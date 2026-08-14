import {
  canonicalStringify,
  decodeAuthenticatedPrincipal,
  decodeCanonicalJsonValue,
  decodeCommandSubmission,
  decodeTransportAttribution,
  PROTOCOL_LIMITS,
  ProtocolValidationError,
} from "./codec.js";
import type { ReceiptStatus } from "./contracts.js";
import {
  REMOTE_CAPABILITIES,
  REMOTE_NEGOTIATION_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RECEIPT_STAGES,
  type RemoteCapability,
  type RemoteCentralAcceptedCommand,
  type RemoteClassifiedReport,
  type RemoteCommandEnvelope,
  type RemoteEventMetadata,
  type RemoteHelloOffer,
  type RemoteHelloRefusal,
  type RemoteHelloRefusalCode,
  type RemoteHelloResponse,
  type RemoteHelloSelection,
  type RemoteProjectionCounts,
  type RemoteProjectionMetadata,
  type RemoteReceiptChain,
  type RemoteReceiptChainEntry,
  type RemoteReceiptEvidence,
  type RemoteReceiptStage,
  type RemoteReportAcknowledgement,
  type RemoteReportClassification,
  type RemoteRepositoryBinding,
  type RemoteServerAttribution,
  type RemoteSynchronizationVector,
} from "./remote-contracts.js";

export const REMOTE_PROTOCOL_LIMITS = Object.freeze({
  maxSupportedVersions: 16,
  maxCapabilities: 32,
  maxMessageLength: 4_096,
  maxReceiptChains: 64,
  maxEvents: 256,
  maxProjections: 256,
  signatureLength: 86,
});

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REMOTE_VERSION_PATTERN =
  /^senawa\.dev\/remote-control\/v[1-9][0-9]*(?:alpha|beta|rc)[1-9][0-9]*$/;
const REFUSAL_CODES = new Set<RemoteHelloRefusalCode>([
  "no-common-version",
  "missing-capability",
  "binding-refused",
  "revoked",
]);
const REPORT_CLASSIFICATIONS = new Set<RemoteReportClassification>(["public", "internal"]);
const TERMINAL_RECEIPT_STATUSES = new Set<Exclude<ReceiptStatus, "queued" | "claimed">>([
  "completed",
  "refused",
  "expired",
  "cancelled",
  "unknown-effect",
]);

export function decodeRemoteHelloOffer(input: string | unknown): RemoteHelloOffer {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "negotiationVersion",
    "peerId",
    "supportedVersions",
    "capabilities",
  ]);
  negotiationVersion(object.negotiationVersion, "$.negotiationVersion");
  identity(object.peerId, "$.peerId");
  const supportedVersions = sortedStringSet(
    object.supportedVersions,
    "$.supportedVersions",
    REMOTE_PROTOCOL_LIMITS.maxSupportedVersions,
    remoteVersion,
  );
  if (supportedVersions.length === 0)
    fail("invalid-value", "$.supportedVersions", "must contain at least one version");
  const capabilities = sortedStringSet(
    object.capabilities,
    "$.capabilities",
    REMOTE_PROTOCOL_LIMITS.maxCapabilities,
    capability,
  );
  return Object.freeze({
    negotiationVersion: REMOTE_NEGOTIATION_VERSION,
    peerId: object.peerId as string,
    supportedVersions,
    capabilities,
  });
}

export function encodeRemoteHelloOffer(input: unknown): string {
  return canonicalStringify(decodeRemoteHelloOffer(input));
}

export function decodeRemoteHelloResponse(input: string | unknown): RemoteHelloResponse {
  const value = decodeCanonicalJsonValue(input);
  const discriminator = exactObject(
    value,
    "$",
    ["negotiationVersion", "type"],
    [
      "sessionId",
      "serverPeerId",
      "selectedVersion",
      "capabilities",
      "code",
      "message",
      "supportedVersions",
      "requiredCapabilities",
    ],
  );
  negotiationVersion(discriminator.negotiationVersion, "$.negotiationVersion");
  if (discriminator.type === "selection") return helloSelection(value);
  if (discriminator.type === "refusal") return helloRefusal(value);
  return fail("invalid-value", "$.type", "must be selection or refusal");
}

export function encodeRemoteHelloResponse(input: unknown): string {
  return canonicalStringify(decodeRemoteHelloResponse(input));
}

