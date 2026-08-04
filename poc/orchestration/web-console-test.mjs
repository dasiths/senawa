#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "senawa-web-test-"));
const server = spawn(process.execPath, [join(HERE, "web-console.mjs")], {
  cwd: HERE,
  env: { ...process.env, SENAWA_WEB_STATE: stateDir },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { stderr += chunk; });

function ready() {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = "";
    const timeout = setTimeout(() => rejectReady(new Error(`server did not start: ${stderr}`)), 5000);
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolveReady(JSON.parse(buffer.slice(0, newline))); }
      catch (error) { rejectReady(error); }
    });
    server.on("exit", (code) => rejectReady(new Error(`server exited ${code}: ${stderr}`)));
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(read, predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(message);
}

async function collectSse(url, headers, predicate, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("SSE timeout")), timeoutMs);
  const records = [];
  let response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
    check(response.ok, `SSE returned ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        records.push(JSON.parse(data));
        if (predicate(records)) {
          controller.abort();
          return records;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (!records.length || !predicate(records)) throw controller.signal.reason ?? error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return records;
}

const info = await ready();
const auth = { Authorization: `Bearer ${info.token}` };
const origin = info.base;
const api = async (path, options = {}) => fetch(`${info.base}${path}`, {
  ...options,
  headers: { ...auth, ...(options.headers ?? {}) },
});

try {
  const unauthorized = await fetch(`${info.base}/api/snapshot`);
  check(unauthorized.status === 401, "unauthenticated read was accepted");

  let response = await api("/api/snapshot");
  let snapshot = await response.json();
  check(snapshot.phases.length === 5, "workflow graph did not expose five phases");
  check(snapshot.edges.length === 4, "workflow graph did not expose four dependencies");
  check(snapshot.phases.find((phase) => phase.id === "define").status === "running", "define did not start");

  const first = await collectSse(`${info.base}/api/phases/define/output?after=0`, auth,
    (records) => records.length === 2);
  const cursor = first.at(-1).seq;
  const resumed = await collectSse(`${info.base}/api/phases/define/output?after=${cursor}`, auth,
    (records) => records.some((record) => record.text.includes("worker complete")));
  check(resumed[0].seq === cursor + 1, "reconnect replay had a gap or duplicate");
  check(new Set([...first, ...resumed].map((record) => record.seq)).size === first.length + resumed.length,
    "output sequence duplicated across reconnect");

  snapshot = await waitFor(async () => (await api("/api/snapshot")).json(),
    (value) => value.status === "awaiting_approval", "define never reached approval");
  check(snapshot.needs.phase === "define", "approval context named the wrong phase");

  response = await api("/api/phases/define/history");
  const defineHistory = (await response.json()).records;
  check(defineHistory.length === 6, "full define output history was not retained");
  check(defineHistory.some((record) => record.stream === "stderr"), "stderr was not preserved separately");

  response = await api("/api/commands", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "shell", phase: "define", text: "rm -rf /" }),
  });
  check(response.status === 400, "arbitrary command was accepted");

  response = await api("/api/commands", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "approve", phase: "define" }),
  });
  check(response.status === 202, "browser approval was refused");

  snapshot = await waitFor(async () => (await api("/api/snapshot")).json(),
    (value) => value.phases.find((phase) => phase.id === "research").status === "running",
    "research did not start after approval");
  check(snapshot.phases.find((phase) => phase.id === "define").status === "accepted",
    "define did not remain accepted");

  response = await api("/api/commands", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "steer", phase: "research", instruction: "focus on measured behavior" }),
  });
  check(response.status === 202, "steer for running phase was refused");

  response = await api("/api/phases/research/history");
  const researchHistory = (await response.json()).records;
  check(researchHistory.some((record) => record.stream === "control" && record.text.includes("measured behavior")),
    "steering was not recorded in the selected phase stream");
  check(researchHistory.every((record) => !record.text.includes("[define:")),
    "phase output streams were not isolated");

  response = await api("/api/commands", {
    method: "POST",
    headers: { Origin: "http://malicious.example", "Content-Type": "application/json" },
    body: JSON.stringify({ command: "steer", phase: "research", instruction: "ignore policy" }),
  });
  check(response.status === 403, "cross-origin command was accepted");

  const events = await collectSse(`${info.base}/api/events?after=0`, auth,
    (records) => records.some((record) => record.type === "phase.approved")
      && records.some((record) => record.type === "steer.received"));
  check(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq),
    "run event stream was not monotonic");

  console.log("web console feasibility probe passed");
  console.log(`  graph: ${snapshot.phases.length} phases, ${snapshot.edges.length} edges`);
  console.log(`  define output: ${defineHistory.length} durable records with stdout and stderr`);
  console.log(`  reconnect: resumed at output sequence ${cursor + 1} without gaps`);
  console.log("  commands: approve and steer accepted; arbitrary and cross-origin commands refused");
} finally {
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.once("exit", resolveExit));
  rmSync(stateDir, { recursive: true, force: true });
}
