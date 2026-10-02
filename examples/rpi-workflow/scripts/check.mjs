import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// The gate behind this reading is blocking, so a runner that passes because it
// found nothing would let the gate agree with an empty project. No tests is a
// red reading, not a green one.

const root = process.cwd();
const skip = new Set([".git", ".senawa", "node_modules", ".senawa-state"]);

function testFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...testFiles(path));
      continue;
    }
    if (/\.test\.(?:js|mjs)$/u.test(entry.name)) found.push(path);
  }
  return found;
}

let files;
try {
  files = testFiles(root);
} catch (error) {
  process.stdout.write(`could not read the project: ${error.message}\n`);
  process.exit(1);
}

if (files.length === 0) {
  process.stdout.write("no test file found; a project with no tests has not been checked\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
});

process.stdout.write(result.stdout ?? "");
process.stdout.write(result.stderr ?? "");

if (result.error !== undefined) {
  process.stdout.write(`the test runner did not finish: ${result.error.message}\n`);
  process.exit(1);
}

const code = result.status ?? 1;
process.stdout.write(
  code === 0
    ? `checked ${String(files.length)} test file(s), all passing\n`
    : `checked ${String(files.length)} test file(s), some failing\n`,
);

process.exit(code);