export function decodeRemoteRepositoryBinding(input: string | unknown): RemoteRepositoryBinding {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "bindingId",
    "tenantId",
    "repositoryId",
    "connectorId",
    "repositoryKeyId",
    "controlPlaneKeyId",
    "revocationEpoch",
    "policyDigest",
    "issuedAt",
  ]);
  remoteProtocolVersion(object.apiVersion, "$.apiVersion");
  for (const field of [
    "bindingId",
    "tenantId",
    "repositoryId",
    "connectorId",
    "repositoryKeyId",
    "controlPlaneKeyId",
  ] as const)
    identity(object[field], `$.${field}`);
  nonNegativeInteger(object.revocationEpoch, "$.revocationEpoch");
  digest(object.policyDigest, "$.policyDigest");
  timestamp(object.issuedAt, "$.issuedAt");
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: object.bindingId as string,
    tenantId: object.tenantId as string,
    repositoryId: object.repositoryId as string,
    connectorId: object.connectorId as string,
    repositoryKeyId: object.repositoryKeyId as string,
    controlPlaneKeyId: object.controlPlaneKeyId as string,
    revocationEpoch: object.revocationEpoch as number,
    policyDigest: object.policyDigest as string,
    issuedAt: object.issuedAt as string,
  });
}

export function encodeRemoteRepositoryBinding(input: unknown): string {
  return canonicalStringify(decodeRemoteRepositoryBinding(input));
}

export function decodeRemoteCentralAcceptedCommand(
  input: string | unknown,
): RemoteCentralAcceptedCommand {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "acceptanceId",
    "binding",
    "attribution",
    "command",
    "commandDigest",
    "acceptedAt",
    "expiresAt",
  ]);
  remoteProtocolVersion(object.apiVersion, "$.apiVersion");
  identity(object.acceptanceId, "$.acceptanceId");
  const binding = decodeRemoteRepositoryBinding(object.binding);
  const attribution = serverAttribution(object.attribution, "$.attribution");
  const command = decodeCommandSubmission(object.command);
  digest(object.commandDigest, "$.commandDigest");
  timestamp(object.acceptedAt, "$.acceptedAt");
  timestamp(object.expiresAt, "$.expiresAt");
  if (command.repositoryId !== binding.repositoryId)
    fail("invalid-value", "$.command.repositoryId", "must equal the repository binding");
  if (attribution.principal.tenant !== binding.tenantId)
    fail("invalid-value", "$.attribution.principal.tenant", "must equal the repository binding");
  if (command.expiresAt !== object.expiresAt)
    fail("invalid-value", "$.command.expiresAt", "must equal the accepted expiry");
  assertTimestampOrder(object.acceptedAt as string, object.expiresAt as string, "$.expiresAt");
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    acceptanceId: object.acceptanceId as string,
    binding,
    attribution,
    command,
    commandDigest: object.commandDigest as string,
    acceptedAt: object.acceptedAt as string,
    expiresAt: object.expiresAt as string,
  });
}

export function encodeRemoteCentralAcceptedCommand(input: unknown): string {
  return canonicalStringify(decodeRemoteCentralAcceptedCommand(input));
}

export function decodeRemoteCommandEnvelope(input: string | unknown): RemoteCommandEnvelope {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "sequence",
    "previousEnvelopeDigest",
    "acceptedCommand",
    "acceptedCommandDigest",
    "issuedAt",
    "signingKeyId",
    "signature",
  ]);
  remoteProtocolVersion(object.apiVersion, "$.apiVersion");
  positiveInteger(object.sequence, "$.sequence");
  nullableDigest(object.previousEnvelopeDigest, "$.previousEnvelopeDigest");
  assertSequenceLink(
    object.sequence as number,
    object.previousEnvelopeDigest,
    "$.previousEnvelopeDigest",
  );
  const acceptedCommand = decodeRemoteCentralAcceptedCommand(object.acceptedCommand);
  digest(object.acceptedCommandDigest, "$.acceptedCommandDigest");
  timestamp(object.issuedAt, "$.issuedAt");
  identity(object.signingKeyId, "$.signingKeyId");
  signature(object.signature, "$.signature");
  if (object.signingKeyId !== acceptedCommand.binding.controlPlaneKeyId)
    fail("invalid-value", "$.signingKeyId", "must equal the bound control-plane key");
  assertTimestampOrder(acceptedCommand.acceptedAt, object.issuedAt as string, "$.issuedAt");
  assertTimestampOrder(object.issuedAt as string, acceptedCommand.expiresAt, "$.issuedAt");
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    sequence: object.sequence as number,
    previousEnvelopeDigest: object.previousEnvelopeDigest as string | null,
    acceptedCommand,
    acceptedCommandDigest: object.acceptedCommandDigest as string,
    issuedAt: object.issuedAt as string,
    signingKeyId: object.signingKeyId as string,
    signature: object.signature as string,
  });
}

