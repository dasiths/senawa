import { BUDGET_UNITS, type BudgetUnit } from "./budgets.js";
import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import type { TaskGenerationReference, TerminalDisposition } from "./completion.js";
import {
  type AssetBindingId,
  type AssetId,
  assetBindingId,
  type ConsumerKey,
  type ContextId,
  contextId,
  type DefinitionGeneration,
  type DispatchId,
  dispatchId,
  isAssetId,
  isConsumerKey,
  isDefinitionGeneration,
  isRunId,
  isTaskId,
  type RunId,
  type TaskId,
} from "./identity.js";

export const TASK_DEPENDENCY_BARRIER_API_VERSION = "senawa.dev/task-dependency-barrier/v1alpha1";
export const WORKER_CONTEXT_BASE_API_VERSION = "senawa.dev/worker-context-base/v1alpha1";
export const WORKER_DISPATCH_API_VERSION = "senawa.dev/worker-dispatch/v1alpha1";
export const WORKER_MODEL_ROUTE_SELECTION_API_VERSION =
  "senawa.dev/worker-model-route-selection/v1alpha1";

export const CONTEXT_CONTRACT_KINDS = [
  "completion-policy",
  "gate-policy",
  "input-schema",
  "role",
  "task-definition",
] as const;

export type ContextContractKind = (typeof CONTEXT_CONTRACT_KINDS)[number];
export type AssetSensitivity = "public" | "internal" | "confidential" | "restricted";

export interface ContextTaskInput {
  readonly taskId: TaskId;
  readonly definitionGeneration: DefinitionGeneration;
}

export interface TaskDependencyAssessmentInput {
  readonly task: TaskGenerationReference;
  readonly disposition: TerminalDisposition;
  readonly assessmentDigest: Sha256Digest;
  readonly authorityFact: unknown;
}

export interface TaskDependencyAssessment {
  readonly task: TaskGenerationReference;
  readonly disposition: TerminalDisposition;
  readonly assessmentDigest: Sha256Digest;
  readonly authorityFact: CanonicalValue;
  readonly authorityFactDigest: Sha256Digest;
}

export interface TaskDependencyBarrierInput {
  readonly task: ContextTaskInput;
  readonly dependencies: readonly TaskDependencyAssessmentInput[];
}

export interface TaskDependencyBarrier {
  readonly apiVersion: typeof TASK_DEPENDENCY_BARRIER_API_VERSION;
  readonly task: ContextTaskInput;
  readonly dependencies: readonly TaskDependencyAssessment[];
  readonly barrierDigest: Sha256Digest;
}

export interface ImmutableContextContractReference {
  readonly kind: ContextContractKind;
  readonly key: ConsumerKey;
  readonly contractDigest: Sha256Digest;
}

export interface HistoricalAssetBindingInput {
  readonly semanticAssetId: AssetId;
  readonly aliasBindingDigest: Sha256Digest;
  readonly contentDigest: Sha256Digest;
  readonly mediaType: string;
  readonly sensitivity: AssetSensitivity;
  readonly byteLength: number;
}

export interface HistoricalAssetBinding extends HistoricalAssetBindingInput {
  readonly assetBindingId: AssetBindingId;
}

export interface RepositoryBase {
  readonly commitDigest: Sha256Digest;
  readonly treeDigest: Sha256Digest;
}

export interface ContextModelPolicyReference {
  readonly key: ConsumerKey;
  readonly policyDigest: Sha256Digest;
  readonly orderedRoutesDigest: Sha256Digest;
}

export interface ContextRoleReference {
  readonly key: ConsumerKey;
  readonly roleDigest: Sha256Digest;
}

export interface ContextBudget {
  readonly unit: BudgetUnit;
  readonly limit: number;
}

export interface WorkerContextBaseInput {
  readonly task: ContextTaskInput;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly contracts: readonly ImmutableContextContractReference[];
  readonly dependencyBarrier: TaskDependencyBarrierInput;
  readonly assets: readonly HistoricalAssetBindingInput[];
  readonly repositoryBase: RepositoryBase;
  readonly modelPolicy: ContextModelPolicyReference;
  readonly role: ContextRoleReference;
  readonly capabilities: readonly string[];
  readonly budgets: readonly ContextBudget[];
}

