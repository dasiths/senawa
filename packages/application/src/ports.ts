import type {
  GateEvaluation,
  JournalEvent,
  JsonObject,
  OutputRecord,
  RepositoryBaselineEvidence,
  RepositoryChangeExpectation,
  RepositoryDeltaEvidence,
  ResolvedInputManifest,
  RunIdentity,
  RunSnapshot,
  RuntimeArtifact,
  RuntimeLease,
  RuntimeState,
  RuntimeTask,
  TaskCompletionAssessment,
  TaskCompletionAssessmentEvidence,
  WorkerHostIdentity,
  WorkerProfile,
  Workflow,
} from "@senawa/domain";

export type {
  WorkerAdapterDescriptor,
  WorkerAuthorization,
  WorkerBinding,
  WorkerBindingContext,
  WorkerBindingName,
  WorkerBindingPort,
  WorkerBindingResult,
  WorkerCancelResult,
  WorkerExecutionPort,
  WorkerHostResolverPort,
  WorkerModelCatalogEntry,
  WorkerModelCatalogPort,
  WorkerOutput,
  WorkerPreflightRequest,
  WorkerResult,
  WorkerSessionEvent,
  WorkerSessionPlan,
  WorkerSessionPort,
  WorkerSessionRequirements,
  WorkerTurn,
  WorkerTurnHandle,
  WorkerTurnObservation,
} from "./workers.js";

import type { WorkerSessionEvent, WorkerTurn } from "./workers.js";

export interface VersionedRunState {
  readonly state: RuntimeState;
  readonly revision: string;
}

export type StoredRuntimeState = Omit<
  RuntimeState,
  "identity" | "snapshot" | "artifacts" | "journal" | "outputs" | "leases" | "leaseFences"
>;

export interface VersionedStoredRuntimeState {
  readonly state: StoredRuntimeState;
  readonly revision: string;
}

export interface RuntimeGraphDefinition {
  readonly phases: readonly {
    readonly id: string;
    readonly title: string;
    readonly dependsOn: readonly string[];
    readonly executorKind: "agent" | "task-frontier" | "sensor-only" | "human" | "foreach";
  }[];
}

export class RuntimeRevisionConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly operationId: string,
  ) {
    super(`Run ${runId} changed before operation ${operationId}`);
    this.name = "RuntimeRevisionConflictError";
  }
}

export class ActiveRunError extends Error {
  constructor(readonly runId: string) {
    super(`An active run already exists: ${runId}`);
    this.name = "ActiveRunError";
  }
}

export class LeaseConflictError extends Error {
  constructor(
    readonly kind: "driver" | "web",
    readonly owner: string,
  ) {
    super(`The ${kind} lease is held by ${owner}`);
    this.name = "LeaseConflictError";
  }
}

export interface RuntimeStatePort {
  createRun(state: RuntimeState, operationId: string): Promise<void>;
  readRun(runId: string): Promise<VersionedRunState>;
  commitRun(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: RuntimeState;
  }): Promise<VersionedRunState>;
  claimReadyTask(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
  }): Promise<RuntimeTask | null>;
}

export interface RuntimeStateStoragePort {
  createRuntimeState(
    runId: string,
    state: StoredRuntimeState,
    operationId: string,
    graph: RuntimeGraphDefinition,
  ): Promise<VersionedStoredRuntimeState>;
  readRuntimeState(runId: string): Promise<VersionedStoredRuntimeState>;
  commitRuntimeState(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: StoredRuntimeState;
  }): Promise<VersionedStoredRuntimeState>;
  claimReadyTask(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
  }): Promise<RuntimeTask | null>;
}

export interface ActiveRunRegistry {
  getActiveRunId(): Promise<string | null>;
}

export interface ActiveRunStoragePort extends ActiveRunRegistry {
  reserveActiveRun(input: {
    readonly runId: string;
    readonly operationId: string;
    readonly createdAt: string;
  }): Promise<void>;
  releaseActiveRun(input: { readonly runId: string; readonly operationId: string }): Promise<void>;
}

export interface RunDocumentStore {
  publishSnapshot(snapshot: RunSnapshot, operationId: string): Promise<void>;
  readArtifact(runId: string, phaseId: string, version?: number): Promise<RuntimeArtifact | null>;
}

export interface RunDocumentStoragePort extends RunDocumentStore {
  publishIdentity(identity: RunIdentity, operationId: string): Promise<void>;
  publishArtifact(artifact: RuntimeArtifact, runId: string, operationId: string): Promise<void>;
  readIdentity(runId: string): Promise<RunIdentity>;
  readSnapshot(runId: string): Promise<RunSnapshot>;
  listArtifacts(runId: string): Promise<readonly RuntimeArtifact[]>;
}

export interface JournalPort {
  readJournal(runId: string, after: number, limit: number): Promise<readonly JournalEvent[]>;
}

export interface JournalStoragePort extends JournalPort {
  appendJournal(input: {
    readonly runId: string;
    readonly entryId: string;
    readonly event: JournalEvent;
  }): Promise<JournalEvent>;
  journalHead(runId: string): Promise<number>;
}

