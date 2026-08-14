import type {
  GitRevisionBinding,
  GitRevisionDescriptor,
  IntegrationBarrier,
  IntegrationMember,
} from "@senawa/kernel";

export interface ParallelExecutionPolicy {
  readonly workspaceMode: "repository" | "worktree";
  readonly maxWriterConcurrency: number;
  readonly failurePolicy: "continue" | "fail-fast";
  readonly integrationRef?: string;
}

export interface RunExecutionBinding {
  readonly repositoryId: string;
  readonly runId: string;
  readonly configurationSnapshotDigest: string;
  readonly execution: ParallelExecutionPolicy;
  readonly allowancePolicy: RunnerAllowancePolicy;
}

export interface RunnerAllowancePolicy {
  readonly policyDigest: string;
  readonly ceilings: readonly {
    readonly unit: string;
    readonly maximum: number;
  }[];
}

export type WorkspaceLifecycleState =
  | "intent"
  | "prepared"
  | "capture-intent"
  | "captured"
  | "removal-intent"
  | "removed"
  | "failed"
  | "unknown";

export interface WorkspaceIntentInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly definitionGeneration: number;
  readonly baseRevision: GitRevisionDescriptor;
  readonly prepareEffectId: string;
  readonly inspectEffectId: string;
}

export interface WorkspaceRecord extends Omit<WorkspaceIntentInput, "baseRevision"> {
  readonly mode: ParallelExecutionPolicy["workspaceMode"];
  readonly state: WorkspaceLifecycleState;
  readonly baseRevision: GitRevisionBinding;
}

export interface WorkspaceResultInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly resultId: string;
  readonly workspaceId: string;
  readonly resultRevision: GitRevisionDescriptor;
  readonly completionFactDigest: string;
  readonly captureEffectId: string;
  readonly inspectEffectId: string;
  readonly recordedAt: string;
}

export interface WorkspaceResultRecord extends Omit<WorkspaceResultInput, "resultRevision"> {
  readonly resultRevision: GitRevisionBinding;
}

export type IntegrationAttemptState =
  | "intent"
  | "claimed"
  | "candidate-created"
  | "validating"
  | "gate-failed"
  | "publishing"
  | "published"
  | "barrier-recorded"
  | "conflicted"
  | "target-moved"
  | "rework-required"
  | "cancelled"
  | "failed"
  | "unknown";

export interface IntegrationAttemptInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly integrationId: string;
  readonly phaseId: string;
  readonly definitionGeneration: number;
  readonly targetRef: string;
  readonly fanInDigest: string;
  readonly members: readonly {
    readonly workspaceId: string;
    readonly resultId: string;
    readonly member: IntegrationMember;
  }[];
  readonly prepareEffectId: string;
  readonly inspectEffectId: string;
}

export interface IntegrationAttemptRecord extends IntegrationAttemptInput {
  readonly state: IntegrationAttemptState;
  readonly ownerId?: string;
  readonly fence?: number;
  readonly slotResourceKey?: string;
  readonly gate?: IntegrationGateRecord;
  readonly barrier?: IntegrationBarrier;
}

export interface IntegrationGateRecord {
  readonly policyDigest: string;
  readonly readingDigest: string;
  readonly evaluationDigest: string;
  readonly decision: "passed" | "failed";
  readonly evidence: unknown;
}

export interface IntegrationSlotClaimInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly integrationId: string;
  readonly ownerId: string;
  readonly currentTime: string;
  readonly expiresAt: string;
}

export type IntegrationSlotClaimResult =
  | { readonly type: "claimed"; readonly attempt: IntegrationAttemptRecord }
  | { readonly type: "busy"; readonly attempt: IntegrationAttemptRecord }
  | { readonly type: "replay"; readonly attempt: IntegrationAttemptRecord };

export interface CompletionEligibilityInput {
  readonly submissionId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly terminalCurrentWriter: boolean;
  readonly workspaceId?: string;
  readonly resultId?: string;
  readonly integrationId?: string;
}

export interface CompletionEligibilityRecord extends CompletionEligibilityInput {
  readonly mode: ParallelExecutionPolicy["workspaceMode"];
  readonly barrierDigest?: string;
  readonly eligible: boolean;
}

export interface WorkspaceIntegrationAuthorityPort {
  bindRunExecution(input: RunExecutionBinding): RunExecutionBinding;
  loadRunExecution(repositoryId: string, runId: string): RunExecutionBinding | undefined;
  listWorkspaces(repositoryId: string, runId: string): readonly WorkspaceRecord[];
  listWorkspaceResults(repositoryId: string, runId: string): readonly WorkspaceResultRecord[];
  listIntegrationAttempts(repositoryId: string, runId: string): readonly IntegrationAttemptRecord[];
  persistWorkspaceIntent(input: WorkspaceIntentInput): WorkspaceRecord;
  recordWorkspaceState(
    repositoryId: string,
    runId: string,
    workspaceId: string,
    state: WorkspaceLifecycleState,
  ): WorkspaceRecord;
  persistWorkspaceResult(input: WorkspaceResultInput): WorkspaceResultRecord;
  persistIntegrationIntent(input: IntegrationAttemptInput): IntegrationAttemptRecord;
  claimIntegrationSlot(input: IntegrationSlotClaimInput): IntegrationSlotClaimResult;
  recordIntegrationState(
    repositoryId: string,
    runId: string,
    integrationId: string,
    state: IntegrationAttemptState,
    ownerId: string,
    fence: number,
    currentTime: string,
  ): IntegrationAttemptRecord;
  recordIntegrationGate(
    repositoryId: string,
    runId: string,
    integrationId: string,
    gate: IntegrationGateRecord,
    ownerId: string,
    fence: number,
    currentTime: string,
  ): IntegrationAttemptRecord;
  recordIntegrationBarrier(
    repositoryId: string,
    runId: string,
    integrationId: string,
    barrier: IntegrationBarrier,
    ownerId: string,
    fence: number,
    currentTime: string,
  ): IntegrationAttemptRecord;
  recordCompletionEligibility(input: CompletionEligibilityInput): CompletionEligibilityRecord;
  completionAdmission(submissionId: string): "accepted" | "deferred";
}
