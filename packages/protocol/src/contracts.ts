export const PROTOCOL_VERSION = "senawa.dev/protocol/v1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// Wire identities remain strings so browser and non-TypeScript clients do not
// inherit the kernel's compile-time brands.
export type OpaqueIdentity = string;
export type CommandId = OpaqueIdentity;
export type RepositoryId = OpaqueIdentity;
export type RunId = OpaqueIdentity;
export type Revision = OpaqueIdentity;

export type AssuranceLevel = "single-factor" | "multi-factor" | "hardware-backed";

export interface AuthenticatedPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly tenant: string;
  readonly assurance: AssuranceLevel;
  readonly roles: readonly string[];
}

export type TransportKind = "cli" | "http" | "runner" | "portal" | "remote";

export interface TransportAttribution {
  readonly kind: TransportKind;
  readonly requestId: OpaqueIdentity;
}

export interface RunIdentity {
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
}

export type CommandIntent =
  | { readonly type: "instantiate-run" }
  | { readonly type: "start-phase-attempt" }
  | { readonly type: "accept-graph-revision" }
  | { readonly type: "submit-completion" }
  | { readonly type: "evaluate-gate" }
  | { readonly type: "record-authority-decision" }
  | { readonly type: "close-phase" }
  | { readonly type: "record-phase-attempt-transition" }
  | { readonly type: "import-plan" }
  | { readonly type: "record-fan-out-diff-decision" }
  | { readonly type: "submit-amendment-proposal" }
  | { readonly type: "withdraw-amendment-proposal" }
  | { readonly type: "record-amendment-decision" }
  | { readonly type: "apply-approved-amendment" }
  | { readonly type: "record-integration-barrier" }
  | { readonly type: "create-escalation" }
  | { readonly type: "answer-question" }
  | { readonly type: "steer-agent" }
  | { readonly type: "grant-allowance" }
  | { readonly type: "pause-run" }
  | { readonly type: "resume-run" }
  | { readonly type: "end-run" };

export interface AnswerQuestionPayload {
  readonly submissionId: OpaqueIdentity;
  readonly questionDigest: string;
  readonly contextDigest: string;
  readonly taskId: OpaqueIdentity;
  readonly definitionGeneration: number;
  readonly answer: JsonValue;
}

/**
 * A person's redirection of an agent that is already working.
 *
 * `delivery` says when the agent is meant to see it. `live` reaches the agent
 * during the turn it is taking, `queued` waits for the turn to end, and
 * `abort-retry` stops the turn and starts the attempt again carrying the
 * instruction. The distinction is recorded because the three produce different
 * histories: only `abort-retry` discards work the agent had already done.
 */
export interface SteerAgentPayload {
  readonly dispatchId: OpaqueIdentity;
  readonly contextDigest: string;
  readonly taskId: OpaqueIdentity;
  readonly definitionGeneration: number;
  readonly delivery: "live" | "queued" | "abort-retry";
  readonly instruction: string;
}

export interface GrantAllowancePayload {
  readonly escalationCommandId: OpaqueIdentity;
  readonly operationId: OpaqueIdentity;
  readonly escalationDigest: string;
  readonly policyDigest: string;
  readonly unit: string;
  readonly expectedLimit: number;
  readonly expectedRunModeRevision: number;
  readonly increaseBy: number;
}

export interface RunControlPayload {
  readonly expectedRunModeRevision: number;
}

export interface SubmitAmendmentProposalPayload {
  readonly proposal: JsonValue;
}

/** Advances a run to the phase named here, once its dependencies have closed. */
export interface StartPhaseAttemptPayload {
  readonly phaseId: string;
  readonly definitionGeneration: number;
}

export interface RecordPhaseAttemptTransitionPayload {
  readonly attemptDigest: string;
  readonly transitionDigest: string;
  readonly triggerDigest: string;
  readonly disposition: "iterate" | "escalate" | "fail" | "closed" | "refused";
}

export interface ImportPlanPayload {
  readonly attemptDigest: string;
  readonly acceptanceDigest: string;
  readonly closureDigest: string;
  readonly forEachKey: string;
  readonly definitionDigest: string;
  readonly evaluationDigest: string;
  readonly taskSetDigest: string;
  readonly expectedPriorEvaluationDigest?: string;
}

export interface RecordFanOutDiffDecisionPayload {
  readonly evaluationDigest: string;
  readonly priorEvaluationDigest: string;
  readonly diffDigest: string;
  readonly authorityDigest: string;
  readonly changed: "supersede-changed";
  readonly removed: "retain-removed";
}

export interface TaskFrontierStatus {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly attemptDigest: string;
  readonly forEachKey: string;
  readonly evaluationDigest: string;
  readonly taskSetDigest: string;
  readonly graphRevisionDigest: string;
  readonly configurationSnapshotDigest: string;
  readonly state: "evaluated" | "review-required" | "proposed" | "applied" | "complete" | "failed";
  readonly selectedCount: number;
  readonly effectiveCount: number;
  readonly activeCount: number;
  readonly completedCount: number;
  readonly maxActive: number;
}

