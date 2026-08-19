import {
  canonicalStringify,
  decodeCanonicalJsonValue,
  decodeDurableReceipt,
  decodeEventStreamFrame,
  PROTOCOL_LIMITS,
  ProtocolValidationError,
} from "./codec.js";
import { type JsonValue, PROTOCOL_VERSION } from "./contracts.js";
import {
  PORTAL_LIMITS,
  type PortalActivityDirection,
  type PortalAgentPage,
  type PortalAgentSummary,
  type PortalAllowanceReview,
  type PortalArtifactAvailability,
  type PortalArtifactContent,
  type PortalArtifactMetadata,
  type PortalArtifactPage,
  type PortalArtifactSource,
  type PortalDeliveryPage,
  type PortalDeliveryRecord,
  type PortalDeliveryRecordKind,
  type PortalEventWindow,
  type PortalFreshDispatchRequirement,
  type PortalGraphEdge,
  type PortalGraphEdgeKind,
  type PortalGraphEdgePage,
  type PortalGraphNode,
  type PortalGraphNodeKind,
  type PortalGraphNodePage,
  type PortalGraphNodeRunState,
  type PortalGraphSummary,
  type PortalHumanNeed,
  type PortalHumanNeedKind,
  type PortalHumanNeedPage,
  type PortalImmutableRecord,
  type PortalIntegrationDiagnostic,
  type PortalIntegrationPage,
  type PortalIntegrationSummary,
  type PortalQuestionAnswer,
  type PortalQuestionPage,
  type PortalQuestionRecord,
  type PortalQuestionSource,
  type PortalReceiptWindow,
  type PortalRecordKind,
  type PortalRepositoryPage,
  type PortalRepositorySummary,
  type PortalRunCounts,
  type PortalRunMode,
  type PortalRunOverview,
  type PortalRunPage,
  type PortalRunSummary,
  type PortalSessionDescriptor,
  type PortalSyncVector,
  type PortalTranscriptOwner,
  type PortalTranscriptOwnerKind,
  type PortalTranscriptPage,
  type PortalTranscriptRecord,
  type PortalTranscriptStream,
  type PortalWorkspacePage,
  type PortalWorkspaceSummary,
  TRANSCRIPT_LIMITS,
} from "./portal-contracts.js";
import type { AssetSensitivity } from "./worker-contracts.js";

const IDENTITY = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const TOKEN = /^[a-z0-9](?:[a-z0-9:-]{0,126}[a-z0-9])?$/;
const CONSUMER_KEY = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUN_MODES = new Set<PortalRunMode>(["running", "paused", "ending", "ended"]);
const NODE_KINDS = new Set<PortalGraphNodeKind>(["workflow", "phase", "task", "criterion"]);
const NODE_RUN_STATES = new Set<PortalGraphNodeRunState>([
  "not-started",
  "running",
  "awaiting-human",
  "accepted",
  "failed",
  "superseded",
]);
const EDGE_KINDS = new Set<PortalGraphEdgeKind>(["containment", "dependency", "supersession"]);
const RECORD_KINDS = new Set<PortalRecordKind>([
  "candidate",
  "gate",
  "decision",
  "closure",
  "escalation",
]);
const NEED_KINDS = new Set<PortalHumanNeedKind>([
  "question",
  "candidate-approval",
  "amendment-decision",
  "amendment-application",
  "escalation",
  "integration-conflict",
  "integration-rework",
  "ending-uncertain",
]);
const ASSET_SOURCES = new Set<PortalArtifactSource>(["worker", "completion-evidence", "installed"]);
const ASSET_AVAILABILITIES = new Set<PortalArtifactAvailability>([
  "metadata-only",
  "verified-stored",
]);
const SENSITIVITIES = new Set<AssetSensitivity>([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const ACTIVITY_DIRECTIONS = new Set<PortalActivityDirection>(["tail", "after", "before"]);
const DELIVERY_KINDS = new Set<PortalDeliveryRecordKind>([
  "phase-attempt",
  "phase-transition",
  "phase-output",
  "fan-out-evaluation",
  "generated-task",
  "plan-import",
]);
const TRANSCRIPT_OWNER_KINDS = new Set<PortalTranscriptOwnerKind>([
  "dispatch",
  "task",
  "phase",
  "run",
]);
const TRANSCRIPT_STREAMS = new Set<PortalTranscriptStream>(["stdout", "stderr", "system"]);
const TRANSCRIPT_TAB = 0x09;
const TRANSCRIPT_SPACE = 0x20;
const TRANSCRIPT_DELETE = 0x7f;
const C1_FIRST = 0x80;
const C1_LAST = 0x9f;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

export function decodePortalSessionDescriptor(input: string | unknown): PortalSessionDescriptor {
  const object = exact(wire(input), "$", ["apiVersion", "expiresAt", "csrfMode", "capabilities"]);
  version(object.apiVersion, "$.apiVersion");
  timestamp(object.expiresAt, "$.expiresAt");
  oneOf(object.csrfMode, "$.csrfMode", new Set(["available", "read-only"]));
  const capabilities = sortedTokens(
    object.capabilities,
    "$.capabilities",
    PROTOCOL_LIMITS.maxCapabilities,
  );
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    expiresAt: object.expiresAt as string,
    csrfMode: object.csrfMode as PortalSessionDescriptor["csrfMode"],
    capabilities,
  });
}

export function encodePortalSessionDescriptor(input: unknown): string {
  return canonicalStringify(decodePortalSessionDescriptor(input));
}

export function decodePortalRepositoryPage(input: string | unknown): PortalRepositoryPage {
  const object = exact(wire(input), "$", ["apiVersion", "hasMore", "repositories"], ["after"]);
  version(object.apiVersion, "$.apiVersion");
  optional(object, "after", identity, "$");
  bool(object.hasMore, "$.hasMore");
  const repositories = page(
    object.repositories,
    "$.repositories",
    PORTAL_LIMITS.maxDiscoveryItems,
    repositorySummary,
  );
  lexicalPage(
    repositories,
    object.after as string | undefined,
    (item) => item.repositoryId,
    "$.repositories",
  );
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    ...copyOptionalString(object, "after"),
    hasMore: object.hasMore as boolean,
    repositories,
  });
}

export function encodePortalRepositoryPage(input: unknown): string {
  return canonicalStringify(decodePortalRepositoryPage(input));
}

