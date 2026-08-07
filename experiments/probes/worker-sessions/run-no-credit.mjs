import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { access, writeFile } from "node:fs/promises";
import {
  applyBrowserTerminalUpdate,
  createBrowserTerminalStore,
  projectBrowserTerminal,
  terminalProjectionLimits,
} from "./browser-terminal-fixture.mjs";

const [tmuxPath, probeRoot, socket] = process.argv.slice(2);
if (!tmuxPath || !probeRoot || !socket) throw new Error("tmux path, probe root, and socket required");

const here = dirname(fileURLToPath(import.meta.url));
const workerScript = join(here, "worker-stand-in.sh");
const runId = `worker-sessions-${basename(probeRoot)}`;
const turns = [
  identity("alpha", 0),
  identity("beta", 7),
];

for (const turn of turns) startTurn(turn);
await Promise.all(turns.map((turn) => waitForFile(controlPath(turn, "ready"))));

const initialTerminals = await Promise.all(turns.map(projectTurn));
let browserStore = createBrowserTerminalStore(initialTerminals);
const initialIdentity = Object.fromEntries(
  initialTerminals.map((terminal) => [terminal.turnId, terminal.tmux]),
);
const betaBeforeAlphaUpdate = structuredClone(browserStore[turns[1].turnId]);

await writeFile(controlPath(turns[0], "step-2"), "continue\n");
await waitForFile(controlPath(turns[0], "updated"));
browserStore = applyBrowserTerminalUpdate(browserStore, await projectTurn(turns[0]));
assert.match(browserStore[turns[0].turnId].streams.stdout, /alpha step=2/u);
assert.deepEqual(browserStore[turns[1].turnId], betaBeforeAlphaUpdate);

await writeFile(controlPath(turns[1], "step-2"), "continue\n");
await waitForFile(controlPath(turns[1], "updated"));
browserStore = applyBrowserTerminalUpdate(browserStore, await projectTurn(turns[1]));
assert.match(browserStore[turns[1].turnId].streams.stdout, /beta step=2/u);

for (const turn of turns) await writeFile(controlPath(turn, "finish"), "finish\n");
await Promise.all(turns.map(waitForPaneExit));
for (const turn of turns) browserStore = applyBrowserTerminalUpdate(browserStore, await projectTurn(turn));

for (const turn of turns) {
  const terminal = browserStore[turn.turnId];
  assert.equal(terminal.status, "exited");
  assert.equal(terminal.exitCode, turn.expectedExit);
  assert.deepEqual(terminal.tmux, initialIdentity[turn.turnId]);
  assert.equal(terminal.lifecycle.at(-1)?.event, turn.expectedExit === 0 ? "completed" : "failed");
  assert.ok(terminal.lifecycle.length <= terminalProjectionLimits.maxLifecycleRecords);
  for (const text of Object.values(terminal.streams)) {
    assert.doesNotMatch(text, /\u001b|secret|password=.*password/u);
    assert.doesNotMatch(text, new RegExp(escapeRegex(probeRoot), "u"));
    assert.ok(text.length <= terminalProjectionLimits.maxCharsPerStream);
  }
}

for (const turn of turns) {
  attachAndDetach(turn);
  attachAndDetach(turn);
}
const attachDetachCycles = turns.length * 2;
const detachedClientCount = lines(
  tmux("list-clients", "-F", "#{client_name}", { allowFailure: true }).stdout,
).length;
assert.equal(detachedClientCount, 0);

const disappeared = [];
for (const turn of turns) {
  tmux("kill-pane", "-t", `${turn.tmuxSession}:worker.0`);
  const result = tmux("has-session", "-t", turn.tmuxSession, { allowFailure: true });
  disappeared.push(result.status !== 0);
}
assert.deepEqual(disappeared, [true, true]);

process.stdout.write(
  `${JSON.stringify(
    {
      result: "pass",
      evidenceKind: "measured-no-credit",
      aiCreditsSpent: false,
      tmuxVersion: tmux("-V").stdout.trim(),
      runId,
      detachedClientCount,
      controlModeAttachDetachCycles: attachDetachCycles,
      paneDisappearanceObserved: disappeared.every(Boolean),
      limits: terminalProjectionLimits,
      terminals: Object.values(browserStore).map((terminal) => ({
        owner: terminal.owner,
        sessionId: terminal.sessionId,
        turnId: terminal.turnId,
        tmux: terminal.tmux,
        status: terminal.status,
        exitCode: terminal.exitCode,
        lifecycle: terminal.lifecycle.map((record) => record.event),
        stdoutChars: terminal.streams.stdout.length,
        stderrChars: terminal.streams.stderr.length,
        paneChars: terminal.streams.pane.length,
      })),
    },
    null,
    2,
  )}\n`,
);

function identity(id, expectedExit) {
  return {
    owner: { kind: "task", id: `worker-${id}` },
    sessionId: `session-${id}`,
    turnId: `turn-${id}-1`,
    tmuxSession: `${socket}-${id}`,
    expectedExit,
  };
}

function startTurn(turn) {
  const command = [
    "bash",
    workerScript,
    probeRoot,
    turn.owner.id,
    turn.sessionId,
    turn.turnId,
    String(turn.expectedExit),
  ]
    .map(shellQuote)
    .join(" ");
  tmux("new-session", "-d", "-s", turn.tmuxSession, "-n", "worker", command);
  tmux("set-option", "-t", turn.tmuxSession, "remain-on-exit", "on");
}

async function projectTurn(turn) {
  const pane = paneIdentity(turn);
  return projectBrowserTerminal({
    runId,
    owner: turn.owner,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    socket,
    tmuxSession: pane.session,
    paneId: pane.paneId,
    panePid: pane.panePid,
    paneDead: pane.dead,
    exitCode: pane.exitCode,
    paneCapture: tmux("capture-pane", "-p", "-t", `${turn.tmuxSession}:worker.0`, "-S", "-80").stdout,
    stdoutPath: join(probeRoot, "output", turn.turnId, "stdout.raw"),
    stderrPath: join(probeRoot, "output", turn.turnId, "stderr.raw"),
    lifecyclePath: join(probeRoot, "output", turn.turnId, "lifecycle.jsonl"),
    probeRoot,
  });
}

function paneIdentity(turn) {
  const output = tmux(
    "list-panes",
    "-t",
    turn.tmuxSession,
    "-F",
    "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}",
  ).stdout.trim();
  const [session, paneId, panePid, paneDead, paneDeadStatus] = output.split("\t");
  assert.ok(session && paneId && panePid && paneDead !== undefined);
  return {
    session,
    paneId,
    panePid: Number(panePid),
    dead: paneDead === "1",
    exitCode: paneDead === "1" ? Number(paneDeadStatus) : null,
  };
}

function attachAndDetach(turn) {
  const result = spawnSync(
    tmuxPath,
    ["-L", socket, "-C", "attach-session", "-t", turn.tmuxSession],
    {
      encoding: "utf8",
      input: "detach-client\n",
      timeout: 2_000,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `tmux control-mode attach/detach failed (${String(result.status)}): ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

async function waitForPaneExit(turn) {
  await waitFor(() => paneIdentity(turn).dead);
}

async function waitForFile(path) {
  await waitFor(async () => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for deterministic tmux fixture");
}

function controlPath(turn, step) {
  return join(probeRoot, "control", `${turn.turnId}.${step}`);
}

function tmux(...input) {
  const options = typeof input.at(-1) === "object" ? input.pop() : {};
  const result = spawnSync(tmuxPath, ["-L", socket, ...input], { encoding: "utf8" });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`tmux ${input.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function lines(value) {
  return value.split("\n").filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}