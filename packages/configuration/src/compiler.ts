import {
  BUDGET_UNITS,
  type BudgetUnit,
  type CanonicalValue,
  type ConditionInput,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  type compileWorkflowGraph,
  consumerKey,
  criterionId,
  defineGate,
  definitionGeneration,
  diagnoseWorkflowGraph,
  GateError,
  type GateRuleInput,
  type GraphCompilationDiagnostic,
  isConsumerKey,
  isDefinitionGeneration,
  type NormalizedWorkflowInput,
  phaseId,
  type Sha256,
  sha256Digest,
  taskId,
  workflowId,
} from "@senawa/kernel";
import {
  CONFIGURATION_SNAPSHOT_API_VERSION,
  type ConfigurationDiagnostic,
  type ConfigurationDiagnosticCode,
  type ConfigurationDoctorResult,
  type ConfigurationRegistryEntry,
  type ConfigurationSnapshot,
  WORKFLOW_CONFIGURATION_API_VERSION,
} from "./contracts.js";
import { ConfigurationCompilationError, sortDiagnostics } from "./diagnostics.js";
import { analyzeSchemaDefinition } from "./schema.js";

const MAX_SENSOR_TIMEOUT_MILLISECONDS = 2_147_483_647;
const MAX_SENSOR_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SENSOR_ATTEMPTS = 10_000;

type CanonicalObject = CanonicalValue & Readonly<Record<string, CanonicalValue>>;

interface ParsedWorkflow {
  readonly workflow: ParsedWorkflowDeclaration;
  readonly schemas: readonly ParsedSchema[];
  readonly roles: readonly ParsedRole[];
  readonly modelPolicies: readonly ParsedModelPolicy[];
  readonly sensors: readonly ParsedSensor[];
  readonly gates: readonly ParsedGate[];
  readonly phases: readonly ParsedPhase[];
  readonly projectedWork: readonly ParsedProjection[];
}

interface ParsedWorkflowDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly input: CanonicalValue;
}

interface ParsedSchema {
  readonly pointer: string;
  readonly key: string;
  readonly schema: CanonicalValue;
}

interface ParsedRole {
  readonly pointer: string;
  readonly key: string;
  readonly kind: "agent" | "human" | "authority";
  readonly capabilities: readonly string[];
  readonly modelPolicy?: string;
}

interface ParsedModelPolicy {
  readonly pointer: string;
  readonly key: string;
  readonly routes: readonly ParsedModelRoute[];
}

interface ParsedModelRoute {
  readonly provider: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxSubmissions: number;
  readonly maxMillidollars: number;
}

interface ParsedSensor {
  readonly pointer: string;
  readonly key: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly inheritedEnvironment: readonly string[];
  readonly maxAttempts: number;
  readonly maxReconciliationAttempts: number;
}

interface ParsedGate {
  readonly pointer: string;
  readonly key: string;
  readonly phase: string;
  readonly blocking: readonly GateRuleInput[];
  readonly advisory: readonly GateRuleInput[];
}

interface ParsedPhase {
  readonly pointer: string;
  readonly key: string;
  readonly generation: number;
  readonly dependsOn: readonly string[];
  readonly input: CanonicalValue;
  readonly work: readonly ParsedWork[];
}

interface ParsedProjection {
  readonly pointer: string;
  readonly phase: string;
  readonly work: ParsedWork;
}

interface ParsedWork {
  readonly pointer: string;
  readonly key: string;
  readonly generation: number;
  readonly role: string;
  readonly budgets: readonly ParsedBudget[];
  readonly dependsOn: readonly string[];
  readonly inputSchema?: string;
  readonly input: CanonicalValue;
  readonly completionPolicy: ParsedCompletionPolicy;
}

interface ParsedBudget {
  readonly unit: BudgetUnit;
  readonly limit: number;
}

interface ParsedCompletionPolicy {
  readonly criteria: readonly ParsedCriterion[];
  readonly evidencePolicy: ParsedEvidencePolicy;
}

interface ParsedCriterion {
  readonly key: string;
  readonly generation: number;
  readonly required: boolean;
  readonly input: CanonicalValue;
}

interface ParsedEvidencePolicy {
  readonly mode: "none" | "task" | "required-criteria" | "all-satisfied";
  readonly requirements: readonly {
    readonly kind: CanonicalValue;
    readonly minimumCount: number;
  }[];
  readonly waiverAuthority?: CanonicalValue;
}

interface DiagnosticCollector {
  readonly locator: string;
  readonly diagnostics: ConfigurationDiagnostic[];
}

interface LoweredConfiguration {
  readonly input: NormalizedWorkflowInput;
  readonly sourceById: ReadonlyMap<string, { readonly pointer: string }>;
}

interface ValidatedRegistries {
  readonly schemas: readonly ConfigurationRegistryEntry[];
  readonly roles: readonly ConfigurationRegistryEntry[];
  readonly modelPolicies: readonly ConfigurationRegistryEntry[];
  readonly sensors: readonly ConfigurationRegistryEntry[];
  readonly gates: readonly ConfigurationRegistryEntry[];
  readonly projections: readonly ConfigurationRegistryEntry[];
  readonly gateKeysByPhase: ReadonlyMap<string, readonly string[]>;
}

const REQUIRED_WORK_BUDGETS: readonly BudgetUnit[] = Object.freeze([
  "work-attempt",
  "dispatch-failure",
  "sensor-retry",
  "review-iteration",
  "integration-attempt",
  "rebase-attempt",
]);
const ROOT_FIELDS = [
  "apiVersion",
  "kind",
  "workflow",
  "schemas",
  "roles",
  "modelPolicies",
  "sensors",
  "gates",
  "phases",
  "projectedWork",
];
const MAX_LIST_ITEMS = 256;

