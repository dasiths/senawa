import { canonicalStringify, type JsonValue } from "@senawa/protocol";
import type {
  ClaimEffectAttemptRequest,
  ClaimEffectAttemptResult,
  CommitEffectRequest,
  EffectAttemptOrigin,
  EffectIntent,
  EffectOutcome,
  FencedRunnerCancellationInput,
  FencedRunnerContextUpdateInput,
  FinalizedEffectUsage,
  PersistIntentRequest,
  PersistIntentResult,
  QueuedEffectCommand,
  RunnerAuthorityPort,
  RunnerAuthoritySnapshot,
  RunnerEffectRecord,
  RunnerEscalation,
  RunnerLeaseFact,
} from "./runner.js";
import { selectEffectAttemptAction } from "./runner.js";

export type RunnerFaultPoint =
  | "before-intent-persist"
  | "after-intent-persist"
  | "before-effect-commit"
  | "after-effect-commit";

export interface RunnerFaultInjector {
  inject(point: RunnerFaultPoint): void;
}

export interface RunnerBudgetState {
  readonly unit: string;
  readonly limit: number;
  readonly reserved: number;
  readonly spent: number;
  readonly unreported: number;
}

export interface RunnerEffectReceipt {
  readonly cursor: number;
  readonly repositoryId: string;
  readonly runId: string;
  readonly commandId?: string;
  readonly operationId?: string;
  readonly status:
    | "queued"
    | "intent"
    | EffectOutcome["status"]
    | "context-updated"
    | "cancellation-requested";
  readonly occurredAt: string;
  readonly attemptId?: string;
}

export interface RunnerEffectEvent {
  readonly cursor: number;
  readonly repositoryId: string;
  readonly runId: string;
  readonly commandId?: string;
  readonly operationId?: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: JsonValue;
}

export interface RunnerProjection {
  readonly cursor: number;
  readonly contextDigest: string;
  readonly effects: readonly {
    readonly operationId: string;
    readonly status: EffectOutcome["status"];
    readonly outputDigest?: string;
  }[];
}

export interface InMemoryRunnerRunInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly contextDigest: string;
  readonly budgets: readonly { readonly unit: string; readonly limit: number }[];
  readonly lease: RunnerLeaseFact;
}

interface MutableBudgetState {
  unit: string;
  limit: number;
  reserved: number;
  spent: number;
  unreported: number;
}

interface InMemoryEffectClaim {
  readonly attemptId: string;
  readonly owner: string;
  readonly fence: number;
  readonly contextDigest: string;
  readonly origin: EffectAttemptOrigin;
}

interface InMemoryRunnerRun {
  repositoryId: string;
  runId: string;
  contextDigest: string;
  lease: RunnerLeaseFact;
  queuedCommands: QueuedEffectCommand[];
  effects: Map<string, RunnerEffectRecord>;
  outcomeAttempts: Map<string, Map<string, EffectOutcome>>;
  claims: Map<string, InMemoryEffectClaim>;
  escalations: RunnerEscalation[];
  budgets: Map<string, MutableBudgetState>;
  cursor: number;
  receipts: RunnerEffectReceipt[];
  events: RunnerEffectEvent[];
  projection: RunnerProjection;
}

export class InMemoryRunnerAuthority implements RunnerAuthorityPort {
  readonly faultInjector: RunnerFaultInjector | undefined;
  readonly runs = new Map<string, InMemoryRunnerRun>();

  constructor(faultInjector?: RunnerFaultInjector) {
    this.faultInjector = faultInjector;
  }

