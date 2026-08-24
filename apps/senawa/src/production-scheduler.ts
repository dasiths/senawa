import {
  bindGitObjectId,
  createIntegrationBarrier,
  deriveReadyTaskFrontier,
  type GitRevisionDescriptor,
  type IntegrationBarrier,
  type IntegrationMemberInput,
  type TaskStatusFact,
} from "@senawa/kernel";
import { canonicalBytes, decodeCanonicalJsonValue, type JsonValue } from "@senawa/protocol";
import {
  type EffectOutcome,
  effectiveWriterLimit,
  type RegisteredWorkerEffectSeed,
  type RunnerLeaseFact,
  type RuntimeSchedulingSnapshot,
  type StoredDispatch,
} from "@senawa/runtime";
import type {
  SqliteContextBroker,
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "@senawa/storage-sqlite";
import type { SqliteSupervisorAuthority } from "@senawa/supervisor";

const MAX_INTEGRATION_ATTEMPTS = 2;

export interface ProductionSchedulerOptions {
  readonly authority: SqliteSupervisorAuthority;
  readonly runnerAuthority: SqliteRunnerAuthority;
  readonly workspaceAuthority: SqliteWorkspaceIntegrationAuthority;
  readonly contextBroker: SqliteContextBroker;
  readonly supervisorWriterLimit: number;
  readonly hostWriterLimit: number;
  readonly sha256: { digest(bytes: Uint8Array): string };
}

export interface ProductionScheduleInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly lease: RunnerLeaseFact;
  readonly currentTime: string;
}

export interface ProductionScheduleResult {
  readonly worked: boolean;
  readonly batchSize: number;
}

export class ProductionScheduler {
  readonly #options: ProductionSchedulerOptions;
  /** The last decline reported per run, so a stalled run says it once. */
  readonly #declined = new Map<string, string>();

  constructor(options: ProductionSchedulerOptions) {
    this.#options = options;
  }

  listRuns(): readonly { readonly repositoryId: string; readonly runId: string }[] {
    const keys = new Set<string>();
    return Object.freeze(
      this.#options.contextBroker.authority
        .snapshot()
        .dispatches.flatMap((dispatch) => {
          const key = `${dispatch.repositoryId}\0${dispatch.runId}`;
          if (keys.has(key)) return [];
          keys.add(key);
          return [{ repositoryId: dispatch.repositoryId, runId: dispatch.runId }];
        })
        .sort((left, right) =>
          left.repositoryId < right.repositoryId
            ? -1
            : left.repositoryId > right.repositoryId
              ? 1
              : left.runId < right.runId
                ? -1
                : left.runId > right.runId
                  ? 1
                  : 0,
        ),
    );
  }

