import {
  assessCompletionAccounting,
  bindGitRevision,
  type CompletionRequirements,
  type CompletionSubmission,
  type HistoricalAssetBinding,
  isSha256Digest,
  reassessCompletionAccounting,
  type Sha256,
  type TaskGenerationReference,
  validateCompletionRequirements,
  validateWorkerContextBase,
  validateWorkerDispatch,
  type WorkerContextBase,
  type WorkerDispatch,
} from "@senawa/kernel";
import {
  type AssetReadAuditReceipt,
  type AssetReadDenialCode,
  type AssetReadRequest,
  type ContextGrantEnvelope,
  canonicalBytes,
  canonicalStringify,
  decodeAssetReadAuditReceipt,
  decodeAssetReadRequest,
  decodeCanonicalJsonValue,
  decodeContextGrantEnvelope,
  decodePersistedContextGrantEnvelope,
  decodeWorkerSubmission,
  type JsonValue,
  PROTOCOL_VERSION,
  type WorkerSubmission,
} from "@senawa/protocol";
import { DEFAULT_PROMPT_PACK_MAX_BYTES, renderPromptPack } from "./prompt-renderer.js";
import {
  type InstallTaskScopeFencesInput,
  type TaskScope,
  type TaskScopeCurrentness,
  type TaskScopeFence,
  taskScopeKey,
} from "./task-currentness.js";

export const WORKER_CAPABILITIES = Object.freeze({
  assetRead: "asset.read",
  completion: "worker.submit.completion",
  question: "worker.submit.question",
  asset: "worker.submit.asset",
  discovery: "worker.submit.discovery",
  amendmentProposal: "worker.submit.amendment-proposal",
  phaseOutput: "worker.submit.phase-output",
});

export interface InstalledCanonicalOutputAsset {
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly mediaType: "application/json";
  readonly schemaResourceDigest: string;
  readonly validationReceiptDigest: string;
}

export interface ContextAssetPort {
  installCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset, bytes: Uint8Array): void;
  hasCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset): boolean;
  readAssetRange(
    binding: HistoricalAssetBinding,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  readJsonAsset(
    binding: HistoricalAssetBinding,
    maxAssetBytes: number,
  ): Promise<Uint8Array | undefined> | Uint8Array | undefined;
}

export const DEFAULT_POINTER_ASSET_MAX_BYTES = 1_048_576;

export function assetReadWorstCaseBytes(
  request:
    | { readonly type: "chunk"; readonly length: number }
    | { readonly type: "pointer"; readonly maxBytes: number },
): number {
  return request.type === "chunk" ? request.length : request.maxBytes;
}

export interface CompletionFact {
  readonly submissionId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly assessment: ReturnType<typeof assessCompletionAccounting>;
}

export interface CompletionFactPort {
  /** Must be idempotent for an exact submissionId and reject conflicting content. */
  admitCompletionFact(fact: CompletionFact): CompletionFactAdmission;
}

export type CompletionFactAdmission = "accepted" | "deferred";

export interface PhaseOutputFact {
  readonly submissionId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly contextId: string;
  readonly contextDigest: string;
  readonly producingTask: TaskGenerationReference;
  readonly output: Extract<WorkerSubmission, { readonly type: "phase-output" }>["output"];
}

export interface PhaseOutputFactPort {
  /** Must be idempotent for an exact submissionId and reject conflicting content. */
  admitPhaseOutputFact(fact: PhaseOutputFact): CompletionFactAdmission;
}

export type AgentTranscriptOwnerKind = "dispatch" | "task" | "phase";

export interface AgentTranscriptOwner {
  readonly kind: AgentTranscriptOwnerKind;
  readonly id: string;
}

export interface AgentTranscriptLine {
  readonly repositoryId: string;
  readonly runId: string;
  readonly owner: AgentTranscriptOwner;
  /** Owner-scoped capture identity that makes an exact replay recognisable. */
  readonly lineId: string;
  readonly occurredAt: string;
  readonly stream: "stdout" | "stderr" | "system";
  readonly text: string;
}

export type AgentTranscriptRefusalCode = "unknown-run" | "invalid-scope" | "line-conflict";

export class AgentTranscriptRefusalError extends Error {
  readonly code: AgentTranscriptRefusalCode;

  constructor(code: AgentTranscriptRefusalCode, message: string) {
    super(message);
    this.name = "AgentTranscriptRefusalError";
    this.code = code;
  }
}

export interface AgentTranscriptPort {
  /**
   * Assigns the next owner-scoped sequence. An exact replay of any retained
   * record is idempotent, and a record that reuses a retained `lineId` with
   * different content is refused with `AgentTranscriptRefusalError`.
   */
  append(record: AgentTranscriptLine): void;
}

export const PHASE_OUTPUT_LIMITS = Object.freeze({
  maxOutputBytes: 262_144,
  maxOutputNodes: 10_000,
  maxOutputDepth: 64,
  maxChangeNotes: 16,
  maxChangeNoteLength: 512,
  maxReportedFindings: 8,
  maxAttempts: 3,
});

export interface PhaseOutputAttemptInput {
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly outcome: "rejected" | "accepted";
  readonly outputName: string;
  readonly toolCallId: string;
  readonly findingsDigest?: string;
  readonly submissionId?: string;
}

export interface PhaseOutputAttemptResult {
  readonly attemptId: string;
  readonly outcome: PhaseOutputAttemptInput["outcome"];
  readonly recordedAttempts: number;
  readonly replayed: boolean;
  readonly exhausted: boolean;
}

export interface PhaseOutputAttemptRecord extends PhaseOutputAttemptInput {}

export function phaseOutputAttemptKey(dispatchId: string, attemptId: string): string {
  return `${dispatchId}\0${attemptId}`;
}

function canonicalAttempt(input: PhaseOutputAttemptInput): string {
  return canonicalStringify({
    dispatchId: input.dispatchId,
    attemptId: input.attemptId,
    outcome: input.outcome,
    outputName: input.outputName,
    toolCallId: input.toolCallId,
    ...(input.findingsDigest === undefined ? {} : { findingsDigest: input.findingsDigest }),
    ...(input.submissionId === undefined ? {} : { submissionId: input.submissionId }),
  });
}

/** Shared rejected-attempt accounting for in-memory and durable phase output ledgers. */
export function evaluatePhaseOutputAttempt(
  existing: readonly PhaseOutputAttemptRecord[],
  input: PhaseOutputAttemptInput,
  maxAttempts: number = PHASE_OUTPUT_LIMITS.maxAttempts,
): { readonly result: PhaseOutputAttemptResult; readonly insert: boolean } {
  const prior = existing.find(
    (record) => record.dispatchId === input.dispatchId && record.attemptId === input.attemptId,
  );
  if (prior !== undefined) {
    if (canonicalAttempt(prior) !== canonicalAttempt(input)) {
      throw new ContextBrokerError(
        "submission-conflict",
        "Phase output attempt identity was reused with different content",
      );
    }
    const rejected = countRejected(existing, input);
    return {
      insert: false,
      result: Object.freeze({
        attemptId: input.attemptId,
        outcome: input.outcome,
        recordedAttempts: rejected,
        replayed: true,
        exhausted: rejected >= maxAttempts,
      }),
    };
  }
  const rejected = countRejected([...existing, input], input);
  return {
    insert: true,
    result: Object.freeze({
      attemptId: input.attemptId,
      outcome: input.outcome,
      recordedAttempts: rejected,
      replayed: false,
      exhausted: rejected >= maxAttempts,
    }),
  };
}

function countRejected(
  records: readonly PhaseOutputAttemptRecord[],
  input: PhaseOutputAttemptInput,
): number {
  return records.filter(
    (record) =>
      record.outcome === "rejected" &&
      record.dispatchId === input.dispatchId &&
      record.outputName === input.outputName,
  ).length;
}

function recordPhaseOutputAttemptInLedger(
  ledger: Map<string, PhaseOutputAttemptRecord>,
  input: PhaseOutputAttemptInput,
): PhaseOutputAttemptResult {
  const { result, insert } = evaluatePhaseOutputAttempt([...ledger.values()], input);
  if (insert) ledger.set(phaseOutputAttemptKey(input.dispatchId, input.attemptId), input);
  return result;
}

export interface ContextBrokerDependencies {
  readonly sha256: Sha256;
  currentTime(): string;
  issueGrantToken(): Uint8Array;
}

export interface ContextGrantInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly assetBindingId: string;
  readonly allowedPointer: string;
  readonly readMode: ContextGrantEnvelope["readMode"];
  readonly sensitivityCeiling: ContextGrantEnvelope["sensitivityCeiling"];
  readonly expiresAt: string;
  readonly maxOperations: number;
  readonly maxBytes: number;
  readonly maxChunkBytes: number;
}

export interface AssetReadInput {
  readonly request: string | unknown;
}

export type AssetReadResult =
  | {
      readonly status: "served";
      readonly receipt: AssetReadAuditReceipt;
      readonly bytes: Uint8Array;
    }
  | {
      readonly status: "denied";
      readonly receipt: AssetReadAuditReceipt;
    };

export interface RegisterWorkerDispatchInput {
  readonly context: unknown;
  readonly dispatch: unknown;
  readonly completionRequirements: unknown;
  readonly taskScope: TaskScopeFence;
  readonly effect?: RegisteredWorkerEffectSeed;
}

export interface RegisteredWorkerEffectSeed {
  readonly input: JsonValue;
  readonly budgetReservation: Readonly<{ unit: string; amount: number }>;
  readonly baseRevision?: import("@senawa/kernel").GitRevisionDescriptor;
  readonly integrationGatePolicyDigest?: string;
}

export interface SubmissionAdmissionInput {
  readonly submission: string | unknown;
}

export interface SubmissionAdmissionResult {
  readonly submissionId: string;
  readonly type: WorkerSubmission["type"];
  readonly status: "accepted" | "stale" | "duplicate";
  readonly replayed: boolean;
  readonly completionFact?: CompletionFact;
  readonly phaseOutputFact?: PhaseOutputFact;
}

export interface ContextBrokerClient {
  readonly dependencies: ContextBrokerDependencies;
  registerDispatch(input: RegisterWorkerDispatchInput): WorkerDispatch;
  loadWorkerDispatch(dispatchId: string): StoredDispatch | undefined;
  listWorkerDispatches?(repositoryId: string, runId: string): readonly StoredDispatch[];
  loadWorkerDispatchProgress(dispatchId: string): WorkerDispatchProgress | undefined;
  grantAssetAccess(input: ContextGrantInput): ContextGrantEnvelope;
  readAsset(input: AssetReadInput): Promise<AssetReadResult>;
  admitSubmission(input: SubmissionAdmissionInput): SubmissionAdmissionResult;
  deliverCompletionFact(submissionId: string): boolean;
  deliverPhaseOutputFact?(submissionId: string): boolean;
  installCanonicalOutputAsset?(asset: InstalledCanonicalOutputAsset, bytes: Uint8Array): void;
  recordPhaseOutputAttempt?(input: PhaseOutputAttemptInput): PhaseOutputAttemptResult;
  countRejectedPhaseOutputAttempts?(dispatchId: string, outputName: string): number;
}

export interface ContextBrokerEvent {
  readonly cursor: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly payload: JsonValue;
}

export interface ContextBrokerProjection {
  readonly cursor: number;
  readonly registeredContexts: number;
  readonly registeredDispatches: number;
  readonly grants: number;
  readonly servedReads: number;
  readonly deniedReads: number;
  readonly acceptedSubmissions: number;
  readonly staleSubmissions: number;
  readonly duplicateSubmissions: number;
  readonly questions: number;
}

export interface StoredDispatch {
  readonly context: WorkerContextBase;
  readonly dispatch: WorkerDispatch;
  readonly completionRequirements: CompletionRequirements;
  readonly taskScope: TaskScopeFence;
  readonly effect?: RegisteredWorkerEffectSeed;
}

export interface WorkerDispatchProgress {
  readonly dispatchId: string;
  readonly completionStatus: "pending" | "accepted";
  readonly submissions: readonly SubmissionAdmissionResult[];
  readonly sessionExpected: boolean;
}

export interface StoredGrant {
  readonly tokenDigest: string;
  readonly envelope: Omit<ContextGrantEnvelope, "grantToken">;
  operationsUsed: number;
  bytesUsed: number;
}

interface StoredRead {
  readonly canonicalReplayKey: string;
  readonly replayKeyDigest: string;
  readonly tokenDigest: string;
  readonly requestDigest: string;
  result: Promise<AssetReadResult> | AssetReadResult;
}

export interface DurableReceiptAttempt {
  readonly receiptCursor: number;
  readonly canonicalReplayKey: string;
  readonly replayKeyDigest: string;
  readonly tokenDigest: string;
  readonly requestDigest: string;
  readonly reserved: boolean;
  readonly failureStage?: ContextReadFailureStage;
  readonly failureFactDigest?: string;
  readonly receipt: AssetReadAuditReceipt;
}

