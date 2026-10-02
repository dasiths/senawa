import { canonicalStringify, type JsonValue } from "@senawa/protocol";
import type {
  ClaimEffectAttemptRequest,
  ClaimEffectAttemptResult,
  CommitEffectRequest,
  EffectAttemptOrigin,
  EffectIntent,
  EffectOutcome,
  EnsureTaskScopesAndBudgetsInput,
  FencedRunnerCancellationInput,
  FencedRunnerContextUpdateInput,
  FinalizedEffectUsage,
  PersistIntentRequest,
  PersistIntentResult,
  QueuedEffectCommand,
  RunnerAuthorityPort,
  RunnerAuthoritySnapshot,
  RunnerCapacityState,
  RunnerEffectRecord,
  RunnerEscalation,
  RunnerLeaseFact,
} from "./runner.js";
import { selectEffectAttemptAction } from "./runner.js";
import {
  type InstallTaskScopeFencesInput,
  type TaskScope,
  type TaskScopeCurrentness,
  type TaskScopeFence,
  taskScopeFence,
  taskScopeKey,
} from "./task-currentness.js";

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
    | "scope-fenced"
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
  readonly taskScopes: readonly TaskScopeCurrentness[];
  readonly repositoryId: string;
  readonly runId: string;
  readonly contextDigest: string;
  readonly budgets: readonly { readonly unit: string; readonly limit: number }[];
  readonly capacities?: readonly RunnerCapacityState[];
  readonly lease: RunnerLeaseFact;
}

interface MutableBudgetState {
  unit: string;
  limit: number;
  reserved: number;
  spent: number;
  unreported: number;
}

interface MutableCapacityState {
  resource: "writer";
  limit: number;
  occupied: number;
}

interface InMemoryEffectClaim {
  readonly taskScope: TaskScopeFence;
  readonly attemptId: string;
  readonly owner: string;
  readonly fence: number;
  readonly origin: EffectAttemptOrigin;
}

