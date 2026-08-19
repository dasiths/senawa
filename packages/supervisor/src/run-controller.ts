import {
  type AsyncEffectHost,
  AsyncFencedRunner,
  AsyncRunnerCancelledError,
  type EffectHost,
  FencedRunner,
  type FencedRunnerCancellationInput,
  planFailurePolicyActions,
  type RunBatchResult,
  type RunnerAuthorityPort,
  type RunOnceResult,
} from "@senawa/runtime";
import type { LeaseGrant } from "@senawa/storage-sqlite";
import type { SqliteSupervisorAuthority } from "./command-queue.js";
import type { SupervisorReceipt } from "./contracts.js";

const LEASE_DURATION_MS = 30_000;
const LEASE_RENEWAL_WINDOW_MS = 10_000;

export interface SupervisorRunControllerOptions {
  readonly authority: SqliteSupervisorAuthority;
  readonly effectHost?: EffectHost;
  readonly asyncEffectHost?: AsyncEffectHost;
  readonly runnerAuthority?: RunnerAuthorityPort;
  readonly deliverCompletionOutboxOnce?: () => boolean;
  readonly deliverAmendmentProposalOutboxOnce?: () => boolean;
  readonly timer?: SupervisorTimer;
  readonly runnerBatchSize?: number;
  readonly failurePolicyForRun?: (
    repositoryId: string,
    runId: string,
  ) => "continue" | "fail-fast" | undefined;
  readonly scheduleBeforeEffects?: (input: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly lease: import("@senawa/runtime").RunnerLeaseFact;
    readonly currentTime: string;
  }) => { readonly worked: boolean; readonly batchSize?: number };
  /**
   * Moves a run's workflow forward: delivers answers, closes phases, dispatches
   * the next one. Runs under this controller's lease, so nothing else drives
   * the same run at the same time.
   */
  readonly driveRunOnce?: (input: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly currentTime: string;
  }) => Promise<boolean>;
}

interface FailurePolicyRunnerAuthority extends RunnerAuthorityPort {
  requestCancellation?(input: FencedRunnerCancellationInput): void;
}

export interface SupervisorTimerHandle {
  cancel(): void;
}

export interface SupervisorTimer {
  schedule(delayMilliseconds: number, callback: () => void): SupervisorTimerHandle;
}

export interface SupervisorRunControllerInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly currentTime: () => string;
  readonly attemptId: string;
  readonly runEffects?: boolean;
}

export interface SupervisorRunControllerResult {
  readonly lease: LeaseGrant;
  readonly receipt?: SupervisorReceipt;
  readonly completionDelivered: boolean;
  readonly amendmentProposalDelivered: boolean;
  readonly amendmentApplyQueued: boolean;
  readonly runner?: RunOnceResult | RunBatchResult;
  readonly worked: boolean;
}

export class SupervisorRunController {
  readonly authority: SqliteSupervisorAuthority;
  readonly #runner: FencedRunner | undefined;
  readonly #asyncRunner: AsyncFencedRunner | undefined;
  readonly #deliverCompletionOutboxOnce: (() => boolean) | undefined;
  readonly #deliverAmendmentProposalOutboxOnce: (() => boolean) | undefined;
  readonly #timer: SupervisorTimer;
  readonly #runnerBatchSize: number;
  readonly #runnerAuthority: FailurePolicyRunnerAuthority | undefined;
  readonly #failurePolicyForRun:
    | ((repositoryId: string, runId: string) => "continue" | "fail-fast" | undefined)
    | undefined;
  readonly #scheduleBeforeEffects: SupervisorRunControllerOptions["scheduleBeforeEffects"];
  readonly #driveRunOnce: SupervisorRunControllerOptions["driveRunOnce"];