export type ContextReadFailureStage = "asset-read" | "asset-integrity";

export interface StoredSubmission {
  readonly canonicalSubmission: string;
  readonly submission: WorkerSubmission;
  readonly result: SubmissionAdmissionResult;
}

interface StoredCompletionFact {
  readonly fact: CompletionFact;
  delivered: boolean;
  delivering: boolean;
}

interface StoredPhaseOutputFact {
  readonly fact: PhaseOutputFact;
  delivered: boolean;
  delivering: boolean;
}

export interface ContextAuthoritySnapshot {
  readonly version: "senawa.dev/context-authority-memory/v1";
  readonly contexts: readonly WorkerContextBase[];
  readonly taskScopes: readonly TaskScopeCurrentness[];
  readonly dispatches: readonly WorkerDispatch[];
  readonly grants: readonly {
    readonly tokenDigest: string;
    readonly envelope: Omit<ContextGrantEnvelope, "grantToken">;
    readonly operationsUsed: number;
    readonly bytesUsed: number;
  }[];
  readonly receipts: readonly AssetReadAuditReceipt[];
  readonly submissions: readonly {
    readonly submission: WorkerSubmission;
    readonly result: SubmissionAdmissionResult;
  }[];
  readonly terminalCompletions: readonly {
    readonly dispatchId: string;
    readonly submissionId: string;
  }[];
  readonly completionOutbox: readonly {
    readonly submissionId: string;
    readonly fact: CompletionFact;
    readonly delivered: boolean;
  }[];
  readonly phaseOutputOutbox: readonly {
    readonly submissionId: string;
    readonly fact: PhaseOutputFact;
    readonly delivered: boolean;
  }[];
  readonly questions: readonly WorkerSubmission[];
  readonly events: readonly ContextBrokerEvent[];
  readonly projection: ContextBrokerProjection;
}

export interface DurableRead {
  readonly requestId: string;
  readonly canonicalReplayKey: string;
  readonly replayKeyDigest: string;
  readonly tokenDigest: string;
  readonly requestDigest: string;
  readonly result: AssetReadResult extends infer _Result
    ? {
        readonly status: AssetReadResult["status"];
        readonly receipt: AssetReadAuditReceipt;
        readonly bytes?: readonly number[];
      }
    : never;
}

export interface DurableContextAuthoritySnapshot {
  readonly version: "senawa.dev/context-authority-durable/v1";
  readonly taskScopes: readonly TaskScopeCurrentness[];
  readonly dispatches: readonly StoredDispatch[];
  readonly grants: readonly StoredGrant[];
  readonly reads: readonly DurableRead[];
  readonly receipts: readonly AssetReadAuditReceipt[];
  readonly receiptAttempts: readonly DurableReceiptAttempt[];
  readonly submissions: readonly StoredSubmission[];
  readonly terminalCompletions: readonly (readonly [string, string])[];
  readonly completionOutbox: readonly {
    readonly submissionId: string;
    readonly fact: CompletionFact;
    readonly delivered: boolean;
  }[];
  readonly phaseOutputOutbox: readonly {
    readonly submissionId: string;
    readonly fact: PhaseOutputFact;
    readonly delivered: boolean;
  }[];
  readonly questions: readonly WorkerSubmission[];
  readonly events: readonly ContextBrokerEvent[];
  readonly cursor: number;
}

export class ContextBrokerError extends Error {
  readonly code:
    | "unknown-dispatch"
    | "unknown-context"
    | "unknown-asset-binding"
    | "invalid-grant"
    | "binding-mismatch"
    | "capability-denied"
    | "submission-conflict"
    | "secret-leak"
    | "invalid-submission";

  constructor(code: ContextBrokerError["code"], message: string) {
    super(message);
    this.name = "ContextBrokerError";
    this.code = code;
  }
}

export class ContextBrokerTransactionAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBrokerTransactionAbortError";
  }
}

export interface ContextAuthorityPort {
  readonly contexts: Map<string, WorkerContextBase>;
  readonly taskScopes: Map<string, TaskScopeCurrentness>;
  readonly dispatches: Map<string, StoredDispatch>;
  readonly grants: Map<string, StoredGrant>;
  readonly reads: Map<string, StoredRead>;
  readonly receipts: AssetReadAuditReceipt[];
  readonly receiptAttempts: DurableReceiptAttempt[];
  readonly submissions: Map<string, StoredSubmission>;
  readonly terminalCompletions: Map<string, string>;
  readonly completionOutbox: Map<string, StoredCompletionFact>;
  readonly phaseOutputOutbox: Map<string, StoredPhaseOutputFact>;
  readonly questions: WorkerSubmission[];
  readonly events: ContextBrokerEvent[];
  cursor: number;
  installTaskScopeFences(input: InstallTaskScopeFencesInput): readonly TaskScopeCurrentness[];
  snapshot(): ContextAuthoritySnapshot;
  toCanonicalJson(): string;
  projection(): ContextBrokerProjection;
}

export class InMemoryContextAuthority implements ContextAuthorityPort {
  readonly contexts = new Map<string, WorkerContextBase>();
  readonly taskScopes = new Map<string, TaskScopeCurrentness>();
  readonly dispatches = new Map<string, StoredDispatch>();
  readonly grants = new Map<string, StoredGrant>();
  readonly reads = new Map<string, StoredRead>();
  readonly receipts: AssetReadAuditReceipt[] = [];
  readonly receiptAttempts: DurableReceiptAttempt[] = [];
  readonly submissions = new Map<string, StoredSubmission>();
  readonly terminalCompletions = new Map<string, string>();
  readonly completionOutbox = new Map<string, StoredCompletionFact>();
  readonly phaseOutputOutbox = new Map<string, StoredPhaseOutputFact>();
  readonly questions: WorkerSubmission[] = [];
  readonly events: ContextBrokerEvent[] = [];
  cursor = 0;

  snapshot(): ContextAuthoritySnapshot {
    const contexts = [...this.contexts.values()].sort((left, right) =>
      compareText(left.contextId, right.contextId),
    );
    const dispatches = [...this.dispatches.values()]
      .map(({ dispatch }) => dispatch)
      .sort((left, right) => compareText(left.dispatchId, right.dispatchId));
    const grants = [...this.grants.values()]
      .map((grant) =>
        deepFreeze({
          tokenDigest: grant.tokenDigest,
          envelope: grant.envelope,
          operationsUsed: grant.operationsUsed,
          bytesUsed: grant.bytesUsed,
        }),
      )
      .sort((left, right) => compareText(left.tokenDigest, right.tokenDigest));
    const submissions = [...this.submissions.values()]
      .map(({ submission, result }) => deepFreeze({ submission, result }))
      .sort((left, right) =>
        compareText(left.submission.submissionId, right.submission.submissionId),
      );
    return deepFreeze({
      version: "senawa.dev/context-authority-memory/v1",
      contexts,
      taskScopes: [...this.taskScopes.values()].sort(compareTaskScope),
      dispatches,
      grants,
      receipts: [...this.receipts],
      submissions,
      terminalCompletions: [...this.terminalCompletions]
        .map(([dispatchId, submissionId]) => deepFreeze({ dispatchId, submissionId }))
        .sort((left, right) => compareText(left.dispatchId, right.dispatchId)),
      completionOutbox: [...this.completionOutbox]
        .map(([submissionId, pending]) =>
          deepFreeze({ submissionId, fact: pending.fact, delivered: pending.delivered }),
        )
        .sort((left, right) => compareText(left.submissionId, right.submissionId)),
      phaseOutputOutbox: [...this.phaseOutputOutbox]
        .map(([submissionId, pending]) =>
          deepFreeze({ submissionId, fact: pending.fact, delivered: pending.delivered }),
        )
        .sort((left, right) => compareText(left.submissionId, right.submissionId)),
      questions: [...this.questions],
      events: [...this.events],
      projection: this.projection(),
    });
  }

  installTaskScopeFences(input: InstallTaskScopeFencesInput): readonly TaskScopeCurrentness[] {
    validateTimestamp(input.installedAt, "installedAt");
    const installations = [...input.fences].sort((left, right) =>
      compareTaskScope(left.scope, right.scope),
    );
    const seen = new Set<string>();
    const current = installations.map((installation) => {
      if (installation.scope.runId !== input.runId)
        throw new TypeError("Context fence scope does not match the target run");
      const key = taskScopeKey(installation.scope);
      if (seen.has(key)) throw new TypeError("Context fence installations must be unique");
      seen.add(key);
      const scope = this.taskScopes.get(key);
      if (scope === undefined) throw new TypeError("Context fence names an unknown task scope");
      if (
        scope.fenceGeneration !== installation.expectedFenceGeneration ||
        scope.acceptedContextDigest !== installation.expectedAcceptedContextDigest
      )
        throw new TypeError("Context fence expectation is stale");
      if (!scope.claimsAccepted) throw new TypeError("Context task scope is already fenced");
      return scope;
    });
    const installed = current.map((scope) => {
      const next = deepFreeze({
        ...scope,
        fenceGeneration: scope.fenceGeneration + 1,
        claimsAccepted: false,
      });
      this.taskScopes.set(taskScopeKey(scope), next);
      return next;
    });
    return Object.freeze(installed);
  }

  toCanonicalJson(): string {
    return canonicalStringify(this.snapshot());
  }

  projection(): ContextBrokerProjection {
    return Object.freeze({
      cursor: this.cursor,
      registeredContexts: this.contexts.size,
      registeredDispatches: this.dispatches.size,
      grants: this.grants.size,
      servedReads: this.receipts.filter(({ status }) => status === "served").length,
      deniedReads: this.receipts.filter(({ status }) => status === "denied").length,
      acceptedSubmissions: [...this.submissions.values()].filter(
        ({ result }) => result.status === "accepted",
      ).length,
      staleSubmissions: [...this.submissions.values()].filter(
        ({ result }) => result.status === "stale",
      ).length,
      duplicateSubmissions: [...this.submissions.values()].filter(
        ({ result }) => result.status === "duplicate",
      ).length,
      questions: this.questions.length,
    });
  }

  toDurableCanonicalJson(): string {
    return canonicalStringify(this.durableSnapshot());
  }

  durableSnapshot(): DurableContextAuthoritySnapshot {
    return deepFreeze({
      version: "senawa.dev/context-authority-durable/v1",
      taskScopes: [...this.taskScopes.values()].sort(compareTaskScope),
      dispatches: [...this.dispatches.values()],
      grants: [...this.grants.values()].map((grant) => ({ ...grant })),
      reads: [...this.reads].map(([requestId, read]) => {
        if (read.result instanceof Promise)
          throw new Error("Cannot serialize an in-flight context asset read");
        return {
          requestId,
          canonicalReplayKey: read.canonicalReplayKey,
          replayKeyDigest: read.replayKeyDigest,
          tokenDigest: read.tokenDigest,
          requestDigest: read.requestDigest,
          result:
            read.result.status === "served"
              ? {
                  status: "served",
                  receipt: read.result.receipt,
                  bytes: [...read.result.bytes],
                }
              : { status: "denied", receipt: read.result.receipt },
        };
      }),
      receipts: this.receipts,
      receiptAttempts: this.receiptAttempts,
      submissions: [...this.submissions.values()],
      terminalCompletions: [...this.terminalCompletions],
      completionOutbox: [...this.completionOutbox].map(([submissionId, pending]) => ({
        submissionId,
        fact: pending.fact,
        delivered: pending.delivered,
      })),
      phaseOutputOutbox: [...this.phaseOutputOutbox].map(([submissionId, pending]) => ({
        submissionId,
        fact: pending.fact,
        delivered: pending.delivered,
      })),
      questions: this.questions,
      events: this.events,
      cursor: this.cursor,
    });
  }

