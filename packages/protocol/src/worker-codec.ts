import {
  canonicalStringify,
  decodeCanonicalJsonValue,
  PROTOCOL_LIMITS,
  ProtocolValidationError,
} from "./codec.js";
import { type JsonValue, PROTOCOL_VERSION } from "./contracts.js";
import type {
  AssetChunkReadRequest,
  AssetPointerReadRequest,
  AssetReadAuditReceipt,
  AssetReadDenialCode,
  AssetReadMode,
  AssetReadRequest,
  AssetSensitivity,
  ContextGrantEnvelope,
  WorkerAmendmentProposalSubmission,
  WorkerAssetSubmission,
  WorkerCompletionPayload,
  WorkerCompletionSubmission,
  WorkerCriterionDisposition,
  WorkerCriterionOutcome,
  WorkerDiscoverySubmission,
  WorkerEvidenceAttachment,
  WorkerQuestionSubmission,
  WorkerSubmission,
  WorkerTaskGenerationReference,
  WorkerTerminalDisposition,
} from "./worker-contracts.js";

export const WORKER_PROTOCOL_LIMITS = Object.freeze({
  maxGrantTokenLength: 512,
  maxPointerLength: 2_048,
  maxAssetReadBytes: 65_536,
  maxGrantOperations: 1_024,
  maxGrantBytes: 256 * 1024 * 1024,
  maxSubmissionSummaryLength: 8_192,
  maxQuestionLength: 16_384,
  maxCompletionItems: 256,
});

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const PREFIXED_IDENTITY_SUFFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const GRANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SENSITIVITIES = new Set<AssetSensitivity>([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const READ_MODES = new Set<AssetReadMode>(["pointer", "chunk", "pointer-and-chunk"]);
const DENIAL_CODES = new Set<AssetReadDenialCode>([
  "invalid-token",
  "scope-denied",
  "sensitivity-denied",
  "expired",
  "budget-exhausted",
  "invalid-pointer",
  "invalid-range",
  "digest-mismatch",
  "request-conflict",
]);
const TERMINAL_DISPOSITIONS = new Set<WorkerTerminalDisposition>([
  "completed",
  "blocked",
  "waived",
  "skipped",
  "superseded",
]);
const CRITERION_DISPOSITIONS = new Set<WorkerCriterionDisposition>([
  "satisfied",
  "unsatisfied",
  "waived",
  "skipped",
]);

export function decodeContextGrantEnvelope(input: string | unknown): ContextGrantEnvelope {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "grantToken",
    "repositoryId",
    "runId",
    "dispatchId",
    "task",
    "contextId",
    "contextDigest",
    "principalId",
    "assetBindingId",
    "allowedPointer",
    "readMode",
    "sensitivityCeiling",
    "issuedAt",
    "expiresAt",
    "maxOperations",
    "maxBytes",
    "maxChunkBytes",
  ]);
  grantToken(object.grantToken, "$.grantToken");
  return Object.freeze({
    ...contextGrantEnvelopeFields(object),
    grantToken: object.grantToken as string,
  });
}

export function decodePersistedContextGrantEnvelope(
  input: string | unknown,
): Omit<ContextGrantEnvelope, "grantToken"> {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "repositoryId",
    "runId",
    "dispatchId",
    "task",
    "contextId",
    "contextDigest",
    "principalId",
    "assetBindingId",
    "allowedPointer",
    "readMode",
    "sensitivityCeiling",
    "issuedAt",
    "expiresAt",
    "maxOperations",
    "maxBytes",
    "maxChunkBytes",
  ]);
  return Object.freeze(contextGrantEnvelopeFields(object));
}

