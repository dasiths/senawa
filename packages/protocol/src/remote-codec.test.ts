import { describe, expect, it } from "vitest";
import { GOLDEN_REMOTE_ENVELOPE_JSON } from "./fixtures/remote-wire-v1.js";
import {
  decodeRemoteCentralAcceptedCommand,
  decodeRemoteClassifiedReport,
  decodeRemoteCommandEnvelope,
  decodeRemoteHelloOffer,
  decodeRemoteHelloResponse,
  decodeRemoteReceiptChain,
  decodeRemoteReceiptChainEntry,
  decodeRemoteReportAcknowledgement,
  decodeRemoteRepositoryBinding,
  decodeRemoteSynchronizationVector,
  encodeRemoteCentralAcceptedCommand,
  encodeRemoteClassifiedReport,
  encodeRemoteCommandEnvelope,
  encodeRemoteHelloOffer,
  encodeRemoteHelloResponse,
  encodeRemoteReceiptChain,
  encodeRemoteReceiptChainEntry,
  encodeRemoteReportAcknowledgement,
  encodeRemoteRepositoryBinding,
  encodeRemoteSynchronizationVector,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  REMOTE_CAPABILITIES,
  REMOTE_NEGOTIATION_VERSION,
  REMOTE_PROTOCOL_LIMITS,
  REMOTE_PROTOCOL_VERSION,
} from "./index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const SIGNATURE = "A".repeat(86);

const binding = Object.freeze({
  apiVersion: REMOTE_PROTOCOL_VERSION,
  bindingId: "binding_alpha",
  tenantId: "tenant_alpha",
  repositoryId: "repository_alpha",
  connectorId: "connector_alpha",
  repositoryKeyId: "key_repository_alpha",
  controlPlaneKeyId: "key_control_alpha",
  revocationEpoch: 2,
  policyDigest: DIGEST_A,
  issuedAt: "2026-08-14T09:00:00.000Z",
});

const command = Object.freeze({
  apiVersion: PROTOCOL_VERSION,
  commandId: "command_remote-alpha",
  repositoryId: binding.repositoryId,
  runId: "run_alpha",
  intent: { type: "pause-run" },
  payload: { expectedRunModeRevision: 3 },
  payloadDigest: DIGEST_A,
  expiresAt: "2026-08-14T11:00:00.000Z",
} as const);

const acceptedCommand = Object.freeze({
  apiVersion: REMOTE_PROTOCOL_VERSION,
  acceptanceId: "acceptance_alpha",
  binding,
  attribution: {
    principal: {
      issuer: "https://control.example.test",
      subject: "operator@example.test",
      tenant: binding.tenantId,
      assurance: "multi-factor",
      roles: ["operator", "release-manager"],
    },
    transport: { kind: "remote", requestId: "request_remote_alpha" },
  },
  command,
  commandDigest: DIGEST_B,
  acceptedAt: "2026-08-14T10:00:00.000Z",
  expiresAt: command.expiresAt,
} as const);

const envelope = Object.freeze({
  apiVersion: REMOTE_PROTOCOL_VERSION,
  sequence: 1,
  previousEnvelopeDigest: null,
  acceptedCommand,
  acceptedCommandDigest: DIGEST_C,
  issuedAt: "2026-08-14T10:01:00.000Z",
  signingKeyId: binding.controlPlaneKeyId,
  signature: SIGNATURE,
} as const);

