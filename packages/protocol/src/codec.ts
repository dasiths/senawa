import {
  type AmendmentDecisionKind,
  type AnswerQuestionPayload,
  type ApplyApprovedAmendmentPayload,
  type AssuranceLevel,
  type AuthenticatedPrincipal,
  type CapabilityHandshake,
  type CommandEnvelope,
  type CommandIntent,
  type CommandSubmission,
  type DurableReceipt,
  type ErrorEnvelope,
  type EventReplayPage,
  type EventStreamFrame,
  type GrantAllowancePayload,
  type ImportPlanPayload,
  type JsonValue,
  type OpaqueIdentity,
  type OverrideMemberPayload,
  PROTOCOL_VERSION,
  type ProjectionEnvelope,
  type ReceiptPage,
  type ReceiptStatus,
  type RecordAmendmentDecisionPayload,
  type RecordFanOutDiffDecisionPayload,
  type RecordIntegrationBarrierPayload,
  type RecordPhaseAttemptTransitionPayload,
  type RunControlPayload,
  type RunIdentity,
  type StartPhaseAttemptPayload,
  type SteerAgentPayload,
  type SubmitAmendmentProposalPayload,
  type SupervisorAdmissionFacts,
  type SupervisorAllocationFact,
  type SupervisorAllocationKind,
  type SupervisorMode,
  type SupervisorReceipt,
  type SupervisorReceiptStatus,
  type SupervisorServiceRecord,
  type SupervisorWake,
  type SupervisorWakeReason,
  type TaskFrontierStatus,
  type TransportAttribution,
  type TransportKind,
  type WithdrawAmendmentProposalPayload,
} from "./contracts.js";

export const PROTOCOL_LIMITS = Object.freeze({
  maxWireBytes: 262_144,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
  maxStringLength: 65_536,
  maxIdentityLength: 128,
  maxRoles: 32,
  maxRoleLength: 64,
  maxMessageLength: 4_096,
  maxCapabilities: 64,
  maxSupportedVersions: 16,
  maxPageItems: 1_024,
  maxAmendmentTaskScopes: 1_024,
});

export type ProtocolValidationErrorCode =
  | "invalid-json"
  | "oversized"
  | "invalid-type"
  | "invalid-value"
  | "missing-field"
  | "unknown-field";

export class ProtocolValidationError extends Error {
  readonly code: ProtocolValidationErrorCode;
  readonly path: string;

  constructor(code: ProtocolValidationErrorCode, path: string, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.path = path;
  }
}

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const COMMAND_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|command_[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** What a worker context can carry back to the agent, so nothing longer is accepted. */
export const MAX_ANSWER_LENGTH = 4_096;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ROLE_PATTERN = /^[a-z0-9](?:[a-z0-9:-]{0,62}[a-z0-9])?$/;
const TOKEN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^senawa\.dev\/protocol\/v[1-9][0-9]*$/;

const ASSURANCE_LEVELS = new Set<AssuranceLevel>([
  "single-factor",
  "multi-factor",
  "hardware-backed",
]);
const TRANSPORT_KINDS = new Set<TransportKind>(["cli", "http", "runner", "portal", "remote"]);
const INTENT_TYPES = new Set<CommandIntent["type"]>([
  "instantiate-run",
  "start-phase-attempt",
  "accept-graph-revision",
  "submit-completion",
  "evaluate-gate",
  "record-authority-decision",
  "close-phase",
  "record-phase-attempt-transition",
  "import-plan",
  "record-fan-out-diff-decision",
  "submit-amendment-proposal",
  "withdraw-amendment-proposal",
  "record-amendment-decision",
  "apply-approved-amendment",
  "record-integration-barrier",
  "create-escalation",
  "answer-question",
  "steer-agent",
  "override-member",
  "grant-allowance",
  "pause-run",
  "resume-run",
  "end-run",
]);
const RECEIPT_STATUSES = new Set<ReceiptStatus>([
  "queued",
  "claimed",
  "completed",
  "refused",
  "expired",
  "cancelled",
  "unknown-effect",
]);
const SUPERVISOR_ALLOCATION_KINDS = new Set<SupervisorAllocationKind>(["approval", "stream-event"]);
const SUPERVISOR_RECEIPT_STATUSES = new Set<SupervisorReceiptStatus>([
  "queued",
  "claimed",
  "terminal",
]);
const SUPERVISOR_WAKE_REASONS = new Set<SupervisorWakeReason>(["command-accepted"]);
const SUPERVISOR_MODES = new Set<SupervisorMode>(["running", "draining", "drained", "stopped"]);

export function decodeCommandEnvelope(input: string | unknown): CommandEnvelope {
  const value = decodeWireValue(input);
  const object = exactObject(
    value,
    "$",
    [
      "apiVersion",
      "commandId",
      "principal",
      "transport",
      "repositoryId",
      "runId",
      "intent",
      "payload",
      "payloadDigest",
    ],
    ["expectedDefinitionRevision", "expectedGraphRevision", "exactObjectDigest", "expiresAt"],
  );

  protocolVersion(object.apiVersion, "$.apiVersion");
  commandId(object.commandId, "$.commandId");
  const principal = authenticatedPrincipal(object.principal, "$.principal");
  const transport = transportAttribution(object.transport, "$.transport");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  const intent = commandIntent(object.intent, "$.intent");
  const payload = jsonValue(object.payload, "$.payload");
  digest(object.payloadDigest, "$.payloadDigest");
  optional(object, "expectedDefinitionRevision", identity, "$.");
  optional(object, "expectedGraphRevision", identity, "$.");
  optional(object, "exactObjectDigest", digest, "$.");
  optional(object, "expiresAt", timestamp, "$.");

  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    commandId: object.commandId as string,
    principal,
    transport,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    intent,
    payload,
    payloadDigest: object.payloadDigest as string,
    ...optionalField(object, "expectedDefinitionRevision"),
    ...optionalField(object, "expectedGraphRevision"),
    ...optionalField(object, "exactObjectDigest"),
    ...optionalField(object, "expiresAt"),
  });
}

export function encodeCommandEnvelope(input: unknown): string {
  return canonicalStringify(decodeCommandEnvelope(input));
}