export function decodePortalRunPage(input: string | unknown): PortalRunPage {
  const object = exact(
    wire(input),
    "$",
    ["apiVersion", "repositoryId", "hasMore", "runs"],
    ["after"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  optional(object, "after", identity, "$");
  bool(object.hasMore, "$.hasMore");
  const runs = page(object.runs, "$.runs", PORTAL_LIMITS.maxDiscoveryItems, runSummary);
  lexicalPage(runs, object.after as string | undefined, (item) => item.runId, "$.runs");
  for (const [index, run] of runs.entries())
    if (run.repositoryId !== object.repositoryId)
      fail("invalid-value", `$.runs[${index}].repositoryId`, "must match the page repository");
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    ...copyOptionalString(object, "after"),
    hasMore: object.hasMore as boolean,
    runs,
  });
}

export function encodePortalRunPage(input: unknown): string {
  return canonicalStringify(decodePortalRunPage(input));
}

export function decodePortalRunOverview(input: string | unknown): PortalRunOverview {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "displayName",
    "workflowName",
    "mode",
    "runModeRevision",
    "terminal",
    "updatedAt",
    "sync",
    "counts",
  ]);
  version(object.apiVersion, "$.apiVersion");
  const summary = runSummary(object, "$", true);
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    ...summary,
    counts: runCounts(object.counts, "$.counts"),
  });
}

export function encodePortalRunOverview(input: unknown): string {
  return canonicalStringify(decodePortalRunOverview(input));
}

export function decodePortalGraphSummary(input: string | unknown): PortalGraphSummary {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "graphRevision",
    "nodeCount",
    "edgeCount",
    "jsonNodeBudget",
  ]);
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  digest(object.graphRevision, "$.graphRevision");
  integer(object.nodeCount, "$.nodeCount");
  integer(object.edgeCount, "$.edgeCount");
  integer(object.jsonNodeBudget, "$.jsonNodeBudget", 1);
  if ((object.jsonNodeBudget as number) !== PORTAL_LIMITS.jsonViewerNodeBudget)
    fail("invalid-value", "$.jsonNodeBudget", `must equal ${PORTAL_LIMITS.jsonViewerNodeBudget}`);
  return Object.freeze(object) as unknown as PortalGraphSummary;
}

export function encodePortalGraphSummary(input: unknown): string {
  return canonicalStringify(decodePortalGraphSummary(input));
}

export function decodePortalGraphNodePage(input: string | unknown): PortalGraphNodePage {
  return graphPage(input, "nodes", portalGraphNode) as PortalGraphNodePage;
}

export function encodePortalGraphNodePage(input: unknown): string {
  return canonicalStringify(decodePortalGraphNodePage(input));
}

export function decodePortalGraphEdgePage(input: string | unknown): PortalGraphEdgePage {
  return graphPage(input, "edges", portalGraphEdge) as PortalGraphEdgePage;
}

export function encodePortalGraphEdgePage(input: unknown): string {
  return canonicalStringify(decodePortalGraphEdgePage(input));
}

export function decodePortalDeliveryPage(input: string | unknown): PortalDeliveryPage {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "dataflowRevision",
    "taskFrontierRevision",
    "after",
    "nextAfter",
    "hasMore",
    "records",
  ]);
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  integer(object.dataflowRevision, "$.dataflowRevision");
  integer(object.taskFrontierRevision, "$.taskFrontierRevision");
  integer(object.after, "$.after");
  integer(object.nextAfter, "$.nextAfter");
  bool(object.hasMore, "$.hasMore");
  const records = page(
    object.records,
    "$.records",
    PORTAL_LIMITS.maxDeliveryItems,
    portalDeliveryRecord,
  );
  if ((object.nextAfter as number) !== (object.after as number) + records.length) {
    fail("invalid-value", "$.nextAfter", "must equal after plus the record count");
  }
  return Object.freeze({ ...object, records }) as unknown as PortalDeliveryPage;
}

export function encodePortalDeliveryPage(input: unknown): string {
  return canonicalStringify(decodePortalDeliveryPage(input));
}

function portalDeliveryRecord(value: unknown, path: string): PortalDeliveryRecord {
  const optionalKeys = [
    "phaseId",
    "definitionGeneration",
    "attempt",
    "state",
    "outputName",
    "schemaKey",
    "contentDigest",
    "byteLength",
    "sensitivity",
    "accepted",
    "trigger",
    "disposition",
    "nextAttempt",
    "forEachKey",
    "evaluationDigest",
    "taskSetDigest",
    "applied",
    "taskId",
    "inputDigest",
    "proposalDigest",
    "decisionDigest",
    "applicationDigest",
  ];
  const object = exact(value, path, ["identity", "kind"], optionalKeys);
  boundedString(object.identity, `${path}.identity`, 1, 256);
  oneOf(object.kind, `${path}.kind`, DELIVERY_KINDS);
  for (const key of ["phaseId", "taskId"] as const) optional(object, key, identity, path);
  for (const key of ["definitionGeneration", "attempt", "byteLength", "nextAttempt"] as const) {
    if (Object.hasOwn(object, key))
      integer(object[key], `${path}.${key}`, key === "byteLength" ? 0 : 1);
  }
  for (const key of [
    "contentDigest",
    "evaluationDigest",
    "taskSetDigest",
    "inputDigest",
    "proposalDigest",
    "decisionDigest",
    "applicationDigest",
  ] as const) {
    if (Object.hasOwn(object, key)) digest(object[key], `${path}.${key}`);
  }
  for (const key of ["accepted", "applied"] as const) {
    if (Object.hasOwn(object, key)) bool(object[key], `${path}.${key}`);
  }
  if (Object.hasOwn(object, "sensitivity")) {
    oneOf(object.sensitivity, `${path}.sensitivity`, SENSITIVITIES);
  }
  for (const key of [
    "state",
    "outputName",
    "schemaKey",
    "trigger",
    "disposition",
    "forEachKey",
  ] as const) {
    if (Object.hasOwn(object, key)) boundedString(object[key], `${path}.${key}`, 1, 256);
  }
  return Object.freeze(object) as unknown as PortalDeliveryRecord;
}

export function decodePortalImmutableRecord(input: string | unknown): PortalImmutableRecord {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "kind",
    "recordId",
    "digest",
    "graphRevision",
    "recordedAt",
    "body",
  ]);
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  oneOf(object.kind, "$.kind", RECORD_KINDS);
  identity(object.recordId, "$.recordId");
  digest(object.digest, "$.digest");
  digest(object.graphRevision, "$.graphRevision");
  timestamp(object.recordedAt, "$.recordedAt");
  return Object.freeze({
    ...object,
    body: json(object.body, "$.body"),
  }) as unknown as PortalImmutableRecord;
}

