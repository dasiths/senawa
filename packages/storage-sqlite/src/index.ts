import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfigurationSnapshot as validateConfigurationSnapshotContract } from "@senawa/configuration";
import {
  type AgentSessionResumeBinding,
  type AmendmentApplication,
  type AmendmentDecision,
  type AmendmentProposal,
  type AmendmentWithdrawal,
  bindGitObjectId,
  bindGitRevision,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  createAmendmentQuiescenceFact,
  type FanOutEvaluation,
  type HistoricalAssetBinding,
  type IntegrationBarrier,
  type IntegrationMember,
  isSha256Digest,
  type PhaseAttempt,
  type PhaseAttemptTransition,
  type PhaseGenerationReference,
  type PhaseInputBinding,
  type PhaseOutputAcceptance,
  type PhaseOutputPublication,
  validateAgentSessionResumeBinding,
  validateFanOutEvaluation,
  validateIntegrationBarrier,
  validatePhaseAttempt,
  validatePhaseAttemptTransition,
  validatePhaseInputBinding,
  validatePhaseOutputAcceptance,
  validatePhaseOutputPublication,
  type validateWorkflowGraph,
  validateWorkflowInputBinding,
  type WorkflowGraph,
  type WorkflowInputBinding,
} from "@senawa/kernel";
import {
  type CommandEnvelope,
  canonicalBytes,
  canonicalStringify,
  type DurableReceipt,
  decodeAnswerQuestionPayload,
  decodeApplyApprovedAmendmentPayload,
  decodeCanonicalJsonValue,
  decodeCommandEnvelope,
  decodeDurableJsonValue,
  decodeDurableReceipt,
  decodeEventReplayPage,
  decodeEventStreamFrame,
  decodeGrantAllowancePayload,
  decodeOverrideMemberPayload,
  decodePortalAgentPage,
  decodePortalAllowanceReview,
  decodePortalArtifactContent,
  decodePortalArtifactPage,
  decodePortalDeliveryPage,
  decodePortalEventWindow,
  decodePortalGraphEdgePage,
  decodePortalGraphNodePage,
  decodePortalGraphSummary,
  decodePortalHumanNeedPage,
  decodePortalImmutableRecord,
  decodePortalIntegrationPage,
  decodePortalQuestionPage,
  decodePortalQuestionRecord,
  decodePortalReceiptWindow,
  decodePortalRepositoryPage,
  decodePortalRunOverview,
  decodePortalRunPage,
  decodePortalTranscriptPage,
  decodePortalTranscriptRecord,
  decodePortalWorkspacePage,
  decodeReceiptPage,
  decodeRemoteClassifiedReport,
  decodeRemoteCommandEnvelope,
  decodeRemoteReceiptChainEntry,
  decodeRemoteReportAcknowledgement,
  decodeRemoteRepositoryBinding,
  decodeRemoteSynchronizationVector,
  decodeRunControlPayload,
  decodeSteerAgentPayload,
  decodeSupervisorAdmissionFacts,
  decodeSupervisorReceipt,
  decodeSupervisorServiceRecord,
  decodeSupervisorWake,
  durableStringify,
  type EventReplayPage,
  type EventStreamFrame,
  type JsonValue,
  MAX_REFUSAL_LENGTH,
  PORTAL_LIMITS,
  type PortalAgentPage,
  type PortalAllowanceReview,
  type PortalArtifactContent,
  type PortalArtifactMetadata,
  type PortalArtifactPage,
  type PortalDeliveryPage,
  type PortalDeliveryRecord,
  type PortalEventWindow,
  type PortalGraphEdgePage,
  type PortalGraphNodePage,
  type PortalGraphNodeRunState,
  type PortalGraphSummary,
  type PortalHumanNeed,
  type PortalHumanNeedPage,
  type PortalImmutableRecord,
  type PortalIntegrationPage,
  type PortalQuestionPage,
  type PortalQuestionRecord,
  type PortalReceiptWindow,
  type PortalRecordKind,
  type PortalRepositoryPage,
  type PortalRunOverview,
  type PortalRunPage,
  type PortalSyncVector,
  type PortalTranscriptOwner,
  type PortalTranscriptPage,
  type PortalWorkspacePage,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ProjectionEnvelope,
  REMOTE_CAPABILITIES,
  REMOTE_PROTOCOL_VERSION,
  type ReceiptPage,
  type RemoteClassifiedReport,
  type RemoteCommandEnvelope,
  type RemoteEventMetadata,
  type RemoteReceiptChainEntry,
  type RemoteReportAcknowledgement,
  type RemoteRepositoryBinding,
  type RemoteSynchronizationVector,
  TRANSCRIPT_LIMITS,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import {
  type AdmissionFacts,
  type AgentTranscriptLine,
  type AgentTranscriptOwner,
  type AgentTranscriptPort,
  AgentTranscriptRefusalError,
  type AssetReadInput,
  type AssetReadResult,
  assetReadWorstCaseBytes,
  type CanonicalJsonAssetDescriptor,
  type CanonicalJsonAssetPort,
  type ClaimEffectAttemptRequest,
  type ClaimEffectAttemptResult,
  type CommandServicePort,
  type CommitEffectRequest,
  type CompletionEligibilityInput,
  type CompletionEligibilityRecord,
  type CompletionFactPort,
  type ContextAuthoritySnapshot,
  ContextBroker,
  type ContextBrokerDependencies,
  type ContextBrokerProjection,
  ContextBrokerTransactionAbortError,
  type ContextGrantInput,
  DEFAULT_POINTER_ASSET_MAX_BYTES,
  decodePersistedAssetReadReplayKey,
  type EffectIntent,
  type EffectOutcome,
  type EnsureTaskScopesAndBudgetsInput,
  evaluatePhaseOutputAttempt,
  type FencedRunnerCancellationInput,
  type FencedRunnerContextUpdateInput,
  type FinalizedEffectUsage,
  InMemoryAuthority,
  InMemoryContextAuthority,
  type InMemoryRunnerRunInput,
  type InstalledCanonicalOutputAsset,
  type InstallTaskScopeFencesInput,
  type IntegrationAttemptInput,
  type IntegrationAttemptRecord,
  type IntegrationAttemptState,
  type IntegrationGateRecord,
  type IntegrationSlotClaimInput,
  type IntegrationSlotClaimResult,
  PageQueryError,
  type ParallelExecutionPolicy,
  type PersistIntentRequest,
  type PersistIntentResult,
  type PhaseOutputAttemptInput,
  type PhaseOutputAttemptRecord,
  type PhaseOutputAttemptResult,
  type PhaseOutputFactPort,
  type QueuedEffectCommand,
  type RegisterWorkerDispatchInput,
  type RunExecutionBinding,
  type RunnerAllowancePolicy,
  type RunnerAuthorityPort,
  type RunnerAuthoritySnapshot,
  type RunnerBudgetState,
  type RunnerCapacityState,
  type RunnerEffectEvent,
  type RunnerEffectReceipt,
  type RunnerEscalation,
  type RunnerLeaseFact,
  type RunnerProjection,
  type RunOnceInput,
  type RuntimeAuthorityRun,
  RuntimeCommandService,
  type RuntimeDataflowPersistencePort,
  type RuntimeDependencies,
  type RuntimeQueryPort,
  readCanonicalJsonPointer,
  type SerializableAuthorityPort,
  type StoredDispatch,
  type SubmissionAdmissionInput,
  type SubmissionAdmissionResult,
  selectEffectAttemptAction,
  type TaskScopeCurrentness,
  type TrustedHumanAuthorityDecision,
  type TrustedRuntimeCommandFacts,
  taskScopeKey,
  type WorkspaceIntegrationAuthorityPort,
  type WorkspaceIntentInput,
  type WorkspaceLifecycleState,
  type WorkspaceRecord,
  type WorkspaceResultInput,
  type WorkspaceResultRecord,
} from "@senawa/runtime";
import Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;
export const ASSET_SECURITY_LIMITS = Object.freeze({
  maxObjectBytes: 256 * 1024 * 1024,
  defaultMaxObjects: 10_000,
  defaultMaxTotalBytes: 1024 * 1024 * 1024,
});
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT_PAGES = 16_384;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

export type SqliteFaultPoint =
  | "after-command-execution"
  | "after-amendment-fences"
  | "after-amendment-application"
  | "before-command-commit"
  | "after-command-commit-before-ack"
  | "after-receipt-page-metadata-read"
  | "after-event-page-metadata-read"
  | "after-asset-stage"
  | "after-asset-install"
  | "before-asset-descriptor-commit"
  | "after-asset-descriptor-commit-before-ack"
  | "after-restore-asset-partial-create"
  | "after-restore-database-partial-create"
  | "after-restore-assets-publish"
  | "after-restore-database-publish";

export interface SqliteAuthorityOptions {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly busyTimeoutMs?: number;
  readonly assetQuota?: {
    readonly maxObjects: number;
    readonly maxTotalBytes: number;
  };
  readonly faultInjector?: (point: SqliteFaultPoint) => void;
}

interface OwnedRestorePath {
  readonly device: number;
  readonly inode: number;
  readonly kind: "directory" | "file";
  readonly path: string;
}

export interface SqlitePortalQueryAuthorityOptions {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
}

export interface AgentTranscriptAppendResult {
  readonly sequence: number;
  readonly retained: number;
  readonly replayed: boolean;
}

export interface PortalArtifactDownload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly digest: string;
}

export interface AssetDescriptor {
  readonly digest: string;
  readonly byteLength: number;
  readonly relativePath: string;
  readonly mediaType?: string;
}

export interface LeaseGrant {
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export interface AcquireLeaseInput {
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly currentTime: string;
  readonly expiresAt: string;
}

export interface RenewLeaseInput extends LeaseGrant {
  readonly currentTime: string;
  readonly newExpiresAt: string;
}

export interface ReleaseLeaseInput extends LeaseGrant {
  readonly currentTime: string;
}

export interface CancellationPlaceholderInput {
  readonly requestId: string;
  readonly runId: string;
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly requestedAt: string;
  readonly currentTime: string;
}

export type SqliteRunnerFaultPoint =
  | "before-intent-commit"
  | "after-intent-commit-before-ack"
  | "before-outcome-commit"
  | "after-outcome-commit-before-ack";

export type SqliteContextBrokerFaultPoint =
  | "after-read-reservation"
  | "before-read-commit"
  | "after-read-commit-before-ack"
  | "before-context-commit"
  | "after-context-commit-before-ack"
  | "before-outbox-ack"
  | "after-outbox-ack-before-return";

export interface SqliteContextBrokerOptions {
  readonly databasePath: string;
  readonly dependencies: ContextBrokerDependencies;
  readonly completionFacts?: CompletionFactPort;
  readonly phaseOutputFacts?: PhaseOutputFactPort;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SqliteContextBrokerFaultPoint) => void;
}

export interface SqliteRunnerAuthorityOptions {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SqliteRunnerFaultPoint) => void;
}

export type RunControlMode = "running" | "paused" | "ending" | "ended";

export interface RunControlState {
  readonly repositoryId: string;
  readonly runId: string;
  readonly mode: RunControlMode;
  readonly revision: number;
  readonly changedAt: string;
}

export interface FreshDispatchRequirement {
  readonly submissionId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly historicalDispatchId: string;
  readonly contextDigest: string;
  readonly taskId: string;
  readonly definitionGeneration: number;
  readonly requirementDigest: string;
  readonly createdAt: string;
}

export type SqliteWorkspaceAuthorityFaultPoint =
  | "before-workspace-intent-commit"
  | "after-workspace-intent-commit-before-ack"
  | "before-workspace-result-commit"
  | "after-workspace-result-commit-before-ack"
  | "before-integration-intent-commit"
  | "after-integration-intent-commit-before-ack"
  | "before-integration-claim-commit"
  | "after-integration-claim-commit-before-ack"
  | "before-integration-barrier-commit"
  | "after-integration-barrier-commit-before-ack"
  | "before-completion-eligibility-commit"
  | "after-completion-eligibility-commit-before-ack";

export interface SqliteWorkspaceIntegrationAuthorityOptions {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SqliteWorkspaceAuthorityFaultPoint) => void;
}

export type SqliteRemoteAuthorityFaultPoint =
  | "after-remote-inbox-commit-before-return"
  | "after-remote-local-acceptance-commit-before-return"
  | "after-remote-local-result-commit-before-return"
  | "before-remote-local-result-report-commit"
  | "after-remote-local-result-report-commit-before-return"
  | "after-remote-report-enqueue-commit-before-return"
  | "after-remote-report-claim-commit-before-return"
  | "after-remote-report-ack-commit-before-return";

export interface SqliteRemoteAuthorityOptions {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SqliteRemoteAuthorityFaultPoint) => void;
}

export type RemoteInboxProcessingState =
  | "waiting"
  | "ready"
  | "conflict"
  | "expired"
  | "revoked"
  | "local-accepted"
  | "local-result";

export interface RemoteInboxRecord {
  readonly bindingId: string;
  readonly sequence: number;
  readonly envelopeDigest: string;
  readonly canonicalEnvelope: string;
  readonly envelope: RemoteCommandEnvelope;
  readonly deliveryEntry: RemoteReceiptChainEntry;
  readonly receivedAt: string;
  readonly processingState: RemoteInboxProcessingState;
  readonly localAcceptance?: RemoteReceiptChainEntry;
  readonly localResult?: RemoteReceiptChainEntry;
}

export interface RemoteInboxAdmission {
  readonly type: "inserted" | "duplicate";
  readonly record: RemoteInboxRecord;
}

export interface RemoteReportClaim {
  readonly reportId: string;
  readonly bindingId: string;
  readonly reportSequence: number;
  readonly reportDigest: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export interface ClaimedRemoteReport {
  readonly claim: RemoteReportClaim;
  readonly canonicalReport: string;
  readonly report: RemoteClassifiedReport;
}

export interface RemoteDeliveryPendingCounts {
  readonly waitingCommands: number;
  readonly readyCommands: number;
  readonly acceptedCommands: number;
  readonly pendingReports: number;
  readonly claimedReports: number;
}

export interface RemoteStreamCheckpoint {
  readonly bindingId: string;
  readonly streamKind: "inbound-command" | "outbound-report" | "outbound-acknowledgement";
  readonly contiguousSequence: number;
  readonly lastDigest: string | null;
  readonly updatedAt: string;
}

export interface RemoteRunEventCheckpoint {
  readonly bindingId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly localLatestCursor: number;
  readonly durablyEnqueuedCursor: number;
  readonly centrallyAcknowledgedCursor: number;
  readonly lastEnqueuedReportSequence: number;
  readonly lastAcknowledgedReportSequence: number;
}

export interface RemoteRunEventAdvance {
  readonly repositoryId: string;
  readonly runId: string;
  readonly fromCursor: number;
  readonly throughCursor: number;
  readonly localLatestCursor: number;
}

export const DEFAULT_REMOTE_SEQUENCE_WINDOW = 64;
export const MAX_REMOTE_SEQUENCE_WINDOW = 1_024;

export interface WorkerAmendmentOutboxClaim {
  readonly submissionId: string;
  readonly sourceDigest: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export interface WorkerAmendmentProposalSource {
  readonly submission: unknown;
  readonly context: unknown;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AuthorityRow {
  readonly revision: number;
  readonly canonical_json: string;
}

interface AssetRow {
  readonly digest: string;
  readonly byte_length: number;
  readonly media_type: string | null;
  readonly relative_path: string;
}

interface PortalRevisionRow {
  readonly workflow_revision: number;
  readonly context_revision: number;
  readonly dataflow_revision: number;
  readonly runner_revision: number;
  readonly task_frontier_revision: number;
  readonly workspace_revision: number;
  readonly human_revision: number;
  readonly portal_revision: number;
  readonly transcript_revision: number;
}

interface PortalQuestionQueryRow {
  readonly submission_id: string;
  readonly canonical_question: string;
  readonly answer_id: string | null;
  readonly answer_digest: string | null;
  readonly canonical_answer: string | null;
  readonly principal_digest: string | null;
  readonly answered_at: string | null;
  readonly requirement_digest: string | null;
  readonly created_at: string | null;
  readonly satisfied_by_dispatch_id: string | null;
  readonly canonical_event: string | null;
}

interface PortalAllowanceQueryRow {
  readonly command_id: string;
  readonly canonical_escalation: string;
  readonly budget_limit: number;
  readonly policy_digest: string;
  readonly canonical_policy: string;
  readonly mode: RunControlMode;
  readonly run_mode_revision: number;
  readonly canonical_authority: string;
}

interface BackupManifest {
  readonly format: "senawa-sqlite-backup";
  readonly version: 1;
  readonly database: {
    readonly relativePath: "authority.db";
    readonly byteLength: number;
    readonly digest: string;
  };
  readonly assets: readonly AssetDescriptor[];
}

interface LeaseRow {
  readonly resource_key: string;
  readonly owner_id: string;
  readonly fence: number;
  readonly expires_at: string;
}

interface RemotePeerRow {
  readonly binding_id: string;
  readonly repository_id: string;
  readonly binding_digest: string;
  readonly canonical_binding: string;
  readonly current_revocation_epoch: number;
  readonly session_id: string | null;
  readonly selected_protocol_version: string | null;
  readonly canonical_capabilities: string | null;
  readonly last_observed_at: string;
}

interface RemoteCheckpointRow {
  readonly binding_id: string;
  readonly stream_kind: RemoteStreamCheckpoint["streamKind"];
  readonly contiguous_sequence: number;
  readonly last_digest: string | null;
  readonly updated_at: string;
}

interface RemoteHistoryCommitmentRow {
  readonly binding_id: string;
  readonly repository_id: string;
  readonly binding_digest: string;
  readonly canonical_binding: string;
  readonly inbound_sequence: number;
  readonly inbound_digest: string | null;
  readonly outbound_report_sequence: number;
  readonly outbound_report_digest: string | null;
  readonly acknowledged_report_sequence: number;
  readonly acknowledged_report_digest: string | null;
  readonly acknowledged_cursor: number;
  readonly canonical_run_event_commitments: string;
  readonly run_event_commitments_digest: string;
}

interface RemoteSynchronizationRow {
  readonly binding_id: string;
  readonly repository_id: string;
  readonly local_latest_cursor: number;
  readonly durably_enqueued_cursor: number;
  readonly centrally_acknowledged_cursor: number;
  readonly local_observed_at: string;
  readonly last_enqueued_at: string | null;
  readonly last_acknowledged_at: string | null;
}

interface RemoteRunEventCheckpointRow {
  readonly binding_id: string;
  readonly repository_id: string;
  readonly run_id: string;
  readonly local_latest_cursor: number;
  readonly durably_enqueued_cursor: number;
  readonly centrally_acknowledged_cursor: number;
  readonly last_enqueued_report_sequence: number;
  readonly last_acknowledged_report_sequence: number;
}

interface RemoteReportRunEventAdvanceRow {
  readonly report_id: string;
  readonly binding_id: string;
  readonly repository_id: string;
  readonly run_id: string;
  readonly from_cursor: number;
  readonly through_cursor: number;
  readonly local_latest_cursor: number;
  readonly report_sequence: number;
  readonly canonical_report: string;
  readonly report_binding_id: string;
  readonly report_repository_id: string;
}

interface RemoteReportReplayRow {
  readonly report_id: string;
  readonly binding_id: string;
  readonly report_sequence: number;
  readonly previous_report_digest: string | null;
  readonly report_digest: string;
  readonly event_advance_count: number;
  readonly canonical_report: string;
}

interface RemoteInboxRow {
  readonly binding_id: string;
  readonly sequence: number;
  readonly repository_id: string;
  readonly acceptance_id: string;
  readonly command_id: string;
  readonly revocation_epoch: number;
  readonly previous_envelope_digest: string | null;
  readonly envelope_digest: string;
  readonly canonical_envelope: string;
  readonly delivery_entry_digest: string;
  readonly canonical_delivery_entry: string;
  readonly expires_at: string;
  readonly received_at: string;
  readonly processing_state: RemoteInboxProcessingState;
  readonly local_command_id: string | null;
  readonly local_acceptance_digest: string | null;
  readonly canonical_local_acceptance: string | null;
  readonly local_accepted_at: string | null;
  readonly local_result_digest: string | null;
  readonly canonical_local_result: string | null;
  readonly local_result_at: string | null;
  readonly local_result_report_id: string | null;
}

interface SnapshotCommand {
  readonly commandId: string;
  readonly canonicalEnvelope: string;
  readonly receipt: DurableReceipt;
  readonly admission: unknown;
}

interface SnapshotRun {
  readonly repositoryId: string;
  readonly runId: string;
  readonly cursor: number;
  readonly commands: readonly SnapshotCommand[];
  readonly receiptHistory: readonly DurableReceipt[];
  readonly events: readonly EventStreamFrame[];
  readonly records?: unknown;
  readonly projectionGeneratedAt?: string;
}

interface AuthoritySnapshot {
  readonly version: string;
  readonly runs: readonly SnapshotRun[];
}

interface CanonicalRunFragments {
  readonly repositoryId: string;
  readonly runId: string;
  readonly commands: Map<string, string>;
  readonly receiptHistory: string[];
  readonly events: string[];
  cursor: number;
  records?: string;
  projectionGeneratedAt?: string;
}

interface NormalizedSnapshot {
  readonly repositories: readonly Record<string, unknown>[];
  readonly runs: readonly Record<string, unknown>[];
  readonly commands: readonly Record<string, unknown>[];
  readonly receiptHistory: readonly Record<string, unknown>[];
  readonly eventFrames: readonly Record<string, unknown>[];
}

interface ConfigurationSnapshotValue {
  readonly snapshotDigest: string;
  readonly graph: ReturnType<typeof validateWorkflowGraph>;
  readonly canonical: Record<string, unknown>;
}

interface AmendmentLifecycleValue {
  readonly proposal: AmendmentProposal;
  readonly decision?: AmendmentDecision;
  readonly withdrawal?: AmendmentWithdrawal;
  readonly application?: AmendmentApplication;
}

interface NormalizedAmendmentRows {
  readonly proposals: readonly Record<string, unknown>[];
  readonly decisions: readonly Record<string, unknown>[];
  readonly withdrawals: readonly Record<string, unknown>[];
  readonly applications: readonly Record<string, unknown>[];
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(version: number) {
    super(
      `SQLite authority schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class StaleAuthorityRevisionError extends Error {
  constructor(expectedRevision: number) {
    super(`SQLite authority revision no longer matches expected revision ${expectedRevision}`);
    this.name = "StaleAuthorityRevisionError";
  }
}

export class LeaseUnavailableError extends Error {
  /** When the live owner's lease runs out, so a waiter can try again then. */
  readonly expiresAt: string | undefined;

  constructor(resourceKey: string, expiresAt?: string) {
    super(`Lease ${resourceKey} is held by another live owner`);
    this.name = "LeaseUnavailableError";
    this.expiresAt = expiresAt;
  }
}

export class StaleLeaseFenceError extends Error {
  constructor(resourceKey: string, fence: number) {
    super(`Lease ${resourceKey} no longer accepts fence ${fence}`);
    this.name = "StaleLeaseFenceError";
  }
}

export class RemoteDeliveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteDeliveryConflictError";
  }
}

export class RemoteSequenceWindowError extends Error {
  constructor(sequence: number, checkpoint: number, window: number) {
    super(
      `Remote command sequence ${sequence} exceeds checkpoint ${checkpoint} plus window ${window}`,
    );
    this.name = "RemoteSequenceWindowError";
  }
}

export class StaleRemoteReportClaimError extends Error {
  constructor(reportId: string, fence: number) {
    super(`Remote report ${reportId} no longer accepts claim fence ${fence}`);
    this.name = "StaleRemoteReportClaimError";
  }
}

export class SqliteAuthority
  implements
    CommandServicePort,
    RuntimeQueryPort,
    SerializableAuthorityPort,
    RuntimeDataflowPersistencePort
{
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: SqliteFaultPoint) => void) | undefined;
  readonly #assetQuota: { readonly maxObjects: number; readonly maxTotalBytes: number };
  #cachedAuthority: InMemoryAuthority;
  #cachedCanonicalSnapshot: IncrementalCanonicalSnapshot;
  #cachedService: RuntimeCommandService;
  #cachedRevision: number;

  constructor(options: SqliteAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.assetDirectory = resolve(options.assetDirectory);
    this.dependencies = options.dependencies;
    this.#faultInjector = options.faultInjector;
    this.#assetQuota = Object.freeze({
      maxObjects: options.assetQuota?.maxObjects ?? ASSET_SECURITY_LIMITS.defaultMaxObjects,
      maxTotalBytes:
        options.assetQuota?.maxTotalBytes ?? ASSET_SECURITY_LIMITS.defaultMaxTotalBytes,
    });
    if (
      !Number.isSafeInteger(this.#assetQuota.maxObjects) ||
      this.#assetQuota.maxObjects < 1 ||
      !Number.isSafeInteger(this.#assetQuota.maxTotalBytes) ||
      this.#assetQuota.maxTotalBytes < 1
    ) {
      throw new TypeError("Asset repository quotas must be positive safe integers");
    }
    ensureSafeDirectoryPath(dirname(this.databasePath));
    ensureSafeDirectoryPath(this.assetDirectory);
    fsyncDirectory(this.assetDirectory);
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
      const verified = verifyDatabase(this.#database, this.dependencies, this.assetDirectory, true);
      const state = verified.state;
      this.#cachedAuthority = verified.authority;
      this.#cachedCanonicalSnapshot = IncrementalCanonicalSnapshot.fromCanonicalJson(
        state.canonical_json,
      );
      this.#cachedService = new RuntimeCommandService(this.dependencies, this.#cachedAuthority);
      this.#cachedRevision = state.revision;
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  submit(input: string | unknown, admission: AdmissionFacts): DurableReceipt {
    const command = decodeCommandEnvelope(input);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const before = this.#readAuthorityRow();
      if (before.revision !== this.#cachedRevision) {
        this.#cachedAuthority = InMemoryAuthority.fromCanonicalJson(
          before.canonical_json,
          this.dependencies,
        );
        this.#cachedCanonicalSnapshot = IncrementalCanonicalSnapshot.fromCanonicalJson(
          before.canonical_json,
        );
        this.#cachedService = new RuntimeCommandService(this.dependencies, this.#cachedAuthority);
        this.#cachedRevision = before.revision;
      }
      const trustedFacts: TrustedRuntimeCommandFacts =
        command.intent.type === "apply-approved-amendment"
          ? {
              amendmentQuiescence: buildTrustedAmendmentQuiescence(
                this.#database,
                before.canonical_json,
                command,
                admission.currentTime,
                this.dependencies,
              ),
            }
          : isHumanAuthorityIntent(command.intent.type) &&
              this.dependencies.authorization.authorize(command.principal, command.intent)
            ? {
                humanAuthority: buildTrustedHumanAuthorityDecision(
                  this.#database,
                  this.#cachedService,
                  command,
                  admission.currentTime,
                  this.dependencies,
                ),
              }
            : {};
      const receipt = this.#cachedService.submitWithTrustedFacts(input, admission, trustedFacts);
      let after = before.canonical_json;
      if (!this.#cachedCanonicalSnapshot.hasCommand(receipt.commandId)) {
        const run = this.#cachedAuthority.runs.get(
          runtimeAuthorityRunKey(receipt.repositoryId, receipt.runId),
        );
        if (run === undefined) {
          throw new TypeError("Submitted command run is missing from the authority cache");
        }
        after = this.#cachedCanonicalSnapshot.appendCommand(run, receipt.commandId);
      }
      this.#fault("after-command-execution");
      if (after !== before.canonical_json) {
        const run = this.#cachedAuthority.runs.get(
          runtimeAuthorityRunKey(receipt.repositoryId, receipt.runId),
        );
        if (run === undefined) {
          throw new TypeError("Submitted command run is missing from the authority cache");
        }
        persistCommandDelta(
          this.#database,
          receipt,
          run,
          after,
          before.revision,
          this.dependencies,
        );
        persistAmendmentProjections(this.#database, parseSnapshot(after), this.dependencies);
        if (
          command.intent.type === "record-amendment-decision" &&
          receipt.status === "completed" &&
          isApprovedAmendmentDecision(receipt.result)
        ) {
          installApprovedAmendmentFences(
            this.#database,
            parseSnapshot(after),
            command.repositoryId,
            command.runId,
            receipt.result.amendmentId,
            admission.currentTime,
            this.dependencies,
          );
          this.#fault("after-amendment-fences");
        }
        if (command.intent.type === "apply-approved-amendment" && receipt.status === "completed") {
          linkAppliedPlanImport(this.#database, receipt.result);
          this.#fault("after-amendment-application");
        }
        if (command.intent.type === "instantiate-run" && receipt.status === "completed") {
          initializeRunControl(this.#database, command, admission.currentTime);
        }
        if (
          isHumanAuthorityIntent(command.intent.type) &&
          receipt.status === "completed" &&
          trustedFacts.humanAuthority?.result !== undefined
        ) {
          persistTrustedHumanAuthorityDecision(
            this.#database,
            command,
            admission.currentTime,
            trustedFacts.humanAuthority.result,
            this.dependencies,
          );
        }
        this.#cachedRevision = before.revision + 1;
      }
      this.#fault("before-command-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-command-commit-before-ack");
      return receipt;
    } catch (error) {
      if (!committed) {
        if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
        const current = this.#readAuthorityRow();
        this.#cachedAuthority = InMemoryAuthority.fromCanonicalJson(
          current.canonical_json,
          this.dependencies,
        );
        this.#cachedCanonicalSnapshot = IncrementalCanonicalSnapshot.fromCanonicalJson(
          current.canonical_json,
        );
        this.#cachedService = new RuntimeCommandService(this.dependencies, this.#cachedAuthority);
        this.#cachedRevision = current.revision;
      }
      throw error;
    }
  }

  queryReceipt(commandId: string): DurableReceipt | undefined {
    validateOpaqueIdentity(commandId);
    const row = this.#database
      .prepare<[string], { terminal_receipt_json: string }>(
        "SELECT terminal_receipt_json FROM commands WHERE command_id = ?",
      )
      .get(commandId);
    return row === undefined ? undefined : decodeDurableReceipt(row.terminal_receipt_json);
  }

  queryReceiptHistory(repositoryId: string, runId: string): readonly DurableReceipt[] {
    return this.#readService().queryReceiptHistory(repositoryId, runId);
  }

  queryReceiptPage(
    repositoryId: string,
    runId: string,
    afterCursor = 0,
    limit: number = PROTOCOL_LIMITS.maxPageItems,
  ): ReceiptPage {
    validateBoundedPageRequest(afterCursor, limit);
    const runKey = canonicalStringify([repositoryId, runId]);
    const readPage = this.#database.transaction(() => {
      const latestCursor =
        this.#database
          .prepare<[string], { cursor: number }>("SELECT cursor FROM runs WHERE run_key = ?")
          .get(runKey)?.cursor ?? 0;
      validatePageCursor(afterCursor, latestCursor);
      this.#fault("after-receipt-page-metadata-read");
      const rows = this.#database
        .prepare<[string, number, number], { canonical_receipt: string }>(
          `SELECT canonical_receipt FROM receipt_history
           WHERE run_key = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
        )
        .all(runKey, afterCursor, limit + 1);
      return { latestCursor, rows };
    });
    const { latestCursor, rows } = readPage.deferred();
    return decodeReceiptPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      afterCursor,
      latestCursor,
      hasMore: rows.length > limit,
      receipts: rows.slice(0, limit).map((row) => decodeDurableReceipt(row.canonical_receipt)),
    });
  }

  queryEvents(repositoryId: string, runId: string, afterCursor = 0): readonly EventStreamFrame[] {
    return this.#readService().queryEvents(repositoryId, runId, afterCursor);
  }

  queryEventPage(
    repositoryId: string,
    runId: string,
    afterCursor = 0,
    limit: number = PROTOCOL_LIMITS.maxPageItems,
  ): EventReplayPage {
    validateBoundedPageRequest(afterCursor, limit);
    const runKey = canonicalStringify([repositoryId, runId]);
    const readPage = this.#database.transaction(() => {
      const latestCursor =
        this.#database
          .prepare<[string], { cursor: number }>("SELECT cursor FROM runs WHERE run_key = ?")
          .get(runKey)?.cursor ?? 0;
      const earliestAvailableCursor =
        this.#database
          .prepare<[string], { earliest_cursor: number | null }>(
            "SELECT MIN(cursor) AS earliest_cursor FROM event_frames WHERE run_key = ?",
          )
          .get(runKey)?.earliest_cursor ?? 0;
      validatePageCursor(afterCursor, latestCursor);
      validateReplayCursor(afterCursor, earliestAvailableCursor);
      this.#fault("after-event-page-metadata-read");
      const rows = this.#database
        .prepare<[string, number, number], { canonical_frame: string }>(
          `SELECT canonical_frame FROM event_frames
           WHERE run_key = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
        )
        .all(runKey, afterCursor, limit + 1);
      return { earliestAvailableCursor, latestCursor, rows };
    });
    const { earliestAvailableCursor, latestCursor, rows } = readPage.deferred();
    return decodeEventReplayPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      afterCursor,
      earliestAvailableCursor,
      latestCursor,
      hasMore: rows.length > limit,
      events: rows.slice(0, limit).map((row) => decodeEventStreamFrame(row.canonical_frame)),
    });
  }

  queryProjection(repositoryId: string, runId: string): ProjectionEnvelope | undefined {
    return this.#readService().queryProjection(repositoryId, runId);
  }

  queryRunExecution(repositoryId: string, runId: string): RunExecutionBinding | undefined {
    return this.#readService().queryRunExecution(repositoryId, runId);
  }

  queryIntegrationBarrier(repositoryId: string, runId: string): IntegrationBarrier | undefined {
    return this.#readService().queryIntegrationBarrier(repositoryId, runId);
  }

  queryRunScheduling(repositoryId: string, runId: string) {
    return this.#readService().queryRunScheduling(repositoryId, runId);
  }

  queryRunControl(repositoryId: string, runId: string): RunControlState | undefined {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const row = this.#database
      .prepare<[string], { mode: RunControlMode; revision: number; changed_at: string }>(
        `SELECT mode, revision, changed_at FROM run_control_state
         WHERE run_key = ?`,
      )
      .get(canonicalStringify([repositoryId, runId]));
    return row === undefined
      ? undefined
      : Object.freeze({
          repositoryId,
          runId,
          mode: row.mode,
          revision: row.revision,
          changedAt: row.changed_at,
        });
  }

  /**
   * Records that a run finished its own work, without a person asking.
   *
   * `ended` was only reachable from `ending`, and only a person requests that,
   * so a run that closed every phase stayed `running` for ever: the portal
   * offered Pause and End run on it, `senawa status` called it running, and
   * anything deciding whether a run was worth driving was told it was still
   * going. A run with nothing left to do is over, and that is a fact about the
   * run rather than a decision anyone has to take.
   *
   * Returns whether this call is the one that ended it, so a caller that runs
   * on every cycle records the event exactly once.
   */
  recordRunFinished(repositoryId: string, runId: string, currentTime: string): boolean {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const runKey = canonicalStringify([repositoryId, runId]);
    const state = this.#database
      .prepare<[string], { mode: RunControlMode; revision: number }>(
        "SELECT mode, revision FROM run_control_state WHERE run_key = ?",
      )
      .get(runKey);
    // A paused or ending run is somewhere a person put it, and finishing does
    // not overrule that.
    if (state === undefined || state.mode !== "running") return false;
    const revision = state.revision + 1;
    const event = {
      eventId: `run-finished-${this.dependencies.sha256.digest(canonicalBytes({ runKey, revision }))}`,
      priorMode: "running",
      resultMode: "ended",
      revision,
      occurredAt: currentTime,
    };
    const changed = this.#database
      .prepare(
        `UPDATE run_control_state SET mode = 'ended', revision = ?, changed_at = ?
         WHERE run_key = ? AND mode = 'running' AND revision = ?`,
      )
      .run(revision, currentTime, runKey, state.revision);
    if (changed.changes === 0) return false;
    this.#database
      .prepare(
        `INSERT INTO run_control_events(
           run_key, revision, event_id, command_id, prior_mode, result_mode,
           principal_digest, canonical_event, occurred_at
         ) VALUES (?, ?, ?, NULL, 'running', 'ended', ?, ?, ?)`,
      )
      .run(
        runKey,
        revision,
        event.eventId,
        this.dependencies.sha256.digest(canonicalBytes(event)),
        canonicalStringify(event),
        currentTime,
      );
    return true;
  }

  /**
   * Questions this run asked that a person has answered, oldest first.
   *
   * The requirement stays unsatisfied until a fresh dispatch carries the answer,
   * which is why answering alone does not release the run.
   */
  listAnsweredQuestions(
    repositoryId: string,
    runId: string,
  ): readonly {
    readonly submissionId: string;
    readonly taskId: string;
    readonly definitionGeneration: number;
    readonly question: string;
    readonly answer: string;
  }[] {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    return Object.freeze(
      this.#database
        .prepare<
          [string],
          {
            submission_id: string;
            task_id: string;
            definition_generation: number;
            canonical_question: string;
            canonical_answer: string;
          }
        >(
          `SELECT f.submission_id, f.task_id, f.definition_generation,
                  q.canonical_question, a.canonical_answer
           FROM context_fresh_dispatch_requirements f
           JOIN context_question_answers a ON a.submission_id = f.submission_id
           JOIN context_questions q ON q.submission_id = f.submission_id
           WHERE f.run_key = ? AND f.satisfied_by_dispatch_id IS NULL
           ORDER BY f.created_at, f.submission_id`,
        )
        .all(canonicalStringify([repositoryId, runId]))
        .flatMap((row) => {
          const question = decodeCanonicalJsonValue(row.canonical_question);
          const answer = decodeCanonicalJsonValue(row.canonical_answer);
          const prompt =
            isPlainRecord(question) && isPlainRecord(question.question)
              ? question.question.prompt
              : undefined;
          const text = isPlainRecord(answer) ? answer.answer : answer;
          if (typeof prompt !== "string" || typeof text !== "string") return [];
          return [
            Object.freeze({
              submissionId: row.submission_id,
              taskId: row.task_id,
              definitionGeneration: row.definition_generation,
              question: prompt,
              answer: text,
            }),
          ];
        }),
    );
  }

  /**
   * Records which dispatch carried an answer back to the agent that asked.
   *
   * A question blocks the scheduler until this is written, because an answer
   * nobody delivered leaves the agent exactly as stuck as it was.
   */
  satisfyFreshDispatchRequirement(submissionId: string, dispatchId: string): void {
    validateOpaqueIdentity(submissionId);
    validateOpaqueIdentity(dispatchId);
    const updated = this.#database
      .prepare(
        `UPDATE context_fresh_dispatch_requirements SET satisfied_by_dispatch_id = ?
         WHERE submission_id = ? AND satisfied_by_dispatch_id IS NULL`,
      )
      .run(dispatchId, submissionId);
    if (updated.changes !== 1) {
      throw new Error("No unsatisfied fresh dispatch requirement for that submission");
    }
  }

  listFreshDispatchRequirements(
    repositoryId: string,
    runId: string,
  ): readonly FreshDispatchRequirement[] {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    return Object.freeze(
      this.#database
        .prepare<
          [string],
          {
            submission_id: string;
            historical_dispatch_id: string;
            context_digest: string;
            task_id: string;
            definition_generation: number;
            requirement_digest: string;
            created_at: string;
          }
        >(
          `SELECT submission_id, historical_dispatch_id, context_digest, task_id,
                  definition_generation, requirement_digest, created_at
           FROM context_fresh_dispatch_requirements
           WHERE run_key = ? AND satisfied_by_dispatch_id IS NULL
           ORDER BY task_id, definition_generation, submission_id`,
        )
        .all(canonicalStringify([repositoryId, runId]))
        .map((row) =>
          Object.freeze({
            submissionId: row.submission_id,
            repositoryId,
            runId,
            historicalDispatchId: row.historical_dispatch_id,
            contextDigest: row.context_digest,
            taskId: row.task_id,
            definitionGeneration: row.definition_generation,
            requirementDigest: row.requirement_digest,
            createdAt: row.created_at,
          }),
        ),
    );
  }

  toCanonicalJson(): string {
    const serialized = this.#readAuthorityRow().canonical_json;
    InMemoryAuthority.fromCanonicalJson(serialized, this.dependencies);
    return serialized;
  }

  revision(): number {
    return this.#readAuthorityRow().revision;
  }

  compareAndSwapSnapshot(expectedRevision: number, canonicalJson: string): number {
    const authority = InMemoryAuthority.fromCanonicalJson(canonicalJson, this.dependencies);
    const validated = authority.toCanonicalJson();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      persistSnapshot(
        this.#database,
        parseSnapshot(validated),
        validated,
        expectedRevision,
        this.dependencies,
      );
      persistAmendmentProjections(this.#database, parseSnapshot(validated), this.dependencies);
      this.#database.exec("COMMIT");
      return expectedRevision + 1;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  acquireLease(input: AcquireLeaseInput): LeaseGrant {
    return acquireLeaseTransaction(this.#database, input);
  }

  renewLease(input: RenewLeaseInput): LeaseGrant {
    return renewLeaseTransaction(this.#database, input);
  }

  releaseLease(input: ReleaseLeaseInput): void {
    releaseLeaseTransaction(this.#database, input);
  }

  putConfigurationSnapshot(input: unknown): string {
    const snapshot = validateConfigurationSnapshot(input, this.dependencies);
    const canonicalSnapshot = canonicalStringify(snapshot.canonical);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database
        .prepare<[string], { graph_revision_digest: string; canonical_snapshot: string }>(
          `SELECT graph_revision_digest, canonical_snapshot
           FROM configuration_snapshots WHERE snapshot_digest = ?`,
        )
        .get(snapshot.snapshotDigest);
      if (current === undefined) {
        this.#database
          .prepare(
            `INSERT INTO configuration_snapshots(
               snapshot_digest, graph_revision_digest, canonical_snapshot
             ) VALUES (?, ?, ?)`,
          )
          .run(snapshot.snapshotDigest, snapshot.graph.revisionDigest, canonicalSnapshot);
      } else if (
        current.graph_revision_digest !== snapshot.graph.revisionDigest ||
        current.canonical_snapshot !== canonicalSnapshot
      ) {
        throw new TypeError("Configuration snapshot digest is bound to different content");
      }
      this.#database.exec("COMMIT");
      return snapshot.snapshotDigest;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getConfigurationSnapshot(snapshotDigest: string): unknown | undefined {
    if (!isSha256Digest(snapshotDigest))
      throw new TypeError("Configuration snapshot digest is invalid");
    const row = this.#database
      .prepare<[string], { canonical_snapshot: string }>(
        "SELECT canonical_snapshot FROM configuration_snapshots WHERE snapshot_digest = ?",
      )
      .get(snapshotDigest);
    return row === undefined ? undefined : decodeCanonicalJsonValue(row.canonical_snapshot);
  }

  queryPhaseCandidateHistory(
    repositoryId: string,
    runId: string,
  ): readonly PhaseGenerationReference[] {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const authority = InMemoryAuthority.fromCanonicalJson(
      this.#readAuthorityRow().canonical_json,
      this.dependencies,
    );
    const run = [...authority.runs.values()].find(
      (candidate) => candidate.repositoryId === repositoryId && candidate.runId === runId,
    );
    if (run?.records === undefined) return Object.freeze([]);
    const records = run.records as unknown as {
      readonly phase: PhaseGenerationReference;
      readonly candidate?: unknown;
      readonly phaseLifecycles?: readonly {
        readonly phase: PhaseGenerationReference;
        readonly candidate?: unknown;
      }[];
    };
    const lifecycles = records.phaseLifecycles ?? [records];
    const history = lifecycles
      .filter((lifecycle) => lifecycle.candidate !== undefined)
      .map(({ phase }) => phase)
      .sort((left, right) => {
        const leftKey = `${left.phaseId}@${left.definitionGeneration}`;
        const rightKey = `${right.phaseId}@${right.definitionGeneration}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    return Object.freeze(
      history.filter(
        (reference, index) =>
          index === 0 ||
          reference.phaseId !== history[index - 1]?.phaseId ||
          reference.definitionGeneration !== history[index - 1]?.definitionGeneration,
      ),
    );
  }

  recordCancellationPlaceholder(input: CancellationPlaceholderInput): void {
    validateStorageIdentifier(input.requestId, "requestId");
    validateStorageIdentifier(input.runId, "runId");
    validateStorageIdentifier(input.resourceKey, "resourceKey");
    validateStorageIdentifier(input.ownerId, "ownerId");
    if (!Number.isSafeInteger(input.fence) || input.fence <= 0) {
      throw new TypeError("fence must be a positive safe integer");
    }
    validateTimestamp(input.requestedAt, "requestedAt");
    validateTimestamp(input.currentTime, "currentTime");
    if (Date.parse(input.requestedAt) > Date.parse(input.currentTime)) {
      throw new TypeError("requestedAt must not be later than currentTime");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.#database
        .prepare<[string], LeaseRow>(
          "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
        )
        .get(input.resourceKey);
      if (
        lease === undefined ||
        lease.owner_id !== input.ownerId ||
        lease.fence !== input.fence ||
        Date.parse(lease.expires_at) <= Date.parse(input.currentTime)
      ) {
        throw new StaleLeaseFenceError(input.resourceKey, input.fence);
      }
      const result = this.#database
        .prepare(
          `INSERT INTO cancellation_requests(
             request_id, run_key, resource_key, owner_id, fence, requested_at
           )
           SELECT ?, runs.run_key, ?, ?, ?, ? FROM runs
           WHERE runs.run_id = ? AND runs.records_json IS NOT NULL`,
        )
        .run(
          input.requestId,
          input.resourceKey,
          input.ownerId,
          input.fence,
          input.requestedAt,
          input.runId,
        );
      if (result.changes !== 1) {
        throw new StaleLeaseFenceError(input.resourceKey, input.fence);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  putAsset(bytes: Uint8Array, mediaType?: string): AssetDescriptor {
    if (bytes.byteLength > ASSET_SECURITY_LIMITS.maxObjectBytes) {
      throw new TypeError("Asset exceeds the 256 MiB object ceiling");
    }
    const digest = this.dependencies.sha256.digest(bytes);
    if (!isSha256Digest(digest)) {
      throw new TypeError("SHA-256 implementations must return lowercase hexadecimal digests");
    }
    const relativePath = join("sha256", digest.slice(0, 2), digest);
    const descriptor: AssetDescriptor = {
      digest,
      byteLength: bytes.byteLength,
      relativePath,
      ...(mediaType === undefined ? {} : { mediaType }),
    };
    let staged: string | undefined;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const current = this.#database
        .prepare<[string], AssetRow>(
          "SELECT digest, byte_length, media_type, relative_path FROM assets WHERE digest = ?",
        )
        .get(digest);
      if (current === undefined) {
        const usage = this.#database
          .prepare<[], { object_count: number; total_bytes: number }>(
            "SELECT COUNT(*) AS object_count, COALESCE(SUM(byte_length), 0) AS total_bytes FROM assets",
          )
          .get();
        if (
          usage === undefined ||
          usage.object_count >= this.#assetQuota.maxObjects ||
          usage.total_bytes + bytes.byteLength > this.#assetQuota.maxTotalBytes
        ) {
          throw new TypeError("Asset repository quota is exhausted");
        }
      } else {
        assertSameDescriptor(current, descriptor);
      }

      const destination = resolveAssetPath(this.assetDirectory, relativePath);
      const stagingDirectory = join(this.assetDirectory, ".staging");
      ensureSafeDirectoryPath(stagingDirectory, this.assetDirectory);
      ensureSafeDirectoryPath(dirname(destination), this.assetDirectory);
      staged = join(stagingDirectory, randomUUID());
      const file = openSync(staged, "wx", 0o600);
      try {
        writeFileSync(file, bytes);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      this.#fault("after-asset-stage");
      try {
        linkSync(staged, destination);
        fsyncDirectory(dirname(destination));
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        verifyAssetBytes(destination, descriptor, this.dependencies);
      }
      unlinkSync(staged);
      fsyncDirectory(stagingDirectory);
      staged = undefined;
      verifyAssetBytes(destination, descriptor, this.dependencies);
      this.#fault("after-asset-install");

      if (current === undefined) {
        this.#database
          .prepare(
            "INSERT INTO assets(digest, byte_length, media_type, relative_path) VALUES (?, ?, ?, ?)",
          )
          .run(digest, bytes.byteLength, mediaType ?? null, relativePath);
        this.#database
          .prepare(
            `UPDATE portal_run_revisions
               SET context_revision = context_revision + 1,
                   portal_revision = portal_revision + 1
               WHERE EXISTS (
                 SELECT 1 FROM context_submissions s
                 WHERE s.repository_id = portal_run_revisions.repository_id
                   AND s.run_id = portal_run_revisions.run_id
                   AND s.submission_type = 'asset'
                   AND json_extract(s.canonical_submission, '$.asset.contentDigest') = ?
               )`,
          )
          .run(digest);
      }
      this.#fault("before-asset-descriptor-commit");
      this.#database.exec("COMMIT");
      this.#fault("after-asset-descriptor-commit-before-ack");
      return descriptor;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      if (staged !== undefined) {
        rmSync(staged, { force: true });
        fsyncDirectory(dirname(staged));
      }
    }
  }

  getAsset(digest: string): Uint8Array | undefined {
    const row = this.#database
      .prepare<[string], AssetRow>(
        "SELECT digest, byte_length, media_type, relative_path FROM assets WHERE digest = ?",
      )
      .get(digest);
    if (row === undefined) return undefined;
    const descriptor = toAssetDescriptor(row);
    const path = resolveAssetPath(this.assetDirectory, descriptor.relativePath);
    return Uint8Array.from(verifyAssetBytes(path, descriptor, this.dependencies));
  }

  /**
   * The input this run was started with, so a later process can dispatch on it.
   *
   * `senawa advance` runs in its own process and has no memory of `senawa
   * start`. Without this it invented an input, which made every phase it
   * dispatched read something the run was never given.
   */
  queryWorkflowInput(
    repositoryId: string,
    runId: string,
  ): { readonly bindingDigest: string; readonly contentDigest: string } | undefined {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const row = this.#database
      .prepare<[string, string], { binding_digest: string; content_digest: string }>(
        `SELECT binding_digest, content_digest FROM workflow_input_bindings
         WHERE repository_id = ? AND run_id = ?`,
      )
      .get(repositoryId, runId);
    return row === undefined
      ? undefined
      : Object.freeze({ bindingDigest: row.binding_digest, contentDigest: row.content_digest });
  }

  bindWorkflowInput(value: WorkflowInputBinding): "created" | "replayed" {
    const binding = validateWorkflowInputBinding(value, this.dependencies.sha256);
    const canonical = canonicalStringify(binding);
    const runKey = this.#requiredRunKey(binding.repositoryId, binding.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#database
        .prepare<[string], { canonical_binding: string }>(
          "SELECT canonical_binding FROM workflow_input_bindings WHERE run_key = ?",
        )
        .get(runKey);
      if (prior !== undefined) {
        if (prior.canonical_binding !== canonical) {
          throw new TypeError("Workflow input is already assigned to different content");
        }
        this.#database.exec("COMMIT");
        return "replayed";
      }
      this.#database
        .prepare(
          `INSERT INTO workflow_input_bindings(
             run_key, repository_id, run_id, graph_revision_digest,
             configuration_snapshot_digest, schema_key, schema_resource_digest,
             content_digest, byte_length, validation_receipt_digest, binding_digest,
             canonical_binding
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runKey,
          binding.repositoryId,
          binding.runId,
          binding.graphRevisionDigest,
          binding.configurationSnapshotDigest,
          binding.schemaKey,
          binding.schemaResourceDigest,
          binding.contentDigest,
          binding.byteLength,
          binding.validationReceiptDigest,
          binding.bindingDigest,
          canonical,
        );
      this.#database.exec("COMMIT");
      return "created";
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The lowest ordinal no attempt of this phase has taken.
   *
   * A phase spends ordinals on more than dispatching — a gate or a close takes
   * one without a dispatch — so inferring the next one from dispatches lands on
   * a number the attempts already hold, and the dataflow refuses it.
   */
  nextPhaseAttemptOrdinal(input: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly phaseId: string;
    readonly definitionGeneration: number;
  }): number {
    const runKey = this.#requiredRunKey(input.repositoryId, input.runId);
    const row = this.#database
      .prepare<[string, string, number], { highest: number | null }>(
        `SELECT MAX(attempt_ordinal) AS highest FROM phase_attempts
         WHERE run_key = ? AND phase_id = ? AND definition_generation = ?`,
      )
      .get(runKey, input.phaseId, input.definitionGeneration);
    return (row?.highest ?? 0) + 1;
  }

  appendPhaseAttempt(
    attemptValue: PhaseAttempt,
    inputValue: PhaseInputBinding,
  ): "created" | "replayed" {
    const attempt = validatePhaseAttempt(attemptValue, this.dependencies.sha256);
    const input = validatePhaseInputBinding(inputValue, this.dependencies.sha256);
    if (
      input.bindingDigest !== attempt.inputBindingDigest ||
      input.sourceSetDigest !== attempt.sourceSetDigest ||
      canonicalStringify(input.phase) !== canonicalStringify(attempt.phase)
    ) {
      throw new TypeError("Phase attempt and input binding do not match");
    }
    const canonicalAttempt = canonicalStringify(attempt);
    const canonicalInput = canonicalStringify(input);
    const runKey = this.#requiredRunKey(attempt.repositoryId, attempt.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#database
        .prepare<[string, string, number, number], { canonical_attempt: string }>(
          `SELECT canonical_attempt FROM phase_attempts
           WHERE run_key = ? AND phase_id = ? AND definition_generation = ?
             AND attempt_ordinal = ?`,
        )
        .get(
          runKey,
          attempt.phase.phaseId,
          attempt.phase.definitionGeneration,
          attempt.phase.attempt,
        );
      if (prior !== undefined) {
        const priorInput = this.#database
          .prepare<[string], { canonical_binding: string }>(
            "SELECT canonical_binding FROM phase_input_bindings WHERE attempt_digest = ?",
          )
          .get(attempt.attemptDigest);
        if (
          prior.canonical_attempt !== canonicalAttempt ||
          priorInput?.canonical_binding !== canonicalInput
        ) {
          throw new TypeError("Phase attempt ordinal is already assigned to different content");
        }
        this.#database.exec("COMMIT");
        return "replayed";
      }
      this.#database
        .prepare(
          `INSERT INTO phase_attempts(
             attempt_digest, run_key, phase_id, definition_generation, attempt_ordinal,
             input_binding_digest, source_set_digest, executor_digest,
             graph_revision_digest, configuration_snapshot_digest,
             upstream_closure_set_digest, upstream_output_set_digest, canonical_attempt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.attemptDigest,
          runKey,
          attempt.phase.phaseId,
          attempt.phase.definitionGeneration,
          attempt.phase.attempt,
          attempt.inputBindingDigest,
          attempt.sourceSetDigest,
          attempt.executorDigest,
          attempt.graphRevisionDigest,
          attempt.configurationSnapshotDigest,
          attempt.upstreamClosureSetDigest,
          attempt.upstreamOutputSetDigest,
          canonicalAttempt,
        );
      this.#database
        .prepare(
          `INSERT INTO phase_input_bindings(
             binding_digest, attempt_digest, schema_key, schema_resource_digest,
             content_digest, byte_length, validation_receipt_digest, source_set_digest,
             canonical_binding
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.bindingDigest,
          attempt.attemptDigest,
          input.schemaKey,
          input.schemaResourceDigest,
          input.contentDigest,
          input.byteLength,
          input.validationReceiptDigest,
          input.sourceSetDigest,
          canonicalInput,
        );
      for (const mapping of input.mappings) {
        this.#database
          .prepare(
            `INSERT INTO phase_input_sources(
               binding_digest, mapping_key, source_kind, source_binding_digest,
               selected_value_digest, destination_pointer, canonical_source
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.bindingDigest,
            mapping.mappingKey,
            mapping.source.kind,
            mapping.sourceBindingDigest,
            mapping.selectedValueDigest,
            mapping.destinationPointer,
            canonicalStringify(mapping),
          );
      }
      this.#database.exec("COMMIT");
      return "created";
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  appendPhaseAttemptTransition(value: PhaseAttemptTransition): "created" | "replayed" {
    const transition = validatePhaseAttemptTransition(value, this.dependencies.sha256);
    const canonical = canonicalStringify(transition);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.#database
        .prepare<[string], { attempt_digest: string }>(
          "SELECT attempt_digest FROM phase_attempts WHERE attempt_digest = ?",
        )
        .get(transition.attemptDigest);
      if (attempt === undefined)
        throw new TypeError("Phase transition references an unknown attempt");
      const prior = this.#database
        .prepare<[string], { canonical_transition: string }>(
          "SELECT canonical_transition FROM phase_attempt_transitions WHERE attempt_digest = ?",
        )
        .get(transition.attemptDigest);
      if (prior !== undefined) {
        if (prior.canonical_transition !== canonical) {
          throw new TypeError("Phase attempt already has a different terminal transition");
        }
        this.#database.exec("COMMIT");
        return "replayed";
      }
      this.#database
        .prepare(
          `INSERT INTO phase_attempt_transitions(
             transition_digest, attempt_digest, predecessor_transition_digest,
             trigger_kind, disposition, next_attempt_ordinal, canonical_transition
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          transition.transitionDigest,
          transition.attemptDigest,
          transition.predecessorTransitionDigest ?? null,
          transition.trigger,
          transition.disposition,
          transition.nextAttempt?.attempt ?? null,
          canonical,
        );
      this.#database.exec("COMMIT");
      return "created";
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  putAgentSessionResumeBinding(
    value: AgentSessionResumeBinding,
    sessionLineKey: string,
  ): "created" | "replayed" {
    if (sessionLineKey.length === 0) {
      throw new TypeError("Agent session resume binding requires a session line key");
    }
    const binding = validateAgentSessionResumeBinding(value, this.dependencies.sha256);
    const canonical = canonicalStringify(binding);
    const prior = this.#database
      .prepare<[string], { canonical_binding: string }>(
        "SELECT canonical_binding FROM agent_session_resume_bindings WHERE binding_digest = ?",
      )
      .get(binding.bindingDigest);
    if (prior !== undefined) {
      if (prior.canonical_binding !== canonical) {
        throw new TypeError("Agent session resume binding digest has different content");
      }
      return "replayed";
    }
    this.#database
      .prepare(
        `INSERT INTO agent_session_resume_bindings(
           binding_digest, predecessor_dispatch_id, predecessor_session_id,
           task_id, task_generation, context_id, context_digest, graph_revision_digest,
           configuration_snapshot_digest, prompt_resource_digest, prompt_content_digest,
           prompt_pack_digest, mapped_input_digest, model_selection_digest,
           repository_commit_digest, repository_tree_digest, canonical_binding,
           session_line_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.bindingDigest,
        binding.predecessorDispatchId,
        binding.predecessorSessionId,
        binding.taskId,
        binding.taskGeneration,
        binding.contextId,
        binding.contextDigest,
        binding.graphRevisionDigest,
        binding.configurationSnapshotDigest,
        binding.promptResourceDigest,
        binding.promptContentDigest,
        binding.promptPackDigest,
        binding.mappedInputDigest,
        binding.modelSelectionDigest,
        binding.repositoryCommitDigest,
        binding.repositoryTreeDigest,
        canonical,
        sessionLineKey,
      );
    return "created";
  }

  /** The most recently recorded binding on one conversation line, if any. */
  queryLatestAgentSessionResumeBinding(
    sessionLineKey: string,
  ): AgentSessionResumeBinding | undefined {
    const row = this.#database
      .prepare<[string], { canonical_binding: string }>(
        `SELECT canonical_binding FROM agent_session_resume_bindings
         WHERE session_line_key = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(sessionLineKey);
    return row === undefined
      ? undefined
      : validateAgentSessionResumeBinding(
          decodeCanonicalJsonValue(row.canonical_binding),
          this.dependencies.sha256,
        );
  }

  /** How many dispatches have already spoken on one conversation line. */
  /**
   * The steerings recorded against a dispatch, oldest first.
   *
   * A person may redirect an agent more than once, and later words do not cancel
   * earlier ones, so all of them are returned in the order they were given.
   */
  /** The overrides recorded in a run, oldest first. */
  listMemberOverrides(runKey: { readonly repositoryId: string; readonly runId: string }): readonly {
    readonly dispatchId: string;
    readonly taskId: string;
    readonly reason: string;
    readonly overriddenAt: string;
  }[] {
    return this.#database
      .prepare<
        [string],
        {
          dispatch_id: string;
          task_id: string;
          reason: string;
          overridden_at: string;
        }
      >(
        `SELECT dispatch_id, task_id, reason, overridden_at
         FROM context_member_overrides WHERE run_key = ? ORDER BY rowid`,
      )
      .all(canonicalStringify([runKey.repositoryId, runKey.runId]))
      .map((row) =>
        Object.freeze({
          dispatchId: row.dispatch_id,
          taskId: row.task_id,
          reason: row.reason,
          overriddenAt: row.overridden_at,
        }),
      );
  }

  listAgentSteerings(dispatchId: string): readonly {
    readonly steeringId: string;
    readonly delivery: "live" | "queued" | "abort-retry";
    readonly instruction: string;
    readonly steeredAt: string;
  }[] {
    return this.#database
      .prepare<
        [string],
        {
          steering_id: string;
          delivery: "live" | "queued" | "abort-retry";
          instruction: string;
          steered_at: string;
        }
      >(
        `SELECT steering_id, delivery, instruction, steered_at
         FROM context_agent_steerings WHERE dispatch_id = ? ORDER BY rowid`,
      )
      .all(dispatchId)
      .map((row) =>
        Object.freeze({
          steeringId: row.steering_id,
          delivery: row.delivery,
          instruction: row.instruction,
          steeredAt: row.steered_at,
        }),
      );
  }

  countAgentSessionResumeBindings(sessionLineKey: string, sessionId?: string): number {
    // Counting the line would keep growing past a renewal, so a conversation is
    // counted by the session it belongs to. The turn is a position within one
    // conversation, not a tally of everything the line has ever said.
    const row =
      sessionId === undefined
        ? this.#database
            .prepare<[string], { total: number }>(
              "SELECT COUNT(*) AS total FROM agent_session_resume_bindings WHERE session_line_key = ?",
            )
            .get(sessionLineKey)
        : this.#database
            .prepare<[string, string], { total: number }>(
              "SELECT COUNT(*) AS total FROM agent_session_resume_bindings" +
                " WHERE session_line_key = ? AND predecessor_session_id = ?",
            )
            .get(sessionLineKey, sessionId);
    return row?.total ?? 0;
  }

  appliedEvaluation(key: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly attemptDigest: string;
    readonly forEachKey: string;
  }): FanOutEvaluation | undefined {
    const runKey = this.#requiredRunKey(key.repositoryId, key.runId);
    const row = this.#database
      .prepare<[string, string, string], { canonical_evaluation: string }>(
        `SELECT canonical_evaluation FROM fan_out_evaluations
         WHERE run_key = ? AND attempt_digest = ? AND for_each_key = ? AND applied = 1
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runKey, key.attemptDigest, key.forEachKey);
    return row === undefined
      ? undefined
      : validateFanOutEvaluation(
          decodeCanonicalJsonValue(row.canonical_evaluation),
          this.dependencies.sha256,
        );
  }

  recordEvaluation(
    key: {
      readonly repositoryId: string;
      readonly runId: string;
      readonly attemptDigest: string;
      readonly forEachKey: string;
    },
    value: FanOutEvaluation,
    expectedPriorEvaluationDigest: string | undefined,
  ): "created" | "replayed" | "conflict" {
    const evaluation = validateFanOutEvaluation(value, this.dependencies.sha256);
    if (
      evaluation.repositoryId !== key.repositoryId ||
      evaluation.runId !== key.runId ||
      evaluation.attemptDigest !== key.attemptDigest ||
      evaluation.forEachKey !== key.forEachKey
    )
      throw new TypeError("Fan-out evaluation does not match its CAS key");
    const canonical = canonicalStringify(evaluation);
    const runKey = this.#requiredRunKey(key.repositoryId, key.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare<[string], { canonical_evaluation: string }>(
          "SELECT canonical_evaluation FROM fan_out_evaluations WHERE evaluation_digest = ?",
        )
        .get(evaluation.evaluationDigest);
      if (existing !== undefined) {
        if (existing.canonical_evaluation !== canonical) {
          throw new TypeError("Fan-out evaluation digest has different content");
        }
        this.#database.exec("COMMIT");
        return "replayed";
      }
      const applied = this.#database
        .prepare<[string, string, string], { evaluation_digest: string }>(
          `SELECT evaluation_digest FROM fan_out_evaluations
           WHERE run_key = ? AND attempt_digest = ? AND for_each_key = ? AND applied = 1
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(runKey, key.attemptDigest, key.forEachKey)?.evaluation_digest;
      if (applied !== expectedPriorEvaluationDigest) {
        this.#database.exec("COMMIT");
        return "conflict";
      }
      const pending = this.#database
        .prepare<[string, string, string], { evaluation_digest: string }>(
          `SELECT evaluation_digest FROM fan_out_evaluations
           WHERE run_key = ? AND attempt_digest = ? AND for_each_key = ? AND applied = 0
           LIMIT 1`,
        )
        .get(runKey, key.attemptDigest, key.forEachKey);
      if (pending !== undefined) {
        this.#database.exec("COMMIT");
        return "conflict";
      }
      this.#database
        .prepare(
          `INSERT INTO fan_out_evaluations(
             evaluation_digest, run_key, attempt_digest, for_each_key,
             prior_evaluation_digest, definition_digest, source_binding_digest,
             collection_digest, task_set_digest, graph_revision_digest,
             configuration_snapshot_digest, canonical_evaluation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evaluation.evaluationDigest,
          runKey,
          evaluation.attemptDigest,
          evaluation.forEachKey,
          expectedPriorEvaluationDigest ?? null,
          evaluation.definitionDigest,
          evaluation.sourceBindingDigest,
          evaluation.collectionDigest,
          evaluation.taskSetDigest,
          evaluation.graphRevisionDigest,
          evaluation.configurationSnapshotDigest,
          canonical,
        );
      for (const member of evaluation.members) {
        this.#database
          .prepare(
            `INSERT INTO fan_out_members(
               evaluation_digest, stable_identity, item_digest, task_key, task_id,
               task_generation, input_digest, member_digest, canonical_member
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evaluation.evaluationDigest,
            member.identity,
            member.itemDigest,
            member.taskKey,
            member.taskId,
            member.generation,
            member.inputDigest,
            member.memberDigest,
            canonicalStringify(member),
          );
      }
      this.#database.exec("COMMIT");
      return "created";
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueProposal(
    _key: {
      readonly repositoryId: string;
      readonly runId: string;
      readonly attemptDigest: string;
      readonly forEachKey: string;
    },
    proposal: AmendmentProposal,
  ): "created" | "replayed" {
    const source = proposal.source as Readonly<Record<string, unknown>>;
    const evaluationDigest = String(source.evaluationDigest ?? "");
    const acceptanceDigest = String(source.acceptanceDigest ?? "");
    const canonicalImport = canonicalStringify({
      evaluationDigest,
      acceptanceDigest,
      proposalDigest: proposal.proposalDigest,
      amendmentId: proposal.amendmentId,
      state: "proposed",
    });
    const prior = this.#database
      .prepare<[string], { canonical_import: string }>(
        "SELECT canonical_import FROM plan_imports WHERE evaluation_digest = ?",
      )
      .get(evaluationDigest);
    if (prior !== undefined) {
      if (prior.canonical_import !== canonicalImport) {
        throw new TypeError("Plan import evaluation is already linked to another proposal");
      }
      return "replayed";
    }
    this.#database
      .prepare(
        `INSERT INTO plan_imports(
           evaluation_digest, acceptance_digest, proposal_digest, amendment_id,
           state, canonical_import
         ) VALUES (?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(
        evaluationDigest,
        acceptanceDigest,
        proposal.proposalDigest,
        proposal.amendmentId,
        canonicalImport,
      );
    return "created";
  }

  markFanOutEvaluationApplied(
    evaluationDigest: string,
    decisionDigest: string,
    applicationDigest: string,
  ): void {
    if (![evaluationDigest, decisionDigest, applicationDigest].every(isSha256Digest)) {
      throw new TypeError("Applied fan-out linkage requires SHA-256 digests");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      markPlanImportApplied(this.#database, evaluationDigest, decisionDigest, applicationDigest);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  publishPhaseOutput(value: PhaseOutputPublication): "created" | "replayed" {
    const publication = validatePhaseOutputPublication(value, this.dependencies.sha256);
    const canonical = canonicalStringify(publication);
    const runKey = this.#requiredRunKey(publication.repositoryId, publication.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.#database
        .prepare<[string, string, number, number], { attempt_digest: string }>(
          `SELECT attempt_digest FROM phase_attempts
           WHERE run_key = ? AND phase_id = ? AND definition_generation = ?
             AND attempt_ordinal = ?`,
        )
        .get(
          runKey,
          publication.phase.phaseId,
          publication.phase.definitionGeneration,
          publication.phase.attempt,
        );
      if (attempt === undefined) throw new TypeError("Phase output references an unknown attempt");
      const prior = this.#database
        .prepare<[string, string], { canonical_publication: string }>(
          `SELECT canonical_publication FROM phase_output_publications
           WHERE attempt_digest = ? AND output_name = ?`,
        )
        .get(attempt.attempt_digest, publication.outputName);
      if (prior !== undefined) {
        if (prior.canonical_publication !== canonical) {
          throw new TypeError("Phase output slot is already assigned to different content");
        }
        this.#database.exec("COMMIT");
        return "replayed";
      }
      this.#database
        .prepare(
          `INSERT INTO phase_output_publications(
             publication_id, publication_digest, run_key, attempt_digest, output_name,
             schema_key, schema_resource_digest, content_digest, byte_length,
             producing_task_id, producing_task_generation, dispatch_id, context_id,
             context_digest, graph_revision_digest, configuration_snapshot_digest,
             input_binding_digest, validation_receipt_digest, canonical_publication
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          publication.publicationId,
          publication.publicationDigest,
          runKey,
          attempt.attempt_digest,
          publication.outputName,
          publication.schemaKey,
          publication.schemaResourceDigest,
          publication.contentDigest,
          publication.byteLength,
          publication.producingTask.taskId,
          publication.producingTask.definitionGeneration,
          publication.dispatchId,
          publication.contextId,
          publication.contextDigest,
          publication.graphRevisionDigest,
          publication.configurationSnapshotDigest,
          publication.inputBindingDigest,
          publication.validationReceiptDigest,
          canonical,
        );
      this.#database.exec("COMMIT");
      return "created";
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  acceptPhaseOutputs(values: readonly PhaseOutputAcceptance[]): "created" | "replayed" {
    this.#database.exec("BEGIN IMMEDIATE");
    let created = false;
    try {
      for (const value of values) {
        const publicationRow = this.#database
          .prepare<[string], { canonical_publication: string }>(
            `SELECT canonical_publication FROM phase_output_publications
             WHERE publication_id = ?`,
          )
          .get(value.publicationId);
        if (publicationRow === undefined) {
          throw new TypeError("Phase output acceptance references an unknown publication");
        }
        const publication = validatePhaseOutputPublication(
          decodeCanonicalJsonValue(publicationRow.canonical_publication),
          this.dependencies.sha256,
        );
        const acceptance = validatePhaseOutputAcceptance(
          value,
          publication,
          this.dependencies.sha256,
        );
        const canonical = canonicalStringify(acceptance);
        const prior = this.#database
          .prepare<[string], { canonical_acceptance: string }>(
            `SELECT canonical_acceptance FROM phase_output_acceptances
             WHERE publication_id = ?`,
          )
          .get(acceptance.publicationId);
        if (prior !== undefined) {
          if (prior.canonical_acceptance !== canonical) {
            throw new TypeError(
              "Phase output publication is already accepted by a different closure",
            );
          }
          continue;
        }
        this.#database
          .prepare(
            `INSERT INTO phase_output_acceptances(
               acceptance_digest, publication_id, publication_digest,
               candidate_digest, closure_digest, canonical_acceptance
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            acceptance.acceptanceDigest,
            acceptance.publicationId,
            acceptance.publicationDigest,
            acceptance.candidateDigest,
            acceptance.closureDigest,
            canonical,
          );
        created = true;
      }
      this.#database.exec("COMMIT");
      return created ? "created" : "replayed";
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #requiredRunKey(repositoryId: string, runIdValue: string): string {
    const row = this.#database
      .prepare<[string, string], { run_key: string }>(
        "SELECT run_key FROM runs WHERE repository_id = ? AND run_id = ?",
      )
      .get(repositoryId, runIdValue);
    if (row === undefined) throw new TypeError("Dataflow record references an unknown run");
    return row.run_key;
  }

  async backup(destinationPath: string): Promise<void> {
    const destination = resolve(destinationPath);
    assertSafeBackupDestination(destination, this.databasePath, this.assetDirectory);
    const partial = `${destination}.partial-${randomUUID()}`;
    mkdirDurably(partial);
    const databasePath = join(partial, "authority.db");
    const assetDirectory = join(partial, "assets");
    ensureSafeDirectoryPath(assetDirectory, partial);
    this.#database.pragma("wal_checkpoint(PASSIVE)");
    try {
      await this.#database.backup(databasePath);
      fsyncFile(databasePath);
      const verification = openReadConnection(databasePath);
      let assets: readonly AssetDescriptor[];
      try {
        verifyDatabase(verification, this.dependencies, this.assetDirectory, true);
        assets = readAssetDescriptors(verification);
      } finally {
        verification.close();
      }
      copyAssetSet(assets, this.assetDirectory, assetDirectory, this.dependencies);
      const databaseBytes = readRegularFile(databasePath);
      const manifest: BackupManifest = {
        format: "senawa-sqlite-backup",
        version: 1,
        database: {
          relativePath: "authority.db",
          byteLength: databaseBytes.byteLength,
          digest: this.dependencies.sha256.digest(databaseBytes),
        },
        assets,
      };
      writeExclusiveFile(join(partial, "manifest.json"), canonicalStringify(manifest));
      verifyBackupBundle(partial, this.dependencies);
      fsyncDirectory(assetDirectory);
      fsyncDirectory(partial);
      publishBackupBundleNoReplace(partial, destination);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  #readAuthorityRow(): AuthorityRow {
    const row = this.#database
      .prepare<[], AuthorityRow>(
        "SELECT revision, canonical_json FROM authority_state WHERE singleton = 1",
      )
      .get();
    if (row === undefined) throw new Error("SQLite authority singleton is missing");
    return row;
  }

  #readService(): RuntimeCommandService {
    const authority = InMemoryAuthority.fromCanonicalJson(
      this.#readAuthorityRow().canonical_json,
      this.dependencies,
    );
    return new RuntimeCommandService(this.dependencies, authority);
  }

  #fault(point: SqliteFaultPoint): void {
    this.#faultInjector?.(point);
  }
}

export class SqliteCanonicalJsonAssetStore implements CanonicalJsonAssetPort {
  readonly authority: SqliteAuthority;

  constructor(authority: SqliteAuthority) {
    this.authority = authority;
  }

  install(value: import("@senawa/kernel").CanonicalValue): CanonicalJsonAssetDescriptor {
    const canonical = canonicalValue(value);
    const descriptor = this.authority.putAsset(canonicalBytes(canonical), "application/json");
    return Object.freeze({
      contentDigest: descriptor.digest as import("@senawa/kernel").Sha256Digest,
      byteLength: descriptor.byteLength,
    });
  }

  load(contentDigest: import("@senawa/kernel").Sha256Digest) {
    const bytes = this.authority.getAsset(contentDigest);
    return bytes === undefined
      ? undefined
      : canonicalValue(decodeCanonicalJsonValue(new TextDecoder().decode(bytes)));
  }
}

export class SqliteRemoteAuthority {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: SqliteRemoteAuthorityFaultPoint) => void) | undefined;

  constructor(options: SqliteRemoteAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = options.dependencies;
    this.#faultInjector = options.faultInjector;
    ensureSafeDirectoryPath(dirname(this.databasePath));
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
      verifyRemoteDeliveryTables(this.#database, this.dependencies);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  registerPeer(
    input: string | RemoteRepositoryBinding,
    observedAt: string,
    sessionId?: string,
  ): RemoteRepositoryBinding {
    const binding = decodeRemoteRepositoryBinding(input);
    const canonicalBinding = canonicalStringify(binding);
    const bindingDigest = digestCanonicalText(canonicalBinding, this.dependencies);
    validateTimestamp(observedAt, "observedAt");
    if (sessionId !== undefined) validateStorageIdentifier(sessionId, "sessionId");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database
        .prepare<
          [string],
          {
            repository_id: string;
            binding_digest: string;
            canonical_binding: string;
            last_observed_at: string;
          }
        >(
          `SELECT repository_id, binding_digest, canonical_binding, last_observed_at
           FROM remote_peer_state WHERE binding_id = ?`,
        )
        .get(binding.bindingId);
      if (current === undefined) {
        this.#database
          .prepare(
            `INSERT INTO remote_peer_state(
               binding_id, repository_id, binding_digest, canonical_binding,
               current_revocation_epoch, session_id, selected_protocol_version,
               canonical_capabilities, last_observed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            binding.bindingId,
            binding.repositoryId,
            bindingDigest,
            canonicalBinding,
            binding.revocationEpoch,
            sessionId ?? null,
            sessionId === undefined ? null : REMOTE_PROTOCOL_VERSION,
            sessionId === undefined ? null : canonicalStringify(REMOTE_CAPABILITIES),
            observedAt,
          );
        for (const streamKind of [
          "inbound-command",
          "outbound-report",
          "outbound-acknowledgement",
        ] as const) {
          this.#database
            .prepare(
              `INSERT INTO remote_stream_checkpoints(
                 binding_id, stream_kind, contiguous_sequence, last_digest, updated_at
               ) VALUES (?, ?, 0, NULL, ?)`,
            )
            .run(binding.bindingId, streamKind, observedAt);
        }
        this.#database
          .prepare(
            `INSERT INTO remote_synchronization_vectors(
               binding_id, repository_id, local_latest_cursor, durably_enqueued_cursor,
               centrally_acknowledged_cursor, local_observed_at,
               last_enqueued_at, last_acknowledged_at
             ) VALUES (?, ?, 0, 0, 0, ?, NULL, NULL)`,
          )
          .run(binding.bindingId, binding.repositoryId, observedAt);
        const emptyRunEventCommitments = canonicalStringify([]);
        this.#database
          .prepare(
            `INSERT INTO remote_history_commitments(
               binding_id, repository_id, binding_digest, canonical_binding,
               inbound_sequence, inbound_digest,
               outbound_report_sequence, outbound_report_digest,
               acknowledged_report_sequence, acknowledged_report_digest,
               acknowledged_cursor, canonical_run_event_commitments,
               run_event_commitments_digest
             ) VALUES (?, ?, ?, ?, 0, NULL, 0, NULL, 0, NULL, 0, ?, ?)`,
          )
          .run(
            binding.bindingId,
            binding.repositoryId,
            bindingDigest,
            canonicalBinding,
            emptyRunEventCommitments,
            digestCanonicalText(emptyRunEventCommitments, this.dependencies),
          );
      } else {
        assertRemoteHistoryCommitmentCurrent(this.#database, binding.bindingId, this.dependencies);
        if (
          current.repository_id !== binding.repositoryId ||
          current.binding_digest !== bindingDigest ||
          current.canonical_binding !== canonicalBinding
        ) {
          throw new RemoteDeliveryConflictError(
            `Remote binding ${binding.bindingId} is already bound to different content`,
          );
        }
        if (Date.parse(observedAt) < Date.parse(current.last_observed_at)) {
          throw new TypeError("Remote peer observation time cannot move backwards");
        }
        if (sessionId === undefined) {
          this.#database
            .prepare(`UPDATE remote_peer_state SET last_observed_at = ? WHERE binding_id = ?`)
            .run(observedAt, binding.bindingId);
        } else {
          this.#database
            .prepare(
              `UPDATE remote_peer_state
               SET session_id = ?, selected_protocol_version = ?,
                   canonical_capabilities = ?, last_observed_at = ?
               WHERE binding_id = ?`,
            )
            .run(
              sessionId,
              REMOTE_PROTOCOL_VERSION,
              canonicalStringify(REMOTE_CAPABILITIES),
              observedAt,
              binding.bindingId,
            );
        }
      }
      this.#database.exec("COMMIT");
      return binding;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordNegotiatedSession(
    bindingId: string,
    sessionId: string,
    selectedVersion: string,
    capabilities: readonly string[],
    observedAt: string,
  ): void {
    validateStorageIdentifier(bindingId, "bindingId");
    validateStorageIdentifier(sessionId, "sessionId");
    validateTimestamp(observedAt, "observedAt");
    const canonicalCapabilities = canonicalStringify([...capabilities]);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const peer = requireRemotePeer(this.#database, bindingId);
      if (Date.parse(observedAt) < Date.parse(peer.last_observed_at)) {
        throw new TypeError("Remote peer observation time cannot move backwards");
      }
      this.#database
        .prepare(
          `UPDATE remote_peer_state
           SET session_id = ?, selected_protocol_version = ?,
               canonical_capabilities = ?, last_observed_at = ?
           WHERE binding_id = ?`,
        )
        .run(sessionId, selectedVersion, canonicalCapabilities, observedAt, bindingId);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  advanceRevocationEpoch(bindingId: string, revocationEpoch: number, observedAt: string): boolean {
    validateStorageIdentifier(bindingId, "bindingId");
    validateNonNegativeSafeInteger(revocationEpoch, "revocationEpoch");
    validateTimestamp(observedAt, "observedAt");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const peer = requireRemotePeer(this.#database, bindingId);
      if (revocationEpoch < peer.current_revocation_epoch) {
        throw new TypeError("Remote revocation epoch cannot move backwards");
      }
      if (Date.parse(observedAt) < Date.parse(peer.last_observed_at)) {
        throw new TypeError("Remote peer observation time cannot move backwards");
      }
      const changed = revocationEpoch > peer.current_revocation_epoch;
      this.#database
        .prepare(
          `UPDATE remote_peer_state
           SET current_revocation_epoch = ?, last_observed_at = ?
           WHERE binding_id = ?`,
        )
        .run(revocationEpoch, observedAt, bindingId);
      if (changed) {
        this.#database
          .prepare(
            `UPDATE remote_command_inbox SET processing_state = 'revoked'
             WHERE binding_id = ? AND revocation_epoch < ?
               AND processing_state IN ('waiting', 'ready')`,
          )
          .run(bindingId, revocationEpoch);
      }
      this.#database.exec("COMMIT");
      return changed;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  admitCommandEnvelope(
    input: string | RemoteCommandEnvelope,
    deliveryEntryInput: string | RemoteReceiptChainEntry,
    receivedAt: string,
    sequenceWindow = DEFAULT_REMOTE_SEQUENCE_WINDOW,
  ): RemoteInboxAdmission {
    const envelope = decodeRemoteCommandEnvelope(input);
    const canonicalEnvelope = canonicalStringify(envelope);
    const envelopeDigest = digestCanonicalText(canonicalEnvelope, this.dependencies);
    const deliveryEntry = decodeRemoteReceiptChainEntry(deliveryEntryInput);
    const canonicalDeliveryEntry = canonicalStringify(deliveryEntry);
    validateTimestamp(receivedAt, "receivedAt");
    validateRemoteSequenceWindow(sequenceWindow);
    assertRemoteCommandDigestBindings(envelope, this.dependencies);
    assertNoForbiddenRemoteCommandData(envelope.acceptedCommand.command.payload);
    const bindingId = envelope.acceptedCommand.binding.bindingId;
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const peer = requireRemotePeer(this.#database, bindingId);
      assertRemoteHistoryCommitmentCurrent(this.#database, bindingId, this.dependencies);
      assertRemoteBindingRow(peer, envelope.acceptedCommand.binding, this.dependencies);
      const checkpoint = requireRemoteCheckpoint(this.#database, bindingId, "inbound-command");
      const existing = readRemoteInboxRow(this.#database, bindingId, envelope.sequence);
      if (existing !== undefined) {
        if (
          existing.envelope_digest !== envelopeDigest ||
          existing.canonical_envelope !== canonicalEnvelope ||
          existing.delivery_entry_digest !== deliveryEntry.entryDigest ||
          existing.canonical_delivery_entry !== canonicalDeliveryEntry
        ) {
          throw new RemoteDeliveryConflictError(
            `Remote command sequence ${envelope.sequence} conflicts with durable content`,
          );
        }
        this.#database.exec("COMMIT");
        committed = true;
        return { type: "duplicate", record: toRemoteInboxRecord(existing) };
      }
      if (envelope.sequence <= checkpoint.contiguous_sequence) {
        throw new RemoteDeliveryConflictError(
          `Remote command sequence ${envelope.sequence} is missing below its checkpoint`,
        );
      }
      if (envelope.sequence > checkpoint.contiguous_sequence + sequenceWindow) {
        throw new RemoteSequenceWindowError(
          envelope.sequence,
          checkpoint.contiguous_sequence,
          sequenceWindow,
        );
      }
      assertRemoteInboxIdentityAvailable(this.#database, envelope, envelopeDigest);
      const predecessorDigest =
        envelope.sequence === checkpoint.contiguous_sequence + 1
          ? checkpoint.last_digest
          : readRemoteInboxRow(this.#database, bindingId, envelope.sequence - 1)?.envelope_digest;
      if (
        predecessorDigest !== undefined &&
        envelope.previousEnvelopeDigest !== predecessorDigest
      ) {
        throw new RemoteDeliveryConflictError(
          `Remote command sequence ${envelope.sequence} conflicts with its predecessor digest`,
        );
      }
      const processingState: RemoteInboxProcessingState =
        envelope.acceptedCommand.binding.revocationEpoch < peer.current_revocation_epoch
          ? "revoked"
          : Date.parse(envelope.acceptedCommand.expiresAt) <= Date.parse(receivedAt)
            ? "expired"
            : "waiting";
      this.#database
        .prepare(
          `INSERT INTO remote_command_inbox(
             binding_id, sequence, repository_id, acceptance_id, command_id,
             revocation_epoch, previous_envelope_digest, envelope_digest,
             canonical_envelope, delivery_entry_digest, canonical_delivery_entry,
             expires_at, received_at, processing_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bindingId,
          envelope.sequence,
          envelope.acceptedCommand.binding.repositoryId,
          envelope.acceptedCommand.acceptanceId,
          envelope.acceptedCommand.command.commandId,
          envelope.acceptedCommand.binding.revocationEpoch,
          envelope.previousEnvelopeDigest,
          envelopeDigest,
          canonicalEnvelope,
          deliveryEntry.entryDigest,
          canonicalDeliveryEntry,
          envelope.acceptedCommand.expiresAt,
          receivedAt,
          processingState,
        );
      reconcileRemoteInbox(this.#database, bindingId, receivedAt);
      refreshRemoteHistoryCommitment(this.#database, bindingId, this.dependencies);
      const inserted = readRemoteInboxRow(this.#database, bindingId, envelope.sequence);
      if (inserted === undefined) throw new Error("Remote inbox insert was not retained");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-remote-inbox-commit-before-return");
      return { type: "inserted", record: toRemoteInboxRecord(inserted) };
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listReadyCommands(
    bindingId: string,
    currentTime: string,
    limit = PROTOCOL_LIMITS.maxPageItems,
  ): readonly RemoteInboxRecord[] {
    validateStorageIdentifier(bindingId, "bindingId");
    validateTimestamp(currentTime, "currentTime");
    validateBoundedPageRequest(0, limit);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const peer = requireRemotePeer(this.#database, bindingId);
      this.#database
        .prepare(
          `UPDATE remote_command_inbox SET processing_state = 'expired'
           WHERE binding_id = ? AND expires_at <= ?
             AND processing_state IN ('waiting', 'ready')`,
        )
        .run(bindingId, currentTime);
      this.#database
        .prepare(
          `UPDATE remote_command_inbox SET processing_state = 'revoked'
           WHERE binding_id = ? AND revocation_epoch < ?
             AND processing_state IN ('waiting', 'ready')`,
        )
        .run(bindingId, peer.current_revocation_epoch);
      const rows = this.#database
        .prepare<[string, number], RemoteInboxRow>(
          `SELECT * FROM remote_command_inbox
           WHERE binding_id = ? AND processing_state = 'ready'
           ORDER BY sequence LIMIT ?`,
        )
        .all(bindingId, limit);
      this.#database.exec("COMMIT");
      return Object.freeze(rows.map(toRemoteInboxRecord));
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listPendingLocalResults(
    bindingId: string,
    limit = PROTOCOL_LIMITS.maxPageItems,
  ): readonly RemoteInboxRecord[] {
    validateStorageIdentifier(bindingId, "bindingId");
    validateBoundedPageRequest(0, limit);
    requireRemotePeer(this.#database, bindingId);
    return Object.freeze(
      this.#database
        .prepare<[string, number], RemoteInboxRow>(
          `SELECT * FROM remote_command_inbox
           WHERE binding_id = ? AND processing_state = 'local-accepted'
           ORDER BY sequence LIMIT ?`,
        )
        .all(bindingId, limit)
        .map(toRemoteInboxRecord),
    );
  }

  listCompletedLocalResults(
    bindingId: string,
    limit: number = PROTOCOL_LIMITS.maxPageItems,
  ): readonly RemoteInboxRecord[] {
    validateStorageIdentifier(bindingId, "bindingId");
    validateBoundedPageRequest(0, limit);
    requireRemotePeer(this.#database, bindingId);
    return Object.freeze(
      this.#database
        .prepare<[string, number], RemoteInboxRow>(
          `SELECT * FROM remote_command_inbox
           WHERE binding_id = ? AND processing_state = 'local-result'
           ORDER BY sequence LIMIT ?`,
        )
        .all(bindingId, limit)
        .map(toRemoteInboxRecord),
    );
  }

  recordLocalAcceptance(
    bindingId: string,
    sequence: number,
    entryInput: string | RemoteReceiptChainEntry,
  ): boolean {
    const entry = decodeRemoteReceiptChainEntry(entryInput);
    if (entry.stage !== "local-accepted" || entry.evidence.type !== "local-receipt") {
      throw new TypeError("Remote local acceptance must be a local-accepted receipt entry");
    }
    return this.#recordRemoteLocalEntry(bindingId, sequence, entry, "acceptance");
  }

  recordLocalResult(
    _bindingId: string,
    _sequence: number,
    entryInput: string | RemoteReceiptChainEntry,
  ): boolean {
    const entry = decodeRemoteReceiptChainEntry(entryInput);
    if (entry.stage !== "local-outcome" || entry.evidence.type !== "local-outcome") {
      throw new TypeError("Remote local result must be a local-outcome receipt entry");
    }
    throw new TypeError("Remote local result must be recorded atomically with its report");
  }

  recordLocalResultAndEnqueueReport(
    bindingId: string,
    sequence: number,
    entryInput: string | RemoteReceiptChainEntry,
    reportInput: string | RemoteClassifiedReport,
    eventAdvanceInput?: RemoteRunEventAdvance | readonly RemoteRunEventAdvance[],
  ): boolean {
    const entry = decodeRemoteReceiptChainEntry(entryInput);
    if (entry.stage !== "local-outcome" || entry.evidence.type !== "local-outcome") {
      throw new TypeError("Remote local result must be a local-outcome receipt entry");
    }
    const report = decodeRemoteClassifiedReport(reportInput);
    validateStorageIdentifier(bindingId, "bindingId");
    validatePositiveSafeInteger(sequence, "sequence");
    const canonicalEntry = canonicalStringify(entry);
    const entryDigest = digestCanonicalText(canonicalEntry, this.dependencies);
    const localCommandId = remoteLocalCommandId(entry);
    const canonicalReport = canonicalStringify(report);
    const reportDigest = digestCanonicalText(canonicalReport, this.dependencies);
    const eventAdvances = normalizeRemoteRunEventAdvances(eventAdvanceInput);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = readRemoteInboxRow(this.#database, bindingId, sequence);
      if (row === undefined) throw new TypeError("Remote inbox command does not exist");
      const envelope = decodeRemoteCommandEnvelope(row.canonical_envelope);
      if (
        entry.bindingId !== bindingId ||
        entry.commandId !== envelope.acceptedCommand.command.commandId ||
        localCommandId !== envelope.acceptedCommand.command.commandId
      ) {
        if (row.processing_state === "local-result") {
          throw new RemoteDeliveryConflictError(
            "Remote local result retry does not match its durable inbox command",
          );
        }
        throw new TypeError("Remote local receipt entry does not match its inbox command");
      }
      const peer = requireRemotePeer(this.#database, bindingId);
      assertRemoteHistoryCommitmentCurrent(this.#database, bindingId, this.dependencies);
      if (report.binding.bindingId !== bindingId) {
        throw new RemoteDeliveryConflictError(
          "Remote report does not match the local outcome binding",
        );
      }
      assertRemoteBindingRow(peer, report.binding, this.dependencies);
      if (row.processing_state === "local-result") {
        if (
          row.local_result_digest !== entryDigest ||
          row.canonical_local_result !== canonicalEntry
        ) {
          throw new RemoteDeliveryConflictError(
            "Remote local result retry differs from the durable terminal entry",
          );
        }
        if (row.local_result_report_id !== report.reportId) {
          throw new RemoteDeliveryConflictError(
            "Remote local result retry does not use its durable report",
          );
        }
        assertRemoteReportReplayExact(
          this.#database,
          report,
          canonicalReport,
          reportDigest,
          eventAdvances,
          this.dependencies,
        );
        this.#database.exec("COMMIT");
        committed = true;
        return false;
      }
      if (row.processing_state !== "local-accepted") {
        throw new TypeError("Remote command has no durable local acceptance");
      }
      if (!remoteReportContainsInboxResult(report, row, canonicalEntry)) {
        throw new RemoteDeliveryConflictError(
          "Remote report does not contain the local outcome command chain",
        );
      }
      const current = requireRemoteSynchronization(this.#database, bindingId);
      const checkpoint = requireRemoteCheckpoint(this.#database, bindingId, "outbound-report");
      if (
        report.reportSequence !== checkpoint.contiguous_sequence + 1 ||
        report.previousReportDigest !== checkpoint.last_digest
      ) {
        throw new RemoteDeliveryConflictError("Remote report does not extend the durable chain");
      }
      assertSynchronizationForEnqueue(report.synchronization, current);
      this.#database
        .prepare(
          `UPDATE remote_command_inbox
           SET processing_state = 'local-result', local_result_digest = ?,
               canonical_local_result = ?, local_result_at = ?, local_result_report_id = ?
           WHERE binding_id = ? AND sequence = ? AND processing_state = 'local-accepted'`,
        )
        .run(entryDigest, canonicalEntry, entry.recordedAt, report.reportId, bindingId, sequence);
      this.#database
        .prepare(
          `INSERT INTO remote_report_outbox(
             report_id, binding_id, repository_id, report_sequence,
             previous_report_digest, report_digest, data_policy_digest,
             source_cursor, event_advance_count, canonical_report, enqueued_at, delivery_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          report.reportId,
          bindingId,
          report.binding.repositoryId,
          report.reportSequence,
          report.previousReportDigest,
          reportDigest,
          report.dataPolicyDigest,
          report.synchronization.durablyEnqueuedCursor,
          eventAdvances.length,
          canonicalReport,
          report.createdAt,
        );
      applyRemoteRunEventAdvances(this.#database, report, eventAdvances);
      updateRemoteCheckpoint(
        this.#database,
        bindingId,
        "outbound-report",
        report.reportSequence,
        reportDigest,
        report.createdAt,
      );
      if (!isZeroRemoteSynchronization(report.synchronization)) {
        this.#database
          .prepare(
            `UPDATE remote_synchronization_vectors
             SET local_latest_cursor = ?, durably_enqueued_cursor = ?,
                 local_observed_at = ?, last_enqueued_at = ?
             WHERE binding_id = ?`,
          )
          .run(
            report.synchronization.localLatestCursor,
            report.synchronization.durablyEnqueuedCursor,
            report.synchronization.localObservedAt,
            report.synchronization.lastEnqueuedAt,
            bindingId,
          );
      }
      refreshRemoteHistoryCommitment(this.#database, bindingId, this.dependencies);
      this.#fault("before-remote-local-result-report-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-remote-local-result-report-commit-before-return");
      return true;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  observeLocalCursor(bindingId: string, localLatestCursor: number, observedAt: string): void {
    validateStorageIdentifier(bindingId, "bindingId");
    validateNonNegativeSafeInteger(localLatestCursor, "localLatestCursor");
    validateTimestamp(observedAt, "observedAt");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      requireRemotePeer(this.#database, bindingId);
      const current = requireRemoteSynchronization(this.#database, bindingId);
      if (localLatestCursor < current.local_latest_cursor) {
        throw new TypeError("Remote local latest cursor cannot move backwards");
      }
      if (Date.parse(observedAt) < Date.parse(current.local_observed_at)) {
        throw new TypeError("Remote local observation time cannot move backwards");
      }
      this.#database
        .prepare(
          `UPDATE remote_synchronization_vectors
           SET local_latest_cursor = ?, local_observed_at = ? WHERE binding_id = ?`,
        )
        .run(localLatestCursor, observedAt, bindingId);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueReport(
    input: string | RemoteClassifiedReport,
    eventAdvanceInput?: RemoteRunEventAdvance | readonly RemoteRunEventAdvance[],
  ): boolean {
    const report = decodeRemoteClassifiedReport(input);
    const canonicalReport = canonicalStringify(report);
    const reportDigest = digestCanonicalText(canonicalReport, this.dependencies);
    const bindingId = report.binding.bindingId;
    const eventAdvances = normalizeRemoteRunEventAdvances(eventAdvanceInput);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const peer = requireRemotePeer(this.#database, bindingId);
      assertRemoteHistoryCommitmentCurrent(this.#database, bindingId, this.dependencies);
      assertRemoteBindingRow(peer, report.binding, this.dependencies);
      const current = requireRemoteSynchronization(this.#database, bindingId);
      const existing = this.#database
        .prepare<[string], { report_id: string }>(
          `SELECT report_id
           FROM remote_report_outbox WHERE report_id = ?`,
        )
        .get(report.reportId);
      if (existing !== undefined) {
        assertRemoteReportReplayExact(
          this.#database,
          report,
          canonicalReport,
          reportDigest,
          eventAdvances,
          this.dependencies,
        );
        this.#database.exec("COMMIT");
        committed = true;
        return false;
      }
      const sequenceConflict = this.#database
        .prepare<[string, number], { report_id: string }>(
          `SELECT report_id FROM remote_report_outbox
           WHERE binding_id = ? AND report_sequence = ?`,
        )
        .get(bindingId, report.reportSequence);
      if (sequenceConflict !== undefined) {
        throw new RemoteDeliveryConflictError(
          `Remote report sequence ${report.reportSequence} is already bound to ${sequenceConflict.report_id}`,
        );
      }
      const checkpoint = requireRemoteCheckpoint(this.#database, bindingId, "outbound-report");
      if (
        report.reportSequence !== checkpoint.contiguous_sequence + 1 ||
        report.previousReportDigest !== checkpoint.last_digest
      ) {
        throw new RemoteDeliveryConflictError("Remote report does not extend the durable chain");
      }
      assertSynchronizationForEnqueue(report.synchronization, current);
      this.#database
        .prepare(
          `INSERT INTO remote_report_outbox(
             report_id, binding_id, repository_id, report_sequence,
             previous_report_digest, report_digest, data_policy_digest,
             source_cursor, event_advance_count, canonical_report, enqueued_at, delivery_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          report.reportId,
          bindingId,
          report.binding.repositoryId,
          report.reportSequence,
          report.previousReportDigest,
          reportDigest,
          report.dataPolicyDigest,
          report.synchronization.durablyEnqueuedCursor,
          eventAdvances.length,
          canonicalReport,
          report.createdAt,
        );
      applyRemoteRunEventAdvances(this.#database, report, eventAdvances);
      updateRemoteCheckpoint(
        this.#database,
        bindingId,
        "outbound-report",
        report.reportSequence,
        reportDigest,
        report.createdAt,
      );
      if (!isZeroRemoteSynchronization(report.synchronization)) {
        this.#database
          .prepare(
            `UPDATE remote_synchronization_vectors
             SET local_latest_cursor = ?, durably_enqueued_cursor = ?,
                 local_observed_at = ?, last_enqueued_at = ?
             WHERE binding_id = ?`,
          )
          .run(
            report.synchronization.localLatestCursor,
            report.synchronization.durablyEnqueuedCursor,
            report.synchronization.localObservedAt,
            report.synchronization.lastEnqueuedAt,
            bindingId,
          );
      }
      refreshRemoteHistoryCommitment(this.#database, bindingId, this.dependencies);
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-remote-report-enqueue-commit-before-return");
      return true;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimReport(
    bindingId: string,
    ownerId: string,
    currentTime: string,
    expiresAt: string,
  ): RemoteReportClaim | undefined {
    validateStorageIdentifier(bindingId, "bindingId");
    validateStorageIdentifier(ownerId, "ownerId");
    validateTimestamp(currentTime, "currentTime");
    validateTimestamp(expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= Date.parse(currentTime)) {
      throw new TypeError("Remote report claim expiry must be later than currentTime");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      requireRemotePeer(this.#database, bindingId);
      const row = this.#database
        .prepare<
          [string],
          {
            report_id: string;
            report_sequence: number;
            report_digest: string;
            claim_owner_id: string | null;
            claim_fence: number | null;
            claim_expires_at: string | null;
          }
        >(
          `SELECT report_id, report_sequence, report_digest,
                  claim_owner_id, claim_fence, claim_expires_at
           FROM remote_report_outbox
           WHERE binding_id = ? AND delivery_state <> 'acknowledged'
           ORDER BY report_sequence LIMIT 1`,
        )
        .get(bindingId);
      if (row === undefined) {
        this.#database.exec("COMMIT");
        committed = true;
        return undefined;
      }
      if (
        row.claim_owner_id === ownerId &&
        row.claim_fence !== null &&
        row.claim_expires_at !== null &&
        Date.parse(row.claim_expires_at) > Date.parse(currentTime)
      ) {
        this.#database.exec("COMMIT");
        committed = true;
        return remoteReportClaim(row, bindingId, ownerId, row.claim_fence, row.claim_expires_at);
      }
      if (
        row.claim_owner_id !== null &&
        row.claim_owner_id !== ownerId &&
        row.claim_expires_at !== null &&
        Date.parse(row.claim_expires_at) > Date.parse(currentTime)
      ) {
        this.#database.exec("COMMIT");
        committed = true;
        return undefined;
      }
      const fence = (row.claim_fence ?? 0) + 1;
      const changed = this.#database
        .prepare(
          `UPDATE remote_report_outbox
           SET delivery_state = 'claimed', claim_owner_id = ?,
               claim_fence = ?, claim_expires_at = ?
           WHERE report_id = ? AND delivery_state <> 'acknowledged'
             AND (delivery_state = 'pending' OR claim_owner_id = ? OR claim_expires_at <= ?)`,
        )
        .run(ownerId, fence, expiresAt, row.report_id, ownerId, currentTime);
      if (changed.changes !== 1) throw new Error("Remote report claim lost a race");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-remote-report-claim-commit-before-return");
      return remoteReportClaim(row, bindingId, ownerId, fence, expiresAt);
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  readClaimedReport(claim: RemoteReportClaim, currentTime: string): ClaimedRemoteReport {
    validateTimestamp(currentTime, "currentTime");
    const row = this.#database
      .prepare<
        [string, string, number],
        {
          binding_id: string;
          report_sequence: number;
          report_digest: string;
          canonical_report: string;
          claim_expires_at: string | null;
          delivery_state: string;
        }
      >(
        `SELECT binding_id, report_sequence, report_digest, canonical_report,
                claim_expires_at, delivery_state
         FROM remote_report_outbox
         WHERE report_id = ? AND claim_owner_id = ? AND claim_fence = ?`,
      )
      .get(claim.reportId, claim.ownerId, claim.fence);
    if (
      row === undefined ||
      row.binding_id !== claim.bindingId ||
      row.report_sequence !== claim.reportSequence ||
      row.report_digest !== claim.reportDigest ||
      row.delivery_state !== "claimed" ||
      row.claim_expires_at !== claim.expiresAt ||
      Date.parse(row.claim_expires_at) <= Date.parse(currentTime)
    ) {
      throw new StaleRemoteReportClaimError(claim.reportId, claim.fence);
    }
    return Object.freeze({
      claim,
      canonicalReport: row.canonical_report,
      report: decodeRemoteClassifiedReport(row.canonical_report),
    });
  }

  acknowledgeReport(
    claim: RemoteReportClaim,
    input: string | RemoteReportAcknowledgement,
    currentTime: string,
  ): boolean {
    const acknowledgement = decodeRemoteReportAcknowledgement(input);
    const canonicalAcknowledgement = canonicalStringify(acknowledgement);
    const acknowledgementDigest = digestCanonicalText(canonicalAcknowledgement, this.dependencies);
    validateTimestamp(currentTime, "currentTime");
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const peer = requireRemotePeer(this.#database, claim.bindingId);
      assertRemoteHistoryCommitmentCurrent(this.#database, claim.bindingId, this.dependencies);
      const binding = decodeRemoteRepositoryBinding(peer.canonical_binding);
      const synchronization = requireRemoteSynchronization(this.#database, claim.bindingId);
      if (Date.parse(currentTime) < Date.parse(synchronization.local_observed_at)) {
        throw new TypeError("Remote acknowledgement observation time cannot move backwards");
      }
      const row = this.#database
        .prepare<
          [string],
          {
            binding_id: string;
            repository_id: string;
            report_sequence: number;
            report_digest: string;
            delivery_state: string;
            claim_owner_id: string | null;
            claim_fence: number | null;
            claim_expires_at: string | null;
            acknowledgement_digest: string | null;
            canonical_acknowledgement: string | null;
          }
        >(
          `SELECT binding_id, repository_id, report_sequence, report_digest,
                  delivery_state, claim_owner_id, claim_fence, claim_expires_at,
                  acknowledgement_digest, canonical_acknowledgement
           FROM remote_report_outbox WHERE report_id = ?`,
        )
        .get(claim.reportId);
      if (row === undefined) throw new StaleRemoteReportClaimError(claim.reportId, claim.fence);
      assertRemoteAcknowledgement(row, claim, acknowledgement, binding.controlPlaneKeyId);
      if (row.delivery_state === "acknowledged") {
        if (row.claim_fence !== claim.fence) {
          throw new StaleRemoteReportClaimError(claim.reportId, claim.fence);
        }
        if (
          row.acknowledgement_digest !== acknowledgementDigest ||
          row.canonical_acknowledgement !== canonicalAcknowledgement
        ) {
          throw new RemoteDeliveryConflictError(
            `Remote report ${claim.reportId} acknowledgement conflicts with durable content`,
          );
        }
        this.#database.exec("COMMIT");
        committed = true;
        return false;
      }
      if (
        row.delivery_state !== "claimed" ||
        row.claim_owner_id !== claim.ownerId ||
        row.claim_fence !== claim.fence ||
        row.claim_expires_at !== claim.expiresAt ||
        Date.parse(row.claim_expires_at) <= Date.parse(currentTime)
      ) {
        throw new StaleRemoteReportClaimError(claim.reportId, claim.fence);
      }
      const changed = this.#database
        .prepare(
          `UPDATE remote_report_outbox
           SET delivery_state = 'acknowledged', claim_owner_id = NULL,
               claim_expires_at = NULL, acknowledgement_digest = ?,
               canonical_acknowledgement = ?, central_receipt_id = ?, acknowledged_at = ?
           WHERE report_id = ? AND delivery_state = 'claimed'
             AND claim_owner_id = ? AND claim_fence = ? AND claim_expires_at = ?
             AND claim_expires_at > ?`,
        )
        .run(
          acknowledgementDigest,
          canonicalAcknowledgement,
          acknowledgement.centralReceiptId,
          acknowledgement.acknowledgedAt,
          claim.reportId,
          claim.ownerId,
          claim.fence,
          claim.expiresAt,
          currentTime,
        );
      if (changed.changes !== 1) {
        throw new StaleRemoteReportClaimError(claim.reportId, claim.fence);
      }
      reconcileRemoteAcknowledgements(this.#database, claim.bindingId, currentTime);
      refreshRemoteHistoryCommitment(this.#database, claim.bindingId, this.dependencies);
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-remote-report-ack-commit-before-return");
      return true;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  querySynchronization(bindingId: string): RemoteSynchronizationVector {
    validateStorageIdentifier(bindingId, "bindingId");
    const row = requireRemoteSynchronization(this.#database, bindingId);
    return decodeRemoteSynchronizationVector({
      repositoryId: row.repository_id,
      localLatestCursor: row.local_latest_cursor,
      durablyEnqueuedCursor: row.durably_enqueued_cursor,
      centrallyAcknowledgedCursor: row.centrally_acknowledged_cursor,
      localObservedAt: row.local_observed_at,
      lastEnqueuedAt: row.last_enqueued_at,
      lastAcknowledgedAt: row.last_acknowledged_at,
    });
  }

  queryRunEventCheckpoint(
    bindingId: string,
    repositoryId: string,
    runId: string,
  ): RemoteRunEventCheckpoint {
    validateStorageIdentifier(bindingId, "bindingId");
    validateStorageIdentifier(repositoryId, "repositoryId");
    validateStorageIdentifier(runId, "runId");
    const peer = requireRemotePeer(this.#database, bindingId);
    if (peer.repository_id !== repositoryId) {
      throw new TypeError("Remote event checkpoint repository does not match its binding");
    }
    const row = readRemoteRunEventCheckpoint(this.#database, bindingId, runId);
    return row === undefined
      ? Object.freeze({
          bindingId,
          repositoryId,
          runId,
          localLatestCursor: 0,
          durablyEnqueuedCursor: 0,
          centrallyAcknowledgedCursor: 0,
          lastEnqueuedReportSequence: 0,
          lastAcknowledgedReportSequence: 0,
        })
      : remoteRunEventCheckpoint(row);
  }

  listRunEventCheckpoints(bindingId: string): readonly RemoteRunEventCheckpoint[] {
    validateStorageIdentifier(bindingId, "bindingId");
    requireRemotePeer(this.#database, bindingId);
    return Object.freeze(
      this.#database
        .prepare<[string], RemoteRunEventCheckpointRow>(
          `SELECT * FROM remote_run_event_checkpoints
           WHERE binding_id = ? ORDER BY last_enqueued_report_sequence, run_id`,
        )
        .all(bindingId)
        .map(remoteRunEventCheckpoint),
    );
  }

  queryCheckpoint(
    bindingId: string,
    streamKind: RemoteStreamCheckpoint["streamKind"],
  ): RemoteStreamCheckpoint {
    validateStorageIdentifier(bindingId, "bindingId");
    const row = requireRemoteCheckpoint(this.#database, bindingId, streamKind);
    return Object.freeze({
      bindingId,
      streamKind,
      contiguousSequence: row.contiguous_sequence,
      lastDigest: row.last_digest,
      updatedAt: row.updated_at,
    });
  }

  queryPendingCounts(bindingId?: string): RemoteDeliveryPendingCounts {
    if (bindingId !== undefined) validateStorageIdentifier(bindingId, "bindingId");
    const filter = bindingId === undefined ? "" : "WHERE binding_id = ?";
    const parameters = bindingId === undefined ? [] : [bindingId];
    const inbox = this.#database
      .prepare<unknown[], { state: RemoteInboxProcessingState; count: number }>(
        `SELECT processing_state AS state, count(*) AS count
         FROM remote_command_inbox ${filter}
         GROUP BY processing_state`,
      )
      .all(...parameters);
    const reports = this.#database
      .prepare<unknown[], { state: string; count: number }>(
        `SELECT delivery_state AS state, count(*) AS count
         FROM remote_report_outbox ${filter}
         GROUP BY delivery_state`,
      )
      .all(...parameters);
    const inboxCounts = new Map(inbox.map((row) => [row.state, row.count]));
    const reportCounts = new Map(reports.map((row) => [row.state, row.count]));
    return Object.freeze({
      waitingCommands: inboxCounts.get("waiting") ?? 0,
      readyCommands: inboxCounts.get("ready") ?? 0,
      acceptedCommands: inboxCounts.get("local-accepted") ?? 0,
      pendingReports: reportCounts.get("pending") ?? 0,
      claimedReports: reportCounts.get("claimed") ?? 0,
    });
  }

  #recordRemoteLocalEntry(
    bindingId: string,
    sequence: number,
    entry: RemoteReceiptChainEntry,
    kind: "acceptance" | "result",
  ): boolean {
    validateStorageIdentifier(bindingId, "bindingId");
    validatePositiveSafeInteger(sequence, "sequence");
    const canonicalEntry = canonicalStringify(entry);
    const entryDigest = digestCanonicalText(canonicalEntry, this.dependencies);
    const localCommandId = remoteLocalCommandId(entry);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = readRemoteInboxRow(this.#database, bindingId, sequence);
      if (row === undefined) throw new TypeError("Remote inbox command does not exist");
      const envelope = decodeRemoteCommandEnvelope(row.canonical_envelope);
      if (
        entry.bindingId !== bindingId ||
        entry.commandId !== envelope.acceptedCommand.command.commandId ||
        localCommandId !== envelope.acceptedCommand.command.commandId
      ) {
        throw new TypeError("Remote local receipt entry does not match its inbox command");
      }
      const existingCanonical =
        kind === "acceptance" ? row.canonical_local_acceptance : row.canonical_local_result;
      const existingDigest =
        kind === "acceptance" ? row.local_acceptance_digest : row.local_result_digest;
      if (existingCanonical !== null || existingDigest !== null) {
        if (existingCanonical !== canonicalEntry || existingDigest !== entryDigest) {
          throw new RemoteDeliveryConflictError(
            `Remote local ${kind} conflicts with durable content`,
          );
        }
        this.#database.exec("COMMIT");
        committed = true;
        return false;
      }
      if (kind === "acceptance") {
        if (row.processing_state !== "ready") {
          throw new TypeError("Remote command is not ready for local acceptance");
        }
        this.#database
          .prepare(
            `UPDATE remote_command_inbox
             SET processing_state = 'local-accepted', local_command_id = ?,
                 local_acceptance_digest = ?, canonical_local_acceptance = ?,
                 local_accepted_at = ?
             WHERE binding_id = ? AND sequence = ? AND processing_state = 'ready'`,
          )
          .run(localCommandId, entryDigest, canonicalEntry, entry.recordedAt, bindingId, sequence);
      } else {
        if (row.processing_state !== "local-accepted") {
          throw new TypeError("Remote command has no durable local acceptance");
        }
        this.#database
          .prepare(
            `UPDATE remote_command_inbox
             SET processing_state = 'local-result', local_result_digest = ?,
                 canonical_local_result = ?, local_result_at = ?
             WHERE binding_id = ? AND sequence = ? AND processing_state = 'local-accepted'`,
          )
          .run(entryDigest, canonicalEntry, entry.recordedAt, bindingId, sequence);
      }
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault(
        kind === "acceptance"
          ? "after-remote-local-acceptance-commit-before-return"
          : "after-remote-local-result-commit-before-return",
      );
      return true;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #fault(point: SqliteRemoteAuthorityFaultPoint): void {
    this.#faultInjector?.(point);
  }
}

export class SqlitePortalQueryAuthority {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  #replayed: { readonly state: string; readonly service: RuntimeCommandService } | undefined;

  constructor(options: SqlitePortalQueryAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.assetDirectory = resolve(options.assetDirectory);
    this.dependencies = options.dependencies;
    this.#database = openReadConnection(this.databasePath);
    const version = this.#database.pragma("user_version", { simple: true }) as number;
    if (version !== CURRENT_SCHEMA_VERSION) {
      this.#database.close();
      throw new UnsupportedSchemaVersionError(version);
    }
    verifyPortalRevisionTables(this.#database);
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  listRepositories(after?: string, limit = PORTAL_LIMITS.maxDiscoveryItems): PortalRepositoryPage {
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxDiscoveryItems);
    const rows = this.#database
      .prepare<
        [string, number],
        { repository_id: string; portal_revision: number; run_count: number }
      >(
        `SELECT r.repository_id, MAX(p.portal_revision) AS portal_revision,
                COUNT(p.run_id) AS run_count
         FROM repositories r
         JOIN portal_run_revisions p ON p.repository_id = r.repository_id
         WHERE r.repository_id > ?
         GROUP BY r.repository_id
         ORDER BY r.repository_id LIMIT ?`,
      )
      .all(after ?? "", limit + 1);
    return decodePortalRepositoryPage({
      apiVersion: PROTOCOL_VERSION,
      ...(after === undefined ? {} : { after }),
      hasMore: rows.length > limit,
      repositories: rows.slice(0, limit).map((row) => ({
        repositoryId: row.repository_id,
        displayName: row.repository_id,
        portalRevision: row.portal_revision,
        runCount: row.run_count,
      })),
    });
  }

  listRuns(
    repositoryId: string,
    after?: string,
    limit = PORTAL_LIMITS.maxDiscoveryItems,
  ): PortalRunPage {
    validateOpaqueIdentity(repositoryId);
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxDiscoveryItems);
    const rows = this.#database
      .prepare<
        [string, string, number],
        {
          run_id: string;
          cursor: number;
          projection_generated_at: string | null;
          mode: RunControlMode | null;
          run_mode_revision: number | null;
          changed_at: string | null;
          workflow_revision: number;
          context_revision: number;
          runner_revision: number;
          workspace_revision: number;
          human_revision: number;
          portal_revision: number;
        }
      >(
        `SELECT r.run_id, r.cursor, r.projection_generated_at,
                c.mode, c.revision AS run_mode_revision, c.changed_at,
                p.workflow_revision, p.context_revision, p.runner_revision,
                p.workspace_revision, p.human_revision, p.portal_revision
         FROM runs r
         JOIN portal_run_revisions p
           ON p.repository_id = r.repository_id AND p.run_id = r.run_id
         LEFT JOIN run_control_state c ON c.run_key = r.run_key
         WHERE r.repository_id = ? AND r.run_id > ?
         ORDER BY r.run_id LIMIT ?`,
      )
      .all(repositoryId, after ?? "", limit + 1);
    const service = this.#runtimeService();
    return decodePortalRunPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      ...(after === undefined ? {} : { after }),
      hasMore: rows.length > limit,
      runs: rows.slice(0, limit).map((row) => {
        const scheduling = service.queryRunScheduling(repositoryId, row.run_id);
        if (scheduling === undefined) {
          throw new Error("Portal run discovery requires an instantiated runtime graph");
        }
        const vector = this.#syncVector(repositoryId, row.run_id, scheduling.graph.revisionDigest);
        const mode = row.mode ?? "running";
        return {
          repositoryId,
          runId: row.run_id,
          displayName: row.run_id,
          workflowName: scheduling.graph.workflowId,
          mode,
          runModeRevision: row.run_mode_revision ?? 0,
          terminal: mode === "ended",
          updatedAt: row.changed_at ?? row.projection_generated_at ?? "1970-01-01T00:00:00.000Z",
          sync: vector,
        };
      }),
    });
  }

  getRunOverview(repositoryId: string, runId: string): PortalRunOverview | undefined {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const row = this.#database
      .prepare<
        [string, string],
        {
          cursor: number;
          projection_generated_at: string | null;
          mode: RunControlMode | null;
          run_mode_revision: number | null;
          changed_at: string | null;
        }
      >(
        `SELECT r.cursor, r.projection_generated_at, c.mode,
                c.revision AS run_mode_revision, c.changed_at
         FROM runs r LEFT JOIN run_control_state c ON c.run_key = r.run_key
         WHERE r.repository_id = ? AND r.run_id = ?`,
      )
      .get(repositoryId, runId);
    if (row === undefined) return undefined;
    const service = this.#runtimeService();
    const scheduling = service.queryRunScheduling(repositoryId, runId);
    if (scheduling === undefined) return undefined;
    const graph = scheduling.graph;
    const runnerCounts = this.#database
      .prepare<[string], { active_effects: number; uncertain_effects: number }>(
        `SELECT
           COUNT(CASE WHEN latest.status = 'active' THEN 1 END) AS active_effects,
           COUNT(CASE WHEN latest.status = 'unknown' THEN 1 END) AS uncertain_effects
         FROM (
           SELECT o.status
           FROM runner_effect_outcomes o
           JOIN runner_effect_intents i ON i.intent_id = o.intent_id
           WHERE i.run_key = ?
             AND o.commit_cursor = (
               SELECT MAX(next.commit_cursor) FROM runner_effect_outcomes next
               WHERE next.intent_id = o.intent_id
             )
         ) latest`,
      )
      .get(canonicalStringify([repositoryId, runId])) ?? {
      active_effects: 0,
      uncertain_effects: 0,
    };
    const counts = graph.nodes.reduce(
      (current, node) => ({
        phases: current.phases + (node.kind === "phase" ? 1 : 0),
        tasks: current.tasks + (node.kind === "task" ? 1 : 0),
        criteria: current.criteria + (node.kind === "criterion" ? 1 : 0),
      }),
      { phases: 0, tasks: 0, criteria: 0 },
    );
    const mode = row.mode ?? "running";
    return decodePortalRunOverview({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      displayName: runId,
      workflowName: graph.workflowId,
      mode,
      runModeRevision: row.run_mode_revision ?? 0,
      terminal: mode === "ended",
      updatedAt: row.changed_at ?? row.projection_generated_at ?? "1970-01-01T00:00:00.000Z",
      sync: this.#syncVector(repositoryId, runId, graph.revisionDigest),
      counts: {
        ...counts,
        closedPhases: this.#closedPhases(repositoryId, runId),
        humanNeeds: this.#humanNeeds(repositoryId, runId).length,
        activeEffects: runnerCounts.active_effects,
        uncertainEffects: runnerCounts.uncertain_effects,
      },
    });
  }

  // A run that has closed every phase is done, and nothing else said so: the
  // mode stays `running` until a person ends it, so this is the only way to tell
  // a finished run from a working one.
  #closedPhases(repositoryId: string, runId: string): number {
    const row = this.#database
      .prepare<[string, string], { closed: number }>(
        `SELECT COUNT(*) AS closed
         FROM authority_state s,
              json_each(s.canonical_json, '$.runs') run,
              json_each(run.value, '$.records.phaseLifecycles') lifecycle
         WHERE s.singleton = 1
           AND json_extract(run.value, '$.repositoryId') = ?
           AND json_extract(run.value, '$.runId') = ?
           AND json_extract(lifecycle.value, '$.closure') IS NOT NULL`,
      )
      .get(repositoryId, runId);
    return row?.closed ?? 0;
  }

  getGraphSummary(repositoryId: string, runId: string): PortalGraphSummary | undefined {
    const graph = this.#graph(repositoryId, runId);
    return graph === undefined
      ? undefined
      : decodePortalGraphSummary({
          apiVersion: PROTOCOL_VERSION,
          repositoryId,
          runId,
          graphRevision: graph.revisionDigest,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          jsonNodeBudget: PORTAL_LIMITS.jsonViewerNodeBudget,
        });
  }

  listGraphNodes(
    repositoryId: string,
    runId: string,
    graphRevision: string,
    after = 0,
    limit = PORTAL_LIMITS.maxGraphItems,
  ): PortalGraphNodePage {
    validatePortalOffset(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxGraphItems);
    const projection = this.#database
      .transaction(() => {
        const graph = this.#requiredGraphRevision(repositoryId, runId, graphRevision);
        return {
          graph,
          statuses: this.#graphNodeStatuses(repositoryId, runId, graph),
          gates: this.#phaseGateDigests(repositoryId, runId),
        };
      })
      .deferred();
    const graph = projection.graph;
    const nodes = graph.nodes.slice(after, after + limit);
    return decodePortalGraphNodePage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      graphRevision,
      after,
      nextAfter: after + nodes.length,
      hasMore: after + nodes.length < graph.nodes.length,
      nodes: nodes.map((node) => {
        const definition = node.definition;
        const parentNodeId = "parentId" in definition ? definition.parentId : undefined;
        const supersededBy = graph.edges.find(
          (edge) => edge.kind === "supersedes" && edge.to === definition.id,
        )?.from;
        const status = projection.statuses.get(definition.id) ?? NOT_STARTED_NODE_STATUS;
        return {
          nodeId: definition.id,
          kind: node.kind,
          title: definition.title ?? definition.key,
          definitionGeneration: definition.generation,
          runState: status.runState,
          ...(parentNodeId === undefined ? {} : { parentNodeId }),
          ...(definition.source.pointer.length === 0
            ? {}
            : { sourcePointer: definition.source.pointer }),
          ...(definition.input === null ? {} : { normalizedInput: definition.input as JsonValue }),
          ...(node.kind === "task" ? { completionPolicy: node.definition.completionPolicy } : {}),
          ...(supersededBy === undefined ? {} : { supersededBy }),
          ...(status.attempt === undefined ? {} : { attempt: status.attempt }),
          ...(status.roleKey === undefined ? {} : { roleKey: status.roleKey }),
          ...(status.dispatchId === undefined ? {} : { dispatchId: status.dispatchId }),
          ...(node.kind === "phase" && projection.gates.has(definition.id)
            ? { gateDigest: projection.gates.get(definition.id) }
            : {}),
          humanNeedCount: status.humanNeedCount,
          evidenceCount: status.evidenceCount,
        };
      }),
    });
  }

  listGraphEdges(
    repositoryId: string,
    runId: string,
    graphRevision: string,
    after = 0,
    limit = PORTAL_LIMITS.maxGraphItems,
  ): PortalGraphEdgePage {
    validatePortalOffset(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxGraphItems);
    const graph = this.#requiredGraphRevision(repositoryId, runId, graphRevision);
    const edges = graph.edges.slice(after, after + limit);
    return decodePortalGraphEdgePage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      graphRevision,
      after,
      nextAfter: after + edges.length,
      hasMore: after + edges.length < graph.edges.length,
      edges: edges.map((edge) => ({
        edgeId: this.dependencies.sha256.digest(canonicalBytes(edge)),
        fromNodeId: edge.from,
        toNodeId: edge.to,
        kind:
          edge.kind === "contains"
            ? "containment"
            : edge.kind === "depends-on"
              ? "dependency"
              : "supersession",
      })),
    });
  }

  listDeliveryRecords(
    repositoryId: string,
    runId: string,
    after = 0,
    limit = PORTAL_LIMITS.maxDeliveryItems,
  ): PortalDeliveryPage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    validatePortalOffset(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxDeliveryItems);
    const run = this.#database
      .prepare<[string, string], { run_key: string }>(
        "SELECT run_key FROM runs WHERE repository_id = ? AND run_id = ?",
      )
      .get(repositoryId, runId);
    if (run === undefined) throw new PageQueryError("cursor-ahead", "Portal run does not exist");
    const graph = this.#graph(repositoryId, runId);
    if (graph === undefined)
      throw new PageQueryError("cursor-ahead", "Portal graph does not exist");
    const records: PortalDeliveryRecord[] = [];

    for (const row of this.#database
      .prepare<
        [string],
        {
          attempt_digest: string;
          phase_id: string;
          definition_generation: number;
          attempt_ordinal: number;
        }
      >(
        `SELECT attempt_digest, phase_id, definition_generation, attempt_ordinal
         FROM phase_attempts WHERE run_key = ? ORDER BY phase_id, attempt_ordinal`,
      )
      .all(run.run_key)) {
      records.push({
        identity: row.attempt_digest,
        kind: "phase-attempt",
        phaseId: row.phase_id,
        definitionGeneration: row.definition_generation,
        attempt: row.attempt_ordinal,
      });
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          transition_digest: string;
          phase_id: string;
          definition_generation: number;
          attempt_ordinal: number;
          trigger_kind: string;
          disposition: string;
          next_attempt_ordinal: number | null;
        }
      >(
        `SELECT t.transition_digest, a.phase_id, a.definition_generation,
                a.attempt_ordinal, t.trigger_kind, t.disposition, t.next_attempt_ordinal
         FROM phase_attempt_transitions t
         JOIN phase_attempts a ON a.attempt_digest = t.attempt_digest
         WHERE a.run_key = ? ORDER BY a.phase_id, a.attempt_ordinal`,
      )
      .all(run.run_key)) {
      records.push({
        identity: row.transition_digest,
        kind: "phase-transition",
        phaseId: row.phase_id,
        definitionGeneration: row.definition_generation,
        attempt: row.attempt_ordinal,
        trigger: row.trigger_kind,
        disposition: row.disposition,
        ...(row.next_attempt_ordinal === null ? {} : { nextAttempt: row.next_attempt_ordinal }),
      });
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          publication_digest: string;
          phase_id: string;
          definition_generation: number;
          attempt_ordinal: number;
          output_name: string;
          schema_key: string;
          content_digest: string;
          byte_length: number;
          acceptance_digest: string | null;
        }
      >(
        `SELECT p.publication_digest, a.phase_id, a.definition_generation,
                a.attempt_ordinal, p.output_name, p.schema_key, p.content_digest,
                p.byte_length, x.acceptance_digest
         FROM phase_output_publications p
         JOIN phase_attempts a ON a.attempt_digest = p.attempt_digest
         LEFT JOIN phase_output_acceptances x ON x.publication_id = p.publication_id
         WHERE p.run_key = ? ORDER BY a.phase_id, a.attempt_ordinal, p.output_name`,
      )
      .all(run.run_key)) {
      records.push({
        identity: row.publication_digest,
        kind: "phase-output",
        phaseId: row.phase_id,
        definitionGeneration: row.definition_generation,
        attempt: row.attempt_ordinal,
        outputName: row.output_name,
        schemaKey: row.schema_key,
        contentDigest: row.content_digest,
        byteLength: row.byte_length,
        accepted: row.acceptance_digest !== null,
      });
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          evaluation_digest: string;
          for_each_key: string;
          task_set_digest: string;
          applied: number;
          attempt_ordinal: number;
          phase_id: string;
        }
      >(
        `SELECT e.evaluation_digest, e.for_each_key, e.task_set_digest, e.applied,
                a.attempt_ordinal, a.phase_id
         FROM fan_out_evaluations e
         JOIN phase_attempts a ON a.attempt_digest = e.attempt_digest
         WHERE e.run_key = ? ORDER BY e.for_each_key, e.evaluation_digest`,
      )
      .all(run.run_key)) {
      records.push({
        identity: row.evaluation_digest,
        kind: "fan-out-evaluation",
        phaseId: row.phase_id,
        attempt: row.attempt_ordinal,
        forEachKey: row.for_each_key,
        evaluationDigest: row.evaluation_digest,
        taskSetDigest: row.task_set_digest,
        applied: row.applied === 1,
      });
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          member_digest: string;
          evaluation_digest: string;
          task_id: string;
          task_generation: number;
          input_digest: string;
          applied: number;
        }
      >(
        `SELECT m.member_digest, m.evaluation_digest, m.task_id,
                m.task_generation, m.input_digest, e.applied
         FROM fan_out_members m JOIN fan_out_evaluations e
           ON e.evaluation_digest = m.evaluation_digest
         WHERE e.run_key = ? ORDER BY m.evaluation_digest, m.stable_identity`,
      )
      .all(run.run_key)) {
      records.push({
        identity: row.member_digest,
        kind: "generated-task",
        evaluationDigest: row.evaluation_digest,
        taskId: row.task_id,
        definitionGeneration: row.task_generation,
        inputDigest: row.input_digest,
        state:
          row.applied !== 1
            ? "proposed"
            : graph.edges.some((edge) => edge.kind === "supersedes" && edge.to === row.task_id)
              ? "superseded"
              : "effective",
      });
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          evaluation_digest: string;
          proposal_digest: string;
          decision_digest: string | null;
          application_digest: string | null;
          state: string;
        }
      >(
        `SELECT i.evaluation_digest, i.proposal_digest, i.decision_digest,
                i.application_digest, i.state
         FROM plan_imports i JOIN fan_out_evaluations e
           ON e.evaluation_digest = i.evaluation_digest
         WHERE e.run_key = ? ORDER BY i.evaluation_digest`,
      )
      .all(run.run_key)) {
      records.push({
        identity: row.proposal_digest,
        kind: "plan-import",
        evaluationDigest: row.evaluation_digest,
        proposalDigest: row.proposal_digest,
        state: row.state,
        ...(row.decision_digest === null ? {} : { decisionDigest: row.decision_digest }),
        ...(row.application_digest === null ? {} : { applicationDigest: row.application_digest }),
      });
    }

    const selected = records.slice(after, after + limit);
    const revision = this.#portalRevision(repositoryId, runId);
    return decodePortalDeliveryPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      dataflowRevision: revision.dataflow_revision,
      taskFrontierRevision: revision.task_frontier_revision,
      after,
      nextAfter: after + selected.length,
      hasMore: after + selected.length < records.length,
      records: selected,
    });
  }

  getImmutableRecord(
    repositoryId: string,
    runId: string,
    kind: PortalRecordKind,
    digestValue: string,
  ): PortalImmutableRecord | undefined {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (!isSha256Digest(digestValue)) throw new TypeError("record digest must be a SHA-256 digest");
    const graph = this.#graph(repositoryId, runId);
    if (graph === undefined) return undefined;
    const run = this.#runtimeRecordRow(repositoryId, runId);
    if (run === undefined) return undefined;
    let body: JsonValue | undefined;
    if (kind === "escalation") {
      const escalation = this.#database
        .prepare<[string], { command_id: string; canonical_escalation: string }>(
          `SELECT command_id, canonical_escalation FROM runner_escalations
           WHERE run_key = ? ORDER BY command_id`,
        )
        .all(canonicalStringify([repositoryId, runId]))
        .find(
          (row) =>
            this.dependencies.sha256.digest(
              canonicalBytes(decodeCanonicalJsonValue(row.canonical_escalation)),
            ) === digestValue,
        );
      body =
        escalation === undefined
          ? undefined
          : decodeCanonicalJsonValue(escalation.canonical_escalation);
    } else {
      const records = decodeDurableJsonValue(run.records_json);
      body = findRuntimeReviewRecord(records, kind, digestValue);
      if (kind === "candidate" && body !== undefined) {
        const gateEvidenceDigest = findCandidateGateEvidenceDigest(records, digestValue);
        body = {
          candidate: body,
          ...(gateEvidenceDigest === undefined ? {} : { gateEvidenceDigest }),
        };
      }
    }
    if (body === undefined) return undefined;
    return decodePortalImmutableRecord({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      kind,
      recordId: digestValue,
      digest: digestValue,
      graphRevision: graph.revisionDigest,
      recordedAt: run.projection_generated_at,
      body,
    });
  }

  getAllowanceReview(
    repositoryId: string,
    runId: string,
    escalationCommandId: string,
  ): PortalAllowanceReview | undefined {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    validateOpaqueIdentity(escalationCommandId);
    const row = this.#database
      .prepare<[string, string], PortalAllowanceQueryRow>(
        `SELECT e.command_id, e.canonical_escalation, b.budget_limit,
                p.policy_digest, p.canonical_policy, c.mode,
                c.revision AS run_mode_revision,
                a.canonical_json AS canonical_authority
         FROM runner_escalations e
         JOIN runner_budgets b
           ON b.run_key = e.run_key
          AND b.unit = json_extract(e.canonical_escalation, '$.unit')
         JOIN runner_allowance_policies p ON p.run_key = e.run_key
         LEFT JOIN runner_allowance_resolutions r
           ON r.escalation_command_id = e.command_id
         JOIN run_control_state c ON c.run_key = e.run_key
         JOIN authority_state a ON a.singleton = 1
         WHERE e.run_key = ? AND e.command_id = ?
           AND r.escalation_command_id IS NULL
         LIMIT 1`,
      )
      .get(canonicalStringify([repositoryId, runId]), escalationCommandId);
    if (row === undefined || (row.mode !== "running" && row.mode !== "paused")) return undefined;
    try {
      const escalation = requiredJsonRecord(
        decodeCanonicalJsonValue(row.canonical_escalation),
        "Portal allowance escalation",
      );
      const policy = requiredJsonRecord(
        decodeCanonicalJsonValue(row.canonical_policy),
        "Portal allowance policy",
      );
      const ceilings = policy.ceilings;
      if (!Array.isArray(ceilings)) return undefined;
      const unit = requiredStringField(escalation.unit, "allowance escalation unit");
      const ceiling = ceilings.find((value) => optionalJsonRecord(value)?.unit === unit);
      const maximum = optionalJsonRecord(ceiling)?.maximum;
      const service = new RuntimeCommandService(
        this.dependencies,
        InMemoryAuthority.fromCanonicalJson(row.canonical_authority, this.dependencies),
      );
      const execution = service.queryRunExecution(repositoryId, runId);
      const graph = service.queryRunScheduling(repositoryId, runId)?.graph;
      if (
        escalation.commandId !== row.command_id ||
        policy.policyDigest !== row.policy_digest ||
        execution === undefined ||
        canonicalStringify(execution.allowancePolicy) !== row.canonical_policy ||
        graph === undefined ||
        typeof maximum !== "number" ||
        !Number.isSafeInteger(maximum) ||
        !Number.isSafeInteger(row.budget_limit) ||
        maximum <= row.budget_limit
      ) {
        return undefined;
      }
      const escalationDigest = this.dependencies.sha256.digest(canonicalBytes(escalation));
      const maxIncrease = maximum - row.budget_limit;
      return decodePortalAllowanceReview({
        apiVersion: PROTOCOL_VERSION,
        repositoryId,
        runId,
        escalationCommandId: row.command_id,
        escalationDigest,
        operationId: escalation.operationId,
        unit,
        requested: escalation.requested,
        available: escalation.available,
        createdAt: escalation.createdAt,
        currentLimit: row.budget_limit,
        maxIncrease,
        ceiling: maximum,
        allowancePolicyDigest: row.policy_digest,
        resultingMax: row.budget_limit + maxIncrease,
        expectedGraphRevision: graph.revisionDigest,
        expectedRunMode: row.mode,
        expectedRunModeRevision: row.run_mode_revision,
      });
    } catch {
      return undefined;
    }
  }

  listHumanNeeds(
    repositoryId: string,
    runId: string,
    after?: string,
    limit = PORTAL_LIMITS.maxHumanNeeds,
  ): PortalHumanNeedPage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxHumanNeeds);
    const revision = this.#portalRevision(repositoryId, runId);
    const all = this.#humanNeeds(repositoryId, runId);
    const matching = all.filter((need) => after === undefined || need.needId > after);
    return decodePortalHumanNeedPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      humanRevision: revision.human_revision,
      ...(after === undefined ? {} : { after }),
      hasMore: matching.length > limit,
      needs: matching.slice(0, limit),
    });
  }

  listQuestions(
    repositoryId: string,
    runId: string,
    after?: string,
    limit = PORTAL_LIMITS.maxHumanNeeds,
  ): PortalQuestionPage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxHumanNeeds);
    const rows = this.#database
      .prepare<[string, string, string, number], PortalQuestionQueryRow>(
        `SELECT q.submission_id, q.canonical_question,
                a.command_id AS answer_id, a.answer_digest, a.canonical_answer,
                a.principal_digest, a.answered_at,
                f.requirement_digest, f.created_at,
                f.satisfied_by_dispatch_id,
                (SELECT e.canonical_event FROM context_events e
                 WHERE e.repository_id = q.repository_id AND e.run_id = q.run_id
                   AND json_extract(e.canonical_event, '$.payload.submissionId') = q.submission_id
                 ORDER BY e.cursor LIMIT 1) AS canonical_event
         FROM context_questions q
         LEFT JOIN context_question_answers a ON a.submission_id = q.submission_id
         LEFT JOIN context_fresh_dispatch_requirements f ON f.submission_id = q.submission_id
         WHERE q.repository_id = ? AND q.run_id = ? AND q.submission_id > ?
         ORDER BY q.submission_id LIMIT ?`,
      )
      .all(repositoryId, runId, after ?? "", limit + 1);
    const questions = rows
      .slice(0, limit)
      .map((row) => this.#portalQuestionRecord(repositoryId, runId, row));
    return decodePortalQuestionPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      contextRevision: this.#portalRevision(repositoryId, runId).context_revision,
      ...(after === undefined ? {} : { after }),
      hasMore: rows.length > limit,
      questions,
    });
  }

  getQuestion(
    repositoryId: string,
    runId: string,
    submissionId: string,
  ): PortalQuestionRecord | undefined {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    validateOpaqueIdentity(submissionId);
    const row = this.#database
      .prepare<[string, string, string], PortalQuestionQueryRow>(
        `SELECT q.submission_id, q.canonical_question,
                a.command_id AS answer_id, a.answer_digest, a.canonical_answer,
                a.principal_digest, a.answered_at,
                f.requirement_digest, f.created_at,
                f.satisfied_by_dispatch_id,
                (SELECT e.canonical_event FROM context_events e
                 WHERE e.repository_id = q.repository_id AND e.run_id = q.run_id
                   AND json_extract(e.canonical_event, '$.payload.submissionId') = q.submission_id
                 ORDER BY e.cursor LIMIT 1) AS canonical_event
         FROM context_questions q
         LEFT JOIN context_question_answers a ON a.submission_id = q.submission_id
         LEFT JOIN context_fresh_dispatch_requirements f ON f.submission_id = q.submission_id
         WHERE q.repository_id = ? AND q.run_id = ? AND q.submission_id = ?`,
      )
      .get(repositoryId, runId, submissionId);
    return row === undefined ? undefined : this.#portalQuestionRecord(repositoryId, runId, row);
  }

  listArtifacts(
    repositoryId: string,
    runId: string,
    after?: string,
    limit = PORTAL_LIMITS.maxArtifactItems,
  ): PortalArtifactPage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxArtifactItems);
    const rows = this.#database
      .prepare<[string, string], { canonical_submission: string }>(
        `SELECT canonical_submission FROM context_submissions
         WHERE repository_id = ? AND run_id = ?
           AND submission_type IN ('asset', 'phase-output')
         ORDER BY submission_id`,
      )
      .all(repositoryId, runId);
    // A page is read back in artifact order, and an artifact is named by its
    // asset rather than by the submission that carried it. Paging on the
    // submission handed back a page whose own contract refused it, so the whole
    // view answered five hundred for every run that made more than one thing.
    const byIdentity = new Map<string, PortalArtifactMetadata>();
    const publications = this.#publishedAttempts(repositoryId, runId);
    for (const { canonical_submission } of rows) {
      const submission = requiredJsonRecord(
        decodeCanonicalJsonValue(canonical_submission),
        "Portal worker asset submission",
      );
      // A phase output is the thing the workflow exists to produce. Listing only
      // proposed assets hid it from everyone who finished a run.
      const asset =
        submission.asset === undefined
          ? phaseOutputAsAsset(requiredJsonRecord(submission.output, "Portal phase output"))
          : requiredJsonRecord(submission.asset, "Portal worker asset metadata");
      const artifact = this.#artifactMetadata(submission, asset);
      // An artifact is its content. Two submissions can carry the same bytes --
      // an attempt that was asked a question and its answered retry producing
      // the same output is exactly that -- and listing both put two rows with
      // one identity in a page whose contract requires them to ascend, so the
      // query refused itself and every artifact view went blank.
      if (!byIdentity.has(artifact.artifactId)) byIdentity.set(artifact.artifactId, artifact);
    }
    const ordered = [...byIdentity.values()]
      .filter((artifact) => after === undefined || artifact.artifactId > after)
      .sort((left, right) =>
        left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
      )
      .map((artifact) => {
        const published = publications.get(artifact.contentDigest);
        return published === undefined ? artifact : { ...artifact, ...published };
      });
    const artifacts = ordered.slice(0, limit);
    return decodePortalArtifactPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      contextRevision: this.#portalRevision(repositoryId, runId).context_revision,
      ...(after === undefined ? {} : { after }),
      hasMore: ordered.length > limit,
      artifacts,
    });
  }

  getArtifact(
    repositoryId: string,
    runId: string,
    artifactId: string,
  ): PortalArtifactMetadata | undefined {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    validateOpaqueIdentity(artifactId);
    const row = this.#database
      .prepare<[string, string, string], { canonical_submission: string }>(
        `SELECT canonical_submission FROM context_submissions
         WHERE repository_id = ? AND run_id = ? AND submission_type = 'asset'
           AND json_extract(canonical_submission, '$.asset.assetId') = ?`,
      )
      .get(repositoryId, runId, artifactId);
    if (row === undefined) return undefined;
    const submission = requiredJsonRecord(
      decodeCanonicalJsonValue(row.canonical_submission),
      "Portal worker asset submission",
    );
    return this.#artifactMetadata(
      submission,
      requiredJsonRecord(submission.asset, "Portal worker asset metadata"),
    );
  }

  readArtifactContent(
    repositoryId: string,
    runId: string,
    artifactId: string,
    offset: number,
    length: number,
  ): PortalArtifactContent | undefined {
    validatePortalOffset(offset);
    validatePortalLimit(length, PORTAL_LIMITS.maxArtifactPreviewBytes);
    const metadata = this.getArtifact(repositoryId, runId, artifactId);
    if (metadata === undefined || metadata.availability !== "verified-stored") return undefined;
    if (offset > metadata.byteLength) throw new TypeError("Artifact offset exceeds byte length");
    const bytes = this.#verifiedArtifactBytes(metadata);
    const chunk = bytes.subarray(offset, Math.min(offset + length, bytes.byteLength));
    let encoding: "utf8" | "base64" = "base64";
    let content = Buffer.from(chunk).toString("base64");
    if (metadata.mediaType.startsWith("text/") || metadata.mediaType === "application/json") {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(chunk);
        encoding = "utf8";
      } catch {
        // Invalid UTF-8 remains an inert base64 preview.
      }
    }
    return decodePortalArtifactContent({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      artifactId,
      contentDigest: metadata.contentDigest,
      offset,
      byteLength: chunk.byteLength,
      totalByteLength: metadata.byteLength,
      encoding,
      content,
      complete: offset + chunk.byteLength === metadata.byteLength,
      jsonNodeBudget: PORTAL_LIMITS.jsonViewerNodeBudget,
    });
  }

  downloadArtifact(
    repositoryId: string,
    runId: string,
    artifactId: string,
  ): PortalArtifactDownload | undefined {
    const metadata = this.getArtifact(repositoryId, runId, artifactId);
    if (metadata === undefined || metadata.availability !== "verified-stored") return undefined;
    return Object.freeze({
      bytes: this.#verifiedArtifactBytes(metadata),
      filename: `senawa-artifact-${metadata.contentDigest}.bin`,
      digest: metadata.contentDigest,
    });
  }

  /**
   * Every agent the run has dispatched, newest first.
   *
   * Read from the dispatch's own context rather than from a report, because the
   * context is what the agent was actually given: the persona, the attempt, and
   * the refusals it was told to act on. The model is the exception: the context
   * names its policy by digest only, so the chosen route comes from the effect.
   */
  listAgents(
    repositoryId: string,
    runId: string,
    after?: string,
    limit = PORTAL_LIMITS.maxAgentItems,
  ): PortalAgentPage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxAgentItems);
    const rows = this.#database
      .prepare<
        [string, string, string, number],
        {
          dispatch_id: string;
          persona: string | null;
          phase_id: string | null;
          task_id: string | null;
          attempt: number | null;
          model: string | null;
          route_index: number | null;
          refusals: string | null;
          finished: number | null;
          session_id: string | null;
        }
      >(
        `SELECT d.dispatch_id,
                json_extract(b.canonical_context, '$.role.key') AS persona,
                json_extract(b.canonical_context, '$.phaseAttempt.phase.phaseId') AS phase_id,
                json_extract(b.canonical_context, '$.task.taskId') AS task_id,
                json_extract(b.canonical_context, '$.phaseAttempt.phase.attempt') AS attempt,
                json_extract(b.canonical_context, '$.priorRefusals') AS refusals,
                (SELECT 1 FROM context_terminal_completions t
                  WHERE t.dispatch_id = d.dispatch_id) AS finished,
                (SELECT s.predecessor_session_id FROM agent_session_resume_bindings s
                  WHERE s.predecessor_dispatch_id = d.dispatch_id LIMIT 1) AS session_id
         FROM context_dispatches d
         JOIN context_bases b ON b.context_id = d.context_id
         WHERE d.repository_id = ? AND d.run_id = ? AND d.dispatch_id > ?
         ORDER BY d.dispatch_id LIMIT ?`,
      )
      .all(repositoryId, runId, after ?? "", limit + 1);
    const names = this.#nodeNames(repositoryId, runId);
    const routes = this.#dispatchRoutes(repositoryId, runId);
    return decodePortalAgentPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      ...(after === undefined ? {} : { after }),
      hasMore: rows.length > limit,
      agents: rows.slice(0, limit).map((row) => {
        // The last refusal is the one the attempt was told to act on. Earlier
        // ones were answered by the attempts between, so showing them all would
        // read as a list of live problems.
        const refusals = readRefusals(row.refusals);
        const latest = refusals[refusals.length - 1];
        const phaseName = row.phase_id === null ? undefined : names.get(row.phase_id);
        const taskName = row.task_id === null ? undefined : names.get(row.task_id);
        const route = routes.get(row.dispatch_id);
        return {
          dispatchId: row.dispatch_id,
          persona: row.persona ?? "unknown",
          phaseId: row.phase_id ?? "unknown",
          taskId: row.task_id ?? "unknown",
          ...(phaseName === undefined ? {} : { phaseName }),
          ...(taskName === undefined ? {} : { taskName }),
          attempt: row.attempt ?? 1,
          ...(route === undefined ? {} : { model: route.model }),
          routeIndex: route?.routeIndex ?? 0,
          state: row.finished === 1 ? "finished" : "working",
          ...(row.session_id === null ? {} : { sessionId: row.session_id }),
          ...(latest === undefined ? {} : { latestRefusal: latest.slice(0, MAX_REFUSAL_LENGTH) }),
        };
      }),
    });
  }

  listWorkspaces(
    repositoryId: string,
    runId: string,
    after?: string,
    limit = PORTAL_LIMITS.maxWorkspaceItems,
  ): PortalWorkspacePage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxWorkspaceItems);
    const runKey = canonicalStringify([repositoryId, runId]);
    const rows = this.#database
      .prepare<
        [string, string, number],
        {
          workspace_id: string;
          task_id: string;
          definition_generation: number;
          dispatch_id: string;
          mode: "repository" | "worktree";
          state: string;
          base_revision_digest: string;
          result_revision_digest: string | null;
          recorded_at: string | null;
          eligible: number | null;
        }
      >(
        `SELECT w.workspace_id, w.task_id, w.definition_generation, w.dispatch_id,
                w.mode, w.state, w.base_revision_digest,
                r.result_revision_digest, r.recorded_at,
                e.eligible
         FROM runner_workspaces w
         LEFT JOIN runner_workspace_results r ON r.workspace_id = w.workspace_id
         LEFT JOIN runner_completion_eligibility e ON e.workspace_id = w.workspace_id
         WHERE w.run_key = ? AND w.workspace_id > ?
         ORDER BY w.workspace_id LIMIT ?`,
      )
      .all(runKey, after ?? "", limit + 1);
    const fallbackTime = this.#runTimestamp(repositoryId, runId);
    return decodePortalWorkspacePage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      workspaceRevision: this.#portalRevision(repositoryId, runId).workspace_revision,
      ...(after === undefined ? {} : { after }),
      hasMore: rows.length > limit,
      workspaces: rows.slice(0, limit).map((row) => ({
        workspaceId: row.workspace_id,
        taskId: row.task_id,
        definitionGeneration: row.definition_generation,
        dispatchId: row.dispatch_id,
        mode: row.mode === "worktree" ? "isolated" : "repository",
        state: row.state,
        baseDigest: row.base_revision_digest,
        ...(row.result_revision_digest === null
          ? {}
          : { resultDigest: row.result_revision_digest }),
        completionEligible: row.eligible === 1,
        updatedAt: row.recorded_at ?? fallbackTime,
      })),
    });
  }

  listIntegrations(
    repositoryId: string,
    runId: string,
    after?: string,
    limit = PORTAL_LIMITS.maxIntegrationItems,
  ): PortalIntegrationPage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (after !== undefined) validateOpaqueIdentity(after);
    validatePortalLimit(limit, PORTAL_LIMITS.maxIntegrationItems);
    const runKey = canonicalStringify([repositoryId, runId]);
    const rows = this.#database
      .prepare<
        [string, string, number],
        {
          integration_id: string;
          phase_id: string;
          definition_generation: number;
          target_ref: string;
          fan_in_digest: string;
          state: string;
          barrier_digest: string | null;
          gate_digest: string | null;
          member_count: number;
        }
      >(
        `SELECT i.integration_id, i.phase_id, i.definition_generation,
                i.target_ref, i.fan_in_digest, i.state, i.barrier_digest,
                g.evaluation_digest AS gate_digest,
                COUNT(m.ordinal) AS member_count
         FROM runner_integration_attempts i
         LEFT JOIN runner_integration_gates g ON g.integration_id = i.integration_id
         LEFT JOIN runner_integration_members m ON m.integration_id = i.integration_id
         WHERE i.run_key = ? AND i.integration_id > ?
         GROUP BY i.integration_id
         ORDER BY i.integration_id LIMIT ?`,
      )
      .all(runKey, after ?? "", limit + 1);
    const updatedAt = this.#runTimestamp(repositoryId, runId);
    return decodePortalIntegrationPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      workspaceRevision: this.#portalRevision(repositoryId, runId).workspace_revision,
      ...(after === undefined ? {} : { after }),
      hasMore: rows.length > limit,
      integrations: rows.slice(0, limit).map((row) => ({
        integrationId: row.integration_id,
        cohortId: row.fan_in_digest,
        attempt: integrationAttemptOrdinal(row.integration_id),
        state: row.state,
        memberCount: row.member_count,
        targetDigest: this.dependencies.sha256.digest(canonicalBytes(row.target_ref)),
        ...(row.gate_digest === null ? {} : { gateDigest: row.gate_digest }),
        ...(row.barrier_digest === null ? {} : { barrierDigest: row.barrier_digest }),
        ...(integrationDiagnosticForState(row.state) === undefined
          ? {}
          : { diagnostic: integrationDiagnosticForState(row.state) }),
        updatedAt,
      })),
    });
  }

  listReceiptWindow(
    repositoryId: string,
    runId: string,
    query: { readonly after?: number; readonly before?: number; readonly limit?: number } = {},
  ): PortalReceiptWindow {
    return this.#activityWindow(repositoryId, runId, "receipts", query) as PortalReceiptWindow;
  }

  listEventWindow(
    repositoryId: string,
    runId: string,
    query: { readonly after?: number; readonly before?: number; readonly limit?: number } = {},
  ): PortalEventWindow {
    return this.#activityWindow(repositoryId, runId, "events", query) as PortalEventWindow;
  }

  listTranscript(
    repositoryId: string,
    runId: string,
    owner: PortalTranscriptOwner,
    after = 0,
    limit = TRANSCRIPT_LIMITS.maxRecordsPerPage,
  ): PortalTranscriptPage {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    validateOpaqueIdentity(owner.id);
    validatePortalOffset(after);
    validatePortalLimit(limit, TRANSCRIPT_LIMITS.maxRecordsPerPage);
    if (owner.kind === "run" && owner.id !== runId)
      throw new PageQueryError("scope-mismatch", "Run transcript scope must name its own run");
    const run = this.#database
      .prepare<[string, string], { run_key: string }>(
        "SELECT run_key FROM runs WHERE repository_id = ? AND run_id = ?",
      )
      .get(repositoryId, runId);
    if (run === undefined) throw new PageQueryError("cursor-ahead", "Portal run does not exist");
    const rows =
      owner.kind === "run"
        ? this.#runTranscriptRows(run.run_key, after, limit + 1)
        : this.#ownerTranscriptRows(run.run_key, owner, after, limit + 1);
    const page = rows.slice(0, limit);
    return decodePortalTranscriptPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      owner: { kind: owner.kind, id: owner.id },
      after,
      nextAfter: page.at(-1)?.sequence ?? after,
      hasMore: rows.length > limit,
      records: page.map((row) => ({
        apiVersion: PROTOCOL_VERSION,
        repositoryId,
        runId,
        // The run scope keeps the capture owner of every line so a merged view
        // never erases which dispatch, task, or phase produced it.
        owner: row.owner === undefined ? { kind: owner.kind, id: owner.id } : { ...row.owner },
        sequence: row.sequence,
        occurredAt: row.occurred_at,
        stream: row.stream,
        text: row.text,
      })),
    });
  }

  #ownerTranscriptRows(
    runKey: string,
    owner: PortalTranscriptOwner,
    after: number,
    limit: number,
  ): readonly PortalTranscriptRow[] {
    return this.#database
      .prepare<[string, string, string, number, number], PortalTranscriptRow>(
        `SELECT sequence, occurred_at, stream, text FROM agent_transcript_lines
         WHERE run_key = ? AND owner_kind = ? AND owner_id = ? AND sequence > ?
         ORDER BY sequence LIMIT ?`,
      )
      .all(runKey, owner.kind, owner.id, after, limit);
  }

  /**
   * The run scope merges every owner of one run over the durable run sequence.
   * It stays bounded by reading only the newest window one owner could retain,
   * so a run with many owners can never widen the projection.
   */
  #runTranscriptRows(runKey: string, after: number, limit: number): readonly PortalTranscriptRow[] {
    const latest =
      this.#database
        .prepare<[string], { latest: number | null }>(
          "SELECT MAX(run_sequence) AS latest FROM agent_transcript_lines WHERE run_key = ?",
        )
        .get(runKey)?.latest ?? 0;
    const floor = Math.max(after, latest - TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner);
    return this.#database
      .prepare<
        [string, number, number],
        PortalTranscriptRow & { readonly owner_kind: string; readonly owner_id: string }
      >(
        `SELECT run_sequence AS sequence, owner_kind, owner_id, occurred_at, stream, text
         FROM agent_transcript_lines
         WHERE run_key = ? AND run_sequence > ?
         ORDER BY run_sequence LIMIT ?`,
      )
      .all(runKey, floor, limit)
      .map((row) => ({
        sequence: row.sequence,
        occurred_at: row.occurred_at,
        stream: row.stream,
        text: row.text,
        owner: Object.freeze({ kind: row.owner_kind, id: row.owner_id }),
      }));
  }

  #activityWindow(
    repositoryId: string,
    runId: string,
    field: "receipts" | "events",
    query: { readonly after?: number; readonly before?: number; readonly limit?: number },
  ): PortalReceiptWindow | PortalEventWindow {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    if (query.after !== undefined && query.before !== undefined) {
      throw new PageQueryError("cursor-ahead", "after and before cursors are mutually exclusive");
    }
    if (query.after !== undefined) validatePortalOffset(query.after);
    if (query.before !== undefined) validatePortalOffset(query.before);
    const limit = query.limit ?? PORTAL_LIMITS.maxActivityItems;
    validatePortalLimit(limit, PORTAL_LIMITS.maxActivityItems);
    const runKey = canonicalStringify([repositoryId, runId]);
    const table = field === "receipts" ? "receipt_history" : "event_frames";
    const canonicalColumn = field === "receipts" ? "canonical_receipt" : "canonical_frame";
    const range = this.#database
      .prepare<[string], { earliest: number | null; latest: number | null }>(
        `SELECT MIN(cursor) AS earliest, MAX(cursor) AS latest FROM ${table} WHERE run_key = ?`,
      )
      .get(runKey) ?? { earliest: null, latest: null };
    const earliestCursor = range.earliest ?? 0;
    const latestCursor = range.latest ?? 0;
    const direction =
      query.after !== undefined ? "after" : query.before !== undefined ? "before" : "tail";
    const rows = this.#database
      .prepare<[string, number, number], { cursor: number; canonical_value: string }>(
        direction === "after"
          ? `SELECT cursor, ${canonicalColumn} AS canonical_value FROM ${table}
             WHERE run_key = ? AND cursor > ? ORDER BY cursor LIMIT ?`
          : `SELECT cursor, canonical_value FROM (
               SELECT cursor, ${canonicalColumn} AS canonical_value FROM ${table}
               WHERE run_key = ? AND cursor < ? ORDER BY cursor DESC LIMIT ?
             ) ORDER BY cursor`,
      )
      .all(
        runKey,
        direction === "after" ? (query.after ?? 0) : (query.before ?? Number.MAX_SAFE_INTEGER),
        limit,
      );
    const first = rows.at(0)?.cursor;
    const last = rows.at(-1)?.cursor;
    const common = {
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      direction,
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.before === undefined ? {} : { before: query.before }),
      earliestCursor,
      latestCursor,
      hasEarlier: first !== undefined && first > earliestCursor,
      hasLater: last !== undefined && last < latestCursor,
    };
    return field === "receipts"
      ? decodePortalReceiptWindow({
          ...common,
          receipts: rows.map((row) => decodeDurableReceipt(row.canonical_value)),
        })
      : decodePortalEventWindow({
          ...common,
          events: rows.map((row) => decodeEventStreamFrame(row.canonical_value)),
        });
  }

  // Building the service replays every command the run has ever accepted, and
  // each replayed command digests the whole record set, so one portal read cost
  // 1.3 seconds on a run of three phases and grew with the run. This authority
  // only ever reads. The durable state is still read on every call; the replay
  // is reused only while those exact bytes are what is stored.
  #runtimeService(): RuntimeCommandService {
    const row = this.#database
      .prepare<[], { canonical_json: string }>(
        "SELECT canonical_json FROM authority_state WHERE singleton = 1",
      )
      .get();
    if (row === undefined) throw new Error("SQLite authority singleton is missing");
    if (this.#replayed?.state === row.canonical_json) return this.#replayed.service;
    const service = new RuntimeCommandService(
      this.dependencies,
      InMemoryAuthority.fromCanonicalJson(row.canonical_json, this.dependencies),
    );
    this.#replayed = { state: row.canonical_json, service };
    return service;
  }

  #graph(repositoryId: string, runId: string) {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    return this.#runtimeService().queryRunScheduling(repositoryId, runId)?.graph;
  }

  /**
   * The model each dispatch was actually given, by dispatch. The context names
   * a model policy by digest and never a model, so reading one from it reported
   * `unknown` for every agent a run ever had. The route the driver chose is
   * recorded with the dispatch's effect, from the moment it is registered.
   */
  #dispatchRoutes(
    repositoryId: string,
    runId: string,
  ): ReadonlyMap<string, { readonly model: string; readonly routeIndex: number }> {
    const routes = new Map<string, { model: string; routeIndex: number }>();
    for (const row of this.#database
      .prepare<
        [string, string],
        { dispatch_id: string | null; model: string | null; route: number | null }
      >(
        `SELECT dispatch_id,
                json_extract(canonical_effect, '$.input.routeSelection.modelPolicy.model')
                  AS model,
                json_extract(canonical_effect, '$.input.routeSelection.modelPolicy.routeIndex')
                  AS route
           FROM context_dispatches
          WHERE repository_id = ? AND run_id = ?`,
      )
      .all(repositoryId, runId)) {
      if (row.dispatch_id === null || row.model === null) continue;
      routes.set(row.dispatch_id, { model: row.model, routeIndex: row.route ?? 0 });
    }
    return routes;
  }

  /**
   * The authored name of every node in the run, by identity. A digest tells a
   * person nothing, and the name the workflow author wrote is already in the
   * graph, so any view showing an identity can show the name beside it.
   */
  #nodeNames(repositoryId: string, runId: string): ReadonlyMap<string, string> {
    const graph = this.#graph(repositoryId, runId);
    if (graph === undefined) return new Map();
    return new Map(
      graph.nodes.map((node) => [node.definition.id, node.definition.title ?? node.definition.key]),
    );
  }

  #requiredGraphRevision(repositoryId: string, runId: string, graphRevision: string) {
    if (!isSha256Digest(graphRevision))
      throw new TypeError("graphRevision must be a SHA-256 digest");
    const graph = this.#graph(repositoryId, runId);
    if (graph === undefined) {
      throw new PageQueryError("cursor-ahead", "Portal graph run does not exist");
    }
    if (graph.revisionDigest !== graphRevision) {
      throw new PageQueryError("cursor-ahead", "Portal graph revision is stale");
    }
    return graph;
  }

  /**
   * Which attempt published each output, and whether its phase closed over it.
   *
   * An artifact is named by its content, so a retried phase that republished the
   * same bytes is one artifact. The attempt is what tells a reader which try it
   * came from, and the acceptance which one the phase actually kept.
   */
  #publishedAttempts(
    repositoryId: string,
    runId: string,
  ): ReadonlyMap<string, { readonly attempt: number; readonly accepted: boolean }> {
    const accepted = this.#acceptedPublicationDigests(repositoryId, runId);
    const found = new Map<string, { readonly attempt: number; readonly accepted: boolean }>();
    for (const row of this.#database
      .prepare<
        [string],
        { content_digest: string; publication_digest: string; attempt_ordinal: number }
      >(
        `SELECT p.content_digest, p.publication_digest, a.attempt_ordinal
         FROM phase_output_publications p
         JOIN phase_attempts a ON a.attempt_digest = p.attempt_digest
         WHERE p.run_key = ? ORDER BY a.attempt_ordinal`,
      )
      .all(canonicalStringify([repositoryId, runId]))) {
      const held = found.get(row.content_digest);
      // The same bytes can be published by more than one attempt. The accepted
      // one is the answer; failing that, the latest.
      if (held !== undefined && (held.accepted || held.attempt > row.attempt_ordinal)) continue;
      found.set(row.content_digest, {
        attempt: row.attempt_ordinal,
        accepted: accepted.has(row.publication_digest),
      });
    }
    return found;
  }

  /**
   * The publications a phase closed over.
   *
   * A closure records them on the run, which is where the driver writes them.
   * The acceptance table is filled by a consumer that hands the closure back,
   * and a driven run never does.
   */
  #acceptedPublicationDigests(repositoryId: string, runId: string): ReadonlySet<string> {
    const accepted = new Set<string>();
    const row = this.#runtimeRecordRow(repositoryId, runId);
    if (row === undefined) return accepted;
    const records = requiredJsonRecord(
      decodeDurableJsonValue(row.records_json),
      "Portal runtime records",
    );
    for (const lifecycle of runtimeLifecycleRecords(records)) {
      const closure = optionalJsonRecord(lifecycle.closure);
      const acceptances = Array.isArray(closure?.outputAcceptances)
        ? closure.outputAcceptances
        : [];
      for (const entry of acceptances) {
        const acceptance = optionalJsonRecord(entry);
        if (typeof acceptance?.publicationDigest === "string")
          accepted.add(acceptance.publicationDigest);
      }
    }
    return accepted;
  }

  /** The gate evidence each phase was judged by, named so a reader can fetch it. */ #phaseGateDigests(
    repositoryId: string,
    runId: string,
  ): ReadonlyMap<string, string> {
    const digests = new Map<string, string>();
    const row = this.#runtimeRecordRow(repositoryId, runId);
    if (row === undefined) return digests;
    const records = requiredJsonRecord(
      decodeDurableJsonValue(row.records_json),
      "Portal runtime records",
    );
    for (const lifecycle of runtimeLifecycleRecords(records)) {
      const phase = optionalJsonRecord(lifecycle.phase);
      const gate = optionalJsonRecord(lifecycle.gateEvidence);
      const evaluation = gate === undefined ? undefined : optionalJsonRecord(gate.evaluation);
      if (typeof phase?.phaseId !== "string") continue;
      if (typeof evaluation?.evaluationDigest !== "string") continue;
      digests.set(phase.phaseId, evaluation.evaluationDigest);
    }
    return digests;
  }

  #graphNodeStatuses(
    repositoryId: string,
    runId: string,
    graph: WorkflowGraph,
  ): ReadonlyMap<string, PortalNodeStatus> {
    const runKey = canonicalStringify([repositoryId, runId]);
    const superseded = new Set<string>(
      graph.edges.filter((edge) => edge.kind === "supersedes").map((edge) => edge.to),
    );
    const attempts = new Map<string, PortalPhaseAttemptFacts>();
    for (const row of this.#database
      .prepare<[string], PortalPhaseAttemptRow>(
        `SELECT a.phase_id, a.definition_generation, a.attempt_ordinal, t.disposition
         FROM phase_attempts a
         LEFT JOIN phase_attempt_transitions t ON t.attempt_digest = a.attempt_digest
         WHERE a.run_key = ?
         ORDER BY a.phase_id, a.definition_generation, a.attempt_ordinal`,
      )
      .all(runKey)) {
      const key = generationKey(row.phase_id, row.definition_generation);
      const prior = attempts.get(key);
      attempts.set(key, {
        latestAttempt: row.attempt_ordinal,
        latestDisposition: row.disposition,
        closed: (prior?.closed ?? false) || row.disposition === "closed",
      });
    }
    const phaseEvidence = generationCounts(
      this.#database
        .prepare<[string], PortalGenerationCountRow>(
          `SELECT a.phase_id AS id, a.definition_generation AS generation, COUNT(*) AS total
           FROM phase_output_publications p
           JOIN phase_attempts a ON a.attempt_digest = p.attempt_digest
           WHERE p.run_key = ? GROUP BY a.phase_id, a.definition_generation`,
        )
        .all(runKey),
    );
    const phaseNeeds = generationCounts(
      this.#database
        .prepare<[string], PortalGenerationCountRow>(
          `SELECT phase_id AS id, definition_generation AS generation, COUNT(*) AS total
           FROM runner_integration_attempts
           WHERE run_key = ? AND state IN ('conflicted', 'target-moved', 'rework-required')
           GROUP BY phase_id, definition_generation`,
        )
        .all(runKey),
    );
    const failedTasks = generationCounts(
      this.#database
        .prepare<[string], PortalGenerationCountRow>(
          `SELECT task_id AS id, definition_generation AS generation, COUNT(*) AS total
           FROM runner_workspaces WHERE run_key = ? AND state = 'failed'
           GROUP BY task_id, definition_generation`,
        )
        .all(runKey),
    );
    const taskNeeds = generationCounts(
      this.#database
        .prepare<[string, string, string], PortalGenerationCountRow>(
          `SELECT json_extract(q.canonical_question, '$.task.taskId') AS id,
                  json_extract(q.canonical_question, '$.task.definitionGeneration') AS generation,
                  COUNT(*) AS total
           FROM context_questions q
           LEFT JOIN context_question_answers a ON a.submission_id = q.submission_id
           -- Only a question its task scope still recognises can be answered, so
           -- only that one should hold its node in an awaiting-human state.
           JOIN amendment_work_fences w
             ON w.run_key = ?
            AND w.task_id = json_extract(q.canonical_question, '$.task.taskId')
            AND w.definition_generation =
                json_extract(q.canonical_question, '$.task.definitionGeneration')
            AND w.claims_accepted = 1
            AND w.current_context_digest = json_extract(q.canonical_question, '$.contextDigest')
           WHERE q.repository_id = ? AND q.run_id = ? AND a.submission_id IS NULL
           GROUP BY id, generation`,
        )
        .all(runKey, repositoryId, runId),
    );
    const taskEvidence = generationCounts(
      this.#database
        .prepare<[string, string], PortalGenerationCountRow>(
          `SELECT json_extract(canonical_submission, '$.task.taskId') AS id,
                  json_extract(canonical_submission, '$.task.definitionGeneration') AS generation,
                  COUNT(*) AS total
           FROM context_submissions
           WHERE repository_id = ? AND run_id = ? AND submission_type = 'asset'
           GROUP BY id, generation`,
        )
        .all(repositoryId, runId),
    );
    const currentContextDigests = new Map<string, string>();
    for (const row of this.#database
      .prepare<[string], { task_id: string; generation: number; current_context_digest: string }>(
        `SELECT task_id, definition_generation AS generation, current_context_digest
         FROM amendment_work_fences WHERE run_key = ?`,
      )
      .all(runKey)) {
      currentContextDigests.set(
        generationKey(row.task_id, row.generation),
        row.current_context_digest,
      );
    }
    const dispatched = new Map<string, PortalTaskDispatchFacts>();
    for (const row of this.#database
      .prepare<[string, string], PortalTaskDispatchRow>(
        `SELECT json_extract(b.canonical_context, '$.task.taskId') AS task_id,
                json_extract(b.canonical_context, '$.task.definitionGeneration') AS generation,
                json_extract(b.canonical_context, '$.role.key') AS role_key,
                d.dispatch_id AS dispatch_id,
                b.context_digest AS context_digest
         FROM context_dispatches d JOIN context_bases b ON b.context_id = d.context_id
         WHERE d.repository_id = ? AND d.run_id = ?
         ORDER BY CAST(json_extract(d.canonical_dispatch, '$.ordinal') AS INTEGER) DESC,
                  d.dispatch_id DESC`,
      )
      .all(repositoryId, runId)) {
      if (row.task_id === null || row.generation === null) continue;
      const key = generationKey(row.task_id, row.generation);
      // A durable fence names the current context exactly, so a dispatch that
      // does not match it is superseded and must never be published as current.
      // Only an unfenced node falls back to the newest attempt, which is then
      // the only current candidate authority has. Rows arrive newest attempt
      // first because the dispatch ordinal, not its opaque digest, orders them,
      // so the first accepted row wins and later rows never displace it. The
      // surviving role label comes from that same winning row.
      const fence = currentContextDigests.get(key);
      const current = fence === undefined || fence === row.context_digest;
      const retained = dispatched.get(key);
      if (retained !== undefined && (retained.dispatchId !== undefined || !current)) continue;
      dispatched.set(key, {
        ...(current ? { dispatchId: row.dispatch_id } : {}),
        ...(row.role_key === null ? {} : { roleKey: row.role_key }),
      });
    }
    const runtime = this.#runtimeNodeFacts(repositoryId, runId);
    const mode =
      this.#database
        .prepare<[string], { mode: RunControlMode }>(
          "SELECT mode FROM run_control_state WHERE run_key = ?",
        )
        .get(runKey)?.mode ?? "running";
    const runNeeds = this.#runScopedNeedCount(runKey, mode);

    const statuses = new Map<string, PortalNodeStatus>();
    const phaseRunStates: PortalGraphNodeRunState[] = [];
    for (const node of graph.nodes) {
      const id: string = node.definition.id;
      const key = generationKey(id, node.definition.generation);
      if (node.kind === "phase") {
        const attempt = attempts.get(key);
        const lifecycle = runtime.lifecycles.get(key);
        const humanNeedCount =
          (lifecycle?.awaitingApproval === true ? 1 : 0) + (phaseNeeds.get(key) ?? 0);
        const runState: PortalGraphNodeRunState = superseded.has(id)
          ? "superseded"
          : lifecycle?.closed === true || attempt?.closed === true
            ? "accepted"
            : attempt?.latestDisposition === "escalate" || attempt?.latestDisposition === "fail"
              ? "failed"
              : humanNeedCount > 0
                ? "awaiting-human"
                : attempt !== undefined || lifecycle?.started === true
                  ? "running"
                  : "not-started";
        phaseRunStates.push(runState);
        statuses.set(id, {
          runState,
          humanNeedCount,
          evidenceCount: phaseEvidence.get(key) ?? 0,
          ...(attempt === undefined ? {} : { attempt: attempt.latestAttempt }),
        });
      } else if (node.kind === "task") {
        const disposition = runtime.acceptedTasks.get(key);
        const humanNeedCount = taskNeeds.get(key) ?? 0;
        const runState: PortalGraphNodeRunState =
          superseded.has(id) || disposition === "superseded"
            ? "superseded"
            : disposition === "blocked" || failedTasks.has(key)
              ? "failed"
              : disposition !== undefined
                ? "accepted"
                : humanNeedCount > 0
                  ? "awaiting-human"
                  : dispatched.has(key)
                    ? "running"
                    : "not-started";
        const roleKey = dispatched.get(key)?.roleKey;
        const dispatchId = dispatched.get(key)?.dispatchId;
        statuses.set(id, {
          runState,
          humanNeedCount,
          evidenceCount: taskEvidence.get(key) ?? 0,
          ...(roleKey === undefined ? {} : { roleKey }),
          ...(dispatchId === undefined ? {} : { dispatchId }),
        });
      } else if (node.kind === "criterion") {
        const disposition = runtime.criterionOutcomes.get(id);
        statuses.set(id, {
          runState: superseded.has(id)
            ? "superseded"
            : disposition === "satisfied" || disposition === "waived"
              ? "accepted"
              : disposition === "unsatisfied"
                ? "failed"
                : "not-started",
          humanNeedCount: 0,
          evidenceCount: runtime.criterionEvidence.get(id) ?? 0,
        });
      }
    }
    for (const node of graph.nodes) {
      if (node.kind !== "workflow") continue;
      statuses.set(node.definition.id, {
        runState:
          phaseRunStates.length > 0 &&
          phaseRunStates.every((state) => state === "accepted" || state === "superseded")
            ? "accepted"
            : phaseRunStates.includes("failed") || mode === "ended"
              ? "failed"
              : runNeeds > 0
                ? "awaiting-human"
                : phaseRunStates.some((state) => state !== "not-started")
                  ? "running"
                  : "not-started",
        humanNeedCount: runNeeds,
        evidenceCount: 0,
      });
    }
    return statuses;
  }

  #runtimeNodeFacts(repositoryId: string, runId: string): PortalRuntimeNodeFacts {
    const lifecycles = new Map<string, PortalPhaseLifecycleFacts>();
    const acceptedTasks = new Map<string, string>();
    const criterionOutcomes = new Map<string, string>();
    const criterionEvidence = new Map<string, number>();
    const recordsRow = this.#runtimeRecordRow(repositoryId, runId);
    if (recordsRow === undefined)
      return { lifecycles, acceptedTasks, criterionOutcomes, criterionEvidence };
    const records = requiredJsonRecord(
      decodeDurableJsonValue(recordsRow.records_json),
      "Portal runtime records",
    );
    for (const lifecycle of runtimeLifecycleRecords(records)) {
      const phase = requiredJsonRecord(lifecycle.phase, "Portal lifecycle phase");
      const key = generationKey(
        requiredStringField(phase.phaseId, "lifecycle phaseId"),
        requiredPositiveIntegerField(phase.definitionGeneration, "lifecycle definitionGeneration"),
      );
      const candidate = optionalJsonRecord(lifecycle.candidate);
      const policy = optionalJsonRecord(lifecycle.approvalPolicy);
      const assessments = Array.isArray(lifecycle.assessments) ? lifecycle.assessments : [];
      const prior = lifecycles.get(key);
      lifecycles.set(key, {
        closed: (prior?.closed ?? false) || optionalJsonRecord(lifecycle.closure) !== undefined,
        awaitingApproval:
          (prior?.awaitingApproval ?? false) ||
          (candidate !== undefined &&
            optionalJsonRecord(lifecycle.authorityDecision) === undefined &&
            policy?.policy === "approval-required"),
        started: (prior?.started ?? false) || candidate !== undefined || assessments.length > 0,
      });
      for (const entry of assessments) {
        const assessment = requiredJsonRecord(
          requiredJsonRecord(entry, "Portal accepted assessment").assessment,
          "Portal accounting assessment",
        );
        const submission = requiredJsonRecord(
          assessment.submission,
          "Portal completion submission",
        );
        const task = requiredJsonRecord(submission.task, "Portal completion task");
        acceptedTasks.set(
          generationKey(
            requiredStringField(task.taskId, "assessment taskId"),
            requiredPositiveIntegerField(
              task.definitionGeneration,
              "assessment definitionGeneration",
            ),
          ),
          requiredStringField(submission.disposition, "assessment disposition"),
        );
        for (const outcome of Array.isArray(submission.criteria) ? submission.criteria : []) {
          const record = requiredJsonRecord(outcome, "Portal criterion outcome");
          criterionOutcomes.set(
            requiredStringField(record.criterionId, "criterion outcome criterionId"),
            requiredStringField(record.disposition, "criterion outcome disposition"),
          );
        }
        for (const attachment of Array.isArray(submission.evidence) ? submission.evidence : []) {
          const criterionId = requiredJsonRecord(
            attachment,
            "Portal evidence attachment",
          ).criterionId;
          if (typeof criterionId !== "string") continue;
          criterionEvidence.set(criterionId, (criterionEvidence.get(criterionId) ?? 0) + 1);
        }
      }
    }
    return { lifecycles, acceptedTasks, criterionOutcomes, criterionEvidence };
  }

  #runScopedNeedCount(runKey: string, mode: RunControlMode): number {
    const escalations =
      this.#database
        .prepare<[string], { total: number }>(
          // The same reading as the needs list: a budget with room for what was
          // asked is not waiting for anyone, and a count that disagrees with the
          // list it heads is a badge nobody can clear.
          `SELECT COUNT(*) AS total FROM runner_escalations e
           LEFT JOIN runner_allowance_resolutions r ON r.escalation_command_id = e.command_id
           JOIN runner_budgets b
             ON b.run_key = e.run_key
            AND b.unit = json_extract(e.canonical_escalation, '$.unit')
           WHERE e.run_key = ? AND r.escalation_command_id IS NULL
             AND b.budget_limit - b.spent
                 < json_extract(e.canonical_escalation, '$.requested')`,
        )
        .get(runKey)?.total ?? 0;
    const amendments =
      this.#database
        .prepare<[string], { total: number }>(
          `SELECT COUNT(*) AS total FROM amendment_proposals p
           LEFT JOIN amendment_decisions d ON d.amendment_id = p.amendment_id
           LEFT JOIN amendment_applications a ON a.amendment_id = p.amendment_id
           LEFT JOIN amendment_withdrawals w ON w.amendment_id = p.amendment_id
           WHERE p.run_key = ? AND w.amendment_id IS NULL AND d.decision IS NOT 'reject'
             AND (d.decision IS NULL OR a.application_digest IS NULL)`,
        )
        .get(runKey)?.total ?? 0;
    if (mode !== "ending") return escalations + amendments;
    const uncertain =
      this.#database
        .prepare<[string], { total: number }>(
          `SELECT COUNT(*) AS total FROM runner_effect_intents i
           LEFT JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
             AND o.commit_cursor = (
               SELECT MAX(next.commit_cursor) FROM runner_effect_outcomes next
               WHERE next.intent_id = i.intent_id
             )
           WHERE i.run_key = ? AND (o.status IS NULL OR o.status IN ('active', 'unknown'))`,
        )
        .get(runKey)?.total ?? 0;
    return escalations + amendments + (uncertain > 0 ? 1 : 0);
  }

  #syncVector(repositoryId: string, runId: string, graphRevision: string): PortalSyncVector {
    const row = this.#database
      .prepare<
        [string, string],
        {
          cursor: number;
          workflow_revision: number;
          context_revision: number;
          runner_revision: number;
          workspace_revision: number;
          human_revision: number;
          portal_revision: number;
          transcript_revision: number;
        }
      >(
        `SELECT r.cursor, p.workflow_revision, p.context_revision,
                p.runner_revision, p.workspace_revision, p.human_revision,
                p.portal_revision, p.transcript_revision
         FROM runs r JOIN portal_run_revisions p
           ON p.repository_id = r.repository_id AND p.run_id = r.run_id
         WHERE r.repository_id = ? AND r.run_id = ?`,
      )
      .get(repositoryId, runId);
    if (row === undefined) throw new Error("Portal revision vector is missing");
    return Object.freeze({
      workflowCursor: row.cursor,
      contextRevision: row.context_revision,
      runnerRevision: row.runner_revision,
      workspaceRevision: row.workspace_revision,
      humanRevision: row.human_revision,
      portalRevision: row.portal_revision,
      transcriptRevision: row.transcript_revision,
      graphRevision,
      lifecycleRevision: row.workflow_revision,
    });
  }

  #portalRevision(repositoryId: string, runId: string): PortalRevisionRow {
    const row = this.#database
      .prepare<[string, string], PortalRevisionRow>(
        `SELECT workflow_revision, context_revision, dataflow_revision, runner_revision,
          task_frontier_revision, workspace_revision, human_revision, portal_revision,
          transcript_revision
         FROM portal_run_revisions WHERE repository_id = ? AND run_id = ?`,
      )
      .get(repositoryId, runId);
    if (row === undefined) throw new Error("Portal revision vector is missing");
    return row;
  }

  #runtimeRecordRow(repositoryId: string, runId: string) {
    return this.#database
      .prepare<[string, string], { records_json: string; projection_generated_at: string }>(
        `SELECT records_json, projection_generated_at FROM runs
         WHERE repository_id = ? AND run_id = ?
           AND records_json IS NOT NULL AND projection_generated_at IS NOT NULL`,
      )
      .get(repositoryId, runId);
  }

  #portalQuestionRecord(
    repositoryId: string,
    runId: string,
    row: PortalQuestionQueryRow,
  ): PortalQuestionRecord {
    const submission = requiredJsonRecord(
      decodeCanonicalJsonValue(row.canonical_question),
      "Portal question submission",
    );
    const task = requiredJsonRecord(submission.task, "Portal question task");
    const question = requiredJsonRecord(submission.question, "Portal question body");
    const event =
      row.canonical_event === null
        ? undefined
        : requiredJsonRecord(
            decodeCanonicalJsonValue(row.canonical_event),
            "Portal question event",
          );
    const submittedAt =
      typeof event?.occurredAt === "string"
        ? event.occurredAt
        : this.#runTimestamp(repositoryId, runId);
    const source = {
      submissionId: row.submission_id,
      dispatchId: requiredStringField(submission.dispatchId, "question dispatchId"),
      taskId: requiredStringField(task.taskId, "question taskId"),
      definitionGeneration: requiredPositiveIntegerField(
        task.definitionGeneration,
        "question definitionGeneration",
      ),
      contextId: requiredStringField(submission.contextId, "question contextId"),
      contextDigest: requiredDigestField(submission.contextDigest, "question contextDigest"),
      contextRevisionDigest: requiredDigestField(
        task.contextRevisionDigest,
        "question contextRevisionDigest",
      ),
      questionDigest: this.dependencies.sha256.digest(canonicalBytes(question)),
      submittedAt,
    };
    const answer =
      row.answer_id === null ||
      row.answer_digest === null ||
      row.canonical_answer === null ||
      row.principal_digest === null ||
      row.answered_at === null
        ? undefined
        : {
            answerId: row.answer_id,
            answerDigest: row.answer_digest,
            answeredAt: row.answered_at,
            answeredBy: row.principal_digest,
            answer: decodeCanonicalJsonValue(row.canonical_answer),
          };
    if (answer !== undefined && row.requirement_digest === null) {
      throw new Error("Answered portal question is missing its fresh dispatch requirement");
    }
    return decodePortalQuestionRecord({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      source,
      prompt: requiredStringField(question.prompt, "question prompt"),
      ...(Object.hasOwn(question, "details") ? { details: question.details } : {}),
      ...(answer === undefined ? {} : { answer }),
      freshDispatch:
        row.requirement_digest === null
          ? { status: "not-required" }
          : row.satisfied_by_dispatch_id === null
            ? {
                requirementId: row.requirement_digest,
                status: "pending",
                createdAt: row.created_at ?? submittedAt,
              }
            : {
                requirementId: row.requirement_digest,
                status: "satisfied",
                createdAt: row.created_at ?? submittedAt,
                satisfiedAt: this.#runTimestamp(repositoryId, runId),
                dispatchId: row.satisfied_by_dispatch_id,
              },
    });
  }

  #artifactMetadata(
    submission: Readonly<Record<string, JsonValue>>,
    asset: Readonly<Record<string, JsonValue>>,
  ): PortalArtifactMetadata {
    const digestValue = requiredDigestField(asset.contentDigest, "asset contentDigest");
    const descriptor = this.#assetDescriptor(digestValue);
    const verified =
      descriptor !== undefined &&
      descriptor.byteLength === asset.byteLength &&
      (descriptor.mediaType ?? asset.mediaType) === asset.mediaType &&
      this.#verifyAssetDescriptor(descriptor);
    const task = requiredJsonRecord(submission.task, "Portal asset task");
    return {
      artifactId: requiredStringField(asset.assetId, "assetId"),
      source: "worker",
      contentDigest: digestValue,
      byteLength: requiredNonNegativeIntegerField(asset.byteLength, "asset byteLength"),
      mediaType: requiredStringField(asset.mediaType, "asset mediaType"),
      summary: requiredStringField(asset.summary, "asset summary"),
      availability: verified ? "verified-stored" : "metadata-only",
      taskId: requiredStringField(task.taskId, "asset taskId"),
      definitionGeneration: requiredPositiveIntegerField(
        task.definitionGeneration,
        "asset definitionGeneration",
      ),
    };
  }

  #assetDescriptor(digestValue: string): AssetDescriptor | undefined {
    const row = this.#database
      .prepare<[string], AssetRow>(
        "SELECT digest, byte_length, media_type, relative_path FROM assets WHERE digest = ?",
      )
      .get(digestValue);
    return row === undefined ? undefined : toAssetDescriptor(row);
  }

  #verifyAssetDescriptor(descriptor: AssetDescriptor): boolean {
    const path = resolveAssetPath(this.assetDirectory, descriptor.relativePath);
    verifyAssetBytes(path, descriptor, this.dependencies);
    return true;
  }

  #verifiedArtifactBytes(metadata: PortalArtifactMetadata): Uint8Array {
    const descriptor = this.#assetDescriptor(metadata.contentDigest);
    if (
      descriptor === undefined ||
      descriptor.byteLength !== metadata.byteLength ||
      (descriptor.mediaType ?? metadata.mediaType) !== metadata.mediaType
    ) {
      throw new Error("Portal artifact bytes do not match exact metadata");
    }
    return Uint8Array.from(
      verifyAssetBytes(
        resolveAssetPath(this.assetDirectory, descriptor.relativePath),
        descriptor,
        this.dependencies,
      ),
    );
  }

  #runTimestamp(repositoryId: string, runId: string): string {
    return (
      this.#database
        .prepare<
          [string, string],
          { changed_at: string | null; projection_generated_at: string | null }
        >(
          `SELECT c.changed_at, r.projection_generated_at FROM runs r
           LEFT JOIN run_control_state c ON c.run_key = r.run_key
           WHERE r.repository_id = ? AND r.run_id = ?`,
        )
        .get(repositoryId, runId)?.changed_at ??
      this.#database
        .prepare<[string, string], { projection_generated_at: string | null }>(
          "SELECT projection_generated_at FROM runs WHERE repository_id = ? AND run_id = ?",
        )
        .get(repositoryId, runId)?.projection_generated_at ??
      "1970-01-01T00:00:00.000Z"
    );
  }

  /**
   * A question can only be answered while its asking dispatch still holds the
   * task scope. Once a later attempt takes the scope over, the authority
   * refuses every answer as `stale-question`, so listing the question offers a
   * person work they cannot do and buries the needs they can act on.
   */
  #questionStillAnswerable(
    repositoryId: string,
    runId: string,
    taskId: string,
    definitionGeneration: number,
    contextDigest: string,
  ): boolean {
    const currentness = this.#database
      .prepare<
        [string, string, number],
        { claims_accepted: number; current_context_digest: string }
      >(
        `SELECT claims_accepted, current_context_digest FROM amendment_work_fences
         WHERE run_key = ? AND task_id = ? AND definition_generation = ?`,
      )
      .get(canonicalStringify([repositoryId, runId]), taskId, definitionGeneration);
    return (
      currentness?.claims_accepted === 1 && currentness.current_context_digest === contextDigest
    );
  }

  #humanNeeds(repositoryId: string, runId: string): readonly PortalHumanNeed[] {
    const sourceRevision = this.#portalRevision(repositoryId, runId).human_revision;
    const needs: PortalHumanNeed[] = [];
    for (const row of this.#database
      .prepare<
        [string, string],
        { submission_id: string; canonical_question: string; created_at: string | null }
      >(
        `SELECT q.submission_id, q.canonical_question, f.created_at
         FROM context_questions q
         LEFT JOIN context_question_answers a ON a.submission_id = q.submission_id
         LEFT JOIN context_fresh_dispatch_requirements f ON f.submission_id = q.submission_id
         WHERE q.repository_id = ? AND q.run_id = ? AND a.submission_id IS NULL
         ORDER BY q.rowid`,
      )
      .all(repositoryId, runId)) {
      const submission = requiredJsonRecord(
        decodeCanonicalJsonValue(row.canonical_question),
        "Portal question need",
      );
      const task = requiredJsonRecord(submission.task, "Portal question need task");
      const question = requiredJsonRecord(submission.question, "Portal question need body");
      const questionDigest = this.dependencies.sha256.digest(canonicalBytes(question));
      if (
        !this.#questionStillAnswerable(
          repositoryId,
          runId,
          requiredStringField(task.taskId, "question taskId"),
          requiredPositiveIntegerField(task.definitionGeneration, "question definitionGeneration"),
          requiredStringField(submission.contextDigest, "question contextDigest"),
        )
      ) {
        continue;
      }
      needs.push({
        needId: `need_question:${row.submission_id}`,
        kind: "question",
        sourceId: row.submission_id,
        sourceDigest: questionDigest,
        sourceRevision,
        title: requiredStringField(question.prompt, "question prompt"),
        createdAt: row.created_at ?? this.#runTimestamp(repositoryId, runId),
        taskId: requiredStringField(task.taskId, "question taskId"),
        definitionGeneration: requiredPositiveIntegerField(
          task.definitionGeneration,
          "question definitionGeneration",
        ),
        exactObjectDigest: questionDigest,
        allowedCommands: ["answer-question"],
      });
    }
    const recordsRow = this.#runtimeRecordRow(repositoryId, runId);
    if (recordsRow !== undefined) {
      const records = requiredJsonRecord(
        decodeDurableJsonValue(recordsRow.records_json),
        "Portal runtime records",
      );
      for (const lifecycle of runtimeLifecycleRecords(records)) {
        const candidate = optionalJsonRecord(lifecycle.candidate);
        const decision = optionalJsonRecord(lifecycle.authorityDecision);
        const policy = optionalJsonRecord(lifecycle.approvalPolicy);
        if (
          candidate !== undefined &&
          decision === undefined &&
          policy?.policy === "approval-required"
        ) {
          const candidateDigest = requiredDigestField(
            candidate.candidateDigest,
            "candidate digest",
          );
          const phase = requiredJsonRecord(candidate.phase, "candidate phase");
          needs.push({
            needId: `need_candidate:${candidateDigest}`,
            kind: "candidate-approval",
            sourceId: candidateDigest,
            sourceDigest: candidateDigest,
            sourceRevision,
            title: `Review phase ${requiredStringField(phase.phaseId, "candidate phaseId")}`,
            createdAt: recordsRow.projection_generated_at,
            expectedGraphRevision: requiredDigestField(
              candidate.graphRevisionDigest,
              "candidate graph revision",
            ),
            exactObjectDigest: candidateDigest,
            allowedCommands: ["record-authority-decision"],
          });
        }
      }
    }
    for (const amendment of this.#database
      .prepare<
        [string],
        {
          amendment_id: string;
          proposal_digest: string;
          base_graph_revision_digest: string;
          canonical_proposal: string;
          decision: string | null;
          application_digest: string | null;
          withdrawn: number;
        }
      >(
        `SELECT p.amendment_id, p.proposal_digest, p.base_graph_revision_digest,
                p.canonical_proposal, d.decision, a.application_digest,
                CASE WHEN w.amendment_id IS NULL THEN 0 ELSE 1 END AS withdrawn
         FROM amendment_proposals p
         LEFT JOIN amendment_decisions d ON d.amendment_id = p.amendment_id
         LEFT JOIN amendment_applications a ON a.amendment_id = p.amendment_id
         LEFT JOIN amendment_withdrawals w ON w.amendment_id = p.amendment_id
         WHERE p.run_key = ? ORDER BY p.amendment_id`,
      )
      .all(canonicalStringify([repositoryId, runId]))) {
      if (amendment.withdrawn === 1 || amendment.decision === "reject") continue;
      const proposal = requiredJsonRecord(
        decodeCanonicalJsonValue(amendment.canonical_proposal),
        "Portal amendment proposal",
      );
      const createdAt =
        timestampField(proposal.occurredAt) ?? this.#runTimestamp(repositoryId, runId);
      if (amendment.decision === null) {
        needs.push({
          needId: `need_amendment:${amendment.amendment_id}`,
          kind: "amendment-decision",
          sourceId: amendment.amendment_id,
          sourceDigest: amendment.proposal_digest,
          sourceRevision,
          title: `Review amendment ${amendment.amendment_id}`,
          createdAt,
          expectedGraphRevision: amendment.base_graph_revision_digest,
          exactObjectDigest: amendment.proposal_digest,
          allowedCommands: ["record-amendment-decision", "withdraw-amendment-proposal"],
        });
      } else if (amendment.application_digest === null) {
        needs.push({
          needId: `need_amendment-application:${amendment.amendment_id}`,
          kind: "amendment-application",
          sourceId: amendment.amendment_id,
          sourceDigest: amendment.proposal_digest,
          sourceRevision,
          title: `Amendment ${amendment.amendment_id} awaits trusted application`,
          createdAt,
          expectedGraphRevision: amendment.base_graph_revision_digest,
          exactObjectDigest: amendment.proposal_digest,
          allowedCommands: [],
        });
      }
    }
    for (const escalation of this.#database
      .prepare<[string], { command_id: string; canonical_escalation: string }>(
        // A budget with room for what was asked is not waiting for anyone.
        // Several members can each raise a request before a person sees any of
        // them, and one grant gives all of them the room they asked for, but
        // only the request that was granted gets a resolution row. The rest
        // stayed listed for ever, each offering a button that could never do
        // anything, because the thing they asked for had already happened.
        `SELECT e.command_id, e.canonical_escalation FROM runner_escalations e
         LEFT JOIN runner_allowance_resolutions r ON r.escalation_command_id = e.command_id
         JOIN runner_budgets b
           ON b.run_key = e.run_key
          AND b.unit = json_extract(e.canonical_escalation, '$.unit')
         WHERE e.run_key = ? AND r.escalation_command_id IS NULL
           AND b.budget_limit - b.spent
               < json_extract(e.canonical_escalation, '$.requested')
         ORDER BY e.command_id`,
      )
      .all(canonicalStringify([repositoryId, runId]))) {
      const body = requiredJsonRecord(
        decodeCanonicalJsonValue(escalation.canonical_escalation),
        "Portal escalation",
      );
      const escalationDigest = this.dependencies.sha256.digest(canonicalBytes(body));
      const allowance = this.getAllowanceReview(repositoryId, runId, escalation.command_id);
      // An escalation is raised by one piece of work. Rendering it as a run-level
      // need loses what asked, what it was doing, and how much it had spent.
      const escalatedTaskId = typeof body.taskId === "string" ? body.taskId : undefined;
      const escalatedGeneration =
        typeof body.definitionGeneration === "number" ? body.definitionGeneration : undefined;
      needs.push({
        needId: `need_escalation:${escalation.command_id}`,
        kind: "escalation",
        sourceId: escalation.command_id,
        sourceDigest: escalationDigest,
        sourceRevision,
        title: `Budget allowance requested for ${requiredStringField(body.unit, "escalation unit")}`,
        createdAt: requiredStringField(body.createdAt, "escalation createdAt"),
        ...(escalatedTaskId === undefined ? {} : { taskId: escalatedTaskId }),
        ...(escalatedGeneration === undefined ? {} : { definitionGeneration: escalatedGeneration }),
        exactObjectDigest: escalationDigest,
        allowedCommands:
          allowance?.escalationDigest === escalationDigest ? ["grant-allowance"] : [],
      });
    }
    for (const integration of this.#database
      .prepare<[string], { integration_id: string; state: string; fan_in_digest: string }>(
        `SELECT integration_id, state, fan_in_digest FROM runner_integration_attempts
         WHERE run_key = ? AND state IN ('conflicted', 'target-moved', 'rework-required')
         ORDER BY integration_id`,
      )
      .all(canonicalStringify([repositoryId, runId]))) {
      needs.push({
        needId: `need_integration:${integration.integration_id}`,
        kind:
          integration.state === "rework-required" ? "integration-rework" : "integration-conflict",
        sourceId: integration.integration_id,
        sourceDigest: integration.fan_in_digest,
        sourceRevision,
        title:
          integration.state === "rework-required"
            ? `Integration ${integration.integration_id} requires bounded rework`
            : `Integration ${integration.integration_id} requires conflict review`,
        createdAt: this.#runTimestamp(repositoryId, runId),
        exactObjectDigest: integration.fan_in_digest,
        allowedCommands: [],
      });
    }
    const runControl = this.#database
      .prepare<[string], { mode: RunControlMode }>(
        "SELECT mode FROM run_control_state WHERE run_key = ?",
      )
      .get(canonicalStringify([repositoryId, runId]));
    if (runControl?.mode === "ending") {
      const uncertain =
        this.#database
          .prepare<[string], { count: number }>(
            `SELECT COUNT(*) AS count FROM runner_effect_intents i
           LEFT JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
             AND o.commit_cursor = (
               SELECT MAX(next.commit_cursor) FROM runner_effect_outcomes next
               WHERE next.intent_id = i.intent_id
             )
           WHERE i.run_key = ? AND (o.status IS NULL OR o.status IN ('active', 'unknown'))`,
          )
          .get(canonicalStringify([repositoryId, runId]))?.count ?? 0;
      if (uncertain > 0) {
        const digestValue = this.dependencies.sha256.digest(
          canonicalBytes({ runId, mode: "ending", uncertain }),
        );
        needs.push({
          needId: `need_ending:${runId}`,
          kind: "ending-uncertain",
          sourceId: runId,
          sourceDigest: digestValue,
          sourceRevision,
          title: `${uncertain} effect${uncertain === 1 ? "" : "s"} remain uncertain while ending`,
          createdAt: this.#runTimestamp(repositoryId, runId),
          exactObjectDigest: digestValue,
          allowedCommands: [],
        });
      }
    }
    return Object.freeze(
      needs.sort((left, right) =>
        left.needId < right.needId ? -1 : left.needId > right.needId ? 1 : 0,
      ),
    );
  }
}

function validatePortalLimit(limit: number, maximum: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new TypeError(
      `Portal page limit must be a positive safe integer no greater than ${maximum}`,
    );
  }
}

interface PortalNodeStatus {
  readonly runState: PortalGraphNodeRunState;
  readonly humanNeedCount: number;
  readonly evidenceCount: number;
  readonly attempt?: number;
  readonly roleKey?: string;
  readonly dispatchId?: string;
}

interface PortalPhaseAttemptRow {
  readonly phase_id: string;
  readonly definition_generation: number;
  readonly attempt_ordinal: number;
  readonly disposition: string | null;
}

interface PortalPhaseAttemptFacts {
  readonly latestAttempt: number;
  readonly latestDisposition: string | null;
  readonly closed: boolean;
}

interface PortalPhaseLifecycleFacts {
  readonly closed: boolean;
  readonly awaitingApproval: boolean;
  readonly started: boolean;
}

interface PortalRuntimeNodeFacts {
  readonly lifecycles: ReadonlyMap<string, PortalPhaseLifecycleFacts>;
  readonly acceptedTasks: ReadonlyMap<string, string>;
  readonly criterionOutcomes: ReadonlyMap<string, string>;
  readonly criterionEvidence: ReadonlyMap<string, number>;
}

interface PortalGenerationCountRow {
  readonly id: string | null;
  readonly generation: number | null;
  readonly total: number;
}

interface PortalTaskDispatchRow {
  readonly task_id: string | null;
  readonly generation: number | null;
  readonly role_key: string | null;
  readonly dispatch_id: string;
  readonly context_digest: string;
}

interface PortalTaskDispatchFacts {
  readonly dispatchId?: string;
  readonly roleKey?: string;
}

interface PortalTranscriptRow {
  readonly sequence: number;
  readonly occurred_at: string;
  readonly stream: string;
  readonly text: string;
  /** Present only for the run projection scope, which merges many capture owners. */
  readonly owner?: Readonly<{ kind: string; id: string }>;
}

const NOT_STARTED_NODE_STATUS: PortalNodeStatus = Object.freeze({
  runState: "not-started",
  humanNeedCount: 0,
  evidenceCount: 0,
});

function generationKey(id: string, generation: number): string {
  return `${id}@${generation}`;
}

function generationCounts(rows: readonly PortalGenerationCountRow[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.id === null || row.generation === null) continue;
    counts.set(generationKey(row.id, row.generation), row.total);
  }
  return counts;
}

function requiredJsonRecord(
  value: JsonValue | undefined,
  subject: string,
): Readonly<Record<string, JsonValue>> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} must be a canonical object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function optionalJsonRecord(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return value === undefined ? undefined : requiredJsonRecord(value, "Portal optional record");
}

function requiredStringField(value: JsonValue | undefined, subject: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${subject} must be a non-empty string`);
  }
  return value;
}

function requiredDigestField(value: JsonValue | undefined, subject: string): string {
  const digestValue = requiredStringField(value, subject);
  if (!isSha256Digest(digestValue)) throw new Error(`${subject} must be a SHA-256 digest`);
  return digestValue;
}

function requiredNonNegativeIntegerField(value: JsonValue | undefined, subject: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${subject} must be a non-negative safe integer`);
  }
  return value;
}

function requiredPositiveIntegerField(value: JsonValue | undefined, subject: string): number {
  const numberValue = requiredNonNegativeIntegerField(value, subject);
  if (numberValue < 1) throw new Error(`${subject} must be positive`);
  return numberValue;
}

function timestampField(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    validateTimestamp(value, "portal timestamp");
    return value;
  } catch {
    return undefined;
  }
}

function runtimeLifecycleRecords(
  records: Readonly<Record<string, JsonValue>>,
): readonly Readonly<Record<string, JsonValue>>[] {
  const history = records.phaseLifecycles;
  if (history === undefined) return [records];
  if (!Array.isArray(history)) throw new Error("Portal phase lifecycle history must be an array");
  return history.map((record) => requiredJsonRecord(record, "Portal phase lifecycle"));
}

function findRuntimeReviewRecord(
  value: JsonValue,
  kind: Exclude<PortalRecordKind, "escalation">,
  expectedDigest: string,
): JsonValue | undefined {
  const records = requiredJsonRecord(value, "Portal runtime review records");
  for (const lifecycle of runtimeLifecycleRecords(records)) {
    const candidate = optionalJsonRecord(lifecycle.candidate);
    if (kind === "candidate" && candidate?.candidateDigest === expectedDigest) return candidate;
    const gate = optionalJsonRecord(lifecycle.gateEvidence);
    const evaluation = gate === undefined ? undefined : optionalJsonRecord(gate.evaluation);
    if (kind === "gate" && evaluation?.evaluationDigest === expectedDigest) return gate;
    const decision = optionalJsonRecord(lifecycle.authorityDecision);
    if (kind === "decision" && decision?.decisionDigest === expectedDigest) return decision;
    const closure = optionalJsonRecord(lifecycle.closure);
    if (kind === "closure" && closure?.closureDigest === expectedDigest) return closure;
  }
  return undefined;
}

function findCandidateGateEvidenceDigest(
  value: JsonValue,
  candidateDigest: string,
): string | undefined {
  const records = requiredJsonRecord(value, "Portal runtime review records");
  for (const lifecycle of runtimeLifecycleRecords(records)) {
    const candidate = optionalJsonRecord(lifecycle.candidate);
    const gate = optionalJsonRecord(lifecycle.gateEvidence);
    const evaluation = gate === undefined ? undefined : optionalJsonRecord(gate.evaluation);
    if (
      candidate?.candidateDigest === candidateDigest &&
      typeof evaluation?.evaluationDigest === "string"
    ) {
      return evaluation.evaluationDigest;
    }
  }
  return undefined;
}

function integrationAttemptOrdinal(integrationId: string): number {
  const match = /(?:attempt|rework)[-_:](\d+)(?:$|[-_:])/u.exec(integrationId);
  if (match?.[1] === undefined) return 1;
  const ordinal = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : 1;
}

function integrationDiagnosticForState(
  state: string,
): { readonly code: string; readonly summary: string } | undefined {
  switch (state) {
    case "conflicted":
      return Object.freeze({
        code: "integration-conflict",
        summary:
          "The integration attempt reported a conflict. Inspect the repository through trusted CLI tooling.",
      });
    case "target-moved":
      return Object.freeze({
        code: "integration-target-moved",
        summary:
          "The integration target changed before publication. A fresh bounded attempt is required.",
      });
    case "rework-required":
      return Object.freeze({
        code: "integration-rework-required",
        summary: "Semantic validation requested one bounded successor attempt.",
      });
    default:
      return undefined;
  }
}

function validatePortalOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("Portal page cursor must be a non-negative safe integer");
  }
}

function verifyPortalRevisionTables(database: Database.Database): void {
  const missing = database
    .prepare<[], { count: number }>(
      `SELECT COUNT(*) AS count
       FROM runs r LEFT JOIN portal_run_revisions p
         ON p.repository_id = r.repository_id AND p.run_id = r.run_id
       WHERE p.run_id IS NULL`,
    )
    .get()?.count;
  const invalid = database
    .prepare<[], { count: number }>(
      `SELECT COUNT(*) AS count FROM portal_run_revisions
       WHERE portal_revision < workflow_revision
          OR portal_revision < context_revision
          OR portal_revision < runner_revision
          OR portal_revision < workspace_revision
          OR portal_revision < human_revision`,
    )
    .get()?.count;
  if (missing !== 0 || invalid !== 0) {
    throw new Error("SQLite portal revision vectors do not match run authority");
  }
}

function isHumanAuthorityIntent(intent: CommandEnvelope["intent"]["type"]): boolean {
  return [
    "answer-question",
    "steer-agent",
    "override-member",
    "grant-allowance",
    "pause-run",
    "resume-run",
    "end-run",
  ].includes(intent);
}

function trustedRefusal(code: string, message: string): TrustedHumanAuthorityDecision {
  return Object.freeze({ refusal: Object.freeze({ code, message }) });
}

function buildTrustedHumanAuthorityDecision(
  database: Database.Database,
  service: RuntimeCommandService,
  command: CommandEnvelope,
  currentTime: string,
  dependencies: RuntimeDependencies,
): TrustedHumanAuthorityDecision {
  const control = readRunControl(database, command.repositoryId, command.runId);
  if (control === undefined) {
    return trustedRefusal("run-control-unavailable", "Run control is not initialized");
  }
  if (
    (command.intent.type === "answer-question" ||
      command.intent.type === "steer-agent" ||
      command.intent.type === "grant-allowance") &&
    (control.mode === "ending" || control.mode === "ended")
  ) {
    return trustedRefusal("run-ending", "Run no longer accepts human authority commands");
  }
  switch (command.intent.type) {
    case "answer-question":
      return buildTrustedQuestionAnswer(database, command, currentTime, dependencies);
    case "steer-agent":
      return buildTrustedAgentSteering(database, command, currentTime, dependencies);
    case "override-member":
      return buildTrustedMemberOverride(database, command, currentTime, dependencies);
    case "grant-allowance":
      return buildTrustedAllowanceGrant(
        database,
        service,
        command,
        control,
        currentTime,
        dependencies,
      );
    case "pause-run":
    case "resume-run":
    case "end-run":
      return buildTrustedRunControl(command, control, currentTime);
    default:
      return trustedRefusal("unsupported-intent", "Intent has no human authority implementation");
  }
}

function buildTrustedQuestionAnswer(
  database: Database.Database,
  command: CommandEnvelope,
  currentTime: string,
  dependencies: RuntimeDependencies,
): TrustedHumanAuthorityDecision {
  const payload = decodeAnswerQuestionPayload(command.payload);
  const existing = database
    .prepare<[string], { command_id: string }>(
      "SELECT command_id FROM context_question_answers WHERE submission_id = ?",
    )
    .get(payload.submissionId);
  if (existing !== undefined) {
    return trustedRefusal("question-already-answered", "Question already has an immutable answer");
  }
  const row = database
    .prepare<
      [string],
      {
        repository_id: string;
        run_id: string;
        canonical_question: string;
      }
    >(
      `SELECT repository_id, run_id, canonical_question
       FROM context_questions WHERE submission_id = ?`,
    )
    .get(payload.submissionId);
  if (
    row === undefined ||
    row.repository_id !== command.repositoryId ||
    row.run_id !== command.runId
  ) {
    return trustedRefusal("unknown-question", "Question does not exist in this run");
  }
  const question = decodeCanonicalJsonValue(row.canonical_question);
  if (
    !isPlainRecord(question) ||
    !isPlainRecord(question.question) ||
    !isPlainRecord(question.task) ||
    typeof question.dispatchId !== "string" ||
    typeof question.contextId !== "string" ||
    typeof question.contextDigest !== "string" ||
    typeof question.task.taskId !== "string" ||
    typeof question.task.definitionGeneration !== "number" ||
    typeof question.task.contextRevisionDigest !== "string"
  ) {
    throw new Error("Stored question record is malformed");
  }
  const source = database
    .prepare<[string, string], { context_digest: string }>(
      `SELECT b.context_digest FROM context_dispatches d
       JOIN context_bases b ON b.context_id = d.context_id
       WHERE d.dispatch_id = ? AND d.context_id = ?`,
    )
    .get(question.dispatchId, question.contextId);
  if (source === undefined || source.context_digest !== question.contextDigest) {
    throw new Error("Stored question lacks its exact trusted dispatch context");
  }
  const taskId = question.task.taskId;
  const definitionGeneration = question.task.definitionGeneration;
  const currentness = database
    .prepare<[string, string, number], { claims_accepted: number; current_context_digest: string }>(
      `SELECT claims_accepted, current_context_digest FROM amendment_work_fences
       WHERE run_key = ? AND task_id = ? AND definition_generation = ?`,
    )
    .get(canonicalStringify([command.repositoryId, command.runId]), taskId, definitionGeneration);
  const questionDigest = dependencies.sha256.digest(canonicalBytes(question.question));
  if (
    payload.questionDigest !== questionDigest ||
    command.exactObjectDigest !== questionDigest ||
    payload.contextDigest !== source.context_digest ||
    payload.taskId !== taskId ||
    payload.definitionGeneration !== definitionGeneration ||
    command.expectedDefinitionRevision !== question.task.contextRevisionDigest ||
    currentness?.current_context_digest !== source.context_digest ||
    currentness.claims_accepted !== 1
  ) {
    return trustedRefusal(
      "stale-question",
      "Question answer guards do not match current authority",
    );
  }
  const answerDigest = dependencies.sha256.digest(canonicalBytes(payload.answer));
  const requirementDigest = dependencies.sha256.digest(
    canonicalBytes({
      submissionId: payload.submissionId,
      historicalDispatchId: question.dispatchId,
      questionDigest,
      contextDigest: source.context_digest,
      answerDigest,
      taskId,
      definitionGeneration,
    }),
  );
  return Object.freeze({
    result: Object.freeze({
      submissionId: payload.submissionId,
      questionDigest,
      answerDigest,
      requirementDigest,
      historicalDispatchId: question.dispatchId,
      contextDigest: source.context_digest,
      taskId,
      definitionGeneration,
      answeredAt: currentTime,
    }),
  });
}

/**
 * Validates a person's redirection of an agent that is already working.
 *
 * The dispatch has to exist and still be the current one for its task. Steering
 * a dispatch that has already been superseded would record an instruction
 * nobody will ever read, and the person who gave it would have no way to tell.
 */
/**
 * Validates a person accepting work the run judged unfinished.
 *
 * The dispatch has to exist and to have finished. Overriding work that is still
 * running would accept an outcome nobody has seen yet, and the person would be
 * vouching for something that had not happened.
 */
function buildTrustedMemberOverride(
  database: Database.Database,
  command: CommandEnvelope,
  currentTime: string,
  dependencies: RuntimeDependencies,
): TrustedHumanAuthorityDecision {
  const payload = decodeOverrideMemberPayload(command.payload);
  const row = database
    .prepare<[string], { repository_id: string; run_id: string }>(
      "SELECT repository_id, run_id FROM context_dispatches WHERE dispatch_id = ?",
    )
    .get(payload.dispatchId);
  if (
    row === undefined ||
    row.repository_id !== command.repositoryId ||
    row.run_id !== command.runId
  ) {
    return trustedRefusal("unknown-dispatch", "Dispatch does not exist in this run");
  }
  const existing = database
    .prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM context_member_overrides WHERE dispatch_id = ?",
    )
    .get(payload.dispatchId);
  if (existing !== undefined) {
    return trustedRefusal("already-overridden", "This work already carries an override");
  }
  return Object.freeze({
    result: Object.freeze({
      overrideId: `override_${dependencies.sha256
        .digest(canonicalBytes({ dispatchId: payload.dispatchId, reason: payload.reason }))
        .slice(0, 32)}`,
      dispatchId: payload.dispatchId,
      taskId: payload.taskId,
      definitionGeneration: payload.definitionGeneration,
      reason: payload.reason,
      overriddenAt: currentTime,
    }),
  });
}

function buildTrustedAgentSteering(
  database: Database.Database,
  command: CommandEnvelope,
  currentTime: string,
  dependencies: RuntimeDependencies,
): TrustedHumanAuthorityDecision {
  const payload = decodeSteerAgentPayload(command.payload);
  const row = database
    .prepare<[string], { context_digest: string; repository_id: string; run_id: string }>(
      `SELECT b.context_digest, d.repository_id, d.run_id
       FROM context_dispatches d
       JOIN context_bases b ON b.context_id = d.context_id
       WHERE d.dispatch_id = ?`,
    )
    .get(payload.dispatchId);
  if (
    row === undefined ||
    row.repository_id !== command.repositoryId ||
    row.run_id !== command.runId
  ) {
    return trustedRefusal("unknown-dispatch", "Dispatch does not exist in this run");
  }
  if (row.context_digest !== payload.contextDigest) {
    return trustedRefusal(
      "stale-steering",
      "Dispatch has moved on from the context this steering was written against",
    );
  }
  const terminal = database
    .prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM context_terminal_completions WHERE dispatch_id = ?",
    )
    .get(payload.dispatchId);
  if (terminal !== undefined) {
    return trustedRefusal("agent-finished", "Agent has already finished this dispatch");
  }
  const instructionDigest = dependencies.sha256.digest(canonicalBytes(payload.instruction));
  return Object.freeze({
    result: Object.freeze({
      steeringId: `steering_${instructionDigest.slice(0, 32)}`,
      dispatchId: payload.dispatchId,
      contextDigest: payload.contextDigest,
      taskId: payload.taskId,
      definitionGeneration: payload.definitionGeneration,
      delivery: payload.delivery,
      instruction: payload.instruction,
      instructionDigest,
      steeredAt: currentTime,
    }),
  });
}

function buildTrustedAllowanceGrant(
  database: Database.Database,
  service: RuntimeCommandService,
  command: CommandEnvelope,
  control: RunControlState,
  currentTime: string,
  dependencies: RuntimeDependencies,
): TrustedHumanAuthorityDecision {
  const payload = decodeGrantAllowancePayload(command.payload);
  const runKey = canonicalStringify([command.repositoryId, command.runId]);
  if (
    database
      .prepare<[string], { present: number }>(
        "SELECT 1 AS present FROM runner_allowance_resolutions WHERE escalation_command_id = ?",
      )
      .get(payload.escalationCommandId) !== undefined
  ) {
    return trustedRefusal("allowance-already-resolved", "Escalation already has a resolution");
  }
  const row = database
    .prepare<
      [string, string],
      { canonical_escalation: string; budget_limit: number; canonical_policy: string }
    >(
      `SELECT e.canonical_escalation, b.budget_limit, p.canonical_policy
       FROM runner_escalations e
       JOIN runner_budgets b ON b.run_key = e.run_key
       JOIN runner_allowance_policies p ON p.run_key = e.run_key
       WHERE e.run_key = ? AND e.command_id = ? AND b.unit = json_extract(e.canonical_escalation, '$.unit')`,
    )
    .get(runKey, payload.escalationCommandId);
  if (row === undefined) {
    return trustedRefusal("unknown-escalation", "Escalation or allowance policy does not exist");
  }
  const escalation = decodeCanonicalJsonValue(row.canonical_escalation);
  const policy = decodeCanonicalJsonValue(row.canonical_policy);
  if (!isPlainRecord(escalation) || !isPlainRecord(policy) || !Array.isArray(policy.ceilings)) {
    throw new Error("Stored escalation allowance authority is malformed");
  }
  const escalationDigest = dependencies.sha256.digest(canonicalBytes(escalation));
  const runtimePolicy = service.queryRunExecution(
    command.repositoryId,
    command.runId,
  )?.allowancePolicy;
  const currentGraphRevision = service.queryRunScheduling(command.repositoryId, command.runId)
    ?.graph.revisionDigest;
  const ceiling = policy.ceilings.find(
    (value) => isPlainRecord(value) && value.unit === payload.unit,
  );
  if (
    escalation.commandId !== payload.escalationCommandId ||
    escalation.operationId !== payload.operationId ||
    escalation.unit !== payload.unit ||
    payload.escalationDigest !== escalationDigest ||
    command.exactObjectDigest !== escalationDigest ||
    runtimePolicy === undefined ||
    canonicalStringify(runtimePolicy) !== row.canonical_policy ||
    payload.policyDigest !== runtimePolicy.policyDigest ||
    command.expectedGraphRevision !== currentGraphRevision ||
    payload.expectedLimit !== row.budget_limit ||
    payload.expectedRunModeRevision !== control.revision ||
    ceiling === undefined ||
    typeof ceiling.maximum !== "number"
  ) {
    return trustedRefusal("stale-allowance", "Allowance guards do not match current authority");
  }
  const resultingLimit = row.budget_limit + payload.increaseBy;
  if (!Number.isSafeInteger(resultingLimit) || resultingLimit > ceiling.maximum) {
    return trustedRefusal(
      "allowance-ceiling-exceeded",
      "Allowance exceeds the trusted policy ceiling",
    );
  }
  return Object.freeze({
    result: Object.freeze({
      escalationCommandId: payload.escalationCommandId,
      escalationDigest,
      policyDigest: payload.policyDigest,
      unit: payload.unit,
      priorLimit: row.budget_limit,
      increaseBy: payload.increaseBy,
      resultingLimit,
      resolvedAt: currentTime,
    }),
  });
}

function buildTrustedRunControl(
  command: CommandEnvelope,
  control: RunControlState,
  currentTime: string,
): TrustedHumanAuthorityDecision {
  const payload = decodeRunControlPayload(command.payload);
  if (payload.expectedRunModeRevision !== control.revision) {
    return trustedRefusal("stale-run-mode", "Run mode revision is stale");
  }
  let resultMode: RunControlMode;
  if (command.intent.type === "pause-run") {
    if (control.mode !== "running") {
      return trustedRefusal("run-not-running", "Only a running run can be paused");
    }
    resultMode = "paused";
  } else if (command.intent.type === "resume-run") {
    if (control.mode !== "paused") {
      return trustedRefusal("run-not-paused", "Only a paused run can be resumed");
    }
    resultMode = "running";
  } else {
    if (!command.principal.roles.includes("release-manager")) {
      return trustedRefusal("release-manager-required", "Ending a run requires release-manager");
    }
    if (control.mode === "ending" || control.mode === "ended") {
      return trustedRefusal("run-already-ending", "Run is already ending or ended");
    }
    resultMode = "ending";
  }
  return Object.freeze({
    result: Object.freeze({
      priorMode: control.mode,
      resultMode,
      priorRevision: control.revision,
      resultRevision: control.revision + 1,
      occurredAt: currentTime,
    }),
  });
}

function persistTrustedHumanAuthorityDecision(
  database: Database.Database,
  command: CommandEnvelope,
  currentTime: string,
  result: JsonValue,
  dependencies: RuntimeDependencies,
): void {
  if (!isPlainRecord(result)) throw new Error("Trusted human authority result is malformed");
  const runKey = canonicalStringify([command.repositoryId, command.runId]);
  const principal = canonicalStringify(command.principal);
  const principalDigest = dependencies.sha256.digest(canonicalBytes(command.principal));
  if (command.intent.type === "override-member") {
    const payload = decodeOverrideMemberPayload(command.payload);
    database
      .prepare(
        `INSERT INTO context_member_overrides(
           override_id, run_key, command_id, dispatch_id, task_id,
           definition_generation, reason, principal_digest, canonical_principal,
           overridden_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.overrideId,
        runKey,
        command.commandId,
        payload.dispatchId,
        payload.taskId,
        payload.definitionGeneration,
        payload.reason,
        principalDigest,
        principal,
        currentTime,
      );
    return;
  }
  if (command.intent.type === "steer-agent") {
    const payload = decodeSteerAgentPayload(command.payload);
    // Recorded before anything tries to deliver it, so a run that changes course
    // can always say who changed it and what they said.
    database
      .prepare(
        `INSERT INTO context_agent_steerings(
           steering_id, run_key, command_id, dispatch_id, context_digest,
           task_id, definition_generation, delivery, instruction,
           instruction_digest, principal_digest, canonical_principal, steered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.steeringId,
        runKey,
        command.commandId,
        payload.dispatchId,
        payload.contextDigest,
        payload.taskId,
        payload.definitionGeneration,
        payload.delivery,
        payload.instruction,
        result.instructionDigest,
        principalDigest,
        principal,
        currentTime,
      );
    return;
  }
  if (command.intent.type === "answer-question") {
    const payload = decodeAnswerQuestionPayload(command.payload);
    database
      .prepare(
        `INSERT INTO context_question_answers(
           submission_id, run_key, command_id, question_digest, context_digest,
           task_id, definition_generation, answer_digest, canonical_answer,
           principal_digest, canonical_principal, answered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payload.submissionId,
        runKey,
        command.commandId,
        result.questionDigest,
        payload.contextDigest,
        payload.taskId,
        payload.definitionGeneration,
        result.answerDigest,
        canonicalStringify(payload.answer),
        principalDigest,
        principal,
        currentTime,
      );
    database
      .prepare(
        `INSERT INTO context_fresh_dispatch_requirements(
           submission_id, run_key, historical_dispatch_id, context_digest, task_id,
           definition_generation, requirement_digest, created_at, satisfied_by_dispatch_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        payload.submissionId,
        runKey,
        result.historicalDispatchId,
        payload.contextDigest,
        payload.taskId,
        payload.definitionGeneration,
        result.requirementDigest,
        currentTime,
      );
    return;
  }
  if (command.intent.type === "grant-allowance") {
    const payload = decodeGrantAllowancePayload(command.payload);
    const update = database
      .prepare(
        `UPDATE runner_budgets SET budget_limit = ?
         WHERE run_key = ? AND unit = ? AND budget_limit = ?`,
      )
      .run(result.resultingLimit, runKey, payload.unit, payload.expectedLimit);
    if (update.changes !== 1) throw new Error("Runner budget changed during allowance grant");
    database
      .prepare(
        `INSERT INTO runner_allowance_resolutions(
           escalation_command_id, run_key, command_id, escalation_digest, policy_digest,
           unit, prior_limit, increase_by, resulting_limit, principal_digest,
           canonical_principal, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payload.escalationCommandId,
        runKey,
        command.commandId,
        payload.escalationDigest,
        payload.policyDigest,
        payload.unit,
        payload.expectedLimit,
        payload.increaseBy,
        result.resultingLimit,
        principalDigest,
        principal,
        currentTime,
      );
    return;
  }
  persistRunControlTransition(
    database,
    command,
    result,
    currentTime,
    principalDigest,
    dependencies,
  );
}

function initializeRunControl(
  database: Database.Database,
  command: CommandEnvelope,
  currentTime: string,
): void {
  database
    .prepare(
      `INSERT INTO run_control_state(
         run_key, repository_id, run_id, mode, revision, changed_at
       ) VALUES (?, ?, ?, 'running', 0, ?) ON CONFLICT(run_key) DO NOTHING`,
    )
    .run(
      canonicalStringify([command.repositoryId, command.runId]),
      command.repositoryId,
      command.runId,
      currentTime,
    );
}

function readRunControl(
  database: Database.Database,
  repositoryId: string,
  runId: string,
): RunControlState | undefined {
  const row = database
    .prepare<[string], { mode: RunControlMode; revision: number; changed_at: string }>(
      "SELECT mode, revision, changed_at FROM run_control_state WHERE run_key = ?",
    )
    .get(canonicalStringify([repositoryId, runId]));
  return row === undefined
    ? undefined
    : Object.freeze({
        repositoryId,
        runId,
        mode: row.mode,
        revision: row.revision,
        changedAt: row.changed_at,
      });
}

function assertRunAcceptsNewEffects(database: Database.Database, runKey: string): void {
  const row = database
    .prepare<[string], { mode: RunControlMode }>(
      "SELECT mode FROM run_control_state WHERE run_key = ?",
    )
    .get(runKey);
  if (row !== undefined && row.mode !== "running") {
    throw new TypeError(`Runner does not accept new effects while run is ${row.mode}`);
  }
}

function persistRunControlTransition(
  database: Database.Database,
  command: CommandEnvelope,
  result: Record<string, JsonValue>,
  currentTime: string,
  principalDigest: string,
  dependencies: RuntimeDependencies,
): void {
  const runKey = canonicalStringify([command.repositoryId, command.runId]);
  const update = database
    .prepare(
      `UPDATE run_control_state SET mode = ?, revision = ?, changed_at = ?
       WHERE run_key = ? AND mode = ? AND revision = ?`,
    )
    .run(
      result.resultMode,
      result.resultRevision,
      currentTime,
      runKey,
      result.priorMode,
      result.priorRevision,
    );
  if (update.changes !== 1) throw new Error("Run control changed during command execution");
  const event = {
    eventId: command.commandId,
    commandId: command.commandId,
    priorMode: result.priorMode,
    resultMode: result.resultMode,
    revision: result.resultRevision,
    principalDigest,
    occurredAt: currentTime,
  };
  database
    .prepare(
      `INSERT INTO run_control_events(
         run_key, revision, event_id, command_id, prior_mode, result_mode,
         principal_digest, canonical_event, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runKey,
      result.resultRevision,
      command.commandId,
      command.commandId,
      result.priorMode,
      result.resultMode,
      principalDigest,
      canonicalStringify(event),
      currentTime,
    );
  if (command.intent.type === "end-run") {
    fenceRunForEnding(
      database,
      command.repositoryId,
      command.runId,
      currentTime,
      command.commandId,
      dependencies,
    );
    advanceRunControlToEndedIfQuiescent(database, runKey, currentTime, dependencies);
  }
}

function fenceRunForEnding(
  database: Database.Database,
  repositoryId: string,
  runId: string,
  currentTime: string,
  commandId: string,
  dependencies: RuntimeDependencies,
): void {
  const state = database
    .prepare<[], { canonical_json: string }>(
      "SELECT canonical_json FROM context_authority_state WHERE singleton = 1",
    )
    .get();
  if (state === undefined) throw new Error("SQLite context authority singleton is missing");
  const authority = InMemoryContextAuthority.fromDurableCanonicalJson(
    state.canonical_json,
    dependencies.sha256,
    storedContextDispatches(database),
  );
  overlayContextTaskScopeCurrentness(database, authority);
  const contextScopes = authority
    .durableSnapshot()
    .taskScopes.filter((scope) => scope.runId === runId && scope.claimsAccepted);
  if (contextScopes.length > 0) {
    authority.installTaskScopeFences({
      repositoryId,
      runId,
      installedAt: currentTime,
      fences: contextScopes.map((scope) => ({
        scope: {
          runId: scope.runId,
          taskId: scope.taskId,
          definitionGeneration: scope.definitionGeneration,
        },
        expectedFenceGeneration: scope.fenceGeneration,
        expectedAcceptedContextDigest: scope.acceptedContextDigest,
      })),
    });
    database
      .prepare("UPDATE context_authority_state SET canonical_json = ? WHERE singleton = 1")
      .run(authority.toDurableCanonicalJsonWithoutDispatches());
    synchronizeContextTaskScopes(
      database,
      normalizeContextAuthority(authority, dependencies.sha256).taskScopes,
    );
  }
  const contextScopeKeys = new Set(
    contextScopes.map((scope) => `${scope.taskId}\0${scope.definitionGeneration}`),
  );
  const remaining = readTaskScopeCurrentness(
    database,
    canonicalStringify([repositoryId, runId]),
  ).filter(
    (scope) =>
      scope.claimsAccepted &&
      !contextScopeKeys.has(`${scope.taskId}\0${scope.definitionGeneration}`),
  );
  if (remaining.length > 0) {
    installDurableTaskScopeFences(
      database,
      {
        repositoryId,
        runId,
        installedAt: currentTime,
        fences: remaining.map((scope) => ({
          scope: {
            runId: scope.runId,
            taskId: scope.taskId,
            definitionGeneration: scope.definitionGeneration,
          },
          expectedFenceGeneration: scope.fenceGeneration,
          expectedAcceptedContextDigest: scope.acceptedContextDigest,
        })),
      },
      dependencies,
    );
  }
  database
    .prepare(
      `INSERT OR IGNORE INTO runner_cancellation_requests(
         intent_id, owner_id, fence, requested_at
       )
       SELECT i.intent_id, ?, 1, ? FROM runner_effect_intents i
       WHERE i.run_key = ? AND NOT EXISTS (
         SELECT 1 FROM runner_effect_outcomes o
         WHERE o.intent_id = i.intent_id AND o.status IN ('completed', 'failed', 'cancelled')
       )`,
    )
    .run(`run-control:${commandId}`, currentTime, canonicalStringify([repositoryId, runId]));
}

function advanceRunControlToEndedIfQuiescent(
  database: Database.Database,
  runKey: string,
  currentTime: string,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): boolean {
  const state = database
    .prepare<[string], { revision: number }>(
      "SELECT revision FROM run_control_state WHERE run_key = ? AND mode = 'ending'",
    )
    .get(runKey);
  if (state === undefined) return false;
  const pending = database
    .prepare<[string], { present: number }>(
      `SELECT 1 AS present FROM runner_effect_intents i
       WHERE i.run_key = ? AND NOT EXISTS (
         SELECT 1 FROM runner_effect_outcomes o
         WHERE o.intent_id = i.intent_id AND o.status IN ('completed', 'failed', 'cancelled')
       ) LIMIT 1`,
    )
    .get(runKey);
  if (pending !== undefined) return false;
  const revision = state.revision + 1;
  const eventId = `run-ended-${dependencies.sha256.digest(canonicalBytes({ runKey, revision }))}`;
  database
    .prepare(
      `UPDATE run_control_state SET mode = 'ended', revision = ?, changed_at = ?
       WHERE run_key = ? AND mode = 'ending' AND revision = ?`,
    )
    .run(revision, currentTime, runKey, state.revision);
  const event = {
    eventId,
    priorMode: "ending",
    resultMode: "ended",
    revision,
    occurredAt: currentTime,
  };
  database
    .prepare(
      `INSERT INTO run_control_events(
         run_key, revision, event_id, command_id, prior_mode, result_mode,
         principal_digest, canonical_event, occurred_at
       ) VALUES (?, ?, ?, NULL, 'ending', 'ended', ?, ?, ?)`,
    )
    .run(
      runKey,
      revision,
      eventId,
      dependencies.sha256.digest(canonicalBytes(event)),
      canonicalStringify(event),
      currentTime,
    );
  return true;
}

export class SqliteRunnerAuthority implements RunnerAuthorityPort {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: SqliteRunnerFaultPoint) => void) | undefined;

  constructor(options: SqliteRunnerAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = options.dependencies;
    this.#faultInjector = options.faultInjector;
    ensureSafeDirectoryPath(dirname(this.databasePath));
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  isConfigured(repositoryId: string, runId: string): boolean {
    return (
      this.#database
        .prepare<[string], { present: number }>(
          "SELECT 1 AS present FROM runner_runs WHERE run_key = ?",
        )
        .get(runnerRunKey(repositoryId, runId)) !== undefined
    );
  }

  configureRun(input: InMemoryRunnerRunInput): void {
    validateRunnerIdentity(input.repositoryId, "repositoryId");
    validateRunnerIdentity(input.runId, "runId");
    validateRunnerDigest(input.contextDigest, "contextDigest");
    validateRunnerLease(input.lease);
    const budgets = new Map<string, number>();
    for (const budget of input.budgets) {
      validateRunnerUnit(budget.unit);
      validateRunnerAmount(budget.limit, "budget limit");
      if (budgets.has(budget.unit)) throw new TypeError("Runner budget units must be unique");
      budgets.set(budget.unit, budget.limit);
    }
    const capacities = new Map<string, RunnerCapacityState>();
    for (const capacity of input.capacities ?? [
      { resource: "writer" as const, limit: 1, occupied: 0 },
    ]) {
      validateRunnerCapacityState(capacity);
      if (capacities.has(capacity.resource)) {
        throw new TypeError("Runner capacity resources must be unique");
      }
      capacities.set(capacity.resource, capacity);
    }
    const runKey = runnerRunKey(input.repositoryId, input.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      assertRunAcceptsNewEffects(this.#database, runKey);
      this.#database
        .prepare(
          `INSERT INTO runner_runs(
             run_key, repository_id, run_id, context_digest, cursor
           ) VALUES (?, ?, ?, ?, 0)`,
        )
        .run(runKey, input.repositoryId, input.runId, input.contextDigest);
      const insertBudget = this.#database.prepare(
        `INSERT INTO runner_budgets(
           run_key, unit, budget_limit, reserved, spent, unreported
         ) VALUES (?, ?, ?, 0, 0, 0)`,
      );
      for (const [unit, limit] of budgets) insertBudget.run(runKey, unit, limit);
      const insertCapacity = this.#database.prepare(
        `INSERT INTO runner_capacities(
           run_key, resource_key, capacity_limit, occupied
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const capacity of capacities.values()) {
        insertCapacity.run(runKey, capacity.resource, capacity.limit, capacity.occupied);
      }
      insertInitialTaskScopes(this.#database, input.repositoryId, input.runId, input.taskScopes);
      this.#database
        .prepare("INSERT INTO runner_projections(run_key, canonical_projection) VALUES (?, ?)")
        .run(
          runKey,
          canonicalStringify({ cursor: 0, contextDigest: input.contextDigest, effects: [] }),
        );
      this.#configureLease(runKey, input.lease);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      if (isSqliteConstraint(error)) throw new TypeError("Runner run is already configured");
      throw error;
    }
  }

  bindAllowancePolicy(
    repositoryId: string,
    runId: string,
    input: RunnerAllowancePolicy,
  ): RunnerAllowancePolicy {
    const policy = validateStorageAllowancePolicy(input);
    const canonical = canonicalStringify(policy);
    const runKey = runnerRunKey(repositoryId, runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunnerRun(repositoryId, runId);
      const existing = this.#database
        .prepare<[string], { policy_digest: string; canonical_policy: string }>(
          `SELECT policy_digest, canonical_policy FROM runner_allowance_policies
           WHERE run_key = ?`,
        )
        .get(runKey);
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO runner_allowance_policies(run_key, policy_digest, canonical_policy)
             VALUES (?, ?, ?)`,
          )
          .run(runKey, policy.policyDigest, canonical);
      } else if (
        existing.policy_digest !== policy.policyDigest ||
        existing.canonical_policy !== canonical
      ) {
        throw new TypeError("Runner allowance policy is already bound to different content");
      }
      this.#database.exec("COMMIT");
      return policy;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  enqueue(command: QueuedEffectCommand): void {
    validateRunnerCommand(command);
    const stored = snapshotRunnerValue(command);
    const runKey = runnerRunKey(command.repositoryId, command.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunnerRun(command.repositoryId, command.runId);
      assertRunAcceptsNewEffects(this.#database, runKey);
      this.#database
        .prepare(
          `INSERT INTO runner_commands(
             command_id, run_key, operation_id, sequence, canonical_command
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          stored.commandId,
          runKey,
          stored.operationId,
          stored.sequence,
          canonicalStringify(stored),
        );
      this.#appendTransition(stored, "queued", stored.queuedAt, undefined, { kind: stored.kind });
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      if (isSqliteConstraint(error)) {
        throw new TypeError("Runner command or operation identity is already queued or started");
      }
      throw error;
    }
  }
  enqueueIdempotent(command: QueuedEffectCommand): boolean {
    validateRunnerCommand(command);
    const stored = snapshotRunnerValue(command);
    const canonical = canonicalStringify(stored);
    const runKey = runnerRunKey(command.repositoryId, command.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunnerRun(command.repositoryId, command.runId);
      const existing = this.#database
        .prepare<
          [string, string, string],
          { command_id: string; operation_id: string; canonical_command: string }
        >(
          `SELECT command_id, operation_id, canonical_command FROM runner_commands
           WHERE run_key = ? AND (command_id = ? OR operation_id = ?)`,
        )
        .get(runKey, stored.commandId, stored.operationId);
      if (existing !== undefined) {
        if (
          existing.command_id !== stored.commandId ||
          existing.operation_id !== stored.operationId ||
          // A command names one decision, and `queuedAt` records when somebody
          // last asked for it rather than what it asks for. Comparing it made a
          // caller with a live clock collide with itself: the supervisor
          // re-offered the same stage on its next cycle, the identity matched,
          // the timestamp did not, and the run died on an exception nothing
          // surfaced. Everything that decides the work is still compared.
          decidedRunnerContent(existing.canonical_command) !== decidedRunnerContent(canonical)
        ) {
          throw new TypeError("Runner stage identity is already bound to different content");
        }
        this.#database.exec("COMMIT");
        return false;
      }
      assertRunAcceptsNewEffects(this.#database, runKey);
      this.#database
        .prepare(
          `INSERT INTO runner_commands(
             command_id, run_key, operation_id, sequence, canonical_command
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(stored.commandId, runKey, stored.operationId, stored.sequence, canonical);
      this.#appendTransition(stored, "queued", stored.queuedAt, undefined, { kind: stored.kind });
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  load(input: { readonly repositoryId: string; readonly runId: string }): RunnerAuthoritySnapshot {
    const run = this.#requireRunnerRun(input.repositoryId, input.runId);
    const commands = this.#database
      .prepare<[string], { canonical_command: string }>(
        `SELECT canonical_command FROM runner_commands
         WHERE run_key = ? ORDER BY sequence, command_id`,
      )
      .all(run.run_key)
      .map((row) => parseRunnerValue<QueuedEffectCommand>(row.canonical_command));
    const effects = this.#database
      .prepare<
        [string],
        {
          intent_id: string;
          canonical_intent: string;
          canonical_outcome: string | null;
          requested_at: string | null;
        }
      >(
        `SELECT i.intent_id, i.canonical_intent,
                (SELECT o.canonical_outcome FROM runner_effect_outcomes o
                 WHERE o.intent_id = i.intent_id ORDER BY o.commit_cursor DESC LIMIT 1)
                  AS canonical_outcome,
                c.requested_at
         FROM runner_effect_intents i
         LEFT JOIN runner_cancellation_requests c ON c.intent_id = i.intent_id
         WHERE i.run_key = ? ORDER BY i.intent_id`,
      )
      .all(run.run_key)
      .map((row) =>
        deepFreezeRunnerValue({
          intent: parseRunnerValue<EffectIntent>(row.canonical_intent),
          ...(row.canonical_outcome === null
            ? {}
            : { outcome: parseRunnerValue<EffectOutcome>(row.canonical_outcome) }),
          ...(row.requested_at === null ? {} : { cancellationRequestedAt: row.requested_at }),
        }),
      );
    // Only requests still waiting. The planner refuses to plan a command that
    // has escalated, which is right while nobody has answered and wrong the
    // moment somebody has: a granted allowance exists precisely so the work that
    // asked for it can run, and keeping the answered request here meant it never
    // ran again. The run then sat with room in its budget, nothing waiting on a
    // person, and no agent working.
    //
    // A grant is a decision about a budget, not about the request that happened
    // to prompt it, and only one request gets a resolution row. Siblings that
    // asked for the same unit are answered by the same grant, so what a request
    // waits for is the room, and one with room is no longer waiting.
    const escalations = this.#database
      .prepare<[string], { canonical_escalation: string }>(
        `SELECT e.canonical_escalation FROM runner_escalations e
         LEFT JOIN runner_allowance_resolutions r ON r.escalation_command_id = e.command_id
         JOIN runner_budgets b
           ON b.run_key = e.run_key
          AND b.unit = json_extract(e.canonical_escalation, '$.unit')
         WHERE e.run_key = ? AND r.escalation_command_id IS NULL
           AND b.budget_limit - b.spent
               < json_extract(e.canonical_escalation, '$.requested')
         ORDER BY e.command_id`,
      )
      .all(run.run_key)
      .map((row) => parseRunnerValue<RunnerEscalation>(row.canonical_escalation));
    const taskScopes = readTaskScopeCurrentness(this.#database, run.run_key);
    return deepFreezeRunnerValue({
      repositoryId: run.repository_id,
      runId: run.run_id,
      taskScopes,
      queuedCommands: commands,
      effects,
      escalations,
      capacities: this.queryCapacities(input.repositoryId, input.runId),
    });
  }

  assertLease(input: RunOnceInput): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(input.repositoryId, input.runId);
      this.#assertRunnerFence(run.run_key, input.lease, input.currentTime);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  ensureTaskScopesAndBudgets(input: EnsureTaskScopesAndBudgetsInput): void {
    const scopes = new Map<string, TaskScopeCurrentness>();
    for (const scope of input.taskScopes) {
      if (scope.runId !== input.runId || !scope.claimsAccepted) {
        throw new TypeError("Admitted runner task scope must match the run and accept claims");
      }
      const key = taskScopeKey(scope);
      if (scopes.has(key)) throw new TypeError("Admitted runner task scopes must be unique");
      scopes.set(key, scope);
    }
    const budgets = new Map<string, number>();
    for (const budget of input.budgets) {
      validateRunnerUnit(budget.unit);
      validateRunnerAmount(budget.limit, "budget limit");
      if (budgets.has(budget.unit)) throw new TypeError("Admitted runner budgets must be unique");
      budgets.set(budget.unit, budget.limit);
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(input.repositoryId, input.runId);
      this.#assertRunnerFence(run.run_key, input.lease, input.currentTime);
      assertRunAcceptsNewEffects(this.#database, run.run_key);
      for (const scope of scopes.values()) {
        insertInitialTaskScopes(this.#database, input.repositoryId, input.runId, [scope]);
      }
      for (const [unit, limit] of budgets) {
        const existing = this.#database
          .prepare<[string, string], { budget_limit: number }>(
            "SELECT budget_limit FROM runner_budgets WHERE run_key = ? AND unit = ?",
          )
          .get(run.run_key, unit);
        if (existing !== undefined && limit < existing.budget_limit) {
          throw new TypeError("Runner budget admission cannot reduce a durable limit");
        }
        this.#database
          .prepare(
            `INSERT INTO runner_budgets(
               run_key, unit, budget_limit, reserved, spent, unreported
             ) VALUES (?, ?, ?, 0, 0, 0)
             ON CONFLICT(run_key, unit) DO UPDATE SET budget_limit = excluded.budget_limit`,
          )
          .run(run.run_key, unit, limit);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  installTaskScopeFences(input: InstallTaskScopeFencesInput): readonly TaskScopeCurrentness[] {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunnerRun(input.repositoryId, input.runId);
      const installed = installDurableTaskScopeFences(this.#database, input, this.dependencies);
      this.#database.exec("COMMIT");
      return installed;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimEffectAttempt(request: ClaimEffectAttemptRequest): ClaimEffectAttemptResult {
    validateRunnerAttempt(request);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(request.repositoryId, request.runId);
      this.#assertRunnerFence(run.run_key, request.lease, request.currentTime);
      const intentRow = this.#database
        .prepare<[string, string], { canonical_intent: string }>(
          `SELECT canonical_intent FROM runner_effect_intents
           WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (
        intentRow === undefined ||
        intentRow.canonical_intent !== canonicalStringify(request.intent)
      ) {
        throw new TypeError("Effect claim does not match the durable intent in this run");
      }
      const replay = this.#database
        .prepare<[string, string, string], { canonical_outcome: string }>(
          `SELECT o.canonical_outcome
           FROM runner_effect_intents i
           JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
           WHERE i.run_key = ? AND i.intent_id = ? AND o.attempt_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId, request.attemptId);
      if (replay !== undefined) {
        this.#database.exec("COMMIT");
        return { type: "replay", outcome: parseRunnerValue(replay.canonical_outcome) };
      }
      const effect = this.load({
        repositoryId: request.repositoryId,
        runId: request.runId,
      }).effects.find(
        ({ intent }) => intent.command.operationId === request.intent.command.operationId,
      );
      if (effect === undefined) throw new TypeError("Runner effect intent is not configured");
      if (effect.outcome !== undefined && isRunnerTerminal(effect.outcome.status)) {
        this.#database.exec("COMMIT");
        return { type: "replay", outcome: effect.outcome };
      }
      const action = selectEffectAttemptAction(effect, request.currentTime, request.attemptId);
      const currentness = requireTaskScopeCurrentness(
        this.#database,
        run.run_key,
        request.intent.command.taskScope,
      );
      if (!sameDurableTaskScopeFence(request.taskScope, currentness)) {
        throw new TypeError("Effect claim task scope does not match durable currentness");
      }
      if (
        action === "dispatch" &&
        (!currentness.claimsAccepted ||
          !sameDurableTaskScopeFence(request.intent.command.taskScope, currentness))
      ) {
        this.#database.exec("COMMIT");
        return { type: "fenced", currentness };
      }
      const existing = this.#database
        .prepare<[string, string], { owner_id: string; fence: number }>(
          `SELECT owner_id, fence FROM runner_effect_claims
           WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (existing !== undefined && existing.fence === request.lease.fence) {
        this.#database.exec("COMMIT");
        return { type: "busy" };
      }
      this.#database
        .prepare("DELETE FROM runner_effect_claims WHERE intent_id = ?")
        .run(request.intent.command.operationId);
      this.#database
        .prepare(
          `INSERT INTO runner_effect_claims(
             intent_id, run_key, owner_id, fence, attempt_id, context_digest, origin,
             task_id, definition_generation, scope_fence_generation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.intent.command.operationId,
          run.run_key,
          request.lease.owner,
          request.lease.fence,
          request.attemptId,
          request.taskScope.acceptedContextDigest,
          action,
          request.taskScope.taskId,
          request.taskScope.definitionGeneration,
          request.taskScope.fenceGeneration,
        );
      this.#database.exec("COMMIT");
      return { type: "claimed", action, effect };
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  persistIntent(request: PersistIntentRequest): PersistIntentResult {
    validateRunnerAttempt(request);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const run = this.#requireRunnerRun(request.repositoryId, request.runId);
      this.#assertRunnerFence(run.run_key, request.lease, request.currentTime);
      const commandRow = this.#database
        .prepare<[string, string], { canonical_command: string }>(
          `SELECT canonical_command FROM runner_commands
           WHERE run_key = ? AND command_id = ?`,
        )
        .get(run.run_key, request.command.commandId);
      if (
        commandRow === undefined ||
        commandRow.canonical_command !== canonicalStringify(request.command)
      ) {
        throw new TypeError("Runner intent command is not the exact durable queued command");
      }
      const command = parseRunnerValue<QueuedEffectCommand>(commandRow.canonical_command);
      const existing = this.#database
        .prepare<[string], { canonical_intent: string }>(
          "SELECT canonical_intent FROM runner_effect_intents WHERE intent_id = ?",
        )
        .get(command.operationId);
      if (existing !== undefined) {
        this.#database.exec("COMMIT");
        committed = true;
        return { type: "persisted", intent: parseRunnerValue(existing.canonical_intent) };
      }
      const existingEscalation = this.#database
        .prepare<[string], { canonical_escalation: string }>(
          "SELECT canonical_escalation FROM runner_escalations WHERE command_id = ?",
        )
        .get(command.commandId);
      const escalationResolved =
        existingEscalation !== undefined &&
        (this.#database
          .prepare<[string], { present: number }>(
            `SELECT 1 AS present FROM runner_allowance_resolutions
             WHERE escalation_command_id = ?`,
          )
          .get(command.commandId) !== undefined ||
          // A budget is shared, so several members can run out within seconds of
          // each other and each raise its own request. One grant gives all of
          // them the room they asked for, but only the request that was named
          // gets a resolution, and one grant can resolve only one request. The
          // rest waited for ever on a decision nobody would make about them, for
          // room that already existed. What a request waits for is the room.
          this.#database
            .prepare<[string, string, string], { present: number }>(
              `SELECT 1 AS present FROM runner_budgets b
               WHERE b.run_key = ?
                 AND b.unit = json_extract(?, '$.unit')
                 AND b.budget_limit - b.spent >= json_extract(?, '$.requested')`,
            )
            .get(
              run.run_key,
              existingEscalation.canonical_escalation,
              existingEscalation.canonical_escalation,
            ) !== undefined);
      if (existingEscalation !== undefined && !escalationResolved) {
        this.#database.exec("COMMIT");
        committed = true;
        return {
          type: "escalated",
          escalation: parseRunnerValue(existingEscalation.canonical_escalation),
        };
      }
      assertRunAcceptsNewEffects(this.#database, run.run_key);
      const currentness = requireTaskScopeCurrentness(
        this.#database,
        run.run_key,
        command.taskScope,
      );
      if (
        !currentness.claimsAccepted ||
        !sameDurableTaskScopeFence(command.taskScope, currentness)
      ) {
        throw new TypeError("Runner command task scope is fenced before intent persistence");
      }
      const budget = this.#requiredBudget(run.run_key, command.budgetReservation.unit);
      const available = Math.max(0, budget.budget_limit - budget.spent - budget.reserved);
      if (command.budgetReservation.amount > available) {
        const escalation = deepFreezeRunnerValue<RunnerEscalation>({
          commandId: command.commandId,
          operationId: command.operationId,
          taskId: command.taskScope.taskId,
          definitionGeneration: command.taskScope.definitionGeneration,
          unit: budget.unit,
          requested: command.budgetReservation.amount,
          available,
          createdAt: request.currentTime,
          reason: "budget-exhausted",
        });
        this.#database
          .prepare(
            `INSERT INTO runner_escalations(command_id, run_key, canonical_escalation)
             VALUES (?, ?, ?)`,
          )
          .run(command.commandId, run.run_key, canonicalStringify(escalation));
        this.#appendTransition(
          command,
          "budget-escalated",
          request.currentTime,
          request.attemptId,
          {
            unit: budget.unit,
            requested: command.budgetReservation.amount,
            available,
          },
        );
        this.#fault("before-intent-commit");
        this.#database.exec("COMMIT");
        committed = true;
        this.#fault("after-intent-commit-before-ack");
        return { type: "escalated", escalation };
      }
      const capacityReservation = command.capacityReservation;
      if (capacityReservation !== undefined) {
        const capacity = this.#requiredCapacity(run.run_key, capacityReservation.resource);
        const availableCapacity = Math.max(0, capacity.capacity_limit - capacity.occupied);
        if (capacityReservation.amount > availableCapacity) {
          this.#database.exec("COMMIT");
          committed = true;
          return {
            type: "capacity-unavailable",
            reservation: capacityReservation,
            available: availableCapacity,
          };
        }
      }
      const intent = deepFreezeRunnerValue<EffectIntent>({
        command,
        owner: request.lease.owner,
        fence: request.lease.fence,
        attemptId: request.attemptId,
        status: "intent",
        persistedAt: request.currentTime,
      });
      this.#database
        .prepare(
          `INSERT INTO runner_effect_intents(
             intent_id, run_key, command_id, owner_id, fence, attempt_id, canonical_intent
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.operationId,
          run.run_key,
          command.commandId,
          intent.owner,
          intent.fence,
          intent.attemptId,
          canonicalStringify(intent),
        );
      this.#database
        .prepare(
          `UPDATE runner_budgets SET reserved = reserved + ?
           WHERE run_key = ? AND unit = ?`,
        )
        .run(command.budgetReservation.amount, run.run_key, command.budgetReservation.unit);
      if (capacityReservation !== undefined) {
        this.#database
          .prepare(
            `INSERT INTO runner_capacity_reservations(
               intent_id, run_key, resource_key, amount, released, reserved_at, released_at
             ) VALUES (?, ?, ?, ?, 0, ?, NULL)`,
          )
          .run(
            command.operationId,
            run.run_key,
            capacityReservation.resource,
            capacityReservation.amount,
            request.currentTime,
          );
        const capacityUpdate = this.#database
          .prepare(
            `UPDATE runner_capacities SET occupied = occupied + ?
             WHERE run_key = ? AND resource_key = ?
               AND occupied + ? <= capacity_limit`,
          )
          .run(
            capacityReservation.amount,
            run.run_key,
            capacityReservation.resource,
            capacityReservation.amount,
          );
        if (capacityUpdate.changes !== 1) {
          throw new Error("Durable writer capacity changed during intent persistence");
        }
      }
      this.#appendTransition(command, "intent", request.currentTime, request.attemptId, {
        owner: intent.owner,
        fence: intent.fence,
        contextDigest: command.contextDigest,
        inputDigest: command.inputDigest,
        budgetReservation: command.budgetReservation,
      });
      this.#fault("before-intent-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-intent-commit-before-ack");
      return { type: "persisted", intent };
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  commitEffect(request: CommitEffectRequest): EffectOutcome {
    validateRunnerAttempt(request);
    const observation = snapshotRunnerObservation(request.observation);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const run = this.#requireRunnerRun(request.repositoryId, request.runId);
      this.#assertRunnerFence(run.run_key, request.lease, request.currentTime);
      const intentRow = this.#database
        .prepare<[string, string], { canonical_intent: string }>(
          `SELECT canonical_intent FROM runner_effect_intents
           WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (
        intentRow === undefined ||
        intentRow.canonical_intent !== canonicalStringify(request.intent)
      ) {
        throw new TypeError("Effect outcome does not match the durable intent");
      }
      const replay = this.#database
        .prepare<[string, string], { canonical_outcome: string }>(
          `SELECT canonical_outcome FROM runner_effect_outcomes
           WHERE intent_id = ? AND attempt_id = ?`,
        )
        .get(request.intent.command.operationId, request.attemptId);
      if (replay !== undefined) {
        this.#database.exec("COMMIT");
        committed = true;
        return parseRunnerValue(replay.canonical_outcome);
      }
      const previousRow = this.#database
        .prepare<[string], { canonical_outcome: string }>(
          `SELECT canonical_outcome FROM runner_effect_outcomes
           WHERE intent_id = ? ORDER BY commit_cursor DESC LIMIT 1`,
        )
        .get(request.intent.command.operationId);
      const previous =
        previousRow === undefined
          ? undefined
          : parseRunnerValue<EffectOutcome>(previousRow.canonical_outcome);
      if (previous !== undefined && isRunnerTerminal(previous.status)) {
        this.#database.exec("COMMIT");
        committed = true;
        return previous;
      }
      const claim = this.#database
        .prepare<
          [string, string],
          {
            owner_id: string;
            fence: number;
            attempt_id: string;
            context_digest: string;
            origin: EffectOutcome["origin"];
            task_id: string;
            definition_generation: number;
            scope_fence_generation: number;
          }
        >(
          `SELECT owner_id, fence, attempt_id, context_digest, origin,
                  task_id, definition_generation, scope_fence_generation
           FROM runner_effect_claims WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (
        claim === undefined ||
        claim.owner_id !== request.lease.owner ||
        claim.fence !== request.lease.fence ||
        claim.attempt_id !== request.attemptId ||
        claim.context_digest !== request.intent.command.taskScope.acceptedContextDigest ||
        claim.task_id !== request.intent.command.taskScope.taskId ||
        claim.definition_generation !== request.intent.command.taskScope.definitionGeneration
      ) {
        throw new TypeError("Effect outcome does not match the live durable attempt claim");
      }
      const reservation = request.intent.command.budgetReservation;
      const usage = finalizeRunnerUsage(
        reservation,
        observation,
        isRunnerTerminal(observation.status),
      );
      const reconciliationAttempts =
        previous === undefined
          ? observation.status === "unknown"
            ? 1
            : 0
          : Math.min(
              previous.reconciliationAttempts + 1,
              request.intent.command.maxReconciliationAttempts,
            );
      const outcome = deepFreezeRunnerValue<EffectOutcome>({
        commandId: request.intent.command.commandId,
        operationId: request.intent.command.operationId,
        kind: request.intent.command.kind,
        owner: request.lease.owner,
        fence: request.lease.fence,
        attemptId: request.attemptId,
        commandTaskScope: request.intent.command.taskScope,
        claimTaskScope: {
          runId: request.runId,
          taskId: claim.task_id,
          definitionGeneration: claim.definition_generation,
          acceptedContextDigest: claim.context_digest,
          fenceGeneration: claim.scope_fence_generation,
        },
        contextDigest: request.intent.command.contextDigest,
        inputDigest: request.intent.command.inputDigest,
        status: observation.status,
        freshness: sameDurableTaskScopeFence(
          {
            runId: request.runId,
            taskId: claim.task_id,
            definitionGeneration: claim.definition_generation,
            acceptedContextDigest: claim.context_digest,
            fenceGeneration: claim.scope_fence_generation,
          },
          requireTaskScopeCurrentness(
            this.#database,
            run.run_key,
            request.intent.command.taskScope,
          ),
        )
          ? "current"
          : "stale",
        observedAt: observation.observedAt,
        reconciliationAttempts,
        usage,
        origin: claim.origin,
        ...(observation.details === undefined ? {} : { details: observation.details }),
        ...(observation.outputDigest === undefined
          ? {}
          : { outputDigest: observation.outputDigest }),
      });
      const cursor = run.cursor + 1;
      this.#database
        .prepare(
          `INSERT INTO runner_effect_outcomes(
             intent_id, attempt_id, commit_cursor, status, canonical_outcome
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          outcome.operationId,
          outcome.attemptId,
          cursor,
          outcome.status,
          canonicalStringify(outcome),
        );
      this.#database
        .prepare("DELETE FROM runner_effect_claims WHERE run_key = ? AND intent_id = ?")
        .run(run.run_key, outcome.operationId);
      if (isRunnerTerminal(outcome.status)) {
        const budget = this.#requiredBudget(run.run_key, reservation.unit);
        if (budget.reserved < reservation.amount) {
          throw new Error("Durable effect reservation exceeds reserved budget");
        }
        this.#database
          .prepare(
            `UPDATE runner_budgets
             SET reserved = reserved - ?, spent = spent + ?, unreported = unreported + ?
             WHERE run_key = ? AND unit = ?`,
          )
          .run(
            reservation.amount,
            usage.reported ?? usage.unreported,
            usage.unreported,
            run.run_key,
            reservation.unit,
          );
        const capacityReservation = request.intent.command.capacityReservation;
        if (capacityReservation !== undefined) {
          const release = this.#database
            .prepare(
              `UPDATE runner_capacity_reservations
               SET released = 1, released_at = ?
               WHERE intent_id = ? AND released = 0`,
            )
            .run(outcome.observedAt, outcome.operationId);
          if (release.changes === 1) {
            const capacity = this.#requiredCapacity(run.run_key, capacityReservation.resource);
            if (capacity.occupied < capacityReservation.amount) {
              throw new Error("Durable effect reservation exceeds occupied capacity");
            }
            this.#database
              .prepare(
                `UPDATE runner_capacities SET occupied = occupied - ?
                 WHERE run_key = ? AND resource_key = ?`,
              )
              .run(capacityReservation.amount, run.run_key, capacityReservation.resource);
          }
        }
      }
      this.#appendTransition(
        request.intent.command,
        outcome.status,
        outcome.observedAt,
        request.attemptId,
        {
          freshness: outcome.freshness,
          reconciliationAttempts: outcome.reconciliationAttempts,
          usage: outcome.usage,
          ...(outcome.outputDigest === undefined ? {} : { outputDigest: outcome.outputDigest }),
        },
      );
      if (isRunnerTerminal(outcome.status)) {
        advanceRunControlToEndedIfQuiescent(
          this.#database,
          run.run_key,
          outcome.observedAt,
          this.dependencies,
        );
      }
      this.#fault("before-outcome-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-outcome-commit-before-ack");
      return outcome;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  acquireRunLease(
    repositoryId: string,
    runId: string,
    owner: string,
    currentTime: string,
    expiresAt: string,
  ): RunnerLeaseFact {
    this.#requireRunnerRun(repositoryId, runId);
    const resourceKey = runnerLeaseResourceKey(repositoryId, runId, this.dependencies);
    const grant = acquireLeaseTransaction(this.#database, {
      resourceKey,
      ownerId: owner,
      currentTime,
      expiresAt,
    });
    return { owner: grant.ownerId, fence: grant.fence, expiresAt: grant.expiresAt };
  }

  updateContext(input: FencedRunnerContextUpdateInput): void {
    validateRunnerDigest(input.contextDigest, "contextDigest");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(input.repositoryId, input.runId);
      this.#assertRunnerFence(run.run_key, input.lease, input.currentTime);
      const activeClaim = this.#database
        .prepare<[string, number], { present: number }>(
          `SELECT 1 AS present FROM runner_effect_claims
           WHERE run_key = ? AND fence = ? LIMIT 1`,
        )
        .get(run.run_key, input.lease.fence);
      if (activeClaim !== undefined) {
        throw new TypeError("Runner context cannot change while an effect attempt is claimed");
      }
      this.#database.prepare("DELETE FROM runner_effect_claims WHERE run_key = ?").run(run.run_key);
      if (run.context_digest === input.contextDigest) {
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare("UPDATE runner_runs SET context_digest = ? WHERE run_key = ?")
        .run(input.contextDigest, run.run_key);
      this.#appendRunTransition(run.run_key, "context-updated", input.currentTime, {
        previousContextDigest: run.context_digest,
        contextDigest: input.contextDigest,
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(input: FencedRunnerCancellationInput): void {
    validateRunnerIdentity(input.operationId, "operationId");
    validateTimestamp(input.requestedAt, "requestedAt");
    if (Date.parse(input.requestedAt) > Date.parse(input.currentTime)) {
      throw new TypeError("requestedAt must not be later than currentTime");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(input.repositoryId, input.runId);
      this.#assertRunnerFence(run.run_key, input.lease, input.currentTime);
      const latest = this.#database
        .prepare<
          [string, string],
          {
            canonical_intent: string;
            requested_at: string | null;
            status: EffectOutcome["status"] | null;
          }
        >(
          `SELECT i.canonical_intent, c.requested_at, o.status
           FROM runner_effect_intents i
           LEFT JOIN runner_cancellation_requests c ON c.intent_id = i.intent_id
           LEFT JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
             AND o.commit_cursor = (
               SELECT max(latest.commit_cursor) FROM runner_effect_outcomes latest
               WHERE latest.intent_id = i.intent_id
             )
           WHERE i.run_key = ? AND i.intent_id = ?`,
        )
        .get(run.run_key, input.operationId);
      if (latest === undefined) throw new TypeError("Cannot cancel an effect without an intent");
      if (latest.status !== null && isRunnerTerminal(latest.status)) {
        this.#database.exec("COMMIT");
        return;
      }
      if (latest.requested_at !== null) {
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare(
          `INSERT INTO runner_cancellation_requests(
             intent_id, owner_id, fence, requested_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(intent_id) DO NOTHING`,
        )
        .run(input.operationId, input.lease.owner, input.lease.fence, input.requestedAt);
      const intent = parseRunnerValue<EffectIntent>(latest.canonical_intent);
      this.#appendTransition(
        intent.command,
        "cancellation-requested",
        input.requestedAt,
        undefined,
        { owner: input.lease.owner, fence: input.lease.fence },
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  queryReceipts(repositoryId: string, runId: string): readonly RunnerEffectReceipt[] {
    const run = this.#requireRunnerRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { canonical_receipt: string }>(
          "SELECT canonical_receipt FROM runner_receipts WHERE run_key = ? ORDER BY cursor",
        )
        .all(run.run_key)
        .map((row) => parseRunnerValue<RunnerEffectReceipt>(row.canonical_receipt)),
    );
  }

  queryEvents(repositoryId: string, runId: string): readonly RunnerEffectEvent[] {
    const run = this.#requireRunnerRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { canonical_event: string }>(
          "SELECT canonical_event FROM runner_events WHERE run_key = ? ORDER BY cursor",
        )
        .all(run.run_key)
        .map((row) => parseRunnerValue<RunnerEffectEvent>(row.canonical_event)),
    );
  }

  queryProjection(repositoryId: string, runId: string): RunnerProjection {
    const run = this.#requireRunnerRun(repositoryId, runId);
    const row = this.#database
      .prepare<[string], { canonical_projection: string }>(
        "SELECT canonical_projection FROM runner_projections WHERE run_key = ?",
      )
      .get(run.run_key);
    if (row === undefined) throw new Error("Runner projection is missing");
    return parseRunnerValue(row.canonical_projection);
  }

  queryBudgets(repositoryId: string, runId: string): readonly RunnerBudgetState[] {
    const run = this.#requireRunnerRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<
          [string],
          {
            unit: string;
            budget_limit: number;
            reserved: number;
            spent: number;
            unreported: number;
          }
        >(
          `SELECT unit, budget_limit, reserved, spent, unreported
           FROM runner_budgets WHERE run_key = ? ORDER BY unit`,
        )
        .all(run.run_key)
        .map((row) =>
          Object.freeze({
            unit: row.unit,
            limit: row.budget_limit,
            reserved: row.reserved,
            spent: row.spent,
            unreported: row.unreported,
          }),
        ),
    );
  }

  queryCapacities(repositoryId: string, runId: string): readonly RunnerCapacityState[] {
    const run = this.#requireRunnerRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { resource_key: "writer"; capacity_limit: number; occupied: number }>(
          `SELECT resource_key, capacity_limit, occupied
           FROM runner_capacities WHERE run_key = ? ORDER BY resource_key`,
        )
        .all(run.run_key)
        .map((row) =>
          Object.freeze({
            resource: row.resource_key,
            limit: row.capacity_limit,
            occupied: row.occupied,
          }),
        ),
    );
  }

  #appendTransition(
    command: QueuedEffectCommand,
    status: RunnerEffectReceipt["status"] | "budget-escalated",
    occurredAt: string,
    attemptId: string | undefined,
    payload: unknown,
  ): void {
    const run = this.#requireRunnerRun(command.repositoryId, command.runId);
    const cursor = run.cursor + 1;
    const receipt: RunnerEffectReceipt = {
      cursor,
      repositoryId: command.repositoryId,
      runId: command.runId,
      commandId: command.commandId,
      operationId: command.operationId,
      status: status === "budget-escalated" ? "failed" : status,
      occurredAt,
      ...(attemptId === undefined ? {} : { attemptId }),
    };
    const event: RunnerEffectEvent = {
      cursor,
      repositoryId: command.repositoryId,
      runId: command.runId,
      commandId: command.commandId,
      operationId: command.operationId,
      eventType: status === "queued" ? "effect-command-queued" : `effect-${status}`,
      occurredAt,
      payload: snapshotRunnerValue(payload) as RunnerEffectEvent["payload"],
    };
    this.#database
      .prepare("INSERT INTO runner_receipts(run_key, cursor, canonical_receipt) VALUES (?, ?, ?)")
      .run(run.run_key, cursor, canonicalStringify(receipt));
    this.#database
      .prepare(
        `INSERT INTO runner_events(run_key, cursor, event_type, canonical_event)
         VALUES (?, ?, ?, ?)`,
      )
      .run(run.run_key, cursor, event.eventType, canonicalStringify(event));
    this.#database
      .prepare("UPDATE runner_runs SET cursor = ? WHERE run_key = ?")
      .run(cursor, run.run_key);
    this.#writeProjection(run.run_key);
  }

  #appendRunTransition(
    runKey: string,
    status: "context-updated",
    occurredAt: string,
    payload: RunnerEffectEvent["payload"],
  ): void {
    const run = this.#database
      .prepare<[string], { cursor: number; repository_id: string; run_id: string }>(
        "SELECT cursor, repository_id, run_id FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (run === undefined) throw new TypeError("Runner run is not configured");
    const cursor = run.cursor + 1;
    const receipt: RunnerEffectReceipt = {
      cursor,
      repositoryId: run.repository_id,
      runId: run.run_id,
      status,
      occurredAt,
    };
    const event: RunnerEffectEvent = {
      cursor,
      repositoryId: run.repository_id,
      runId: run.run_id,
      eventType: `runner-${status}`,
      occurredAt,
      payload: snapshotRunnerValue(payload) as RunnerEffectEvent["payload"],
    };
    this.#database
      .prepare("INSERT INTO runner_receipts(run_key, cursor, canonical_receipt) VALUES (?, ?, ?)")
      .run(runKey, cursor, canonicalStringify(receipt));
    this.#database
      .prepare(
        `INSERT INTO runner_events(run_key, cursor, event_type, canonical_event)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runKey, cursor, event.eventType, canonicalStringify(event));
    this.#database
      .prepare("UPDATE runner_runs SET cursor = ? WHERE run_key = ?")
      .run(cursor, runKey);
    this.#writeProjection(runKey);
  }

  #writeProjection(runKey: string): void {
    const run = this.#database
      .prepare<[string], { cursor: number; context_digest: string }>(
        "SELECT cursor, context_digest FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (run === undefined) throw new TypeError("Runner run is not configured");
    const effects = this.#database
      .prepare<[string], { canonical_outcome: string }>(
        `SELECT o.canonical_outcome FROM runner_effect_intents i
         JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
           AND o.commit_cursor = (
             SELECT max(latest.commit_cursor) FROM runner_effect_outcomes latest
             WHERE latest.intent_id = i.intent_id
           )
         WHERE i.run_key = ? ORDER BY i.intent_id`,
      )
      .all(runKey)
      .map((row) => parseRunnerValue<EffectOutcome>(row.canonical_outcome))
      .flatMap((outcome) =>
        outcome.freshness !== "current"
          ? []
          : [
              {
                operationId: outcome.operationId,
                status: outcome.status,
                ...(outcome.outputDigest === undefined
                  ? {}
                  : { outputDigest: outcome.outputDigest }),
              },
            ],
      );
    const projection: RunnerProjection = {
      cursor: run.cursor,
      contextDigest: run.context_digest,
      effects,
    };
    this.#database
      .prepare(`UPDATE runner_projections SET canonical_projection = ? WHERE run_key = ?`)
      .run(canonicalStringify(projection), runKey);
  }

  #assertRunnerFence(runKey: string, supplied: RunnerLeaseFact, currentTime: string): void {
    validateRunnerLease(supplied);
    validateTimestamp(currentTime, "currentTime");
    const resourceKey = this.#database
      .prepare<[string], { repository_id: string; run_id: string }>(
        "SELECT repository_id, run_id FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (resourceKey === undefined) throw new TypeError("Runner run is not configured");
    const leaseKey = runnerLeaseResourceKey(
      resourceKey.repository_id,
      resourceKey.run_id,
      this.dependencies,
    );
    const lease = this.#database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(leaseKey);
    if (
      lease === undefined ||
      lease.owner_id !== supplied.owner ||
      lease.fence !== supplied.fence ||
      lease.expires_at !== supplied.expiresAt ||
      Date.parse(currentTime) >= Date.parse(lease.expires_at)
    ) {
      throw new StaleLeaseFenceError(leaseKey, supplied.fence);
    }
  }

  #configureLease(runKey: string, lease: RunnerLeaseFact): void {
    const run = this.#database
      .prepare<[string], { repository_id: string; run_id: string }>(
        "SELECT repository_id, run_id FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (run === undefined) throw new TypeError("Runner run is not configured");
    const resourceKey = runnerLeaseResourceKey(run.repository_id, run.run_id, this.dependencies);
    const existing = this.#database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(resourceKey);
    if (existing !== undefined) {
      if (
        existing.owner_id !== lease.owner ||
        existing.fence !== lease.fence ||
        existing.expires_at !== lease.expiresAt
      ) {
        throw new StaleLeaseFenceError(resourceKey, lease.fence);
      }
      return;
    }
    if (lease.fence !== 1)
      throw new TypeError("A newly configured runner lease must start at fence 1");
    this.#database
      .prepare("INSERT INTO leases(resource_key, owner_id, fence, expires_at) VALUES (?, ?, 1, ?)")
      .run(resourceKey, lease.owner, lease.expiresAt);
  }

  #requireRunnerRun(
    repositoryId: string,
    runId: string,
  ): {
    readonly run_key: string;
    readonly repository_id: string;
    readonly run_id: string;
    readonly context_digest: string;
    readonly cursor: number;
  } {
    validateRunnerIdentity(repositoryId, "repositoryId");
    validateRunnerIdentity(runId, "runId");
    const row = this.#database
      .prepare<
        [string, string],
        {
          run_key: string;
          repository_id: string;
          run_id: string;
          context_digest: string;
          cursor: number;
        }
      >(
        `SELECT run_key, repository_id, run_id, context_digest, cursor
         FROM runner_runs WHERE repository_id = ? AND run_id = ?`,
      )
      .get(repositoryId, runId);
    if (row === undefined) throw new TypeError("Runner run is not configured");
    return row;
  }

  #requiredBudget(
    runKey: string,
    unit: string,
  ): {
    readonly unit: string;
    readonly budget_limit: number;
    readonly reserved: number;
    readonly spent: number;
  } {
    const row = this.#database
      .prepare<
        [string, string],
        { unit: string; budget_limit: number; reserved: number; spent: number }
      >(
        `SELECT unit, budget_limit, reserved, spent FROM runner_budgets
         WHERE run_key = ? AND unit = ?`,
      )
      .get(runKey, unit);
    if (row === undefined) throw new TypeError("Runner command names an unknown budget unit");
    return row;
  }

  #requiredCapacity(
    runKey: string,
    resource: "writer",
  ): {
    readonly resource_key: "writer";
    readonly capacity_limit: number;
    readonly occupied: number;
  } {
    const row = this.#database
      .prepare<
        [string, string],
        { resource_key: "writer"; capacity_limit: number; occupied: number }
      >(
        `SELECT resource_key, capacity_limit, occupied FROM runner_capacities
         WHERE run_key = ? AND resource_key = ?`,
      )
      .get(runKey, resource);
    if (row === undefined) throw new TypeError("Runner command names an unknown capacity resource");
    return row;
  }

  #fault(point: SqliteRunnerFaultPoint): void {
    this.#faultInjector?.(point);
  }
}

export class SqliteWorkspaceIntegrationAuthority implements WorkspaceIntegrationAuthorityPort {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: SqliteWorkspaceAuthorityFaultPoint) => void) | undefined;

  constructor(options: SqliteWorkspaceIntegrationAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = options.dependencies;
    this.#faultInjector = options.faultInjector;
    ensureSafeDirectoryPath(dirname(this.databasePath));
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  bindRunExecution(input: RunExecutionBinding): RunExecutionBinding {
    const binding = validateRunExecutionBinding(input);
    const run = this.#requireRun(binding.repositoryId, binding.runId);
    const canonical = canonicalStringify(binding);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare<[string], { canonical_binding: string }>(
          "SELECT canonical_binding FROM runner_execution_bindings WHERE run_key = ?",
        )
        .get(run.run_key);
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO runner_execution_bindings(
               run_key, repository_id, run_id, configuration_snapshot_digest,
               workspace_mode, max_writer_concurrency, failure_policy,
               integration_ref, canonical_binding
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            run.run_key,
            binding.repositoryId,
            binding.runId,
            binding.configurationSnapshotDigest,
            binding.execution.workspaceMode,
            binding.execution.maxWriterConcurrency,
            binding.execution.failurePolicy,
            binding.execution.integrationRef ?? null,
            canonical,
          );
      } else if (existing.canonical_binding !== canonical) {
        throw new TypeError("Run execution identity is already bound to different content");
      }
      this.#database.exec("COMMIT");
      return binding;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  loadRunExecution(repositoryId: string, runId: string): RunExecutionBinding | undefined {
    const run = this.#requireRun(repositoryId, runId);
    const row = this.#database
      .prepare<[string], { canonical_binding: string }>(
        "SELECT canonical_binding FROM runner_execution_bindings WHERE run_key = ?",
      )
      .get(run.run_key);
    return row === undefined
      ? undefined
      : validateRunExecutionBinding(parseRunnerValue(row.canonical_binding));
  }

  listWorkspaces(repositoryId: string, runId: string): readonly WorkspaceRecord[] {
    const run = this.#requireRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { canonical_workspace: string }>(
          `SELECT canonical_workspace FROM runner_workspaces
           WHERE run_key = ? ORDER BY workspace_id`,
        )
        .all(run.run_key)
        .map(({ canonical_workspace }) => parseRunnerValue<WorkspaceRecord>(canonical_workspace)),
    );
  }

  listWorkspaceResults(repositoryId: string, runId: string): readonly WorkspaceResultRecord[] {
    const run = this.#requireRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { canonical_result: string }>(
          `SELECT r.canonical_result FROM runner_workspace_results r
           JOIN runner_workspaces w ON w.workspace_id = r.workspace_id
           WHERE w.run_key = ? ORDER BY r.result_id`,
        )
        .all(run.run_key)
        .map(({ canonical_result }) => parseRunnerValue<WorkspaceResultRecord>(canonical_result)),
    );
  }

  listIntegrationAttempts(
    repositoryId: string,
    runId: string,
  ): readonly IntegrationAttemptRecord[] {
    const run = this.#requireRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { canonical_attempt: string }>(
          `SELECT canonical_attempt FROM runner_integration_attempts
           WHERE run_key = ? ORDER BY integration_id`,
        )
        .all(run.run_key)
        .map(({ canonical_attempt }) =>
          parseRunnerValue<IntegrationAttemptRecord>(canonical_attempt),
        ),
    );
  }

  integrationSlotStatus(repositoryId: string):
    | {
        readonly ownerId: string;
        readonly fence: number;
        readonly expiresAt: string;
      }
    | undefined {
    validateRunnerIdentity(repositoryId, "repositoryId");
    const resourceKey = integrationSlotResourceKey(repositoryId, this.dependencies);
    const row = this.#database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(resourceKey);
    return row === undefined
      ? undefined
      : Object.freeze({
          ownerId: row.owner_id,
          fence: row.fence,
          expiresAt: row.expires_at,
        });
  }

  persistWorkspaceIntent(input: WorkspaceIntentInput): WorkspaceRecord {
    validateRunnerIdentity(input.workspaceId, "workspaceId");
    validateRunnerIdentity(input.dispatchId, "dispatchId");
    validateRunnerIdentity(input.taskId, "taskId");
    validateRunnerIdentity(input.prepareEffectId, "prepareEffectId");
    validateRunnerIdentity(input.inspectEffectId, "inspectEffectId");
    validateDefinitionGeneration(input.definitionGeneration);
    const binding = this.#requiredBinding(input.repositoryId, input.runId);
    if (binding.execution.workspaceMode !== "worktree") {
      throw new TypeError("Repository execution forbids durable workspace intents");
    }
    const baseRevision = bindGitRevision(input.baseRevision, this.dependencies.sha256);
    const record = deepFreezeRunnerValue<WorkspaceRecord>({
      repositoryId: input.repositoryId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      dispatchId: input.dispatchId,
      taskId: input.taskId,
      definitionGeneration: input.definitionGeneration,
      mode: binding.execution.workspaceMode,
      state: "intent",
      baseRevision,
      prepareEffectId: input.prepareEffectId,
      inspectEffectId: input.inspectEffectId,
    });
    const run = this.#requireRun(input.repositoryId, input.runId);
    const canonical = canonicalStringify(record);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare<[string], { canonical_workspace: string }>(
          "SELECT canonical_workspace FROM runner_workspaces WHERE workspace_id = ?",
        )
        .get(input.workspaceId);
      let result = record;
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO runner_workspaces(
               workspace_id, run_key, repository_id, dispatch_id, task_id,
               definition_generation, mode, state, base_revision_digest,
               prepare_effect_id, inspect_effect_id, canonical_workspace
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?)`,
          )
          .run(
            record.workspaceId,
            run.run_key,
            record.repositoryId,
            record.dispatchId,
            record.taskId,
            record.definitionGeneration,
            record.mode,
            record.baseRevision.descriptorDigest,
            record.prepareEffectId,
            record.inspectEffectId,
            canonical,
          );
      } else {
        const current = parseRunnerValue<WorkspaceRecord>(existing.canonical_workspace);
        if (canonicalStringify({ ...current, state: "intent" }) !== canonical) {
          throw new TypeError("Workspace identity is already bound to different content");
        }
        result = current;
      }
      this.#fault("before-workspace-intent-commit");
      this.#database.exec("COMMIT");
      this.#fault("after-workspace-intent-commit-before-ack");
      return result;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordWorkspaceState(
    repositoryId: string,
    runId: string,
    workspaceId: string,
    state: WorkspaceLifecycleState,
  ): WorkspaceRecord {
    const current = this.#requiredWorkspace(repositoryId, runId, workspaceId);
    if (!isAllowedWorkspaceTransition(current.state, state)) {
      throw new TypeError(`Workspace state cannot transition from ${current.state} to ${state}`);
    }
    if (current.state === state) return current;
    const updated = deepFreezeRunnerValue({ ...current, state });
    this.#database
      .prepare(
        `UPDATE runner_workspaces SET state = ?, canonical_workspace = ?
         WHERE workspace_id = ?`,
      )
      .run(state, canonicalStringify(updated), workspaceId);
    return updated;
  }

  persistWorkspaceResult(input: WorkspaceResultInput): WorkspaceResultRecord {
    validateRunnerIdentity(input.resultId, "resultId");
    validateRunnerIdentity(input.captureEffectId, "captureEffectId");
    validateRunnerIdentity(input.inspectEffectId, "inspectEffectId");
    validateRunnerDigest(input.completionFactDigest, "completionFactDigest");
    validateTimestamp(input.recordedAt, "recordedAt");
    const workspace = this.#requiredWorkspace(input.repositoryId, input.runId, input.workspaceId);
    if (!isAllowedWorkspaceTransition(workspace.state, "captured")) {
      throw new TypeError("Workspace result requires a prepared or capture-intent workspace");
    }
    const resultRevision = bindGitRevision(input.resultRevision, this.dependencies.sha256);
    const record = deepFreezeRunnerValue<WorkspaceResultRecord>({ ...input, resultRevision });
    const canonical = canonicalStringify(record);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare<[string], { canonical_result: string }>(
          "SELECT canonical_result FROM runner_workspace_results WHERE result_id = ?",
        )
        .get(input.resultId);
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO runner_workspace_results(
               result_id, workspace_id, result_tree_digest, result_revision_digest,
               completion_fact_digest, capture_effect_id, inspect_effect_id,
               recorded_at, canonical_result
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.resultId,
            record.workspaceId,
            bindGitObjectId(record.resultRevision.revision.tree, this.dependencies.sha256)
              .descriptorDigest,
            record.resultRevision.descriptorDigest,
            record.completionFactDigest,
            record.captureEffectId,
            record.inspectEffectId,
            record.recordedAt,
            canonical,
          );
        const updatedWorkspace = deepFreezeRunnerValue({
          ...workspace,
          state: "captured" as const,
        });
        this.#database
          .prepare(
            `UPDATE runner_workspaces SET state = 'captured', canonical_workspace = ?
             WHERE workspace_id = ?`,
          )
          .run(canonicalStringify(updatedWorkspace), workspace.workspaceId);
      } else if (existing.canonical_result !== canonical) {
        throw new TypeError("Workspace result identity is already bound to different content");
      }
      this.#fault("before-workspace-result-commit");
      this.#database.exec("COMMIT");
      this.#fault("after-workspace-result-commit-before-ack");
      return record;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  persistIntegrationIntent(input: IntegrationAttemptInput): IntegrationAttemptRecord {
    validateIntegrationAttemptInput(input, this.dependencies);
    const binding = this.#requiredBinding(input.repositoryId, input.runId);
    if (binding.execution.workspaceMode !== "worktree") {
      throw new TypeError("Repository execution forbids integration attempts");
    }
    if (input.targetRef !== binding.execution.integrationRef) {
      throw new TypeError("Integration attempt target does not match immutable execution policy");
    }
    const run = this.#requireRun(input.repositoryId, input.runId);
    const record = deepFreezeRunnerValue<IntegrationAttemptRecord>({ ...input, state: "intent" });
    const canonical = canonicalStringify(record);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare<[string], { canonical_attempt: string }>(
          "SELECT canonical_attempt FROM runner_integration_attempts WHERE integration_id = ?",
        )
        .get(input.integrationId);
      let result = record;
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO runner_integration_attempts(
               integration_id, run_key, repository_id, phase_id, definition_generation,
               target_ref, fan_in_digest, state, owner_id, fence, slot_resource_key,
               prepare_effect_id, inspect_effect_id, barrier_digest, canonical_barrier,
               canonical_attempt
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`,
          )
          .run(
            record.integrationId,
            run.run_key,
            record.repositoryId,
            record.phaseId,
            record.definitionGeneration,
            record.targetRef,
            record.fanInDigest,
            record.prepareEffectId,
            record.inspectEffectId,
            canonical,
          );
        const insertMember = this.#database.prepare(
          `INSERT INTO runner_integration_members(
             integration_id, ordinal, workspace_id, result_id, member_digest, canonical_member
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const [ordinal, member] of record.members.entries()) {
          const workspace = this.#requiredWorkspace(
            record.repositoryId,
            record.runId,
            member.workspaceId,
          );
          const result = this.#requiredResult(record.repositoryId, record.runId, member.resultId);
          if (
            member.member.baseRevisionDigest !== workspace.baseRevision.descriptorDigest ||
            member.member.resultTreeDigest !==
              bindGitObjectId(result.resultRevision.revision.tree, this.dependencies.sha256)
                .descriptorDigest ||
            member.member.completionFactDigest !== result.completionFactDigest
          ) {
            throw new TypeError("Integration member does not match its workspace result bindings");
          }
          insertMember.run(
            record.integrationId,
            ordinal,
            member.workspaceId,
            member.resultId,
            member.member.memberDigest,
            canonicalStringify(member.member),
          );
        }
      } else {
        const current = parseRunnerValue<IntegrationAttemptRecord>(existing.canonical_attempt);
        if (canonicalStringify(integrationIntentIdentity(current)) !== canonical) {
          throw new TypeError("Integration identity is already bound to different content");
        }
        result = current;
      }
      this.#fault("before-integration-intent-commit");
      this.#database.exec("COMMIT");
      this.#fault("after-integration-intent-commit-before-ack");
      return result;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimIntegrationSlot(input: IntegrationSlotClaimInput): IntegrationSlotClaimResult {
    validateRunnerIdentity(input.ownerId, "ownerId");
    validateTimestamp(input.currentTime, "currentTime");
    validateTimestamp(input.expiresAt, "expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.currentTime)) {
      throw new TypeError("Integration slot expiry must be later than currentTime");
    }
    const slotResourceKey = integrationSlotResourceKey(input.repositoryId, this.dependencies);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.#requiredIntegration(
        input.repositoryId,
        input.runId,
        input.integrationId,
      );
      const lease = this.#database
        .prepare<[string], LeaseRow>(
          "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
        )
        .get(slotResourceKey);
      if (attempt.state !== "intent") {
        if (
          attempt.ownerId === input.ownerId &&
          lease?.owner_id === input.ownerId &&
          lease.fence === attempt.fence &&
          Date.parse(lease.expires_at) > Date.parse(input.currentTime)
        ) {
          if (Date.parse(input.expiresAt) > Date.parse(lease.expires_at)) {
            this.#database
              .prepare(
                `UPDATE leases SET expires_at = ?
                 WHERE resource_key = ? AND owner_id = ? AND fence = ?`,
              )
              .run(input.expiresAt, slotResourceKey, input.ownerId, lease.fence);
          }
          this.#database.exec("COMMIT");
          return { type: "replay", attempt };
        }
        if (lease !== undefined && Date.parse(lease.expires_at) > Date.parse(input.currentTime)) {
          this.#database.exec("COMMIT");
          return { type: "busy", attempt };
        }
      }
      let fence = 1;
      if (lease === undefined) {
        this.#database
          .prepare(
            "INSERT INTO leases(resource_key, owner_id, fence, expires_at) VALUES (?, ?, 1, ?)",
          )
          .run(slotResourceKey, input.ownerId, input.expiresAt);
      } else if (Date.parse(lease.expires_at) > Date.parse(input.currentTime)) {
        if (lease.owner_id !== input.ownerId) {
          this.#database.exec("COMMIT");
          return { type: "busy", attempt };
        }
        fence = lease.fence;
        if (Date.parse(input.expiresAt) > Date.parse(lease.expires_at)) {
          this.#database
            .prepare(
              `UPDATE leases SET expires_at = ?
               WHERE resource_key = ? AND owner_id = ? AND fence = ?`,
            )
            .run(input.expiresAt, slotResourceKey, input.ownerId, fence);
        }
      } else {
        fence = lease.fence + 1;
        this.#database
          .prepare(
            `UPDATE leases SET owner_id = ?, fence = ?, expires_at = ?
             WHERE resource_key = ?`,
          )
          .run(input.ownerId, fence, input.expiresAt, slotResourceKey);
      }
      const claimed = deepFreezeRunnerValue<IntegrationAttemptRecord>({
        ...attempt,
        state: "claimed",
        ownerId: input.ownerId,
        fence,
        slotResourceKey,
      });
      this.#database
        .prepare(
          `UPDATE runner_integration_attempts
           SET state = 'claimed', owner_id = ?, fence = ?, slot_resource_key = ?,
               canonical_attempt = ?
           WHERE integration_id = ?`,
        )
        .run(
          input.ownerId,
          fence,
          slotResourceKey,
          canonicalStringify(claimed),
          input.integrationId,
        );
      this.#fault("before-integration-claim-commit");
      this.#database.exec("COMMIT");
      this.#fault("after-integration-claim-commit-before-ack");
      return { type: "claimed", attempt: claimed };
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordIntegrationState(
    repositoryId: string,
    runId: string,
    integrationId: string,
    state: IntegrationAttemptState,
    ownerId: string,
    fence: number,
    currentTime: string,
  ): IntegrationAttemptRecord {
    validateTimestamp(currentTime, "currentTime");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requiredIntegration(repositoryId, runId, integrationId);
      this.#assertIntegrationFence(current, ownerId, fence, currentTime);
      if (!isAllowedIntegrationTransition(current.state, state)) {
        throw new TypeError(
          `Integration state cannot transition from ${current.state} to ${state}`,
        );
      }
      if (current.state === state) {
        this.#database.exec("COMMIT");
        return current;
      }
      const updated = deepFreezeRunnerValue({ ...current, state });
      this.#database
        .prepare(
          `UPDATE runner_integration_attempts SET state = ?, canonical_attempt = ?
           WHERE integration_id = ?`,
        )
        .run(state, canonicalStringify(updated), integrationId);
      if (terminalIntegrationState(state) && updated.slotResourceKey !== undefined) {
        const release = this.#database
          .prepare(
            `UPDATE leases SET expires_at = '0000-01-01T00:00:00.000Z'
             WHERE resource_key = ? AND owner_id = ? AND fence = ?`,
          )
          .run(updated.slotResourceKey, ownerId, fence);
        if (release.changes !== 1) {
          throw new StaleLeaseFenceError(updated.slotResourceKey, fence);
        }
      }
      this.#database.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordIntegrationGate(
    repositoryId: string,
    runId: string,
    integrationId: string,
    gate: IntegrationGateRecord,
    ownerId: string,
    fence: number,
    currentTime: string,
  ): IntegrationAttemptRecord {
    validateIntegrationGate(gate);
    validateTimestamp(currentTime, "currentTime");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requiredIntegration(repositoryId, runId, integrationId);
      this.#assertIntegrationFence(current, ownerId, fence, currentTime);
      if (current.state !== "validating" && current.state !== "gate-failed") {
        throw new TypeError("Integration gate requires a validating attempt");
      }
      const canonicalEvidence = canonicalStringify(gate.evidence);
      const existing = this.#database
        .prepare<[string], { canonical_evidence: string; evaluation_digest: string }>(
          `SELECT canonical_evidence, evaluation_digest FROM runner_integration_gates
           WHERE integration_id = ?`,
        )
        .get(integrationId);
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO runner_integration_gates(
               integration_id, policy_digest, reading_digest, evaluation_digest,
               decision, canonical_evidence
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            integrationId,
            gate.policyDigest,
            gate.readingDigest,
            gate.evaluationDigest,
            gate.decision,
            canonicalEvidence,
          );
      } else if (
        existing.evaluation_digest !== gate.evaluationDigest ||
        existing.canonical_evidence !== canonicalEvidence
      ) {
        throw new TypeError("Integration gate is immutable once recorded");
      }
      const state = gate.decision === "passed" ? "validating" : "gate-failed";
      const updated = deepFreezeRunnerValue<IntegrationAttemptRecord>({ ...current, state, gate });
      this.#database
        .prepare(
          `UPDATE runner_integration_attempts SET state = ?, canonical_attempt = ?
           WHERE integration_id = ?`,
        )
        .run(state, canonicalStringify(updated), integrationId);
      this.#database.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordIntegrationBarrier(
    repositoryId: string,
    runId: string,
    integrationId: string,
    barrierValue: IntegrationBarrier,
    ownerId: string,
    fence: number,
    currentTime: string,
  ): IntegrationAttemptRecord {
    validateTimestamp(currentTime, "currentTime");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requiredIntegration(repositoryId, runId, integrationId);
      this.#assertIntegrationFence(current, ownerId, fence, currentTime);
      if (current.state !== "published" && current.state !== "barrier-recorded") {
        throw new TypeError("Integration barrier requires a published attempt");
      }
      const barrier = validateIntegrationBarrier(barrierValue, this.dependencies.sha256);
      assertBarrierMatchesAttempt(barrier, current);
      if (current.barrier !== undefined) {
        if (canonicalStringify(current.barrier) !== canonicalStringify(barrier)) {
          throw new TypeError("Integration barrier is immutable once recorded");
        }
        this.#database.exec("COMMIT");
        return current;
      }
      const updated = deepFreezeRunnerValue<IntegrationAttemptRecord>({
        ...current,
        state: "barrier-recorded",
        barrier,
      });
      this.#database
        .prepare(
          `UPDATE runner_integration_attempts
           SET state = 'barrier-recorded', barrier_digest = ?, canonical_barrier = ?,
               canonical_attempt = ?
           WHERE integration_id = ?`,
        )
        .run(
          barrier.barrierDigest,
          canonicalStringify(barrier),
          canonicalStringify(updated),
          integrationId,
        );
      if (updated.slotResourceKey !== undefined) {
        this.#database
          .prepare(
            `UPDATE leases SET expires_at = '0000-01-01T00:00:00.000Z'
             WHERE resource_key = ? AND owner_id = ? AND fence = ?`,
          )
          .run(updated.slotResourceKey, ownerId, fence);
      }
      this.#fault("before-integration-barrier-commit");
      this.#database.exec("COMMIT");
      this.#fault("after-integration-barrier-commit-before-ack");
      return updated;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordCompletionEligibility(input: CompletionEligibilityInput): CompletionEligibilityRecord {
    validateRunnerIdentity(input.submissionId, "submissionId");
    validateRunnerIdentity(input.dispatchId, "dispatchId");
    if (typeof input.terminalCurrentWriter !== "boolean") {
      throw new TypeError("terminalCurrentWriter must be boolean");
    }
    const binding = this.#requiredBinding(input.repositoryId, input.runId);
    let barrierDigest: string | undefined;
    let eligible = input.terminalCurrentWriter;
    if (binding.execution.workspaceMode === "repository") {
      if (
        input.workspaceId !== undefined ||
        input.resultId !== undefined ||
        input.integrationId !== undefined
      ) {
        throw new TypeError("Repository completion eligibility forbids workspace authority");
      }
    } else {
      if (
        input.workspaceId === undefined ||
        input.resultId === undefined ||
        input.integrationId === undefined
      ) {
        throw new TypeError("Worktree completion eligibility requires workspace and integration");
      }
      const workspace = this.#requiredWorkspace(input.repositoryId, input.runId, input.workspaceId);
      const result = this.#requiredResult(input.repositoryId, input.runId, input.resultId);
      const integration = this.#requiredIntegration(
        input.repositoryId,
        input.runId,
        input.integrationId,
      );
      if (
        workspace.dispatchId !== input.dispatchId ||
        result.workspaceId !== workspace.workspaceId ||
        !integration.members.some(
          (member) =>
            member.workspaceId === workspace.workspaceId &&
            member.resultId === result.resultId &&
            member.member.completionFactDigest === result.completionFactDigest,
        )
      ) {
        throw new TypeError("Completion eligibility does not match its integration member");
      }
      barrierDigest = integration.barrier?.barrierDigest;
      eligible =
        eligible &&
        ["captured", "removed"].includes(workspace.state) &&
        integration.state === "barrier-recorded" &&
        barrierDigest !== undefined;
    }
    const record = deepFreezeRunnerValue<CompletionEligibilityRecord>({
      ...input,
      mode: binding.execution.workspaceMode,
      ...(barrierDigest === undefined ? {} : { barrierDigest }),
      eligible,
    });
    const run = this.#requireRun(input.repositoryId, input.runId);
    const canonical = canonicalStringify(record);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO runner_completion_eligibility(
           submission_id, run_key, dispatch_id, mode, terminal_current_writer,
           workspace_id, result_id, integration_id, barrier_digest, eligible,
           canonical_eligibility
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(submission_id) DO UPDATE SET
           terminal_current_writer = excluded.terminal_current_writer,
           barrier_digest = excluded.barrier_digest,
           eligible = excluded.eligible,
           canonical_eligibility = excluded.canonical_eligibility`,
        )
        .run(
          record.submissionId,
          run.run_key,
          record.dispatchId,
          record.mode,
          record.terminalCurrentWriter ? 1 : 0,
          record.workspaceId ?? null,
          record.resultId ?? null,
          record.integrationId ?? null,
          record.barrierDigest ?? null,
          record.eligible ? 1 : 0,
          canonical,
        );
      this.#fault("before-completion-eligibility-commit");
      this.#database.exec("COMMIT");
      this.#fault("after-completion-eligibility-commit-before-ack");
      return record;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completionAdmission(submissionId: string): "accepted" | "deferred" {
    validateRunnerIdentity(submissionId, "submissionId");
    const row = this.#database
      .prepare<[string], { eligible: number }>(
        "SELECT eligible FROM runner_completion_eligibility WHERE submission_id = ?",
      )
      .get(submissionId);
    return row?.eligible === 1 ? "accepted" : "deferred";
  }

  #requireRun(repositoryId: string, runId: string): { readonly run_key: string } {
    validateRunnerIdentity(repositoryId, "repositoryId");
    validateRunnerIdentity(runId, "runId");
    const row = this.#database
      .prepare<[string, string], { run_key: string }>(
        "SELECT run_key FROM runner_runs WHERE repository_id = ? AND run_id = ?",
      )
      .get(repositoryId, runId);
    if (row === undefined) throw new TypeError("Runner run is not configured");
    return row;
  }

  #requiredBinding(repositoryId: string, runId: string): RunExecutionBinding {
    const binding = this.loadRunExecution(repositoryId, runId);
    if (binding === undefined) throw new TypeError("Run execution policy is not bound");
    return binding;
  }

  #requiredWorkspace(repositoryId: string, runId: string, workspaceId: string): WorkspaceRecord {
    const run = this.#requireRun(repositoryId, runId);
    const row = this.#database
      .prepare<[string, string], { canonical_workspace: string }>(
        `SELECT canonical_workspace FROM runner_workspaces
         WHERE workspace_id = ? AND run_key = ?`,
      )
      .get(workspaceId, run.run_key);
    if (row === undefined) throw new TypeError("Workspace is not configured for this run");
    return parseRunnerValue(row.canonical_workspace);
  }

  #requiredResult(repositoryId: string, runId: string, resultId: string): WorkspaceResultRecord {
    const run = this.#requireRun(repositoryId, runId);
    const row = this.#database
      .prepare<[string, string], { canonical_result: string }>(
        `SELECT r.canonical_result FROM runner_workspace_results r
         JOIN runner_workspaces w ON w.workspace_id = r.workspace_id
         WHERE r.result_id = ? AND w.run_key = ?`,
      )
      .get(resultId, run.run_key);
    if (row === undefined) throw new TypeError("Workspace result is not configured for this run");
    return parseRunnerValue(row.canonical_result);
  }

  #requiredIntegration(
    repositoryId: string,
    runId: string,
    integrationId: string,
  ): IntegrationAttemptRecord {
    const run = this.#requireRun(repositoryId, runId);
    const row = this.#database
      .prepare<[string, string], { canonical_attempt: string }>(
        `SELECT canonical_attempt FROM runner_integration_attempts
         WHERE integration_id = ? AND run_key = ?`,
      )
      .get(integrationId, run.run_key);
    if (row === undefined)
      throw new TypeError("Integration attempt is not configured for this run");
    return parseRunnerValue(row.canonical_attempt);
  }

  #assertIntegrationFence(
    attempt: IntegrationAttemptRecord,
    ownerId: string,
    fence: number,
    currentTime: string,
  ): void {
    if (
      attempt.ownerId !== ownerId ||
      attempt.fence !== fence ||
      attempt.slotResourceKey === undefined
    ) {
      throw new StaleLeaseFenceError(attempt.slotResourceKey ?? "integration-slot", fence);
    }
    const lease = this.#database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(attempt.slotResourceKey);
    if (
      lease?.owner_id !== ownerId ||
      lease.fence !== fence ||
      Date.parse(lease.expires_at) <= Date.parse(currentTime)
    ) {
      throw new StaleLeaseFenceError(attempt.slotResourceKey, fence);
    }
  }

  #fault(point: SqliteWorkspaceAuthorityFaultPoint): void {
    this.#faultInjector?.(point);
  }
}

function acquireLeaseTransaction(
  database: Database.Database,
  input: AcquireLeaseInput,
): LeaseGrant {
  validateStorageIdentifier(input.resourceKey, "resourceKey");
  validateStorageIdentifier(input.ownerId, "ownerId");
  validateTimestamp(input.currentTime, "currentTime");
  validateTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(input.expiresAt) <= Date.parse(input.currentTime)) {
    throw new TypeError("Lease expiry must be later than currentTime");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(input.resourceKey);
    let fence = 1;
    if (current === undefined) {
      database
        .prepare(
          "INSERT INTO leases(resource_key, owner_id, fence, expires_at) VALUES (?, ?, 1, ?)",
        )
        .run(input.resourceKey, input.ownerId, input.expiresAt);
    } else if (
      current.owner_id === input.ownerId &&
      Date.parse(current.expires_at) > Date.parse(input.currentTime)
    ) {
      if (Date.parse(input.expiresAt) < Date.parse(current.expires_at)) {
        throw new TypeError("Lease reacquisition must not shorten a live expiry");
      }
      fence = current.fence;
      database
        .prepare("UPDATE leases SET expires_at = ? WHERE resource_key = ?")
        .run(input.expiresAt, input.resourceKey);
    } else {
      if (
        current.owner_id !== input.ownerId &&
        Date.parse(current.expires_at) > Date.parse(input.currentTime)
      ) {
        throw new LeaseUnavailableError(input.resourceKey, current.expires_at);
      }
      fence = current.fence + 1;
      database
        .prepare("UPDATE leases SET owner_id = ?, fence = ?, expires_at = ? WHERE resource_key = ?")
        .run(input.ownerId, fence, input.expiresAt, input.resourceKey);
    }
    database.exec("COMMIT");
    return {
      resourceKey: input.resourceKey,
      ownerId: input.ownerId,
      fence,
      expiresAt: input.expiresAt,
    };
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function renewLeaseTransaction(database: Database.Database, input: RenewLeaseInput): LeaseGrant {
  validateStorageIdentifier(input.resourceKey, "resourceKey");
  validateStorageIdentifier(input.ownerId, "ownerId");
  validateTimestamp(input.currentTime, "currentTime");
  validateTimestamp(input.expiresAt, "expiresAt");
  validateTimestamp(input.newExpiresAt, "newExpiresAt");
  if (
    !Number.isSafeInteger(input.fence) ||
    input.fence <= 0 ||
    Date.parse(input.newExpiresAt) <= Date.parse(input.expiresAt) ||
    Date.parse(input.currentTime) >= Date.parse(input.expiresAt)
  ) {
    throw new TypeError("Lease renewal requires a live fence and a later expiry");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        `UPDATE leases SET expires_at = ?
         WHERE resource_key = ? AND owner_id = ? AND fence = ? AND expires_at = ?`,
      )
      .run(input.newExpiresAt, input.resourceKey, input.ownerId, input.fence, input.expiresAt);
    if (result.changes !== 1) throw new StaleLeaseFenceError(input.resourceKey, input.fence);
    database.exec("COMMIT");
    return {
      resourceKey: input.resourceKey,
      ownerId: input.ownerId,
      fence: input.fence,
      expiresAt: input.newExpiresAt,
    };
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function releaseLeaseTransaction(database: Database.Database, input: ReleaseLeaseInput): void {
  validateStorageIdentifier(input.resourceKey, "resourceKey");
  validateStorageIdentifier(input.ownerId, "ownerId");
  validateTimestamp(input.currentTime, "currentTime");
  validateTimestamp(input.expiresAt, "expiresAt");
  if (!Number.isSafeInteger(input.fence) || input.fence <= 0) {
    throw new TypeError("Lease fence must be a positive safe integer");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(input.resourceKey);
    if (
      current === undefined ||
      current.owner_id !== input.ownerId ||
      current.fence !== input.fence ||
      current.expires_at !== input.expiresAt ||
      Date.parse(input.currentTime) >= Date.parse(current.expires_at)
    ) {
      throw new StaleLeaseFenceError(input.resourceKey, input.fence);
    }
    const result = database
      .prepare(
        `UPDATE leases SET expires_at = ?
         WHERE resource_key = ? AND owner_id = ? AND fence = ? AND expires_at = ?`,
      )
      .run(input.currentTime, input.resourceKey, input.ownerId, input.fence, input.expiresAt);
    if (result.changes !== 1) throw new StaleLeaseFenceError(input.resourceKey, input.fence);
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function runnerRunKey(repositoryId: string, runId: string): string {
  return canonicalStringify([repositoryId, runId]);
}

function runnerLeaseResourceKey(
  repositoryId: string,
  runId: string,
  dependencies: RuntimeDependencies,
): string {
  const digest = dependencies.sha256.digest(
    new TextEncoder().encode(canonicalStringify([repositoryId, runId])),
  );
  if (!isSha256Digest(digest)) throw new TypeError("Invalid runner lease resource digest");
  return `runner:${digest}`;
}

function finalizeRunnerUsage(
  reservation: QueuedEffectCommand["budgetReservation"],
  observation: CommitEffectRequest["observation"],
  terminal: boolean,
): FinalizedEffectUsage {
  if (observation.usage !== undefined && observation.usage.unit !== reservation.unit) {
    throw new TypeError("Effect usage unit must match its budget reservation");
  }
  if (observation.usage !== undefined && observation.usage.amount > reservation.amount) {
    throw new TypeError("Effect reported usage must not exceed its budget reservation");
  }
  return Object.freeze({
    unit: reservation.unit,
    reserved: reservation.amount,
    ...(observation.usage === undefined ? {} : { reported: observation.usage.amount }),
    unreported: terminal && observation.usage === undefined ? reservation.amount : 0,
  });
}

function validateRunnerAttempt(request: {
  readonly repositoryId: string;
  readonly runId: string;
  readonly lease: RunnerLeaseFact;
  readonly currentTime: string;
  readonly attemptId: string;
}): void {
  validateRunnerIdentity(request.repositoryId, "repositoryId");
  validateRunnerIdentity(request.runId, "runId");
  validateRunnerLease(request.lease);
  validateTimestamp(request.currentTime, "currentTime");
  validateRunnerIdentity(request.attemptId, "attemptId");
}

function validateRunnerCommand(command: QueuedEffectCommand): void {
  if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) {
    throw new TypeError("Runner command sequence must be a positive safe integer");
  }
  validateRunnerIdentity(command.commandId, "commandId");
  validateRunnerIdentity(command.repositoryId, "repositoryId");
  validateRunnerIdentity(command.runId, "runId");
  validateRunnerIdentity(command.operationId, "operationId");
  if (
    Object.keys(command.taskScope).sort().join(",") !==
    "acceptedContextDigest,definitionGeneration,fenceGeneration,runId,taskId"
  )
    throw new TypeError("Runner command task scope must contain exactly five fields");
  if (
    command.taskScope.runId !== command.runId ||
    !Number.isSafeInteger(command.taskScope.definitionGeneration) ||
    command.taskScope.definitionGeneration < 1 ||
    !Number.isSafeInteger(command.taskScope.fenceGeneration) ||
    command.taskScope.fenceGeneration < 1
  )
    throw new TypeError("Runner command task scope is invalid");
  validateRunnerIdentity(command.taskScope.taskId, "taskScope.taskId");
  validateRunnerDigest(command.taskScope.acceptedContextDigest, "taskScope.acceptedContextDigest");
  if (command.contextDigest !== command.taskScope.acceptedContextDigest)
    throw new TypeError("Runner command context must equal its accepted task scope context");
  if (!["worker", "sensor", "git", "asset", "time"].includes(command.kind)) {
    throw new TypeError("Runner command effect kind is invalid");
  }
  validateRunnerDigest(command.contextDigest, "contextDigest");
  validateRunnerDigest(command.inputDigest, "inputDigest");
  canonicalStringify(command.input);
  validateRunnerUnit(command.budgetReservation.unit);
  validateRunnerAmount(command.budgetReservation.amount, "budget reservation");
  validateTimestamp(command.queuedAt, "queuedAt");
  if (command.deadline !== undefined) validateTimestamp(command.deadline, "deadline");
  if (
    !Number.isSafeInteger(command.maxReconciliationAttempts) ||
    command.maxReconciliationAttempts < 1
  ) {
    throw new TypeError("Runner reconciliation limit must be a positive safe integer");
  }
}

function snapshotRunnerObservation(
  observation: CommitEffectRequest["observation"],
): CommitEffectRequest["observation"] {
  if (!["active", "completed", "failed", "cancelled", "unknown"].includes(observation.status)) {
    throw new TypeError("Effect observation status is invalid");
  }
  validateTimestamp(observation.observedAt, "observedAt");
  if (observation.details !== undefined) canonicalStringify(observation.details);
  if (observation.outputDigest !== undefined) {
    validateRunnerDigest(observation.outputDigest, "outputDigest");
  }
  if (observation.usage !== undefined) {
    validateRunnerUnit(observation.usage.unit);
    validateRunnerAmount(observation.usage.amount, "reported usage");
  }
  return snapshotRunnerValue(observation);
}

function validateRunnerLease(lease: RunnerLeaseFact): void {
  validateRunnerIdentity(lease.owner, "lease owner");
  if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) {
    throw new TypeError("Lease fence must be a positive safe integer");
  }
  validateTimestamp(lease.expiresAt, "lease expiry");
}

function validateRunnerDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
}

function validateRunnerIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
}

function validateRunnerUnit(unit: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(unit)) {
    throw new TypeError("Budget unit must be a lowercase bounded key");
  }
}

function validateRunnerAmount(amount: number, subject: string): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError(`${subject} must be a non-negative safe integer`);
  }
}

function validateRunnerCapacityState(capacity: RunnerCapacityState): void {
  if (capacity.resource !== "writer") {
    throw new TypeError("Runner capacity resource must be writer");
  }
  if (!Number.isSafeInteger(capacity.limit) || capacity.limit < 1) {
    throw new TypeError("capacity limit must be a positive safe integer");
  }
  validateRunnerAmount(capacity.occupied, "occupied capacity");
  if (capacity.occupied > capacity.limit) {
    throw new TypeError("Occupied runner capacity must not exceed its limit");
  }
}

function validateRunExecutionBinding(input: RunExecutionBinding): RunExecutionBinding {
  validateRunnerIdentity(input.repositoryId, "repositoryId");
  validateRunnerIdentity(input.runId, "runId");
  validateRunnerDigest(input.configurationSnapshotDigest, "configurationSnapshotDigest");
  const execution = validateParallelExecutionPolicy(input.execution);
  const allowancePolicy = validateStorageAllowancePolicy(input.allowancePolicy);
  return deepFreezeRunnerValue({
    repositoryId: input.repositoryId,
    runId: input.runId,
    configurationSnapshotDigest: input.configurationSnapshotDigest,
    execution,
    allowancePolicy,
  });
}

function validateStorageAllowancePolicy(input: RunnerAllowancePolicy): RunnerAllowancePolicy {
  validateRunnerDigest(input.policyDigest, "allowance policy digest");
  if (!Array.isArray(input.ceilings))
    throw new TypeError("Allowance policy ceilings must be an array");
  const seen = new Set<string>();
  const ceilings = input.ceilings.map((ceiling) => {
    validateRunnerUnit(ceiling.unit);
    validateRunnerAmount(ceiling.maximum, "allowance policy maximum");
    if (seen.has(ceiling.unit)) throw new TypeError("Allowance policy units must be unique");
    seen.add(ceiling.unit);
    return { unit: ceiling.unit, maximum: ceiling.maximum };
  });
  if (
    ceilings.some((ceiling, index) => {
      const previous = ceilings[index - 1];
      return previous !== undefined && previous.unit >= ceiling.unit;
    })
  ) {
    throw new TypeError("Allowance policy ceilings must be sorted by unit");
  }
  return deepFreezeRunnerValue({ policyDigest: input.policyDigest, ceilings });
}

function validateParallelExecutionPolicy(input: ParallelExecutionPolicy): ParallelExecutionPolicy {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Execution policy must be an object");
  }
  const expectedKeys = [
    "failurePolicy",
    ...(input.workspaceMode === "worktree" ? ["integrationRef"] : []),
    "maxWriterConcurrency",
    "workspaceMode",
  ].sort();
  if (Object.keys(input).sort().join(",") !== expectedKeys.join(",")) {
    throw new TypeError("Execution policy must contain exactly its normalized fields");
  }
  if (input.workspaceMode !== "repository" && input.workspaceMode !== "worktree") {
    throw new TypeError("Execution workspaceMode must be repository or worktree");
  }
  if (input.failurePolicy !== "continue" && input.failurePolicy !== "fail-fast") {
    throw new TypeError("Execution failurePolicy must be continue or fail-fast");
  }
  if (!Number.isSafeInteger(input.maxWriterConcurrency) || input.maxWriterConcurrency < 1) {
    throw new TypeError("Execution maxWriterConcurrency must be a positive safe integer");
  }
  if (input.workspaceMode === "repository") {
    if (input.maxWriterConcurrency !== 1 || input.integrationRef !== undefined) {
      throw new TypeError("Repository execution requires one writer and no integration ref");
    }
  } else if (
    typeof input.integrationRef !== "string" ||
    !isFullLocalBranchRefForStorage(input.integrationRef)
  ) {
    throw new TypeError("Worktree execution requires a full local integration ref");
  }
  return deepFreezeRunnerValue(JSON.parse(canonicalStringify(input)) as ParallelExecutionPolicy);
}

function validateDefinitionGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("definitionGeneration must be a positive safe integer");
  }
}

function validateIntegrationAttemptInput(
  input: IntegrationAttemptInput,
  dependencies: RuntimeDependencies,
): void {
  validateRunnerIdentity(input.repositoryId, "repositoryId");
  validateRunnerIdentity(input.runId, "runId");
  validateRunnerIdentity(input.integrationId, "integrationId");
  validateRunnerIdentity(input.phaseId, "phaseId");
  validateDefinitionGeneration(input.definitionGeneration);
  validateRunnerDigest(input.fanInDigest, "fanInDigest");
  validateRunnerIdentity(input.prepareEffectId, "prepareEffectId");
  validateRunnerIdentity(input.inspectEffectId, "inspectEffectId");
  if (!isFullLocalBranchRefForStorage(input.targetRef)) {
    throw new TypeError("Integration target must be a full local branch ref");
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new TypeError("Integration attempt requires at least one member");
  }
  const identities = new Set<string>();
  let priorTaskId: string | undefined;
  for (const member of input.members) {
    validateRunnerIdentity(member.workspaceId, "workspaceId");
    validateRunnerIdentity(member.resultId, "resultId");
    validateIntegrationMember(member.member, dependencies);
    if (priorTaskId !== undefined && priorTaskId >= member.member.taskId) {
      throw new TypeError("Integration members must be task-sorted and unique");
    }
    priorTaskId = member.member.taskId;
    const identity = `${member.workspaceId}\u0000${member.resultId}`;
    if (identities.has(identity)) throw new TypeError("Integration members must be unique");
    identities.add(identity);
  }
  const expectedFanIn = canonicalDigest(
    canonicalValue({ members: input.members.map(({ member }) => member) }),
    dependencies.sha256,
  );
  if (input.fanInDigest !== expectedFanIn) {
    throw new TypeError("Integration fan-in digest does not match its exact members");
  }
}

function validateIntegrationMember(
  member: IntegrationMember,
  dependencies: RuntimeDependencies,
): void {
  validateRunnerIdentity(member.taskId, "member.taskId");
  validateDefinitionGeneration(member.definitionGeneration);
  for (const [field, value] of [
    ["contextDigest", member.contextDigest],
    ["baseRevisionDigest", member.baseRevisionDigest],
    ["resultTreeDigest", member.resultTreeDigest],
    ["completionFactDigest", member.completionFactDigest],
    ["memberDigest", member.memberDigest],
  ] as const) {
    validateRunnerDigest(value, field);
  }
  const expected = canonicalDigest(
    canonicalValue({
      taskId: member.taskId,
      definitionGeneration: member.definitionGeneration,
      contextDigest: member.contextDigest,
      baseRevisionDigest: member.baseRevisionDigest,
      resultTreeDigest: member.resultTreeDigest,
      completionFactDigest: member.completionFactDigest,
    }),
    dependencies.sha256,
  );
  if (member.memberDigest !== expected) {
    throw new TypeError("Integration member digest does not match its exact bindings");
  }
}

function validateIntegrationGate(gate: IntegrationGateRecord): void {
  validateRunnerDigest(gate.policyDigest, "policyDigest");
  validateRunnerDigest(gate.readingDigest, "readingDigest");
  validateRunnerDigest(gate.evaluationDigest, "evaluationDigest");
  if (gate.decision !== "passed" && gate.decision !== "failed") {
    throw new TypeError("Integration gate decision must be passed or failed");
  }
  canonicalStringify(gate.evidence);
}

function integrationIntentIdentity(attempt: IntegrationAttemptRecord): IntegrationAttemptRecord {
  return {
    repositoryId: attempt.repositoryId,
    runId: attempt.runId,
    integrationId: attempt.integrationId,
    phaseId: attempt.phaseId,
    definitionGeneration: attempt.definitionGeneration,
    targetRef: attempt.targetRef,
    fanInDigest: attempt.fanInDigest,
    members: attempt.members,
    prepareEffectId: attempt.prepareEffectId,
    inspectEffectId: attempt.inspectEffectId,
    state: "intent",
  };
}

function assertBarrierMatchesAttempt(
  barrier: IntegrationBarrier,
  attempt: IntegrationAttemptRecord,
): void {
  if (
    barrier.phaseId !== attempt.phaseId ||
    barrier.definitionGeneration !== attempt.definitionGeneration ||
    barrier.targetRef !== attempt.targetRef ||
    barrier.fanInDigest !== attempt.fanInDigest ||
    canonicalStringify(barrier.members) !==
      canonicalStringify(attempt.members.map(({ member }) => member))
  ) {
    throw new TypeError("Integration barrier does not match its durable attempt");
  }
  if (
    attempt.gate === undefined ||
    attempt.gate.decision !== "passed" ||
    barrier.gatePolicyDigest !== attempt.gate.policyDigest ||
    barrier.gateReadingDigest !== attempt.gate.readingDigest ||
    barrier.gateEvaluationDigest !== attempt.gate.evaluationDigest
  ) {
    throw new TypeError("Integration barrier does not match its passed gate authority");
  }
}

function integrationSlotResourceKey(
  repositoryId: string,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): string {
  return `integration-slot-${canonicalDigest(
    canonicalValue({ repositoryId, resource: "integration-slot" }),
    dependencies.sha256,
  )}`;
}

function isAllowedWorkspaceTransition(
  current: WorkspaceLifecycleState,
  next: WorkspaceLifecycleState,
): boolean {
  if (current === next) return true;
  const allowed: Readonly<Record<WorkspaceLifecycleState, readonly WorkspaceLifecycleState[]>> = {
    intent: ["prepared", "failed", "unknown"],
    prepared: ["capture-intent", "captured", "failed", "unknown"],
    "capture-intent": ["captured", "failed", "unknown"],
    captured: ["removal-intent"],
    "removal-intent": ["removed", "failed", "unknown"],
    removed: [],
    failed: [],
    unknown: ["prepared", "captured", "removed", "failed"],
  };
  return allowed[current].includes(next);
}

function isAllowedIntegrationTransition(
  current: IntegrationAttemptState,
  next: IntegrationAttemptState,
): boolean {
  if (current === next) return true;
  const terminal: readonly IntegrationAttemptState[] = [
    "conflicted",
    "target-moved",
    "rework-required",
    "cancelled",
    "failed",
  ];
  if (terminal.includes(current) || current === "barrier-recorded") return false;
  const allowed: Partial<
    Readonly<Record<IntegrationAttemptState, readonly IntegrationAttemptState[]>>
  > = {
    claimed: ["candidate-created", "cancelled", "failed", "unknown"],
    "candidate-created": ["validating", "conflicted", "cancelled", "failed", "unknown"],
    validating: ["gate-failed", "publishing", "rework-required", "cancelled", "failed", "unknown"],
    "gate-failed": ["rework-required"],
    publishing: ["published", "target-moved", "failed", "unknown"],
    published: ["barrier-recorded", "target-moved"],
    unknown: ["claimed", "candidate-created", "validating", "publishing", "published", ...terminal],
  };
  return allowed[current]?.includes(next) ?? false;
}

function terminalIntegrationState(state: IntegrationAttemptState): boolean {
  return [
    "barrier-recorded",
    "conflicted",
    "target-moved",
    "rework-required",
    "cancelled",
    "failed",
  ].includes(state);
}

function isFullLocalBranchRefForStorage(value: string): boolean {
  return (
    value.startsWith("refs/heads/") &&
    value.length <= 1_024 &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !["~", "^", ":", "?", "*", "[", "\\"].some((character) => value.includes(character)) &&
    value
      .slice("refs/heads/".length)
      .split("/")
      .every(
        (component) =>
          component.length > 0 &&
          !component.startsWith(".") &&
          !component.endsWith(".") &&
          !component.endsWith(".lock"),
      )
  );
}

function isRunnerTerminal(status: EffectOutcome["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * A queued command without the moment it was queued. Two offers of the same
 * command differ only in that field, and it decides nothing about the work, so
 * it must not make one offer look like a conflicting command.
 */
function decidedRunnerContent(canonicalCommand: string): string {
  const value = JSON.parse(canonicalCommand) as Record<string, unknown>;
  const { queuedAt: _queuedAt, ...decided } = value;
  return canonicalStringify(decided);
}

function snapshotRunnerValue<T>(value: T): T {
  return parseRunnerValue(canonicalStringify(value));
}

function parseRunnerValue<T>(serialized: string): T {
  return deepFreezeRunnerValue(JSON.parse(serialized) as T);
}

function deepFreezeRunnerValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeRunnerValue(child);
    Object.freeze(value);
  }
  return value;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

const CONTEXT_ASSET_CHUNK_BYTES = 65_536;
const MAX_VERIFIED_CONTEXT_ASSET_BYTES = 268_435_456;

interface ContextAuthorityStateRow {
  readonly canonical_json: string;
}

interface ContextChunkRow {
  readonly chunk_index: number;
  readonly byte_offset: number;
  readonly byte_length: number;
  readonly chunk_digest: string;
  readonly content: Uint8Array;
}

export class SqliteContextAssetAuthority {
  readCalls = 0;
  readonly broker: SqliteContextBroker;

  constructor(broker: SqliteContextBroker) {
    this.broker = broker;
  }

  installCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset, bytes: Uint8Array): void {
    this.broker.installCanonicalOutputAsset(asset, bytes);
  }

  hasCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset): boolean {
    return this.broker.hasCanonicalOutputAsset(asset);
  }

  put(binding: HistoricalAssetBinding, bytes: Uint8Array): void {
    this.broker.putContextAsset(binding, bytes);
  }

  readAssetRange(
    binding: HistoricalAssetBinding,
    offset: number,
    length: number,
  ): Uint8Array | undefined {
    this.readCalls += 1;
    return this.broker.readContextAssetRange(binding, offset, length);
  }

  readJsonAsset(binding: HistoricalAssetBinding, maxAssetBytes: number): Uint8Array | undefined {
    this.readCalls += 1;
    if (binding.byteLength > maxAssetBytes) return undefined;
    return this.broker.readContextAssetRange(binding, 0, binding.byteLength);
  }
}

export class SqliteContextBroker {
  readonly databasePath: string;
  readonly dependencies: ContextBrokerDependencies;
  readonly assets: SqliteContextAssetAuthority;
  readonly transcript: AgentTranscriptPort;
  readonly authority: {
    snapshot: () => ContextAuthoritySnapshot;
    projection: () => ContextBrokerProjection;
    toCanonicalJson: () => string;
    toDurableCanonicalJson: () => string;
    installTaskScopeFences: (input: InstallTaskScopeFencesInput) => readonly TaskScopeCurrentness[];
  };
  readonly #database: Database.Database;
  readonly #completionFacts: CompletionFactPort | undefined;
  readonly #phaseOutputFacts: PhaseOutputFactPort | undefined;
  readonly #faultInjector: ((point: SqliteContextBrokerFaultPoint) => void) | undefined;
  readonly #deliveringSubmissionIds = new Set<string>();
  #decoded:
    | { readonly fingerprint: string; readonly authority: InMemoryContextAuthority }
    | undefined;

  installCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset, bytes: Uint8Array): void {
    if (
      bytes.byteLength !== asset.byteLength ||
      this.dependencies.sha256.digest(bytes) !== asset.contentDigest
    ) {
      throw new TypeError("Canonical phase output asset is not installed with exact bytes");
    }
    this.#database
      .prepare(
        `INSERT INTO phase_output_assets(
           validation_receipt_digest, content_digest, byte_length, media_type,
           schema_resource_digest, canonical_bytes, canonical_descriptor
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(validation_receipt_digest) DO NOTHING`,
      )
      .run(
        asset.validationReceiptDigest,
        asset.contentDigest,
        asset.byteLength,
        asset.mediaType,
        asset.schemaResourceDigest,
        bytes,
        canonicalStringify(asset),
      );
    if (!this.hasCanonicalOutputAsset(asset)) {
      throw new TypeError("Canonical phase output validation receipt conflicts with prior content");
    }
  }

  recordPhaseOutputAttempt(input: PhaseOutputAttemptInput): PhaseOutputAttemptResult {
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const existing = this.#loadPhaseOutputAttempts(input.dispatchId);
      const { result, insert } = evaluatePhaseOutputAttempt(existing, input);
      if (insert) {
        this.#database
          .prepare(
            `INSERT INTO phase_output_attempts(
               dispatch_id, attempt_id, output_name, tool_call_id, outcome,
               findings_digest, submission_id, canonical_attempt
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.dispatchId,
            input.attemptId,
            input.outputName,
            input.toolCallId,
            input.outcome,
            input.findingsDigest ?? null,
            input.submissionId ?? null,
            canonicalStringify(input),
          );
      }
      this.#database.exec("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  countRejectedPhaseOutputAttempts(dispatchId: string, outputName: string): number {
    const row = this.#database
      .prepare<[string, string], { total: number }>(
        `SELECT COUNT(*) AS total FROM phase_output_attempts
         WHERE dispatch_id = ? AND output_name = ? AND outcome = 'rejected'`,
      )
      .get(dispatchId, outputName);
    return row?.total ?? 0;
  }

  appendTranscript(input: AgentTranscriptLine): AgentTranscriptAppendResult {
    const ownerKind: string = input.owner.kind;
    if (ownerKind === "run")
      throw new AgentTranscriptRefusalError(
        "invalid-scope",
        "Agent transcript capture cannot write the run projection scope",
      );
    validateOpaqueIdentity(input.owner.id);
    validateOpaqueIdentity(input.lineId);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const run = this.#database
        .prepare<[string, string], { run_key: string }>(
          "SELECT run_key FROM runs WHERE repository_id = ? AND run_id = ?",
        )
        .get(input.repositoryId, input.runId);
      if (run === undefined)
        throw new AgentTranscriptRefusalError(
          "unknown-run",
          "Agent transcript references an unknown run",
        );
      const retainedReplay = this.#database
        .prepare<
          [string, string, string, string],
          { sequence: number; occurred_at: string; stream: string; text: string }
        >(
          `SELECT sequence, occurred_at, stream, text FROM agent_transcript_lines
           WHERE run_key = ? AND owner_kind = ? AND owner_id = ? AND line_id = ?`,
        )
        .get(run.run_key, input.owner.kind, input.owner.id, input.lineId);
      const replayed = retainedReplay !== undefined;
      if (retainedReplay !== undefined) {
        if (
          retainedReplay.occurred_at !== input.occurredAt ||
          retainedReplay.stream !== input.stream ||
          retainedReplay.text !== input.text
        ) {
          throw new AgentTranscriptRefusalError(
            "line-conflict",
            "Agent transcript line conflicts with prior content",
          );
        }
      }
      const sequence = retainedReplay?.sequence ?? this.#nextTranscriptSequence(run.run_key, input);
      if (!replayed) {
        decodePortalTranscriptRecord({
          apiVersion: PROTOCOL_VERSION,
          repositoryId: input.repositoryId,
          runId: input.runId,
          owner: { kind: input.owner.kind, id: input.owner.id },
          sequence,
          occurredAt: input.occurredAt,
          stream: input.stream,
          text: input.text,
        });
        const runSequence =
          (this.#database
            .prepare<[string], { latest: number | null }>(
              "SELECT MAX(run_sequence) AS latest FROM agent_transcript_lines WHERE run_key = ?",
            )
            .get(run.run_key)?.latest ?? 0) + 1;
        this.#database
          .prepare(
            `INSERT INTO agent_transcript_lines(
               run_key, owner_kind, owner_id, sequence, run_sequence, line_id,
               occurred_at, stream, text
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            run.run_key,
            input.owner.kind,
            input.owner.id,
            sequence,
            runSequence,
            input.lineId,
            input.occurredAt,
            input.stream,
            input.text,
          );
        this.#database
          .prepare(
            `DELETE FROM agent_transcript_lines
             WHERE run_key = ? AND owner_kind = ? AND owner_id = ? AND sequence <= ?`,
          )
          .run(
            run.run_key,
            input.owner.kind,
            input.owner.id,
            sequence - TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner,
          );
      }
      const retained =
        this.#database
          .prepare<[string, string, string], { total: number }>(
            `SELECT COUNT(*) AS total FROM agent_transcript_lines
             WHERE run_key = ? AND owner_kind = ? AND owner_id = ?`,
          )
          .get(run.run_key, input.owner.kind, input.owner.id)?.total ?? 0;
      this.#database.exec("COMMIT");
      committed = true;
      return Object.freeze({ sequence, retained, replayed });
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Bounded durable high-water read used by the retention and page bounds; the
   * next owner-scoped sequence is assigned inside the append transaction so no
   * caller has to read it first.
   */
  #nextTranscriptSequence(runKey: string, input: AgentTranscriptLine): number {
    return this.#latestOwnerSequence(runKey, input.owner) + 1;
  }

  #latestOwnerSequence(runKey: string, owner: AgentTranscriptOwner): number {
    return (
      this.#database
        .prepare<[string, string, string], { latest: number | null }>(
          `SELECT MAX(sequence) AS latest FROM agent_transcript_lines
           WHERE run_key = ? AND owner_kind = ? AND owner_id = ?`,
        )
        .get(runKey, owner.kind, owner.id)?.latest ?? 0
    );
  }

  #loadPhaseOutputAttempts(dispatchId: string): readonly PhaseOutputAttemptRecord[] {
    return this.#database
      .prepare<
        [string],
        {
          dispatch_id: string;
          attempt_id: string;
          output_name: string;
          tool_call_id: string;
          outcome: "rejected" | "accepted";
          findings_digest: string | null;
          submission_id: string | null;
        }
      >(
        `SELECT dispatch_id, attempt_id, output_name, tool_call_id, outcome,
                findings_digest, submission_id
         FROM phase_output_attempts WHERE dispatch_id = ? ORDER BY attempt_id`,
      )
      .all(dispatchId)
      .map((row) => ({
        dispatchId: row.dispatch_id,
        attemptId: row.attempt_id,
        outputName: row.output_name,
        toolCallId: row.tool_call_id,
        outcome: row.outcome,
        ...(row.findings_digest === null ? {} : { findingsDigest: row.findings_digest }),
        ...(row.submission_id === null ? {} : { submissionId: row.submission_id }),
      }));
  }

  hasCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset): boolean {
    const row = this.#database
      .prepare<
        [string],
        {
          content_digest: string;
          byte_length: number;
          media_type: string;
          schema_resource_digest: string;
          canonical_bytes: Uint8Array;
          canonical_descriptor: string;
        }
      >(
        `SELECT content_digest, byte_length, media_type, schema_resource_digest, canonical_bytes,
                canonical_descriptor
         FROM phase_output_assets WHERE validation_receipt_digest = ?`,
      )
      .get(asset.validationReceiptDigest);
    return (
      row !== undefined &&
      row.content_digest === asset.contentDigest &&
      row.byte_length === asset.byteLength &&
      row.media_type === asset.mediaType &&
      row.schema_resource_digest === asset.schemaResourceDigest &&
      row.canonical_descriptor === canonicalStringify(asset) &&
      row.canonical_bytes.byteLength === asset.byteLength &&
      this.dependencies.sha256.digest(row.canonical_bytes) === asset.contentDigest
    );
  }
  #readQueue: Promise<void> = Promise.resolve();

  constructor(options: SqliteContextBrokerOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = Object.freeze({
      sha256: options.dependencies.sha256,
      currentTime: options.dependencies.currentTime,
      issueGrantToken: options.dependencies.issueGrantToken,
    });
    this.#completionFacts = options.completionFacts;
    this.#phaseOutputFacts = options.phaseOutputFacts;
    this.#faultInjector = options.faultInjector;
    ensureSafeDirectoryPath(dirname(this.databasePath));
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
      this.#verifyContextStorage();
    } catch (error) {
      this.#database.close();
      throw error;
    }
    this.assets = new SqliteContextAssetAuthority(this);
    this.transcript = Object.freeze({
      append: (record: AgentTranscriptLine) => void this.appendTranscript(record),
    });
    this.authority = Object.freeze({
      snapshot: () => this.#readAuthority().snapshot(),
      projection: () => this.#readAuthority().projection(),
      toCanonicalJson: () => this.#readAuthority().toCanonicalJson(),
      // The stored form leaves dispatches to their table, so a caller wanting
      // one self-contained value gets it rebuilt rather than read raw.
      toDurableCanonicalJson: () => this.#readAuthority().toDurableCanonicalJson(),
      installTaskScopeFences: (input) => this.installTaskScopeFences(input),
    });
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  registerDispatch(input: RegisterWorkerDispatchInput) {
    return this.#transact((broker) => broker.registerDispatch(input));
  }

  loadWorkerDispatch(dispatchId: string) {
    return this.#readBroker().loadWorkerDispatch(dispatchId);
  }

  listWorkerDispatches(repositoryId: string, runId: string) {
    return this.#readBroker().listWorkerDispatches(repositoryId, runId);
  }

  loadWorkerDispatchProgress(dispatchId: string) {
    return this.#readBroker().loadWorkerDispatchProgress(dispatchId);
  }

  installTaskScopeFences(input: InstallTaskScopeFencesInput): readonly TaskScopeCurrentness[] {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const installed = installDurableTaskScopeFences(this.#database, input, this.dependencies);
      this.#database.exec("COMMIT");
      return installed;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  grantAssetAccess(input: ContextGrantInput) {
    return this.#transact((broker) => broker.grantAssetAccess(input));
  }

  async readAsset(input: AssetReadInput): Promise<AssetReadResult> {
    return this.#serializeRead(() => this.#readAssetTransaction(input));
  }

  async #readAssetTransaction(input: AssetReadInput): Promise<AssetReadResult> {
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const authority = this.#loadAuthority();
      const broker = new ContextBroker(this.assets, this.dependencies, authority);
      const result = await broker.readAsset(input);
      this.#persistContextAuthority(authority);
      this.#fault("before-read-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-read-commit-before-ack");
      return result;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  admitSubmission(input: SubmissionAdmissionInput): SubmissionAdmissionResult {
    const result = this.#transact((broker) => broker.admitSubmission(input));
    this.deliverCompletionFact(result.submissionId);
    this.deliverPhaseOutputFact(result.submissionId);
    return result;
  }

  deliverPhaseOutputFact(submissionId: string): boolean {
    if (this.#phaseOutputFacts === undefined || this.#deliveringSubmissionIds.has(submissionId)) {
      return false;
    }
    this.#deliveringSubmissionIds.add(submissionId);
    try {
      const pending = this.#loadAuthority().phaseOutputOutbox.get(submissionId);
      if (pending === undefined || pending.delivered) return false;
      let admission: "accepted" | "deferred";
      try {
        admission = this.#phaseOutputFacts.admitPhaseOutputFact(pending.fact);
      } catch {
        // A failed publication leaves the fact pending for a later drain.
        return false;
      }
      if (admission === "deferred") return false;
      this.#database.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const current = this.#loadAuthority();
        const currentPending = current.phaseOutputOutbox.get(submissionId);
        if (currentPending === undefined || currentPending.delivered) {
          this.#database.exec("COMMIT");
          committed = true;
          return false;
        }
        currentPending.delivered = true;
        this.#persistContextAuthority(current);
        this.#fault("before-outbox-ack");
        this.#database.exec("COMMIT");
        committed = true;
        this.#fault("after-outbox-ack-before-return");
        return true;
      } catch (error) {
        if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.#deliveringSubmissionIds.delete(submissionId);
    }
  }

  deliverCompletionFact(submissionId: string): boolean {
    if (this.#completionFacts === undefined || this.#deliveringSubmissionIds.has(submissionId))
      return false;
    this.#deliveringSubmissionIds.add(submissionId);
    try {
      const pending = this.#loadAuthority().completionOutbox.get(submissionId);
      if (pending === undefined || pending.delivered) return false;
      // A consumer failure propagates here on purpose: an inline submission must
      // fail loudly rather than report success for a fact that never published.
      // Background drains contain this throw themselves.
      if (this.#completionFacts.admitCompletionFact(pending.fact) === "deferred") return false;
      this.#database.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const current = this.#loadAuthority();
        const currentPending = current.completionOutbox.get(submissionId);
        if (currentPending === undefined || currentPending.delivered) {
          this.#database.exec("COMMIT");
          committed = true;
          return false;
        }
        currentPending.delivered = true;
        this.#persistContextAuthority(current);
        this.#fault("before-outbox-ack");
        this.#database.exec("COMMIT");
        committed = true;
        this.#fault("after-outbox-ack-before-return");
        return true;
      } catch (error) {
        if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.#deliveringSubmissionIds.delete(submissionId);
    }
  }

  deliverCompletionOutboxOnce(): boolean {
    for (const submissionId of pendingOutboxSubmissionIds(this.#loadAuthority().completionOutbox)) {
      if (drainOutboxEntry(() => this.deliverCompletionFact(submissionId))) return true;
    }
    return false;
  }

  deliverPhaseOutputOutboxOnce(): boolean {
    for (const submissionId of pendingOutboxSubmissionIds(
      this.#loadAuthority().phaseOutputOutbox,
    )) {
      if (drainOutboxEntry(() => this.deliverPhaseOutputFact(submissionId))) return true;
    }
    return false;
  }

  /** Reads exact canonical phase output bytes staged by an accepted submission. */
  loadCanonicalOutputBytes(contentDigest: string): Uint8Array | undefined {
    const row = this.#database
      .prepare<[string], { canonical_bytes: Uint8Array }>(
        "SELECT canonical_bytes FROM phase_output_assets WHERE content_digest = ? LIMIT 1",
      )
      .get(contentDigest);
    if (row === undefined) return undefined;
    return this.dependencies.sha256.digest(row.canonical_bytes) === contentDigest
      ? row.canonical_bytes
      : undefined;
  }

  claimAmendmentProposalOutbox(
    ownerId: string,
    currentTime: string,
    expiresAt: string,
  ): WorkerAmendmentOutboxClaim | undefined {
    validateStorageIdentifier(ownerId, "ownerId");
    validateTimestamp(currentTime, "currentTime");
    validateTimestamp(expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= Date.parse(currentTime)) {
      throw new TypeError("Amendment outbox claim expiry must be later than currentTime");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare<
          [string, string],
          {
            submission_id: string;
            source_digest: string;
            claim_owner_id: string | null;
            claim_fence: number | null;
            claim_expires_at: string | null;
          }
        >(
          `SELECT submission_id, source_digest, claim_owner_id, claim_fence, claim_expires_at
           FROM context_amendment_outbox
           WHERE delivered = 0
             AND (claim_owner_id IS NULL OR claim_owner_id = ? OR claim_expires_at <= ?)
           ORDER BY submission_id LIMIT 1`,
        )
        .get(ownerId, currentTime);
      if (row === undefined) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      if (
        row.claim_owner_id === ownerId &&
        row.claim_fence !== null &&
        row.claim_expires_at !== null &&
        Date.parse(row.claim_expires_at) > Date.parse(currentTime)
      ) {
        this.#database.exec("COMMIT");
        return {
          submissionId: row.submission_id,
          sourceDigest: row.source_digest,
          ownerId,
          fence: row.claim_fence,
          expiresAt: row.claim_expires_at,
        };
      }
      const fence = (row.claim_fence ?? 0) + 1;
      const result = this.#database
        .prepare(
          `UPDATE context_amendment_outbox
           SET claim_owner_id = ?, claim_fence = ?, claim_expires_at = ?
           WHERE submission_id = ? AND delivered = 0
             AND (claim_owner_id IS NULL OR claim_owner_id = ? OR claim_expires_at <= ?)`,
        )
        .run(ownerId, fence, expiresAt, row.submission_id, ownerId, currentTime);
      if (result.changes !== 1) throw new TypeError("Amendment outbox claim lost a race");
      this.#database.exec("COMMIT");
      return {
        submissionId: row.submission_id,
        sourceDigest: row.source_digest,
        ownerId,
        fence,
        expiresAt,
      };
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  readClaimedAmendmentProposal(
    claim: WorkerAmendmentOutboxClaim,
    currentTime: string,
  ): WorkerAmendmentProposalSource {
    validateTimestamp(currentTime, "currentTime");
    const row = this.#database
      .prepare<
        [string, string, number],
        {
          source_digest: string;
          canonical_source: string;
          claim_expires_at: string | null;
          delivered: number;
        }
      >(
        `SELECT source_digest, canonical_source, claim_expires_at, delivered
         FROM context_amendment_outbox
         WHERE submission_id = ? AND claim_owner_id = ? AND claim_fence = ?`,
      )
      .get(claim.submissionId, claim.ownerId, claim.fence);
    if (
      row === undefined ||
      row.delivered !== 0 ||
      row.source_digest !== claim.sourceDigest ||
      row.claim_expires_at !== claim.expiresAt ||
      Date.parse(row.claim_expires_at) <= Date.parse(currentTime)
    ) {
      throw new TypeError("Amendment outbox claim is stale");
    }
    const source = decodeCanonicalJsonValue(row.canonical_source);
    if (
      !isPlainRecord(source) ||
      !Object.hasOwn(source, "submission") ||
      !Object.hasOwn(source, "context")
    ) {
      throw new Error("Amendment outbox source is invalid");
    }
    return Object.freeze({ submission: source.submission, context: source.context });
  }

  acknowledgeAmendmentProposalOutbox(
    claim: WorkerAmendmentOutboxClaim,
    currentTime: string,
  ): boolean {
    return this.completeAmendmentProposalOutbox(claim, currentTime, {
      kind: "acknowledged",
      submissionId: claim.submissionId,
      sourceDigest: claim.sourceDigest,
    });
  }

  completeAmendmentProposalOutbox(
    claim: WorkerAmendmentOutboxClaim,
    currentTime: string,
    outcome: unknown,
  ): boolean {
    validateTimestamp(currentTime, "currentTime");
    const canonicalOutcomeValue = canonicalValue(outcome);
    if (!isPlainRecord(canonicalOutcomeValue)) {
      throw new TypeError("Amendment bridge outcome must be an object");
    }
    const outcomeKind = canonicalOutcomeValue.kind;
    if (
      outcomeKind !== "acknowledged" &&
      outcomeKind !== "compiled" &&
      outcomeKind !== "diagnostics"
    ) {
      throw new TypeError("Amendment bridge outcome kind is invalid");
    }
    const canonicalOutcome = canonicalStringify(canonicalOutcomeValue);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existingOutcome = this.#database
        .prepare<
          [string],
          { source_digest: string; outcome_kind: string; canonical_outcome: string }
        >(
          `SELECT source_digest, outcome_kind, canonical_outcome
           FROM amendment_proposal_bridge_outcomes WHERE submission_id = ?`,
        )
        .get(claim.submissionId);
      if (existingOutcome !== undefined) {
        if (
          existingOutcome.source_digest !== claim.sourceDigest ||
          existingOutcome.outcome_kind !== outcomeKind ||
          existingOutcome.canonical_outcome !== canonicalOutcome
        ) {
          throw new TypeError("Amendment bridge outcome conflicts with durable completion");
        }
      }
      const delivered = this.#database
        .prepare<[string], { source_digest: string; claim_fence: number | null }>(
          `SELECT source_digest, claim_fence FROM context_amendment_outbox
           WHERE submission_id = ? AND delivered = 1`,
        )
        .get(claim.submissionId);
      if (delivered !== undefined) {
        if (
          delivered.source_digest !== claim.sourceDigest ||
          delivered.claim_fence !== claim.fence
        ) {
          throw new TypeError("Amendment outbox acknowledgement conflicts with delivered source");
        }
        this.#database.exec("COMMIT");
        return false;
      }
      const result = this.#database
        .prepare(
          `UPDATE context_amendment_outbox
           SET delivered = 1, claim_owner_id = NULL, claim_expires_at = NULL
           WHERE submission_id = ? AND source_digest = ? AND delivered = 0
             AND claim_owner_id = ? AND claim_fence = ? AND claim_expires_at = ?
             AND claim_expires_at > ?`,
        )
        .run(
          claim.submissionId,
          claim.sourceDigest,
          claim.ownerId,
          claim.fence,
          claim.expiresAt,
          currentTime,
        );
      if (result.changes !== 1) throw new TypeError("Amendment outbox acknowledgement is stale");
      this.#database
        .prepare(
          `INSERT INTO amendment_proposal_bridge_outcomes(
             submission_id, source_digest, outcome_kind, canonical_outcome, recorded_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(claim.submissionId, claim.sourceDigest, outcomeKind, canonicalOutcome, currentTime);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getAmendmentProposalBridgeOutcome(submissionId: string): unknown | undefined {
    validateStorageIdentifier(submissionId, "submissionId");
    const row = this.#database
      .prepare<[string], { canonical_outcome: string }>(
        `SELECT canonical_outcome FROM amendment_proposal_bridge_outcomes
         WHERE submission_id = ?`,
      )
      .get(submissionId);
    return row === undefined ? undefined : decodeCanonicalJsonValue(row.canonical_outcome);
  }

  putContextAsset(binding: HistoricalAssetBinding, input: Uint8Array): void {
    const bytes = Uint8Array.from(input);
    if (
      bytes.byteLength !== binding.byteLength ||
      this.dependencies.sha256.digest(bytes) !== binding.contentDigest
    )
      throw new TypeError("Context asset bytes do not match their historical binding");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare<[string], { content_digest: string; byte_length: number }>(
          `SELECT content_digest, byte_length FROM context_asset_bindings
           WHERE asset_binding_id = ?`,
        )
        .get(binding.assetBindingId);
      if (
        row === undefined ||
        row.content_digest !== binding.contentDigest ||
        row.byte_length !== binding.byteLength
      )
        throw new TypeError("Context asset binding is not registered with exact canonical facts");
      const chunkCount = Math.ceil(bytes.byteLength / CONTEXT_ASSET_CHUNK_BYTES);
      const existing = this.#database
        .prepare<[string], { content_digest: string; byte_length: number; chunk_count: number }>(
          `SELECT content_digest, byte_length, chunk_count FROM context_asset_manifests
           WHERE asset_binding_id = ?`,
        )
        .get(binding.assetBindingId);
      if (existing !== undefined) {
        if (
          existing.content_digest !== binding.contentDigest ||
          existing.byte_length !== binding.byteLength ||
          existing.chunk_count !== chunkCount
        )
          throw new TypeError("Context asset identity is already bound to different content");
        verifyContextAssetManifest(
          this.#database,
          binding.assetBindingId,
          this.dependencies.sha256,
        );
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare(
          `INSERT INTO context_asset_manifests(
             asset_binding_id, content_digest, byte_length, chunk_size, chunk_count
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          binding.assetBindingId,
          binding.contentDigest,
          binding.byteLength,
          CONTEXT_ASSET_CHUNK_BYTES,
          chunkCount,
        );
      const insertChunk = this.#database.prepare(
        `INSERT INTO context_asset_chunks(
           asset_binding_id, chunk_index, byte_offset, byte_length, chunk_digest, content
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const byteOffset = chunkIndex * CONTEXT_ASSET_CHUNK_BYTES;
        const chunk = bytes.slice(byteOffset, byteOffset + CONTEXT_ASSET_CHUNK_BYTES);
        insertChunk.run(
          binding.assetBindingId,
          chunkIndex,
          byteOffset,
          chunk.byteLength,
          this.dependencies.sha256.digest(chunk),
          chunk,
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  readContextAssetRange(
    binding: HistoricalAssetBinding,
    offset: number,
    length: number,
  ): Uint8Array | undefined {
    this.#fault("after-read-reservation");
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > binding.byteLength ||
      length > binding.byteLength - offset
    )
      return undefined;
    const manifest = this.#database
      .prepare<
        [string],
        { content_digest: string; byte_length: number; chunk_size: number; chunk_count: number }
      >(
        `SELECT content_digest, byte_length, chunk_size, chunk_count
         FROM context_asset_manifests WHERE asset_binding_id = ?`,
      )
      .get(binding.assetBindingId);
    if (
      manifest === undefined ||
      manifest.content_digest !== binding.contentDigest ||
      manifest.byte_length !== binding.byteLength ||
      manifest.chunk_size !== CONTEXT_ASSET_CHUNK_BYTES ||
      manifest.chunk_count !== expectedContextChunkCount(binding.byteLength)
    )
      return undefined;
    if (length === 0) {
      const empty = new Uint8Array();
      return offset === 0 &&
        binding.byteLength === 0 &&
        this.dependencies.sha256.digest(empty) !== binding.contentDigest
        ? undefined
        : empty;
    }
    const firstChunk = Math.floor(offset / CONTEXT_ASSET_CHUNK_BYTES);
    const lastChunk = Math.floor((offset + length - 1) / CONTEXT_ASSET_CHUNK_BYTES);
    const rows = this.#database
      .prepare<[string, number, number], ContextChunkRow>(
        `SELECT chunk_index, byte_offset, byte_length, chunk_digest, content
         FROM context_asset_chunks
         WHERE asset_binding_id = ? AND chunk_index BETWEEN ? AND ?
         ORDER BY chunk_index`,
      )
      .all(binding.assetBindingId, firstChunk, lastChunk);
    if (rows.length !== lastChunk - firstChunk + 1) return undefined;
    const result = new Uint8Array(length);
    for (const [index, row] of rows.entries()) {
      const content = Uint8Array.from(row.content);
      const expectedIndex = firstChunk + index;
      const expectedLength = expectedContextChunkLength(
        binding.byteLength,
        manifest.chunk_count,
        expectedIndex,
      );
      if (
        row.chunk_index !== expectedIndex ||
        row.byte_length !== content.byteLength ||
        row.byte_length !== expectedLength ||
        row.byte_offset !== row.chunk_index * CONTEXT_ASSET_CHUNK_BYTES ||
        this.dependencies.sha256.digest(content) !== row.chunk_digest
      )
        return undefined;
      const copyStart = Math.max(offset, row.byte_offset);
      const copyEnd = Math.min(offset + length, row.byte_offset + row.byte_length);
      result.set(
        content.slice(copyStart - row.byte_offset, copyEnd - row.byte_offset),
        copyStart - offset,
      );
    }
    if (
      offset === 0 &&
      length === binding.byteLength &&
      this.dependencies.sha256.digest(result) !== binding.contentDigest
    )
      return undefined;
    return result;
  }

  #serializeRead<Result>(operation: () => Promise<Result>): Promise<Result> {
    const prior = this.#readQueue;
    let release: () => void = () => undefined;
    this.#readQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prior.then(operation).finally(release);
  }

  #transact<Result>(operation: (broker: ContextBroker) => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const authority = this.#loadAuthority();
      const broker = new ContextBroker(this.assets, this.dependencies, authority);
      const result = operation(broker);
      this.#persistContextAuthority(authority);
      this.#fault("before-context-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-context-commit-before-ack");
      return result;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #loadBroker(): ContextBroker {
    return new ContextBroker(this.assets, this.dependencies, this.#loadAuthority());
  }

  // Reads never mutate the authority they are given, so they can share the one
  // already decoded.
  #readBroker(): ContextBroker {
    return new ContextBroker(this.assets, this.dependencies, this.#readAuthority());
  }

  #readContextState(): string {
    const row = this.#database
      .prepare<[], ContextAuthorityStateRow>(
        "SELECT canonical_json FROM context_authority_state WHERE singleton = 1",
      )
      .get();
    if (row === undefined) throw new Error("SQLite context authority singleton is missing");
    return row.canonical_json;
  }

  #loadAuthority(): InMemoryContextAuthority {
    const authority = InMemoryContextAuthority.fromDurableCanonicalJson(
      this.#readContextState(),
      this.dependencies.sha256,
      storedContextDispatches(this.#database),
    );
    overlayContextTaskScopeCurrentness(this.#database, authority);
    return authority;
  }

  // Decoding the durable state costs about a hundred milliseconds on a run of
  // three phases, and a supervisor cycle asked for it repeatedly. The bytes are
  // still read from SQLite every time; what is skipped is decoding bytes that
  // have already been decoded. The fingerprint covers exactly the tables
  // #loadAuthority reads, so anything that could change the result changes it.
  #readAuthority(): InMemoryContextAuthority {
    const fingerprint = this.#contextFingerprint();
    if (this.#decoded?.fingerprint === fingerprint) return this.#decoded.authority;
    const authority = this.#loadAuthority();
    this.#decoded = { fingerprint, authority };
    return authority;
  }

  #contextFingerprint(): string {
    const parts: string[] = [this.#readContextState()];
    for (const row of this.#database
      .prepare<
        [],
        {
          dispatch_id: string;
          canonical_dispatch: string;
          canonical_completion_requirements: string;
          canonical_task_scope: string;
          canonical_effect: string | null;
          context_id: string;
        }
      >(
        `SELECT dispatch_id, canonical_dispatch, canonical_completion_requirements,
                canonical_task_scope, canonical_effect, context_id
         FROM context_dispatches ORDER BY dispatch_id`,
      )
      .all()) {
      parts.push(
        row.dispatch_id,
        row.canonical_dispatch,
        row.canonical_completion_requirements,
        row.canonical_task_scope,
        row.canonical_effect ?? "",
        row.context_id,
      );
    }
    for (const row of this.#database
      .prepare<[], { context_id: string; canonical_context: string }>(
        "SELECT context_id, canonical_context FROM context_bases ORDER BY context_id",
      )
      .all()) {
      parts.push(row.context_id, row.canonical_context);
    }
    for (const row of this.#database
      .prepare<
        [],
        {
          run_key: string;
          task_id: string;
          definition_generation: number;
          fence_generation: number;
          current_context_digest: string;
          claims_accepted: number;
        }
      >(
        `SELECT run_key, task_id, definition_generation, fence_generation,
                current_context_digest, claims_accepted
         FROM amendment_work_fences ORDER BY run_key, task_id, definition_generation`,
      )
      .all()) {
      parts.push(
        row.run_key,
        row.task_id,
        String(row.definition_generation),
        String(row.fence_generation),
        row.current_context_digest,
        String(row.claims_accepted),
      );
    }
    return this.dependencies.sha256.digest(new TextEncoder().encode(parts.join("\u0000")));
  }

  #persistContextAuthority(authority: InMemoryContextAuthority): void {
    const serialized = authority.toDurableCanonicalJsonWithoutDispatches();
    this.#database
      .prepare("UPDATE context_authority_state SET canonical_json = ? WHERE singleton = 1")
      .run(serialized);
    this.#mirrorContextAuthority(authority);
  }

  #mirrorContextAuthority(authority: InMemoryContextAuthority): void {
    const normalized = normalizeContextAuthority(authority, this.dependencies.sha256);
    synchronizeContextTaskScopes(this.#database, normalized.taskScopes);
    const amendmentOutboxState = new Map(
      this.#database
        .prepare<
          [],
          {
            submission_id: string;
            source_digest: string;
            delivered: number;
            claim_owner_id: string | null;
            claim_fence: number | null;
            claim_expires_at: string | null;
          }
        >(
          `SELECT submission_id, source_digest, delivered, claim_owner_id,
                  claim_fence, claim_expires_at
           FROM context_amendment_outbox ORDER BY submission_id`,
        )
        .all()
        .map((row) => [row.submission_id, row] as const),
    );
    for (const row of normalized.contextBases) {
      this.#database
        .prepare(
          `INSERT INTO context_bases(context_id, context_digest, canonical_context)
           VALUES (?, ?, ?) ON CONFLICT(context_id) DO NOTHING`,
        )
        .run(row.context_id, row.context_digest, row.canonical_context);
    }
    for (const row of normalized.dispatches) {
      this.#database
        .prepare(
          `INSERT INTO context_dispatches(
             dispatch_id, repository_id, run_id, context_id, prompt_pack_digest,
             canonical_dispatch, canonical_completion_requirements,
             canonical_task_scope, canonical_effect
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dispatch_id) DO NOTHING`,
        )
        .run(
          row.dispatch_id,
          row.repository_id,
          row.run_id,
          row.context_id,
          row.prompt_pack_digest,
          row.canonical_dispatch,
          row.canonical_completion_requirements,
          row.canonical_task_scope,
          row.canonical_effect,
        );
    }
    for (const row of normalized.bindings)
      this.#database
        .prepare(
          `INSERT INTO context_asset_bindings(
             asset_binding_id, context_id, semantic_asset_id, alias_binding_digest,
             content_digest, byte_length, media_type
           ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(asset_binding_id) DO NOTHING`,
        )
        .run(
          row.asset_binding_id,
          row.context_id,
          row.semantic_asset_id,
          row.alias_binding_digest,
          row.content_digest,
          row.byte_length,
          row.media_type,
        );
    this.#database.exec(
      `DELETE FROM context_amendment_outbox;
       DELETE FROM context_audit_receipts;
       DELETE FROM context_events;
       DELETE FROM context_questions;
       DELETE FROM context_terminal_completions;
        DELETE FROM context_phase_output_outbox;
       DELETE FROM context_completion_outbox;
       DELETE FROM context_read_attempts;
       DELETE FROM context_grants;
       DELETE FROM context_submissions;`,
    );
    for (const row of normalized.grants)
      this.#database
        .prepare(
          `INSERT INTO context_grants(
             token_digest, dispatch_id, repository_id, run_id, asset_binding_id,
             canonical_envelope, operations_used, bytes_used
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.token_digest,
          row.dispatch_id,
          row.repository_id,
          row.run_id,
          row.asset_binding_id,
          row.canonical_envelope,
          row.operations_used,
          row.bytes_used,
        );
    for (const row of normalized.readAttempts) {
      this.#database
        .prepare(
          `INSERT INTO context_read_attempts(
             request_id, token_digest, dispatch_id, repository_id, run_id,
             canonical_replay_key, replay_key_digest, request_digest, status,
             result_bytes, canonical_receipt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.request_id,
          row.token_digest,
          row.dispatch_id,
          row.repository_id,
          row.run_id,
          row.canonical_replay_key,
          row.replay_key_digest,
          row.request_digest,
          row.status,
          row.result_bytes === null ? null : Uint8Array.from(row.result_bytes),
          row.canonical_receipt,
        );
    }
    for (const row of normalized.receipts) {
      this.#database
        .prepare(
          `INSERT INTO context_audit_receipts(
             receipt_cursor, request_id, repository_id, run_id, dispatch_id,
             canonical_replay_key, replay_key_digest, token_digest, request_digest,
             reserved, failure_stage, failure_fact_digest, canonical_receipt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.receipt_cursor,
          row.request_id,
          row.repository_id,
          row.run_id,
          row.dispatch_id,
          row.canonical_replay_key,
          row.replay_key_digest,
          row.token_digest,
          row.request_digest,
          row.reserved,
          row.failure_stage,
          row.failure_fact_digest,
          row.canonical_receipt,
        );
    }
    for (const row of normalized.submissions)
      this.#database
        .prepare(
          `INSERT INTO context_submissions(
             submission_id, repository_id, run_id, dispatch_id, submission_type,
             canonical_submission, canonical_result
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.submission_id,
          row.repository_id,
          row.run_id,
          row.dispatch_id,
          row.submission_type,
          row.canonical_submission,
          row.canonical_result,
        );
    for (const row of normalized.questions)
      this.#database
        .prepare(
          `INSERT INTO context_questions(submission_id, repository_id, run_id, canonical_question)
           VALUES (?, ?, ?, ?)`,
        )
        .run(row.submission_id, row.repository_id, row.run_id, row.canonical_question);
    for (const row of normalized.terminalCompletions)
      this.#database
        .prepare(
          "INSERT INTO context_terminal_completions(dispatch_id, submission_id) VALUES (?, ?)",
        )
        .run(row.dispatch_id, row.submission_id);
    for (const row of normalized.completionOutbox)
      this.#database
        .prepare(
          `INSERT INTO context_completion_outbox(
             submission_id, dispatch_id, canonical_fact, delivered
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(row.submission_id, row.dispatch_id, row.canonical_fact, row.delivered);
    for (const row of normalized.phaseOutputOutbox)
      this.#database
        .prepare(
          `INSERT INTO context_phase_output_outbox(
             submission_id, dispatch_id, canonical_fact, delivered
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(row.submission_id, row.dispatch_id, row.canonical_fact, row.delivered);
    for (const row of normalized.amendmentOutbox) {
      const prior = amendmentOutboxState.get(row.submission_id);
      if (prior !== undefined && prior.source_digest !== row.source_digest) {
        throw new Error("Worker amendment outbox source changed for an existing submission");
      }
      this.#database
        .prepare(
          `INSERT INTO context_amendment_outbox(
             submission_id, dispatch_id, context_id, amendment_id,
             canonical_source, source_digest, delivered,
             claim_owner_id, claim_fence, claim_expires_at
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.submission_id,
          row.dispatch_id,
          row.context_id,
          row.canonical_source,
          row.source_digest,
          prior?.delivered ?? 0,
          prior?.claim_owner_id ?? null,
          prior?.claim_fence ?? null,
          prior?.claim_expires_at ?? null,
        );
    }
    for (const row of normalized.events)
      this.#database
        .prepare(
          `INSERT INTO context_events(
             cursor, repository_id, run_id, dispatch_id, event_type, canonical_event
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.cursor,
          row.repository_id,
          row.run_id,
          row.dispatch_id,
          row.event_type,
          row.canonical_event,
        );
    const projection = normalized.projection[0];
    if (projection === undefined) throw new Error("Context projection normalization failed");
    this.#database
      .prepare(
        `INSERT INTO context_projection(singleton, cursor, canonical_projection)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           cursor = excluded.cursor, canonical_projection = excluded.canonical_projection`,
      )
      .run(projection.cursor, projection.canonical_projection);
  }

  #verifyContextStorage(): void {
    const quickCheck = this.#database.pragma("quick_check(1)") as { quick_check: string }[];
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok")
      throw new Error("SQLite context authority quick_check failed");
    if ((this.#database.pragma("foreign_key_check") as unknown[]).length > 0)
      throw new Error("SQLite context authority foreign_key_check failed");
    const shared = readVerificationState(this.#database, this.dependencies);
    verifyContextTables(this.#database, this.dependencies, shared.context);
    verifyAmendmentTables(this.#database, this.dependencies, shared.snapshot, shared.context);
  }

  #fault(point: SqliteContextBrokerFaultPoint): void {
    try {
      this.#faultInjector?.(point);
    } catch (error) {
      if (point === "after-read-reservation")
        throw new ContextBrokerTransactionAbortError(
          error instanceof Error ? error.message : "Injected context read transaction abort",
        );
      throw error;
    }
  }
}

export function restoreSqliteAuthority(
  options: SqliteAuthorityOptions & { readonly backupPath: string },
): SqliteAuthority {
  const databasePath = resolve(options.databasePath);
  const backupPath = resolve(options.backupPath);
  const assetDirectory = resolve(options.assetDirectory);
  const bundle = verifyBackupBundle(backupPath, options.dependencies);
  assertFreshRestoreDestinations(databasePath, assetDirectory, backupPath);
  const suffix = randomUUID();
  const databasePartial = `${databasePath}.restore.partial-${suffix}`;
  const databasePublicationPartial = `${databasePath}.publish.partial-${suffix}`;
  const assetPartial = `${assetDirectory}.restore.partial-${suffix}`;
  mkdirDurably(assetPartial);
  const ownedAssetPartial = captureOwnedRestorePath(assetPartial, "directory");
  let ownedDatabasePartial: OwnedRestorePath | undefined;
  let ownedDatabasePublicationPartial: OwnedRestorePath | undefined;
  let ownedAssets: OwnedRestorePath | undefined;
  let ownedDatabase: OwnedRestorePath | undefined;
  let restoredAuthority: SqliteAuthority | undefined;
  try {
    options.faultInjector?.("after-restore-asset-partial-create");
    copyAssetSet(bundle.manifest.assets, bundle.assetDirectory, assetPartial, options.dependencies);
    copyFileSync(bundle.databasePath, databasePartial, constants.COPYFILE_EXCL);
    ownedDatabasePartial = captureOwnedRestorePath(databasePartial, "file");
    options.faultInjector?.("after-restore-database-partial-create");
    fsyncFile(databasePartial);
    verifyDatabaseArtifact(databasePartial, bundle.manifest, options.dependencies);
    const copied = openRestoreVerificationConnection(databasePartial);
    try {
      verifyDatabase(copied, options.dependencies, assetPartial, true);
    } finally {
      copied.close();
    }
    copyFileSync(databasePartial, databasePublicationPartial, constants.COPYFILE_EXCL);
    ownedDatabasePublicationPartial = captureOwnedRestorePath(databasePublicationPartial, "file");
    fsyncFile(databasePublicationPartial);
    assertFreshRestoreDestinations(databasePath, assetDirectory, backupPath);
    ownedAssets = publishAssetDirectoryNoReplace(assetPartial, assetDirectory, ownedAssetPartial);
    options.faultInjector?.("after-restore-assets-publish");
    linkSync(databasePublicationPartial, databasePath);
    ownedDatabase = captureOwnedRestorePath(databasePath, "file");
    options.faultInjector?.("after-restore-database-publish");
    fsyncDirectory(dirname(databasePath));
    removeOwnedRestorePath(ownedDatabasePublicationPartial);
    if (removeOwnedRestorePath(ownedDatabasePartial)) {
      fsyncDirectory(dirname(databasePartial));
    }
    restoredAuthority = new SqliteAuthority(options);
    return restoredAuthority;
  } catch (error) {
    restoredAuthority?.close();
    if (removeOwnedRestorePath(ownedDatabasePublicationPartial)) {
      fsyncDirectory(dirname(databasePublicationPartial));
    }
    if (removeOwnedRestorePath(ownedDatabasePartial)) {
      fsyncDirectory(dirname(databasePartial));
    }
    if (removeOwnedRestorePath(ownedAssetPartial)) {
      fsyncDirectory(dirname(assetPartial));
    }
    if (removeOwnedRestorePath(ownedDatabase)) {
      fsyncDirectory(dirname(databasePath));
    }
    if (removeOwnedRestorePath(ownedAssets)) {
      fsyncDirectory(dirname(assetDirectory));
    }
    throw error;
  }
}

export const SQLITE_INTEGRITY_CATEGORIES = Object.freeze([
  "storage",
  "structure",
  "migrations",
  "canonical-authority",
  "normalized-projections",
  "context-and-runner",
  "amendments",
  "workspaces",
  "human-authority",
  "portal",
  "supervisor",
  "remote-delivery",
  "assets",
] as const);

export type SqliteIntegrityCategory = (typeof SQLITE_INTEGRITY_CATEGORIES)[number];

export interface SqliteIntegrityCheck {
  readonly category: SqliteIntegrityCategory;
  readonly status: "passed" | "failed" | "not-checked";
  readonly code: string;
}

export interface SqliteIntegrityReport {
  readonly format: "senawa-sqlite-integrity";
  readonly version: 1;
  readonly status: "passed" | "failed";
  readonly checks: readonly SqliteIntegrityCheck[];
}

export function checkSqliteAuthorityIntegrity(
  options: Pick<SqliteAuthorityOptions, "databasePath" | "assetDirectory" | "dependencies">,
): SqliteIntegrityReport {
  let database: Database.Database;
  try {
    database = openReadConnection(resolve(options.databasePath));
  } catch {
    return failedIntegrityReport("storage");
  }
  try {
    verifyDatabase(database, options.dependencies, resolve(options.assetDirectory), true);
    return passedIntegrityReport();
  } catch (error) {
    return failedIntegrityReport(classifyIntegrityFailure(error));
  } finally {
    database.close();
  }
}

export function checkSqliteAuthorityBackupIntegrity(options: {
  readonly backupPath: string;
  readonly dependencies: RuntimeDependencies;
}): SqliteIntegrityReport {
  const source = resolve(options.backupPath);
  try {
    const sourceStatus = lstatSync(source);
    if (sourceStatus.isSymbolicLink() || !sourceStatus.isDirectory()) {
      return failedIntegrityReport("storage");
    }
  } catch {
    return failedIntegrityReport("storage");
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "senawa-sqlite-backup-verify-"));
  const stagedBackup = join(temporaryRoot, "backup");
  try {
    cpSync(source, stagedBackup, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    verifyBackupBundle(stagedBackup, options.dependencies);
    return passedIntegrityReport();
  } catch (error) {
    return failedIntegrityReport(classifyIntegrityFailure(error));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function passedIntegrityReport(): SqliteIntegrityReport {
  return Object.freeze({
    format: "senawa-sqlite-integrity",
    version: 1,
    status: "passed",
    checks: Object.freeze(
      SQLITE_INTEGRITY_CATEGORIES.map((category) =>
        Object.freeze({ category, status: "passed" as const, code: `${category}-ok` }),
      ),
    ),
  });
}

function failedIntegrityReport(failedCategory: SqliteIntegrityCategory): SqliteIntegrityReport {
  const failedIndex = SQLITE_INTEGRITY_CATEGORIES.indexOf(failedCategory);
  return Object.freeze({
    format: "senawa-sqlite-integrity",
    version: 1,
    status: "failed",
    checks: Object.freeze(
      SQLITE_INTEGRITY_CATEGORIES.map((category, index) => {
        const status =
          index < failedIndex
            ? ("passed" as const)
            : index === failedIndex
              ? ("failed" as const)
              : ("not-checked" as const);
        return Object.freeze({
          category,
          status,
          code:
            status === "passed"
              ? `${category}-ok`
              : status === "failed"
                ? `${category}-failed`
                : `${category}-not-checked`,
        });
      }),
    ),
  });
}

function classifyIntegrityFailure(error: unknown): SqliteIntegrityCategory {
  const message = error instanceof Error ? error.message : "";
  if (/backup|manifest|independent regular file/iu.test(message)) return "storage";
  if (/quick_check|foreign_key|database disk image|malformed/iu.test(message)) return "structure";
  if (/migration|schema version/iu.test(message)) return "migrations";
  if (/authority|canonical|event content digest/iu.test(message)) return "canonical-authority";
  if (/normalized|snapshot/iu.test(message)) return "normalized-projections";
  if (/context|runner|usage|allowance|budget|grant/iu.test(message)) return "context-and-runner";
  if (/amendment/iu.test(message)) return "amendments";
  if (/workspace|integration|barrier/iu.test(message)) return "workspaces";
  if (/human|approval|question|answer/iu.test(message)) return "human-authority";
  if (/portal/iu.test(message)) return "portal";
  if (/supervisor|service|wake|lease/iu.test(message)) return "supervisor";
  if (/remote|checkpoint|commitment|report chain/iu.test(message)) return "remote-delivery";
  if (/asset|digest|chunk/iu.test(message)) return "assets";
  return "storage";
}

function validateConfigurationSnapshot(
  input: unknown,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): ConfigurationSnapshotValue {
  const canonical = canonicalValue(input) as unknown;
  if (!isPlainRecord(canonical)) throw new TypeError("Configuration snapshot must be an object");
  if (canonical.apiVersion !== "senawa.dev/configuration-snapshot/v1") {
    throw new TypeError("Configuration snapshot apiVersion is unsupported");
  }
  const snapshot = validateConfigurationSnapshotContract(canonical, dependencies.sha256);
  return {
    snapshotDigest: snapshot.snapshotDigest,
    graph: snapshot.graph,
    canonical: snapshot as unknown as Record<string, unknown>,
  };
}

function normalizeAmendmentRows(snapshot: AuthoritySnapshot): NormalizedAmendmentRows {
  const proposals: Record<string, unknown>[] = [];
  const decisions: Record<string, unknown>[] = [];
  const withdrawals: Record<string, unknown>[] = [];
  const applications: Record<string, unknown>[] = [];
  for (const run of snapshot.runs) {
    const records = run.records;
    if (!isPlainRecord(records) || !Array.isArray(records.amendmentRecords)) continue;
    const runKey = canonicalStringify([run.repositoryId, run.runId]);
    for (const value of records.amendmentRecords) {
      if (!isPlainRecord(value) || !isPlainRecord(value.proposal)) {
        throw new TypeError("Runtime amendment records are not canonical objects");
      }
      const lifecycle = value as unknown as AmendmentLifecycleValue;
      const proposal = lifecycle.proposal;
      proposals.push({
        amendment_id: proposal.amendmentId,
        run_key: runKey,
        proposal_digest: proposal.proposalDigest,
        base_graph_revision_digest: proposal.baseGraph.revisionDigest,
        base_context_digest: proposal.baseContextDigest,
        base_snapshot_digest: proposal.baseConfigurationSnapshotDigest,
        result_snapshot_digest: proposal.resultConfigurationSnapshotDigest,
        reviewed_graph_revision_digest: proposal.reviewedResultGraph.revisionDigest,
        canonical_proposal: canonicalStringify(proposal),
      });
      if (lifecycle.decision !== undefined) {
        decisions.push({
          approval_id: lifecycle.decision.approvalId,
          amendment_id: proposal.amendmentId,
          proposal_digest: lifecycle.decision.proposalDigest,
          decision_digest: lifecycle.decision.decisionDigest,
          decision: lifecycle.decision.decision,
          canonical_decision: canonicalStringify(lifecycle.decision),
        });
      }
      if (lifecycle.withdrawal !== undefined) {
        withdrawals.push({
          amendment_id: proposal.amendmentId,
          withdrawal_digest: lifecycle.withdrawal.withdrawalDigest,
          canonical_withdrawal: canonicalStringify(lifecycle.withdrawal),
        });
      }
      if (lifecycle.application !== undefined) {
        applications.push({
          amendment_id: proposal.amendmentId,
          application_digest: lifecycle.application.applicationDigest,
          before_graph_revision_digest: lifecycle.application.beforeGraphRevisionDigest,
          after_graph_revision_digest: lifecycle.application.afterGraphRevisionDigest,
          quiescence_fact_digest: lifecycle.application.quiescenceFactDigest,
          canonical_application: canonicalStringify(lifecycle.application),
        });
      }
    }
  }
  return {
    proposals: proposals.sort(compareNormalized("amendment_id")),
    decisions: decisions.sort(compareNormalized("approval_id")),
    withdrawals: withdrawals.sort(compareNormalized("amendment_id")),
    applications: applications.sort(compareNormalized("amendment_id")),
  };
}

function markPlanImportApplied(
  database: Database.Database,
  evaluationDigest: string,
  decisionDigest: string,
  applicationDigest: string,
): void {
  if (![evaluationDigest, decisionDigest, applicationDigest].every(isSha256Digest)) {
    throw new TypeError("Applied fan-out linkage requires SHA-256 digests");
  }
  const importRow = database
    .prepare<
      [string],
      {
        acceptance_digest: string;
        proposal_digest: string;
        amendment_id: string;
        state: string;
      }
    >(
      `SELECT acceptance_digest, proposal_digest, amendment_id, state
       FROM plan_imports WHERE evaluation_digest = ?`,
    )
    .get(evaluationDigest);
  if (importRow === undefined || !["proposed", "approved"].includes(importRow.state)) {
    throw new TypeError("Plan import is not ready for applied linkage");
  }
  const canonicalImport = canonicalStringify({
    evaluationDigest,
    acceptanceDigest: importRow.acceptance_digest,
    proposalDigest: importRow.proposal_digest,
    amendmentId: importRow.amendment_id,
    decisionDigest,
    applicationDigest,
    state: "applied",
  });
  const changed = database
    .prepare(
      `UPDATE plan_imports
       SET state = 'applied', decision_digest = ?, application_digest = ?, canonical_import = ?
       WHERE evaluation_digest = ? AND state IN ('proposed', 'approved')`,
    )
    .run(decisionDigest, applicationDigest, canonicalImport, evaluationDigest).changes;
  if (changed !== 1) throw new TypeError("Plan import is not ready for applied linkage");
  database
    .prepare("UPDATE fan_out_evaluations SET applied = 1 WHERE evaluation_digest = ?")
    .run(evaluationDigest);
}

function linkAppliedPlanImport(database: Database.Database, result: unknown): void {
  const application = isPlainRecord(result) ? result.application : undefined;
  if (!isPlainRecord(application)) return;
  const row = database
    .prepare<[string], { evaluation_digest: string }>(
      `SELECT evaluation_digest FROM plan_imports
       WHERE amendment_id = ? AND state IN ('proposed', 'approved')`,
    )
    .get(String(application.amendmentId));
  if (row === undefined) return;
  markPlanImportApplied(
    database,
    row.evaluation_digest,
    String(application.decisionDigest),
    String(application.applicationDigest),
  );
}

function persistAmendmentProjections(
  database: Database.Database,
  snapshot: AuthoritySnapshot,
  dependencies: RuntimeDependencies,
): void {
  const expected = normalizeAmendmentRows(snapshot);
  for (const row of expected.proposals) {
    const proposal = JSON.parse(row.canonical_proposal as string) as AmendmentProposal;
    const base = requiredConfigurationSnapshotRow(database, row.base_snapshot_digest as string);
    const result = requiredConfigurationSnapshotRow(database, row.result_snapshot_digest as string);
    if (
      base.graph_revision_digest !== proposal.baseGraph.revisionDigest ||
      result.graph_revision_digest !== proposal.reviewedResultGraph.revisionDigest
    ) {
      throw new TypeError(
        "Amendment proposal configuration snapshots do not bind its exact graphs",
      );
    }
    validateConfigurationSnapshot(JSON.parse(base.canonical_snapshot), dependencies);
    validateConfigurationSnapshot(JSON.parse(result.canonical_snapshot), dependencies);
  }
  synchronizeAmendmentTable(database, "amendment_proposals", "amendment_id", expected.proposals);
  synchronizeAmendmentTable(database, "amendment_decisions", "approval_id", expected.decisions);
  synchronizeAmendmentTable(
    database,
    "amendment_withdrawals",
    "amendment_id",
    expected.withdrawals,
  );
  synchronizeAmendmentTable(
    database,
    "amendment_applications",
    "amendment_id",
    expected.applications,
  );
}

function synchronizeAmendmentTable(
  database: Database.Database,
  table: string,
  keyColumn: string,
  expected: readonly Record<string, unknown>[],
): void {
  const expectedKeys = new Set(expected.map((row) => String(row[keyColumn])));
  for (const row of database.prepare(`SELECT ${keyColumn} AS identity FROM ${table}`).all() as {
    identity: string;
  }[]) {
    if (!expectedKeys.has(row.identity)) {
      database.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(row.identity);
    }
  }
  for (const row of expected) {
    const columns = Object.keys(row);
    database
      .prepare(
        `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT(${keyColumn}) DO NOTHING`,
      )
      .run(...columns.map((column) => row[column]));
    const actual = database
      .prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE ${keyColumn} = ?`)
      .get(row[keyColumn]);
    if (canonicalStringify(actual) !== canonicalStringify(row)) {
      throw new Error(`SQLite ${table} row diverges from canonical runtime amendment authority`);
    }
  }
}

function requiredConfigurationSnapshotRow(database: Database.Database, digest: string) {
  const row = database
    .prepare<[string], { graph_revision_digest: string; canonical_snapshot: string }>(
      `SELECT graph_revision_digest, canonical_snapshot
       FROM configuration_snapshots WHERE snapshot_digest = ?`,
    )
    .get(digest);
  if (row === undefined) {
    throw new TypeError(`Configuration snapshot ${digest} is not durably registered`);
  }
  return row;
}

function isApprovedAmendmentDecision(
  value: unknown,
): value is { readonly amendmentId: string; readonly decision: "approve" } {
  return (
    isPlainRecord(value) && value.decision === "approve" && typeof value.amendmentId === "string"
  );
}

function findAmendmentLifecycle(
  snapshot: AuthoritySnapshot,
  repositoryId: string,
  runIdValue: string,
  amendmentId: string,
): AmendmentLifecycleValue {
  const run = snapshot.runs.find(
    (candidate) => candidate.repositoryId === repositoryId && candidate.runId === runIdValue,
  );
  const records = run?.records;
  if (!isPlainRecord(records) || !Array.isArray(records.amendmentRecords)) {
    throw new TypeError("Run has no durable amendment authority");
  }
  const value = records.amendmentRecords.find(
    (candidate) =>
      isPlainRecord(candidate) &&
      isPlainRecord(candidate.proposal) &&
      candidate.proposal.amendmentId === amendmentId,
  );
  if (value === undefined)
    throw new TypeError("Amendment proposal is absent from durable authority");
  return value as unknown as AmendmentLifecycleValue;
}

function installApprovedAmendmentFences(
  database: Database.Database,
  snapshot: AuthoritySnapshot,
  repositoryId: string,
  runIdValue: string,
  amendmentId: string,
  installedAt: string,
  dependencies: RuntimeDependencies,
): readonly TaskScopeCurrentness[] {
  const lifecycle = findAmendmentLifecycle(snapshot, repositoryId, runIdValue, amendmentId);
  if (lifecycle.decision?.decision !== "approve") {
    throw new TypeError("Only an approved amendment can install durable fences");
  }
  const runKey = canonicalStringify([repositoryId, runIdValue]);
  const fences = lifecycle.proposal.impact.affectedTaskScopes.map((scope) => {
    const current = requireTaskScopeCurrentness(database, runKey, {
      runId: runIdValue,
      taskId: scope.taskId,
      definitionGeneration: scope.definitionGeneration,
    });
    return {
      scope: {
        runId: current.runId,
        taskId: current.taskId,
        definitionGeneration: current.definitionGeneration,
      },
      expectedFenceGeneration: current.fenceGeneration,
      expectedAcceptedContextDigest: current.acceptedContextDigest,
    };
  });
  return installDurableTaskScopeFences(
    database,
    { repositoryId, runId: runIdValue, installedAt, fences },
    dependencies,
    amendmentId,
  );
}

function buildTrustedAmendmentQuiescence(
  database: Database.Database,
  canonicalAuthority: string,
  command: ReturnType<typeof decodeCommandEnvelope>,
  occurredAt: string,
  dependencies: RuntimeDependencies,
) {
  const payload = decodeApplyApprovedAmendmentPayload(command.payload);
  const lifecycle = findAmendmentLifecycle(
    parseSnapshot(canonicalAuthority),
    command.repositoryId,
    command.runId,
    payload.amendmentId,
  );
  if (
    lifecycle.decision?.decision !== "approve" ||
    lifecycle.decision.decisionDigest !== payload.decisionDigest
  ) {
    throw new TypeError("Apply does not name the exact durable approved decision");
  }
  const runKey = canonicalStringify([command.repositoryId, command.runId]);
  for (const scope of lifecycle.proposal.impact.affectedTaskScopes) {
    const current = requireTaskScopeCurrentness(database, runKey, {
      runId: command.runId,
      taskId: scope.taskId,
      definitionGeneration: scope.definitionGeneration,
    });
    if (current.claimsAccepted) throw new TypeError("Apply requires every affected scope fence");
    const row = database
      .prepare<[string, string, number], { amendment_id: string | null }>(
        `SELECT amendment_id FROM amendment_work_fences
         WHERE run_key = ? AND task_id = ? AND definition_generation = ?`,
      )
      .get(runKey, scope.taskId, scope.definitionGeneration);
    if (row?.amendment_id !== payload.amendmentId) {
      throw new TypeError("Apply affected scope fence belongs to a different transition");
    }
  }
  const affected = lifecycle.proposal.impact.affectedTaskScopes;
  // Quiescence has to reach the members beneath an affected phase, not only the
  // scopes the proposal names. A fan-out member is a task of its own, so an
  // amendment could otherwise apply while one was still working and rewrite the
  // graph under it.
  const counted = withMemberScopes(database, command.runId, affected);
  let liveClaimCount = 0;
  let nonterminalEffectCount = 0;
  for (const scope of counted) {
    liveClaimCount +=
      database
        .prepare<[string, string, number], { count: number }>(
          `SELECT count(*) AS count FROM runner_effect_claims
           WHERE run_key = ? AND task_id = ? AND definition_generation = ?`,
        )
        .get(runKey, scope.taskId, scope.definitionGeneration)?.count ?? 0;
    nonterminalEffectCount +=
      database
        .prepare<[string, string, number], { count: number }>(
          `SELECT count(*) AS count
           FROM runner_effect_intents i
           WHERE i.run_key = ?
             AND json_extract(i.canonical_intent, '$.command.taskScope.taskId') = ?
             AND json_extract(i.canonical_intent, '$.command.taskScope.definitionGeneration') = ?
             AND COALESCE((
               SELECT o.status FROM runner_effect_outcomes o
               WHERE o.intent_id = i.intent_id ORDER BY o.commit_cursor DESC LIMIT 1
             ), 'active') IN ('active', 'unknown')`,
        )
        .get(runKey, scope.taskId, scope.definitionGeneration)?.count ?? 0;
  }
  return createAmendmentQuiescenceFact(
    {
      occurredAt,
      affectedTaskScopes: affected,
      liveClaimCount,
      nonterminalEffectCount,
    },
    lifecycle.proposal,
    dependencies.sha256,
  );
}

function insertInitialTaskScopes(
  database: Database.Database,
  repositoryId: string,
  runIdValue: string,
  scopes: readonly TaskScopeCurrentness[],
): void {
  const runKey = canonicalStringify([repositoryId, runIdValue]);
  for (const scope of scopes) {
    if (scope.runId !== runIdValue || !scope.claimsAccepted) {
      throw new TypeError("Initial runner task scope must match the run and accept claims");
    }
    database
      .prepare(
        `INSERT INTO amendment_work_fences(
           run_key, repository_id, run_id, task_id, definition_generation,
           fence_generation, current_context_digest, claims_accepted, amendment_id, installed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)
         ON CONFLICT(run_key, task_id, definition_generation) DO NOTHING`,
      )
      .run(
        runKey,
        repositoryId,
        runIdValue,
        scope.taskId,
        scope.definitionGeneration,
        scope.fenceGeneration,
        scope.acceptedContextDigest,
      );
    const current = requireTaskScopeCurrentness(database, runKey, scope);
    if (!current.claimsAccepted || !sameDurableTaskScopeFence(scope, current)) {
      throw new TypeError("Runner and context task-scope initialization diverge");
    }
  }
}

function readTaskScopeCurrentness(
  database: Database.Database,
  runKey: string,
): readonly TaskScopeCurrentness[] {
  return Object.freeze(
    database
      .prepare<
        [string],
        {
          run_id: string;
          task_id: string;
          definition_generation: number;
          fence_generation: number;
          current_context_digest: string;
          claims_accepted: number;
        }
      >(
        `SELECT run_id, task_id, definition_generation, fence_generation,
                current_context_digest, claims_accepted
         FROM amendment_work_fences WHERE run_key = ?
         ORDER BY task_id, definition_generation`,
      )
      .all(runKey)
      .map(taskScopeCurrentnessFromRow),
  );
}

function requireTaskScopeCurrentness(
  database: Database.Database,
  runKey: string,
  scope: { readonly runId: string; readonly taskId: string; readonly definitionGeneration: number },
): TaskScopeCurrentness {
  const row = database
    .prepare<
      [string, string, number],
      {
        run_id: string;
        task_id: string;
        definition_generation: number;
        fence_generation: number;
        current_context_digest: string;
        claims_accepted: number;
      }
    >(
      `SELECT run_id, task_id, definition_generation, fence_generation,
              current_context_digest, claims_accepted
       FROM amendment_work_fences
       WHERE run_key = ? AND task_id = ? AND definition_generation = ?`,
    )
    .get(runKey, scope.taskId, scope.definitionGeneration);
  if (row === undefined || row.run_id !== scope.runId) {
    throw new TypeError("Task scope currentness is not durably configured");
  }
  return taskScopeCurrentnessFromRow(row);
}

function taskScopeCurrentnessFromRow(row: {
  readonly run_id: string;
  readonly task_id: string;
  readonly definition_generation: number;
  readonly fence_generation: number;
  readonly current_context_digest: string;
  readonly claims_accepted: number;
}): TaskScopeCurrentness {
  return Object.freeze({
    runId: row.run_id,
    taskId: row.task_id,
    definitionGeneration: row.definition_generation,
    acceptedContextDigest: row.current_context_digest,
    fenceGeneration: row.fence_generation,
    claimsAccepted: row.claims_accepted === 1,
  });
}

function sameDurableTaskScopeFence(
  left: {
    readonly runId: string;
    readonly taskId: string;
    readonly definitionGeneration: number;
    readonly acceptedContextDigest: string;
    readonly fenceGeneration: number;
  },
  right: TaskScopeCurrentness,
): boolean {
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.definitionGeneration === right.definitionGeneration &&
    left.acceptedContextDigest === right.acceptedContextDigest &&
    left.fenceGeneration === right.fenceGeneration
  );
}

function installDurableTaskScopeFences(
  database: Database.Database,
  input: InstallTaskScopeFencesInput,
  dependencies: Pick<RuntimeDependencies, "sha256">,
  amendmentId?: string,
): readonly TaskScopeCurrentness[] {
  validateTimestamp(input.installedAt, "installedAt");
  const runKey = canonicalStringify([input.repositoryId, input.runId]);
  const installations = [...input.fences].sort((left, right) =>
    compareText(taskScopeKey(left.scope), taskScopeKey(right.scope)),
  );
  const seen = new Set<string>();
  const current = installations.map((installation) => {
    if (installation.scope.runId !== input.runId) {
      throw new TypeError("Fence scope does not match the target run");
    }
    const key = taskScopeKey(installation.scope);
    if (seen.has(key)) throw new TypeError("Fence installations must be unique");
    seen.add(key);
    const scope = requireTaskScopeCurrentness(database, runKey, installation.scope);
    if (
      !scope.claimsAccepted ||
      scope.fenceGeneration !== installation.expectedFenceGeneration ||
      scope.acceptedContextDigest !== installation.expectedAcceptedContextDigest
    ) {
      throw new TypeError("Task scope fence expectation is stale");
    }
    return scope;
  });
  const contextState = database
    .prepare<[], ContextAuthorityStateRow>(
      "SELECT canonical_json FROM context_authority_state WHERE singleton = 1",
    )
    .get();
  if (contextState === undefined) throw new Error("SQLite context authority singleton is missing");
  const contextAuthority = InMemoryContextAuthority.fromDurableCanonicalJson(
    contextState.canonical_json,
    dependencies.sha256,
    storedContextDispatches(database),
  );
  overlayContextTaskScopeCurrentness(database, contextAuthority);
  const contextInstallations = installations.filter((installation) =>
    contextAuthority.taskScopes.has(taskScopeKey(installation.scope)),
  );
  const fencedDispatches = contextAuthority
    .durableSnapshot()
    .dispatches.filter((record) =>
      installations.some(
        (installation) => taskScopeKey(installation.scope) === taskScopeKey(record.taskScope),
      ),
    );
  const installed = current.map((scope) => {
    const result = database
      .prepare(
        `UPDATE amendment_work_fences
         SET fence_generation = fence_generation + 1, claims_accepted = 0,
             amendment_id = ?, installed_at = ?
         WHERE run_key = ? AND task_id = ? AND definition_generation = ?
           AND fence_generation = ? AND current_context_digest = ? AND claims_accepted = 1`,
      )
      .run(
        amendmentId ?? null,
        input.installedAt,
        runKey,
        scope.taskId,
        scope.definitionGeneration,
        scope.fenceGeneration,
        scope.acceptedContextDigest,
      );
    if (result.changes !== 1) throw new TypeError("Task scope fence lost a concurrent race");
    database
      .prepare(
        `INSERT INTO runner_cancellation_requests(intent_id, owner_id, fence, requested_at)
         SELECT i.intent_id, i.owner_id, i.fence, ?
         FROM runner_effect_intents i
         WHERE i.run_key = ?
           AND json_extract(i.canonical_intent, '$.command.taskScope.taskId') = ?
           AND json_extract(i.canonical_intent, '$.command.taskScope.definitionGeneration') = ?
           AND COALESCE((
             SELECT o.status FROM runner_effect_outcomes o
             WHERE o.intent_id = i.intent_id ORDER BY o.commit_cursor DESC LIMIT 1
           ), 'active') IN ('active', 'unknown')
         ON CONFLICT(intent_id) DO NOTHING`,
      )
      .run(input.installedAt, runKey, scope.taskId, scope.definitionGeneration);
    return Object.freeze({
      ...scope,
      fenceGeneration: scope.fenceGeneration + 1,
      claimsAccepted: false,
    });
  });
  if (contextInstallations.length > 0) {
    contextAuthority.installTaskScopeFences({ ...input, fences: contextInstallations });
    database
      .prepare("UPDATE context_authority_state SET canonical_json = ? WHERE singleton = 1")
      .run(contextAuthority.toDurableCanonicalJsonWithoutDispatches());
  }
  if (amendmentId !== undefined) {
    for (const record of fencedDispatches) {
      database
        .prepare(
          `INSERT INTO amendment_fenced_dispatches(
             amendment_id, dispatch_id, task_id, definition_generation,
             prior_fence_generation, installed_fence_generation
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          amendmentId,
          record.dispatch.dispatchId,
          record.taskScope.taskId,
          record.taskScope.definitionGeneration,
          record.taskScope.fenceGeneration,
          record.taskScope.fenceGeneration + 1,
        );
    }
  }
  return Object.freeze(installed);
}

/**
 * The dispatches from the table that holds them, in the snapshot's own shape.
 *
 * The durable snapshot leaves them out, because it is rewritten whole on every
 * change and they are about four fifths of it. They go back through the same
 * validation the snapshot's own dispatches take.
 */
function storedContextDispatches(database: Database.Database): readonly unknown[] {
  const rows = database
    .prepare<
      [],
      {
        canonical_dispatch: string;
        canonical_completion_requirements: string;
        canonical_task_scope: string;
        canonical_effect: string | null;
        context_id: string;
      }
    >(
      `SELECT canonical_dispatch, canonical_completion_requirements,
              canonical_task_scope, canonical_effect, context_id
       FROM context_dispatches ORDER BY dispatch_id`,
    )
    .all();
  if (rows.length === 0) return [];
  const contexts = new Map(
    database
      .prepare<[], { context_id: string; canonical_context: string }>(
        "SELECT context_id, canonical_context FROM context_bases",
      )
      .all()
      .map((row) => [row.context_id, row.canonical_context] as const),
  );
  return rows.map((row) => {
    const context = contexts.get(row.context_id);
    if (context === undefined) throw new Error("Context dispatch names an absent context base");
    return {
      context: JSON.parse(context) as unknown,
      dispatch: JSON.parse(row.canonical_dispatch) as unknown,
      completionRequirements: JSON.parse(row.canonical_completion_requirements) as unknown,
      taskScope: JSON.parse(row.canonical_task_scope) as unknown,
      ...(row.canonical_effect === null
        ? {}
        : { effect: JSON.parse(row.canonical_effect) as unknown }),
    };
  });
}

function overlayContextTaskScopeCurrentness(
  database: Database.Database,
  authority: InMemoryContextAuthority,
): void {
  for (const [key, scope] of authority.taskScopes) {
    let dispatch:
      | (typeof authority.dispatches extends Map<string, infer Value> ? Value : never)
      | undefined;
    for (const record of authority.dispatches.values()) {
      if (taskScopeKey(record.taskScope) === key) {
        dispatch = record;
        break;
      }
    }
    if (dispatch === undefined) throw new Error("Context task scope lacks a durable dispatch");
    const current = requireTaskScopeCurrentness(
      database,
      canonicalStringify([dispatch.dispatch.repositoryId, dispatch.dispatch.runId]),
      scope,
    );
    authority.taskScopes.set(key, current);
  }
}

function synchronizeContextTaskScopes(
  database: Database.Database,
  rows: readonly Record<string, unknown>[],
): void {
  for (const row of rows) {
    const existing = database
      .prepare<
        [string, string, number],
        {
          run_id: string;
          task_id: string;
          definition_generation: number;
          fence_generation: number;
          current_context_digest: string;
          claims_accepted: number;
        }
      >(
        `SELECT run_id, task_id, definition_generation, fence_generation,
                current_context_digest, claims_accepted
         FROM amendment_work_fences
         WHERE run_key = ? AND task_id = ? AND definition_generation = ?`,
      )
      .get(row.run_key as string, row.task_id as string, row.definition_generation as number);
    if (existing === undefined) {
      database
        .prepare(
          `INSERT INTO amendment_work_fences(
             run_key, repository_id, run_id, task_id, definition_generation,
             fence_generation, current_context_digest, claims_accepted, amendment_id, installed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          row.run_key,
          row.repository_id,
          row.run_id,
          row.task_id,
          row.definition_generation,
          row.fence_generation,
          row.current_context_digest,
          row.claims_accepted,
        );
      continue;
    }
    const expected = {
      run_id: row.run_id,
      task_id: row.task_id,
      definition_generation: row.definition_generation,
      fence_generation: row.fence_generation,
      current_context_digest: row.current_context_digest,
      claims_accepted: row.claims_accepted,
    };
    if (canonicalStringify(existing) === canonicalStringify(expected)) continue;
    // Only the context authority writes the accepted digest, and it advances it
    // when a later attempt takes the scope over. Fencing moves the other two
    // fields, so a difference there is a genuine divergence.
    if (
      existing.fence_generation === row.fence_generation &&
      existing.claims_accepted === row.claims_accepted &&
      existing.run_id === row.run_id
    ) {
      database
        .prepare(
          `UPDATE amendment_work_fences SET current_context_digest = ?
           WHERE run_key = ? AND task_id = ? AND definition_generation = ?`,
        )
        .run(row.current_context_digest, row.run_key, row.task_id, row.definition_generation);
      continue;
    }
    throw new Error("Context and runner task-scope currentness diverge");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lists undelivered outbox submission identifiers in deterministic delivery order.
 *
 * Drains iterate this list rather than attempting only its head. A fact whose
 * consumer defers or throws stays pending indefinitely, and attempting only the
 * lowest-sorted entry would let that one fact block delivery for every other run.
 */
function pendingOutboxSubmissionIds(
  outbox: ReadonlyMap<string, { readonly delivered: boolean }>,
): readonly string[] {
  return [...outbox.entries()]
    .filter(([, entry]) => !entry.delivered)
    .map(([submissionId]) => submissionId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Attempts one background outbox delivery without letting it abort the drain.
 *
 * Drains run on the supervisor's background pump. A consumer that throws must
 * leave its fact pending for a later attempt rather than unwind through the
 * pump, which would leak the run lease and take the daemon down with it.
 */
function drainOutboxEntry(deliver: () => boolean): boolean {
  try {
    return deliver();
  } catch {
    return false;
  }
}

/**
 * Applies the durability and concurrency pragmas every writing connection must share.
 *
 * Every connection that writes to the authority database has to agree on these
 * pragmas. A connection that omits `synchronous = FULL` acknowledges writes that
 * a power loss can still discard, so this helper is exported to keep hosts
 * outside this module from configuring a weaker connection by hand.
 */
export function configureWriteConnection(database: Database.Database, busyTimeoutMs: number): void {
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  retrySqliteLock(() => database.pragma("journal_mode = WAL"), busyTimeoutMs);
  database.pragma("synchronous = FULL");
  database.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
}

function retrySqliteLock<T>(operation: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteLockError(error) || Date.now() >= deadline) throw error;
      const remaining = Math.max(1, Math.min(10, deadline - Date.now()));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
    }
  }
}

function openReadConnection(path: string): Database.Database {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
  database.pragma("query_only = ON");
  return database;
}

function openRestoreVerificationConnection(path: string): Database.Database {
  const database = new Database(path, { fileMustExist: true });
  database.pragma("journal_mode = DELETE");
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
  database.pragma("query_only = ON");
  return database;
}

function digestCanonicalText(
  canonical: string,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): string {
  const digest = dependencies.sha256.digest(new TextEncoder().encode(canonical));
  if (!isSha256Digest(digest)) {
    throw new TypeError("SHA-256 implementations must return lowercase hexadecimal digests");
  }
  return digest;
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function validatePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function validateRemoteSequenceWindow(value: number): void {
  validatePositiveSafeInteger(value, "sequenceWindow");
  if (value > MAX_REMOTE_SEQUENCE_WINDOW) {
    throw new TypeError(`sequenceWindow must not exceed ${MAX_REMOTE_SEQUENCE_WINDOW}`);
  }
}

function requireRemotePeer(database: Database.Database, bindingId: string): RemotePeerRow {
  const row = database
    .prepare<[string], RemotePeerRow>("SELECT * FROM remote_peer_state WHERE binding_id = ?")
    .get(bindingId);
  if (row === undefined) throw new TypeError(`Remote binding ${bindingId} is not registered`);
  return row;
}

function requireRemoteCheckpoint(
  database: Database.Database,
  bindingId: string,
  streamKind: RemoteStreamCheckpoint["streamKind"],
): RemoteCheckpointRow {
  const row = database
    .prepare<[string, string], RemoteCheckpointRow>(
      `SELECT * FROM remote_stream_checkpoints
       WHERE binding_id = ? AND stream_kind = ?`,
    )
    .get(bindingId, streamKind);
  if (row === undefined) {
    throw new Error(`Remote ${streamKind} checkpoint is missing for ${bindingId}`);
  }
  return row;
}

function requireRemoteHistoryCommitment(
  database: Database.Database,
  bindingId: string,
): RemoteHistoryCommitmentRow {
  const row = database
    .prepare<[string], RemoteHistoryCommitmentRow>(
      "SELECT * FROM remote_history_commitments WHERE binding_id = ?",
    )
    .get(bindingId);
  if (row === undefined) {
    throw new Error(`Remote history commitment is missing for ${bindingId}`);
  }
  return row;
}

function canonicalRemoteRunEventCommitments(
  database: Database.Database,
  bindingId: string,
): string {
  const rows = database
    .prepare<[string], RemoteRunEventCheckpointRow>(
      `SELECT * FROM remote_run_event_checkpoints
       WHERE binding_id = ? ORDER BY run_id`,
    )
    .all(bindingId);
  return canonicalStringify(rows.map(remoteRunEventCheckpoint));
}

function assertRemoteHistoryCommitmentCurrent(
  database: Database.Database,
  bindingId: string,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const peer = requireRemotePeer(database, bindingId);
  const commitment = requireRemoteHistoryCommitment(database, bindingId);
  const inbound = requireRemoteCheckpoint(database, bindingId, "inbound-command");
  const outbound = requireRemoteCheckpoint(database, bindingId, "outbound-report");
  const acknowledged = requireRemoteCheckpoint(database, bindingId, "outbound-acknowledgement");
  const synchronization = requireRemoteSynchronization(database, bindingId);
  const canonicalRunEventCommitments = canonicalRemoteRunEventCommitments(database, bindingId);
  if (
    commitment.repository_id !== peer.repository_id ||
    commitment.binding_digest !== peer.binding_digest ||
    commitment.canonical_binding !== peer.canonical_binding ||
    commitment.inbound_sequence !== inbound.contiguous_sequence ||
    commitment.inbound_digest !== inbound.last_digest ||
    commitment.outbound_report_sequence !== outbound.contiguous_sequence ||
    commitment.outbound_report_digest !== outbound.last_digest ||
    commitment.acknowledged_report_sequence !== acknowledged.contiguous_sequence ||
    commitment.acknowledged_report_digest !== acknowledged.last_digest ||
    commitment.acknowledged_cursor !== synchronization.centrally_acknowledged_cursor ||
    commitment.canonical_run_event_commitments !== canonicalRunEventCommitments ||
    commitment.run_event_commitments_digest !==
      digestCanonicalText(canonicalRunEventCommitments, dependencies)
  ) {
    throw new Error(`Remote history commitment diverges from normalized state for ${bindingId}`);
  }
}

function refreshRemoteHistoryCommitment(
  database: Database.Database,
  bindingId: string,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const inbound = requireRemoteCheckpoint(database, bindingId, "inbound-command");
  const outbound = requireRemoteCheckpoint(database, bindingId, "outbound-report");
  const acknowledged = requireRemoteCheckpoint(database, bindingId, "outbound-acknowledgement");
  const synchronization = requireRemoteSynchronization(database, bindingId);
  const canonicalRunEventCommitments = canonicalRemoteRunEventCommitments(database, bindingId);
  const result = database
    .prepare(
      `UPDATE remote_history_commitments
       SET inbound_sequence = ?, inbound_digest = ?,
           outbound_report_sequence = ?, outbound_report_digest = ?,
           acknowledged_report_sequence = ?, acknowledged_report_digest = ?,
           acknowledged_cursor = ?, canonical_run_event_commitments = ?,
           run_event_commitments_digest = ?
       WHERE binding_id = ?
         AND inbound_sequence <= ?
         AND outbound_report_sequence <= ?
         AND acknowledged_report_sequence <= ?
         AND acknowledged_cursor <= ?`,
    )
    .run(
      inbound.contiguous_sequence,
      inbound.last_digest,
      outbound.contiguous_sequence,
      outbound.last_digest,
      acknowledged.contiguous_sequence,
      acknowledged.last_digest,
      synchronization.centrally_acknowledged_cursor,
      canonicalRunEventCommitments,
      digestCanonicalText(canonicalRunEventCommitments, dependencies),
      bindingId,
      inbound.contiguous_sequence,
      outbound.contiguous_sequence,
      acknowledged.contiguous_sequence,
      synchronization.centrally_acknowledged_cursor,
    );
  if (result.changes !== 1) {
    throw new Error(`Remote history commitment cannot move backwards for ${bindingId}`);
  }
}

function updateRemoteCheckpoint(
  database: Database.Database,
  bindingId: string,
  streamKind: RemoteStreamCheckpoint["streamKind"],
  sequence: number,
  digest: string,
  updatedAt: string,
): void {
  const result = database
    .prepare(
      `UPDATE remote_stream_checkpoints
       SET contiguous_sequence = ?, last_digest = ?, updated_at = ?
       WHERE binding_id = ? AND stream_kind = ?`,
    )
    .run(sequence, digest, updatedAt, bindingId, streamKind);
  if (result.changes !== 1) throw new Error(`Remote ${streamKind} checkpoint is missing`);
}

function requireRemoteSynchronization(
  database: Database.Database,
  bindingId: string,
): RemoteSynchronizationRow {
  const row = database
    .prepare<[string], RemoteSynchronizationRow>(
      "SELECT * FROM remote_synchronization_vectors WHERE binding_id = ?",
    )
    .get(bindingId);
  if (row === undefined) throw new Error(`Remote synchronization is missing for ${bindingId}`);
  return row;
}

function readRemoteRunEventCheckpoint(
  database: Database.Database,
  bindingId: string,
  runId: string,
): RemoteRunEventCheckpointRow | undefined {
  return database
    .prepare<[string, string], RemoteRunEventCheckpointRow>(
      `SELECT * FROM remote_run_event_checkpoints
       WHERE binding_id = ? AND run_id = ?`,
    )
    .get(bindingId, runId);
}

function remoteRunEventCheckpoint(row: RemoteRunEventCheckpointRow): RemoteRunEventCheckpoint {
  return Object.freeze({
    bindingId: row.binding_id,
    repositoryId: row.repository_id,
    runId: row.run_id,
    localLatestCursor: row.local_latest_cursor,
    durablyEnqueuedCursor: row.durably_enqueued_cursor,
    centrallyAcknowledgedCursor: row.centrally_acknowledged_cursor,
    lastEnqueuedReportSequence: row.last_enqueued_report_sequence,
    lastAcknowledgedReportSequence: row.last_acknowledged_report_sequence,
  });
}

function assertRemoteBindingRow(
  peer: RemotePeerRow,
  binding: RemoteRepositoryBinding,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const canonicalBinding = canonicalStringify(binding);
  if (
    peer.binding_id !== binding.bindingId ||
    peer.repository_id !== binding.repositoryId ||
    peer.binding_digest !== digestCanonicalText(canonicalBinding, dependencies) ||
    peer.canonical_binding !== canonicalBinding
  ) {
    throw new RemoteDeliveryConflictError(
      `Remote binding ${binding.bindingId} does not match durable peer state`,
    );
  }
}

function assertRemoteCommandDigestBindings(
  envelope: RemoteCommandEnvelope,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const accepted = envelope.acceptedCommand;
  const commandDigest = dependencies.sha256.digest(canonicalBytes(accepted.command));
  const acceptedDigest = dependencies.sha256.digest(canonicalBytes(accepted));
  if (commandDigest !== accepted.commandDigest) {
    throw new RemoteDeliveryConflictError("Remote command digest does not bind its command");
  }
  if (acceptedDigest !== envelope.acceptedCommandDigest) {
    throw new RemoteDeliveryConflictError(
      "Remote accepted-command digest does not bind its accepted command",
    );
  }
}

const FORBIDDEN_REMOTE_COMMAND_FIELDS = new Set([
  "assetbytes",
  "assetcontent",
  "canonicalpath",
  "context",
  "contextbytes",
  "credential",
  "credentials",
  "endpoint",
  "granttoken",
  "lease",
  "leases",
  "privatekey",
  "privatekeypath",
  "prompt",
  "promptbytes",
  "rawassetcontent",
  "repositorypath",
  "sdksessionid",
  "source",
  "sourcepath",
  "token",
  "workspacepath",
]);

function assertNoForbiddenRemoteCommandData(value: JsonValue, path = "$.payload"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoForbiddenRemoteCommandData(item, `${path}[${index}]`);
    }
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
    if (FORBIDDEN_REMOTE_COMMAND_FIELDS.has(normalizedKey)) {
      throw new TypeError(`Remote command contains forbidden local-only field ${path}.${key}`);
    }
    assertNoForbiddenRemoteCommandData(item as JsonValue, `${path}.${key}`);
  }
}

function readRemoteInboxRow(
  database: Database.Database,
  bindingId: string,
  sequence: number,
): RemoteInboxRow | undefined {
  return database
    .prepare<[string, number], RemoteInboxRow>(
      `SELECT * FROM remote_command_inbox WHERE binding_id = ? AND sequence = ?`,
    )
    .get(bindingId, sequence);
}

function assertRemoteInboxIdentityAvailable(
  database: Database.Database,
  envelope: RemoteCommandEnvelope,
  envelopeDigest: string,
): void {
  const bindingId = envelope.acceptedCommand.binding.bindingId;
  const row = database
    .prepare<
      [string, string, string, string],
      { sequence: number; acceptance_id: string; command_id: string; envelope_digest: string }
    >(
      `SELECT sequence, acceptance_id, command_id, envelope_digest
       FROM remote_command_inbox
       WHERE binding_id = ?
         AND (acceptance_id = ? OR command_id = ? OR envelope_digest = ?)
       LIMIT 1`,
    )
    .get(
      bindingId,
      envelope.acceptedCommand.acceptanceId,
      envelope.acceptedCommand.command.commandId,
      envelopeDigest,
    );
  if (row !== undefined) {
    throw new RemoteDeliveryConflictError(
      `Remote command identity is already bound at sequence ${row.sequence}`,
    );
  }
}

function reconcileRemoteInbox(
  database: Database.Database,
  bindingId: string,
  updatedAt: string,
): void {
  let checkpoint = requireRemoteCheckpoint(database, bindingId, "inbound-command");
  while (true) {
    const next = readRemoteInboxRow(database, bindingId, checkpoint.contiguous_sequence + 1);
    if (next === undefined) return;
    if (next.previous_envelope_digest !== checkpoint.last_digest) {
      if (
        next.processing_state === "waiting" ||
        next.processing_state === "expired" ||
        next.processing_state === "revoked"
      ) {
        database
          .prepare(
            `UPDATE remote_command_inbox SET processing_state = 'conflict'
             WHERE binding_id = ? AND sequence = ?
               AND processing_state IN ('waiting', 'expired', 'revoked')`,
          )
          .run(bindingId, next.sequence);
      }
      return;
    }
    if (next.processing_state === "waiting") {
      database
        .prepare(
          `UPDATE remote_command_inbox SET processing_state = 'ready'
           WHERE binding_id = ? AND sequence = ? AND processing_state = 'waiting'`,
        )
        .run(bindingId, next.sequence);
    }
    updateRemoteCheckpoint(
      database,
      bindingId,
      "inbound-command",
      next.sequence,
      next.envelope_digest,
      updatedAt,
    );
    checkpoint = {
      ...checkpoint,
      contiguous_sequence: next.sequence,
      last_digest: next.envelope_digest,
      updated_at: updatedAt,
    };
  }
}

function toRemoteInboxRecord(row: RemoteInboxRow): RemoteInboxRecord {
  return Object.freeze({
    bindingId: row.binding_id,
    sequence: row.sequence,
    envelopeDigest: row.envelope_digest,
    canonicalEnvelope: row.canonical_envelope,
    envelope: decodeRemoteCommandEnvelope(row.canonical_envelope),
    deliveryEntry: decodeRemoteReceiptChainEntry(row.canonical_delivery_entry),
    receivedAt: row.received_at,
    processingState: row.processing_state,
    ...(row.canonical_local_acceptance === null
      ? {}
      : { localAcceptance: decodeRemoteReceiptChainEntry(row.canonical_local_acceptance) }),
    ...(row.canonical_local_result === null
      ? {}
      : { localResult: decodeRemoteReceiptChainEntry(row.canonical_local_result) }),
  });
}

function remoteLocalCommandId(entry: RemoteReceiptChainEntry): string {
  if (entry.evidence.type !== "local-receipt" && entry.evidence.type !== "local-outcome") {
    throw new TypeError("Remote receipt entry does not contain local command evidence");
  }
  return entry.evidence.localCommandId;
}

function assertSynchronizationForEnqueue(
  synchronization: RemoteSynchronizationVector,
  current: RemoteSynchronizationRow,
): void {
  if (isZeroRemoteSynchronization(synchronization)) return;
  if (
    synchronization.repositoryId !== current.repository_id ||
    synchronization.localLatestCursor < current.local_latest_cursor ||
    synchronization.durablyEnqueuedCursor < current.durably_enqueued_cursor ||
    synchronization.centrallyAcknowledgedCursor !== current.centrally_acknowledged_cursor ||
    synchronization.lastAcknowledgedAt !== current.last_acknowledged_at ||
    Date.parse(synchronization.localObservedAt) < Date.parse(current.local_observed_at)
  ) {
    throw new RemoteDeliveryConflictError(
      "Remote report synchronization does not extend durable synchronization state",
    );
  }
}

function isZeroRemoteSynchronization(synchronization: RemoteSynchronizationVector): boolean {
  return (
    synchronization.localLatestCursor === 0 &&
    synchronization.durablyEnqueuedCursor === 0 &&
    synchronization.centrallyAcknowledgedCursor === 0 &&
    synchronization.lastEnqueuedAt === null &&
    synchronization.lastAcknowledgedAt === null
  );
}

function applyRemoteRunEventAdvances(
  database: Database.Database,
  report: RemoteClassifiedReport,
  advances: readonly RemoteRunEventAdvance[],
): void {
  const representedRunIds = new Set(report.events.map((event) => event.runId));
  if (
    (report.events.length > 0 && representedRunIds.size !== advances.length) ||
    (report.events.length === 0 && advances.length > 1)
  ) {
    throw new RemoteDeliveryConflictError(
      "Remote report event metadata requires an exact set of run checkpoint advances",
    );
  }
  const advancedRunIds = new Set<string>();
  for (const advance of advances) {
    if (
      advancedRunIds.has(advance.runId) ||
      (report.events.length > 0 && !representedRunIds.has(advance.runId))
    ) {
      throw new RemoteDeliveryConflictError(
        "Remote report event metadata requires an exact set of run checkpoint advances",
      );
    }
    advancedRunIds.add(advance.runId);
    applyRemoteRunEventAdvance(database, report, advance);
  }
  if (advances.length === 0) return;
  const aggregate = remoteRunEventAggregate(database, report.binding.bindingId);
  if (
    report.synchronization.localLatestCursor !== aggregate.localLatestCursor ||
    report.synchronization.durablyEnqueuedCursor !== aggregate.durablyEnqueuedCursor ||
    report.synchronization.centrallyAcknowledgedCursor !== aggregate.centrallyAcknowledgedCursor
  ) {
    throw new RemoteDeliveryConflictError(
      "Remote report synchronization does not equal its per-run event checkpoints",
    );
  }
}

function normalizeRemoteRunEventAdvances(
  input: RemoteRunEventAdvance | readonly RemoteRunEventAdvance[] | undefined,
): readonly RemoteRunEventAdvance[] {
  return input === undefined ? [] : Array.isArray(input) ? input : [input as RemoteRunEventAdvance];
}

function assertRemoteReportReplayExact(
  database: Database.Database,
  report: RemoteClassifiedReport,
  canonicalReport: string,
  reportDigest: string,
  advances: readonly RemoteRunEventAdvance[],
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const durableReport = database
    .prepare<[string], RemoteReportReplayRow>(
      `SELECT report_id, binding_id, report_sequence, previous_report_digest,
              report_digest, event_advance_count, canonical_report
       FROM remote_report_outbox WHERE report_id = ?`,
    )
    .get(report.reportId);
  if (
    durableReport === undefined ||
    durableReport.binding_id !== report.binding.bindingId ||
    durableReport.report_sequence !== report.reportSequence ||
    durableReport.previous_report_digest !== report.previousReportDigest ||
    durableReport.report_digest !== reportDigest ||
    durableReport.canonical_report !== canonicalReport ||
    durableReport.event_advance_count !== advances.length
  ) {
    throw new RemoteDeliveryConflictError(
      `Remote report ${report.reportId} retry differs from durable content`,
    );
  }
  const canonicalAdvances = canonicalStringify(
    [...advances]
      .sort((left, right) => (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0))
      .map((advance) => ({
        repositoryId: advance.repositoryId,
        runId: advance.runId,
        fromCursor: advance.fromCursor,
        throughCursor: advance.throughCursor,
        localLatestCursor: advance.localLatestCursor,
      })),
  );
  const canonicalDurableAdvances = canonicalStringify(
    database
      .prepare<[string], RemoteReportRunEventAdvanceRow>(
        `SELECT a.*, r.report_sequence, r.canonical_report,
                r.binding_id AS report_binding_id,
                r.repository_id AS report_repository_id
         FROM remote_report_run_event_advances a
         JOIN remote_report_outbox r
           ON r.report_id = a.report_id AND r.binding_id = a.binding_id
         WHERE a.report_id = ? ORDER BY a.run_id`,
      )
      .all(report.reportId)
      .map((advance) => ({
        repositoryId: advance.repository_id,
        runId: advance.run_id,
        fromCursor: advance.from_cursor,
        throughCursor: advance.through_cursor,
        localLatestCursor: advance.local_latest_cursor,
      })),
  );
  if (canonicalAdvances !== canonicalDurableAdvances) {
    throw new RemoteDeliveryConflictError(
      `Remote report ${report.reportId} retry has different run event advances`,
    );
  }

  const commitment = requireRemoteHistoryCommitment(database, report.binding.bindingId);
  const committedReports = database
    .prepare<[string], RemoteReportReplayRow>(
      `SELECT report_id, binding_id, report_sequence, previous_report_digest,
              report_digest, event_advance_count, canonical_report
       FROM remote_report_outbox
       WHERE binding_id = ? ORDER BY report_sequence`,
    )
    .all(report.binding.bindingId);
  let expectedSequence = 1;
  let expectedPreviousDigest: string | null = null;
  let lastDigest: string | null = null;
  let replayIncluded = false;
  for (const committedReport of committedReports) {
    const computedDigest = digestCanonicalText(committedReport.canonical_report, dependencies);
    if (
      committedReport.report_sequence !== expectedSequence ||
      committedReport.previous_report_digest !== expectedPreviousDigest ||
      committedReport.report_digest !== computedDigest
    ) {
      throw new RemoteDeliveryConflictError(
        `Remote report ${report.reportId} retry diverges from committed report history`,
      );
    }
    expectedSequence += 1;
    expectedPreviousDigest = committedReport.report_digest;
    lastDigest = committedReport.report_digest;
    replayIncluded ||= committedReport.report_id === report.reportId;
  }
  if (
    !replayIncluded ||
    commitment.outbound_report_sequence !== expectedSequence - 1 ||
    commitment.outbound_report_digest !== lastDigest
  ) {
    throw new RemoteDeliveryConflictError(
      `Remote report ${report.reportId} retry is not covered by the history commitment`,
    );
  }
}

function applyRemoteRunEventAdvance(
  database: Database.Database,
  report: RemoteClassifiedReport,
  advance: RemoteRunEventAdvance,
): void {
  validateStorageIdentifier(advance.repositoryId, "repositoryId");
  validateStorageIdentifier(advance.runId, "runId");
  validateNonNegativeSafeInteger(advance.fromCursor, "fromCursor");
  validateNonNegativeSafeInteger(advance.throughCursor, "throughCursor");
  validateNonNegativeSafeInteger(advance.localLatestCursor, "localLatestCursor");
  if (
    advance.repositoryId !== report.binding.repositoryId ||
    advance.throughCursor < advance.fromCursor ||
    advance.localLatestCursor < advance.throughCursor
  ) {
    throw new RemoteDeliveryConflictError("Remote run event advance is invalid");
  }
  const current = readRemoteRunEventCheckpoint(database, report.binding.bindingId, advance.runId);
  if (
    (current !== undefined && current.repository_id !== advance.repositoryId) ||
    advance.fromCursor !== (current?.durably_enqueued_cursor ?? 0) ||
    advance.localLatestCursor < (current?.local_latest_cursor ?? 0)
  ) {
    throw new RemoteDeliveryConflictError(
      "Remote run event advance does not extend its durable checkpoint",
    );
  }
  const runKey = canonicalStringify([advance.repositoryId, advance.runId]);
  const durableRun = database
    .prepare<[string], { repository_id: string; run_id: string; cursor: number }>(
      "SELECT repository_id, run_id, cursor FROM runs WHERE run_key = ?",
    )
    .get(runKey);
  if (
    durableRun === undefined ||
    durableRun.repository_id !== advance.repositoryId ||
    durableRun.run_id !== advance.runId
  ) {
    throw new RemoteDeliveryConflictError(
      "Remote run event advance does not reference an authoritative local run",
    );
  }
  if (advance.localLatestCursor > durableRun.cursor) {
    throw new RemoteDeliveryConflictError(
      "Remote run event advance exceeds the local authority cursor",
    );
  }
  const exactEvents = database
    .prepare<[string, number, number], { canonical_frame: string }>(
      `SELECT canonical_frame FROM event_frames
       WHERE run_key = ? AND cursor > ? AND cursor <= ? ORDER BY cursor`,
    )
    .all(runKey, advance.fromCursor, advance.throughCursor)
    .map((row) => remoteEventMetadata(decodeEventStreamFrame(row.canonical_frame)));
  if (
    report.events.some((event) => event.repositoryId !== report.binding.repositoryId) ||
    canonicalStringify(report.events.filter((event) => event.runId === advance.runId)) !==
      canonicalStringify(exactEvents)
  ) {
    throw new RemoteDeliveryConflictError(
      "Remote report event metadata does not exactly cover its run checkpoint advance",
    );
  }
  database
    .prepare(
      `INSERT INTO remote_run_event_checkpoints(
         binding_id, repository_id, run_id, local_latest_cursor,
         durably_enqueued_cursor, centrally_acknowledged_cursor,
         last_enqueued_report_sequence, last_acknowledged_report_sequence
       ) VALUES (?, ?, ?, ?, ?, 0, ?, 0)
       ON CONFLICT(binding_id, run_id) DO UPDATE SET
         local_latest_cursor = excluded.local_latest_cursor,
         durably_enqueued_cursor = excluded.durably_enqueued_cursor,
         last_enqueued_report_sequence = excluded.last_enqueued_report_sequence`,
    )
    .run(
      report.binding.bindingId,
      advance.repositoryId,
      advance.runId,
      advance.localLatestCursor,
      advance.throughCursor,
      report.reportSequence,
    );
  database
    .prepare(
      `INSERT INTO remote_report_run_event_advances(
         report_id, binding_id, repository_id, run_id,
         from_cursor, through_cursor, local_latest_cursor
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      report.reportId,
      report.binding.bindingId,
      advance.repositoryId,
      advance.runId,
      advance.fromCursor,
      advance.throughCursor,
      advance.localLatestCursor,
    );
}

function remoteEventMetadata(event: EventStreamFrame): RemoteEventMetadata {
  return Object.freeze({
    cursor: event.cursor,
    repositoryId: event.repositoryId,
    runId: event.runId,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payloadDigest: event.payloadDigest,
    ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
  });
}

function remoteRunEventAggregate(
  database: Database.Database,
  bindingId: string,
): {
  readonly localLatestCursor: number;
  readonly durablyEnqueuedCursor: number;
  readonly centrallyAcknowledgedCursor: number;
} {
  return database
    .prepare<
      [string],
      {
        localLatestCursor: number;
        durablyEnqueuedCursor: number;
        centrallyAcknowledgedCursor: number;
      }
    >(
      `SELECT
         COALESCE(SUM(local_latest_cursor), 0) AS localLatestCursor,
         COALESCE(SUM(durably_enqueued_cursor), 0) AS durablyEnqueuedCursor,
         COALESCE(SUM(centrally_acknowledged_cursor), 0) AS centrallyAcknowledgedCursor
       FROM remote_run_event_checkpoints WHERE binding_id = ?`,
    )
    .get(bindingId) as {
    readonly localLatestCursor: number;
    readonly durablyEnqueuedCursor: number;
    readonly centrallyAcknowledgedCursor: number;
  };
}

function remoteReportClaim(
  row: {
    readonly report_id: string;
    readonly report_sequence: number;
    readonly report_digest: string;
  },
  bindingId: string,
  ownerId: string,
  fence: number,
  expiresAt: string,
): RemoteReportClaim {
  return Object.freeze({
    reportId: row.report_id,
    bindingId,
    reportSequence: row.report_sequence,
    reportDigest: row.report_digest,
    ownerId,
    fence,
    expiresAt,
  });
}

function assertRemoteAcknowledgement(
  row: {
    readonly binding_id: string;
    readonly repository_id: string;
    readonly report_sequence: number;
    readonly report_digest: string;
  },
  claim: RemoteReportClaim,
  acknowledgement: RemoteReportAcknowledgement,
  controlPlaneKeyId: string,
): void {
  if (
    row.binding_id !== claim.bindingId ||
    row.report_sequence !== claim.reportSequence ||
    row.report_digest !== claim.reportDigest ||
    acknowledgement.bindingId !== row.binding_id ||
    acknowledgement.repositoryId !== row.repository_id ||
    acknowledgement.reportId !== claim.reportId ||
    acknowledgement.reportSequence !== row.report_sequence ||
    acknowledgement.reportDigest !== row.report_digest ||
    acknowledgement.signingKeyId !== controlPlaneKeyId
  ) {
    throw new RemoteDeliveryConflictError(
      `Remote report ${claim.reportId} acknowledgement does not match its durable report`,
    );
  }
}

function reconcileRemoteAcknowledgements(
  database: Database.Database,
  bindingId: string,
  currentTime: string,
): void {
  let checkpoint = requireRemoteCheckpoint(database, bindingId, "outbound-acknowledgement");
  let acknowledgedCursor = requireRemoteSynchronization(
    database,
    bindingId,
  ).centrally_acknowledged_cursor;
  let acknowledgedAt: string | null = null;
  while (true) {
    const next = database
      .prepare<
        [string, number],
        {
          report_id: string;
          report_sequence: number;
          report_digest: string;
          source_cursor: number;
          acknowledged_at: string;
        }
      >(
        `SELECT report_id, report_sequence, report_digest, source_cursor, acknowledged_at
         FROM remote_report_outbox
         WHERE binding_id = ? AND report_sequence = ? AND delivery_state = 'acknowledged'`,
      )
      .get(bindingId, checkpoint.contiguous_sequence + 1);
    if (next === undefined) break;
    acknowledgedAt = next.acknowledged_at;
    const advanced = database
      .prepare(
        `UPDATE remote_run_event_checkpoints
         SET centrally_acknowledged_cursor = (
               SELECT through_cursor FROM remote_report_run_event_advances
               WHERE report_id = ? AND run_id = remote_run_event_checkpoints.run_id
             ),
             last_acknowledged_report_sequence = ?
         WHERE binding_id = ? AND run_id IN (
           SELECT run_id FROM remote_report_run_event_advances WHERE report_id = ?
         )`,
      )
      .run(next.report_id, next.report_sequence, bindingId, next.report_id);
    acknowledgedCursor =
      advanced.changes === 0
        ? next.source_cursor
        : remoteRunEventAggregate(database, bindingId).centrallyAcknowledgedCursor;
    updateRemoteCheckpoint(
      database,
      bindingId,
      "outbound-acknowledgement",
      next.report_sequence,
      next.report_digest,
      currentTime,
    );
    checkpoint = {
      ...checkpoint,
      contiguous_sequence: next.report_sequence,
      last_digest: next.report_digest,
      updated_at: currentTime,
    };
  }
  if (acknowledgedAt !== null) {
    database
      .prepare(
        `UPDATE remote_synchronization_vectors
         SET centrally_acknowledged_cursor = ?, last_acknowledged_at = ?, local_observed_at = ?
         WHERE binding_id = ?`,
      )
      .run(
        acknowledgedCursor,
        acknowledgedCursor === 0 ? null : acknowledgedAt,
        currentTime,
        bindingId,
      );
  }
}

function applyMigrations(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > CURRENT_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
  const migrations = loadMigrations(dependencies);
  for (const migration of migrations) {
    const apply = database.transaction(() => {
      const lockedVersion = database.pragma("user_version", { simple: true }) as number;
      if (lockedVersion > CURRENT_SCHEMA_VERSION) {
        throw new UnsupportedSchemaVersionError(lockedVersion);
      }
      if (migration.version <= lockedVersion) return;
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO migration_metadata(version, name, checksum) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, migration.checksum);
      database.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
  }
  verifyMigrationMetadata(database, migrations);
}

function loadMigrations(dependencies: Pick<RuntimeDependencies, "sha256">): readonly Migration[] {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/u.test(name))
    .sort()
    .map((name) => {
      const version = Number.parseInt(name.slice(0, 3), 10);
      const sql = readFileSync(join(MIGRATIONS_DIRECTORY, name), "utf8");
      const checksum = dependencies.sha256.digest(new TextEncoder().encode(sql));
      if (!isSha256Digest(checksum)) throw new TypeError("Invalid migration SHA-256 digest");
      return { version, name, sql, checksum };
    });
}

function verifyMigrationMetadata(
  database: Database.Database,
  migrations: readonly Migration[],
): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > CURRENT_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
  const rows = database
    .prepare<[], { version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM migration_metadata ORDER BY version",
    )
    .all();
  const expected = migrations.filter((migration) => migration.version <= version);
  if (
    rows.length !== expected.length ||
    rows.some((row, index) => {
      const migration = expected[index];
      return (
        migration === undefined ||
        row.version !== migration.version ||
        row.name !== migration.name ||
        row.checksum !== migration.checksum
      );
    })
  ) {
    throw new Error("SQLite migration metadata does not match packaged migration checksums");
  }
}

/**
 * Verifies the record and returns the authority it had to build to do so.
 *
 * Checking the canonical state means constructing it, and every caller that
 * verifies before reading then constructed it again from the same bytes. That
 * second pass was thirty-five per cent of opening a record and produced a value
 * identical to the first. See `command-latency.md`.
 */
function verifyDatabase(
  database: Database.Database,
  dependencies: RuntimeDependencies,
  assetDirectory: string,
  verifyAssets: boolean,
): { readonly authority: InMemoryAuthority; readonly state: AuthorityRow } {
  const quickCheck = database.pragma("quick_check(1)") as { quick_check: string }[];
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error(`SQLite quick_check failed: ${canonicalStringify(quickCheck)}`);
  }
  const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error(`SQLite foreign_key_check failed: ${canonicalStringify(foreignKeyFailures)}`);
  }
  verifyMigrationMetadata(database, loadMigrations(dependencies));
  const state = database
    .prepare<[], AuthorityRow>(
      "SELECT revision, canonical_json FROM authority_state WHERE singleton = 1",
    )
    .get();
  if (state === undefined) throw new Error("SQLite authority singleton is missing");
  const authority = InMemoryAuthority.fromCanonicalJson(state.canonical_json, dependencies);
  // Each cross-check used to read and reparse the durable singletons for
  // itself, so opening a record parsed the authority state twice and the
  // context state twice more. They are parsed once here and passed down.
  const shared = readVerificationState(database, dependencies);
  verifyNormalizedSnapshot(database, shared.snapshot, dependencies);
  verifyContextTables(database, dependencies, shared.context);
  verifyPhaseDataflowTables(database, dependencies);
  verifyTaskFrontierTables(database, dependencies);
  verifyAmendmentTables(database, dependencies, shared.snapshot, shared.context);
  verifyParallelWorkspaceTables(database, dependencies);
  verifyHumanAuthorityTables(database, dependencies);
  verifyPortalRevisionTables(database);
  verifySupervisorTables(database);
  verifyRemoteDeliveryTables(database, dependencies);
  if (verifyAssets) {
    for (const descriptor of readAssetDescriptors(database)) {
      verifyAssetBytes(
        resolveAssetPath(assetDirectory, descriptor.relativePath),
        descriptor,
        dependencies,
      );
    }
  }
  return { authority, state };
}

function verifyPhaseDataflowTables(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  for (const row of database
    .prepare<[], { canonical_binding: string }>(
      "SELECT canonical_binding FROM workflow_input_bindings ORDER BY run_key",
    )
    .all()) {
    validateWorkflowInputBinding(
      decodeCanonicalJsonValue(row.canonical_binding),
      dependencies.sha256,
    );
  }
  const attempts = new Map<string, PhaseAttempt>();
  for (const row of database
    .prepare<[], { attempt_digest: string; canonical_attempt: string }>(
      "SELECT attempt_digest, canonical_attempt FROM phase_attempts ORDER BY attempt_digest",
    )
    .all()) {
    const attempt = validatePhaseAttempt(
      decodeCanonicalJsonValue(row.canonical_attempt),
      dependencies.sha256,
    );
    if (attempt.attemptDigest !== row.attempt_digest) {
      throw new Error("SQLite phase attempt digest diverges from canonical content");
    }
    attempts.set(row.attempt_digest, attempt);
  }
  for (const row of database
    .prepare<[], { attempt_digest: string; canonical_binding: string }>(
      `SELECT attempt_digest, canonical_binding
       FROM phase_input_bindings ORDER BY attempt_digest`,
    )
    .all()) {
    const input = validatePhaseInputBinding(
      decodeCanonicalJsonValue(row.canonical_binding),
      dependencies.sha256,
    );
    const attempt = attempts.get(row.attempt_digest);
    if (
      attempt === undefined ||
      attempt.inputBindingDigest !== input.bindingDigest ||
      attempt.sourceSetDigest !== input.sourceSetDigest
    ) {
      throw new Error("SQLite phase input binding diverges from its attempt");
    }
  }
  const publications = new Map<string, PhaseOutputPublication>();
  for (const row of database
    .prepare<[], { publication_id: string; canonical_publication: string }>(
      `SELECT publication_id, canonical_publication
       FROM phase_output_publications ORDER BY publication_id`,
    )
    .all()) {
    const publication = validatePhaseOutputPublication(
      decodeCanonicalJsonValue(row.canonical_publication),
      dependencies.sha256,
    );
    if (publication.publicationId !== row.publication_id) {
      throw new Error("SQLite phase output publication identity diverges from canonical content");
    }
    publications.set(row.publication_id, publication);
  }
  for (const row of database
    .prepare<[], { publication_id: string; canonical_acceptance: string }>(
      `SELECT publication_id, canonical_acceptance
       FROM phase_output_acceptances ORDER BY publication_id`,
    )
    .all()) {
    const publication = publications.get(row.publication_id);
    if (publication === undefined) {
      throw new Error("SQLite phase output acceptance lacks its publication");
    }
    validatePhaseOutputAcceptance(
      decodeCanonicalJsonValue(row.canonical_acceptance),
      publication,
      dependencies.sha256,
    );
  }
  for (const row of database
    .prepare<
      [],
      {
        content_digest: string;
        byte_length: number;
        canonical_bytes: Uint8Array;
        canonical_descriptor: string;
      }
    >(
      `SELECT content_digest, byte_length, canonical_bytes, canonical_descriptor
       FROM phase_output_assets ORDER BY validation_receipt_digest`,
    )
    .all()) {
    const descriptor = decodeCanonicalJsonValue(row.canonical_descriptor);
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error("SQLite canonical phase output asset descriptor is invalid");
    }
    const descriptorRecord = descriptor as Readonly<Record<string, unknown>>;
    if (
      descriptorRecord.contentDigest !== row.content_digest ||
      descriptorRecord.byteLength !== row.byte_length ||
      row.canonical_bytes.byteLength !== row.byte_length ||
      dependencies.sha256.digest(row.canonical_bytes) !== row.content_digest
    ) {
      throw new Error("SQLite canonical phase output asset diverges from its exact bytes");
    }
  }
}

function verifyTaskFrontierTables(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  for (const row of database
    .prepare<
      [],
      { transition_digest: string; attempt_digest: string; canonical_transition: string }
    >(
      `SELECT transition_digest, attempt_digest, canonical_transition
       FROM phase_attempt_transitions ORDER BY transition_digest`,
    )
    .all()) {
    const transition = validatePhaseAttemptTransition(
      decodeCanonicalJsonValue(row.canonical_transition),
      dependencies.sha256,
    );
    if (
      transition.transitionDigest !== row.transition_digest ||
      transition.attemptDigest !== row.attempt_digest
    )
      throw new Error("SQLite phase transition columns diverge from canonical authority");
  }
  for (const row of database
    .prepare<[], { binding_digest: string; canonical_binding: string }>(
      `SELECT binding_digest, canonical_binding
       FROM agent_session_resume_bindings ORDER BY binding_digest`,
    )
    .all()) {
    const binding = validateAgentSessionResumeBinding(
      decodeCanonicalJsonValue(row.canonical_binding),
      dependencies.sha256,
    );
    if (binding.bindingDigest !== row.binding_digest) {
      throw new Error("SQLite resume binding columns diverge from canonical authority");
    }
  }
  for (const row of database
    .prepare<[], { evaluation_digest: string; canonical_evaluation: string }>(
      `SELECT evaluation_digest, canonical_evaluation
       FROM fan_out_evaluations ORDER BY evaluation_digest`,
    )
    .all()) {
    const evaluation = validateFanOutEvaluation(
      decodeCanonicalJsonValue(row.canonical_evaluation),
      dependencies.sha256,
    );
    if (evaluation.evaluationDigest !== row.evaluation_digest) {
      throw new Error("SQLite fan-out evaluation columns diverge from canonical authority");
    }
    const members = database
      .prepare<[string], { stable_identity: string; canonical_member: string }>(
        `SELECT stable_identity, canonical_member FROM fan_out_members
         WHERE evaluation_digest = ? ORDER BY stable_identity`,
      )
      .all(evaluation.evaluationDigest);
    if (
      members.length !== evaluation.members.length ||
      members.some(
        (member, index) =>
          member.stable_identity !== evaluation.members[index]?.identity ||
          member.canonical_member !== canonicalStringify(evaluation.members[index]),
      )
    )
      throw new Error("SQLite fan-out members diverge from canonical evaluation authority");
  }
  for (const row of database
    .prepare<
      [],
      {
        evaluation_digest: string;
        acceptance_digest: string;
        proposal_digest: string;
        amendment_id: string;
        decision_digest: string | null;
        application_digest: string | null;
        state: string;
        canonical_import: string;
      }
    >(
      `SELECT evaluation_digest, acceptance_digest, proposal_digest, amendment_id,
              decision_digest, application_digest, state, canonical_import
       FROM plan_imports ORDER BY evaluation_digest`,
    )
    .all()) {
    const expected = {
      evaluationDigest: row.evaluation_digest,
      acceptanceDigest: row.acceptance_digest,
      proposalDigest: row.proposal_digest,
      amendmentId: row.amendment_id,
      ...(row.decision_digest === null ? {} : { decisionDigest: row.decision_digest }),
      ...(row.application_digest === null ? {} : { applicationDigest: row.application_digest }),
      state: row.state,
    };
    if (canonicalStringify(expected) !== row.canonical_import) {
      throw new Error("SQLite plan import columns diverge from canonical metadata authority");
    }
  }
}

function verifyRemoteDeliveryTables(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const peers = database
    .prepare<[], RemotePeerRow>("SELECT * FROM remote_peer_state ORDER BY binding_id")
    .all();
  const peerByBinding = new Map(peers.map((peer) => [peer.binding_id, peer]));
  const bindings = new Map<string, RemoteRepositoryBinding>();
  const commitments = database
    .prepare<[], RemoteHistoryCommitmentRow>(
      "SELECT * FROM remote_history_commitments ORDER BY binding_id",
    )
    .all();
  if (
    commitments.length !== peers.length ||
    commitments.some((commitment) => !peerByBinding.has(commitment.binding_id))
  ) {
    throw new Error("SQLite remote history commitments do not exactly cover peer state");
  }
  const commitmentByBinding = new Map(
    commitments.map((commitment) => [commitment.binding_id, commitment]),
  );
  for (const peer of peers) {
    const binding = decodeRemoteRepositoryBinding(peer.canonical_binding);
    const commitment = commitmentByBinding.get(peer.binding_id);
    if (
      commitment === undefined ||
      canonicalStringify(binding) !== peer.canonical_binding ||
      digestCanonicalText(peer.canonical_binding, dependencies) !== peer.binding_digest ||
      binding.bindingId !== peer.binding_id ||
      binding.repositoryId !== peer.repository_id ||
      commitment.repository_id !== peer.repository_id ||
      commitment.binding_digest !== peer.binding_digest ||
      commitment.canonical_binding !== peer.canonical_binding ||
      digestCanonicalText(commitment.canonical_run_event_commitments, dependencies) !==
        commitment.run_event_commitments_digest ||
      peer.current_revocation_epoch < binding.revocationEpoch
    ) {
      throw new Error("SQLite remote peer state and history commitment are not semantically bound");
    }
    if (peer.session_id !== null) validateStorageIdentifier(peer.session_id, "session_id");
    const negotiated = [
      peer.session_id,
      peer.selected_protocol_version,
      peer.canonical_capabilities,
    ];
    if (
      negotiated.some((value) => value === null) !== negotiated.every((value) => value === null)
    ) {
      throw new Error("SQLite remote negotiated session is incomplete");
    }
    if (
      peer.session_id !== null &&
      (peer.selected_protocol_version !== REMOTE_PROTOCOL_VERSION ||
        peer.canonical_capabilities !== canonicalStringify(REMOTE_CAPABILITIES))
    ) {
      throw new Error("SQLite remote negotiated session is invalid");
    }
    validateTimestamp(peer.last_observed_at, "last_observed_at");
    bindings.set(peer.binding_id, binding);
  }

  const checkpoints = database
    .prepare<[], RemoteCheckpointRow>(
      `SELECT * FROM remote_stream_checkpoints ORDER BY binding_id, stream_kind`,
    )
    .all();
  if (checkpoints.length !== peers.length * 3) {
    throw new Error("SQLite remote stream checkpoints do not exactly cover peer state");
  }
  const checkpointByKey = new Map(
    checkpoints.map((row) => [`${row.binding_id}:${row.stream_kind}`, row]),
  );
  for (const peer of peers) {
    for (const streamKind of [
      "inbound-command",
      "outbound-report",
      "outbound-acknowledgement",
    ] as const) {
      const checkpoint = checkpointByKey.get(`${peer.binding_id}:${streamKind}`);
      if (
        checkpoint === undefined ||
        !Number.isSafeInteger(checkpoint.contiguous_sequence) ||
        checkpoint.contiguous_sequence < 0 ||
        (checkpoint.contiguous_sequence === 0) !== (checkpoint.last_digest === null) ||
        (checkpoint.last_digest !== null && !isSha256Digest(checkpoint.last_digest))
      ) {
        throw new Error("SQLite remote stream checkpoint state is invalid");
      }
      validateTimestamp(checkpoint.updated_at, "updated_at");
    }
  }

  const inboxRows = database
    .prepare<[], RemoteInboxRow>(`SELECT * FROM remote_command_inbox ORDER BY binding_id, sequence`)
    .all();
  const inboxByBinding = groupRowsBy(inboxRows, (row) => row.binding_id);
  for (const [bindingId, rows] of inboxByBinding) {
    const peer = peerByBinding.get(bindingId);
    const binding = bindings.get(bindingId);
    if (peer === undefined || binding === undefined) {
      throw new Error("SQLite remote inbox references missing peer state");
    }
    let contiguousSequence = 0;
    let contiguousDigest: string | null = null;
    for (const row of rows) {
      const envelope = decodeRemoteCommandEnvelope(row.canonical_envelope);
      const deliveryEntry = decodeRemoteReceiptChainEntry(row.canonical_delivery_entry);
      assertRemoteCommandDigestBindings(envelope, dependencies);
      assertRemoteBindingRow(peer, envelope.acceptedCommand.binding, dependencies);
      const expectedConflict =
        row.sequence === contiguousSequence + 1 &&
        row.previous_envelope_digest !== contiguousDigest;
      if (
        canonicalStringify(envelope) !== row.canonical_envelope ||
        digestCanonicalText(row.canonical_envelope, dependencies) !== row.envelope_digest ||
        envelope.sequence !== row.sequence ||
        envelope.previousEnvelopeDigest !== row.previous_envelope_digest ||
        envelope.acceptedCommand.binding.repositoryId !== row.repository_id ||
        envelope.acceptedCommand.acceptanceId !== row.acceptance_id ||
        envelope.acceptedCommand.command.commandId !== row.command_id ||
        envelope.acceptedCommand.binding.revocationEpoch !== row.revocation_epoch ||
        envelope.acceptedCommand.expiresAt !== row.expires_at ||
        deliveryEntry.entryDigest !== row.delivery_entry_digest ||
        deliveryEntry.bindingId !== bindingId ||
        deliveryEntry.commandId !== row.command_id ||
        deliveryEntry.stage !== "connector-delivered" ||
        deliveryEntry.evidence.type !== "connector-delivery" ||
        deliveryEntry.evidence.envelopeSequence !== row.sequence ||
        deliveryEntry.evidence.envelopeDigest !== row.envelope_digest ||
        (row.processing_state === "conflict") !== expectedConflict
      ) {
        throw new Error("SQLite remote inbox row is not semantically bound");
      }
      validateTimestamp(row.received_at, "received_at");
      if (!expectedConflict && row.sequence === contiguousSequence + 1) {
        contiguousSequence = row.sequence;
        contiguousDigest = row.envelope_digest;
      }
      verifyRemoteLocalEntry(row, binding, dependencies, "acceptance");
      verifyRemoteLocalEntry(row, binding, dependencies, "result");
      verifyRemoteInboxResultReport(database, row);
    }
    const checkpoint = requireRemoteCheckpoint(database, bindingId, "inbound-command");
    const commitment = requireRemoteHistoryCommitment(database, bindingId);
    if (
      checkpoint.contiguous_sequence !== contiguousSequence ||
      checkpoint.last_digest !== contiguousDigest ||
      commitment.inbound_sequence !== contiguousSequence ||
      commitment.inbound_digest !== contiguousDigest ||
      rows.some(
        (row) =>
          ((row.processing_state === "ready" ||
            row.processing_state === "local-accepted" ||
            row.processing_state === "local-result") &&
            row.sequence > contiguousSequence) ||
          (row.processing_state === "waiting" && row.sequence <= contiguousSequence) ||
          (row.processing_state === "revoked" &&
            row.revocation_epoch >= peer.current_revocation_epoch),
      )
    ) {
      throw new Error("SQLite remote inbox checkpoint diverges from its envelope chain");
    }
  }
  for (const peer of peers) {
    if (inboxByBinding.has(peer.binding_id)) continue;
    const checkpoint = requireRemoteCheckpoint(database, peer.binding_id, "inbound-command");
    const commitment = requireRemoteHistoryCommitment(database, peer.binding_id);
    if (
      checkpoint.contiguous_sequence !== 0 ||
      checkpoint.last_digest !== null ||
      commitment.inbound_sequence !== 0 ||
      commitment.inbound_digest !== null
    ) {
      throw new Error("SQLite empty remote inbox has a non-empty checkpoint");
    }
  }

  const reports = database
    .prepare<
      [],
      {
        report_id: string;
        binding_id: string;
        repository_id: string;
        report_sequence: number;
        previous_report_digest: string | null;
        report_digest: string;
        data_policy_digest: string;
        source_cursor: number;
        event_advance_count: number;
        canonical_report: string;
        enqueued_at: string;
        delivery_state: string;
        claim_owner_id: string | null;
        claim_fence: number | null;
        claim_expires_at: string | null;
        acknowledgement_digest: string | null;
        canonical_acknowledgement: string | null;
        central_receipt_id: string | null;
        acknowledged_at: string | null;
      }
    >(`SELECT * FROM remote_report_outbox ORDER BY binding_id, report_sequence`)
    .all();
  const reportsByBinding = groupRowsBy(reports, (row) => row.binding_id);
  for (const peer of peers) {
    const binding = bindings.get(peer.binding_id);
    if (binding === undefined) throw new Error("SQLite remote binding decode was lost");
    const bindingReports = reportsByBinding.get(peer.binding_id) ?? [];
    let previousDigest: string | null = null;
    let acknowledgedSequence = 0;
    let acknowledgedDigest: string | null = null;
    let acknowledgedCursor = 0;
    let lastAcknowledgedAt: string | null = null;
    for (const [index, row] of bindingReports.entries()) {
      const report = decodeRemoteClassifiedReport(row.canonical_report);
      const reportDigest = digestCanonicalText(row.canonical_report, dependencies);
      const representedRunCount = new Set(report.events.map((event) => event.runId)).size;
      if (
        canonicalStringify(report) !== row.canonical_report ||
        reportDigest !== row.report_digest ||
        report.reportId !== row.report_id ||
        report.binding.bindingId !== row.binding_id ||
        report.binding.repositoryId !== row.repository_id ||
        report.reportSequence !== row.report_sequence ||
        report.previousReportDigest !== row.previous_report_digest ||
        report.dataPolicyDigest !== row.data_policy_digest ||
        report.synchronization.durablyEnqueuedCursor !== row.source_cursor ||
        (report.events.length > 0 && row.event_advance_count !== representedRunCount) ||
        (report.events.length === 0 && row.event_advance_count > 1) ||
        report.createdAt !== row.enqueued_at ||
        row.report_sequence !== index + 1 ||
        row.previous_report_digest !== previousDigest
      ) {
        throw new Error("SQLite remote report row is not semantically bound");
      }
      assertRemoteBindingRow(peer, report.binding, dependencies);
      previousDigest = reportDigest;
      if (row.claim_owner_id !== null)
        validateStorageIdentifier(row.claim_owner_id, "claim_owner_id");
      if (row.claim_expires_at !== null)
        validateTimestamp(row.claim_expires_at, "claim_expires_at");
      if (row.delivery_state === "acknowledged") {
        if (row.canonical_acknowledgement === null || row.acknowledgement_digest === null) {
          throw new Error("SQLite remote report acknowledgement is incomplete");
        }
        const acknowledgement = decodeRemoteReportAcknowledgement(row.canonical_acknowledgement);
        if (
          canonicalStringify(acknowledgement) !== row.canonical_acknowledgement ||
          digestCanonicalText(row.canonical_acknowledgement, dependencies) !==
            row.acknowledgement_digest ||
          acknowledgement.centralReceiptId !== row.central_receipt_id ||
          acknowledgement.acknowledgedAt !== row.acknowledged_at
        ) {
          throw new Error("SQLite remote report acknowledgement is not exact");
        }
        assertRemoteAcknowledgement(
          row,
          {
            reportId: row.report_id,
            bindingId: row.binding_id,
            reportSequence: row.report_sequence,
            reportDigest: row.report_digest,
            ownerId: "integrity-verifier",
            fence: row.claim_fence ?? 0,
            expiresAt: row.acknowledged_at ?? binding.issuedAt,
          },
          acknowledgement,
          binding.controlPlaneKeyId,
        );
        if (row.report_sequence === acknowledgedSequence + 1) {
          acknowledgedSequence = row.report_sequence;
          acknowledgedDigest = row.report_digest;
          acknowledgedCursor = row.source_cursor;
          lastAcknowledgedAt = acknowledgement.acknowledgedAt;
        }
      }
    }
    const reportCheckpoint = requireRemoteCheckpoint(database, peer.binding_id, "outbound-report");
    const acknowledgementCheckpoint = requireRemoteCheckpoint(
      database,
      peer.binding_id,
      "outbound-acknowledgement",
    );
    if (
      reportCheckpoint.contiguous_sequence !== bindingReports.length ||
      reportCheckpoint.last_digest !== previousDigest ||
      acknowledgementCheckpoint.contiguous_sequence !== acknowledgedSequence ||
      acknowledgementCheckpoint.last_digest !== acknowledgedDigest
    ) {
      throw new Error("SQLite remote report checkpoint diverges from its durable chain");
    }
    const synchronization = requireRemoteSynchronization(database, peer.binding_id);
    const decodedSynchronization = decodeRemoteSynchronizationVector({
      repositoryId: synchronization.repository_id,
      localLatestCursor: synchronization.local_latest_cursor,
      durablyEnqueuedCursor: synchronization.durably_enqueued_cursor,
      centrallyAcknowledgedCursor: synchronization.centrally_acknowledged_cursor,
      localObservedAt: synchronization.local_observed_at,
      lastEnqueuedAt: synchronization.last_enqueued_at,
      lastAcknowledgedAt: synchronization.last_acknowledged_at,
    });
    const latestReport = bindingReports.at(-1);
    const latestReportValue =
      latestReport === undefined
        ? undefined
        : decodeRemoteClassifiedReport(latestReport.canonical_report);
    const runEventAggregate = verifyRemoteRunEventCheckpoints(
      database,
      peer,
      acknowledgementCheckpoint.contiguous_sequence,
    );
    const commitment = requireRemoteHistoryCommitment(database, peer.binding_id);
    const canonicalRunEventCommitments = canonicalRemoteRunEventCommitments(
      database,
      peer.binding_id,
    );
    if (
      commitment.outbound_report_sequence !== bindingReports.length ||
      commitment.outbound_report_digest !== previousDigest ||
      commitment.acknowledged_report_sequence !== acknowledgedSequence ||
      commitment.acknowledged_report_digest !== acknowledgedDigest ||
      commitment.acknowledged_cursor !== acknowledgedCursor ||
      commitment.canonical_run_event_commitments !== canonicalRunEventCommitments ||
      commitment.run_event_commitments_digest !==
        digestCanonicalText(canonicalRunEventCommitments, dependencies) ||
      decodedSynchronization.repositoryId !== peer.repository_id ||
      decodedSynchronization.durablyEnqueuedCursor !== (latestReport?.source_cursor ?? 0) ||
      decodedSynchronization.centrallyAcknowledgedCursor !== acknowledgedCursor ||
      decodedSynchronization.lastAcknowledgedAt !== lastAcknowledgedAt ||
      decodedSynchronization.lastEnqueuedAt !==
        (latestReportValue?.synchronization.lastEnqueuedAt ?? null) ||
      (runEventAggregate !== undefined &&
        (decodedSynchronization.localLatestCursor !== runEventAggregate.localLatestCursor ||
          decodedSynchronization.durablyEnqueuedCursor !==
            runEventAggregate.durablyEnqueuedCursor ||
          decodedSynchronization.centrallyAcknowledgedCursor !==
            runEventAggregate.centrallyAcknowledgedCursor))
    ) {
      throw new Error("SQLite remote synchronization diverges from durable reports");
    }
  }
}

function verifyRemoteRunEventCheckpoints(
  database: Database.Database,
  peer: RemotePeerRow,
  acknowledgedReportSequence: number,
):
  | {
      readonly localLatestCursor: number;
      readonly durablyEnqueuedCursor: number;
      readonly centrallyAcknowledgedCursor: number;
    }
  | undefined {
  const rows = database
    .prepare<[string], RemoteRunEventCheckpointRow>(
      `SELECT * FROM remote_run_event_checkpoints
       WHERE binding_id = ? ORDER BY run_id`,
    )
    .all(peer.binding_id);
  const reports = database
    .prepare<
      [string],
      {
        readonly report_id: string;
        readonly canonical_report: string;
        readonly event_advance_count: number;
      }
    >(
      `SELECT report_id, canonical_report, event_advance_count FROM remote_report_outbox
       WHERE binding_id = ? ORDER BY report_sequence`,
    )
    .all(peer.binding_id);
  const advances = database
    .prepare<[string, string], RemoteReportRunEventAdvanceRow>(
      `SELECT a.*, r.report_sequence, r.canonical_report,
              r.binding_id AS report_binding_id,
              r.repository_id AS report_repository_id
       FROM remote_report_run_event_advances a
       JOIN remote_report_outbox r ON r.report_id = a.report_id
       WHERE a.binding_id = ? OR r.binding_id = ?
       ORDER BY r.report_sequence, a.run_id`,
    )
    .all(peer.binding_id, peer.binding_id);
  const expectedAdvanceKeys = new Set<string>();
  const actualAdvanceCounts = new Map<string, number>();
  for (const row of reports) {
    const report = decodeRemoteClassifiedReport(row.canonical_report);
    const representedRunIds = new Set<string>();
    for (const event of report.events) {
      if (event.repositoryId !== peer.repository_id) {
        throw new Error("SQLite remote report event metadata is not binding-owned");
      }
      representedRunIds.add(event.runId);
    }
    for (const runId of representedRunIds) {
      expectedAdvanceKeys.add(canonicalStringify([row.report_id, runId]));
    }
  }
  if (reports.some((report) => report.event_advance_count > 0) && advances.length === 0) {
    throw new Error("SQLite remote report run event advance evidence is incomplete");
  }
  if (rows.length === 0 && advances.length === 0) return undefined;
  if (
    advances.length === 0 &&
    rows.every(
      (row) =>
        row.repository_id === peer.repository_id &&
        row.local_latest_cursor === 0 &&
        row.durably_enqueued_cursor === 0 &&
        row.centrally_acknowledged_cursor === 0 &&
        row.last_enqueued_report_sequence === 0 &&
        row.last_acknowledged_report_sequence === 0,
    )
  )
    return undefined;
  const reconstructed = new Map<string, RemoteRunEventCheckpoint>();
  for (const advance of advances) {
    const report = decodeRemoteClassifiedReport(advance.canonical_report);
    const reportEvents = report.events.filter((event) => event.runId === advance.run_id);
    if (
      advance.report_id !== report.reportId ||
      advance.binding_id !== peer.binding_id ||
      advance.binding_id !== advance.report_binding_id ||
      advance.repository_id !== advance.report_repository_id ||
      report.binding.bindingId !== advance.binding_id ||
      report.binding.repositoryId !== advance.repository_id ||
      advance.repository_id !== peer.repository_id ||
      (report.events.length > 0 && reportEvents.length === 0) ||
      advance.from_cursor > advance.through_cursor ||
      advance.through_cursor > advance.local_latest_cursor
    ) {
      throw new Error("SQLite remote report run event advance is not binding-owned");
    }
    expectedAdvanceKeys.delete(canonicalStringify([advance.report_id, advance.run_id]));
    actualAdvanceCounts.set(
      advance.report_id,
      (actualAdvanceCounts.get(advance.report_id) ?? 0) + 1,
    );
    const prior = reconstructed.get(advance.run_id);
    if (
      advance.from_cursor !== (prior?.durablyEnqueuedCursor ?? 0) ||
      advance.local_latest_cursor < (prior?.localLatestCursor ?? 0)
    ) {
      throw new Error("SQLite remote report run event advance is not contiguous");
    }
    const runKey = canonicalStringify([advance.repository_id, advance.run_id]);
    const exactEvents = database
      .prepare<[string, number, number], { canonical_frame: string }>(
        `SELECT canonical_frame FROM event_frames
         WHERE run_key = ? AND cursor > ? AND cursor <= ? ORDER BY cursor`,
      )
      .all(runKey, advance.from_cursor, advance.through_cursor)
      .map((row) => remoteEventMetadata(decodeEventStreamFrame(row.canonical_frame)));
    if (canonicalStringify(reportEvents) !== canonicalStringify(exactEvents)) {
      throw new Error("SQLite remote report run event advance is not exact");
    }
    const acknowledged = advance.report_sequence <= acknowledgedReportSequence;
    reconstructed.set(
      advance.run_id,
      Object.freeze({
        bindingId: peer.binding_id,
        repositoryId: advance.repository_id,
        runId: advance.run_id,
        localLatestCursor: advance.local_latest_cursor,
        durablyEnqueuedCursor: advance.through_cursor,
        centrallyAcknowledgedCursor: acknowledged
          ? advance.through_cursor
          : (prior?.centrallyAcknowledgedCursor ?? 0),
        lastEnqueuedReportSequence: advance.report_sequence,
        lastAcknowledgedReportSequence: acknowledged
          ? advance.report_sequence
          : (prior?.lastAcknowledgedReportSequence ?? 0),
      }),
    );
  }
  if (expectedAdvanceKeys.size > 0) {
    throw new Error("SQLite remote report run event advance evidence is incomplete");
  }
  if (
    reports.some(
      (report) => (actualAdvanceCounts.get(report.report_id) ?? 0) !== report.event_advance_count,
    )
  ) {
    throw new Error("SQLite remote report run event advance evidence is incomplete");
  }
  for (const row of rows) {
    const authoritativeRun = database
      .prepare<[string, string], { repository_id: string; run_id: string }>(
        `SELECT repository_id, run_id FROM runs
         WHERE repository_id = ? AND run_id = ?`,
      )
      .get(row.repository_id, row.run_id);
    if (
      authoritativeRun === undefined ||
      authoritativeRun.repository_id !== peer.repository_id ||
      authoritativeRun.run_id !== row.run_id
    ) {
      throw new Error("SQLite remote run event checkpoint is not bound to an authoritative run");
    }
    const expected = reconstructed.get(row.run_id);
    const zeroCheckpoint =
      expected === undefined &&
      row.repository_id === peer.repository_id &&
      row.local_latest_cursor === 0 &&
      row.durably_enqueued_cursor === 0 &&
      row.centrally_acknowledged_cursor === 0 &&
      row.last_enqueued_report_sequence === 0 &&
      row.last_acknowledged_report_sequence === 0;
    if (
      !zeroCheckpoint &&
      (expected === undefined ||
        canonicalStringify(remoteRunEventCheckpoint(row)) !== canonicalStringify(expected))
    ) {
      throw new Error("SQLite remote run event checkpoint diverges from durable reports");
    }
    reconstructed.delete(row.run_id);
  }
  if (reconstructed.size > 0) {
    throw new Error("SQLite remote report run event advance is missing its checkpoint");
  }
  return remoteRunEventAggregate(database, peer.binding_id);
}

function verifyRemoteLocalEntry(
  row: RemoteInboxRow,
  binding: RemoteRepositoryBinding,
  dependencies: Pick<RuntimeDependencies, "sha256">,
  kind: "acceptance" | "result",
): void {
  const canonical =
    kind === "acceptance" ? row.canonical_local_acceptance : row.canonical_local_result;
  const digest = kind === "acceptance" ? row.local_acceptance_digest : row.local_result_digest;
  const recordedAt = kind === "acceptance" ? row.local_accepted_at : row.local_result_at;
  if (canonical === null && digest === null && recordedAt === null) return;
  if (canonical === null || digest === null || recordedAt === null) {
    throw new Error(`SQLite remote local ${kind} is incomplete`);
  }
  const entry = decodeRemoteReceiptChainEntry(canonical);
  if (
    canonicalStringify(entry) !== canonical ||
    digestCanonicalText(canonical, dependencies) !== digest ||
    entry.bindingId !== binding.bindingId ||
    entry.commandId !== row.command_id ||
    remoteLocalCommandId(entry) !== row.command_id ||
    entry.recordedAt !== recordedAt ||
    (kind === "acceptance" && entry.stage !== "local-accepted") ||
    (kind === "result" && entry.stage !== "local-outcome")
  ) {
    throw new Error(`SQLite remote local ${kind} is not semantically bound`);
  }
}

function verifyRemoteInboxResultReport(database: Database.Database, row: RemoteInboxRow): void {
  if (row.local_result_report_id === null) return;
  if (row.canonical_local_result === null) {
    throw new Error("SQLite remote inbox result report has no terminal entry");
  }
  const reportRow = database
    .prepare<[string, string], { canonical_report: string }>(
      `SELECT canonical_report FROM remote_report_outbox
       WHERE report_id = ? AND binding_id = ?`,
    )
    .get(row.local_result_report_id, row.binding_id);
  if (reportRow === undefined) {
    throw new Error("SQLite remote inbox result references a missing or cross-binding report");
  }
  const report = decodeRemoteClassifiedReport(reportRow.canonical_report);
  if (!remoteReportContainsInboxResult(report, row, row.canonical_local_result)) {
    throw new Error(
      "SQLite remote inbox result report does not contain its terminal command chain",
    );
  }
}

function remoteReportContainsInboxResult(
  report: RemoteClassifiedReport,
  row: RemoteInboxRow,
  canonicalResult: string,
): boolean {
  const chain = report.receiptChains.find(
    (candidate) =>
      candidate.bindingId === report.binding.bindingId && candidate.commandId === row.command_id,
  );
  if (chain === undefined) return false;
  return chain.entries.some((entry) => canonicalStringify(entry) === canonicalResult);
}

function groupRowsBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

function verifyHumanAuthorityTables(
  database: Database.Database,
  dependencies: RuntimeDependencies,
): void {
  const answers = database
    .prepare<
      [],
      {
        submission_id: string;
        run_key: string;
        question_digest: string;
        context_digest: string;
        task_id: string;
        definition_generation: number;
        answer_digest: string;
        canonical_answer: string;
        principal_digest: string;
        canonical_principal: string;
        canonical_question: string | null;
      }
    >(
      `SELECT a.submission_id, a.run_key, a.question_digest, a.context_digest,
              a.task_id, a.definition_generation, a.answer_digest, a.canonical_answer,
              a.principal_digest, a.canonical_principal, q.canonical_question
       FROM context_question_answers a
       LEFT JOIN context_questions q ON q.submission_id = a.submission_id
       ORDER BY a.submission_id`,
    )
    .all();
  for (const answer of answers) {
    const question =
      answer.canonical_question === null
        ? undefined
        : decodeCanonicalJsonValue(answer.canonical_question);
    if (
      !isPlainRecord(question) ||
      !isPlainRecord(question.question) ||
      !isPlainRecord(question.task) ||
      question.contextDigest !== answer.context_digest ||
      question.task.taskId !== answer.task_id ||
      question.task.definitionGeneration !== answer.definition_generation ||
      answer.run_key !== canonicalStringify([question.repositoryId, question.runId]) ||
      dependencies.sha256.digest(canonicalBytes(question.question)) !== answer.question_digest ||
      dependencies.sha256.digest(
        canonicalBytes(decodeCanonicalJsonValue(answer.canonical_answer)),
      ) !== answer.answer_digest ||
      dependencies.sha256.digest(
        canonicalBytes(decodeCanonicalJsonValue(answer.canonical_principal)),
      ) !== answer.principal_digest
    ) {
      throw new Error("SQLite question answer authority is not semantically bound");
    }
    const requirement = database
      .prepare<
        [string],
        {
          historical_dispatch_id: string;
          context_digest: string;
          task_id: string;
          definition_generation: number;
          requirement_digest: string;
        }
      >(
        `SELECT historical_dispatch_id, context_digest, task_id, definition_generation,
                requirement_digest
         FROM context_fresh_dispatch_requirements WHERE submission_id = ?`,
      )
      .get(answer.submission_id);
    if (
      requirement === undefined ||
      requirement.context_digest !== answer.context_digest ||
      requirement.task_id !== answer.task_id ||
      requirement.definition_generation !== answer.definition_generation ||
      dependencies.sha256.digest(
        canonicalBytes({
          submissionId: answer.submission_id,
          historicalDispatchId: requirement.historical_dispatch_id,
          questionDigest: answer.question_digest,
          contextDigest: answer.context_digest,
          answerDigest: answer.answer_digest,
          taskId: answer.task_id,
          definitionGeneration: answer.definition_generation,
        }),
      ) !== requirement.requirement_digest
    ) {
      throw new Error("SQLite fresh dispatch requirement is not bound to its answer");
    }
  }

  const policies = new Map(
    database
      .prepare<[], { run_key: string; policy_digest: string; canonical_policy: string }>(
        `SELECT run_key, policy_digest, canonical_policy
         FROM runner_allowance_policies ORDER BY run_key`,
      )
      .all()
      .map((row) => {
        const policy = validateStorageAllowancePolicy(
          decodeCanonicalJsonValue(row.canonical_policy) as unknown as RunnerAllowancePolicy,
        );
        if (
          policy.policyDigest !== row.policy_digest ||
          canonicalStringify(policy) !== row.canonical_policy
        ) {
          throw new Error("SQLite runner allowance policy columns diverge from canonical policy");
        }
        return [row.run_key, policy] as const;
      }),
  );
  for (const resolution of database
    .prepare<
      [],
      {
        escalation_command_id: string;
        run_key: string;
        escalation_digest: string;
        policy_digest: string;
        unit: string;
        prior_limit: number;
        increase_by: number;
        resulting_limit: number;
        canonical_principal: string;
        principal_digest: string;
        canonical_escalation: string | null;
      }
    >(
      `SELECT r.escalation_command_id, r.run_key, r.escalation_digest,
              r.policy_digest, r.unit, r.prior_limit, r.increase_by,
              r.resulting_limit, r.canonical_principal, r.principal_digest,
              e.canonical_escalation
       FROM runner_allowance_resolutions r
       LEFT JOIN runner_escalations e ON e.command_id = r.escalation_command_id
       ORDER BY r.escalation_command_id`,
    )
    .all()) {
    const policy = policies.get(resolution.run_key);
    if (
      resolution.canonical_escalation === null ||
      policy === undefined ||
      policy.policyDigest !== resolution.policy_digest ||
      dependencies.sha256.digest(
        canonicalBytes(decodeCanonicalJsonValue(resolution.canonical_escalation)),
      ) !== resolution.escalation_digest ||
      dependencies.sha256.digest(
        canonicalBytes(decodeCanonicalJsonValue(resolution.canonical_principal)),
      ) !== resolution.principal_digest ||
      resolution.resulting_limit !== resolution.prior_limit + resolution.increase_by ||
      !policy.ceilings.some(
        ({ unit, maximum }) => unit === resolution.unit && resolution.resulting_limit <= maximum,
      )
    ) {
      throw new Error("SQLite allowance resolution is not semantically bound");
    }
  }

  for (const state of database
    .prepare<[], { run_key: string; mode: RunControlMode; revision: number }>(
      "SELECT run_key, mode, revision FROM run_control_state ORDER BY run_key",
    )
    .all()) {
    const events = database
      .prepare<
        [string],
        {
          revision: number;
          prior_mode: RunControlMode;
          result_mode: RunControlMode;
          canonical_event: string;
        }
      >(
        `SELECT revision, prior_mode, result_mode, canonical_event
         FROM run_control_events WHERE run_key = ? ORDER BY revision`,
      )
      .all(state.run_key);
    let mode: RunControlMode = "running";
    let revision = 0;
    for (const event of events) {
      if (
        event.revision !== revision + 1 ||
        event.prior_mode !== mode ||
        canonicalStringify(decodeCanonicalJsonValue(event.canonical_event)) !==
          event.canonical_event
      ) {
        throw new Error("SQLite run-control event history is not contiguous");
      }
      mode = event.result_mode;
      revision = event.revision;
    }
    if (state.mode !== mode || state.revision !== revision) {
      throw new Error("SQLite run-control state diverges from immutable events");
    }
  }
}

/** The durable singletons a verification pass reads, parsed once and shared. */
function readVerificationState(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): { readonly snapshot: AuthoritySnapshot; readonly context: InMemoryContextAuthority } {
  const authorityRow = database
    .prepare<[], AuthorityRow>(
      "SELECT revision, canonical_json FROM authority_state WHERE singleton = 1",
    )
    .get();
  if (authorityRow === undefined) throw new Error("SQLite authority singleton is missing");
  const contextRow = database
    .prepare<[], ContextAuthorityStateRow>(
      "SELECT canonical_json FROM context_authority_state WHERE singleton = 1",
    )
    .get();
  if (contextRow === undefined) throw new Error("SQLite context authority singleton is missing");
  const context = InMemoryContextAuthority.fromDurableCanonicalJson(
    contextRow.canonical_json,
    dependencies.sha256,
    storedContextDispatches(database),
  );
  return { snapshot: parseSnapshot(authorityRow.canonical_json), context };
}

function verifyContextTables(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
  authority: InMemoryContextAuthority,
): void {
  verifyNormalizedContextAuthority(database, authority, dependencies.sha256);
  verifyAllContextAssetManifests(database, dependencies.sha256);
  verifyDurableContextReads(database, authority);
}

function verifyParallelWorkspaceTables(
  database: Database.Database,
  dependencies: RuntimeDependencies,
): void {
  const capacityRows = database
    .prepare<
      [],
      {
        run_key: string;
        capacity_limit: number;
        occupied: number;
        expected_occupied: number;
      }
    >(
      `SELECT c.run_key, c.capacity_limit, c.occupied,
              COALESCE(SUM(CASE WHEN r.released = 0 THEN r.amount ELSE 0 END), 0)
                AS expected_occupied
       FROM runner_capacities c
       LEFT JOIN runner_capacity_reservations r
         ON r.run_key = c.run_key AND r.resource_key = c.resource_key
       GROUP BY c.run_key, c.resource_key, c.capacity_limit, c.occupied
       ORDER BY c.run_key`,
    )
    .all();
  const runnerRunCount = database
    .prepare<[], { count: number }>("SELECT count(*) AS count FROM runner_runs")
    .get()?.count;
  if (
    runnerRunCount === undefined ||
    capacityRows.length !== runnerRunCount ||
    capacityRows.some(
      (row) =>
        row.capacity_limit < 1 ||
        row.occupied !== row.expected_occupied ||
        row.occupied > row.capacity_limit,
    )
  ) {
    throw new Error("SQLite runner capacity authority does not match its reservations");
  }

  const reservationRows = database
    .prepare<
      [],
      {
        intent_id: string;
        resource_key: string;
        amount: number;
        released: number;
        released_at: string | null;
        canonical_intent: string;
        canonical_outcome: string | null;
      }
    >(
      `SELECT r.intent_id, r.resource_key, r.amount, r.released, r.released_at,
              i.canonical_intent,
              (SELECT o.canonical_outcome FROM runner_effect_outcomes o
               WHERE o.intent_id = r.intent_id ORDER BY o.commit_cursor DESC LIMIT 1)
                AS canonical_outcome
       FROM runner_capacity_reservations r
       JOIN runner_effect_intents i ON i.intent_id = r.intent_id
       ORDER BY r.intent_id`,
    )
    .all();
  for (const row of reservationRows) {
    const intent = parseRunnerValue<EffectIntent>(row.canonical_intent);
    const reservation = intent.command.capacityReservation;
    const terminal =
      row.canonical_outcome === null
        ? false
        : isRunnerTerminal(parseRunnerValue<EffectOutcome>(row.canonical_outcome).status);
    if (
      reservation?.resource !== row.resource_key ||
      reservation.amount !== row.amount ||
      (row.released === 1) !== terminal ||
      (row.released_at !== null) !== terminal
    ) {
      throw new Error("SQLite runner capacity reservation does not match its effect lifecycle");
    }
  }

  const bindingRows = database
    .prepare<
      [],
      {
        run_key: string;
        repository_id: string;
        run_id: string;
        configuration_snapshot_digest: string;
        workspace_mode: string;
        max_writer_concurrency: number;
        failure_policy: string;
        integration_ref: string | null;
        canonical_binding: string;
      }
    >("SELECT * FROM runner_execution_bindings ORDER BY run_key")
    .all();
  const bindings = new Map<string, RunExecutionBinding>();
  for (const row of bindingRows) {
    const binding = validateRunExecutionBinding(parseRunnerValue(row.canonical_binding));
    assertCanonicalStorageRecord(row.canonical_binding, binding, "run execution binding");
    if (
      binding.repositoryId !== row.repository_id ||
      binding.runId !== row.run_id ||
      binding.configurationSnapshotDigest !== row.configuration_snapshot_digest ||
      binding.execution.workspaceMode !== row.workspace_mode ||
      binding.execution.maxWriterConcurrency !== row.max_writer_concurrency ||
      binding.execution.failurePolicy !== row.failure_policy ||
      (binding.execution.integrationRef ?? null) !== row.integration_ref
    ) {
      throw new Error("SQLite run execution binding columns diverge from canonical authority");
    }
    bindings.set(row.run_key, binding);
  }

  const workspaceRows = database
    .prepare<
      [],
      {
        workspace_id: string;
        run_key: string;
        repository_id: string;
        dispatch_id: string;
        task_id: string;
        definition_generation: number;
        mode: string;
        state: WorkspaceLifecycleState;
        base_revision_digest: string;
        prepare_effect_id: string;
        inspect_effect_id: string;
        canonical_workspace: string;
      }
    >("SELECT * FROM runner_workspaces ORDER BY workspace_id")
    .all();
  const workspaces = new Map<string, WorkspaceRecord>();
  for (const row of workspaceRows) {
    const workspace = parseRunnerValue<WorkspaceRecord>(row.canonical_workspace);
    assertCanonicalStorageRecord(row.canonical_workspace, workspace, "workspace");
    const baseRevision = bindGitRevision(workspace.baseRevision.revision, dependencies.sha256);
    const binding = bindings.get(row.run_key);
    if (
      canonicalStringify(baseRevision) !== canonicalStringify(workspace.baseRevision) ||
      workspace.workspaceId !== row.workspace_id ||
      workspace.repositoryId !== row.repository_id ||
      workspace.dispatchId !== row.dispatch_id ||
      workspace.taskId !== row.task_id ||
      workspace.definitionGeneration !== row.definition_generation ||
      workspace.mode !== row.mode ||
      workspace.state !== row.state ||
      workspace.baseRevision.descriptorDigest !== row.base_revision_digest ||
      workspace.prepareEffectId !== row.prepare_effect_id ||
      workspace.inspectEffectId !== row.inspect_effect_id ||
      binding?.execution.workspaceMode !== workspace.mode
    ) {
      throw new Error("SQLite workspace columns diverge from canonical authority");
    }
    workspaces.set(workspace.workspaceId, workspace);
  }

  const resultRows = database
    .prepare<
      [],
      {
        result_id: string;
        workspace_id: string;
        result_tree_digest: string;
        result_revision_digest: string;
        completion_fact_digest: string;
        capture_effect_id: string;
        inspect_effect_id: string;
        recorded_at: string;
        canonical_result: string;
      }
    >("SELECT * FROM runner_workspace_results ORDER BY result_id")
    .all();
  const results = new Map<string, WorkspaceResultRecord>();
  for (const row of resultRows) {
    const result = parseRunnerValue<WorkspaceResultRecord>(row.canonical_result);
    assertCanonicalStorageRecord(row.canonical_result, result, "workspace result");
    const revision = bindGitRevision(result.resultRevision.revision, dependencies.sha256);
    const tree = bindGitObjectId(result.resultRevision.revision.tree, dependencies.sha256);
    if (
      canonicalStringify(revision) !== canonicalStringify(result.resultRevision) ||
      result.resultId !== row.result_id ||
      result.workspaceId !== row.workspace_id ||
      tree.descriptorDigest !== row.result_tree_digest ||
      revision.descriptorDigest !== row.result_revision_digest ||
      result.completionFactDigest !== row.completion_fact_digest ||
      result.captureEffectId !== row.capture_effect_id ||
      result.inspectEffectId !== row.inspect_effect_id ||
      result.recordedAt !== row.recorded_at ||
      !workspaces.has(result.workspaceId)
    ) {
      throw new Error("SQLite workspace result columns diverge from canonical authority");
    }
    results.set(result.resultId, result);
  }

  const attemptRows = database
    .prepare<
      [],
      {
        integration_id: string;
        run_key: string;
        repository_id: string;
        phase_id: string;
        definition_generation: number;
        target_ref: string;
        fan_in_digest: string;
        state: IntegrationAttemptState;
        owner_id: string | null;
        fence: number | null;
        slot_resource_key: string | null;
        prepare_effect_id: string;
        inspect_effect_id: string;
        barrier_digest: string | null;
        canonical_barrier: string | null;
        canonical_attempt: string;
      }
    >("SELECT * FROM runner_integration_attempts ORDER BY integration_id")
    .all();
  const attempts = new Map<string, IntegrationAttemptRecord>();
  for (const row of attemptRows) {
    const attempt = parseRunnerValue<IntegrationAttemptRecord>(row.canonical_attempt);
    assertCanonicalStorageRecord(row.canonical_attempt, attempt, "integration attempt");
    validateIntegrationAttemptInput(
      {
        repositoryId: attempt.repositoryId,
        runId: attempt.runId,
        integrationId: attempt.integrationId,
        phaseId: attempt.phaseId,
        definitionGeneration: attempt.definitionGeneration,
        targetRef: attempt.targetRef,
        fanInDigest: attempt.fanInDigest,
        members: attempt.members,
        prepareEffectId: attempt.prepareEffectId,
        inspectEffectId: attempt.inspectEffectId,
      },
      dependencies,
    );
    const barrier =
      row.canonical_barrier === null
        ? undefined
        : validateIntegrationBarrier(
            parseRunnerValue<IntegrationBarrier>(row.canonical_barrier),
            dependencies.sha256,
          );
    if (
      attempt.integrationId !== row.integration_id ||
      attempt.repositoryId !== row.repository_id ||
      attempt.phaseId !== row.phase_id ||
      attempt.definitionGeneration !== row.definition_generation ||
      attempt.targetRef !== row.target_ref ||
      attempt.fanInDigest !== row.fan_in_digest ||
      attempt.state !== row.state ||
      (attempt.ownerId ?? null) !== row.owner_id ||
      (attempt.fence ?? null) !== row.fence ||
      (attempt.slotResourceKey ?? null) !== row.slot_resource_key ||
      attempt.prepareEffectId !== row.prepare_effect_id ||
      attempt.inspectEffectId !== row.inspect_effect_id ||
      (attempt.barrier?.barrierDigest ?? null) !== row.barrier_digest ||
      canonicalStringify(attempt.barrier ?? null) !== canonicalStringify(barrier ?? null) ||
      bindings.get(row.run_key)?.execution.integrationRef !== attempt.targetRef
    ) {
      throw new Error("SQLite integration attempt columns diverge from canonical authority");
    }
    attempts.set(attempt.integrationId, attempt);
  }

  const memberRows = database
    .prepare<
      [],
      {
        integration_id: string;
        ordinal: number;
        workspace_id: string;
        result_id: string;
        member_digest: string;
        canonical_member: string;
      }
    >("SELECT * FROM runner_integration_members ORDER BY integration_id, ordinal")
    .all();
  for (const row of memberRows) {
    const attempt = attempts.get(row.integration_id);
    const expected = attempt?.members[row.ordinal];
    if (
      expected === undefined ||
      expected.workspaceId !== row.workspace_id ||
      expected.resultId !== row.result_id ||
      expected.member.memberDigest !== row.member_digest ||
      canonicalStringify(expected.member) !== row.canonical_member ||
      !workspaces.has(row.workspace_id) ||
      !results.has(row.result_id)
    ) {
      throw new Error("SQLite integration member rows diverge from canonical authority");
    }
  }
  if (
    memberRows.length !==
    [...attempts.values()].reduce((total, attempt) => total + attempt.members.length, 0)
  ) {
    throw new Error("SQLite integration member rows do not exactly cover attempts");
  }

  const gateRows = database
    .prepare<
      [],
      {
        integration_id: string;
        policy_digest: string;
        reading_digest: string;
        evaluation_digest: string;
        decision: "passed" | "failed";
        canonical_evidence: string;
      }
    >("SELECT * FROM runner_integration_gates ORDER BY integration_id")
    .all();
  for (const row of gateRows) {
    const gate = attempts.get(row.integration_id)?.gate;
    if (
      gate === undefined ||
      gate.policyDigest !== row.policy_digest ||
      gate.readingDigest !== row.reading_digest ||
      gate.evaluationDigest !== row.evaluation_digest ||
      gate.decision !== row.decision ||
      canonicalStringify(gate.evidence) !== row.canonical_evidence
    ) {
      throw new Error("SQLite integration gate rows diverge from canonical authority");
    }
  }
  if (gateRows.length !== [...attempts.values()].filter(({ gate }) => gate !== undefined).length) {
    throw new Error("SQLite integration gate rows do not exactly cover attempts");
  }

  const eligibilityRows = database
    .prepare<
      [],
      {
        submission_id: string;
        run_key: string;
        dispatch_id: string;
        mode: "repository" | "worktree";
        terminal_current_writer: number;
        workspace_id: string | null;
        result_id: string | null;
        integration_id: string | null;
        barrier_digest: string | null;
        eligible: number;
        canonical_eligibility: string;
      }
    >("SELECT * FROM runner_completion_eligibility ORDER BY submission_id")
    .all();
  for (const row of eligibilityRows) {
    const record = parseRunnerValue<CompletionEligibilityRecord>(row.canonical_eligibility);
    assertCanonicalStorageRecord(row.canonical_eligibility, record, "completion eligibility");
    const attempt = row.integration_id === null ? undefined : attempts.get(row.integration_id);
    const expectedEligible =
      row.terminal_current_writer === 1 &&
      (row.mode === "repository" ||
        (row.workspace_id !== null &&
          ["captured", "removed"].includes(workspaces.get(row.workspace_id)?.state ?? "") &&
          row.result_id !== null &&
          results.get(row.result_id)?.workspaceId === row.workspace_id &&
          attempt?.state === "barrier-recorded" &&
          attempt.barrier?.barrierDigest === row.barrier_digest));
    if (
      record.submissionId !== row.submission_id ||
      record.dispatchId !== row.dispatch_id ||
      record.mode !== row.mode ||
      record.terminalCurrentWriter !== (row.terminal_current_writer === 1) ||
      (record.workspaceId ?? null) !== row.workspace_id ||
      (record.resultId ?? null) !== row.result_id ||
      (record.integrationId ?? null) !== row.integration_id ||
      (record.barrierDigest ?? null) !== row.barrier_digest ||
      record.eligible !== (row.eligible === 1) ||
      (record.eligible && !expectedEligible) ||
      bindings.get(row.run_key)?.execution.workspaceMode !== record.mode
    ) {
      throw new Error("SQLite completion eligibility diverges from durable authority");
    }
  }
}

function assertCanonicalStorageRecord(serialized: string, value: unknown, label: string): void {
  if (canonicalStringify(value) !== serialized) {
    throw new Error(`SQLite ${label} must use exact canonical JSON`);
  }
}

function verifyAmendmentTables(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
  snapshot: AuthoritySnapshot,
  contextAuthority: InMemoryContextAuthority,
): void {
  const expected = normalizeAmendmentRows(snapshot);
  verifyNormalizedContextRows(
    "amendment_proposals",
    database
      .prepare(
        `SELECT amendment_id, run_key, proposal_digest, base_graph_revision_digest,
                base_context_digest, base_snapshot_digest, result_snapshot_digest,
                reviewed_graph_revision_digest, canonical_proposal
         FROM amendment_proposals ORDER BY amendment_id`,
      )
      .all(),
    expected.proposals,
  );
  verifyNormalizedContextRows(
    "amendment_decisions",
    database
      .prepare(
        `SELECT approval_id, amendment_id, proposal_digest, decision_digest,
                decision, canonical_decision
         FROM amendment_decisions ORDER BY approval_id`,
      )
      .all(),
    expected.decisions,
  );
  verifyNormalizedContextRows(
    "amendment_withdrawals",
    database
      .prepare(
        `SELECT amendment_id, withdrawal_digest, canonical_withdrawal
         FROM amendment_withdrawals ORDER BY amendment_id`,
      )
      .all(),
    expected.withdrawals,
  );
  verifyNormalizedContextRows(
    "amendment_applications",
    database
      .prepare(
        `SELECT amendment_id, application_digest, before_graph_revision_digest,
                after_graph_revision_digest, quiescence_fact_digest, canonical_application
         FROM amendment_applications ORDER BY amendment_id`,
      )
      .all(),
    expected.applications,
  );

  for (const row of database
    .prepare<
      [],
      { snapshot_digest: string; graph_revision_digest: string; canonical_snapshot: string }
    >(
      `SELECT snapshot_digest, graph_revision_digest, canonical_snapshot
       FROM configuration_snapshots ORDER BY snapshot_digest`,
    )
    .all()) {
    const snapshot = validateConfigurationSnapshot(
      JSON.parse(row.canonical_snapshot),
      dependencies,
    );
    if (
      snapshot.snapshotDigest !== row.snapshot_digest ||
      snapshot.graph.revisionDigest !== row.graph_revision_digest ||
      canonicalStringify(snapshot.canonical) !== row.canonical_snapshot
    ) {
      throw new Error("SQLite configuration snapshot row diverges from canonical content");
    }
  }

  const normalizedContext = normalizeContextAuthority(contextAuthority, dependencies.sha256);
  for (const row of normalizedContext.taskScopes) {
    const current = requireTaskScopeCurrentness(database, row.run_key as string, {
      runId: row.run_id as string,
      taskId: row.task_id as string,
      definitionGeneration: row.definition_generation as number,
    });
    if (
      current.fenceGeneration !== row.fence_generation ||
      current.acceptedContextDigest !== row.current_context_digest ||
      current.claimsAccepted !== (row.claims_accepted === 1)
    ) {
      throw new Error("SQLite context and runner task-scope currentness diverge");
    }
  }

  const actualOutbox = database
    .prepare<
      [],
      {
        submission_id: string;
        dispatch_id: string;
        context_id: string;
        amendment_id: string | null;
        canonical_source: string;
        source_digest: string;
        delivered: number;
        claim_owner_id: string | null;
        claim_fence: number | null;
        claim_expires_at: string | null;
      }
    >(
      `SELECT submission_id, dispatch_id, context_id, amendment_id, canonical_source,
              source_digest, delivered, claim_owner_id, claim_fence, claim_expires_at
       FROM context_amendment_outbox ORDER BY submission_id`,
    )
    .all();
  if (actualOutbox.length !== normalizedContext.amendmentOutbox.length) {
    throw new Error("SQLite context amendment outbox does not exactly cover accepted sources");
  }
  for (const [index, expectedRow] of normalizedContext.amendmentOutbox.entries()) {
    const actual = actualOutbox[index];
    if (
      actual === undefined ||
      actual.submission_id !== expectedRow.submission_id ||
      actual.dispatch_id !== expectedRow.dispatch_id ||
      actual.context_id !== expectedRow.context_id ||
      actual.canonical_source !== expectedRow.canonical_source ||
      actual.source_digest !== expectedRow.source_digest ||
      actual.amendment_id !== null ||
      !isSha256Digest(actual.source_digest) ||
      canonicalDigest(
        canonicalValue(decodeCanonicalJsonValue(actual.canonical_source)),
        dependencies.sha256,
      ) !== actual.source_digest ||
      ![0, 1].includes(actual.delivered)
    ) {
      throw new Error("SQLite context amendment outbox source is not semantically bound");
    }
    if (actual.claim_expires_at !== null)
      validateTimestamp(actual.claim_expires_at, "claim_expires_at");
    if (
      (actual.claim_owner_id === null) !== (actual.claim_expires_at === null) ||
      (actual.claim_owner_id !== null && actual.claim_fence === null) ||
      (actual.delivered === 1 &&
        (actual.claim_owner_id !== null || actual.claim_expires_at !== null))
    ) {
      throw new Error("SQLite context amendment outbox claim state is invalid");
    }
  }

  const outboxBySubmission = new Map(actualOutbox.map((row) => [row.submission_id, row]));
  for (const row of database
    .prepare<
      [],
      {
        submission_id: string;
        source_digest: string;
        outcome_kind: string;
        canonical_outcome: string;
        recorded_at: string;
      }
    >(
      `SELECT submission_id, source_digest, outcome_kind, canonical_outcome, recorded_at
       FROM amendment_proposal_bridge_outcomes ORDER BY submission_id`,
    )
    .all()) {
    const outbox = outboxBySubmission.get(row.submission_id);
    const outcome = decodeCanonicalJsonValue(row.canonical_outcome);
    if (
      outbox === undefined ||
      outbox.delivered !== 1 ||
      outbox.source_digest !== row.source_digest ||
      !["acknowledged", "compiled", "diagnostics"].includes(row.outcome_kind) ||
      !isPlainRecord(outcome) ||
      outcome.kind !== row.outcome_kind ||
      outcome.submissionId !== row.submission_id ||
      outcome.sourceDigest !== row.source_digest ||
      canonicalStringify(outcome) !== row.canonical_outcome
    ) {
      throw new Error("SQLite amendment bridge outcome is not bound to delivered source");
    }
    validateTimestamp(row.recorded_at, "recorded_at");
  }

  const proposals = new Map(
    expected.proposals.map((row) => [
      row.amendment_id as string,
      JSON.parse(row.canonical_proposal as string) as AmendmentProposal,
    ]),
  );
  const approved = new Set(
    expected.decisions
      .filter((row) => row.decision === "approve")
      .map((row) => row.amendment_id as string),
  );
  const fenceRows = database
    .prepare<
      [],
      {
        run_key: string;
        repository_id: string;
        run_id: string;
        task_id: string;
        definition_generation: number;
        fence_generation: number;
        current_context_digest: string;
        claims_accepted: number;
        amendment_id: string | null;
        installed_at: string | null;
      }
    >(
      `SELECT run_key, repository_id, run_id, task_id, definition_generation,
              fence_generation, current_context_digest, claims_accepted,
              amendment_id, installed_at
       FROM amendment_work_fences ORDER BY run_key, task_id, definition_generation`,
    )
    .all();
  for (const row of fenceRows) {
    if (
      row.run_key !== canonicalStringify([row.repository_id, row.run_id]) ||
      !Number.isSafeInteger(row.definition_generation) ||
      row.definition_generation <= 0 ||
      !Number.isSafeInteger(row.fence_generation) ||
      row.fence_generation <= 0 ||
      !isSha256Digest(row.current_context_digest) ||
      ![0, 1].includes(row.claims_accepted) ||
      (row.installed_at === null) !== (row.claims_accepted === 1)
    ) {
      throw new Error("SQLite amendment work fence row is invalid");
    }
    if (row.installed_at !== null && row.installed_at !== "context-authority-fence") {
      validateTimestamp(row.installed_at, "amendment fence installed_at");
    }
    if (row.amendment_id !== null) {
      const proposal = proposals.get(row.amendment_id);
      if (
        proposal === undefined ||
        !approved.has(row.amendment_id) ||
        row.claims_accepted !== 0 ||
        !proposal.impact.affectedTaskScopes.some(
          (scope) =>
            scope.taskId === row.task_id &&
            scope.definitionGeneration === row.definition_generation,
        )
      ) {
        throw new Error("SQLite amendment work fence is not bound to approved exact impact");
      }
    }
  }

  for (const row of database
    .prepare<[], { run_key: string; canonical_command: string }>(
      `SELECT run_key, canonical_command FROM runner_commands
       ORDER BY run_key, sequence, command_id`,
    )
    .all()) {
    const command = parseRunnerValue<QueuedEffectCommand>(row.canonical_command);
    const current = requireTaskScopeCurrentness(database, row.run_key, command.taskScope);
    // A queued command is a durable record of what was asked for, and a later
    // attempt taking the scope over does not rewrite history: after a takeover
    // every earlier command names an earlier context, which this read used to
    // call corruption and refuse to open the database on. What no command may
    // ever be is ahead of the fence. Claim time is where a stale command is
    // stopped from running, in `persistIntent`.
    if (command.taskScope.fenceGeneration > current.fenceGeneration) {
      throw new Error("SQLite runner command diverges from shared task-scope currentness");
    }
  }
  for (const row of database
    .prepare<
      [],
      {
        run_key: string;
        intent_id: string;
        context_digest: string;
        task_id: string | null;
        definition_generation: number | null;
        scope_fence_generation: number | null;
        canonical_intent: string;
      }
    >(
      `SELECT c.run_key, c.intent_id, c.context_digest, c.task_id,
              c.definition_generation, c.scope_fence_generation, i.canonical_intent
       FROM runner_effect_claims c
       JOIN runner_effect_intents i ON i.intent_id = c.intent_id
       ORDER BY c.run_key, c.intent_id`,
    )
    .all()) {
    const intent = parseRunnerValue<EffectIntent>(row.canonical_intent);
    if (
      row.task_id !== intent.command.taskScope.taskId ||
      row.definition_generation !== intent.command.taskScope.definitionGeneration ||
      row.context_digest !== intent.command.taskScope.acceptedContextDigest ||
      row.scope_fence_generation === null ||
      row.scope_fence_generation < intent.command.taskScope.fenceGeneration
    ) {
      throw new Error("SQLite runner claim does not bind an exact durable task scope");
    }
    requireTaskScopeCurrentness(database, row.run_key, {
      runId: intent.command.runId,
      taskId: intent.command.taskScope.taskId,
      definitionGeneration: intent.command.taskScope.definitionGeneration,
    });
  }

  const expectedDispatchFences: Record<string, unknown>[] = [];
  for (const amendmentId of approved) {
    const proposal = proposals.get(amendmentId);
    if (proposal === undefined) continue;
    for (const record of contextAuthority.durableSnapshot().dispatches) {
      if (
        proposal.impact.affectedTaskScopes.some(
          (scope) =>
            scope.taskId === record.taskScope.taskId &&
            scope.definitionGeneration === record.taskScope.definitionGeneration,
        )
      ) {
        expectedDispatchFences.push({
          amendment_id: amendmentId,
          dispatch_id: record.dispatch.dispatchId,
          task_id: record.taskScope.taskId,
          definition_generation: record.taskScope.definitionGeneration,
          prior_fence_generation: record.taskScope.fenceGeneration,
          installed_fence_generation: record.taskScope.fenceGeneration + 1,
        });
      }
    }
  }
  expectedDispatchFences.sort(compareNormalized("amendment_id", "dispatch_id"));
  verifyNormalizedContextRows(
    "amendment_fenced_dispatches",
    database
      .prepare(
        `SELECT amendment_id, dispatch_id, task_id, definition_generation,
                prior_fence_generation, installed_fence_generation
         FROM amendment_fenced_dispatches ORDER BY amendment_id, dispatch_id`,
      )
      .all(),
    expectedDispatchFences,
  );
}

function verifySupervisorTables(database: Database.Database): void {
  const repositoryRows = database
    .prepare("SELECT repository_id FROM supervisor_repositories ORDER BY repository_id")
    .all() as { readonly repository_id: string }[];
  const repositoryIds = new Set(repositoryRows.map((row) => row.repository_id));
  const registryRows = database
    .prepare(
      `SELECT repository_id, canonical_path, config_snapshot_id
       FROM supervisor_repository_registry ORDER BY repository_id`,
    )
    .all() as {
    readonly repository_id: string;
    readonly canonical_path: string;
    readonly config_snapshot_id: string;
  }[];
  for (const row of registryRows) {
    validateOpaqueIdentity(row.repository_id);
    validateOpaqueIdentity(row.config_snapshot_id);
    if (
      !repositoryIds.has(row.repository_id) ||
      resolve(row.canonical_path) !== row.canonical_path
    ) {
      throw new Error("Supervisor repository registry row is invalid");
    }
  }
  const runRows = database
    .prepare(
      `SELECT run_key, repository_id, run_id
       FROM supervisor_runs ORDER BY run_key`,
    )
    .all() as {
    readonly run_key: string;
    readonly repository_id: string;
    readonly run_id: string;
  }[];
  const commandRows = database
    .prepare(
      `SELECT command_id, run_key, accepted_sequence, canonical_envelope,
              canonical_admission, state, accepted_at, accepted_at_ms,
              claim_owner_id, claim_fence, claim_expires_at, claim_expires_at_ms,
              terminal_receipt_json
       FROM supervisor_commands ORDER BY run_key, accepted_sequence`,
    )
    .all() as SupervisorCommandVerificationRow[];
  const receiptRows = database
    .prepare(
      `SELECT run_key, sequence, command_id, status, recorded_at, recorded_at_ms,
              canonical_receipt
       FROM supervisor_receipts ORDER BY run_key, sequence`,
    )
    .all() as SupervisorReceiptVerificationRow[];
  const wakeRows = database
    .prepare(
      `SELECT w.run_key, r.repository_id, r.run_id, w.generation, w.ack_generation,
              w.not_before, w.not_before_ms, w.reasons_json
       FROM supervisor_wakes w
       JOIN supervisor_runs r ON r.run_key = w.run_key
       ORDER BY w.run_key`,
    )
    .all() as SupervisorWakeVerificationRow[];
  const authorityCommandRows = database
    .prepare(
      `SELECT command_id, run_key, canonical_envelope, terminal_receipt_json
       FROM commands ORDER BY command_id`,
    )
    .all() as {
    readonly command_id: string;
    readonly run_key: string;
    readonly canonical_envelope: string;
    readonly terminal_receipt_json: string;
  }[];

  const repositories = new Set<string>();
  for (const row of repositoryRows) {
    validateStorageIdentifier(row.repository_id, "supervisor repository_id");
    repositories.add(row.repository_id);
  }
  if (repositories.size !== repositoryRows.length) {
    throw new Error("Supervisor repositories contain duplicate identities");
  }

  const runs = new Map<
    string,
    {
      readonly repositoryId: string;
      readonly runId: string;
      readonly commands: SupervisorCommandVerificationRow[];
    }
  >();
  const referencedRepositories = new Set<string>();
  for (const row of runRows) {
    validateStorageIdentifier(row.repository_id, "supervisor run repository_id");
    validateStorageIdentifier(row.run_id, "supervisor run run_id");
    const expectedRunKey = canonicalStringify([row.repository_id, row.run_id]);
    if (row.run_key !== expectedRunKey || runs.has(row.run_key)) {
      throw new Error("Supervisor run identity does not match its canonical run key");
    }
    referencedRepositories.add(row.repository_id);
    runs.set(row.run_key, {
      repositoryId: row.repository_id,
      runId: row.run_id,
      commands: [],
    });
  }
  if ([...referencedRepositories].some((repositoryId) => !repositories.has(repositoryId))) {
    throw new Error("Supervisor run references a missing repository row");
  }

  const authorityCommands = new Map(authorityCommandRows.map((row) => [row.command_id, row]));
  const commands = new Map<string, SupervisorCommandVerificationRow>();
  for (const row of commandRows) {
    const run = runs.get(row.run_key);
    if (run === undefined || commands.has(row.command_id)) {
      throw new Error("Supervisor command references an invalid run or duplicate command identity");
    }
    const envelope = decodeCommandEnvelope(row.canonical_envelope);
    const admission = decodeSupervisorAdmissionFacts(row.canonical_admission);
    if (
      envelope.commandId !== row.command_id ||
      envelope.repositoryId !== run.repositoryId ||
      envelope.runId !== run.runId ||
      admission.currentTime !== row.accepted_at ||
      timestampEpoch(row.accepted_at, "supervisor accepted_at") !== row.accepted_at_ms ||
      !Number.isSafeInteger(row.accepted_sequence) ||
      row.accepted_sequence <= 0
    ) {
      throw new Error("Supervisor command columns diverge from canonical command content");
    }
    verifySupervisorClaimColumns(row);
    const authorityCommand = authorityCommands.get(row.command_id);
    if (authorityCommand !== undefined) {
      const authorityEnvelope = decodeCommandEnvelope(authorityCommand.canonical_envelope);
      const authorityReceipt = decodeDurableReceipt(authorityCommand.terminal_receipt_json);
      if (
        authorityCommand.run_key !== row.run_key ||
        authorityCommand.canonical_envelope !== row.canonical_envelope ||
        authorityEnvelope.commandId !== row.command_id ||
        authorityReceipt.commandId !== row.command_id ||
        authorityReceipt.repositoryId !== run.repositoryId ||
        authorityReceipt.runId !== run.runId ||
        authorityReceipt.status === "queued" ||
        authorityReceipt.status === "claimed"
      ) {
        throw new Error("Supervisor command diverges from its underlying authority command");
      }
      if (row.state === "queued") {
        throw new Error("Queued supervisor command cannot already exist in command authority");
      }
    }
    if (row.state === "terminal") {
      if (
        row.terminal_receipt_json === null ||
        authorityCommand === undefined ||
        row.terminal_receipt_json !== authorityCommand.terminal_receipt_json
      ) {
        throw new Error("Terminal supervisor command lacks its exact authority receipt");
      }
      const terminal = decodeDurableReceipt(row.terminal_receipt_json);
      if (
        terminal.commandId !== row.command_id ||
        terminal.repositoryId !== run.repositoryId ||
        terminal.runId !== run.runId ||
        terminal.status === "queued" ||
        terminal.status === "claimed"
      ) {
        throw new Error("Terminal supervisor command receipt identity or status is invalid");
      }
    } else if (row.terminal_receipt_json !== null) {
      throw new Error("Nonterminal supervisor command stores a terminal receipt");
    }
    commands.set(row.command_id, row);
    run.commands.push(row);
  }

  for (const [runKey, run] of runs) {
    if (run.commands.length === 0) {
      throw new Error("Supervisor run must contain at least one command");
    }
    for (const [index, command] of run.commands.entries()) {
      if (command.accepted_sequence !== index + 1 || command.run_key !== runKey) {
        throw new Error("Supervisor accepted command sequence is not contiguous within its run");
      }
    }
  }

  const receiptsByCommand = new Map<string, SupervisorReceiptVerificationRow[]>();
  const nextReceiptSequence = new Map<string, number>();
  for (const row of receiptRows) {
    const command = commands.get(row.command_id);
    const run = runs.get(row.run_key);
    const expectedSequence = nextReceiptSequence.get(row.run_key) ?? 1;
    const receipt = decodeSupervisorReceipt(row.canonical_receipt);
    if (
      command === undefined ||
      run === undefined ||
      command.run_key !== row.run_key ||
      row.sequence !== expectedSequence ||
      receipt.sequence !== row.sequence ||
      receipt.commandId !== row.command_id ||
      receipt.repositoryId !== run.repositoryId ||
      receipt.runId !== run.runId ||
      receipt.status !== row.status ||
      receipt.recordedAt !== row.recorded_at ||
      timestampEpoch(row.recorded_at, "supervisor recorded_at") !== row.recorded_at_ms ||
      ((row.status === "queued" || row.status === "terminal") &&
        (row.recorded_at !== command.accepted_at || row.recorded_at_ms !== command.accepted_at_ms))
    ) {
      throw new Error("Supervisor receipt columns diverge from canonical staged history");
    }
    nextReceiptSequence.set(row.run_key, expectedSequence + 1);
    const history = receiptsByCommand.get(row.command_id) ?? [];
    history.push(row);
    receiptsByCommand.set(row.command_id, history);
  }

  for (const command of commandRows) {
    const history = receiptsByCommand.get(command.command_id) ?? [];
    const expectedStatuses =
      command.state === "queued"
        ? ["queued"]
        : command.state === "claimed"
          ? ["queued", "claimed"]
          : ["queued", "claimed", "terminal"];
    if (
      canonicalStringify(history.map((row) => row.status)) !== canonicalStringify(expectedStatuses)
    ) {
      throw new Error("Supervisor command staged history does not match its latest state");
    }
    const latest = history.at(-1);
    if (latest === undefined || latest.status !== command.state) {
      throw new Error("Supervisor command latest staged receipt does not match command state");
    }
    if (command.state === "terminal") {
      const receipt = decodeSupervisorReceipt(latest.canonical_receipt);
      if (
        receipt.terminalReceipt === undefined ||
        canonicalStringify(receipt.terminalReceipt) !== command.terminal_receipt_json
      ) {
        throw new Error("Supervisor terminal staged receipt does not match authority receipt");
      }
    }
  }

  if (wakeRows.length !== runs.size) {
    throw new Error("Supervisor wakes do not exactly cover supervisor runs");
  }
  for (const row of wakeRows) {
    const run = runs.get(row.run_key);
    const reasons = JSON.parse(row.reasons_json) as unknown;
    const wake = decodeSupervisorWake({
      repositoryId: row.repository_id,
      runId: row.run_id,
      generation: row.generation,
      acknowledgedGeneration: row.ack_generation,
      notBefore: row.not_before,
      reasons,
    });
    const latestCommand = run?.commands.at(-1);
    const hasPendingWork = run?.commands.some((command) => command.state !== "terminal") ?? false;
    if (
      run === undefined ||
      wake.repositoryId !== run.repositoryId ||
      wake.runId !== run.runId ||
      row.reasons_json !== canonicalStringify(wake.reasons) ||
      row.generation !== run.commands.length ||
      latestCommand === undefined ||
      wake.notBefore !== latestCommand.accepted_at ||
      timestampEpoch(row.not_before, "supervisor wake not_before") !== row.not_before_ms ||
      (hasPendingWork && row.ack_generation >= row.generation) ||
      (!hasPendingWork && row.ack_generation !== row.generation)
    ) {
      throw new Error("Supervisor wake does not match its run command state");
    }
  }

  const serviceRows = database
    .prepare(
      `SELECT singleton, desired_mode, updated_at, updated_at_ms
       FROM supervisor_service_state ORDER BY singleton`,
    )
    .all() as {
    readonly singleton: number;
    readonly desired_mode: string;
    readonly updated_at: string;
    readonly updated_at_ms: number;
  }[];
  if (serviceRows.length !== 1 || serviceRows[0]?.singleton !== 1) {
    throw new Error("Supervisor service state must contain exactly one singleton");
  }
  const service = decodeSupervisorServiceRecord({
    mode: serviceRows[0].desired_mode,
    changedAt: serviceRows[0].updated_at,
  });
  if (
    timestampEpoch(service.changedAt, "supervisor service changedAt") !==
    serviceRows[0].updated_at_ms
  ) {
    throw new Error("Supervisor service timestamp does not match its epoch value");
  }

  const logRows = database
    .prepare(
      `SELECT cursor, recorded_at, recorded_at_ms, level, event, message, fields_json
       FROM supervisor_logs ORDER BY cursor`,
    )
    .all() as {
    readonly cursor: number;
    readonly recorded_at: string;
    readonly recorded_at_ms: number;
    readonly level: string;
    readonly event: string;
    readonly message: string;
    readonly fields_json: string;
  }[];
  let previousCursor = 0;
  for (const row of logRows) {
    const fields = decodeCanonicalJsonValue(row.fields_json);
    if (
      !Number.isSafeInteger(row.cursor) ||
      row.cursor <= previousCursor ||
      timestampEpoch(row.recorded_at, "supervisor log recordedAt") !== row.recorded_at_ms ||
      !["debug", "info", "warn", "error"].includes(row.level) ||
      row.event.length === 0 ||
      row.event.length > 128 ||
      row.message.length === 0 ||
      row.message.length > 2_048 ||
      containsControlCharacter(row.event) ||
      containsControlCharacter(row.message) ||
      canonicalStringify(fields) !== row.fields_json
    ) {
      throw new Error("Supervisor log row is invalid");
    }
    previousCursor = row.cursor;
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

interface SupervisorCommandVerificationRow {
  readonly command_id: string;
  readonly run_key: string;
  readonly accepted_sequence: number;
  readonly canonical_envelope: string;
  readonly canonical_admission: string;
  readonly state: "queued" | "claimed" | "terminal";
  readonly accepted_at: string;
  readonly accepted_at_ms: number;
  readonly claim_owner_id: string | null;
  readonly claim_fence: number | null;
  readonly claim_expires_at: string | null;
  readonly claim_expires_at_ms: number | null;
  readonly terminal_receipt_json: string | null;
}

interface SupervisorReceiptVerificationRow {
  readonly run_key: string;
  readonly sequence: number;
  readonly command_id: string;
  readonly status: "queued" | "claimed" | "terminal";
  readonly recorded_at: string;
  readonly recorded_at_ms: number;
  readonly canonical_receipt: string;
}

interface SupervisorWakeVerificationRow {
  readonly run_key: string;
  readonly repository_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly ack_generation: number;
  readonly not_before: string;
  readonly not_before_ms: number;
  readonly reasons_json: string;
}

function verifySupervisorClaimColumns(row: SupervisorCommandVerificationRow): void {
  if (row.state !== "claimed") {
    if (
      row.claim_owner_id !== null ||
      row.claim_fence !== null ||
      row.claim_expires_at !== null ||
      row.claim_expires_at_ms !== null
    ) {
      throw new Error("Nonclaimed supervisor command contains claim fields");
    }
    return;
  }
  if (
    row.claim_owner_id === null ||
    row.claim_fence === null ||
    !Number.isSafeInteger(row.claim_fence) ||
    row.claim_fence <= 0 ||
    row.claim_expires_at === null ||
    row.claim_expires_at_ms === null
  ) {
    throw new Error("Claimed supervisor command lacks exact claim fields");
  }
  validateStorageIdentifier(row.claim_owner_id, "supervisor claim owner");
  if (timestampEpoch(row.claim_expires_at, "supervisor claim expiry") !== row.claim_expires_at_ms) {
    throw new Error("Supervisor claim expiry does not match its epoch value");
  }
}

function timestampEpoch(value: string, field: string): number {
  validateTimestamp(value, field);
  const epoch = Date.parse(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (!Number.isSafeInteger(epoch) || new Date(value).toISOString() !== normalized) {
    throw new TypeError(`${field} must be an exact UTC timestamp`);
  }
  return epoch;
}

function normalizeContextAuthority(
  authority: InMemoryContextAuthority,
  sha256: RuntimeDependencies["sha256"],
) {
  const snapshot = authority.snapshot();
  const durable = authority.durableSnapshot();
  const storedByDispatch = new Map(
    durable.dispatches.map((record) => [record.dispatch.dispatchId, record]),
  );
  return {
    taskScopes: durable.taskScopes.map((scope) => {
      const dispatch = durable.dispatches.find(
        (record) =>
          record.taskScope.runId === scope.runId &&
          record.taskScope.taskId === scope.taskId &&
          record.taskScope.definitionGeneration === scope.definitionGeneration,
      )?.dispatch;
      if (dispatch === undefined) {
        throw new Error("Context task scope has no exact durable dispatch binding");
      }
      return {
        run_key: canonicalStringify([dispatch.repositoryId, dispatch.runId]),
        repository_id: dispatch.repositoryId,
        run_id: dispatch.runId,
        task_id: scope.taskId,
        definition_generation: scope.definitionGeneration,
        fence_generation: scope.fenceGeneration,
        current_context_digest: scope.acceptedContextDigest,
        claims_accepted: scope.claimsAccepted ? 1 : 0,
        amendment_id: null,
        installed_at: scope.claimsAccepted ? null : "context-authority-fence",
      };
    }),
    contextBases: snapshot.contexts.map((context) => ({
      context_id: context.contextId,
      context_digest: context.contextDigest,
      canonical_context: canonicalStringify(context),
    })),
    dispatches: snapshot.dispatches.map((dispatch) => {
      const stored = storedByDispatch.get(dispatch.dispatchId);
      if (stored === undefined) {
        throw new Error("Context dispatch normalization is missing its durable record");
      }
      return {
        dispatch_id: dispatch.dispatchId,
        repository_id: dispatch.repositoryId,
        run_id: dispatch.runId,
        context_id: dispatch.contextId,
        prompt_pack_digest: dispatch.promptPackDigest,
        canonical_dispatch: canonicalStringify(dispatch),
        canonical_completion_requirements: canonicalStringify(stored.completionRequirements),
        canonical_task_scope: canonicalStringify(stored.taskScope),
        canonical_effect: stored.effect === undefined ? null : canonicalStringify(stored.effect),
      };
    }),
    bindings: snapshot.contexts
      .flatMap((context) =>
        context.assets.map((binding) => ({
          asset_binding_id: binding.assetBindingId,
          context_id: context.contextId,
          semantic_asset_id: binding.semanticAssetId,
          alias_binding_digest: binding.aliasBindingDigest,
          content_digest: binding.contentDigest,
          byte_length: binding.byteLength,
          media_type: binding.mediaType,
        })),
      )
      .sort((left, right) => compareNormalizedText(left.asset_binding_id, right.asset_binding_id)),
    grants: snapshot.grants.map((grant) => ({
      token_digest: grant.tokenDigest,
      dispatch_id: grant.envelope.dispatchId,
      repository_id: grant.envelope.repositoryId,
      run_id: grant.envelope.runId,
      asset_binding_id: grant.envelope.assetBindingId,
      canonical_envelope: canonicalStringify(grant.envelope),
      operations_used: grant.operationsUsed,
      bytes_used: grant.bytesUsed,
    })),
    readAttempts: durable.reads
      .map((read) => {
        return {
          request_id: read.requestId,
          token_digest: read.tokenDigest,
          dispatch_id:
            read.result.receipt.dispatchId === "dispatch_unknown"
              ? null
              : read.result.receipt.dispatchId,
          repository_id: read.result.receipt.repositoryId,
          run_id: read.result.receipt.runId,
          canonical_replay_key: read.canonicalReplayKey,
          replay_key_digest: read.replayKeyDigest,
          request_digest: read.requestDigest,
          status: read.result.status,
          result_bytes: read.result.bytes ?? null,
          canonical_receipt: canonicalStringify(read.result.receipt),
          owner_id: null,
          fence: null,
        };
      })
      .sort((left, right) => compareNormalizedText(left.request_id, right.request_id)),
    receipts: durable.receiptAttempts.map((attempt) => ({
      receipt_cursor: attempt.receiptCursor,
      request_id: attempt.receipt.requestId,
      repository_id: attempt.receipt.repositoryId,
      run_id: attempt.receipt.runId,
      dispatch_id: attempt.receipt.dispatchId,
      canonical_replay_key: attempt.canonicalReplayKey,
      replay_key_digest: attempt.replayKeyDigest,
      token_digest: attempt.tokenDigest,
      request_digest: attempt.requestDigest,
      reserved: attempt.reserved ? 1 : 0,
      failure_stage: attempt.failureStage ?? null,
      failure_fact_digest: attempt.failureFactDigest ?? null,
      canonical_receipt: canonicalStringify(attempt.receipt),
    })),
    events: snapshot.events.map((event) => ({
      cursor: event.cursor,
      repository_id: event.repositoryId,
      run_id: event.runId,
      dispatch_id: event.dispatchId,
      event_type: event.eventType,
      canonical_event: canonicalStringify(event),
    })),
    projection: [
      {
        singleton: 1,
        cursor: snapshot.projection.cursor,
        canonical_projection: canonicalStringify(snapshot.projection),
      },
    ],
    submissions: snapshot.submissions.map((stored) => ({
      submission_id: stored.submission.submissionId,
      repository_id: stored.submission.repositoryId,
      run_id: stored.submission.runId,
      dispatch_id: stored.submission.dispatchId,
      submission_type: stored.submission.type,
      canonical_submission: canonicalStringify(stored.submission),
      canonical_result: canonicalStringify(stored.result),
    })),
    questions: snapshot.questions.map((question) => ({
      submission_id: question.submissionId,
      repository_id: question.repositoryId,
      run_id: question.runId,
      canonical_question: canonicalStringify(question),
    })),
    terminalCompletions: snapshot.terminalCompletions.map((terminal) => ({
      dispatch_id: terminal.dispatchId,
      submission_id: terminal.submissionId,
    })),
    completionOutbox: snapshot.completionOutbox.map((pending) => ({
      submission_id: pending.submissionId,
      dispatch_id: pending.fact.dispatchId,
      canonical_fact: canonicalStringify(pending.fact),
      delivered: pending.delivered ? 1 : 0,
    })),
    phaseOutputOutbox: snapshot.phaseOutputOutbox.map((pending) => ({
      submission_id: pending.submissionId,
      dispatch_id: pending.fact.dispatchId,
      canonical_fact: canonicalStringify(pending.fact),
      delivered: pending.delivered ? 1 : 0,
    })),
    amendmentOutbox: snapshot.submissions.flatMap(({ submission, result }) => {
      if (submission.type !== "amendment-proposal" || result.status !== "accepted") return [];
      const context = snapshot.contexts.find(
        (candidate) => candidate.contextId === submission.contextId,
      );
      if (
        context === undefined ||
        context.contextDigest !== submission.amendment.baseContextDigest
      ) {
        throw new Error("Worker amendment source lacks its exact historical context");
      }
      const source = { submission, context };
      return [
        {
          submission_id: submission.submissionId,
          dispatch_id: submission.dispatchId,
          context_id: submission.contextId,
          canonical_source: canonicalStringify(source),
          source_digest: canonicalDigest(canonicalValue(source), sha256),
        },
      ];
    }),
  };
}

function verifyNormalizedContextAuthority(
  database: Database.Database,
  authority: InMemoryContextAuthority,
  sha256: RuntimeDependencies["sha256"],
): void {
  const expected = normalizeContextAuthority(authority, sha256);
  verifyNormalizedContextRows(
    "context_bases",
    database
      .prepare(
        `SELECT context_id, context_digest, canonical_context
         FROM context_bases ORDER BY context_id`,
      )
      .all(),
    expected.contextBases,
  );
  verifyNormalizedContextRows(
    "context_dispatches",
    database
      .prepare(
        `SELECT dispatch_id, repository_id, run_id, context_id, prompt_pack_digest,
                canonical_dispatch, canonical_completion_requirements,
                canonical_task_scope, canonical_effect
         FROM context_dispatches ORDER BY dispatch_id`,
      )
      .all(),
    expected.dispatches,
  );
  verifyNormalizedContextRows(
    "context_asset_bindings",
    database
      .prepare(
        `SELECT asset_binding_id, context_id, semantic_asset_id, alias_binding_digest,
                content_digest, byte_length, media_type
         FROM context_asset_bindings ORDER BY asset_binding_id`,
      )
      .all(),
    expected.bindings,
  );
  verifyNormalizedContextRows(
    "context_grants",
    database
      .prepare(
        `SELECT token_digest, dispatch_id, repository_id, run_id, asset_binding_id,
                canonical_envelope, operations_used, bytes_used
         FROM context_grants ORDER BY token_digest`,
      )
      .all(),
    expected.grants,
  );
  const readRows = database
    .prepare<
      [],
      {
        request_id: string;
        token_digest: string;
        dispatch_id: string | null;
        repository_id: string;
        run_id: string;
        canonical_replay_key: string;
        replay_key_digest: string;
        request_digest: string;
        status: string;
        result_bytes: Uint8Array | null;
        canonical_receipt: string | null;
        owner_id: string | null;
        fence: number | null;
      }
    >(
      `SELECT request_id, token_digest, dispatch_id, repository_id, run_id,
              canonical_replay_key, replay_key_digest, request_digest, status, result_bytes,
              canonical_receipt, owner_id, fence
       FROM context_read_attempts ORDER BY request_id`,
    )
    .all()
    .map((row) => ({
      ...row,
      result_bytes: row.result_bytes === null ? null : [...row.result_bytes],
    }));
  verifyNormalizedContextRows("context_read_attempts", readRows, expected.readAttempts);
  verifyNormalizedContextRows(
    "context_audit_receipts",
    database
      .prepare(
        `SELECT receipt_cursor, request_id, repository_id, run_id, dispatch_id,
          canonical_replay_key, replay_key_digest, token_digest, request_digest,
          reserved, failure_stage, failure_fact_digest, canonical_receipt
         FROM context_audit_receipts ORDER BY receipt_cursor`,
      )
      .all(),
    expected.receipts,
  );
  verifyNormalizedContextRows(
    "context_events",
    database
      .prepare(
        `SELECT cursor, repository_id, run_id, dispatch_id, event_type, canonical_event
         FROM context_events ORDER BY cursor`,
      )
      .all(),
    expected.events,
  );
  verifyNormalizedContextRows(
    "context_projection",
    database
      .prepare(
        "SELECT singleton, cursor, canonical_projection FROM context_projection ORDER BY singleton",
      )
      .all(),
    expected.projection,
  );
  verifyNormalizedContextRows(
    "context_submissions",
    database
      .prepare(
        `SELECT submission_id, repository_id, run_id, dispatch_id, submission_type,
                canonical_submission, canonical_result
         FROM context_submissions ORDER BY submission_id`,
      )
      .all(),
    expected.submissions,
  );
  verifyNormalizedContextRows(
    "context_questions",
    database
      .prepare(
        `SELECT submission_id, repository_id, run_id, canonical_question
         FROM context_questions ORDER BY submission_id`,
      )
      .all(),
    expected.questions,
  );
  verifyNormalizedContextRows(
    "context_terminal_completions",
    database
      .prepare(
        `SELECT dispatch_id, submission_id
         FROM context_terminal_completions ORDER BY dispatch_id`,
      )
      .all(),
    expected.terminalCompletions,
  );
  verifyNormalizedContextRows(
    "context_completion_outbox",
    database
      .prepare(
        `SELECT submission_id, dispatch_id, canonical_fact, delivered
         FROM context_completion_outbox ORDER BY submission_id`,
      )
      .all(),
    expected.completionOutbox,
  );
  verifyNormalizedContextRows(
    "context_phase_output_outbox",
    database
      .prepare(
        `SELECT submission_id, dispatch_id, canonical_fact, delivered
         FROM context_phase_output_outbox ORDER BY submission_id`,
      )
      .all(),
    expected.phaseOutputOutbox,
  );
}

function verifyNormalizedContextRows(
  table: string,
  actual: readonly unknown[],
  expected: readonly unknown[],
): void {
  if (actual.length !== expected.length)
    throw new Error(`SQLite ${table} row count diverges from canonical context authority`);
  // Every row here is keyed, so the two sides hold a set rather than a
  // sequence. Reading the table in key order and the authority in the order
  // things happened made a second question look like corruption and refused to
  // open the database at all.
  const left = [...actual].map((row) => canonicalStringify(row)).sort(compareText);
  const right = [...expected].map((row) => canonicalStringify(row)).sort(compareText);
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index])
      throw new Error(`SQLite ${table} row ${index} diverges from canonical context authority`);
  }
}

function verifyDurableContextReads(
  database: Database.Database,
  authority: InMemoryContextAuthority,
): void {
  const snapshot = authority.snapshot();
  const durable = authority.durableSnapshot();
  const contexts = new Map<string, ContextAuthoritySnapshot["contexts"][number]>(
    snapshot.contexts.map((context) => [context.contextId, context]),
  );
  const grants = new Map(durable.grants.map((grant) => [grant.tokenDigest, grant]));
  const reads = new Map(durable.reads.map((read) => [read.requestId, read]));

  for (const read of durable.reads) {
    if (read.result.status !== "served") continue;
    const replay = decodePersistedAssetReadReplayKey(read.canonicalReplayKey);
    const grant = grants.get(replay.tokenDigest);
    if (grant === undefined)
      throw new Error("SQLite served context read does not resolve its exact persisted grant");
    const context = contexts.get(grant.envelope.contextId);
    const binding = context?.assets.find(
      ({ assetBindingId }) => assetBindingId === replay.assetBindingId,
    );
    if (binding === undefined)
      throw new Error("SQLite served context read does not resolve its historical asset binding");
    const content =
      replay.type === "pointer" && binding.byteLength <= DEFAULT_POINTER_ASSET_MAX_BYTES
        ? readVerifiedContextAssetRange(database, binding, 0, binding.byteLength)
        : undefined;
    const expected =
      replay.type === "chunk"
        ? readVerifiedContextAssetRange(database, binding, replay.offset, replay.length)
        : content === undefined
          ? undefined
          : readCanonicalJsonPointer(content, replay.pointer, replay.maxBytes);
    if (expected === undefined || !sameContextBytes(expected, read.result.bytes))
      throw new Error("SQLite durable context read bytes do not match verified historical asset");
  }

  const usage = new Map(
    durable.grants.map((grant) => [grant.tokenDigest, { operations: 0, bytes: 0 }]),
  );
  for (const attempt of durable.receiptAttempts) {
    const receipt = attempt.receipt;
    const read = reads.get(receipt.requestId);
    if (read === undefined)
      throw new Error("SQLite context receipt does not resolve its durable read");
    const replay = decodePersistedAssetReadReplayKey(attempt.canonicalReplayKey);
    const isStoredResult = canonicalStringify(receipt) === canonicalStringify(read.result.receipt);
    const grant = grants.get(attempt.tokenDigest);
    if (grant === undefined) {
      if (
        attempt.reserved ||
        receipt.status !== "denied" ||
        receipt.denialCode !== (isStoredResult ? "invalid-token" : "request-conflict") ||
        receipt.chargedOperations !== 0 ||
        receipt.chargedBytes !== 0 ||
        receipt.responseBytes !== 0 ||
        receipt.remainingOperations !== 0 ||
        receipt.remainingBytes !== 0
      )
        throw new Error("SQLite unknown-token context receipt has invalid derived accounting");
      continue;
    }
    const charged = usage.get(grant.tokenDigest);
    if (charged === undefined) throw new Error("SQLite context grant usage state is missing");
    const context = contexts.get(grant.envelope.contextId);
    const binding = context?.assets.find(
      ({ assetBindingId }) => assetBindingId === grant.envelope.assetBindingId,
    );
    if (binding === undefined)
      throw new Error("SQLite context receipt does not resolve its historical asset binding");
    const expected = deriveExpectedContextReadAccounting(
      database,
      replay,
      attempt,
      grant,
      binding,
      charged,
      isStoredResult,
    );
    if (
      attempt.tokenDigest !== replay.tokenDigest ||
      attempt.reserved !== expected.reserved ||
      receipt.status !== expected.status ||
      receipt.denialCode !== expected.denialCode ||
      receipt.chargedOperations !== expected.operations ||
      receipt.chargedBytes !== expected.bytes ||
      receipt.responseBytes !== expected.responseBytes
    )
      throw new Error("SQLite context receipt fields do not match verifier-derived accounting");
    charged.operations += expected.operations;
    charged.bytes += expected.bytes;
    if (
      charged.operations > grant.envelope.maxOperations ||
      charged.bytes > grant.envelope.maxBytes ||
      receipt.remainingOperations !== grant.envelope.maxOperations - charged.operations ||
      receipt.remainingBytes !== grant.envelope.maxBytes - charged.bytes
    )
      throw new Error("SQLite context receipt remaining budget does not match ordered usage");
  }
  for (const grant of durable.grants) {
    const charged = usage.get(grant.tokenDigest);
    if (
      charged === undefined ||
      grant.operationsUsed !== charged.operations ||
      grant.bytesUsed !== charged.bytes
    )
      throw new Error("SQLite context grant counters do not match the completed read ledger");
  }
}

interface DerivedContextReadAccounting {
  readonly status: "served" | "denied";
  readonly denialCode?: ContextAuthoritySnapshot["receipts"][number]["denialCode"];
  readonly reserved: boolean;
  readonly operations: number;
  readonly bytes: number;
  readonly responseBytes: number;
}

function deriveExpectedContextReadAccounting(
  database: Database.Database,
  replay: ReturnType<typeof decodePersistedAssetReadReplayKey>,
  attempt: ReturnType<InMemoryContextAuthority["durableSnapshot"]>["receiptAttempts"][number],
  grant: ReturnType<InMemoryContextAuthority["durableSnapshot"]>["grants"][number],
  binding: HistoricalAssetBinding,
  charged: { operations: number; bytes: number },
  isStoredResult: boolean,
): DerivedContextReadAccounting {
  const receipt = attempt.receipt;
  const denied = (
    denialCode: NonNullable<DerivedContextReadAccounting["denialCode"]>,
    reserved = false,
  ): DerivedContextReadAccounting => ({
    status: "denied",
    denialCode,
    reserved,
    operations: reserved ? 1 : 0,
    bytes: 0,
    responseBytes: 0,
  });
  if (!isStoredResult) return denied("request-conflict");
  if (replay.assetBindingId !== grant.envelope.assetBindingId) return denied("scope-denied");
  if (Date.parse(receipt.occurredAt) >= Date.parse(grant.envelope.expiresAt))
    return denied("expired");
  if (!persistedContextRequestAllowed(replay, grant.envelope, binding))
    return denied(replay.type === "chunk" ? "invalid-range" : "invalid-pointer");
  const worstCaseBytes = assetReadWorstCaseBytes(replay);
  if (
    charged.operations + 1 > grant.envelope.maxOperations ||
    charged.bytes + worstCaseBytes > grant.envelope.maxBytes
  )
    return denied("budget-exhausted");
  const content =
    replay.type === "pointer" && binding.byteLength <= DEFAULT_POINTER_ASSET_MAX_BYTES
      ? readVerifiedContextAssetRange(database, binding, 0, binding.byteLength)
      : undefined;
  const response =
    replay.type === "chunk"
      ? readVerifiedContextAssetRange(database, binding, replay.offset, replay.length)
      : content === undefined
        ? undefined
        : readCanonicalJsonPointer(content, replay.pointer, replay.maxBytes);
  if (
    receipt.status === "denied" &&
    receipt.denialCode === "digest-mismatch" &&
    attempt.failureStage !== undefined &&
    attempt.failureFactDigest !== undefined
  )
    return denied("digest-mismatch", true);
  if (response === undefined) return denied("invalid-pointer", true);
  return {
    status: "served",
    reserved: true,
    operations: 1,
    bytes: worstCaseBytes,
    responseBytes: response.byteLength,
  };
}

function persistedContextRequestAllowed(
  request: ReturnType<typeof decodePersistedAssetReadReplayKey>,
  envelope: ReturnType<InMemoryContextAuthority["durableSnapshot"]>["grants"][number]["envelope"],
  binding: HistoricalAssetBinding,
): boolean {
  if (request.type === "chunk") {
    if (envelope.readMode === "pointer") return false;
    return (
      request.length <= envelope.maxChunkBytes &&
      request.offset <= binding.byteLength &&
      request.length <= binding.byteLength - request.offset
    );
  }
  if (envelope.readMode === "chunk") return false;
  const pointerSegments = parsePersistedJsonPointer(request.pointer);
  const allowedSegments = parsePersistedJsonPointer(envelope.allowedPointer);
  return allowedSegments.every((segment, index) => pointerSegments[index] === segment);
}

function parsePersistedJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function readVerifiedContextAssetRange(
  database: Database.Database,
  binding: HistoricalAssetBinding,
  offset: number,
  length: number,
): Uint8Array | undefined {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > binding.byteLength ||
    length > binding.byteLength - offset
  )
    return undefined;
  if (length === 0) return new Uint8Array();
  const firstChunk = Math.floor(offset / CONTEXT_ASSET_CHUNK_BYTES);
  const lastChunk = Math.floor((offset + length - 1) / CONTEXT_ASSET_CHUNK_BYTES);
  const rows = database
    .prepare<[string, number, number], Pick<ContextChunkRow, "byte_offset" | "content">>(
      `SELECT byte_offset, content FROM context_asset_chunks
       WHERE asset_binding_id = ? AND chunk_index BETWEEN ? AND ?
       ORDER BY chunk_index`,
    )
    .all(binding.assetBindingId, firstChunk, lastChunk);
  if (rows.length !== lastChunk - firstChunk + 1) return undefined;
  const result = new Uint8Array(length);
  for (const row of rows) {
    const copyStart = Math.max(offset, row.byte_offset);
    const copyEnd = Math.min(offset + length, row.byte_offset + row.content.byteLength);
    result.set(
      row.content.slice(copyStart - row.byte_offset, copyEnd - row.byte_offset),
      copyStart - offset,
    );
  }
  return result;
}

function sameContextBytes(expected: Uint8Array, actual: readonly number[] | undefined): boolean {
  return (
    actual !== undefined &&
    expected.byteLength === actual.length &&
    expected.every((byte, index) => byte === actual[index])
  );
}

function compareNormalizedText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface ContextManifestVerificationRow {
  readonly asset_binding_id: string;
  readonly binding_content_digest: string;
  readonly binding_byte_length: number;
  readonly content_digest: string;
  readonly byte_length: number;
  readonly chunk_size: number;
  readonly chunk_count: number;
}

function expectedContextChunkCount(byteLength: number): number {
  return Math.ceil(byteLength / CONTEXT_ASSET_CHUNK_BYTES);
}

function expectedContextChunkLength(
  byteLength: number,
  chunkCount: number,
  chunkIndex: number,
): number {
  return chunkIndex + 1 < chunkCount
    ? CONTEXT_ASSET_CHUNK_BYTES
    : byteLength - chunkIndex * CONTEXT_ASSET_CHUNK_BYTES;
}

function verifyAllContextAssetManifests(
  database: Database.Database,
  sha256: RuntimeDependencies["sha256"],
): void {
  const manifests = database
    .prepare<[], { asset_binding_id: string }>(
      "SELECT asset_binding_id FROM context_asset_manifests ORDER BY asset_binding_id",
    )
    .all();
  for (const manifest of manifests)
    verifyContextAssetManifest(database, manifest.asset_binding_id, sha256);
}

function verifyContextAssetManifest(
  database: Database.Database,
  assetBindingId: string,
  sha256: RuntimeDependencies["sha256"],
): void {
  const manifest = database
    .prepare<[string], ContextManifestVerificationRow>(
      `SELECT
         manifest.asset_binding_id,
         binding.content_digest AS binding_content_digest,
         binding.byte_length AS binding_byte_length,
         manifest.content_digest,
         manifest.byte_length,
         manifest.chunk_size,
         manifest.chunk_count
       FROM context_asset_manifests AS manifest
       JOIN context_asset_bindings AS binding
         ON binding.asset_binding_id = manifest.asset_binding_id
       WHERE manifest.asset_binding_id = ?`,
    )
    .get(assetBindingId);
  if (manifest === undefined) throw new Error("SQLite context asset manifest is missing");
  if (
    !Number.isSafeInteger(manifest.byte_length) ||
    manifest.byte_length < 0 ||
    manifest.byte_length > MAX_VERIFIED_CONTEXT_ASSET_BYTES ||
    manifest.binding_content_digest !== manifest.content_digest ||
    manifest.binding_byte_length !== manifest.byte_length ||
    manifest.chunk_size !== CONTEXT_ASSET_CHUNK_BYTES ||
    manifest.chunk_count !== expectedContextChunkCount(manifest.byte_length)
  )
    throw new Error("SQLite context asset manifest does not match its exact binding facts");
  const rows = database
    .prepare<[string], ContextChunkRow>(
      `SELECT chunk_index, byte_offset, byte_length, chunk_digest, content
       FROM context_asset_chunks
       WHERE asset_binding_id = ?
       ORDER BY chunk_index`,
    )
    .all(assetBindingId);
  if (rows.length !== manifest.chunk_count)
    throw new Error("SQLite context asset chunk count does not match its manifest");
  const contentBytes = new Uint8Array(manifest.byte_length);
  let aggregateLength = 0;
  for (const [index, row] of rows.entries()) {
    const content = Uint8Array.from(row.content);
    const expectedLength = expectedContextChunkLength(
      manifest.byte_length,
      manifest.chunk_count,
      index,
    );
    if (
      row.chunk_index !== index ||
      row.byte_offset !== index * CONTEXT_ASSET_CHUNK_BYTES ||
      row.byte_length !== expectedLength ||
      content.byteLength !== expectedLength ||
      sha256.digest(content) !== row.chunk_digest
    )
      throw new Error("SQLite context asset chunk integrity check failed");
    contentBytes.set(content, row.byte_offset);
    aggregateLength += content.byteLength;
  }
  if (
    aggregateLength !== manifest.byte_length ||
    sha256.digest(contentBytes) !== manifest.content_digest
  )
    throw new Error("SQLite context asset full content digest check failed");
}

function readAssetDescriptors(database: Database.Database): readonly AssetDescriptor[] {
  return database
    .prepare<[], AssetRow>(
      "SELECT digest, byte_length, media_type, relative_path FROM assets ORDER BY digest",
    )
    .all()
    .map(toAssetDescriptor);
}

function persistSnapshot(
  database: Database.Database,
  snapshot: AuthoritySnapshot,
  serialized: string,
  expectedRevision: number,
  dependencies: RuntimeDependencies,
): void {
  const normalized = normalizeSnapshot(snapshot, dependencies);
  database.exec(
    "UPDATE repositories SET active_run_key = NULL; DELETE FROM event_frames; DELETE FROM receipt_history;",
  );
  const insertRepository = database.prepare(
    "INSERT INTO repositories(repository_id, active_run_key) VALUES (?, NULL) ON CONFLICT(repository_id) DO NOTHING",
  );
  const upsertRun = database.prepare(
    `INSERT INTO runs(
       run_key, repository_id, run_id, cursor, records_json, projection_generated_at, revision_digest
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_key) DO UPDATE SET
       cursor = excluded.cursor,
       records_json = excluded.records_json,
       projection_generated_at = excluded.projection_generated_at,
       revision_digest = excluded.revision_digest`,
  );
  const upsertCommand = database.prepare(
    `INSERT INTO commands(
       command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(command_id) DO UPDATE SET
       run_key = excluded.run_key,
       canonical_envelope = excluded.canonical_envelope,
       admission_json = excluded.admission_json,
       terminal_receipt_json = excluded.terminal_receipt_json`,
  );
  const insertReceipt = database.prepare(
    `INSERT INTO receipt_history(
       run_key, cursor, command_id, ordinal, status, canonical_receipt
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO event_frames(
       event_id, run_key, cursor, command_id, event_type, canonical_frame
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const repository of normalized.repositories) {
    insertRepository.run(repository.repository_id);
  }
  for (const run of normalized.runs) {
    upsertRun.run(
      run.run_key,
      run.repository_id,
      run.run_id,
      run.cursor,
      run.records_json,
      run.projection_generated_at,
      run.revision_digest,
    );
  }
  for (const command of normalized.commands) {
    upsertCommand.run(
      command.command_id,
      command.run_key,
      command.canonical_envelope,
      command.admission_json,
      command.terminal_receipt_json,
    );
  }
  const desiredCommandIds = new Set(normalized.commands.map((row) => row.command_id as string));
  const deleteClaimsForCommand = database.prepare("DELETE FROM claims WHERE command_id = ?");
  const deleteCommand = database.prepare("DELETE FROM commands WHERE command_id = ?");
  for (const row of database
    .prepare<[], { command_id: string }>("SELECT command_id FROM commands")
    .all()) {
    if (!desiredCommandIds.has(row.command_id)) {
      deleteClaimsForCommand.run(row.command_id);
      deleteCommand.run(row.command_id);
    }
  }
  for (const receipt of normalized.receiptHistory) {
    insertReceipt.run(
      receipt.run_key,
      receipt.cursor,
      receipt.command_id,
      receipt.ordinal,
      receipt.status,
      receipt.canonical_receipt,
    );
  }
  for (const event of normalized.eventFrames) {
    insertEvent.run(
      event.event_id,
      event.run_key,
      event.cursor,
      event.command_id,
      event.event_type,
      event.canonical_frame,
    );
  }
  const desiredRunKeys = new Set(normalized.runs.map((row) => row.run_key as string));
  const deleteRun = database.prepare("DELETE FROM runs WHERE run_key = ?");
  for (const row of database.prepare<[], { run_key: string }>("SELECT run_key FROM runs").all()) {
    if (!desiredRunKeys.has(row.run_key)) deleteRun.run(row.run_key);
  }
  const desiredRepositoryIds = new Set(
    normalized.repositories.map((row) => row.repository_id as string),
  );
  const deleteRepository = database.prepare("DELETE FROM repositories WHERE repository_id = ?");
  for (const row of database
    .prepare<[], { repository_id: string }>("SELECT repository_id FROM repositories")
    .all()) {
    if (!desiredRepositoryIds.has(row.repository_id)) deleteRepository.run(row.repository_id);
  }
  const updateRepository = database.prepare(
    "UPDATE repositories SET active_run_key = ? WHERE repository_id = ?",
  );
  for (const repository of normalized.repositories) {
    updateRepository.run(repository.active_run_key, repository.repository_id);
  }
  const result = database
    .prepare(
      `UPDATE authority_state
       SET revision = revision + 1, canonical_json = ?
       WHERE singleton = 1 AND revision = ?`,
    )
    .run(serialized, expectedRevision);
  if (result.changes !== 1) throw new StaleAuthorityRevisionError(expectedRevision);
}

function persistCommandDelta(
  database: Database.Database,
  receipt: DurableReceipt,
  run: RuntimeAuthorityRun,
  serialized: string,
  expectedRevision: number,
  dependencies: RuntimeDependencies,
): void {
  const runKey = canonicalStringify([run.repositoryId, run.runId]);
  const command = run.commands.get(receipt.commandId);
  const receipts = run.receiptHistory.slice(-3);
  const events = run.events.slice(-3);
  if (
    command === undefined ||
    receipts.some((entry) => entry.commandId !== receipt.commandId) ||
    events.some((entry) => entry.commandId !== receipt.commandId) ||
    receipts.length !== 3 ||
    events.length !== 3
  ) {
    throw new TypeError("Incremental command persistence requires one complete lifecycle");
  }
  // A run's own records are state it writes for itself, not a message, so the
  // wire ceiling does not apply. A live run reached 262,077 of its 262,144 wire
  // bytes and the next retry could not be persisted at all.
  const recordsJson = run.records === undefined ? null : durableStringify(run.records);
  database
    .prepare(
      "INSERT INTO repositories(repository_id, active_run_key) VALUES (?, NULL) ON CONFLICT(repository_id) DO NOTHING",
    )
    .run(run.repositoryId);
  database
    .prepare(
      `INSERT INTO runs(
         run_key, repository_id, run_id, cursor, records_json, projection_generated_at,
         revision_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key) DO UPDATE SET
         cursor = excluded.cursor,
         records_json = excluded.records_json,
         projection_generated_at = excluded.projection_generated_at,
         revision_digest = excluded.revision_digest`,
    )
    .run(
      runKey,
      run.repositoryId,
      run.runId,
      run.cursor,
      recordsJson,
      run.projectionGeneratedAt ?? null,
      run.records === undefined
        ? null
        : canonicalDigest(canonicalValue(run.records), dependencies.sha256),
    );
  if (run.records !== undefined) {
    database
      .prepare("UPDATE repositories SET active_run_key = ? WHERE repository_id = ?")
      .run(runKey, run.repositoryId);
  }
  database
    .prepare(
      `INSERT INTO commands(
         command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.commandId,
      runKey,
      command.canonicalEnvelope,
      canonicalStringify(command.admission),
      canonicalStringify(command.receipt),
    );
  const insertReceipt = database.prepare(
    `INSERT INTO receipt_history(
       run_key, cursor, command_id, ordinal, status, canonical_receipt
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [index, lifecycleReceipt] of receipts.entries()) {
    insertReceipt.run(
      runKey,
      lifecycleReceipt.cursor,
      receipt.commandId,
      index + 1,
      lifecycleReceipt.status,
      canonicalStringify(lifecycleReceipt),
    );
  }
  const insertEvent = database.prepare(
    `INSERT INTO event_frames(
       event_id, run_key, cursor, command_id, event_type, canonical_frame
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    insertEvent.run(
      event.eventId,
      runKey,
      event.cursor,
      receipt.commandId,
      event.eventType,
      canonicalStringify(event),
    );
  }
  const result = database
    .prepare(
      `UPDATE authority_state
       SET revision = revision + 1, canonical_json = ?
       WHERE singleton = 1 AND revision = ?`,
    )
    .run(serialized, expectedRevision);
  if (result.changes !== 1) throw new StaleAuthorityRevisionError(expectedRevision);
}

function runtimeAuthorityRunKey(repositoryId: string, runId: string): string {
  return `${repositoryId}\u0000${runId}`;
}

function validateBoundedPageRequest(afterCursor: number, limit: number): void {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
    throw new TypeError("Page cursors must be non-negative safe integers");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PROTOCOL_LIMITS.maxPageItems) {
    throw new TypeError(`Page limits must be integers from 1 to ${PROTOCOL_LIMITS.maxPageItems}`);
  }
}

function validatePageCursor(afterCursor: number, latestCursor: number): void {
  if (afterCursor > latestCursor) {
    throw new PageQueryError("cursor-ahead", "Page cursor exceeds the latest authority cursor");
  }
}

function validateReplayCursor(afterCursor: number, earliestAvailableCursor: number): void {
  if (earliestAvailableCursor > 0 && afterCursor < earliestAvailableCursor - 1) {
    throw new PageQueryError(
      "event-replay-gap",
      "Event cursor precedes the available replay range",
    );
  }
}

class IncrementalCanonicalSnapshot {
  readonly #version: string;
  readonly #runs: Map<string, CanonicalRunFragments>;
  readonly #commandIds: Set<string>;
  #serialized: string;

  private constructor(snapshot: AuthoritySnapshot, serialized: string) {
    this.#version = snapshot.version;
    this.#runs = new Map(
      snapshot.runs.map((run) => [
        runtimeAuthorityRunKey(run.repositoryId, run.runId),
        {
          repositoryId: run.repositoryId,
          runId: run.runId,
          cursor: run.cursor,
          commands: new Map(
            run.commands.map((command) => [command.commandId, canonicalStringify(command)]),
          ),
          receiptHistory: run.receiptHistory.map((receipt) => canonicalStringify(receipt)),
          events: run.events.map((event) => canonicalStringify(event)),
          ...(run.records === undefined ? {} : { records: durableStringify(run.records) }),
          ...(run.projectionGeneratedAt === undefined
            ? {}
            : { projectionGeneratedAt: run.projectionGeneratedAt }),
        },
      ]),
    );
    this.#commandIds = new Set(
      snapshot.runs.flatMap((run) => run.commands.map((command) => command.commandId)),
    );
    this.#serialized = serialized;
  }

  static fromCanonicalJson(serialized: string): IncrementalCanonicalSnapshot {
    return new IncrementalCanonicalSnapshot(parseSnapshot(serialized), serialized);
  }

  hasCommand(commandId: string): boolean {
    return this.#commandIds.has(commandId);
  }

  appendCommand(run: RuntimeAuthorityRun, commandId: string): string {
    const command = run.commands.get(commandId);
    const receipts = run.receiptHistory.slice(-3);
    const events = run.events.slice(-3);
    if (
      command === undefined ||
      receipts.length !== 3 ||
      events.length !== 3 ||
      receipts.some((entry) => entry.commandId !== commandId) ||
      events.some((entry) => entry.commandId !== commandId)
    ) {
      throw new TypeError("Incremental canonical persistence requires one complete lifecycle");
    }
    const key = runtimeAuthorityRunKey(run.repositoryId, run.runId);
    let fragments = this.#runs.get(key);
    if (fragments === undefined) {
      fragments = {
        repositoryId: run.repositoryId,
        runId: run.runId,
        cursor: 0,
        commands: new Map(),
        receiptHistory: [],
        events: [],
      };
      this.#runs.set(key, fragments);
    }
    fragments.commands.set(commandId, canonicalStringify({ commandId, ...command }));
    fragments.receiptHistory.push(...receipts.map((receipt) => canonicalStringify(receipt)));
    fragments.events.push(...events.map((event) => canonicalStringify(event)));
    fragments.cursor = run.cursor;
    if (run.records === undefined) delete fragments.records;
    else fragments.records = durableStringify(run.records);
    if (run.projectionGeneratedAt === undefined) delete fragments.projectionGeneratedAt;
    else fragments.projectionGeneratedAt = run.projectionGeneratedAt;
    this.#commandIds.add(commandId);
    this.#serialized = this.#serialize();
    return this.#serialized;
  }

  #serialize(): string {
    const runs = [...this.#runs.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, run]) => serializeCanonicalRun(run));
    return `{"runs":[${runs.join(",")}],"version":${JSON.stringify(this.#version)}}`;
  }
}

function serializeCanonicalRun(run: CanonicalRunFragments): string {
  const commands = [...run.commands.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, command]) => command);
  return `{"commands":[${commands.join(",")}],"cursor":${run.cursor},"events":[${run.events.join(",")}]${
    run.projectionGeneratedAt === undefined
      ? ""
      : `,"projectionGeneratedAt":${JSON.stringify(run.projectionGeneratedAt)}`
  },"receiptHistory":[${run.receiptHistory.join(",")}]${
    run.records === undefined ? "" : `,"records":${run.records}`
  },"repositoryId":${JSON.stringify(run.repositoryId)},"runId":${JSON.stringify(run.runId)}}`;
}

function parseSnapshot(serialized: string): AuthoritySnapshot {
  return JSON.parse(serialized) as AuthoritySnapshot;
}

function verifyNormalizedSnapshot(
  database: Database.Database,
  snapshot: AuthoritySnapshot,
  dependencies: RuntimeDependencies,
): void {
  const expected = normalizeSnapshot(snapshot, dependencies);
  const actual: NormalizedSnapshot = {
    repositories: database
      .prepare("SELECT repository_id, active_run_key FROM repositories ORDER BY repository_id")
      .all() as Record<string, unknown>[],
    runs: database
      .prepare(
        `SELECT run_key, repository_id, run_id, cursor, records_json,
                projection_generated_at, revision_digest
         FROM runs ORDER BY run_key`,
      )
      .all() as Record<string, unknown>[],
    commands: database
      .prepare(
        `SELECT command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
         FROM commands ORDER BY command_id`,
      )
      .all() as Record<string, unknown>[],
    receiptHistory: database
      .prepare(
        `SELECT run_key, cursor, command_id, ordinal, status, canonical_receipt
         FROM receipt_history ORDER BY run_key, cursor`,
      )
      .all() as Record<string, unknown>[],
    eventFrames: database
      .prepare(
        `SELECT event_id, run_key, cursor, command_id, event_type, canonical_frame
         FROM event_frames ORDER BY run_key, cursor`,
      )
      .all() as Record<string, unknown>[],
  };
  if (canonicalSerialize(canonicalValue(actual)) !== canonicalSerialize(canonicalValue(expected))) {
    throw new Error("SQLite normalized authority tables diverge from canonical snapshot");
  }
}

function normalizeSnapshot(
  snapshot: AuthoritySnapshot,
  dependencies: RuntimeDependencies,
): NormalizedSnapshot {
  const repositories = new Map<string, string | null>();
  const runs: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const receiptHistory: Record<string, unknown>[] = [];
  const eventFrames: Record<string, unknown>[] = [];
  for (const run of snapshot.runs) {
    const runKey = canonicalStringify([run.repositoryId, run.runId]);
    const activeRunKey = repositories.get(run.repositoryId);
    if (run.records !== undefined) {
      if (activeRunKey !== undefined && activeRunKey !== null) {
        throw new TypeError(`Repository ${run.repositoryId} has multiple active runs`);
      }
      repositories.set(run.repositoryId, runKey);
    } else if (activeRunKey === undefined) {
      repositories.set(run.repositoryId, null);
    }
    const recordsJson = run.records === undefined ? null : durableStringify(run.records);
    runs.push({
      run_key: runKey,
      repository_id: run.repositoryId,
      run_id: run.runId,
      cursor: run.cursor,
      records_json: recordsJson,
      projection_generated_at: run.projectionGeneratedAt ?? null,
      revision_digest:
        run.records === undefined
          ? null
          : canonicalDigest(canonicalValue(run.records), dependencies.sha256),
    });
    for (const command of run.commands) {
      commands.push({
        command_id: command.commandId,
        run_key: runKey,
        canonical_envelope: command.canonicalEnvelope,
        admission_json: canonicalStringify(command.admission),
        terminal_receipt_json: canonicalStringify(command.receipt),
      });
    }
    const ordinals = new Map<string, number>();
    for (const receipt of run.receiptHistory) {
      const ordinal = (ordinals.get(receipt.commandId) ?? 0) + 1;
      ordinals.set(receipt.commandId, ordinal);
      receiptHistory.push({
        run_key: runKey,
        cursor: receipt.cursor,
        command_id: receipt.commandId,
        ordinal,
        status: receipt.status,
        canonical_receipt: canonicalStringify(receipt),
      });
    }
    for (const event of run.events) {
      if (event.commandId === undefined) {
        throw new TypeError("Persisted command event must identify its command");
      }
      eventFrames.push({
        event_id: event.eventId,
        run_key: runKey,
        cursor: event.cursor,
        command_id: event.commandId,
        event_type: event.eventType,
        canonical_frame: canonicalStringify(event),
      });
    }
  }
  return {
    repositories: [...repositories.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([repositoryId, activeRunKey]) => ({
        repository_id: repositoryId,
        active_run_key: activeRunKey,
      })),
    runs: runs.sort(compareNormalized("run_key")),
    commands: commands.sort(compareNormalized("command_id")),
    receiptHistory: receiptHistory.sort(compareNormalized("run_key", "cursor")),
    eventFrames: eventFrames.sort(compareNormalized("run_key", "cursor")),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNormalized(
  primary: string,
  secondary?: string,
): (left: Record<string, unknown>, right: Record<string, unknown>) => number {
  return (left, right) => {
    const primaryOrder = compareText(String(left[primary]), String(right[primary]));
    if (primaryOrder !== 0 || secondary === undefined) return primaryOrder;
    const leftSecondary = left[secondary];
    const rightSecondary = right[secondary];
    if (typeof leftSecondary === "number" && typeof rightSecondary === "number") {
      return leftSecondary - rightSecondary;
    }
    return compareText(String(leftSecondary), String(rightSecondary));
  };
}

function toAssetDescriptor(row: AssetRow): AssetDescriptor {
  return {
    digest: row.digest,
    byteLength: row.byte_length,
    relativePath: row.relative_path,
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
  };
}

function assertSameDescriptor(row: AssetRow, descriptor: AssetDescriptor): void {
  if (
    row.byte_length !== descriptor.byteLength ||
    row.relative_path !== descriptor.relativePath ||
    row.media_type !== (descriptor.mediaType ?? null)
  ) {
    throw new Error(`Asset digest ${descriptor.digest} is bound to a different descriptor`);
  }
}

function verifyAssetBytes(
  path: string,
  descriptor: AssetDescriptor,
  dependencies: RuntimeDependencies,
): Buffer {
  let bytes: Buffer;
  let file: number | undefined;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== descriptor.byteLength) {
      throw new Error("size mismatch");
    }
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error(`Committed asset ${descriptor.digest} is missing or unreadable`, {
      cause: error,
    });
  } finally {
    if (file !== undefined) closeSync(file);
  }
  if (dependencies.sha256.digest(bytes) !== descriptor.digest) {
    throw new Error(`Committed asset ${descriptor.digest} failed digest verification`);
  }
  return bytes;
}

function resolveAssetPath(assetDirectory: string, relativePath: string): string {
  const root = resolve(assetDirectory);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new TypeError("Asset descriptor path must remain inside the asset directory");
  }
  assertExistingPathComponentsAreDirectories(dirname(path), root);
  return path;
}

function copyAssetSet(
  assets: readonly AssetDescriptor[],
  sourceRoot: string,
  destinationRoot: string,
  dependencies: RuntimeDependencies,
): void {
  ensureSafeDirectoryPath(destinationRoot);
  for (const descriptor of assets) {
    const source = resolveAssetPath(sourceRoot, descriptor.relativePath);
    verifyAssetBytes(source, descriptor, dependencies);
    const destination = resolveAssetPath(destinationRoot, descriptor.relativePath);
    ensureSafeDirectoryPath(dirname(destination), destinationRoot);
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    verifyAssetBytes(destination, descriptor, dependencies);
    fsyncFile(destination);
    fsyncDirectory(dirname(destination));
  }
  fsyncDirectory(destinationRoot);
}

function publishBackupBundleNoReplace(partial: string, destination: string): void {
  let destinationCreated = false;
  try {
    mkdirSync(destination, { mode: 0o700 });
    destinationCreated = true;
    fsyncDirectory(destination);
    fsyncDirectory(dirname(destination));
    renameSync(join(partial, "authority.db"), join(destination, "authority.db"));
    renameSync(join(partial, "assets"), join(destination, "assets"));
    fsyncDirectory(destination);
    renameSync(join(partial, "manifest.json"), join(destination, "manifest.json"));
    fsyncDirectory(destination);
    rmSync(partial, { recursive: true });
    fsyncDirectory(dirname(partial));
  } catch (error) {
    if (destinationCreated) {
      rmSync(destination, { recursive: true, force: true });
      fsyncDirectory(dirname(destination));
    }
    if (isNodeError(error, "EEXIST")) {
      throw new Error("SQLite backup destination already exists", { cause: error });
    }
    throw error;
  }
}

function publishAssetDirectoryNoReplace(
  partial: string,
  destination: string,
  ownedPartial: OwnedRestorePath,
): OwnedRestorePath {
  let ownedDestination: OwnedRestorePath | undefined;
  try {
    mkdirSync(destination, { mode: 0o700 });
    ownedDestination = captureOwnedRestorePath(destination, "directory");
    fsyncDirectory(destination);
    fsyncDirectory(dirname(destination));
    for (const entry of readdirSync(partial)) {
      renameSync(join(partial, entry), join(destination, entry));
    }
    fsyncDirectory(destination);
    if (removeOwnedRestorePath(ownedPartial)) fsyncDirectory(dirname(partial));
    return ownedDestination;
  } catch (error) {
    if (removeOwnedRestorePath(ownedDestination)) {
      fsyncDirectory(dirname(destination));
    }
    if (isNodeError(error, "EEXIST")) {
      throw new Error("SQLite restore asset destination already exists", { cause: error });
    }
    throw error;
  }
}

function captureOwnedRestorePath(
  path: string,
  expectedKind: OwnedRestorePath["kind"],
): OwnedRestorePath {
  const status = lstatSync(path);
  const kind = status.isFile() ? "file" : status.isDirectory() ? "directory" : undefined;
  if (kind !== expectedKind) throw new Error("SQLite restore created an unexpected path type");
  return { device: status.dev, inode: status.ino, kind, path };
}

function removeOwnedRestorePath(owned: OwnedRestorePath | undefined): boolean {
  if (owned === undefined) return false;
  let status: Stats;
  try {
    status = lstatSync(owned.path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  if (
    status.dev !== owned.device ||
    status.ino !== owned.inode ||
    (owned.kind === "file" ? !status.isFile() : !status.isDirectory())
  ) {
    return false;
  }
  rmSync(owned.path, { recursive: owned.kind === "directory", force: true });
  return true;
}

function verifyBackupBundle(
  backupPath: string,
  dependencies: RuntimeDependencies,
): {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly manifest: BackupManifest;
} {
  const root = resolve(backupPath);
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("SQLite backup must be a real directory");
  }
  ensureSafeDirectoryPath(root);
  const databasePath = join(root, "authority.db");
  const assetDirectory = join(root, "assets");
  const assetMetadata = lstatSync(assetDirectory);
  if (assetMetadata.isSymbolicLink() || !assetMetadata.isDirectory()) {
    throw new Error("SQLite backup assets must be a real directory");
  }
  ensureSafeDirectoryPath(assetDirectory, root);
  const manifest = parseBackupManifest(
    readRegularFile(join(root, "manifest.json")).toString("utf8"),
  );
  verifyDatabaseArtifact(databasePath, manifest, dependencies);
  const database = openReadConnection(databasePath);
  try {
    verifyDatabase(database, dependencies, assetDirectory, true);
    if (
      canonicalStringify(readAssetDescriptors(database)) !== canonicalStringify(manifest.assets)
    ) {
      throw new Error("SQLite backup asset manifest does not match its database");
    }
  } finally {
    database.close();
  }
  return { databasePath, assetDirectory, manifest };
}

function verifyDatabaseArtifact(
  databasePath: string,
  manifest: BackupManifest,
  dependencies: RuntimeDependencies,
): void {
  const databaseBytes = readRegularFile(databasePath);
  if (
    databaseBytes.byteLength !== manifest.database.byteLength ||
    dependencies.sha256.digest(databaseBytes) !== manifest.database.digest
  ) {
    throw new Error("SQLite backup database does not match its manifest");
  }
}

function parseBackupManifest(serialized: string): BackupManifest {
  const value = JSON.parse(serialized) as Partial<BackupManifest>;
  if (
    value.format !== "senawa-sqlite-backup" ||
    value.version !== 1 ||
    value.database?.relativePath !== "authority.db" ||
    !Number.isSafeInteger(value.database.byteLength) ||
    (value.database.byteLength ?? -1) < 0 ||
    !isSha256Digest(value.database.digest ?? "") ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("SQLite backup manifest is invalid");
  }
  for (const descriptor of value.assets) {
    if (
      typeof descriptor !== "object" ||
      descriptor === null ||
      !isSha256Digest(descriptor.digest) ||
      !Number.isSafeInteger(descriptor.byteLength) ||
      descriptor.byteLength < 0 ||
      descriptor.relativePath !==
        join("sha256", descriptor.digest.slice(0, 2), descriptor.digest) ||
      (descriptor.mediaType !== undefined && typeof descriptor.mediaType !== "string")
    ) {
      throw new Error("SQLite backup manifest is invalid");
    }
  }
  return value as BackupManifest;
}

function assertSafeBackupDestination(
  destination: string,
  databasePath: string,
  assetDirectory: string,
): void {
  assertPathMissing(destination, "SQLite backup destination already exists");
  const plannedDestination = plannedRealPath(destination);
  for (const activePath of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    assetDirectory,
  ]) {
    const canonicalActivePath = pathEntryExists(activePath)
      ? realpathSync(activePath)
      : plannedRealPath(activePath);
    if (pathsOverlap(plannedDestination, canonicalActivePath)) {
      throw new Error("SQLite backup destination overlaps active authority storage");
    }
  }
}

function assertFreshRestoreDestinations(
  databasePath: string,
  assetDirectory: string,
  backupPath: string,
): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, assetDirectory]) {
    assertPathMissing(
      path,
      "SQLite restore destination database and assets must not already exist",
    );
  }
  const realBackup = realpathSync(backupPath);
  const realDatabase = plannedRealPath(databasePath);
  const realAssets = plannedRealPath(assetDirectory);
  if (pathsOverlap(realBackup, realDatabase) || pathsOverlap(realBackup, realAssets)) {
    throw new Error("SQLite restore destination must not overlap its backup bundle");
  }
  if (pathsOverlap(realDatabase, realAssets)) {
    throw new Error("SQLite restore database and asset destinations must not overlap");
  }
}

function plannedRealPath(path: string): string {
  ensureSafeDirectoryPath(dirname(path));
  return join(realpathSync(dirname(path)), basename(path));
}

function pathsOverlap(first: string, second: string): boolean {
  const fromFirst = relative(first, second);
  const fromSecond = relative(second, first);
  return (
    fromFirst === "" ||
    (fromFirst !== ".." && !fromFirst.startsWith(`..${sep}`)) ||
    (fromSecond !== ".." && !fromSecond.startsWith(`..${sep}`))
  );
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function assertPathMissing(path: string, message: string): void {
  if (pathEntryExists(path)) throw new Error(message);
}

function readRegularFile(path: string): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`Filesystem path is not an independent regular file: ${path}`);
    }
    return readFileSync(file);
  } finally {
    closeSync(file);
  }
}

function writeExclusiveFile(path: string, contents: string): void {
  const file = openSync(path, "wx", 0o600);
  try {
    writeFileSync(file, contents);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  fsyncDirectory(dirname(path));
}

function mkdirDurably(path: string): void {
  assertPathMissing(path, `Filesystem destination already exists: ${path}`);
  ensureSafeDirectoryPath(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  fsyncDirectory(path);
  fsyncDirectory(dirname(path));
}

function assertExistingPathComponentsAreDirectories(path: string, containmentRoot: string): void {
  const root = resolve(containmentRoot);
  const absolute = resolve(path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error("Filesystem path escapes its containment root");
  }
  let current = root;
  const rootMetadata = lstatSync(current);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Filesystem path component is not a real directory: ${current}`);
  }
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Filesystem path component is not a real directory: ${current}`);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
  if (pathEntryExists(absolute)) {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(absolute);
    const realRelative = relative(realRoot, realPath);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`)) {
      throw new Error("Filesystem path escapes its real containment root");
    }
  }
}

function ensureSafeDirectoryPath(path: string, containmentRoot?: string): void {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const parent = current;
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Filesystem path component is not a real directory: ${current}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
        const metadata = lstatSync(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Filesystem path component is not a real directory: ${current}`);
        }
      }
      fsyncDirectory(current);
      fsyncDirectory(parent);
    }
  }
  if (containmentRoot !== undefined) {
    const realRoot = realpathSync(resolve(containmentRoot));
    const realDirectory = realpathSync(absolute);
    const fromRoot = relative(realRoot, realDirectory);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error("Asset directory path escapes its real asset root");
    }
  }
}

function fsyncFile(path: string): void {
  const file = openSync(path, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function fsyncDirectory(path: string): void {
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function validateTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a UTC RFC 3339 timestamp`);
  }
}

function validateStorageIdentifier(value: string, field: string): void {
  try {
    validateOpaqueIdentity(value);
  } catch (error) {
    throw new TypeError(`${field} must be a non-empty bounded identity`, { cause: error });
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isSqliteLockError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))
  );
}

/** Presents a phase output in the shape the artifact listing reads. */
function phaseOutputAsAsset(
  output: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const contentDigest = String(output.contentDigest);
  return {
    assetId: `asset_${contentDigest}`,
    byteLength: output.byteLength ?? 0,
    contentDigest,
    mediaType: output.mediaType ?? "application/json",
    summary: `phase output ${String(output.outputName)}`,
  };
}

/** Reads the refusal list a dispatch carried, tolerating an absent or odd one. */
function readRefusals(value: string | null): readonly string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Widens task scopes to every sibling working under the same phase.
 *
 * The phase a task belongs to is recorded on the context it was dispatched
 * with, which is the only place the relationship survives an amendment.
 */
function withMemberScopes(
  database: Database.Database,
  runIdValue: string,
  scopes: readonly { readonly taskId: string; readonly definitionGeneration: number }[],
): readonly { readonly taskId: string; readonly definitionGeneration: number }[] {
  const widened = new Map(
    scopes.map((scope) => [`${scope.taskId}\u0001${scope.definitionGeneration}`, scope]),
  );
  const siblings = database.prepare<
    [string, string, string],
    { task_id: string; definition_generation: number }
  >(
    `SELECT DISTINCT
       json_extract(b.canonical_context, '$.task.taskId') AS task_id,
       json_extract(b.canonical_context, '$.task.definitionGeneration') AS definition_generation
     FROM context_dispatches d
     JOIN context_bases b ON b.context_id = d.context_id
     WHERE d.run_id = ?
       AND json_extract(b.canonical_context, '$.phaseAttempt.phase.phaseId') IN (
         SELECT json_extract(b2.canonical_context, '$.phaseAttempt.phase.phaseId')
         FROM context_dispatches d2
         JOIN context_bases b2 ON b2.context_id = d2.context_id
         WHERE d2.run_id = ? AND json_extract(b2.canonical_context, '$.task.taskId') = ?
       )`,
  );
  for (const scope of scopes) {
    for (const row of siblings.all(runIdValue, runIdValue, scope.taskId)) {
      if (row.task_id === null || row.definition_generation === null) continue;
      const key = `${row.task_id}\u0001${row.definition_generation}`;
      if (widened.has(key)) continue;
      widened.set(key, {
        taskId: row.task_id,
        definitionGeneration: row.definition_generation,
      });
    }
  }
  return [...widened.values()];
}