export function doctorWorkflowConfiguration(
  input: unknown,
  locator: string,
  sha256: Sha256,
): ConfigurationDoctorResult {
  const validLocator = typeof locator === "string" && locator.length > 0;
  const collector: DiagnosticCollector = {
    locator: validLocator ? locator : "invalid://configuration-source",
    diagnostics: [],
  };
  if (!validLocator) {
    addDiagnostic(collector, "invalid-locator", "", "Source locator must be a non-empty string");
  }

  let snapshot: CanonicalValue;
  try {
    snapshot = canonicalValue(input);
  } catch {
    addDiagnostic(
      collector,
      "invalid-canonical-value",
      "",
      "Workflow configuration must contain only finite JSON values and plain objects",
    );
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }

  const parsed = parseDocument(snapshot, collector);
  if (parsed === undefined) return { diagnostics: sortDiagnostics(collector.diagnostics) };

  const registries = validateRegistries(parsed, collector, sha256);
  const lowered = lowerConfiguration(parsed, registries.gateKeysByPhase, collector, sha256);
  const diagnosis = diagnoseWorkflowGraph(lowered.input, sha256);
  for (const diagnostic of diagnosis.diagnostics) {
    addDiagnostic(
      collector,
      diagnostic.code,
      pointerForGraphDiagnostic(diagnostic, lowered),
      diagnostic.message,
    );
  }
  if (diagnosis.graph === undefined || collector.diagnostics.length > 0) {
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }
  return {
    diagnostics: Object.freeze([]),
    snapshot: createConfigurationSnapshot(diagnosis.graph, registries, sha256),
  };
}

export function compileWorkflowConfiguration(
  input: unknown,
  locator: string,
  sha256: Sha256,
): ConfigurationSnapshot {
  const result = doctorWorkflowConfiguration(input, locator, sha256);
  if (result.snapshot === undefined) throw new ConfigurationCompilationError(result.diagnostics);
  return result.snapshot;
}

function parseDocument(
  value: CanonicalValue,
  collector: DiagnosticCollector,
): ParsedWorkflow | undefined {
  const document = exactObject(value, "", ROOT_FIELDS, [], collector);
  if (document === undefined) return undefined;
  if (document.apiVersion !== WORKFLOW_CONFIGURATION_API_VERSION) {
    addDiagnostic(
      collector,
      "invalid-api-version",
      "/apiVersion",
      `apiVersion must be ${WORKFLOW_CONFIGURATION_API_VERSION}`,
    );
  }
  if (document.kind !== "Workflow") {
    addDiagnostic(collector, "invalid-kind", "/kind", "kind must be Workflow");
  }
  const workflow = parseWorkflow(document.workflow, collector);
  const schemas = parseSchemas(document.schemas, collector);
  const roles = parseRoles(document.roles, collector);
  const modelPolicies = parseModelPolicies(document.modelPolicies, collector);
  const sensors = parseSensors(document.sensors, collector);
  const gates = parseGates(document.gates, collector);
  const phases = parsePhases(document.phases, collector);
  const projectedWork = parseProjectedWork(document.projectedWork, collector);
  if (
    workflow === undefined ||
    schemas === undefined ||
    roles === undefined ||
    modelPolicies === undefined ||
    sensors === undefined ||
    gates === undefined ||
    phases === undefined ||
    projectedWork === undefined
  ) {
    return undefined;
  }
  return { workflow, schemas, roles, modelPolicies, sensors, gates, phases, projectedWork };
}

function parseWorkflow(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): ParsedWorkflowDeclaration | undefined {
  const object = exactObject(value, "/workflow", ["key", "generation"], ["input"], collector);
  if (object === undefined) return undefined;
  const key = parseKey(object.key, "/workflow/key", collector);
  const generation = parseGeneration(object.generation, "/workflow/generation", collector);
  return key === undefined || generation === undefined
    ? undefined
    : { key, generation, input: object.input ?? canonicalValue(null) };
}