export function decodeCommandSubmission(input: string | unknown): CommandSubmission {
  const value = decodeWireValue(input);
  const object = exactObject(
    value,
    "$",
    ["apiVersion", "commandId", "repositoryId", "runId", "intent", "payload", "payloadDigest"],
    ["expectedDefinitionRevision", "expectedGraphRevision", "exactObjectDigest", "expiresAt"],
  );

  protocolVersion(object.apiVersion, "$.apiVersion");
  commandId(object.commandId, "$.commandId");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  const intent = commandIntent(object.intent, "$.intent");
  const payload = jsonValue(object.payload, "$.payload");
  digest(object.payloadDigest, "$.payloadDigest");
  optional(object, "expectedDefinitionRevision", identity, "$.");
  optional(object, "expectedGraphRevision", identity, "$.");
  optional(object, "exactObjectDigest", digest, "$.");
  optional(object, "expiresAt", timestamp, "$.");

  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    commandId: object.commandId as string,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    intent,
    payload,
    payloadDigest: object.payloadDigest as string,
    ...optionalField(object, "expectedDefinitionRevision"),
    ...optionalField(object, "expectedGraphRevision"),
    ...optionalField(object, "exactObjectDigest"),
    ...optionalField(object, "expiresAt"),
  });
}

export function encodeCommandSubmission(input: unknown): string {
  return canonicalStringify(decodeCommandSubmission(input));
}

export function decodeAnswerQuestionPayload(input: string | unknown): AnswerQuestionPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "submissionId",
    "questionDigest",
    "contextDigest",
    "taskId",
    "definitionGeneration",
    "answer",
  ]);
  identity(object.submissionId, "$.submissionId");
  digest(object.questionDigest, "$.questionDigest");
  digest(object.contextDigest, "$.contextDigest");
  identity(object.taskId, "$.taskId");
  positiveSequence(object.definitionGeneration, "$.definitionGeneration");
  // The worker context bounds the text it carries back to the agent. Accepting a
  // longer answer records an immutable decision that can never be delivered,
  // which strands the run with no way to replace it.
  if (typeof object.answer === "string" && object.answer.length > MAX_ANSWER_LENGTH) {
    fail("oversized", "$.answer", `is longer than ${MAX_ANSWER_LENGTH} characters`);
  }
  return Object.freeze({
    submissionId: object.submissionId as string,
    questionDigest: object.questionDigest as string,
    contextDigest: object.contextDigest as string,
    taskId: object.taskId as string,
    definitionGeneration: object.definitionGeneration as number,
    answer: jsonValue(object.answer, "$.answer"),
  });
}

export function encodeAnswerQuestionPayload(input: unknown): string {
  return canonicalStringify(decodeAnswerQuestionPayload(input));
}

export function decodeSteerAgentPayload(input: string | unknown): SteerAgentPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "dispatchId",
    "contextDigest",
    "taskId",
    "definitionGeneration",
    "delivery",
    "instruction",
  ]);
  identity(object.dispatchId, "$.dispatchId");
  digest(object.contextDigest, "$.contextDigest");
  identity(object.taskId, "$.taskId");
  positiveSequence(object.definitionGeneration, "$.definitionGeneration");
  if (
    object.delivery !== "live" &&
    object.delivery !== "queued" &&
    object.delivery !== "abort-retry"
  ) {
    throw new ProtocolValidationError(
      "invalid-value",
      "$.delivery",
      "Steering delivery must be live, queued, or abort-retry",
    );
  }
  // An empty instruction would redirect an agent to nothing while still
  // recording that somebody redirected it, which is worse than refusing.
  if (typeof object.instruction !== "string" || object.instruction.length === 0) {
    throw new ProtocolValidationError(
      "invalid-value",
      "$.instruction",
      "Steering instruction must carry text",
    );
  }
  return Object.freeze({
    dispatchId: object.dispatchId as string,
    contextDigest: object.contextDigest as string,
    taskId: object.taskId as string,
    definitionGeneration: object.definitionGeneration as number,
    delivery: object.delivery,
    instruction: object.instruction,
  });
}

export function encodeSteerAgentPayload(input: unknown): string {
  return canonicalStringify(decodeSteerAgentPayload(input));
}

export function decodeOverrideMemberPayload(input: string | unknown): OverrideMemberPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "dispatchId",
    "taskId",
    "definitionGeneration",
    "reason",
  ]);
  identity(object.dispatchId, "$.dispatchId");
  identity(object.taskId, "$.taskId");
  positiveSequence(object.definitionGeneration, "$.definitionGeneration");
  // An override with no reason records that somebody overrode something and
  // nothing about why, which is the only part anybody will need later.
  if (typeof object.reason !== "string" || object.reason.length === 0) {
    throw new ProtocolValidationError(
      "invalid-value",
      "$.reason",
      "An override must say why the work was accepted",
    );
  }
  return Object.freeze({
    dispatchId: object.dispatchId as string,
    taskId: object.taskId as string,
    definitionGeneration: object.definitionGeneration as number,
    reason: object.reason,
  });
}

export function encodeOverrideMemberPayload(input: unknown): string {
  return canonicalStringify(decodeOverrideMemberPayload(input));
}

export function decodeGrantAllowancePayload(input: string | unknown): GrantAllowancePayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "escalationCommandId",
    "operationId",
    "escalationDigest",
    "policyDigest",
    "unit",
    "expectedLimit",
    "expectedRunModeRevision",
    "increaseBy",
  ]);
  identity(object.escalationCommandId, "$.escalationCommandId");
  identity(object.operationId, "$.operationId");
  digest(object.escalationDigest, "$.escalationDigest");
  digest(object.policyDigest, "$.policyDigest");
  token(object.unit, "$.unit");
  cursor(object.expectedLimit, "$.expectedLimit");
  cursor(object.expectedRunModeRevision, "$.expectedRunModeRevision");
  positiveSequence(object.increaseBy, "$.increaseBy");
  return Object.freeze({
    escalationCommandId: object.escalationCommandId as string,
    operationId: object.operationId as string,
    escalationDigest: object.escalationDigest as string,
    policyDigest: object.policyDigest as string,
    unit: object.unit as string,
    expectedLimit: object.expectedLimit as number,
    expectedRunModeRevision: object.expectedRunModeRevision as number,
    increaseBy: object.increaseBy as number,
  });
}

export function encodeGrantAllowancePayload(input: unknown): string {
  return canonicalStringify(decodeGrantAllowancePayload(input));
}

export function decodeRunControlPayload(input: string | unknown): RunControlPayload {
  const object = exactObject(decodeWireValue(input), "$", ["expectedRunModeRevision"]);
  cursor(object.expectedRunModeRevision, "$.expectedRunModeRevision");
  return Object.freeze({ expectedRunModeRevision: object.expectedRunModeRevision as number });
}

export function encodeRunControlPayload(input: unknown): string {
  return canonicalStringify(decodeRunControlPayload(input));
}

