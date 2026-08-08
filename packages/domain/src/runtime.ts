import type { PlanArtifact, RepositoryChangeExpectation, WorkRequest } from "./artifacts.js";
import type { JsonObject } from "./common.js";
import type { JournalEvent } from "./events.js";
import type { OutputRecord } from "./output.js";
import type { RunSnapshot } from "./run-snapshot.js";
import type { CriterionVerdict, TaskCompletionAssessmentEvidence } from "./task-completion.js";

export type RunStatus = "running" | "awaiting_approval" | "paused" | "finished" | "ended";
export type PhaseStatus = "pending" | "running" | "awaiting_approval" | "accepted" | "ended";
export type TaskStatus = "pending" | "in_progress" | "rework" | "closed" | "escalated" | "ended";
export type RuntimeBackend = "file" | "beads";

export type WorkerHostKind = "simulated" | "copilot-subprocess" | "copilot-sdk";

export interface WorkerHostIdentity {
  readonly kind: WorkerHostKind;
  readonly adapter: string;
  readonly adapterVersion: string;
}

export interface RunIdentity {
  readonly runId: string;
  readonly backend: RuntimeBackend;
  readonly workflow: string;
  readonly request: WorkRequest;
  readonly createdAt: string;
  readonly fingerprint: string;
  readonly workerHost: WorkerHostIdentity;
}

export function decodeRunIdentity(value: unknown): RunIdentity {
  const identity = value as Omit<RunIdentity, "workerHost"> & {
    readonly workerHost?: Partial<WorkerHostIdentity> & { readonly kind?: string };
  };
  const workerHost = identity.workerHost;
  if (workerHost === undefined) throw new Error("Persisted run identity has no worker host");
  const kind = canonicalWorkerHostKind(workerHost.kind);
  return {
    ...identity,
    workerHost: {
      kind,
      adapter: workerHost.adapter ?? adapterName(kind),
      adapterVersion: workerHost.adapterVersion ?? "unknown",
    },
  };
}

function canonicalWorkerHostKind(value: string | undefined): WorkerHostKind {
  switch (value) {
    case "simulated":
      return "simulated";
    case "copilot-subprocess":
      return "copilot-subprocess";
    case "copilot-sdk":
      return "copilot-sdk";
    default:
      throw new Error(`Invalid persisted worker host kind: ${String(value)}`);
  }
}

function adapterName(kind: WorkerHostKind): string {
  return kind === "simulated" ? "simulated-worker" : kind;
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
  readonly criteria?: ReadonlyArray<{
    readonly id: string;
    readonly verdict: CriterionVerdict;
    readonly reason: string;
    readonly evidencePath: string | null;
  }>;
  readonly nextPrompt: string;
}

export interface ResolvedInputReference {
  readonly name: string;
  readonly reference: string;
  readonly ownerKind: "phase" | "evidence";
  readonly ownerId: string;
  readonly path: string;
  readonly version: number;
  readonly digest: string;
  readonly schemaKind: string;
  readonly summary: JsonObject;
  readonly content: JsonObject;
}

export interface ResolvedInputManifest {
  readonly version: 1;
  readonly inputs: readonly ResolvedInputReference[];
}

export interface RepositoryStateEntry {
  readonly path: string;
  readonly status: string;
  readonly digest: string;
}

export interface RepositoryBaselineEvidence {
  readonly version: 1;
  readonly kind: "repository-baseline";
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly dispatchId: string;
  readonly turnId: string;
  readonly expectation: RepositoryChangeExpectation;
  readonly authorizedPaths: readonly string[];
  readonly frozenPaths: readonly string[];
  readonly head: string | null;
  readonly entries: readonly RepositoryStateEntry[];
  readonly capturedAt: string;
  readonly uncertainty: readonly string[];
  readonly digest: string;
  readonly evidencePath: string;
}

export interface RepositoryDeltaEvidence {
  readonly version: 1;
  readonly kind: "repository-delta";
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly dispatchId: string;
  readonly turnId: string;
  readonly expectation: RepositoryChangeExpectation;
  readonly baselineDigest: string;
  readonly headBefore: string | null;
  readonly headAfter: string | null;
  readonly preExistingChanges: readonly string[];
  readonly changedPaths: readonly RepositoryStateEntry[];
  readonly inScopeChanges: readonly string[];
  readonly outOfScopeChanges: readonly string[];
  readonly frozenChanges: readonly string[];
  readonly uncertainty: readonly string[];
  readonly workerClaim: {
    readonly reported: boolean;
    readonly changed: boolean | null;
    readonly patchDigest?: string;
    readonly agreement: "agree" | "disagree" | "unreported";
  };
  readonly capturedAt: string;
  readonly digest: string;
  readonly evidencePath: string;
}

export interface TaskSourcePlan {
  readonly phaseId: string;
  readonly path: string;
  readonly version: number;
  readonly digest: string;
}

export type RuntimeTask = PlanArtifact["tasks"][number] & {
  status: TaskStatus;
  attempt: number;
  dispatchFailures: number;
  sessionId: string | null;
  steering: string[];
  reworkFindings?: string[];
  reworkFeedback?: RuntimeGateFeedback;
  sourcePlan?: TaskSourcePlan;
  inheritedInputs?: readonly ResolvedInputReference[];
};

export interface RuntimeArtifact {
  readonly phaseId: string;
  readonly version: number;
  readonly path: string;
  readonly createdAt: string;
  readonly content: JsonObject;
  readonly consumed: readonly ResolvedInputReference[] | Readonly<Record<string, number>>;
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
  readonly inputManifest?: ResolvedInputManifest;
  readonly repositoryBaseline?: RepositoryBaselineEvidence;
  repositoryDelta?: RepositoryDeltaEvidence;
  taskAssessment?: TaskCompletionAssessmentEvidence;
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
