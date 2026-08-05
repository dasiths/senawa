import type {
  GateEvaluation,
  JournalEvent,
  JsonObject,
  OutputRecord,
  RunSnapshot,
  RuntimeArtifact,
  RuntimeLease,
  RuntimeState,
  WorkerProfile,
  Workflow,
} from "@senawa/domain";

export interface VersionedRunState {
  readonly state: RuntimeState;
  readonly revision: string;
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

export interface RuntimeStatePort {
  createRun(state: RuntimeState, operationId: string): Promise<void>;
  readRun(runId: string): Promise<VersionedRunState>;
  commitRun(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: RuntimeState;
  }): Promise<VersionedRunState>;
}

export interface ActiveRunRegistry {
  getActiveRunId(): Promise<string | null>;
}

export interface RunDocumentStore {
  publishSnapshot(snapshot: RunSnapshot, operationId: string): Promise<void>;
  readArtifact(runId: string, phaseId: string, version?: number): Promise<RuntimeArtifact | null>;
}

export interface JournalPort {
  readJournal(runId: string, after: number, limit: number): Promise<readonly JournalEvent[]>;
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

export interface WorkerTurn {
  readonly runId: string;
  readonly owner: { readonly kind: "phase" | "task"; readonly id: string };
  readonly operation: "create" | "resume";
  readonly turnId: string;
  readonly dispatchId: string;
  readonly operationId: string;
  readonly role: string;
  readonly profile: WorkerProfile;
  readonly profileDigest: string;
  readonly resolvedModel: WorkerProfile["spec"]["model"];
  readonly attempt: number;
  readonly sessionId: string;
  readonly goal: string;
  readonly rejectionReason: string | null;
  readonly steering: readonly string[];
  readonly prompt: string;
  readonly authorization: {
    readonly taskPaths: readonly string[];
    readonly frozenPaths: readonly string[];
  };
}

export interface WorkerOutput {
  readonly stream: "stdout" | "stderr" | "system";
  readonly text: string;
}

export interface WorkerResult {
  readonly sessionId: string;
  readonly artifact?: JsonObject;
  readonly output: readonly WorkerOutput[];
}

export type WorkerTurnObservation =
  | { readonly state: "missing" }
  | { readonly state: "active" }
  | { readonly state: "completed"; readonly result: WorkerResult }
  | { readonly state: "idle" }
  | { readonly state: "cancelled"; readonly detail?: string }
  | { readonly state: "unknown"; readonly detail: string };

export interface WorkerSessionPort {
  execute(turn: WorkerTurn): Promise<WorkerResult>;
  inspect?(turn: WorkerTurn): Promise<WorkerTurnObservation>;
}

export interface GateEvaluationPort {
  evaluate(input: {
    readonly runId: string;
    readonly owner: WorkerTurn["owner"];
    readonly attempt: number;
    readonly gateId: string;
    readonly policy: RunSnapshot["policy"];
    readonly artifact?: JsonObject;
  }): Promise<GateEvaluation>;
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
    OutputLogPort,
    LeasePort {}
