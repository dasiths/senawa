import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const markdownFiles = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "*.md"], {
  encoding: "utf8",
})
  .stdout.trim()
  .split("\n")
  .filter(Boolean);
const failures = [];
const anchorCache = new Map();

for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    const href = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(href)) continue;
    const [rawPath, rawFragment] = href.split("#", 2);
    const target = resolve(dirname(file), decodeURIComponent(rawPath));
    try {
      const information = await stat(target);
      if (
        rawFragment !== undefined &&
        information.isFile() &&
        !(await anchors(target)).has(decodeURIComponent(rawFragment))
      ) {
        failures.push(`${file}: missing anchor ${href}`);
      }
    } catch {
      failures.push(`${file}: missing target ${href}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Validated local Markdown targets and anchors in ${markdownFiles.length} files.\n`,
  );
}

async function anchors(file) {
  const cached = anchorCache.get(file);
  if (cached !== undefined) return cached;
  const source = await readFile(file, "utf8");
  const values = new Set(
    [...source.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/giu)].map((match) => match[1]),
  );
  const counts = new Map();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
    const base = match[1]
      .replace(/`([^`]*)`/gu, "$1")
      .replace(/<[^>]+>/gu, "")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    values.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(file, values);
  return values;
}
