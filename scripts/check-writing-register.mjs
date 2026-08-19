import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps consumer-facing pages in the register the canonical behaviours use.
 *
 * The behaviours are written in plain words on purpose: "work out how data moves
 * between phases" rather than "resolve the dataflow graph". A guide that reaches
 * for the second kind of word asks a reader to learn vocabulary before they can
 * learn the product, and the vocabulary is the part they never needed.
 *
 * Design documents are exempt. A reader there has already chosen to look inside.
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Each word, and what to write instead. */
const REPLACEMENTS = new Map([
  ["idempotent", "say what a repeated call does"],
  ["monotonic", "say it counts up and never goes back"],
  ["monotonically", "say it counts up and never goes back"],
  ["rehydrate", "say read back"],
  ["rehydrated", "say read back"],
  ["reify", "say make real"],
  ["orchestrate", "say drive"],
  ["orchestrates", "say drives"],
  ["leverage", "say use"],
  ["leverages", "say uses"],
  ["utilise", "say use"],
  ["utilize", "say use"],
  ["facilitate", "say let"],
  ["facilitates", "say lets"],
  ["seamless", "say what it actually does"],
  ["seamlessly", "say what it actually does"],
  ["performant", "say how fast, and at what"],
  ["robustly", "say what it survives"],
  ["synergy", "say what the two things do together"],
  ["holistic", "say what it covers"],
  ["paradigm", "say what the approach is"],
]);

const PAGES = ["docs/guide", "docs/reference", "README.md"];

const failures = [];
for (const entry of PAGES) {
  for (const path of await markdownUnder(join(root, entry))) {
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      // A fenced example or an inline literal is quoting something, not
      // explaining it, so the register does not apply there.
      if (line.trimStart().startsWith("```")) return;
      const prose = line.replaceAll(/`[^`]*`/g, "");
      for (const [word, instead] of REPLACEMENTS) {
        if (!new RegExp(`\\b${word}\\b`, "i").test(prose)) continue;
        failures.push(`${relative(root, path)}:${index + 1}: "${word}" — ${instead}`);
      }
    });
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.stderr.write(
    `\n${failures.length} consumer-facing lines use a word the canonical behaviours avoid.\n`,
  );
  process.exit(1);
}

process.stdout.write("Validated the register of every consumer-facing page.\n");

async function markdownUnder(target) {
  const found = [];
  await walk(target, found);
  return found;
}

async function walk(target, found) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    if (target.endsWith(".md")) found.push(target);
    return;
  }
  for (const entry of entries) {
    const path = join(target, entry.name);
    if (entry.isDirectory()) {
      await walk(path, found);
      continue;
    }
    if (entry.name.endsWith(".md")) found.push(path);
  }
}
