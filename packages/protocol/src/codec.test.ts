import { describe, expect, it } from "vitest";
import { GOLDEN_COMMAND_JSON, GOLDEN_RECEIPT_JSON } from "./fixtures/v1alpha.js";
import {
  canonicalBytes,
  decodeAuthenticatedPrincipal,
  decodeCapabilityHandshake,
  decodeCommandEnvelope,
  decodeDurableReceipt,
  decodeErrorEnvelope,
  decodeEventStreamFrame,
  decodeProjectionEnvelope,
  decodeRunIdentity,
  decodeTransportAttribution,
  encodeAuthenticatedPrincipal,
  encodeCapabilityHandshake,
  encodeCommandEnvelope,
  encodeDurableReceipt,
  encodeErrorEnvelope,
  encodeEventStreamFrame,
  encodeProjectionEnvelope,
  encodeRunIdentity,
  encodeTransportAttribution,
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

describe("v1alpha command codec", () => {
  it("matches the canonical command golden fixture and round trips", () => {
    const encoded = encodeCommandEnvelope(command);

    expect(encoded).toBe(GOLDEN_COMMAND_JSON);
    expect(new TextDecoder().decode(canonicalBytes(command))).toBe(GOLDEN_COMMAND_JSON);
    expect(decodeCommandEnvelope(encoded)).toEqual(command);
    expect(Object.isFrozen(decodeCommandEnvelope(encoded))).toBe(true);
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
    "accept-graph-revision",
    "submit-completion",
    "evaluate-gate",
    "record-authority-decision",
    "close-phase",
    "create-escalation",
    "grant-allowance",
  ] as const)("accepts the %s intent discriminator", (type) => {
    expect(decodeCommandEnvelope({ ...command, intent: { type } }).intent).toEqual({ type });
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

describe("v1alpha identity and attribution values", () => {
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

describe("v1alpha receipts", () => {
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

describe("v1alpha event, projection, capability, and error envelopes", () => {
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
        supportedVersions: ["senawa.dev/protocol/v2alpha1"],
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
