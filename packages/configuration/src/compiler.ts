import {
  AmendmentError,
  BUDGET_UNITS,
  type BudgetUnit,
  type CanonicalValue,
  type ConditionInput,
  type ConsumerKey,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  type compileWorkflowGraph,
  consumerKey,
  createAmendmentProposal,
  criterionId,
  DataflowError,
  type DataMappingDeclaration,
  defineGate,
  definitionGeneration,
  diagnoseWorkflowGraph,
  GateError,
  type GateRuleInput,
  type GraphCompilationDiagnostic,
  isConsumerKey,
  isDefinitionGeneration,
  isSha256Digest,
  type NormalizedAmendmentOperation,
  type NormalizedWorkflowInput,
  normalizedWorkflowInputFromGraph,
  phaseId,
  type Sha256,
  sha256Digest,
  taskId,
  validateDataMappingDeclarations,
  validateWorkflowGraph,
  workflowId,
} from "@senawa/kernel";
import {
  CONFIGURATION_SNAPSHOT_API_VERSION,
  type ConfigurationAmendmentCompilation,
  type ConfigurationAmendmentDoctorResult,
  type ConfigurationDiagnostic,
  type ConfigurationDiagnosticCode,
  type ConfigurationDoctorResult,
  type ConfigurationPromptResource,
  type ConfigurationRegistryEntry,
  type ConfigurationSchemaResource,
  type ConfigurationSnapshot,
  type ExecutionPolicy,
  type RemotePolicy,
  WORKFLOW_AMENDMENT_API_VERSION,
  WORKFLOW_CONFIGURATION_API_VERSION,
  type WorkflowAmendmentCompilationInput,
  type WorkflowConfigurationCompilationInput,
} from "./contracts.js";
import { ConfigurationCompilationError, sortDiagnostics } from "./diagnostics.js";
import {
  canonicalPromptInputPaths,
  PromptTemplateError,
  parsePromptTemplate,
} from "./prompt-template.js";
import {
  CONFIGURATION_RESOURCE_LIMITS,
  ConfigurationResourceValidationError,
  parseStrictJsonResource,
  readConfigurationTextResource,
  validateConfigurationResourcePath,
} from "./resources.js";
import { analyzeSchemaDefinition, normalizeSchemaResourceId } from "./schema.js";

const MAX_SENSOR_TIMEOUT_MILLISECONDS = 2_147_483_647;
const MAX_SENSOR_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SENSOR_ATTEMPTS = 10_000;
const MAX_SENSOR_AGGREGATE_OUTPUT_BYTES = 1024 * 1024 * 1024;

type CanonicalObject = CanonicalValue & Readonly<Record<string, CanonicalValue>>;

interface ParsedWorkflow {
  readonly execution: ExecutionPolicy;
  readonly remote?: ParsedRemotePolicy;
  readonly workflow: ParsedWorkflowDeclaration;
  readonly prompts: readonly ParsedPromptDeclaration[];
  readonly schemas: readonly ParsedSchemaDeclaration[];
  readonly roles: readonly ParsedRole[];
  readonly modelPolicies: readonly ParsedModelPolicy[];
  readonly sensors: readonly ParsedSensor[];
  readonly gates: readonly ParsedGate[];
  readonly completionEvidenceViews: readonly ParsedCompletionEvidenceView[];
  readonly forEach: readonly ParsedForEach[];
  readonly taskTemplates: readonly ParsedTaskTemplate[];
  readonly phases: readonly ParsedPhase[];
}

interface ParsedAmendment {
  readonly baseSnapshotDigest: string;
  readonly baseContextDigest: string;
  readonly operations: readonly ParsedAmendmentOperation[];
}

type ParsedAmendmentOperation =
  | { readonly kind: "add-phase"; readonly phase: ParsedPhase }
  | { readonly kind: "add-task"; readonly phase: string; readonly work: ParsedWork };

interface ParsedWorkflowDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly inputSchema: string;
}

interface ParsedPromptDeclaration {
  readonly pointer: string;
  readonly key: string;
  readonly path: string;
  readonly inputPaths: readonly string[];
}

interface ParsedSchemaDeclaration {
  readonly pointer: string;
  readonly key: string;
  readonly path: string;
}

interface ResolvedWorkflow extends Omit<ParsedWorkflow, "prompts" | "schemas"> {
  readonly prompts: readonly ResolvedPrompt[];
  readonly schemas: readonly ResolvedSchema[];
}

type ResolvedPrompt = Omit<ParsedPromptDeclaration, "key"> & ConfigurationPromptResource;

type ResolvedSchema = Omit<ParsedSchemaDeclaration, "key"> & ConfigurationSchemaResource;

interface ParsedRole {
  readonly pointer: string;
  readonly key: string;
  readonly kind: "agent" | "human" | "authority";
  readonly capabilities: readonly string[];
  readonly prompt?: string;
  readonly modelPolicy?: string;
  readonly sessionScope?: "attempt" | "phase" | "run";
  readonly sessionMaxTurns?: number;
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

interface ParsedCompletionEvidenceView {
  readonly pointer: string;
  readonly key: string;
  readonly phase: string;
  readonly evidenceKinds: readonly CanonicalValue[];
}

interface ParsedForEach {
  readonly pointer: string;
  readonly key: string;
  readonly source:
    | { readonly kind: "phase-output"; readonly phase: string; readonly output: string }
    | { readonly kind: "phase-input"; readonly phase: string };
  readonly collectionPointer: string;
  readonly collectionSchema: string;
  readonly itemSchema: string;
  readonly identityPointer: string;
  readonly limits: Readonly<{
    readonly maxSelectedItems: number;
    readonly maxTotalTasks: number;
    readonly maxConcurrency: number;
    readonly exhaustion: "escalate" | "fail";
  }>;
}

interface ParsedTaskTemplate {
  readonly pointer: string;
  readonly key: string;
  readonly generation: number;
  readonly role: string;
  readonly budgets: readonly ParsedBudget[];
  readonly inputSchema: string;
  readonly inputMappings: readonly DataMappingDeclaration[];
  readonly dependencyIdentityPointer?: string;
  readonly repositoryChanges: "required" | "allowed" | "forbidden";
  readonly completionPolicy: ParsedCompletionPolicy;
}

interface ParsedPhase {
  readonly pointer: string;
  readonly key: string;
  readonly generation: number;
  readonly dependsOn: readonly string[];
  readonly input: ParsedPhaseInput;
  readonly executor: ParsedPhaseExecutor;
  readonly outputs: readonly ParsedPhaseOutput[];
  readonly iteration: ParsedPhaseIteration;
  readonly exit: ParsedPhaseExit;
  readonly actions: readonly ParsedPhaseAction[];
  readonly work: readonly ParsedWork[];
}

interface ParsedPhaseAction {
  readonly kind: "import-plan";
  readonly forEach: string;
}

interface ParsedPhaseInput {
  readonly schema: string;
  readonly mappings: readonly DataMappingDeclaration[];
}

type ParsedPhaseExecutor =
  | {
      readonly kind: "agent";
      readonly role: string;
      readonly budgets: readonly ParsedBudget[];
      readonly completionPolicy: ParsedCompletionPolicy;
      readonly resumeAcrossAttempts: boolean;
    }
  | { readonly kind: "task-set"; readonly work: readonly ParsedWork[] }
  | { readonly kind: "task-frontier"; readonly forEach: string; readonly template: string };

interface ParsedPhaseOutput {
  readonly key: string;
  readonly schema: string;
  readonly path: string;
  readonly maxBytes: number;
}

interface ParsedPhaseIteration {
  readonly maximumAttempts: number;
  readonly onGateRejected: "iterate" | "fail";
  readonly onApprovalRejected: "iterate" | "fail";
  readonly onUpstreamChanged?: "iterate" | "fail";
  readonly onExhausted: "escalate" | "fail";
}

interface ParsedPhaseExit {
  readonly requiredOutputs: readonly string[];
  readonly gate?: string;
  readonly approval:
    | { readonly policy: "none" }
    | {
        readonly policy: "required";
        readonly authority: CanonicalValue;
        readonly scope?: "phase" | "member";
      };
}

interface ParsedWork {
  readonly pointer: string;
  readonly key: string;
  /** What a person calls this piece of work. The key stays the identity. */
  readonly title?: string;
  readonly generation: number;
  readonly role: string;
  readonly budgets: readonly ParsedBudget[];
  readonly dependsOn: readonly string[];
  readonly inputSchema?: string;
  readonly input: CanonicalValue;
  readonly completionPolicy: ParsedCompletionPolicy;
  readonly reservedExecutor?: true;
}

interface ParsedBudget {
  readonly unit: BudgetUnit;
  readonly limit: number;
}

interface ParsedCompletionPolicy {
  readonly criteria: readonly ParsedCriterion[];
  readonly completionEvidencePolicy: ParsedCompletionEvidencePolicy;
}

interface ParsedCriterion {
  readonly key: string;
  readonly generation: number;
  readonly required: boolean;
  readonly input: CanonicalValue;
}

interface ParsedCompletionEvidencePolicy {
  readonly mode: "none" | "task" | "required-criteria" | "all-satisfied";
  readonly requirements: readonly {
    readonly kind: CanonicalValue;
    readonly minimumCount: number;
  }[];
  readonly waiverAuthority?: CanonicalValue;
}

interface ParsedRemotePolicy {
  readonly disconnectedMode: RemotePolicy["disconnectedMode"];
  readonly roleMappings: readonly ParsedRemoteRoleMapping[];
  readonly maximumRemoteAuthorizationLeaseSeconds: number;
  readonly synchronization: RemotePolicy["synchronization"];
}

type ParsedRemoteRoleMapping = RemotePolicy["roleMappings"][number] & {
  readonly pointer: string;
};

interface DiagnosticCollector {
  readonly locator: string;
  readonly diagnostics: ConfigurationDiagnostic[];
}

interface LoweredConfiguration {
  readonly execution: ExecutionPolicy;
  readonly remote?: RemotePolicy;
  readonly input: NormalizedWorkflowInput;
  readonly sourceById: ReadonlyMap<string, { readonly pointer: string }>;
}

interface ValidatedRegistries {
  readonly prompts: readonly ConfigurationPromptResource[];
  readonly schemas: readonly ConfigurationSchemaResource[];
  readonly roles: readonly ConfigurationRegistryEntry[];
  readonly modelPolicies: readonly ConfigurationRegistryEntry[];
  readonly sensors: readonly ConfigurationRegistryEntry[];
  readonly gates: readonly ConfigurationRegistryEntry[];
  readonly completionEvidenceViews: readonly ConfigurationRegistryEntry[];
  readonly phaseDataflow: readonly ConfigurationRegistryEntry[];
  readonly forEach: readonly ConfigurationRegistryEntry[];
  readonly taskTemplates: readonly ConfigurationRegistryEntry[];
  readonly gateKeysByPhase: ReadonlyMap<string, readonly string[]>;
}

// Only the review iteration loop is enforced at runtime. Requiring the other
// five units made every phase declare limits nothing reads.
const REQUIRED_WORK_BUDGETS: readonly BudgetUnit[] = Object.freeze(["review-iteration"]);
const ROOT_FIELDS = [
  "apiVersion",
  "kind",
  "workflow",
  "prompts",
  "schemas",
  "roles",
  "modelPolicies",
  "sensors",
  "gates",
  "completionEvidenceViews",
  "forEach",
  "taskTemplates",
  "phases",
];
const OPTIONAL_ROOT_FIELDS = ["execution", "remote"];
const MAX_LIST_ITEMS = 256;
const AMENDMENT_ROOT_FIELDS = [
  "apiVersion",
  "kind",
  "baseSnapshotDigest",
  "baseContextDigest",
  "operations",
];

export async function doctorWorkflowConfiguration(
  input: WorkflowConfigurationCompilationInput,
  sha256: Sha256,
): Promise<ConfigurationDoctorResult> {
  const locator = input.locator;
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
    snapshot = canonicalValue(input.document);
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

  const resolved = await resolveConfigurationResources(parsed, input.resources, collector, sha256);
  if (resolved === undefined) return { diagnostics: sortDiagnostics(collector.diagnostics) };
  const registries = validateRegistries(resolved, collector, sha256);
  const lowered = lowerConfiguration(resolved, registries.gateKeysByPhase, collector, sha256);
  const compiled = diagnoseLoweredConfiguration(lowered, registries, collector, sha256);
  if (compiled === undefined) return { diagnostics: sortDiagnostics(collector.diagnostics) };
  return { diagnostics: Object.freeze([]), snapshot: compiled };
}

function diagnoseLoweredConfiguration(
  lowered: LoweredConfiguration,
  registries: ValidatedRegistries,
  collector: DiagnosticCollector,
  sha256: Sha256,
): ConfigurationSnapshot | undefined {
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
    return undefined;
  }
  return createConfigurationSnapshot(
    diagnosis.graph,
    registries,
    lowered.execution,
    lowered.remote,
    sha256,
  );
}