export function encodePortalImmutableRecord(input: unknown): string {
  return canonicalStringify(decodePortalImmutableRecord(input));
}

export function decodePortalAllowanceReview(input: string | unknown): PortalAllowanceReview {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "escalationCommandId",
    "escalationDigest",
    "operationId",
    "unit",
    "requested",
    "available",
    "createdAt",
    "currentLimit",
    "maxIncrease",
    "ceiling",
    "allowancePolicyDigest",
    "resultingMax",
    "expectedGraphRevision",
    "expectedRunMode",
    "expectedRunModeRevision",
  ]);
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  identity(object.escalationCommandId, "$.escalationCommandId");
  digest(object.escalationDigest, "$.escalationDigest");
  identity(object.operationId, "$.operationId");
  token(object.unit, "$.unit");
  integer(object.requested, "$.requested", 1);
  integer(object.available, "$.available");
  timestamp(object.createdAt, "$.createdAt");
  integer(object.currentLimit, "$.currentLimit");
  integer(object.maxIncrease, "$.maxIncrease", 1);
  integer(object.ceiling, "$.ceiling", 1);
  digest(object.allowancePolicyDigest, "$.allowancePolicyDigest");
  integer(object.resultingMax, "$.resultingMax", 1);
  digest(object.expectedGraphRevision, "$.expectedGraphRevision");
  oneOf(object.expectedRunMode, "$.expectedRunMode", new Set(["running", "paused"]));
  integer(object.expectedRunModeRevision, "$.expectedRunModeRevision");
  if ((object.requested as number) <= (object.available as number))
    fail("invalid-value", "$.requested", "must exceed available for an escalation");
  if (
    (object.maxIncrease as number) !==
    (object.ceiling as number) - (object.currentLimit as number)
  )
    fail("invalid-value", "$.maxIncrease", "must equal ceiling minus currentLimit");
  if (
    (object.resultingMax as number) !==
    (object.currentLimit as number) + (object.maxIncrease as number)
  )
    fail("invalid-value", "$.resultingMax", "must equal currentLimit plus maxIncrease");
  return Object.freeze(object) as unknown as PortalAllowanceReview;
}

export function encodePortalAllowanceReview(input: unknown): string {
  return canonicalStringify(decodePortalAllowanceReview(input));
}

export function decodePortalHumanNeedPage(input: string | unknown): PortalHumanNeedPage {
  const object = exact(
    wire(input),
    "$",
    ["apiVersion", "repositoryId", "runId", "humanRevision", "hasMore", "needs"],
    ["after"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  integer(object.humanRevision, "$.humanRevision");
  optional(object, "after", identity, "$");
  bool(object.hasMore, "$.hasMore");
  const needs = page(object.needs, "$.needs", PORTAL_LIMITS.maxHumanNeeds, humanNeed);
  lexicalPage(needs, object.after as string | undefined, (item) => item.needId, "$.needs");
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    humanRevision: object.humanRevision as number,
    ...copyOptionalString(object, "after"),
    hasMore: object.hasMore as boolean,
    needs,
  });
}

export function encodePortalHumanNeedPage(input: unknown): string {
  return canonicalStringify(decodePortalHumanNeedPage(input));
}

export function decodePortalQuestionRecord(input: string | unknown): PortalQuestionRecord {
  const object = exact(
    wire(input),
    "$",
    ["apiVersion", "repositoryId", "runId", "source", "prompt", "freshDispatch"],
    ["details", "answer"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  boundedString(object.prompt, "$.prompt", 1, 16_384);
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    source: questionSource(object.source, "$.source"),
    prompt: object.prompt as string,
    ...(Object.hasOwn(object, "details") ? { details: json(object.details, "$.details") } : {}),
    ...(Object.hasOwn(object, "answer")
      ? { answer: questionAnswer(object.answer, "$.answer") }
      : {}),
    freshDispatch: freshDispatch(object.freshDispatch, "$.freshDispatch"),
  });
}

export function encodePortalQuestionRecord(input: unknown): string {
  return canonicalStringify(decodePortalQuestionRecord(input));
}

export function decodePortalQuestionPage(input: string | unknown): PortalQuestionPage {
  const object = exact(
    wire(input),
    "$",
    ["apiVersion", "repositoryId", "runId", "contextRevision", "hasMore", "questions"],
    ["after"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  integer(object.contextRevision, "$.contextRevision");
  optional(object, "after", identity, "$");
  bool(object.hasMore, "$.hasMore");
  const questions = page(
    object.questions,
    "$.questions",
    PORTAL_LIMITS.maxHumanNeeds,
    (value, path) => {
      const question = decodePortalQuestionRecord(value);
      if (question.repositoryId !== object.repositoryId || question.runId !== object.runId)
        fail("invalid-value", path, "must match the page repository and run");
      return question;
    },
  );
  lexicalPage(
    questions,
    object.after as string | undefined,
    (item) => item.source.submissionId,
    "$.questions",
  );
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    contextRevision: object.contextRevision as number,
    ...copyOptionalString(object, "after"),
    hasMore: object.hasMore as boolean,
    questions,
  });
}

export function encodePortalQuestionPage(input: unknown): string {
  return canonicalStringify(decodePortalQuestionPage(input));
}

export function decodePortalArtifactPage(input: string | unknown): PortalArtifactPage {
  const object = exact(
    wire(input),
    "$",
    ["apiVersion", "repositoryId", "runId", "contextRevision", "hasMore", "artifacts"],
    ["after"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  integer(object.contextRevision, "$.contextRevision");
  optional(object, "after", identity, "$");
  bool(object.hasMore, "$.hasMore");
  const artifacts = page(
    object.artifacts,
    "$.artifacts",
    PORTAL_LIMITS.maxArtifactItems,
    artifactMetadata,
  );
  lexicalPage(
    artifacts,
    object.after as string | undefined,
    (item) => item.artifactId,
    "$.artifacts",
  );
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    contextRevision: object.contextRevision as number,
    ...copyOptionalString(object, "after"),
    hasMore: object.hasMore as boolean,
    artifacts,
  });
}

export function encodePortalArtifactPage(input: unknown): string {
  return canonicalStringify(decodePortalArtifactPage(input));
}