  static fromDurableCanonicalJson(serialized: string, sha256: Sha256): InMemoryContextAuthority {
    const decoded = decodeCanonicalJsonValue(serialized);
    const hasTaskScopes =
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded) &&
      Object.hasOwn(decoded, "taskScopes");
    const parsed = exactDurableObject(decoded, "snapshot", [
      "version",
      ...(hasTaskScopes ? ["taskScopes"] : []),
      "dispatches",
      "grants",
      "reads",
      "receipts",
      "receiptAttempts",
      "submissions",
      "terminalCompletions",
      "completionOutbox",
      "phaseOutputOutbox",
      "questions",
      "events",
      "cursor",
    ]);
    if (parsed.version !== "senawa.dev/context-authority-durable/v1")
      throw new TypeError("Unsupported durable context authority version");
    assertNoGrantTokenField(parsed, "snapshot");
    const dispatchRecords = durableArray(parsed.dispatches, "dispatches");
    if (!hasTaskScopes && dispatchRecords.length > 0)
      durableFailure("nonempty context authority snapshots require taskScopes");
    const taskScopeRecords = hasTaskScopes ? durableArray(parsed.taskScopes, "taskScopes") : [];
    const grantRecords = durableArray(parsed.grants, "grants");
    const readRecords = durableArray(parsed.reads, "reads");
    const receiptRecords = durableArray(parsed.receipts, "receipts");
    const receiptAttemptRecords = durableArray(parsed.receiptAttempts, "receiptAttempts");
    const submissionRecords = durableArray(parsed.submissions, "submissions");
    const terminalRecords = durableArray(parsed.terminalCompletions, "terminalCompletions");
    const outboxRecords = durableArray(parsed.completionOutbox, "completionOutbox");
    const phaseOutputOutboxRecords = durableArray(parsed.phaseOutputOutbox, "phaseOutputOutbox");
    const questionRecords = durableArray(parsed.questions, "questions");
    const eventRecords = durableArray(parsed.events, "events");
    const cursor = nonNegativeSafeInteger(parsed.cursor, "cursor");
    const authority = new InMemoryContextAuthority();
    for (const [index, value] of taskScopeRecords.entries()) {
      const scope = decodeTaskScopeCurrentness(value, `taskScopes[${index}]`);
      const key = taskScopeKey(scope);
      if (authority.taskScopes.has(key))
        durableFailure(`taskScopes[${index}] duplicates a task scope`);
      authority.taskScopes.set(key, scope);
    }
    for (const [index, value] of dispatchRecords.entries()) {
      const candidate = durableObject(value, `dispatches[${index}]`);
      const record = exactDurableObject(value, `dispatches[${index}]`, [
        "context",
        "dispatch",
        "completionRequirements",
        "taskScope",
        ...(Object.hasOwn(candidate, "effect") ? ["effect"] : []),
      ]);
      const context = validateWorkerContextBase(record.context, sha256);
      const dispatch = validateWorkerDispatch(record.dispatch, context, sha256);
      const completionRequirements = validateCompletionRequirements(record.completionRequirements);
      const taskScope = validateDispatchTaskScope(record.taskScope, dispatch, context);
      if (!sameTask(dispatch.task, completionRequirements.task))
        durableFailure(`dispatches[${index}] completion requirements do not match the dispatch`);
      const priorContext = authority.contexts.get(context.contextId);
      if (
        priorContext !== undefined &&
        canonicalStringify(priorContext) !== canonicalStringify(context)
      )
        durableFailure(`dispatches[${index}] conflicts with its context identity`);
      if (authority.dispatches.has(dispatch.dispatchId))
        durableFailure(`dispatches[${index}] duplicates a dispatch identity`);
      const currentness = authority.taskScopes.get(taskScopeKey(taskScope));
      if (currentness === undefined || !isHistoricalTaskScopeFence(taskScope, currentness))
        durableFailure(`dispatches[${index}] task fence is not present in scope currentness`);
      const effect = decodeRegisteredWorkerEffectSeed(record.effect, sha256);
      const stored = deepFreeze({
        context,
        dispatch,
        completionRequirements,
        taskScope,
        ...(effect === undefined ? {} : { effect }),
      });
      authority.contexts.set(context.contextId, context);
      authority.dispatches.set(dispatch.dispatchId, stored);
    }
    for (const [index, value] of grantRecords.entries()) {
      const grant = exactDurableObject(value, `grants[${index}]`, [
        "tokenDigest",
        "envelope",
        "operationsUsed",
        "bytesUsed",
      ]);
      const tokenDigest = sha256DigestValue(grant.tokenDigest, `grants[${index}].tokenDigest`);
      const envelope = decodePersistedContextGrantEnvelope(grant.envelope);
      const operationsUsed = nonNegativeSafeInteger(
        grant.operationsUsed,
        `grants[${index}].operationsUsed`,
      );
      const bytesUsed = nonNegativeSafeInteger(grant.bytesUsed, `grants[${index}].bytesUsed`);
      if (operationsUsed > envelope.maxOperations || bytesUsed > envelope.maxBytes)
        durableFailure(`grants[${index}] usage exceeds its persisted maxima`);
      const stored = authority.dispatches.get(envelope.dispatchId);
      if (stored === undefined) durableFailure(`grants[${index}] references an unknown dispatch`);
      assertGrantBinding(envelope, stored, `grants[${index}]`);
      if (authority.grants.has(tokenDigest))
        durableFailure(`grants[${index}] duplicates a token digest`);
      authority.grants.set(tokenDigest, {
        tokenDigest,
        envelope,
        operationsUsed,
        bytesUsed,
      });
    }
    assertNoIssuedGrantToken(parsed, authority.grants, sha256);
    for (const [index, value] of readRecords.entries()) {
      const read = exactDurableObject(value, `reads[${index}]`, [
        "requestId",
        "canonicalReplayKey",
        "replayKeyDigest",
        "tokenDigest",
        "requestDigest",
        "result",
      ]);
      const requestId = durableString(read.requestId, `reads[${index}].requestId`);
      const canonicalReplayKey = durableString(
        read.canonicalReplayKey,
        `reads[${index}].canonicalReplayKey`,
      );
      const replay = decodePersistedAssetReadReplayKey(canonicalReplayKey);
      if (replay.requestId !== requestId)
        durableFailure(`reads[${index}] request identity does not match its replay key`);
      const replayKeyDigest = sha256DigestValue(
        read.replayKeyDigest,
        `reads[${index}].replayKeyDigest`,
      );
      if (replayKeyDigest !== digestReplayKey(sha256, canonicalReplayKey))
        durableFailure(`reads[${index}] replay key digest does not match its canonical bytes`);
      const tokenDigest = sha256DigestValue(read.tokenDigest, `reads[${index}].tokenDigest`);
      if (tokenDigest !== replay.tokenDigest)
        durableFailure(`reads[${index}] token digest does not match its replay key`);
      const requestDigest = sha256DigestValue(read.requestDigest, `reads[${index}].requestDigest`);
      const storedResult = exactDurableObject(read.result, `reads[${index}].result`, [
        "status",
        "receipt",
        ...(read.result !== null &&
        typeof read.result === "object" &&
        Object.hasOwn(read.result, "bytes")
          ? ["bytes"]
          : []),
      ]);
      const receipt = decodeAssetReadAuditReceipt(storedResult.receipt);
      assertReadReceiptBinding(receipt, replay, requestDigest, authority, `reads[${index}]`);
      let result: AssetReadResult;
      if (storedResult.status === "served") {
        if (!Object.hasOwn(storedResult, "bytes"))
          durableFailure(`reads[${index}] served result is missing bytes`);
        const bytes = durableBytes(storedResult.bytes, `reads[${index}].result.bytes`);
        if (receipt.status !== "served" || bytes.byteLength !== receipt.responseBytes)
          durableFailure(`reads[${index}] served bytes do not match the receipt`);
        result = Object.freeze({ status: "served", receipt, bytes });
      } else if (storedResult.status === "denied") {
        if (Object.hasOwn(storedResult, "bytes") || receipt.status !== "denied")
          durableFailure(`reads[${index}] denied result does not match the receipt`);
        result = Object.freeze({ status: "denied", receipt });
      } else {
        durableFailure(`reads[${index}] has an invalid result status`);
      }
      if (authority.reads.has(requestId))
        durableFailure(`reads[${index}] duplicates a request identity`);
      authority.reads.set(requestId, {
        canonicalReplayKey,
        replayKeyDigest,
        tokenDigest,
        requestDigest,
        result,
      });
    }
    if (receiptAttemptRecords.length !== receiptRecords.length)
      durableFailure("receiptAttempts must exactly cover persisted receipts");
    const receiptCounts = new Map<string, number>();
    for (const [index, value] of receiptRecords.entries()) {
      const receipt = decodeAssetReadAuditReceipt(value);
      const hasFailureMetadata =
        value !== null &&
        typeof receiptAttemptRecords[index] === "object" &&
        !Array.isArray(receiptAttemptRecords[index]) &&
        receiptAttemptRecords[index] !== null &&
        (Object.hasOwn(receiptAttemptRecords[index], "failureStage") ||
          Object.hasOwn(receiptAttemptRecords[index], "failureFactDigest"));
      const attempt = exactDurableObject(
        receiptAttemptRecords[index],
        `receiptAttempts[${index}]`,
        hasFailureMetadata
          ? [
              "receiptCursor",
              "canonicalReplayKey",
              "replayKeyDigest",
              "tokenDigest",
              "requestDigest",
              "reserved",
              "failureStage",
              "failureFactDigest",
              "receipt",
            ]
          : [
              "receiptCursor",
              "canonicalReplayKey",
              "replayKeyDigest",
              "tokenDigest",
              "requestDigest",
              "reserved",
              "receipt",
            ],
      );
      const receiptCursor = nonNegativeSafeInteger(
        attempt.receiptCursor,
        `receiptAttempts[${index}].receiptCursor`,
      );
      if (receiptCursor !== index + 1)
        durableFailure(`receiptAttempts[${index}] has a noncontiguous receipt cursor`);
      const canonicalReplayKey = durableString(
        attempt.canonicalReplayKey,
        `receiptAttempts[${index}].canonicalReplayKey`,
      );
      const replay = decodePersistedAssetReadReplayKey(canonicalReplayKey);
      const replayKeyDigest = sha256DigestValue(
        attempt.replayKeyDigest,
        `receiptAttempts[${index}].replayKeyDigest`,
      );
      if (replayKeyDigest !== digestReplayKey(sha256, canonicalReplayKey))
        durableFailure(
          `receiptAttempts[${index}] replay key digest does not match its canonical bytes`,
        );
      const tokenDigest = sha256DigestValue(
        attempt.tokenDigest,
        `receiptAttempts[${index}].tokenDigest`,
      );
      if (tokenDigest !== replay.tokenDigest)
        durableFailure(`receiptAttempts[${index}] token digest does not match its replay key`);
      const requestDigest = sha256DigestValue(
        attempt.requestDigest,
        `receiptAttempts[${index}].requestDigest`,
      );
      const reserved = durableBoolean(attempt.reserved, `receiptAttempts[${index}].reserved`);
      const attemptReceipt = decodeAssetReadAuditReceipt(attempt.receipt);
      if (canonicalStringify(attemptReceipt) !== canonicalStringify(receipt))
        durableFailure(`receiptAttempts[${index}] receipt does not match the receipt ledger`);
      let failureStage: ContextReadFailureStage | undefined;
      let failureFactDigest: string | undefined;
      if (hasFailureMetadata) {
        const stage = durableString(attempt.failureStage, `receiptAttempts[${index}].failureStage`);
        if (stage !== "asset-read" && stage !== "asset-integrity")
          durableFailure(`receiptAttempts[${index}] has an invalid failure stage`);
        failureStage = stage;
        failureFactDigest = sha256DigestValue(
          attempt.failureFactDigest,
          `receiptAttempts[${index}].failureFactDigest`,
        );
        if (
          failureFactDigest !==
          digestReceiptFailureFact(sha256, {
            failureStage,
            receiptCursor,
            replayKeyDigest,
            requestDigest,
            tokenDigest,
          })
        )
          durableFailure(`receiptAttempts[${index}] failure fact digest does not match`);
      }
      const isDigestMismatch =
        receipt.status === "denied" && receipt.denialCode === "digest-mismatch";
      if (isDigestMismatch !== hasFailureMetadata)
        durableFailure(
          `receiptAttempts[${index}] failure provenance must exactly match digest-mismatch denial`,
        );
      assertReadReceiptBinding(
        receipt,
        replay,
        requestDigest,
        authority,
        `receiptAttempts[${index}]`,
      );
      const read = authority.reads.get(receipt.requestId);
      if (read === undefined)
        durableFailure(`receipts[${index}] references an unknown durable read`);
      if (read.result instanceof Promise)
        durableFailure(`receipts[${index}] references an in-flight durable read`);
      const canonical = canonicalStringify(receipt);
      const resultReceipt = canonicalStringify(read.result.receipt);
      if (canonical !== resultReceipt) {
        if (
          receipt.status !== "denied" ||
          receipt.denialCode !== "request-conflict" ||
          receipt.requestDigest === read.requestDigest
        )
          durableFailure(`receipts[${index}] is not the read result or an exact conflict`);
        const grant = authority.grants.get(replay.tokenDigest);
        if (
          grant !== undefined &&
          (receipt.repositoryId !== grant.envelope.repositoryId ||
            receipt.runId !== grant.envelope.runId ||
            receipt.dispatchId !== grant.envelope.dispatchId ||
            receipt.contextId !== grant.envelope.contextId ||
            receipt.assetBindingId !== grant.envelope.assetBindingId ||
            receipt.principalId !== grant.envelope.principalId)
        )
          durableFailure(`receipts[${index}] conflict attribution does not match its grant`);
      } else if (
        canonicalReplayKey !== read.canonicalReplayKey ||
        replayKeyDigest !== read.replayKeyDigest ||
        tokenDigest !== read.tokenDigest ||
        requestDigest !== read.requestDigest
      ) {
        durableFailure(`receiptAttempts[${index}] does not match its durable read identity`);
      }
      if (
        !authority.dispatches.has(receipt.dispatchId) &&
        receipt.dispatchId !== "dispatch_unknown"
      )
        durableFailure(`receipts[${index}] references an unknown dispatch`);
      receiptCounts.set(canonical, (receiptCounts.get(canonical) ?? 0) + 1);
      authority.receipts.push(receipt);
      authority.receiptAttempts.push({
        receiptCursor,
        canonicalReplayKey,
        replayKeyDigest,
        tokenDigest,
        requestDigest,
        reserved,
        ...(failureStage === undefined || failureFactDigest === undefined
          ? {}
          : { failureStage, failureFactDigest }),
        receipt,
      });
    }
    for (const [requestId, read] of authority.reads) {
      if (read.result instanceof Promise) durableFailure(`reads[${requestId}] persisted a promise`);
      const canonical = canonicalStringify(read.result.receipt);
      if ((receiptCounts.get(canonical) ?? 0) !== 1)
        durableFailure(`reads[${requestId}] must have one exact persisted receipt`);
    }
    for (const [index, value] of submissionRecords.entries()) {
      const storedValue = exactDurableObject(value, `submissions[${index}]`, [
        "canonicalSubmission",
        "submission",
        "result",
      ]);
      const canonicalSubmission = durableString(
        storedValue.canonicalSubmission,
        `submissions[${index}].canonicalSubmission`,
      );
      const submission = decodeWorkerSubmission(storedValue.submission);
      if (canonicalSubmission !== canonicalStringify(submission))
        durableFailure(`submissions[${index}] canonical submission does not match its payload`);
      const dispatch = authority.dispatches.get(submission.dispatchId);
      if (dispatch === undefined)
        durableFailure(`submissions[${index}] references an unknown dispatch`);
      assertSubmissionRecordBinding(submission, dispatch, `submissions[${index}]`);
      const result = decodeSubmissionAdmissionResult(
        storedValue.result,
        submission,
        dispatch,
        `submissions[${index}]`,
      );
      if (authority.submissions.has(submission.submissionId))
        durableFailure(`submissions[${index}] duplicates a submission identity`);
      authority.submissions.set(
        submission.submissionId,
        deepFreeze({ canonicalSubmission, submission, result }),
      );
    }
    for (const [index, value] of terminalRecords.entries()) {
      if (!Array.isArray(value) || value.length !== 2)
        durableFailure(`terminalCompletions[${index}] must be an exact pair`);
      const dispatchId = durableString(value[0], `terminalCompletions[${index}][0]`);
      const submissionId = durableString(value[1], `terminalCompletions[${index}][1]`);
      if (authority.terminalCompletions.has(dispatchId))
        durableFailure(`terminalCompletions[${index}] duplicates a dispatch`);
      const submission = authority.submissions.get(submissionId);
      if (
        submission === undefined ||
        submission.submission.type !== "completion" ||
        submission.submission.dispatchId !== dispatchId ||
        submission.result.status !== "accepted" ||
        submission.result.completionFact === undefined
      )
        durableFailure(`terminalCompletions[${index}] does not name the accepted completion`);
      authority.terminalCompletions.set(dispatchId, submissionId);
    }
    for (const stored of authority.submissions.values()) {
      if (
        stored.result.completionFact !== undefined &&
        authority.terminalCompletions.get(stored.submission.dispatchId) !==
          stored.submission.submissionId
      )
        durableFailure(`submission ${stored.submission.submissionId} lacks its terminal claim`);
    }
    for (const [index, value] of outboxRecords.entries()) {
      const pending = exactDurableObject(value, `completionOutbox[${index}]`, [
        "submissionId",
        "fact",
        "delivered",
      ]);
      const submissionId = durableString(
        pending.submissionId,
        `completionOutbox[${index}].submissionId`,
      );
      if (typeof pending.delivered !== "boolean")
        durableFailure(`completionOutbox[${index}].delivered must be a boolean`);
      const stored = authority.submissions.get(submissionId);
      if (
        stored?.result.completionFact === undefined ||
        canonicalStringify(pending.fact) !== canonicalStringify(stored.result.completionFact)
      )
        durableFailure(`completionOutbox[${index}] does not match its completion result`);
      if (authority.completionOutbox.has(submissionId))
        durableFailure(`completionOutbox[${index}] duplicates a submission`);
      authority.completionOutbox.set(
        submissionId,
        Object.seal({
          fact: stored.result.completionFact,
          delivered: pending.delivered,
          delivering: false,
        }),
      );
    }
    for (const stored of authority.submissions.values()) {
      if (
        stored.result.completionFact !== undefined &&
        !authority.completionOutbox.has(stored.submission.submissionId)
      )
        durableFailure(`submission ${stored.submission.submissionId} lacks its completion outbox`);
    }
    for (const [index, value] of phaseOutputOutboxRecords.entries()) {
      const pending = exactDurableObject(value, `phaseOutputOutbox[${index}]`, [
        "submissionId",
        "fact",
        "delivered",
      ]);
      const submissionId = durableString(
        pending.submissionId,
        `phaseOutputOutbox[${index}].submissionId`,
      );
      if (typeof pending.delivered !== "boolean") {
        durableFailure(`phaseOutputOutbox[${index}].delivered must be a boolean`);
      }
      const stored = authority.submissions.get(submissionId);
      if (
        stored?.result.phaseOutputFact === undefined ||
        canonicalStringify(pending.fact) !== canonicalStringify(stored.result.phaseOutputFact)
      ) {
        durableFailure(`phaseOutputOutbox[${index}] does not match its output result`);
      }
      if (authority.phaseOutputOutbox.has(submissionId)) {
        durableFailure(`phaseOutputOutbox[${index}] duplicates a submission`);
      }
      authority.phaseOutputOutbox.set(
        submissionId,
        Object.seal({
          fact: stored.result.phaseOutputFact,
          delivered: pending.delivered,
          delivering: false,
        }),
      );
    }
    for (const stored of authority.submissions.values()) {
      if (
        stored.result.phaseOutputFact !== undefined &&
        !authority.phaseOutputOutbox.has(stored.submission.submissionId)
      ) {
        durableFailure(
          `submission ${stored.submission.submissionId} lacks its phase output outbox`,
        );
      }
    }
    const questionIds = new Set<string>();
    for (const [index, value] of questionRecords.entries()) {
      const question = decodeWorkerSubmission(value);
      const stored = authority.submissions.get(question.submissionId);
      if (
        question.type !== "question" ||
        stored?.submission.type !== "question" ||
        canonicalStringify(question) !== canonicalStringify(stored.submission) ||
        questionIds.has(question.submissionId)
      )
        durableFailure(`questions[${index}] is not one exact question submission`);
      questionIds.add(question.submissionId);
      authority.questions.push(question);
    }
    for (const stored of authority.submissions.values()) {
      if (stored.submission.type === "question" && !questionIds.has(stored.submission.submissionId))
        durableFailure(`question ${stored.submission.submissionId} is missing from questions`);
    }
    for (const [index, value] of eventRecords.entries()) {
      const event = decodeContextBrokerEvent(value, index + 1, authority);
      authority.events.push(event);
    }
    if (cursor !== authority.events.length)
      durableFailure("cursor does not match the exact event sequence");
    authority.cursor = cursor;
    return authority;
  }
}