const receiptEntries = Object.freeze([
  {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: binding.bindingId,
    commandId: command.commandId,
    stage: "central-accepted",
    stageSequence: 1,
    recordedAt: "2026-08-14T10:00:00.000Z",
    previousEntryDigest: null,
    entryDigest: "1".repeat(64),
    evidence: {
      type: "central-acceptance",
      acceptanceId: acceptedCommand.acceptanceId,
      acceptanceDigest: DIGEST_B,
    },
  },
  {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: binding.bindingId,
    commandId: command.commandId,
    stage: "connector-delivered",
    stageSequence: 2,
    recordedAt: "2026-08-14T10:01:00.000Z",
    previousEntryDigest: "1".repeat(64),
    entryDigest: "2".repeat(64),
    evidence: { type: "connector-delivery", envelopeSequence: 1, envelopeDigest: DIGEST_C },
  },
  {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: binding.bindingId,
    commandId: command.commandId,
    stage: "local-accepted",
    stageSequence: 3,
    recordedAt: "2026-08-14T10:02:00.000Z",
    previousEntryDigest: "2".repeat(64),
    entryDigest: "3".repeat(64),
    evidence: {
      type: "local-receipt",
      localCommandId: command.commandId,
      receiptStatus: "queued",
      receiptCursor: 10,
      receiptDigest: "3".repeat(64),
    },
  },
  {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: binding.bindingId,
    commandId: command.commandId,
    stage: "runner-claimed",
    stageSequence: 4,
    recordedAt: "2026-08-14T10:03:00.000Z",
    previousEntryDigest: "3".repeat(64),
    entryDigest: "4".repeat(64),
    evidence: {
      type: "local-receipt",
      localCommandId: command.commandId,
      receiptStatus: "claimed",
      receiptCursor: 11,
      receiptDigest: "4".repeat(64),
    },
  },
  {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: binding.bindingId,
    commandId: command.commandId,
    stage: "local-outcome",
    stageSequence: 5,
    recordedAt: "2026-08-14T10:04:00.000Z",
    previousEntryDigest: "4".repeat(64),
    entryDigest: "5".repeat(64),
    evidence: {
      type: "local-outcome",
      localCommandId: command.commandId,
      receiptStatus: "completed",
      receiptCursor: 12,
      receiptDigest: "5".repeat(64),
    },
  },
] as const);

const receiptChain = Object.freeze({
  bindingId: binding.bindingId,
  commandId: command.commandId,
  entries: receiptEntries,
});

const synchronization = Object.freeze({
  repositoryId: binding.repositoryId,
  localLatestCursor: 14,
  durablyEnqueuedCursor: 13,
  centrallyAcknowledgedCursor: 10,
  localObservedAt: "2026-08-14T10:10:00.000Z",
  lastEnqueuedAt: "2026-08-14T10:08:00.000Z",
  lastAcknowledgedAt: "2026-08-14T10:09:00.000Z",
});

const eventMetadata = Object.freeze({
  cursor: 13,
  repositoryId: binding.repositoryId,
  runId: command.runId,
  eventId: "event_alpha",
  eventType: "run-paused",
  occurredAt: "2026-08-14T10:05:00.000Z",
  payloadDigest: DIGEST_A,
  commandId: command.commandId,
});

const projectionMetadata = Object.freeze({
  cursor: 14,
  repositoryId: binding.repositoryId,
  runId: command.runId,
  projectionType: "run-summary",
  revision: "revision_alpha",
  generatedAt: "2026-08-14T10:06:00.000Z",
  payloadDigest: DIGEST_B,
  lifecycleStatus: "paused",
  counts: { tasks: 4, readyTasks: 1, humanNeeds: 1, activeEffects: 0, uncertainEffects: 0 },
});

const report = Object.freeze({
  apiVersion: REMOTE_PROTOCOL_VERSION,
  reportId: "report_alpha",
  binding,
  classification: "internal",
  dataPolicyDigest: DIGEST_C,
  reportSequence: 1,
  previousReportDigest: null,
  createdAt: "2026-08-14T10:10:00.000Z",
  receiptChains: [receiptChain],
  events: [eventMetadata],
  projections: [projectionMetadata],
  synchronization,
} as const);

