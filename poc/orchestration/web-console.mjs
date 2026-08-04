#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = join(HERE, "web-console");
const STATE = resolve(process.env.SENAWA_WEB_STATE ?? mkdtempSync(join(tmpdir(), "senawa-web-")));
const TOKEN = process.env.SENAWA_WEB_TOKEN ?? randomBytes(24).toString("base64url");
const HOST = "127.0.0.1";
const PORT = Number(process.env.SENAWA_WEB_PORT ?? 0);
const workflow = parseYaml(readFileSync(join(HERE, "workflows", "standard-delivery.yaml"), "utf8"));
const runLog = join(STATE, "run-events.jsonl");
const outputDir = join(STATE, "output");
mkdirSync(outputDir, { recursive: true });

const phases = workflow.spec.phases.map((phase) => ({
  id: phase.id,
  role: phase.executor.role ?? phase.executor.kind,
  kind: phase.executor.kind,
  dependsOn: phase.dependsOn ?? [],
  status: "pending",
  attempt: 0,
  pid: null,
}));
const runSubscribers = new Set();
const outputSubscribers = new Map();
const children = new Map();
let runSeq = 0;
let runStatus = "running";

const readJsonl = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

function sendSse(response, record) {
  response.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
}

function emitRun(type, data = {}) {
  const record = { seq: ++runSeq, at: new Date().toISOString(), type, ...data };
  appendFileSync(runLog, `${JSON.stringify(record)}\n`);
  for (const response of runSubscribers) sendSse(response, record);
  return record;
}

function outputFile(phaseId) {
  return join(outputDir, `${phaseId}.jsonl`);
}

function appendOutput(phaseId, stream, text) {
  const history = readJsonl(outputFile(phaseId));
  const record = {
    seq: history.length + 1,
    at: new Date().toISOString(),
    phase: phaseId,
    stream,
    text,
  };
  appendFileSync(outputFile(phaseId), `${JSON.stringify(record)}\n`);
  for (const response of outputSubscribers.get(phaseId) ?? []) sendSse(response, record);
  return record;
}

function captureLines(phaseId, stream, readable) {
  let pending = "";
  readable.setEncoding("utf8");
  readable.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) appendOutput(phaseId, stream, line);
  });
  readable.on("end", () => {
    if (pending) appendOutput(phaseId, stream, pending);
  });
}

function phaseById(id) {
  return phases.find((phase) => phase.id === id);
}

function startPhase(phase) {
  runStatus = "running";
  phase.status = "running";
  phase.attempt += 1;
  const program = `
const phase = process.argv[1];
const attempt = process.argv[2];
const messages = [
  "session attached",
  "reading frozen inputs",
  "working through assigned scope",
  "running completion checks",
  "artifact submitted",
  "worker complete"
];
let index = 0;
function writeNext() {
  if (index === messages.length) process.exit(0);
  const line = "[" + phase + ":" + attempt + "] " + messages[index];
  (index === 2 ? process.stderr : process.stdout).write(line + "\\n");
  index += 1;
  setTimeout(writeNext, 140);
}
writeNext();
`;
  const child = spawn(process.execPath, ["-e", program, phase.id, String(phase.attempt)], {
    cwd: HERE,
    stdio: ["ignore", "pipe", "pipe"],
  });
  phase.pid = child.pid;
  children.set(phase.id, child);
  emitRun("phase.started", { phase: phase.id, role: phase.role, attempt: phase.attempt, pid: child.pid });
  captureLines(phase.id, "stdout", child.stdout);
  captureLines(phase.id, "stderr", child.stderr);
  child.on("close", (code, signal) => {
    children.delete(phase.id);
    phase.pid = null;
    if (phase.status !== "running") return;
    if (code === 0) {
      phase.status = "awaiting_approval";
      runStatus = "awaiting_approval";
      emitRun("phase.awaiting_approval", { phase: phase.id, attempt: phase.attempt });
    } else {
      phase.status = "failed";
      runStatus = "stopped";
      emitRun("phase.failed", { phase: phase.id, code, signal });
    }
  });
}

function startNextPhase() {
  const next = phases.find((phase) => phase.status === "pending"
    && phase.dependsOn.every((id) => phaseById(id)?.status === "accepted"));
  if (next) {
    runStatus = "running";
    startPhase(next);
    return;
  }
  if (phases.every((phase) => phase.status === "accepted")) {
    runStatus = "finished";
    emitRun("work.finished");
  }
}

function snapshot() {
  const needs = phases.find((phase) => phase.status === "awaiting_approval");
  return {
    workflow: workflow.metadata.name,
    status: runStatus,
    needs: needs ? { action: "approve", phase: needs.id } : null,
    phases: phases.map((phase) => ({ ...phase, outputCount: readJsonl(outputFile(phase.id)).length })),
    edges: phases.flatMap((phase) => phase.dependsOn.map((from) => ({ from, to: phase.id }))),
    cursor: runSeq,
  };
}