function contextGrantEnvelopeFields(object: Readonly<Record<string, unknown>>) {
  version(object.apiVersion, "$.apiVersion");
  identity(object.repositoryId, "$.repositoryId", "repository_");
  identity(object.runId, "$.runId", "run_");
  identity(object.dispatchId, "$.dispatchId", "dispatch_");
  const task = taskReference(object.task, "$.task");
  identity(object.contextId, "$.contextId", "context_");
  digest(object.contextDigest, "$.contextDigest");
  identity(object.principalId, "$.principalId", "principal_");
  identity(object.assetBindingId, "$.assetBindingId", "asset-binding_");
  jsonPointer(object.allowedPointer, "$.allowedPointer");
  enumValue(object.readMode, "$.readMode", READ_MODES);
  enumValue(object.sensitivityCeiling, "$.sensitivityCeiling", SENSITIVITIES);
  timestamp(object.issuedAt, "$.issuedAt");
  timestamp(object.expiresAt, "$.expiresAt");
  boundedPositiveInteger(
    object.maxOperations,
    "$.maxOperations",
    WORKER_PROTOCOL_LIMITS.maxGrantOperations,
  );
  boundedPositiveInteger(object.maxBytes, "$.maxBytes", WORKER_PROTOCOL_LIMITS.maxGrantBytes);
  positiveInteger(object.maxChunkBytes, "$.maxChunkBytes");
  if (
    (object.maxChunkBytes as number) > WORKER_PROTOCOL_LIMITS.maxAssetReadBytes ||
    (object.maxChunkBytes as number) > (object.maxBytes as number)
  ) {
    fail("invalid-value", "$.maxChunkBytes", "must not exceed the read or grant byte limit");
  }
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    dispatchId: object.dispatchId as string,
    task,
    contextId: object.contextId as string,
    contextDigest: object.contextDigest as string,
    principalId: object.principalId as string,
    assetBindingId: object.assetBindingId as string,
    allowedPointer: object.allowedPointer as string,
    readMode: object.readMode as AssetReadMode,
    sensitivityCeiling: object.sensitivityCeiling as AssetSensitivity,
    issuedAt: object.issuedAt as string,
    expiresAt: object.expiresAt as string,
    maxOperations: object.maxOperations as number,
    maxBytes: object.maxBytes as number,
    maxChunkBytes: object.maxChunkBytes as number,
  });
}

export function encodeContextGrantEnvelope(input: unknown): string {
  return canonicalStringify(decodeContextGrantEnvelope(input));
}

export function decodeAssetReadRequest(input: string | unknown): AssetReadRequest {
  const value = decodeCanonicalJsonValue(input);
  const discriminator = exactObject(
    value,
    "$",
    ["apiVersion", "requestId", "grantToken", "assetBindingId", "type"],
    ["pointer", "maxBytes", "offset", "length"],
  );
  version(discriminator.apiVersion, "$.apiVersion");
  identity(discriminator.requestId, "$.requestId", "request_");
  grantToken(discriminator.grantToken, "$.grantToken");
  identity(discriminator.assetBindingId, "$.assetBindingId", "asset-binding_");
  if (discriminator.type === "pointer") {
    const object = exactObject(value, "$", [
      "apiVersion",
      "requestId",
      "grantToken",
      "assetBindingId",
      "type",
      "pointer",
      "maxBytes",
    ]);
    jsonPointer(object.pointer, "$.pointer");
    boundedReadLength(object.maxBytes, "$.maxBytes");
    return Object.freeze({
      apiVersion: PROTOCOL_VERSION,
      requestId: object.requestId as string,
      grantToken: object.grantToken as string,
      assetBindingId: object.assetBindingId as string,
      type: "pointer",
      pointer: object.pointer as string,
      maxBytes: object.maxBytes as number,
    } satisfies AssetPointerReadRequest);
  }
  if (discriminator.type === "chunk") {
    const object = exactObject(value, "$", [
      "apiVersion",
      "requestId",
      "grantToken",
      "assetBindingId",
      "type",
      "offset",
      "length",
    ]);
    nonNegativeInteger(object.offset, "$.offset");
    boundedReadLength(object.length, "$.length");
    return Object.freeze({
      apiVersion: PROTOCOL_VERSION,
      requestId: object.requestId as string,
      grantToken: object.grantToken as string,
      assetBindingId: object.assetBindingId as string,
      type: "chunk",
      offset: object.offset as number,
      length: object.length as number,
    } satisfies AssetChunkReadRequest);
  }
  return fail("invalid-value", "$.type", "must be pointer or chunk");
}

export function encodeAssetReadRequest(input: unknown): string {
  return canonicalStringify(decodeAssetReadRequest(input));
}

