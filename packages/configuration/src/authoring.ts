import { type CanonicalValue, canonicalValue } from "@senawa/kernel";
import { parseDocument } from "yaml";
import type { ConfigurationDiagnostic, ConfigurationDiagnosticCode } from "./contracts.js";
import { sortDiagnostics } from "./diagnostics.js";
import { parsePromptTemplate } from "./prompt-template.js";

/** One authored file: its path, used as the diagnostic locator, and its text. */
export interface AuthoredSource {
  readonly path: string;
  readonly text: string;
}

export interface AuthoredWorkflowInput {
  readonly agents: AuthoredSource;
  readonly workflow: AuthoredSource;
  readonly sensors: AuthoredSource;
  /** Prompt template text by the path an agent declares, used to derive input paths. */
  readonly prompts: ReadonlyMap<string, string>;
}

export interface AuthoredLoweringResult {
  readonly diagnostics: readonly ConfigurationDiagnostic[];
  readonly document?: CanonicalValue;
}

const WORKFLOW_API_VERSION = "senawa.dev/workflow/v1";
const SESSION_SCOPES = new Set(["run", "phase", "element"]);
const FAILURE_POLICIES = new Set(["continue", "fail-fast"]);
const OUTPUT_SENSITIVITIES = new Set(["public", "internal", "confidential", "restricted"]);
const EVIDENCE_MODES = new Set(["none", "task", "required-criteria", "all-satisfied"]);
const ITERATE_OR_FAIL = new Set(["iterate", "fail"]);
const ESCALATE_OR_FAIL = new Set(["escalate", "fail"]);
const MAX_PHASE_ATTEMPTS = 20;
/** The comparisons an author may write, and the internal operator each becomes. */
const GATE_COMPARISONS = Object.freeze([
  { key: "exitCode", operator: "equals", defaultPointer: "/exitCode" },
  { key: "equals", operator: "equals", defaultPointer: undefined },
  { key: "atLeast", operator: "greater-than-or-equal", defaultPointer: undefined },
  { key: "atMost", operator: "less-than-or-equal", defaultPointer: undefined },
  { key: "exists", operator: "exists", defaultPointer: undefined },
] as const);
const DEFAULT_ITERATION: AuthoredIteration = Object.freeze({
  maximumAttempts: 3,
  onGateRejected: "iterate",
  onApprovalRejected: "iterate",
  onUpstreamChanged: "iterate",
  onExhausted: "escalate",
});
/** The kernel refuses a larger phase output, so authoring cannot promise one. */
const MAX_OUTPUT_BYTES = 262_144;

/** The single attempt counter that replaces the six declared budget units (D-005). */
const PHASE_ATTEMPT_LIMIT = 3;
const AGENT_BUDGETS = Object.freeze([{ unit: "review-iteration", limit: PHASE_ATTEMPT_LIMIT }]);

/**
 * What every agent needs to talk back to senawa.
 *
 * The broker denies a submission whose capability is absent from the dispatch,
 * and a dispatch cannot widen what its context granted. Omitting these produces
 * a run that registers, renders, schedules, and dispatches, then fails at the
 * agent's first submission.
 */
const AGENT_CAPABILITIES = Object.freeze([
  "worker.submit.completion",
  "worker.submit.phase-output",
  "worker.submit.question",
]);

interface Collector {
  readonly diagnostics: ConfigurationDiagnostic[];
}

/** The three documents a consumer authors, by their fixed names. */
export const AUTHORED_DOCUMENT_NAMES = Object.freeze([
  "agents.yaml",
  "workflow.yaml",
  "sensors.yaml",
] as const);

/**
 * Lists the prompt templates the authored agents declare.
 *
 * Lowering needs the template text to derive input paths, and reading files is
 * not this package's job, so a caller uses this to know what to read first.
 */
export function listAuthoredPromptPaths(source: AuthoredSource): readonly string[] {
  const collector: Collector = { diagnostics: [] };
  const agents = parseYaml(collector, source);
  if (!isRecord(agents)) return Object.freeze([]);
  const paths = new Set<string>();
  for (const value of Object.values(agents)) {
    if (isRecord(value) && typeof value.prompt === "string") paths.add(value.prompt);
  }
  return Object.freeze([...paths].sort(compare));
}

/**
 * Lowers the three authored documents into the internal workflow document.
 *
 * The authored surface names intent; everything the internal model needs beyond
 * that is derived here rather than written by hand. Nothing about the internal
 * model is relaxed, so the compiler and kernel keep every invariant they had.
 */