  configureRun(input: InMemoryRunnerRunInput): void {
    validateIdentity(input.repositoryId, "repositoryId");
    validateIdentity(input.runId, "runId");
    validateDigest(input.contextDigest, "contextDigest");
    validateLease(input.lease);
    const key = runKey(input.repositoryId, input.runId);
    if (this.runs.has(key)) throw new TypeError("Runner run is already configured");
    const budgets = new Map<string, MutableBudgetState>();
    for (const budget of input.budgets) {
      validateUnit(budget.unit);
      validateAmount(budget.limit, "budget limit");
      if (budgets.has(budget.unit)) throw new TypeError("Runner budget units must be unique");
      budgets.set(budget.unit, {
        unit: budget.unit,
        limit: budget.limit,
        reserved: 0,
        spent: 0,
        unreported: 0,
      });
    }
    this.runs.set(key, {
      repositoryId: input.repositoryId,
      runId: input.runId,
      contextDigest: input.contextDigest,
      lease: Object.freeze({ ...input.lease }),
      queuedCommands: [],
      effects: new Map(),
      outcomeAttempts: new Map(),
      claims: new Map(),
      escalations: [],
      budgets,
      cursor: 0,
      receipts: [],
      events: [],
      projection: Object.freeze({ cursor: 0, contextDigest: input.contextDigest, effects: [] }),
    });
  }

  enqueue(command: QueuedEffectCommand): void {
    validateCommand(command);
    const run = this.requiredRun(command.repositoryId, command.runId);
    if (
      run.queuedCommands.some(({ commandId }) => commandId === command.commandId) ||
      [...run.effects.values()].some(({ intent }) => intent.command.commandId === command.commandId)
    ) {
      throw new TypeError("Runner command identity is already queued or started");
    }
    if (
      run.queuedCommands.some(({ operationId }) => operationId === command.operationId) ||
      run.effects.has(command.operationId)
    ) {
      throw new TypeError("Effect operation identity is already queued or started");
    }
    const stored = snapshotCommand(command);
    const cursor = run.cursor + 1;
    const receipt: RunnerEffectReceipt = Object.freeze({
      cursor,
      repositoryId: run.repositoryId,
      runId: run.runId,
      commandId: stored.commandId,
      operationId: stored.operationId,
      status: "queued",
      occurredAt: stored.queuedAt,
    });
    const event: RunnerEffectEvent = Object.freeze({
      cursor,
      repositoryId: run.repositoryId,
      runId: run.runId,
      commandId: stored.commandId,
      operationId: stored.operationId,
      eventType: "effect-command-queued",
      occurredAt: stored.queuedAt,
      payload: { kind: stored.kind },
    });
    run.queuedCommands.push(stored);
    run.cursor = cursor;
    run.receipts.push(receipt);
    run.events.push(event);
    run.projection = this.project(run);
  }

  load(input: { readonly repositoryId: string; readonly runId: string }): RunnerAuthoritySnapshot {
    const run = this.requiredRun(input.repositoryId, input.runId);
    return Object.freeze({
      repositoryId: run.repositoryId,
      runId: run.runId,
      contextDigest: run.contextDigest,
      queuedCommands: Object.freeze([...run.queuedCommands]),
      effects: Object.freeze([...run.effects.values()]),
      escalations: Object.freeze([...run.escalations]),
    });
  }

  assertLease(input: PersistIntentRequest): void {
    const run = this.requiredRun(input.repositoryId, input.runId);
    this.assertFence(run, input.lease, input.currentTime);
  }

  claimEffectAttempt(request: ClaimEffectAttemptRequest): ClaimEffectAttemptResult {
    const run = this.requiredRun(request.repositoryId, request.runId);
    this.assertFence(run, request.lease, request.currentTime);
    if (request.contextDigest !== run.contextDigest) {
      throw new TypeError("Runner context changed before effect attempt claim");
    }
    const record = run.effects.get(request.intent.command.operationId);
    if (
      record === undefined ||
      canonicalStringify(record.intent) !== canonicalStringify(request.intent)
    ) {
      throw new TypeError("Effect claim does not match the durable intent in this run");
    }
    const replay = run.outcomeAttempts
      .get(request.intent.command.operationId)
      ?.get(request.attemptId);
    if (replay !== undefined) return { type: "replay", outcome: replay };
    if (record.outcome !== undefined && isTerminal(record.outcome.status)) {
      return { type: "replay", outcome: record.outcome };
    }
    const existing = run.claims.get(request.intent.command.operationId);
    if (existing !== undefined && existing.fence === request.lease.fence) return { type: "busy" };
    const action = selectEffectAttemptAction(record, request.currentTime, request.attemptId);
    run.claims.set(
      request.intent.command.operationId,
      Object.freeze({
        attemptId: request.attemptId,
        owner: request.lease.owner,
        fence: request.lease.fence,
        contextDigest: request.contextDigest,
        origin: action,
      }),
    );
    return {
      type: "claimed",
      action,
      effect: record,
    };
  }