interface InMemoryRunnerRun {
  repositoryId: string;
  runId: string;
  contextDigest: string;
  taskScopes: Map<string, TaskScopeCurrentness>;
  lease: RunnerLeaseFact;
  queuedCommands: QueuedEffectCommand[];
  effects: Map<string, RunnerEffectRecord>;
  outcomeAttempts: Map<string, Map<string, EffectOutcome>>;
  claims: Map<string, InMemoryEffectClaim>;
  escalations: RunnerEscalation[];
  budgets: Map<string, MutableBudgetState>;
  capacities: Map<string, MutableCapacityState>;
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
    const taskScopes = new Map<string, TaskScopeCurrentness>();
    for (const scope of input.taskScopes) {
      validateTaskScopeCurrentness(scope, input.runId);
      const scopeKey = taskScopeKey(scope);
      if (taskScopes.has(scopeKey)) throw new TypeError("Runner task scopes must be unique");
      taskScopes.set(scopeKey, deepFreeze({ ...scope }));
    }
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
    const capacities = new Map<string, MutableCapacityState>();
    for (const capacity of input.capacities ?? [
      { resource: "writer" as const, limit: 1, occupied: 0 },
    ]) {
      validateCapacityState(capacity);
      if (capacities.has(capacity.resource)) {
        throw new TypeError("Runner capacity resources must be unique");
      }
      capacities.set(capacity.resource, { ...capacity });
    }
    this.runs.set(key, {
      repositoryId: input.repositoryId,
      runId: input.runId,
      contextDigest: input.contextDigest,
      taskScopes,
      lease: Object.freeze({ ...input.lease }),
      queuedCommands: [],
      effects: new Map(),
      outcomeAttempts: new Map(),
      claims: new Map(),
      escalations: [],
      budgets,
      capacities,
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
      taskScopes: Object.freeze(
        [...run.taskScopes.values()]
          .sort(compareTaskScope)
          .map((scope) => deepFreeze({ ...scope })),
      ),
      queuedCommands: Object.freeze([...run.queuedCommands]),
      effects: Object.freeze([...run.effects.values()]),
      escalations: Object.freeze([...run.escalations]),
      capacities: Object.freeze(
        [...run.capacities.values()]
          .sort((left, right) => compareText(left.resource, right.resource))
          .map((capacity) => Object.freeze({ ...capacity })),
      ),
    });
  }

  assertLease(input: PersistIntentRequest): void {
    const run = this.requiredRun(input.repositoryId, input.runId);
    this.assertFence(run, input.lease, input.currentTime);
  }

  ensureTaskScopesAndBudgets(input: EnsureTaskScopesAndBudgetsInput): void {
    const run = this.requiredRun(input.repositoryId, input.runId);
    this.assertFence(run, input.lease, input.currentTime);
    const scopes = new Map<string, TaskScopeCurrentness>();
    for (const scope of input.taskScopes) {
      validateTaskScopeCurrentness(scope, input.runId);
      if (!scope.claimsAccepted)
        throw new TypeError("Admitted runner task scopes must accept claims");
      const key = taskScopeKey(scope);
      if (scopes.has(key)) throw new TypeError("Admitted runner task scopes must be unique");
      scopes.set(key, scope);
      const existing = run.taskScopes.get(key);
      if (existing !== undefined && canonicalStringify(existing) !== canonicalStringify(scope)) {
        throw new TypeError("Runner task scope admission conflicts with durable currentness");
      }
    }
    const budgets = new Map<string, number>();
    for (const budget of input.budgets) {
      validateUnit(budget.unit);
      validateAmount(budget.limit, "budget limit");
      if (budgets.has(budget.unit)) throw new TypeError("Admitted runner budgets must be unique");
      budgets.set(budget.unit, budget.limit);
      const existing = run.budgets.get(budget.unit);
      if (existing !== undefined && budget.limit < existing.limit) {
        throw new TypeError("Runner budget admission cannot reduce a durable limit");
      }
    }
    for (const [key, scope] of scopes) {
      if (!run.taskScopes.has(key)) run.taskScopes.set(key, deepFreeze({ ...scope }));
    }
    for (const [unit, limit] of budgets) {
      const existing = run.budgets.get(unit);
      if (existing === undefined) {
        run.budgets.set(unit, { unit, limit, reserved: 0, spent: 0, unreported: 0 });
      } else {
        existing.limit = limit;
      }
    }
  }

  installTaskScopeFences(input: InstallTaskScopeFencesInput): readonly TaskScopeCurrentness[] {
    const run = this.requiredRun(input.repositoryId, input.runId);
    validateTimestamp(input.installedAt, "installedAt");
    const installations = [...input.fences].sort((left, right) =>
      compareTaskScope(left.scope, right.scope),
    );
    const seen = new Set<string>();
    const current = installations.map((installation) => {
      if (installation.scope.runId !== input.runId)
        throw new TypeError("Runner fence scope does not match the target run");
      const key = taskScopeKey(installation.scope);
      if (seen.has(key)) throw new TypeError("Runner fence installations must be unique");
      seen.add(key);
      const scope = run.taskScopes.get(key);
      if (scope === undefined) throw new TypeError("Runner fence names an unknown task scope");
      if (
        scope.fenceGeneration !== installation.expectedFenceGeneration ||
        scope.acceptedContextDigest !== installation.expectedAcceptedContextDigest
      )
        throw new TypeError("Runner fence expectation is stale");
      if (!scope.claimsAccepted) throw new TypeError("Runner task scope is already fenced");
      return scope;
    });
    const installed = current.map((scope) => {
      const next = deepFreeze({
        ...scope,
        fenceGeneration: scope.fenceGeneration + 1,
        claimsAccepted: false,
      });
      run.taskScopes.set(taskScopeKey(scope), next);
      for (const [operationId, record] of run.effects) {
        if (
          (record.outcome === undefined || !isTerminal(record.outcome.status)) &&
          sameTaskScope(record.intent.command.taskScope, scope) &&
          record.cancellationRequestedAt === undefined
        )
          run.effects.set(
            operationId,
            Object.freeze({ ...record, cancellationRequestedAt: input.installedAt }),
          );
      }
      return next;
    });
    for (const scope of installed)
      this.appendRunTransition(run, "scope-fenced", input.installedAt, {
        taskId: scope.taskId,
        definitionGeneration: scope.definitionGeneration,
        acceptedContextDigest: scope.acceptedContextDigest,
        fenceGeneration: scope.fenceGeneration,
      });
    return Object.freeze(installed);
  }

  claimEffectAttempt(request: ClaimEffectAttemptRequest): ClaimEffectAttemptResult {
    const run = this.requiredRun(request.repositoryId, request.runId);
    this.assertFence(run, request.lease, request.currentTime);
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
    const currentness = run.taskScopes.get(taskScopeKey(record.intent.command.taskScope));
    if (currentness === undefined) throw new TypeError("Effect claim names an unknown task scope");
    if (!sameTaskScopeFence(request.taskScope, currentness))
      throw new TypeError("Effect claim task scope does not match durable currentness");
    const action = selectEffectAttemptAction(record, request.currentTime, request.attemptId);
    if (
      action === "dispatch" &&
      (!currentness.claimsAccepted ||
        !sameTaskScopeFence(record.intent.command.taskScope, currentness))
    )
      return { type: "fenced", currentness };
    const existing = run.claims.get(request.intent.command.operationId);
    if (existing !== undefined && existing.fence === request.lease.fence) return { type: "busy" };
    run.claims.set(
      request.intent.command.operationId,
      Object.freeze({
        attemptId: request.attemptId,
        owner: request.lease.owner,
        fence: request.lease.fence,
        taskScope: deepFreeze({ ...request.taskScope }),
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
    const currentness = run.taskScopes.get(taskScopeKey(queued.taskScope));
    if (
      currentness === undefined ||
      !currentness.claimsAccepted ||
      !sameTaskScopeFence(queued.taskScope, currentness)
    )
      throw new TypeError("Runner command task scope is fenced before effect intent persistence");

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

    const capacityReservation = queued.capacityReservation;
    const capacity =
      capacityReservation === undefined
        ? undefined
        : run.capacities.get(capacityReservation.resource);
    if (capacityReservation !== undefined && capacity === undefined) {
      throw new TypeError("Runner command names an unknown capacity resource");
    }
    if (capacityReservation !== undefined && capacity !== undefined) {
      const capacityAvailable = Math.max(0, capacity.limit - capacity.occupied);
      if (capacityReservation.amount > capacityAvailable) {
        return {
          type: "capacity-unavailable",
          reservation: capacityReservation,
          available: capacityAvailable,
        };
      }
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
    if (capacityReservation !== undefined && capacity !== undefined) {
      capacity.occupied += capacityReservation.amount;
    }
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
      !sameTaskScope(claim.taskScope, request.intent.command.taskScope)
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
      commandTaskScope: record.intent.command.taskScope,
      claimTaskScope: claim.taskScope,
      contextDigest: record.intent.command.contextDigest,
      inputDigest: record.intent.command.inputDigest,
      status: observation.status,
      freshness: isCurrentOutcome(run, record.intent.command.taskScope, claim.taskScope)
        ? "current"
        : "stale",
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
      const capacityReservation = record.intent.command.capacityReservation;
      if (capacityReservation !== undefined) {
        const capacity = run.capacities.get(capacityReservation.resource);
        if (capacity === undefined)
          throw new TypeError("Durable effect reservation has no capacity");
        capacity.occupied -= capacityReservation.amount;
      }
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

  queryCapacities(repositoryId: string, runId: string): readonly RunnerCapacityState[] {
    return Object.freeze(
      [...this.requiredRun(repositoryId, runId).capacities.values()]
        .sort((left, right) => compareText(left.resource, right.resource))
        .map((capacity) => Object.freeze({ ...capacity })),
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
    status: "context-updated" | "scope-fenced",
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
        if (
          outcome === undefined ||
          !isCurrentOutcome(run, outcome.commandTaskScope, outcome.claimTaskScope)
        )
          return [];
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
  validateTaskScopeFence(command.taskScope, command.runId);
  if (command.contextDigest !== command.taskScope.acceptedContextDigest)
    throw new TypeError("Runner command context must equal its accepted task scope context");
  if (!["worker", "sensor", "git", "asset", "time"].includes(command.kind)) {
    throw new TypeError("Runner command effect kind is invalid");
  }
  validateDigest(command.contextDigest, "contextDigest");
  validateDigest(command.inputDigest, "inputDigest");
  canonicalStringify(command.input);
  validateUnit(command.budgetReservation.unit);
  validateAmount(command.budgetReservation.amount, "budget reservation");
  if (command.capacityReservation !== undefined) {
    if (command.capacityReservation.resource !== "writer") {
      throw new TypeError("Effect capacity resource must be writer");
    }
    validatePositiveAmount(command.capacityReservation.amount, "capacity reservation");
  }
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

function validatePositiveAmount(amount: number, subject: string): void {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new TypeError(`${subject} must be a positive safe integer`);
  }
}

function validateCapacityState(capacity: RunnerCapacityState): void {
  if (capacity.resource !== "writer")
    throw new TypeError("Runner capacity resource must be writer");
  validatePositiveAmount(capacity.limit, "capacity limit");
  validateAmount(capacity.occupied, "occupied capacity");
  if (capacity.occupied > capacity.limit) {
    throw new TypeError("Occupied runner capacity must not exceed its limit");
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

function validateTaskScopeFence(scope: TaskScopeFence, runId: string): void {
  if (
    Object.keys(scope).sort().join(",") !==
    "acceptedContextDigest,definitionGeneration,fenceGeneration,runId,taskId"
  )
    throw new TypeError("Task scope fence must contain exactly its five authority fields");
  if (scope.runId !== runId) throw new TypeError("Task scope run does not match its command run");
  validateIdentity(scope.taskId, "taskScope.taskId");
  if (!Number.isSafeInteger(scope.definitionGeneration) || scope.definitionGeneration < 1)
    throw new TypeError("Task scope definition generation must be a positive safe integer");
  validateDigest(scope.acceptedContextDigest, "taskScope.acceptedContextDigest");
  if (!Number.isSafeInteger(scope.fenceGeneration) || scope.fenceGeneration < 1)
    throw new TypeError("Task scope fence generation must be a positive safe integer");
}

function validateTaskScopeCurrentness(scope: TaskScopeCurrentness, runId: string): void {
  if (
    Object.keys(scope).sort().join(",") !==
    "acceptedContextDigest,claimsAccepted,definitionGeneration,fenceGeneration,runId,taskId"
  )
    throw new TypeError("Task scope currentness must contain exactly its six authority fields");
  validateTaskScopeFence(taskScopeFence(scope), runId);
  if (typeof scope.claimsAccepted !== "boolean")
    throw new TypeError("Task scope claimsAccepted must be boolean");
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

function compareTaskScope(left: TaskScope, right: TaskScope): number {
  return (
    compareText(left.runId, right.runId) ||
    compareText(left.taskId, right.taskId) ||
    left.definitionGeneration - right.definitionGeneration
  );
}

function isCurrentOutcome(
  run: InMemoryRunnerRun,
  commandScope: TaskScopeFence,
  claimScope: TaskScopeFence,
): boolean {
  const currentness = run.taskScopes.get(taskScopeKey(commandScope));
  return (
    currentness?.claimsAccepted === true &&
    sameTaskScopeFence(commandScope, currentness) &&
    sameTaskScopeFence(claimScope, currentness)
  );
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
