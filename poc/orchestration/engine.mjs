#!/usr/bin/env node
// Workflow engine probe: a blocking driver whose runtime state lives in beads.
//
// Proves the current design shape offline, with deterministic fake agents:
//   * work start validates, freezes definitions, compiles phases, then DRIVES
//   * phase state, iterations, sessions and versions live in BEAD METADATA
//   * waiting for a human is a beads `human` gate, not a local flag
//   * reject starts iteration n+1 and feeds the reason back in
//   * artifacts are versioned, never overwritten
//   * plan revise is additive and re-opens the implementation frontier
//   * the run ends when the human accepts, not when the graph drains
//   * an intent journalled before a side effect makes a crash reconcilable
//   * work.json is identity only; cache.json is derived and safe to delete
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(process.env.SENAWA_ROOT ?? process.cwd());
const DEFS = resolve(process.env.SENAWA_DEFINITIONS ?? process.cwd());
const WORK = join(ROOT, ".agents", ".copilot-tracking", "run");
const IDENTITY = join(WORK, "work.json");
const CACHE = join(WORK, "cache.json");
const JOURNAL = join(WORK, "journal.jsonl");
const SNAPSHOT = join(WORK, "snapshot");
const ARTIFACTS = join(WORK, "artifacts");
// Stands in for the isolated COPILOT_HOME; nothing here reaches the user's history.
const HOME = join(WORK, ".copilot-home");
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
      type: "object", additionalProperties: false, required: ["name", "description"],
      properties: { name: { type: "string" }, description: { type: "string" } },
    },
    spec: {
      type: "object", additionalProperties: false, required: ["inputSchema", "phases"],
      properties: {
        inputSchema: { type: "string" },
        completesWhen: { type: "string" },
        phases: {
          type: "array", minItems: 1,
          items: {
            type: "object", additionalProperties: false, required: ["id", "executor"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
              dependsOn: { type: "array", items: { type: "string" } },
              executor: {
                type: "object", required: ["kind"],
                properties: {
                  kind: { enum: ["agent", "task-frontier", "sensor-only", "human", "foreach"] },
                  role: { type: "string" },
                  output: { type: "string" },
                  concurrency: { anyOf: [{ type: "integer", minimum: 1 }, { const: "auto" }] },
                  resumeAcrossIterations: { type: "boolean" },
                  reentrant: { type: "boolean" },
                },
              },
              exit: { type: "object" },
              actions: { type: "array" },
              loop: { type: "object" },
              iteration: { type: "object" },
            },
          },
        },
      },
    },
  },
};

const readYaml = (p) => parseYaml(readFileSync(p, "utf8"));
const wfPath = (name, base = DEFS) => join(base, "workflows", `${name}.yaml`);
const loadWorkflow = (name, base = DEFS) => readYaml(wfPath(name, base));
const loadSensors = (base = DEFS) => readYaml(join(base, "sensors.yaml"));
const errs = (e = []) => e.map((x) => `${x.instancePath || "/"} ${x.message}`).join("; ");

function sourceFiles(name, base = DEFS) {
  const wf = loadWorkflow(name, base);
  return [wfPath(name, base), join(base, "sensors.yaml"), resolve(dirname(wfPath(name, base)), wf.spec.inputSchema)];
}

function hashFiles(paths) {
  const h = createHash("sha256");
  for (const p of paths.sort()) { h.update(p); h.update(readFileSync(p)); }
  return `sha256:${h.digest("hex")}`;
}

