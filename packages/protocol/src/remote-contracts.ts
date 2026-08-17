import type {
  AuthenticatedPrincipal,
  CommandSubmission,
  OpaqueIdentity,
  ReceiptStatus,
  TransportAttribution,
} from "./contracts.js";

export const REMOTE_NEGOTIATION_VERSION = "senawa.dev/remote-control/negotiation/v1" as const;
export const REMOTE_PROTOCOL_VERSION = "senawa.dev/remote-control/v1" as const;

export const REMOTE_CAPABILITIES = Object.freeze([
  "classified-reporting-v1",
  "command-delivery-v1",
  "exact-acknowledgement-v1",
  "hash-linked-envelopes-v1",
  "receipt-chain-v1",
  "sync-vector-v1",
] as const);

export type RemoteNegotiationVersion = typeof REMOTE_NEGOTIATION_VERSION;
export type RemoteProtocolVersion = typeof REMOTE_PROTOCOL_VERSION;
export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];

export interface RemoteHelloOffer {
  readonly negotiationVersion: RemoteNegotiationVersion;
  readonly peerId: OpaqueIdentity;
  readonly supportedVersions: readonly string[];
  readonly capabilities: readonly string[];
}

export interface RemoteHelloSelection {
  readonly negotiationVersion: RemoteNegotiationVersion;
  readonly type: "selection";
  readonly sessionId: OpaqueIdentity;
  readonly serverPeerId: OpaqueIdentity;
  readonly selectedVersion: RemoteProtocolVersion;
  readonly capabilities: readonly RemoteCapability[];
}

export type RemoteHelloRefusalCode =
  | "no-common-version"
  | "missing-capability"
  | "binding-refused"
  | "revoked";

export interface RemoteHelloRefusal {
  readonly negotiationVersion: RemoteNegotiationVersion;
  readonly type: "refusal";
  readonly code: RemoteHelloRefusalCode;
  readonly message: string;
  readonly supportedVersions: readonly string[];
  readonly requiredCapabilities: readonly RemoteCapability[];
}

export type RemoteHelloResponse = RemoteHelloSelection | RemoteHelloRefusal;

export interface RemoteRepositoryBinding {
  readonly apiVersion: RemoteProtocolVersion;
  readonly bindingId: OpaqueIdentity;
  readonly tenantId: OpaqueIdentity;
  readonly repositoryId: OpaqueIdentity;
  readonly connectorId: OpaqueIdentity;
  readonly repositoryKeyId: OpaqueIdentity;
  readonly controlPlaneKeyId: OpaqueIdentity;
  readonly revocationEpoch: number;
  readonly policyDigest: string;
  readonly issuedAt: string;
}

export interface RemoteServerAttribution {
  readonly principal: AuthenticatedPrincipal;
  readonly transport: TransportAttribution & Readonly<{ kind: "remote" }>;
}

export interface RemoteCentralAcceptedCommand {
  readonly apiVersion: RemoteProtocolVersion;
  readonly acceptanceId: OpaqueIdentity;
  readonly binding: RemoteRepositoryBinding;
  readonly attribution: RemoteServerAttribution;
  readonly command: CommandSubmission;
  readonly commandDigest: string;
  readonly acceptedAt: string;
  readonly expiresAt: string;
}

export interface RemoteCommandEnvelope {
  readonly apiVersion: RemoteProtocolVersion;
  readonly sequence: number;
  readonly previousEnvelopeDigest: string | null;
  readonly acceptedCommand: RemoteCentralAcceptedCommand;
  readonly acceptedCommandDigest: string;
  readonly issuedAt: string;
  readonly signingKeyId: OpaqueIdentity;
  readonly signature: string;
}

export interface RemoteCommandDelivery {
  readonly envelope: RemoteCommandEnvelope;
  readonly receiptEntry: RemoteReceiptChainEntry;
}

export const REMOTE_RECEIPT_STAGES = Object.freeze([
  "central-accepted",
  "connector-delivered",
  "local-accepted",
  "runner-claimed",
  "local-outcome",
] as const);

export type RemoteReceiptStage = (typeof REMOTE_RECEIPT_STAGES)[number];