function authorized(request) {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("senawa_token="))?.slice("senawa_token=".length);
  return bearer === TOKEN || cookie === TOKEN;
}

function securityHeaders(response, contentType) {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
}

function json(response, status, body) {
  securityHeaders(response, "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(`${JSON.stringify(body)}\n`);
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) rejectBody(new Error("request body too large"));
    });
    request.on("end", () => {
      try { resolveBody(JSON.parse(body || "{}")); }
      catch { rejectBody(new Error("invalid JSON")); }
    });
    request.on("error", rejectBody);
  });
}

function beginSse(request, response, records, subscribers, after) {
  securityHeaders(response, "text/event-stream; charset=utf-8");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.writeHead(200);
  response.write("retry: 500\n\n");
  for (const record of records) if (record.seq > after) sendSse(response, record);
  subscribers.add(response);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
  request.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(response);
  });
}

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? `${HOST}:${PORT}`}`);

  if (url.pathname === "/" && url.searchParams.get("token") === TOKEN) {
    response.setHeader("Set-Cookie", `senawa_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    response.writeHead(303, { Location: "/" });
    response.end();
    return;
  }
  if (!authorized(request)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  if (request.method === "GET" && staticFiles.has(url.pathname)) {
    const [name, type] = staticFiles.get(url.pathname);
    securityHeaders(response, type);
    response.writeHead(200);
    response.end(readFileSync(join(STATIC, basename(name))));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/snapshot") {
    json(response, 200, snapshot());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
    beginSse(request, response, readJsonl(runLog), runSubscribers, after);
    return;
  }

  const outputMatch = url.pathname.match(/^\/api\/phases\/([a-z][a-z0-9-]*)\/output$/);
  if (request.method === "GET" && outputMatch) {
    const phase = phaseById(outputMatch[1]);
    if (!phase) { json(response, 404, { error: "unknown phase" }); return; }
    const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
    if (!outputSubscribers.has(phase.id)) outputSubscribers.set(phase.id, new Set());
    beginSse(request, response, readJsonl(outputFile(phase.id)), outputSubscribers.get(phase.id), after);
    return;
  }

  const historyMatch = url.pathname.match(/^\/api\/phases\/([a-z][a-z0-9-]*)\/history$/);
  if (request.method === "GET" && historyMatch) {
    const phase = phaseById(historyMatch[1]);
    if (!phase) { json(response, 404, { error: "unknown phase" }); return; }
    json(response, 200, { phase: phase.id, records: readJsonl(outputFile(phase.id)) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands") {
    const expectedOrigin = `http://${request.headers.host}`;
    if (request.headers.origin && request.headers.origin !== expectedOrigin) {
      json(response, 403, { error: "origin rejected" });
      return;
    }
    try {
      const body = await readBody(request);
      if (!new Set(["approve", "reject", "steer"]).has(body.command)) {
        json(response, 400, { error: "command is not exposed to the browser" });
        return;
      }
      const phase = phaseById(body.phase);
      if (!phase) { json(response, 404, { error: "unknown phase" }); return; }

      if (body.command === "approve") {
        if (phase.status !== "awaiting_approval") {
          json(response, 409, { error: `${phase.id} is not awaiting approval` });
          return;
        }
        phase.status = "accepted";
        runStatus = "running";
        emitRun("phase.approved", { phase: phase.id, via: "browser" });
        startNextPhase();
      } else if (body.command === "reject") {
        if (phase.status !== "awaiting_approval" || typeof body.reason !== "string" || !body.reason.trim()) {
          json(response, 409, { error: "rejection requires an awaiting phase and a reason" });
          return;
        }
        appendOutput(phase.id, "control", `rejected from browser: ${body.reason.trim()}`);
        emitRun("phase.rejected", { phase: phase.id, reason: body.reason.trim(), via: "browser" });
        startPhase(phase);
      } else {
        if (phase.status !== "running" || typeof body.instruction !== "string" || !body.instruction.trim()) {
          json(response, 409, { error: "steering requires a running phase and an instruction" });
          return;
        }
        appendOutput(phase.id, "control", `steer received: ${body.instruction.trim()}`);
        emitRun("steer.received", { phase: phase.id, instruction: body.instruction.trim(), via: "browser" });
      }
      json(response, 202, { accepted: true, snapshot: snapshot() });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return;
  }

  json(response, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const base = `http://${HOST}:${address.port}`;
  console.log(JSON.stringify({ url: `${base}/?token=${TOKEN}`, base, token: TOKEN, stateDir: STATE }));
  emitRun("work.started", { workflow: workflow.metadata.name });
  startNextPhase();
});

function shutdown() {
  for (const child of children.values()) child.kill("SIGTERM");
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