  persistIntent(request: PersistIntentRequest): PersistIntentResult {
    this.faultInjector?.inject("before-intent-persist");
    const run = this.requiredRun(request.repositoryId, request.runId);
    this.assertFence(run, request.lease, request.currentTime);
    const queued = run.queuedCommands.find(
      ({ commandId }) => commandId === request.command.commandId,
    );
    if (
      queued === undefined ||
      canonicalStringify(queued) !== canonicalStringify(request.command)
    ) {
      throw new TypeError("Runner intent command is not the exact durable queued command");
    }
    const existing = run.effects.get(queued.operationId);
    if (existing !== undefined) return { type: "persisted", intent: existing.intent };
    if (queued.contextDigest !== run.contextDigest) {
      throw new TypeError("Runner command context is stale before effect intent persistence");
    }

    const budget = run.budgets.get(queued.budgetReservation.unit);
    if (budget === undefined) throw new TypeError("Runner command names an unknown budget unit");
    const available = Math.max(0, budget.limit - budget.spent - budget.reserved);
    if (queued.budgetReservation.amount > available) {
      const escalation: RunnerEscalation = Object.freeze({
        commandId: queued.commandId,
        operationId: queued.operationId,
        unit: budget.unit,
        requested: queued.budgetReservation.amount,
        available,
        createdAt: request.currentTime,
        reason: "budget-exhausted",
      });
      run.escalations.push(escalation);
      this.appendTransition(
        run,
        queued,
        "budget-escalated",
        request.currentTime,
        request.attemptId,
        {
          unit: budget.unit,
          requested: queued.budgetReservation.amount,
          available,
        },
      );
      this.faultInjector?.inject("after-intent-persist");
      return { type: "escalated", escalation };
    }

    const intent: EffectIntent = Object.freeze({
      command: queued,
      owner: request.lease.owner,
      fence: request.lease.fence,
      attemptId: request.attemptId,
      status: "intent",
      persistedAt: request.currentTime,
    });
    budget.reserved += queued.budgetReservation.amount;
    run.effects.set(queued.operationId, Object.freeze({ intent }));
    this.appendTransition(run, queued, "intent", request.currentTime, request.attemptId, {
      owner: intent.owner,
      fence: intent.fence,
      contextDigest: queued.contextDigest,
      inputDigest: queued.inputDigest,
      budgetReservation: {
        unit: queued.budgetReservation.unit,
        amount: queued.budgetReservation.amount,
      },
    });
    this.faultInjector?.inject("after-intent-persist");
    return { type: "persisted", intent };
  }