export interface WorkerContextBase {
  readonly apiVersion: typeof WORKER_CONTEXT_BASE_API_VERSION;
  readonly task: ContextTaskInput;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly contracts: readonly ImmutableContextContractReference[];
  readonly dependencyBarrier: TaskDependencyBarrier;
  readonly assets: readonly HistoricalAssetBinding[];
  readonly repositoryBase: RepositoryBase;
  readonly modelPolicy: ContextModelPolicyReference;
  readonly role: ContextRoleReference;
  readonly capabilities: readonly string[];
  readonly budgets: readonly ContextBudget[];
  readonly contextDigest: Sha256Digest;
  readonly contextId: ContextId;
}

export interface WorkerDispatchInput {
  readonly repositoryId: string;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly workerPrincipalId: string;
  readonly roleKey: ConsumerKey;
  readonly capabilities: readonly string[];
  readonly promptPackDigest: Sha256Digest;
}

export interface WorkerDispatch {
  readonly apiVersion: typeof WORKER_DISPATCH_API_VERSION;
  readonly dispatchId: DispatchId;
  readonly repositoryId: string;
  readonly runId: RunId;
  readonly task: TaskGenerationReference;
  readonly contextId: ContextId;
  readonly contextDigest: Sha256Digest;
  readonly ordinal: number;
  readonly worker: Readonly<{
    readonly principalId: string;
    readonly roleKey: ConsumerKey;
  }>;
  readonly capabilities: readonly string[];
  readonly promptPackDigest: Sha256Digest;
}

export interface WorkerModelRouteSelectionInput {
  readonly routeIndex: number;
  readonly provider: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxSubmissions: number;
  readonly maxMillidollars: number;
  readonly maxAiCredits: number;
}

export interface WorkerModelRouteSelection {
  readonly apiVersion: typeof WORKER_MODEL_ROUTE_SELECTION_API_VERSION;
  readonly dispatchId: DispatchId;
  readonly contextId: ContextId;
  readonly contextDigest: Sha256Digest;
  readonly modelPolicy: ContextModelPolicyReference &
    Readonly<{
      readonly routeIndex: number;
      readonly provider: string;
      readonly model: string;
    }>;
  readonly limits: Readonly<{
    readonly maxTurns: number;
    readonly maxSubmissions: number;
    readonly maxMillidollars: number;
    readonly maxAiCredits: number;
  }>;
  readonly selectionDigest: Sha256Digest;
}

export type ContextErrorCode =
  | "invalid-context"
  | "invalid-barrier"
  | "invalid-dispatch"
  | "invalid-route-selection"
  | "duplicate-contract"
  | "duplicate-dependency"
  | "duplicate-asset"
  | "duplicate-capability"
  | "duplicate-budget"
  | "context-mismatch"
  | "capability-widening";

export class ContextError extends Error {
  readonly code: ContextErrorCode;

  constructor(code: ContextErrorCode, message: string) {
    super(message);
    this.name = "ContextError";
    this.code = code;
  }
}

export function createTaskDependencyBarrier(
  input: TaskDependencyBarrierInput,
  sha256: Sha256,
): TaskDependencyBarrier {
  const snapshot = snapshotCanonical(input, "invalid-barrier", "Dependency barriers");
  return compileTaskDependencyBarrier(snapshot, sha256);
}

export function validateTaskDependencyBarrier(
  value: unknown,
  sha256: Sha256,
): TaskDependencyBarrier {
  const snapshot = snapshotCanonical(value, "invalid-barrier", "Dependency barriers");
  assertExactKeys(snapshot, "dependency barrier", [
    "apiVersion",
    "task",
    "dependencies",
    "barrierDigest",
  ]);
  if (snapshot.apiVersion !== TASK_DEPENDENCY_BARRIER_API_VERSION) {
    fail("invalid-barrier", "Dependency barrier apiVersion is not recognized");
  }
  if (!Array.isArray(snapshot.dependencies)) {
    fail("invalid-barrier", "Dependency barrier dependencies must be an array");
  }
  const input = {
    task: snapshot.task,
    dependencies: snapshot.dependencies.map((dependency, index) => {
      assertExactKeys(dependency, `dependency barrier dependency ${index}`, [
        "task",
        "disposition",
        "assessmentDigest",
        "authorityFact",
        "authorityFactDigest",
      ]);
      return {
        task: dependency.task,
        disposition: dependency.disposition,
        assessmentDigest: dependency.assessmentDigest,
        authorityFact: dependency.authorityFact,
      };
    }),
  };
  const recompiled = compileTaskDependencyBarrier(input, sha256);
  assertExactRecompilation(snapshot, recompiled, "invalid-barrier", "Dependency barrier");
  return recompiled;
}