export function decodeAssetReadAuditReceipt(input: string | unknown): AssetReadAuditReceipt {
  const object = exactObject(
    decodeCanonicalJsonValue(input),
    "$",
    [
      "apiVersion",
      "requestId",
      "requestDigest",
      "repositoryId",
      "runId",
      "dispatchId",
      "contextId",
      "assetBindingId",
      "principalId",
      "status",
      "occurredAt",
      "chargedOperations",
      "chargedBytes",
      "responseBytes",
      "remainingOperations",
      "remainingBytes",
    ],
    ["denialCode"],
  );
  version(object.apiVersion, "$.apiVersion");
  identity(object.requestId, "$.requestId", "request_");
  digest(object.requestDigest, "$.requestDigest");
  identity(object.repositoryId, "$.repositoryId", "repository_");
  identity(object.runId, "$.runId", "run_");
  identity(object.dispatchId, "$.dispatchId", "dispatch_");
  identity(object.contextId, "$.contextId", "context_");
  identity(object.assetBindingId, "$.assetBindingId", "asset-binding_");
  identity(object.principalId, "$.principalId", "principal_");
  if (object.status !== "served" && object.status !== "denied")
    fail("invalid-value", "$.status", "must be served or denied");
  timestamp(object.occurredAt, "$.occurredAt");
  for (const field of [
    "chargedOperations",
    "chargedBytes",
    "responseBytes",
    "remainingOperations",
    "remainingBytes",
  ] as const)
    nonNegativeInteger(object[field], `$.${field}`);
  const chargedOperations = object.chargedOperations as number;
  const chargedBytes = object.chargedBytes as number;
  const responseBytes = object.responseBytes as number;
  const hasDenial = Object.hasOwn(object, "denialCode");
  if (object.status === "denied") {
    if (!hasDenial) fail("missing-field", "$.denialCode", "is required for denied reads");
    enumValue(object.denialCode, "$.denialCode", DENIAL_CODES);
    if (object.chargedBytes !== 0 || object.responseBytes !== 0)
      fail("invalid-value", "$.chargedBytes", "denied reads must not charge or return bytes");
    if (
      object.denialCode !== "invalid-pointer" &&
      object.denialCode !== "digest-mismatch" &&
      chargedOperations !== 0
    )
      fail("invalid-value", "$.chargedOperations", "this denial cannot charge operations");
    if (object.denialCode === "digest-mismatch" && chargedOperations !== 1)
      fail(
        "invalid-value",
        "$.chargedOperations",
        "digest mismatch denials must charge one operation",
      );
    if (chargedOperations > 1)
      fail(
        "invalid-value",
        "$.chargedOperations",
        "denied reads cannot charge multiple operations",
      );
  } else if (hasDenial) {
    fail("unknown-field", "$.denialCode", "is not valid for served reads");
  } else {
    if (chargedOperations !== 1)
      fail("invalid-value", "$.chargedOperations", "served reads must charge one operation");
    if (chargedBytes < 1 || chargedBytes > WORKER_PROTOCOL_LIMITS.maxAssetReadBytes)
      fail("invalid-value", "$.chargedBytes", "served read charge exceeds protocol bounds");
    if (responseBytes < 1 || responseBytes > chargedBytes)
      fail("invalid-value", "$.responseBytes", "served response must fit within charged bytes");
  }
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    requestId: object.requestId as string,
    requestDigest: object.requestDigest as string,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    dispatchId: object.dispatchId as string,
    contextId: object.contextId as string,
    assetBindingId: object.assetBindingId as string,
    principalId: object.principalId as string,
    status: object.status,
    occurredAt: object.occurredAt as string,
    chargedOperations: object.chargedOperations as number,
    chargedBytes: object.chargedBytes as number,
    responseBytes: object.responseBytes as number,
    remainingOperations: object.remainingOperations as number,
    remainingBytes: object.remainingBytes as number,
    ...(hasDenial ? { denialCode: object.denialCode as AssetReadDenialCode } : {}),
  } as AssetReadAuditReceipt);
}

export function encodeAssetReadAuditReceipt(input: unknown): string {
  return canonicalStringify(decodeAssetReadAuditReceipt(input));
}