export function lowerAuthoredWorkflow(input: AuthoredWorkflowInput): AuthoredLoweringResult {
  const collector: Collector = { diagnostics: [] };
  const agents = parseYaml(collector, input.agents);
  const workflow = parseYaml(collector, input.workflow);
  const sensors = parseYaml(collector, input.sensors);
  if (agents === undefined || workflow === undefined || sensors === undefined) {
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }

  const agentsByKey = readAgents(collector, input, agents);
  const sensorSet = readSensors(collector, input.sensors.path, sensors);
  const gateSet = readGates(collector, input.sensors.path, sensors, sensorSet);
  const phases = readPhases(
    collector,
    input.workflow.path,
    workflow,
    agentsByKey,
    sensorSet,
    gateSet,
  );
  const name = requiredString(collector, input.workflow.path, "/name", workflow, "name");
  const workflowInput = requiredString(collector, input.workflow.path, "/input", workflow, "input");
  if (name === undefined || workflowInput === undefined || phases === undefined) {
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }

  const schemaPaths = new Set<string>([workflowInput]);
  for (const phase of phases) {
    schemaPaths.add(phase.output);
    if (phase.input !== undefined) schemaPaths.add(phase.input);
    if (phase.forEach !== undefined) schemaPaths.add(phase.forEach.collection);
  }

  const document = canonicalValue({
    apiVersion: WORKFLOW_API_VERSION,
    kind: "Workflow",
    execution: {
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: "continue",
    },
    workflow: {
      key: name,
      generation: 1,
      input: { schema: schemaKey(workflowInput) },
    },
    prompts: [...agentsByKey.values()]
      .filter((agent) => phases.some((phase) => phase.agent === agent.key))
      .map((agent) => ({
        key: agent.key,
        path: agent.prompt,
        inputPaths: agent.inputPaths,
      }))
      .sort((left, right) => compare(left.key, right.key)),
    schemas: [...schemaPaths].sort(compare).map((path) => ({ key: schemaKey(path), path })),
    roles: [...agentsByKey.values()]
      .filter((agent) => phases.some((phase) => phase.agent === agent.key))
      .map((agent) => ({
        key: agent.key,
        kind: "agent",
        capabilities: [...AGENT_CAPABILITIES, `${agent.key}-work`].sort(compare),
        prompt: agent.key,
        modelPolicy: agent.key,
      }))
      .sort((left, right) => compare(left.key, right.key)),
    modelPolicies: [...agentsByKey.values()]
      .filter((agent) => phases.some((phase) => phase.agent === agent.key))
      .map((agent) => ({ key: agent.key, routes: agent.routes }))
      .sort((left, right) => compare(left.key, right.key)),
    sensors: [...sensorSet.values()]
      .map((sensor) => ({
        key: sensor.key,
        argv: sensor.argv,
        cwd: sensor.cwd,
        timeoutMs: sensor.timeoutMs,
        maxStdoutBytes: sensor.maxOutputBytes,
        maxStderrBytes: sensor.maxOutputBytes,
        inheritedEnvironment: [...new Set(sensor.environment)].sort(compare),
        maxAttempts: 3,
        maxReconciliationAttempts: 2,
      }))
      .sort((left, right) => compare(left.key, right.key)),
    gates: phases
      .filter((phase) => phase.gates.length > 0)
      .map((phase) => {
        const referenced = phase.gates.map((name) => gateSet.get(name) ?? implicitGate(name));
        return {
          key: `${phase.name}-gate`,
          phase: phase.name,
          blocking: referenced.flatMap((gate) => gate.blocking).map(lowerGateRule),
          advisory: referenced.flatMap((gate) => gate.advisory).map(lowerGateRule),
        };
      })
      .sort((left, right) => compare(left.key, right.key)),
    completionEvidenceViews: phases.flatMap((phase) =>
      phase.completionEvidenceFrom.map((view) => ({
        key: `${phase.name}-from-${view.phase}`,
        phase: view.phase,
        evidenceKinds: [...view.kinds].sort(compare),
        sensitivityCeiling: view.maxSensitivity,
      })),
    ),
    forEach: phases
      .filter((phase) => phase.forEach !== undefined)
      .map((phase) => {
        const fanOut = phase.forEach as NonNullable<AuthoredPhase["forEach"]>;
        return {
          key: `${phase.name}-items`,
          source: { kind: "phase-output", phase: fanOut.phase, output: fanOut.phase },
          pointer: `/${fanOut.field}`,
          collectionSchema: schemaKey(fanOut.collection),
          itemSchema: schemaKey(phase.input ?? fanOut.collection),
          identityPointer: "/id",
          limits: {
            maxSelectedItems: 64,
            maxTotalTasks: 256,
            // v1 runs members one after another, so concurrency stays at one.
            maxConcurrency: 1,
            exhaustion: phase.iteration.onExhausted,
          },
        };
      })
      .sort((left, right) => compare(left.key, right.key)),
    taskTemplates: phases
      .filter((phase) => phase.forEach !== undefined)
      .map((phase) => ({
        key: `${phase.name}-work`,
        generation: 1,
        role: phase.agent,
        budgets: AGENT_BUDGETS,
        inputSchema: schemaKey(phase.input ?? ""),
        inputMappings: [
          { key: "item", source: { kind: "current-item", pointer: "" }, destinationPointer: "" },
        ],
        dependencyIdentityPointer: "/dependsOn",
        repositoryChanges: "allowed",
        completionPolicy: {
          criteria: [{ key: `${phase.name}-produced`, generation: 1, required: true, input: null }],
          completionEvidencePolicy: {
            mode: phase.completionEvidence.mode,
            requirements: phase.completionEvidence.require.map((requirement) => ({
              kind: requirement.kind,
              minimumCount: requirement.min,
            })),
          },
        },
      }))
      .sort((left, right) => compare(left.key, right.key)),
    phases: phases.map((phase) => lowerPhase(phase, phases, workflowInput)),
  });

  return { diagnostics: sortDiagnostics(collector.diagnostics), document };
}