  constructor(options: SupervisorRunControllerOptions) {
    this.authority = options.authority;
    if (options.effectHost !== undefined && options.asyncEffectHost !== undefined) {
      throw new TypeError("Sync and async effect hosts are mutually exclusive");
    }
    const hostConfigured =
      options.effectHost !== undefined || options.asyncEffectHost !== undefined;
    if (hostConfigured !== (options.runnerAuthority !== undefined)) {
      throw new TypeError("Effect host and runner authority must be configured together");
    }
    this.#runner =
      options.effectHost === undefined
        ? undefined
        : new FencedRunner(required(options.runnerAuthority), options.effectHost);
    this.#asyncRunner =
      options.asyncEffectHost === undefined
        ? undefined
        : new AsyncFencedRunner(required(options.runnerAuthority), options.asyncEffectHost);
    this.#deliverCompletionOutboxOnce = options.deliverCompletionOutboxOnce;
    this.#deliverAmendmentProposalOutboxOnce = options.deliverAmendmentProposalOutboxOnce;
    this.#timer = options.timer ?? systemTimer;
    this.#runnerBatchSize = options.runnerBatchSize ?? 1;
    this.#runnerAuthority = options.runnerAuthority;
    this.#failurePolicyForRun = options.failurePolicyForRun;
    this.#scheduleBeforeEffects = options.scheduleBeforeEffects;
    this.#driveRunOnce = options.driveRunOnce;
    if (!Number.isSafeInteger(this.#runnerBatchSize) || this.#runnerBatchSize < 1) {
      throw new TypeError("Runner batch size must be a positive safe integer");
    }
  }

  runOnce(input: SupervisorRunControllerInput): SupervisorRunControllerResult {
    if (this.#asyncRunner !== undefined) {
      throw new TypeError("An async effect host requires runOnceAsync");
    }
    const acquiredAt = input.currentTime();
    let lease = this.authority.acquireRunLease(
      input.repositoryId,
      input.runId,
      input.ownerId,
      acquiredAt,
      addMilliseconds(acquiredAt, LEASE_DURATION_MS),
    );
    let completed = false;
    try {
      const receipt = this.authority.drainRunOnce({
        repositoryId: input.repositoryId,
        runId: input.runId,
        lease,
        currentTime: input.currentTime(),
      });
      const completionDelivered = this.#deliverCompletionOutboxOnce?.() ?? false;
      const amendmentProposalDelivered = this.#deliverAmendmentProposalOutboxOnce?.() ?? false;
      const amendmentRecovery = this.authority
        .listApprovedAmendmentRecoveries()
        .find(
          (candidate) =>
            candidate.repositoryId === input.repositoryId && candidate.runId === input.runId,
        );
      const amendmentApplyQueued =
        amendmentRecovery === undefined
          ? false
          : this.authority.queueApprovedAmendmentApply(amendmentRecovery, input.currentTime());
      const runnerTime = input.currentTime();
      if (Date.parse(lease.expiresAt) - Date.parse(runnerTime) <= LEASE_RENEWAL_WINDOW_MS) {
        lease = this.authority.renewRunLease(
          lease,
          runnerTime,
          addMilliseconds(runnerTime, LEASE_DURATION_MS),
        );
      }
      const scheduled = this.#scheduleBeforeEffects?.({
        repositoryId: input.repositoryId,
        runId: input.runId,
        lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
        currentTime: runnerTime,
      });
      const runnable = this.authority
        .listRunnableRuns()
        .some((run) => run.repositoryId === input.repositoryId && run.runId === input.runId);
      const runner =
        input.runEffects !== false && runnable
          ? this.runSyncEffects(
              {
                repositoryId: input.repositoryId,
                runId: input.runId,
                lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
                currentTime: runnerTime,
                attemptId: input.attemptId,
              },
              scheduled?.batchSize,
            )
          : undefined;
      const worked =
        receipt !== undefined ||
        completionDelivered ||
        amendmentProposalDelivered ||
        amendmentApplyQueued ||
        scheduled?.worked === true ||
        runnerWorked(runner);
      completed = true;
      return {
        lease,
        ...(receipt === undefined ? {} : { receipt }),
        completionDelivered,
        amendmentProposalDelivered,
        amendmentApplyQueued,
        ...(runner === undefined ? {} : { runner }),
        worked,
      };
    } finally {
      if (completed) this.authority.releaseRunLease(lease, input.currentTime());
    }
  }

  async runOnceAsync(input: SupervisorRunControllerInput): Promise<SupervisorRunControllerResult> {
    const acquiredAt = input.currentTime();
    let lease = this.authority.acquireRunLease(
      input.repositoryId,
      input.runId,
      input.ownerId,
      acquiredAt,
      addMilliseconds(acquiredAt, LEASE_DURATION_MS),
    );
    let completed = false;
    let renewalFailed = false;
    let renewalTimer: SupervisorTimerHandle | undefined;
    const abortController = new AbortController();
    const scheduleRenewal = (): void => {
      const now = input.currentTime();
      const remaining = Date.parse(lease.expiresAt) - Date.parse(now);
      const delay = Math.max(0, Math.min(LEASE_RENEWAL_WINDOW_MS, remaining - 1));
      renewalTimer = this.#timer.schedule(delay, () => {
        try {
          const renewedAt = input.currentTime();
          lease = this.authority.renewRunLease(
            lease,
            renewedAt,
            addMilliseconds(renewedAt, LEASE_DURATION_MS),
          );
          scheduleRenewal();
        } catch {
          renewalFailed = true;
          abortController.abort();
        }
      });
    };

    try {
      const receipt = this.authority.drainRunOnce({
        repositoryId: input.repositoryId,
        runId: input.runId,
        lease,
        currentTime: input.currentTime(),
      });
      const completionDelivered = this.#deliverCompletionOutboxOnce?.() ?? false;
      const amendmentProposalDelivered = this.#deliverAmendmentProposalOutboxOnce?.() ?? false;
      const amendmentRecovery = this.authority
        .listApprovedAmendmentRecoveries()
        .find(
          (candidate) =>
            candidate.repositoryId === input.repositoryId && candidate.runId === input.runId,
        );
      const amendmentApplyQueued =
        amendmentRecovery === undefined
          ? false
          : this.authority.queueApprovedAmendmentApply(amendmentRecovery, input.currentTime());
      const scheduleTime = input.currentTime();
      const scheduled = this.#scheduleBeforeEffects?.({
        repositoryId: input.repositoryId,
        runId: input.runId,
        lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
        currentTime: scheduleTime,
      });
      const runnerBatchSize = scheduled?.batchSize ?? this.#runnerBatchSize;
      const runnable = this.authority
        .listRunnableRuns()
        .some((run) => run.repositoryId === input.repositoryId && run.runId === input.runId);
      let runner: RunOnceResult | RunBatchResult | undefined;
      if (input.runEffects !== false && runnable) {
        const failurePolicy = this.#failurePolicyForRun?.(input.repositoryId, input.runId);
        if (this.#asyncRunner !== undefined) {
          scheduleRenewal();
          try {
            const runnerInput = {
              repositoryId: input.repositoryId,
              runId: input.runId,
              attemptId: input.attemptId,
              signal: abortController.signal,
              currentTime: input.currentTime,
              currentLease: () => ({
                owner: lease.ownerId,
                fence: lease.fence,
                expiresAt: lease.expiresAt,
              }),
            };
            runner =
              runnerBatchSize === 1
                ? await this.#asyncRunner.runOnce(runnerInput)
                : await this.#asyncRunner.runBatch(runnerInput, {
                    maxTransitions: runnerBatchSize,
                    ...(failurePolicy === undefined ? {} : { failurePolicy }),
                  });
          } catch (error) {
            if (renewalFailed && error instanceof AsyncRunnerCancelledError) throw error;
            throw error;
          } finally {
            renewalTimer?.cancel();
          }
        } else {
          const runnerTime = input.currentTime();
          if (Date.parse(lease.expiresAt) - Date.parse(runnerTime) <= LEASE_RENEWAL_WINDOW_MS) {
            lease = this.authority.renewRunLease(
              lease,
              runnerTime,
              addMilliseconds(runnerTime, LEASE_DURATION_MS),
            );
          }
          runner = this.runSyncEffects(
            {
              repositoryId: input.repositoryId,
              runId: input.runId,
              lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
              currentTime: runnerTime,
              attemptId: input.attemptId,
            },
            runnerBatchSize,
          );
        }
        this.#applyFailurePolicy(
          input.repositoryId,
          input.runId,
          runner,
          lease,
          input.currentTime(),
        );
      }
      // Driving is what turns a recorded human decision into work. It runs last
      // because an effect still in flight is the run's current business, and it
      // runs here rather than in another process so this lease covers it.
      const driven =
        runnerWorked(runner) || receipt !== undefined
          ? false
          : ((await this.#driveRunOnce?.({
              repositoryId: input.repositoryId,
              runId: input.runId,
              currentTime: input.currentTime(),
            })) ?? false);
      const worked =
        receipt !== undefined ||
        completionDelivered ||
        amendmentProposalDelivered ||
        amendmentApplyQueued ||
        scheduled?.worked === true ||
        driven ||
        runnerWorked(runner);
      completed = true;
      return {
        lease,
        ...(receipt === undefined ? {} : { receipt }),
        completionDelivered,
        amendmentProposalDelivered,
        amendmentApplyQueued,
        ...(runner === undefined ? {} : { runner }),
        worked,
      };
    } finally {
      renewalTimer?.cancel();
      if (completed && !renewalFailed) this.authority.releaseRunLease(lease, input.currentTime());
    }
  }

  private runSyncEffects(
    input: Parameters<FencedRunner["runOnce"]>[0],
    batchSize = this.#runnerBatchSize,
  ) {
    return batchSize === 1
      ? this.#runner?.runOnce(input)
      : this.#runner?.runBatch(input, { maxTransitions: batchSize });
  }

  #applyFailurePolicy(
    repositoryId: string,
    runId: string,
    runner: RunOnceResult | RunBatchResult | undefined,
    lease: LeaseGrant,
    currentTime: string,
  ): void {
    const policy = this.#failurePolicyForRun?.(repositoryId, runId);
    const authority = this.#runnerAuthority;
    if (policy === undefined || authority === undefined || runner === undefined) return;
    const results = runner.type === "batch" ? runner.results : [runner];
    const failedOperationIds = new Set(
      results.flatMap((result) =>
        result.type === "committed" &&
        result.outcome.kind === "worker" &&
        result.outcome.status === "failed"
          ? [result.outcome.operationId]
          : [],
      ),
    );
    if (failedOperationIds.size === 0) return;
    const snapshot = authority.load({ repositoryId, runId });
    const commands = [
      ...snapshot.queuedCommands,
      ...snapshot.effects.map(({ intent }) => intent.command),
    ];
    const failedAdmissionTimes = new Set(
      commands
        .filter(({ operationId }) => failedOperationIds.has(operationId))
        .map(({ queuedAt }) => queuedAt),
    );
    const siblings = snapshot.effects
      .filter(({ intent }) => failedAdmissionTimes.has(intent.command.queuedAt))
      .map(({ intent, outcome }) => ({
        taskId: intent.command.taskScope.taskId,
        operationId: intent.command.operationId,
        status: outcome?.status ?? "active",
      }));
    const actions = planFailurePolicyActions(policy, siblings);
    const taskIds = new Set(
      actions.flatMap((action) => (action.type === "fence-task" ? [action.taskId] : [])),
    );
    const currentScopes = snapshot.taskScopes.filter(
      ({ taskId, claimsAccepted }) => claimsAccepted && taskIds.has(taskId),
    );
    if (currentScopes.length > 0) {
      authority.installTaskScopeFences({
        repositoryId,
        runId,
        installedAt: currentTime,
        fences: currentScopes.map((scope) => ({
          scope: {
            runId: scope.runId,
            taskId: scope.taskId,
            definitionGeneration: scope.definitionGeneration,
          },
          expectedFenceGeneration: scope.fenceGeneration,
          expectedAcceptedContextDigest: scope.acceptedContextDigest,
        })),
      });
    }
    for (const action of actions) {
      if (action.type !== "request-cancellation") continue;
      authority.requestCancellation?.({
        repositoryId,
        runId,
        lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
        currentTime,
        operationId: action.operationId,
        requestedAt: currentTime,
      });
    }
  }
}

const systemTimer: SupervisorTimer = Object.freeze({
  schedule(delayMilliseconds: number, callback: () => void) {
    const handle = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ cancel: () => clearTimeout(handle) });
  },
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Required run controller value is missing");
  return value;
}

function runnerWorked(runner: RunOnceResult | RunBatchResult | undefined): boolean {
  if (runner === undefined) return false;
  return runner.type === "batch" ? runner.results.length > 0 : runner.type !== "idle";
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) throw new TypeError("Run controller time must be a timestamp");
  return new Date(epoch + milliseconds).toISOString();
}
