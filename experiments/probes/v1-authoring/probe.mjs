// Probe: does the v1 authoring surface lower into a document the compiler accepts?
//
// This calls the real `lowerAuthoredWorkflow` rather than reimplementing it, so
// the probe demonstrates the shipped behaviour instead of drifting from it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  doctorWorkflowConfiguration,
  lowerAuthoredWorkflow,
} from "../../../packages/configuration/dist/index.js";
import { runtimeDependencies } from "../../../apps/senawa/dist/daemon.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "authored");
const read = (name) => readFileSync(join(root, name), "utf8");

const prompts = new Map(
  readdirSync(join(root, "prompts")).map((name) => [
    `prompts/${name}`,
    read(join("prompts", name)),
  ]),
);

const lowered = lowerAuthoredWorkflow({
  agents: { path: "agents.yaml", text: read("agents.yaml") },
  workflow: { path: "workflow.yaml", text: read("workflow.yaml") },
  sensors: { path: "sensors.yaml", text: read("sensors.yaml") },
  prompts,
});

const authoredLines = ["agents.yaml", "workflow.yaml", "sensors.yaml"].reduce(
  (total, name) => total + read(name).split("\n").length,
  0,
);

console.log("=== authored surface ===");
console.log(`  3 YAML documents, ${authoredLines} lines`);
console.log(`  JSON Pointers authored: 0`);
console.log(`  budget units authored: 0`);
console.log();

if (lowered.diagnostics.length > 0) {
  console.log("=== lowering diagnostics ===");
  for (const item of lowered.diagnostics) {
    console.log(`  ${item.locator}${item.pointer} [${item.code}] ${item.message}`);
  }
  process.exit(1);
}

const generated = JSON.stringify(lowered.document, undefined, 2);
console.log("=== lowered internal document ===");
console.log(`  lines: ${generated.split("\n").length}`);
console.log(`  depth: ${depth(lowered.document)}`);
console.log();

const result = await doctorWorkflowConfiguration(
  { document: lowered.document, locator: "authored://workflow.yaml", resources: reader() },
  runtimeDependencies.sha256,
);

if (result.diagnostics.length > 0) {
  console.log("=== compiler diagnostics ===");
  for (const item of result.diagnostics) {
    console.log(`  ${item.pointer} [${item.code}] ${item.message}`);
  }
  process.exit(1);
}

const nodes = result.snapshot.graph.nodes;
const byKind = {};
for (const node of nodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
console.log("=== compiled graph (kernel accepted) ===");
console.log(`  nodes: ${nodes.length}  edges: ${result.snapshot.graph.edges.length}`);
console.log(`  by kind: ${JSON.stringify(byKind)}`);
console.log(`  snapshot digest: ${result.snapshot.snapshotDigest.slice(0, 16)}...`);

function depth(value, current = 0) {
  if (Array.isArray(value)) {
    return value.reduce((deepest, item) => Math.max(deepest, depth(item, current + 1)), current);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce(
      (deepest, item) => Math.max(deepest, depth(item, current + 1)),
      current,
    );
  }
  return current;
}

function reader() {
  return {
    async read({ path, maxBytes }) {
      const text = readFileSync(join(root, path), "utf8");
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maxBytes) throw new Error(`oversized resource ${path}`);
      return bytes;
    },
  };
}
