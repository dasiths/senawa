import { describe, expect, it } from "vitest";
import { GOLDEN_COMMAND_JSON, GOLDEN_RECEIPT_JSON } from "./fixtures/wire-v1.js";
import {
  canonicalBytes,
  decodeAnswerQuestionPayload,
  decodeApplyApprovedAmendmentPayload,
  decodeAuthenticatedPrincipal,
  decodeCapabilityHandshake,
  decodeCommandEnvelope,
  decodeCommandSubmission,
  decodeDurableReceipt,
  decodeErrorEnvelope,
  decodeEventReplayPage,
  decodeEventStreamFrame,
  decodeGrantAllowancePayload,
  decodeImportPlanPayload,
  decodeProjectionEnvelope,
  decodeReceiptPage,
  decodeRecordAmendmentDecisionPayload,
  decodeRecordFanOutDiffDecisionPayload,
  decodeRecordIntegrationBarrierPayload,
  decodeRecordPhaseAttemptTransitionPayload,
  decodeRunControlPayload,
  decodeRunIdentity,
  decodeSubmitAmendmentProposalPayload,
  decodeSupervisorAdmissionFacts,
  decodeSupervisorReceipt,
  decodeSupervisorServiceRecord,
  decodeSupervisorWake,
  decodeTaskFrontierStatus,
  decodeTransportAttribution,
  decodeWithdrawAmendmentProposalPayload,
  encodeAnswerQuestionPayload,
  encodeApplyApprovedAmendmentPayload,
  encodeAuthenticatedPrincipal,
  encodeCapabilityHandshake,
  encodeCommandEnvelope,
  encodeCommandSubmission,
  encodeDurableReceipt,
  encodeErrorEnvelope,
  encodeEventReplayPage,
  encodeEventStreamFrame,
  encodeGrantAllowancePayload,
  encodeImportPlanPayload,
  encodeProjectionEnvelope,
  encodeReceiptPage,
  encodeRecordAmendmentDecisionPayload,
  encodeRecordFanOutDiffDecisionPayload,
  encodeRecordIntegrationBarrierPayload,
  encodeRecordPhaseAttemptTransitionPayload,
  encodeRunControlPayload,
  encodeRunIdentity,
  encodeSubmitAmendmentProposalPayload,
  encodeTaskFrontierStatus,
  encodeTransportAttribution,
  encodeWithdrawAmendmentProposalPayload,
  MAX_ANSWER_LENGTH,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  validateOpaqueIdentity,
} from "./index.js";

const DIGEST = "a".repeat(64);

const command = {
  apiVersion: PROTOCOL_VERSION,
  commandId: "018f47a6-45cd-7df2-89ab-0123456789ab",
  principal: {
    issuer: "https://identity.example.test",
    subject: "operator@example.test",
    tenant: "tenant_alpha",
    assurance: "multi-factor",
    roles: ["operator", "release-manager"],
  },
  transport: { kind: "portal", requestId: "request_01" },
  repositoryId: "repository_alpha",
  runId: "run_alpha",
  intent: { type: "instantiate-run" },
  payload: { workflowId: "workflow_alpha", zeta: 2, alpha: true },
  payloadDigest: DIGEST,
  expectedDefinitionRevision: "definition_17",
  exactObjectDigest: "b".repeat(64),
  expiresAt: "2026-08-12T12:30:00.000Z",
} as const;

const receipt = {
  apiVersion: PROTOCOL_VERSION,
  commandId: command.commandId,
  repositoryId: command.repositoryId,
  runId: command.runId,
  status: "completed",
  cursor: 7,
  priorRevision: "revision_06",
  resultRevision: "revision_07",
  result: { accepted: true },
} as const;

const event = {
  apiVersion: PROTOCOL_VERSION,
  cursor: 8,
  repositoryId: command.repositoryId,
  runId: command.runId,
  eventId: "event_08",
  eventType: "run-instantiated",
  occurredAt: "2026-08-12T12:00:00Z",
  payload: { revision: "revision_07" },
  payloadDigest: DIGEST,
  commandId: command.commandId,
} as const;

