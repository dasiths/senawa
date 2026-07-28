// A deliberately minimal hot path: the same preToolUse decision with no zod,
// no execa, no commander. If the full graph is too slow to sit in front of
// every tool call, this is the shape senawa would ship instead, with the heavy
// CLI reserved for `senawa task done` where latency does not matter.
import { parse as parseYaml } from "yaml";

const EMBEDDED_CONFIG = `
version: 1
gates:
  - id: may-commit
    requires: [format, lint, typecheck]
`;

if (process.argv.includes("--selftest")) {
  parseYaml(EMBEDDED_CONFIG);
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");

if (!raw.trim()) {
  process.stdout.write("{}");
} else {
  const config = parseYaml(EMBEDDED_CONFIG);
  const payload = JSON.parse(raw);
  // Hand-rolled validation. The payload shape is fixed by the CLI, small, and
  // fully covered by three checks; zod earns its place at the sensors.yaml
  // boundary, not here.
  if (typeof payload?.toolName !== "string" || typeof payload?.sessionId !== "string") {
    process.stderr.write("malformed hook payload\n");
    process.exit(2); // exit 2 on preToolUse is a deny
  }
  const command = String(payload.toolArgs?.command ?? "");
  const gate = config.gates.find((g) => g.id === "may-commit");
  process.stdout.write(
    /\bgit\s+commit\b/.test(command)
      ? JSON.stringify({
          permissionDecision: "deny",
          permissionDecisionReason: `may-commit requires ${gate.requires.join(", ")}`,
        })
      : "{}",
  );
}
