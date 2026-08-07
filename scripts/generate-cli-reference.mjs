import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const executable = resolve(root, "apps/senawa/dist/senawa.mjs");
const outputPath = resolve(root, "docs/reference/cli.md");
const groups = [
  [],
  ["doctor"],
  ["model"],
  ["model", "list"],
  ["workflow"],
  ["workflow", "list"],
  ["workflow", "info"],
  ["workflow", "render"],
  ["workflow", "validate"],
  ["sensor"],
  ["sensor", "list"],
  ["sensor", "info"],
  ["sensor", "audit"],
  ["gate"],
  ["gate", "check"],
  ["work"],
  ["work", "start"],
  ["work", "resume"],
  ["work", "pause"],
  ["work", "finish"],
  ["work", "show"],
  ["work", "wait"],
  ["work", "end"],
  ["work", "report"],
  ["work", "web"],
  ["phase"],
  ["phase", "show"],
  ["phase", "brief"],
  ["phase", "artifact"],
  ["task"],
  ["task", "show"],
  ["plan"],
  ["plan", "revise"],
  ["ask"],
  ["answer"],
  ["discover"],
  ["note"],
  ["browser"],
  ["approve"],
  ["reject"],
  ["steer"],
];
const sections = groups.map((path) => {
  const result = spawnSync(process.execPath, [executable, ...path, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to generate help for ${["senawa", ...path].join(" ")}: ${result.stderr.trim()}`,
    );
  }
  const title = path.length === 0 ? "Top-level grammar" : `senawa ${path.join(" ")}`;
  return `## ${title}\n\n\`\`\`text\n${result.stdout.trimEnd()}\n\`\`\``;
});

const content = `# Senawa CLI Reference

This file is generated from the registered Commander grammar. Run
\`pnpm docs:cli\` after changing CLI commands.

Beads is the default runtime. Use the global \`--runtime file\` option only for
development, tests, and the deterministic file-backed demo. Runtime selection
belongs to process composition and is not available through browser HTTP routes.

The current CLI intentionally omits \`init\`, \`sensor run\`, \`task done\`, and
\`task abort\`. Repository initialization does not yet have bundled scaffold
assets, individual sensor execution has no gate expectation contract, and task
completion has no authenticated subprocess command bridge. Per-task cancellation
also lacks coordination with a continuing driver; forced whole-run end does not
establish that narrower contract.

${sections.join("\n\n")}
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, content);