export function decodeWorkerSubmission(input: string | unknown): WorkerSubmission {
  const value = decodeCanonicalJsonValue(input);
  const base = exactObject(
    value,
    "$",
    [
      "apiVersion",
      "submissionId",
      "repositoryId",
      "runId",
      "dispatchId",
      "task",
      "contextId",
      "contextDigest",
      "principalId",
      "type",
    ],
    ["completion", "question", "asset", "discovery", "amendment"],
  );
  const binding = submissionBinding(base);
  switch (base.type) {
    case "completion": {
      const object = exactObject(value, "$", [...submissionKeys(), "completion"]);
      const completion = completionPayload(object.completion, "$.completion");
      assertSameTask(binding.task, completion.task, "$.completion.task");
      return Object.freeze({
        ...binding,
        type: "completion",
        completion,
      } satisfies WorkerCompletionSubmission);
    }
    case "question": {
      const object = exactObject(value, "$", [...submissionKeys(), "question"]);
      const question = exactObject(object.question, "$.question", ["prompt"], ["details"]);
      boundedString(
        question.prompt,
        "$.question.prompt",
        1,
        WORKER_PROTOCOL_LIMITS.maxQuestionLength,
      );
      return Object.freeze({
        ...binding,
        type: "question",
        question: Object.freeze({
          prompt: question.prompt as string,
          ...(Object.hasOwn(question, "details") ? { details: question.details as JsonValue } : {}),
        }),
      } satisfies WorkerQuestionSubmission);
    }
    case "asset": {
      const object = exactObject(value, "$", [...submissionKeys(), "asset"]);
      const asset = exactObject(object.asset, "$.asset", [
        "assetId",
        "contentDigest",
        "byteLength",
        "mediaType",
        "sensitivity",
        "summary",
      ]);
      identity(asset.assetId, "$.asset.assetId", "asset_");
      digest(asset.contentDigest, "$.asset.contentDigest");
      nonNegativeInteger(asset.byteLength, "$.asset.byteLength");
      mediaType(asset.mediaType, "$.asset.mediaType");
      enumValue(asset.sensitivity, "$.asset.sensitivity", SENSITIVITIES);
      boundedString(
        asset.summary,
        "$.asset.summary",
        1,
        WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength,
      );
      return Object.freeze({
        ...binding,
        type: "asset",
        asset: Object.freeze(asset),
      } as unknown as WorkerAssetSubmission);
    }
    case "discovery": {
      const object = exactObject(value, "$", [...submissionKeys(), "discovery"]);
      const discovery = exactObject(object.discovery, "$.discovery", ["summary", "details"]);
      boundedString(
        discovery.summary,
        "$.discovery.summary",
        1,
        WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength,
      );
      return Object.freeze({
        ...binding,
        type: "discovery",
        discovery: Object.freeze(discovery),
      } as unknown as WorkerDiscoverySubmission);
    }
    case "amendment-proposal": {
      const object = exactObject(value, "$", [...submissionKeys(), "amendment"]);
      const amendment = exactObject(object.amendment, "$.amendment", [
        "baseGraphRevisionDigest",
        "baseContextDigest",
        "summary",
        "operations",
      ]);
      digest(amendment.baseGraphRevisionDigest, "$.amendment.baseGraphRevisionDigest");
      digest(amendment.baseContextDigest, "$.amendment.baseContextDigest");
      if (amendment.baseContextDigest !== binding.contextDigest)
        fail(
          "invalid-value",
          "$.amendment.baseContextDigest",
          "must equal the bound context digest",
        );
      boundedString(
        amendment.summary,
        "$.amendment.summary",
        1,
        WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength,
      );
      return Object.freeze({
        ...binding,
        type: "amendment-proposal",
        amendment: Object.freeze(amendment),
      } as unknown as WorkerAmendmentProposalSubmission);
    }
    default:
      return fail("invalid-value", "$.type", "must be a recognized worker submission variant");
  }
}

export function encodeWorkerSubmission(input: unknown): string {
  return canonicalStringify(decodeWorkerSubmission(input));
}

function submissionBinding(object: Readonly<Record<string, unknown>>) {
  version(object.apiVersion, "$.apiVersion");
  identity(object.submissionId, "$.submissionId", "submission_");
  identity(object.repositoryId, "$.repositoryId", "repository_");
  identity(object.runId, "$.runId", "run_");
  identity(object.dispatchId, "$.dispatchId", "dispatch_");
  const task = taskReference(object.task, "$.task");
  identity(object.contextId, "$.contextId", "context_");
  digest(object.contextDigest, "$.contextDigest");
  identity(object.principalId, "$.principalId", "principal_");
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    submissionId: object.submissionId as string,
    repositoryId: object.repositoryId as string,
    runId: object.runId as string,
    dispatchId: object.dispatchId as string,
    task,
    contextId: object.contextId as string,
    contextDigest: object.contextDigest as string,
    principalId: object.principalId as string,
  });
}