export function createWorkerContextBase(
  input: WorkerContextBaseInput,
  sha256: Sha256,
): WorkerContextBase {
  const snapshot = snapshotCanonical(input, "invalid-context", "Worker context bases");
  return compileWorkerContextBase(snapshot, sha256);
}

export function validateWorkerContextBase(value: unknown, sha256: Sha256): WorkerContextBase {
  const snapshot = snapshotCanonical(value, "invalid-context", "Worker context bases");
  assertExactKeys(snapshot, "worker context base", [
    "apiVersion",
    "task",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "contracts",
    "dependencyBarrier",
    "assets",
    "repositoryBase",
    "modelPolicy",
    "role",
    "capabilities",
    "budgets",
    "contextDigest",
    "contextId",
  ]);
  if (snapshot.apiVersion !== WORKER_CONTEXT_BASE_API_VERSION) {
    fail("invalid-context", "Worker context base apiVersion is not recognized");
  }
  if (!Array.isArray(snapshot.assets)) {
    fail("invalid-context", "Worker context assets must be an array");
  }
  const barrier = validateTaskDependencyBarrier(snapshot.dependencyBarrier, sha256);
  const input = {
    task: snapshot.task,
    graphRevisionDigest: snapshot.graphRevisionDigest,
    configurationSnapshotDigest: snapshot.configurationSnapshotDigest,
    contracts: snapshot.contracts,
    dependencyBarrier: {
      task: barrier.task,
      dependencies: barrier.dependencies.map(
        ({ authorityFactDigest: _digest, ...dependency }) => dependency,
      ),
    },
    assets: snapshot.assets.map((asset, index) => {
      assertExactKeys(asset, `worker context asset ${index}`, [
        "semanticAssetId",
        "aliasBindingDigest",
        "contentDigest",
        "mediaType",
        "sensitivity",
        "byteLength",
        "assetBindingId",
      ]);
      const { assetBindingId: _assetBindingId, ...binding } = asset;
      return binding;
    }),
    repositoryBase: snapshot.repositoryBase,
    modelPolicy: snapshot.modelPolicy,
    role: snapshot.role,
    capabilities: snapshot.capabilities,
    budgets: snapshot.budgets,
  };
  const recompiled = compileWorkerContextBase(input, sha256);
  assertExactRecompilation(snapshot, recompiled, "invalid-context", "Worker context base");
  return recompiled;
}

export function taskGenerationReferenceForContext(
  value: unknown,
  sha256: Sha256,
): TaskGenerationReference {
  const context = validateWorkerContextBase(value, sha256);
  return canonicalValue({
    taskId: context.task.taskId,
    definitionGeneration: context.task.definitionGeneration,
    contextRevisionDigest: context.contextDigest,
  }) as unknown as TaskGenerationReference;
}

export function createWorkerDispatch(
  input: WorkerDispatchInput,
  contextValue: unknown,
  sha256: Sha256,
): WorkerDispatch {
  const context = validateWorkerContextBase(contextValue, sha256);
  const snapshot = snapshotCanonical(input, "invalid-dispatch", "Worker dispatches");
  return compileWorkerDispatch(snapshot, context, sha256);
}

export function resumeWorkerDispatch(
  input: WorkerDispatchInput,
  contextValue: unknown,
  sha256: Sha256,
): WorkerDispatch {
  return createWorkerDispatch(input, contextValue, sha256);
}

