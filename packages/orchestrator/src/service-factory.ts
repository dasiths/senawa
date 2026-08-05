import { resolve } from "node:path";
import { loadRepositoryDefinitions, type RepositoryDefinitions } from "@senawa/configuration";
import type { RuntimeLease, RuntimeState, RuntimeStore } from "@senawa/graph";
import { RunReportService } from "@senawa/report";
import { CommandGateEvaluator, type GateEvaluator } from "@senawa/sensors";
import { RunCommandService, RunQueryService } from "./run-services.js";
import { DeterministicWorkerHost, type WorkerHost } from "./worker-host.js";

export type RunChangeListener = (runId: string) => void;

export class RunChangeNotifier {
  private readonly listeners = new Set<RunChangeListener>();

  subscribe(listener: RunChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(runId: string): void {
    for (const listener of this.listeners) listener(runId);
  }
}

class ObservableRuntimeStore implements RuntimeStore {
  constructor(
    private readonly store: RuntimeStore,
    private readonly notifier: RunChangeNotifier,
  ) {}

  async createRun(state: RuntimeState): Promise<void> {
    await this.store.createRun(state);
    this.notifier.publish(state.identity.runId);
  }

  getActiveRunId(): Promise<string | null> {
    return this.store.getActiveRunId();
  }

  readRun(runId: string): Promise<RuntimeState> {
    return this.store.readRun(runId);
  }

  async updateRun(runId: string, update: (draft: RuntimeState) => void): Promise<RuntimeState> {
    const state = await this.store.updateRun(runId, update);
    this.notifier.publish(runId);
    return state;
  }

  async acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    const lease = await this.store.acquireLease(runId, kind, owner, ttlMs);
    this.notifier.publish(runId);
    return lease;
  }

  async renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    const renewed = await this.store.renewLease(runId, kind, lease, ttlMs);
    this.notifier.publish(runId);
    return renewed;
  }

  async releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void> {
    await this.store.releaseLease(runId, kind, lease);
    this.notifier.publish(runId);
  }

  getWorkDirectory(runId: string): string {
    return this.store.getWorkDirectory(runId);
  }
}

export interface SenawaServices {
  readonly repositoryRoot: string;
  readonly commands: RunCommandService;
  readonly queries: RunQueryService;
  readonly notifier: RunChangeNotifier;
  loadDefinitions(workflowName?: string): Promise<RepositoryDefinitions>;
  acquireWebLease(runId: string, owner: string, ttlMs: number): Promise<RuntimeLease>;
  renewWebLease(runId: string, lease: RuntimeLease, ttlMs: number): Promise<RuntimeLease>;
  releaseWebLease(runId: string, lease: RuntimeLease): Promise<void>;
}

export interface SenawaServiceOptions {
  readonly store: RuntimeStore;
  readonly workerHost?: WorkerHost;
  readonly gateEvaluator?: GateEvaluator;
  readonly now?: () => Date;
}

export function createSenawaServices(
  repositoryRoot: string,
  options: SenawaServiceOptions,
): SenawaServices {
  const root = resolve(repositoryRoot);
  const notifier = new RunChangeNotifier();
  const store = new ObservableRuntimeStore(options.store, notifier);
  const reports = new RunReportService(store);
  const commands = new RunCommandService(
    store,
    options.workerHost ?? new DeterministicWorkerHost(),
    options.gateEvaluator ?? new CommandGateEvaluator(root),
    options.now,
  );
  const queries = new RunQueryService(store, root, reports);

  return {
    repositoryRoot: root,
    commands,
    queries,
    notifier,
    loadDefinitions: (workflowName) => loadRepositoryDefinitions(root, workflowName),
    acquireWebLease: (runId, owner, ttlMs) => store.acquireLease(runId, "web", owner, ttlMs),
    renewWebLease: (runId, lease, ttlMs) => store.renewLease(runId, "web", lease, ttlMs),
    releaseWebLease: (runId, lease) => store.releaseLease(runId, "web", lease),
  };
}
