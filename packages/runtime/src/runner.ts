import type { JsonValue } from "@senawa/protocol";
import type {
  InstallTaskScopeFencesInput,
  TaskScopeCurrentness,
  TaskScopeFence,
} from "./task-currentness.js";

export type EffectKind = "worker" | "sensor" | "git" | "asset" | "time";

export type EffectStatus = "intent" | "active" | "completed" | "failed" | "cancelled" | "unknown";

export interface RunnerLeaseFact {
  readonly owner: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export interface EffectBudgetReservation {
  readonly unit: string;
  readonly amount: number;
}

export interface EffectCapacityReservation {
  readonly resource: "writer";
  readonly amount: number;
}

export interface EffectUsageReport {
  readonly unit: string;
  readonly amount: number;
}

export interface FinalizedEffectUsage {
  readonly unit: string;
  readonly reserved: number;
  readonly reported?: number;
  readonly unreported: number;
}

export interface QueuedEffectCommand {
  readonly sequence: number;
  readonly commandId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly kind: EffectKind;
  readonly taskScope: TaskScopeFence;
  readonly contextDigest: string;
  readonly inputDigest: string;
  readonly input: JsonValue;
  readonly budgetReservation: EffectBudgetReservation;
  readonly capacityReservation?: EffectCapacityReservation;
  readonly queuedAt: string;
  readonly deadline?: string;
  readonly maxReconciliationAttempts: number;
}

export interface EffectIntent {
  readonly command: QueuedEffectCommand;
  readonly owner: string;
  readonly fence: number;
  readonly attemptId: string;
  readonly status: "intent";
  readonly persistedAt: string;
}

export interface EffectObservation {
  readonly status: Exclude<EffectStatus, "intent">;
  readonly observedAt: string;
  readonly details?: JsonValue;
  readonly outputDigest?: string;
  readonly usage?: EffectUsageReport;
}

export interface EffectInspection {
  readonly status: "completed" | "active" | "missing" | "cancelled" | "unknown";
  readonly observedAt: string;
  readonly details?: JsonValue;
  readonly outputDigest?: string;
  readonly usage?: EffectUsageReport;
}

export interface EffectOutcome {
  readonly commandId: string;
  readonly operationId: string;
  readonly kind: EffectKind;
  readonly owner: string;
  readonly fence: number;
  readonly attemptId: string;
  readonly commandTaskScope: TaskScopeFence;
  readonly claimTaskScope: TaskScopeFence;
  readonly contextDigest: string;
  readonly inputDigest: string;
  readonly status: Exclude<EffectStatus, "intent">;
  readonly freshness: "current" | "stale";
  readonly observedAt: string;
  readonly reconciliationAttempts: number;
  readonly usage: FinalizedEffectUsage;
  readonly origin: EffectAttemptOrigin;
  readonly details?: JsonValue;
  readonly outputDigest?: string;
}

export interface RunnerEscalation {
  readonly commandId: string;
  readonly operationId: string;
  readonly unit: string;
  readonly requested: number;
  readonly available: number;
  readonly createdAt: string;
  readonly reason: "budget-exhausted";
}

export interface RunnerEffectRecord {
  readonly intent: EffectIntent;
  readonly outcome?: EffectOutcome;
  readonly cancellationRequestedAt?: string;
}

export interface RunnerAuthoritySnapshot {
  readonly repositoryId: string;
  readonly runId: string;
  readonly taskScopes: readonly TaskScopeCurrentness[];
  readonly queuedCommands: readonly QueuedEffectCommand[];
  readonly effects: readonly RunnerEffectRecord[];
  readonly escalations: readonly RunnerEscalation[];
  readonly capacities: readonly RunnerCapacityState[];
}

export interface RunnerCapacityState {
  readonly resource: "writer";
  readonly limit: number;
  readonly occupied: number;
}

export interface RunOnceInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly lease: RunnerLeaseFact;
  readonly currentTime: string;
  readonly attemptId: string;
}

export interface FencedRunnerMutationInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly lease: RunnerLeaseFact;
  readonly currentTime: string;
}

export interface FencedRunnerContextUpdateInput extends FencedRunnerMutationInput {
  readonly contextDigest: string;
}