export function validateWorkerDispatch(
  value: unknown,
  contextValue: unknown,
  sha256: Sha256,
): WorkerDispatch {
  const context = validateWorkerContextBase(contextValue, sha256);
  const snapshot = snapshotCanonical(value, "invalid-dispatch", "Worker dispatches");
  assertExactKeys(snapshot, "worker dispatch", [
    "apiVersion",
    "dispatchId",
    "repositoryId",
    "runId",
    "task",
    "contextId",
    "contextDigest",
    "ordinal",
    "worker",
    "capabilities",
    "promptPackDigest",
  ]);
  if (snapshot.apiVersion !== WORKER_DISPATCH_API_VERSION) {
    fail("invalid-dispatch", "Worker dispatch apiVersion is not recognized");
  }
  assertExactKeys(snapshot.worker, "worker dispatch principal", ["principalId", "roleKey"]);
  const input = {
    repositoryId: snapshot.repositoryId,
    runId: snapshot.runId,
    ordinal: snapshot.ordinal,
    workerPrincipalId: snapshot.worker.principalId,
    roleKey: snapshot.worker.roleKey,
    capabilities: snapshot.capabilities,
    promptPackDigest: snapshot.promptPackDigest,
  };
  const recompiled = compileWorkerDispatch(input, context, sha256);
  assertExactRecompilation(snapshot, recompiled, "invalid-dispatch", "Worker dispatch");
  return recompiled;
}

export function workerSessionIdentity(
  value: unknown,
  contextValue: unknown,
  sha256: Sha256,
): DispatchId {
  return validateWorkerDispatch(value, contextValue, sha256).dispatchId;
}

export function createWorkerModelRouteSelection(
  input: WorkerModelRouteSelectionInput,
  contextValue: unknown,
  dispatchValue: unknown,
  sha256: Sha256,
): WorkerModelRouteSelection {
  const context = validateWorkerContextBase(contextValue, sha256);
  const dispatch = validateWorkerDispatch(dispatchValue, context, sha256);
  const snapshot = snapshotCanonical(
    input,
    "invalid-route-selection",
    "Worker model route selections",
  );
  return compileWorkerModelRouteSelection(snapshot, context, dispatch, sha256);
}

export function validateWorkerModelRouteSelection(
  value: unknown,
  contextValue: unknown,
  dispatchValue: unknown,
  sha256: Sha256,
): WorkerModelRouteSelection {
  const context = validateWorkerContextBase(contextValue, sha256);
  const dispatch = validateWorkerDispatch(dispatchValue, context, sha256);
  const snapshot = snapshotCanonical(
    value,
    "invalid-route-selection",
    "Worker model route selections",
  );
  assertExactKeys(
    snapshot,
    "worker model route selection",
    [
      "apiVersion",
      "dispatchId",
      "contextId",
      "contextDigest",
      "modelPolicy",
      "limits",
      "selectionDigest",
    ],
    "invalid-route-selection",
  );
  if (snapshot.apiVersion !== WORKER_MODEL_ROUTE_SELECTION_API_VERSION) {
    fail("invalid-route-selection", "Worker model route selection apiVersion is not recognized");
  }
  assertExactKeys(
    snapshot.modelPolicy,
    "worker model route selection policy",
    ["key", "policyDigest", "orderedRoutesDigest", "routeIndex", "provider", "model"],
    "invalid-route-selection",
  );
  assertExactKeys(
    snapshot.limits,
    "worker model route selection limits",
    ["maxTurns", "maxSubmissions", "maxMillidollars", "maxAiCredits"],
    "invalid-route-selection",
  );
  const recompiled = compileWorkerModelRouteSelection(
    {
      routeIndex: snapshot.modelPolicy.routeIndex,
      provider: snapshot.modelPolicy.provider,
      model: snapshot.modelPolicy.model,
      maxTurns: snapshot.limits.maxTurns,
      maxSubmissions: snapshot.limits.maxSubmissions,
      maxMillidollars: snapshot.limits.maxMillidollars,
      maxAiCredits: snapshot.limits.maxAiCredits,
    },
    context,
    dispatch,
    sha256,
  );
  assertExactRecompilation(
    snapshot,
    recompiled,
    "invalid-route-selection",
    "Worker model route selection",
  );
  return recompiled;
}

function compileTaskDependencyBarrier(value: unknown, sha256: Sha256): TaskDependencyBarrier {
  assertExactKeys(value, "dependency barrier input", ["task", "dependencies"]);
  const task = contextTask(value.task, "dependency barrier task", "invalid-barrier");
  if (!Array.isArray(value.dependencies)) {
    fail("invalid-barrier", "Dependency barrier dependencies must be an array");
  }
  const dependencies = value.dependencies.map((dependency, index) =>
    dependencyAssessment(dependency, index, sha256),
  );
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    if (seen.has(dependency.task.taskId)) {
      fail(
        "duplicate-dependency",
        `Dependency ${dependency.task.taskId} is assessed more than once`,
      );
    }
    seen.add(dependency.task.taskId);
  }
  dependencies.sort((left, right) => compareText(left.task.taskId, right.task.taskId));
  const content = {
    apiVersion: TASK_DEPENDENCY_BARRIER_API_VERSION,
    task,
    dependencies,
  };
  const barrierDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, barrierDigest }) as unknown as TaskDependencyBarrier;
}