export function decodePortalArtifactContent(input: string | unknown): PortalArtifactContent {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "artifactId",
    "contentDigest",
    "offset",
    "byteLength",
    "totalByteLength",
    "encoding",
    "content",
    "complete",
    "jsonNodeBudget",
  ]);
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  identity(object.artifactId, "$.artifactId");
  digest(object.contentDigest, "$.contentDigest");
  integer(object.offset, "$.offset");
  integer(object.byteLength, "$.byteLength");
  integer(object.totalByteLength, "$.totalByteLength");
  if ((object.byteLength as number) > PORTAL_LIMITS.maxArtifactPreviewBytes)
    fail("oversized", "$.byteLength", `must not exceed ${PORTAL_LIMITS.maxArtifactPreviewBytes}`);
  if (
    (object.offset as number) + (object.byteLength as number) >
    (object.totalByteLength as number)
  )
    fail("invalid-value", "$.byteLength", "range must not exceed totalByteLength");
  oneOf(object.encoding, "$.encoding", new Set(["utf8", "base64"]));
  boundedString(object.content, "$.content", 0, 131_072);
  bool(object.complete, "$.complete");
  integer(object.jsonNodeBudget, "$.jsonNodeBudget", 1);
  if ((object.jsonNodeBudget as number) !== PORTAL_LIMITS.jsonViewerNodeBudget)
    fail("invalid-value", "$.jsonNodeBudget", `must equal ${PORTAL_LIMITS.jsonViewerNodeBudget}`);
  const decodedLength =
    object.encoding === "base64"
      ? base64ByteLength(object.content as string, "$.content")
      : new TextEncoder().encode(object.content as string).byteLength;
  if (decodedLength !== object.byteLength)
    fail("invalid-value", "$.content", "encoded content length must equal byteLength");
  return Object.freeze(object) as unknown as PortalArtifactContent;
}

export function encodePortalArtifactContent(input: unknown): string {
  return canonicalStringify(decodePortalArtifactContent(input));
}

export function decodePortalAgentPage(input: string | unknown): PortalAgentPage {
  const object = exact(
    wire(input),
    "$",
    ["apiVersion", "repositoryId", "runId", "hasMore", "agents"],
    ["after"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  optional(object, "after", identity, "$");
  bool(object.hasMore, "$.hasMore");
  const agents = page(object.agents, "$.agents", PORTAL_LIMITS.maxAgentItems, agentSummary);
  return Object.freeze({
    apiVersion: object.apiVersion,
    repositoryId: object.repositoryId,
    runId: object.runId,
    ...(object.after === undefined ? {} : { after: object.after }),
    hasMore: object.hasMore,
    agents,
  }) as unknown as PortalAgentPage;
}

export function encodePortalAgentPage(input: unknown): string {
  return canonicalStringify(decodePortalAgentPage(input));
}

export function decodePortalWorkspacePage(input: string | unknown): PortalWorkspacePage {
  return authorityPage(
    input,
    "workspaces",
    PORTAL_LIMITS.maxWorkspaceItems,
    workspaceSummary,
  ) as PortalWorkspacePage;
}

export function encodePortalWorkspacePage(input: unknown): string {
  return canonicalStringify(decodePortalWorkspacePage(input));
}

export function decodePortalIntegrationPage(input: string | unknown): PortalIntegrationPage {
  return authorityPage(
    input,
    "integrations",
    PORTAL_LIMITS.maxIntegrationItems,
    integrationSummary,
  ) as PortalIntegrationPage;
}

export function encodePortalIntegrationPage(input: unknown): string {
  return canonicalStringify(decodePortalIntegrationPage(input));
}

export function decodePortalReceiptWindow(input: string | unknown): PortalReceiptWindow {
  return activityWindow(input, "receipts", decodeDurableReceipt) as PortalReceiptWindow;
}

export function encodePortalReceiptWindow(input: unknown): string {
  return canonicalStringify(decodePortalReceiptWindow(input));
}

export function decodePortalEventWindow(input: string | unknown): PortalEventWindow {
  return activityWindow(input, "events", decodeEventStreamFrame) as PortalEventWindow;
}

export function encodePortalEventWindow(input: unknown): string {
  return canonicalStringify(decodePortalEventWindow(input));
}

export function decodePortalTranscriptRecord(input: string | unknown): PortalTranscriptRecord {
  return transcriptRecord(wire(input), "$");
}

export function encodePortalTranscriptRecord(input: unknown): string {
  return canonicalStringify(decodePortalTranscriptRecord(input));
}

export function decodePortalTranscriptPage(input: string | unknown): PortalTranscriptPage {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "owner",
    "after",
    "nextAfter",
    "hasMore",
    "records",
  ]);
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  const owner = transcriptOwner(object.owner, "$.owner");
  integer(object.after, "$.after");
  integer(object.nextAfter, "$.nextAfter");
  bool(object.hasMore, "$.hasMore");
  const records = page(
    object.records,
    "$.records",
    TRANSCRIPT_LIMITS.maxRecordsPerPage,
    transcriptRecord,
  );
  let prior = object.after as number;
  for (const [index, record] of records.entries()) {
    if (record.repositoryId !== object.repositoryId || record.runId !== object.runId)
      fail("invalid-value", `$.records[${index}]`, "must match the page repository and run");
    // The run scope merges many capture owners, so its records keep the owner
    // that produced them; capture never writes the run scope itself.
    if (owner.kind === "run") {
      if (record.owner.kind === "run")
        fail("invalid-value", `$.records[${index}].owner`, "must name a capture owner");
    } else if (record.owner.kind !== owner.kind || record.owner.id !== owner.id) {
      fail("invalid-value", `$.records[${index}].owner`, "must match the page owner");
    }
    if (record.sequence <= prior)
      fail(
        "invalid-value",
        `$.records[${index}].sequence`,
        "must be strictly ascending after the cursor",
      );
    prior = record.sequence;
  }
  if ((object.nextAfter as number) !== prior)
    fail("invalid-value", "$.nextAfter", "must equal the last returned sequence");
  if (object.hasMore === true && records.length === 0)
    fail("invalid-value", "$.hasMore", "must be false for an empty page");
  return Object.freeze({ ...object, owner, records }) as unknown as PortalTranscriptPage;
}

export function encodePortalTranscriptPage(input: unknown): string {
  return canonicalStringify(decodePortalTranscriptPage(input));
}

