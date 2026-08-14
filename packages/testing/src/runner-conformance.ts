import type {
  AsyncEffectHost,
  AsyncEffectHostContext,
  EffectHost,
  EffectInspection,
  EffectIntent,
  EffectObservation,
  FencedRunnerCancellationInput,
  FencedRunnerContextUpdateInput,
  InMemoryRunnerRunInput,
  QueuedEffectCommand,
  RunnerAuthorityPort,
  RunnerBudgetState,
  RunnerCapacityState,
  RunnerEffectEvent,
  RunnerEffectReceipt,
  RunnerLeaseFact,
  RunnerProjection,
  RunOnceInput,
  TaskScopeCurrentness,
} from "@senawa/runtime";
import { taskScopeFence } from "@senawa/runtime";

export const runnerFixture = Object.freeze({
  repositoryId: "repository_runner-fixture",
  runId: "run_runner-fixture",
  contextDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
  outputDigest: "c".repeat(64),
  taskId: "task_runner-fixture",
  currentTime: "2026-08-12T12:00:00.000Z",
  lease: Object.freeze({
    owner: "runner-owner-primary",
    fence: 1,
    expiresAt: "2026-08-12T13:00:00.000Z",
  }),
});

export const runnerTaskScope: TaskScopeCurrentness = Object.freeze({
  runId: runnerFixture.runId,
  taskId: runnerFixture.taskId,
  definitionGeneration: 1,
  acceptedContextDigest: runnerFixture.contextDigest,
  fenceGeneration: 1,
  claimsAccepted: true,
});
export const runnerTaskFence = taskScopeFence(runnerTaskScope);

export interface RunnerAuthorityConformanceHarness {
  readonly authority: RunnerAuthorityPort;
  configureRun(input: InMemoryRunnerRunInput): void;
  enqueue(command: QueuedEffectCommand): void;
  updateContext(input: FencedRunnerContextUpdateInput): void;
  requestCancellation(input: FencedRunnerCancellationInput): void;
  queryReceipts(repositoryId: string, runId: string): readonly RunnerEffectReceipt[];
  queryEvents(repositoryId: string, runId: string): readonly RunnerEffectEvent[];
  queryProjection(repositoryId: string, runId: string): RunnerProjection;
  queryBudgets(repositoryId: string, runId: string): readonly RunnerBudgetState[];
  queryCapacities(repositoryId: string, runId: string): readonly RunnerCapacityState[];
}

export type RunnerAuthorityConformanceFactory = () => RunnerAuthorityConformanceHarness;

export interface FakeEffectHostOptions {
  readonly beforeDispatch?: (intent: EffectIntent) => void;
  readonly reportUsage?: boolean;
  readonly dispatch?: (intent: EffectIntent, host: FakeEffectHost) => EffectObservation;
  readonly inspect?: (intent: EffectIntent, host: FakeEffectHost) => EffectInspection;
  readonly cancel?: (intent: EffectIntent, host: FakeEffectHost) => EffectObservation;
}

export class FakeEffectHost implements EffectHost {
  readonly options: FakeEffectHostOptions;
  readonly observations = new Map<string, EffectObservation>();
  dispatchCalls = 0;
  inspectCalls = 0;
  cancelCalls = 0;

  constructor(options: FakeEffectHostOptions = {}) {
    this.options = options;
  }

  dispatch(intent: EffectIntent): EffectObservation {
    this.dispatchCalls += 1;
    this.options.beforeDispatch?.(intent);
    if (this.options.dispatch !== undefined) return this.options.dispatch(intent, this);
    const observation: EffectObservation = {
      status: "completed",
      observedAt: runnerFixture.currentTime,
      outputDigest: runnerFixture.outputDigest,
      ...(this.options.reportUsage === false
        ? {}
        : {
            usage: {
              unit: intent.command.budgetReservation.unit,
              amount: Math.min(3, intent.command.budgetReservation.amount),
            },
          }),
    };
    this.observations.set(intent.command.operationId, observation);
    return observation;
  }

  inspect(intent: EffectIntent): EffectInspection {
    this.inspectCalls += 1;
    if (this.options.inspect !== undefined) return this.options.inspect(intent, this);
    const observation = this.observations.get(intent.command.operationId);
    if (observation === undefined) {
      return { status: "missing", observedAt: runnerFixture.currentTime };
    }
    if (observation.status === "failed") {
      return {
        status: "unknown",
        observedAt: observation.observedAt,
        ...(observation.details === undefined ? {} : { details: observation.details }),
      };
    }
    return {
      status: observation.status,
      observedAt: observation.observedAt,
      ...(observation.details === undefined ? {} : { details: observation.details }),
      ...(observation.outputDigest === undefined ? {} : { outputDigest: observation.outputDigest }),
      ...(observation.usage === undefined ? {} : { usage: observation.usage }),
    };
  }

  cancel(intent: EffectIntent): EffectObservation {
    this.cancelCalls += 1;
    if (this.options.cancel !== undefined) return this.options.cancel(intent, this);
    const observation: EffectObservation = {
      status: "cancelled",
      observedAt: runnerFixture.currentTime,
      details: { reason: "cancelled-by-runner" },
    };
    this.observations.set(intent.command.operationId, observation);
    return observation;
  }
}

export class FakeAsyncEffectHost implements AsyncEffectHost {
  readonly host: FakeEffectHost;
  readonly contexts: AsyncEffectHostContext[] = [];

  constructor(options: FakeEffectHostOptions = {}) {
    this.host = new FakeEffectHost(options);
  }

  async dispatch(
    intent: EffectIntent,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    this.contexts.push(context);
    return this.host.dispatch(intent);
  }

  async inspect(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectInspection> {
    this.contexts.push(context);
    return this.host.inspect(intent);
  }

  async cancel(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectObservation> {
    this.contexts.push(context);
    return this.host.cancel(intent);
  }
}

export function runnerEffectCommand(
  overrides: Partial<QueuedEffectCommand> = {},
): QueuedEffectCommand {
  return {
    sequence: 1,
    commandId: "runner-command-effect",
    repositoryId: runnerFixture.repositoryId,
    runId: runnerFixture.runId,
    operationId: "operation_runner-effect",
    kind: "worker",
    taskScope: runnerTaskFence,
    contextDigest: runnerFixture.contextDigest,
    inputDigest: runnerFixture.inputDigest,
    input: { task: "verify" },
    budgetReservation: { unit: "model-millidollars", amount: 5 },
    queuedAt: runnerFixture.currentTime,
    maxReconciliationAttempts: 2,
    ...overrides,
  };
}

export function runOnceInput(overrides: Partial<RunOnceInput> = {}): RunOnceInput {
  return {
    repositoryId: runnerFixture.repositoryId,
    runId: runnerFixture.runId,
    lease: runnerFixture.lease,
    currentTime: runnerFixture.currentTime,
    attemptId: "runner-attempt-1",
    ...overrides,
  };
}

export function configuredHarness<T extends { configureRun(input: InMemoryRunnerRunInput): void }>(
  harness: T,
): T {
  harness.configureRun({
    repositoryId: runnerFixture.repositoryId,
    runId: runnerFixture.runId,
    contextDigest: runnerFixture.contextDigest,
    taskScopes: [runnerTaskScope],
    budgets: [
      { unit: "model-millidollars", limit: 10 },
      { unit: "retry", limit: 2 },
    ],
    lease: runnerFixture.lease,
  });
  return harness;
}

export function takeoverLease(): RunnerLeaseFact {
  return {
    owner: "runner-owner-takeover",
    fence: 2,
    expiresAt: "2026-08-12T14:00:00.000Z",
  };
}