export interface EnsureTaskScopesAndBudgetsInput extends FencedRunnerMutationInput {
  readonly taskScopes: readonly TaskScopeCurrentness[];
  readonly budgets: readonly { readonly unit: string; readonly limit: number }[];
}

export interface FencedRunnerCancellationInput extends FencedRunnerMutationInput {
  readonly operationId: string;
  readonly requestedAt: string;
}

export type RunnerPlan =
  | { readonly type: "start"; readonly command: QueuedEffectCommand }
  | { readonly type: "reconcile"; readonly effect: RunnerEffectRecord }
  | { readonly type: "none" };

type RunnerTransitionPlan = Exclude<RunnerPlan, { readonly type: "none" }>;

export type PersistIntentResult =
  | { readonly type: "persisted"; readonly intent: EffectIntent }
  | { readonly type: "escalated"; readonly escalation: RunnerEscalation }
  | {
      readonly type: "capacity-unavailable";
      readonly reservation: EffectCapacityReservation;
      readonly available: number;
    };

export interface PersistIntentRequest extends RunOnceInput {
  readonly command: QueuedEffectCommand;
}

export interface CommitEffectRequest extends RunOnceInput {
  readonly intent: EffectIntent;
  readonly observation: EffectObservation;
}

export type EffectAttemptOrigin = "dispatch" | "inspection" | "cancellation" | "settlement";

export interface ClaimEffectAttemptRequest extends RunOnceInput {
  readonly intent: EffectIntent;
  readonly taskScope: TaskScopeFence;
}

export type ClaimEffectAttemptResult =
  | {
      readonly type: "claimed";
      readonly action: EffectAttemptOrigin;
      readonly effect: RunnerEffectRecord;
    }
  | { readonly type: "busy" }
  | { readonly type: "fenced"; readonly currentness: TaskScopeCurrentness }
  | { readonly type: "replay"; readonly outcome: EffectOutcome };

export interface RunnerAuthorityPort {
  load(input: Pick<RunOnceInput, "repositoryId" | "runId">): RunnerAuthoritySnapshot;
  assertLease(input: RunOnceInput): void;
  ensureTaskScopesAndBudgets(input: EnsureTaskScopesAndBudgetsInput): void;
  installTaskScopeFences(input: InstallTaskScopeFencesInput): readonly TaskScopeCurrentness[];
  claimEffectAttempt(request: ClaimEffectAttemptRequest): ClaimEffectAttemptResult;
  persistIntent(request: PersistIntentRequest): PersistIntentResult;
  commitEffect(request: CommitEffectRequest): EffectOutcome;
}

export interface EffectHost {
  dispatch(intent: EffectIntent, lease: RunnerLeaseFact): EffectObservation;
  inspect(intent: EffectIntent, lease: RunnerLeaseFact): EffectInspection;
  cancel(intent: EffectIntent, lease: RunnerLeaseFact): EffectObservation;
}

export interface AsyncEffectHostContext {
  readonly lease: RunnerLeaseFact;
  readonly signal: AbortSignal;
}