interface AuthoredAgent {
  readonly key: string;
  readonly prompt: string;
  readonly provider: string;
  readonly routes: readonly AuthoredRoute[];
  readonly session: string;
  readonly credits: number;
  readonly inputPaths: readonly string[];
}

interface AuthoredRoute {
  readonly provider: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxSubmissions: number;
  readonly maxMillidollars: number;
}

interface AuthoredPhase {
  readonly name: string;
  readonly agent: string;
  readonly session: string;
  readonly needs: readonly string[];
  readonly output: string;
  readonly outputSensitivity: string;
  readonly outputMaxBytes: number;
  readonly input?: string;
  readonly gates: readonly string[];
  readonly approve: boolean;
  readonly forEach?: {
    readonly phase: string;
    readonly field: string;
    readonly collection: string;
  };
  readonly onFailure: string;
  readonly completionEvidence: AuthoredCompletionEvidence;
  readonly completionEvidenceFrom: readonly AuthoredCompletionEvidenceView[];
  readonly iteration: AuthoredIteration;
  readonly approveRole?: string;
}

interface AuthoredIteration {
  readonly maximumAttempts: number;
  readonly onGateRejected: string;
  readonly onApprovalRejected: string;
  readonly onUpstreamChanged: string;
  readonly onExhausted: string;
}

interface AuthoredCompletionEvidence {
  readonly mode: string;
  readonly require: readonly { readonly kind: string; readonly min: number }[];
}

function readAgents(
  collector: Collector,
  input: AuthoredWorkflowInput,
  value: unknown,
): ReadonlyMap<string, AuthoredAgent> {
  const agents = new Map<string, AuthoredAgent>();
  if (!isRecord(value)) {
    add(
      collector,
      "invalid-document",
      input.agents.path,
      "",
      "Agent definitions must be a mapping",
    );
    return agents;
  }
  for (const [key, raw] of Object.entries(value)) {
    const pointer = `/${key}`;
    if (!isRecord(raw)) {
      add(collector, "invalid-field", input.agents.path, pointer, "Agent must be a mapping");
      continue;
    }
    const prompt = requiredString(collector, input.agents.path, pointer, raw, "prompt");
    const routes = readRoutes(collector, input.agents.path, pointer, raw);
    if (prompt === undefined || routes.length === 0) continue;
    const session = typeof raw.session === "string" ? raw.session : "run";
    if (!SESSION_SCOPES.has(session)) {
      add(
        collector,
        "invalid-field",
        input.agents.path,
        `${pointer}/session`,
        `Session scope must be one of ${[...SESSION_SCOPES].sort().join(", ")}`,
      );
    }
    const text = input.prompts.get(prompt);
    if (text === undefined) {
      add(
        collector,
        "missing-resource-path",
        input.agents.path,
        `${pointer}/prompt`,
        `Prompt template ${prompt} was not supplied`,
      );
      continue;
    }
    // Declaring input paths by hand is what the compiler already cross-checks
    // against the template, so read them from the template instead.
    let inputPaths: readonly string[];
    try {
      inputPaths = [...parsePromptTemplate(text).inputPaths].sort(compare);
    } catch (error) {
      add(
        collector,
        "invalid-prompt-template",
        prompt,
        "",
        error instanceof Error ? error.message : "Prompt template is invalid",
      );
      continue;
    }
    agents.set(key, {
      key,
      prompt,
      provider: typeof raw.provider === "string" ? raw.provider : "openai",
      routes,
      session,
      credits: typeof raw.credits === "number" && raw.credits > 0 ? raw.credits : 1,
      inputPaths,
    });
  }
  return agents;
}

interface AuthoredSensor {
  readonly key: string;
  readonly argv: readonly string[];
  readonly deterministic: boolean;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment: readonly string[];
}

/** Accepts a plain count, or a duration such as 10m, and refuses anything else. */
function readDuration(
  collector: Collector,
  path: string,
  pointer: string,
  value: unknown,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const match = /^(\d+)(ms|s|m|h|k)?$/u.exec(value.trim());
    const amount = match === undefined || match === null ? Number.NaN : Number(match[1]);
    const unit = match?.[2] ?? "ms";
    const scale: Readonly<Record<string, number>> = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      k: 1_024,
    };
    const factor = scale[unit];
    if (Number.isSafeInteger(amount) && amount > 0 && factor !== undefined) return amount * factor;
  }
  add(
    collector,
    "invalid-field",
    path,
    pointer,
    "Expected a positive count or a duration like 10m",
  );
  return fallback;
}

interface AuthoredGateRule {
  readonly key: string;
  readonly sensorKey: string;
  readonly pointer: string;
  readonly operator: string;
  readonly expected: unknown;
}

interface AuthoredGate {
  readonly key: string;
  readonly blocking: readonly AuthoredGateRule[];
  readonly advisory: readonly AuthoredGateRule[];
}