  listFreshDispatchRequirements(repositoryId: string, runId: string) {
    return this.#options.authority.commandAuthority.listFreshDispatchRequirements(
      repositoryId,
      runId,
    );
  }

  schedule(input: ProductionScheduleInput): ProductionScheduleResult {
    const runControl = this.#options.authority.commandAuthority.queryRunControl(
      input.repositoryId,
      input.runId,
    );
    if (runControl !== undefined && runControl.mode !== "running") {
      return { worked: false, batchSize: 1 };
    }
    // A requirement names one stale dispatch, not a stale run. Refusing to
    // schedule anything while one was outstanding also refused the fresh
    // dispatch created to carry the answer, so a second answer arriving before
    // that dispatch had run left the run unable to schedule either: the answer
    // could only be delivered by a dispatch, and no dispatch could be scheduled
    // while the answer was undelivered.
    const outstanding = this.listFreshDispatchRequirements(input.repositoryId, input.runId);
    const runtime = this.#options.authority.commandAuthority.queryRunScheduling(
      input.repositoryId,
      input.runId,
    );
    const runtimeBinding = this.#options.authority.commandAuthority.queryRunExecution(
      input.repositoryId,
      input.runId,
    );
    if (runtime === undefined || runtimeBinding === undefined) {
      return { worked: false, batchSize: 1 };
    }
    const dispatches = schedulableDispatches(
      selectCurrentDispatches(
        runtime,
        this.#options.contextBroker.authority.snapshot().taskScopes,
        this.#options.contextBroker.listWorkerDispatches(input.repositoryId, input.runId),
      ),
      outstanding,
    );
    if (dispatches === undefined || dispatches.length === 0) {
      return { worked: false, batchSize: 1 };
    }
    this.#configureRunner(input, dispatches, runtimeBinding.execution.maxWriterConcurrency);
    this.#options.runnerAuthority.bindAllowancePolicy(
      input.repositoryId,
      input.runId,
      runtimeBinding.allowancePolicy,
    );
    const binding =
      this.#options.workspaceAuthority.loadRunExecution(input.repositoryId, input.runId) ??
      this.#options.workspaceAuthority.bindRunExecution(runtimeBinding);
    const snapshot = this.#options.runnerAuthority.load(input);
    const available = snapshot.capacities.find(({ resource }) => resource === "writer")?.limit ?? 0;
    const occupied =
      snapshot.capacities.find(({ resource }) => resource === "writer")?.occupied ?? 0;
    const batchSize = Math.max(
      1,
      effectiveWriterLimit(binding.execution, {
        supervisorWriterLimit: this.#options.supervisorWriterLimit,
        hostWriterLimit: this.#options.hostWriterLimit,
        availableDurableWriterCapacity: Math.max(0, available - occupied),
      }),
    );
    const ready = this.#ready(runtime, dispatches, snapshot.effects);
    const worked =
      binding.execution.workspaceMode === "repository"
        ? this.#scheduleRepository(input, dispatches, ready.tasks)
        : this.#scheduleWorktree(input, runtime, dispatches, ready.tasks);
    this.#recordDecline(input, dispatches, ready, worked);
    return { worked, batchSize };
  }

  /**
   * A run holding dispatches that none of them can be scheduled is a stall, and
   * `worked: false` is what an idle run says too. Three wrong diagnoses came
   * from not being able to tell those apart, so the frontier's reasoning is
   * written down the first time it declines everything, and again only when the
   * reason changes.
   */
  #recordDecline(
    input: ProductionScheduleInput,
    dispatches: readonly StoredDispatch[],
    ready: { readonly tasks: ReadonlySet<string>; readonly facts: readonly TaskStatusFact[] },
    worked: boolean,
  ): void {
    const key = `${input.repositoryId}\u0000${input.runId}`;
    if (worked || dispatches.length === 0) {
      this.#declined.delete(key);
      return;
    }
    const held = dispatches
      .filter(({ taskScope }) => !ready.tasks.has(taskScope.taskId))
      .map(({ taskScope }) => {
        const fact = ready.facts.find(({ taskId }) => taskId === taskScope.taskId);
        return `${String(taskScope.taskId)} ${fact?.status ?? "unknown"}`;
      })
      .sort();
    if (held.length === 0) return;
    const reason = declineReason(held);
    if (this.#declined.get(key) === reason) return;
    this.#declined.set(key, reason);
    this.#options.authority.appendLog({
      recordedAt: input.currentTime,
      level: "warn",
      event: "schedule-declined",
      message: reason,
      fields: { repositoryId: input.repositoryId, runId: input.runId, held },
    });
  }

  #configureRunner(
    input: ProductionScheduleInput,
    dispatches: readonly StoredDispatch[],
    writerLimit: number,
  ): void {
    const additions = runnerBudgetAdditions(dispatches);
    if (this.#options.runnerAuthority.isConfigured(input.repositoryId, input.runId)) {
      const snapshot = this.#options.runnerAuthority.load(input);
      const admittedScopes = new Set(snapshot.taskScopes.map(taskScopeIdentity));
      const newDispatches = dispatches.filter(
        ({ taskScope }) => !admittedScopes.has(taskScopeIdentity(taskScope)),
      );
      const budgets = new Map(
        this.#options.runnerAuthority
          .queryBudgets(input.repositoryId, input.runId)
          .map(({ unit, limit }) => [unit, limit] as const),
      );
      for (const [unit, amount] of runnerBudgetAdditions(newDispatches)) {
        budgets.set(unit, (budgets.get(unit) ?? 0) + amount);
      }
      this.#options.runnerAuthority.ensureTaskScopesAndBudgets({
        repositoryId: input.repositoryId,
        runId: input.runId,
        lease: input.lease,
        currentTime: input.currentTime,
        taskScopes: dispatches.map(({ taskScope }) => ({ ...taskScope, claimsAccepted: true })),
        budgets: [...budgets].map(([unit, limit]) => ({ unit, limit })),
      });
      return;
    }
    this.#options.runnerAuthority.configureRun({
      repositoryId: input.repositoryId,
      runId: input.runId,
      contextDigest: this.#options.sha256.digest(
        canonicalBytes(dispatches.map(({ context }) => context.contextDigest)),
      ),
      taskScopes: dispatches.map(({ taskScope }) => ({ ...taskScope, claimsAccepted: true })),
      budgets: [...additions].map(([unit, limit]) => ({ unit, limit })),
      capacities: [{ resource: "writer", limit: writerLimit, occupied: 0 }],
      lease: input.lease,
    });
  }

  #ready(
    runtime: RuntimeSchedulingSnapshot,
    dispatches: readonly StoredDispatch[],
    effects: ReturnType<SqliteRunnerAuthority["load"]>["effects"],
  ): { readonly tasks: ReadonlySet<string>; readonly facts: readonly TaskStatusFact[] } {
    const accepted = new Map(
      runtime.acceptedTasks.map(
        (task) => [`${task.task.taskId}\0${task.task.definitionGeneration}`, task] as const,
      ),
    );
    const facts: TaskStatusFact[] = [];
    for (const node of runtime.graph.nodes) {
      if (node.kind !== "task") continue;
      const acceptedTask = accepted.get(`${node.definition.id}\0${node.definition.generation}`);
      if (acceptedTask !== undefined) {
        facts.push({
          taskId: node.definition.id,
          definitionGeneration: node.definition.generation,
          status: "accepted",
          accountingAssessmentDigest: acceptedTask.accountingAssessmentDigest,
          ...(acceptedTask.integrationBarrierDigest === undefined
            ? {}
            : { integrationBarrierDigest: acceptedTask.integrationBarrierDigest }),
        });
        continue;
      }
      const dispatchIds = new Set<string>(
        dispatches
          .filter(({ taskScope }) => taskScope.taskId === node.definition.id)
          .map(({ dispatch }) => String(dispatch.dispatchId)),
      );
      const worker = effects.find(
        ({ intent }) =>
          intent.command.kind === "worker" &&
          dispatchIds.has(workerDispatchId(intent.command.input) ?? ""),
      );
      const status =
        worker === undefined
          ? "pending"
          : worker.outcome?.status === "failed"
            ? "failed"
            : worker.outcome?.status === "cancelled"
              ? "cancelled"
              : "active";
      facts.push({
        taskId: node.definition.id,
        definitionGeneration: node.definition.generation,
        status,
      });
    }
    return {
      tasks: new Set(
        deriveReadyTaskFrontier(runtime.graph, facts, this.#options.sha256).tasks.map(
          ({ taskId }) => taskId,
        ),
      ),
      facts,
    };
  }

  #scheduleRepository(
    input: ProductionScheduleInput,
    dispatches: readonly StoredDispatch[],
    ready: ReadonlySet<string>,
  ): boolean {
    let worked = false;
    const runner = this.#options.runnerAuthority.load(input);
    for (const dispatch of dispatches) {
      if (!ready.has(dispatch.taskScope.taskId)) continue;
      // The command line dispatches in its own process, so a worker effect may
      // already exist for this dispatch. Enqueuing a second one collides on the
      // stage identity and takes the daemon down with it.
      const dispatched = runner.effects.some(
        ({ intent }) =>
          intent.command.kind === "worker" &&
          workerDispatchId(intent.command.input) === dispatch.dispatch.dispatchId,
      );
      if (dispatched) continue;
      worked =
        this.#enqueue(input, dispatch, "02-worker", "worker", required(dispatch.effect).input) ||
        worked;
    }
    return worked;
  }

  #scheduleWorktree(
    input: ProductionScheduleInput,
    runtime: RuntimeSchedulingSnapshot,
    dispatches: readonly StoredDispatch[],
    ready: ReadonlySet<string>,
  ): boolean {
    let worked = false;
    const workspaces = this.#options.workspaceAuthority.listWorkspaces(
      input.repositoryId,
      input.runId,
    );
    const results = this.#options.workspaceAuthority.listWorkspaceResults(
      input.repositoryId,
      input.runId,
    );
    const runner = this.#options.runnerAuthority.load(input);
    for (const dispatch of dispatches) {
      const effect = required(dispatch.effect);
      if (
        !ready.has(dispatch.taskScope.taskId) &&
        !workspaces.some(({ dispatchId }) => dispatchId === dispatch.dispatch.dispatchId)
      ) {
        continue;
      }
      const workspaceId = stableId("workspace", dispatch.dispatch.dispatchId, this.#options.sha256);
      const resultId = stableId("result", dispatch.dispatch.dispatchId, this.#options.sha256);
      const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId);
      if (workspace === undefined) {
        const baseRevision = required(effect.baseRevision);
        worked =
          this.#enqueue(input, dispatch, "01-prepare", "git", {
            operation: "prepare-workspace",
            workspaceId,
            dispatchId: dispatch.dispatch.dispatchId,
            taskId: dispatch.taskScope.taskId,
            definitionGeneration: dispatch.taskScope.definitionGeneration,
            baseRevision,
            inspectEffectId: stableId("inspect-prepare", workspaceId, this.#options.sha256),
          }) || worked;
        continue;
      }
      const worker = runner.effects.find(
        ({ intent }) =>
          intent.command.kind === "worker" &&
          workerDispatchId(intent.command.input) === dispatch.dispatch.dispatchId,
      );
      if (workspace.state === "prepared" && worker === undefined) {
        worked =
          this.#enqueue(input, dispatch, "02-worker", "worker", {
            operation: "dispatch-worker",
            workspaceId,
            worker: effect.input,
          }) || worked;
        continue;
      }
      if (
        worker?.outcome?.status === "completed" &&
        !results.some(({ resultId: id }) => id === resultId)
      ) {
        const completionFact = this.#options.contextBroker
          .loadWorkerDispatchProgress(dispatch.dispatch.dispatchId)
          ?.submissions.find(({ completionFact }) => completionFact !== undefined)?.completionFact;
        if (completionFact !== undefined) {
          worked =
            this.#enqueue(input, dispatch, "03-capture", "git", {
              operation: "capture-workspace",
              workspaceId,
              resultId,
              completionFactDigest: this.#options.sha256.digest(canonicalBytes(completionFact)),
              inspectEffectId: stableId("inspect-capture", resultId, this.#options.sha256),
              message: `Capture ${dispatch.taskScope.taskId}`,
            }) || worked;
        }
      }
    }
    if (worked) return true;
    return this.#scheduleIntegration(input, runtime, dispatches);
  }

  #scheduleIntegration(
    input: ProductionScheduleInput,
    runtime: RuntimeSchedulingSnapshot,
    dispatches: readonly StoredDispatch[],
  ): boolean {
    const results = this.#options.workspaceAuthority.listWorkspaceResults(
      input.repositoryId,
      input.runId,
    );
    if (results.length === 0) return false;
    const runner = this.#options.runnerAuthority.load(input);
    const currentDispatchIds = new Set(
      dispatches.map(({ dispatch }) => String(dispatch.dispatchId)),
    );
    const unsettledWorker = runner.effects.some(
      ({ intent, outcome }) =>
        intent.command.kind === "worker" &&
        currentDispatchIds.has(workerDispatchId(intent.command.input) ?? "") &&
        outcome?.status === undefined,
    );
    if (unsettledWorker) return false;
    const allAttempts = this.#options.workspaceAuthority.listIntegrationAttempts(
      input.repositoryId,
      input.runId,
    );
    const workspaces = this.#options.workspaceAuthority.listWorkspaces(
      input.repositoryId,
      input.runId,
    );
    const memberFacts = dispatches.flatMap((dispatch) => {
      const workspaceId = stableId("workspace", dispatch.dispatch.dispatchId, this.#options.sha256);
      const resultId = stableId("result", dispatch.dispatch.dispatchId, this.#options.sha256);
      const matchingWorkspaces = workspaces.filter(
        (workspace) =>
          workspace.workspaceId === workspaceId &&
          workspace.dispatchId === dispatch.dispatch.dispatchId &&
          workspace.taskId === dispatch.taskScope.taskId &&
          workspace.definitionGeneration === dispatch.taskScope.definitionGeneration,
      );
      const matchingResults = results.filter(
        (result) => result.resultId === resultId && result.workspaceId === workspaceId,
      );
      if (matchingWorkspaces.length > 1 || matchingResults.length > 1) {
        throw new TypeError("Current integration member selection is ambiguous");
      }
      const workspace = matchingWorkspaces[0];
      const result = matchingResults[0];
      return workspace === undefined || result === undefined
        ? []
        : [{ result, workspace, dispatch, effect: required(dispatch.effect) }];
    });
    if (memberFacts.length === 0) return false;
    const beforeRevision = commonBaseRevision(memberFacts.map(({ effect }) => effect));
    const memberInputs: IntegrationMemberInput[] = memberFacts.map(
      ({ result, workspace, dispatch }) => ({
        taskId: dispatch.taskScope.taskId as IntegrationMemberInput["taskId"],
        definitionGeneration: dispatch.taskScope
          .definitionGeneration as IntegrationMemberInput["definitionGeneration"],
        contextDigest: dispatch.context.contextDigest,
        baseRevisionDigest: workspace.baseRevision.descriptorDigest,
        resultTreeDigest: bindGitObjectId(result.resultRevision.revision.tree, this.#options.sha256)
          .descriptorDigest,
        completionFactDigest:
          result.completionFactDigest as IntegrationMemberInput["completionFactDigest"],
      }),
    );
    const policyDigest = commonPolicyDigest(
      memberFacts.map(({ effect }) => effect),
      runtime.graph.revisionDigest,
    );
    const provisional = createIntegrationBarrier(
      {
        phaseId: runtime.phase.phaseId,
        definitionGeneration: runtime.phase.definitionGeneration,
        graphRevisionDigest: runtime.graph.revisionDigest,
        targetRef: required(
          this.#options.workspaceAuthority.loadRunExecution(input.repositoryId, input.runId)
            ?.execution.integrationRef,
        ),
        beforeRevision,
        afterRevision: beforeRevision,
        members: memberInputs,
        gatePolicyDigest: policyDigest as IntegrationBarrier["gatePolicyDigest"],
        gateReadingDigest: "0".repeat(64) as IntegrationBarrier["gateReadingDigest"],
        gateEvaluationDigest: "0".repeat(64) as IntegrationBarrier["gateEvaluationDigest"],
        outcome: "integrated",
      },
      this.#options.sha256,
    );
    const attempts = allAttempts.filter(
      (attempt) =>
        attempt.phaseId === runtime.phase.phaseId &&
        attempt.definitionGeneration === runtime.phase.definitionGeneration &&
        attempt.fanInDigest === provisional.fanInDigest,
    );
    const current = attempts.at(-1);
    if (current?.state === "barrier-recorded") {
      let worked = false;
      for (const { workspace, dispatch } of memberFacts) {
        if (workspace.state !== "removed") {
          worked =
            this.#enqueue(input, dispatch, "08-cleanup", "git", {
              operation: "remove-workspace",
              workspaceId: workspace.workspaceId,
            }) || worked;
        }
      }
      return worked;
    }
    const retryable = current?.state === "rework-required";
    if (current !== undefined && terminalIntegrationState(current.state) && !retryable)
      return false;
    if (retryable && attempts.length >= MAX_INTEGRATION_ATTEMPTS) return false;
    const ordinal = allAttempts.length + 1;
    const integrationId = stableId(
      `integration-${ordinal}`,
      provisional.fanInDigest,
      this.#options.sha256,
    );
    const stageDispatch = memberFacts[0]?.dispatch;
    if (stageDispatch === undefined) return false;
    if (current === undefined || terminalIntegrationState(current.state)) {
      return this.#enqueue(input, stageDispatch, `04-integration-${ordinal}`, "git", {
        operation: "prepare-integration",
        integrationId,
        phaseId: runtime.phase.phaseId,
        definitionGeneration: runtime.phase.definitionGeneration,
        targetRef: provisional.targetRef,
        fanInDigest: provisional.fanInDigest,
        beforeRevision,
        members: memberFacts.map(({ result, workspace }, index) => ({
          workspaceId: workspace.workspaceId,
          resultId: result.resultId,
          member: required(provisional.members[index]),
          resultRevision: result.resultRevision.revision,
        })),
        inspectEffectId: stableId("inspect-integration", integrationId, this.#options.sha256),
      });
    }
    const candidateRevision = integrationCandidate(runner.effects, current.integrationId);
    if (
      current.state === "candidate-created" &&
      current.gate === undefined &&
      candidateRevision !== undefined
    ) {
      return this.#enqueue(input, stageDispatch, `05-validate-${ordinal}`, "git", {
        operation: "validate-integration",
        integrationId: current.integrationId,
        candidateRevision,
        policyDigest,
      });
    }
    if (
      current.state === "validating" &&
      current.gate?.decision === "passed" &&
      candidateRevision !== undefined
    ) {
      const barrier = createIntegrationBarrier(
        {
          phaseId: runtime.phase.phaseId,
          definitionGeneration: runtime.phase.definitionGeneration,
          graphRevisionDigest: runtime.graph.revisionDigest,
          targetRef: provisional.targetRef,
          beforeRevision,
          afterRevision: candidateRevision,
          members: memberInputs,
          gatePolicyDigest: current.gate.policyDigest as IntegrationBarrier["gatePolicyDigest"],
          gateReadingDigest: current.gate.readingDigest as IntegrationBarrier["gateReadingDigest"],
          gateEvaluationDigest: current.gate
            .evaluationDigest as IntegrationBarrier["gateEvaluationDigest"],
          outcome: "integrated",
        },
        this.#options.sha256,
      );
      return this.#enqueue(input, stageDispatch, `06-publish-${ordinal}`, "git", {
        operation: "publish-integration",
        integrationId: current.integrationId,
        expectedOld: beforeRevision,
        candidateRevision,
        barrier,
      });
    }
    return false;
  }

  #enqueue(
    input: ProductionScheduleInput,
    dispatch: StoredDispatch,
    stage: string,
    kind: "worker" | "git",
    effectInput: unknown,
  ): boolean {
    const effect = required(dispatch.effect);
    const identity = stableId(stage, dispatch.dispatch.dispatchId, this.#options.sha256);
    const canonicalInput = decodeCanonicalJsonValue(effectInput);
    return this.#options.runnerAuthority.enqueueIdempotent({
      sequence: stageSequence(stage),
      commandId: `command_${identity}`,
      repositoryId: input.repositoryId,
      runId: input.runId,
      operationId: `operation_${identity}`,
      kind,
      taskScope: dispatch.taskScope,
      contextDigest: dispatch.context.contextDigest,
      inputDigest: this.#options.sha256.digest(canonicalBytes(canonicalInput)),
      input: canonicalInput,
      budgetReservation:
        kind === "worker" ? effect.budgetReservation : { unit: "workspace-operations", amount: 1 },
      capacityReservation: { resource: "writer", amount: 1 },
      queuedAt: input.currentTime,
      maxReconciliationAttempts: 3,
    });
  }
}

