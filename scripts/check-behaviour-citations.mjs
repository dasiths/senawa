import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks that every canonical behaviour is accounted for somewhere.
 *
 * The brief says to cite a behaviour's id rather than restate the row, which
 * only works if the citations are real. An id nobody cites is a promise the
 * project has quietly stopped tracking, and the brief still makes it.
 *
 * This proves each behaviour is accounted for, not that it is implemented. A
 * citation can say a behaviour is deferred; what it cannot do is not exist.
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const briefPath = join(root, "docs", "design", "WIP", "redesign-2", "brief.md");

const brief = await readFile(briefPath, "utf8");
const ROW = /^\|\s*(?<id>[A-Z]{2}-[0-9]{2})\s*\|\s*(?<must>[^|]+?)\s*\|/gm;

const behaviours = [...brief.matchAll(ROW)].map((match) => ({
  id: match.groups.id,
  must: match.groups.must,
}));

if (behaviours.length === 0) throw new Error("The brief lists no canonical behaviours");

const citations = await collectCitations(root);
const uncited = behaviours.filter(({ id }) => !citations.some((text) => text.includes(id)));

if (uncited.length > 0) {
  for (const { id, must } of uncited) {
    process.stderr.write(`${id} is cited nowhere: senawa must ${must}\n`);
  }
  process.stderr.write(
    `\n${uncited.length} canonical behaviours are promised and tracked nowhere.\n` +
      "Cite the id from a plan item, a test name, or a decision.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `Validated ${behaviours.length} canonical behaviours against their citations.\n`,
);

async function collectCitations(directory) {
  const texts = [];
  for (const parent of ["apps", "packages", "docs", "tests", "README.md"]) {
    await walk(join(directory, parent), texts, briefPath);
  }
  return texts;
}

async function walk(target, texts, skip) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    if (target !== skip) texts.push(await readFile(target, "utf8"));
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(target, entry.name);
    if (entry.isDirectory()) {
      await walk(path, texts, skip);
      continue;
    }
    if (!/\.(ts|md|sql)$/.test(entry.name) || path === skip) continue;
    texts.push(await readFile(path, "utf8"));
  }
}