export async function compileWorkflowConfiguration(
  input: WorkflowConfigurationCompilationInput,
  sha256: Sha256,
): Promise<ConfigurationSnapshot> {
  const result = await doctorWorkflowConfiguration(input, sha256);
  if (result.snapshot === undefined) throw new ConfigurationCompilationError(result.diagnostics);
  return result.snapshot;
}

export function doctorWorkflowAmendment(
  input: WorkflowAmendmentCompilationInput,
  sha256: Sha256,
): ConfigurationAmendmentDoctorResult {
  const validLocator = typeof input.locator === "string" && input.locator.length > 0;
  const collector: DiagnosticCollector = {
    locator: validLocator ? input.locator : "invalid://configuration-source",
    diagnostics: [],
  };
  if (!validLocator) {
    addDiagnostic(collector, "invalid-locator", "", "Source locator must be a non-empty string");
  }

  let document: CanonicalValue;
  try {
    document = canonicalValue(input.document);
  } catch {
    addDiagnostic(
      collector,
      "invalid-canonical-value",
      "",
      "Workflow amendment must contain only finite JSON values and plain objects",
    );
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }

  const parsed = parseAmendmentDocument(document, collector);
  if (parsed === undefined) return { diagnostics: sortDiagnostics(collector.diagnostics) };
  let baseSnapshot: ConfigurationSnapshot;
  try {
    baseSnapshot = validateConfigurationSnapshot(input.baseSnapshot, sha256);
  } catch (error) {
    addDiagnostic(
      collector,
      "invalid-document",
      "/baseSnapshotDigest",
      error instanceof Error ? error.message : "Base configuration snapshot is invalid",
    );
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }
  if (parsed.baseSnapshotDigest !== baseSnapshot.snapshotDigest) {
    addDiagnostic(
      collector,
      "stale-base",
      "/baseSnapshotDigest",
      "Amendment baseSnapshotDigest does not match the accepted configuration snapshot",
    );
  }

  let baseInput: NormalizedWorkflowInput;
  try {
    baseInput = normalizedWorkflowInputFromGraph(baseSnapshot.graph, sha256);
  } catch (error) {
    addDiagnostic(
      collector,
      "invalid-document",
      "/baseSnapshotDigest",
      error instanceof Error ? error.message : "Base configuration snapshot graph is invalid",
    );
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }

  const registries = registriesFromSnapshot(baseSnapshot);
  validateAmendmentSemantics(parsed, baseSnapshot, collector);
  const lowered = lowerAmendment(
    parsed,
    baseInput,
    baseSnapshot.execution,
    baseSnapshot.remote,
    registries.gateKeysByPhase,
    collector,
    sha256,
  );
  const resultSnapshot = diagnoseLoweredConfiguration(
    lowered.candidate,
    registries,
    collector,
    sha256,
  );
  if (resultSnapshot === undefined) {
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }

  try {
    const proposal = createAmendmentProposal(
      {
        source: { kind: "configuration-amendment", locator: input.locator },
        baseGraph: baseSnapshot.graph,
        baseContextDigest: sha256Digest(parsed.baseContextDigest),
        baseConfigurationSnapshotDigest: baseSnapshot.snapshotDigest,
        resultConfigurationSnapshotDigest: resultSnapshot.snapshotDigest,
        operations: lowered.operations,
        phaseCandidateHistory: input.phaseCandidateHistory,
      },
      sha256,
    );
    return {
      diagnostics: Object.freeze([]),
      compilation: canonicalValue({
        operations: proposal.operations,
        resultSnapshot,
        proposal,
      }) as unknown as ConfigurationAmendmentCompilation,
    };
  } catch (error) {
    addDiagnostic(
      collector,
      error instanceof AmendmentError ? error.code : "invalid-document",
      "/operations",
      error instanceof Error ? error.message : "Amendment compilation failed",
    );
    return { diagnostics: sortDiagnostics(collector.diagnostics) };
  }
}

export function compileWorkflowAmendment(
  input: WorkflowAmendmentCompilationInput,
  sha256: Sha256,
): ConfigurationAmendmentCompilation {
  const result = doctorWorkflowAmendment(input, sha256);
  if (result.compilation === undefined) {
    throw new ConfigurationCompilationError(result.diagnostics);
  }
  return result.compilation;
}

function parseAmendmentDocument(
  value: CanonicalValue,
  collector: DiagnosticCollector,
): ParsedAmendment | undefined {
  const document = exactObject(value, "", AMENDMENT_ROOT_FIELDS, [], collector);
  if (document === undefined) return undefined;
  if (document.apiVersion !== WORKFLOW_AMENDMENT_API_VERSION) {
    addDiagnostic(
      collector,
      "invalid-api-version",
      "/apiVersion",
      `apiVersion must be ${WORKFLOW_AMENDMENT_API_VERSION}`,
    );
  }
  if (document.kind !== "WorkflowAmendment") {
    addDiagnostic(collector, "invalid-kind", "/kind", "kind must be WorkflowAmendment");
  }
  const baseSnapshotDigest = parseDigest(
    document.baseSnapshotDigest,
    "/baseSnapshotDigest",
    collector,
  );
  const baseContextDigest = parseDigest(
    document.baseContextDigest,
    "/baseContextDigest",
    collector,
  );
  const operations = parseArray(
    document.operations,
    "/operations",
    collector,
    (operation, pointer) => parseAmendmentOperation(operation, pointer, collector),
  );
  if (operations !== undefined && operations.length === 0) {
    addDiagnostic(collector, "invalid-operation", "/operations", "Amendments require an operation");
  }
  return baseSnapshotDigest === undefined ||
    baseContextDigest === undefined ||
    operations === undefined
    ? undefined
    : { baseSnapshotDigest, baseContextDigest, operations };
}

function parseAmendmentOperation(
  value: CanonicalValue,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedAmendmentOperation | undefined {
  if (!isRecord(value)) {
    addDiagnostic(collector, "invalid-document", pointer, "Amendment operations must be objects");
    return undefined;
  }
  if (value.kind === "add-phase") {
    const operation = exactObject(value, pointer, ["kind", "phase"], [], collector);
    if (operation === undefined) return undefined;
    const phase = parsePhase(operation.phase, `${pointer}/phase`, collector);
    return phase === undefined ? undefined : { kind: value.kind, phase };
  }
  if (value.kind === "add-task") {
    const operation = exactObject(value, pointer, ["kind", "phase", "work"], [], collector);
    if (operation === undefined) return undefined;
    const phase = parseReference(operation.phase, `${pointer}/phase`, collector);
    const work = parseWork(operation.work, `${pointer}/work`, collector);
    return phase === undefined || work === undefined
      ? undefined
      : { kind: value.kind, phase, work };
  }
  addDiagnostic(
    collector,
    "invalid-operation",
    `${pointer}/kind`,
    "Operation must add a phase or task",
  );
  return undefined;
}

function parseDocument(
  value: CanonicalValue,
  collector: DiagnosticCollector,
): ParsedWorkflow | undefined {
  const document = exactObject(value, "", ROOT_FIELDS, OPTIONAL_ROOT_FIELDS, collector);
  if (document === undefined) return undefined;
  if (document.apiVersion !== WORKFLOW_CONFIGURATION_API_VERSION) {
    addDiagnostic(
      collector,
      "invalid-api-version",
      "/apiVersion",
      `apiVersion must be ${WORKFLOW_CONFIGURATION_API_VERSION}`,
    );
    return undefined;
  }
  if (document.kind !== "Workflow") {
    addDiagnostic(collector, "invalid-kind", "/kind", "kind must be Workflow");
  }
  const execution = parseExecution(document.execution, collector);
  const remote = parseRemotePolicy(document.remote, collector);
  const workflow = parseWorkflow(document.workflow, collector);
  const prompts = parsePrompts(document.prompts, collector);
  const schemas = parseSchemas(document.schemas, collector);
  const roles = parseRoles(document.roles, collector);
  const modelPolicies = parseModelPolicies(document.modelPolicies, collector);
  const sensors = parseSensors(document.sensors, collector);
  const gates = parseGates(document.gates, collector);
  const completionEvidenceViews = parseCompletionEvidenceViews(
    document.completionEvidenceViews,
    collector,
  );
  const forEach = parseForEachRegistry(
    Reflect.get(document, "forEach") as CanonicalValue,
    collector,
  );
  const taskTemplates = parseTaskTemplateRegistry(document.taskTemplates, collector);
  const phases = parsePhases(document.phases, collector);
  if (
    execution === undefined ||
    remote === null ||
    workflow === undefined ||
    prompts === undefined ||
    schemas === undefined ||
    roles === undefined ||
    modelPolicies === undefined ||
    sensors === undefined ||
    gates === undefined ||
    completionEvidenceViews === undefined ||
    forEach === undefined ||
    taskTemplates === undefined ||
    phases === undefined
  ) {
    return undefined;
  }
  return {
    execution,
    ...(remote === undefined ? {} : { remote }),
    workflow,
    prompts,
    schemas,
    roles,
    modelPolicies,
    sensors,
    gates,
    completionEvidenceViews,
    forEach,
    taskTemplates,
    phases,
  };
}

function parseExecution(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): ExecutionPolicy | undefined {
  if (value === undefined) {
    return Object.freeze({
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: "continue",
    });
  }
  const object = exactObject(
    value,
    "/execution",
    [],
    ["workspaceMode", "maxWriterConcurrency", "failurePolicy", "integrationRef"],
    collector,
  );
  if (object === undefined) return undefined;
  const workspaceMode = object.workspaceMode ?? "repository";
  if (workspaceMode !== "repository" && workspaceMode !== "worktree") {
    addDiagnostic(
      collector,
      "invalid-field",
      "/execution/workspaceMode",
      "workspaceMode must be repository or worktree",
    );
  }
  const maxWriterConcurrency =
    object.maxWriterConcurrency === undefined
      ? 1
      : parsePositiveInteger(
          object.maxWriterConcurrency,
          "/execution/maxWriterConcurrency",
          collector,
        );
  const failurePolicy = object.failurePolicy ?? "continue";
  if (failurePolicy !== "continue" && failurePolicy !== "fail-fast") {
    addDiagnostic(
      collector,
      "invalid-field",
      "/execution/failurePolicy",
      "failurePolicy must be continue or fail-fast",
    );
  }
  const integrationRef = object.integrationRef;
  const validIntegrationRef =
    integrationRef === undefined ||
    (typeof integrationRef === "string" && isFullLocalBranchRef(integrationRef));
  if (!validIntegrationRef) {
    addDiagnostic(
      collector,
      "invalid-field",
      "/execution/integrationRef",
      "integrationRef must be a full refs/heads branch ref",
    );
  }
  if (workspaceMode === "repository" && integrationRef !== undefined) {
    addDiagnostic(
      collector,
      "invalid-field",
      "/execution/integrationRef",
      "repository mode forbids integrationRef",
    );
  }
  if (
    workspaceMode === "repository" &&
    maxWriterConcurrency !== undefined &&
    maxWriterConcurrency > 1
  ) {
    addDiagnostic(
      collector,
      "invalid-field",
      "/execution/maxWriterConcurrency",
      "repository mode permits exactly one writer",
    );
  }
  if (workspaceMode === "worktree" && integrationRef === undefined) {
    addDiagnostic(
      collector,
      "missing-field",
      "/execution/integrationRef",
      "worktree mode requires integrationRef",
    );
  }
  if (
    (workspaceMode !== "repository" && workspaceMode !== "worktree") ||
    maxWriterConcurrency === undefined ||
    (failurePolicy !== "continue" && failurePolicy !== "fail-fast") ||
    !validIntegrationRef ||
    (workspaceMode === "repository" &&
      (integrationRef !== undefined || maxWriterConcurrency > 1)) ||
    (workspaceMode === "worktree" && integrationRef === undefined)
  ) {
    return undefined;
  }
  const common = { workspaceMode, maxWriterConcurrency, failurePolicy } as const;
  return Object.freeze(
    workspaceMode === "worktree" ? { ...common, integrationRef } : common,
  ) as ExecutionPolicy;
}

function parseRemotePolicy(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): ParsedRemotePolicy | null | undefined {
  if (value === undefined) return undefined;
  const object = exactObject(
    value,
    "/remote",
    ["roleMappings", "maximumRemoteAuthorizationLeaseSeconds", "synchronization"],
    ["disconnectedMode"],
    collector,
  );
  if (object === undefined) return null;

  const disconnectedMode = object.disconnectedMode ?? "continue-authorized-local";
  if (
    disconnectedMode !== "continue-authorized-local" &&
    disconnectedMode !== "pause-new-local-work"
  ) {
    addDiagnostic(
      collector,
      "invalid-field",
      "/remote/disconnectedMode",
      "disconnectedMode must be continue-authorized-local or pause-new-local-work",
    );
  }
  const roleMappings = Object.hasOwn(object, "roleMappings")
    ? parseRemoteRoleMappings(object.roleMappings, collector)
    : undefined;
  const maximumRemoteAuthorizationLeaseSeconds = Object.hasOwn(
    object,
    "maximumRemoteAuthorizationLeaseSeconds",
  )
    ? parsePositiveInteger(
        object.maximumRemoteAuthorizationLeaseSeconds,
        "/remote/maximumRemoteAuthorizationLeaseSeconds",
        collector,
      )
    : undefined;
  const synchronization = Object.hasOwn(object, "synchronization")
    ? parseRemoteSynchronization(object.synchronization, collector)
    : undefined;
  if (
    (disconnectedMode !== "continue-authorized-local" &&
      disconnectedMode !== "pause-new-local-work") ||
    roleMappings === undefined ||
    maximumRemoteAuthorizationLeaseSeconds === undefined ||
    synchronization === undefined
  ) {
    return null;
  }
  return {
    disconnectedMode: disconnectedMode as RemotePolicy["disconnectedMode"],
    roleMappings,
    maximumRemoteAuthorizationLeaseSeconds,
    synchronization,
  };
}

function parseRemoteRoleMappings(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedRemoteRoleMapping[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    addDiagnostic(
      collector,
      "invalid-field",
      "/remote/roleMappings",
      `roleMappings must be an array with at most ${MAX_LIST_ITEMS} items`,
    );
    return undefined;
  }
  const mappings: ParsedRemoteRoleMapping[] = [];
  const inputPointers = new Map<string, string>();
  value.forEach((item, index) => {
    const pointer = `/remote/roleMappings/${index}`;
    const object = exactObject(
      item,
      pointer,
      ["issuer", "tenant", "upstreamRole", "localRoles"],
      [],
      collector,
    );
    if (object === undefined) return;
    if (
      !Object.hasOwn(object, "issuer") ||
      !Object.hasOwn(object, "tenant") ||
      !Object.hasOwn(object, "upstreamRole") ||
      !Object.hasOwn(object, "localRoles")
    ) {
      return;
    }
    const issuer = parseBoundedString(object.issuer, `${pointer}/issuer`, collector);
    const tenant = parseBoundedString(object.tenant, `${pointer}/tenant`, collector);
    const upstreamRole = parseBoundedString(
      object.upstreamRole,
      `${pointer}/upstreamRole`,
      collector,
    );
    const localRoles = parseRemoteLocalRoles(object.localRoles, `${pointer}/localRoles`, collector);
    if (
      issuer === undefined ||
      tenant === undefined ||
      upstreamRole === undefined ||
      localRoles === undefined
    ) {
      return;
    }
    const inputKey = canonicalSerialize(canonicalValue([issuer, tenant, upstreamRole]));
    const priorPointer = inputPointers.get(inputKey);
    if (priorPointer !== undefined) {
      addDiagnostic(
        collector,
        "duplicate-key",
        `${pointer}/upstreamRole`,
        `Remote role mapping input is already declared at ${priorPointer}`,
      );
      return;
    }
    inputPointers.set(inputKey, `${pointer}/upstreamRole`);
    mappings.push({ pointer, issuer, tenant, upstreamRole, localRoles });
  });
  return Object.freeze(mappings.sort(compareRemoteRoleMappings));
}

function parseRemoteLocalRoles(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    addDiagnostic(
      collector,
      "invalid-field",
      pointer,
      `localRoles must contain between 1 and ${MAX_LIST_ITEMS} role references`,
    );
    return undefined;
  }
  const roles: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const role = parseReference(item, `${pointer}/${index}`, collector);
    if (role === undefined) return;
    if (seen.has(role)) {
      addDiagnostic(
        collector,
        "duplicate-key",
        `${pointer}/${index}`,
        `localRoles duplicates ${role}`,
      );
    } else {
      roles.push(role);
      seen.add(role);
    }
  });
  return Object.freeze(roles);
}