export interface AsyncEffectHost {
  dispatch(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectObservation>;
  inspect(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectInspection>;
  cancel(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectObservation>;
}

export interface AsyncRunOnceInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly signal: AbortSignal;
  currentTime(): string;
  currentLease(): RunnerLeaseFact;
}

export type RunOnceResult =
  | { readonly type: "idle" }
  | { readonly type: "escalated"; readonly escalation: RunnerEscalation }
  | {
      readonly type: "capacity-unavailable";
      readonly reservation: EffectCapacityReservation;
      readonly available: number;
    }
  | { readonly type: "committed"; readonly outcome: EffectOutcome };

export interface RunnerBatchOptions {
  readonly maxTransitions: number;
  readonly failurePolicy?: "continue" | "fail-fast";
}

export interface RunBatchResult {
  readonly type: "batch";
  readonly results: readonly Exclude<RunOnceResult, { readonly type: "idle" }>[];
}

export interface ScheduleRunnerTransitionsOptions extends RunnerBatchOptions {
  readonly currentTime: string;
}

export function scheduleRunnerTransitions(
  snapshot: RunnerAuthoritySnapshot,
  options: ScheduleRunnerTransitionsOptions,
): readonly RunnerTransitionPlan[] {
  validateBatchOptions(options);
  const reconcilable = snapshot.effects
    .filter(({ outcome }) => {
      if (outcome === undefined) return true;
      return outcome.status === "active" || outcome.status === "unknown";
    })
    .sort(
      (left, right) =>
        cancellationPriority(left, options.currentTime) -
          cancellationPriority(right, options.currentTime) ||
        compareText(left.intent.command.operationId, right.intent.command.operationId),
    );

  const startedCommandIds = new Set(snapshot.effects.map(({ intent }) => intent.command.commandId));
  const escalatedCommandIds = new Set(snapshot.escalations.map(({ commandId }) => commandId));
  const availableCapacities = new Map(
    snapshot.capacities.map((capacity) => [
      capacity.resource,
      Math.max(0, capacity.limit - capacity.occupied),
    ]),
  );
  const commands = snapshot.queuedCommands
    .filter(
      (candidate) =>
        !startedCommandIds.has(candidate.commandId) &&
        !escalatedCommandIds.has(candidate.commandId) &&
        snapshot.taskScopes.some(
          (currentness) =>
            currentness.claimsAccepted && sameTaskScopeFence(candidate.taskScope, currentness),
        ),
    )
    .sort(
      (left, right) =>
        compareText(left.operationId, right.operationId) ||
        left.sequence - right.sequence ||
        compareText(left.commandId, right.commandId),
    );
  const plans: RunnerTransitionPlan[] = reconcilable
    .slice(0, options.maxTransitions)
    .map((effect) => ({ type: "reconcile", effect }));
  for (const command of commands) {
    if (plans.length >= options.maxTransitions) break;
    const reservation = command.capacityReservation;
    if (reservation !== undefined) {
      const available = availableCapacities.get(reservation.resource) ?? 0;
      if (reservation.amount > available) continue;
      availableCapacities.set(reservation.resource, available - reservation.amount);
    }
    plans.push({ type: "start", command });
  }
  return Object.freeze(plans);
}

export function scheduleRunnerTransition(snapshot: RunnerAuthoritySnapshot): RunnerPlan {
  return (
    scheduleRunnerTransitions(snapshot, {
      currentTime: "0000-01-01T00:00:00.000Z",
      maxTransitions: 1,
    })[0] ?? { type: "none" }
  );
}

interface PreparedEffectAttempt {
  readonly intent: EffectIntent;
  readonly action: EffectAttemptOrigin;
  readonly effect: RunnerEffectRecord;
}

type PreparedPlanResult =
  | { readonly type: "attempt"; readonly attempt: PreparedEffectAttempt }
  | {
      readonly type: "result";
      readonly result: Exclude<RunOnceResult, { readonly type: "idle" }>;
    }
  | { readonly type: "skip" };

export class FencedRunner {
  readonly authority: RunnerAuthorityPort;
  readonly host: EffectHost;

  constructor(authority: RunnerAuthorityPort, host: EffectHost) {
    this.authority = authority;
    this.host = host;
  }

  runOnce(input: RunOnceInput): RunOnceResult {
    const batch = this.runBatch(input, { maxTransitions: 1 });
    return batch.results[0] ?? { type: "idle" };
  }

  runBatch(input: RunOnceInput, options: RunnerBatchOptions): RunBatchResult {
    validateRunOnceInput(input);
    validateBatchOptions(options);
    const snapshot = this.authority.load(input);
    const plans = scheduleRunnerTransitions(snapshot, {
      currentTime: input.currentTime,
      maxTransitions: options.maxTransitions,
    });
    const prepared: PreparedEffectAttempt[] = [];
    const results: Exclude<RunOnceResult, { readonly type: "idle" }>[] = [];
    for (const plan of plans) {
      const preparedPlan = this.preparePlan(plan, snapshot, input);
      if (preparedPlan.type === "attempt") prepared.push(preparedPlan.attempt);
      if (preparedPlan.type === "result") results.push(preparedPlan.result);
    }

    const errors: unknown[] = [];
    for (const attempt of prepared) {
      try {
        const observation = this.observeClaimedAction(
          attempt.action,
          attempt.effect,
          input,
          attempt.effect.intent.command.contextDigest,
        );
        results.push({
          type: "committed",
          outcome: this.authority.commitEffect({
            ...input,
            intent: attempt.intent,
            observation,
          }),
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "One or more fenced effects failed");
    return Object.freeze({ type: "batch", results: Object.freeze(results) });
  }

  private preparePlan(
    plan: Exclude<RunnerPlan, { readonly type: "none" }>,
    snapshot: RunnerAuthoritySnapshot,
    input: RunOnceInput,
  ): PreparedPlanResult {
    let intent: EffectIntent;
    if (plan.type === "start") {
      const persisted = this.authority.persistIntent({ ...input, command: plan.command });
      if (persisted.type === "escalated") {
        return { type: "result", result: persisted };
      }
      if (persisted.type === "capacity-unavailable") {
        return { type: "result", result: persisted };
      }
      intent = persisted.intent;
    } else {
      intent = plan.effect.intent;
    }
    const claim = this.authority.claimEffectAttempt({
      ...input,
      intent,
      taskScope:
        snapshot.taskScopes.find((scope) => sameTaskScope(scope, intent.command.taskScope)) ??
        intent.command.taskScope,
    });
    if (claim.type === "busy" || claim.type === "fenced") return { type: "skip" };
    if (claim.type === "replay") {
      return { type: "result", result: { type: "committed", outcome: claim.outcome } };
    }
    return {
      type: "attempt",
      attempt: { intent, action: claim.action, effect: claim.effect },
    };
  }

  private observeClaimedAction(
    action: EffectAttemptOrigin,
    effect: RunnerEffectRecord,
    input: RunOnceInput,
    currentContextDigest: string,
  ): EffectObservation {
    const { intent } = effect;
    if (action === "dispatch") {
      try {
        this.authority.assertLease(input);
        return this.host.dispatch(intent, input.lease);
      } catch (error) {
        if (isFenceError(error)) throw error;
        return this.inspectAfterLostResponse(intent, input, error);
      }
    }
    const cancellationRequired =
      effect.cancellationRequestedAt !== undefined ||
      isAtOrAfter(input.currentTime, intent.command.deadline);
    if (action === "cancellation") {
      try {
        this.authority.assertLease(input);
        return this.host.cancel(intent, input.lease);
      } catch (error) {
        if (isFenceError(error)) throw error;
        return this.inspectAfterLostResponse(intent, input, error);
      }
    }

    if (action === "settlement") {
      if (effect.outcome === undefined) {
        return {
          status: "cancelled",
          observedAt: input.currentTime,
          details: { reason: "deadline-reached-before-dispatch" },
        };
      }
      return {
        status: "failed",
        observedAt: input.currentTime,
        details: {
          reason: cancellationRequired
            ? "cancellation-reconciliation-limit-reached"
            : "reconciliation-limit-reached",
          previousStatus: effect.outcome.status,
        },
      };
    }

    let inspection: EffectInspection;
    try {
      this.authority.assertLease(input);
      inspection = this.host.inspect(intent, input.lease);
    } catch (error) {
      if (isFenceError(error)) throw error;
      return unknownObservation(input.currentTime, "inspect-threw", error);
    }
    if (inspection.status === "missing") {
      if (intent.command.contextDigest !== currentContextDigest) {
        return {
          status: "cancelled",
          observedAt: input.currentTime,
          details: { reason: "stale-context-before-dispatch" },
        };
      }
      try {
        this.authority.assertLease(input);
        return this.host.dispatch(intent, input.lease);
      } catch (error) {
        if (isFenceError(error)) throw error;
        return this.inspectAfterLostResponse(intent, input, error);
      }
    }
    return inspectionToObservation(inspection);
  }

  private inspectAfterLostResponse(
    intent: EffectIntent,
    input: RunOnceInput,
    dispatchError: unknown,
  ): EffectObservation {
    try {
      this.authority.assertLease(input);
      const inspection = this.host.inspect(intent, input.lease);
      if (inspection.status !== "missing") return inspectionToObservation(inspection);
    } catch (error) {
      if (isFenceError(error)) throw error;
      // The durable unknown record below is the authority when inspection also fails.
    }
    return unknownObservation(input.currentTime, "effect-response-lost", dispatchError);
  }
}

export class AsyncRunnerCancelledError extends Error {
  constructor() {
    super("Asynchronous effect execution was cancelled");
    this.name = "AsyncRunnerCancelledError";
  }
}

export class AsyncFencedRunner {
  readonly authority: RunnerAuthorityPort;
  readonly host: AsyncEffectHost;

  constructor(authority: RunnerAuthorityPort, host: AsyncEffectHost) {
    this.authority = authority;
    this.host = host;
  }

  async runOnce(input: AsyncRunOnceInput): Promise<RunOnceResult> {
    const batch = await this.runBatch(input, { maxTransitions: 1 });
    return batch.results[0] ?? { type: "idle" };
  }

  async runBatch(input: AsyncRunOnceInput, options: RunnerBatchOptions): Promise<RunBatchResult> {
    validateAsyncRunOnceIdentity(input);
    validateBatchOptions(options);
    const initial = this.freshInput(input);
    const snapshot = this.authority.load(initial);
    const plans = scheduleRunnerTransitions(snapshot, {
      currentTime: initial.currentTime,
      maxTransitions: options.maxTransitions,
    });
    const prepared: PreparedEffectAttempt[] = [];
    const results: Exclude<RunOnceResult, { readonly type: "idle" }>[] = [];
    for (const plan of plans) {
      const preparedPlan = this.preparePlan(plan, snapshot, input);
      if (preparedPlan.type === "attempt") prepared.push(preparedPlan.attempt);
      if (preparedPlan.type === "result") results.push(preparedPlan.result);
    }

    const cohort = new AbortController();
    const abortCohort = (): void => cohort.abort(input.signal.reason);
    if (input.signal.aborted) abortCohort();
    else input.signal.addEventListener("abort", abortCohort, { once: true });
    const cohortInput = { ...input, signal: cohort.signal };
    const observations = await Promise.allSettled(
      prepared.map(async (attempt): Promise<EffectObservation> => {
        try {
          const observation = await this.observeClaimedAction(
            attempt.action,
            attempt.effect,
            cohortInput,
            attempt.effect.intent.command.contextDigest,
          );
          if (
            options.failurePolicy === "fail-fast" &&
            (observation.status === "failed" || observation.status === "cancelled")
          ) {
            cohort.abort(new AsyncRunnerCancelledError());
          }
          return observation;
        } catch (error) {
          if (cohort.signal.aborted && !input.signal.aborted) {
            return {
              status: "cancelled",
              observedAt: input.currentTime(),
              details: { reason: "fail-fast-sibling-failed" },
            };
          }
          throw error;
        }
      }),
    );
    input.signal.removeEventListener("abort", abortCohort);
    const errors: unknown[] = [];
    for (const [index, settled] of observations.entries()) {
      if (settled.status === "rejected") {
        errors.push(settled.reason);
        continue;
      }
      const attempt = prepared[index];
      if (attempt === undefined) throw new TypeError("Settled effect has no prepared attempt");
      try {
        results.push({
          type: "committed",
          outcome: this.authority.commitEffect({
            ...this.freshInput(input),
            intent: attempt.intent,
            observation: settled.value,
          }),
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (input.signal.aborted) throw new AsyncRunnerCancelledError();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "One or more fenced effects failed");
    return Object.freeze({ type: "batch", results: Object.freeze(results) });
  }

  private preparePlan(
    plan: Exclude<RunnerPlan, { readonly type: "none" }>,
    snapshot: RunnerAuthoritySnapshot,
    input: AsyncRunOnceInput,
  ): PreparedPlanResult {
    let intent: EffectIntent;
    if (plan.type === "start") {
      const persisted = this.authority.persistIntent({
        ...this.freshInput(input),
        command: plan.command,
      });
      if (persisted.type === "escalated" || persisted.type === "capacity-unavailable") {
        return { type: "result", result: persisted };
      }
      intent = persisted.intent;
    } else {
      intent = plan.effect.intent;
    }
    const claim = this.authority.claimEffectAttempt({
      ...this.freshInput(input),
      intent,
      taskScope:
        snapshot.taskScopes.find((scope) => sameTaskScope(scope, intent.command.taskScope)) ??
        intent.command.taskScope,
    });
    if (claim.type === "busy" || claim.type === "fenced") return { type: "skip" };
    if (claim.type === "replay") {
      return { type: "result", result: { type: "committed", outcome: claim.outcome } };
    }
    return {
      type: "attempt",
      attempt: { intent, action: claim.action, effect: claim.effect },
    };
  }

  private async observeClaimedAction(
    action: EffectAttemptOrigin,
    effect: RunnerEffectRecord,
    input: AsyncRunOnceInput,
    currentContextDigest: string,
  ): Promise<EffectObservation> {
    const { intent } = effect;
    if (action === "settlement") {
      const currentTime = this.freshInput(input).currentTime;
      if (effect.outcome === undefined) {
        return {
          status: "cancelled",
          observedAt: currentTime,
          details: { reason: "deadline-reached-before-dispatch" },
        };
      }
      const cancellationRequired =
        effect.cancellationRequestedAt !== undefined ||
        isAtOrAfter(currentTime, intent.command.deadline);
      return {
        status: "failed",
        observedAt: currentTime,
        details: {
          reason: cancellationRequired
            ? "cancellation-reconciliation-limit-reached"
            : "reconciliation-limit-reached",
          previousStatus: effect.outcome.status,
        },
      };
    }

    if (action === "dispatch" || action === "cancellation") {
      try {
        const context = this.hostContext(input);
        const observation =
          action === "dispatch"
            ? await this.host.dispatch(intent, context)
            : await this.host.cancel(intent, context);
        this.throwIfAborted(input.signal);
        return observation;
      } catch (error) {
        this.throwIfAborted(input.signal);
        if (isFenceError(error)) throw error;
        return this.inspectAfterLostResponse(intent, input, error);
      }
    }

    let inspection: EffectInspection;
    try {
      inspection = await this.host.inspect(intent, this.hostContext(input));
      this.throwIfAborted(input.signal);
    } catch (error) {
      this.throwIfAborted(input.signal);
      if (isFenceError(error)) throw error;
      return unknownObservation(this.freshInput(input).currentTime, "inspect-threw", error);
    }
    if (inspection.status !== "missing") return inspectionToObservation(inspection);
    if (intent.command.contextDigest !== currentContextDigest) {
      return {
        status: "cancelled",
        observedAt: this.freshInput(input).currentTime,
        details: { reason: "stale-context-before-dispatch" },
      };
    }
    try {
      const observation = await this.host.dispatch(intent, this.hostContext(input));
      this.throwIfAborted(input.signal);
      return observation;
    } catch (error) {
      this.throwIfAborted(input.signal);
      if (isFenceError(error)) throw error;
      return this.inspectAfterLostResponse(intent, input, error);
    }
  }

  private async inspectAfterLostResponse(
    intent: EffectIntent,
    input: AsyncRunOnceInput,
    dispatchError: unknown,
  ): Promise<EffectObservation> {
    try {
      const inspection = await this.host.inspect(intent, this.hostContext(input));
      this.throwIfAborted(input.signal);
      if (inspection.status !== "missing") return inspectionToObservation(inspection);
    } catch (error) {
      this.throwIfAborted(input.signal);
      if (isFenceError(error)) throw error;
    }
    return unknownObservation(
      this.freshInput(input).currentTime,
      "effect-response-lost",
      dispatchError,
    );
  }

  private hostContext(input: AsyncRunOnceInput): AsyncEffectHostContext {
    const current = this.freshInput(input);
    this.authority.assertLease(current);
    return { lease: current.lease, signal: input.signal };
  }

  private freshInput(input: AsyncRunOnceInput): RunOnceInput {
    this.throwIfAborted(input.signal);
    try {
      const currentTime = input.currentTime();
      const lease = input.currentLease();
      const current = {
        repositoryId: input.repositoryId,
        runId: input.runId,
        attemptId: input.attemptId,
        currentTime,
        lease,
      };
      validateRunOnceInput(current);
      return current;
    } catch {
      throw new AsyncRunnerCancelledError();
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new AsyncRunnerCancelledError();
  }
}

export function selectEffectAttemptAction(
  effect: RunnerEffectRecord,
  currentTime: string,
  attemptId: string,
): EffectAttemptOrigin {
  const cancellationRequired =
    effect.cancellationRequestedAt !== undefined ||
    isAtOrAfter(currentTime, effect.intent.command.deadline);
  if (effect.outcome === undefined) {
    if (cancellationRequired) return "settlement";
    return effect.intent.attemptId === attemptId ? "dispatch" : "inspection";
  }
  if (cancellationRequired && effect.outcome?.origin !== "cancellation") return "cancellation";
  if (
    cancellationRequired ||
    (effect.outcome !== undefined &&
      effect.outcome.reconciliationAttempts >= effect.intent.command.maxReconciliationAttempts)
  ) {
    return "settlement";
  }
  return "inspection";
}

function isFenceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "StaleLeaseFenceError" ||
      error.message.includes("stale or expired lease fence"))
  );
}

function inspectionToObservation(inspection: EffectInspection): EffectObservation {
  if (inspection.status === "missing") {
    throw new TypeError("A missing inspection is not an effect outcome");
  }
  return {
    status: inspection.status,
    observedAt: inspection.observedAt,
    ...(inspection.details === undefined ? {} : { details: inspection.details }),
    ...(inspection.outputDigest === undefined ? {} : { outputDigest: inspection.outputDigest }),
    ...(inspection.usage === undefined ? {} : { usage: inspection.usage }),
  };
}

function unknownObservation(observedAt: string, reason: string, error: unknown): EffectObservation {
  return {
    status: "unknown",
    observedAt,
    details: {
      reason,
      message: error instanceof Error ? error.message : "Effect host did not return a result",
    },
  };
}

function validateRunOnceInput(input: RunOnceInput): void {
  if (input.repositoryId.length === 0 || input.runId.length === 0 || input.attemptId.length === 0) {
    throw new TypeError("RunOnce identities must be non-empty");
  }
  if (
    input.lease.owner.length === 0 ||
    !Number.isSafeInteger(input.lease.fence) ||
    input.lease.fence < 1
  ) {
    throw new TypeError("RunOnce requires a non-empty owner and positive safe-integer fence");
  }
  validateTimestamp(input.currentTime, "currentTime");
  validateTimestamp(input.lease.expiresAt, "lease.expiresAt");
  if (Date.parse(input.currentTime) >= Date.parse(input.lease.expiresAt)) {
    throw new TypeError("RunOnce requires a live lease fact");
  }
}

function validateAsyncRunOnceIdentity(input: AsyncRunOnceInput): void {
  if (input.repositoryId.length === 0 || input.runId.length === 0 || input.attemptId.length === 0) {
    throw new TypeError("RunOnce identities must be non-empty");
  }
}

function validateBatchOptions(options: RunnerBatchOptions): void {
  if (!Number.isSafeInteger(options.maxTransitions) || options.maxTransitions < 1) {
    throw new TypeError("Runner batch limit must be a positive safe integer");
  }
  if (
    options.failurePolicy !== undefined &&
    options.failurePolicy !== "continue" &&
    options.failurePolicy !== "fail-fast"
  ) {
    throw new TypeError("Runner batch failure policy must be continue or fail-fast");
  }
}

function cancellationPriority(effect: RunnerEffectRecord, currentTime: string): number {
  return effect.cancellationRequestedAt !== undefined ||
    isAtOrAfter(currentTime, effect.intent.command.deadline)
    ? 0
    : 1;
}

function isAtOrAfter(currentTime: string, deadline: string | undefined): boolean {
  return deadline !== undefined && Date.parse(currentTime) >= Date.parse(deadline);
}

function validateTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a UTC RFC 3339 timestamp`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameTaskScope(left: TaskScopeFence, right: TaskScopeFence): boolean {
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.definitionGeneration === right.definitionGeneration
  );
}

function sameTaskScopeFence(left: TaskScopeFence, right: TaskScopeFence): boolean {
  return (
    sameTaskScope(left, right) &&
    left.acceptedContextDigest === right.acceptedContextDigest &&
    left.fenceGeneration === right.fenceGeneration
  );
}