function transcriptRecord(value: unknown, path: string): PortalTranscriptRecord {
  const object = exact(value, path, [
    "apiVersion",
    "repositoryId",
    "runId",
    "owner",
    "sequence",
    "occurredAt",
    "stream",
    "text",
  ]);
  version(object.apiVersion, `${path}.apiVersion`);
  identity(object.repositoryId, `${path}.repositoryId`);
  identity(object.runId, `${path}.runId`);
  integer(object.sequence, `${path}.sequence`, 1);
  timestamp(object.occurredAt, `${path}.occurredAt`);
  oneOf(object.stream, `${path}.stream`, TRANSCRIPT_STREAMS);
  transcriptText(object.text, `${path}.text`);
  return Object.freeze({
    ...object,
    owner: transcriptOwner(object.owner, `${path}.owner`),
  }) as unknown as PortalTranscriptRecord;
}

function transcriptOwner(value: unknown, path: string): PortalTranscriptOwner {
  const object = exact(value, path, ["kind", "id"]);
  oneOf(object.kind, `${path}.kind`, TRANSCRIPT_OWNER_KINDS);
  identity(object.id, `${path}.id`);
  return Object.freeze(object) as unknown as PortalTranscriptOwner;
}

/**
 * One record is exactly one displayed row. Every character a renderer can treat
 * as a forced break is refused here so a single captured record can never forge
 * extra rows in the pane, the clipboard, or a download; capture splits
 * multi-line output into separate records.
 */
function transcriptText(value: unknown, path: string): void {
  boundedString(value, path, 1, TRANSCRIPT_LIMITS.maxLineBytes);
  const text = value as string;
  if (new TextEncoder().encode(text).byteLength > TRANSCRIPT_LIMITS.maxLineBytes)
    fail("oversized", path, `must encode to at most ${TRANSCRIPT_LIMITS.maxLineBytes} UTF-8 bytes`);
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code < TRANSCRIPT_SPACE && code !== TRANSCRIPT_TAB) ||
      code === TRANSCRIPT_DELETE ||
      (code >= C1_FIRST && code <= C1_LAST) ||
      code === LINE_SEPARATOR ||
      code === PARAGRAPH_SEPARATOR ||
      (code >= SURROGATE_FIRST && code <= SURROGATE_LAST)
    )
      fail(
        "invalid-value",
        path,
        "must contain no line breaks, no control characters other than tab, and no lone surrogates",
      );
  }
}

function repositorySummary(value: unknown, path: string): PortalRepositorySummary {
  const object = exact(value, path, ["repositoryId", "displayName", "portalRevision", "runCount"]);
  identity(object.repositoryId, `${path}.repositoryId`);
  boundedString(object.displayName, `${path}.displayName`, 1, 256);
  integer(object.portalRevision, `${path}.portalRevision`);
  integer(object.runCount, `${path}.runCount`);
  return Object.freeze(object) as unknown as PortalRepositorySummary;
}

function runSummary(value: unknown, path: string, alreadyExact = false): PortalRunSummary {
  const object = alreadyExact
    ? (value as Readonly<Record<string, unknown>>)
    : exact(value, path, [
        "repositoryId",
        "runId",
        "displayName",
        "workflowName",
        "mode",
        "runModeRevision",
        "terminal",
        "updatedAt",
        "sync",
      ]);
  identity(object.repositoryId, `${path}.repositoryId`);
  identity(object.runId, `${path}.runId`);
  boundedString(object.displayName, `${path}.displayName`, 1, 256);
  boundedString(object.workflowName, `${path}.workflowName`, 1, 256);
  oneOf(object.mode, `${path}.mode`, RUN_MODES);
  integer(object.runModeRevision, `${path}.runModeRevision`);
  bool(object.terminal, `${path}.terminal`);
  timestamp(object.updatedAt, `${path}.updatedAt`);
  if ((object.mode === "ended") !== object.terminal)
    fail("invalid-value", `${path}.terminal`, "must be true exactly for ended runs");
  return Object.freeze({
    ...object,
    sync: syncVector(object.sync, `${path}.sync`),
  }) as unknown as PortalRunSummary;
}

function syncVector(value: unknown, path: string): PortalSyncVector {
  const object = exact(value, path, [
    "workflowCursor",
    "contextRevision",
    "runnerRevision",
    "workspaceRevision",
    "humanRevision",
    "portalRevision",
    "transcriptRevision",
    "graphRevision",
    "lifecycleRevision",
  ]);
  for (const key of [
    "workflowCursor",
    "contextRevision",
    "runnerRevision",
    "workspaceRevision",
    "humanRevision",
    "portalRevision",
    "transcriptRevision",
    "lifecycleRevision",
  ])
    integer(object[key], `${path}.${key}`);
  digest(object.graphRevision, `${path}.graphRevision`);
  return Object.freeze(object) as unknown as PortalSyncVector;
}

function runCounts(value: unknown, path: string): PortalRunCounts {
  const object = exact(value, path, [
    "phases",
    "tasks",
    "criteria",
    "humanNeeds",
    "activeEffects",
    "uncertainEffects",
  ]);
  for (const key of Object.keys(object)) integer(object[key], `${path}.${key}`);
  return Object.freeze(object) as unknown as PortalRunCounts;
}

function graphPage(
  input: string | unknown,
  field: "nodes" | "edges",
  decoder: (value: unknown, path: string) => PortalGraphNode | PortalGraphEdge,
): PortalGraphNodePage | PortalGraphEdgePage {
  const object = exact(wire(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "graphRevision",
    "after",
    "nextAfter",
    "hasMore",
    field,
  ]);
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  digest(object.graphRevision, "$.graphRevision");
  integer(object.after, "$.after");
  integer(object.nextAfter, "$.nextAfter");
  bool(object.hasMore, "$.hasMore");
  const items = page(object[field], `$.${field}`, PORTAL_LIMITS.maxGraphItems, decoder);
  if ((object.nextAfter as number) !== (object.after as number) + items.length)
    fail("invalid-value", "$.nextAfter", "must equal after plus the returned item count");
  if (object.hasMore === true && items.length === 0)
    fail("invalid-value", "$.hasMore", "must be false for an empty page");
  return Object.freeze({ ...object, [field]: items }) as unknown as
    | PortalGraphNodePage
    | PortalGraphEdgePage;
}