function parseRemoteSynchronization(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): RemotePolicy["synchronization"] | undefined {
  const pointer = "/remote/synchronization";
  const fields = [
    "classificationCeiling",
    "receiptChain",
    "events",
    "projections",
    "synchronizationState",
  ];
  const object = exactObject(value, pointer, fields, [], collector);
  if (object === undefined) return undefined;
  if (fields.some((field) => !Object.hasOwn(object, field))) return undefined;
  const classificationCeiling = object.classificationCeiling;
  if (classificationCeiling !== "public" && classificationCeiling !== "internal") {
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/classificationCeiling`,
      "classificationCeiling must be public or internal",
    );
  }
  const toggles = ["receiptChain", "events", "projections", "synchronizationState"] as const;
  for (const toggle of toggles) {
    if (typeof object[toggle] !== "boolean") {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/${toggle}`,
        `${toggle} must be a boolean`,
      );
    }
  }
  const requiresSynchronizationState = toggles
    .filter((toggle) => toggle !== "synchronizationState")
    .some((toggle) => object[toggle] === true);
  if (requiresSynchronizationState && object.synchronizationState !== true) {
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/synchronizationState`,
      "synchronizationState must be enabled when another synchronization stream is enabled",
    );
  }
  if (
    (classificationCeiling !== "public" && classificationCeiling !== "internal") ||
    toggles.some((toggle) => typeof object[toggle] !== "boolean") ||
    (requiresSynchronizationState && object.synchronizationState !== true)
  ) {
    return undefined;
  }
  return {
    classificationCeiling:
      classificationCeiling as RemotePolicy["synchronization"]["classificationCeiling"],
    receiptChain: object.receiptChain as boolean,
    events: object.events as boolean,
    projections: object.projections as boolean,
    synchronizationState: object.synchronizationState as boolean,
  };
}

function compareRemoteRoleMappings(
  left: RemotePolicy["roleMappings"][number],
  right: RemotePolicy["roleMappings"][number],
): number {
  return (
    compareText(left.issuer, right.issuer) ||
    compareText(left.tenant, right.tenant) ||
    compareText(left.upstreamRole, right.upstreamRole)
  );
}

function isFullLocalBranchRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.length > 1_024 || value.includes("..")) {
    return false;
  }
  if (
    value.includes("@{") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code === 0x7f;
    })
  ) {
    return false;
  }
  if (["~", "^", ":", "?", "*", "[", "\\"].some((character) => value.includes(character))) {
    return false;
  }
  const components = value.slice("refs/heads/".length).split("/");
  return components.every(
    (component) =>
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      !component.startsWith(".") &&
      !component.endsWith(".") &&
      !component.endsWith(".lock"),
  );
}

function parseWorkflow(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): ParsedWorkflowDeclaration | undefined {
  const object = exactObject(value, "/workflow", ["key", "generation", "input"], [], collector);
  if (object === undefined) return undefined;
  const key = parseKey(object.key, "/workflow/key", collector);
  const generation = parseGeneration(object.generation, "/workflow/generation", collector);
  const input = exactObject(object.input, "/workflow/input", ["schema"], [], collector);
  const inputSchema =
    input === undefined
      ? undefined
      : parseReference(input.schema, "/workflow/input/schema", collector);
  return key === undefined || generation === undefined || inputSchema === undefined
    ? undefined
    : { key, generation, inputSchema };
}

function parseSchemas(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedSchemaDeclaration[] | undefined {
  return parseArray(value, "/schemas", collector, (item, pointer) => {
    if (isRecord(item) && Object.hasOwn(item, "schema")) {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/schema`,
        "Inline schema bodies are not supported in v1; use path",
      );
    }
    const object = exactObject(item, pointer, ["key", "path"], [], collector);
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const path = parseResourcePath(object.path, "schema", `${pointer}/path`, collector);
    return key === undefined || path === undefined ? undefined : { pointer, key, path };
  });
}

function parsePrompts(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedPromptDeclaration[] | undefined {
  if (value === undefined) {
    addDiagnostic(
      collector,
      "missing-prompt-resources",
      "/prompts",
      "v1 requires the prompts resource array",
    );
    return undefined;
  }
  return parseArray(value, "/prompts", collector, (item, pointer) => {
    const object = exactObject(item, pointer, ["key", "path", "inputPaths"], [], collector);
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const path = parseResourcePath(object.path, "prompt", `${pointer}/path`, collector);
    let inputPaths: readonly string[] | undefined;
    if (
      !Array.isArray(object.inputPaths) ||
      object.inputPaths.some((path) => typeof path !== "string")
    ) {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/inputPaths`,
        "Prompt inputPaths must be an array of canonical JSON Pointers",
      );
    } else {
      try {
        inputPaths = canonicalPromptInputPaths(object.inputPaths as readonly string[]);
      } catch (error) {
        addDiagnostic(
          collector,
          "invalid-field",
          `${pointer}/inputPaths`,
          error instanceof Error ? error.message : "Prompt inputPaths are invalid",
        );
      }
    }
    return key === undefined || path === undefined || inputPaths === undefined
      ? undefined
      : { pointer, key, path, inputPaths };
  });
}

function parseResourcePath(
  value: CanonicalValue | undefined,
  kind: "prompt" | "schema",
  pointer: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (typeof value !== "string") {
    addDiagnostic(
      collector,
      "missing-resource-path",
      pointer,
      "External resource declarations require path",
    );
    return undefined;
  }
  try {
    return validateConfigurationResourcePath(kind, value);
  } catch (error) {
    addDiagnostic(
      collector,
      "invalid-resource-path",
      pointer,
      error instanceof Error ? error.message : "External resource path is invalid",
    );
    return undefined;
  }
}

async function resolveConfigurationResources(
  parsed: ParsedWorkflow,
  reader: WorkflowConfigurationCompilationInput["resources"],
  collector: DiagnosticCollector,
  sha256: Sha256,
): Promise<ResolvedWorkflow | undefined> {
  let invalidCount = false;
  if (parsed.prompts.length > CONFIGURATION_RESOURCE_LIMITS.maxPromptResources) {
    invalidCount = true;
    addDiagnostic(
      collector,
      "resource-set-too-large",
      "/prompts",
      `Prompt resources cannot exceed ${CONFIGURATION_RESOURCE_LIMITS.maxPromptResources} entries`,
    );
  }
  if (parsed.schemas.length > CONFIGURATION_RESOURCE_LIMITS.maxSchemaResources) {
    invalidCount = true;
    addDiagnostic(
      collector,
      "resource-set-too-large",
      "/schemas",
      `Schema resources cannot exceed ${CONFIGURATION_RESOURCE_LIMITS.maxSchemaResources} entries`,
    );
  }
  reportDuplicateKeys(parsed.prompts, collector);
  reportDuplicateKeys(parsed.schemas, collector);
  const pathPointers = new Map<string, string>();
  const duplicatedPaths = new Set<string>();
  for (const declaration of [...parsed.prompts, ...parsed.schemas]) {
    const comparisonPath = declaration.path.toLowerCase();
    const prior = pathPointers.get(comparisonPath);
    if (prior === undefined) {
      pathPointers.set(comparisonPath, `${declaration.pointer}/path`);
    } else {
      duplicatedPaths.add(comparisonPath);
      addDiagnostic(
        collector,
        "invalid-resource-path",
        `${declaration.pointer}/path`,
        `Resource path ${declaration.path} is already declared at ${prior}`,
      );
    }
  }
  if (invalidCount) return undefined;

  const prompts: ResolvedPrompt[] = [];
  const schemas: ResolvedSchema[] = [];
  let aggregateBytes = 0;
  const declarations = [
    ...parsed.prompts.map((declaration) => ({ kind: "prompt" as const, declaration })),
    ...parsed.schemas.map((declaration) => ({ kind: "schema" as const, declaration })),
  ].sort(
    (left, right) =>
      compareText(left.kind, right.kind) ||
      compareText(left.declaration.key, right.declaration.key),
  );
  for (const { kind, declaration } of declarations) {
    if (duplicatedPaths.has(declaration.path.toLowerCase())) continue;
    try {
      const source = await readConfigurationTextResource(reader, kind, declaration.path, sha256);
      aggregateBytes += source.byteLength;
      if (aggregateBytes > CONFIGURATION_RESOURCE_LIMITS.maxAggregateBytes) {
        addDiagnostic(
          collector,
          "resource-set-too-large",
          kind === "prompt" ? "/prompts" : "/schemas",
          `Configuration resources exceed ${CONFIGURATION_RESOURCE_LIMITS.maxAggregateBytes} bytes`,
        );
        break;
      }
      if (kind === "prompt") {
        const promptDeclaration = declaration as ParsedPromptDeclaration;
        const template = parsePromptTemplate(source.utf8);
        for (const inputPath of template.inputPaths) {
          if (!promptDeclaration.inputPaths.includes(inputPath)) {
            addDiagnostic(
              collector,
              "undeclared-prompt-input",
              `${promptDeclaration.pointer}/inputPaths`,
              `Prompt template uses undeclared input path ${inputPath}`,
            );
          }
        }
        promptDeclaration.inputPaths.forEach((inputPath, index) => {
          if (!template.inputPaths.includes(inputPath)) {
            addDiagnostic(
              collector,
              "unused-prompt-input",
              `${promptDeclaration.pointer}/inputPaths/${index}`,
              `Declared prompt input path ${inputPath} is absent from the template`,
            );
          }
        });
        const content = canonicalValue({
          key: promptDeclaration.key,
          source,
          inputPaths: promptDeclaration.inputPaths,
        });
        prompts.push({
          ...promptDeclaration,
          source,
          digest: canonicalDigest(content, sha256),
        } as ResolvedPrompt);
      } else {
        const schemaDeclaration = declaration as ParsedSchemaDeclaration;
        const schema = parseStrictJsonResource(source.utf8).value;
        const schemaDigest = canonicalDigest(schema, sha256);
        const content = canonicalValue({
          key: schemaDeclaration.key,
          source,
          schema,
          schemaDigest,
        });
        schemas.push({
          ...schemaDeclaration,
          source,
          schema,
          schemaDigest,
          digest: canonicalDigest(content, sha256),
        } as ResolvedSchema);
      }
    } catch (error) {
      const pointer = `${declaration.pointer}/path`;
      if (error instanceof PromptTemplateError) {
        addDiagnostic(collector, "invalid-prompt-template", pointer, error.message);
      } else if (error instanceof ConfigurationResourceValidationError) {
        addDiagnostic(collector, error.code, pointer, error.message);
      } else {
        addDiagnostic(
          collector,
          "resource-read-failed",
          pointer,
          `${kind} resource could not be read`,
        );
      }
    }
  }
  if (collector.diagnostics.length > 0) return undefined;
  return { ...parsed, prompts: Object.freeze(prompts), schemas: Object.freeze(schemas) };
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
      ["prompt", "modelPolicy", "sessionScope", "sessionMaxTurns"],
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
    const prompt = Object.hasOwn(object, "prompt")
      ? parseReference(object.prompt, `${pointer}/prompt`, collector)
      : undefined;
    let sessionScope: ParsedRole["sessionScope"];
    if (Object.hasOwn(object, "sessionScope")) {
      if (
        object.sessionScope === "attempt" ||
        object.sessionScope === "phase" ||
        object.sessionScope === "run"
      ) {
        sessionScope = object.sessionScope as ParsedRole["sessionScope"];
      } else {
        addDiagnostic(
          collector,
          "invalid-role",
          `${pointer}/sessionScope`,
          "Role sessionScope must be attempt, phase, or run",
        );
      }
      if (kind !== "agent" && sessionScope !== undefined) {
        addDiagnostic(
          collector,
          "invalid-role",
          `${pointer}/sessionScope`,
          "Only agent roles hold a session",
        );
      }
    }
    let sessionMaxTurns: number | undefined;
    if (Object.hasOwn(object, "sessionMaxTurns")) {
      if (
        typeof object.sessionMaxTurns === "number" &&
        Number.isSafeInteger(object.sessionMaxTurns) &&
        object.sessionMaxTurns > 0
      ) {
        sessionMaxTurns = object.sessionMaxTurns;
      } else {
        addDiagnostic(
          collector,
          "invalid-role",
          `${pointer}/sessionMaxTurns`,
          "Role sessionMaxTurns must be a positive whole number of turns",
        );
      }
    }
    if (key === undefined || kind === undefined || capabilities === undefined) return undefined;
    return {
      pointer,
      key,
      kind,
      capabilities,
      ...(prompt === undefined ? {} : { prompt }),
      ...(modelPolicy === undefined ? {} : { modelPolicy }),
      ...(sessionScope === undefined ? {} : { sessionScope }),
      ...(sessionMaxTurns === undefined ? {} : { sessionMaxTurns }),
    };
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
    : {
        provider,
        model,
        maxTurns,
        maxSubmissions,
        maxMillidollars,
      };
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
    const attemptCount = maxAttempts + maxReconciliationAttempts;
    const bytesPerAttempt = maxStdoutBytes + maxStderrBytes;
    if (bytesPerAttempt > Math.floor(MAX_SENSOR_AGGREGATE_OUTPUT_BYTES / attemptCount)) {
      addDiagnostic(
        collector,
        "invalid-field",
        pointer,
        `Sensor aggregate retry output must not exceed ${MAX_SENSOR_AGGREGATE_OUTPUT_BYTES} bytes`,
      );
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

function parseCompletionEvidenceViews(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedCompletionEvidenceView[] | undefined {
  return parseArray(value, "/completionEvidenceViews", collector, (item, pointer) => {
    const object = exactObject(item, pointer, ["key", "phase", "evidenceKinds"], [], collector);
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const phase = parseReference(object.phase, `${pointer}/phase`, collector);
    const evidenceKinds = Array.isArray(object.evidenceKinds)
      ? object.evidenceKinds.map((kind) => canonicalValue(kind))
      : undefined;
    if (evidenceKinds === undefined || evidenceKinds.length === 0) {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/evidenceKinds`,
        "Evidence views require at least one allowlisted evidence kind",
      );
    }
    return key === undefined ||
      phase === undefined ||
      evidenceKinds === undefined ||
      evidenceKinds.length === 0
      ? undefined
      : { pointer, key, phase, evidenceKinds };
  });
}

