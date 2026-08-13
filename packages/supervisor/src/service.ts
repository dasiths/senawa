import { validateOpaqueIdentity } from "@senawa/protocol";
import type { AsyncEffectHost, EffectHost } from "@senawa/runtime";
import { LeaseUnavailableError, SqliteRunnerAuthority } from "@senawa/storage-sqlite";
import {
  type SqliteSupervisorAuthority,
  SupervisorServiceUnavailableError,
} from "./command-queue.js";
import {
  type CopilotSessionStoreHealthPort,
  decodeSupervisorServiceStatus,
  type SupervisorClock,
  type SupervisorListenerStatus,
  type SupervisorLogPage,
  type SupervisorServiceStatus,
} from "./contracts.js";
import { SupervisorRunController, type SupervisorTimer } from "./run-controller.js";

const DEFAULT_STARTUP_CYCLE_LIMIT = 1_024;

export type SupervisorLifecycleState =
  | "stopped"
  | "starting"
  | "running"
  | "draining"
  | "drained"
  | "stopping";

export interface SupervisorServiceOptions {
  readonly authority: SqliteSupervisorAuthority;
  readonly clock: SupervisorClock;
  readonly ownerId: string;
  readonly processId?: number;
  readonly startupCycleLimit?: number;
  readonly onTransition?: (state: SupervisorLifecycleState) => void;
  readonly sessionStoreHealth?: CopilotSessionStoreHealthPort;
  readonly listeners?: readonly SupervisorListener[];
  readonly effectHost?: EffectHost;
  readonly asyncEffectHost?: AsyncEffectHost;
  readonly deliverCompletionOutboxOnce?: () => boolean;
  readonly timer?: SupervisorTimer;
  readonly closeables?: readonly SupervisorCloseable[];
}

export interface SupervisorCloseable {
  close(): Promise<void> | void;
}

export interface SupervisorListener {
  start(): Promise<SupervisorListenerStatus>;
  close(): Promise<void>;
}

export interface SupervisorCycleResult {
  readonly worked: boolean;
  readonly pendingWakeCount: number;
}

export interface SupervisorQuiescenceProof {
  assertDrained(): void;
}

export class SupervisorService {
  readonly authority: SqliteSupervisorAuthority;
  readonly clock: SupervisorClock;
  readonly ownerId: string;
  readonly processId: number;
  readonly #startupCycleLimit: number;
  readonly #onTransition: ((state: SupervisorLifecycleState) => void) | undefined;
  readonly #sessionStoreHealth: CopilotSessionStoreHealthPort | undefined;
  readonly #configuredListeners: readonly SupervisorListener[];
  readonly #closeables: readonly SupervisorCloseable[];
  readonly #effectHostConfigured: boolean;
  readonly #controller: SupervisorRunController;
  readonly #runnerAuthority: SqliteRunnerAuthority | undefined;
  readonly #startedAt: string;
  #listeners: readonly SupervisorListenerStatus[] = [];
  #startedListeners: SupervisorListener[] = [];
  #attemptSequence = 0;
  #state: SupervisorLifecycleState = "stopped";
  #cycle: Promise<SupervisorCycleResult> | undefined;
  #operation: Promise<void> = Promise.resolve();
  #pump: Promise<void> | undefined;
  #stopOperation: Promise<void> | undefined;
  #closed = false;

  constructor(options: SupervisorServiceOptions) {
    if (options.ownerId.length === 0) throw new TypeError("Supervisor ownerId must be non-empty");
    const startupCycleLimit = options.startupCycleLimit ?? DEFAULT_STARTUP_CYCLE_LIMIT;
    if (!Number.isSafeInteger(startupCycleLimit) || startupCycleLimit < 1) {
      throw new TypeError("startupCycleLimit must be a positive safe integer");
    }
    this.authority = options.authority;
    this.clock = options.clock;
    this.ownerId = options.ownerId;
    this.processId = options.processId ?? process.pid;
    this.#startupCycleLimit = startupCycleLimit;
    this.#onTransition = options.onTransition;
    this.#sessionStoreHealth = options.sessionStoreHealth;
    this.#configuredListeners = options.listeners ?? [];
    this.#closeables = options.closeables ?? [];
    this.#effectHostConfigured =
      options.effectHost !== undefined || options.asyncEffectHost !== undefined;
    this.#runnerAuthority =
      options.effectHost === undefined && options.asyncEffectHost === undefined
        ? undefined
        : new SqliteRunnerAuthority({
            databasePath: options.authority.databasePath,
            dependencies: options.authority.dependencies,
          });
    this.#controller = new SupervisorRunController({
      authority: options.authority,
      ...(options.effectHost === undefined
        ? {}
        : {
            effectHost: options.effectHost,
            runnerAuthority: requiredValue(this.#runnerAuthority),
          }),
      ...(options.asyncEffectHost === undefined
        ? {}
        : {
            asyncEffectHost: options.asyncEffectHost,
            runnerAuthority: requiredValue(this.#runnerAuthority),
          }),
      ...(options.deliverCompletionOutboxOnce === undefined
        ? {}
        : { deliverCompletionOutboxOnce: options.deliverCompletionOutboxOnce }),
      ...(options.timer === undefined ? {} : { timer: options.timer }),
    });
    this.#startedAt = this.#now();
  }