  commitEffect(request: CommitEffectRequest): EffectOutcome {
    this.faultInjector?.inject("before-effect-commit");
    const run = this.requiredRun(request.repositoryId, request.runId);
    this.assertFence(run, request.lease, request.currentTime);
    const record = run.effects.get(request.intent.command.operationId);
    if (
      record === undefined ||
      canonicalStringify(record.intent) !== canonicalStringify(request.intent)
    ) {
      throw new TypeError("Effect outcome does not match the durable intent");
    }
    const previous = record.outcome;
    const replay = run.outcomeAttempts
      .get(request.intent.command.operationId)
      ?.get(request.attemptId);
    if (replay !== undefined) return replay;
    if (previous !== undefined && isTerminal(previous.status)) return previous;
    const claim = run.claims.get(request.intent.command.operationId);
    if (
      claim === undefined ||
      claim.attemptId !== request.attemptId ||
      claim.owner !== request.lease.owner ||
      claim.fence !== request.lease.fence ||
      claim.contextDigest !== run.contextDigest
    ) {
      throw new TypeError("Effect outcome does not match the live durable attempt claim");
    }
    const observation = snapshotObservation(request.observation);

    const reservation = record.intent.command.budgetReservation;
    const usage = finalizeUsage(reservation, observation, isTerminal(observation.status));
    const reconciliationAttempts =
      previous === undefined
        ? observation.status === "unknown"
          ? 1
          : 0
        : Math.min(
            previous.reconciliationAttempts + 1,
            record.intent.command.maxReconciliationAttempts,
          );
    const outcome: EffectOutcome = deepFreeze({
      commandId: record.intent.command.commandId,
      operationId: record.intent.command.operationId,
      kind: record.intent.command.kind,
      owner: request.lease.owner,
      fence: request.lease.fence,
      attemptId: request.attemptId,
      contextDigest: record.intent.command.contextDigest,
      inputDigest: record.intent.command.inputDigest,
      status: observation.status,
      freshness: record.intent.command.contextDigest === run.contextDigest ? "current" : "stale",
      observedAt: observation.observedAt,
      reconciliationAttempts,
      usage,
      origin: claim.origin,
      ...(observation.details === undefined ? {} : { details: observation.details }),
      ...(observation.outputDigest === undefined ? {} : { outputDigest: observation.outputDigest }),
    });

    const budget = run.budgets.get(reservation.unit);
    if (budget === undefined) throw new TypeError("Durable effect reservation has no budget");
    if (isTerminal(outcome.status)) {
      budget.reserved -= reservation.amount;
      budget.spent += usage.reported ?? usage.unreported;
      budget.unreported += usage.unreported;
    }
    run.effects.set(
      outcome.operationId,
      Object.freeze({
        intent: record.intent,
        outcome,
        ...(record.cancellationRequestedAt === undefined
          ? {}
          : { cancellationRequestedAt: record.cancellationRequestedAt }),
      }),
    );
    const attempts = run.outcomeAttempts.get(outcome.operationId) ?? new Map();
    attempts.set(outcome.attemptId, outcome);
    run.outcomeAttempts.set(outcome.operationId, attempts);
    run.claims.delete(outcome.operationId);
    this.appendTransition(
      run,
      record.intent.command,
      outcome.status,
      outcome.observedAt,
      request.attemptId,
      {
        freshness: outcome.freshness,
        reconciliationAttempts: outcome.reconciliationAttempts,
        usage: {
          unit: outcome.usage.unit,
          reserved: outcome.usage.reserved,
          ...(outcome.usage.reported === undefined ? {} : { reported: outcome.usage.reported }),
          unreported: outcome.usage.unreported,
        },
        ...(outcome.outputDigest === undefined ? {} : { outputDigest: outcome.outputDigest }),
      },
    );
    this.faultInjector?.inject("after-effect-commit");
    return outcome;
  }

  setLease(repositoryId: string, runId: string, lease: RunnerLeaseFact): void {
    validateLease(lease);
    this.requiredRun(repositoryId, runId).lease = Object.freeze({ ...lease });
  }

  updateContext(input: FencedRunnerContextUpdateInput): void {
    validateDigest(input.contextDigest, "contextDigest");
    const run = this.requiredRun(input.repositoryId, input.runId);
    this.assertFence(run, input.lease, input.currentTime);
    if ([...run.claims.values()].some(({ fence }) => fence === input.lease.fence)) {
      throw new TypeError("Runner context cannot change while an effect attempt is claimed");
    }
    run.claims.clear();
    if (run.contextDigest === input.contextDigest) return;
    const previousContextDigest = run.contextDigest;
    run.contextDigest = input.contextDigest;
    this.appendRunTransition(run, "context-updated", input.currentTime, {
      previousContextDigest,
      contextDigest: input.contextDigest,
    });
  }

  requestCancellation(input: FencedRunnerCancellationInput): void {
    validateTimestamp(input.requestedAt, "requestedAt");
    if (Date.parse(input.requestedAt) > Date.parse(input.currentTime)) {
      throw new TypeError("requestedAt must not be later than currentTime");
    }
    const run = this.requiredRun(input.repositoryId, input.runId);
    this.assertFence(run, input.lease, input.currentTime);
    const record = run.effects.get(input.operationId);
    if (record === undefined) throw new TypeError("Cannot cancel an effect without an intent");
    if (record.outcome !== undefined && isTerminal(record.outcome.status)) return;
    if (record.cancellationRequestedAt !== undefined) return;
    run.effects.set(
      input.operationId,
      Object.freeze({ ...record, cancellationRequestedAt: input.requestedAt }),
    );
    this.appendTransition(
      run,
      record.intent.command,
      "cancellation-requested",
      input.requestedAt,
      undefined,
      { owner: input.lease.owner, fence: input.lease.fence },
    );
  }