function compileWorkerContextBase(value: unknown, sha256: Sha256): WorkerContextBase {
  assertExactKeys(value, "worker context base input", [
    "task",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "contracts",
    "dependencyBarrier",
    "assets",
    "repositoryBase",
    "modelPolicy",
    "role",
    "capabilities",
    "budgets",
  ]);
  const task = contextTask(value.task, "worker context task", "invalid-context");
  assertDigest(value.graphRevisionDigest, "graphRevisionDigest", "invalid-context");
  assertDigest(value.configurationSnapshotDigest, "configurationSnapshotDigest", "invalid-context");
  const contracts = contextContracts(value.contracts);
  const dependencyBarrier = compileTaskDependencyBarrier(value.dependencyBarrier, sha256);
  if (
    dependencyBarrier.task.taskId !== task.taskId ||
    dependencyBarrier.task.definitionGeneration !== task.definitionGeneration
  ) {
    fail("context-mismatch", "Dependency barrier task does not match the worker context task");
  }
  const assets = historicalAssetBindings(value.assets, sha256);
  const repositoryBase = repositoryBaseReference(value.repositoryBase);
  const modelPolicy = modelPolicyReference(value.modelPolicy);
  const role = roleReference(value.role);
  const capabilities = capabilitySet(value.capabilities, "invalid-context");
  const budgets = contextBudgets(value.budgets);
  const content = {
    apiVersion: WORKER_CONTEXT_BASE_API_VERSION,
    task,
    graphRevisionDigest: value.graphRevisionDigest as Sha256Digest,
    configurationSnapshotDigest: value.configurationSnapshotDigest as Sha256Digest,
    contracts,
    dependencyBarrier,
    assets,
    repositoryBase,
    modelPolicy,
    role,
    capabilities,
    budgets,
  };
  const contextDigest = canonicalDigest(canonicalValue(content), sha256);
  const derivedContextId = contextId(`context_${contextDigest}`);
  return canonicalValue({
    ...content,
    contextDigest,
    contextId: derivedContextId,
  }) as unknown as WorkerContextBase;
}

function compileWorkerDispatch(
  value: unknown,
  context: WorkerContextBase,
  sha256: Sha256,
): WorkerDispatch {
  assertExactKeys(value, "worker dispatch input", [
    "repositoryId",
    "runId",
    "ordinal",
    "workerPrincipalId",
    "roleKey",
    "capabilities",
    "promptPackDigest",
  ]);
  if (!isRepositoryId(value.repositoryId)) {
    fail("invalid-dispatch", "Worker dispatch repositoryId is not a valid repository identity");
  }
  if (!isRunId(value.runId)) {
    fail("invalid-dispatch", "Worker dispatch runId is not a valid run identity");
  }
  if (!isPositiveSafeInteger(value.ordinal)) {
    fail("invalid-dispatch", "Worker dispatch ordinal must be a positive safe integer");
  }
  if (!isPrincipalId(value.workerPrincipalId)) {
    fail("invalid-dispatch", "Worker principal identity is invalid");
  }
  if (!isConsumerKey(value.roleKey)) {
    fail("invalid-dispatch", "Worker dispatch roleKey is invalid");
  }
  if (value.roleKey !== context.role.key) {
    fail("context-mismatch", "Worker dispatch role does not match the context role");
  }
  const capabilities = capabilitySet(value.capabilities, "invalid-dispatch");
  const allowedCapabilities = new Set(context.capabilities);
  for (const capability of capabilities) {
    if (!allowedCapabilities.has(capability)) {
      fail(
        "capability-widening",
        `Worker dispatch capability ${capability} is not granted by the context`,
      );
    }
  }
  assertDigest(value.promptPackDigest, "promptPackDigest", "invalid-dispatch");
  const content = {
    apiVersion: WORKER_DISPATCH_API_VERSION,
    repositoryId: value.repositoryId,
    runId: value.runId as RunId,
    task: {
      taskId: context.task.taskId,
      definitionGeneration: context.task.definitionGeneration,
      contextRevisionDigest: context.contextDigest,
    },
    contextId: context.contextId,
    contextDigest: context.contextDigest,
    ordinal: value.ordinal,
    worker: {
      principalId: value.workerPrincipalId,
      roleKey: value.roleKey as ConsumerKey,
    },
    capabilities,
    promptPackDigest: value.promptPackDigest as Sha256Digest,
  };
  const dispatchDigest = canonicalDigest(canonicalValue(content), sha256);
  const derivedDispatchId = dispatchId(`dispatch_${dispatchDigest}`);
  return canonicalValue({ ...content, dispatchId: derivedDispatchId }) as unknown as WorkerDispatch;
}