function submissionKeys(): readonly string[] {
  return [
    "apiVersion",
    "submissionId",
    "repositoryId",
    "runId",
    "dispatchId",
    "task",
    "contextId",
    "contextDigest",
    "principalId",
    "type",
  ];
}

function completionPayload(value: unknown, path: string): WorkerCompletionPayload {
  const object = exactObject(
    value,
    path,
    ["task", "disposition", "summary", "criteria", "evidence"],
    ["replacementTask"],
  );
  const task = taskReference(object.task, `${path}.task`);
  enumValue(object.disposition, `${path}.disposition`, TERMINAL_DISPOSITIONS);
  boundedString(
    object.summary,
    `${path}.summary`,
    1,
    WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength,
  );
  const criteria = boundedArray(object.criteria, `${path}.criteria`).map((entry, index) =>
    criterionOutcome(entry, `${path}.criteria[${index}]`),
  );
  const evidence = boundedArray(object.evidence, `${path}.evidence`).map((entry, index) =>
    evidenceAttachment(entry, `${path}.evidence[${index}]`),
  );
  assertUnique(
    criteria.map(({ criterionId }) => criterionId),
    `${path}.criteria`,
  );
  assertUnique(
    evidence.map(({ assetId }) => assetId),
    `${path}.evidence`,
  );
  const hasReplacement = Object.hasOwn(object, "replacementTask");
  if ((object.disposition === "superseded") !== hasReplacement)
    fail("invalid-value", `${path}.replacementTask`, "is required only for superseded completion");
  return Object.freeze({
    task,
    disposition: object.disposition as WorkerTerminalDisposition,
    summary: object.summary as string,
    criteria: Object.freeze(criteria),
    evidence: Object.freeze(evidence),
    ...(hasReplacement
      ? { replacementTask: taskReference(object.replacementTask, `${path}.replacementTask`) }
      : {}),
  });
}

function criterionOutcome(value: unknown, path: string): WorkerCriterionOutcome {
  const object = exactObject(value, path, ["criterionId", "disposition"], ["authorityFact"]);
  identity(object.criterionId, `${path}.criterionId`, "criterion_");
  enumValue(object.disposition, `${path}.disposition`, CRITERION_DISPOSITIONS);
  if (object.disposition !== "waived" && Object.hasOwn(object, "authorityFact"))
    fail("unknown-field", `${path}.authorityFact`, "is valid only for waived criteria");
  return Object.freeze({
    criterionId: object.criterionId as string,
    disposition: object.disposition as WorkerCriterionDisposition,
    ...(Object.hasOwn(object, "authorityFact")
      ? { authorityFact: object.authorityFact as JsonValue }
      : {}),
  });
}

function evidenceAttachment(value: unknown, path: string): WorkerEvidenceAttachment {
  const object = exactObject(value, path, ["assetId", "kind", "descriptor"], ["criterionId"]);
  identity(object.assetId, `${path}.assetId`, "asset_");
  if (Object.hasOwn(object, "criterionId"))
    identity(object.criterionId, `${path}.criterionId`, "criterion_");
  return Object.freeze({
    assetId: object.assetId as string,
    kind: object.kind as JsonValue,
    descriptor: object.descriptor as JsonValue,
    ...(Object.hasOwn(object, "criterionId") ? { criterionId: object.criterionId as string } : {}),
  });
}

function taskReference(value: unknown, path: string): WorkerTaskGenerationReference {
  const object = exactObject(value, path, [
    "taskId",
    "definitionGeneration",
    "contextRevisionDigest",
  ]);
  identity(object.taskId, `${path}.taskId`, "task_");
  positiveInteger(object.definitionGeneration, `${path}.definitionGeneration`);
  digest(object.contextRevisionDigest, `${path}.contextRevisionDigest`);
  return Object.freeze({
    taskId: object.taskId as string,
    definitionGeneration: object.definitionGeneration as number,
    contextRevisionDigest: object.contextRevisionDigest as string,
  });
}

function assertSameTask(
  left: WorkerTaskGenerationReference,
  right: WorkerTaskGenerationReference,
  path: string,
): void {
  if (
    left.taskId !== right.taskId ||
    left.definitionGeneration !== right.definitionGeneration ||
    left.contextRevisionDigest !== right.contextRevisionDigest
  )
    fail("invalid-value", path, "must equal the outer assigned task generation");
}

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-type", path, "must be an object");
  const object = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object))
    if (!allowed.has(key)) fail("unknown-field", `${path}.${key}`, "is not allowed");
  for (const key of required)
    if (!Object.hasOwn(object, key)) fail("missing-field", `${path}.${key}`, "is required");
  return object;
}

function boundedArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail("invalid-type", path, "must be an array");
  if (value.length > WORKER_PROTOCOL_LIMITS.maxCompletionItems)
    fail(
      "oversized",
      path,
      `must contain at most ${WORKER_PROTOCOL_LIMITS.maxCompletionItems} items`,
    );
  return value;
}

function identity(value: unknown, path: string, prefix?: string): void {
  boundedString(value, path, 1, PROTOCOL_LIMITS.maxIdentityLength);
  if (!IDENTITY_PATTERN.test(value as string))
    fail("invalid-value", path, "must be an opaque ASCII identity");
  if (
    prefix !== undefined &&
    (!(value as string).startsWith(prefix) ||
      !PREFIXED_IDENTITY_SUFFIX_PATTERN.test((value as string).slice(prefix.length)))
  )
    fail(
      "invalid-value",
      path,
      `must use the ${prefix} prefix and a bounded lowercase identity suffix`,
    );
}

function grantToken(value: unknown, path: string): void {
  boundedString(value, path, 43, WORKER_PROTOCOL_LIMITS.maxGrantTokenLength);
  if (!GRANT_TOKEN_PATTERN.test(value as string))
    fail(
      "invalid-value",
      path,
      "must be an opaque base64url token with at least 256 bits of entropy",
    );
}

function digest(value: unknown, path: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
    fail("invalid-value", path, "must be a SHA-256 digest");
}

function version(value: unknown, path: string): void {
  if (value !== PROTOCOL_VERSION) fail("invalid-value", path, `must equal ${PROTOCOL_VERSION}`);
}

function jsonPointer(value: unknown, path: string): void {
  boundedString(value, path, 0, WORKER_PROTOCOL_LIMITS.maxPointerLength);
  if (value !== "" && (!(value as string).startsWith("/") || /~(?:[^01]|$)/u.test(value as string)))
    fail("invalid-value", path, "must be an RFC 6901 JSON pointer");
}

function mediaType(value: unknown, path: string): void {
  boundedString(value, path, 3, 127);
  if (!MEDIA_TYPE_PATTERN.test(value as string))
    fail("invalid-value", path, "must be a lowercase media type");
}

function timestamp(value: unknown, path: string): void {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value))
    fail("invalid-value", path, "must be a UTC RFC 3339 timestamp");
  const normalized = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  try {
    if (new Date(value).toISOString() !== normalized)
      fail("invalid-value", path, "must be a valid UTC RFC 3339 timestamp");
  } catch {
    fail("invalid-value", path, "must be a valid UTC RFC 3339 timestamp");
  }
}

function boundedReadLength(value: unknown, path: string): void {
  positiveInteger(value, path);
  if ((value as number) > WORKER_PROTOCOL_LIMITS.maxAssetReadBytes)
    fail("oversized", path, `must not exceed ${WORKER_PROTOCOL_LIMITS.maxAssetReadBytes}`);
}

function positiveInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail("invalid-value", path, "must be a positive safe integer");
}

function boundedPositiveInteger(value: unknown, path: string, maximum: number): void {
  positiveInteger(value, path);
  if ((value as number) > maximum) fail("oversized", path, `must not exceed ${maximum}`);
}

function nonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("invalid-value", path, "must be a non-negative safe integer");
}

function boundedString(value: unknown, path: string, minimum: number, maximum: number): void {
  if (typeof value !== "string") fail("invalid-type", path, "must be a string");
  if (value.length < minimum || value.length > maximum)
    fail("oversized", path, `must contain ${minimum}-${maximum} UTF-16 code units`);
}

function enumValue<Value extends string>(
  value: unknown,
  path: string,
  accepted: ReadonlySet<Value>,
): void {
  if (typeof value !== "string" || !accepted.has(value as Value))
    fail("invalid-value", path, `must be one of ${[...accepted].join(", ")}`);
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length)
    fail("invalid-value", path, "must not contain duplicate identities");
}

function fail(code: ProtocolValidationError["code"], path: string, message: string): never {
  throw new ProtocolValidationError(code, path, `${path} ${message}`);
}