function parseSchemas(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedSchema[] | undefined {
  return parseArray(value, "/schemas", collector, (item, pointer) => {
    const object = exactObject(item, pointer, ["key", "schema"], [], collector);
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    return key === undefined
      ? undefined
      : { pointer, key, schema: object.schema as CanonicalValue };
  });
}

function parseRoles(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedRole[] | undefined {
  return parseArray(value, "/roles", collector, (item, pointer) => {
    const object = exactObject(
      item,
      pointer,
      ["key", "kind", "capabilities"],
      ["modelPolicy"],
      collector,
    );
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    let kind: ParsedRole["kind"] | undefined;
    if (object.kind === "agent") kind = "agent";
    if (object.kind === "human") kind = "human";
    if (object.kind === "authority") kind = "authority";
    if (kind === undefined) {
      addDiagnostic(collector, "invalid-role", `${pointer}/kind`, "Role kind is not recognized");
    }
    const capabilities = parseUniqueStrings(
      object.capabilities,
      `${pointer}/capabilities`,
      collector,
      "Role capabilities",
    );
    const modelPolicy = Object.hasOwn(object, "modelPolicy")
      ? parseReference(object.modelPolicy, `${pointer}/modelPolicy`, collector)
      : undefined;
    if (key === undefined || kind === undefined || capabilities === undefined) return undefined;
    const common = { pointer, key, kind, capabilities };
    return modelPolicy === undefined ? common : { ...common, modelPolicy };
  });
}

function parseModelPolicies(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedModelPolicy[] | undefined {
  return parseArray(value, "/modelPolicies", collector, (item, pointer) => {
    const object = exactObject(item, pointer, ["key", "routes"], [], collector);
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const routes = parseArray(
      object.routes,
      `${pointer}/routes`,
      collector,
      (route, routePointer) => parseModelRoute(route, routePointer, collector),
    );
    if (routes !== undefined && routes.length === 0) {
      addDiagnostic(
        collector,
        "invalid-model-policy",
        `${pointer}/routes`,
        "Model policies require at least one explicit route",
      );
    }
    return key === undefined || routes === undefined ? undefined : { pointer, key, routes };
  });
}

function parseModelRoute(
  value: CanonicalValue,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedModelRoute | undefined {
  const object = exactObject(
    value,
    pointer,
    ["provider", "model", "maxTurns", "maxSubmissions", "maxMillidollars"],
    [],
    collector,
  );
  if (object === undefined) return undefined;
  const provider = parseBoundedString(object.provider, `${pointer}/provider`, collector);
  const model = parseBoundedString(object.model, `${pointer}/model`, collector);
  if (provider === "auto" || model === "auto") {
    addDiagnostic(
      collector,
      "invalid-model-policy",
      provider === "auto" ? `${pointer}/provider` : `${pointer}/model`,
      "Model routes must be explicit and cannot use auto",
    );
  }
  const maxTurns = parsePositiveInteger(object.maxTurns, `${pointer}/maxTurns`, collector);
  const maxSubmissions = parsePositiveInteger(
    object.maxSubmissions,
    `${pointer}/maxSubmissions`,
    collector,
  );
  const maxMillidollars = parsePositiveInteger(
    object.maxMillidollars,
    `${pointer}/maxMillidollars`,
    collector,
  );
  return provider === undefined ||
    model === undefined ||
    provider === "auto" ||
    model === "auto" ||
    maxTurns === undefined ||
    maxSubmissions === undefined ||
    maxMillidollars === undefined
    ? undefined
    : { provider, model, maxTurns, maxSubmissions, maxMillidollars };
}

function parseSensors(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedSensor[] | undefined {
  const fields = [
    "key",
    "argv",
    "cwd",
    "timeoutMs",
    "maxStdoutBytes",
    "maxStderrBytes",
    "inheritedEnvironment",
    "maxAttempts",
    "maxReconciliationAttempts",
  ];
  return parseArray(value, "/sensors", collector, (item, pointer) => {
    const object = exactObject(item, pointer, fields, [], collector);
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const argv = parseArgv(object.argv, `${pointer}/argv`, collector);
    const cwd = parseSafePath(object.cwd, `${pointer}/cwd`, collector);
    const inheritedEnvironment = parseEnvironment(
      object.inheritedEnvironment,
      `${pointer}/inheritedEnvironment`,
      collector,
    );
    const timeoutMs = parseBoundedPositiveInteger(
      object.timeoutMs,
      `${pointer}/timeoutMs`,
      MAX_SENSOR_TIMEOUT_MILLISECONDS,
      collector,
    );
    const maxStdoutBytes = parseBoundedPositiveInteger(
      object.maxStdoutBytes,
      `${pointer}/maxStdoutBytes`,
      MAX_SENSOR_OUTPUT_BYTES,
      collector,
    );
    const maxStderrBytes = parseBoundedPositiveInteger(
      object.maxStderrBytes,
      `${pointer}/maxStderrBytes`,
      MAX_SENSOR_OUTPUT_BYTES,
      collector,
    );
    const maxAttempts = parseBoundedPositiveInteger(
      object.maxAttempts,
      `${pointer}/maxAttempts`,
      MAX_SENSOR_ATTEMPTS,
      collector,
    );
    const maxReconciliationAttempts = parseBoundedPositiveInteger(
      object.maxReconciliationAttempts,
      `${pointer}/maxReconciliationAttempts`,
      MAX_SENSOR_ATTEMPTS,
      collector,
    );
    if (
      key === undefined ||
      argv === undefined ||
      cwd === undefined ||
      inheritedEnvironment === undefined ||
      timeoutMs === undefined ||
      maxStdoutBytes === undefined ||
      maxStderrBytes === undefined ||
      maxAttempts === undefined ||
      maxReconciliationAttempts === undefined
    ) {
      return undefined;
    }
    return {
      pointer,
      key,
      argv,
      cwd,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      inheritedEnvironment,
      maxAttempts,
      maxReconciliationAttempts,
    };
  });
}

function parseGates(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedGate[] | undefined {
  return parseArray(value, "/gates", collector, (item, pointer) => {
    const object = exactObject(
      item,
      pointer,
      ["key", "phase", "blocking", "advisory"],
      [],
      collector,
    );
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const phase = parseReference(object.phase, `${pointer}/phase`, collector);
    const blocking = parseGateRules(object.blocking, `${pointer}/blocking`, collector);
    const advisory = parseGateRules(object.advisory, `${pointer}/advisory`, collector);
    return key === undefined ||
      phase === undefined ||
      blocking === undefined ||
      advisory === undefined
      ? undefined
      : { pointer, key, phase, blocking, advisory };
  });
}

function parseGateRules(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): readonly GateRuleInput[] | undefined {
  if (!Array.isArray(value)) {
    addDiagnostic(collector, "invalid-gate", pointer, "Gate rules must be an array");
    return undefined;
  }
  return value as unknown as readonly GateRuleInput[];
}

function parsePhases(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedPhase[] | undefined {
  return parseArray(value, "/phases", collector, (item, pointer) => {
    const object = exactObject(
      item,
      pointer,
      ["key", "generation", "work"],
      ["dependsOn", "input"],
      collector,
    );
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const generation = parseGeneration(object.generation, `${pointer}/generation`, collector);
    const dependsOn = parseStringArray(object.dependsOn, `${pointer}/dependsOn`, collector);
    const work = parseArray(object.work, `${pointer}/work`, collector, (declaration, workPointer) =>
      parseWork(declaration, workPointer, collector),
    );
    return key === undefined ||
      generation === undefined ||
      dependsOn === undefined ||
      work === undefined
      ? undefined
      : {
          pointer,
          key,
          generation,
          dependsOn,
          input: object.input ?? canonicalValue(null),
          work,
        };
  });
}

function parseProjectedWork(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedProjection[] | undefined {
  return parseArray(value, "/projectedWork", collector, (item, pointer) => {
    const object = exactObject(item, pointer, ["phase", "work"], [], collector);
    if (object === undefined) return undefined;
    const phase = parseReference(object.phase, `${pointer}/phase`, collector);
    const work = parseWork(object.work, `${pointer}/work`, collector);
    return phase === undefined || work === undefined ? undefined : { pointer, phase, work };
  });
}

function parseWork(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedWork | undefined {
  const object = exactObject(
    value,
    pointer,
    ["key", "generation", "role", "budgets", "completionPolicy"],
    ["dependsOn", "inputSchema", "input"],
    collector,
  );
  if (object === undefined) return undefined;
  const key = parseKey(object.key, `${pointer}/key`, collector);
  const generation = parseGeneration(object.generation, `${pointer}/generation`, collector);
  const role = parseReference(object.role, `${pointer}/role`, collector);
  const budgets = parseBudgets(object.budgets, `${pointer}/budgets`, collector);
  const dependsOn = parseStringArray(object.dependsOn, `${pointer}/dependsOn`, collector);
  const completionPolicy = parseCompletionPolicy(
    object.completionPolicy,
    `${pointer}/completionPolicy`,
    collector,
  );
  const inputSchema = Object.hasOwn(object, "inputSchema")
    ? parseReference(object.inputSchema, `${pointer}/inputSchema`, collector)
    : undefined;
  if (
    key === undefined ||
    generation === undefined ||
    role === undefined ||
    budgets === undefined ||
    dependsOn === undefined ||
    completionPolicy === undefined
  ) {
    return undefined;
  }
  const common = {
    pointer,
    key,
    generation,
    role,
    budgets,
    dependsOn,
    input: object.input ?? canonicalValue(null),
    completionPolicy,
  };
  return inputSchema === undefined ? common : { ...common, inputSchema };
}

function parseBudgets(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): readonly ParsedBudget[] | undefined {
  const budgets = parseArray(value, pointer, collector, (item, itemPointer) => {
    const object = exactObject(item, itemPointer, ["unit", "limit"], [], collector);
    if (object === undefined) return undefined;
    if (!(BUDGET_UNITS as readonly unknown[]).includes(object.unit)) {
      addDiagnostic(
        collector,
        "invalid-budget",
        `${itemPointer}/unit`,
        "Budget unit is not recognized",
      );
      return undefined;
    }
    const limit = parsePositiveInteger(object.limit, `${itemPointer}/limit`, collector);
    return limit === undefined ? undefined : { unit: object.unit as BudgetUnit, limit };
  });
  if (budgets === undefined) return undefined;
  const seen = new Set<BudgetUnit>();
  for (const budget of budgets) {
    if (seen.has(budget.unit)) {
      addDiagnostic(collector, "duplicate-key", pointer, `Budget ${budget.unit} is duplicated`);
    }
    seen.add(budget.unit);
  }
  for (const unit of REQUIRED_WORK_BUDGETS) {
    if (!seen.has(unit)) {
      addDiagnostic(collector, "invalid-budget", pointer, `Work must bound the ${unit} loop`);
    }
  }
  return Object.freeze([...budgets].sort((left, right) => compareText(left.unit, right.unit)));
}

function parseCompletionPolicy(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedCompletionPolicy | undefined {
  const object = exactObject(value, pointer, ["criteria", "evidencePolicy"], [], collector);
  if (object === undefined) return undefined;
  const criteria = parseArray(
    object.criteria,
    `${pointer}/criteria`,
    collector,
    (item, itemPointer) => {
      const criterion = exactObject(
        item,
        itemPointer,
        ["key", "generation", "required"],
        ["input"],
        collector,
      );
      if (criterion === undefined) return undefined;
      const key = parseKey(criterion.key, `${itemPointer}/key`, collector);
      const generation = parseGeneration(
        criterion.generation,
        `${itemPointer}/generation`,
        collector,
      );
      if (typeof criterion.required !== "boolean") {
        addDiagnostic(
          collector,
          "invalid-field",
          `${itemPointer}/required`,
          "required must be a boolean",
        );
      }
      return key === undefined ||
        generation === undefined ||
        typeof criterion.required !== "boolean"
        ? undefined
        : {
            key,
            generation,
            required: criterion.required,
            input: criterion.input ?? canonicalValue(null),
          };
    },
  );
  const evidencePolicy = parseEvidencePolicy(
    object.evidencePolicy,
    `${pointer}/evidencePolicy`,
    collector,
  );
  return criteria === undefined || evidencePolicy === undefined
    ? undefined
    : { criteria, evidencePolicy };
}

function parseEvidencePolicy(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedEvidencePolicy | undefined {
  const object = exactObject(
    value,
    pointer,
    ["mode", "requirements"],
    ["waiverAuthority"],
    collector,
  );
  if (object === undefined) return undefined;
  let mode: ParsedEvidencePolicy["mode"] | undefined;
  if (object.mode === "none") mode = "none";
  if (object.mode === "task") mode = "task";
  if (object.mode === "required-criteria") mode = "required-criteria";
  if (object.mode === "all-satisfied") mode = "all-satisfied";
  if (mode === undefined) {
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/mode`,
      "Evidence policy mode is not recognized",
    );
  }
  const requirements = parseArray(
    object.requirements,
    `${pointer}/requirements`,
    collector,
    (item, itemPointer) => {
      const requirement = exactObject(item, itemPointer, ["kind", "minimumCount"], [], collector);
      if (requirement === undefined) return undefined;
      const minimumCount = parsePositiveInteger(
        requirement.minimumCount,
        `${itemPointer}/minimumCount`,
        collector,
      );
      return minimumCount === undefined
        ? undefined
        : { kind: requirement.kind as CanonicalValue, minimumCount };
    },
  );
  if (mode === undefined || requirements === undefined) return undefined;
  const common = { mode, requirements };
  return Object.hasOwn(object, "waiverAuthority")
    ? { ...common, waiverAuthority: object.waiverAuthority as CanonicalValue }
    : common;
}

function validateRegistries(
  parsed: ParsedWorkflow,
  collector: DiagnosticCollector,
  sha256: Sha256,
): ValidatedRegistries {
  for (const registry of [
    parsed.schemas,
    parsed.roles,
    parsed.modelPolicies,
    parsed.sensors,
    parsed.gates,
  ]) {
    reportDuplicateKeys(registry, collector);
  }

  const schemaIds = new Map<string, string>();
  for (const schema of parsed.schemas) {
    const analysis = analyzeSchemaDefinition(schema.schema, `${schema.pointer}/schema`);
    for (const finding of analysis.findings) {
      addDiagnostic(collector, finding.code, finding.pointer, finding.message);
    }
    for (const resource of analysis.resources) {
      const prior = schemaIds.get(resource.id);
      if (prior === undefined) {
        schemaIds.set(resource.id, resource.pointer);
      } else {
        addDiagnostic(
          collector,
          "duplicate-schema-id",
          resource.pointer,
          `Schema resource $id ${resource.id} is already declared at ${prior}`,
        );
      }
    }
  }

  const policyKeys = new Set(parsed.modelPolicies.map(({ key }) => key));
  for (const role of parsed.roles) {
    if (role.kind === "agent" && role.modelPolicy === undefined) {
      addDiagnostic(
        collector,
        "invalid-role",
        role.pointer,
        "Agent roles require a modelPolicy reference",
      );
    }
    if (role.kind !== "agent" && role.modelPolicy !== undefined) {
      addDiagnostic(
        collector,
        "authority-widening",
        `${role.pointer}/modelPolicy`,
        `${role.kind} roles cannot carry model execution policy`,
      );
    }
    if (role.modelPolicy !== undefined && !policyKeys.has(role.modelPolicy)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${role.pointer}/modelPolicy`,
        `Model policy ${role.modelPolicy} is not declared`,
      );
    }
  }

  const phaseKeys = new Set(parsed.phases.map(({ key }) => key));
  const sensorKeys = new Set(parsed.sensors.map(({ key }) => key));
  const compiledGates = new Map<string, CanonicalValue>();
  const gateKeysByPhase = new Map<string, string[]>();
  for (const gate of parsed.gates) {
    if (!phaseKeys.has(gate.phase)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${gate.pointer}/phase`,
        `Gate phase ${gate.phase} is not declared`,
      );
    }
    for (const reference of collectSensorReferences(gate)) {
      if (!sensorKeys.has(reference.key)) {
        addDiagnostic(
          collector,
          "unknown-reference",
          reference.pointer,
          `Gate sensor ${reference.key} is not declared`,
        );
      }
    }
    try {
      const definition = defineGate(
        {
          key: consumerKey(gate.key),
          blocking: [...gate.blocking].sort(byRuleKey),
          advisory: [...gate.advisory].sort(byRuleKey),
        },
        sha256,
      );
      compiledGates.set(gate.key, canonicalValue(definition));
      const bindings = gateKeysByPhase.get(gate.phase) ?? [];
      bindings.push(gate.key);
      gateKeysByPhase.set(gate.phase, bindings);
    } catch (error) {
      addDiagnostic(
        collector,
        "invalid-gate",
        error instanceof GateError ? pointerForGateError(gate, error) : gate.pointer,
        error instanceof GateError ? error.message : "Gate definition is invalid",
      );
    }
  }
  for (const bindings of gateKeysByPhase.values()) bindings.sort(compareText);
  validateWorkSemantics(parsed, collector);

  return {
    schemas: registryEntries(
      parsed.schemas.map(({ key, schema }) => ({ key, value: { key, schema } })),
      sha256,
    ),
    roles: registryEntries(
      parsed.roles.map(({ pointer: _pointer, ...role }) => ({ key: role.key, value: role })),
      sha256,
    ),
    modelPolicies: registryEntries(
      parsed.modelPolicies.map(({ pointer: _pointer, ...policy }) => ({
        key: policy.key,
        value: policy,
      })),
      sha256,
    ),
    sensors: registryEntries(
      parsed.sensors.map(({ pointer: _pointer, ...sensor }) => ({
        key: sensor.key,
        value: sensor,
      })),
      sha256,
    ),
    gates: registryEntries(
      parsed.gates.flatMap((gate) => {
        const definition = compiledGates.get(gate.key);
        return definition === undefined
          ? []
          : [{ key: gate.key, value: { key: gate.key, phase: gate.phase, definition } }];
      }),
      sha256,
    ),
    projections: registryEntries(
      parsed.projectedWork.map(({ phase, work }) => ({
        key: `${phase}/${work.key}`,
        value: { phase, work: normalizedWorkDefinition(work) },
      })),
      sha256,
    ),
    gateKeysByPhase,
  };
}

function validateWorkSemantics(parsed: ParsedWorkflow, collector: DiagnosticCollector): void {
  const roleByKey = new Map(parsed.roles.map((role) => [role.key, role]));
  const schemaKeys = new Set(parsed.schemas.map(({ key }) => key));
  const phaseKeys = new Set(parsed.phases.map(({ key }) => key));
  const seen = new Map<string, string>();
  const declarations = [
    ...parsed.phases.flatMap(({ key: phase, work }) =>
      work.map((declaration) => ({ phase, work: declaration })),
    ),
    ...parsed.projectedWork,
  ];
  for (const { phase, work } of declarations) {
    const qualifiedKey = `${phase}/${work.key}`;
    const prior = seen.get(qualifiedKey);
    if (prior === undefined) {
      seen.set(qualifiedKey, work.pointer);
    } else {
      addDiagnostic(
        collector,
        "duplicate-key",
        `${work.pointer}/key`,
        `Work ${qualifiedKey} is already declared at ${prior}`,
      );
    }
    const role = roleByKey.get(work.role);
    if (role === undefined) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${work.pointer}/role`,
        `Role ${work.role} is not declared`,
      );
    } else if (role.kind !== "agent") {
      addDiagnostic(
        collector,
        "authority-widening",
        `${work.pointer}/role`,
        `${role.kind} role ${work.role} cannot execute work`,
      );
    }
    if (work.inputSchema !== undefined && !schemaKeys.has(work.inputSchema)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${work.pointer}/inputSchema`,
        `Input schema ${work.inputSchema} is not declared`,
      );
    }
    if (!phaseKeys.has(phase)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        work.pointer.startsWith("/projectedWork")
          ? `${work.pointer.slice(0, work.pointer.lastIndexOf("/work"))}/phase`
          : work.pointer,
        `Projected work phase ${phase} is not declared`,
      );
    }
  }
}
function lowerConfiguration(
  parsed: ParsedWorkflow,
  gateKeysByPhase: ReadonlyMap<string, readonly string[]>,
  collector: DiagnosticCollector,
  sha256: Sha256,
): LoweredConfiguration {
  const workflowIdentity = workflowId(
    `workflow_${pathDigest(`workflow/${parsed.workflow.key}`, sha256)}`,
  );
  const sourceById = new Map<string, { pointer: string }>();
  sourceById.set(workflowIdentity, { pointer: "/workflow" });
  const phases = parsed.phases.map((phase) => {
    const pointer = `/phases/${escapePointer(phase.key)}`;
    const id = phaseIdentity(parsed.workflow.key, phase.key, sha256);
    sourceById.set(id, { pointer });
    return {
      id,
      key: consumerKey(phase.key),
      generation: definitionGeneration(phase.generation),
      parentId: workflowIdentity,
      dependsOn: phase.dependsOn.map((key) => phaseIdentity(parsed.workflow.key, key, sha256)),
      source: { locator: collector.locator, pointer },
      input: phase.input,
    };
  });
  const allWork = [
    ...parsed.phases.flatMap((phase) =>
      phase.work.map((work) => ({ phaseKey: phase.key, work, projected: false })),
    ),
    ...parsed.projectedWork.map(({ phase, work }) => ({ phaseKey: phase, work, projected: true })),
  ];
  const uniqueWork: typeof allWork = [];
  const seen = new Set<string>();
  for (const declaration of allWork) {
    const qualified = `${declaration.phaseKey}/${declaration.work.key}`;
    if (!seen.has(qualified)) uniqueWork.push(declaration);
    seen.add(qualified);
  }
  const executableWork = uniqueWork.map(({ phaseKey, work, projected }) => {
    const pointer = projected
      ? `/projectedWork/${escapePointer(phaseKey)}/${escapePointer(work.key)}`
      : `/phases/${escapePointer(phaseKey)}/work/${escapePointer(work.key)}`;
    const id = taskIdentity(parsed.workflow.key, phaseKey, work.key, sha256);
    sourceById.set(id, { pointer });
    const criteria = [...work.completionPolicy.criteria].sort((left, right) =>
      compareText(left.key, right.key),
    );
    return {
      id,
      key: consumerKey(work.key),
      generation: definitionGeneration(work.generation),
      parentId: phaseIdentity(parsed.workflow.key, phaseKey, sha256),
      dependsOn: work.dependsOn.map((reference) =>
        taskIdentityFromReference(parsed.workflow.key, reference, sha256),
      ),
      source: { locator: collector.locator, pointer },
      input: canonicalValue({
        value: work.input,
        binding: normalizedWorkBinding(work, gateKeysByPhase.get(phaseKey) ?? []),
      }),
      completionPolicy: {
        criteria: criteria.map((criterion) => ({
          criterionId: criterionIdentity(
            parsed.workflow.key,
            phaseKey,
            work.key,
            criterion.key,
            sha256,
          ),
          required: criterion.required,
        })),
        evidencePolicy: normalizeEvidencePolicy(work.completionPolicy.evidencePolicy),
      },
    };
  });
  const criteria = uniqueWork.flatMap(({ phaseKey, work, projected }) =>
    work.completionPolicy.criteria.map((criterion) => {
      const taskPointer = projected
        ? `/projectedWork/${escapePointer(phaseKey)}/${escapePointer(work.key)}`
        : `/phases/${escapePointer(phaseKey)}/work/${escapePointer(work.key)}`;
      const pointer = `${taskPointer}/completionPolicy/criteria/${escapePointer(criterion.key)}`;
      const id = criterionIdentity(parsed.workflow.key, phaseKey, work.key, criterion.key, sha256);
      sourceById.set(id, { pointer });
      return {
        id,
        key: consumerKey(criterion.key),
        generation: definitionGeneration(criterion.generation),
        parentId: taskIdentity(parsed.workflow.key, phaseKey, work.key, sha256),
        source: { locator: collector.locator, pointer },
        input: criterion.input,
      };
    }),
  );
  return {
    input: {
      workflow: {
        id: workflowIdentity,
        key: consumerKey(parsed.workflow.key),
        generation: definitionGeneration(parsed.workflow.generation),
        source: { locator: collector.locator, pointer: "/workflow" },
        input: parsed.workflow.input,
      },
      phases: phases.sort(byDefinitionId),
      executableWork: executableWork.sort(byDefinitionId),
      criteria: criteria.sort(byDefinitionId),
    },
    sourceById,
  };
}

function normalizedWorkBinding(work: ParsedWork, gates: readonly string[]) {
  const common = { role: work.role, budgets: work.budgets, gates: [...gates].sort(compareText) };
  return work.inputSchema === undefined ? common : { ...common, inputSchema: work.inputSchema };
}

function normalizedWorkDefinition(work: ParsedWork): CanonicalValue {
  const common = {
    key: work.key,
    generation: work.generation,
    role: work.role,
    budgets: work.budgets,
    dependsOn: [...work.dependsOn].sort(compareText),
    input: work.input,
    completionPolicy: {
      criteria: [...work.completionPolicy.criteria]
        .sort((left, right) => compareText(left.key, right.key))
        .map(({ key, generation, required, input }) => ({ key, generation, required, input })),
      evidencePolicy: normalizeEvidencePolicy(work.completionPolicy.evidencePolicy),
    },
  };
  return canonicalValue(
    work.inputSchema === undefined ? common : { ...common, inputSchema: work.inputSchema },
  );
}

function normalizeEvidencePolicy(policy: ParsedEvidencePolicy) {
  const requirements = [...policy.requirements].sort((left, right) =>
    compareText(canonicalSerialize(left.kind), canonicalSerialize(right.kind)),
  );
  return policy.waiverAuthority === undefined
    ? { mode: policy.mode, requirements }
    : { mode: policy.mode, requirements, waiverAuthority: policy.waiverAuthority };
}

function createConfigurationSnapshot(
  graph: ReturnType<typeof compileWorkflowGraph>,
  registries: ValidatedRegistries,
  sha256: Sha256,
): ConfigurationSnapshot {
  const contentRegistries = {
    schemas: registries.schemas,
    roles: registries.roles,
    modelPolicies: registries.modelPolicies,
    sensors: registries.sensors,
    gates: registries.gates,
    projections: registries.projections,
  };
  const componentDigests = {
    graph: canonicalDigest(canonicalValue(graph), sha256),
    schemas: canonicalDigest(canonicalValue(contentRegistries.schemas), sha256),
    roles: canonicalDigest(canonicalValue(contentRegistries.roles), sha256),
    modelPolicies: canonicalDigest(canonicalValue(contentRegistries.modelPolicies), sha256),
    sensors: canonicalDigest(canonicalValue(contentRegistries.sensors), sha256),
    gates: canonicalDigest(canonicalValue(contentRegistries.gates), sha256),
    projections: canonicalDigest(canonicalValue(contentRegistries.projections), sha256),
  };
  const content = {
    apiVersion: CONFIGURATION_SNAPSHOT_API_VERSION,
    graph,
    ...contentRegistries,
    componentDigests,
  };
  const snapshotDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, snapshotDigest }) as unknown as ConfigurationSnapshot;
}

function registryEntries(
  declarations: readonly { readonly key: string; readonly value: unknown }[],
  sha256: Sha256,
): readonly ConfigurationRegistryEntry[] {
  return Object.freeze(
    declarations
      .map(({ key, value }) => {
        const canonical = canonicalValue(value);
        return { key, value: canonical, digest: canonicalDigest(canonical, sha256) };
      })
      .sort((left, right) => compareText(left.key, right.key)),
  );
}

function reportDuplicateKeys(
  declarations: readonly { readonly key: string; readonly pointer: string }[],
  collector: DiagnosticCollector,
): void {
  const seen = new Map<string, string>();
  for (const declaration of declarations) {
    const prior = seen.get(declaration.key);
    if (prior === undefined) seen.set(declaration.key, `${declaration.pointer}/key`);
    else {
      addDiagnostic(
        collector,
        "duplicate-key",
        `${declaration.pointer}/key`,
        `Key ${declaration.key} is already declared at ${prior}`,
      );
    }
  }
}

function collectSensorReferences(gate: ParsedGate): readonly { key: string; pointer: string }[] {
  const references: { key: string; pointer: string }[] = [];
  const visitCondition = (condition: ConditionInput, pointer: string): void => {
    if (!isRecord(condition)) return;
    switch (condition.operator) {
      case "all":
      case "any":
        if (Array.isArray(condition.conditions)) {
          condition.conditions.forEach((child, index) => {
            visitCondition(child, `${pointer}/conditions/${index}`);
          });
        }
        return;
      case "not":
        visitCondition(condition.condition, `${pointer}/condition`);
        return;
      case "exists":
      case "equals":
      case "not-equals":
      case "greater-than":
      case "greater-than-or-equal":
      case "less-than":
      case "less-than-or-equal":
        if (isRecord(condition.accessor) && typeof condition.accessor.sensorKey === "string") {
          references.push({
            key: condition.accessor.sensorKey,
            pointer: `${pointer}/accessor/sensorKey`,
          });
        }
        return;
    }
  };
  const visitRules = (rules: readonly GateRuleInput[], pointer: string): void => {
    rules.forEach((rule, index) => {
      if (isRecord(rule)) visitCondition(rule.condition, `${pointer}/${index}/condition`);
    });
  };
  visitRules(gate.blocking, `${gate.pointer}/blocking`);
  visitRules(gate.advisory, `${gate.pointer}/advisory`);
  return references;
}

function pointerForGateError(gate: ParsedGate, error: GateError): string {
  if (error.path === undefined) return gate.pointer;
  const path = [...error.path];
  const [kind, sortedIndex] = path;
  if ((kind === "blocking" || kind === "advisory") && typeof sortedIndex === "number") {
    const sortedRules = [...gate[kind]].sort(byRuleKey);
    const failedRule = sortedRules[sortedIndex];
    if (failedRule !== undefined) {
      const sourceIndex = gate[kind].indexOf(failedRule);
      if (sourceIndex >= 0) path[1] = sourceIndex;
    }
  }
  return `${gate.pointer}/${path.map((segment) => escapePointer(String(segment))).join("/")}`;
}

function parseArray<Result>(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
  parseItem: (item: CanonicalValue, pointer: string) => Result | undefined,
): readonly Result[] | undefined {
  if (!Array.isArray(value)) {
    addDiagnostic(collector, "invalid-field", pointer, `${pointer} must be an array`);
    return undefined;
  }
  const accepted: Result[] = [];
  value.forEach((item, index) => {
    const parsed = parseItem(item, `${pointer}/${index}`);
    if (parsed !== undefined) accepted.push(parsed);
  });
  return Object.freeze(accepted);
}

function exactObject(
  value: CanonicalValue | undefined,
  pointer: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  collector: DiagnosticCollector,
): CanonicalObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addDiagnostic(
      collector,
      "invalid-document",
      pointer,
      `${pointer || "Document"} must be an object`,
    );
    return undefined;
  }
  const object = value as CanonicalObject;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      addDiagnostic(
        collector,
        "unknown-field",
        `${pointer}/${escapePointer(key)}`,
        `Unknown field ${key}`,
      );
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(object, key)) {
      addDiagnostic(
        collector,
        "missing-field",
        `${pointer}/${escapePointer(key)}`,
        `Missing required field ${key}`,
      );
    }
  }
  return object;
}

function parseKey(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (!isConsumerKey(value)) {
    addDiagnostic(collector, "invalid-key", pointer, "Key must use the consumer key lexical form");
    return undefined;
  }
  return value;
}

function parseGeneration(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): number | undefined {
  if (!isDefinitionGeneration(value)) {
    addDiagnostic(
      collector,
      "invalid-generation",
      pointer,
      "Generation must be a positive safe integer",
    );
    return undefined;
  }
  return value;
}

function parseReference(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    addDiagnostic(
      collector,
      "invalid-field",
      pointer,
      "Reference must be a non-empty finite string",
    );
    return undefined;
  }
  return value;
}

function parseBoundedString(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\0")
  ) {
    addDiagnostic(
      collector,
      "invalid-field",
      pointer,
      "Value must be a non-empty string of at most 1024 characters",
    );
    return undefined;
  }
  return value;
}

function parsePositiveInteger(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    addDiagnostic(collector, "invalid-field", pointer, "Value must be a positive safe integer");
    return undefined;
  }
  return value;
}

function parseBoundedPositiveInteger(
  value: CanonicalValue | undefined,
  pointer: string,
  maximum: number,
  collector: DiagnosticCollector,
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    addDiagnostic(collector, "invalid-field", pointer, `Value must be between 1 and ${maximum}`);
    return undefined;
  }
  return value;
}

function parseStringArray(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): readonly string[] | undefined {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    addDiagnostic(collector, "invalid-field", pointer, `${pointer} must be an array of strings`);
    return undefined;
  }
  const accepted: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/${index}`,
        "Reference must be a string",
      );
    } else accepted.push(item);
  });
  return Object.freeze(accepted);
}

function parseUniqueStrings(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
  label: string,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    addDiagnostic(
      collector,
      "invalid-field",
      pointer,
      `${label} must be an array with at most ${MAX_LIST_ITEMS} items`,
    );
    return undefined;
  }
  const accepted: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const parsed = parseBoundedString(item, `${pointer}/${index}`, collector);
    if (parsed === undefined) return;
    if (seen.has(parsed)) {
      addDiagnostic(
        collector,
        "duplicate-key",
        `${pointer}/${index}`,
        `${label} duplicates ${parsed}`,
      );
    } else {
      accepted.push(parsed);
      seen.add(parsed);
    }
  });
  return Object.freeze(accepted.sort(compareText));
}

function parseArgv(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    addDiagnostic(
      collector,
      "invalid-sensor",
      pointer,
      "Sensor argv must be a non-empty bounded array",
    );
    return undefined;
  }
  const accepted = value.map((item, index) =>
    parseBoundedString(item, `${pointer}/${index}`, collector),
  );
  return accepted.some((item) => item === undefined)
    ? undefined
    : Object.freeze(accepted as string[]);
}

function parseSafePath(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    addDiagnostic(collector, "invalid-sensor", pointer, "Sensor cwd must be a safe relative path");
    return undefined;
  }
  return value;
}

function parseEnvironment(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): readonly string[] | undefined {
  const environment = parseUniqueStrings(value, pointer, collector, "Inherited environment");
  if (environment === undefined) return undefined;
  let valid = true;
  environment.forEach((name, index) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      addDiagnostic(
        collector,
        "invalid-sensor",
        `${pointer}/${index}`,
        `Environment name ${name} is invalid`,
      );
      valid = false;
    }
  });
  return valid ? environment : undefined;
}