  get state(): SupervisorLifecycleState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== "stopped" || this.#closed) {
      throw new Error("Supervisor service can only start once from stopped");
    }
    this.#transition("starting");
    try {
      this.authority.setMode("running", this.#now());
      for (let index = 0; index < this.#startupCycleLimit; index += 1) {
        const result = await this.runCycle();
        if (!result.worked) {
          const listeners: SupervisorListenerStatus[] = [];
          for (const listener of this.#configuredListeners) {
            listeners.push(await listener.start());
            this.#startedListeners.push(listener);
          }
          this.#listeners = Object.freeze(listeners);
          this.#transition("running");
          this.#log("info", "service.started", "Supervisor service started", {
            listenerCount: listeners.length,
          });
          return;
        }
      }
      throw new Error("Supervisor startup recovery exceeded its bounded cycle limit");
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        this.authority.setMode("stopped", this.#now());
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      cleanupErrors.push(...(await this.#closeOwnedResources()));
      this.#closed = true;
      this.#listeners = [];
      this.#transition("stopped");
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Supervisor startup failed");
      }
      throw error;
    }
  }

  runCycle(): Promise<SupervisorCycleResult> {
    if (this.#state !== "starting" && this.#state !== "running" && this.#state !== "draining") {
      return Promise.resolve({ worked: false, pendingWakeCount: 0 });
    }
    if (this.#cycle !== undefined) return this.#cycle;
    this.#cycle = this.#enqueueOperation(() => this.#runCycle()).finally(() => {
      this.#cycle = undefined;
    });
    return this.#cycle;
  }

  wake(): void {
    if (this.#state !== "running" || this.#pump !== undefined) return;
    this.#pump = this.#runPump().finally(() => {
      this.#pump = undefined;
      if (this.#state === "running" && this.authority.listPendingWakes().length > 0) this.wake();
    });
  }

  async drain(): Promise<void> {
    if (this.#state === "drained") return;
    if (this.#state !== "running") {
      throw new Error("Supervisor service can only drain while running");
    }
    this.authority.setMode("draining", this.#now());
    this.#transition("draining");
    this.#log("info", "service.draining", "Supervisor service is draining", {});
    await this.#cycle;
    await this.#pump;
    await this.#operation;
    this.authority.setMode("drained", this.#now());
    this.#transition("drained");
    this.#log("info", "service.drained", "Supervisor service drained", {});
  }

  stop(): Promise<void> {
    if (this.#state === "stopped") return Promise.resolve();
    if (this.#stopOperation !== undefined) return this.#stopOperation;
    this.#stopOperation = this.#drainAndStop().finally(() => {
      this.#stopOperation = undefined;
    });
    return this.#stopOperation;
  }

  withQuiescentState<T>(operation: (proof: SupervisorQuiescenceProof) => Promise<T>): Promise<T> {
    return this.#enqueueOperation(async () => {
      const proof = Object.freeze({
        assertDrained: () => {
          if (this.#state !== "drained") {
            throw new Error("Supervisor quiescent operation requires drained service");
          }
        },
      });
      proof.assertDrained();
      const result = await operation(proof);
      proof.assertDrained();
      return result;
    });
  }

  async #drainAndStop(): Promise<void> {
    if (this.#state === "running") await this.drain();
    if (this.#state !== "drained") {
      throw new Error("Supervisor service can only stop after draining");
    }
    return this.#enqueueOperation(() => this.#stopDrained());
  }

  async #stopDrained(): Promise<void> {
    this.#transition("stopping");
    const errors: unknown[] = [];
    try {
      this.authority.setMode("stopped", this.#now());
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#log("info", "service.stopping", "Supervisor service is stopping", {});
    } catch (error) {
      errors.push(error);
    }
    errors.push(...(await this.#closeOwnedResources()));
    this.#closed = true;
    this.#listeners = [];
    this.#transition("stopped");
    if (errors.length > 0) throw errors[0];
  }

  async status(): Promise<SupervisorServiceStatus> {
    return this.#enqueueOperation(async () => {
      this.#assertQueryAvailable();
      const snapshot = this.authority.operationalSnapshot();
      const sdkSessionStore =
        this.#sessionStoreHealth === undefined
          ? {
              status: "unknown" as const,
              expectedSessionCount: snapshot.startedSessionIds.length,
              missingSessionIds: Object.freeze([] as string[]),
              message: "SDK session store health adapter is not configured",
            }
          : await this.#sessionStoreHealth.health(snapshot.startedSessionIds);
      return decodeSupervisorServiceStatus({
        lifecycle: this.#state,
        mode: this.authority.mode(),
        health: sdkSessionStore.status === "healthy" ? "healthy" : "degraded",
        processId: this.processId,
        startedAt: this.#startedAt,
        listeners: this.#listeners,
        pending: snapshot.pending,
        leases: snapshot.leases,
        sdkSessionStore,
      });
    });
  }

  async logs(afterCursor?: number, limit?: number): Promise<SupervisorLogPage> {
    return this.#enqueueOperation(async () => {
      this.#assertQueryAvailable();
      return this.authority.queryLogs(afterCursor, limit);
    });
  }

  async recover(repositoryId: string, runId: string): Promise<{ readonly worked: boolean }> {
    if (this.#state !== "running") throw new Error("Supervisor recovery requires running service");
    return this.#enqueueOperation(async () => {
      this.#attemptSequence += 1;
      const result = await this.#controller.runOnceAsync({
        repositoryId: validateOpaqueIdentity(repositoryId),
        runId: validateOpaqueIdentity(runId),
        ownerId: this.ownerId,
        currentTime: () => this.#now(),
        attemptId: `${this.ownerId}-recovery-${this.#attemptSequence}`,
        runEffects: await this.#effectsAllowed(),
      });
      this.#log("info", "run.recovered", "Direct run recovery completed", {
        repositoryId,
        runId,
        worked: result.worked,
      });
      return Object.freeze({ worked: result.worked });
    });
  }

  async #runCycle(): Promise<SupervisorCycleResult> {
    const wakes = this.authority.listPendingWakes();
    const wake = wakes[0];
    const runnable = this.authority.listRunnableRuns()[0];
    const target = wake ?? runnable;
    if (target === undefined) return { worked: false, pendingWakeCount: 0 };
    if (this.#state === "draining") {
      return { worked: false, pendingWakeCount: wakes.length };
    }

    try {
      this.#attemptSequence += 1;
      const result = await this.#controller.runOnceAsync({
        repositoryId: target.repositoryId,
        runId: target.runId,
        ownerId: this.ownerId,
        currentTime: () => this.#now(),
        attemptId: `${this.ownerId}-${this.#attemptSequence}`,
        runEffects: await this.#effectsAllowed(),
      });
      if (!result.worked && wake !== undefined) {
        this.authority.acknowledgeWake(wake.repositoryId, wake.runId, wake.generation);
      }
      return {
        worked: result.worked,
        pendingWakeCount: this.authority.listPendingWakes().length,
      };
    } catch (error) {
      if (error instanceof LeaseUnavailableError) {
        return { worked: false, pendingWakeCount: wakes.length };
      }
      throw error;
    }
  }

  async #runPump(): Promise<void> {
    for (let index = 0; index < this.#startupCycleLimit; index += 1) {
      const result = await this.runCycle();
      if (!result.worked) return;
    }
    this.#log("warn", "service.pump-bounded", "Supervisor wake pump reached its cycle bound", {
      cycleLimit: this.#startupCycleLimit,
    });
  }

  #transition(state: SupervisorLifecycleState): void {
    this.#state = state;
    this.#onTransition?.(state);
  }

  #now(): string {
    return timestamp(this.clock.now());
  }

  #log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    message: string,
    fields: unknown,
  ): void {
    this.authority.appendLog({ recordedAt: this.#now(), level, event, message, fields });
  }

  #enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertQueryAvailable(): void {
    if (this.#closed) throw new SupervisorServiceUnavailableError("stopped");
  }

  async #closeOwnedResources(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const listener of [...this.#startedListeners].reverse()) {
      try {
        await listener.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#startedListeners = [];
    for (const closeable of [...this.#closeables].reverse()) {
      try {
        await closeable.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#runnerAuthority?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.authority.close();
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  async #effectsAllowed(): Promise<boolean> {
    if (!this.#effectHostConfigured) return false;
    const startedSessionIds = this.authority.operationalSnapshot().startedSessionIds;
    if (startedSessionIds.length === 0) return true;
    if (this.#sessionStoreHealth === undefined) return false;
    const health = await this.#sessionStoreHealth.health(startedSessionIds);
    return health.status === "healthy" && health.missingSessionIds.length === 0;
  }
}

function timestamp(epochMilliseconds: number): string {
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
    throw new TypeError("Supervisor clock must return non-negative epoch milliseconds");
  }
  return new Date(epochMilliseconds).toISOString();
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Required supervisor service value is missing");
  return value;
}
