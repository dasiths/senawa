// Stand-in for `senawa hook pre-tool`: the hot path that Copilot CLI runs
// before every single tool call. It must parse a hook payload from stdin,
// consult policy, and print a decision.
//
// The imports matter more than the logic. This is the realistic module graph
// for the real CLI, and module resolution is what the measurement is about.
import { Command } from "commander";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const HookPayload = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  toolName: z.string(),
  toolArgs: z.unknown(),
});

const SensorsConfig = z.object({
  version: z.number(),
  gates: z.array(z.object({ id: z.string(), requires: z.array(z.string()).default([]) })),
});

const EMBEDDED_CONFIG = `
version: 1
gates:
  - id: may-commit
    requires: [format, lint, typecheck]
`;

function decide(payload, config) {
  const args = payload.toolArgs ?? {};
  const command = typeof args === "object" && args !== null ? String(args.command ?? "") : "";
  const gate = config.gates.find((g) => g.id === "may-commit");
  if (/\bgit\s+commit\b/.test(command) && gate) {
    return {
      permissionDecision: "deny",
      permissionDecisionReason: `may-commit requires ${gate.requires.join(", ")}`,
    };
  }
  return {};
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const program = new Command();
program
  .name("senawa-hook")
  .option("--selftest", "exit immediately after loading the module graph")
  .action(async (opts) => {
    // Referenced so the bundler cannot tree-shake execa out of the graph;
    // the real CLI needs it to run sensors.
    if (typeof execa !== "function") throw new Error("execa missing");

    if (opts.selftest) return;

    const config = SensorsConfig.parse(parseYaml(EMBEDDED_CONFIG));
    const raw = await readStdin();
    if (!raw.trim()) {
      process.stdout.write("{}");
      return;
    }
    const payload = HookPayload.parse(JSON.parse(raw));
    process.stdout.write(JSON.stringify(decide(payload, config)));
  });

await program.parseAsync(process.argv);