function parsePhases(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedPhase[] | undefined {
  return parseArray(value, "/phases", collector, (item, pointer) =>
    parsePhase(item, pointer, collector),
  );
}

function parsePhase(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedPhase | undefined {
  const object = exactObject(
    value,
    pointer,
    ["key", "generation", "input", "executor", "outputs", "iteration", "exit", "actions"],
    ["dependsOn"],
    collector,
  );
  if (object === undefined) return undefined;
  const key = parseKey(object.key, `${pointer}/key`, collector);
  const generation = parseGeneration(object.generation, `${pointer}/generation`, collector);
  const dependsOn = parseStringArray(object.dependsOn, `${pointer}/dependsOn`, collector);
  const input = parsePhaseInput(object.input, `${pointer}/input`, collector);
  const executor = parsePhaseExecutor(object.executor, `${pointer}/executor`, collector);
  const outputs = parsePhaseOutputs(object.outputs, `${pointer}/outputs`, collector);
  const iteration = parsePhaseIteration(object.iteration, `${pointer}/iteration`, collector);
  const exit = parsePhaseExit(object.exit, `${pointer}/exit`, collector);
  const actions = parseArray(
    object.actions,
    `${pointer}/actions`,
    collector,
    (action, actionPointer) => parsePhaseAction(action, actionPointer, collector),
  );
  const work =
    executor?.kind === "task-set"
      ? executor.work
      : executor?.kind === "agent" && key !== undefined && generation !== undefined
        ? Object.freeze([
            {
              pointer: `${pointer}/executor`,
              key: "phase-executor",
              title: key,
              generation,
              role: executor.role,
              budgets: executor.budgets,
              dependsOn: Object.freeze([]),
              inputSchema: input?.schema,
              input: canonicalValue({ kind: "phase-executor", phase: key }),
              completionPolicy: executor.completionPolicy,
              reservedExecutor: true,
            } as ParsedWork,
          ])
        : Object.freeze([]);
  return key === undefined ||
    generation === undefined ||
    dependsOn === undefined ||
    input === undefined ||
    executor === undefined ||
    outputs === undefined ||
    iteration === undefined ||
    exit === undefined ||
    actions === undefined
    ? undefined
    : {
        pointer,
        key,
        generation,
        dependsOn,
        input,
        executor,
        outputs,
        iteration,
        exit,
        actions,
        work,
      };
}

function parsePhaseAction(
  value: CanonicalValue,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedPhaseAction | undefined {
  const object = exactObject(value, pointer, ["kind", "forEach"], [], collector);
  if (object === undefined) return undefined;
  if (object.kind !== "import-plan") {
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/kind`,
      "Phase action must be import-plan",
    );
    return undefined;
  }
  const forEach = parseReference(
    Reflect.get(object, "forEach") as CanonicalValue,
    `${pointer}/forEach`,
    collector,
  );
  return forEach === undefined ? undefined : { kind: "import-plan", forEach };
}

function parsePhaseInput(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedPhaseInput | undefined {
  const object = exactObject(value, pointer, ["schema", "mappings"], [], collector);
  if (object === undefined) return undefined;
  const schema = parseReference(object.schema, `${pointer}/schema`, collector);
  const mappings = parseArray(
    object.mappings,
    `${pointer}/mappings`,
    collector,
    (item, itemPointer) => parseDataMapping(item, itemPointer, collector),
  );
  return schema === undefined || mappings === undefined ? undefined : { schema, mappings };
}

function parseDataMapping(
  value: CanonicalValue,
  pointer: string,
  collector: DiagnosticCollector,
): DataMappingDeclaration | undefined {
  const object = exactObject(
    value,
    pointer,
    ["key", "source", "destinationPointer"],
    [],
    collector,
  );
  if (object === undefined) return undefined;
  const key = parseKey(object.key, `${pointer}/key`, collector);
  const destinationPointer =
    typeof object.destinationPointer === "string" ? object.destinationPointer : undefined;
  if (destinationPointer === undefined) {
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/destinationPointer`,
      "Mapping destinationPointer must be an RFC 6901 JSON Pointer",
    );
  }
  const source = parseMappingSource(object.source, `${pointer}/source`, collector);
  return key === undefined || destinationPointer === undefined || source === undefined
    ? undefined
    : { key: consumerKey(key), source, destinationPointer };
}

function parseMappingSource(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): DataMappingDeclaration["source"] | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    addDiagnostic(
      collector,
      "invalid-field",
      pointer,
      "Mapping source must be an object with a supported kind",
    );
    return undefined;
  }
  const required =
    value.kind === "phase-output"
      ? ["kind", "phase", "output", "pointer"]
      : value.kind === "completion-evidence"
        ? ["kind", "phase", "view", "pointer"]
        : ["kind", "pointer"];
  const object = exactObject(value, pointer, required, [], collector);
  if (object === undefined) return undefined;
  if (typeof object.pointer !== "string") {
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/pointer`,
      "Mapping source pointer must be an RFC 6901 JSON Pointer",
    );
    return undefined;
  }
  if (object.kind === "workflow-input" || object.kind === "current-item") {
    return {
      kind: object.kind as "workflow-input" | "current-item",
      pointer: object.pointer,
    };
  }
  if (object.kind === "phase-output") {
    const phase = parseReference(object.phase, `${pointer}/phase`, collector);
    const output = parseReference(object.output, `${pointer}/output`, collector);
    return phase === undefined || output === undefined
      ? undefined
      : {
          kind: "phase-output",
          phase: consumerKey(phase),
          output: consumerKey(output),
          pointer: object.pointer,
        };
  }
  if (object.kind === "completion-evidence") {
    const phase = parseReference(object.phase, `${pointer}/phase`, collector);
    const view = parseReference(object.view, `${pointer}/view`, collector);
    return phase === undefined || view === undefined
      ? undefined
      : {
          kind: "completion-evidence",
          phase: consumerKey(phase),
          view: consumerKey(view),
          pointer: object.pointer,
        };
  }
  addDiagnostic(
    collector,
    "invalid-field",
    `${pointer}/kind`,
    "Mapping source kind is not supported",
  );
  return undefined;
}

function parsePhaseExecutor(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedPhaseExecutor | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    addDiagnostic(
      collector,
      "invalid-field",
      pointer,
      "Phase executor must be an exact agent or task-set object",
    );
    return undefined;
  }
  if (value.kind === "task-set") {
    const object = exactObject(value, pointer, ["kind", "work"], [], collector);
    const work =
      object === undefined
        ? undefined
        : parseArray(object.work, `${pointer}/work`, collector, (item, itemPointer) =>
            parseWork(item, itemPointer, collector),
          );
    return work === undefined ? undefined : { kind: "task-set", work };
  }
  if (value.kind === "task-frontier") {
    const object = exactObject(value, pointer, ["kind", "forEach", "template"], [], collector);
    if (object === undefined) return undefined;
    const forEach = parseReference(
      Reflect.get(object, "forEach") as CanonicalValue,
      `${pointer}/forEach`,
      collector,
    );
    const template = parseReference(object.template, `${pointer}/template`, collector);
    return forEach === undefined || template === undefined
      ? undefined
      : { kind: "task-frontier", forEach, template };
  }
  if (value.kind === "agent") {
    const object = exactObject(
      value,
      pointer,
      ["kind", "role", "budgets", "completionPolicy", "resumeAcrossAttempts"],
      [],
      collector,
    );
    if (object === undefined) return undefined;
    const role = parseReference(object.role, `${pointer}/role`, collector);
    const budgets = parseBudgets(object.budgets, `${pointer}/budgets`, collector);
    const completionPolicy = parseCompletionPolicy(
      object.completionPolicy,
      `${pointer}/completionPolicy`,
      collector,
    );
    if (typeof object.resumeAcrossAttempts !== "boolean") {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/resumeAcrossAttempts`,
        "resumeAcrossAttempts must be a boolean",
      );
    }
    return role === undefined ||
      budgets === undefined ||
      completionPolicy === undefined ||
      typeof object.resumeAcrossAttempts !== "boolean"
      ? undefined
      : {
          kind: "agent",
          role,
          budgets,
          completionPolicy,
          resumeAcrossAttempts: object.resumeAcrossAttempts,
        };
  }
  addDiagnostic(
    collector,
    "invalid-field",
    `${pointer}/kind`,
    "Phase executor kind must be agent, task-set, or task-frontier",
  );
  return undefined;
}

