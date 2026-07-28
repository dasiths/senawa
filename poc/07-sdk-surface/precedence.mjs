// POC 07b - precedence between onPreToolUse and onPermissionRequest.
//
// The design proposes using BOTH: onPreToolUse for fast policy, and
// onPermissionRequest for gate decisions that carry feedback to the model.
// The first run of probe.mjs suggested that a blanket `allow` from
// onPreToolUse suppresses onPermissionRequest entirely, which would mean the
// two cannot be layered naively. This isolates that.
import { CopilotClient, approveAll } from "@github/copilot-sdk";

const hdr = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const note = (s) => console.log(`   ${s}`);

const PROMPT =
  "Run the shell command `echo SENTINEL_RAN > /tmp/poc07b_marker.txt`. " +
  "Then say in one line whether it succeeded or was refused, and why.";

async function scenario(label, hooks) {
  const seen = { preTool: 0, permission: 0 };
  const client = new CopilotClient({ logLevel: "none" });
  await client.start();

  const session = await client.createSession({
    model: "claude-haiku-4.5",
    onPermissionRequest: (req) => {
      seen.permission++;
      if (req.kind === "shell") {
        return { kind: "reject", feedback: "DENIED_BY_PERMISSION_HANDLER: may-commit is red" };
      }
      return approveAll(req);
    },
    hooks: hooks(seen),
  });

  const reply = await session.sendAndWait({ prompt: PROMPT });
  await session.disconnect();
  await client.stop();

  hdr(label);
  note(`onPreToolUse calls        : ${seen.preTool}`);
  note(`onPermissionRequest calls : ${seen.permission}`);
  note(`agent said: ${(reply?.data?.content ?? "").split("\n")[0].slice(0, 180)}`);
}

// A: preToolUse blanket-allows. Does the permission handler still get consulted?
await scenario("A. onPreToolUse returns allow", (seen) => ({
  onPreToolUse: () => {
    seen.preTool++;
    return { permissionDecision: "allow" };
  },
}));

// B: preToolUse observes only, returning nothing.
await scenario("B. onPreToolUse returns nothing (observe only)", (seen) => ({
  onPreToolUse: () => {
    seen.preTool++;
    return {};
  },
}));

// C: no preToolUse hook at all.
await scenario("C. no onPreToolUse hook registered", () => ({}));
