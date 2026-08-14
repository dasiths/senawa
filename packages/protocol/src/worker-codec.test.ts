import { describe, expect, it } from "vitest";
import {
  decodeAssetReadAuditReceipt,
  decodeAssetReadRequest,
  decodeContextGrantEnvelope,
  decodeWorkerSubmission,
  encodeAssetReadAuditReceipt,
  encodeAssetReadRequest,
  encodeContextGrantEnvelope,
  encodeWorkerSubmission,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  WORKER_PROTOCOL_LIMITS,
} from "./index.js";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const TOKEN = "A".repeat(43);
const TASK = Object.freeze({
  taskId: "task_verify",
  definitionGeneration: 1,
  contextRevisionDigest: DIGEST,
});

const grant = Object.freeze({
  apiVersion: PROTOCOL_VERSION,
  grantToken: TOKEN,
  repositoryId: "repository_fixture",
  runId: "run_fixture",
  dispatchId: `dispatch_${DIGEST}`,
  task: TASK,
  contextId: `context_${DIGEST}`,
  contextDigest: DIGEST,
  principalId: "principal_worker",
  assetBindingId: `asset-binding_${DIGEST}`,
  allowedPointer: "/work",
  readMode: "pointer-and-chunk",
  sensitivityCeiling: "confidential",
  issuedAt: "2026-08-13T10:00:00.000Z",
  expiresAt: "2026-08-13T12:00:00.000Z",
  maxOperations: 4,
  maxBytes: 4_096,
  maxChunkBytes: 1_024,
} as const);

const binding = Object.freeze({
  apiVersion: PROTOCOL_VERSION,
  submissionId: "submission_01",
  repositoryId: grant.repositoryId,
  runId: grant.runId,
  dispatchId: grant.dispatchId,
  task: TASK,
  contextId: grant.contextId,
  contextDigest: DIGEST,
  principalId: grant.principalId,
});

