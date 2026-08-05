import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sourceRoot = process.cwd();
const cliBundle = resolve(sourceRoot, "packages/cli/dist/senawa.mjs");
const keepServer = process.argv.slice(2).includes("--keep-server");
const demoRoot = await mkdtemp(join(tmpdir(), "senawa-production-demo-"));
let webProcess;
let completed = false;

try {
  await installDefinitions(sourceRoot, demoRoot);
  print(`Demo repository: ${demoRoot}`);
  runCli(["doctor"]);
  const started = runCli(
    [
      "work",
      "start",
      "Demonstrate the production Senawa vertical slice",
      "--workflow",
      "standard-delivery",
      "--detach",
    ],
    [2],
  );
  const runId = parseJson(started.stdout).runId;
  if (typeof runId !== "string") throw new Error("Start output did not include a run ID");

  const web = await startWeb(runId);
  webProcess = web.process;
  const browser = await openBrowserSession(web.bootstrapUrl, web.url, runId);
  print(`Automated browser endpoint: ${web.url}`);

  const defineStream = await openSse(
    `${browser.origin}/api/v1/runs/${runId}/streams/${encodeURIComponent("phase:define")}/events?after=0`,
    browser.cookie,
  );
  const initialDefineRecords = await Promise.all([
    defineStream.next(),
    defineStream.next(),
    defineStream.next(),
  ]);
  const lastDefineSequence = initialDefineRecords.at(-1)?.seq ?? 0;
  await browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "reject",
    phaseId: "define",
    reason: "Show deterministic artifact rework",
  });
  await browser.command({ apiVersion: "senawa.dev/browser-command/v1", command: "resume" });
  const replayedDefineRecord = await defineStream.next();
  if (replayedDefineRecord.seq <= lastDefineSequence) {
    throw new Error("Definition output stream did not advance after rejection");
  }
  defineStream.close();
  print(`HTTP rejection and SSE replay advanced define output to ${replayedDefineRecord.seq}.`);

  await approveAndResume(browser, "define");
  await approveAndResume(browser, "research");
  await browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "approve",
    phaseId: "plan",
  });

  const taskStream = await openSse(
    `${browser.origin}/api/v1/runs/${runId}/streams/${encodeURIComponent("task:implement-change")}/events?after=0`,
    browser.cookie,
  );
  const resumeImplementation = browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "resume",
  });
  const streamedTaskRecord = await taskStream.next();
  const implementationResult = await resumeImplementation;
  taskStream.close();
  if (implementationResult.snapshot?.needs?.phaseId !== "verify") {
    throw new Error("Implementation did not advance to verification approval");
  }
  print(`SSE streamed task output record ${streamedTaskRecord.seq} during implementation.`);

  await browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "approve",
    phaseId: "verify",
  });
  const finished = await browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "resume",
  });
  if (finished.snapshot?.status !== "finished") throw new Error("Demo run did not finish");

  const journal = await browser.get(`/api/v1/runs/${runId}/events?limit=500`);
  const reworkEvents = journal.filter((event) => event.event === "task.rework");
  if (reworkEvents.length !== 2) {
    throw new Error(`Expected two command-gate rework events, received ${reworkEvents.length}`);
  }
  print(`Command sensors forced ${reworkEvents.length} deterministic task rework events.`);

  runCli(["work", "report", runId]);
  print("Offline demo completed without invoking Copilot.");
  completed = true;

  if (keepServer) {
    await stopProcess(webProcess);
    const inspectionWeb = await startWeb(runId);
    webProcess = inspectionWeb.process;
    print(`Browser URL: ${inspectionWeb.bootstrapUrl}`);
    print(`Server left running for explicit inspection: ${inspectionWeb.url}`);
    print(`Supervisor PID: ${webProcess.pid}`);
    print(`Demo repository retained at: ${demoRoot}`);
    webProcess.stdout?.destroy();
    webProcess.stderr?.destroy();
    webProcess.unref();
  }
} finally {
  if (!keepServer || !completed) {
    await stopProcess(webProcess);
    await rm(demoRoot, { recursive: true, force: true });
  }
}