export interface WithdrawAmendmentProposalPayload {
  readonly amendmentId: OpaqueIdentity;
  readonly proposalDigest: string;
}

export type AmendmentDecisionKind = "approve" | "reject";

export interface RecordAmendmentDecisionPayload extends WithdrawAmendmentProposalPayload {
  readonly decision: AmendmentDecisionKind;
  readonly reviewedResultGraphRevisionDigest: string;
}

export interface AmendmentTaskScopePayload {
  readonly taskId: OpaqueIdentity;
  readonly definitionGeneration: number;
}

export interface ApplyApprovedAmendmentPayload extends WithdrawAmendmentProposalPayload {
  readonly decisionDigest: string;
  readonly reviewedResultGraphRevisionDigest: string;
}

export interface RecordIntegrationBarrierPayload {
  readonly integrationId: OpaqueIdentity;
  readonly configurationSnapshotDigest: string;
  readonly barrier: JsonValue;
}

export interface CommandEnvelope {
  readonly apiVersion: ProtocolVersion;
  readonly commandId: CommandId;
  readonly principal: AuthenticatedPrincipal;
  readonly transport: TransportAttribution;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly intent: CommandIntent;
  readonly payload: JsonValue;
  readonly payloadDigest: string;
  readonly expectedDefinitionRevision?: Revision;
  readonly expectedGraphRevision?: Revision;
  readonly exactObjectDigest?: string;
  readonly expiresAt?: string;
}

export type CommandSubmission = Omit<CommandEnvelope, "principal" | "transport">;

export type ReceiptStatus =
  | "queued"
  | "claimed"
  | "completed"
  | "refused"
  | "expired"
  | "cancelled"
  | "unknown-effect";

export interface ErrorEnvelope {
  readonly apiVersion: ProtocolVersion;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly commandId?: CommandId;
  readonly details?: JsonValue;
}

export interface DurableReceipt {
  readonly apiVersion: ProtocolVersion;
  readonly commandId: CommandId;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly status: ReceiptStatus;
  readonly cursor: number;
  readonly priorRevision?: Revision;
  readonly resultRevision?: Revision;
  readonly result?: JsonValue;
  readonly error?: ErrorEnvelope;
}

export interface ReceiptPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly afterCursor: number;
  readonly latestCursor: number;
  readonly hasMore: boolean;
  readonly receipts: readonly DurableReceipt[];
}

export type SupervisorAllocationKind = "approval" | "stream-event";

export interface SupervisorAllocationFact {
  readonly kind: SupervisorAllocationKind;
  readonly id: OpaqueIdentity;
}

export interface SupervisorAdmissionFacts {
  readonly currentTime: string;
  readonly facts: JsonValue;
  readonly allocations: readonly SupervisorAllocationFact[];
}

export type SupervisorReceiptStatus = "queued" | "claimed" | "terminal";

export interface SupervisorReceipt {
  readonly sequence: number;
  readonly commandId: CommandId;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly status: SupervisorReceiptStatus;
  readonly recordedAt: string;
  readonly terminalReceipt?: DurableReceipt;
}

export type SupervisorWakeReason = "command-accepted";

export interface SupervisorWake {
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly generation: number;
  readonly acknowledgedGeneration: number;
  readonly notBefore: string;
  readonly reasons: readonly SupervisorWakeReason[];
}

export type SupervisorMode = "running" | "draining" | "drained" | "stopped";

export interface SupervisorServiceRecord {
  readonly mode: SupervisorMode;
  readonly changedAt: string;
}

export interface EventStreamFrame {
  readonly apiVersion: ProtocolVersion;
  readonly cursor: number;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly eventId: OpaqueIdentity;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: JsonValue;
  readonly payloadDigest: string;
  readonly commandId?: CommandId;
}

export interface EventReplayPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly afterCursor: number;
  readonly earliestAvailableCursor: number;
  /** Latest workflow/run authority cursor, which may exceed the latest available event cursor. */
  readonly latestCursor: number;
  readonly hasMore: boolean;
  readonly events: readonly EventStreamFrame[];
}

export interface ProjectionEnvelope {
  readonly apiVersion: ProtocolVersion;
  readonly cursor: number;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly projectionType: string;
  readonly revision: Revision;
  readonly generatedAt: string;
  readonly payload: JsonValue;
  readonly payloadDigest: string;
}

export interface CapabilityHandshake {
  readonly apiVersion: ProtocolVersion;
  readonly peerId: OpaqueIdentity;
  readonly supportedVersions: readonly string[];
  readonly capabilities: readonly string[];
}
