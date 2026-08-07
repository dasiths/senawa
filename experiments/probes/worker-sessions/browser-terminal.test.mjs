import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBrowserTerminalUpdate,
  createBrowserTerminalStore,
  sanitizeTerminalText,
  terminalProjectionLimits,
} from "./browser-terminal-fixture.mjs";

test("keeps one independently updating browser terminal per worker turn", () => {
  const alpha = terminal("turn-alpha", "alpha step 1");
  const beta = terminal("turn-beta", "beta step 1");
  const initial = createBrowserTerminalStore([alpha, beta]);
  const betaBefore = structuredClone(initial[beta.turnId]);

  const updated = applyBrowserTerminalUpdate(initial, terminal("turn-alpha", "alpha step 2"));

  assert.equal(updated[alpha.turnId].streams.stdout, "alpha step 2");
  assert.deepEqual(updated[beta.turnId], betaBefore);
  assert.equal(Object.keys(updated).length, 2);
});

test("sanitizes secrets, controls, paths, lines, and streams before projection", () => {
  const root = "/tmp/senawa-sensitive-root";
  const raw = `before\u001b[31m red\u001b[0m token=secret ${root}\u0000\n${"x".repeat(2_000)}`;
  const sanitized = sanitizeTerminalText(raw, root);

  assert.doesNotMatch(sanitized, /\u001b|secret|senawa-sensitive-root|\u0000/u);
  assert.match(sanitized, /token=\[redacted\]/u);
  assert.match(sanitized, /\[probe-root\]/u);
  assert.ok(sanitized.length <= terminalProjectionLimits.maxCharsPerStream);
  assert.match(sanitized, /truncated/u);
});

function terminal(turnId, stdout) {
  return {
    apiVersion: "senawa.dev/browser-worker-terminal/v1",
    runId: "probe-run",
    owner: { kind: "task", id: turnId },
    sessionId: `session-${turnId}`,
    turnId,
    tmux: { socket: "probe", session: turnId, paneId: "%1", panePid: 100 },
    status: "running",
    exitCode: null,
    streams: { stdout, stderr: "", pane: stdout },
    lifecycle: [],
  };
}