export function encodeRemoteCommandEnvelope(input: unknown): string {
  return canonicalStringify(decodeRemoteCommandEnvelope(input));
}

export function decodeRemoteReceiptChainEntry(input: string | unknown): RemoteReceiptChainEntry {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "bindingId",
    "commandId",
    "stage",
    "stageSequence",
    "recordedAt",
    "previousEntryDigest",
    "entryDigest",
    "evidence",
  ]);
  remoteProtocolVersion(object.apiVersion, "$.apiVersion");
  identity(object.bindingId, "$.bindingId");
  identity(object.commandId, "$.commandId");
  enumValue(object.stage, "$.stage", new Set(REMOTE_RECEIPT_STAGES));
  positiveInteger(object.stageSequence, "$.stageSequence");
  const expectedStageSequence =
    REMOTE_RECEIPT_STAGES.indexOf(object.stage as RemoteReceiptStage) + 1;
  if (object.stageSequence !== expectedStageSequence)
    fail("invalid-value", "$.stageSequence", "must equal the fixed receipt stage sequence");
  timestamp(object.recordedAt, "$.recordedAt");
  nullableDigest(object.previousEntryDigest, "$.previousEntryDigest");
  assertSequenceLink(
    object.stageSequence as number,
    object.previousEntryDigest,
    "$.previousEntryDigest",
  );
  digest(object.entryDigest, "$.entryDigest");
  const evidence = receiptEvidence(
    object.evidence,
    object.stage as RemoteReceiptStage,
    "$.evidence",
  );
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: object.bindingId as string,
    commandId: object.commandId as string,
    stage: object.stage as RemoteReceiptStage,
    stageSequence: object.stageSequence as number,
    recordedAt: object.recordedAt as string,
    previousEntryDigest: object.previousEntryDigest as string | null,
    entryDigest: object.entryDigest as string,
    evidence,
  });
}

export function encodeRemoteReceiptChainEntry(input: unknown): string {
  return canonicalStringify(decodeRemoteReceiptChainEntry(input));
}

export function decodeRemoteReceiptChain(input: string | unknown): RemoteReceiptChain {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "bindingId",
    "commandId",
    "entries",
  ]);
  identity(object.bindingId, "$.bindingId");
  identity(object.commandId, "$.commandId");
  const values = boundedArray(object.entries, "$.entries", REMOTE_RECEIPT_STAGES.length);
  if (values.length === 0) fail("invalid-value", "$.entries", "must contain a receipt stage");
  const entries: RemoteReceiptChainEntry[] = [];
  let localCommandId: string | undefined;
  let localReceiptCursor: number | undefined;
  for (const [index, value] of values.entries()) {
    const entry = decodeRemoteReceiptChainEntry(value);
    if (entry.bindingId !== object.bindingId || entry.commandId !== object.commandId)
      fail("invalid-value", `$.entries[${index}]`, "must match the receipt-chain identity");
    if (entry.stageSequence !== index + 1)
      fail("invalid-value", `$.entries[${index}].stageSequence`, "must form a stage prefix");
    const prior = entries.at(-1);
    if (prior !== undefined) {
      if (entry.previousEntryDigest !== prior.entryDigest)
        fail(
          "invalid-value",
          `$.entries[${index}].previousEntryDigest`,
          "must equal the prior entry digest",
        );
    }
    if (entry.evidence.type === "local-receipt" || entry.evidence.type === "local-outcome") {
      if (localCommandId !== undefined && entry.evidence.localCommandId !== localCommandId)
        fail(
          "invalid-value",
          `$.entries[${index}].evidence.localCommandId`,
          "must equal the prior local command identity",
        );
      if (localReceiptCursor !== undefined && entry.evidence.receiptCursor <= localReceiptCursor)
        fail(
          "invalid-value",
          `$.entries[${index}].evidence.receiptCursor`,
          "must increase across local receipt stages",
        );
      localCommandId = entry.evidence.localCommandId;
      localReceiptCursor = entry.evidence.receiptCursor;
    }
    entries.push(entry);
  }
  return Object.freeze({
    bindingId: object.bindingId as string,
    commandId: object.commandId as string,
    entries: Object.freeze(entries),
  });
}

export function encodeRemoteReceiptChain(input: unknown): string {
  return canonicalStringify(decodeRemoteReceiptChain(input));
}

