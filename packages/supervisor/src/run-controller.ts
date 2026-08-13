import {
  type AsyncEffectHost,
  AsyncFencedRunner,
  AsyncRunnerCancelledError,
  type EffectHost,
  FencedRunner,
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
  readonly runner?: RunOnceResult;
  readonly worked: boolean;
}

export class SupervisorRunController {
  readonly authority: SqliteSupervisorAuthority;
  readonly #runner: FencedRunner | undefined;
  readonly #asyncRunner: AsyncFencedRunner | undefined;
  readonly #deliverCompletionOutboxOnce: (() => boolean) | undefined;
  readonly #deliverAmendmentProposalOutboxOnce: (() => boolean) | undefined;
  readonly #timer: SupervisorTimer;

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
      const runnable = this.authority
        .listRunnableRuns()
        .some((run) => run.repositoryId === input.repositoryId && run.runId === input.runId);
      const runner =
        input.runEffects !== false && runnable
          ? this.#runner?.runOnce({
              repositoryId: input.repositoryId,
              runId: input.runId,
              lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
              currentTime: runnerTime,
              attemptId: input.attemptId,
            })
          : undefined;
      const worked =
        receipt !== undefined ||
        completionDelivered ||
        amendmentProposalDelivered ||
        amendmentApplyQueued ||
        (runner !== undefined && runner.type !== "idle");
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
      const runnable = this.authority
        .listRunnableRuns()
        .some((run) => run.repositoryId === input.repositoryId && run.runId === input.runId);
      let runner: RunOnceResult | undefined;
      if (input.runEffects !== false && runnable) {
        if (this.#asyncRunner !== undefined) {
          scheduleRenewal();
          try {
            runner = await this.#asyncRunner.runOnce({
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
          runner = this.#runner?.runOnce({
            repositoryId: input.repositoryId,
            runId: input.runId,
            lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
            currentTime: runnerTime,
            attemptId: input.attemptId,
          });
        }
      }
      const worked =
        receipt !== undefined ||
        completionDelivered ||
        amendmentProposalDelivered ||
        amendmentApplyQueued ||
        (runner !== undefined && runner.type !== "idle");
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

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) throw new TypeError("Run controller time must be a timestamp");
  return new Date(epoch + milliseconds).toISOString();
}