export function decodeStartPhaseAttemptPayload(input: string | unknown): StartPhaseAttemptPayload {
  const object = exactObject(decodeWireValue(input), "$", ["phaseId", "definitionGeneration"]);
  identity(object.phaseId, "$.phaseId");
  if (
    typeof object.definitionGeneration !== "number" ||
    !Number.isSafeInteger(object.definitionGeneration) ||
    object.definitionGeneration < 1
  ) {
    fail("invalid-value", "$.definitionGeneration", "must be a positive safe integer");
  }
  return Object.freeze({
    phaseId: object.phaseId as string,
    definitionGeneration: object.definitionGeneration as number,
  });
}

export function decodeRecordPhaseAttemptTransitionPayload(
  input: string | unknown,
): RecordPhaseAttemptTransitionPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "attemptDigest",
    "transitionDigest",
    "triggerDigest",
    "taskId",
    "definitionGeneration",
    "disposition",
  ]);
  digest(object.attemptDigest, "$.attemptDigest");
  digest(object.transitionDigest, "$.transitionDigest");
  digest(object.triggerDigest, "$.triggerDigest");
  identity(object.taskId, "$.taskId");
  positiveSequence(object.definitionGeneration, "$.definitionGeneration");
  if (
    !["opened", "iterate", "escalate", "fail", "closed", "suspended", "refused"].includes(
      String(object.disposition),
    )
  ) {
    fail("invalid-value", "$.disposition", "must be a phase attempt transition disposition");
  }
  return Object.freeze({
    attemptDigest: object.attemptDigest as string,
    transitionDigest: object.transitionDigest as string,
    triggerDigest: object.triggerDigest as string,
    taskId: object.taskId as string,
    definitionGeneration: object.definitionGeneration as number,
    disposition: object.disposition as RecordPhaseAttemptTransitionPayload["disposition"],
  });
}

export function encodeRecordPhaseAttemptTransitionPayload(input: unknown): string {
  return canonicalStringify(decodeRecordPhaseAttemptTransitionPayload(input));
}

export function decodeImportPlanPayload(input: string | unknown): ImportPlanPayload {
  const object = exactObject(
    decodeWireValue(input),
    "$",
    [
      "attemptDigest",
      "acceptanceDigest",
      "closureDigest",
      "forEachKey",
      "definitionDigest",
      "evaluationDigest",
      "taskSetDigest",
    ],
    ["expectedPriorEvaluationDigest"],
  );
  for (const field of [
    "attemptDigest",
    "acceptanceDigest",
    "closureDigest",
    "definitionDigest",
    "evaluationDigest",
    "taskSetDigest",
  ] as const)
    digest(object[field], `$.${field}`);
  token(object.forEachKey, "$.forEachKey");
  optional(object, "expectedPriorEvaluationDigest", digest, "$.");
  return Object.freeze({
    attemptDigest: object.attemptDigest as string,
    acceptanceDigest: object.acceptanceDigest as string,
    closureDigest: object.closureDigest as string,
    forEachKey: object.forEachKey as string,
    definitionDigest: object.definitionDigest as string,
    evaluationDigest: object.evaluationDigest as string,
    taskSetDigest: object.taskSetDigest as string,
    ...optionalField(object, "expectedPriorEvaluationDigest"),
  });
}

export function encodeImportPlanPayload(input: unknown): string {
  return canonicalStringify(decodeImportPlanPayload(input));
}

export function decodeRecordFanOutDiffDecisionPayload(
  input: string | unknown,
): RecordFanOutDiffDecisionPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "evaluationDigest",
    "priorEvaluationDigest",
    "diffDigest",
    "authorityDigest",
    "changed",
    "removed",
  ]);
  for (const field of [
    "evaluationDigest",
    "priorEvaluationDigest",
    "diffDigest",
    "authorityDigest",
  ] as const)
    digest(object[field], `$.${field}`);
  if (object.changed !== "supersede-changed" || object.removed !== "retain-removed") {
    fail("invalid-value", "$", "fan-out changes must supersede and removals must be retained");
  }
  return Object.freeze({
    evaluationDigest: object.evaluationDigest as string,
    priorEvaluationDigest: object.priorEvaluationDigest as string,
    diffDigest: object.diffDigest as string,
    authorityDigest: object.authorityDigest as string,
    changed: "supersede-changed",
    removed: "retain-removed",
  });
}

export function encodeRecordFanOutDiffDecisionPayload(input: unknown): string {
  return canonicalStringify(decodeRecordFanOutDiffDecisionPayload(input));
}

export function decodeTaskFrontierStatus(input: string | unknown): TaskFrontierStatus {
  const object = exactObject(decodeWireValue(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "attemptDigest",
    "forEachKey",
    "evaluationDigest",
    "taskSetDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "state",
    "selectedCount",
    "effectiveCount",
    "activeCount",
    "completedCount",
    "maxActive",
  ]);
  protocolVersion(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  for (const field of [
    "attemptDigest",
    "evaluationDigest",
    "taskSetDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
  ] as const)
    digest(object[field], `$.${field}`);
  token(object.forEachKey, "$.forEachKey");
  if (
    !["evaluated", "review-required", "proposed", "applied", "complete", "failed"].includes(
      String(object.state),
    )
  ) {
    fail("invalid-value", "$.state", "must be a task-frontier state");
  }
  for (const field of [
    "selectedCount",
    "effectiveCount",
    "activeCount",
    "completedCount",
  ] as const) {
    cursor(object[field], `$.${field}`);
  }
  cursor(object.maxActive, "$.maxActive");
  if ((object.maxActive as number) < 1 || (object.maxActive as number) > 32) {
    fail("invalid-value", "$.maxActive", "must be between 1 and 32");
  }
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    attemptDigest: object.attemptDigest as string,
    forEachKey: object.forEachKey as string,
    evaluationDigest: object.evaluationDigest as string,
    taskSetDigest: object.taskSetDigest as string,
    graphRevisionDigest: object.graphRevisionDigest as string,
    configurationSnapshotDigest: object.configurationSnapshotDigest as string,
    state: object.state as TaskFrontierStatus["state"],
    selectedCount: object.selectedCount as number,
    effectiveCount: object.effectiveCount as number,
    activeCount: object.activeCount as number,
    completedCount: object.completedCount as number,
    maxActive: object.maxActive as number,
  });
}

export function encodeTaskFrontierStatus(input: unknown): string {
  return canonicalStringify(decodeTaskFrontierStatus(input));
}

export function decodeSubmitAmendmentProposalPayload(
  input: string | unknown,
): SubmitAmendmentProposalPayload {
  const object = exactObject(decodeWireValue(input), "$", ["proposal"]);
  return Object.freeze({ proposal: jsonValue(object.proposal, "$.proposal") });
}

export function encodeSubmitAmendmentProposalPayload(input: unknown): string {
  return canonicalStringify(decodeSubmitAmendmentProposalPayload(input));
}