describe("remote hello negotiation codecs", () => {
  const unsupportedOffer = {
    negotiationVersion: REMOTE_NEGOTIATION_VERSION,
    peerId: "connector_alpha",
    supportedVersions: ["senawa.dev/remote-control/v2"],
    capabilities: [...REMOTE_CAPABILITIES],
  } as const;

  it("decodes a syntactically valid unsupported offer and a typed no-common-version refusal", () => {
    expect(decodeRemoteHelloOffer(encodeRemoteHelloOffer(unsupportedOffer))).toEqual(
      unsupportedOffer,
    );
    const refusal = {
      negotiationVersion: REMOTE_NEGOTIATION_VERSION,
      type: "refusal",
      code: "no-common-version",
      message: "No common remote-control protocol version.",
      supportedVersions: [REMOTE_PROTOCOL_VERSION],
      requiredCapabilities: [...REMOTE_CAPABILITIES],
    } as const;
    expect(decodeRemoteHelloResponse(encodeRemoteHelloResponse(refusal))).toEqual(refusal);
  });

  it("accepts only the exact selected version and required capability set", () => {
    const selection = {
      negotiationVersion: REMOTE_NEGOTIATION_VERSION,
      type: "selection",
      sessionId: "session_alpha",
      serverPeerId: "control_alpha",
      selectedVersion: REMOTE_PROTOCOL_VERSION,
      capabilities: [...REMOTE_CAPABILITIES],
    } as const;
    expect(decodeRemoteHelloResponse(encodeRemoteHelloResponse(selection))).toEqual(selection);
    expectProtocolError("invalid-value", "$.selectedVersion", () =>
      decodeRemoteHelloResponse({
        ...selection,
        selectedVersion: "senawa.dev/remote-control/v2",
      }),
    );
    expectProtocolError("invalid-value", "$.capabilities", () =>
      decodeRemoteHelloResponse({ ...selection, capabilities: REMOTE_CAPABILITIES.slice(1) }),
    );
  });

  it("rejects unknown, missing, duplicate, unsorted, malformed, and oversized negotiation data", () => {
    expectProtocolError("unknown-field", "$.tenantId", () =>
      decodeRemoteHelloOffer({ ...unsupportedOffer, tenantId: "tenant_override" }),
    );
    const { peerId: _peerId, ...missingPeer } = unsupportedOffer;
    expectProtocolError("missing-field", "$.peerId", () => decodeRemoteHelloOffer(missingPeer));
    expectProtocolError("invalid-value", "$.capabilities", () =>
      decodeRemoteHelloOffer({
        ...unsupportedOffer,
        capabilities: [REMOTE_CAPABILITIES[1], REMOTE_CAPABILITIES[0]],
      }),
    );
    expectProtocolError("invalid-value", "$.supportedVersions", () =>
      decodeRemoteHelloOffer({
        ...unsupportedOffer,
        supportedVersions: ["senawa.dev/remote-control/v2", "senawa.dev/remote-control/v2"],
      }),
    );
    expectProtocolError("invalid-value", "$.supportedVersions[0]", () =>
      decodeRemoteHelloOffer({ ...unsupportedOffer, supportedVersions: [PROTOCOL_VERSION] }),
    );
    const tooManyCapabilities = Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.maxCapabilities + 1 },
      (_, index) => `capability-${String(index).padStart(2, "0")}`,
    );
    expectProtocolError("oversized", "$.capabilities", () =>
      decodeRemoteHelloOffer({ ...unsupportedOffer, capabilities: tooManyCapabilities }),
    );
  });
});