export function decodeRemoteSynchronizationVector(
  input: string | unknown,
): RemoteSynchronizationVector {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "repositoryId",
    "localLatestCursor",
    "durablyEnqueuedCursor",
    "centrallyAcknowledgedCursor",
    "localObservedAt",
    "lastEnqueuedAt",
    "lastAcknowledgedAt",
  ]);
  identity(object.repositoryId, "$.repositoryId");
  for (const field of [
    "localLatestCursor",
    "durablyEnqueuedCursor",
    "centrallyAcknowledgedCursor",
  ] as const)
    nonNegativeInteger(object[field], `$.${field}`);
  if ((object.durablyEnqueuedCursor as number) > (object.localLatestCursor as number))
    fail("invalid-value", "$.durablyEnqueuedCursor", "must not exceed localLatestCursor");
  if ((object.centrallyAcknowledgedCursor as number) > (object.durablyEnqueuedCursor as number))
    fail("invalid-value", "$.centrallyAcknowledgedCursor", "must not exceed durablyEnqueuedCursor");
  timestamp(object.localObservedAt, "$.localObservedAt");
  nullableTimestamp(object.lastEnqueuedAt, "$.lastEnqueuedAt");
  nullableTimestamp(object.lastAcknowledgedAt, "$.lastAcknowledgedAt");
  assertCursorTimestamp(
    object.durablyEnqueuedCursor as number,
    object.lastEnqueuedAt,
    "$.lastEnqueuedAt",
  );
  assertCursorTimestamp(
    object.centrallyAcknowledgedCursor as number,
    object.lastAcknowledgedAt,
    "$.lastAcknowledgedAt",
  );
  return Object.freeze({
    repositoryId: object.repositoryId as string,
    localLatestCursor: object.localLatestCursor as number,
    durablyEnqueuedCursor: object.durablyEnqueuedCursor as number,
    centrallyAcknowledgedCursor: object.centrallyAcknowledgedCursor as number,
    localObservedAt: object.localObservedAt as string,
    lastEnqueuedAt: object.lastEnqueuedAt as string | null,
    lastAcknowledgedAt: object.lastAcknowledgedAt as string | null,
  });
}

export function encodeRemoteSynchronizationVector(input: unknown): string {
  return canonicalStringify(decodeRemoteSynchronizationVector(input));
}

export function decodeRemoteClassifiedReport(input: string | unknown): RemoteClassifiedReport {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "reportId",
    "binding",
    "classification",
    "dataPolicyDigest",
    "reportSequence",
    "previousReportDigest",
    "createdAt",
    "receiptChains",
    "events",
    "projections",
    "synchronization",
  ]);
  remoteProtocolVersion(object.apiVersion, "$.apiVersion");
  identity(object.reportId, "$.reportId");
  const binding = decodeRemoteRepositoryBinding(object.binding);
  enumValue(object.classification, "$.classification", REPORT_CLASSIFICATIONS);
  digest(object.dataPolicyDigest, "$.dataPolicyDigest");
  positiveInteger(object.reportSequence, "$.reportSequence");
  nullableDigest(object.previousReportDigest, "$.previousReportDigest");
  assertSequenceLink(
    object.reportSequence as number,
    object.previousReportDigest,
    "$.previousReportDigest",
  );
  timestamp(object.createdAt, "$.createdAt");
  const receiptChains = decodeReceiptChains(object.receiptChains, binding.bindingId);
  const events = decodeEventMetadataList(object.events, binding.repositoryId, "$.events");
  const projections = decodeProjectionMetadataList(
    object.projections,
    binding.repositoryId,
    "$.projections",
  );
  const synchronization = decodeRemoteSynchronizationVector(object.synchronization);
  if (synchronization.repositoryId !== binding.repositoryId)
    fail("invalid-value", "$.synchronization.repositoryId", "must equal the repository binding");
  for (const [index, event] of events.entries())
    if (event.cursor > synchronization.localLatestCursor)
      fail("invalid-value", `$.events[${index}].cursor`, "must not exceed localLatestCursor");
  for (const [index, projection] of projections.entries())
    if (projection.cursor > synchronization.localLatestCursor)
      fail("invalid-value", `$.projections[${index}].cursor`, "must not exceed localLatestCursor");
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    reportId: object.reportId as string,
    binding,
    classification: object.classification as RemoteReportClassification,
    dataPolicyDigest: object.dataPolicyDigest as string,
    reportSequence: object.reportSequence as number,
    previousReportDigest: object.previousReportDigest as string | null,
    createdAt: object.createdAt as string,
    receiptChains,
    events,
    projections,
    synchronization,
  });
}

export function encodeRemoteClassifiedReport(input: unknown): string {
  return canonicalStringify(decodeRemoteClassifiedReport(input));
}

