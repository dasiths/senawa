import { readdir, readFile } from "node:fs/promises";
import { builtinModules, isBuiltin } from "node:module";
import { join } from "node:path";
import ts from "typescript";

const NODE_BUILTINS = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/u, "")));

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

const configurationManifest = JSON.parse(
  await readFile("packages/configuration/package.json", "utf8"),
);
const configurationDependencies = Object.keys(configurationManifest.dependencies ?? {});
const allowedConfigurationDependencies = new Set(["@senawa/kernel", "ajv", "json-schema-traverse"]);
if (
  configurationDependencies.some((dependency) => !allowedConfigurationDependencies.has(dependency))
) {
  violations.push(
    "packages/configuration/package.json: configuration has an unsupported production dependency",
  );
}

const executionHostManifest = JSON.parse(
  await readFile("packages/execution-host/package.json", "utf8"),
);
const executionHostDependencies = Object.keys(executionHostManifest.dependencies ?? {});
const allowedExecutionHostDependencies = new Set([
  "@github/copilot-sdk",
  "@senawa/kernel",
  "@senawa/protocol",
  "@senawa/runtime",
]);
if (
  executionHostDependencies.some((dependency) => !allowedExecutionHostDependencies.has(dependency))
) {
  violations.push(
    "packages/execution-host/package.json: execution-host has an unsupported production dependency",
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

const supervisorManifest = JSON.parse(await readFile("packages/supervisor/package.json", "utf8"));
const supervisorDependencies = Object.keys(supervisorManifest.dependencies ?? {});
const allowedSupervisorDependencies = new Set([
  "@senawa/protocol",
  "@senawa/runtime",
  "@senawa/storage-sqlite",
  "better-sqlite3",
]);
if (supervisorDependencies.some((dependency) => !allowedSupervisorDependencies.has(dependency))) {
  violations.push("packages/supervisor/package.json: supervisor has an unsupported dependency");
}

const portalManifest = JSON.parse(await readFile("packages/portal/package.json", "utf8"));
const portalDependencies = Object.keys(portalManifest.dependencies ?? {});
if (portalDependencies.length !== 1 || portalDependencies[0] !== "@senawa/protocol") {
  violations.push("packages/portal/package.json: portal may depend only on protocol in production");
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
  const isConfiguration = file.startsWith("packages/configuration/");
  const isExecutionHost = file.startsWith("packages/execution-host/");
  const isPortal = file.startsWith("packages/portal/src/") && !file.endsWith(".test.ts");
  const isPackage = file.startsWith("packages/");
  const isBrowserSystemTest = /^packages\/[^/]+\/tests\/browser\//u.test(file);
  if (
    isPackage &&
    !isBrowserSystemTest &&
    /(?:from\s+|import\s*(?:\(\s*)?)["'][^"']*apps\//u.test(content)
  ) {
    findings.push(`${file}: packages cannot import apps`);
  }
  if (isPackage && !file.endsWith(".test.ts") && content.includes("@senawa/testing")) {
    findings.push(`${file}: production packages cannot import testing`);
  }
  if ((isKernel || isProtocol || isRuntime || isConfiguration) && hasNodeRuntimeImport(content)) {
    const packageName = isKernel
      ? "kernel"
      : isProtocol
        ? "protocol"
        : isRuntime
          ? "runtime"
          : "configuration";
    findings.push(`${file}: ${packageName} cannot import Node modules`);
  }
  if (isPortal && hasNodeRuntimeImport(content)) {
    findings.push(`${file}: portal production source cannot import Node modules`);
  }
  if (isPortal && /@senawa\/(?!protocol(?:["'/]|$))[a-z0-9-]+/u.test(content)) {
    findings.push(`${file}: portal production source may import only protocol`);
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
  if (isConfiguration && /@senawa\/(?!kernel(?:["'/]|$))[a-z0-9-]+/u.test(content)) {
    findings.push(`${file}: configuration may import only the kernel package`);
  }
  if (
    isExecutionHost &&
    /@senawa\/(?!kernel(?:["'/]|$)|protocol(?:["'/]|$)|runtime(?:["'/]|$))[a-z0-9-]+/u.test(content)
  ) {
    findings.push(`${file}: execution-host may import only kernel, protocol, and runtime packages`);
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
  const source = ts.createSourceFile(
    "boundary-probe.ts",
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node) => {
    if (found) return;
    const specifier = moduleSpecifier(node);
    if (specifier !== undefined && isNodeBuiltin(specifier)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function moduleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

function isNodeBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/u, "");
  return NODE_BUILTINS.has(normalized) || isBuiltin(specifier) || isBuiltin(normalized);
}

function verifyRules() {
  const cases = [
    ["packages/kernel/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
    ["packages/protocol/src/bad.ts", 'import "node:http";', "cannot import Node modules"],
    ["packages/portal/src/bad.ts", 'import "node:crypto";', "cannot import Node modules"],
    ["packages/portal/src/bad.ts", 'import "@senawa/kernel";', "may import only protocol"],
    ["packages/runtime/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
    ["packages/configuration/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
    ["packages/kernel/src/bad.ts", 'import os from "os";', "cannot import Node modules"],
    [
      "packages/kernel/src/bad.ts",
      'import { promisify } from "node:util";',
      "cannot import Node modules",
    ],
    ["packages/kernel/src/bad.ts", 'const bytes = import("buffer");', "cannot import Node modules"],
    [
      "packages/kernel/src/bad.ts",
      'const streams = import("node:stream");',
      "cannot import Node modules",
    ],
    ["packages/kernel/src/bad.ts", 'export { once } from "events";', "cannot import Node modules"],
    ["packages/kernel/src/bad.ts", 'import "node:url";', "cannot import Node modules"],
    [
      "packages/kernel/src/bad.ts",
      'const workers = import("worker_threads");',
      "cannot import Node modules",
    ],
    [
      "packages/kernel/src/bad.ts",
      'import process from "node:process";',
      "cannot import Node modules",
    ],
    [
      "packages/kernel/src/bad.ts",
      'import { test } from "node:test";',
      "cannot import Node modules",
    ],
    ["packages/kernel/src/bad.ts", "await import(`node:fs`);", "cannot import Node modules"],
    [
      "packages/kernel/src/bad.ts",
      'await import/* comment */("node:fs");',
      "cannot import Node modules",
    ],
    ["packages/kernel/src/bad.ts", 'import/* comment */ "node:fs";', "cannot import Node modules"],
    ["packages/kernel/src/bad.ts", 'import fs = require("node:fs");', "cannot import Node modules"],
    ["packages/kernel/src/bad.ts", 'const fs = require("node:fs");', "cannot import Node modules"],
    [
      "packages/kernel/src/bad.ts",
      'import("node:fs", { with: {} });',
      "cannot import Node modules",
    ],
    ["packages/kernel/src/bad.ts", 'require("node:fs", undefined);', "cannot import Node modules"],
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
    [
      "packages/configuration/src/bad.ts",
      'import "@senawa/runtime";',
      "may import only the kernel",
    ],
    [
      "packages/execution-host/src/bad.ts",
      'import "@senawa/storage-sqlite";',
      "may import only kernel, protocol, and runtime packages",
    ],
    [
      "packages/execution-host/src/bad.ts",
      'import "../../../apps/senawa/src/main.js";',
      "packages cannot import apps",
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
      throw new Error(`Boundary self-test failed for ${file} (${content}): ${expected}`);
    }
  }
  if (
    checkSource(
      "packages/example/tests/browser/global-setup.ts",
      'import "../../../../apps/senawa/src/main.js";',
    ).some((finding) => finding.includes("cannot import apps"))
  ) {
    throw new Error("Boundary self-test rejected browser system-test composition");
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