export function decodeWithdrawAmendmentProposalPayload(
  input: string | unknown,
): WithdrawAmendmentProposalPayload {
  const object = exactObject(decodeWireValue(input), "$", ["amendmentId", "proposalDigest"]);
  identity(object.amendmentId, "$.amendmentId");
  digest(object.proposalDigest, "$.proposalDigest");
  return Object.freeze({
    amendmentId: object.amendmentId as string,
    proposalDigest: object.proposalDigest as string,
  });
}

export function encodeWithdrawAmendmentProposalPayload(input: unknown): string {
  return canonicalStringify(decodeWithdrawAmendmentProposalPayload(input));
}

export function decodeRecordAmendmentDecisionPayload(
  input: string | unknown,
): RecordAmendmentDecisionPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "amendmentId",
    "proposalDigest",
    "decision",
    "reviewedResultGraphRevisionDigest",
  ]);
  identity(object.amendmentId, "$.amendmentId");
  digest(object.proposalDigest, "$.proposalDigest");
  if (object.decision !== "approve" && object.decision !== "reject") {
    fail("invalid-value", "$.decision", "must be approve or reject");
  }
  digest(object.reviewedResultGraphRevisionDigest, "$.reviewedResultGraphRevisionDigest");
  return Object.freeze({
    amendmentId: object.amendmentId as string,
    proposalDigest: object.proposalDigest as string,
    decision: object.decision as AmendmentDecisionKind,
    reviewedResultGraphRevisionDigest: object.reviewedResultGraphRevisionDigest as string,
  });
}

export function encodeRecordAmendmentDecisionPayload(input: unknown): string {
  return canonicalStringify(decodeRecordAmendmentDecisionPayload(input));
}

export function decodeApplyApprovedAmendmentPayload(
  input: string | unknown,
): ApplyApprovedAmendmentPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "amendmentId",
    "proposalDigest",
    "decisionDigest",
    "reviewedResultGraphRevisionDigest",
  ]);
  identity(object.amendmentId, "$.amendmentId");
  digest(object.proposalDigest, "$.proposalDigest");
  digest(object.decisionDigest, "$.decisionDigest");
  digest(object.reviewedResultGraphRevisionDigest, "$.reviewedResultGraphRevisionDigest");
  return Object.freeze({
    amendmentId: object.amendmentId as string,
    proposalDigest: object.proposalDigest as string,
    decisionDigest: object.decisionDigest as string,
    reviewedResultGraphRevisionDigest: object.reviewedResultGraphRevisionDigest as string,
  });
}

export function encodeApplyApprovedAmendmentPayload(input: unknown): string {
  return canonicalStringify(decodeApplyApprovedAmendmentPayload(input));
}

export function decodeRecordIntegrationBarrierPayload(
  input: string | unknown,
): RecordIntegrationBarrierPayload {
  const object = exactObject(decodeWireValue(input), "$", [
    "integrationId",
    "configurationSnapshotDigest",
    "barrier",
  ]);
  identity(object.integrationId, "$.integrationId");
  digest(object.configurationSnapshotDigest, "$.configurationSnapshotDigest");
  return Object.freeze({
    integrationId: object.integrationId as string,
    configurationSnapshotDigest: object.configurationSnapshotDigest as string,
    barrier: jsonValue(object.barrier, "$.barrier"),
  });
}

export function encodeRecordIntegrationBarrierPayload(input: unknown): string {
  return canonicalStringify(decodeRecordIntegrationBarrierPayload(input));
}

export function decodeAuthenticatedPrincipal(input: string | unknown): AuthenticatedPrincipal {
  return authenticatedPrincipal(decodeWireValue(input), "$");
}

export function encodeAuthenticatedPrincipal(input: unknown): string {
  return canonicalStringify(decodeAuthenticatedPrincipal(input));
}

export function decodeTransportAttribution(input: string | unknown): TransportAttribution {
  return transportAttribution(decodeWireValue(input), "$");
}

export function encodeTransportAttribution(input: unknown): string {
  return canonicalStringify(decodeTransportAttribution(input));
}

export function decodeRunIdentity(input: string | unknown): RunIdentity {
  const object = exactObject(decodeWireValue(input), "$", ["repositoryId", "runId"]);
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  return Object.freeze({
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
  });
}

export function encodeRunIdentity(input: unknown): string {
  return canonicalStringify(decodeRunIdentity(input));
}

export function validateOpaqueIdentity(value: unknown): OpaqueIdentity {
  identity(value, "$");
  return value as string;
}

export function decodeDurableReceipt(input: string | unknown): DurableReceipt {
  const object = exactObject(
    decodeWireValue(input),
    "$",
    ["apiVersion", "commandId", "repositoryId", "runId", "status", "cursor"],
    ["priorRevision", "resultRevision", "result", "error"],
  );
  protocolVersion(object.apiVersion, "$.apiVersion");
  commandId(object.commandId, "$.commandId");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  enumValue(object.status, "$.status", RECEIPT_STATUSES);
  cursor(object.cursor, "$.cursor");
  optional(object, "priorRevision", identity, "$.");
  optional(object, "resultRevision", identity, "$.");
  const result = Object.hasOwn(object, "result")
    ? { result: jsonValue(object.result, "$.result") }
    : {};
  const error = Object.hasOwn(object, "error")
    ? { error: errorEnvelope(object.error, "$.error") }
    : {};
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    commandId: object.commandId as string,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    status: object.status as ReceiptStatus,
    cursor: object.cursor as number,
    ...optionalField(object, "priorRevision"),
    ...optionalField(object, "resultRevision"),
    ...result,
    ...error,
  });
}

export function encodeDurableReceipt(input: unknown): string {
  return canonicalStringify(decodeDurableReceipt(input));
}

export function decodeReceiptPage(input: string | unknown): ReceiptPage {
  const object = exactObject(decodeWireValue(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "afterCursor",
    "latestCursor",
    "hasMore",
    "receipts",
  ]);
  protocolVersion(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  cursor(object.afterCursor, "$.afterCursor");
  cursor(object.latestCursor, "$.latestCursor");
  if ((object.afterCursor as number) > (object.latestCursor as number)) {
    fail("invalid-value", "$.afterCursor", "must not exceed latestCursor");
  }
  booleanValue(object.hasMore, "$.hasMore");
  const receipts = boundedCursorPageItems(
    object.receipts,
    "$.receipts",
    object.repositoryId as string,
    object.runId as string,
    object.afterCursor as number,
    object.latestCursor as number,
    decodeDurableReceipt,
  );
  validatePageCompletion(
    receipts,
    object.afterCursor as number,
    object.latestCursor as number,
    object.hasMore,
    "$.hasMore",
  );
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    afterCursor: object.afterCursor as number,
    latestCursor: object.latestCursor as number,
    hasMore: object.hasMore,
    receipts,
  });
}