export function decodeRemoteReportAcknowledgement(
  input: string | unknown,
): RemoteReportAcknowledgement {
  const object = exactObject(decodeCanonicalJsonValue(input), "$", [
    "apiVersion",
    "bindingId",
    "repositoryId",
    "reportId",
    "reportSequence",
    "reportDigest",
    "centralReceiptId",
    "acknowledgedAt",
    "signingKeyId",
    "signature",
  ]);
  remoteProtocolVersion(object.apiVersion, "$.apiVersion");
  for (const field of [
    "bindingId",
    "repositoryId",
    "reportId",
    "centralReceiptId",
    "signingKeyId",
  ] as const)
    identity(object[field], `$.${field}`);
  positiveInteger(object.reportSequence, "$.reportSequence");
  digest(object.reportDigest, "$.reportDigest");
  timestamp(object.acknowledgedAt, "$.acknowledgedAt");
  signature(object.signature, "$.signature");
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: object.bindingId as string,
    repositoryId: object.repositoryId as string,
    reportId: object.reportId as string,
    reportSequence: object.reportSequence as number,
    reportDigest: object.reportDigest as string,
    centralReceiptId: object.centralReceiptId as string,
    acknowledgedAt: object.acknowledgedAt as string,
    signingKeyId: object.signingKeyId as string,
    signature: object.signature as string,
  });
}

export function encodeRemoteReportAcknowledgement(input: unknown): string {
  return canonicalStringify(decodeRemoteReportAcknowledgement(input));
}

function helloSelection(value: unknown): RemoteHelloSelection {
  const object = exactObject(value, "$", [
    "negotiationVersion",
    "type",
    "sessionId",
    "serverPeerId",
    "selectedVersion",
    "capabilities",
  ]);
  negotiationVersion(object.negotiationVersion, "$.negotiationVersion");
  if (object.type !== "selection") fail("invalid-value", "$.type", "must equal selection");
  identity(object.sessionId, "$.sessionId");
  identity(object.serverPeerId, "$.serverPeerId");
  remoteProtocolVersion(object.selectedVersion, "$.selectedVersion");
  if (object.selectedVersion !== REMOTE_PROTOCOL_VERSION)
    fail("invalid-value", "$.selectedVersion", "must select the offered protocol version");
  const capabilities = sortedStringSet(
    object.capabilities,
    "$.capabilities",
    REMOTE_PROTOCOL_LIMITS.maxCapabilities,
    capability,
  );
  assertRequiredCapabilities(capabilities, "$.capabilities");
  return Object.freeze({
    negotiationVersion: REMOTE_NEGOTIATION_VERSION,
    type: "selection",
    sessionId: object.sessionId as string,
    serverPeerId: object.serverPeerId as string,
    selectedVersion: REMOTE_PROTOCOL_VERSION,
    capabilities: capabilities as readonly RemoteCapability[],
  });
}

function helloRefusal(value: unknown): RemoteHelloRefusal {
  const object = exactObject(value, "$", [
    "negotiationVersion",
    "type",
    "code",
    "message",
    "supportedVersions",
    "requiredCapabilities",
  ]);
  negotiationVersion(object.negotiationVersion, "$.negotiationVersion");
  if (object.type !== "refusal") fail("invalid-value", "$.type", "must equal refusal");
  enumValue(object.code, "$.code", REFUSAL_CODES);
  boundedString(object.message, "$.message", 1, REMOTE_PROTOCOL_LIMITS.maxMessageLength);
  const supportedVersions = sortedStringSet(
    object.supportedVersions,
    "$.supportedVersions",
    REMOTE_PROTOCOL_LIMITS.maxSupportedVersions,
    remoteVersion,
  );
  if (supportedVersions.length === 0)
    fail("invalid-value", "$.supportedVersions", "must contain at least one version");
  const requiredCapabilities = sortedStringSet(
    object.requiredCapabilities,
    "$.requiredCapabilities",
    REMOTE_PROTOCOL_LIMITS.maxCapabilities,
    capability,
  );
  assertRequiredCapabilities(requiredCapabilities, "$.requiredCapabilities");
  return Object.freeze({
    negotiationVersion: REMOTE_NEGOTIATION_VERSION,
    type: "refusal",
    code: object.code as RemoteHelloRefusalCode,
    message: object.message as string,
    supportedVersions,
    requiredCapabilities: requiredCapabilities as readonly RemoteCapability[],
  });
}

function serverAttribution(value: unknown, path: string): RemoteServerAttribution {
  const object = exactObject(value, path, ["principal", "transport"]);
  const principal = decodeAuthenticatedPrincipal(object.principal);
  const transport = decodeTransportAttribution(object.transport);
  if (transport.kind !== "remote")
    fail("invalid-value", `${path}.transport.kind`, "must equal remote");
  return Object.freeze({
    principal,
    transport: Object.freeze({ kind: "remote" as const, requestId: transport.requestId }),
  });
}

