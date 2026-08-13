export const PROTOCOL_VERSION = "senawa.dev/protocol/v1alpha1" as const;

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
  | { readonly type: "accept-graph-revision" }
  | { readonly type: "submit-completion" }
  | { readonly type: "evaluate-gate" }
  | { readonly type: "record-authority-decision" }
  | { readonly type: "close-phase" }
  | { readonly type: "submit-amendment-proposal" }
  | { readonly type: "withdraw-amendment-proposal" }
  | { readonly type: "record-amendment-decision" }
  | { readonly type: "apply-approved-amendment" }
  | { readonly type: "create-escalation" }
  | { readonly type: "grant-allowance" };

export interface SubmitAmendmentProposalPayload {
  readonly proposal: JsonValue;
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
