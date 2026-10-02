import { readdir, readFile } from "node:fs/promises";
import { builtinModules, isBuiltin } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";

const NODE_BUILTINS = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/u, "")));

/**
 * Matches reads of ambient time or randomness.
 *
 * A boundary check that lists only a few spellings is not an enforcement
 * mechanism, because the next author reaches for an unlisted spelling and the
 * check stays green. Every common way to read a clock or a random source
 * belongs here, including the destructured and bare-callee forms. `Date.parse`
 * is deliberately absent: it is a pure function of its argument.
 */
const AMBIENT_TIME_OR_RANDOM_PATTERN =
  /(?:\b(?:Date\s*\.\s*now|new\s+Date\b|Math\s*\.\s*random|performance\s*\.\s*now|hrtime|(?:crypto\s*\.\s*)?(?:randomUUID|getRandomValues|randomBytes|randomInt)\s*\()|\{[^}]*\}\s*=\s*(?:Date|Math|crypto|performance)\b)/u;

/** Matches ambient effects that are additionally forbidden inside the kernel. */
const AMBIENT_EFFECT_PATTERN =
  /\b(?:process\s*\.|globalThis\s*\.|fetch\s*\(|Worker\s*\(|setTimeout\s*\(|setInterval\s*\(|setImmediate\s*\(|queueMicrotask\s*\()/u;

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

const reportingManifest = JSON.parse(await readFile("packages/reporting/package.json", "utf8"));
const reportingDependencies = Object.keys(reportingManifest.dependencies ?? {});
const allowedReportingDependencies = new Set([
  "@senawa/kernel",
  "@senawa/protocol",
  "@senawa/runtime",
]);
if (reportingDependencies.some((dependency) => !allowedReportingDependencies.has(dependency))) {
  violations.push(
    "packages/reporting/package.json: reporting may depend only on kernel, protocol, and runtime packages",
  );
}

const configurationManifest = JSON.parse(
  await readFile("packages/configuration/package.json", "utf8"),
);
const configurationDependencies = Object.keys(configurationManifest.dependencies ?? {});
const allowedConfigurationDependencies = new Set([
  "@senawa/kernel",
  "ajv",
  "json-schema-traverse",
  "yaml",
]);
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
  "@senawa/configuration",
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
  "@senawa/configuration",
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

const controlPlaneManifest = JSON.parse(await readFile("apps/control-plane/package.json", "utf8"));
const controlPlaneDependencies = Object.keys(controlPlaneManifest.dependencies ?? {});
if (controlPlaneDependencies.length !== 1 || controlPlaneDependencies[0] !== "@senawa/protocol") {
  violations.push(
    "apps/control-plane/package.json: control-plane may depend only on protocol in production",
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
  const isReporting = file.startsWith("packages/reporting/");
  const isReportingProduction = isReporting && !file.endsWith(".test.ts");
  const isConfiguration = file.startsWith("packages/configuration/");
  const isExecutionHost = file.startsWith("packages/execution-host/");
  const isPortal = file.startsWith("packages/portal/src/") && !file.endsWith(".test.ts");
  const isControlPlane = file.startsWith("apps/control-plane/src/") && !file.endsWith(".test.ts");
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
  if (
    (isKernel || isProtocol || isRuntime || isReportingProduction || isConfiguration) &&
    hasNodeRuntimeImport(content)
  ) {
    const packageName = isKernel
      ? "kernel"
      : isProtocol
        ? "protocol"
        : isRuntime
          ? "runtime"
          : isReporting
            ? "reporting"
            : "configuration";
    findings.push(`${file}: ${packageName} cannot import Node modules`);
  }
  if (isPortal && hasNodeRuntimeImport(content)) {
    findings.push(`${file}: portal production source cannot import Node modules`);
  }
  if (isPortal && /@senawa\/(?!protocol(?:["'/]|$))[a-z0-9-]+/u.test(content)) {
    findings.push(`${file}: portal production source may import only protocol`);
  }
  if (isControlPlane && hasUnsupportedControlPlaneImport(content)) {
    findings.push(
      `${file}: control-plane production source may import only protocol, Node built-ins, and sibling modules`,
    );
  }
  if (isProtocol && content.includes("@senawa/kernel")) {
    findings.push(`${file}: protocol cannot import kernel behavior`);
  }
  if (isProtocol && /@senawa\/[a-z0-9-]+/u.test(content)) {
    findings.push(`${file}: protocol cannot import workspace packages`);
  }
  if (isKernel && !file.endsWith(".test.ts") && hasNondeterministicSource(content)) {
    findings.push(`${file}: kernel cannot observe runtime state or external effects`);
  }
  if (isRuntime && !file.endsWith(".test.ts") && hasAmbientTimeOrRandomSource(content)) {
    findings.push(`${file}: runtime must receive current time and identifier allocation`);
  }
  if (isPackage && !isBrowserSystemTest && hasRelativeCrossPackageImport(file, content)) {
    findings.push(`${file}: packages cannot reach another package through a relative path`);
  }
  if (isRuntime && /@senawa\/(?!kernel(?:["'/]|$)|protocol(?:["'/]|$))[a-z0-9-]+/u.test(content)) {
    findings.push(`${file}: runtime may import only protocol and kernel packages`);
  }
  if (
    isReportingProduction &&
    /@senawa\/(?!kernel(?:["'/]|$)|protocol(?:["'/]|$)|runtime(?:["'/]|$))[a-z0-9-]+/u.test(content)
  ) {
    findings.push(`${file}: reporting may import only kernel, protocol, and runtime packages`);
  }
  if (isConfiguration && /@senawa\/(?!kernel(?:["'/]|$))[a-z0-9-]+/u.test(content)) {
    findings.push(`${file}: configuration may import only the kernel package`);
  }
  if (
    isExecutionHost &&
    /@senawa\/(?!configuration(?:["'/]|$)|kernel(?:["'/]|$)|protocol(?:["'/]|$)|runtime(?:["'/]|$))[a-z0-9-]+/u.test(
      content,
    )
  ) {
    findings.push(
      `${file}: execution-host may import only configuration, kernel, protocol, and runtime packages`,
    );
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

function hasAmbientTimeOrRandomSource(content) {
  return AMBIENT_TIME_OR_RANDOM_PATTERN.test(content);
}

function hasNondeterministicSource(content) {
  return hasAmbientTimeOrRandomSource(content) || AMBIENT_EFFECT_PATTERN.test(content);
}

/**
 * Detects a relative import that escapes its own package.
 *
 * Every package rule above matches `@senawa/<name>` specifiers. Without this
 * rule each of them is defeated by spelling the same dependency as
 * `../../<package>/src/index.js`, so the specifier-based rules would describe a
 * boundary rather than enforce one.
 */
function hasRelativeCrossPackageImport(file, content) {
  const packageRoot = /^(packages\/[^/]+)\//u.exec(file)?.[1];
  if (packageRoot === undefined) return false;
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
    if (specifier?.startsWith(".")) {
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!resolved.startsWith(`${packageRoot}/`)) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
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

function hasUnsupportedControlPlaneImport(content) {
  const source = ts.createSourceFile(
    "control-plane-boundary-probe.ts",
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node) => {
    if (found) return;
    const specifier = moduleSpecifier(node);
    if (
      specifier !== undefined &&
      specifier !== "@senawa/protocol" &&
      !isNodeBuiltin(specifier) &&
      !specifier.startsWith("./")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function verifyRules() {
  const cases = [
    ["packages/kernel/src/bad.ts", "const at = new Date();", "cannot observe runtime state"],
    [
      "packages/kernel/src/bad.ts",
      "const id = crypto.randomUUID();",
      "cannot observe runtime state",
    ],
    ["packages/kernel/src/bad.ts", "const at = performance.now();", "cannot observe runtime state"],
    [
      "packages/kernel/src/bad.ts",
      "setTimeout(() => undefined, 1);",
      "cannot observe runtime state",
    ],
    ["packages/kernel/src/bad.ts", "const { now } = Date;\nnow();", "cannot observe runtime state"],
    ["packages/runtime/src/bad.ts", "const id = randomUUID();", "must receive current time"],
    [
      "packages/protocol/src/bad.ts",
      'import "@senawa/storage-sqlite";',
      "cannot import workspace packages",
    ],
    [
      "packages/protocol/src/bad.ts",
      'import "@senawa/runtime";',
      "cannot import workspace packages",
    ],
    [
      "packages/runtime/src/bad.ts",
      'import "../../storage-sqlite/src/index.js";',
      "cannot reach another package through a relative path",
    ],
    [
      "packages/portal/src/bad.ts",
      'export { x } from "../../kernel/src/index.js";',
      "cannot reach another package through a relative path",
    ],
    ["packages/kernel/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
    ["packages/protocol/src/bad.ts", 'import "node:http";', "cannot import Node modules"],
    ["packages/portal/src/bad.ts", 'import "node:crypto";', "cannot import Node modules"],
    ["packages/portal/src/bad.ts", 'import "@senawa/kernel";', "may import only protocol"],
    ["packages/runtime/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
    ["packages/reporting/src/bad.ts", 'import "node:fs";', "cannot import Node modules"],
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
      "packages/reporting/src/bad.ts",
      'import "@senawa/storage-sqlite";',
      "may import only kernel, protocol, and runtime packages",
    ],
    [
      "packages/configuration/src/bad.ts",
      'import "@senawa/runtime";',
      "may import only the kernel",
    ],
    [
      "packages/execution-host/src/bad.ts",
      'import "@senawa/storage-sqlite";',
      "may import only configuration, kernel, protocol, and runtime packages",
    ],
    [
      "packages/execution-host/src/bad.ts",
      'import "../../../apps/senawa/src/main.js";',
      "packages cannot import apps",
    ],
    [
      "apps/control-plane/src/bad.ts",
      'import "@senawa/supervisor";',
      "may import only protocol, Node built-ins, and sibling modules",
    ],
    [
      "apps/control-plane/src/bad.ts",
      'import "../../../packages/storage-sqlite/src/index.js";',
      "may import only protocol, Node built-ins, and sibling modules",
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