function receiptEvidence(
  value: unknown,
  stage: RemoteReceiptStage,
  path: string,
): RemoteReceiptEvidence {
  if (stage === "central-accepted") {
    const object = exactObject(value, path, ["type", "acceptanceId", "acceptanceDigest"]);
    if (object.type !== "central-acceptance")
      fail("invalid-value", `${path}.type`, "must equal central-acceptance for this stage");
    identity(object.acceptanceId, `${path}.acceptanceId`);
    digest(object.acceptanceDigest, `${path}.acceptanceDigest`);
    return Object.freeze({
      type: "central-acceptance",
      acceptanceId: object.acceptanceId as string,
      acceptanceDigest: object.acceptanceDigest as string,
    });
  }
  if (stage === "connector-delivered") {
    const object = exactObject(value, path, ["type", "envelopeSequence", "envelopeDigest"]);
    if (object.type !== "connector-delivery")
      fail("invalid-value", `${path}.type`, "must equal connector-delivery for this stage");
    positiveInteger(object.envelopeSequence, `${path}.envelopeSequence`);
    digest(object.envelopeDigest, `${path}.envelopeDigest`);
    return Object.freeze({
      type: "connector-delivery",
      envelopeSequence: object.envelopeSequence as number,
      envelopeDigest: object.envelopeDigest as string,
    });
  }
  if (stage === "local-outcome") {
    const object = exactObject(value, path, [
      "type",
      "localCommandId",
      "receiptStatus",
      "receiptCursor",
      "receiptDigest",
    ]);
    if (object.type !== "local-outcome")
      fail("invalid-value", `${path}.type`, "must equal local-outcome for this stage");
    identity(object.localCommandId, `${path}.localCommandId`);
    enumValue(object.receiptStatus, `${path}.receiptStatus`, TERMINAL_RECEIPT_STATUSES);
    nonNegativeInteger(object.receiptCursor, `${path}.receiptCursor`);
    digest(object.receiptDigest, `${path}.receiptDigest`);
    return Object.freeze({
      type: "local-outcome",
      localCommandId: object.localCommandId as string,
      receiptStatus: object.receiptStatus as Exclude<ReceiptStatus, "queued" | "claimed">,
      receiptCursor: object.receiptCursor as number,
      receiptDigest: object.receiptDigest as string,
    });
  }
  const object = exactObject(value, path, [
    "type",
    "localCommandId",
    "receiptStatus",
    "receiptCursor",
    "receiptDigest",
  ]);
  if (object.type !== "local-receipt")
    fail("invalid-value", `${path}.type`, "must equal local-receipt for this stage");
  identity(object.localCommandId, `${path}.localCommandId`);
  const expectedStatus = stage === "local-accepted" ? "queued" : "claimed";
  if (object.receiptStatus !== expectedStatus)
    fail("invalid-value", `${path}.receiptStatus`, `must equal ${expectedStatus} for this stage`);
  nonNegativeInteger(object.receiptCursor, `${path}.receiptCursor`);
  digest(object.receiptDigest, `${path}.receiptDigest`);
  return Object.freeze({
    type: "local-receipt",
    localCommandId: object.localCommandId as string,
    receiptStatus: expectedStatus,
    receiptCursor: object.receiptCursor as number,
    receiptDigest: object.receiptDigest as string,
  });
}

function decodeReceiptChains(value: unknown, bindingId: string): readonly RemoteReceiptChain[] {
  const values = boundedArray(value, "$.receiptChains", REMOTE_PROTOCOL_LIMITS.maxReceiptChains);
  const chains: RemoteReceiptChain[] = [];
  for (const [index, entry] of values.entries()) {
    const chain = decodeRemoteReceiptChain(entry);
    if (chain.bindingId !== bindingId)
      fail("invalid-value", `$.receiptChains[${index}].bindingId`, "must equal the report binding");
    const prior = chains.at(-1);
    if (prior !== undefined && prior.commandId >= chain.commandId)
      fail("invalid-value", "$.receiptChains", "must be sorted uniquely by commandId");
    chains.push(chain);
  }
  return Object.freeze(chains);
}

