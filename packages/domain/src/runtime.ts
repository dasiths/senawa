import type { PlanArtifact, WorkRequest } from "./artifacts.js";
import type { JsonObject } from "./common.js";
import type { JournalEvent } from "./events.js";
import type { OutputRecord } from "./output.js";
import type { RunSnapshot } from "./run-snapshot.js";

export type RunStatus = "running" | "awaiting_approval" | "paused" | "finished" | "ended";
export type PhaseStatus = "pending" | "running" | "awaiting_approval" | "accepted" | "ended";
export type TaskStatus = "pending" | "in_progress" | "rework" | "closed" | "escalated" | "ended";
export type RuntimeBackend = "file" | "beads";

export interface RunIdentity {
  readonly runId: string;
  readonly backend: RuntimeBackend;
  readonly workflow: string;
  readonly request: WorkRequest;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface RuntimePhase {
  readonly id: string;
  status: PhaseStatus;
  iteration: number;
  artifactVersion: number | null;
  sessionId: string | null;
  rejectionReason: string | null;
}

export interface RuntimeGateFeedback {
  readonly gateId: string;
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly remainingAttempts: number;
  readonly failedReadings: ReadonlyArray<{
    readonly sensorId: string;
    readonly summary: string;
  }>;
  readonly findings: readonly string[];
  readonly evidencePaths: readonly string[];
  readonly nextPrompt: string;
}

export type RuntimeTask = PlanArtifact["tasks"][number] & {
  status: TaskStatus;
  attempt: number;
  dispatchFailures: number;
  sessionId: string | null;
  steering: string[];
  reworkFindings?: string[];
  reworkFeedback?: RuntimeGateFeedback;
};

export interface RuntimeArtifact {
  readonly phaseId: string;
  readonly version: number;
  readonly path: string;
  readonly createdAt: string;
  readonly content: JsonObject;
  readonly consumed: Readonly<Record<string, number>>;
}

export interface RuntimeLease {
  readonly owner: string;
  readonly fence: number;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface ActiveWorkerTurn {
  readonly ownerKind: "phase" | "task";
  readonly ownerId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly turnId: string;
  readonly dispatchId: string;
  readonly operationId: string;
  readonly operation: "create" | "resume";
}

export type RuntimeDispatchStatus =
  | "intent"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface RuntimeDispatch {
  readonly dispatchId: string;
  readonly operationId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly ownerKind: "phase" | "task";
  readonly ownerId: string;
  readonly operation: "create" | "resume";
  readonly workAttempt: number;
  readonly dispatchFailure: number;
  readonly createdAt: string;
  status: RuntimeDispatchStatus;
  updatedAt: string;
  detail?: string;
}

export interface RuntimeState {
  readonly apiVersion: "senawa.dev/runtime/v1";
  readonly identity: RunIdentity;
  readonly snapshot: RunSnapshot;
  status: RunStatus;
  endReason: string | null;
  phases: RuntimePhase[];
  tasks: RuntimeTask[];
  artifacts: RuntimeArtifact[];
  journal: JournalEvent[];
  outputs: Record<string, OutputRecord[]>;
  activeTurn: ActiveWorkerTurn | null;
  dispatches: RuntimeDispatch[];
  leases: { driver: RuntimeLease | null; web: RuntimeLease | null };
  leaseFences?: { driver: number; web: number };
}