function stableId(
  prefix: string,
  value: string,
  sha256: { digest(bytes: Uint8Array): string },
): string {
  return `${prefix}-${sha256.digest(canonicalBytes({ prefix, value })).slice(0, 32)}`;
}

function stageSequence(stage: string): number {
  const parsed = Number(stage.slice(0, 2));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 99;
}

function workerDispatchId(input: JsonValue): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, JsonValue>>;
  if (typeof record.dispatchId === "string") return record.dispatchId;
  const worker = record.worker;
  const workerRecord = worker as Readonly<Record<string, JsonValue>> | null;
  return workerRecord !== null && typeof workerRecord === "object" && !Array.isArray(workerRecord)
    ? typeof workerRecord.dispatchId === "string"
      ? workerRecord.dispatchId
      : undefined
    : undefined;
}

/**
 * The dispatches that may run while answers are still owed to earlier ones.
 *
 * A fresh dispatch requirement names the one dispatch an answer made stale. It
 * does not make the run stale, and in particular it does not make stale the
 * fresh dispatch created to carry that answer.
 */
export function schedulableDispatches(
  dispatches: readonly StoredDispatch[] | undefined,
  requirements: readonly { readonly historicalDispatchId: string }[],
): readonly StoredDispatch[] | undefined {
  if (dispatches === undefined) return undefined;
  const stale = new Set(requirements.map(({ historicalDispatchId }) => historicalDispatchId));
  return dispatches.filter((stored) => !stale.has(stored.dispatch.dispatchId));
}