function decodeEventMetadataList(
  value: unknown,
  repositoryId: string,
  path: string,
): readonly RemoteEventMetadata[] {
  const values = boundedArray(value, path, REMOTE_PROTOCOL_LIMITS.maxEvents);
  const events: RemoteEventMetadata[] = [];
  const eventIds = new Set<string>();
  let priorRunId: string | undefined;
  let priorCursor = -1;
  for (const [index, entry] of values.entries()) {
    const itemPath = `${path}[${index}]`;
    const object = exactObject(
      entry,
      itemPath,
      ["cursor", "repositoryId", "runId", "eventId", "eventType", "occurredAt", "payloadDigest"],
      ["commandId"],
    );
    nonNegativeInteger(object.cursor, `${itemPath}.cursor`);
    identity(object.repositoryId, `${itemPath}.repositoryId`);
    identity(object.runId, `${itemPath}.runId`);
    identity(object.eventId, `${itemPath}.eventId`);
    token(object.eventType, `${itemPath}.eventType`);
    timestamp(object.occurredAt, `${itemPath}.occurredAt`);
    digest(object.payloadDigest, `${itemPath}.payloadDigest`);
    if (Object.hasOwn(object, "commandId")) identity(object.commandId, `${itemPath}.commandId`);
    if (object.repositoryId !== repositoryId)
      fail("invalid-value", `${itemPath}.repositoryId`, "must equal the report binding");
    if (
      priorRunId !== undefined &&
      (priorRunId > (object.runId as string) ||
        (priorRunId === object.runId && (object.cursor as number) <= priorCursor))
    )
      fail("invalid-value", `${itemPath}.cursor`, "must increase within runId order");
    if (eventIds.has(object.eventId as string))
      fail("invalid-value", `${itemPath}.eventId`, "must not duplicate an event identity");
    priorCursor = object.cursor as number;
    priorRunId = object.runId as string;
    eventIds.add(object.eventId as string);
    events.push(
      Object.freeze({
        cursor: object.cursor as number,
        repositoryId: object.repositoryId as string,
        runId: object.runId as string,
        eventId: object.eventId as string,
        eventType: object.eventType as string,
        occurredAt: object.occurredAt as string,
        payloadDigest: object.payloadDigest as string,
        ...(Object.hasOwn(object, "commandId") ? { commandId: object.commandId as string } : {}),
      }),
    );
  }
  return Object.freeze(events);
}

function decodeProjectionMetadataList(
  value: unknown,
  repositoryId: string,
  path: string,
): readonly RemoteProjectionMetadata[] {
  const values = boundedArray(value, path, REMOTE_PROTOCOL_LIMITS.maxProjections);
  const projections: RemoteProjectionMetadata[] = [];
  let priorKey: string | undefined;
  for (const [index, entry] of values.entries()) {
    const itemPath = `${path}[${index}]`;
    const object = exactObject(entry, itemPath, [
      "cursor",
      "repositoryId",
      "runId",
      "projectionType",
      "revision",
      "generatedAt",
      "payloadDigest",
      "lifecycleStatus",
      "counts",
    ]);
    nonNegativeInteger(object.cursor, `${itemPath}.cursor`);
    identity(object.repositoryId, `${itemPath}.repositoryId`);
    identity(object.runId, `${itemPath}.runId`);
    token(object.projectionType, `${itemPath}.projectionType`);
    identity(object.revision, `${itemPath}.revision`);
    timestamp(object.generatedAt, `${itemPath}.generatedAt`);
    digest(object.payloadDigest, `${itemPath}.payloadDigest`);
    token(object.lifecycleStatus, `${itemPath}.lifecycleStatus`);
    const counts = projectionCounts(object.counts, `${itemPath}.counts`);
    if (object.repositoryId !== repositoryId)
      fail("invalid-value", `${itemPath}.repositoryId`, "must equal the report binding");
    const key = `${object.runId as string}\u0000${object.projectionType as string}`;
    if (priorKey !== undefined && priorKey >= key)
      fail("invalid-value", path, "must be sorted uniquely by runId and projectionType");
    priorKey = key;
    projections.push(
      Object.freeze({
        cursor: object.cursor as number,
        repositoryId: object.repositoryId as string,
        runId: object.runId as string,
        projectionType: object.projectionType as string,
        revision: object.revision as string,
        generatedAt: object.generatedAt as string,
        payloadDigest: object.payloadDigest as string,
        lifecycleStatus: object.lifecycleStatus as string,
        counts,
      }),
    );
  }
  return Object.freeze(projections);
}

function projectionCounts(value: unknown, path: string): RemoteProjectionCounts {
  const object = exactObject(value, path, [
    "tasks",
    "readyTasks",
    "humanNeeds",
    "activeEffects",
    "uncertainEffects",
  ]);
  for (const field of [
    "tasks",
    "readyTasks",
    "humanNeeds",
    "activeEffects",
    "uncertainEffects",
  ] as const)
    nonNegativeInteger(object[field], `${path}.${field}`);
  if ((object.readyTasks as number) > (object.tasks as number))
    fail("invalid-value", `${path}.readyTasks`, "must not exceed tasks");
  return Object.freeze({
    tasks: object.tasks as number,
    readyTasks: object.readyTasks as number,
    humanNeeds: object.humanNeeds as number,
    activeEffects: object.activeEffects as number,
    uncertainEffects: object.uncertainEffects as number,
  });
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

function boundedArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) fail("invalid-type", path, "must be an array");
  if (value.length > maximum) fail("oversized", path, `must contain at most ${maximum} entries`);
  return value;
}

