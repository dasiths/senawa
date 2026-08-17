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

const WORKFLOW_API_VERSION = "senawa.dev/workflow/v1alpha3";
const SESSION_SCOPES = new Set(["run", "phase", "element"]);
const FAILURE_POLICIES = new Set(["continue", "fail-fast"]);

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
  const phases = readPhases(collector, input.workflow.path, workflow, agentsByKey, sensorSet);
  const name = requiredString(collector, input.workflow.path, "/name", workflow, "name");
  const workflowInput = requiredString(collector, input.workflow.path, "/input", workflow, "input");
  if (name === undefined || workflowInput === undefined || phases === undefined) {
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }

  const schemaPaths = new Set<string>([workflowInput]);
  for (const phase of phases) {
    schemaPaths.add(phase.output);
    if (phase.input !== undefined) schemaPaths.add(phase.input);
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
      .map((agent) => ({
        key: agent.key,
        routes: [
          {
            provider: agent.provider,
            model: agent.model,
            maxTurns: 12,
            maxSubmissions: 4,
            maxMillidollars: 5_000,
          },
        ],
      }))
      .sort((left, right) => compare(left.key, right.key)),
    sensors: [...sensorSet.values()]
      .map((sensor) => ({
        key: sensor.key,
        argv: sensor.argv,
        cwd: ".",
        timeoutMs: 300_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        inheritedEnvironment: ["PATH"],
        maxAttempts: 3,
        maxReconciliationAttempts: 2,
      }))
      .sort((left, right) => compare(left.key, right.key)),
    gates: phases
      .filter((phase) => phase.gates.length > 0)
      .map((phase) => ({
        key: `${phase.name}-gate`,
        phase: phase.name,
        blocking: phase.gates.map((sensor) => ({
          key: `${sensor}-passes`,
          condition: {
            operator: "equals",
            accessor: { sensorKey: sensor, pointer: "/exitCode" },
            expected: 0,
          },
        })),
        advisory: [],
      }))
      .sort((left, right) => compare(left.key, right.key)),
    implementationEvidenceViews: [],
    forEach: [],
    taskTemplates: [],
    phases: phases.map((phase) => lowerPhase(phase, phases, workflowInput)),
  });

  return { diagnostics: sortDiagnostics(collector.diagnostics), document };
}

interface AuthoredAgent {
  readonly key: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly session: string;
  readonly credits: number;
  readonly inputPaths: readonly string[];
}

interface AuthoredPhase {
  readonly name: string;
  readonly agent: string;
  readonly session: string;
  readonly needs: readonly string[];
  readonly output: string;
  readonly input?: string;
  readonly gates: readonly string[];
  readonly approve: boolean;
  readonly forEach?: string;
  readonly onFailure: string;
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
    const model = requiredString(collector, input.agents.path, pointer, raw, "model");
    if (prompt === undefined || model === undefined) continue;
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
    agents.set(key, {
      key,
      prompt,
      provider: typeof raw.provider === "string" ? raw.provider : "openai",
      model,
      session,
      credits: typeof raw.credits === "number" && raw.credits > 0 ? raw.credits : 1,
      inputPaths: [...parsePromptTemplate(text).inputPaths].sort(compare),
    });
  }
  return agents;
}

interface AuthoredSensor {
  readonly key: string;
  readonly argv: readonly string[];
  readonly deterministic: boolean;
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
    sensors.set(key, { key, argv, deterministic: raw.deterministic !== false });
  }
  return sensors;
}

function readPhases(
  collector: Collector,
  path: string,
  value: unknown,
  agents: ReadonlyMap<string, AuthoredAgent>,
  sensors: ReadonlyMap<string, AuthoredSensor>,
): readonly AuthoredPhase[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.phases)) {
    add(collector, "missing-field", path, "/phases", "Workflow must declare a phases list");
    return undefined;
  }
  const phases: AuthoredPhase[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.phases.entries()) {
    const pointer = `/phases/${index}`;
    if (!isRecord(raw)) {
      add(collector, "invalid-field", path, pointer, "Phase must be a mapping");
      continue;
    }
    const name = requiredString(collector, path, pointer, raw, "name");
    const agent = requiredString(collector, path, pointer, raw, "agent");
    const output = requiredString(collector, path, pointer, raw, "output");
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
      if (!sensors.has(gate)) {
        add(
          collector,
          "unknown-reference",
          path,
          `${pointer}/gates/${gateIndex}`,
          `Unknown sensor ${gate}`,
        );
      }
    }
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
    const forEach = typeof raw.forEach === "string" ? raw.forEach : undefined;
    if (forEach !== undefined) {
      const [sourcePhase] = forEach.split(".");
      if (sourcePhase !== undefined && !needs.includes(sourcePhase)) {
        add(
          collector,
          "unknown-reference",
          path,
          `${pointer}/forEach`,
          `forEach reads phase ${sourcePhase} which is absent from needs`,
        );
      }
      // Lowering a fan-out into member phases is not implemented yet. Refusing
      // is the only honest answer, because lowering it as a plain phase would
      // silently drop the collection the author asked to iterate.
      add(
        collector,
        "invalid-field",
        path,
        `${pointer}/forEach`,
        "Fan-out lowering is not implemented yet, so this phase cannot be compiled",
      );
    }
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
      output,
      ...(declaredInput === undefined ? {} : { input: declaredInput }),
      gates,
      approve: raw.approve === true,
      ...(forEach === undefined ? {} : { forEach }),
      onFailure,
    });
  }
  return phases;
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
    executor: {
      kind: "agent",
      role: phase.agent,
      budgets: AGENT_BUDGETS,
      resumeAcrossAttempts: phase.session !== "element",
      completionPolicy: {
        criteria: [{ key: `${phase.name}-produced`, generation: 1, required: true, input: null }],
        evidencePolicy: { mode: "none", requirements: [] },
      },
    },
    outputs: [
      {
        key: phase.name,
        schema: schemaKey(phase.output),
        path: `outputs/${phase.name}.json`,
        maxBytes: 262_144,
        sensitivity: "internal",
      },
    ],
    actions: [],
    iteration: {
      maximumAttempts: PHASE_ATTEMPT_LIMIT,
      onGateRejected: "iterate",
      onApprovalRejected: "iterate",
      onUpstreamChanged: "iterate",
      onExhausted: "escalate",
    },
    exit: {
      requiredOutputs: [phase.name],
      ...(phase.gates.length > 0 ? { gate: `${phase.name}-gate` } : {}),
      approval: phase.approve
        ? { policy: "required", authority: { role: "release-manager" } }
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