function portalGraphNode(value: unknown, path: string): PortalGraphNode {
  const object = exact(
    value,
    path,
    [
      "nodeId",
      "kind",
      "title",
      "definitionGeneration",
      "lifecycle",
      "runState",
      "humanNeedCount",
      "evidenceCount",
    ],
    [
      "parentNodeId",
      "sourcePointer",
      "normalizedInput",
      "completionPolicy",
      "supersededBy",
      "attempt",
      "roleKey",
      "dispatchId",
    ],
  );
  identity(object.nodeId, `${path}.nodeId`);
  oneOf(object.kind, `${path}.kind`, NODE_KINDS);
  boundedString(object.title, `${path}.title`, 1, 1_024);
  integer(object.definitionGeneration, `${path}.definitionGeneration`, 1);
  token(object.lifecycle, `${path}.lifecycle`);
  oneOf(object.runState, `${path}.runState`, NODE_RUN_STATES);
  integer(object.humanNeedCount, `${path}.humanNeedCount`);
  integer(object.evidenceCount, `${path}.evidenceCount`);
  optional(object, "parentNodeId", identity, path);
  optional(
    object,
    "sourcePointer",
    (entry, entryPath) => boundedString(entry, entryPath, 1, 2_048),
    path,
  );
  optional(object, "supersededBy", identity, path);
  optional(object, "attempt", (entry, entryPath) => integer(entry, entryPath, 1), path);
  optional(object, "roleKey", consumerKey, path);
  optional(object, "dispatchId", identity, path);
  return Object.freeze({
    ...object,
    ...(Object.hasOwn(object, "normalizedInput")
      ? { normalizedInput: json(object.normalizedInput, `${path}.normalizedInput`) }
      : {}),
    ...(Object.hasOwn(object, "completionPolicy")
      ? { completionPolicy: json(object.completionPolicy, `${path}.completionPolicy`) }
      : {}),
  }) as unknown as PortalGraphNode;
}

function portalGraphEdge(value: unknown, path: string): PortalGraphEdge {
  const object = exact(value, path, ["edgeId", "fromNodeId", "toNodeId", "kind"]);
  identity(object.edgeId, `${path}.edgeId`);
  identity(object.fromNodeId, `${path}.fromNodeId`);
  identity(object.toNodeId, `${path}.toNodeId`);
  oneOf(object.kind, `${path}.kind`, EDGE_KINDS);
  if (object.fromNodeId === object.toNodeId)
    fail("invalid-value", `${path}.toNodeId`, "must differ from fromNodeId");
  return Object.freeze(object) as unknown as PortalGraphEdge;
}

function humanNeed(value: unknown, path: string): PortalHumanNeed {
  const object = exact(
    value,
    path,
    [
      "needId",
      "kind",
      "sourceId",
      "sourceDigest",
      "sourceRevision",
      "title",
      "createdAt",
      "allowedCommands",
    ],
    ["taskId", "definitionGeneration", "expectedGraphRevision", "exactObjectDigest"],
  );
  identity(object.needId, `${path}.needId`);
  oneOf(object.kind, `${path}.kind`, NEED_KINDS);
  identity(object.sourceId, `${path}.sourceId`);
  digest(object.sourceDigest, `${path}.sourceDigest`);
  integer(object.sourceRevision, `${path}.sourceRevision`);
  boundedString(object.title, `${path}.title`, 1, 1_024);
  timestamp(object.createdAt, `${path}.createdAt`);
  optional(object, "taskId", identity, path);
  optional(
    object,
    "definitionGeneration",
    (entry, entryPath) => integer(entry, entryPath, 1),
    path,
  );
  optional(object, "expectedGraphRevision", digest, path);
  optional(object, "exactObjectDigest", digest, path);
  const allowedCommands = sortedTokens(object.allowedCommands, `${path}.allowedCommands`, 16);
  return Object.freeze({ ...object, allowedCommands }) as unknown as PortalHumanNeed;
}

function questionSource(value: unknown, path: string): PortalQuestionSource {
  const object = exact(value, path, [
    "submissionId",
    "dispatchId",
    "taskId",
    "definitionGeneration",
    "contextId",
    "contextDigest",
    "contextRevisionDigest",
    "questionDigest",
    "submittedAt",
  ]);
  for (const key of ["submissionId", "dispatchId", "taskId", "contextId"])
    identity(object[key], `${path}.${key}`);
  integer(object.definitionGeneration, `${path}.definitionGeneration`, 1);
  for (const key of ["contextDigest", "contextRevisionDigest", "questionDigest"])
    digest(object[key], `${path}.${key}`);
  timestamp(object.submittedAt, `${path}.submittedAt`);
  return Object.freeze(object) as unknown as PortalQuestionSource;
}

function questionAnswer(value: unknown, path: string): PortalQuestionAnswer {
  const object = exact(value, path, [
    "answerId",
    "answerDigest",
    "answeredAt",
    "answeredBy",
    "answer",
  ]);
  identity(object.answerId, `${path}.answerId`);
  digest(object.answerDigest, `${path}.answerDigest`);
  timestamp(object.answeredAt, `${path}.answeredAt`);
  identity(object.answeredBy, `${path}.answeredBy`);
  return Object.freeze({
    ...object,
    answer: json(object.answer, `${path}.answer`),
  }) as unknown as PortalQuestionAnswer;
}

function freshDispatch(value: unknown, path: string): PortalFreshDispatchRequirement {
  const discriminator = exact(
    value,
    path,
    ["status"],
    ["requirementId", "createdAt", "satisfiedAt", "dispatchId"],
  );
  if (discriminator.status === "not-required") {
    return Object.freeze(
      exact(value, path, ["status"]),
    ) as unknown as PortalFreshDispatchRequirement;
  }
  const object = exact(
    value,
    path,
    ["requirementId", "status", "createdAt"],
    ["satisfiedAt", "dispatchId"],
  );
  identity(object.requirementId, `${path}.requirementId`);
  oneOf(object.status, `${path}.status`, new Set(["pending", "satisfied"]));
  timestamp(object.createdAt, `${path}.createdAt`);
  optional(object, "satisfiedAt", timestamp, path);
  optional(object, "dispatchId", identity, path);
  const hasResolution = Object.hasOwn(object, "satisfiedAt") && Object.hasOwn(object, "dispatchId");
  if ((object.status === "satisfied") !== hasResolution)
    fail(
      "invalid-value",
      path,
      "satisfiedAt and dispatchId are required exactly for satisfied requirements",
    );
  return Object.freeze(object) as unknown as PortalFreshDispatchRequirement;
}

