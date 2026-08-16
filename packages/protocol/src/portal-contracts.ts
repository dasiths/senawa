import type {
  DurableReceipt,
  EventStreamFrame,
  JsonValue,
  OpaqueIdentity,
  ProtocolVersion,
  RepositoryId,
  RunId,
} from "./contracts.js";
import type { AssetSensitivity } from "./worker-contracts.js";

export const PORTAL_CAPABILITIES = Object.freeze([
  "portal-read-activity",
  "portal-read-artifacts",
  "portal-read-discovery",
  "portal-read-graph",
  "portal-read-human-needs",
  "portal-read-integrations",
  "portal-read-records",
  "portal-read-workspaces",
  "portal-write-answer-question",
  "portal-write-grant-allowance",
  "portal-write-record-amendment-decision",
  "portal-write-record-authority-decision",
  "portal-write-run-control",
] as const);

export const PORTAL_LIMITS = Object.freeze({
  maxDiscoveryItems: 100,
  maxGraphItems: 200,
  maxActivityItems: 100,
  maxArtifactItems: 100,
  maxWorkspaceItems: 100,
  maxIntegrationItems: 100,
  maxHumanNeeds: 100,
  maxDeliveryItems: 256,
  maxArtifactPreviewBytes: 65_536,
  jsonViewerNodeBudget: 500,
});

export interface PortalSyncVector {
  readonly workflowCursor: number;
  readonly contextRevision: number;
  readonly runnerRevision: number;
  readonly workspaceRevision: number;
  readonly humanRevision: number;
  readonly portalRevision: number;
  /**
   * Agent output advances only this component so an actively writing run never
   * invalidates a bounded assembly window that requires vector equality.
   */
  readonly transcriptRevision: number;
  readonly graphRevision: string;
  readonly lifecycleRevision: number;
}

export interface PortalSessionDescriptor {
  readonly apiVersion: ProtocolVersion;
  readonly expiresAt: string;
  readonly csrfMode: "available" | "read-only";
  readonly capabilities: readonly string[];
}

export interface PortalRepositorySummary {
  readonly repositoryId: RepositoryId;
  readonly displayName: string;
  readonly portalRevision: number;
  readonly runCount: number;
}

export interface PortalRepositoryPage {
  readonly apiVersion: ProtocolVersion;
  readonly after?: RepositoryId;
  readonly hasMore: boolean;
  readonly repositories: readonly PortalRepositorySummary[];
}

export type PortalRunMode = "running" | "paused" | "ending" | "ended";

export interface PortalRunSummary {
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly displayName: string;
  readonly workflowName: string;
  readonly mode: PortalRunMode;
  readonly runModeRevision: number;
  readonly terminal: boolean;
  readonly updatedAt: string;
  readonly sync: PortalSyncVector;
}

export interface PortalRunPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly after?: RunId;
  readonly hasMore: boolean;
  readonly runs: readonly PortalRunSummary[];
}

export interface PortalRunCounts {
  readonly phases: number;
  readonly tasks: number;
  readonly criteria: number;
  readonly humanNeeds: number;
  readonly activeEffects: number;
  readonly uncertainEffects: number;
}

export interface PortalRunOverview extends PortalRunSummary {
  readonly apiVersion: ProtocolVersion;
  readonly counts: PortalRunCounts;
}

export interface PortalGraphSummary {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly graphRevision: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly jsonNodeBudget: number;
}

export type PortalGraphNodeKind = "workflow" | "phase" | "task" | "criterion";

export type PortalGraphNodeRunState =
  | "not-started"
  | "running"
  | "awaiting-human"
  | "accepted"
  | "failed"
  | "superseded";

export interface PortalGraphNode {
  readonly nodeId: OpaqueIdentity;
  readonly kind: PortalGraphNodeKind;
  readonly title: string;
  readonly definitionGeneration: number;
  readonly lifecycle: string;
  readonly runState: PortalGraphNodeRunState;
  readonly parentNodeId?: OpaqueIdentity;
  readonly sourcePointer?: string;
  readonly normalizedInput?: JsonValue;
  readonly completionPolicy?: JsonValue;
  readonly supersededBy?: OpaqueIdentity;
  readonly attempt?: number;
  readonly roleKey?: string;
  /** The dispatch currently executing this node, when authority records one. */
  readonly dispatchId?: OpaqueIdentity;
  readonly humanNeedCount: number;
  readonly evidenceCount: number;
}

export type PortalGraphEdgeKind = "containment" | "dependency" | "supersession";

export interface PortalGraphEdge {
  readonly edgeId: OpaqueIdentity;
  readonly fromNodeId: OpaqueIdentity;
  readonly toNodeId: OpaqueIdentity;
  readonly kind: PortalGraphEdgeKind;
}

