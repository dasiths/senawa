import type { JsonValue, OpaqueIdentity, ProtocolVersion } from "./contracts.js";

export type AssetSensitivity = "public" | "internal" | "confidential" | "restricted";
export type AssetReadMode = "pointer" | "chunk" | "pointer-and-chunk";

export interface WorkerTaskGenerationReference {
  readonly taskId: OpaqueIdentity;
  readonly definitionGeneration: number;
  readonly contextRevisionDigest: string;
}

export interface ContextGrantEnvelope {
  readonly apiVersion: ProtocolVersion;
  readonly grantToken: string;
  readonly repositoryId: OpaqueIdentity;
  readonly runId: OpaqueIdentity;
  readonly dispatchId: OpaqueIdentity;
  readonly task: WorkerTaskGenerationReference;
  readonly contextId: OpaqueIdentity;
  readonly contextDigest: string;
  readonly principalId: OpaqueIdentity;
  readonly assetBindingId: OpaqueIdentity;
  readonly allowedPointer: string;
  readonly readMode: AssetReadMode;
  readonly sensitivityCeiling: AssetSensitivity;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly maxOperations: number;
  readonly maxBytes: number;
  readonly maxChunkBytes: number;
}

interface AssetReadRequestBase {
  readonly apiVersion: ProtocolVersion;
  readonly requestId: OpaqueIdentity;
  readonly grantToken: string;
  readonly assetBindingId: OpaqueIdentity;
}

export interface AssetPointerReadRequest extends AssetReadRequestBase {
  readonly type: "pointer";
  readonly pointer: string;
  readonly maxBytes: number;
}

export interface AssetChunkReadRequest extends AssetReadRequestBase {
  readonly type: "chunk";
  readonly offset: number;
  readonly length: number;
}

export type AssetReadRequest = AssetPointerReadRequest | AssetChunkReadRequest;

export type AssetReadReceiptStatus = "served" | "denied";

export type AssetReadDenialCode =
  | "invalid-token"
  | "scope-denied"
  | "sensitivity-denied"
  | "expired"
  | "budget-exhausted"
  | "invalid-pointer"
  | "invalid-range"
  | "digest-mismatch"
  | "request-conflict";

export interface AssetReadAuditReceipt {
  readonly apiVersion: ProtocolVersion;
  readonly requestId: OpaqueIdentity;
  readonly requestDigest: string;
  readonly repositoryId: OpaqueIdentity;
  readonly runId: OpaqueIdentity;
  readonly dispatchId: OpaqueIdentity;
  readonly contextId: OpaqueIdentity;
  readonly assetBindingId: OpaqueIdentity;
  readonly principalId: OpaqueIdentity;
  readonly status: AssetReadReceiptStatus;
  readonly occurredAt: string;
  readonly chargedOperations: number;
  readonly chargedBytes: number;
  readonly responseBytes: number;
  readonly remainingOperations: number;
  readonly remainingBytes: number;
  readonly denialCode?: AssetReadDenialCode;
}

export type WorkerTerminalDisposition =
  | "completed"
  | "blocked"
  | "waived"
  | "skipped"
  | "superseded";

export type WorkerCriterionDisposition = "satisfied" | "unsatisfied" | "waived" | "skipped";

export interface WorkerCriterionOutcome {
  readonly criterionId: OpaqueIdentity;
  readonly disposition: WorkerCriterionDisposition;
  readonly authorityFact?: JsonValue;
}

export interface WorkerCompletionEvidenceItem {
  readonly assetId: OpaqueIdentity;
  readonly kind: JsonValue;
  readonly descriptor: JsonValue;
  readonly criterionId?: OpaqueIdentity;
}

export interface WorkerCompletionPayload {
  readonly task: WorkerTaskGenerationReference;
  readonly disposition: WorkerTerminalDisposition;
  readonly summary: string;
  readonly criteria: readonly WorkerCriterionOutcome[];
  readonly completionEvidence: readonly WorkerCompletionEvidenceItem[];
  readonly replacementTask?: WorkerTaskGenerationReference;
}

interface WorkerSubmissionBase {
  readonly apiVersion: ProtocolVersion;
  readonly submissionId: OpaqueIdentity;
  readonly repositoryId: OpaqueIdentity;
  readonly runId: OpaqueIdentity;
  readonly dispatchId: OpaqueIdentity;
  readonly task: WorkerTaskGenerationReference;
  readonly contextId: OpaqueIdentity;
  readonly contextDigest: string;
  readonly principalId: OpaqueIdentity;
}

export interface WorkerCompletionSubmission extends WorkerSubmissionBase {
  readonly type: "completion";
  readonly completion: WorkerCompletionPayload;
}

export interface WorkerQuestionSubmission extends WorkerSubmissionBase {
  readonly type: "question";
  readonly question: Readonly<{
    readonly prompt: string;
    readonly details?: JsonValue;
  }>;
}

export interface WorkerAssetSubmission extends WorkerSubmissionBase {
  readonly type: "asset";
  readonly asset: Readonly<{
    readonly assetId: OpaqueIdentity;
    readonly contentDigest: string;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly sensitivity: AssetSensitivity;
    readonly summary: string;
  }>;
}

export interface WorkerDiscoverySubmission extends WorkerSubmissionBase {
  readonly type: "discovery";
  readonly discovery: Readonly<{
    readonly summary: string;
    readonly details: JsonValue;
  }>;
}

export interface WorkerAmendmentProposalSubmission extends WorkerSubmissionBase {
  readonly type: "amendment-proposal";
  readonly amendment: Readonly<{
    readonly baseGraphRevisionDigest: string;
    readonly baseContextDigest: string;
    readonly summary: string;
    readonly operations: JsonValue;
  }>;
}

export interface WorkerPhaseOutputSubmission extends WorkerSubmissionBase {
  readonly type: "phase-output";
  readonly output: Readonly<{
    readonly phase: Readonly<{
      readonly phaseId: OpaqueIdentity;
      readonly definitionGeneration: number;
      readonly attempt: number;
    }>;
    readonly outputName: string;
    readonly schemaKey: string;
    readonly schemaResourceDigest: string;
    readonly contentDigest: string;
    readonly byteLength: number;
    readonly mediaType: "application/json";
    readonly sensitivity: AssetSensitivity;
    readonly graphRevisionDigest: string;
    readonly configurationSnapshotDigest: string;
    readonly inputBindingDigest: string;
    readonly validationReceiptDigest: string;
  }>;
}

export type WorkerSubmission =
  | WorkerCompletionSubmission
  | WorkerQuestionSubmission
  | WorkerAssetSubmission
  | WorkerDiscoverySubmission
  | WorkerAmendmentProposalSubmission
  | WorkerPhaseOutputSubmission;