function parsePhaseOutputs(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): readonly ParsedPhaseOutput[] | undefined {
  return parseArray(value, pointer, collector, (item, itemPointer) => {
    const object = exactObject(
      item,
      itemPointer,
      ["key", "schema", "path", "maxBytes"],
      [],
      collector,
    );
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${itemPointer}/key`, collector);
    const schema = parseReference(object.schema, `${itemPointer}/schema`, collector);
    const maxBytes = parseBoundedPositiveInteger(
      object.maxBytes,
      `${itemPointer}/maxBytes`,
      16 * 1024 * 1024,
      collector,
    );
    const path =
      typeof object.path === "string" && isSafeOutputPath(object.path) ? object.path : undefined;
    if (path === undefined)
      addDiagnostic(
        collector,
        "invalid-field",
        `${itemPointer}/path`,
        "Output path must be a normalized relative .json path",
      );
    return key === undefined || schema === undefined || maxBytes === undefined || path === undefined
      ? undefined
      : { key, schema, path, maxBytes };
  });
}

function isSafeOutputPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    !value.endsWith(".json") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("%") ||
    value.includes(":") ||
    !/^[\x20-\x7e]+$/u.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function parsePhaseIteration(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedPhaseIteration | undefined {
  const object = exactObject(
    value,
    pointer,
    ["maximumAttempts", "onGateRejected", "onApprovalRejected", "onExhausted"],
    ["onUpstreamChanged"],
    collector,
  );
  if (object === undefined) return undefined;
  const maximumAttempts = parseBoundedPositiveInteger(
    object.maximumAttempts,
    `${pointer}/maximumAttempts`,
    10_000,
    collector,
  );
  const onGateRejected =
    object.onGateRejected === "iterate" || object.onGateRejected === "fail"
      ? object.onGateRejected
      : undefined;
  const onApprovalRejected =
    object.onApprovalRejected === "iterate" || object.onApprovalRejected === "fail"
      ? object.onApprovalRejected
      : undefined;
  const onUpstreamChanged = Object.hasOwn(object, "onUpstreamChanged")
    ? object.onUpstreamChanged === "iterate" || object.onUpstreamChanged === "fail"
      ? object.onUpstreamChanged
      : undefined
    : "fail";
  const onExhausted =
    object.onExhausted === "escalate" || object.onExhausted === "fail"
      ? object.onExhausted
      : undefined;
  if (onGateRejected === undefined)
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/onGateRejected`,
      "onGateRejected must be iterate or fail",
    );
  if (onApprovalRejected === undefined)
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/onApprovalRejected`,
      "onApprovalRejected must be iterate or fail",
    );
  if (onUpstreamChanged === undefined)
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/onUpstreamChanged`,
      "onUpstreamChanged must be iterate or fail",
    );
  if (onExhausted === undefined)
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/onExhausted`,
      "onExhausted must be escalate or fail",
    );
  return maximumAttempts === undefined ||
    onGateRejected === undefined ||
    onApprovalRejected === undefined ||
    onUpstreamChanged === undefined ||
    onExhausted === undefined
    ? undefined
    : {
        maximumAttempts,
        onGateRejected: onGateRejected as "iterate" | "fail",
        onApprovalRejected: onApprovalRejected as "iterate" | "fail",
        onUpstreamChanged: onUpstreamChanged as "iterate" | "fail",
        onExhausted: onExhausted as "escalate" | "fail",
      };
}

function parsePhaseExit(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedPhaseExit | undefined {
  const object = exactObject(value, pointer, ["requiredOutputs", "approval"], ["gate"], collector);
  if (object === undefined) return undefined;
  const requiredOutputs = parseUniqueStrings(
    object.requiredOutputs,
    `${pointer}/requiredOutputs`,
    collector,
    "Required outputs",
  );
  const gate = Object.hasOwn(object, "gate")
    ? parseReference(object.gate, `${pointer}/gate`, collector)
    : undefined;
  const approvalObject = isRecord(object.approval)
    ? exactObject(
        object.approval,
        `${pointer}/approval`,
        ["policy"],
        object.approval.policy === "required" ? ["authority", "scope"] : [],
        collector,
      )
    : undefined;
  let approval: ParsedPhaseExit["approval"] | undefined;
  if (approvalObject?.policy === "none") approval = { policy: "none" };
  if (approvalObject?.policy === "required" && Object.hasOwn(approvalObject, "authority")) {
    // A phase that names no scope keeps approval's original meaning, so no
    // authored workflow changes behaviour by being read again.
    const declared = approvalObject.scope === undefined ? undefined : String(approvalObject.scope);
    if (declared !== undefined && declared !== "phase" && declared !== "member") {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/approval/scope`,
        "Approval scope must be phase or member",
      );
      return undefined;
    }
    approval = {
      policy: "required",
      authority: approvalObject.authority as CanonicalValue,
      ...(declared === undefined ? {} : { scope: declared }),
    };
  }
  if (approval === undefined)
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/approval`,
      "Approval must declare none or a required authority",
    );
  if (requiredOutputs === undefined || approval === undefined) return undefined;
  const common = { requiredOutputs, approval };
  return gate === undefined ? common : { ...common, gate };
}

function parseForEachRegistry(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedForEach[] | undefined {
  return parseArray(value, "/forEach", collector, (item, pointer) => {
    const object = exactObject(
      item,
      pointer,
      ["key", "source", "pointer", "collectionSchema", "itemSchema", "identityPointer", "limits"],
      [],
      collector,
    );
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const source = parseForEachSource(object.source, `${pointer}/source`, collector);
    const collectionPointer = parsePointerField(object.pointer, `${pointer}/pointer`, collector);
    const collectionSchema = parseReference(
      object.collectionSchema,
      `${pointer}/collectionSchema`,
      collector,
    );
    const itemSchema = parseReference(object.itemSchema, `${pointer}/itemSchema`, collector);
    const identityPointer = parsePointerField(
      object.identityPointer,
      `${pointer}/identityPointer`,
      collector,
    );
    const limits = parseForEachLimits(object.limits, `${pointer}/limits`, collector);
    return key === undefined ||
      source === undefined ||
      collectionPointer === undefined ||
      collectionSchema === undefined ||
      itemSchema === undefined ||
      identityPointer === undefined ||
      limits === undefined
      ? undefined
      : {
          pointer,
          key,
          source,
          collectionPointer,
          collectionSchema,
          itemSchema,
          identityPointer,
          limits,
        };
  });
}

function parseForEachSource(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedForEach["source"] | undefined {
  if (!isRecord(value) || (value.kind !== "phase-output" && value.kind !== "phase-input")) {
    addDiagnostic(
      collector,
      "invalid-field",
      pointer,
      "forEach source must be phase-output or phase-input",
    );
    return undefined;
  }
  const object = exactObject(
    value,
    pointer,
    value.kind === "phase-output" ? ["kind", "phase", "output"] : ["kind", "phase"],
    [],
    collector,
  );
  if (object === undefined) return undefined;
  const phase = parseReference(object.phase, `${pointer}/phase`, collector);
  if (phase === undefined) return undefined;
  if (object.kind === "phase-input") return { kind: "phase-input", phase };
  const output = parseReference(object.output, `${pointer}/output`, collector);
  return output === undefined ? undefined : { kind: "phase-output", phase, output };
}

function parseForEachLimits(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedForEach["limits"] | undefined {
  const object = exactObject(
    value,
    pointer,
    ["maxSelectedItems", "maxTotalTasks", "maxConcurrency", "exhaustion"],
    [],
    collector,
  );
  if (object === undefined) return undefined;
  const maxSelectedItems = parseBoundedPositiveInteger(
    object.maxSelectedItems,
    `${pointer}/maxSelectedItems`,
    256,
    collector,
  );
  const maxTotalTasks = parseBoundedPositiveInteger(
    object.maxTotalTasks,
    `${pointer}/maxTotalTasks`,
    1024,
    collector,
  );
  const maxConcurrency = parseBoundedPositiveInteger(
    object.maxConcurrency,
    `${pointer}/maxConcurrency`,
    32,
    collector,
  );
  const exhaustion =
    object.exhaustion === "escalate" || object.exhaustion === "fail"
      ? object.exhaustion
      : undefined;
  if (exhaustion === undefined) {
    addDiagnostic(
      collector,
      "invalid-field",
      `${pointer}/exhaustion`,
      "Fan-out exhaustion must escalate or fail",
    );
  }
  return maxSelectedItems === undefined ||
    maxTotalTasks === undefined ||
    maxConcurrency === undefined ||
    exhaustion === undefined
    ? undefined
    : {
        maxSelectedItems,
        maxTotalTasks,
        maxConcurrency,
        exhaustion: exhaustion as "escalate" | "fail",
      };
}

function parseTaskTemplateRegistry(
  value: CanonicalValue | undefined,
  collector: DiagnosticCollector,
): readonly ParsedTaskTemplate[] | undefined {
  return parseArray(value, "/taskTemplates", collector, (item, pointer) => {
    const object = exactObject(
      item,
      pointer,
      [
        "key",
        "generation",
        "role",
        "budgets",
        "inputSchema",
        "inputMappings",
        "repositoryChanges",
        "completionPolicy",
      ],
      ["dependencyIdentityPointer"],
      collector,
    );
    if (object === undefined) return undefined;
    const key = parseKey(object.key, `${pointer}/key`, collector);
    const generation = parseGeneration(object.generation, `${pointer}/generation`, collector);
    const role = parseReference(object.role, `${pointer}/role`, collector);
    const budgets = parseBudgets(object.budgets, `${pointer}/budgets`, collector);
    const inputSchema = parseReference(object.inputSchema, `${pointer}/inputSchema`, collector);
    const inputMappings = parseArray(
      object.inputMappings,
      `${pointer}/inputMappings`,
      collector,
      (mapping, mappingPointer) => parseDataMapping(mapping, mappingPointer, collector),
    );
    const dependencyIdentityPointer = Object.hasOwn(object, "dependencyIdentityPointer")
      ? parsePointerField(
          object.dependencyIdentityPointer,
          `${pointer}/dependencyIdentityPointer`,
          collector,
        )
      : undefined;
    const repositoryChanges = ["required", "allowed", "forbidden"].includes(
      String(object.repositoryChanges),
    )
      ? (object.repositoryChanges as ParsedTaskTemplate["repositoryChanges"])
      : undefined;
    if (repositoryChanges === undefined) {
      addDiagnostic(
        collector,
        "invalid-field",
        `${pointer}/repositoryChanges`,
        "repositoryChanges must be required, allowed, or forbidden",
      );
    }
    const completionPolicy = parseCompletionPolicy(
      object.completionPolicy,
      `${pointer}/completionPolicy`,
      collector,
    );
    return key === undefined ||
      generation === undefined ||
      role === undefined ||
      budgets === undefined ||
      inputSchema === undefined ||
      inputMappings === undefined ||
      repositoryChanges === undefined ||
      completionPolicy === undefined
      ? undefined
      : {
          pointer,
          key,
          generation,
          role,
          budgets,
          inputSchema,
          inputMappings,
          ...(dependencyIdentityPointer === undefined ? {} : { dependencyIdentityPointer }),
          repositoryChanges,
          completionPolicy,
        };
  });
}

function parsePointerField(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (typeof value !== "string") {
    addDiagnostic(collector, "invalid-field", pointer, "Value must be an RFC 6901 JSON Pointer");
    return undefined;
  }
  return value;
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
  const object = exactObject(
    value,
    pointer,
    ["criteria", "completionEvidencePolicy"],
    [],
    collector,
  );
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
  const completionEvidencePolicy = parseCompletionEvidencePolicy(
    object.completionEvidencePolicy,
    `${pointer}/completionEvidencePolicy`,
    collector,
  );
  return criteria === undefined || completionEvidencePolicy === undefined
    ? undefined
    : { criteria, completionEvidencePolicy };
}

function parseCompletionEvidencePolicy(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): ParsedCompletionEvidencePolicy | undefined {
  const object = exactObject(
    value,
    pointer,
    ["mode", "requirements"],
    ["waiverAuthority"],
    collector,
  );
  if (object === undefined) return undefined;
  let mode: ParsedCompletionEvidencePolicy["mode"] | undefined;
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
  parsed: ResolvedWorkflow,
  collector: DiagnosticCollector,
  sha256: Sha256,
): ValidatedRegistries {
  for (const registry of [
    parsed.prompts,
    parsed.schemas,
    parsed.roles,
    parsed.modelPolicies,
    parsed.sensors,
    parsed.gates,
    parsed.completionEvidenceViews,
  ]) {
    reportDuplicateKeys(registry, collector);
  }

  const schemaIds = new Map<string, string>();
  const externalSchemas = parsed.schemas.flatMap((schema) => {
    if (!isRecord(schema.schema) || typeof schema.schema.$id !== "string") return [];
    const id = normalizeSchemaResourceId(schema.schema.$id);
    return id === undefined ? [] : [{ key: schema.key, id, schema: schema.schema }];
  });
  for (const schema of parsed.schemas) {
    const analysis = analyzeSchemaDefinition(
      schema.schema,
      `${schema.pointer}/path`,
      externalSchemas
        .filter(({ key }) => key !== schema.key)
        .map(({ id, schema: external }) => ({ id, schema: external })),
    );
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

  const roleKeys = new Set(parsed.roles.map(({ key }) => key));
  for (const mapping of parsed.remote?.roleMappings ?? []) {
    mapping.localRoles.forEach((role, index) => {
      if (!roleKeys.has(role)) {
        addDiagnostic(
          collector,
          "unknown-reference",
          `${mapping.pointer}/localRoles/${index}`,
          `Local role ${role} is not declared`,
        );
      }
    });
  }

  const policyKeys = new Set(parsed.modelPolicies.map(({ key }) => key));
  const promptKeys = new Set<string>(parsed.prompts.map(({ key }) => key));
  for (const role of parsed.roles) {
    if (role.kind === "agent" && role.modelPolicy === undefined) {
      addDiagnostic(
        collector,
        "invalid-role",
        role.pointer,
        "Agent roles require a modelPolicy reference",
      );
    }
    if (role.kind === "agent" && role.prompt === undefined) {
      addDiagnostic(
        collector,
        "missing-agent-prompt",
        `${role.pointer}/prompt`,
        "Agent roles require one prompt resource reference",
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
    if (role.kind !== "agent" && role.prompt !== undefined) {
      addDiagnostic(
        collector,
        "forbidden-role-prompt",
        `${role.pointer}/prompt`,
        `${role.kind} roles cannot carry prompt execution policy`,
      );
    }
    if (role.prompt !== undefined && !promptKeys.has(role.prompt)) {
      addDiagnostic(
        collector,
        "unknown-prompt-reference",
        `${role.pointer}/prompt`,
        `Prompt resource ${role.prompt} is not declared`,
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
  validatePhaseDataflowSemantics(parsed, collector);
  validateFanOutSemantics(parsed, collector);

  return {
    prompts: Object.freeze(parsed.prompts.map(stripResolvedPrompt).sort(byKey)),
    schemas: Object.freeze(parsed.schemas.map(stripResolvedSchema).sort(byKey)),
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
    completionEvidenceViews: registryEntries(
      parsed.completionEvidenceViews.map(({ pointer: _pointer, ...view }) => ({
        key: view.key,
        value: {
          ...view,
          evidenceKinds: [...view.evidenceKinds].sort((left, right) =>
            compareText(canonicalSerialize(left), canonicalSerialize(right)),
          ),
        },
      })),
      sha256,
    ),
    phaseDataflow: registryEntries(
      parsed.phases.map((phase) => ({
        key: phase.key,
        value: normalizedPhaseDataflow(phase),
      })),
      sha256,
    ),
    forEach: registryEntries(
      parsed.forEach.map(({ pointer: _pointer, collectionPointer, ...definition }) => ({
        key: definition.key,
        value: { ...definition, pointer: collectionPointer },
      })),
      sha256,
    ),
    taskTemplates: registryEntries(
      parsed.taskTemplates.map(({ pointer: _pointer, ...template }) => ({
        key: template.key,
        value: template,
      })),
      sha256,
    ),
    gateKeysByPhase,
  };
}

function validateFanOutSemantics(parsed: ParsedWorkflow, collector: DiagnosticCollector): void {
  const schemaKeys = new Set(parsed.schemas.map(({ key }) => key));
  const phaseByKey = new Map(parsed.phases.map((phase) => [phase.key, phase]));
  const roleByKey = new Map(parsed.roles.map((role) => [role.key, role]));
  const forEachByKey = new Map(parsed.forEach.map((definition) => [definition.key, definition]));
  const templateByKey = new Map(parsed.taskTemplates.map((template) => [template.key, template]));
  for (const definition of parsed.forEach) {
    const phase = phaseByKey.get(definition.source.phase);
    if (phase === undefined) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${definition.pointer}/source/phase`,
        `Phase ${definition.source.phase} is not declared`,
      );
    } else if (
      definition.source.kind === "phase-output" &&
      !phase.outputs.some(
        (output) =>
          output.key ===
          (definition.source as Extract<ParsedForEach["source"], { kind: "phase-output" }>).output,
      )
    ) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${definition.pointer}/source/output`,
        `Output ${definition.source.output} is not declared`,
      );
    }
    for (const [field, key] of [
      ["collectionSchema", definition.collectionSchema],
      ["itemSchema", definition.itemSchema],
    ] as const) {
      if (!schemaKeys.has(key))
        addDiagnostic(
          collector,
          "unknown-reference",
          `${definition.pointer}/${field}`,
          `Schema ${key} is not declared`,
        );
    }
  }
  for (const template of parsed.taskTemplates) {
    if (!schemaKeys.has(template.inputSchema)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${template.pointer}/inputSchema`,
        `Schema ${template.inputSchema} is not declared`,
      );
    }
    if (roleByKey.get(template.role)?.kind !== "agent") {
      addDiagnostic(
        collector,
        "authority-widening",
        `${template.pointer}/role`,
        `Role ${template.role} cannot execute generated work`,
      );
    }
    try {
      validateDataMappingDeclarations(template.inputMappings, {
        dependencyPhases: parsed.phases.map(({ key }) => consumerKey(key)),
        declaredPhaseOutputs: parsed.phases.flatMap((phase) =>
          phase.outputs.map((output) => ({
            phase: consumerKey(phase.key),
            output: consumerKey(output.key),
          })),
        ),
        completionEvidenceViews: parsed.completionEvidenceViews.map((view) => ({
          phase: consumerKey(view.phase),
          view: consumerKey(view.key),
        })),
        allowCurrentItem: true,
      });
    } catch (error) {
      addDiagnostic(
        collector,
        error instanceof DataflowError ? error.code : "invalid-field",
        `${template.pointer}/inputMappings`,
        error instanceof Error ? error.message : "Task template mappings are invalid",
      );
    }
  }
  for (const phase of parsed.phases) {
    if (phase.executor.kind === "task-frontier") {
      if (!forEachByKey.has(phase.executor.forEach))
        addDiagnostic(
          collector,
          "unknown-reference",
          `${phase.pointer}/executor/forEach`,
          `forEach ${phase.executor.forEach} is not declared`,
        );
      if (!templateByKey.has(phase.executor.template))
        addDiagnostic(
          collector,
          "unknown-reference",
          `${phase.pointer}/executor/template`,
          `Task template ${phase.executor.template} is not declared`,
        );
    }
    for (const [index, action] of phase.actions.entries()) {
      if (!forEachByKey.has(action.forEach))
        addDiagnostic(
          collector,
          "unknown-reference",
          `${phase.pointer}/actions/${index}/forEach`,
          `forEach ${action.forEach} is not declared`,
        );
    }
  }
}