function compileWorkerModelRouteSelection(
  value: unknown,
  context: WorkerContextBase,
  dispatch: WorkerDispatch,
  sha256: Sha256,
): WorkerModelRouteSelection {
  assertExactKeys(
    value,
    "worker model route selection input",
    [
      "routeIndex",
      "provider",
      "model",
      "maxTurns",
      "maxSubmissions",
      "maxMillidollars",
      "maxAiCredits",
    ],
    "invalid-route-selection",
  );
  if (!isNonNegativeSafeInteger(value.routeIndex)) {
    fail("invalid-route-selection", "Model route index must be a non-negative safe integer");
  }
  if (!isBoundedModelName(value.provider) || !isBoundedModelName(value.model)) {
    fail("invalid-route-selection", "Model provider and model must be explicit bounded strings");
  }
  if (value.provider === "auto" || value.model === "auto") {
    fail("invalid-route-selection", "Model provider and model cannot use auto routing");
  }
  for (const [name, limit] of [
    ["maxTurns", value.maxTurns],
    ["maxSubmissions", value.maxSubmissions],
    ["maxMillidollars", value.maxMillidollars],
  ] as const) {
    if (!isPositiveSafeInteger(limit)) {
      fail("invalid-route-selection", `${name} must be a positive safe integer`);
    }
  }
  if (
    typeof value.maxAiCredits !== "number" ||
    !Number.isFinite(value.maxAiCredits) ||
    value.maxAiCredits <= 0 ||
    Math.round(value.maxAiCredits * 1_000_000_000) < 1 ||
    !Number.isSafeInteger(Math.round(value.maxAiCredits * 1_000_000_000))
  ) {
    fail(
      "invalid-route-selection",
      "maxAiCredits must round to a positive safe integer nano-credit ceiling",
    );
  }
  const content = {
    apiVersion: WORKER_MODEL_ROUTE_SELECTION_API_VERSION,
    dispatchId: dispatch.dispatchId,
    contextId: context.contextId,
    contextDigest: context.contextDigest,
    modelPolicy: {
      ...context.modelPolicy,
      routeIndex: value.routeIndex,
      provider: value.provider,
      model: value.model,
    },
    limits: {
      maxTurns: value.maxTurns,
      maxSubmissions: value.maxSubmissions,
      maxMillidollars: value.maxMillidollars,
      maxAiCredits: value.maxAiCredits,
    },
  };
  const selectionDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, selectionDigest }) as unknown as WorkerModelRouteSelection;
}

function dependencyAssessment(
  value: unknown,
  index: number,
  sha256: Sha256,
): TaskDependencyAssessment {
  assertExactKeys(value, `dependency assessment ${index}`, [
    "task",
    "disposition",
    "assessmentDigest",
    "authorityFact",
  ]);
  const task = taskGenerationReference(value.task, `dependency assessment ${index} task`);
  if (!isTerminalDisposition(value.disposition)) {
    fail("invalid-barrier", `Dependency assessment ${index} disposition is not recognized`);
  }
  assertDigest(value.assessmentDigest, "assessmentDigest", "invalid-barrier");
  const authorityFact = value.authorityFact as CanonicalValue;
  const authorityFactDigest = canonicalDigest(authorityFact, sha256);
  return {
    task,
    disposition: value.disposition,
    assessmentDigest: value.assessmentDigest as Sha256Digest,
    authorityFact,
    authorityFactDigest,
  };
}