  queryReceipts(repositoryId: string, runId: string): readonly RunnerEffectReceipt[] {
    return Object.freeze([...this.requiredRun(repositoryId, runId).receipts]);
  }

  queryEvents(repositoryId: string, runId: string): readonly RunnerEffectEvent[] {
    return Object.freeze([...this.requiredRun(repositoryId, runId).events]);
  }

  queryProjection(repositoryId: string, runId: string): RunnerProjection {
    return this.requiredRun(repositoryId, runId).projection;
  }

  queryBudgets(repositoryId: string, runId: string): readonly RunnerBudgetState[] {
    return Object.freeze(
      [...this.requiredRun(repositoryId, runId).budgets.values()]
        .sort((left, right) => compareText(left.unit, right.unit))
        .map((budget) => Object.freeze({ ...budget })),
    );
  }

  private appendTransition(
    run: InMemoryRunnerRun,
    command: QueuedEffectCommand,
    status: RunnerEffectReceipt["status"] | "budget-escalated",
    occurredAt: string,
    attemptId: string | undefined,
    payload: JsonValue,
  ): void {
    const cursor = run.cursor + 1;
    const receipt: RunnerEffectReceipt = Object.freeze({
      cursor,
      repositoryId: run.repositoryId,
      runId: run.runId,
      commandId: command.commandId,
      operationId: command.operationId,
      status: status === "budget-escalated" ? "failed" : status,
      occurredAt,
      ...(attemptId === undefined ? {} : { attemptId }),
    });
    const event: RunnerEffectEvent = Object.freeze({
      cursor,
      repositoryId: run.repositoryId,
      runId: run.runId,
      commandId: command.commandId,
      operationId: command.operationId,
      eventType: `effect-${status}`,
      occurredAt,
      payload,
    });
    run.cursor = cursor;
    run.receipts.push(receipt);
    run.events.push(event);
    run.projection = this.project(run);
  }

  private appendRunTransition(
    run: InMemoryRunnerRun,
    status: "context-updated",
    occurredAt: string,
    payload: JsonValue,
  ): void {
    const cursor = run.cursor + 1;
    run.cursor = cursor;
    run.receipts.push(
      Object.freeze({
        cursor,
        repositoryId: run.repositoryId,
        runId: run.runId,
        status,
        occurredAt,
      }),
    );
    run.events.push(
      Object.freeze({
        cursor,
        repositoryId: run.repositoryId,
        runId: run.runId,
        eventType: `runner-${status}`,
        occurredAt,
        payload,
      }),
    );
    run.projection = this.project(run);
  }

  private project(run: InMemoryRunnerRun): RunnerProjection {
    const effects = [...run.effects.values()]
      .flatMap(({ outcome }) => {
        if (outcome === undefined || outcome.contextDigest !== run.contextDigest) return [];
        return [
          Object.freeze({
            operationId: outcome.operationId,
            status: outcome.status,
            ...(outcome.outputDigest === undefined ? {} : { outputDigest: outcome.outputDigest }),
          }),
        ];
      })
      .sort((left, right) => compareText(left.operationId, right.operationId));
    return Object.freeze({
      cursor: run.cursor,
      contextDigest: run.contextDigest,
      effects: Object.freeze(effects),
    });
  }

  private assertFence(
    run: InMemoryRunnerRun,
    supplied: RunnerLeaseFact,
    currentTime: string,
  ): void {
    validateTimestamp(currentTime, "currentTime");
    if (
      supplied.owner !== run.lease.owner ||
      supplied.fence !== run.lease.fence ||
      supplied.expiresAt !== run.lease.expiresAt ||
      Date.parse(currentTime) >= Date.parse(run.lease.expiresAt)
    ) {
      throw new TypeError("Runner authority rejected a stale or expired lease fence");
    }
  }