describe("remote binding, acceptance, and envelope codecs", () => {
  it("round trips exact repository binding and server-derived attribution", () => {
    expect(decodeRemoteRepositoryBinding(encodeRemoteRepositoryBinding(binding))).toEqual(binding);
    expect(
      decodeRemoteCentralAcceptedCommand(encodeRemoteCentralAcceptedCommand(acceptedCommand)),
    ).toEqual(acceptedCommand);
    expectProtocolError("unknown-field", "$.principal", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        principal: acceptedCommand.attribution.principal,
      }),
    );
    expectProtocolError("unknown-field", "$.endpoint", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        binding: { ...binding, endpoint: "https://secret.example.test" },
      }),
    );
  });

  it("keeps outer and inner protocol versions independent and exact", () => {
    expectProtocolError("invalid-value", "$.apiVersion", () =>
      decodeRemoteCentralAcceptedCommand({ ...acceptedCommand, apiVersion: PROTOCOL_VERSION }),
    );
    expectProtocolError("invalid-value", "$.apiVersion", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        command: { ...command, apiVersion: REMOTE_PROTOCOL_VERSION },
      }),
    );
  });

  it("rejects repository, tenant, transport, expiry, key, identity, timestamp, and digest mismatch", () => {
    expectProtocolError("invalid-value", "$.command.repositoryId", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        command: { ...command, repositoryId: "repository_other" },
      }),
    );
    expectProtocolError("invalid-value", "$.attribution.principal.tenant", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        attribution: {
          ...acceptedCommand.attribution,
          principal: { ...acceptedCommand.attribution.principal, tenant: "tenant_other" },
        },
      }),
    );
    expectProtocolError("invalid-value", "$.attribution.transport.kind", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        attribution: {
          ...acceptedCommand.attribution,
          transport: { kind: "http", requestId: "request_remote_alpha" },
        },
      }),
    );
    expectProtocolError("invalid-value", "$.command.expiresAt", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        expiresAt: "2026-08-14T10:30:00.000Z",
      }),
    );
    expectProtocolError("invalid-value", "$.expiresAt", () =>
      decodeRemoteCentralAcceptedCommand({
        ...acceptedCommand,
        acceptedAt: "2026-08-14T12:00:00.000Z",
      }),
    );
    expectProtocolError("invalid-value", "$.bindingId", () =>
      decodeRemoteRepositoryBinding({ ...binding, bindingId: "Binding Alpha" }),
    );
    expectProtocolError("invalid-value", "$.issuedAt", () =>
      decodeRemoteRepositoryBinding({ ...binding, issuedAt: "2026-02-31T00:00:00Z" }),
    );
    expectProtocolError("invalid-value", "$.policyDigest", () =>
      decodeRemoteRepositoryBinding({ ...binding, policyDigest: DIGEST_A.toUpperCase() }),
    );
  });

  it("matches the canonical envelope golden and enforces ordered hash links", () => {
    const encoded = encodeRemoteCommandEnvelope(envelope);
    expect(encoded).toBe(GOLDEN_REMOTE_ENVELOPE_JSON);
    expect(decodeRemoteCommandEnvelope(encoded)).toEqual(envelope);
    expectProtocolError("invalid-json", "$", () => decodeRemoteCommandEnvelope(` ${encoded}`));
    expectProtocolError("invalid-value", "$.previousEnvelopeDigest", () =>
      decodeRemoteCommandEnvelope({ ...envelope, previousEnvelopeDigest: DIGEST_A }),
    );
    expectProtocolError("invalid-value", "$.previousEnvelopeDigest", () =>
      decodeRemoteCommandEnvelope({ ...envelope, sequence: 2 }),
    );
    expectProtocolError("invalid-value", "$.signingKeyId", () =>
      decodeRemoteCommandEnvelope({ ...envelope, signingKeyId: "key_other" }),
    );
    expectProtocolError("invalid-value", "$.signature", () =>
      decodeRemoteCommandEnvelope({ ...envelope, signature: "not-a-signature" }),
    );
    expectProtocolError("invalid-value", "$.signature", () =>
      decodeRemoteCommandEnvelope({
        ...envelope,
        signature: `${envelope.signature.slice(0, -1)}B`,
      }),
    );
  });
});

describe("remote five-stage receipt-chain codecs", () => {
  it("round trips each stage and one complete linked chain", () => {
    for (const entry of receiptEntries)
      expect(decodeRemoteReceiptChainEntry(encodeRemoteReceiptChainEntry(entry))).toEqual(entry);
    expect(decodeRemoteReceiptChain(encodeRemoteReceiptChain(receiptChain))).toEqual(receiptChain);
  });

  it("accepts a valid chain prefix without conflating central acceptance with execution", () => {
    const prefix = { ...receiptChain, entries: receiptEntries.slice(0, 2) };
    const decoded = decodeRemoteReceiptChain(prefix);
    expect(decoded.entries.map(({ stage }) => stage)).toEqual([
      "central-accepted",
      "connector-delivered",
    ]);
    expect(decoded.entries).toHaveLength(2);
  });

  it("rejects stage, link, identity, cursor, and evidence mismatches", () => {
    expectProtocolError("invalid-value", "$.stageSequence", () =>
      decodeRemoteReceiptChainEntry({ ...receiptEntries[1], stageSequence: 3 }),
    );
    expectProtocolError("invalid-value", "$.previousEntryDigest", () =>
      decodeRemoteReceiptChainEntry({ ...receiptEntries[0], previousEntryDigest: DIGEST_A }),
    );
    expectProtocolError("invalid-value", "$.evidence.receiptStatus", () =>
      decodeRemoteReceiptChainEntry({
        ...receiptEntries[2],
        evidence: { ...receiptEntries[2].evidence, receiptStatus: "claimed" },
      }),
    );
    expectProtocolError("invalid-value", "$.entries[1].previousEntryDigest", () =>
      decodeRemoteReceiptChain({
        ...receiptChain,
        entries: [receiptEntries[0], { ...receiptEntries[1], previousEntryDigest: DIGEST_A }],
      }),
    );
    expectProtocolError("invalid-value", "$.entries[2].stageSequence", () =>
      decodeRemoteReceiptChain({
        ...receiptChain,
        entries: [receiptEntries[0], receiptEntries[1], receiptEntries[3]],
      }),
    );
    expectProtocolError("invalid-value", "$.entries[3].evidence.localCommandId", () =>
      decodeRemoteReceiptChain({
        ...receiptChain,
        entries: receiptEntries.map((entry, index) =>
          index === 3
            ? { ...entry, evidence: { ...entry.evidence, localCommandId: "command_other" } }
            : entry,
        ),
      }),
    );
    expectProtocolError("invalid-value", "$.entries[3].evidence.receiptCursor", () =>
      decodeRemoteReceiptChain({
        ...receiptChain,
        entries: receiptEntries.map((entry, index) =>
          index === 3 ? { ...entry, evidence: { ...entry.evidence, receiptCursor: 10 } } : entry,
        ),
      }),
    );
    expect(
      decodeRemoteReceiptChain({
        ...receiptChain,
        entries: receiptEntries.map((entry, index) =>
          index === 2 ? { ...entry, recordedAt: "2026-08-14T09:59:00.000Z" } : entry,
        ),
      }).entries[2]?.recordedAt,
    ).toBe("2026-08-14T09:59:00.000Z");
  });
});