export class InMemoryContextAssetAuthority implements ContextAssetPort {
  readonly assets = new Map<string, Uint8Array>();
  readonly canonicalOutputs = new Map<string, InstalledCanonicalOutputAsset>();
  readonly sha256: Sha256;

  constructor(sha256: Sha256) {
    this.sha256 = sha256;
  }

  installCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset, bytes: Uint8Array): void {
    if (
      bytes.byteLength !== asset.byteLength ||
      this.sha256.digest(bytes) !== asset.contentDigest
    ) {
      throw new TypeError("Canonical phase output bytes do not match their descriptor");
    }
    this.canonicalOutputs.set(canonicalStringify(asset), deepFreeze(asset));
  }

  hasCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset): boolean {
    return this.canonicalOutputs.has(canonicalStringify(asset));
  }

  put(binding: HistoricalAssetBinding, bytes: Uint8Array): void {
    this.assets.set(binding.assetBindingId, Uint8Array.from(bytes));
  }

  readAssetRange(
    binding: HistoricalAssetBinding,
    offset: number,
    length: number,
  ): Uint8Array | undefined {
    const bytes = this.assets.get(binding.assetBindingId);
    return bytes === undefined ? undefined : bytes.slice(offset, offset + length);
  }

  readJsonAsset(binding: HistoricalAssetBinding, maxAssetBytes: number): Uint8Array | undefined {
    const bytes = this.assets.get(binding.assetBindingId);
    return bytes === undefined || bytes.byteLength > maxAssetBytes
      ? undefined
      : Uint8Array.from(bytes);
  }
}

export class ContextBroker implements ContextBrokerClient {
  readonly authority: ContextAuthorityPort;
  readonly assets: ContextAssetPort;
  readonly completionFacts: CompletionFactPort | undefined;
  readonly phaseOutputFacts: PhaseOutputFactPort | undefined;
  readonly dependencies: ContextBrokerDependencies;

  constructor(
    assets: ContextAssetPort,
    dependencies: ContextBrokerDependencies,
    authority: ContextAuthorityPort = new InMemoryContextAuthority(),
    completionFacts?: CompletionFactPort,
    phaseOutputFacts?: PhaseOutputFactPort,
  ) {
    this.assets = assets;
    this.dependencies = Object.freeze({
      sha256: dependencies.sha256,
      currentTime: dependencies.currentTime,
      issueGrantToken: dependencies.issueGrantToken,
    });
    this.authority = authority;
    this.completionFacts = completionFacts;
    this.phaseOutputFacts = phaseOutputFacts;
  }

  registerDispatch(input: RegisterWorkerDispatchInput): WorkerDispatch {
    const context = validateWorkerContextBase(input.context, this.dependencies.sha256);
    const dispatch = validateWorkerDispatch(input.dispatch, context, this.dependencies.sha256);
    const completionRequirements = validateCompletionRequirements(input.completionRequirements);
    const taskScope = validateDispatchTaskScope(input.taskScope, dispatch, context);
    const effect = decodeRegisteredWorkerEffectSeed(input.effect, this.dependencies.sha256);
    if (!sameTask(dispatch.task, completionRequirements.task)) {
      throw new ContextBrokerError(
        "binding-mismatch",
        "Completion requirements do not match the dispatch task generation",
      );
    }
    if (
      this.containsIssuedGrantToken(context) ||
      this.containsIssuedGrantToken(dispatch) ||
      this.containsIssuedGrantToken(completionRequirements)
    )
      throw new ContextBrokerError(
        "secret-leak",
        "Worker dispatch inputs contain issued grant authority",
      );
    const promptPack = renderPromptPack(
      context,
      dispatch,
      this.dependencies.sha256,
      DEFAULT_PROMPT_PACK_MAX_BYTES,
    );
    if (promptPack.digest !== dispatch.promptPackDigest) {
      throw new ContextBrokerError(
        "binding-mismatch",
        "Dispatch prompt pack digest does not match the bounded deterministic rendering",
      );
    }
    const existing = this.authority.dispatches.get(dispatch.dispatchId);
    if (existing !== undefined) {
      if (
        canonicalStringify(existing.context) !== canonicalStringify(context) ||
        canonicalStringify(existing.dispatch) !== canonicalStringify(dispatch) ||
        canonicalStringify(existing.completionRequirements) !==
          canonicalStringify(completionRequirements) ||
        canonicalStringify(existing.taskScope) !== canonicalStringify(taskScope) ||
        canonicalStringify(existing.effect ?? null) !== canonicalStringify(effect ?? null)
      ) {
        throw new ContextBrokerError(
          "binding-mismatch",
          "Dispatch identity is already registered with different canonical facts",
        );
      }
      return existing.dispatch;
    }
    const scopeKey = taskScopeKey(taskScope);
    const currentness = this.authority.taskScopes.get(scopeKey);
    if (currentness === undefined) {
      this.authority.taskScopes.set(scopeKey, deepFreeze({ ...taskScope, claimsAccepted: true }));
    } else if (!currentness.claimsAccepted || !sameTaskScopeFence(taskScope, currentness)) {
      throw new ContextBrokerError(
        "binding-mismatch",
        "Dispatch task scope is not current and accepting claims",
      );
    }
    this.authority.contexts.set(context.contextId, context);
    this.authority.dispatches.set(
      dispatch.dispatchId,
      Object.freeze({
        context,
        dispatch,
        completionRequirements,
        taskScope,
        ...(effect === undefined ? {} : { effect }),
      }),
    );
    return dispatch;
  }

