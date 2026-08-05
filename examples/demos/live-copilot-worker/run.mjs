import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const arguments_ = process.argv.slice(2);
const confirmed = arguments_.includes("--confirm-cost");
const goal = optionValue(arguments_, "--goal") ?? "Exercise the Senawa live worker path";

process.stderr.write(
  `${[
    "WARNING: demo:live can spend GitHub Copilot AI credits during implementation turns.",
    "Phase preparation is deterministic, but every resume must retain --worker-host copilot.",
  ].join("\n")}\n`,
);

if (!confirmed) {
  process.stderr.write("Re-run with --confirm-cost to start the opt-in live workflow.\n");
  process.exitCode = 2;
} else {
  const result = spawnSync(
    process.execPath,
    [
      resolve("apps/senawa/dist/senawa.mjs"),
      "--worker-host",
      "copilot",
      "work",
      "start",
      goal,
      "--workflow",
      "standard-delivery",
      "--detach",
    ],
    { cwd: process.cwd(), stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}

function optionValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}