  private requiredRun(repositoryId: string, runId: string): InMemoryRunnerRun {
    const run = this.runs.get(runKey(repositoryId, runId));
    if (run === undefined) throw new TypeError("Runner run is not configured");
    return run;
  }
}

function finalizeUsage(
  reservation: QueuedEffectCommand["budgetReservation"],
  observation: CommitEffectRequest["observation"],
  terminal: boolean,
): FinalizedEffectUsage {
  if (observation.usage !== undefined && observation.usage.unit !== reservation.unit) {
    throw new TypeError("Effect usage unit must match its budget reservation");
  }
  if (observation.usage !== undefined && observation.usage.amount > reservation.amount) {
    throw new TypeError("Effect reported usage must not exceed its budget reservation");
  }
  return Object.freeze({
    unit: reservation.unit,
    reserved: reservation.amount,
    ...(observation.usage === undefined ? {} : { reported: observation.usage.amount }),
    unreported: terminal && observation.usage === undefined ? reservation.amount : 0,
  });
}

function validateCommand(command: QueuedEffectCommand): void {
  if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) {
    throw new TypeError("Runner command sequence must be a positive safe integer");
  }
  validateIdentity(command.commandId, "commandId");
  validateIdentity(command.repositoryId, "repositoryId");
  validateIdentity(command.runId, "runId");
  validateIdentity(command.operationId, "operationId");
  if (!["worker", "sensor", "git", "asset", "time"].includes(command.kind)) {
    throw new TypeError("Runner command effect kind is invalid");
  }
  validateDigest(command.contextDigest, "contextDigest");
  validateDigest(command.inputDigest, "inputDigest");
  canonicalStringify(command.input);
  validateUnit(command.budgetReservation.unit);
  validateAmount(command.budgetReservation.amount, "budget reservation");
  validateTimestamp(command.queuedAt, "queuedAt");
  if (command.deadline !== undefined) validateTimestamp(command.deadline, "deadline");
  if (
    !Number.isSafeInteger(command.maxReconciliationAttempts) ||
    command.maxReconciliationAttempts < 1
  ) {
    throw new TypeError("Runner reconciliation limit must be a positive safe integer");
  }
}

function validateObservation(observation: CommitEffectRequest["observation"]): void {
  if (!["active", "completed", "failed", "cancelled", "unknown"].includes(observation.status)) {
    throw new TypeError("Effect observation status is invalid");
  }
  validateTimestamp(observation.observedAt, "observedAt");
  if (observation.details !== undefined) canonicalStringify(observation.details);
  if (observation.outputDigest !== undefined)
    validateDigest(observation.outputDigest, "outputDigest");
  if (observation.usage !== undefined) {
    validateUnit(observation.usage.unit);
    validateAmount(observation.usage.amount, "reported usage");
  }
}

function snapshotCommand(command: QueuedEffectCommand): QueuedEffectCommand {
  return deepFreeze(JSON.parse(canonicalStringify(command)) as QueuedEffectCommand);
}

function snapshotObservation(
  observation: CommitEffectRequest["observation"],
): CommitEffectRequest["observation"] {
  validateObservation(observation);
  return deepFreeze(
    JSON.parse(canonicalStringify(observation)) as CommitEffectRequest["observation"],
  );
}

function validateLease(lease: RunnerLeaseFact): void {
  validateIdentity(lease.owner, "lease owner");
  if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) {
    throw new TypeError("Lease fence must be a positive safe integer");
  }
  validateTimestamp(lease.expiresAt, "lease expiry");
}

function validateDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
}

function validateIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
}

function validateUnit(unit: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(unit)) {
    throw new TypeError("Budget unit must be a lowercase bounded key");
  }
}

function validateAmount(amount: number, subject: string): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError(`${subject} must be a non-negative safe integer`);
  }
}

function validateTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a UTC RFC 3339 timestamp`);
  }
}

function isTerminal(status: EffectOutcome["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function runKey(repositoryId: string, runId: string): string {
  return `${repositoryId}\u0000${runId}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