function sortedStringSet(
  value: unknown,
  path: string,
  maximum: number,
  validator: (value: unknown, path: string) => void,
): readonly string[] {
  const values = boundedArray(value, path, maximum);
  const result: string[] = [];
  for (const [index, entry] of values.entries()) {
    validator(entry, `${path}[${index}]`);
    const prior = result.at(-1);
    if (prior !== undefined && prior >= (entry as string))
      fail("invalid-value", path, "must be sorted lexicographically without duplicates");
    result.push(entry as string);
  }
  return Object.freeze(result);
}

function assertRequiredCapabilities(values: readonly string[], path: string): void {
  if (
    values.length !== REMOTE_CAPABILITIES.length ||
    values.some((value, index) => value !== REMOTE_CAPABILITIES[index])
  )
    fail("invalid-value", path, "must equal the required remote capability set");
}

function negotiationVersion(value: unknown, path: string): void {
  if (value !== REMOTE_NEGOTIATION_VERSION)
    fail("invalid-value", path, `must equal ${REMOTE_NEGOTIATION_VERSION}`);
}

function remoteProtocolVersion(value: unknown, path: string): void {
  if (value !== REMOTE_PROTOCOL_VERSION)
    fail("invalid-value", path, `must equal ${REMOTE_PROTOCOL_VERSION}`);
}

function remoteVersion(value: unknown, path: string): void {
  boundedString(value, path, 1, 128);
  if (!REMOTE_VERSION_PATTERN.test(value as string))
    fail("invalid-value", path, "must be a remote-control protocol version");
}

function identity(value: unknown, path: string): void {
  boundedString(value, path, 1, PROTOCOL_LIMITS.maxIdentityLength);
  if (!IDENTITY_PATTERN.test(value as string))
    fail("invalid-value", path, "must be an opaque ASCII identity token");
}

function capability(value: unknown, path: string): void {
  boundedString(value, path, 1, 64);
  if (!TOKEN_PATTERN.test(value as string))
    fail("invalid-value", path, "must be a lowercase capability token");
}

function token(value: unknown, path: string): void {
  boundedString(value, path, 1, 64);
  if (!TOKEN_PATTERN.test(value as string))
    fail("invalid-value", path, "must be a lowercase token");
}

function digest(value: unknown, path: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
    fail("invalid-value", path, "must be a SHA-256 digest");
}

function nullableDigest(value: unknown, path: string): void {
  if (value !== null) digest(value, path);
}

function signature(value: unknown, path: string): void {
  if (
    typeof value !== "string" ||
    !SIGNATURE_PATTERN.test(value) ||
    encodeBase64Url(decodeBase64Url(value)) !== value
  )
    fail(
      "invalid-value",
      path,
      `must be an unpadded ${REMOTE_PROTOCOL_LIMITS.signatureLength}-character base64url signature`,
    );
}

function decodeBase64Url(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    accumulator = accumulator * 64 + alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(Math.floor(accumulator / 2 ** bits) & 0xff);
      accumulator %= 2 ** bits;
    }
  }
  return Uint8Array.from(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = accumulator * 256 + byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += alphabet[Math.floor(accumulator / 2 ** bits) & 0x3f];
      accumulator %= 2 ** bits;
    }
  }
  if (bits > 0) output += alphabet[(accumulator * 2 ** (6 - bits)) & 0x3f];
  return output;
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

function nullableTimestamp(value: unknown, path: string): void {
  if (value !== null) timestamp(value, path);
}

function positiveInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail("invalid-value", path, "must be a positive safe integer");
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

function assertSequenceLink(sequence: number, previousDigest: unknown, path: string): void {
  if ((sequence === 1) !== (previousDigest === null))
    fail("invalid-value", path, "must be null exactly for sequence one");
}

function assertTimestampOrder(earlier: string, later: string, path: string): void {
  if (earlier > later) fail("invalid-value", path, "must not precede the bound timestamp");
}

function assertCursorTimestamp(cursor: number, value: unknown, path: string): void {
  if ((cursor === 0) !== (value === null))
    fail("invalid-value", path, "must be null exactly when its cursor is zero");
}

function fail(code: ProtocolValidationError["code"], path: string, message: string): never {
  throw new ProtocolValidationError(code, path, `${path} ${message}`);
}
