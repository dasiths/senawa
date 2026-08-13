import type { JsonValue } from "@senawa/protocol";

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
  readonly contextDigest: string;
  readonly inputDigest: string;
  readonly input: JsonValue;
  readonly budgetReservation: EffectBudgetReservation;
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
  readonly contextDigest: string;
  readonly queuedCommands: readonly QueuedEffectCommand[];
  readonly effects: readonly RunnerEffectRecord[];
  readonly escalations: readonly RunnerEscalation[];
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

export interface FencedRunnerCancellationInput extends FencedRunnerMutationInput {
  readonly operationId: string;
  readonly requestedAt: string;
}

export type RunnerPlan =
  | { readonly type: "start"; readonly command: QueuedEffectCommand }
  | { readonly type: "reconcile"; readonly effect: RunnerEffectRecord }
  | { readonly type: "none" };

export type PersistIntentResult =
  | { readonly type: "persisted"; readonly intent: EffectIntent }
  | { readonly type: "escalated"; readonly escalation: RunnerEscalation };

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
  readonly contextDigest: string;
}

export type ClaimEffectAttemptResult =
  | {
      readonly type: "claimed";
      readonly action: EffectAttemptOrigin;
      readonly effect: RunnerEffectRecord;
    }
  | { readonly type: "busy" }
  | { readonly type: "replay"; readonly outcome: EffectOutcome };

export interface RunnerAuthorityPort {
  load(input: Pick<RunOnceInput, "repositoryId" | "runId">): RunnerAuthoritySnapshot;
  assertLease(input: RunOnceInput): void;
  claimEffectAttempt(request: ClaimEffectAttemptRequest): ClaimEffectAttemptResult;
  persistIntent(request: PersistIntentRequest): PersistIntentResult;
  commitEffect(request: CommitEffectRequest): EffectOutcome;
}

export interface EffectHost {
  dispatch(intent: EffectIntent, lease: RunnerLeaseFact): EffectObservation;
  inspect(intent: EffectIntent, lease: RunnerLeaseFact): EffectInspection;
  cancel(intent: EffectIntent, lease: RunnerLeaseFact): EffectObservation;
}

export type RunOnceResult =
  | { readonly type: "idle" }
  | { readonly type: "escalated"; readonly escalation: RunnerEscalation }
  | { readonly type: "committed"; readonly outcome: EffectOutcome };

export function scheduleRunnerTransition(snapshot: RunnerAuthoritySnapshot): RunnerPlan {
  const reconcilable = snapshot.effects
    .filter(({ outcome }) => {
      if (outcome === undefined) return true;
      return outcome.status === "active" || outcome.status === "unknown";
    })
    .sort((left, right) =>
      compareText(left.intent.command.operationId, right.intent.command.operationId),
    )[0];
  if (reconcilable !== undefined) return { type: "reconcile", effect: reconcilable };

  const startedCommandIds = new Set(snapshot.effects.map(({ intent }) => intent.command.commandId));
  const escalatedCommandIds = new Set(snapshot.escalations.map(({ commandId }) => commandId));
  const command = snapshot.queuedCommands
    .filter(
      ({ commandId }) => !startedCommandIds.has(commandId) && !escalatedCommandIds.has(commandId),
    )
    .sort(
      (left, right) =>
        left.sequence - right.sequence || compareText(left.commandId, right.commandId),
    )[0];
  return command === undefined ? { type: "none" } : { type: "start", command };
}

export class FencedRunner {
  readonly authority: RunnerAuthorityPort;
  readonly host: EffectHost;

  constructor(authority: RunnerAuthorityPort, host: EffectHost) {
    this.authority = authority;
    this.host = host;
  }

  runOnce(input: RunOnceInput): RunOnceResult {
    validateRunOnceInput(input);
    const snapshot = this.authority.load(input);
    const plan = scheduleRunnerTransition(snapshot);
    if (plan.type === "none") return { type: "idle" };

    if (plan.type === "start") {
      const persisted = this.authority.persistIntent({ ...input, command: plan.command });
      if (persisted.type === "escalated") {
        return { type: "escalated", escalation: persisted.escalation };
      }
      const claim = this.authority.claimEffectAttempt({
        ...input,
        intent: persisted.intent,
        contextDigest: snapshot.contextDigest,
      });
      if (claim.type === "busy") return { type: "idle" };
      if (claim.type === "replay") return { type: "committed", outcome: claim.outcome };
      const observation = this.observeClaimedAction(
        claim.action,
        claim.effect,
        input,
        snapshot.contextDigest,
      );
      return {
        type: "committed",
        outcome: this.authority.commitEffect({ ...input, intent: persisted.intent, observation }),
      };
    }

    const claim = this.authority.claimEffectAttempt({
      ...input,
      intent: plan.effect.intent,
      contextDigest: snapshot.contextDigest,
    });
    if (claim.type === "busy") return { type: "idle" };
    if (claim.type === "replay") return { type: "committed", outcome: claim.outcome };
    const observation = this.observeClaimedAction(
      claim.action,
      claim.effect,
      input,
      snapshot.contextDigest,
    );
    return {
      type: "committed",
      outcome: this.authority.commitEffect({
        ...input,
        intent: plan.effect.intent,
        observation,
      }),
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
