import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageFiles = await collect("packages");
const appFiles = await collect("apps");
const violations = [];

const runtimeManifest = JSON.parse(await readFile("packages/runtime/package.json", "utf8"));
const runtimeDependencies = Object.keys(runtimeManifest.dependencies ?? {});
if (
  runtimeDependencies.some(
    (dependency) => dependency !== "@senawa/kernel" && dependency !== "@senawa/protocol",
  )
) {
  violations.push(
    "packages/runtime/package.json: runtime may depend only on protocol and kernel packages",
  );
}

const storageManifest = JSON.parse(await readFile("packages/storage-sqlite/package.json", "utf8"));
const storageDependencies = Object.keys(storageManifest.dependencies ?? {});
const allowedStorageDependencies = new Set([
  "@senawa/kernel",
  "@senawa/protocol",
  "@senawa/runtime",
  "better-sqlite3",
]);
if (storageDependencies.some((dependency) => !allowedStorageDependencies.has(dependency))) {
  violations.push(
    "packages/storage-sqlite/package.json: storage-sqlite has an unsupported production dependency",
  );
}

for (const file of [...packageFiles, ...appFiles]) {
  const content = await readFile(file, "utf8");
  violations.push(...checkSource(file, content));
}

verifyRules();

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Validated architecture boundaries across ${packageFiles.length + appFiles.length} source files.`,
  );
}

function checkSource(file, content) {
  const findings = [];
  const isKernel = file.startsWith("packages/kernel/");
  const isProtocol = file.startsWith("packages/protocol/");
  const isRuntime = file.startsWith("packages/runtime/");
  const isPackage = file.startsWith("packages/");
  if (isPackage && /(?:from\s+|import\s*(?:\(\s*)?)["'][^"']*apps\//u.test(content)) {
    findings.push(`${file}: packages cannot import apps`);
  }
  if (isPackage && !file.endsWith(".test.ts") && content.includes("@senawa/testing")) {
    findings.push(`${file}: production packages cannot import testing`);
  }
  if ((isKernel || isProtocol || isRuntime) && hasNodeRuntimeImport(content)) {
    const packageName = isKernel ? "kernel" : isProtocol ? "protocol" : "runtime";
    findings.push(`${file}: ${packageName} cannot import Node modules`);
  }
  if (isProtocol && content.includes("@senawa/kernel")) {
    findings.push(`${file}: protocol cannot import kernel behavior`);
  }
  if (isKernel && /\b(?:Date\.now|Math\.random|process\.|fetch\s*\(|Worker\s*\()/u.test(content)) {
    findings.push(`${file}: kernel cannot observe runtime state or external effects`);
  }
  if (isRuntime && /\b(?:Date\.now|Math\.random)\s*\(/u.test(content)) {
    findings.push(`${file}: runtime must receive current time and identifier allocation`);
  }
  if (isRuntime && /@senawa\/(?!kernel(?:["'/]|$)|protocol(?:["'/]|$))[a-z0-9-]+/u.test(content)) {
    findings.push(`${file}: runtime may import only protocol and kernel packages`);
  }
  if (
    isKernel &&
    /@senawa\/(?:runtime|storage|execution-host|sensors|workers|git|supervisor|portal)/u.test(
      content,
    )
  ) {
    findings.push(`${file}: kernel cannot import effect or adapter packages`);
  }
  return findings;
}

function hasNodeRuntimeImport(content) {
  return /(?:from\s+|import\s*(?:\(\s*)?)["'](?:node:|fs(?:\/promises)?["']|path["']|http["']|child_process["']|crypto["'])/u.test(
    content,
  );
}

function verifyRules() {
  const cases = [
    ["packages/kernel/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
    ["packages/protocol/src/bad.ts", 'import "node:http";', "cannot import Node modules"],
    ["packages/runtime/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
    ["packages/kernel/src/bad.ts", "Date.now();", "cannot observe runtime state"],
    ["packages/kernel/src/bad.ts", "Math.random();", "cannot observe runtime state"],
    ["packages/runtime/src/bad.ts", "const now = Date.now();", "must receive current time"],
    ["packages/kernel/src/bad.ts", "process.cwd();", "cannot observe runtime state"],
    [
      "packages/kernel/src/bad.ts",
      'fetch("https://example.test");',
      "cannot observe runtime state",
    ],
    ["packages/kernel/src/bad.ts", 'new Worker("worker.js");', "cannot observe runtime state"],
    [
      "packages/kernel/src/bad.ts",
      'import "@senawa/execution-host";',
      "cannot import effect or adapter packages",
    ],
    ["packages/protocol/src/bad.ts", 'import "@senawa/kernel";', "cannot import kernel"],
    [
      "packages/runtime/src/bad.ts",
      'import "@senawa/storage-sqlite";',
      "may import only protocol and kernel",
    ],
    ["packages/example/src/bad.ts", 'import "@senawa/testing";', "cannot import testing"],
    [
      "packages/example/src/bad.ts",
      'import "../../../apps/senawa/src/main.js";',
      "cannot import apps",
    ],
  ];
  for (const [file, content, expected] of cases) {
    if (!checkSource(file, content).some((finding) => finding.includes(expected))) {
      throw new Error(`Boundary self-test failed for ${file}: ${expected}`);
    }
  }
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? collect(path) : path.endsWith(".ts") ? [path] : [];
      }),
    )
  ).flat();
}
