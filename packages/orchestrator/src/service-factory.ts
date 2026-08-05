import { resolve } from "node:path";
import type {
  RunChangeNotificationPort,
  RunPersistencePort,
  WorkerExecutionPort,
} from "@senawa/application";
import { RunReportEvidenceReader } from "@senawa/application";
import { loadRepositoryDefinitions, type RepositoryDefinitions } from "@senawa/configuration";
import type { RuntimeLease } from "@senawa/domain";
import { RunReportService } from "@senawa/reporting";
import { CommandGateEvaluator, type GateEvaluator } from "@senawa/sensors";
import { RunCommandService, RunQueryService } from "./run-services.js";
import { DeterministicWorkerHost } from "./worker-host.js";

export interface SenawaServices {
  readonly repositoryRoot: string;
  readonly commands: RunCommandService;
  readonly queries: RunQueryService;
  readonly notifier: RunChangeNotificationPort;
  loadDefinitions(workflowName?: string): Promise<RepositoryDefinitions>;
  acquireWebLease(runId: string, owner: string, ttlMs: number): Promise<RuntimeLease>;
  renewWebLease(runId: string, lease: RuntimeLease, ttlMs: number): Promise<RuntimeLease>;
  releaseWebLease(runId: string, lease: RuntimeLease): Promise<void>;
}

export interface SenawaServiceOptions {
  readonly persistence: RunPersistencePort;
  readonly notifier: RunChangeNotificationPort;
  readonly workerHost?: WorkerExecutionPort;
  readonly gateEvaluator?: GateEvaluator;
  readonly now?: () => Date;
}

export function createSenawaServices(
  repositoryRoot: string,
  options: SenawaServiceOptions,
): SenawaServices {
  const root = resolve(repositoryRoot);
  const store = options.persistence;
  const notifier = options.notifier;
  const reports = new RunReportService(new RunReportEvidenceReader(store));
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