/**
 * What a stalled run is holding, named by task and by the status that held it.
 *
 * `worked: false` is what an idle run says too, so a run that holds dispatches
 * none of which can be scheduled has to say which and why, or it is
 * indistinguishable from one with nothing to do.
 */
export function declineReason(held: readonly string[]): string {
  return `no dispatch is schedulable; the ready frontier holds ${held.join(", ")}`;
}

export function selectCurrentDispatches(
  runtime: RuntimeSchedulingSnapshot,
  taskScopes: readonly {
    readonly runId: string;
    readonly taskId: string;
    readonly definitionGeneration: number;
    readonly acceptedContextDigest: string;
    readonly fenceGeneration: number;
    readonly claimsAccepted: boolean;
  }[],
  dispatches: readonly StoredDispatch[],
): readonly StoredDispatch[] | undefined {
  const selected: StoredDispatch[] = [];
  for (const node of runtime.graph.nodes) {
    if (node.kind !== "task") continue;
    const scopes = taskScopes.filter(
      (scope) =>
        scope.claimsAccepted &&
        scope.taskId === node.definition.id &&
        scope.definitionGeneration === node.definition.generation,
    );
    if (scopes.length > 1) return undefined;
    const scope = scopes[0];
    if (scope === undefined) continue;
    const matches = dispatches.filter(
      (dispatch) =>
        dispatch.dispatch.task.taskId === node.definition.id &&
        dispatch.dispatch.task.definitionGeneration === node.definition.generation &&
        dispatch.context.contextDigest === scope.acceptedContextDigest &&
        sameTaskScope(dispatch.taskScope, scope),
    );
    if (matches.length > 1) return undefined;
    const dispatch = matches[0];
    if (dispatch?.effect !== undefined) selected.push(dispatch);
  }
  return Object.freeze(selected);
}