function artifactMetadata(value: unknown, path: string): PortalArtifactMetadata {
  const object = exact(
    value,
    path,
    [
      "artifactId",
      "source",
      "contentDigest",
      "byteLength",
      "mediaType",
      "sensitivity",
      "summary",
      "availability",
    ],
    ["taskId", "definitionGeneration", "criterionId"],
  );
  identity(object.artifactId, `${path}.artifactId`);
  oneOf(object.source, `${path}.source`, ASSET_SOURCES);
  digest(object.contentDigest, `${path}.contentDigest`);
  integer(object.byteLength, `${path}.byteLength`);
  boundedString(object.mediaType, `${path}.mediaType`, 3, 127);
  if (!MEDIA_TYPE.test(object.mediaType as string))
    fail("invalid-value", `${path}.mediaType`, "must be a lowercase media type");
  oneOf(object.sensitivity, `${path}.sensitivity`, SENSITIVITIES);
  boundedString(object.summary, `${path}.summary`, 1, 8_192);
  oneOf(object.availability, `${path}.availability`, ASSET_AVAILABILITIES);
  optional(object, "taskId", identity, path);
  optional(
    object,
    "definitionGeneration",
    (entry, entryPath) => integer(entry, entryPath, 1),
    path,
  );
  optional(object, "criterionId", identity, path);
  return Object.freeze(object) as unknown as PortalArtifactMetadata;
}

function authorityPage(
  input: string | unknown,
  field: "workspaces" | "integrations",
  limit: number,
  decoder: (value: unknown, path: string) => PortalWorkspaceSummary | PortalIntegrationSummary,
): PortalWorkspacePage | PortalIntegrationPage {
  const object = exact(
    wire(input),
    "$",
    ["apiVersion", "repositoryId", "runId", "workspaceRevision", "hasMore", field],
    ["after"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  integer(object.workspaceRevision, "$.workspaceRevision");
  optional(object, "after", identity, "$");
  bool(object.hasMore, "$.hasMore");
  const items = page(object[field], `$.${field}`, limit, decoder);
  lexicalPage(
    items,
    object.after as string | undefined,
    (item) =>
      field === "workspaces"
        ? (item as PortalWorkspaceSummary).workspaceId
        : (item as PortalIntegrationSummary).integrationId,
    `$.${field}`,
  );
  return Object.freeze({ ...object, [field]: items }) as unknown as
    | PortalWorkspacePage
    | PortalIntegrationPage;
}

function agentSummary(value: unknown, path: string): PortalAgentSummary {
  const object = exact(
    value,
    path,
    ["dispatchId", "persona", "phaseId", "taskId", "attempt", "model", "routeIndex", "state"],
    ["sessionId", "latestRefusal"],
  );
  identity(object.dispatchId, `${path}.dispatchId`);
  token(object.persona, `${path}.persona`);
  identity(object.phaseId, `${path}.phaseId`);
  identity(object.taskId, `${path}.taskId`);
  integer(object.attempt, `${path}.attempt`, 1);
  token(object.model, `${path}.model`);
  integer(object.routeIndex, `${path}.routeIndex`, 0);
  oneOf(object.state, `${path}.state`, new Set(["working", "finished"]));
  optional(object, "sessionId", identity, path);
  if (object.latestRefusal !== undefined) {
    token(object.latestRefusal, `${path}.latestRefusal`);
  }
  return Object.freeze(object) as unknown as PortalAgentSummary;
}

function workspaceSummary(value: unknown, path: string): PortalWorkspaceSummary {
  const object = exact(
    value,
    path,
    [
      "workspaceId",
      "taskId",
      "definitionGeneration",
      "dispatchId",
      "mode",
      "state",
      "baseDigest",
      "completionEligible",
      "updatedAt",
    ],
    ["resultDigest"],
  );
  identity(object.workspaceId, `${path}.workspaceId`);
  identity(object.taskId, `${path}.taskId`);
  integer(object.definitionGeneration, `${path}.definitionGeneration`, 1);
  identity(object.dispatchId, `${path}.dispatchId`);
  oneOf(object.mode, `${path}.mode`, new Set(["repository", "isolated"]));
  token(object.state, `${path}.state`);
  digest(object.baseDigest, `${path}.baseDigest`);
  optional(object, "resultDigest", digest, path);
  bool(object.completionEligible, `${path}.completionEligible`);
  timestamp(object.updatedAt, `${path}.updatedAt`);
  return Object.freeze(object) as unknown as PortalWorkspaceSummary;
}

function integrationSummary(value: unknown, path: string): PortalIntegrationSummary {
  const object = exact(
    value,
    path,
    ["integrationId", "cohortId", "attempt", "state", "memberCount", "targetDigest", "updatedAt"],
    ["gateDigest", "barrierDigest", "successorIntegrationId", "diagnostic"],
  );
  identity(object.integrationId, `${path}.integrationId`);
  identity(object.cohortId, `${path}.cohortId`);
  integer(object.attempt, `${path}.attempt`, 1);
  token(object.state, `${path}.state`);
  integer(object.memberCount, `${path}.memberCount`, 1);
  digest(object.targetDigest, `${path}.targetDigest`);
  optional(object, "gateDigest", digest, path);
  optional(object, "barrierDigest", digest, path);
  optional(object, "successorIntegrationId", identity, path);
  timestamp(object.updatedAt, `${path}.updatedAt`);
  return Object.freeze({
    ...object,
    ...(Object.hasOwn(object, "diagnostic")
      ? { diagnostic: integrationDiagnostic(object.diagnostic, `${path}.diagnostic`) }
      : {}),
  }) as unknown as PortalIntegrationSummary;
}

function integrationDiagnostic(value: unknown, path: string): PortalIntegrationDiagnostic {
  const object = exact(value, path, ["code", "summary"], ["details"]);
  token(object.code, `${path}.code`);
  boundedString(object.summary, `${path}.summary`, 1, 4_096);
  return Object.freeze({
    ...object,
    ...(Object.hasOwn(object, "details")
      ? { details: json(object.details, `${path}.details`) }
      : {}),
  }) as unknown as PortalIntegrationDiagnostic;
}

function activityWindow(
  input: string | unknown,
  field: "receipts" | "events",
  decoder: (value: unknown) => {
    readonly cursor: number;
    readonly repositoryId: string;
    readonly runId: string;
  },
): PortalReceiptWindow | PortalEventWindow {
  const object = exact(
    wire(input),
    "$",
    [
      "apiVersion",
      "repositoryId",
      "runId",
      "direction",
      "earliestCursor",
      "latestCursor",
      "hasEarlier",
      "hasLater",
      field,
    ],
    ["after", "before"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId");
  identity(object.runId, "$.runId");
  oneOf(object.direction, "$.direction", ACTIVITY_DIRECTIONS);
  optional(object, "after", integer, "$");
  optional(object, "before", integer, "$");
  const hasAfter = Object.hasOwn(object, "after");
  const hasBefore = Object.hasOwn(object, "before");
  if (
    (object.direction === "after") !== hasAfter ||
    (object.direction === "before") !== hasBefore ||
    (hasAfter && hasBefore)
  )
    fail(
      "invalid-value",
      "$.direction",
      "must select exactly its matching after or before cursor, or neither for tail",
    );
  integer(object.earliestCursor, "$.earliestCursor");
  integer(object.latestCursor, "$.latestCursor");
  if ((object.earliestCursor as number) > (object.latestCursor as number))
    fail("invalid-value", "$.earliestCursor", "must not exceed latestCursor");
  bool(object.hasEarlier, "$.hasEarlier");
  bool(object.hasLater, "$.hasLater");
  const items = page(object[field], `$.${field}`, PORTAL_LIMITS.maxActivityItems, (entry, path) => {
    const item = decoder(entry);
    if (item.repositoryId !== object.repositoryId || item.runId !== object.runId)
      fail("invalid-value", path, "must match the window repository and run");
    return item;
  });
  let prior = -1;
  for (const [index, item] of items.entries()) {
    if (item.cursor <= prior)
      fail(
        "invalid-value",
        `$.${field}[${index}].cursor`,
        "must be strictly ascending within the window",
      );
    if (
      item.cursor < (object.earliestCursor as number) ||
      item.cursor > (object.latestCursor as number)
    )
      fail(
        "invalid-value",
        `$.${field}[${index}].cursor`,
        "must fall within the available cursor range",
      );
    if (hasAfter && item.cursor <= (object.after as number))
      fail("invalid-value", `$.${field}[${index}].cursor`, "must follow after");
    if (hasBefore && item.cursor >= (object.before as number))
      fail("invalid-value", `$.${field}[${index}].cursor`, "must precede before");
    prior = item.cursor;
  }
  return Object.freeze({ ...object, [field]: items }) as unknown as
    | PortalReceiptWindow
    | PortalEventWindow;
}

function wire(input: string | unknown): JsonValue {
  return decodeCanonicalJsonValue(input);
}
function json(input: unknown, _path: string): JsonValue {
  return decodeCanonicalJsonValue(input);
}

function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optionalFields: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-type", path, "must be an object");
  const object = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optionalFields]);
  for (const key of Object.keys(object))
    if (!allowed.has(key)) fail("unknown-field", `${path}.${key}`, "is not allowed");
  for (const key of required)
    if (!Object.hasOwn(object, key)) fail("missing-field", `${path}.${key}`, "is required");
  return object;
}

function page<T>(
  value: unknown,
  path: string,
  limit: number,
  decoder: (value: unknown, path: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) fail("invalid-type", path, "must be an array");
  if (value.length > limit) fail("oversized", path, `must contain at most ${limit} entries`);
  return Object.freeze(value.map((entry, index) => decoder(entry, `${path}[${index}]`)));
}

function lexicalPage<T>(
  items: readonly T[],
  after: string | undefined,
  key: (item: T) => string,
  path: string,
): void {
  let prior = after;
  for (const [index, item] of items.entries()) {
    const current = key(item);
    if (prior !== undefined && current <= prior)
      fail("invalid-value", `${path}[${index}]`, "must be lexically ascending after the cursor");
    prior = current;
  }
}

function sortedTokens(value: unknown, path: string, limit: number): readonly string[] {
  if (!Array.isArray(value)) fail("invalid-type", path, "must be an array");
  if (value.length > limit) fail("oversized", path, `must contain at most ${limit} entries`);
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    token(entry, `${path}[${index}]`);
    const prior = result.at(-1);
    if (prior !== undefined && prior >= (entry as string))
      fail("invalid-value", path, "must be sorted and unique");
    result.push(entry as string);
  }
  return Object.freeze(result);
}