export function encodeReceiptPage(input: unknown): string {
  return canonicalStringify(decodeReceiptPage(input));
}

export function decodeSupervisorAdmissionFacts(input: string | unknown): SupervisorAdmissionFacts {
  const object = exactObject(decodeWireValue(input), "$", ["currentTime", "facts", "allocations"]);
  timestamp(object.currentTime, "$.currentTime");
  const facts = jsonValue(object.facts, "$.facts");
  if (!Array.isArray(object.allocations)) {
    fail("invalid-type", "$.allocations", "must be an array");
  }
  const allocationIds = new Set<string>();
  const allocations = object.allocations.map((value, index): SupervisorAllocationFact => {
    const allocation = exactObject(value, `$.allocations[${index}]`, ["kind", "id"]);
    enumValue(allocation.kind, `$.allocations[${index}].kind`, SUPERVISOR_ALLOCATION_KINDS);
    identity(allocation.id, `$.allocations[${index}].id`);
    if (allocationIds.has(allocation.id as string)) {
      fail("invalid-value", `$.allocations[${index}].id`, "must not duplicate an allocation id");
    }
    allocationIds.add(allocation.id as string);
    return Object.freeze({
      kind: allocation.kind as SupervisorAllocationKind,
      id: allocation.id as string,
    });
  });
  return Object.freeze({
    currentTime: object.currentTime as string,
    facts,
    allocations: Object.freeze(allocations),
  });
}

export function encodeSupervisorAdmissionFacts(input: unknown): string {
  return canonicalStringify(decodeSupervisorAdmissionFacts(input));
}

export function decodeSupervisorReceipt(input: string | unknown): SupervisorReceipt {
  const object = exactObject(
    decodeWireValue(input),
    "$",
    ["sequence", "commandId", "repositoryId", "runId", "status", "recordedAt"],
    ["terminalReceipt"],
  );
  positiveSequence(object.sequence, "$.sequence");
  commandId(object.commandId, "$.commandId");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  enumValue(object.status, "$.status", SUPERVISOR_RECEIPT_STATUSES);
  timestamp(object.recordedAt, "$.recordedAt");
  const terminalReceipt = Object.hasOwn(object, "terminalReceipt")
    ? decodeDurableReceipt(object.terminalReceipt)
    : undefined;
  if ((object.status === "terminal") !== (terminalReceipt !== undefined)) {
    fail(
      "invalid-value",
      "$.terminalReceipt",
      "must be present exactly for terminal supervisor receipts",
    );
  }
  if (
    terminalReceipt !== undefined &&
    (terminalReceipt.commandId !== object.commandId ||
      terminalReceipt.repositoryId !== object.repositoryId ||
      terminalReceipt.runId !== object.runId ||
      terminalReceipt.status === "queued" ||
      terminalReceipt.status === "claimed")
  ) {
    fail(
      "invalid-value",
      "$.terminalReceipt",
      "must be the exact terminal durable receipt for this supervisor receipt",
    );
  }
  return Object.freeze({
    sequence: object.sequence as number,
    commandId: object.commandId as string,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    status: object.status as SupervisorReceiptStatus,
    recordedAt: object.recordedAt as string,
    ...(terminalReceipt === undefined ? {} : { terminalReceipt }),
  });
}

export function encodeSupervisorReceipt(input: unknown): string {
  return canonicalStringify(decodeSupervisorReceipt(input));
}

export function decodeSupervisorWake(input: string | unknown): SupervisorWake {
  const object = exactObject(decodeWireValue(input), "$", [
    "repositoryId",
    "runId",
    "generation",
    "acknowledgedGeneration",
    "notBefore",
    "reasons",
  ]);
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  cursor(object.generation, "$.generation");
  cursor(object.acknowledgedGeneration, "$.acknowledgedGeneration");
  if ((object.acknowledgedGeneration as number) > (object.generation as number)) {
    fail("invalid-value", "$.acknowledgedGeneration", "must not exceed generation");
  }
  timestamp(object.notBefore, "$.notBefore");
  const reasons = sortedStringSet(
    object.reasons,
    "$.reasons",
    SUPERVISOR_WAKE_REASONS.size,
    (value, path) => enumValue(value, path, SUPERVISOR_WAKE_REASONS),
  ) as readonly SupervisorWakeReason[];
  return Object.freeze({
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    generation: object.generation as number,
    acknowledgedGeneration: object.acknowledgedGeneration as number,
    notBefore: object.notBefore as string,
    reasons,
  });
}

export function encodeSupervisorWake(input: unknown): string {
  return canonicalStringify(decodeSupervisorWake(input));
}

export function decodeSupervisorServiceRecord(input: string | unknown): SupervisorServiceRecord {
  const object = exactObject(decodeWireValue(input), "$", ["mode", "changedAt"]);
  enumValue(object.mode, "$.mode", SUPERVISOR_MODES);
  timestamp(object.changedAt, "$.changedAt");
  return Object.freeze({
    mode: object.mode as SupervisorMode,
    changedAt: object.changedAt as string,
  });
}

export function encodeSupervisorServiceRecord(input: unknown): string {
  return canonicalStringify(decodeSupervisorServiceRecord(input));
}

export function decodeEventStreamFrame(input: string | unknown): EventStreamFrame {
  const object = exactObject(
    decodeWireValue(input),
    "$",
    [
      "apiVersion",
      "cursor",
      "repositoryId",
      "runId",
      "eventId",
      "eventType",
      "occurredAt",
      "payload",
      "payloadDigest",
    ],
    ["commandId"],
  );
  protocolVersion(object.apiVersion, "$.apiVersion");
  cursor(object.cursor, "$.cursor");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  identity(object.eventId, "$.eventId");
  token(object.eventType, "$.eventType");
  timestamp(object.occurredAt, "$.occurredAt");
  const payload = jsonValue(object.payload, "$.payload");
  digest(object.payloadDigest, "$.payloadDigest");
  optional(object, "commandId", commandId, "$.");
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    cursor: object.cursor as number,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    eventId: object.eventId as string,
    eventType: object.eventType as string,
    occurredAt: object.occurredAt as string,
    payload,
    payloadDigest: object.payloadDigest as string,
    ...optionalField(object, "commandId"),
  });
}

export function encodeEventStreamFrame(input: unknown): string {
  return canonicalStringify(decodeEventStreamFrame(input));
}