/** A phase may name a sensor directly, which means that sensor must exit zero. */
function implicitGate(sensorKey: string): AuthoredGate {
  return {
    key: sensorKey,
    blocking: [
      {
        key: `${sensorKey}-passes`,
        sensorKey,
        pointer: "/exitCode",
        operator: "equals",
        expected: 0,
      },
    ],
    advisory: [],
  };
}

function lowerGateRule(rule: AuthoredGateRule): unknown {
  return {
    key: rule.key,
    condition: {
      operator: rule.operator,
      accessor: { sensorKey: rule.sensorKey, pointer: rule.pointer },
      expected: rule.expected,
    },
  };
}

/**
 * Reads named gates, so a rule can measure something other than an exit code.
 *
 * The author names the reading field; the strict internal pointer is generated.
 */
function readGates(
  collector: Collector,
  path: string,
  value: unknown,
  sensors: ReadonlyMap<string, AuthoredSensor>,
): ReadonlyMap<string, AuthoredGate> {
  const gates = new Map<string, AuthoredGate>();
  if (!isRecord(value) || value.gates === undefined) return gates;
  if (!isRecord(value.gates)) {
    add(collector, "invalid-field", path, "/gates", "Gates must be a mapping");
    return gates;
  }
  for (const [key, raw] of Object.entries(value.gates)) {
    const pointer = `/gates/${key}`;
    if (!isRecord(raw)) {
      add(collector, "invalid-gate", path, pointer, "Gate must be a mapping");
      continue;
    }
    const blocking = readGateRules(collector, path, `${pointer}/blocking`, raw.blocking, sensors);
    const advisory = readGateRules(collector, path, `${pointer}/advisory`, raw.advisory, sensors);
    if (blocking.length === 0) {
      add(collector, "invalid-gate", path, pointer, "A gate needs at least one blocking rule");
      continue;
    }
    // A blocking gate with no deterministic reading is the harness agreeing with
    // itself, so it is refused where it is written.
    if (!blocking.some((rule) => sensors.get(rule.sensorKey)?.deterministic === true)) {
      add(
        collector,
        "invalid-gate",
        path,
        pointer,
        `Gate ${key} has no deterministic reading to anchor it`,
      );
      continue;
    }
    gates.set(key, { key, blocking, advisory });
  }
  return gates;
}

/**
 * Reads an agent's model routes, in either the short or the expanded form.
 *
 * The expanded form exists so a run can fall back rather than stall when a model
 * is unavailable or exhausts its own ceilings.
 */
/**
 * Reads a fan-out declaration, which names an upstream collection to iterate.
 *
 * The collection schema is named rather than derived because the kernel
 * validates the selected array on its own, and no schema for it can be
 * conjured from the one that describes a single item.
 */
function readForEach(
  collector: Collector,
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
  needs: readonly string[],
): { readonly phase: string; readonly field: string; readonly collection: string } | undefined {
  const declared = raw.forEach;
  if (declared === undefined) return undefined;
  if (typeof declared !== "string") {
    add(collector, "invalid-field", path, `${pointer}/forEach`, "forEach must be phase.field");
    return undefined;
  }
  const [phase, ...rest] = declared.split(".");
  const field = rest.join(".");
  if (phase === undefined || field.length === 0) {
    add(collector, "invalid-field", path, `${pointer}/forEach`, "forEach must be phase.field");
    return undefined;
  }
  if (!needs.includes(phase)) {
    add(
      collector,
      "unknown-reference",
      path,
      `${pointer}/forEach`,
      `forEach reads phase ${phase} which is absent from needs`,
    );
    return undefined;
  }
  const collection = typeof raw.collection === "string" ? raw.collection : undefined;
  if (collection === undefined) {
    add(
      collector,
      "missing-field",
      path,
      `${pointer}/collection`,
      "A fan-out must name the schema its collection satisfies",
    );
    return undefined;
  }
  if (typeof raw.input !== "string") {
    add(
      collector,
      "missing-field",
      path,
      `${pointer}/input`,
      "A fan-out member reads one item, so the phase must name that item's schema",
    );
    return undefined;
  }
  return { phase, field, collection };
}

function readRoutes(
  collector: Collector,
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
): readonly AuthoredRoute[] {
  const provider = typeof raw.provider === "string" ? raw.provider : "openai";
  const build = (value: Readonly<Record<string, unknown>>, model: string): AuthoredRoute => ({
    provider: typeof value.provider === "string" ? value.provider : provider,
    model,
    maxTurns: typeof value.turns === "number" ? value.turns : 12,
    maxSubmissions: typeof value.submissions === "number" ? value.submissions : 4,
    maxMillidollars: typeof value.spend === "number" ? value.spend : 5_000,
  });

  if (typeof raw.model === "string") {
    if (raw.models !== undefined) {
      add(collector, "invalid-field", path, pointer, "Declare either model or models, not both");
      return [];
    }
    return [build(raw, raw.model)];
  }
  if (!Array.isArray(raw.models)) {
    add(collector, "missing-field", path, `${pointer}/model`, "model is required");
    return [];
  }
  const routes: AuthoredRoute[] = [];
  for (const [index, entry] of raw.models.entries()) {
    const routePointer = `${pointer}/models/${index}`;
    if (!isRecord(entry) || typeof entry.model !== "string") {
      add(collector, "missing-field", path, `${routePointer}/model`, "model is required");
      continue;
    }
    routes.push(build(entry, entry.model));
  }
  if (routes.length === 0) {
    add(collector, "invalid-field", path, `${pointer}/models`, "Declare at least one route");
  }
  return routes;
}