export interface OutputLogPort {
  readOutput(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
    after: number,
    limit: number,
  ): Promise<readonly OutputRecord[]>;
}

export interface OutputLogStoragePort extends OutputLogPort {
  appendOutput(input: {
    readonly runId: string;
    readonly ownerKind: "run" | "phase" | "task";
    readonly ownerId: string;
    readonly entryId: string;
    readonly record: OutputRecord;
  }): Promise<OutputRecord>;
  outputHead(runId: string, ownerKind: "run" | "phase" | "task", ownerId: string): Promise<number>;
  listOutputOwners(
    runId: string,
  ): Promise<readonly { readonly kind: "run" | "phase" | "task"; readonly id: string }[]>;
}

export interface WorkerEventRecord {
  readonly runId: string;
  readonly owner: WorkerTurn["owner"];
  readonly dispatchId: string;
  readonly operationId: string;
  readonly role: string;
  readonly attempt: number;
  readonly workerHost?: WorkerHostIdentity;
  readonly configuredModel?: WorkerProfile["spec"]["model"];
  readonly event: WorkerSessionEvent;
}

export interface WorkerEventLogPort {
  readWorkerEvents(runId: string): Promise<readonly WorkerEventRecord[]>;
}

export interface WorkerEventStoragePort extends WorkerEventLogPort {
  appendWorkerEvent(input: {
    readonly runId: string;
    readonly entryId: string;
    readonly record: WorkerEventRecord;
  }): Promise<WorkerEventRecord>;
}

export interface LeasePort {
  acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease>;
  renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease>;
  releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void>;
}

export interface LeaseStoragePort extends LeasePort {
  inspectLease(runId: string, kind: "driver" | "web"): Promise<RuntimeLease | null>;
  readLeaseFence(runId: string, kind: "driver" | "web"): Promise<number>;
}

export interface GateEvaluationPort {
  evaluate(input: {
    readonly runId: string;
    readonly owner: WorkerTurn["owner"];
    readonly attempt: number;
    readonly gateId: string;
    readonly policy: RunSnapshot["policy"];
    readonly artifact?: JsonObject;
    readonly inputManifest?: ResolvedInputManifest;
    readonly repositoryChange?: RepositoryChangeExpectation;
    readonly repositoryEvidence?: RepositoryDeltaEvidence;
    readonly taskAssessment?: TaskCompletionAssessment;
    readonly onOutput?: (input: {
      readonly sensorId: string;
      readonly stream: "stdout" | "stderr" | "system";
      readonly text: string;
    }) => Promise<void>;
  }): Promise<GateEvaluation>;
}

export interface RepositoryEvidencePort {
  captureBaseline(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly attempt: number;
    readonly dispatchId: string;
    readonly turnId: string;
    readonly expectation: RepositoryChangeExpectation;
    readonly authorizedPaths: readonly string[];
    readonly frozenPaths: readonly string[];
    readonly recovered: boolean;
    readonly capturedAt: string;
  }): Promise<RepositoryBaselineEvidence>;
  captureDelta(input: {
    readonly baseline: RepositoryBaselineEvidence;
    readonly workerClaim: {
      readonly reported: boolean;
      readonly changed: boolean | null;
      readonly patch?: string;
    };
    readonly recovered: boolean;
    readonly capturedAt: string;
  }): Promise<RepositoryDeltaEvidence>;
}

export interface TaskAssessmentPort {
  persist(assessment: TaskCompletionAssessment): Promise<TaskCompletionAssessmentEvidence>;
}

export interface ArtifactValidationPort {
  validatePhaseArtifact(input: {
    readonly snapshot: RunSnapshot;
    readonly phaseId: string;
    readonly schemaReference: string;
    readonly artifact: JsonObject;
  }): Promise<void> | void;
}

export interface ReportingPort {
  render(runId: string): Promise<string>;
}

export interface WorkflowCatalogPort {
  listWorkflows(): Promise<readonly string[]>;
  readWorkflow(workflowName: string): Promise<Workflow>;
}

export interface ClockPort {
  now(): Date;
}

export interface SchedulerPort {
  scheduleEvery(intervalMs: number, task: () => void): () => void;
}

export interface IdentifierPort {
  createId(): string;
}

export interface NotificationPort {
  publishRunChanged(runId: string): void | Promise<void>;
}

export interface RunChangeNotificationPort extends NotificationPort {
  subscribe(listener: (runId: string) => void): () => void;
}

export interface TelemetryPort {
  record(input: {
    readonly name: string;
    readonly runId: string;
    readonly data?: Readonly<Record<string, string | number | boolean>>;
  }): void | Promise<void>;
}

export interface RunPersistencePort
  extends RuntimeStatePort,
    ActiveRunRegistry,
    RunDocumentStore,
    JournalPort,
    OutputLogStoragePort,
    WorkerEventStoragePort,
    LeaseStoragePort {}