export function decodeEventReplayPage(input: string | unknown): EventReplayPage {
  const object = exactObject(decodeWireValue(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "afterCursor",
    "earliestAvailableCursor",
    "latestCursor",
    "hasMore",
    "events",
  ]);
  protocolVersion(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  cursor(object.afterCursor, "$.afterCursor");
  cursor(object.earliestAvailableCursor, "$.earliestAvailableCursor");
  cursor(object.latestCursor, "$.latestCursor");
  if ((object.earliestAvailableCursor as number) > (object.latestCursor as number)) {
    fail("invalid-value", "$.earliestAvailableCursor", "must not exceed latestCursor");
  }
  if ((object.afterCursor as number) > (object.latestCursor as number)) {
    fail("invalid-value", "$.afterCursor", "must not exceed latestCursor");
  }
  if (
    (object.earliestAvailableCursor as number) > 0 &&
    (object.afterCursor as number) < (object.earliestAvailableCursor as number) - 1
  ) {
    fail("invalid-value", "$.afterCursor", "must not precede the available replay range");
  }
  booleanValue(object.hasMore, "$.hasMore");
  const events = boundedCursorPageItems(
    object.events,
    "$.events",
    object.repositoryId as string,
    object.runId as string,
    object.afterCursor as number,
    object.latestCursor as number,
    decodeEventStreamFrame,
  );
  validatePageCompletion(
    events,
    object.afterCursor as number,
    object.latestCursor as number,
    object.hasMore,
    "$.hasMore",
  );
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    afterCursor: object.afterCursor as number,
    earliestAvailableCursor: object.earliestAvailableCursor as number,
    latestCursor: object.latestCursor as number,
    hasMore: object.hasMore,
    events,
  });
}

export function encodeEventReplayPage(input: unknown): string {
  return canonicalStringify(decodeEventReplayPage(input));
}

export function decodeProjectionEnvelope(input: string | unknown): ProjectionEnvelope {
  const object = exactObject(decodeWireValue(input), "$", [
    "apiVersion",
    "cursor",
    "repositoryId",
    "runId",
    "projectionType",
    "revision",
    "generatedAt",
    "payload",
    "payloadDigest",
  ]);
  protocolVersion(object.apiVersion, "$.apiVersion");
  cursor(object.cursor, "$.cursor");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  token(object.projectionType, "$.projectionType");
  identity(object.revision, "$.revision");
  timestamp(object.generatedAt, "$.generatedAt");
  const payload = jsonValue(object.payload, "$.payload");
  digest(object.payloadDigest, "$.payloadDigest");
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    cursor: object.cursor as number,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    projectionType: object.projectionType as string,
    revision: object.revision as string,
    generatedAt: object.generatedAt as string,
    payload,
    payloadDigest: object.payloadDigest as string,
  });
}

export function encodeProjectionEnvelope(input: unknown): string {
  return canonicalStringify(decodeProjectionEnvelope(input));
}

export function decodeCapabilityHandshake(input: string | unknown): CapabilityHandshake {
  const object = exactObject(decodeWireValue(input), "$", [
    "apiVersion",
    "peerId",
    "supportedVersions",
    "capabilities",
  ]);
  protocolVersion(object.apiVersion, "$.apiVersion");
  identity(object.peerId, "$.peerId");
  const supportedVersions = sortedStringSet(
    object.supportedVersions,
    "$.supportedVersions",
    PROTOCOL_LIMITS.maxSupportedVersions,
    version,
  );
  if (!supportedVersions.includes(PROTOCOL_VERSION)) {
    fail("invalid-value", "$.supportedVersions", `must include ${PROTOCOL_VERSION}`);
  }
  const capabilities = sortedStringSet(
    object.capabilities,
    "$.capabilities",
    PROTOCOL_LIMITS.maxCapabilities,
    token,
  );
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    peerId: object.peerId as string,
    supportedVersions,
    capabilities,
  });
}

export function encodeCapabilityHandshake(input: unknown): string {
  return canonicalStringify(decodeCapabilityHandshake(input));
}

export function decodeErrorEnvelope(input: string | unknown): ErrorEnvelope {
  return errorEnvelope(decodeWireValue(input), "$.");
}

export function encodeErrorEnvelope(input: unknown): string {
  return canonicalStringify(decodeErrorEnvelope(input));
}

/**
 * Validates a value that has already been decoded from the wire.
 *
 * `decodeCanonicalJsonValue` reads a string as JSON text. A field that is
 * already a JSON value must not go through it, or a value that happens to be a
 * string is parsed a second time and refused for not being JSON.
 */
export function decodeDecodedJsonValue(input: unknown): JsonValue {
  return snapshotJsonValue(input, "$", { depth: 0, nodes: 0 });
}

export function canonicalStringify(input: unknown): string {
  const value = snapshotJsonValue(input, "$", { depth: 0, nodes: 0 });
  const encoded = serialize(value);
  if (utf8Length(encoded) > PROTOCOL_LIMITS.maxWireBytes) {
    fail("oversized", "$", `wire value exceeds ${PROTOCOL_LIMITS.maxWireBytes} bytes`);
  }
  return encoded;
}

export function canonicalBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(input));
}

export function decodeCanonicalJsonValue(input: string | unknown): JsonValue {
  return decodeWireValue(input);
}

/**
 * Reads canonical JSON that a process wrote for itself.
 *
 * The wire ceilings bound what an untrusted peer may send in one message. A
 * run's durable state is neither a message nor untrusted, and applying the wire
 * ceilings to it was a category error with a live consequence: a run that had
 * made seventeen dispatches could no longer persist an eighteenth, and a run
 * that cannot record anything is a worse failure than one that stops.
 *
 * The bound is still a bound. An unreadable file must not be able to exhaust
 * memory, so durable state gets ceilings of its own, sized for a long run
 * rather than for a request.
 */
export function decodeDurableJsonValue(input: string): JsonValue {
  return decodeValueWithin(input, DURABLE_STATE_LIMITS);
}

/** Serializes state a process is writing for itself, against the same ceilings. */
export function durableStringify(input: unknown): string {
  const value = snapshotJsonValue(input, "$", {
    depth: 0,
    nodes: 0,
    maxNodes: DURABLE_STATE_LIMITS.maxJsonNodes,
  });
  const encoded = serialize(value);
  if (utf8Length(encoded) > DURABLE_STATE_LIMITS.maxBytes) {
    fail("oversized", "$", `durable value exceeds ${DURABLE_STATE_LIMITS.maxBytes} bytes`);
  }
  return encoded;
}

/** What one process may write for itself and read back. */
export const DURABLE_STATE_LIMITS = Object.freeze({
  maxBytes: 67_108_864,
  maxJsonNodes: 4_000_000,
});