function readGateRules(
  collector: Collector,
  path: string,
  pointer: string,
  value: unknown,
  sensors: ReadonlyMap<string, AuthoredSensor>,
): readonly AuthoredGateRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    add(collector, "invalid-gate", path, pointer, "Rules must be a list");
    return [];
  }
  const rules: AuthoredGateRule[] = [];
  for (const [index, raw] of value.entries()) {
    const rulePointer = `${pointer}/${index}`;
    if (!isRecord(raw)) {
      add(collector, "invalid-gate", path, rulePointer, "Rule must be a mapping");
      continue;
    }
    const sensorKey = typeof raw.sensor === "string" ? raw.sensor : undefined;
    if (sensorKey === undefined) {
      add(collector, "missing-field", path, `${rulePointer}/sensor`, "sensor is required");
      continue;
    }
    if (!sensors.has(sensorKey)) {
      add(
        collector,
        "unknown-reference",
        path,
        `${rulePointer}/sensor`,
        `Unknown sensor ${sensorKey}`,
      );
      continue;
    }
    const comparison = GATE_COMPARISONS.find((candidate) => raw[candidate.key] !== undefined);
    if (comparison === undefined) {
      add(
        collector,
        "invalid-gate",
        path,
        rulePointer,
        `A rule needs one of ${GATE_COMPARISONS.map(({ key }) => key).join(", ")}`,
      );
      continue;
    }
    const field = typeof raw.field === "string" ? raw.field : comparison.defaultPointer;
    if (field === undefined) {
      add(collector, "missing-field", path, `${rulePointer}/field`, "field is required");
      continue;
    }
    rules.push({
      key: gateRuleKey(sensorKey, field, comparison.key),
      sensorKey,
      pointer: field.startsWith("/") ? field : `/${field}`,
      operator: comparison.operator,
      expected: raw[comparison.key],
    });
  }
  return rules;
}

