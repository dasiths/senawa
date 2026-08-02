#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(process.env.SENAWA_ROOT ?? process.cwd());
const DEFINITIONS = resolve(process.env.SENAWA_DEFINITIONS ?? process.cwd());
const WORK_DIR = join(ROOT, ".agents", ".copilot-tracking", "run");
const STATE_PATH = join(WORK_DIR, "work.json");
const JOURNAL_PATH = join(WORK_DIR, "journal.jsonl");
const SNAPSHOT = join(WORK_DIR, "snapshot");
const ajv = new Ajv2020({ allErrors: true, strict: false });

const BD_ENV = {
  ...process.env,
  BD_NON_INTERACTIVE: "1",
  DO_NOT_TRACK: "1",
  BD_JSON_ENVELOPE: "1",
  BEADS_DIR: join(ROOT, ".beads"),
};

const workflowSchema = {
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "spec"],
  properties: {
    apiVersion: { const: "senawa.dev/workflow/v1" },
    kind: { const: "Workflow" },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description"],
      properties: { name: { type: "string" }, description: { type: "string" } },
    },
    spec: {
      type: "object",
      additionalProperties: false,
      required: ["inputSchema", "phases"],
      properties: {
        inputSchema: { type: "string" },
        phases: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "executor"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
              dependsOn: { type: "array", items: { type: "string" } },
              executor: {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: { enum: ["agent", "task-frontier", "sensor-only", "human", "foreach"] },
                  role: { type: "string" },
                  output: { type: "string" },
                  concurrency: { anyOf: [{ type: "integer", minimum: 1 }, { const: "auto" }] },
                },
              },
              exit: { type: "object" },
              actions: { type: "array" },
              loop: { type: "object" },
            },
          },
        },
      },
    },
  },
};

function parseFile(path) {
  return parseYaml(readFileSync(path, "utf8"));
}

function workflowPath(name, base = DEFINITIONS) {
  return join(base, "workflows", `${name}.yaml`);
}

function loadWorkflow(name, base = DEFINITIONS) {
  return parseFile(workflowPath(name, base));
}

function loadSensors(base = DEFINITIONS) {
  return parseFile(join(base, "sensors.yaml"));
}

function hashFiles(paths) {
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash.update(path);
    hash.update(readFileSync(path));
  }
  return `sha256:${hash.digest("hex")}`;
}

function sourceFiles(name, base = DEFINITIONS) {
  const workflow = loadWorkflow(name, base);
  return [
    workflowPath(name, base),
    join(base, "sensors.yaml"),
    resolve(dirname(workflowPath(name, base)), workflow.spec.inputSchema),
  ];
}

function formatErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

