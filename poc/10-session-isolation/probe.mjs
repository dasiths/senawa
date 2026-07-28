// POC 10 - Can worker sessions be kept OUT of the user's session history?
//
// Dispatching one session per task pollutes the Copilot session picker with an
// entry per task, which makes the human's own history unusable. The SDK has no
// "hidden session" flag, but it has three candidate mechanisms. This measures
// whether they actually work:
//
//   A. baseDirectory   - sets COPILOT_HOME on the runtime, so session state
//                        lands somewhere the user's CLI never looks
//   B. deleteSession   - remove the session after its transcript is archived
//   C. COPILOT_HOME    - the same trick for the subprocess path (Topology B1)
//
// The test is simple: create a session under an isolated home, then ask a
// DEFAULT client whether it can see it. If it cannot, the user's history is clean.
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";

const hdr = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const note = (s) => console.log(`   ${s}`);

const ISOLATED = mkdtempSync(join(tmpdir(), "senawa-home-"));
note(`isolated COPILOT_HOME: ${ISOLATED}`);

// --------------------------------------------------------------------------
hdr("baseline: how many sessions does the DEFAULT home report?");
const before = await (async () => {
  const c = new CopilotClient({ logLevel: "none" });
  await c.start();
  const list = await c.listSessions();
  await c.stop();
  return list;
})();
note(`default home sees ${before.length} session(s)`);

// --------------------------------------------------------------------------
hdr("A. create a worker session under an isolated baseDirectory");
const isolatedClient = new CopilotClient({ logLevel: "none", baseDirectory: ISOLATED });
await isolatedClient.start();

const workerId = crypto.randomUUID();
const worker = await isolatedClient.createSession({
  sessionId: workerId,
  model: "claude-haiku-4.5",
  onPermissionRequest: approveAll,
});
await worker.sendAndWait({ prompt: "Reply with the single word: ok" });
await worker.disconnect();

const isolatedList = await isolatedClient.listSessions();
note(`isolated client sees ${isolatedList.length} session(s), including ours: ${isolatedList.some((s) => s.sessionId === workerId)}`);
note(`state written under isolated home? ${existsSync(join(ISOLATED, "session-state")) ? readdirSync(join(ISOLATED, "session-state")).length + " dir(s)" : "NO"}`);

// --------------------------------------------------------------------------
hdr("the decisive check: can the DEFAULT home see the worker session?");
const after = await (async () => {
  const c = new CopilotClient({ logLevel: "none" });
  await c.start();
  const list = await c.listSessions();
  await c.stop();
  return list;
})();
note(`default home now sees ${after.length} session(s) (was ${before.length})`);
const leaked = after.some((s) => s.sessionId === workerId);
note(leaked ? "LEAKED: the worker session is in the user's history" : "CLEAN: the worker session is invisible to the user's history");

// --------------------------------------------------------------------------
hdr("B. deleteSession removes it even from the isolated home");
await isolatedClient.deleteSession(workerId);
const afterDelete = await isolatedClient.listSessions();
note(`isolated home after delete: ${afterDelete.length} session(s), ours present: ${afterDelete.some((s) => s.sessionId === workerId)}`);
await isolatedClient.stop();

// --------------------------------------------------------------------------
hdr("C. the same trick for the subprocess path (Topology B1)");
const subId = crypto.randomUUID();
execFileSync(
  "copilot",
  ["-p", "Reply with the single word: ok", "-s", "--model", "claude-haiku-4.5",
   "--session-id", subId, "--allow-all-tools", "--no-remote-export"],
  { env: { ...process.env, COPILOT_HOME: ISOLATED }, encoding: "utf8", timeout: 120000 },
);

const subVisible = await (async () => {
  const c = new CopilotClient({ logLevel: "none" });
  await c.start();
  const list = await c.listSessions();
  await c.stop();
  return list.some((s) => s.sessionId === subId);
})();
note(subVisible ? "LEAKED: copilot -p session is in the default history" : "CLEAN: COPILOT_HOME isolates the subprocess path too");

hdr("done");
note(`inspect or remove: ${ISOLATED}`);