export interface PortalGraphNodePage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly graphRevision: string;
  readonly after: number;
  readonly nextAfter: number;
  readonly hasMore: boolean;
  readonly nodes: readonly PortalGraphNode[];
}

export interface PortalGraphEdgePage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly graphRevision: string;
  readonly after: number;
  readonly nextAfter: number;
  readonly hasMore: boolean;
  readonly edges: readonly PortalGraphEdge[];
}

export type PortalDeliveryRecordKind =
  | "phase-attempt"
  | "phase-transition"
  | "phase-output"
  | "fan-out-evaluation"
  | "generated-task"
  | "plan-import";

export interface PortalDeliveryRecord {
  readonly identity: string;
  readonly kind: PortalDeliveryRecordKind;
  readonly phaseId?: OpaqueIdentity;
  readonly definitionGeneration?: number;
  readonly attempt?: number;
  readonly state?: string;
  readonly outputName?: string;
  readonly schemaKey?: string;
  readonly contentDigest?: string;
  readonly byteLength?: number;
  readonly sensitivity?: AssetSensitivity;
  readonly accepted?: boolean;
  readonly trigger?: string;
  readonly disposition?: string;
  readonly nextAttempt?: number;
  readonly forEachKey?: string;
  readonly evaluationDigest?: string;
  readonly taskSetDigest?: string;
  readonly applied?: boolean;
  readonly taskId?: OpaqueIdentity;
  readonly inputDigest?: string;
  readonly proposalDigest?: string;
  readonly decisionDigest?: string;
  readonly applicationDigest?: string;
}

export interface PortalDeliveryPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly dataflowRevision: number;
  readonly taskFrontierRevision: number;
  readonly after: number;
  readonly nextAfter: number;
  readonly hasMore: boolean;
  readonly records: readonly PortalDeliveryRecord[];
}

export type PortalRecordKind = "candidate" | "gate" | "decision" | "closure" | "escalation";

export interface PortalImmutableRecord {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly kind: PortalRecordKind;
  readonly recordId: OpaqueIdentity;
  readonly digest: string;
  readonly graphRevision: string;
  readonly recordedAt: string;
  readonly body: JsonValue;
}

export interface PortalAllowanceReview {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly escalationCommandId: OpaqueIdentity;
  readonly escalationDigest: string;
  readonly operationId: OpaqueIdentity;
  readonly unit: string;
  readonly requested: number;
  readonly available: number;
  readonly createdAt: string;
  readonly currentLimit: number;
  readonly maxIncrease: number;
  readonly ceiling: number;
  readonly allowancePolicyDigest: string;
  readonly resultingMax: number;
  readonly expectedGraphRevision: string;
  readonly expectedRunMode: "running" | "paused";
  readonly expectedRunModeRevision: number;
}

export type PortalHumanNeedKind =
  | "question"
  | "candidate-approval"
  | "amendment-decision"
  | "amendment-application"
  | "escalation"
  | "integration-conflict"
  | "integration-rework"
  | "ending-uncertain";

export interface PortalHumanNeed {
  readonly needId: OpaqueIdentity;
  readonly kind: PortalHumanNeedKind;
  readonly sourceId: OpaqueIdentity;
  readonly sourceDigest: string;
  readonly sourceRevision: number;
  readonly title: string;
  readonly createdAt: string;
  readonly taskId?: OpaqueIdentity;
  readonly definitionGeneration?: number;
  readonly expectedGraphRevision?: string;
  readonly exactObjectDigest?: string;
  readonly allowedCommands: readonly string[];
}

export interface PortalHumanNeedPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly humanRevision: number;
  readonly after?: OpaqueIdentity;
  readonly hasMore: boolean;
  readonly needs: readonly PortalHumanNeed[];
}

export interface PortalQuestionSource {
  readonly submissionId: OpaqueIdentity;
  readonly dispatchId: OpaqueIdentity;
  readonly taskId: OpaqueIdentity;
  readonly definitionGeneration: number;
  readonly contextId: OpaqueIdentity;
  readonly contextDigest: string;
  readonly contextRevisionDigest: string;
  readonly questionDigest: string;
  readonly submittedAt: string;
}

export interface PortalQuestionAnswer {
  readonly answerId: OpaqueIdentity;
  readonly answerDigest: string;
  readonly answeredAt: string;
  readonly answeredBy: OpaqueIdentity;
  readonly answer: JsonValue;
}

export type PortalFreshDispatchRequirement =
  | { readonly status: "not-required" }
  | {
      readonly requirementId: OpaqueIdentity;
      readonly status: "pending";
      readonly createdAt: string;
    }
  | {
      readonly requirementId: OpaqueIdentity;
      readonly status: "satisfied";
      readonly createdAt: string;
      readonly satisfiedAt: string;
      readonly dispatchId: OpaqueIdentity;
    };

