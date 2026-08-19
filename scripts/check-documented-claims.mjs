import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks that every documented claim names a test that really exists.
 *
 * A documentation index that points at tests is only worth having if the
 * pointers are checked. Otherwise a test gets renamed, the link rots quietly,
 * and the index becomes a list of claims nobody is proving any more, which reads
 * more trustworthy than saying nothing at all.
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const indexPath = join(root, "docs", "reference", "acceptances.md");

const ROW = /^\|\s*(?<claim>[^|]+?)\s*\|\s*(?<where>[^|]+?)\s*\|\s*`(?<test>[^`]+)`\s*\|\s*$/;

const text = await readFile(indexPath, "utf8");
const rows = text
  .split("\n")
  .map((line) => ROW.exec(line)?.groups)
  .filter((groups) => groups !== undefined);

if (rows.length === 0) {
  throw new Error("docs/reference/acceptances.md lists no claims");
}

const sources = await collectSources(root);
const failures = [];

for (const { claim, where, test } of rows) {
  const [file, name] = test.split(" > ").map((part) => part.trim());
  if (name === undefined) {
    failures.push(`${claim}: "${test}" is not "<file> > <test name>"`);
    continue;
  }
  const matches = sources.filter((path) => path.endsWith(file));
  if (matches.length === 0) {
    failures.push(`${claim}: no test file named ${file}`);
    continue;
  }
  const found = await Promise.all(
    matches.map(async (path) => (await readFile(path, "utf8")).includes(name)),
  );
  if (!found.includes(true)) {
    failures.push(`${claim}: ${file} has no test named "${name}"`);
    continue;
  }
  const document = join(root, where);
  try {
    await readFile(document, "utf8");
  } catch {
    failures.push(`${claim}: no document at ${where}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.stderr.write(`\n${failures.length} documented claims name nothing that exists.\n`);
  process.exit(1);
}

process.stdout.write(`Validated ${rows.length} documented claims against their acceptances.\n`);

async function collectSources(directory) {
  const found = [];
  for (const parent of ["apps", "packages", "tests"]) {
    await walk(join(directory, parent), found);
  }
  return found;
}

async function walk(directory, found) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, found);
      continue;
    }
    if (entry.name.endsWith(".test.ts")) found.push(path);
  }
}