function pointerForGraphDiagnostic(
  diagnostic: GraphCompilationDiagnostic,
  lowered: LoweredConfiguration,
): string {
  const source =
    diagnostic.subject === undefined ? undefined : lowered.sourceById.get(diagnostic.subject.id);
  if (source === undefined) return "/workflow";
  if (diagnostic.field === "completionPolicy") return `${source.pointer}/completionPolicy`;
  if (diagnostic.field === "evidencePolicy")
    return `${source.pointer}/completionPolicy/evidencePolicy`;
  return diagnostic.field === "dependsOn" ||
    diagnostic.field === "parentId" ||
    diagnostic.field === "source" ||
    diagnostic.field === "supersedes"
    ? `${source.pointer}/${diagnostic.field}`
    : source.pointer;
}

function phaseIdentity(workflowKey: string, phaseKey: string, sha256: Sha256) {
  return phaseId(`phase_${pathDigest(`workflow/${workflowKey}/phases/${phaseKey}`, sha256)}`);
}

function taskIdentity(workflowKey: string, phaseKey: string, workKey: string, sha256: Sha256) {
  return taskId(
    `task_${pathDigest(`workflow/${workflowKey}/phases/${phaseKey}/work/${workKey}`, sha256)}`,
  );
}

function taskIdentityFromReference(workflowKey: string, reference: string, sha256: Sha256) {
  const separator = reference.indexOf("/");
  return taskIdentity(
    workflowKey,
    separator < 0 ? reference : reference.slice(0, separator),
    separator < 0 ? "" : reference.slice(separator + 1),
    sha256,
  );
}

function criterionIdentity(
  workflowKey: string,
  phaseKey: string,
  workKey: string,
  criterionKey: string,
  sha256: Sha256,
) {
  return criterionId(
    `criterion_${pathDigest(
      `workflow/${workflowKey}/phases/${phaseKey}/work/${workKey}/criteria/${criterionKey}`,
      sha256,
    )}`,
  );
}

function pathDigest(path: string, sha256: Sha256): string {
  return sha256Digest(sha256.digest(new TextEncoder().encode(path)));
}

function byDefinitionId(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareText(left.id, right.id);
}

function byRuleKey(left: GateRuleInput, right: GateRuleInput): number {
  return compareText(left.key, right.key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function addDiagnostic(
  collector: DiagnosticCollector,
  code: ConfigurationDiagnosticCode,
  pointer: string,
  message: string,
): void {
  collector.diagnostics.push({
    code,
    locator: code === "invalid-locator" ? "" : collector.locator,
    pointer,
    message,
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