export interface RemoteCentralAcceptanceEvidence {
  readonly type: "central-acceptance";
  readonly acceptanceId: OpaqueIdentity;
  readonly acceptanceDigest: string;
}

export interface RemoteConnectorDeliveryEvidence {
  readonly type: "connector-delivery";
  readonly envelopeSequence: number;
  readonly envelopeDigest: string;
}

export interface RemoteLocalReceiptEvidence {
  readonly type: "local-receipt";
  readonly localCommandId: OpaqueIdentity;
  readonly receiptStatus: "queued" | "claimed";
  readonly receiptCursor: number;
  readonly receiptDigest: string;
}

export interface RemoteLocalOutcomeEvidence {
  readonly type: "local-outcome";
  readonly localCommandId: OpaqueIdentity;
  readonly receiptStatus: Exclude<ReceiptStatus, "queued" | "claimed">;
  readonly receiptCursor: number;
  readonly receiptDigest: string;
}

export type RemoteReceiptEvidence =
  | RemoteCentralAcceptanceEvidence
  | RemoteConnectorDeliveryEvidence
  | RemoteLocalReceiptEvidence
  | RemoteLocalOutcomeEvidence;

export interface RemoteReceiptChainEntry {
  readonly apiVersion: RemoteProtocolVersion;
  readonly bindingId: OpaqueIdentity;
  readonly commandId: OpaqueIdentity;
  readonly stage: RemoteReceiptStage;
  readonly stageSequence: number;
  readonly recordedAt: string;
  readonly previousEntryDigest: string | null;
  readonly entryDigest: string;
  readonly evidence: RemoteReceiptEvidence;
}

export interface RemoteReceiptChain {
  readonly bindingId: OpaqueIdentity;
  readonly commandId: OpaqueIdentity;
  readonly entries: readonly RemoteReceiptChainEntry[];
}

export type RemoteReportClassification = "public" | "internal";

export interface RemoteEventMetadata {
  readonly cursor: number;
  readonly repositoryId: OpaqueIdentity;
  readonly runId: OpaqueIdentity;
  readonly eventId: OpaqueIdentity;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payloadDigest: string;
  readonly commandId?: OpaqueIdentity;
}

export interface RemoteProjectionCounts {
  readonly tasks: number;
  readonly readyTasks: number;
  readonly humanNeeds: number;
  readonly activeEffects: number;
  readonly uncertainEffects: number;
}

export interface RemoteProjectionMetadata {
  readonly cursor: number;
  readonly repositoryId: OpaqueIdentity;
  readonly runId: OpaqueIdentity;
  readonly projectionType: string;
  readonly revision: OpaqueIdentity;
  readonly generatedAt: string;
  readonly payloadDigest: string;
  readonly lifecycleStatus: string;
  readonly counts: RemoteProjectionCounts;
}

export interface RemoteSynchronizationVector {
  readonly repositoryId: OpaqueIdentity;
  readonly localLatestCursor: number;
  readonly durablyEnqueuedCursor: number;
  readonly centrallyAcknowledgedCursor: number;
  readonly localObservedAt: string;
  readonly lastEnqueuedAt: string | null;
  readonly lastAcknowledgedAt: string | null;
}

export interface RemoteClassifiedReport {
  readonly apiVersion: RemoteProtocolVersion;
  readonly reportId: OpaqueIdentity;
  readonly binding: RemoteRepositoryBinding;
  readonly classification: RemoteReportClassification;
  readonly dataPolicyDigest: string;
  readonly reportSequence: number;
  readonly previousReportDigest: string | null;
  readonly createdAt: string;
  readonly receiptChains: readonly RemoteReceiptChain[];
  readonly events: readonly RemoteEventMetadata[];
  readonly projections: readonly RemoteProjectionMetadata[];
  readonly synchronization: RemoteSynchronizationVector;
}

export interface RemoteReportAcknowledgement {
  readonly apiVersion: RemoteProtocolVersion;
  readonly bindingId: OpaqueIdentity;
  readonly repositoryId: OpaqueIdentity;
  readonly reportId: OpaqueIdentity;
  readonly reportSequence: number;
  readonly reportDigest: string;
  readonly centralReceiptId: OpaqueIdentity;
  readonly acknowledgedAt: string;
  readonly signingKeyId: OpaqueIdentity;
  readonly signature: string;
}
