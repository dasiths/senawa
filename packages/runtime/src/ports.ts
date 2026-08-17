import type { IntegrationBarrier, Sha256 } from "@senawa/kernel";
import type {
  AuthenticatedPrincipal,
  CommandEnvelope,
  CommandIntent,
  DurableReceipt,
  EventReplayPage,
  EventStreamFrame,
  JsonValue,
  ProjectionEnvelope,
  ReceiptPage,
} from "@senawa/protocol";

export type RuntimeSha256 = Sha256;

export type AllocationKind = "approval" | "escalation" | "stream-event";

export type PageQueryErrorCode = "cursor-ahead" | "event-replay-gap" | "scope-mismatch";

export class PageQueryError extends Error {
  readonly code: PageQueryErrorCode;

  constructor(code: PageQueryErrorCode, message: string) {
    super(message);
    this.name = "PageQueryError";
    this.code = code;
  }
}

export interface AdmissionFacts {
  readonly currentTime: string;
  readonly facts: JsonValue;
  allocateId(kind: AllocationKind, command: CommandEnvelope): string;
}

export interface AuthorizationPolicy {
  authorize(principal: AuthenticatedPrincipal, intent: CommandIntent): boolean;
}

export interface RuntimeDependencies {
  readonly sha256: RuntimeSha256;
  readonly authorization: AuthorizationPolicy;
}

export interface CommandServicePort {
  submit(input: string | unknown, admission: AdmissionFacts): DurableReceipt;
}

export interface RuntimeQueryPort {
  queryReceipt(commandId: string): DurableReceipt | undefined;
  queryReceiptHistory(repositoryId: string, runId: string): readonly DurableReceipt[];
  queryReceiptPage(
    repositoryId: string,
    runId: string,
    afterCursor?: number,
    limit?: number,
  ): ReceiptPage;
  queryEvents(
    repositoryId: string,
    runId: string,
    afterCursor?: number,
  ): readonly EventStreamFrame[];
  queryEventPage(
    repositoryId: string,
    runId: string,
    afterCursor?: number,
    limit?: number,
  ): EventReplayPage;
  queryProjection(repositoryId: string, runId: string): ProjectionEnvelope | undefined;
  queryIntegrationBarrier(repositoryId: string, runId: string): IntegrationBarrier | undefined;
}

export interface SerializableAuthorityPort {
  toCanonicalJson(): string;
}

export const REPORTING_SNAPSHOT_VERSION = "senawa.dev/reporting-snapshot/v1" as const;

export const REPORTING_LIMITS = Object.freeze({
  maxRecordsPerSection: 10_000,
  maxTotalRecords: 50_000,
  maxReferencesPerRecord: 32,
  maxScalarsPerRecord: 32,
  maxTextBytes: 1_024,
});

export type ReportingSectionStatus = "complete" | "absent" | "unavailable";

export type ReportingSectionName =
  | "graph"
  | "trajectory"
  | "actors"
  | "models"
  | "assets"
  | "context"
  | "dataflow"
  | "amendments"
  | "escalations"
  | "gates"
  | "approvals"
  | "costs"
  | "uncertainty"
  | "workspaces"
  | "integration"
  | "portal"
  | "remote";

export interface ReportingSourceVector {
  readonly workflowCursor: number;
  readonly lifecycleRevision: number;
  readonly contextRevision: number;
  readonly dataflowRevision: number;
  readonly runnerRevision: number;
  readonly workspaceRevision: number;
  readonly humanRevision: number;
  readonly portalRevision: number;
  readonly graphRevision?: string;
  readonly remoteLocalCursor?: number;
  readonly remoteEnqueuedCursor?: number;
  readonly remoteAcknowledgedCursor?: number;
}

export type ReportingReferenceRole = "source" | "result" | "related";

export interface ReportingReference {
  readonly role: ReportingReferenceRole;
  readonly kind: string;
  readonly identity: string;
}

export type ReportingScalar = string | number | boolean;

export interface ReportingNamedScalar {
  readonly name: string;
  readonly value: ReportingScalar;
}

/** A positive projection of typed authority facts; arbitrary source values never belong here. */
export interface ReportingRecord {
  readonly kind: string;
  readonly identity: string;
  readonly sequence?: number;
  readonly state?: string;
  readonly occurredAt?: string;
  readonly digest?: string;
  readonly references: readonly ReportingReference[];
  readonly scalars: readonly ReportingNamedScalar[];
}

export interface ReportingSnapshotSection {
  readonly name: ReportingSectionName;
  readonly status: ReportingSectionStatus;
  readonly reasonCode?: string;
  readonly records: readonly ReportingRecord[];
}

export interface ReportingSnapshot {
  readonly version: typeof REPORTING_SNAPSHOT_VERSION;
  readonly repositoryId: string;
  readonly runId: string;
  readonly schemaVersion: number;
  readonly configurationSnapshotDigest?: string;
  readonly sourceVector: ReportingSourceVector;
  readonly sections: readonly ReportingSnapshotSection[];
}

export interface ReportingSnapshotPort {
  captureReportingSnapshot(repositoryId: string, runId: string): ReportingSnapshot;
}

export interface AuthorityPort<RunState = unknown> extends SerializableAuthorityPort {
  readonly runs: Map<string, RunState>;
}