  loadWorkerDispatch(dispatchId: string): StoredDispatch | undefined {
    const stored = this.authority.dispatches.get(dispatchId);
    if (stored === undefined) return undefined;
    return deepFreeze({
      context: stored.context,
      dispatch: stored.dispatch,
      completionRequirements: stored.completionRequirements,
      taskScope: stored.taskScope,
    });
  }

  listWorkerDispatches(repositoryId: string, runId: string): readonly StoredDispatch[] {
    return Object.freeze(
      [...this.authority.dispatches.values()]
        .filter(
          ({ dispatch }) => dispatch.repositoryId === repositoryId && dispatch.runId === runId,
        )
        .sort((left, right) => compareText(left.dispatch.dispatchId, right.dispatch.dispatchId))
        .map((stored) => deepFreeze({ ...stored })),
    );
  }

  loadWorkerDispatchProgress(dispatchId: string): WorkerDispatchProgress | undefined {
    const stored = this.authority.dispatches.get(dispatchId);
    if (stored === undefined) return undefined;
    const submissions = [...this.authority.submissions.values()]
      .filter(({ submission }) => submission.dispatchId === dispatchId)
      .map(({ result }) => deepFreeze({ ...result }));
    return deepFreeze({
      dispatchId,
      completionStatus: submissions.some(
        ({ type, status }) => type === "completion" && status !== "stale",
      )
        ? "accepted"
        : "pending",
      submissions,
      sessionExpected: true,
    });
  }

  grantAssetAccess(input: ContextGrantInput): ContextGrantEnvelope {
    const issuedAt = this.trustedTime();
    validateTimestamp(input.expiresAt, "expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(issuedAt))
      throw new ContextBrokerError(
        "invalid-grant",
        "Context grants must expire after the trusted current time",
      );
    const stored = this.requiredDispatch(input.dispatchId);
    if (
      stored.dispatch.repositoryId !== input.repositoryId ||
      stored.dispatch.runId !== input.runId
    )
      throw new ContextBrokerError(
        "binding-mismatch",
        "Grant run identity does not match the dispatch",
      );
    this.requireCapability(stored.dispatch, WORKER_CAPABILITIES.assetRead);
    const binding = stored.context.assets.find(
      ({ assetBindingId }) => assetBindingId === input.assetBindingId,
    );
    if (binding === undefined)
      throw new ContextBrokerError(
        "unknown-asset-binding",
        "Grant asset binding is not present in the immutable context",
      );
    const tokenBytes = this.dependencies.issueGrantToken();
    if (!(tokenBytes instanceof Uint8Array) || tokenBytes.byteLength !== 32)
      throw new ContextBrokerError(
        "invalid-grant",
        "Grant token issuers must return exactly 32 bytes",
      );
    const grantToken = encodeBase64Url(tokenBytes);
    const tokenDigest = digestBytes(this.dependencies.sha256, new TextEncoder().encode(grantToken));
    if (this.authority.grants.has(tokenDigest))
      throw new ContextBrokerError(
        "invalid-grant",
        "Grant token issuer returned an identity that is already in use",
      );
    const candidate = decodeContextGrantEnvelope({
      apiVersion: PROTOCOL_VERSION,
      grantToken,
      repositoryId: stored.dispatch.repositoryId,
      runId: stored.dispatch.runId,
      dispatchId: stored.dispatch.dispatchId,
      task: stored.dispatch.task,
      contextId: stored.context.contextId,
      contextDigest: stored.context.contextDigest,
      principalId: stored.dispatch.worker.principalId,
      assetBindingId: binding.assetBindingId,
      allowedPointer: input.allowedPointer,
      readMode: input.readMode,
      sensitivityCeiling: input.sensitivityCeiling,
      issuedAt,
      expiresAt: input.expiresAt,
      maxOperations: input.maxOperations,
      maxBytes: input.maxBytes,
      maxChunkBytes: input.maxChunkBytes,
    });
    const { grantToken: _grantToken, ...persistedEnvelope } = candidate;
    if (this.containsGrantTokenDigest(persistedEnvelope, tokenDigest))
      throw new ContextBrokerError(
        "secret-leak",
        "Context grant inputs contain issued grant authority",
      );
    this.authority.grants.set(tokenDigest, {
      tokenDigest,
      envelope: deepFreeze(persistedEnvelope),
      operationsUsed: 0,
      bytesUsed: 0,
    });
    this.appendEvent(stored.dispatch, "context-grant-issued", issuedAt, {
      tokenDigest,
      assetBindingId: binding.assetBindingId,
      issuedAt,
      expiresAt: candidate.expiresAt,
    });
    return candidate;
  }

  async readAsset(input: AssetReadInput): Promise<AssetReadResult> {
    const occurredAt = this.trustedTime();
    const request = decodeAssetReadRequest(input.request);
    const requestDigest = digestBytes(this.dependencies.sha256, canonicalBytes(request));
    const tokenDigest = digestBytes(
      this.dependencies.sha256,
      new TextEncoder().encode(request.grantToken),
    );
    const { grantToken: _grantToken, ...requestWithoutToken } = request;
    const canonicalReplayKey = canonicalStringify({
      ...requestWithoutToken,
      tokenDigest,
    });
    const replayKeyDigest = digestReplayKey(this.dependencies.sha256, canonicalReplayKey);
    const prior = this.authority.reads.get(request.requestId);
    if (prior !== undefined) {
      if (prior.canonicalReplayKey === canonicalReplayKey)
        return cloneReadResult(await Promise.resolve(prior.result));
      const grant = this.resolveGrant(request.grantToken);
      const conflict =
        grant === undefined
          ? this.deniedUnknown(request, requestDigest, occurredAt, "request-conflict")
          : this.denied(grant, request, requestDigest, occurredAt, "request-conflict", 0);
      this.appendReceipt(
        conflict.receipt,
        canonicalReplayKey,
        replayKeyDigest,
        tokenDigest,
        requestDigest,
        false,
      );
      return conflict;
    }

    let resolveResult: (result: AssetReadResult) => void = () => undefined;
    let rejectResult: (error: unknown) => void = () => undefined;
    const inFlight = new Promise<AssetReadResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const storedRead: StoredRead = {
      canonicalReplayKey,
      replayKeyDigest,
      tokenDigest,
      requestDigest,
      result: inFlight,
    };
    this.authority.reads.set(request.requestId, storedRead);
    const grant = this.resolveGrant(request.grantToken);
    if (grant === undefined) {
      const denied = this.deniedUnknown(request, requestDigest, occurredAt, "invalid-token");
      this.completeRead(storedRead, denied, false);
      resolveResult(denied);
      return cloneReadResult(denied);
    }

    const reservation: {
      charged: boolean;
      bytes: number;
      failureStage?: ContextReadFailureStage;
    } = { charged: false, bytes: 0 };
    void this.performRead(grant, request, requestDigest, occurredAt, reservation).then(
      (result) => {
        this.completeRead(storedRead, result, reservation.charged, reservation.failureStage);
        resolveResult(result);
      },
      (error) => {
        if (error instanceof ContextBrokerTransactionAbortError) {
          rejectResult(error);
          return;
        }
        if (reservation.charged) grant.bytesUsed -= reservation.bytes;
        const denied = this.denied(
          grant,
          request,
          requestDigest,
          occurredAt,
          "digest-mismatch",
          reservation.charged ? 1 : 0,
        );
        this.completeRead(storedRead, denied, reservation.charged, "asset-read");
        resolveResult(denied);
      },
    );
    return cloneReadResult(await inFlight);
  }

  private async performRead(
    grant: StoredGrant,
    request: AssetReadRequest,
    requestDigest: string,
    occurredAt: string,
    reservation: {
      charged: boolean;
      bytes: number;
      failureStage?: ContextReadFailureStage;
    },
  ): Promise<AssetReadResult> {
    const stored = this.requiredDispatch(grant.envelope.dispatchId);
    const deny = (code: AssetReadDenialCode, chargedOperations = 0): AssetReadResult => {
      return this.denied(grant, request, requestDigest, occurredAt, code, chargedOperations);
    };
    if (request.assetBindingId !== grant.envelope.assetBindingId) return deny("scope-denied");
    if (Date.parse(occurredAt) >= Date.parse(grant.envelope.expiresAt)) return deny("expired");
    const binding = stored.context.assets.find(
      ({ assetBindingId }) => assetBindingId === grant.envelope.assetBindingId,
    );
    if (binding === undefined) return deny("scope-denied");
    if (sensitivityRank(binding.sensitivity) > sensitivityRank(grant.envelope.sensitivityCeiling))
      return deny("sensitivity-denied");
    const worstCaseBytes = assetReadWorstCaseBytes(request);
    if (!this.requestAllowedByGrant(request, grant, binding))
      return deny(request.type === "chunk" ? "invalid-range" : "invalid-pointer");
    if (
      grant.operationsUsed + 1 > grant.envelope.maxOperations ||
      grant.bytesUsed + worstCaseBytes > grant.envelope.maxBytes
    )
      return deny("budget-exhausted");

    // Reserve the worst-case response before I/O. Successful short responses do not refund bytes.
    reservation.charged = true;
    reservation.bytes = worstCaseBytes;
    grant.operationsUsed += 1;
    grant.bytesUsed += worstCaseBytes;
    let response: Uint8Array | undefined;
    try {
      if (request.type === "chunk") {
        response = await this.assets.readAssetRange(binding, request.offset, request.length);
      } else {
        const content = await this.assets.readJsonAsset(binding, DEFAULT_POINTER_ASSET_MAX_BYTES);
        if (content === undefined) {
          reservation.failureStage = "asset-integrity";
          grant.bytesUsed -= worstCaseBytes;
          return deny("digest-mismatch", 1);
        }
        response = readCanonicalJsonPointer(content, request.pointer, request.maxBytes);
      }
    } catch (error) {
      if (error instanceof ContextBrokerTransactionAbortError) throw error;
      reservation.failureStage = "asset-read";
      grant.bytesUsed -= worstCaseBytes;
      return deny("digest-mismatch", 1);
    }
    if (
      response === undefined ||
      (request.type === "chunk" && response.byteLength !== request.length)
    ) {
      grant.bytesUsed -= worstCaseBytes;
      if (request.type === "pointer") return deny("invalid-pointer", 1);
      reservation.failureStage = "asset-integrity";
      return deny("digest-mismatch", 1);
    }
    const receipt = decodeAssetReadAuditReceipt({
      ...receiptBinding(grant, request, requestDigest, occurredAt),
      status: "served",
      chargedOperations: 1,
      chargedBytes: worstCaseBytes,
      responseBytes: response.byteLength,
      remainingOperations: grant.envelope.maxOperations - grant.operationsUsed,
      remainingBytes: grant.envelope.maxBytes - grant.bytesUsed,
    });
    const result: AssetReadResult = Object.freeze({
      status: "served",
      receipt,
      bytes: Uint8Array.from(response),
    });
    this.appendEvent(stored.dispatch, "asset-read-served", occurredAt, {
      requestId: request.requestId,
      requestDigest,
      assetBindingId: request.assetBindingId,
      responseBytes: response.byteLength,
    });
    return result;
  }

  admitSubmission(input: SubmissionAdmissionInput): SubmissionAdmissionResult {
    const occurredAt = this.trustedTime();
    const submission = decodeWorkerSubmission(input.submission);
    const canonicalSubmission = canonicalStringify(submission);
    if (this.containsIssuedGrantToken(submission))
      throw new ContextBrokerError(
        "secret-leak",
        "Worker submission contains issued grant authority",
      );
    const prior = this.authority.submissions.get(submission.submissionId);
    if (prior !== undefined) {
      if (prior.canonicalSubmission === canonicalSubmission) {
        this.deliverCompletionFact(submission.submissionId);
        this.deliverPhaseOutputFact(submission.submissionId);
        return Object.freeze({ ...prior.result, replayed: true });
      }
      throw new ContextBrokerError(
        "submission-conflict",
        "Submission identity is already bound to different canonical content",
      );
    }
    const stored = this.requiredDispatch(submission.dispatchId);
    this.assertSubmissionBinding(submission, stored);
    this.requireCapability(stored.dispatch, capabilityForSubmission(submission.type));
    const currentness = this.authority.taskScopes.get(taskScopeKey(stored.taskScope));
    const stale =
      currentness === undefined ||
      !currentness.claimsAccepted ||
      !sameTaskScopeFence(stored.taskScope, currentness);
    let completionFact: CompletionFact | undefined;
    let phaseOutputFact: PhaseOutputFact | undefined;
    const duplicateCompletion =
      !stale &&
      submission.type === "completion" &&
      this.authority.terminalCompletions.has(submission.dispatchId);
    if (!stale && !duplicateCompletion && submission.type === "completion") {
      const assessment = assessCompletionAccounting(
        stored.completionRequirements,
        submission.completion as unknown as CompletionSubmission,
      );
      completionFact = deepFreeze({
        submissionId: submission.submissionId,
        repositoryId: submission.repositoryId,
        runId: submission.runId,
        dispatchId: submission.dispatchId,
        assessment,
      });
      this.authority.terminalCompletions.set(submission.dispatchId, submission.submissionId);
    }
    const priorOutput =
      submission.type === "phase-output" ? this.acceptedPhaseOutputForSlot(submission) : undefined;
    const duplicateOutput =
      !stale &&
      submission.type === "phase-output" &&
      priorOutput !== undefined &&
      canonicalStringify(
        (priorOutput.submission as Extract<WorkerSubmission, { readonly type: "phase-output" }>)
          .output,
      ) === canonicalStringify(submission.output);
    if (
      !stale &&
      submission.type === "phase-output" &&
      priorOutput !== undefined &&
      !duplicateOutput
    ) {
      throw new ContextBrokerError(
        "submission-conflict",
        "Phase output slot is already bound to different canonical content",
      );
    }
    if (!stale && !duplicateOutput && submission.type === "phase-output") {
      this.assertPhaseOutputSubmission(submission, stored);
      phaseOutputFact = deepFreeze({
        submissionId: submission.submissionId,
        repositoryId: submission.repositoryId,
        runId: submission.runId,
        dispatchId: submission.dispatchId,
        contextId: submission.contextId,
        contextDigest: submission.contextDigest,
        producingTask: submission.task as TaskGenerationReference,
        output: submission.output,
      });
    }
    const result = deepFreeze({
      submissionId: submission.submissionId,
      type: submission.type,
      status:
        stale || false
          ? "stale"
          : duplicateCompletion || duplicateOutput
            ? "duplicate"
            : "accepted",
      replayed: false,
      ...(completionFact === undefined ? {} : { completionFact }),
      ...(phaseOutputFact === undefined ? {} : { phaseOutputFact }),
    }) as SubmissionAdmissionResult;
    this.authority.submissions.set(
      submission.submissionId,
      Object.freeze({ canonicalSubmission, submission, result }),
    );
    if (submission.type === "question") this.authority.questions.push(submission);
    this.appendEvent(
      stored.dispatch,
      stale
        ? "worker-submission-stale"
        : duplicateCompletion
          ? "worker-submission-duplicate"
          : "worker-submission-accepted",
      occurredAt,
      { submissionId: submission.submissionId, submissionType: submission.type },
    );
    if (completionFact !== undefined) {
      this.authority.completionOutbox.set(
        submission.submissionId,
        Object.seal({ fact: completionFact, delivered: false, delivering: false }),
      );
      this.deliverCompletionFact(submission.submissionId);
    }
    if (phaseOutputFact !== undefined) {
      this.authority.phaseOutputOutbox.set(
        submission.submissionId,
        Object.seal({ fact: phaseOutputFact, delivered: false, delivering: false }),
      );
      this.deliverPhaseOutputFact(submission.submissionId);
    }
    return result;
  }

  deliverPhaseOutputFact(submissionId: string): boolean {
    const pending = this.authority.phaseOutputOutbox.get(submissionId);
    if (pending === undefined || pending.delivered || pending.delivering) return false;
    if (this.phaseOutputFacts === undefined) return false;
    pending.delivering = true;
    try {
      if (this.phaseOutputFacts.admitPhaseOutputFact(pending.fact) === "deferred") return false;
      pending.delivered = true;
      return true;
    } finally {
      pending.delivering = false;
    }
  }

  installCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset, bytes: Uint8Array): void {
    this.assets.installCanonicalOutputAsset(asset, bytes);
  }

