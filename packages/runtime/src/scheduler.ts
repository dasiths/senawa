export type RuntimeWorkspaceMode = "repository" | "worktree";
export type RuntimeFailurePolicy = "continue" | "fail-fast";

export interface RuntimeExecutionPolicy {
  readonly workspaceMode: RuntimeWorkspaceMode;
  readonly maxWriterConcurrency: number;
  readonly failurePolicy: RuntimeFailurePolicy;
}

export interface SchedulerLimits {
  readonly supervisorWriterLimit: number;
  readonly hostWriterLimit: number;
  readonly availableDurableWriterCapacity: number;
}

export interface ReadyTaskFact {
  readonly taskId: string;
  readonly definitionGeneration: number;
}

export interface ReadyEffectFact {
  readonly taskId: string;
  readonly operationId: string;
  readonly status: "queued" | "active" | "unknown" | "completed" | "failed" | "cancelled";
}

export interface ReadySiblingBatchMember {
  readonly taskId: string;
  readonly definitionGeneration: number;
  readonly operationId: string;
}

export interface ReadySiblingBatchPlan {
  readonly effectiveWriterLimit: number;
  readonly members: readonly ReadySiblingBatchMember[];
}

export interface SiblingExecutionFact {
  readonly taskId: string;
  readonly operationId: string;
  readonly status: ReadyEffectFact["status"];
}

export type FailurePolicyAction =
  | { readonly type: "stop-new-writer-admission" }
  | { readonly type: "fence-task"; readonly taskId: string }
  | { readonly type: "request-cancellation"; readonly operationId: string };

export function effectiveWriterLimit(
  policy: RuntimeExecutionPolicy,
  limits: SchedulerLimits,
): number {
  validateExecutionPolicy(policy);
  validateLimit(limits.supervisorWriterLimit, "supervisor writer limit");
  validateLimit(limits.hostWriterLimit, "host writer limit");
  validateLimit(limits.availableDurableWriterCapacity, "durable writer capacity", true);
  const workflowLimit = policy.workspaceMode === "repository" ? 1 : policy.maxWriterConcurrency;
  return Math.min(
    workflowLimit,
    limits.supervisorWriterLimit,
    limits.hostWriterLimit,
    limits.availableDurableWriterCapacity,
  );
}

export function planReadySiblingBatch(
  policy: RuntimeExecutionPolicy,
  limits: SchedulerLimits,
  readyTasks: readonly ReadyTaskFact[],
  effects: readonly ReadyEffectFact[],
): ReadySiblingBatchPlan {
  const limit = effectiveWriterLimit(policy, limits);
  const readyByTask = new Map<string, ReadyTaskFact>();
  for (const task of readyTasks) {
    validateIdentity(task.taskId, "ready task identity");
    if (!Number.isSafeInteger(task.definitionGeneration) || task.definitionGeneration < 1) {
      throw new TypeError("Ready task generation must be a positive safe integer");
    }
    if (readyByTask.has(task.taskId)) throw new TypeError("Ready task facts must be unique");
    readyByTask.set(task.taskId, task);
  }
  const operationIds = new Set<string>();
  const members = effects
    .flatMap((effect) => {
      validateIdentity(effect.taskId, "effect task identity");
      validateIdentity(effect.operationId, "effect operation identity");
      if (operationIds.has(effect.operationId)) {
        throw new TypeError("Ready effect operation facts must be unique");
      }
      operationIds.add(effect.operationId);
      const task = readyByTask.get(effect.taskId);
      return effect.status === "queued" && task !== undefined
        ? [{ ...task, operationId: effect.operationId }]
        : [];
    })
    .sort(compareBatchMember)
    .slice(0, limit);
  return Object.freeze({
    effectiveWriterLimit: limit,
    members: Object.freeze(members.map((member) => Object.freeze(member))),
  });
}

export function planFailurePolicyActions(
  policy: RuntimeFailurePolicy,
  siblings: readonly SiblingExecutionFact[],
): readonly FailurePolicyAction[] {
  const ordered = [...siblings].sort(compareSiblingFact);
  if (!ordered.some(({ status }) => status === "failed")) return Object.freeze([]);
  if (policy === "continue") {
    return Object.freeze(
      ordered
        .filter(({ status }) => status === "failed")
        .map(({ taskId }) => Object.freeze({ type: "fence-task" as const, taskId })),
    );
  }
  if (policy !== "fail-fast") throw new TypeError("Failure policy must be continue or fail-fast");
  const taskIds = [...new Set(ordered.map(({ taskId }) => taskId))].sort(compareText);
  return Object.freeze([
    Object.freeze({ type: "stop-new-writer-admission" as const }),
    ...taskIds.map((taskId) => Object.freeze({ type: "fence-task" as const, taskId })),
    ...ordered
      .filter(({ status }) => status === "active" || status === "unknown")
      .map(({ operationId }) =>
        Object.freeze({ type: "request-cancellation" as const, operationId }),
      ),
  ]);
}

function validateExecutionPolicy(policy: RuntimeExecutionPolicy): void {
  if (policy.workspaceMode !== "repository" && policy.workspaceMode !== "worktree") {
    throw new TypeError("Workspace mode must be repository or worktree");
  }
  validateLimit(policy.maxWriterConcurrency, "workflow writer limit");
  if (policy.workspaceMode === "repository" && policy.maxWriterConcurrency !== 1) {
    throw new TypeError("Repository mode requires exactly one workflow writer");
  }
  if (policy.failurePolicy !== "continue" && policy.failurePolicy !== "fail-fast") {
    throw new TypeError("Failure policy must be continue or fail-fast");
  }
}

function validateLimit(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
}

function validateIdentity(value: string, label: string): void {
  if (value.length === 0 || value.length > 128) throw new TypeError(`${label} must be bounded`);
}

function compareBatchMember(left: ReadySiblingBatchMember, right: ReadySiblingBatchMember): number {
  return compareText(left.taskId, right.taskId) || compareText(left.operationId, right.operationId);
}

function compareSiblingFact(left: SiblingExecutionFact, right: SiblingExecutionFact): number {
  return compareText(left.taskId, right.taskId) || compareText(left.operationId, right.operationId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
