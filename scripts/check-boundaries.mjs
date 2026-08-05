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
const removedPackages = new Set(["core", "graph", "orchestrator", "report", "web"]);
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
    const source = await readFile(file, "utf8");
    for (const dependency of packageImports(source)) {
      if (removedPackages.has(dependency)) {
        failures.push(`${pathOf(file)} imports removed package @senawa/${dependency}`);
      }
    }
  }
}

for (const manifest of await manifestFiles()) {
  const value = JSON.parse(await readFile(manifest, "utf8"));
  if (typeof value.name === "string" && removedPackages.has(value.name.replace("@senawa/", ""))) {
    failures.push(`${pathOf(manifest)} declares removed package ${value.name}`);
  }
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = value[section] ?? {};
    for (const dependency of Object.keys(dependencies)) {
      const packageName = dependency.replace("@senawa/", "");
      if (removedPackages.has(packageName)) {
        failures.push(`${pathOf(manifest)} depends on removed package ${dependency}`);
      }
      if (
        value.name === "@senawa/application" &&
        dependency.startsWith("@senawa/") &&
        dependency !== "@senawa/domain"
      ) {
        failures.push(
          `${pathOf(manifest)} gives application an outward dependency on ${dependency}`,
        );
      }
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

async function manifestFiles() {
  const files = [];
  for (const directory of [join(root, "apps"), join(root, "packages")]) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    files.push(
      ...entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name === "package.json" &&
            !entry.parentPath.includes(`${join("node_modules")}`),
        )
        .map((entry) => join(entry.parentPath, entry.name)),
    );
  }
  return files;
}

function packageImports(source) {
  return [...source.matchAll(/from\s+["']@senawa\/([^"'/]+)(?:\/[^"']*)?["']/gu)].map(
    (match) => match[1],
  );
}

function pathOf(file) {
  return relative(root, file).replaceAll("\\", "/");
}