function optional(
  object: Readonly<Record<string, unknown>>,
  key: string,
  validator: (value: unknown, path: string) => void,
  path: string,
): void {
  if (Object.hasOwn(object, key)) validator(object[key], `${path}.${key}`);
}
function copyOptionalString(
  object: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  return Object.hasOwn(object, key) ? { [key]: object[key] as string } : {};
}
function version(value: unknown, path: string): void {
  if (value !== PROTOCOL_VERSION) fail("invalid-value", path, `must equal ${PROTOCOL_VERSION}`);
}
function identity(value: unknown, path: string): void {
  boundedString(value, path, 1, PROTOCOL_LIMITS.maxIdentityLength);
  if (!IDENTITY.test(value as string))
    fail("invalid-value", path, "must be an opaque ASCII identity");
}
function digest(value: unknown, path: string): void {
  if (typeof value !== "string" || !DIGEST.test(value))
    fail("invalid-value", path, "must be a SHA-256 digest");
}
function timestamp(value: unknown, path: string): void {
  if (typeof value !== "string" || !TIMESTAMP.test(value))
    fail("invalid-value", path, "must be a UTC RFC 3339 timestamp");
  const normalized = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  if (new Date(value).toISOString() !== normalized)
    fail("invalid-value", path, "must be a valid UTC RFC 3339 timestamp");
}
function token(value: unknown, path: string): void {
  boundedString(value, path, 1, 128);
  if (!TOKEN.test(value as string)) fail("invalid-value", path, "must be a lowercase token");
}
function consumerKey(value: unknown, path: string): void {
  boundedString(value, path, 1, 63);
  if (!CONSUMER_KEY.test(value as string))
    fail("invalid-value", path, "must be a lowercase consumer key");
}
function boundedString(value: unknown, path: string, minimum: number, maximum: number): void {
  if (typeof value !== "string") fail("invalid-type", path, "must be a string");
  if (value.length < minimum || value.length > maximum)
    fail("oversized", path, `must contain ${minimum}-${maximum} UTF-16 code units`);
}
function integer(value: unknown, path: string, minimum = 0): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    fail("invalid-value", path, `must be a safe integer of at least ${minimum}`);
}
function bool(value: unknown, path: string): void {
  if (typeof value !== "boolean") fail("invalid-type", path, "must be a boolean");
}
function oneOf<T extends string>(value: unknown, path: string, values: ReadonlySet<T>): void {
  if (typeof value !== "string" || !values.has(value as T))
    fail("invalid-value", path, `must be one of ${[...values].join(", ")}`);
}
function base64ByteLength(value: string, path: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    fail("invalid-value", path, "must be canonical base64");
  return value.length === 0
    ? 0
    : (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
function fail(code: ProtocolValidationError["code"], path: string, message: string): never {
  throw new ProtocolValidationError(code, path, `${path} ${message}`);
}