function validatePhaseDataflowSemantics(
  parsed: ParsedWorkflow,
  collector: DiagnosticCollector,
): void {
  const schemaKeys = new Set(parsed.schemas.map(({ key }) => key));
  const roleByKey = new Map(parsed.roles.map((role) => [role.key, role]));
  const gateKeys = new Set(parsed.gates.map(({ key }) => key));
  const phaseByKey = new Map(parsed.phases.map((phase) => [phase.key, phase]));
  const declaredPhaseOutputs = parsed.phases.flatMap((phase) =>
    phase.outputs.map((output) => ({
      phase: consumerKey(phase.key),
      output: consumerKey(output.key),
    })),
  );
  const evidenceViews = parsed.completionEvidenceViews.map((view) => ({
    phase: consumerKey(view.phase),
    view: consumerKey(view.key),
  }));

  if (!schemaKeys.has(parsed.workflow.inputSchema)) {
    addDiagnostic(
      collector,
      "unknown-reference",
      "/workflow/input/schema",
      `Workflow input schema ${parsed.workflow.inputSchema} is not declared`,
    );
  }
  for (const view of parsed.completionEvidenceViews) {
    if (!phaseByKey.has(view.phase)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${view.pointer}/phase`,
        `Evidence view phase ${view.phase} is not declared`,
      );
    }
  }
  for (const phase of parsed.phases) {
    if (!schemaKeys.has(phase.input.schema)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${phase.pointer}/input/schema`,
        `Phase input schema ${phase.input.schema} is not declared`,
      );
    }
    if (phase.executor.kind === "agent") {
      const role = roleByKey.get(phase.executor.role);
      if (role === undefined) {
        addDiagnostic(
          collector,
          "unknown-reference",
          `${phase.pointer}/executor/role`,
          `Executor role ${phase.executor.role} is not declared`,
        );
      } else if (role.kind !== "agent") {
        addDiagnostic(
          collector,
          "authority-widening",
          `${phase.pointer}/executor/role`,
          `Executor role ${phase.executor.role} is not an agent`,
        );
      }
    } else if (
      phase.executor.kind === "task-set" &&
      phase.executor.work.some((work) => work.key === "phase-executor")
    ) {
      addDiagnostic(
        collector,
        "duplicate-key",
        `${phase.pointer}/executor/work`,
        "Task-set work cannot use the reserved phase-executor key",
      );
    }
    const outputKeys = new Set<string>();
    const outputPaths = new Set<string>();
    for (const output of phase.outputs) {
      if (outputKeys.has(output.key)) {
        addDiagnostic(
          collector,
          "duplicate-key",
          `${phase.pointer}/outputs`,
          `Phase output ${output.key} is duplicated`,
        );
      }
      if (outputPaths.has(output.path)) {
        addDiagnostic(
          collector,
          "duplicate-key",
          `${phase.pointer}/outputs`,
          `Phase output path ${output.path} is duplicated`,
        );
      }
      outputKeys.add(output.key);
      outputPaths.add(output.path);
      if (!schemaKeys.has(output.schema)) {
        addDiagnostic(
          collector,
          "unknown-reference",
          `${phase.pointer}/outputs/${escapePointer(output.key)}/schema`,
          `Phase output schema ${output.schema} is not declared`,
        );
      }
    }
    for (const required of phase.exit.requiredOutputs) {
      if (!outputKeys.has(required)) {
        addDiagnostic(
          collector,
          "unknown-reference",
          `${phase.pointer}/exit/requiredOutputs`,
          `Required output ${required} is not declared by phase ${phase.key}`,
        );
      }
    }
    if (phase.exit.gate !== undefined && !gateKeys.has(phase.exit.gate)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${phase.pointer}/exit/gate`,
        `Exit gate ${phase.exit.gate} is not declared`,
      );
    }
    try {
      validateDataMappingDeclarations(phase.input.mappings, {
        dependencyPhases: transitivePhaseDependencies(phase, phaseByKey).map(consumerKey),
        declaredPhaseOutputs,
        completionEvidenceViews: evidenceViews,
        allowCurrentItem: false,
      });
    } catch (error) {
      addDiagnostic(
        collector,
        error instanceof DataflowError ? error.code : "invalid-field",
        `${phase.pointer}/input/mappings`,
        error instanceof Error ? error.message : "Phase input mappings are invalid",
      );
    }
  }
}

function transitivePhaseDependencies(
  phase: ParsedPhase,
  phaseByKey: ReadonlyMap<string, ParsedPhase>,
): readonly string[] {
  const found = new Set<string>();
  const pending = [...phase.dependsOn];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || found.has(key)) continue;
    found.add(key);
    pending.push(...(phaseByKey.get(key)?.dependsOn ?? []));
  }
  return [...found].sort(compareText);
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
    if (!phaseKeys.has(phase))
      addDiagnostic(
        collector,
        "unknown-reference",
        work.pointer,
        `Work phase ${phase} is not declared`,
      );
  }
}

function validateAmendmentSemantics(
  parsed: ParsedAmendment,
  baseSnapshot: ConfigurationSnapshot,
  collector: DiagnosticCollector,
): void {
  const roleByKey = new Map<string, Readonly<Record<string, unknown>>>(
    baseSnapshot.roles.map((entry) => [
      String(entry.key),
      isRecord(entry.value) ? entry.value : {},
    ]),
  );
  const schemaKeys = new Set<string>(baseSnapshot.schemas.map(({ key }) => key));
  for (const operation of parsed.operations) {
    if (operation.kind !== "add-task") continue;
    const role = roleByKey.get(operation.work.role);
    if (role === undefined) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${operation.work.pointer}/role`,
        `Role ${operation.work.role} is not declared in the accepted snapshot`,
      );
    } else if (role.kind !== "agent") {
      addDiagnostic(
        collector,
        "authority-widening",
        `${operation.work.pointer}/role`,
        `Role ${operation.work.role} cannot execute work`,
      );
    }
    if (operation.work.inputSchema !== undefined && !schemaKeys.has(operation.work.inputSchema)) {
      addDiagnostic(
        collector,
        "unknown-reference",
        `${operation.work.pointer}/inputSchema`,
        `Input schema ${operation.work.inputSchema} is not declared in the accepted snapshot`,
      );
    }
  }
}