  recordPhaseOutputAttempt(input: PhaseOutputAttemptInput): PhaseOutputAttemptResult {
    return recordPhaseOutputAttemptInLedger(this.#phaseOutputAttempts, input);
  }

  countRejectedPhaseOutputAttempts(dispatchId: string, outputName: string): number {
    return [...this.#phaseOutputAttempts.values()].filter(
      (record) =>
        record.outcome === "rejected" &&
        record.dispatchId === dispatchId &&
        record.outputName === outputName,
    ).length;
  }

  readonly #phaseOutputAttempts = new Map<string, PhaseOutputAttemptRecord>();

  private acceptedPhaseOutputForSlot(
    submission: Extract<WorkerSubmission, { readonly type: "phase-output" }>,
  ): StoredSubmission | undefined {
    return [...this.authority.submissions.values()].find(
      (stored) =>
        stored.submission.type === "phase-output" &&
        stored.result.status === "accepted" &&
        stored.submission.runId === submission.runId &&
        (stored.submission as Extract<WorkerSubmission, { readonly type: "phase-output" }>).output
          .phase.phaseId === submission.output.phase.phaseId &&
        (stored.submission as Extract<WorkerSubmission, { readonly type: "phase-output" }>).output
          .phase.definitionGeneration === submission.output.phase.definitionGeneration &&
        (stored.submission as Extract<WorkerSubmission, { readonly type: "phase-output" }>).output
          .phase.attempt === submission.output.phase.attempt &&
        (stored.submission as Extract<WorkerSubmission, { readonly type: "phase-output" }>).output
          .outputName === submission.output.outputName,
    );
  }

  private assertPhaseOutputSubmission(
    submission: Extract<WorkerSubmission, { readonly type: "phase-output" }>,
    stored: StoredDispatch,
  ): void {
    const { context } = stored;
    const declaration = context.phaseOutputDeclarations.find(
      ({ outputName }) => outputName === submission.output.outputName,
    );
    if (
      declaration === undefined ||
      submission.output.phase.phaseId !== context.phaseAttempt.phase.phaseId ||
      submission.output.phase.definitionGeneration !==
        context.phaseAttempt.phase.definitionGeneration ||
      submission.output.phase.attempt !== context.phaseAttempt.phase.attempt ||
      submission.output.schemaKey !== declaration.schemaKey ||
      submission.output.schemaResourceDigest !== declaration.schemaResourceDigest ||
      submission.output.byteLength > declaration.maxBytes ||
      submission.output.sensitivity !== declaration.sensitivity ||
      submission.output.graphRevisionDigest !== context.graphRevisionDigest ||
      submission.output.configurationSnapshotDigest !== context.configurationSnapshotDigest ||
      submission.output.inputBindingDigest !== context.phaseInputBinding.bindingDigest
    ) {
      throw new ContextBrokerError(
        "binding-mismatch",
        "Phase output does not match its declared slot, attempt, input, graph, or snapshot",
      );
    }
    if (
      !this.assets.hasCanonicalOutputAsset({
        contentDigest: submission.output.contentDigest,
        byteLength: submission.output.byteLength,
        mediaType: submission.output.mediaType,
        schemaResourceDigest: submission.output.schemaResourceDigest,
        validationReceiptDigest: submission.output.validationReceiptDigest,
      })
    ) {
      throw new ContextBrokerError(
        "binding-mismatch",
        "Phase output canonical asset and validation receipt are not installed",
      );
    }
  }

  deliverCompletionFact(submissionId: string): boolean {
    const pending = this.authority.completionOutbox.get(submissionId);
    if (pending === undefined || pending.delivered || pending.delivering) return false;
    if (this.completionFacts === undefined) return false;
    pending.delivering = true;
    try {
      if (this.completionFacts.admitCompletionFact(pending.fact) === "deferred") return false;
      pending.delivered = true;
      return true;
    } finally {
      pending.delivering = false;
    }
  }

  private requiredDispatch(dispatchId: string): StoredDispatch {
    const stored = this.authority.dispatches.get(dispatchId);
    if (stored === undefined)
      throw new ContextBrokerError("unknown-dispatch", "Worker dispatch is not registered");
    return stored;
  }

  private requireCapability(dispatch: WorkerDispatch, capability: string): void {
    if (!dispatch.capabilities.includes(capability))
      throw new ContextBrokerError(
        "capability-denied",
        `Worker dispatch lacks required capability ${capability}`,
      );
  }

  private assertSubmissionBinding(submission: WorkerSubmission, stored: StoredDispatch): void {
    const dispatch = stored.dispatch;
    if (
      submission.repositoryId !== dispatch.repositoryId ||
      submission.runId !== dispatch.runId ||
      submission.dispatchId !== dispatch.dispatchId ||
      submission.contextId !== dispatch.contextId ||
      submission.contextDigest !== dispatch.contextDigest ||
      submission.principalId !== dispatch.worker.principalId ||
      !sameTask(submission.task as TaskGenerationReference, dispatch.task)
    ) {
      throw new ContextBrokerError(
        "binding-mismatch",
        "Worker submission does not match its exact dispatch, task, context, and principal binding",
      );
    }
  }

  private requestAllowedByGrant(
    request: AssetReadRequest,
    grant: StoredGrant,
    binding: HistoricalAssetBinding,
  ): boolean {
    if (request.type === "chunk") {
      if (grant.envelope.readMode === "pointer") return false;
      return (
        request.length <= grant.envelope.maxChunkBytes &&
        request.offset <= binding.byteLength &&
        request.length <= binding.byteLength - request.offset
      );
    }
    if (grant.envelope.readMode === "chunk") return false;
    return pointerWithin(request.pointer, grant.envelope.allowedPointer);
  }

  private denied(
    grant: StoredGrant,
    request: AssetReadRequest,
    requestDigest: string,
    occurredAt: string,
    denialCode: AssetReadDenialCode,
    chargedOperations: number,
  ): AssetReadResult {
    const receipt = decodeAssetReadAuditReceipt({
      ...receiptBinding(grant, request, requestDigest, occurredAt),
      status: "denied",
      chargedOperations,
      chargedBytes: 0,
      responseBytes: 0,
      remainingOperations: grant.envelope.maxOperations - grant.operationsUsed,
      remainingBytes: grant.envelope.maxBytes - grant.bytesUsed,
      denialCode,
    });
    return Object.freeze({ status: "denied", receipt });
  }

  private deniedUnknown(
    request: AssetReadRequest,
    requestDigest: string,
    occurredAt: string,
    denialCode: "invalid-token" | "request-conflict",
  ): AssetReadResult {
    const receipt = decodeAssetReadAuditReceipt({
      apiVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      requestDigest,
      repositoryId: "repository_unknown",
      runId: "run_unknown",
      dispatchId: "dispatch_unknown",
      contextId: "context_unknown",
      assetBindingId: request.assetBindingId,
      principalId: "principal_unknown",
      status: "denied",
      occurredAt,
      chargedOperations: 0,
      chargedBytes: 0,
      responseBytes: 0,
      remainingOperations: 0,
      remainingBytes: 0,
      denialCode,
    });
    return Object.freeze({ status: "denied", receipt });
  }

  private completeRead(
    storedRead: StoredRead,
    result: AssetReadResult,
    reserved: boolean,
    failureStage?: ContextReadFailureStage,
  ): void {
    const storedResult = cloneReadResult(result);
    storedRead.result = storedResult;
    this.appendReceipt(
      storedResult.receipt,
      storedRead.canonicalReplayKey,
      storedRead.replayKeyDigest,
      storedRead.tokenDigest,
      storedRead.requestDigest,
      reserved,
      failureStage,
    );
  }

  private appendReceipt(
    receipt: AssetReadAuditReceipt,
    canonicalReplayKey: string,
    replayKeyDigest: string,
    tokenDigest: string,
    requestDigest: string,
    reserved: boolean,
    failureStage?: ContextReadFailureStage,
  ): void {
    const receiptCursor = this.authority.receipts.length + 1;
    const failureFact =
      failureStage === undefined
        ? {}
        : {
            failureStage,
            failureFactDigest: digestBytes(
              this.dependencies.sha256,
              canonicalBytes({
                failureStage,
                receiptCursor,
                replayKeyDigest,
                requestDigest,
                tokenDigest,
              }),
            ),
          };
    this.authority.receipts.push(receipt);
    this.authority.receiptAttempts.push(
      deepFreeze({
        receiptCursor,
        canonicalReplayKey,
        replayKeyDigest,
        tokenDigest,
        requestDigest,
        reserved,
        ...failureFact,
        receipt,
      }),
    );
  }

  private resolveGrant(grantToken: string): StoredGrant | undefined {
    const tokenDigest = digestBytes(this.dependencies.sha256, new TextEncoder().encode(grantToken));
    return this.authority.grants.get(tokenDigest);
  }

  private containsIssuedGrantToken(value: unknown): boolean {
    if (typeof value === "string") {
      for (let index = 0; index <= value.length - 43; index += 1) {
        const candidate = value.slice(index, index + 43);
        if (!/^[A-Za-z0-9_-]{43}$/u.test(candidate)) continue;
        const digest = digestBytes(this.dependencies.sha256, new TextEncoder().encode(candidate));
        if (this.authority.grants.has(digest)) return true;
      }
      return false;
    }
    if (Array.isArray(value)) return value.some((entry) => this.containsIssuedGrantToken(entry));
    if (value !== null && typeof value === "object")
      return Object.values(value).some((entry) => this.containsIssuedGrantToken(entry));
    return false;
  }

  private containsGrantTokenDigest(value: unknown, tokenDigest: string): boolean {
    if (typeof value === "string") {
      for (let index = 0; index <= value.length - 43; index += 1) {
        const candidate = value.slice(index, index + 43);
        if (!/^[A-Za-z0-9_-]{43}$/u.test(candidate)) continue;
        const digest = digestBytes(this.dependencies.sha256, new TextEncoder().encode(candidate));
        if (digest === tokenDigest || this.authority.grants.has(digest)) return true;
      }
      return false;
    }
    if (Array.isArray(value))
      return value.some((entry) => this.containsGrantTokenDigest(entry, tokenDigest));
    if (value !== null && typeof value === "object")
      return Object.values(value).some((entry) =>
        this.containsGrantTokenDigest(entry, tokenDigest),
      );
    return false;
  }

  private trustedTime(): string {
    const currentTime = this.dependencies.currentTime();
    validateTimestamp(currentTime, "trusted currentTime");
    return currentTime;
  }

  private appendEvent(
    dispatch: WorkerDispatch,
    eventType: string,
    occurredAt: string,
    payload: JsonValue,
  ): void {
    this.authority.cursor += 1;
    this.authority.events.push(
      deepFreeze({
        cursor: this.authority.cursor,
        eventType,
        occurredAt,
        repositoryId: dispatch.repositoryId,
        runId: dispatch.runId,
        dispatchId: dispatch.dispatchId,
        payload,
      }),
    );
  }
}

function receiptBinding(
  grant: StoredGrant,
  request: AssetReadRequest,
  requestDigest: string,
  occurredAt: string,
) {
  return {
    apiVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    requestDigest,
    repositoryId: grant.envelope.repositoryId,
    runId: grant.envelope.runId,
    dispatchId: grant.envelope.dispatchId,
    contextId: grant.envelope.contextId,
    assetBindingId: grant.envelope.assetBindingId,
    principalId: grant.envelope.principalId,
    occurredAt,
  };
}

function capabilityForSubmission(type: WorkerSubmission["type"]): string {
  switch (type) {
    case "completion":
      return WORKER_CAPABILITIES.completion;
    case "question":
      return WORKER_CAPABILITIES.question;
    case "asset":
      return WORKER_CAPABILITIES.asset;
    case "discovery":
      return WORKER_CAPABILITIES.discovery;
    case "amendment-proposal":
      return WORKER_CAPABILITIES.amendmentProposal;
    case "phase-output":
      return WORKER_CAPABILITIES.phaseOutput;
  }
}

function pointerWithin(pointer: string, allowedPointer: string): boolean {
  const pointerSegments = parseJsonPointer(pointer);
  const allowedSegments = parseJsonPointer(allowedPointer);
  return allowedSegments.every((segment, index) => pointerSegments[index] === segment);
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

export function readCanonicalJsonPointer(
  content: Uint8Array,
  pointer: string,
  maxBytes: number,
): Uint8Array | undefined {
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return undefined;
  }
  let selected = root;
  for (const segment of parseJsonPointer(pointer)) {
    if (Array.isArray(selected)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= selected.length) return undefined;
      selected = selected[index];
    } else if (
      selected !== null &&
      typeof selected === "object" &&
      Object.hasOwn(selected, segment)
    ) {
      selected = (selected as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(canonicalStringify(selected));
  } catch {
    return undefined;
  }
  return bytes.byteLength <= maxBytes ? bytes : undefined;
}

function cloneReadResult(result: AssetReadResult): AssetReadResult {
  return result.status === "served"
    ? Object.freeze({
        status: "served",
        receipt: result.receipt,
        bytes: Uint8Array.from(result.bytes),
      })
    : result;
}

function sameTask(left: TaskGenerationReference, right: TaskGenerationReference): boolean {
  return (
    left.taskId === right.taskId &&
    left.definitionGeneration === right.definitionGeneration &&
    left.contextRevisionDigest === right.contextRevisionDigest
  );
}

function validateDispatchTaskScope(
  value: unknown,
  dispatch: WorkerDispatch,
  context: WorkerContextBase,
): TaskScopeFence {
  const object = exactDurableObject(value, "taskScope", [
    "runId",
    "taskId",
    "definitionGeneration",
    "acceptedContextDigest",
    "fenceGeneration",
  ]);
  const scope = deepFreeze({
    runId: durableString(object.runId, "taskScope.runId"),
    taskId: durableString(object.taskId, "taskScope.taskId"),
    definitionGeneration: nonNegativeSafeInteger(
      object.definitionGeneration,
      "taskScope.definitionGeneration",
    ),
    acceptedContextDigest: sha256DigestValue(
      object.acceptedContextDigest,
      "taskScope.acceptedContextDigest",
    ),
    fenceGeneration: nonNegativeSafeInteger(object.fenceGeneration, "taskScope.fenceGeneration"),
  });
  if (
    scope.runId !== dispatch.runId ||
    scope.taskId !== dispatch.task.taskId ||
    scope.definitionGeneration !== dispatch.task.definitionGeneration ||
    scope.acceptedContextDigest !== context.contextDigest ||
    scope.definitionGeneration < 1 ||
    scope.fenceGeneration < 1
  )
    throw new ContextBrokerError(
      "binding-mismatch",
      "Dispatch task scope does not match its run, task generation, and accepted context",
    );
  return scope;
}

function decodeTaskScopeCurrentness(value: unknown, path: string): TaskScopeCurrentness {
  const object = exactDurableObject(value, path, [
    "runId",
    "taskId",
    "definitionGeneration",
    "acceptedContextDigest",
    "fenceGeneration",
    "claimsAccepted",
  ]);
  const definitionGeneration = nonNegativeSafeInteger(
    object.definitionGeneration,
    `${path}.definitionGeneration`,
  );
  const fenceGeneration = nonNegativeSafeInteger(object.fenceGeneration, `${path}.fenceGeneration`);
  if (definitionGeneration < 1 || fenceGeneration < 1)
    durableFailure(`${path} generations must be positive`);
  if (typeof object.claimsAccepted !== "boolean")
    durableFailure(`${path}.claimsAccepted must be a boolean`);
  return deepFreeze({
    runId: durableString(object.runId, `${path}.runId`),
    taskId: durableString(object.taskId, `${path}.taskId`),
    definitionGeneration,
    acceptedContextDigest: sha256DigestValue(
      object.acceptedContextDigest,
      `${path}.acceptedContextDigest`,
    ),
    fenceGeneration,
    claimsAccepted: object.claimsAccepted,
  });
}

function sameTaskScopeFence(left: TaskScopeFence, right: TaskScopeFence): boolean {
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.definitionGeneration === right.definitionGeneration &&
    left.acceptedContextDigest === right.acceptedContextDigest &&
    left.fenceGeneration === right.fenceGeneration
  );
}

function isHistoricalTaskScopeFence(
  dispatch: TaskScopeFence,
  currentness: TaskScopeCurrentness,
): boolean {
  return (
    dispatch.runId === currentness.runId &&
    dispatch.taskId === currentness.taskId &&
    dispatch.definitionGeneration === currentness.definitionGeneration &&
    dispatch.acceptedContextDigest === currentness.acceptedContextDigest &&
    dispatch.fenceGeneration <= currentness.fenceGeneration
  );
}

function compareTaskScope(left: TaskScope, right: TaskScope): number {
  return (
    compareText(left.runId, right.runId) ||
    compareText(left.taskId, right.taskId) ||
    left.definitionGeneration - right.definitionGeneration
  );
}

function digestBytes(sha256: Sha256, bytes: Uint8Array): string {
  const digest = sha256.digest(bytes);
  if (!isSha256Digest(digest))
    throw new TypeError("SHA-256 implementations must return lowercase hexadecimal digests");
  return digest;
}

function digestReplayKey(sha256: Sha256, canonicalReplayKey: string): string {
  return digestBytes(sha256, new TextEncoder().encode(canonicalReplayKey));
}

function digestReceiptFailureFact(
  sha256: Sha256,
  fact: {
    readonly failureStage: ContextReadFailureStage;
    readonly receiptCursor: number;
    readonly replayKeyDigest: string;
    readonly requestDigest: string;
    readonly tokenDigest: string;
  },
): string {
  return digestBytes(sha256, canonicalBytes(fact));
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += alphabet[(accumulator >>> bits) & 63];
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits > 0) result += alphabet[(accumulator << (6 - bits)) & 63];
  return result;
}

