// SDK surface - Which control points does the SDK really expose?
//
// The design was revised on the strength of a documentation claim: that the
// SDK exposes no subagent or agent stop hook, and therefore that Topology B2
// cannot use the "block until green" pattern. That is a load-bearing claim, so
// it gets checked against the shipped type declarations rather than the README.
//
// Then a live session exercises the three control points the design leans on:
// onPermissionRequest rejection with feedback, defineTool, and resumeSession.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import { z } from "zod";

const hdr = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const note = (s) => console.log(`   ${s}`);

// ---------------------------------------------------------------------------
hdr("1. hook surface, read from the shipped .d.ts");

function collectDts(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) collectDts(p, out);
    else if (entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const pkgDir = join(process.cwd(), "node_modules", "@github", "copilot-sdk");
const dts = collectDts(pkgDir).map((f) => readFileSync(f, "utf8")).join("\n");

const candidates = [
  "onPreToolUse", "onPostToolUse", "onPostToolUseFailure", "onUserPromptSubmitted",
  "onSessionStart", "onSessionEnd", "onErrorOccurred", "onPreCompact",
  "onSubagentStart", "onSubagentStop", "onAgentStop", "onStop",
  "onNotification", "onPermissionRequest", "onUserInputRequest", "onElicitationRequest",
];
for (const name of candidates) {
  const present = new RegExp(`\\b${name}\\??\\s*:`).test(dts);
  note(`${present ? "PRESENT" : "absent "}  ${name}`);
}

hdr("2. SessionHooks type as declared");
const block = dts.match(/(?:interface|type)\s+SessionHooks[^{]*\{[^}]*\}/s);
note(block ? block[0].replace(/\n\s*/g, "\n   ") : "SessionHooks type not found by name");

hdr("3. reasoningEffort accepted values");
const effort = dts.match(/reasoningEffort\??\s*:\s*([^;]+);/);
note(effort ? effort[1].trim() : "not found");

// ---------------------------------------------------------------------------
hdr("4. live session: custom tool, permission rejection, resume");

const client = new CopilotClient({ logLevel: "none" });
await client.start();

const calls = [];
const sessionId = crypto.randomUUID();

const session = await client.createSession({
  sessionId,
  model: "claude-haiku-4.5",
  tools: [
    defineTool("senawa_task_done", {
      description:
        "Submit this task for completion review. This is the ONLY way to finish. " +
        "Returns whether the harness accepted the work.",
      parameters: z.object({ summary: z.string().describe("what you changed") }),
      handler: async ({ summary }) => {
        calls.push(summary);
        // The backpressure contract: refuse, with actionable evidence.
        return {
          accepted: false,
          gate: "task-done",
          failed: ["unit-tests"],
          next_prompt:
            "unit-tests is red: test_parse_batch_empty expected 0 rows, got None. " +
            "Do not call senawa_task_done again in this run; just acknowledge.",
        };
      },
    }),
  ],
  onPermissionRequest: (req) => {
    if (req.kind === "shell") {
      return { kind: "reject", feedback: "may-commit is red: typecheck failed" };
    }
    return approveAll(req);
  },
  hooks: {
    onPreToolUse: (input) => {
      note(`   [hook] onPreToolUse fired for ${input.toolName}`);
      return { permissionDecision: "allow" };
    },
  },
});

await session.sendAndWait({
  prompt: "Call the senawa_task_done tool with summary 'split parse_batch into stages', then tell me in one line what the harness said.",
});
note(`custom tool invoked ${calls.length} time(s): ${JSON.stringify(calls)}`);

hdr("5. permission rejection reaches the model as feedback");
const shellReply = await session.sendAndWait({
  prompt: "Run the shell command `git commit -m x`. Then state, in one line, the exact reason it was refused.",
});
note((shellReply?.data?.content ?? "(no content)").split("\n").slice(0, 3).join(" ").slice(0, 300));

await session.disconnect();

hdr("6. resumeSession restores the same conversation");
const resumed = await client.resumeSession(sessionId, { onPermissionRequest: approveAll });
const recall = await resumed.sendAndWait({
  prompt: "What summary string did I pass to senawa_task_done earlier? Answer with just that string.",
});
note((recall?.data?.content ?? "(no content)").slice(0, 200));
await resumed.disconnect();

await client.stop();
hdr("done");