function validateDefinitions(name, base = DEFINITIONS) {
  const issues = [];
  const workflow = loadWorkflow(name, base);
  const sensors = loadSensors(base);
  const validWorkflow = ajv.compile(workflowSchema);
  if (!validWorkflow(workflow)) issues.push(`workflow schema: ${formatErrors(validWorkflow.errors)}`);

  const phaseIds = new Set();
  for (const phase of workflow.spec?.phases ?? []) {
    if (phaseIds.has(phase.id)) issues.push(`duplicate phase ${phase.id}`);
    phaseIds.add(phase.id);
  }
  for (const phase of workflow.spec?.phases ?? []) {
    for (const dependency of phase.dependsOn ?? []) {
      if (!phaseIds.has(dependency)) issues.push(`${phase.id}: missing dependency ${dependency}`);
    }
    if (phase.executor?.kind === "task-frontier") {
      if (!phase.loop?.until) issues.push(`${phase.id}: task-frontier loop has no termination condition`);
      if (!Number.isInteger(phase.loop?.each?.rework?.maxAttempts)) issues.push(`${phase.id}: task-frontier loop has no finite rework budget`);
      if (!Number.isInteger(phase.loop?.each?.dispatch?.maxFailures)) issues.push(`${phase.id}: task-frontier loop has no finite dispatch budget`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map((workflow.spec?.phases ?? []).map((phase) => [phase.id, phase]));
  function visit(id) {
    if (visiting.has(id)) {
      issues.push(`phase dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of phaseIds) visit(id);

  const sensorById = new Map((sensors.sensors ?? []).map((sensor) => [sensor.id, sensor]));
  const gateById = new Map((sensors.gates ?? []).map((gate) => [gate.id, gate]));
  for (const phase of workflow.spec?.phases ?? []) {
    const gateId = phase.exit?.gate ?? phase.loop?.each?.gate;
    if (gateId && !gateById.has(gateId)) issues.push(`${phase.id}: missing gate ${gateId}`);
  }
  for (const gate of sensors.gates ?? []) {
    let deterministic = 0;
    for (const check of gate.checks ?? []) {
      const sensor = sensorById.get(check.sensor);
      if (!sensor) issues.push(`${gate.id}: missing sensor ${check.sensor}`);
      if (sensor?.kind === "deterministic" && !check.advisory) deterministic += 1;
    }
    if (deterministic === 0) issues.push(`${gate.id}: no deterministic anchor`);
  }

  const schemaPath = resolve(dirname(workflowPath(name, base)), workflow.spec.inputSchema);
  try {
    ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  } catch (error) {
    issues.push(`input schema: ${error.message}`);
  }
  return { workflow, sensors, issues };
}

function bd(args, { json = true } = {}) {
  const output = execFileSync("bd", args, {
    cwd: ROOT,
    env: BD_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!json) return output;
  const parsed = JSON.parse(output);
  return parsed?.schema_version !== undefined && "data" in parsed ? parsed.data : parsed;
}

function one(value) {
  return Array.isArray(value) ? value[0] : value;
}

function issue(id) {
  return one(bd(["show", id, "--json"]));
}

function refreshGraphState(state) {
  for (const phase of Object.values(state.phases)) phase.status = issue(phase.issueId).status;
  for (const task of state.tasks) task.status = issue(task.issueId).status;
  state.status = issue(state.epic).status === "closed" ? "finished" : "running";
  return state;
}

function closeIssue(id, reason) {
  bd(["close", id, "--reason", reason], { json: false });
}

function emit(event, fields = {}) {
  const lines = existsSync(JOURNAL_PATH)
    ? readFileSync(JOURNAL_PATH, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  appendFileSync(JOURNAL_PATH, `${JSON.stringify({ seq: lines + 1, event, at: new Date().toISOString(), ...fields })}\n`);
}

function saveState(state) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function pointer(value, path) {
  if (path === "" || path === "/") return value;
  return path.split("/").slice(1).reduce((current, part) => current?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], value);
}

function evaluateGate(gateId, context, state, definitions) {
  const gate = definitions.sensors.gates.find((candidate) => candidate.id === gateId);
  const readings = [];
  for (const check of gate.checks) {
    let assessment;
    if (check.sensor === "artifact-present") {
      assessment = existsSync(context.artifact)
        ? { verdict: "pass", summary: "artifact exists", findings: [] }
        : { verdict: "fail", summary: "artifact is missing", findings: [{ message: context.artifact }] };
    } else if (check.sensor === "task-tests") {
      const pass = context.task.key !== "implement-api" || context.attempt >= 2;
      assessment = pass
        ? { verdict: "pass", summary: "task tests passed", findings: [] }
        : { verdict: "fail", summary: "task tests failed", findings: [{ message: "seeded first-attempt failure" }] };
    } else {
      assessment = { verdict: "pass", summary: "structured advisory review passed", findings: [] };
    }
    const actual = pointer(assessment, check.expect.path);
    const matched = check.expect.operator === "equals" && actual === check.expect.value;
    readings.push({ sensor: check.sensor, assessment, matched, advisory: check.advisory === true });
  }
  const accepted = readings.every((reading) => reading.advisory || reading.matched);
  emit("gate.evaluated", { gate: gateId, phase: context.phase, task: context.task?.key, accepted, readings });
  return { accepted, readings };
}

function fakeAgentArtifact(phase, state) {
  const path = join(WORK_DIR, phase.executor.output);
  mkdirSync(dirname(path), { recursive: true });
  let value = { phase: phase.id, goal: state.input.goal };
  if (phase.id === "plan") {
    value = {
      tasks: [
        { key: "implement-api", title: "Implement the API", dependsOn: [] },
        { key: "update-caller", title: "Update the caller", dependsOn: ["implement-api"] },
      ],
    };
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  emit("phase.artifact_submitted", { phase: phase.id, path: phase.executor.output });
  return path;
}

function importPlan(phase, state) {
  if (state.tasks.length) return;
  const plan = JSON.parse(readFileSync(join(WORK_DIR, phase.executor.output), "utf8"));
  const implementPhase = state.phases.implement;
  const byKey = new Map();
  for (const task of plan.tasks) {
    const created = one(bd(["create", task.title, "-t", "task", "--parent", implementPhase.issueId, "--json"]));
    const runtime = { ...task, issueId: created.id, status: "open", attempt: 0, dispatchFailures: 0, sessionId: `session-${task.key}` };
    state.tasks.push(runtime);
    byKey.set(task.key, runtime);
  }
  for (const task of state.tasks) {
    for (const dependency of task.dependsOn) bd(["dep", "add", task.issueId, byKey.get(dependency).issueId], { json: false });
  }
  emit("plan.imported", { tasks: state.tasks.map((task) => task.key) });
}

function taskReady(task, state) {
  return task.dependsOn.every((dependency) => state.tasks.find((candidate) => candidate.key === dependency)?.status === "closed");
}

function tick() {
  const state = refreshGraphState(JSON.parse(readFileSync(STATE_PATH, "utf8")));
  const definitions = {
    workflow: loadWorkflow(state.workflow, SNAPSHOT),
    sensors: loadSensors(SNAPSHOT),
  };
  const phases = definitions.workflow.spec.phases;

  for (const phase of phases) {
    const runtime = state.phases[phase.id];
    if (runtime.status === "closed") continue;
    const dependenciesClosed = (phase.dependsOn ?? []).every((dependency) => state.phases[dependency].status === "closed");
    if (!dependenciesClosed) continue;

    if (phase.executor.kind === "agent") {
      if (runtime.status === "open") {
        runtime.status = "in_progress";
        bd(["update", runtime.issueId, "--status", "in_progress", "--json"]);
        emit("phase.dispatched", { phase: phase.id, role: phase.executor.role });
      }
      const artifact = fakeAgentArtifact(phase, state);
      const gate = evaluateGate(phase.exit.gate, { phase: phase.id, artifact }, state, definitions);
      if (gate.accepted) {
        if (phase.actions?.some((action) => action.kind === "import-plan")) importPlan(phase, state);
        runtime.status = "closed";
        closeIssue(runtime.issueId, `${phase.exit.gate} passed`);
        emit("phase.closed", { phase: phase.id });
      }
      saveState(state);
      return { action: "agent-phase", phase: phase.id, status: runtime.status };
    }

    if (phase.executor.kind === "task-frontier") {
      if (runtime.status === "open") {
        runtime.status = "in_progress";
        bd(["update", runtime.issueId, "--status", "in_progress", "--json"]);
      }
      const active = state.tasks.find((task) => task.status === "in_progress");
      const task = active ?? state.tasks.find((candidate) => candidate.status === "open" && taskReady(candidate, state));
      if (!task) {
        if (state.tasks.every((candidate) => candidate.status === "closed")) {
          runtime.status = "closed";
          closeIssue(runtime.issueId, "all selected tasks closed");
          emit("phase.closed", { phase: phase.id });
          saveState(state);
          return { action: "frontier-complete", phase: phase.id };
        }
        throw new Error("implementation frontier stalled");
      }
      task.status = "in_progress";
      task.attempt += 1;
      bd(["update", task.issueId, "--status", "in_progress", "--json"]);
      emit(task.attempt === 1 ? "task.dispatched" : "task.resumed", { task: task.key, attempt: task.attempt, sessionId: task.sessionId });
      const gate = evaluateGate(phase.loop.each.gate, { phase: phase.id, task, attempt: task.attempt }, state, definitions);
      if (gate.accepted) {
        task.status = "closed";
        closeIssue(task.issueId, `${phase.loop.each.gate} passed`);
        emit("task.closed", { task: task.key, attempt: task.attempt });
      } else if (task.attempt >= phase.loop.each.rework.maxAttempts) {
        task.status = "escalated";
        emit("task.escalated", { task: task.key, attempt: task.attempt });
      } else {
        emit("task.reworked", { task: task.key, attempt: task.attempt });
      }
      saveState(state);
      return { action: gate.accepted ? "task-closed" : "task-rework", phase: phase.id, task: task.key, attempt: task.attempt };
    }
  }

  if (Object.values(state.phases).every((phase) => phase.status === "closed")) {
    state.status = "finished";
    closeIssue(state.epic, "workflow complete");
    emit("work.finished", { workflow: state.workflow });
    saveState(state);
    return { action: "work-finished" };
  }
  return { action: "idle" };
}

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

if (command === "doctor") {
  const workflowIndex = args.indexOf("--workflow");
  const name = workflowIndex >= 0 ? args[workflowIndex + 1] : "standard-delivery";
  const result = validateDefinitions(name);
  if (result.issues.length) {
    for (const issueText of result.issues) console.error(`error: ${issueText}`);
    process.exit(1);
  }
  console.log(`ok: workflow ${name}, ${result.workflow.spec.phases.length} phases, ${result.sensors.gates.length} gates`);
} else if (command === "workflow" && subcommand === "list") {
  const rows = readdirSync(join(DEFINITIONS, "workflows"))
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => loadWorkflow(basename(file, ".yaml")).metadata);
  console.log(JSON.stringify(rows, null, 2));
} else if (command === "workflow" && subcommand === "info") {
  const workflow = loadWorkflow(args[2]);
  console.log(JSON.stringify({ ...workflow.metadata, phases: workflow.spec.phases.map((phase) => ({ id: phase.id, executor: phase.executor.kind, gate: phase.exit?.gate ?? phase.loop?.each?.gate })) }, null, 2));
} else if (command === "workflow" && subcommand === "render") {
  const workflow = loadWorkflow(args[2]);
  console.log("flowchart LR");
  for (const phase of workflow.spec.phases) {
    console.log(`  ${phase.id}[${phase.id}: ${phase.executor.kind}]`);
    for (const dependency of phase.dependsOn ?? []) console.log(`  ${dependency} --> ${phase.id}`);
  }
} else if (command === "work" && subcommand === "start") {
  const goal = args[2];
  const workflowIndex = args.indexOf("--workflow");
  const inputIndex = args.indexOf("--input");
  const name = workflowIndex >= 0 ? args[workflowIndex + 1] : "standard-delivery";
  const result = validateDefinitions(name);
  if (result.issues.length) throw new Error(`doctor failed: ${result.issues.join("; ")}`);
  const supplied = inputIndex >= 0 ? JSON.parse(readFileSync(resolve(args[inputIndex + 1]), "utf8")) : {};
  const input = { goal, ...supplied };
  const inputSchemaPath = resolve(dirname(workflowPath(name)), result.workflow.spec.inputSchema);
  const validateInput = ajv.compile(JSON.parse(readFileSync(inputSchemaPath, "utf8")));
  if (!validateInput(input)) throw new Error(`invalid workflow input: ${formatErrors(validateInput.errors)}`);

  execFileSync("bd", ["init", "--quiet", "--stealth", "--non-interactive", "--role", "maintainer"], { cwd: ROOT, env: BD_ENV, stdio: ["ignore", "ignore", "pipe"] });
  mkdirSync(SNAPSHOT, { recursive: true });
  mkdirSync(join(SNAPSHOT, "workflows"), { recursive: true });
  mkdirSync(join(SNAPSHOT, "schemas"), { recursive: true });
  for (const path of sourceFiles(name)) {
    const destination = path.endsWith("sensors.yaml")
      ? join(SNAPSHOT, "sensors.yaml")
      : path.endsWith(".schema.json")
        ? join(SNAPSHOT, "schemas", basename(path))
        : join(SNAPSHOT, "workflows", basename(path));
    copyFileSync(path, destination);
  }
  const fingerprint = hashFiles(sourceFiles(name));
  const epic = one(bd(["create", goal, "-t", "epic", "--json"]));
  const phases = {};
  for (const phase of result.workflow.spec.phases) {
    const created = one(bd(["create", `Phase: ${phase.id}`, "-t", "task", "--parent", epic.id, "--json"]));
    phases[phase.id] = { issueId: created.id, status: "open" };
  }
  for (const phase of result.workflow.spec.phases) {
    for (const dependency of phase.dependsOn ?? []) bd(["dep", "add", phases[phase.id].issueId, phases[dependency].issueId], { json: false });
  }
  const state = { workflow: name, fingerprint, input, epic: epic.id, status: "running", phases, tasks: [] };
  saveState(state);
  emit("work.started", { workflow: name, goal });
  emit("workflow.instantiated", { workflow: name, fingerprint, phases: Object.keys(phases) });
  console.log(JSON.stringify({ work: "run", epic: epic.id, workflow: name, frontier: ["define"], fingerprint }));
} else if (command === "tick") {
  console.log(JSON.stringify(tick()));
} else if (command === "work" && subcommand === "show") {
  const state = refreshGraphState(JSON.parse(readFileSync(STATE_PATH, "utf8")));
  saveState(state);
  const sourceChanged = hashFiles(sourceFiles(state.workflow)) !== state.fingerprint;
  console.log(JSON.stringify({ ...state, sourceChanged, phaseCount: Object.keys(state.phases).length, journalEvents: readFileSync(JOURNAL_PATH, "utf8").trim().split("\n").length }, null, 2));
} else {
  console.error("usage: cli.mjs doctor | workflow list|info|render | work start|show | tick");
  process.exit(2);
}