function authenticatedPrincipal(value: unknown, path: string): AuthenticatedPrincipal {
  const object = exactObject(value, path, ["issuer", "subject", "tenant", "assurance", "roles"]);
  boundedString(object.issuer, `${path}.issuer`, 1, 512);
  boundedString(object.subject, `${path}.subject`, 1, 512);
  identity(object.tenant, `${path}.tenant`);
  enumValue(object.assurance, `${path}.assurance`, ASSURANCE_LEVELS);
  if (!Array.isArray(object.roles)) {
    fail("invalid-type", `${path}.roles`, "must be an array");
  }
  if (object.roles.length > PROTOCOL_LIMITS.maxRoles) {
    fail("oversized", `${path}.roles`, `must contain at most ${PROTOCOL_LIMITS.maxRoles} roles`);
  }
  const roles: string[] = [];
  for (const [index, role] of object.roles.entries()) {
    boundedString(role, `${path}.roles[${index}]`, 1, PROTOCOL_LIMITS.maxRoleLength);
    if (!ROLE_PATTERN.test(role as string)) {
      fail("invalid-value", `${path}.roles[${index}]`, "must be a lowercase role token");
    }
    if (roles.includes(role as string)) {
      fail("invalid-value", `${path}.roles[${index}]`, "must not duplicate a role");
    }
    const priorRole = roles.at(-1);
    if (priorRole !== undefined && priorRole >= (role as string)) {
      fail("invalid-value", `${path}.roles`, "must be sorted lexicographically");
    }
    roles.push(role as string);
  }
  return Object.freeze({
    issuer: object.issuer as string,
    subject: object.subject as string,
    tenant: object.tenant as string,
    assurance: object.assurance as AssuranceLevel,
    roles: Object.freeze(roles),
  });
}

function transportAttribution(value: unknown, path: string): TransportAttribution {
  const object = exactObject(value, path, ["kind", "requestId"]);
  enumValue(object.kind, `${path}.kind`, TRANSPORT_KINDS);
  identity(object.requestId, `${path}.requestId`);
  return Object.freeze({
    kind: object.kind as TransportKind,
    requestId: object.requestId as string,
  });
}

function commandIntent(value: unknown, path: string): CommandIntent {
  const object = exactObject(value, path, ["type"]);
  enumValue(object.type, `${path}.type`, INTENT_TYPES);
  return Object.freeze({ type: object.type as CommandIntent["type"] });
}

function errorEnvelope(value: unknown, path: string): ErrorEnvelope {
  const rootPath = path.endsWith(".") ? path.slice(0, -1) : path;
  const object = exactObject(
    value,
    rootPath,
    ["apiVersion", "code", "message", "retryable"],
    ["commandId", "details"],
  );
  protocolVersion(object.apiVersion, `${rootPath}.apiVersion`);
  token(object.code, `${rootPath}.code`);
  boundedString(object.message, `${rootPath}.message`, 1, PROTOCOL_LIMITS.maxMessageLength);
  if (typeof object.retryable !== "boolean") {
    fail("invalid-type", `${rootPath}.retryable`, "must be a boolean");
  }
  optional(object, "commandId", commandId, `${rootPath}.`);
  const details = Object.hasOwn(object, "details")
    ? { details: jsonValue(object.details, `${rootPath}.details`) }
    : {};
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    code: object.code as string,
    message: object.message as string,
    retryable: object.retryable,
    ...optionalField(object, "commandId"),
    ...details,
  });
}

function decodeWireValue(input: string | unknown): JsonValue {
  if (typeof input === "string") {
    if (utf8Length(input) > PROTOCOL_LIMITS.maxWireBytes) {
      fail("oversized", "$", `wire input exceeds ${PROTOCOL_LIMITS.maxWireBytes} bytes`);
    }
    try {
      const value = snapshotJsonValue(JSON.parse(input), "$", { depth: 0, nodes: 0 });
      if (serialize(value) !== input) {
        fail("invalid-json", "$", "must use canonical JSON encoding without duplicate keys");
      }
      return value;
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        throw error;
      }
      fail("invalid-json", "$", "must contain one valid JSON value");
    }
  }
  const value = snapshotJsonValue(input, "$", { depth: 0, nodes: 0 });
  if (utf8Length(serialize(value)) > PROTOCOL_LIMITS.maxWireBytes) {
    fail("oversized", "$", `wire value exceeds ${PROTOCOL_LIMITS.maxWireBytes} bytes`);
  }
  return value;
}

function decodeValueWithin(
  input: string,
  limits: { readonly maxBytes: number; readonly maxJsonNodes: number },
): JsonValue {
  if (utf8Length(input) > limits.maxBytes) {
    fail("oversized", "$", `durable input exceeds ${limits.maxBytes} bytes`);
  }
  try {
    const value = snapshotJsonValue(JSON.parse(input), "$", {
      depth: 0,
      nodes: 0,
      maxNodes: limits.maxJsonNodes,
    });
    if (serialize(value) !== input) {
      fail("invalid-json", "$", "must use canonical JSON encoding without duplicate keys");
    }
    return value;
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    fail("invalid-json", "$", "must contain one valid JSON value");
  }
}

function snapshotJsonValue(
  value: unknown,
  path: string,
  budget: { depth: number; nodes: number; maxNodes?: number },
  ancestors = new Set<object>(),
): JsonValue {
  const maxNodes = budget.maxNodes ?? PROTOCOL_LIMITS.maxJsonNodes;
  budget.nodes += 1;
  if (budget.nodes > maxNodes) {
    fail("oversized", path, `JSON value exceeds ${maxNodes} nodes`);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    boundedString(value, path, 0, PROTOCOL_LIMITS.maxStringLength);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid-value", path, "numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    fail("invalid-type", path, "must contain only JSON values");
  }
  if (budget.depth >= PROTOCOL_LIMITS.maxJsonDepth) {
    fail("oversized", path, `JSON value exceeds depth ${PROTOCOL_LIMITS.maxJsonDepth}`);
  }
  if (ancestors.has(value)) {
    fail("invalid-value", path, "must not contain cycles");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail("invalid-type", path, "objects must have a plain or null prototype");
  }
  ancestors.add(value);
  budget.depth += 1;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      return snapshotArray(descriptors, path, budget, ancestors);
    }
    const result: Record<string, JsonValue> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        fail("invalid-type", path, "objects must not contain symbol keys");
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        fail("invalid-type", `${path}.${key}`, "properties must be enumerable data properties");
      }
      result[key] = snapshotJsonValue(descriptor.value, `${path}.${key}`, budget, ancestors);
    }
    return Object.freeze(result);
  } finally {
    budget.depth -= 1;
    ancestors.delete(value);
  }
}