describe("worker context grant and asset codecs", () => {
  it("round trips an opaque grant and both bounded read modes", () => {
    expect(decodeContextGrantEnvelope(encodeContextGrantEnvelope(grant))).toEqual(grant);

    const pointer = {
      apiVersion: PROTOCOL_VERSION,
      requestId: "request_pointer",
      grantToken: TOKEN,
      assetBindingId: grant.assetBindingId,
      type: "pointer",
      pointer: "/work/items/0",
      maxBytes: 512,
    } as const;
    const chunk = {
      apiVersion: PROTOCOL_VERSION,
      requestId: "request_chunk",
      grantToken: TOKEN,
      assetBindingId: grant.assetBindingId,
      type: "chunk",
      offset: 12,
      length: 64,
    } as const;

    expect(decodeAssetReadRequest(encodeAssetReadRequest(pointer))).toEqual(pointer);
    expect(decodeAssetReadRequest(encodeAssetReadRequest(chunk))).toEqual(chunk);
  });

  it("round trips served and denied durable audit receipts", () => {
    const base = {
      apiVersion: PROTOCOL_VERSION,
      requestId: "request_pointer",
      requestDigest: DIGEST,
      repositoryId: grant.repositoryId,
      runId: grant.runId,
      dispatchId: grant.dispatchId,
      contextId: grant.contextId,
      assetBindingId: grant.assetBindingId,
      principalId: grant.principalId,
      occurredAt: "2026-08-13T11:00:00.000Z",
      remainingOperations: 3,
      remainingBytes: 3_584,
    } as const;
    const served = {
      ...base,
      status: "served",
      chargedOperations: 1,
      chargedBytes: 512,
      responseBytes: 27,
    } as const;
    const denied = {
      ...base,
      status: "denied",
      chargedOperations: 0,
      chargedBytes: 0,
      responseBytes: 0,
      denialCode: "expired",
    } as const;

    expect(decodeAssetReadAuditReceipt(encodeAssetReadAuditReceipt(served))).toEqual(served);
    expect(decodeAssetReadAuditReceipt(encodeAssetReadAuditReceipt(denied))).toEqual(denied);
    const { denialCode: _denialCode, ...missingDenialCode } = denied;
    expectProtocolError("missing-field", "$.denialCode", () =>
      decodeAssetReadAuditReceipt(missingDenialCode),
    );
    expectProtocolError("unknown-field", "$.denialCode", () =>
      decodeAssetReadAuditReceipt({ ...served, denialCode: "expired" }),
    );
    expectProtocolError("invalid-value", "$.chargedOperations", () =>
      decodeAssetReadAuditReceipt({ ...served, chargedOperations: 0 }),
    );
    expectProtocolError("invalid-value", "$.chargedBytes", () =>
      decodeAssetReadAuditReceipt({ ...served, chargedBytes: 0, responseBytes: 0 }),
    );
    expectProtocolError("invalid-value", "$.responseBytes", () =>
      decodeAssetReadAuditReceipt({ ...served, chargedBytes: 4, responseBytes: 5 }),
    );
    expectProtocolError("invalid-value", "$.chargedOperations", () =>
      decodeAssetReadAuditReceipt({ ...denied, chargedOperations: 2 }),
    );
    expectProtocolError("invalid-value", "$.chargedOperations", () =>
      decodeAssetReadAuditReceipt({
        ...denied,
        denialCode: "invalid-token",
        chargedOperations: 1,
      }),
    );
    expectProtocolError("invalid-value", "$.chargedOperations", () =>
      decodeAssetReadAuditReceipt({
        ...denied,
        denialCode: "request-conflict",
        chargedOperations: 1,
      }),
    );
    expectProtocolError("invalid-value", "$.chargedOperations", () =>
      decodeAssetReadAuditReceipt({
        ...denied,
        denialCode: "digest-mismatch",
        chargedOperations: 0,
      }),
    );
    expectProtocolError("invalid-value", "$.responseBytes", () =>
      decodeAssetReadAuditReceipt({ ...served, responseBytes: 0 }),
    );
    expectProtocolError("invalid-value", "$.chargedBytes", () =>
      decodeAssetReadAuditReceipt({
        ...served,
        chargedBytes: WORKER_PROTOCOL_LIMITS.maxAssetReadBytes + 1,
      }),
    );
    expectProtocolError("invalid-value", "$.remainingBytes", () =>
      decodeAssetReadAuditReceipt({ ...denied, remainingBytes: Number.MAX_SAFE_INTEGER + 1 }),
    );
    expectProtocolError("invalid-value", "$.chargedOperations", () =>
      decodeAssetReadAuditReceipt({ ...denied, chargedOperations: 1 }),
    );
    expect(
      decodeAssetReadAuditReceipt({
        ...denied,
        denialCode: "invalid-pointer",
        chargedOperations: 1,
      }),
    ).toEqual({ ...denied, denialCode: "invalid-pointer", chargedOperations: 1 });
  });

  it("rejects weak tokens, malformed pointers, oversized reads, extras, and accessors", () => {
    expectProtocolError("oversized", "$.grantToken", () =>
      decodeContextGrantEnvelope({ ...grant, grantToken: "weak" }),
    );
    expectProtocolError("invalid-value", "$.allowedPointer", () =>
      decodeContextGrantEnvelope({ ...grant, allowedPointer: "/bad~2escape" }),
    );
    expectProtocolError("oversized", "$.length", () =>
      decodeAssetReadRequest({
        apiVersion: PROTOCOL_VERSION,
        requestId: "request_large",
        grantToken: TOKEN,
        assetBindingId: grant.assetBindingId,
        type: "chunk",
        offset: 0,
        length: WORKER_PROTOCOL_LIMITS.maxAssetReadBytes + 1,
      }),
    );
    expectProtocolError("unknown-field", "$.approval", () =>
      decodeContextGrantEnvelope({ ...grant, approval: true }),
    );

    let invoked = false;
    const adversarial = { ...grant } as Record<string, unknown>;
    Object.defineProperty(adversarial, "grantToken", {
      enumerable: true,
      get() {
        invoked = true;
        return TOKEN;
      },
    });
    expectProtocolError("invalid-type", "$.grantToken", () =>
      decodeContextGrantEnvelope(adversarial),
    );
    expect(invoked).toBe(false);
  });

  it("enforces worker grant operation, byte, and chunk ceilings at limit plus one", () => {
    expect(
      decodeContextGrantEnvelope({
        ...grant,
        maxOperations: WORKER_PROTOCOL_LIMITS.maxGrantOperations,
        maxBytes: WORKER_PROTOCOL_LIMITS.maxGrantBytes,
        maxChunkBytes: WORKER_PROTOCOL_LIMITS.maxAssetReadBytes,
      }),
    ).toMatchObject({
      maxOperations: WORKER_PROTOCOL_LIMITS.maxGrantOperations,
      maxBytes: WORKER_PROTOCOL_LIMITS.maxGrantBytes,
      maxChunkBytes: WORKER_PROTOCOL_LIMITS.maxAssetReadBytes,
    });
    expectProtocolError("oversized", "$.maxOperations", () =>
      decodeContextGrantEnvelope({
        ...grant,
        maxOperations: WORKER_PROTOCOL_LIMITS.maxGrantOperations + 1,
      }),
    );
    expectProtocolError("oversized", "$.maxBytes", () =>
      decodeContextGrantEnvelope({ ...grant, maxBytes: WORKER_PROTOCOL_LIMITS.maxGrantBytes + 1 }),
    );
    expectProtocolError("invalid-value", "$.maxChunkBytes", () =>
      decodeContextGrantEnvelope({
        ...grant,
        maxBytes: WORKER_PROTOCOL_LIMITS.maxGrantBytes,
        maxChunkBytes: WORKER_PROTOCOL_LIMITS.maxAssetReadBytes + 1,
      }),
    );
  });
});