/** A rule key names the sensor, the field, and the comparison, so two rules over one sensor stay distinct. */
function gateRuleKey(sensorKey: string, field: string, comparison: string): string {
  const kebab = (value: string) =>
    value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`).replace(/[^a-z0-9]+/gu, "-");
  return [sensorKey, kebab(field), kebab(comparison)]
    .join("-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function readSensors(
  collector: Collector,
  path: string,
  value: unknown,
): ReadonlyMap<string, AuthoredSensor> {
  const sensors = new Map<string, AuthoredSensor>();
  if (!isRecord(value)) {
    add(collector, "invalid-document", path, "", "Sensor definitions must be a mapping");
    return sensors;
  }
  const declared = value.sensors;
  if (declared === undefined) return sensors;
  if (!isRecord(declared)) {
    add(collector, "invalid-field", path, "/sensors", "Sensors must be a mapping");
    return sensors;
  }
  for (const [key, raw] of Object.entries(declared)) {
    const pointer = `/sensors/${key}`;
    if (!isRecord(raw)) {
      add(collector, "invalid-sensor", path, pointer, "Sensor must be a mapping");
      continue;
    }
    const run = requiredString(collector, path, pointer, raw, "run");
    if (run === undefined) continue;
    const argv = run.split(/\s+/u).filter((part) => part.length > 0);
    if (argv.length === 0) {
      add(collector, "invalid-sensor", path, `${pointer}/run`, "Sensor command is empty");
      continue;
    }
    sensors.set(key, {
      key,
      argv,
      deterministic: raw.deterministic !== false,
      cwd: typeof raw.cwd === "string" ? raw.cwd : ".",
      timeoutMs: readDuration(collector, path, `${pointer}/timeout`, raw.timeout, 300_000),
      maxOutputBytes: readDuration(collector, path, `${pointer}/maxOutput`, raw.maxOutput, 65_536),
      environment: Array.isArray(raw.env) ? ["PATH", ...raw.env.filter(isString)] : ["PATH"],
    });
  }
  return sensors;
}

function readPhases(
  collector: Collector,
  path: string,
  value: unknown,
  agents: ReadonlyMap<string, AuthoredAgent>,
  sensors: ReadonlyMap<string, AuthoredSensor>,
  gateSet: ReadonlyMap<string, AuthoredGate>,
): readonly AuthoredPhase[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.phases)) {
    add(collector, "missing-field", path, "/phases", "Workflow must declare a phases list");
    return undefined;
  }
  const defaults = readIteration(
    collector,
    path,
    "/defaults",
    asDefaults(value),
    DEFAULT_ITERATION,
  );
  const phases: AuthoredPhase[] = [];
  const seen = new Set<string>();
  const declaredNames = new Set(
    value.phases.flatMap((entry) =>
      isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [],
    ),
  );
  for (const [index, raw] of value.phases.entries()) {
    const pointer = `/phases/${index}`;
    if (!isRecord(raw)) {
      add(collector, "invalid-field", path, pointer, "Phase must be a mapping");
      continue;
    }
    const name = requiredString(collector, path, pointer, raw, "name");
    refuseUnknownFields(collector, path, pointer, raw, PHASE_FIELDS);
    const agent = requiredString(collector, path, pointer, raw, "agent");
    const output = readOutput(collector, path, pointer, raw);
    if (name === undefined || agent === undefined || output === undefined) continue;
    if (seen.has(name)) {
      add(collector, "duplicate-key", path, `${pointer}/name`, `Phase ${name} is declared twice`);
      continue;
    }
    seen.add(name);
    if (!agents.has(agent)) {
      add(collector, "unknown-reference", path, `${pointer}/agent`, `Unknown agent ${agent}`);
    }
    const needs = Array.isArray(raw.needs) ? raw.needs.filter(isString) : [];
    for (const [needIndex, need] of needs.entries()) {
      if (!value.phases.some((other) => isRecord(other) && other.name === need)) {
        add(
          collector,
          "unknown-reference",
          path,
          `${pointer}/needs/${needIndex}`,
          `Unknown phase ${need}`,
        );
      }
    }
    const gates = Array.isArray(raw.gates) ? raw.gates.filter(isString) : [];
    for (const [gateIndex, gate] of gates.entries()) {
      if (gateSet.has(gate)) continue;
      const sensor = sensors.get(gate);
      if (sensor === undefined) {
        add(
          collector,
          "unknown-reference",
          path,
          `${pointer}/gates/${gateIndex}`,
          `Unknown gate or sensor ${gate}`,
        );
        continue;
      }
      // A blocking gate with no deterministic reading is the harness agreeing
      // with itself, so it is refused where it is written rather than passing.
      if (!sensor.deterministic) {
        add(
          collector,
          "invalid-gate",
          path,
          `${pointer}/gates/${gateIndex}`,
          `Sensor ${gate} is not deterministic, so it cannot anchor a blocking gate`,
        );
      }
    }
    const approve = raw.approve;
    const approveRole =
      isRecord(approve) && typeof approve.role === "string" ? approve.role : undefined;
    const onFailure = typeof raw.onFailure === "string" ? raw.onFailure : "fail-fast";
    if (!FAILURE_POLICIES.has(onFailure)) {
      add(
        collector,
        "invalid-field",
        path,
        `${pointer}/onFailure`,
        `Failure policy must be one of ${[...FAILURE_POLICIES].sort().join(", ")}`,
      );
    }
    const forEach = readForEach(collector, path, pointer, raw, needs);
    // A phase reading more than one upstream output cannot have its input schema
    // derived unambiguously, so it must name one.
    const declaredInput = typeof raw.input === "string" ? raw.input : undefined;
    if (declaredInput === undefined && needs.length > 1) {
      add(
        collector,
        "missing-field",
        path,
        `${pointer}/input`,
        `Phase ${name} reads ${needs.length} upstream outputs, so it must declare an input schema`,
      );
    }
    phases.push({
      name,
      agent,
      session: agents.get(agent)?.session ?? "run",
      needs,
      output: output.schema,
      outputSensitivity: output.sensitivity,
      outputMaxBytes: output.maxBytes,
      ...(declaredInput === undefined ? {} : { input: declaredInput }),
      gates,
      approve: raw.approve === true || isRecord(raw.approve),
      ...(forEach === undefined ? {} : { forEach }),
      onFailure,
      completionEvidence: readCompletionEvidence(collector, path, pointer, raw),
      completionEvidenceFrom: readCompletionEvidenceFrom(
        collector,
        path,
        pointer,
        raw,
        declaredNames,
      ),
      iteration: readIteration(collector, path, pointer, raw, defaults),
      ...(approveRole === undefined ? {} : { approveRole }),
    });
  }
  return phases;
}

/**
 * Reads the loop policy for one phase, falling back to the workflow defaults.
 *
 * These were constants until now, which meant the loop the product is built
 * around was the one thing an author could not describe.
 */
/** One earlier phase's accepted completion evidence, made readable to a later one. */
export interface AuthoredCompletionEvidenceView {
  readonly phase: string;
  readonly kinds: readonly string[];
  readonly maxSensitivity: "public" | "internal" | "confidential" | "restricted";
}

/**
 * Reads the phases whose accepted completion evidence this phase may read.
 *
 * The kinds are an allowlist and the ceiling caps what may cross, so a
 * confidential attachment cannot reach a phase cleared for less.
 */
function readCompletionEvidenceFrom(
  collector: Collector,
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
  declaredPhases: ReadonlySet<string>,
): readonly AuthoredCompletionEvidenceView[] {
  const declared = raw.completionEvidenceFrom;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    add(collector, "invalid-field", path, `${pointer}/completionEvidenceFrom`, "Must be a list");
    return [];
  }
  const views: AuthoredCompletionEvidenceView[] = [];
  for (const [index, entry] of declared.entries()) {
    const at = `${pointer}/completionEvidenceFrom/${index}`;
    if (!isRecord(entry)) {
      add(collector, "invalid-field", path, at, "Must be a mapping");
      continue;
    }
    const phase = requiredString(collector, path, at, entry, "phase");
    if (phase === undefined) continue;
    if (!declaredPhases.has(phase)) {
      add(collector, "unknown-reference", path, `${at}/phase`, `Unknown phase ${phase}`);
      continue;
    }
    const kinds = Array.isArray(entry.kinds)
      ? entry.kinds.filter((kind): kind is string => typeof kind === "string")
      : [];
    if (kinds.length === 0) {
      add(collector, "missing-field", path, `${at}/kinds`, "Name at least one evidence kind");
      continue;
    }
    const ceiling = typeof entry.maxSensitivity === "string" ? entry.maxSensitivity : "internal";
    if (!OUTPUT_SENSITIVITIES.has(ceiling)) {
      add(
        collector,
        "invalid-field",
        path,
        `${at}/maxSensitivity`,
        `Must be one of ${[...OUTPUT_SENSITIVITIES].sort().join(", ")}`,
      );
      continue;
    }
    views.push({
      phase,
      kinds,
      maxSensitivity: ceiling as AuthoredCompletionEvidenceView["maxSensitivity"],
    });
  }
  return views;
}

/** Every field a phase may declare. A typo here silently did nothing before. */
const PHASE_FIELDS = new Set([
  "name",
  "agent",
  "needs",
  "input",
  "output",
  "gates",
  "approve",
  "forEach",
  "collection",
  "onFailure",
  "completionEvidence",
  "completionEvidenceFrom",
  "attempts",
  "onGateRejected",
  "onApprovalRejected",
  "onUpstreamChanged",
  "onExhausted",
]);

/**
 * Refuses a field the reader does not know.
 *
 * Ignoring an unknown field means a misspelled `approve` configures nothing and
 * says nothing, which reads as the feature being broken rather than misspelled.
 */
function refuseUnknownFields(
  collector: Collector,
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(raw).sort()) {
    if (allowed.has(key)) continue;
    add(collector, "unknown-field", path, `${pointer}/${key}`, `${key} is not a phase field`);
  }
}

/** The workflow-level defaults block, read with the same rules as a phase. */
function asDefaults(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return isRecord(value.defaults) ? value.defaults : {};
}

function readIteration(
  collector: Collector,
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
  defaults: AuthoredIteration,
): AuthoredIteration {
  const attempts = typeof raw.attempts === "number" ? raw.attempts : defaults.maximumAttempts;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_PHASE_ATTEMPTS) {
    add(
      collector,
      "invalid-field",
      path,
      `${pointer}/attempts`,
      `attempts must be between 1 and ${MAX_PHASE_ATTEMPTS}`,
    );
  }
  const disposition = (key: string, fallback: string, allowed: ReadonlySet<string>): string => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !allowed.has(value)) {
      add(
        collector,
        "invalid-field",
        path,
        `${pointer}/${key}`,
        `${key} must be one of ${[...allowed].sort().join(", ")}`,
      );
      return fallback;
    }
    return value;
  };
  return {
    maximumAttempts: attempts,
    onGateRejected: disposition("onGateRejected", defaults.onGateRejected, ITERATE_OR_FAIL),
    onApprovalRejected: disposition(
      "onApprovalRejected",
      defaults.onApprovalRejected,
      ITERATE_OR_FAIL,
    ),
    onUpstreamChanged: disposition(
      "onUpstreamChanged",
      defaults.onUpstreamChanged,
      ITERATE_OR_FAIL,
    ),
    onExhausted: disposition("onExhausted", defaults.onExhausted, ESCALATE_OR_FAIL),
  };
}

/** Reads a phase output, in either the short or the expanded form. */
function readOutput(
  collector: Collector,
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
): { schema: string; sensitivity: string; maxBytes: number } | undefined {
  const value = raw.output;
  if (typeof value === "string") {
    return { schema: value, sensitivity: "internal", maxBytes: MAX_OUTPUT_BYTES };
  }
  if (!isRecord(value)) {
    add(collector, "missing-field", path, `${pointer}/output`, "output is required");
    return undefined;
  }
  const schema = requiredString(collector, `${pointer}/output`, "", value, "schema");
  if (schema === undefined) return undefined;
  const sensitivity = typeof value.sensitivity === "string" ? value.sensitivity : "internal";
  if (!OUTPUT_SENSITIVITIES.has(sensitivity)) {
    add(
      collector,
      "invalid-field",
      path,
      `${pointer}/output/sensitivity`,
      `Sensitivity must be one of ${[...OUTPUT_SENSITIVITIES].sort().join(", ")}`,
    );
  }
  const maxBytes = typeof value.maxBytes === "number" ? value.maxBytes : MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_BYTES) {
    add(
      collector,
      "invalid-field",
      path,
      `${pointer}/output/maxBytes`,
      `An output may be at most ${MAX_OUTPUT_BYTES} bytes`,
    );
  }
  return { schema, sensitivity, maxBytes };
}

/** Reads the completion evidence policy, defaulting to requiring none. */
function readCompletionEvidence(
  collector: Collector,
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
): AuthoredCompletionEvidence {
  const value = raw.completionEvidence;
  if (value === undefined) return { mode: "none", require: [] };
  if (!isRecord(value)) {
    add(
      collector,
      "invalid-field",
      path,
      `${pointer}/completionEvidence`,
      "completionEvidence must be a mapping",
    );
    return { mode: "none", require: [] };
  }
  const mode = typeof value.mode === "string" ? value.mode : "none";
  if (!EVIDENCE_MODES.has(mode)) {
    add(
      collector,
      "invalid-field",
      path,
      `${pointer}/completionEvidence/mode`,
      `Mode must be one of ${[...EVIDENCE_MODES].sort().join(", ")}`,
    );
  }
  const declared = Array.isArray(value.require) ? value.require : [];
  const require: { kind: string; min: number }[] = [];
  for (const [index, entry] of declared.entries()) {
    const itemPointer = `${pointer}/completionEvidence/require/${index}`;
    if (!isRecord(entry)) {
      add(collector, "invalid-field", path, itemPointer, "Each requirement must be a mapping");
      continue;
    }
    const kind = typeof entry.kind === "string" ? entry.kind : undefined;
    if (kind === undefined || kind.length === 0) {
      add(collector, "missing-field", path, `${itemPointer}/kind`, "kind is required");
      continue;
    }
    const min = typeof entry.min === "number" ? entry.min : 1;
    if (!Number.isSafeInteger(min) || min < 1) {
      add(collector, "invalid-field", path, `${itemPointer}/min`, "min must be a positive integer");
      continue;
    }
    require.push({ kind, min });
  }
  // Requiring evidence while the mode collects none would read as a promise the
  // gate never keeps, so it is refused where it is written.
  if (mode === "none" && require.length > 0) {
    add(
      collector,
      "invalid-field",
      path,
      `${pointer}/completionEvidence/mode`,
      "Mode none collects no evidence, so it cannot carry requirements",
    );
  }
  return { mode, require };
}

function lowerPhase(
  phase: AuthoredPhase,
  phases: readonly AuthoredPhase[],
  workflowInput: string,
): unknown {
  const upstream = phase.needs
    .map((need) => phases.find(({ name }) => name === need))
    .filter((found): found is AuthoredPhase => found !== undefined);
  const inputSchema =
    phase.input !== undefined
      ? schemaKey(phase.input)
      : upstream.length === 1 && upstream[0] !== undefined
        ? schemaKey(upstream[0].output)
        : schemaKey(workflowInput);
  // Mappings are the pointer pairs an author writes today. Each upstream output
  // lands under a member named for its phase; a root phase reads the workflow
  // input whole.
  const mappings =
    upstream.length === 0
      ? [{ key: "input", source: { kind: "workflow-input", pointer: "" }, destinationPointer: "" }]
      : upstream.map((need) => ({
          key: need.name,
          source: {
            kind: "phase-output",
            phase: need.name,
            output: need.name,
            pointer: "",
          },
          destinationPointer: upstream.length === 1 ? "" : `/${need.name}`,
        }));
  return {
    key: phase.name,
    generation: 1,
    dependsOn: [...phase.needs].sort(compare),
    input: { schema: inputSchema, mappings },
    executor:
      phase.forEach !== undefined
        ? {
            kind: "task-frontier",
            forEach: `${phase.name}-items`,
            template: `${phase.name}-work`,
          }
        : {
            kind: "agent",
            role: phase.agent,
            budgets: AGENT_BUDGETS,
            resumeAcrossAttempts: phase.session !== "element",
            completionPolicy: {
              criteria: [
                { key: `${phase.name}-produced`, generation: 1, required: true, input: null },
              ],
              completionEvidencePolicy: {
                mode: phase.completionEvidence.mode,
                requirements: phase.completionEvidence.require.map((requirement) => ({
                  kind: requirement.kind,
                  minimumCount: requirement.min,
                })),
              },
            },
          },
    outputs: [
      {
        key: phase.name,
        schema: schemaKey(phase.output),
        path: `outputs/${phase.name}.json`,
        maxBytes: phase.outputMaxBytes,
        sensitivity: phase.outputSensitivity,
      },
    ],
    actions: [],
    iteration: phase.iteration,
    exit: {
      requiredOutputs: [phase.name],
      ...(phase.gates.length > 0 ? { gate: `${phase.name}-gate` } : {}),
      approval: phase.approve
        ? { policy: "required", authority: { role: phase.approveRole ?? "release-manager" } }
        : { policy: "none" },
    },
  };
}

function parseYaml(collector: Collector, source: AuthoredSource): unknown {
  const parsed = parseDocument(source.text, { prettyErrors: true });
  for (const error of parsed.errors) {
    add(collector, "invalid-document", source.path, "", error.message);
  }
  if (parsed.errors.length > 0) return undefined;
  return parsed.toJS({ maxAliasCount: 100 });
}

function requiredString(
  collector: Collector,
  path: string,
  pointer: string,
  value: unknown,
  field: string,
): string | undefined {
  if (isRecord(value) && typeof value[field] === "string" && value[field].length > 0) {
    return value[field];
  }
  add(collector, "missing-field", path, `${pointer}/${field}`, `${field} is required`);
  return undefined;
}

function schemaKey(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

function add(
  collector: Collector,
  code: ConfigurationDiagnosticCode,
  locator: string,
  pointer: string,
  message: string,
): void {
  collector.diagnostics.push({ code, locator, pointer, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