function contextContracts(value: unknown): ImmutableContextContractReference[] {
  if (!Array.isArray(value)) {
    fail("invalid-context", "Worker context contracts must be an array");
  }
  const contracts = value.map((contract, index) => {
    assertExactKeys(contract, `worker context contract ${index}`, [
      "kind",
      "key",
      "contractDigest",
    ]);
    if (!isContextContractKind(contract.kind) || !isConsumerKey(contract.key)) {
      fail("invalid-context", `Worker context contract ${index} has an invalid kind or key`);
    }
    assertDigest(contract.contractDigest, "contractDigest", "invalid-context");
    return contract as unknown as ImmutableContextContractReference;
  });
  const seen = new Set<string>();
  for (const contract of contracts) {
    const identity = `${contract.kind}\u0000${contract.key}`;
    if (seen.has(identity)) {
      fail("duplicate-contract", `Contract ${contract.kind}/${contract.key} is selected twice`);
    }
    seen.add(identity);
  }
  return contracts.sort(
    (left, right) =>
      compareText(left.kind, right.kind) ||
      compareText(left.key, right.key) ||
      compareText(left.contractDigest, right.contractDigest),
  );
}

function historicalAssetBindings(value: unknown, sha256: Sha256): HistoricalAssetBinding[] {
  if (!Array.isArray(value)) {
    fail("invalid-context", "Worker context assets must be an array");
  }
  const bindings = value.map((binding, index) => {
    assertExactKeys(binding, `worker context asset ${index}`, [
      "semanticAssetId",
      "aliasBindingDigest",
      "contentDigest",
      "mediaType",
      "sensitivity",
      "byteLength",
    ]);
    if (!isAssetId(binding.semanticAssetId)) {
      fail("invalid-context", `Worker context asset ${index} has an invalid semantic asset id`);
    }
    assertDigest(binding.aliasBindingDigest, "aliasBindingDigest", "invalid-context");
    assertDigest(binding.contentDigest, "contentDigest", "invalid-context");
    if (!isMediaType(binding.mediaType) || !isAssetSensitivity(binding.sensitivity)) {
      fail("invalid-context", `Worker context asset ${index} has invalid media metadata`);
    }
    if (!isNonNegativeSafeInteger(binding.byteLength)) {
      fail("invalid-context", `Worker context asset ${index} byteLength is invalid`);
    }
    const content = binding as unknown as HistoricalAssetBindingInput;
    const bindingDigest = canonicalDigest(canonicalValue(content), sha256);
    return { ...content, assetBindingId: assetBindingId(`asset-binding_${bindingDigest}`) };
  });
  const semanticIds = new Set<string>();
  const bindingIds = new Set<string>();
  for (const binding of bindings) {
    if (semanticIds.has(binding.semanticAssetId) || bindingIds.has(binding.assetBindingId)) {
      fail("duplicate-asset", `Asset binding ${binding.semanticAssetId} is selected twice`);
    }
    semanticIds.add(binding.semanticAssetId);
    bindingIds.add(binding.assetBindingId);
  }
  return bindings.sort((left, right) => compareText(left.semanticAssetId, right.semanticAssetId));
}

function repositoryBaseReference(value: unknown): RepositoryBase {
  assertExactKeys(value, "repository base", ["commitDigest", "treeDigest"]);
  assertDigest(value.commitDigest, "commitDigest", "invalid-context");
  assertDigest(value.treeDigest, "treeDigest", "invalid-context");
  return value as unknown as RepositoryBase;
}

function modelPolicyReference(value: unknown): ContextModelPolicyReference {
  assertExactKeys(value, "model policy reference", ["key", "policyDigest", "orderedRoutesDigest"]);
  if (!isConsumerKey(value.key)) {
    fail("invalid-context", "Model policy key is invalid");
  }
  assertDigest(value.policyDigest, "policyDigest", "invalid-context");
  assertDigest(value.orderedRoutesDigest, "orderedRoutesDigest", "invalid-context");
  return value as unknown as ContextModelPolicyReference;
}

function roleReference(value: unknown): ContextRoleReference {
  assertExactKeys(value, "role reference", ["key", "roleDigest"]);
  if (!isConsumerKey(value.key)) {
    fail("invalid-context", "Role key is invalid");
  }
  assertDigest(value.roleDigest, "roleDigest", "invalid-context");
  return value as unknown as ContextRoleReference;
}