function registriesFromSnapshot(snapshot: ConfigurationSnapshot): ValidatedRegistries {
  const gateKeysByPhase = new Map<string, string[]>();
  for (const entry of snapshot.gates) {
    if (!isRecord(entry.value) || typeof entry.value.phase !== "string") continue;
    const keys = gateKeysByPhase.get(entry.value.phase) ?? [];
    keys.push(String(entry.key));
    gateKeysByPhase.set(entry.value.phase, keys);
  }
  for (const keys of gateKeysByPhase.values()) keys.sort(compareText);
  return {
    prompts: snapshot.prompts,
    schemas: snapshot.schemas,
    roles: snapshot.roles,
    modelPolicies: snapshot.modelPolicies,
    sensors: snapshot.sensors,
    gates: snapshot.gates,
    completionEvidenceViews: snapshot.completionEvidenceViews,
    phaseDataflow: snapshot.phaseDataflow,
    forEach: snapshot.forEach,
    taskTemplates: snapshot.taskTemplates,
    gateKeysByPhase,
  };
}

export function validateConfigurationSnapshot(
  value: unknown,
  sha256: Sha256,
): ConfigurationSnapshot {
  const snapshot = canonicalValue(value);
  if (!isRecord(snapshot)) throw new TypeError("Base configuration snapshot must be an object");
  const expectedKeys = [
    "apiVersion",
    "execution",
    ...(Object.hasOwn(snapshot, "remote") ? ["remote"] : []),
    "graph",
    "prompts",
    "schemas",
    "roles",
    "modelPolicies",
    "sensors",
    "gates",
    "completionEvidenceViews",
    "phaseDataflow",
    "forEach",
    "taskTemplates",
    "componentDigests",
    "snapshotDigest",
  ].sort(compareText);
  if (
    canonicalSerialize(canonicalValue(Object.keys(snapshot).sort(compareText))) !==
    canonicalSerialize(canonicalValue(expectedKeys))
  ) {
    throw new TypeError("Base configuration snapshot has an invalid shape");
  }
  if (snapshot.apiVersion !== CONFIGURATION_SNAPSHOT_API_VERSION) {
    throw new TypeError(
      `Base configuration snapshot apiVersion must be ${CONFIGURATION_SNAPSHOT_API_VERSION}`,
    );
  }
  const graph = validateWorkflowGraph(snapshot.graph, sha256);
  const execution = validateSnapshotExecution(snapshot.execution);
  const remote = Object.hasOwn(snapshot, "remote")
    ? validateSnapshotRemotePolicy(snapshot.remote)
    : undefined;
  const registries: ValidatedRegistries = {
    prompts: validateSnapshotPromptResources(snapshot.prompts, sha256),
    schemas: validateSnapshotSchemaResources(snapshot.schemas, sha256),
    roles: validateSnapshotRegistry(snapshot.roles, "roles", sha256),
    modelPolicies: validateSnapshotRegistry(snapshot.modelPolicies, "modelPolicies", sha256),
    sensors: validateSnapshotRegistry(snapshot.sensors, "sensors", sha256),
    gates: validateSnapshotRegistry(snapshot.gates, "gates", sha256),
    completionEvidenceViews: validateSnapshotRegistry(
      snapshot.completionEvidenceViews,
      "completionEvidenceViews",
      sha256,
    ),
    phaseDataflow: validateSnapshotRegistry(snapshot.phaseDataflow, "phaseDataflow", sha256),
    forEach: validateSnapshotRegistry(snapshot.forEach, "forEach", sha256),
    taskTemplates: validateSnapshotRegistry(snapshot.taskTemplates, "taskTemplates", sha256),
    gateKeysByPhase: new Map(),
  };
  validateSnapshotResourceSet(registries.prompts, registries.schemas);
  validateSnapshotSchemaSafety(registries.schemas);
  const roleKeys = new Set(registries.roles.map(({ key }) => String(key)));
  for (const mapping of remote?.roleMappings ?? []) {
    if (mapping.localRoles.some((role) => !roleKeys.has(role))) {
      throw new TypeError("Base configuration snapshot remote policy references an unknown role");
    }
  }
  const expected = createConfigurationSnapshot(graph, registries, execution, remote, sha256);
  if (canonicalSerialize(snapshot) !== canonicalSerialize(canonicalValue(expected))) {
    throw new TypeError("Base configuration snapshot does not match its exact canonical digests");
  }
  return expected;
}

function validateSnapshotExecution(value: unknown): ExecutionPolicy {
  const collector: DiagnosticCollector = { locator: "snapshot://execution", diagnostics: [] };
  const execution = parseExecution(canonicalValue(value), collector);
  if (execution === undefined || collector.diagnostics.length > 0) {
    throw new TypeError("Base configuration snapshot execution policy is invalid");
  }
  return execution;
}

function validateSnapshotRemotePolicy(value: unknown): RemotePolicy {
  const collector: DiagnosticCollector = { locator: "snapshot://remote", diagnostics: [] };
  const remote = parseRemotePolicy(canonicalValue(value), collector);
  if (remote === undefined || remote === null || collector.diagnostics.length > 0) {
    throw new TypeError("Base configuration snapshot remote policy is invalid");
  }
  return normalizeRemotePolicy(remote);
}

function validateSnapshotRegistry(
  value: unknown,
  label: string,
  sha256: Sha256,
): readonly ConfigurationRegistryEntry[] {
  if (!Array.isArray(value)) throw new TypeError(`Base snapshot ${label} must be an array`);
  const entries = value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`Base snapshot ${label}[${index}] must be an object`);
    if (
      canonicalSerialize(canonicalValue(Object.keys(item).sort(compareText))) !==
      canonicalSerialize(canonicalValue(["digest", "key", "value"]))
    ) {
      throw new TypeError(`Base snapshot ${label}[${index}] has an invalid shape`);
    }
    if (typeof item.key !== "string" || item.key.length === 0 || !isSha256Digest(item.digest)) {
      throw new TypeError(`Base snapshot ${label}[${index}] has an invalid key or digest`);
    }
    const canonical = canonicalValue(item.value);
    if (canonicalDigest(canonical, sha256) !== item.digest) {
      throw new TypeError(`Base snapshot ${label}[${index}] digest does not match its value`);
    }
    return { key: item.key, value: canonical, digest: item.digest };
  });
  const sorted = [...entries].sort((left, right) =>
    compareText(String(left.key), String(right.key)),
  );
  if (canonicalSerialize(canonicalValue(entries)) !== canonicalSerialize(canonicalValue(sorted))) {
    throw new TypeError(`Base snapshot ${label} entries are not canonically ordered`);
  }
  if (new Set(entries.map(({ key }) => key)).size !== entries.length) {
    throw new TypeError(`Base snapshot ${label} entries have duplicate keys`);
  }
  return Object.freeze(entries);
}

function validateSnapshotPromptResources(
  value: unknown,
  sha256: Sha256,
): readonly ConfigurationPromptResource[] {
  if (!Array.isArray(value)) throw new TypeError("Base snapshot prompts must be an array");
  const resources = value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`Base snapshot prompts[${index}] must be an object`);
    const source = validateSnapshotTextSource(item.source, "prompt", sha256);
    const inputPaths = canonicalPromptInputPaths(item.inputPaths as readonly string[]);
    const template = parsePromptTemplate(source.utf8);
    if (
      inputPaths.length !== template.inputPaths.length ||
      inputPaths.some((path, pathIndex) => path !== template.inputPaths[pathIndex])
    ) {
      throw new TypeError(`Base snapshot prompts[${index}] inputPaths do not match its template`);
    }
    const content = canonicalValue({ key: item.key, source, inputPaths });
    if (!isConsumerKey(item.key) || canonicalDigest(content, sha256) !== item.digest) {
      throw new TypeError(`Base snapshot prompts[${index}] has an invalid key or digest`);
    }
    return canonicalValue({
      key: item.key,
      source,
      inputPaths,
      digest: item.digest,
    }) as unknown as ConfigurationPromptResource;
  });
  return validateSortedUniqueResourceKeys(resources, "prompts");
}

function validateSnapshotSchemaResources(
  value: unknown,
  sha256: Sha256,
): readonly ConfigurationSchemaResource[] {
  if (!Array.isArray(value)) throw new TypeError("Base snapshot schemas must be an array");
  const resources = value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`Base snapshot schemas[${index}] must be an object`);
    const source = validateSnapshotTextSource(item.source, "schema", sha256);
    const schema = parseStrictJsonResource(source.utf8).value;
    const schemaDigest = canonicalDigest(schema, sha256);
    const content = canonicalValue({ key: item.key, source, schema, schemaDigest });
    if (
      !isConsumerKey(item.key) ||
      item.schemaDigest !== schemaDigest ||
      canonicalSerialize(schema) !== canonicalSerialize(canonicalValue(item.schema)) ||
      canonicalDigest(content, sha256) !== item.digest
    ) {
      throw new TypeError(
        `Base snapshot schemas[${index}] does not match its exact bytes or digest`,
      );
    }
    return canonicalValue({
      key: item.key,
      source,
      schema,
      schemaDigest,
      digest: item.digest,
    }) as unknown as ConfigurationSchemaResource;
  });
  return validateSortedUniqueResourceKeys(resources, "schemas");
}

function validateSnapshotResourceSet(
  prompts: readonly ConfigurationPromptResource[],
  schemas: readonly ConfigurationSchemaResource[],
): void {
  if (prompts.length > CONFIGURATION_RESOURCE_LIMITS.maxPromptResources) {
    throw new TypeError("Base snapshot has too many prompt resources");
  }
  if (schemas.length > CONFIGURATION_RESOURCE_LIMITS.maxSchemaResources) {
    throw new TypeError("Base snapshot has too many schema resources");
  }
  const paths = [...prompts, ...schemas].map(({ source }) => source.path);
  if (new Set(paths).size !== paths.length) {
    throw new TypeError("Base snapshot contains duplicate resource paths");
  }
  const aggregateBytes = [...prompts, ...schemas].reduce(
    (total, resource) => total + resource.source.byteLength,
    0,
  );
  if (aggregateBytes > CONFIGURATION_RESOURCE_LIMITS.maxAggregateBytes) {
    throw new TypeError("Base snapshot resource set exceeds its aggregate byte limit");
  }
}

function validateSnapshotSchemaSafety(schemas: readonly ConfigurationSchemaResource[]): void {
  const externalSchemas = schemas.flatMap((resource) => {
    if (!isRecord(resource.schema) || typeof resource.schema.$id !== "string") return [];
    const id = normalizeSchemaResourceId(resource.schema.$id);
    return id === undefined ? [] : [{ key: resource.key, id, schema: resource.schema }];
  });
  for (const resource of schemas) {
    const findings = analyzeSchemaDefinition(
      resource.schema,
      `/schemas/${escapePointer(resource.key)}`,
      externalSchemas
        .filter(({ key }) => key !== resource.key)
        .map(({ id, schema }) => ({ id, schema })),
    ).findings;
    if (findings.length > 0) {
      throw new TypeError(`Base snapshot schema ${resource.key} is unsafe or invalid`);
    }
  }
}

function validateSnapshotTextSource(
  value: unknown,
  kind: "prompt" | "schema",
  sha256: Sha256,
): ConfigurationPromptResource["source"] {
  if (!isRecord(value)) throw new TypeError(`Base snapshot ${kind} source must be an object`);
  const path = validateConfigurationResourcePath(kind, value.path as string);
  const utf8 = value.utf8;
  if (typeof utf8 !== "string" || utf8.includes("\0")) {
    throw new TypeError(`Base snapshot ${kind} source has invalid UTF-8 text`);
  }
  const bytes = new TextEncoder().encode(utf8);
  const mediaType =
    kind === "prompt" ? "text/markdown; charset=utf-8" : "application/schema+json; charset=utf-8";
  if (
    value.mediaType !== mediaType ||
    value.byteLength !== bytes.byteLength ||
    value.contentDigest !== sha256.digest(bytes)
  ) {
    throw new TypeError(`Base snapshot ${kind} source does not match its exact bytes`);
  }
  return canonicalValue({
    path,
    mediaType,
    byteLength: bytes.byteLength,
    contentDigest: value.contentDigest,
    utf8,
  }) as unknown as ConfigurationPromptResource["source"];
}

