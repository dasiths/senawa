// Probe: does the v1 authoring surface lower into a graph the kernel accepts?
//
// This is a proof of concept for the Phase 0 authoring format spike. It parses
// the three authored YAML documents, derives everything the current template
// makes an author write by hand, and compiles the result with the real kernel.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  compileWorkflowGraph,
  consumerKey,
  criterionId,
  definitionGeneration,
  phaseId,
  taskId,
  workflowId,
} from "../../../packages/kernel/dist/index.js";
import { runtimeDependencies } from "../../../apps/senawa/dist/daemon.js";

const here = dirname(fileURLToPath(import.meta.url));
const authored = join(here, "authored");
const sha256 = runtimeDependencies.sha256;
const read = (name) => parse(readFileSync(join(authored, name), "utf8"));

const agents = read("agents.yaml");
const workflow = read("workflow.yaml");
const sensors = read("sensors.yaml");

const problems = [];
const note = (message) => problems.push(message);

// --- Derivation -------------------------------------------------------------
// Everything below is what an author writes today and should not have to.

const wf = workflowId(`workflow_${workflow.name}`);
const source = (pointer) => ({ locator: "authored://workflow.yaml", pointer });
const gen = definitionGeneration(1);

/** Members of a fan-out become phases parented to the fan-out phase (D-001). */
const FANOUT_SAMPLE = 3;

const phases = [];
const executableWork = [];
const criteria = [];

for (const [index, phase] of workflow.phases.entries()) {
  const pid = phaseId(`phase_${phase.name}`);
  const pointer = `/phases/${index}`;

  if (agents[phase.agent] === undefined) note(`phase ${phase.name}: unknown agent ${phase.agent}`);
  for (const gate of phase.gates ?? []) {
    if (sensors.gates?.[gate] === undefined) note(`phase ${phase.name}: unknown gate ${gate}`);
  }

  phases.push({
    id: pid,
    key: consumerKey(phase.name),
    generation: gen,
    parentId: wf,
    source: source(pointer),
    // `needs` is the authored form of dependsOn. Nothing else is required.
    ...(phase.needs === undefined ? {} : { dependsOn: phase.needs.map((n) => phaseId(`phase_${n}`)) }),
  });

  // A phase running an agent needs one unit of executable work. The current
  // compiler already synthesises exactly this and calls it `phase-executor`.
  const addExecutor = (ownerId, ownerPointer, suffix) => {
    const tid = taskId(`task_${suffix}-executor`);
    const cid = criterionId(`criterion_${suffix}-produced`);
    executableWork.push({
      id: tid,
      key: consumerKey("phase-executor"),
      generation: gen,
      parentId: ownerId,
      source: source(`${ownerPointer}/executor`),
      completionPolicy: {
        criteria: [{ criterionId: cid, required: true }],
        evidencePolicy: { mode: "none", requirements: [] },
      },
    });
    criteria.push({
      id: cid,
      key: consumerKey(`${suffix}-produced`),
      generation: gen,
      parentId: tid,
      source: source(`${ownerPointer}/output`),
    });
  };

  if (phase.forEach === undefined) {
    addExecutor(pid, pointer, phase.name);
    continue;
  }

  // Fan-out. The collection is not known until the earlier phase runs, so the
  // probe materialises a representative sample to prove the shape compiles.
  const [sourcePhase] = String(phase.forEach).split(".");
  if (!workflow.phases.some(({ name }) => name === sourcePhase)) {
    note(`phase ${phase.name}: forEach references unknown phase ${sourcePhase}`);
  }
  if (!(phase.needs ?? []).includes(sourcePhase)) {
    note(`phase ${phase.name}: forEach reads ${sourcePhase} but does not declare it in needs`);
  }
  for (let member = 0; member < FANOUT_SAMPLE; member += 1) {
    const memberName = `${phase.name}-${member}`;
    const memberId = phaseId(`phase_${memberName}`);
    phases.push({
      id: memberId,
      key: consumerKey(memberName),
      generation: gen,
      parentId: pid,
      source: source(`${pointer}/forEach/${member}`),
      // Members run sequentially in v1, so each depends on the one before it.
      ...(member === 0 ? {} : { dependsOn: [phaseId(`phase_${phase.name}-${member - 1}`)] }),
    });
    addExecutor(memberId, `${pointer}/forEach/${member}`, memberName);
  }
}

// Derived input bindings. An author names `needs`; the binding is the earlier
// phase's declared output. No JSON Pointer is authored anywhere.
const bindings = workflow.phases.flatMap((phase) =>
  (phase.needs ?? []).map((need) => ({
    phase: phase.name,
    from: `${need}.output`,
    sourcePointer: "",
    destinationPointer: `/${need}`,
  })),
);

// --- Compile ----------------------------------------------------------------

let graph;
try {
  graph = compileWorkflowGraph(
    {
      workflow: { id: wf, key: consumerKey(workflow.name), generation: gen, source: source("") },
      phases,
      executableWork,
      criteria,
    },
    sha256,
  );
} catch (error) {
  console.error("COMPILE FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}

// --- Report -----------------------------------------------------------------

const authoredBytes = ["agents.yaml", "workflow.yaml", "sensors.yaml"].reduce(
  (total, name) => total + readFileSync(join(authored, name), "utf8").split("\n").length,
  0,
);

const byKind = {};
for (const node of graph.nodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;

console.log("=== authored surface ===");
console.log(`  3 YAML documents, ${authoredBytes} lines total`);
console.log(`  phases authored: ${workflow.phases.length}`);
console.log(`  JSON Pointers authored: 0`);
console.log(`  budget units authored: 0`);
console.log();
console.log("=== compiled graph (kernel accepted) ===");
console.log(`  nodes: ${graph.nodes.length}  edges: ${graph.edges.length}`);
console.log(`  by kind: ${JSON.stringify(byKind)}`);
console.log(`  revision: ${graph.revisionDigest.slice(0, 16)}...`);
console.log();
console.log("=== derived, not authored ===");
console.log(`  input bindings: ${bindings.length}`);
console.log(`  executor tasks: ${executableWork.length}`);
console.log(`  criteria: ${criteria.length}`);
console.log(`  fan-out member phases: ${FANOUT_SAMPLE} (sampled; real count is runtime)`);
console.log();

const memberPhases = graph.nodes.filter(
  (node) => node.kind === "phase" && String(node.definition.parentId).startsWith("phase_"),
);
console.log("=== fan-out members are phases grouped under their parent ===");
for (const node of memberPhases) {
  console.log(`  ${node.definition.key} -> parent ${node.definition.parentId}`);
}
console.log();

if (problems.length > 0) {
  console.log("=== diagnostics ===");
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log("No diagnostics.");
}

writeFileSync(
  join(here, "compiled-graph.json"),
  `${JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, undefined, 2)}\n`,
);