describe("remote classified report, synchronization, and acknowledgement codecs", () => {
  it("round trips classified metadata without raw event or projection payloads", () => {
    expect(decodeRemoteClassifiedReport(encodeRemoteClassifiedReport(report))).toEqual(report);
    expect(Object.keys(decodeRemoteClassifiedReport(report).events[0] ?? {})).not.toContain(
      "payload",
    );
    expect(Object.keys(decodeRemoteClassifiedReport(report).projections[0] ?? {})).not.toContain(
      "payload",
    );
    expectProtocolError("unknown-field", "$.events[0].payload", () =>
      decodeRemoteClassifiedReport({
        ...report,
        events: [{ ...eventMetadata, payload: { source: "/workspace/private" } }],
      }),
    );
    expectProtocolError("unknown-field", "$.projections[0].payload", () =>
      decodeRemoteClassifiedReport({
        ...report,
        projections: [{ ...projectionMetadata, payload: { credentials: "secret" } }],
      }),
    );
    expectProtocolError("unknown-field", "$.sourcePath", () =>
      decodeRemoteClassifiedReport({ ...report, sourcePath: "/workspace/private" }),
    );
    expectProtocolError("invalid-value", "$.classification", () =>
      decodeRemoteClassifiedReport({ ...report, classification: "confidential" }),
    );
  });

  it("enforces report links, repository binding, sorted uniqueness, cursor bounds, and list bounds", () => {
    expectProtocolError("invalid-value", "$.previousReportDigest", () =>
      decodeRemoteClassifiedReport({ ...report, previousReportDigest: DIGEST_A }),
    );
    expectProtocolError("invalid-value", "$.events[0].repositoryId", () =>
      decodeRemoteClassifiedReport({
        ...report,
        events: [{ ...eventMetadata, repositoryId: "repository_other" }],
      }),
    );
    expectProtocolError("invalid-value", "$.events[1].cursor", () =>
      decodeRemoteClassifiedReport({
        ...report,
        events: [eventMetadata, { ...eventMetadata, eventId: "event_beta" }],
      }),
    );
    expect(
      decodeRemoteClassifiedReport({
        ...report,
        events: [
          { ...eventMetadata, cursor: 13 },
          {
            ...eventMetadata,
            cursor: 1,
            runId: "run_beta",
            eventId: "event_beta",
          },
        ],
      }).events.map(({ runId, cursor }) => [runId, cursor]),
    ).toEqual([
      ["run_alpha", 13],
      ["run_beta", 1],
    ]);
    expectProtocolError("invalid-value", "$.projections", () =>
      decodeRemoteClassifiedReport({
        ...report,
        projections: [projectionMetadata, { ...projectionMetadata, revision: "revision_beta" }],
      }),
    );
    expectProtocolError("invalid-value", "$.events[0].cursor", () =>
      decodeRemoteClassifiedReport({
        ...report,
        events: [{ ...eventMetadata, cursor: synchronization.localLatestCursor + 1 }],
      }),
    );
    expectProtocolError("oversized", "$.events", () =>
      decodeRemoteClassifiedReport({
        ...report,
        events: Array.from({ length: REMOTE_PROTOCOL_LIMITS.maxEvents + 1 }, () => eventMetadata),
      }),
    );
  });

  it("enforces exact synchronization arithmetic and timestamp presence", () => {
    expect(
      decodeRemoteSynchronizationVector(encodeRemoteSynchronizationVector(synchronization)),
    ).toEqual(synchronization);
    expectProtocolError("invalid-value", "$.durablyEnqueuedCursor", () =>
      decodeRemoteSynchronizationVector({
        ...synchronization,
        durablyEnqueuedCursor: synchronization.localLatestCursor + 1,
      }),
    );
    expectProtocolError("invalid-value", "$.centrallyAcknowledgedCursor", () =>
      decodeRemoteSynchronizationVector({
        ...synchronization,
        centrallyAcknowledgedCursor: synchronization.durablyEnqueuedCursor + 1,
      }),
    );
    expectProtocolError("invalid-value", "$.lastAcknowledgedAt", () =>
      decodeRemoteSynchronizationVector({ ...synchronization, lastAcknowledgedAt: null }),
    );
    expect(
      decodeRemoteSynchronizationVector({
        ...synchronization,
        lastEnqueuedAt: "2026-08-14T10:11:00.000Z",
        lastAcknowledgedAt: "2026-08-14T09:59:00.000Z",
      }),
    ).toMatchObject({
      lastEnqueuedAt: "2026-08-14T10:11:00.000Z",
      lastAcknowledgedAt: "2026-08-14T09:59:00.000Z",
    });
    expect(
      decodeRemoteClassifiedReport({
        ...report,
        createdAt: "2026-08-14T08:59:00.000Z",
      }).createdAt,
    ).toBe("2026-08-14T08:59:00.000Z");
    expect(
      decodeRemoteSynchronizationVector({
        repositoryId: binding.repositoryId,
        localLatestCursor: 0,
        durablyEnqueuedCursor: 0,
        centrallyAcknowledgedCursor: 0,
        localObservedAt: "2026-08-14T10:10:00.000Z",
        lastEnqueuedAt: null,
        lastAcknowledgedAt: null,
      }),
    ).toMatchObject({ centrallyAcknowledgedCursor: 0 });
  });

  it("round trips one exact acknowledgement and rejects attribution-like extras", () => {
    const acknowledgement = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      bindingId: binding.bindingId,
      repositoryId: binding.repositoryId,
      reportId: report.reportId,
      reportSequence: report.reportSequence,
      reportDigest: DIGEST_C,
      centralReceiptId: "central_receipt_alpha",
      acknowledgedAt: "2026-08-14T10:11:00.000Z",
      signingKeyId: binding.controlPlaneKeyId,
      signature: SIGNATURE,
    } as const;
    expect(
      decodeRemoteReportAcknowledgement(encodeRemoteReportAcknowledgement(acknowledgement)),
    ).toEqual(acknowledgement);
    expectProtocolError("unknown-field", "$.principal", () =>
      decodeRemoteReportAcknowledgement({ ...acknowledgement, principal: "override" }),
    );
    const { reportDigest: _reportDigest, ...missingDigest } = acknowledgement;
    expectProtocolError("missing-field", "$.reportDigest", () =>
      decodeRemoteReportAcknowledgement(missingDigest),
    );
    expectProtocolError("invalid-value", "$.reportSequence", () =>
      decodeRemoteReportAcknowledgement({ ...acknowledgement, reportSequence: 0 }),
    );
    expectProtocolError("invalid-value", "$.reportDigest", () =>
      decodeRemoteReportAcknowledgement({ ...acknowledgement, reportDigest: "short" }),
    );
    expectProtocolError("invalid-value", "$.acknowledgedAt", () =>
      decodeRemoteReportAcknowledgement({
        ...acknowledgement,
        acknowledgedAt: "2026-13-14T10:11:00Z",
      }),
    );
  });
});

function expectProtocolError(
  code: ProtocolValidationError["code"],
  path: string | ReturnType<typeof expect.stringContaining>,
  run: () => unknown,
): void {
  try {
    run();
    throw new Error("expected protocol validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolValidationError);
    expect(error).toMatchObject({ code });
    expect((error as ProtocolValidationError).path).toEqual(path);
  }
}