function validateSortedUniqueResourceKeys<T extends { readonly key: ConsumerKey }>(
  resources: readonly T[],
  label: string,
): readonly T[] {
  const sorted = [...resources].sort(byKey);
  if (resources.some((resource, index) => resource.key !== sorted[index]?.key)) {
    throw new TypeError(`Base snapshot ${label} entries are not canonically ordered`);
  }
  if (new Set(resources.map(({ key }) => key)).size !== resources.length) {
    throw new TypeError(`Base snapshot ${label} entries have duplicate keys`);
  }
  return Object.freeze(resources);
}

function lowerAmendment(
  parsed: ParsedAmendment,
  baseInput: NormalizedWorkflowInput,
  execution: ExecutionPolicy,
  remote: RemotePolicy | undefined,
  gateKeysByPhase: ReadonlyMap<string, readonly string[]>,
  collector: DiagnosticCollector,
  sha256: Sha256,
): {
  readonly operations: readonly NormalizedAmendmentOperation[];
  readonly candidate: LoweredConfiguration;
} {
  const sourceById = new Map<string, { pointer: string }>();
  const workflowKey = baseInput.workflow.key;
  const operations = parsed.operations.map((operation) => {
    if (operation.kind === "add-phase") {
      const phase = lowerPhaseDeclaration(
        workflowKey,
        baseInput.workflow.id,
        operation.phase,
        collector.locator,
        sourceById,
        sha256,
      );
      return { kind: operation.kind, phase } as const;
    }
    const lowered = lowerWorkDeclaration(
      workflowKey,
      operation.phase,
      operation.work,
      false,
      collector.locator,
      gateKeysByPhase.get(operation.phase) ?? [],
      sourceById,
      sha256,
    );
    return { kind: operation.kind, task: lowered.task, criteria: lowered.criteria } as const;
  });
  const phases = operations.flatMap((operation) =>
    operation.kind === "add-phase" ? [operation.phase] : [],
  );
  const executableWork = operations.flatMap((operation) =>
    operation.kind === "add-task" ? [operation.task] : [],
  );
  const criteria = operations.flatMap((operation) =>
    operation.kind === "add-task" ? operation.criteria : [],
  );
  return {
    operations,
    candidate: {
      execution,
      ...(remote === undefined ? {} : { remote }),
      input: {
        workflow: baseInput.workflow,
        phases: [...baseInput.phases, ...phases],
        executableWork: [...baseInput.executableWork, ...executableWork],
        criteria: [...baseInput.criteria, ...criteria],
      },
      sourceById,
    },
  };
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
  const phases = parsed.phases.map((phase) =>
    lowerPhaseDeclaration(
      parsed.workflow.key,
      workflowIdentity,
      phase,
      collector.locator,
      sourceById,
      sha256,
    ),
  );
  const allWork = [
    ...parsed.phases.flatMap((phase) =>
      phase.work.map((work) => ({ phaseKey: phase.key, work, projected: false })),
    ),
  ];
  const uniqueWork: typeof allWork = [];
  const seen = new Set<string>();
  for (const declaration of allWork) {
    const qualified = `${declaration.phaseKey}/${declaration.work.key}`;
    if (!seen.has(qualified)) uniqueWork.push(declaration);
    seen.add(qualified);
  }
  const loweredWork = uniqueWork.map(({ phaseKey, work, projected }) =>
    lowerWorkDeclaration(
      parsed.workflow.key,
      phaseKey,
      work,
      projected,
      collector.locator,
      gateKeysByPhase.get(phaseKey) ?? [],
      sourceById,
      sha256,
    ),
  );
  const executableWork = loweredWork.map(({ task }) => task);
  const criteria = loweredWork.flatMap((item) => item.criteria);
  return {
    execution: parsed.execution,
    ...(parsed.remote === undefined ? {} : { remote: normalizeRemotePolicy(parsed.remote) }),
    input: {
      workflow: {
        id: workflowIdentity,
        key: consumerKey(parsed.workflow.key),
        generation: definitionGeneration(parsed.workflow.generation),
        source: { locator: collector.locator, pointer: "/workflow" },
        input: canonicalValue({ schema: parsed.workflow.inputSchema }),
      },
      phases: phases.sort(byDefinitionId),
      executableWork: executableWork.sort(byDefinitionId),
      criteria: criteria.sort(byDefinitionId),
    },
    sourceById,
  };
}

function normalizeRemotePolicy(policy: ParsedRemotePolicy): RemotePolicy {
  return canonicalValue({
    disconnectedMode: policy.disconnectedMode,
    roleMappings: policy.roleMappings.map(({ issuer, tenant, upstreamRole, localRoles }) => ({
      issuer,
      tenant,
      upstreamRole,
      localRoles: [...localRoles].sort(compareText),
    })),
    maximumRemoteAuthorizationLeaseSeconds: policy.maximumRemoteAuthorizationLeaseSeconds,
    synchronization: policy.synchronization,
  }) as unknown as RemotePolicy;
}

function lowerPhaseDeclaration(
  workflowKey: string,
  workflowIdentity: ReturnType<typeof workflowId>,
  phase: ParsedPhase,
  locator: string,
  sourceById: Map<string, { pointer: string }>,
  sha256: Sha256,
) {
  const pointer = `/phases/${escapePointer(phase.key)}`;
  const id = phaseIdentity(workflowKey, phase.key, sha256);
  sourceById.set(id, { pointer });
  return {
    id,
    key: consumerKey(phase.key),
    generation: definitionGeneration(phase.generation),
    parentId: workflowIdentity,
    dependsOn: phase.dependsOn.map((key) => phaseIdentity(workflowKey, key, sha256)),
    source: { locator, pointer },
    input: normalizedPhaseDataflow(phase),
  };
}

function lowerWorkDeclaration(
  workflowKey: string,
  phaseKey: string,
  work: ParsedWork,
  projected: boolean,
  locator: string,
  gates: readonly string[],
  sourceById: Map<string, { pointer: string }>,
  sha256: Sha256,
) {
  const pointer = work.reservedExecutor
    ? `/phases/${escapePointer(phaseKey)}/executor`
    : projected
      ? `/projectedWork/${escapePointer(phaseKey)}/${escapePointer(work.key)}`
      : `/phases/${escapePointer(phaseKey)}/executor/work/${escapePointer(work.key)}`;
  const id = taskIdentity(workflowKey, phaseKey, work.key, sha256);
  sourceById.set(id, { pointer });
  const sortedCriteria = [...work.completionPolicy.criteria].sort((left, right) =>
    compareText(left.key, right.key),
  );
  const task = {
    id,
    key: consumerKey(work.key),
    ...(work.title === undefined ? {} : { title: work.title }),
    generation: definitionGeneration(work.generation),
    parentId: phaseIdentity(workflowKey, phaseKey, sha256),
    dependsOn: work.dependsOn.map((reference) =>
      taskIdentityFromReference(workflowKey, reference, sha256),
    ),
    source: { locator, pointer },
    input: canonicalValue({ value: work.input, binding: normalizedWorkBinding(work, gates) }),
    completionPolicy: {
      criteria: sortedCriteria.map((criterion) => ({
        criterionId: criterionIdentity(workflowKey, phaseKey, work.key, criterion.key, sha256),
        required: criterion.required,
      })),
      completionEvidencePolicy: normalizeCompletionEvidencePolicy(
        work.completionPolicy.completionEvidencePolicy,
      ),
    },
  };
  const criteria = work.completionPolicy.criteria.map((criterion) => {
    const criterionPointer = `${pointer}/completionPolicy/criteria/${escapePointer(criterion.key)}`;
    const criterionIdentityValue = criterionIdentity(
      workflowKey,
      phaseKey,
      work.key,
      criterion.key,
      sha256,
    );
    sourceById.set(criterionIdentityValue, { pointer: criterionPointer });
    return {
      id: criterionIdentityValue,
      key: consumerKey(criterion.key),
      generation: definitionGeneration(criterion.generation),
      parentId: id,
      source: { locator, pointer: criterionPointer },
      input: criterion.input,
    };
  });
  return { task, criteria };
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
      completionEvidencePolicy: normalizeCompletionEvidencePolicy(
        work.completionPolicy.completionEvidencePolicy,
      ),
    },
  };
  return canonicalValue(
    work.inputSchema === undefined ? common : { ...common, inputSchema: work.inputSchema },
  );
}

function normalizedPhaseDataflow(phase: ParsedPhase): CanonicalValue {
  const executor =
    phase.executor.kind === "agent"
      ? {
          kind: "agent" as const,
          role: phase.executor.role,
          budgets: phase.executor.budgets,
          completionPolicy: phase.executor.completionPolicy,
          resumeAcrossAttempts: phase.executor.resumeAcrossAttempts,
          reservedTaskKey: "phase-executor",
        }
      : phase.executor.kind === "task-set"
        ? {
            kind: "task-set" as const,
            work: phase.executor.work.map(normalizedWorkDefinition),
          }
        : {
            kind: "task-frontier" as const,
            forEach: phase.executor.forEach,
            template: phase.executor.template,
          };
  return canonicalValue({
    key: phase.key,
    generation: phase.generation,
    dependsOn: [...phase.dependsOn].sort(compareText),
    input: {
      schema: phase.input.schema,
      mappings: [...phase.input.mappings].sort((left, right) => compareText(left.key, right.key)),
    },
    executor,
    outputs: [...phase.outputs].sort((left, right) => compareText(left.key, right.key)),
    iteration: phase.iteration,
    exit: {
      requiredOutputs: [...phase.exit.requiredOutputs].sort(compareText),
      ...(phase.exit.gate === undefined ? {} : { gate: phase.exit.gate }),
      approval: phase.exit.approval,
    },
    actions: phase.actions,
  });
}

function normalizeCompletionEvidencePolicy(policy: ParsedCompletionEvidencePolicy) {
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
  execution: ExecutionPolicy,
  remote: RemotePolicy | undefined,
  sha256: Sha256,
): ConfigurationSnapshot {
  const contentRegistries = {
    prompts: registries.prompts,
    schemas: registries.schemas,
    roles: registries.roles,
    modelPolicies: registries.modelPolicies,
    sensors: registries.sensors,
    gates: registries.gates,
    completionEvidenceViews: registries.completionEvidenceViews,
    phaseDataflow: registries.phaseDataflow,
    forEach: registries.forEach,
    taskTemplates: registries.taskTemplates,
  };
  const componentDigests = {
    execution: canonicalDigest(canonicalValue(execution), sha256),
    ...(remote === undefined ? {} : { remote: canonicalDigest(canonicalValue(remote), sha256) }),
    graph: canonicalDigest(canonicalValue(graph), sha256),
    prompts: canonicalDigest(canonicalValue(contentRegistries.prompts), sha256),
    schemas: canonicalDigest(canonicalValue(contentRegistries.schemas), sha256),
    roles: canonicalDigest(canonicalValue(contentRegistries.roles), sha256),
    modelPolicies: canonicalDigest(canonicalValue(contentRegistries.modelPolicies), sha256),
    sensors: canonicalDigest(canonicalValue(contentRegistries.sensors), sha256),
    gates: canonicalDigest(canonicalValue(contentRegistries.gates), sha256),
    completionEvidenceViews: canonicalDigest(
      canonicalValue(contentRegistries.completionEvidenceViews),
      sha256,
    ),
    phaseDataflow: canonicalDigest(canonicalValue(contentRegistries.phaseDataflow), sha256),
    forEach: canonicalDigest(canonicalValue(contentRegistries.forEach), sha256),
    taskTemplates: canonicalDigest(canonicalValue(contentRegistries.taskTemplates), sha256),
  };
  const content = {
    apiVersion: CONFIGURATION_SNAPSHOT_API_VERSION,
    execution,
    ...(remote === undefined ? {} : { remote }),
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

function stripResolvedPrompt(prompt: ResolvedPrompt): ConfigurationPromptResource {
  return canonicalValue({
    key: consumerKey(prompt.key),
    source: prompt.source,
    inputPaths: prompt.inputPaths,
    digest: prompt.digest,
  }) as unknown as ConfigurationPromptResource;
}

function stripResolvedSchema(schema: ResolvedSchema): ConfigurationSchemaResource {
  return canonicalValue({
    key: consumerKey(schema.key),
    source: schema.source,
    schema: schema.schema,
    schemaDigest: schema.schemaDigest,
    digest: schema.digest,
  }) as unknown as ConfigurationSchemaResource;
}

function byKey(left: { readonly key: string }, right: { readonly key: string }): number {
  return compareText(left.key, right.key);
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

function parseDigest(
  value: CanonicalValue | undefined,
  pointer: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (!isSha256Digest(value)) {
    addDiagnostic(collector, "invalid-field", pointer, "Value must be a SHA-256 digest");
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
  if (diagnostic.field === "completionEvidencePolicy")
    return `${source.pointer}/completionPolicy/completionEvidencePolicy`;
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