export interface PortalQuestionRecord {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly source: PortalQuestionSource;
  readonly prompt: string;
  readonly details?: JsonValue;
  readonly answer?: PortalQuestionAnswer;
  readonly freshDispatch: PortalFreshDispatchRequirement;
}

export interface PortalQuestionPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly contextRevision: number;
  readonly after?: OpaqueIdentity;
  readonly hasMore: boolean;
  readonly questions: readonly PortalQuestionRecord[];
}

export type PortalArtifactSource = "worker" | "evidence" | "installed";
export type PortalArtifactAvailability = "metadata-only" | "verified-stored";

export interface PortalArtifactMetadata {
  readonly artifactId: OpaqueIdentity;
  readonly source: PortalArtifactSource;
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sensitivity: AssetSensitivity;
  readonly summary: string;
  readonly availability: PortalArtifactAvailability;
  readonly taskId?: OpaqueIdentity;
  readonly definitionGeneration?: number;
  readonly criterionId?: OpaqueIdentity;
}

export interface PortalArtifactPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly contextRevision: number;
  readonly after?: OpaqueIdentity;
  readonly hasMore: boolean;
  readonly artifacts: readonly PortalArtifactMetadata[];
}

export interface PortalArtifactContent {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly artifactId: OpaqueIdentity;
  readonly contentDigest: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly totalByteLength: number;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
  readonly complete: boolean;
  readonly jsonNodeBudget: number;
}

export interface PortalWorkspaceSummary {
  readonly workspaceId: OpaqueIdentity;
  readonly taskId: OpaqueIdentity;
  readonly definitionGeneration: number;
  readonly dispatchId: OpaqueIdentity;
  readonly mode: "repository" | "isolated";
  readonly state: string;
  readonly baseDigest: string;
  readonly resultDigest?: string;
  readonly completionEligible: boolean;
  readonly updatedAt: string;
}

export interface PortalWorkspacePage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly workspaceRevision: number;
  readonly after?: OpaqueIdentity;
  readonly hasMore: boolean;
  readonly workspaces: readonly PortalWorkspaceSummary[];
}

export interface PortalIntegrationDiagnostic {
  readonly code: string;
  readonly summary: string;
  readonly details?: JsonValue;
}

export interface PortalIntegrationSummary {
  readonly integrationId: OpaqueIdentity;
  readonly cohortId: OpaqueIdentity;
  readonly attempt: number;
  readonly state: string;
  readonly memberCount: number;
  readonly targetDigest: string;
  readonly gateDigest?: string;
  readonly barrierDigest?: string;
  readonly successorIntegrationId?: OpaqueIdentity;
  readonly diagnostic?: PortalIntegrationDiagnostic;
  readonly updatedAt: string;
}

export interface PortalIntegrationPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly workspaceRevision: number;
  readonly after?: OpaqueIdentity;
  readonly hasMore: boolean;
  readonly integrations: readonly PortalIntegrationSummary[];
}

export type PortalActivityDirection = "tail" | "after" | "before";

interface PortalActivityWindowBase {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly direction: PortalActivityDirection;
  readonly after?: number;
  readonly before?: number;
  readonly earliestCursor: number;
  readonly latestCursor: number;
  readonly hasEarlier: boolean;
  readonly hasLater: boolean;
}

export interface PortalReceiptWindow extends PortalActivityWindowBase {
  readonly receipts: readonly DurableReceipt[];
}

export interface PortalEventWindow extends PortalActivityWindowBase {
  readonly events: readonly EventStreamFrame[];
}

export const TRANSCRIPT_LIMITS = Object.freeze({
  maxLineBytes: 4_096,
  maxRecordsPerPage: 200,
  maxRetainedLinesPerOwner: 5_000,
});

/**
 * `run` is a read-only projection scope. Capture always writes a dispatch, task,
 * or phase owner; the run scope merges those durable rows for one run.
 */
export type PortalTranscriptOwnerKind = "dispatch" | "task" | "phase" | "run";

export interface PortalTranscriptOwner {
  readonly kind: PortalTranscriptOwnerKind;
  readonly id: OpaqueIdentity;
}

export type PortalTranscriptStream = "stdout" | "stderr" | "system";

export interface PortalTranscriptRecord {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly owner: PortalTranscriptOwner;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly stream: PortalTranscriptStream;
  readonly text: string;
}

export interface PortalTranscriptPage {
  readonly apiVersion: ProtocolVersion;
  readonly repositoryId: RepositoryId;
  readonly runId: RunId;
  readonly owner: PortalTranscriptOwner;
  readonly after: number;
  readonly nextAfter: number;
  readonly hasMore: boolean;
  readonly records: readonly PortalTranscriptRecord[];
}