function snapshotArray(
  descriptors: PropertyDescriptorMap,
  path: string,
  budget: { depth: number; nodes: number; maxNodes?: number },
  ancestors: Set<object>,
): JsonValue {
  const length = descriptors.length?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) {
    fail("invalid-type", path, "arrays must be dense and contain no extra properties");
  }
  const result: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail("invalid-type", `${path}[${index}]`, "array entries must be enumerable data properties");
    }
    result.push(snapshotJsonValue(descriptor.value, `${path}[${index}]`, budget, ancestors));
  }
  return Object.freeze(result);
}

function jsonValue(value: unknown, path: string): JsonValue {
  return snapshotJsonValue(value, path, { depth: 0, nodes: 0 });
}

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optionalFields: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-type", path, "must be an object");
  }
  const object = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optionalFields]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail("unknown-field", `${path}.${key}`, "is not allowed");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      fail("missing-field", `${path}.${key}`, "is required");
    }
  }
  return object;
}

function optional(
  object: Readonly<Record<string, unknown>>,
  key: string,
  validator: (value: unknown, path: string) => void,
  pathPrefix: string,
): void {
  if (Object.hasOwn(object, key)) {
    validator(object[key], `${pathPrefix}${key}`);
  }
}

function optionalField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  return Object.hasOwn(object, key) ? { [key]: object[key] as string } : {};
}

function protocolVersion(value: unknown, path: string): void {
  if (value !== PROTOCOL_VERSION) {
    fail("invalid-value", path, `must equal ${PROTOCOL_VERSION}`);
  }
}

function commandId(value: unknown, path: string): void {
  boundedString(value, path, 1, PROTOCOL_LIMITS.maxIdentityLength);
  if (!COMMAND_ID_PATTERN.test(value as string)) {
    fail("invalid-value", path, "must be a lowercase RFC 4122 UUID or command_ identity");
  }
}

function identity(value: unknown, path: string): void {
  boundedString(value, path, 1, PROTOCOL_LIMITS.maxIdentityLength);
  if (!IDENTITY_PATTERN.test(value as string)) {
    fail("invalid-value", path, "must be an opaque ASCII identity token");
  }
}

function digest(value: unknown, path: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("invalid-value", path, "must be 64 lowercase hexadecimal characters");
  }
}

function timestamp(value: unknown, path: string): void {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    fail("invalid-value", path, "must be a valid UTC RFC 3339 timestamp");
  }
  const millisecondTimestamp = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  try {
    if (new Date(value).toISOString() !== millisecondTimestamp) {
      fail("invalid-value", path, "must be a valid UTC RFC 3339 timestamp");
    }
  } catch {
    fail("invalid-value", path, "must be a valid UTC RFC 3339 timestamp");
  }
}

function cursor(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid-value", path, "must be a non-negative safe integer");
  }
}

function booleanValue(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    fail("invalid-type", path, "must be a boolean");
  }
}

function boundedCursorPageItems<
  Item extends {
    readonly cursor: number;
    readonly repositoryId: string;
    readonly runId: string;
  },
>(
  value: unknown,
  path: string,
  repositoryId: string,
  runId: string,
  afterCursor: number,
  latestCursor: number,
  decoder: (input: unknown) => Item,
): readonly Item[] {
  if (!Array.isArray(value)) {
    fail("invalid-type", path, "must be an array");
  }
  if (value.length > PROTOCOL_LIMITS.maxPageItems) {
    fail("oversized", path, `must contain at most ${PROTOCOL_LIMITS.maxPageItems} entries`);
  }
  const items: Item[] = [];
  let priorCursor = afterCursor;
  for (const [index, entry] of value.entries()) {
    const item = decoder(entry);
    if (item.repositoryId !== repositoryId || item.runId !== runId) {
      fail("invalid-value", `${path}[${index}]`, "must match the page repository and run identity");
    }
    if (item.cursor <= priorCursor) {
      fail(
        "invalid-value",
        `${path}[${index}].cursor`,
        "must be strictly increasing after afterCursor",
      );
    }
    if (item.cursor > latestCursor) {
      fail("invalid-value", `${path}[${index}].cursor`, "must not exceed latestCursor");
    }
    priorCursor = item.cursor;
    items.push(item);
  }
  return Object.freeze(items);
}

function validatePageCompletion<Item extends { readonly cursor: number }>(
  items: readonly Item[],
  afterCursor: number,
  latestCursor: number,
  hasMore: boolean,
  path: string,
): void {
  const finalCursor = items.at(-1)?.cursor;
  if (hasMore && finalCursor === undefined) {
    fail("invalid-value", path, "must be false for an empty page");
  }
  if (hasMore && (afterCursor >= latestCursor || finalCursor === latestCursor)) {
    fail("invalid-value", path, "must be false when the page reaches latestCursor");
  }
}

function positiveSequence(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("invalid-value", path, "must be a positive safe integer");
  }
}

function token(value: unknown, path: string): void {
  boundedString(value, path, 1, 64);
  if (!TOKEN_PATTERN.test(value as string)) {
    fail("invalid-value", path, "must be a lowercase token");
  }
}

function version(value: unknown, path: string): void {
  boundedString(value, path, 1, 128);
  if (!VERSION_PATTERN.test(value as string)) {
    fail("invalid-value", path, "must be a Senawa protocol version");
  }
}

function sortedStringSet(
  value: unknown,
  path: string,
  maximumItems: number,
  validator: (value: unknown, path: string) => void,
): readonly string[] {
  if (!Array.isArray(value)) {
    fail("invalid-type", path, "must be an array");
  }
  if (value.length === 0 || value.length > maximumItems) {
    fail("oversized", path, `must contain 1-${maximumItems} entries`);
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    validator(entry, `${path}[${index}]`);
    const priorEntry = result.at(-1);
    if (priorEntry !== undefined && priorEntry >= (entry as string)) {
      fail("invalid-value", path, "must be sorted and contain no duplicates");
    }
    result.push(entry as string);
  }
  return Object.freeze(result);
}

function boundedString(
  value: unknown,
  path: string,
  minimumLength: number,
  maximumLength: number,
): void {
  if (typeof value !== "string") {
    fail("invalid-type", path, "must be a string");
  }
  if (value.length < minimumLength || value.length > maximumLength) {
    fail("oversized", path, `must contain ${minimumLength}-${maximumLength} UTF-16 code units`);
  }
  if (!hasWellFormedUtf16(value)) {
    fail("invalid-value", path, "must not contain unpaired UTF-16 surrogates");
  }
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function enumValue<Value extends string>(
  value: unknown,
  path: string,
  accepted: ReadonlySet<Value>,
): void {
  if (typeof value !== "string" || !accepted.has(value as Value)) {
    fail("invalid-value", path, `must be one of ${[...accepted].join(", ")}`);
  }
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fail(code: ProtocolValidationErrorCode, path: string, message: string): never {
  throw new ProtocolValidationError(code, path, `${path} ${message}`);
}