const projection = {
  apiVersion: PROTOCOL_VERSION,
  cursor: 8,
  repositoryId: command.repositoryId,
  runId: command.runId,
  projectionType: "run-summary",
  revision: "revision_07",
  generatedAt: "2026-08-12T12:00:01.000Z",
  payload: { status: "active" },
  payloadDigest: DIGEST,
} as const;

const handshake = {
  apiVersion: PROTOCOL_VERSION,
  peerId: "portal_alpha",
  supportedVersions: [PROTOCOL_VERSION],
  capabilities: ["command-submit", "event-stream", "projection-read"],
} as const;

const errorEnvelope = {
  apiVersion: PROTOCOL_VERSION,
  code: "stale-revision",
  message: "The submitted revision is stale.",
  retryable: false,
  commandId: command.commandId,
  details: { actualRevision: "revision_08" },
} as const;

describe("v1 command codec", () => {
  it("matches the canonical command golden fixture and round trips", () => {
    const encoded = encodeCommandEnvelope(command);

    expect(encoded).toBe(GOLDEN_COMMAND_JSON);
    expect(new TextDecoder().decode(canonicalBytes(command))).toBe(GOLDEN_COMMAND_JSON);
    expect(decodeCommandEnvelope(encoded)).toEqual(command);
    expect(Object.isFrozen(decodeCommandEnvelope(encoded))).toBe(true);
  });

  it("round trips a submission while rejecting client-owned attribution", () => {
    const { principal: _principal, transport: _transport, ...submission } = command;
    expect(decodeCommandSubmission(encodeCommandSubmission(submission))).toEqual(submission);
    expectProtocolError("unknown-field", "$.principal", () =>
      decodeCommandSubmission({ ...submission, principal: command.principal }),
    );
    expectProtocolError("unknown-field", "$.transport", () =>
      decodeCommandSubmission({ ...submission, transport: command.transport }),
    );
  });

  it("rejects unknown fields that could create principal ambiguity", () => {
    const ambiguous = {
      ...command,
      principal: { ...command.principal, principalId: "operator_override" },
    };

    expectProtocolError("unknown-field", "$.principal.principalId", () =>
      decodeCommandEnvelope(ambiguous),
    );
  });

  it("rejects duplicate principal keys and non-canonical raw JSON", () => {
    const encoded = encodeCommandEnvelope(command);
    const duplicatePrincipal = encoded.replace('"principal":', '"principal":null,"principal":');

    expectProtocolError("invalid-json", "$", () => decodeCommandEnvelope(duplicatePrincipal));
    expectProtocolError("invalid-json", "$", () => decodeCommandEnvelope(` ${encoded}`));
  });

  it.each([
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
    "grant-allowance",
    "pause-run",
    "resume-run",
    "end-run",
  ] as const)("accepts the %s intent discriminator", (type) => {
    expect(decodeCommandEnvelope({ ...command, intent: { type } }).intent).toEqual({ type });
  });

  it("round trips metadata-only iteration, plan import, diff decision, and frontier status", () => {
    const transition = {
      attemptDigest: DIGEST,
      transitionDigest: "b".repeat(64),
      triggerDigest: "c".repeat(64),
      disposition: "iterate",
    };
    expect(
      decodeRecordPhaseAttemptTransitionPayload(
        encodeRecordPhaseAttemptTransitionPayload(transition),
      ),
    ).toEqual(transition);

    const planImport = {
      attemptDigest: DIGEST,
      acceptanceDigest: "b".repeat(64),
      closureDigest: "c".repeat(64),
      forEachKey: "plan-tasks",
      definitionDigest: "d".repeat(64),
      evaluationDigest: "e".repeat(64),
      taskSetDigest: "f".repeat(64),
    };
    expect(decodeImportPlanPayload(encodeImportPlanPayload(planImport))).toEqual(planImport);

    const decision = {
      evaluationDigest: DIGEST,
      priorEvaluationDigest: "b".repeat(64),
      diffDigest: "c".repeat(64),
      authorityDigest: "d".repeat(64),
      changed: "supersede-changed",
      removed: "retain-removed",
    };
    expect(
      decodeRecordFanOutDiffDecisionPayload(encodeRecordFanOutDiffDecisionPayload(decision)),
    ).toEqual(decision);

    const status = {
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      attemptDigest: DIGEST,
      forEachKey: "plan-tasks",
      evaluationDigest: "b".repeat(64),
      taskSetDigest: "c".repeat(64),
      graphRevisionDigest: "d".repeat(64),
      configurationSnapshotDigest: "e".repeat(64),
      state: "applied",
      selectedCount: 3,
      effectiveCount: 3,
      activeCount: 1,
      completedCount: 2,
      maxActive: 2,
    };
    expect(decodeTaskFrontierStatus(encodeTaskFrontierStatus(status))).toEqual(status);
    expect(Object.keys(status)).not.toContain("output");
    expect(Object.keys(status)).not.toContain("prompt");
  });

  it("round trips the exact trusted integration barrier payload", () => {
    const payload = {
      integrationId: "integration_alpha",
      configurationSnapshotDigest: DIGEST,
      barrier: { barrierDigest: "b".repeat(64), outcome: "integrated" },
    };
    expect(
      decodeRecordIntegrationBarrierPayload(encodeRecordIntegrationBarrierPayload(payload)),
    ).toEqual(payload);
    expectProtocolError("unknown-field", "$.candidateDigest", () =>
      decodeRecordIntegrationBarrierPayload({ ...payload, candidateDigest: DIGEST }),
    );
  });

  it("rejects malformed identifiers, digests, timestamps, and alternate attribution", () => {
    expectProtocolError("invalid-value", "$.commandId", () =>
      decodeCommandEnvelope({ ...command, commandId: "not a command id" }),
    );
    expectProtocolError("invalid-value", "$.payloadDigest", () =>
      decodeCommandEnvelope({ ...command, payloadDigest: DIGEST.toUpperCase() }),
    );
    expectProtocolError("invalid-value", "$.repositoryId", () =>
      decodeCommandEnvelope({ ...command, repositoryId: "Repository_Alpha" }),
    );
    expectProtocolError("invalid-value", "$.expiresAt", () =>
      decodeCommandEnvelope({ ...command, expiresAt: "2026-02-31T12:00:00Z" }),
    );
    expectProtocolError("unknown-field", "$.transport.principal", () =>
      decodeCommandEnvelope({
        ...command,
        transport: { ...command.transport, principal: command.principal },
      }),
    );
  });

  it("rejects oversized and malformed JSON values before command handling", () => {
    expectProtocolError("oversized", "$", () =>
      decodeCommandEnvelope(`"${"x".repeat(PROTOCOL_LIMITS.maxWireBytes)}"`),
    );
    expectProtocolError("oversized", "$.payload", () =>
      decodeCommandEnvelope({
        ...command,
        payload: "x".repeat(PROTOCOL_LIMITS.maxStringLength + 1),
      }),
    );
    expectProtocolError("invalid-value", "$.payload", () =>
      decodeCommandEnvelope({ ...command, payload: "\ud800" }),
    );

    const sparsePayload = Array(2);
    sparsePayload[0] = "present";
    expectProtocolError("invalid-type", "$.payload", () =>
      decodeCommandEnvelope({ ...command, payload: sparsePayload }),
    );

    const deepPayload: Record<string, unknown> = {};
    let cursor = deepPayload;
    for (let depth = 0; depth < PROTOCOL_LIMITS.maxJsonDepth; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expectProtocolError("oversized", expect.stringContaining("$.payload"), () =>
      decodeCommandEnvelope({ ...command, payload: deepPayload }),
    );
  });

  it("rejects accessor properties without invoking them", () => {
    let invoked = false;
    const adversarial = { ...command } as Record<string, unknown>;
    Object.defineProperty(adversarial, "payload", {
      enumerable: true,
      get() {
        invoked = true;
        return {};
      },
    });

    expectProtocolError("invalid-type", "$.payload", () => decodeCommandEnvelope(adversarial));
    expect(invoked).toBe(false);
  });
});

describe("v1 human authority and run-control payloads", () => {
  it("round trips an exact question answer without caller-owned authority facts", () => {
    const payload = {
      submissionId: "submission_question",
      questionDigest: "b".repeat(64),
      contextDigest: "c".repeat(64),
      taskId: "task_alpha",
      definitionGeneration: 3,
      answer: { selected: "production" },
    };
    expect(decodeAnswerQuestionPayload(encodeAnswerQuestionPayload(payload))).toEqual(payload);
    expectProtocolError("unknown-field", "$.dispatchId", () =>
      decodeAnswerQuestionPayload({ ...payload, dispatchId: "dispatch_override" }),
    );
  });

  it("refuses a text answer longer than a worker context can carry back", () => {
    const payload = {
      submissionId: "submission_question",
      questionDigest: "b".repeat(64),
      contextDigest: "c".repeat(64),
      taskId: "task_alpha",
      definitionGeneration: 3,
      answer: "a".repeat(MAX_ANSWER_LENGTH),
    };
    expect(decodeAnswerQuestionPayload(encodeAnswerQuestionPayload(payload))).toEqual(payload);
    expectProtocolError("oversized", "$.answer", () =>
      decodeAnswerQuestionPayload({ ...payload, answer: "a".repeat(MAX_ANSWER_LENGTH + 1) }),
    );
  });

  it("round trips an allowance grant while excluding a caller-supplied ceiling", () => {
    const payload = {
      escalationCommandId: "command_escalation",
      operationId: "operation_alpha",
      escalationDigest: "d".repeat(64),
      policyDigest: "e".repeat(64),
      unit: "tokens",
      expectedLimit: 1_000,
      expectedRunModeRevision: 3,
      increaseBy: 250,
    };
    expect(decodeGrantAllowancePayload(encodeGrantAllowancePayload(payload))).toEqual(payload);
    expectProtocolError("unknown-field", "$.ceiling", () =>
      decodeGrantAllowancePayload({ ...payload, ceiling: 10_000 }),
    );
    expectProtocolError("invalid-value", "$.increaseBy", () =>
      decodeGrantAllowancePayload({ ...payload, increaseBy: 0 }),
    );
  });

  it("requires one non-negative exact run-mode revision", () => {
    expect(
      decodeRunControlPayload(encodeRunControlPayload({ expectedRunModeRevision: 7 })),
    ).toEqual({ expectedRunModeRevision: 7 });
    expectProtocolError("invalid-value", "$.expectedRunModeRevision", () =>
      decodeRunControlPayload({ expectedRunModeRevision: -1 }),
    );
    expectProtocolError("unknown-field", "$.cancelDaemon", () =>
      decodeRunControlPayload({ expectedRunModeRevision: 7, cancelDaemon: true }),
    );
  });
});

describe("v1 amendment command payloads", () => {
  const amendmentId = "amendment_fixture";
  const proposalDigest = "b".repeat(64);
  const reviewedResultGraphRevisionDigest = "c".repeat(64);
  const decisionDigest = "d".repeat(64);

  it("decodes exact proposal, withdrawal, decision, and apply payloads", () => {
    const proposalPayload = { proposal: { amendmentId } };
    expect(
      decodeSubmitAmendmentProposalPayload(encodeSubmitAmendmentProposalPayload(proposalPayload)),
    ).toEqual({
      proposal: { amendmentId },
    });
    const withdrawalPayload = { amendmentId, proposalDigest };
    expect(
      decodeWithdrawAmendmentProposalPayload(
        encodeWithdrawAmendmentProposalPayload(withdrawalPayload),
      ),
    ).toEqual(withdrawalPayload);
    const decisionPayload = {
      amendmentId,
      proposalDigest,
      decision: "approve",
      reviewedResultGraphRevisionDigest,
    } as const;
    expect(
      decodeRecordAmendmentDecisionPayload({
        ...decodeRecordAmendmentDecisionPayload(
          encodeRecordAmendmentDecisionPayload(decisionPayload),
        ),
      }),
    ).toEqual(decisionPayload);
    const applyPayload = {
      amendmentId,
      proposalDigest,
      decisionDigest,
      reviewedResultGraphRevisionDigest,
    };
    const encodedApply = encodeApplyApprovedAmendmentPayload(applyPayload);
    expect(encodedApply).toBe(
      `{"amendmentId":"amendment_fixture","decisionDigest":"${decisionDigest}","proposalDigest":"${proposalDigest}","reviewedResultGraphRevisionDigest":"${reviewedResultGraphRevisionDigest}"}`,
    );
    expect(decodeApplyApprovedAmendmentPayload(encodedApply)).toEqual(applyPayload);
  });

  it("rejects extras, invalid decisions, and caller-supplied quiescence", () => {
    expectProtocolError("unknown-field", "$.mutableStatus", () =>
      decodeWithdrawAmendmentProposalPayload({
        amendmentId,
        proposalDigest,
        mutableStatus: "withdrawn",
      }),
    );
    expectProtocolError("invalid-value", "$.decision", () =>
      decodeRecordAmendmentDecisionPayload({
        amendmentId,
        proposalDigest,
        decision: "abstain",
        reviewedResultGraphRevisionDigest,
      }),
    );
    expectProtocolError("unknown-field", "$.quiescence", () =>
      decodeApplyApprovedAmendmentPayload({
        amendmentId,
        proposalDigest,
        decisionDigest,
        reviewedResultGraphRevisionDigest,
        quiescence: {},
      }),
    );
  });
});

describe("v1 identity and attribution values", () => {
  it("round trips standalone principal, transport, and run identity DTOs", () => {
    expect(decodeAuthenticatedPrincipal(encodeAuthenticatedPrincipal(command.principal))).toEqual(
      command.principal,
    );
    expect(decodeTransportAttribution(encodeTransportAttribution(command.transport))).toEqual(
      command.transport,
    );
    const runIdentity = { repositoryId: command.repositoryId, runId: command.runId };
    expect(decodeRunIdentity(encodeRunIdentity(runIdentity))).toEqual(runIdentity);
    expect(validateOpaqueIdentity("asset_evidence.01")).toBe("asset_evidence.01");
  });

  it("rejects malformed standalone identity and attribution values", () => {
    expectProtocolError("invalid-value", "$", () => validateOpaqueIdentity("Asset Invalid"));
    expectProtocolError("unknown-field", "$.principalId", () =>
      decodeAuthenticatedPrincipal({ ...command.principal, principalId: "override" }),
    );
    expectProtocolError("unknown-field", "$.issuer", () =>
      decodeTransportAttribution({ ...command.transport, issuer: "override" }),
    );
    expectProtocolError("unknown-field", "$.workflowId", () =>
      decodeRunIdentity({
        repositoryId: command.repositoryId,
        runId: command.runId,
        workflowId: "workflow_alpha",
      }),
    );
  });
});

describe("v1 receipts", () => {
  it("matches the canonical receipt golden fixture and round trips", () => {
    const encoded = encodeDurableReceipt(receipt);

    expect(encoded).toBe(GOLDEN_RECEIPT_JSON);
    expect(decodeDurableReceipt(encoded)).toEqual(receipt);
  });

  it.each([
    "queued",
    "claimed",
    "completed",
    "refused",
    "expired",
    "cancelled",
    "unknown-effect",
  ] as const)("accepts the %s durable status", (status) => {
    expect(decodeDurableReceipt({ ...receipt, status }).status).toBe(status);
  });

  it("rejects non-monotonic cursor representations and unknown fields", () => {
    for (const cursor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectProtocolError("invalid-value", "$.cursor", () =>
        decodeDurableReceipt({ ...receipt, cursor }),
      );
    }
    expectProtocolError("unknown-field", "$.sequence", () =>
      decodeDurableReceipt({ ...receipt, sequence: 8 }),
    );
  });
});

describe("v1 bounded query pages", () => {
  const receiptPage = {
    apiVersion: PROTOCOL_VERSION,
    repositoryId: command.repositoryId,
    runId: command.runId,
    afterCursor: 2,
    latestCursor: 7,
    hasMore: false,
    receipts: [{ ...receipt, cursor: 4 }, receipt],
  } as const;
  const eventPage = {
    apiVersion: PROTOCOL_VERSION,
    repositoryId: command.repositoryId,
    runId: command.runId,
    afterCursor: 2,
    earliestAvailableCursor: 1,
    latestCursor: 8,
    hasMore: false,
    events: [{ ...event, cursor: 5, eventId: "event_05" }, event],
  } as const;

  it("round trips exact sparse pages with frozen item arrays", () => {
    const decodedReceipts = decodeReceiptPage(encodeReceiptPage(receiptPage));
    const decodedEvents = decodeEventReplayPage(encodeEventReplayPage(eventPage));

    expect(decodedReceipts).toEqual(receiptPage);
    expect(decodedEvents).toEqual(eventPage);
    expect(Object.isFrozen(decodedReceipts.receipts)).toBe(true);
    expect(Object.isFrozen(decodedEvents.events)).toBe(true);
  });

  it("rejects extras, identity mismatches, invalid cursor bounds, and impossible hasMore", () => {
    expectProtocolError("unknown-field", "$.limit", () =>
      decodeReceiptPage({ ...receiptPage, limit: 2 }),
    );
    expectProtocolError("invalid-value", "$.receipts[0]", () =>
      decodeReceiptPage({
        ...receiptPage,
        receipts: [{ ...receipt, cursor: 4, repositoryId: "repository_other" }],
      }),
    );
    expectProtocolError("invalid-value", "$.events[1].cursor", () =>
      decodeEventReplayPage({
        ...eventPage,
        events: [
          { ...event, cursor: 5 },
          { ...event, cursor: 5, eventId: "event_other" },
        ],
      }),
    );
    expectProtocolError("invalid-value", "$.receipts[0].cursor", () =>
      decodeReceiptPage({ ...receiptPage, receipts: [{ ...receipt, cursor: 8 }] }),
    );
    expectProtocolError("invalid-value", "$.afterCursor", () =>
      decodeReceiptPage({ ...receiptPage, afterCursor: -1 }),
    );
    expectProtocolError("invalid-value", "$.latestCursor", () =>
      decodeReceiptPage({ ...receiptPage, latestCursor: -1 }),
    );
    expectProtocolError("invalid-value", "$.afterCursor", () =>
      decodeReceiptPage({ ...receiptPage, afterCursor: 8 }),
    );
    expectProtocolError("invalid-value", "$.afterCursor", () =>
      decodeEventReplayPage({ ...eventPage, afterCursor: 9 }),
    );
    expectProtocolError("invalid-value", "$.afterCursor", () =>
      decodeEventReplayPage({ ...eventPage, afterCursor: 0, earliestAvailableCursor: 2 }),
    );
    expect(
      decodeEventReplayPage({ ...eventPage, afterCursor: 0, earliestAvailableCursor: 1 }),
    ).toEqual({ ...eventPage, afterCursor: 0, earliestAvailableCursor: 1 });
    expectProtocolError("invalid-value", "$.hasMore", () =>
      decodeEventReplayPage({ ...eventPage, hasMore: true }),
    );
    expectProtocolError("invalid-value", "$.hasMore", () =>
      decodeEventReplayPage({ ...eventPage, events: [], hasMore: true }),
    );
    expect(decodeEventReplayPage({ ...eventPage, afterCursor: 7, events: [] })).toEqual({
      ...eventPage,
      afterCursor: 7,
      events: [],
    });
    expectProtocolError("invalid-value", "$.hasMore", () =>
      decodeEventReplayPage({
        ...eventPage,
        afterCursor: eventPage.latestCursor,
        events: [],
        hasMore: true,
      }),
    );
    expectProtocolError("invalid-value", "$.earliestAvailableCursor", () =>
      decodeEventReplayPage({ ...eventPage, earliestAvailableCursor: 9 }),
    );
  });

  it("rejects oversized, sparse, and accessor-backed item arrays", () => {
    expectProtocolError("oversized", "$.receipts", () =>
      decodeReceiptPage({
        ...receiptPage,
        receipts: Array.from({ length: PROTOCOL_LIMITS.maxPageItems + 1 }, () => null),
      }),
    );

    const sparseEvents = Array(2);
    sparseEvents[0] = event;
    expectProtocolError("invalid-type", "$.events", () =>
      decodeEventReplayPage({ ...eventPage, events: sparseEvents }),
    );

    let invoked = false;
    const adversarial = { ...receiptPage } as Record<string, unknown>;
    Object.defineProperty(adversarial, "receipts", {
      enumerable: true,
      get() {
        invoked = true;
        return [];
      },
    });
    expectProtocolError("invalid-type", "$.receipts", () => decodeReceiptPage(adversarial));
    expect(invoked).toBe(false);
  });
});

describe("v1 supervisor persistence codecs", () => {
  it("decodes exact admission allocations and rejects unknown allocation fields", () => {
    const admission = {
      currentTime: "2026-08-12T12:00:00Z",
      facts: { source: "test" },
      allocations: [{ kind: "stream-event", id: "stream-event-1" }],
    } as const;
    expect(decodeSupervisorAdmissionFacts(admission)).toEqual(admission);
    expectProtocolError("unknown-field", "$.allocations[0].bogus", () =>
      decodeSupervisorAdmissionFacts({
        ...admission,
        allocations: [{ ...admission.allocations[0], bogus: true }],
      }),
    );
  });

  it("requires exact staged receipt shape and terminal durable receipt semantics", () => {
    const queued = {
      sequence: 1,
      commandId: command.commandId,
      repositoryId: command.repositoryId,
      runId: command.runId,
      status: "queued",
      recordedAt: "2026-08-12T12:00:00Z",
    } as const;
    expect(decodeSupervisorReceipt(queued)).toEqual(queued);
    expectProtocolError("unknown-field", "$.bogus", () =>
      decodeSupervisorReceipt({ ...queued, bogus: true }),
    );
    expectProtocolError("invalid-value", "$.terminalReceipt", () =>
      decodeSupervisorReceipt({ ...queued, status: "terminal" }),
    );
    expectProtocolError("invalid-value", "$.terminalReceipt", () =>
      decodeSupervisorReceipt({
        ...queued,
        status: "terminal",
        terminalReceipt: { ...receipt, commandId: "command_other" },
      }),
    );
  });

  it("enforces wake generations, canonical reasons, and exact service records", () => {
    const wake = {
      repositoryId: command.repositoryId,
      runId: command.runId,
      generation: 2,
      acknowledgedGeneration: 1,
      notBefore: "2026-08-12T12:00:00.500Z",
      reasons: ["command-accepted"],
    } as const;
    expect(decodeSupervisorWake(wake)).toEqual(wake);
    expectProtocolError("invalid-value", "$.acknowledgedGeneration", () =>
      decodeSupervisorWake({ ...wake, acknowledgedGeneration: 3 }),
    );
    expectProtocolError("invalid-value", "$.reasons[0]", () =>
      decodeSupervisorWake({ ...wake, reasons: ["unknown"] }),
    );
    expectProtocolError("unknown-field", "$.bogus", () =>
      decodeSupervisorServiceRecord({
        mode: "running",
        changedAt: "2026-08-12T12:00:00Z",
        bogus: true,
      }),
    );
  });
});

describe("v1 event, projection, capability, and error envelopes", () => {
  it("round trips canonical event and projection envelopes", () => {
    expect(decodeEventStreamFrame(encodeEventStreamFrame(event))).toEqual(event);
    expect(decodeProjectionEnvelope(encodeProjectionEnvelope(projection))).toEqual(projection);
  });

  it("round trips the capability handshake and error envelope", () => {
    expect(decodeCapabilityHandshake(encodeCapabilityHandshake(handshake))).toEqual(handshake);
    expect(decodeErrorEnvelope(encodeErrorEnvelope(errorEnvelope))).toEqual(errorEnvelope);
  });

  it("rejects ambiguous or non-canonical capability lists", () => {
    expectProtocolError("invalid-value", "$.supportedVersions", () =>
      decodeCapabilityHandshake({
        ...handshake,
        supportedVersions: ["senawa.dev/protocol/v2"],
      }),
    );
    expectProtocolError("invalid-value", "$.capabilities", () =>
      decodeCapabilityHandshake({
        ...handshake,
        capabilities: ["event-stream", "command-submit"],
      }),
    );
  });

  it("rejects unknown fields in every remaining envelope", () => {
    const cases = [
      [decodeEventStreamFrame, { ...event, offset: 8 }, "$.offset"],
      [decodeProjectionEnvelope, { ...projection, state: "active" }, "$.state"],
      [decodeCapabilityHandshake, { ...handshake, version: PROTOCOL_VERSION }, "$.version"],
      [decodeErrorEnvelope, { ...errorEnvelope, status: 409 }, "$.status"],
    ] as const;

    for (const [decode, value, path] of cases) {
      expectProtocolError("unknown-field", path, () => decode(value));
    }
  });
});

function expectProtocolError(
  code: ProtocolValidationError["code"],
  path: string | ReturnType<typeof expect.stringContaining>,
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