function sameTaskScope(
  left: StoredDispatch["taskScope"],
  right: StoredDispatch["taskScope"],
): boolean {
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.definitionGeneration === right.definitionGeneration &&
    left.acceptedContextDigest === right.acceptedContextDigest &&
    left.fenceGeneration === right.fenceGeneration
  );
}

function taskScopeIdentity(scope: StoredDispatch["taskScope"]): string {
  return [
    scope.runId,
    scope.taskId,
    scope.definitionGeneration,
    scope.acceptedContextDigest,
    scope.fenceGeneration,
  ].join("\0");
}

function runnerBudgetAdditions(dispatches: readonly StoredDispatch[]): Map<string, number> {
  const budgets = new Map<string, number>();
  for (const { context, effect } of dispatches) {
    for (const budget of context.budgets) {
      budgets.set(budget.unit, (budgets.get(budget.unit) ?? 0) + budget.limit);
    }
    if (effect !== undefined && !budgets.has(effect.budgetReservation.unit)) {
      budgets.set(effect.budgetReservation.unit, effect.budgetReservation.amount);
    }
  }
  if (dispatches.length > 0) {
    budgets.set("workspace-operations", dispatches.length * 10);
  }
  return budgets;
}

function integrationCandidate(
  effects: readonly {
    readonly intent: { readonly command: { readonly input: JsonValue } };
    readonly outcome?: EffectOutcome;
  }[],
  integrationId: string,
): GitRevisionDescriptor | undefined {
  const outcome = effects.find(({ intent }) => {
    const input = intent.command.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
    const record = input as Readonly<Record<string, JsonValue>>;
    return record.operation === "prepare-integration" && record.integrationId === integrationId;
  })?.outcome;
  const envelope = outcome?.details;
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope))
    return undefined;
  const details = (envelope as Readonly<Record<string, JsonValue>>).details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  return (details as Readonly<Record<string, JsonValue>>).candidateRevision as unknown as
    | GitRevisionDescriptor
    | undefined;
}

function commonBaseRevision(seeds: readonly RegisteredWorkerEffectSeed[]): GitRevisionDescriptor {
  const first = required(seeds[0]?.baseRevision);
  const digest = JSON.stringify(first);
  if (seeds.some(({ baseRevision }) => JSON.stringify(baseRevision) !== digest)) {
    throw new TypeError("Integration members must share one immutable base revision");
  }
  return first;
}

function commonPolicyDigest(
  seeds: readonly RegisteredWorkerEffectSeed[],
  fallback: string,
): string {
  const values = new Set(
    seeds.map(({ integrationGatePolicyDigest }) => integrationGatePolicyDigest ?? fallback),
  );
  if (values.size !== 1) throw new TypeError("Integration members have conflicting gate policies");
  return required(values.values().next().value);
}

function terminalIntegrationState(state: string): boolean {
  return [
    "barrier-recorded",
    "conflicted",
    "target-moved",
    "rework-required",
    "cancelled",
    "failed",
  ].includes(state);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Required production scheduler value is missing");
  return value;
}