function sensitivityRank(value: ContextGrantEnvelope["sensitivityCeiling"]): number {
  return ["public", "internal", "confidential", "restricted"].indexOf(value);
}

function validateTimestamp(value: string, label: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new TypeError(`${label} must be an exact UTC RFC 3339 timestamp with milliseconds`);
}

interface PersistedAssetReadReplayKeyBase {
  readonly apiVersion: AssetReadRequest["apiVersion"];
  readonly requestId: string;
  readonly tokenDigest: string;
  readonly assetBindingId: string;
}

export type PersistedAssetReadReplayKey =
  | (PersistedAssetReadReplayKeyBase & {
      readonly type: "pointer";
      readonly pointer: string;
      readonly maxBytes: number;
    })
  | (PersistedAssetReadReplayKeyBase & {
      readonly type: "chunk";
      readonly offset: number;
      readonly length: number;
    });

function exactDurableObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return durableFailure(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    return durableFailure(`${label} must contain exactly ${expected.join(", ")}`);
  return value as Readonly<Record<string, unknown>>;
}

function durableObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return durableFailure(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function decodeRegisteredWorkerEffectSeed(
  value: unknown,
  sha256: Sha256,
): RegisteredWorkerEffectSeed | undefined {
  if (value === undefined) return undefined;
  const candidate = durableObject(value, "registered worker effect");
  const record = exactDurableObject(value, "registered worker effect", [
    "input",
    "budgetReservation",
    ...(Object.hasOwn(candidate, "baseRevision") ? ["baseRevision"] : []),
    ...(Object.hasOwn(candidate, "integrationGatePolicyDigest")
      ? ["integrationGatePolicyDigest"]
      : []),
  ]);
  const budget = exactDurableObject(record.budgetReservation, "worker effect budget", [
    "unit",
    "amount",
  ]);
  const unit = durableString(budget.unit, "worker effect budget unit");
  if (unit.length === 0 || unit.length > 128) {
    return durableFailure("worker effect budget unit must be bounded");
  }
  const amount = nonNegativeSafeInteger(budget.amount, "worker effect budget amount");
  if (amount < 1) return durableFailure("worker effect budget amount must be positive");
  const input = decodeCanonicalJsonValue(record.input) as JsonValue;
  const baseRevision =
    record.baseRevision === undefined
      ? undefined
      : bindGitRevision(record.baseRevision, sha256).revision;
  const integrationGatePolicyDigest =
    record.integrationGatePolicyDigest === undefined
      ? undefined
      : sha256DigestValue(
          record.integrationGatePolicyDigest,
          "worker effect integration gate policy digest",
        );
  return deepFreeze({
    input,
    budgetReservation: { unit, amount },
    ...(baseRevision === undefined ? {} : { baseRevision }),
    ...(integrationGatePolicyDigest === undefined ? {} : { integrationGatePolicyDigest }),
  });
}

function durableArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) return durableFailure(`${label} must be an array`);
  return value;
}

function durableString(value: unknown, label: string): string {
  if (typeof value !== "string") return durableFailure(`${label} must be a string`);
  return value;
}

function durableBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return durableFailure(`${label} must be a boolean`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return durableFailure(`${label} must be a non-negative safe integer`);
  return value;
}

function sha256DigestValue(value: unknown, label: string): string {
  if (!isSha256Digest(value)) return durableFailure(`${label} must be a SHA-256 digest`);
  return value;
}

function durableBytes(value: unknown, label: string): Uint8Array {
  const values = durableArray(value, label);
  if (values.length > 65_536) return durableFailure(`${label} exceeds the durable read limit`);
  const bytes = new Uint8Array(values.length);
  for (const [index, byte] of values.entries()) {
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)
      return durableFailure(`${label}[${index}] must be an unsigned byte`);
    bytes[index] = byte;
  }
  return bytes;
}

function assertNoGrantTokenField(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoGrantTokenField(entry, `${path}[${index}]`);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "grantToken") durableFailure(`${path}.${key} is forbidden in durable state`);
    assertNoGrantTokenField(nested, `${path}.${key}`);
  }
}

