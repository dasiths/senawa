import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

/**
 * Reports exported runtime values that no production file mentions.
 *
 * The plan's acceptance is that no exported production symbol lacks a
 * production caller. Taken literally that also condemns every exported type: a
 * type describing a function's parameters is used by callers who write an
 * object literal and never name it. So this checks values only, which is where
 * dead code accumulates and where an unused export misleads a later author into
 * thinking a surface is supported.
 *
 * Test-support modules are declared rather than inferred, because guessing from
 * a filename would let a genuinely dead module hide behind a plausible name.
 */
const TEST_SUPPORT = new Map([
  ["packages/testing/src/", "the testing package exists to be consumed by other suites"],
  ["apps/senawa/src/brief-scenarios.ts", "the harness the brief's diagrams are tested with"],
  ["apps/control-plane/src/fixtures.ts", "control plane signing fixtures"],
]);

/** Surfaces consumed by name from outside the workspace. */
const PUBLISHED = new Set(["index.ts", "cli.ts", "daemon.ts"]);

const files = [];
for (const root of ["packages", "apps"]) files.push(...(await collect(root)));

const sources = new Map();
for (const file of files) sources.set(file, await readFile(file, "utf8"));

const mentions = new Map();
for (const [file, text] of sources) {
  for (const name of identifiers(text, file)) {
    const seen = mentions.get(name);
    if (seen === undefined) mentions.set(name, new Set([file]));
    else seen.add(file);
  }
}

// `export * from "./x.js"` names nothing, so counting identifiers cannot see it.
// Every file a published entry re-exports wholesale is itself published.
const republished = new Set();
for (const [file, text] of sources) {
  if (!PUBLISHED.has(file.split("/").at(-1))) continue;
  for (const target of starExports(text, file)) republished.add(target);
}

const findings = [];
for (const [file, text] of sources) {
  if (isTest(file) || isTestSupport(file)) continue;
  if (PUBLISHED.has(file.split("/").at(-1)) || republished.has(file)) continue;
  for (const name of exportedValues(text, file)) {
    // A value nothing else names, not even a test, is dead. A value its own
    // test names is an internal under test, which is a reason to export it.
    const mentioned = mentions.get(name) ?? new Set();
    if ([...mentioned].every((candidate) => candidate === file)) findings.push(`${file}: ${name}`);
  }
}

if (findings.length > 0) {
  console.error(`Found ${findings.length} exported values with no production caller:`);
  for (const finding of findings.sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Validated exported values across ${sources.size} files.`);
}

function isTest(file) {
  return file.endsWith(".test.ts") || file.includes("/tests/");
}

function isTestSupport(file) {
  return [...TEST_SUPPORT.keys()].some((prefix) => file.startsWith(prefix));
}

function starExports(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const targets = [];
  const directory = file.slice(0, file.lastIndexOf("/"));
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause !== undefined) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith(".")) continue;
    targets.push(join(directory, specifier.text.replace(/\.js$/u, ".ts")));
  }
  return targets;
}

function exportedValues(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const names = [];
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function identifiers(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found = new Set();
  const walk = (node) => {
    if (ts.isIdentifier(node)) found.add(node.text);
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(source, walk);
  return found;
}

async function collect(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}