function validateDefinitions(name, base = DEFS) {
  const issues = [];
  const workflow = loadWorkflow(name, base);
  const sensors = loadSensors(base);
  const ok = ajv.compile(workflowSchema);
  if (!ok(workflow)) issues.push(`workflow schema: ${errs(ok.errors)}`);

  const phases = workflow.spec?.phases ?? [];
  const ids = new Set();
  for (const p of phases) { if (ids.has(p.id)) issues.push(`duplicate phase ${p.id}`); ids.add(p.id); }

  for (const p of phases) {
    for (const d of p.dependsOn ?? []) if (!ids.has(d)) issues.push(`${p.id}: missing dependency ${d}`);
    if (p.executor?.kind === "task-frontier") {
      if (!p.loop?.until) issues.push(`${p.id}: task-frontier loop has no termination condition`);
      if (!Number.isInteger(p.loop?.each?.rework?.maxAttempts)) issues.push(`${p.id}: task-frontier loop has no finite rework budget`);
      if (!Number.isInteger(p.loop?.each?.dispatch?.maxFailures)) issues.push(`${p.id}: task-frontier loop has no finite dispatch budget`);
      if (p.executor.resumeAcrossIterations) issues.push(`${p.id}: resumeAcrossIterations applies to agent phases only`);
    }
    if (p.executor?.kind === "agent" && p.executor.reentrant) issues.push(`${p.id}: reentrant applies to task frontiers only`);
    if (p.iteration && !Number.isInteger(p.iteration.max)) issues.push(`${p.id}: iteration.max must be a finite integer`);
    if (p.iteration?.onUpstreamChange && !["cascade", "flag", "independent"].includes(p.iteration.onUpstreamChange)) {
      issues.push(`${p.id}: unknown onUpstreamChange ${p.iteration.onUpstreamChange}`);
    }
    const approval = p.exit?.approval;
    if (approval && !["human", "human-direct"].includes(approval)) issues.push(`${p.id}: unknown approval ${approval}`);
  }

  const byId = new Map(phases.map((p) => [p.id, p]));
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) { issues.push(`phase dependency cycle includes ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) visit(d);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);

  if (workflow.spec?.completesWhen) {
    const target = workflow.spec.completesWhen.replace(/-accepted$/, "");
    if (!ids.has(target)) issues.push(`completesWhen names unknown phase ${target}`);
  }

  const sensorById = new Map((sensors.sensors ?? []).map((s) => [s.id, s]));
  const gateById = new Map((sensors.gates ?? []).map((g) => [g.id, g]));
  for (const p of phases) {
    const gate = p.exit?.gate ?? p.loop?.each?.gate;
    if (gate && !gateById.has(gate)) issues.push(`${p.id}: missing gate ${gate}`);
  }
  for (const g of sensors.gates ?? []) {
    let deterministic = 0;
    for (const c of g.checks ?? []) {
      const s = sensorById.get(c.sensor);
      if (!s) issues.push(`${g.id}: missing sensor ${c.sensor}`);
      if (s?.kind === "deterministic" && !c.advisory) deterministic += 1;
    }
    if (deterministic === 0) issues.push(`${g.id}: no deterministic anchor`);
  }

  try { ajv.compile(JSON.parse(readFileSync(resolve(dirname(wfPath(name, base)), workflow.spec.inputSchema), "utf8"))); }
  catch (e) { issues.push(`input schema: ${e.message}`); }
  return { workflow, sensors, issues };
}

// --- graph, with the read cache the design mandates --------------------------
function bd(args, { json = true } = {}) {
  const out = execFileSync("bd", args, { cwd: ROOT, env: BD_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!json) return out;
  const parsed = JSON.parse(out);
  return parsed?.schema_version !== undefined && "data" in parsed ? parsed.data : parsed;
}
const one = (v) => (Array.isArray(v) ? v[0] : v);

const reads = new Map();
const invalidate = () => reads.clear();
function issue(id) {
  if (!reads.has(id)) reads.set(id, one(bd(["show", id, "--json"])));
  return reads.get(id);
}
function write(args) { invalidate(); return bd(args); }
function writeRaw(args) { invalidate(); return bd(args, { json: false }); }
const closeIssue = (id, reason) => writeRaw(["close", id, "--reason", reason]);
const reopenIssue = (id) => write(["update", id, "--status", "open", "--json"]);

// --- journal ----------------------------------------------------------------
function emit(event, fields = {}) {
  const n = existsSync(JOURNAL) ? readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean).length : 0;
  appendFileSync(JOURNAL, `${JSON.stringify({ seq: n + 1, event, at: new Date().toISOString(), ...fields })}\n`);
}
const journal = () => (existsSync(JOURNAL)
  ? readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : []);

const identity = () => JSON.parse(readFileSync(IDENTITY, "utf8"));
const say = (s) => console.log(s);

// --- phase state, held in bead metadata --------------------------------------
const PHASE_DEFAULTS = {
  status: "open", iteration: 0, sessionId: null, currentVersion: null,
  stale: false, lastRejection: null, gateId: null, revisions: [],
};

function phaseState(idty, id) {
  return { ...PHASE_DEFAULTS, ...(issue(idty.phaseBeads[id]).metadata?.senawa ?? {}) };
}

function setPhase(idty, id, patch, reason) {
  const cur = phaseState(idty, id);
  const next = { ...cur, ...patch };
  write(["update", idty.phaseBeads[id], "--metadata", JSON.stringify({ senawa: next }), "--json"]);
  if (patch.status && patch.status !== cur.status) {
    writeRaw(["set-state", idty.phaseBeads[id], `senawa=${patch.status}`, "--reason", reason ?? patch.status]);
  }
  return next;
}

// --- task state, derived from the graph --------------------------------------
const TASK_DEFAULTS = { status: "open", attempt: 0, sessionId: null, dispatchFailures: 0, pendingGate: false };

function tasks(idty) {
  // --all is required: bd list hides closed issues, which would make finished
  // tasks vanish from the frontier and let plan revise recreate them.
  const rows = bd(["list", "--all", "--metadata-field", `senawa_work=${idty.epic}`, "--json"]) ?? [];
  return rows
    .filter((r) => r.issue_type !== "event" && r.metadata?.senawa_key)
    .map((r) => {
      const m = r.metadata ?? {};
      const s = { ...TASK_DEFAULTS, ...(m.senawa ?? {}) };
      return {
        issueId: r.id, title: r.title, key: m.senawa_key, dependsOn: m.senawa_dependsOn ?? [],
        ...s, status: r.status === "closed" ? "closed" : s.status,
      };
    });
}

function setTask(idty, task, patch) {
  Object.assign(task, patch);
  write(["update", task.issueId, "--metadata", JSON.stringify({
    senawa: {
      status: task.status, attempt: task.attempt, sessionId: task.sessionId,
      dispatchFailures: task.dispatchFailures, pendingGate: task.pendingGate,
    },
    senawa_work: idty.epic, senawa_key: task.key, senawa_dependsOn: task.dependsOn,
  }), "--json"]);
}

// --- sensors and gates ------------------------------------------------------
const pointer = (v, path) => (path === "" || path === "/" ? v
  : path.split("/").slice(1).reduce((c, k) => c?.[k], v));

function evaluateGate(gateId, ctx, defs) {
  const gate = defs.sensors.gates.find((g) => g.id === gateId);
  const readings = [];
  for (const check of gate.checks) {
    let a;
    if (check.sensor === "artifact-present") {
      a = existsSync(ctx.artifact)
        ? { verdict: "pass", summary: "artifact exists", findings: [] }
        : { verdict: "fail", summary: "artifact is missing", findings: [{ message: ctx.artifact }] };
    } else if (check.sensor === "task-tests") {
      const pass = ctx.task.key !== "implement-api" || ctx.attempt >= 2;
      a = pass
        ? { verdict: "pass", summary: "task tests passed", findings: [] }
        : { verdict: "fail", summary: "task tests failed", findings: [{ message: "seeded first-attempt failure" }] };
    } else {
      a = { verdict: "pass", summary: "structured advisory review passed", findings: [] };
    }
    const matched = check.expect.operator === "equals" && pointer(a, check.expect.path) === check.expect.value;
    readings.push({ sensor: check.sensor, assessment: a, matched, advisory: check.advisory === true });
  }
  const accepted = readings.every((r) => r.advisory || r.matched);
  emit("gate.evaluated", { gate: gateId, phase: ctx.phase, task: ctx.task?.key, accepted, readings });
  return { accepted, readings };
}

// --- fake agent sessions ----------------------------------------------------
function planFor(iteration, revisions) {
  const base = [
    { key: "implement-api", title: "Implement the API", dependsOn: [] },
    { key: "update-caller", title: "Update the caller", dependsOn: ["implement-api"] },
  ];
  // Iteration 2 exists because a human rejected v1; the extra task is the visible difference.
  if (iteration >= 2) base.push({ key: "add-error-handling", title: "Add error handling", dependsOn: ["implement-api"] });
  return { tasks: [...base, ...revisions] };
}

function runAgentPhase(idty, phase, defs) {
  let st = phaseState(idty, phase.id);
  const resumeAcross = phase.executor.resumeAcrossIterations === true;
  let sessionId = st.sessionId;
  let resumed = true;
  if (!resumeAcross || !sessionId) {
    sessionId = randomUUID();
    resumed = false;
    mkdirSync(join(HOME, "session-state", sessionId), { recursive: true });
  }

  const consumed = {};
  for (const p of defs.workflow.spec.phases) {
    const v = phaseState(idty, p.id).currentVersion;
    if (v) consumed[p.id] = `v${v}`;
  }
  emit("phase.iteration_started", {
    phase: phase.id, iteration: st.iteration, session_id: sessionId, resumed, consumed,
    reason: st.lastRejection ?? null,
  });
  say(`   ${phase.id}: ${resumed ? "resumed" : "started"} ${phase.executor.role} session, iteration ${st.iteration}`);

  const version = st.iteration;
  const dir = join(ARTIFACTS, phase.id);
  mkdirSync(dir, { recursive: true });
  const body = phase.id === "plan"
    ? planFor(version, st.revisions)
    : { phase: phase.id, goal: idty.input.goal, iteration: version, addressed: st.lastRejection ?? null };
  const file = join(dir, `v${version}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  const cur = join(dir, "current");
  if (existsSync(cur)) rmSync(cur);
  symlinkSync(`v${version}.json`, cur);
  setPhase(idty, phase.id, { sessionId, currentVersion: version });
  emit("phase.submitted", { phase: phase.id, iteration: version, artifact: `artifacts/${phase.id}/v${version}.json` });
  return file;
}

// --- plan import ------------------------------------------------------------
function importPlan(idty, phase) {
  const plan = JSON.parse(readFileSync(join(ARTIFACTS, phase.id, "current"), "utf8"));
  const known = new Map(tasks(idty).map((t) => [t.key, t]));
  const added = [];
  for (const t of plan.tasks) {
    if (known.has(t.key)) continue;
    const created = one(write(["create", t.title, "-t", "task", "--parent", idty.phaseBeads.implement, "--json"]));
    const rt = { issueId: created.id, title: t.title, key: t.key, dependsOn: t.dependsOn, ...TASK_DEFAULTS };
    setTask(idty, rt, {});
    known.set(t.key, rt); added.push(t.key);
  }
  for (const t of known.values()) {
    for (const d of t.dependsOn) {
      const dep = known.get(d);
      if (dep) { try { writeRaw(["dep", "add", t.issueId, dep.issueId]); } catch { /* already linked */ } }
    }
  }
  if (added.length) emit("plan.imported", { tasks: added });
  return added;
}

// --- driver -----------------------------------------------------------------
const taskReady = (t, all) => t.dependsOn.every((d) => all.find((x) => x.key === d)?.status === "closed");

function crashIf(marker) {
  if (process.env.SENAWA_CRASH_AT === marker) {
    say(`   [driver killed at ${marker}]`);
    process.exit(70);
  }
}

function resolveGate(idty, phaseId, reason) {
  const { gateId } = phaseState(idty, phaseId);
  if (!gateId) return;
  try { writeRaw(["gate", "resolve", gateId, "--reason", reason]); } catch { /* already resolved */ }
}

function acceptPhase(idty, phase, actor) {
  const st = phaseState(idty, phase.id);
  resolveGate(idty, phase.id, "approved");
  setPhase(idty, phase.id, { status: "accepted", gateId: null }, "accepted");
  if (phase.actions?.some((a) => a.kind === "import-plan")) importPlan(idty, phase);
  closeIssue(idty.phaseBeads[phase.id], `${phase.id} accepted`);
  emit("phase.approved", { phase: phase.id, iteration: st.iteration, actor: { kind: "human", ...actor } });
}

function awaitApproval(idty, phase) {
  const st = phaseState(idty, phase.id);
  if (!st.gateId) {
    const g = one(write(["gate", "create", "--type=human", "--blocks", idty.phaseBeads[phase.id],
      "--reason", `${phase.id} awaiting human approval`, "--json"]));
    setPhase(idty, phase.id, { status: "awaiting_approval", gateId: g?.id ?? g?.gate_id ?? null }, "awaiting approval");
  }
  return { kind: "approval", phase: phase.id };
}

function gateTask(idty, phase, task, defs) {
  const gate = evaluateGate(phase.loop.each.gate, { phase: phase.id, task, attempt: task.attempt }, defs);
  if (gate.accepted) {
    setTask(idty, task, { status: "closed" });
    closeIssue(task.issueId, `${phase.loop.each.gate} passed`);
    emit("task.closed", { task: task.key, attempt: task.attempt });
    say(`   ${task.key}: accepted on attempt ${task.attempt}`);
    return { kind: "progress", task: task.key };
  }
  if (task.attempt >= phase.loop.each.rework.maxAttempts) {
    setTask(idty, task, { status: "escalated" });
    emit("task.escalated", { task: task.key, attempt: task.attempt });
    return { kind: "escalated", task: task.key };
  }
  setTask(idty, task, { status: "open" });
  emit("task.reworked", { task: task.key, attempt: task.attempt });
  say(`   ${task.key}: refused on attempt ${task.attempt}, resuming the same session`);
  return { kind: "progress", task: task.key };
}

function runTask(idty, phase, task, defs) {
  setTask(idty, task, {
    status: "in_progress", attempt: task.attempt + 1,
    sessionId: task.sessionId ?? randomUUID(),
  });

  // Intent first: an intent with no outcome is what resume reconciles.
  emit("task.dispatching", { task: task.key, attempt: task.attempt, session_id: task.sessionId });
  crashIf(`before-work:${task.key}`);
  writeFileSync(join(HOME, `${task.key}.turn`), String(task.attempt));
  crashIf(`after-work:${task.key}`);
  emit("task.dispatched", { task: task.key, attempt: task.attempt, session_id: task.sessionId });

  return gateTask(idty, phase, task, defs);
}

function advance(idty, defs) {
  for (const phase of defs.workflow.spec.phases) {
    const st = phaseState(idty, phase.id);
    if (st.status === "accepted") continue;
    if (!(phase.dependsOn ?? []).every((d) => phaseState(idty, d).status === "accepted")) continue;
    if (st.status === "awaiting_approval") return { kind: "approval", phase: phase.id };

    if (phase.executor.kind === "agent") {
      if (st.status === "open") {
        setPhase(idty, phase.id, { status: "running", iteration: st.iteration + 1 }, "running");
        emit("phase.started", { phase: phase.id, iteration: st.iteration + 1 });
      }
      write(["update", idty.phaseBeads[phase.id], "--status", "in_progress", "--json"]);
      const artifact = runAgentPhase(idty, phase, defs);
      const gate = evaluateGate(phase.exit.gate, { phase: phase.id, artifact }, defs);
      if (!gate.accepted) return { kind: "gate-failed", phase: phase.id };
      if (phase.exit.approval) return awaitApproval(idty, phase);
      acceptPhase(idty, phase, { via: "auto" });
      return { kind: "progress", phase: phase.id };
    }

    if (phase.executor.kind === "task-frontier") {
      if (st.status !== "running") setPhase(idty, phase.id, { status: "running" }, "running");
      if (issue(idty.phaseBeads[phase.id]).status === "closed") reopenIssue(idty.phaseBeads[phase.id]);
      const all = tasks(idty);
      const active = all.find((t) => t.status === "in_progress");
      const task = active ?? all.find((t) => t.status === "open" && taskReady(t, all));
      if (!task) {
        if (all.length && all.every((t) => t.status === "closed")) {
          if (phase.exit?.approval) return awaitApproval(idty, phase);
          acceptPhase(idty, phase, { via: "auto" });
          return { kind: "progress", phase: phase.id };
        }
        return { kind: "stalled", phase: phase.id };
      }
      if (task.pendingGate) {
        setTask(idty, task, { pendingGate: false });
        return gateTask(idty, phase, task, defs);
      }
      return runTask(idty, phase, task, defs);
    }
  }

  const target = (defs.workflow.spec.completesWhen ?? "").replace(/-accepted$/, "");
  const done = target
    ? phaseState(idty, target).status === "accepted"
    : defs.workflow.spec.phases.every((p) => phaseState(idty, p.id).status === "accepted");
  return done ? { kind: "done" } : { kind: "idle" };
}

function reconcile(idty) {
  const events = journal();
  const open = [];
  for (const e of events) {
    if (e.event === "task.dispatching") open.push(e);
    if (e.event === "task.dispatched") {
      const i = open.findIndex((x) => x.task === e.task && x.attempt === e.attempt);
      if (i >= 0) open.splice(i, 1);
    }
  }
  const all = tasks(idty);
  for (const intent of open) {
    const task = all.find((t) => t.key === intent.task);
    if (!task) continue;
    const turnFile = join(HOME, `${task.key}.turn`);
    const turned = existsSync(turnFile) && Number(readFileSync(turnFile, "utf8")) >= intent.attempt;
    if (turned) {
      emit("task.dispatched", { task: task.key, attempt: intent.attempt, session_id: intent.session_id, reconciled: true });
      say(`   reconciled ${task.key}: the turn had completed, adopting it`);
      setTask(idty, task, { attempt: intent.attempt, pendingGate: true, status: "in_progress" });
    } else {
      emit("dispatch.failed", { task: task.key, attempt: intent.attempt, reason: "driver died before the worker acted" });
      say(`   reconciled ${task.key}: the worker never acted, re-dispatching`);
      setTask(idty, task, {
        attempt: Math.max(0, intent.attempt - 1),
        dispatchFailures: task.dispatchFailures + 1, status: "open",
      });
    }
  }
  return open.length;
}

function projection(idty, defs) {
  const phases = {};
  let accepted = 0;
  let needs = null;
  for (const p of defs.workflow.spec.phases) {
    const st = phaseState(idty, p.id);
    phases[p.id] = { status: st.status, iteration: st.iteration, version: st.currentVersion, stale: st.stale };
    if (st.status === "accepted") accepted += 1;
    if (!needs && st.status === "awaiting_approval") {
      needs = { action: "approve", phase: p.id, artifact: `artifacts/${p.id}/v${st.currentVersion}.json` };
    }
  }
  const all = tasks(idty);
  const target = (defs.workflow.spec.completesWhen ?? "").replace(/-accepted$/, "");
  const finished = target ? phases[target]?.status === "accepted" : accepted === Object.keys(phases).length;
  return {
    workflow: idty.workflow,
    status: finished ? "finished" : needs ? "awaiting_approval" : "running",
    needs,
    progress: {
      phases: `${accepted}/${Object.keys(phases).length} accepted`,
      tasks: `${all.filter((t) => t.status === "closed").length}/${all.length} closed`,
    },
    sourceChanged: hashFiles(sourceFiles(idty.workflow)) !== idty.fingerprint,
    phases,
    tasks: all.map((t) => ({ key: t.key, status: t.status, attempt: t.attempt })),
    cursor: journal().length,
    isolatedSessions: existsSync(join(HOME, "session-state")) ? readdirSync(join(HOME, "session-state")).length : 0,
  };
}

function drive(idty, defs) {
  for (;;) {
    invalidate();
    const r = advance(idty, defs);
    writeFileSync(CACHE, `${JSON.stringify(projection(idty, defs), null, 2)}\n`);
    if (r.kind === "approval") {
      const st = phaseState(idty, r.phase);
      say(`\n== ${r.phase} needs your approval (iteration ${st.iteration})`);
      say(`   artifact: artifacts/${r.phase}/v${st.currentVersion}.json`);
      say(`   approve ${r.phase}   |   reject ${r.phase} --reason "..."`);
      process.exit(2);
    }
    if (r.kind === "done") {
      closeIssue(idty.epic, "workflow accepted");
      emit("work.finished", { workflow: idty.workflow });
      writeFileSync(CACHE, `${JSON.stringify(projection(idty, defs), null, 2)}\n`);
      say("\n== work accepted");
      process.exit(0);
    }
    if (r.kind === "escalated" || r.kind === "stalled" || r.kind === "gate-failed") {
      say(`\n== stopped: ${r.kind} ${r.phase ?? r.task ?? ""}`);
      process.exit(2);
    }
  }
}

const defsFrom = (idty) => ({
  workflow: loadWorkflow(idty.workflow, SNAPSHOT),
  sensors: loadSensors(SNAPSHOT),
});

// --- commands ---------------------------------------------------------------
const args = process.argv.slice(2);
const [cmd, sub] = args;
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (cmd === "doctor") {
  const name = flag("--workflow") ?? "standard-delivery";
  const r = validateDefinitions(name);
  if (r.issues.length) { for (const i of r.issues) console.error(`error: ${i}`); process.exit(1); }
  say(`ok: workflow ${name}, ${r.workflow.spec.phases.length} phases, ${r.sensors.gates.length} gates`);
}

else if (cmd === "workflow" && sub === "list") {
  say(JSON.stringify(readdirSync(join(DEFS, "workflows")).filter((f) => f.endsWith(".yaml"))
    .map((f) => loadWorkflow(basename(f, ".yaml")).metadata), null, 2));
}

else if (cmd === "workflow" && sub === "info") {
  const wf = loadWorkflow(args[2]);
  say(JSON.stringify({
    ...wf.metadata,
    completesWhen: wf.spec.completesWhen ?? "all-phases-closed",
    phases: wf.spec.phases.map((p) => ({
      id: p.id, executor: p.executor.kind,
      gate: p.exit?.gate ?? p.loop?.each?.gate,
      approval: p.exit?.approval ?? null,
      iterationMax: p.iteration?.max ?? null,
    })),
  }, null, 2));
}

else if (cmd === "workflow" && sub === "render") {
  const wf = loadWorkflow(args[2]);
  say("flowchart LR");
  for (const p of wf.spec.phases) {
    say(`  ${p.id}[${p.id}: ${p.executor.kind}${p.exit?.approval ? " + approval" : ""}]`);
    for (const d of p.dependsOn ?? []) say(`  ${d} --> ${p.id}`);
  }
}

else if (cmd === "work" && sub === "start") {
  const goal = args[2];
  const name = flag("--workflow") ?? "standard-delivery";
  const r = validateDefinitions(name);
  if (r.issues.length) throw new Error(`doctor failed: ${r.issues.join("; ")}`);
  const supplied = flag("--input") ? JSON.parse(readFileSync(resolve(flag("--input")), "utf8")) : {};
  const input = { goal, ...supplied };
  const okInput = ajv.compile(JSON.parse(readFileSync(resolve(dirname(wfPath(name)), r.workflow.spec.inputSchema), "utf8")));
  if (!okInput(input)) throw new Error(`invalid workflow input: ${errs(okInput.errors)}`);

  execFileSync("bd", ["init", "--quiet", "--stealth", "--non-interactive", "--role", "maintainer"],
    { cwd: ROOT, env: BD_ENV, stdio: ["ignore", "ignore", "pipe"] });
  for (const d of [SNAPSHOT, join(SNAPSHOT, "workflows"), join(SNAPSHOT, "schemas"), ARTIFACTS, HOME]) mkdirSync(d, { recursive: true });
  for (const p of sourceFiles(name)) {
    copyFileSync(p, p.endsWith("sensors.yaml") ? join(SNAPSHOT, "sensors.yaml")
      : p.endsWith(".schema.json") ? join(SNAPSHOT, "schemas", basename(p))
        : join(SNAPSHOT, "workflows", basename(p)));
  }
  const epic = one(bd(["create", goal, "-t", "epic", "--json"]));
  const phaseBeads = {};
  for (const p of r.workflow.spec.phases) {
    phaseBeads[p.id] = one(bd(["create", `Phase: ${p.id}`, "-t", "task", "--parent", epic.id, "--json"])).id;
  }
  for (const p of r.workflow.spec.phases) {
    for (const d of p.dependsOn ?? []) bd(["dep", "add", phaseBeads[p.id], phaseBeads[d]], { json: false });
  }
  // work.json is identity, written once and never mutated.
  writeFileSync(IDENTITY, `${JSON.stringify({
    workflow: name, fingerprint: hashFiles(sourceFiles(name)), input, epic: epic.id, phaseBeads,
  }, null, 2)}\n`);
  emit("work.started", { workflow: name, goal });
  emit("workflow.instantiated", { workflow: name, phases: Object.keys(phaseBeads) });
  say(`== ${name} started, epic ${epic.id}`);
  drive(identity(), { workflow: loadWorkflow(name, SNAPSHOT), sensors: loadSensors(SNAPSHOT) });
}

else if (cmd === "work" && sub === "resume") {
  const idty = identity();
  const n = reconcile(idty);
  emit("work.resumed", { reconciled: n });
  say(`== resumed${n ? `, reconciled ${n} in-flight dispatch(es)` : ""}`);
  drive(idty, defsFrom(idty));
}

else if (cmd === "approve") {
  const idty = identity();
  const defs = defsFrom(idty);
  const phase = defs.workflow.spec.phases.find((p) => p.id === args[1]);
  const st = phaseState(idty, phase.id);
  if (st.status !== "awaiting_approval") throw new Error(`${phase.id} is not awaiting approval`);
  acceptPhase(idty, phase, { via: process.env.SENAWA_APPROVAL_VIA ?? "tty" });
  say(`approved ${phase.id} (iteration ${st.iteration})`);
}

else if (cmd === "reject") {
  const idty = identity();
  const defs = defsFrom(idty);
  const phase = defs.workflow.spec.phases.find((p) => p.id === args[1]);
  const st = phaseState(idty, phase.id);
  const reason = flag("--reason");
  if (st.status !== "awaiting_approval") throw new Error(`${phase.id} is not awaiting approval`);
  if (st.iteration >= (phase.iteration?.max ?? 1)) throw new Error(`${phase.id} exhausted iteration.max`);
  resolveGate(idty, phase.id, "rejected");
  setPhase(idty, phase.id, { status: "open", lastRejection: reason, gateId: null }, "rejected");
  reopenIssue(idty.phaseBeads[phase.id]);
  emit("phase.rejected", { phase: phase.id, iteration: st.iteration, reason });
  for (const p of defs.workflow.spec.phases) {
    if ((p.dependsOn ?? []).includes(phase.id)
      && p.iteration?.onUpstreamChange === "flag"
      && phaseState(idty, p.id).status === "accepted") {
      setPhase(idty, p.id, { stale: true });
      emit("phase.marked_stale", { phase: p.id, because: phase.id });
    }
  }
  say(`rejected ${phase.id}: ${reason}`);
}

else if (cmd === "plan" && sub === "revise") {
  const idty = identity();
  const defs = defsFrom(idty);
  const added = JSON.parse(readFileSync(resolve(flag("--add")), "utf8"));
  const st = phaseState(idty, "plan");
  const revisions = [...st.revisions, ...added.tasks];
  const next = st.currentVersion + 1;
  const dir = join(ARTIFACTS, "plan");
  writeFileSync(join(dir, `v${next}.json`), `${JSON.stringify(planFor(st.iteration, revisions), null, 2)}\n`);
  rmSync(join(dir, "current")); symlinkSync(`v${next}.json`, join(dir, "current"));
  setPhase(idty, "plan", { revisions, currentVersion: next });
  const keys = importPlan(idty, defs.workflow.spec.phases.find((p) => p.id === "plan"));
  // Re-entrant frontier: implementation and everything after it reopen.
  for (const id of ["implement", "verify"]) {
    if (phaseState(idty, id).status !== "open") {
      resolveGate(idty, id, "superseded by a plan revision");
      setPhase(idty, id, { status: "open", gateId: null }, "reopened by plan revision");
      reopenIssue(idty.phaseBeads[id]);
    }
  }
  emit("plan.revised", { added: keys, version: `v${next}` });
  say(`plan revised to v${next}, added ${keys.join(", ")}`);
}

else if (cmd === "work" && sub === "show") {
  const idty = identity();
  const p = projection(idty, defsFrom(idty));
  writeFileSync(CACHE, `${JSON.stringify(p, null, 2)}\n`);
  say(JSON.stringify(p, null, 2));
}

else {
  console.error("usage: engine.mjs doctor | workflow list|info | work start|resume|show | approve | reject | plan revise");
  process.exit(2);
}