function assertNoIssuedGrantToken(
  value: unknown,
  grants: ReadonlyMap<string, StoredGrant>,
  sha256: Sha256,
): void {
  if (typeof value === "string") {
    for (let index = 0; index <= value.length - 43; index += 1) {
      const candidate = value.slice(index, index + 43);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(candidate)) continue;
      const digest = digestBytes(sha256, new TextEncoder().encode(candidate));
      if (grants.has(digest)) durableFailure("durable state contains issued grant authority");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoIssuedGrantToken(entry, grants, sha256);
    return;
  }
  if (value !== null && typeof value === "object")
    for (const nested of Object.values(value)) assertNoIssuedGrantToken(nested, grants, sha256);
}

function assertGrantBinding(
  envelope: Omit<ContextGrantEnvelope, "grantToken">,
  stored: StoredDispatch,
  label: string,
): void {
  const { dispatch, context } = stored;
  const binding = context.assets.find(
    ({ assetBindingId }) => assetBindingId === envelope.assetBindingId,
  );
  if (
    envelope.repositoryId !== dispatch.repositoryId ||
    envelope.runId !== dispatch.runId ||
    envelope.dispatchId !== dispatch.dispatchId ||
    !sameTask(envelope.task as TaskGenerationReference, dispatch.task) ||
    envelope.contextId !== context.contextId ||
    envelope.contextDigest !== context.contextDigest ||
    envelope.principalId !== dispatch.worker.principalId ||
    binding === undefined
  )
    durableFailure(`${label} does not match its exact dispatch and asset binding`);
}

export function decodePersistedAssetReadReplayKey(serialized: string): PersistedAssetReadReplayKey {
  const value = decodeCanonicalJsonValue(serialized);
  const base = exactDurableObject(value, "read replay key", [
    "apiVersion",
    "requestId",
    "tokenDigest",
    "assetBindingId",
    "type",
    ...(value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "pointer"
      ? ["pointer", "maxBytes"]
      : ["offset", "length"]),
  ]);
  const tokenDigest = sha256DigestValue(base.tokenDigest, "read replay key tokenDigest");
  const { tokenDigest: _tokenDigest, ...requestWithoutToken } = base;
  const request = decodeAssetReadRequest({
    ...requestWithoutToken,
    grantToken: "A".repeat(43),
  });
  if (canonicalStringify(value) !== serialized)
    durableFailure("read replay key must use exact canonical serialization");
  const { grantToken: _grantToken, ...persistedRequest } = request;
  return Object.freeze({ ...persistedRequest, tokenDigest });
}

function assertReadReceiptBinding(
  receipt: AssetReadAuditReceipt,
  replay: PersistedAssetReadReplayKey,
  requestDigest: string,
  authority: InMemoryContextAuthority,
  label: string,
): void {
  if (receipt.requestId !== replay.requestId || receipt.requestDigest !== requestDigest)
    durableFailure(`${label} receipt does not match its request`);
  const grant = authority.grants.get(replay.tokenDigest);
  if (grant === undefined) {
    if (
      receipt.assetBindingId !== replay.assetBindingId ||
      receipt.status !== "denied" ||
      (receipt.denialCode !== "invalid-token" && receipt.denialCode !== "request-conflict") ||
      receipt.repositoryId !== "repository_unknown" ||
      receipt.runId !== "run_unknown" ||
      receipt.dispatchId !== "dispatch_unknown" ||
      receipt.contextId !== "context_unknown" ||
      receipt.principalId !== "principal_unknown"
    )
      durableFailure(`${label} unknown-token receipt has invalid authority bindings`);
    return;
  }
  if (
    receipt.repositoryId !== grant.envelope.repositoryId ||
    receipt.runId !== grant.envelope.runId ||
    receipt.dispatchId !== grant.envelope.dispatchId ||
    receipt.contextId !== grant.envelope.contextId ||
    receipt.assetBindingId !== grant.envelope.assetBindingId ||
    receipt.principalId !== grant.envelope.principalId
  )
    durableFailure(`${label} receipt does not match its grant`);
}

function assertSubmissionRecordBinding(
  submission: WorkerSubmission,
  stored: StoredDispatch,
  label: string,
): void {
  const { dispatch } = stored;
  if (
    submission.repositoryId !== dispatch.repositoryId ||
    submission.runId !== dispatch.runId ||
    submission.dispatchId !== dispatch.dispatchId ||
    !sameTask(submission.task as TaskGenerationReference, dispatch.task) ||
    submission.contextId !== dispatch.contextId ||
    submission.contextDigest !== dispatch.contextDigest ||
    submission.principalId !== dispatch.worker.principalId
  )
    durableFailure(`${label} does not match its exact dispatch binding`);
}

function decodeSubmissionAdmissionResult(
  value: unknown,
  submission: WorkerSubmission,
  stored: StoredDispatch,
  label: string,
): SubmissionAdmissionResult {
  const hasFact =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "completionFact");
  const hasPhaseOutputFact =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "phaseOutputFact");
  const result = exactDurableObject(value, `${label}.result`, [
    "submissionId",
    "type",
    "status",
    "replayed",
    ...(hasFact ? ["completionFact"] : []),
    ...(hasPhaseOutputFact ? ["phaseOutputFact"] : []),
  ]);
  if (
    result.submissionId !== submission.submissionId ||
    result.type !== submission.type ||
    (result.status !== "accepted" && result.status !== "stale" && result.status !== "duplicate") ||
    result.replayed !== false
  )
    durableFailure(`${label}.result does not match its submission`);
  if (
    result.status === "duplicate" &&
    submission.type !== "completion" &&
    submission.type !== "phase-output"
  ) {
    durableFailure(`${label}.result marks a non-terminal submission as duplicate`);
  }
  let completionFact: CompletionFact | undefined;
  if (hasFact) {
    if (submission.type !== "completion" || result.status !== "accepted")
      durableFailure(`${label}.result has a completion fact for a non-terminal result`);
    const fact = exactDurableObject(result.completionFact, `${label}.result.completionFact`, [
      "submissionId",
      "repositoryId",
      "runId",
      "dispatchId",
      "assessment",
    ]);
    const assessment = reassessCompletionAccounting(
      stored.completionRequirements,
      fact.assessment as Parameters<typeof reassessCompletionAccounting>[1],
    );
    if (
      fact.submissionId !== submission.submissionId ||
      fact.repositoryId !== submission.repositoryId ||
      fact.runId !== submission.runId ||
      fact.dispatchId !== submission.dispatchId ||
      canonicalStringify(assessment.submission) !== canonicalStringify(submission.completion)
    )
      durableFailure(`${label}.result completion fact does not match its submission`);
    completionFact = deepFreeze({
      submissionId: submission.submissionId,
      repositoryId: submission.repositoryId,
      runId: submission.runId,
      dispatchId: submission.dispatchId,
      assessment,
    });
  } else if (submission.type === "completion" && result.status === "accepted") {
    durableFailure(`${label}.result accepted completion is missing its completion fact`);
  }
  let phaseOutputFact: PhaseOutputFact | undefined;
  if (hasPhaseOutputFact) {
    if (submission.type !== "phase-output" || result.status !== "accepted") {
      durableFailure(`${label}.result has a phase output fact for a non-output result`);
    }
    const fact = exactDurableObject(result.phaseOutputFact, `${label}.result.phaseOutputFact`, [
      "submissionId",
      "repositoryId",
      "runId",
      "dispatchId",
      "contextId",
      "contextDigest",
      "producingTask",
      "output",
    ]);
    if (
      fact.submissionId !== submission.submissionId ||
      fact.repositoryId !== submission.repositoryId ||
      fact.runId !== submission.runId ||
      fact.dispatchId !== submission.dispatchId ||
      fact.contextId !== submission.contextId ||
      fact.contextDigest !== submission.contextDigest ||
      canonicalStringify(fact.producingTask) !== canonicalStringify(submission.task) ||
      canonicalStringify(fact.output) !== canonicalStringify(submission.output)
    ) {
      durableFailure(`${label}.result phase output fact does not match its submission`);
    }
    phaseOutputFact = deepFreeze({
      submissionId: submission.submissionId,
      repositoryId: submission.repositoryId,
      runId: submission.runId,
      dispatchId: submission.dispatchId,
      contextId: submission.contextId,
      contextDigest: submission.contextDigest,
      producingTask: submission.task as TaskGenerationReference,
      output: submission.output,
    });
  } else if (submission.type === "phase-output" && result.status === "accepted") {
    durableFailure(`${label}.result accepted phase output is missing its output fact`);
  }
  return deepFreeze({
    submissionId: submission.submissionId,
    type: submission.type,
    status: result.status as SubmissionAdmissionResult["status"],
    replayed: false,
    ...(completionFact === undefined ? {} : { completionFact }),
    ...(phaseOutputFact === undefined ? {} : { phaseOutputFact }),
  });
}

function decodeContextBrokerEvent(
  value: unknown,
  expectedCursor: number,
  authority: InMemoryContextAuthority,
): ContextBrokerEvent {
  const event = exactDurableObject(value, `events[${expectedCursor - 1}]`, [
    "cursor",
    "eventType",
    "occurredAt",
    "repositoryId",
    "runId",
    "dispatchId",
    "payload",
  ]);
  if (event.cursor !== expectedCursor) durableFailure("events must have contiguous cursors");
  const eventType = durableString(event.eventType, `events[${expectedCursor - 1}].eventType`);
  if (
    eventType !== "context-grant-issued" &&
    eventType !== "asset-read-served" &&
    eventType !== "worker-submission-accepted" &&
    eventType !== "worker-submission-stale" &&
    eventType !== "worker-submission-duplicate"
  )
    durableFailure(`events[${expectedCursor - 1}] has an unknown event type`);
  const occurredAt = durableString(event.occurredAt, `events[${expectedCursor - 1}].occurredAt`);
  validateTimestamp(occurredAt, `events[${expectedCursor - 1}].occurredAt`);
  const dispatchId = durableString(event.dispatchId, `events[${expectedCursor - 1}].dispatchId`);
  const stored = authority.dispatches.get(dispatchId);
  if (
    stored === undefined ||
    event.repositoryId !== stored.dispatch.repositoryId ||
    event.runId !== stored.dispatch.runId
  )
    durableFailure(`events[${expectedCursor - 1}] does not match its dispatch`);
  validateContextBrokerEventPayload(eventType, event.payload, authority, expectedCursor - 1);
  return deepFreeze({
    cursor: expectedCursor,
    eventType,
    occurredAt,
    repositoryId: stored.dispatch.repositoryId,
    runId: stored.dispatch.runId,
    dispatchId,
    payload: event.payload as JsonValue,
  });
}

function validateContextBrokerEventPayload(
  eventType: string,
  value: unknown,
  authority: InMemoryContextAuthority,
  index: number,
): void {
  const label = `events[${index}].payload`;
  if (eventType === "context-grant-issued") {
    const payload = exactDurableObject(value, label, [
      "tokenDigest",
      "assetBindingId",
      "issuedAt",
      "expiresAt",
    ]);
    const tokenDigest = sha256DigestValue(payload.tokenDigest, `${label}.tokenDigest`);
    const grant = authority.grants.get(tokenDigest);
    if (
      grant === undefined ||
      payload.assetBindingId !== grant.envelope.assetBindingId ||
      payload.issuedAt !== grant.envelope.issuedAt ||
      payload.expiresAt !== grant.envelope.expiresAt
    )
      durableFailure(`${label} does not match its grant`);
    return;
  }
  if (eventType === "asset-read-served") {
    const payload = exactDurableObject(value, label, [
      "requestId",
      "requestDigest",
      "assetBindingId",
      "responseBytes",
    ]);
    const requestId = durableString(payload.requestId, `${label}.requestId`);
    const read = authority.reads.get(requestId);
    if (
      read === undefined ||
      read.result instanceof Promise ||
      read.result.status !== "served" ||
      payload.requestDigest !== read.requestDigest ||
      payload.assetBindingId !== read.result.receipt.assetBindingId ||
      payload.responseBytes !== read.result.bytes.byteLength
    )
      durableFailure(`${label} does not match its served read`);
    return;
  }
  const payload = exactDurableObject(value, label, ["submissionId", "submissionType"]);
  const submissionId = durableString(payload.submissionId, `${label}.submissionId`);
  const stored = authority.submissions.get(submissionId);
  const expectedStatus = eventType.slice("worker-submission-".length);
  if (
    stored === undefined ||
    payload.submissionType !== stored.submission.type ||
    stored.result.status !== expectedStatus
  )
    durableFailure(`${label} does not match its submission result`);
}

function durableFailure(message: string): never {
  throw new TypeError(`Invalid durable context authority snapshot: ${message}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