function runCli(arguments_, acceptedCodes = [0]) {
  print(`$ senawa ${arguments_.join(" ")}`);
  const result = spawnSync(process.execPath, [cliBundle, ...arguments_], {
    cwd: demoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (!acceptedCodes.includes(result.status ?? 1)) {
    throw new Error(`senawa exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  process.stdout.write(result.stdout);
  return result;
}

async function installDefinitions(from, to) {
  await cp(join(from, ".senawa"), join(to, ".senawa"), { recursive: true });
  const skillTarget = join(to, ".agents", "skills", "senawa", "SKILL.md");
  await mkdir(dirname(skillTarget), { recursive: true });
  await cp(join(from, ".agents", "skills", "senawa", "SKILL.md"), skillTarget);
  await cp(join(from, "scripts", "demo-fixture", "package.json"), join(to, "package.json"));
  await cp(join(from, "scripts", "demo-fixture", "check.mjs"), join(to, "check.mjs"));
}

async function startWeb(runId) {
  const child = spawn(process.execPath, [cliBundle, "work", "web", runId, "--port", "0"], {
    cwd: demoRoot,
    detached: keepServer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const output = await readJsonOutput(child, () => stderr);
  if (
    typeof output.url !== "string" ||
    typeof output.browserUrl !== "string" ||
    typeof output.runId !== "string"
  ) {
    throw new Error("Web supervisor did not print its URL");
  }
  const bootstrapUrl = output.url;
  const url = output.browserUrl;
  return { process: child, bootstrapUrl, url };
}

async function readJsonOutput(child, readError) {
  child.stdout?.setEncoding("utf8");
  return new Promise((resolveOutput, rejectOutput) => {
    let output = "";
    const timeout = setTimeout(
      () => rejectOutput(new Error("Web supervisor startup timed out")),
      10_000,
    );
    child.once("error", rejectOutput);
    child.once("exit", (code) => {
      rejectOutput(new Error(`Web supervisor exited ${code}: ${readError()}`));
    });
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      try {
        const parsed = JSON.parse(output);
        clearTimeout(timeout);
        resolveOutput(parsed);
      } catch {
        // Wait for the remaining pretty-printed JSON.
      }
    });
  });
}

async function openBrowserSession(bootstrapUrl, url, runId) {
  const bootstrap = await fetch(bootstrapUrl, { redirect: "manual" });
  if (bootstrap.status !== 303) throw new Error(`Browser bootstrap returned ${bootstrap.status}`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Browser bootstrap did not issue a cookie");
  const origin = new URL(url).origin;
  return {
    cookie,
    origin,
    async get(path) {
      const response = await fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
      if (!response.ok) throw new Error(`HTTP GET ${path} returned ${response.status}`);
      return response.json();
    },
    async command(command) {
      const response = await fetch(`${origin}/api/v1/runs/${runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const body = await response.json();
      if (response.status !== 202) {
        throw new Error(
          `HTTP command ${command.command} returned ${response.status}: ${JSON.stringify(body)}`,
        );
      }
      print(`HTTP ${command.command}: accepted`);
      return body;
    },
  };
}

async function approveAndResume(browser, phaseId) {
  await browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "approve",
    phaseId,
  });
  return browser.command({ apiVersion: "senawa.dev/browser-command/v1", command: "resume" });
}

async function openSse(url, cookie) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Cookie: cookie }, signal: controller.signal });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`SSE request returned ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length);
          if (data !== undefined) return JSON.parse(data);
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE stream ended before the next record");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close() {
      controller.abort();
    },
  };
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

function parseJson(value) {
  return JSON.parse(value);
}

function print(value) {
  process.stdout.write(`${value}\n`);
}
