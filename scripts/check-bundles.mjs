import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const cliBundle = resolve("apps/senawa/dist/senawa.mjs");
const hookBundle = resolve("apps/senawa-hook/dist/senawa-hook.mjs");

for (const bundle of [cliBundle, hookBundle]) {
  const source = await readFile(bundle, "utf8");
  if (!source.startsWith("#!/usr/bin/env node")) {
    throw new Error(`${bundle} is missing its executable banner`);
  }
  const details = await stat(bundle);
  if (details.size === 0) throw new Error(`${bundle} is empty`);
}

runBundle(cliBundle, ["--help"], undefined, "Senawa CLI");
runBundle(hookBundle, ["pre-tool"], "{}", "Senawa hook");

process.stdout.write("Bundle checks passed: CLI and hook import and start successfully.\n");

function runBundle(bundle, arguments_, input, label) {
  const result = spawnSync(process.execPath, [bundle, ...arguments_], {
    encoding: "utf8",
    input,
    timeout: 10_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} startup failed with exit ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}