describe("worker submission codec", () => {
  const completion = {
    ...binding,
    type: "completion",
    completion: {
      task: TASK,
      disposition: "completed",
      summary: "Verified the bounded work.",
      criteria: [{ criterionId: "criterion_verified", disposition: "satisfied" }],
      evidence: [],
    },
  } as const;

  it("round trips every exact proposal variant", () => {
    const variants = [
      completion,
      {
        ...binding,
        submissionId: "submission_02",
        type: "question",
        question: { prompt: "Which environment is authoritative?", details: { options: 2 } },
      },
      {
        ...binding,
        submissionId: "submission_03",
        type: "asset",
        asset: {
          assetId: "asset_report",
          contentDigest: OTHER_DIGEST,
          byteLength: 42,
          mediaType: "application/json",
          sensitivity: "internal",
          summary: "Verification report",
        },
      },
      {
        ...binding,
        submissionId: "submission_04",
        type: "discovery",
        discovery: { summary: "Found a constraint", details: { source: "inspection" } },
      },
      {
        ...binding,
        submissionId: "submission_05",
        type: "amendment-proposal",
        amendment: {
          baseGraphRevisionDigest: OTHER_DIGEST,
          baseContextDigest: DIGEST,
          summary: "Propose additive follow-up work",
          operations: [{ type: "add-task", key: "follow-up" }],
        },
      },
    ] as const;

    for (const variant of variants) {
      expect(decodeWorkerSubmission(encodeWorkerSubmission(variant))).toEqual(variant);
      expect(Object.isFrozen(decodeWorkerSubmission(variant))).toBe(true);
    }
  });

  it("rejects cross-task completion, graph authority, duplicate evidence, and sparse arrays", () => {
    expectProtocolError("invalid-value", "$.completion.task", () =>
      decodeWorkerSubmission({
        ...completion,
        completion: {
          ...completion.completion,
          task: { ...TASK, definitionGeneration: 2 },
        },
      }),
    );
    expectProtocolError("unknown-field", "$.closePhase", () =>
      decodeWorkerSubmission({ ...completion, closePhase: true }),
    );
    const evidence = {
      assetId: "asset_duplicate",
      kind: { type: "report" },
      descriptor: { digest: OTHER_DIGEST },
    };
    expectProtocolError("invalid-value", "$.completion.evidence", () =>
      decodeWorkerSubmission({
        ...completion,
        completion: { ...completion.completion, evidence: [evidence, evidence] },
      }),
    );

    const sparse = Array(2);
    sparse[0] = completion.completion.criteria[0];
    expectProtocolError("invalid-type", "$.completion.criteria", () =>
      decodeWorkerSubmission({
        ...completion,
        completion: { ...completion.completion, criteria: sparse },
      }),
    );
  });
});

function expectProtocolError(
  code: ProtocolValidationError["code"],
  path: string,
  operation: () => unknown,
): void {
  try {
    operation();
    expect.fail("Expected protocol validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolValidationError);
    expect(error).toMatchObject({ code, path });
  }
}