function capabilitySet(value: unknown, code: ContextErrorCode): string[] {
  if (!Array.isArray(value)) {
    fail(code, "Capabilities must be an array");
  }
  const capabilities = value.map((capability) => {
    if (!isCapability(capability)) {
      fail(code, "Capabilities must use bounded lowercase capability names");
    }
    return capability;
  });
  assertUnique(capabilities, "duplicate-capability", "Capability");
  return capabilities.sort(compareText);
}

function contextBudgets(value: unknown): ContextBudget[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("invalid-context", "Worker context budgets must be a non-empty array");
  }
  const budgets = value.map((budget, index) => {
    assertExactKeys(budget, `worker context budget ${index}`, ["unit", "limit"]);
    if (!isBudgetUnit(budget.unit) || !isPositiveSafeInteger(budget.limit)) {
      fail("invalid-context", `Worker context budget ${index} has an invalid unit or limit`);
    }
    return budget as unknown as ContextBudget;
  });
  assertUnique(
    budgets.map((budget) => budget.unit),
    "duplicate-budget",
    "Budget",
  );
  return budgets.sort((left, right) => compareText(left.unit, right.unit));
}

function contextTask(
  value: unknown,
  label: string,
  code: "invalid-context" | "invalid-barrier",
): ContextTaskInput {
  assertExactKeys(value, label, ["taskId", "definitionGeneration"]);
  if (!isTaskId(value.taskId) || !isDefinitionGeneration(value.definitionGeneration)) {
    fail(code, `${label} is not an exact task generation seed`);
  }
  return value as unknown as ContextTaskInput;
}

function taskGenerationReference(value: unknown, label: string): TaskGenerationReference {
  assertExactKeys(value, label, ["taskId", "definitionGeneration", "contextRevisionDigest"]);
  if (
    !isTaskId(value.taskId) ||
    !isDefinitionGeneration(value.definitionGeneration) ||
    !isSha256Digest(value.contextRevisionDigest)
  ) {
    fail("invalid-barrier", `${label} is not an exact task generation reference`);
  }
  return value as unknown as TaskGenerationReference;
}

function snapshotCanonical(value: unknown, code: ContextErrorCode, label: string): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    return fail(code, `${label} must be stable canonical JSON values`);
  }
}

function assertExactKeys(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
  code: ContextErrorCode = "invalid-context",
): asserts value is Record<string, CanonicalValue> {
  if (!isRecord(value)) {
    fail(code, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} must contain exactly ${expected.join(", ")}`);
  }
}

function isBoundedModelName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 1_024 && !value.includes("\0")
  );
}

function assertExactRecompilation(
  submitted: CanonicalValue,
  recompiled: unknown,
  code: ContextErrorCode,
  label: string,
): void {
  if (canonicalSerialize(submitted) !== canonicalSerialize(recompiled as CanonicalValue)) {
    fail(code, `${label} does not match its exact canonical recompilation`);
  }
}

function assertDigest(
  value: unknown,
  label: string,
  code: ContextErrorCode,
): asserts value is Sha256Digest {
  if (!isSha256Digest(value)) {
    fail(code, `${label} must be a SHA-256 digest`);
  }
}

function assertUnique(values: readonly string[], code: ContextErrorCode, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail(code, `${label} ${value} is declared more than once`);
    }
    seen.add(value);
  }
}

function isRecord(value: unknown): value is Record<string, CanonicalValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextContractKind(value: unknown): value is ContextContractKind {
  return CONTEXT_CONTRACT_KINDS.includes(value as ContextContractKind);
}

function isTerminalDisposition(value: unknown): value is TerminalDisposition {
  return ["completed", "blocked", "waived", "skipped", "superseded"].includes(
    value as TerminalDisposition,
  );
}

function isBudgetUnit(value: unknown): value is BudgetUnit {
  return BUDGET_UNITS.includes(value as BudgetUnit);
}

function isAssetSensitivity(value: unknown): value is AssetSensitivity {
  return ["public", "internal", "confidential", "restricted"].includes(value as AssetSensitivity);
}

function isCapability(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9.-]{0,127}$/u.test(value);
}

function isMediaType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 127 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)
  );
}

function isRepositoryId(value: unknown): value is string {
  return (
    typeof value === "string" && /^repository_[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)
  );
}

function isPrincipalId(value: unknown): value is string {
  return (
    typeof value === "string" && /^principal_[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: ContextErrorCode, message: string): never {
  throw new ContextError(code, message);
}
