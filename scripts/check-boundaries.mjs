import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const adapters = new Set([
  "artifact-store",
  "browser",
  "configuration",
  "observability",
  "reporting",
  "runtime-beads",
  "runtime-file",
  "sensors",
  "workers",
]);
const failures = [];

for (const adapter of adapters) {
  for (const file of await sourceFiles(join(root, "packages", adapter, "src"))) {
    if (file.endsWith(".test.ts")) continue;
    const source = await readFile(file, "utf8");
    for (const dependency of packageImports(source)) {
      if (adapters.has(dependency) && dependency !== adapter) {
        failures.push(`${pathOf(file)} imports concrete adapter @senawa/${dependency}`);
      }
    }
  }
}

for (const file of await sourceFiles(join(root, "packages", "application", "src"))) {
  if (file.endsWith(".test.ts")) continue;
  for (const dependency of packageImports(await readFile(file, "utf8"))) {
    if (dependency !== "domain") {
      failures.push(
        `${pathOf(file)} imports @senawa/${dependency}; application may import domain only`,
      );
    }
  }
}

for (const file of await sourceFiles(join(root, "packages", "domain", "src"))) {
  if (packageImports(await readFile(file, "utf8")).length > 0) {
    failures.push(`${pathOf(file)} imports a production package; domain must remain inward-only`);
  }
}

for (const directory of [join(root, "apps"), join(root, "packages")]) {
  for (const file of await sourceFiles(directory)) {
    if (file.endsWith(".test.ts")) continue;
    const source = await readFile(file, "utf8");
    if (/from\s+["']@senawa\/(?:web|report)["']/u.test(source)) {
      failures.push(`${pathOf(file)} imports an old production package name`);
    }
  }
}

for (const [facade, target] of [
  ["web", "browser"],
  ["report", "reporting"],
]) {
  for (const file of await sourceFiles(join(root, "packages", facade, "src"))) {
    if (file.endsWith(".test.ts")) continue;
    const source = (await readFile(file, "utf8")).trim();
    if (!/^export \* from ["'][^"']+["'];$/u.test(source)) {
      failures.push(`${pathOf(file)} is not a thin re-export facade for @senawa/${target}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `Package boundary violations:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
}
process.stdout.write("Package boundary checks passed.\n");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function packageImports(source) {
  return [...source.matchAll(/from\s+["']@senawa\/([^"'/]+)(?:\/[^"']*)?["']/gu)].map(
    (match) => match[1],
  );
}

function pathOf(file) {
  return relative(root, file).replaceAll("\\", "/");
}
