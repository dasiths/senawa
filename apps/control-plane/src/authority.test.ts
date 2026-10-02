import { createHash, generateKeyPairSync } from "node:crypto";
import {
  type AuthenticatedPrincipal,
  type CommandSubmission,
  canonicalStringify,
  encodeRemoteCommandEnvelope,
  PROTOCOL_VERSION,
  REMOTE_CAPABILITIES,
  REMOTE_NEGOTIATION_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteClassifiedReport,
  type RemoteHelloOffer,
  type RemoteReceiptChain,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import { describe, expect, it } from "vitest";

import {
  type AuthorityRefusalCode,
  createReceiptChainEntry,
  ReferenceControlPlane,
  signClassifiedReport,
  signCommandIngress,
  verifyCommandEnvelope,
  verifyReportAcknowledgement,
} from "./authority.js";
import { createEd25519FixtureKeyPair, DeterministicRandom, VirtualClock } from "./fixtures.js";

const INITIAL_TIME = "2026-08-14T10:00:00.000Z";
const POLICY_DIGEST = "a".repeat(64);

describe("reference control-plane authority", () => {
  it("negotiates exact capabilities and returns typed refusals", () => {
    const fixture = createFixture();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      () =>
        new ReferenceControlPlane({
          clock: fixture.clock,
          random: fixture.random,
          serverPeerId: "control-plane_invalid",
          signingKey: { keyId: fixture.binding.controlPlaneKeyId, privateKey: rsa.privateKey },
        }),
    ).toThrow("Ed25519 private key");
    expect(() =>
      fixture.authority.register({ binding: fixture.binding, repositoryPublicKey: rsa.publicKey }),
    ).toThrow("Ed25519 public key");
    expect(fixture.authority.negotiate(validNegotiation(fixture))).toMatchObject({
      type: "selection",
      selectedVersion: REMOTE_PROTOCOL_VERSION,
      capabilities: REMOTE_CAPABILITIES,
    });
    expect(
      fixture.authority.negotiate({
        ...validNegotiation(fixture),
        offer: { ...helloOffer(), supportedVersions: ["senawa.dev/remote-control/v2"] },
      }),
    ).toMatchObject({ type: "refusal", code: "no-common-version" });
    expect(
      fixture.authority.negotiate({
        ...validNegotiation(fixture),
        offer: { ...helloOffer(), capabilities: REMOTE_CAPABILITIES.slice(1) },
      }),
    ).toMatchObject({ type: "refusal", code: "missing-capability" });
    expect(
      fixture.authority.negotiate({ ...validNegotiation(fixture), connectorId: "connector-other" }),
    ).toMatchObject({ type: "refusal", code: "binding-refused" });
  });

  it.each<{
    readonly name: string;
    readonly expected: AuthorityRefusalCode;
    readonly mutate: (
      fixture: Fixture,
      ingress: ReturnType<typeof commandIngress>,
      context: ReturnType<typeof ingressContext>,
    ) => void;
  }>([
    {
      name: "unknown repository key",
      expected: "unknown-key",
      mutate: (_fixture, ingress) => Object.assign(ingress, { repositoryKeyId: "key-unknown" }),
    },
    {
      name: "connector crossing",
      expected: "connector-mismatch",
      mutate: (_fixture, ingress) => Object.assign(ingress, { connectorId: "connector-other" }),
    },
    {
      name: "tenant crossing",
      expected: "tenant-mismatch",
      mutate: (fixture, _ingress, context) =>
        Object.assign(context, { principal: { ...fixture.principal, tenant: "tenant-other" } }),
    },
    {
      name: "repository crossing",
      expected: "repository-mismatch",
      mutate: (fixture, ingress) => {
        const command = commandFixture("crossing", "repository-other");
        Object.assign(ingress, {
          command,
          signature: signCommandIngress(fixture.repositoryKey.privateKey, command),
        });
      },
    },
    {
      name: "forged command",
      expected: "invalid-signature",
      mutate: (fixture, ingress) => {
        const attacker = createEd25519FixtureKeyPair("key-attacker", "33".repeat(32));
        Object.assign(ingress, {
          signature: signCommandIngress(attacker.privateKey, ingress.command),
        });
        expect(fixture.repositoryKey.keyId).not.toBe(attacker.keyId);
      },
    },
    {
      name: "expired command",
      expected: "expired",
      mutate: (fixture, ingress) => {
        const command = commandFixture("expired", fixture.binding.repositoryId, INITIAL_TIME);
        Object.assign(ingress, {
          command,
          signature: signCommandIngress(fixture.repositoryKey.privateKey, command),
        });
      },
    },
    {
      name: "revoked binding",
      expected: "revoked",
      mutate: (fixture) => fixture.authority.revoke(fixture.binding.bindingId),
    },
  ])("denies $name without allocating central authority", ({ expected, mutate }) => {
    const fixture = createFixture();
    const ingress = commandIngress(fixture, commandFixture("denial", fixture.binding.repositoryId));
    const context = ingressContext(fixture);
    mutate(fixture, ingress, context);
    expect(fixture.authority.acceptCommand(ingress, context)).toMatchObject({
      type: "refusal",
      code: expected,
    });
    expect(fixture.authority.envelopes(fixture.binding.bindingId)).toHaveLength(0);
  });

  it("derives attribution from trusted ingress and enforces exact command replay", () => {
    const fixture = createFixture();
    const command = commandFixture("exact", fixture.binding.repositoryId);
    const ingress = commandIngress(fixture, command);
    const accepted = requireAccepted(
      fixture.authority.acceptCommand(ingress, ingressContext(fixture)),
    );
    expect(accepted.replay).toBe(false);
    expect(accepted.envelope.acceptedCommand.attribution).toEqual({
      principal: fixture.principal,
      transport: { kind: "remote", requestId: ingress.requestId },
    });
    expect(accepted.envelope.acceptedCommand.command).not.toHaveProperty("principal");
    expect(verifyCommandEnvelope(fixture.controlPlaneKey.publicKey, accepted.envelope)).toBe(true);

    const replay = requireAccepted(
      fixture.authority.acceptCommand(ingress, ingressContext(fixture)),
    );
    expect(replay.replay).toBe(true);
    expect(replay.envelope).toEqual(accepted.envelope);

    expect(
      fixture.authority.acceptCommand(ingress, {
        principal: { ...fixture.principal, subject: "operator-other" },
      }),
    ).toMatchObject({ type: "refusal", code: "duplicate-conflict" });

    const changed = { ...command, payload: { expectedRunModeRevision: 2 } };
    changed.payloadDigest = digest(changed.payload);
    expect(
      fixture.authority.acceptCommand(commandIngress(fixture, changed), ingressContext(fixture)),
    ).toMatchObject({ type: "refusal", code: "duplicate-conflict" });

    expect(
      fixture.authority.acceptCommand(
        { ...ingress, command: { ...command, principal: fixture.principal } },
        ingressContext(fixture),
      ),
    ).toMatchObject({ type: "refusal", code: "binding-mismatch" });
  });

  it("creates signed ordered hash-linked deliveries", () => {
    const fixture = createFixture();
    const first = requireAccepted(
      fixture.authority.acceptCommand(
        commandIngress(fixture, commandFixture("one", fixture.binding.repositoryId)),
        ingressContext(fixture),
      ),
    ).envelope;
    const second = requireAccepted(
      fixture.authority.acceptCommand(
        commandIngress(fixture, commandFixture("two", fixture.binding.repositoryId)),
        ingressContext(fixture),
      ),
    ).envelope;
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(second.previousEnvelopeDigest).toBe(digestBytes(encodeRemoteCommandEnvelope(first)));
    expect(verifyCommandEnvelope(fixture.controlPlaneKey.publicKey, first)).toBe(true);
    expect(verifyCommandEnvelope(fixture.controlPlaneKey.publicKey, second)).toBe(true);
  });

  it("ingests five distinct receipt stages and exactly acknowledges classified reports", () => {
    const fixture = createFixture();
    const command = commandFixture("chain", fixture.binding.repositoryId);
    const envelope = requireAccepted(
      fixture.authority.acceptCommand(commandIngress(fixture, command), ingressContext(fixture)),
    ).envelope;
    fixture.clock.advance(1_000);
    const delivered = requireChain(
      fixture.authority.recordDelivery(fixture.binding.bindingId, envelope.sequence),
    );
    const completeChain = completeReceiptChain(delivered, fixture.clock);
    fixture.clock.advance(1_000);
    const report = reportFixture(fixture, completeChain);
    const ingress = {
      repositoryKeyId: fixture.repositoryKey.keyId,
      connectorId: fixture.binding.connectorId,
      report,
      signature: signClassifiedReport(fixture.repositoryKey.privateKey, report),
    };
    const accepted = requireAcknowledged(fixture.authority.acceptReport(ingress));
    expect(accepted.replay).toBe(false);
    expect(
      verifyReportAcknowledgement(fixture.controlPlaneKey.publicKey, accepted.acknowledgement),
    ).toBe(true);
    expect(
      fixture.authority
        .receiptChain(fixture.binding.bindingId, command.commandId)
        ?.entries.map(({ stage }) => stage),
    ).toEqual([
      "central-accepted",
      "connector-delivered",
      "local-accepted",
      "runner-claimed",
      "local-outcome",
    ]);
    expect(requireAcknowledged(fixture.authority.acceptReport(ingress))).toEqual({
      ...accepted,
      replay: true,
    });
    expect(fixture.authority.synchronization(fixture.binding.bindingId)).toMatchObject({
      state: "stale",
      cursorLag: 2,
      stalenessMs: 0,
      vector: { centrallyAcknowledgedCursor: 12 },
    });
    fixture.clock.advance(5_000);
    expect(fixture.authority.synchronization(fixture.binding.bindingId)?.stalenessMs).toBe(5_000);
  });

  it("rejects forged, stale-policy, and conflicting report acknowledgement attempts", () => {
    const fixture = createFixture();
    const report = reportFixture(fixture);
    const validSignature = signClassifiedReport(fixture.repositoryKey.privateKey, report);
    const attacker = createEd25519FixtureKeyPair("key-attacker", "44".repeat(32));
    expect(
      fixture.authority.acceptReport({
        repositoryKeyId: fixture.repositoryKey.keyId,
        connectorId: fixture.binding.connectorId,
        report,
        signature: signClassifiedReport(attacker.privateKey, report),
      }),
    ).toMatchObject({ type: "refusal", code: "invalid-signature" });

    const stale = { ...report, dataPolicyDigest: "f".repeat(64) };
    expect(
      fixture.authority.acceptReport({
        repositoryKeyId: fixture.repositoryKey.keyId,
        connectorId: fixture.binding.connectorId,
        report: stale,
        signature: signClassifiedReport(fixture.repositoryKey.privateKey, stale),
      }),
    ).toMatchObject({ type: "refusal", code: "classification-refused" });

    const rebound = {
      ...report,
      binding: { ...report.binding, repositoryId: "repository-other" },
      synchronization: { ...report.synchronization, repositoryId: "repository-other" },
    };
    expect(
      fixture.authority.acceptReport({
        repositoryKeyId: fixture.repositoryKey.keyId,
        connectorId: fixture.binding.connectorId,
        report: rebound,
        signature: signClassifiedReport(fixture.repositoryKey.privateKey, rebound),
      }),
    ).toMatchObject({ type: "refusal", code: "binding-mismatch" });

    expect(
      fixture.authority.acceptReport({
        repositoryKeyId: fixture.repositoryKey.keyId,
        connectorId: fixture.binding.connectorId,
        report: { ...report, reportSequence: 2, previousReportDigest: "e".repeat(64) },
        signature: validSignature,
      }),
    ).toMatchObject({ type: "refusal", code: "invalid-signature" });

    expect(
      fixture.authority.acceptReport({
        repositoryKeyId: fixture.repositoryKey.keyId,
        connectorId: fixture.binding.connectorId,
        report,
        signature: validSignature,
      }),
    ).toMatchObject({ type: "acknowledged", replay: false });
    const conflictingReplay = { ...report, reportId: "report-conflict" };
    expect(
      fixture.authority.acceptReport({
        repositoryKeyId: fixture.repositoryKey.keyId,
        connectorId: fixture.binding.connectorId,
        report: conflictingReplay,
        signature: signClassifiedReport(fixture.repositoryKey.privateKey, conflictingReplay),
      }),
    ).toMatchObject({ type: "refusal", code: "duplicate-conflict" });
  });

  it("is restart-ephemeral", () => {
    const fixture = createFixture();
    const restarted = new ReferenceControlPlane({
      clock: fixture.clock,
      random: new DeterministicRandom("restart"),
      serverPeerId: "control-plane-fixture",
      signingKey: fixture.controlPlaneKey,
    });
    expect(restarted.negotiate(validNegotiation(fixture))).toMatchObject({
      type: "refusal",
      code: "binding-refused",
    });
  });
});

interface Fixture {
  readonly authority: ReferenceControlPlane;
  readonly binding: RemoteRepositoryBinding;
  readonly clock: VirtualClock;
  readonly controlPlaneKey: ReturnType<typeof createEd25519FixtureKeyPair>;
  readonly principal: AuthenticatedPrincipal;
  readonly random: DeterministicRandom;
  readonly repositoryKey: ReturnType<typeof createEd25519FixtureKeyPair>;
}

function createFixture(): Fixture {
  const clock = new VirtualClock(INITIAL_TIME);
  const random = new DeterministicRandom("authority");
  const repositoryKey = createEd25519FixtureKeyPair("repository-key-alpha", "11".repeat(32));
  const controlPlaneKey = createEd25519FixtureKeyPair("control-plane-key-alpha", "22".repeat(32));
  const binding: RemoteRepositoryBinding = Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: "binding-alpha",
    tenantId: "tenant-alpha",
    repositoryId: "repository-alpha",
    connectorId: "connector-alpha",
    repositoryKeyId: repositoryKey.keyId,
    controlPlaneKeyId: controlPlaneKey.keyId,
    revocationEpoch: 0,
    policyDigest: POLICY_DIGEST,
    issuedAt: INITIAL_TIME,
  });
  const principal: AuthenticatedPrincipal = Object.freeze({
    issuer: "https://fixture.control-plane.test",
    subject: "operator-alpha",
    tenant: binding.tenantId,
    assurance: "multi-factor",
    roles: Object.freeze(["operator"]),
  });
  const authority = new ReferenceControlPlane({
    clock,
    random,
    serverPeerId: "control-plane-fixture",
    signingKey: controlPlaneKey,
  });
  authority.register({ binding, repositoryPublicKey: repositoryKey.publicKey });
  return { authority, binding, clock, controlPlaneKey, principal, random, repositoryKey };
}

function helloOffer(): RemoteHelloOffer {
  return Object.freeze({
    negotiationVersion: REMOTE_NEGOTIATION_VERSION,
    peerId: "connector-fixture",
    supportedVersions: Object.freeze([REMOTE_PROTOCOL_VERSION]),
    capabilities: REMOTE_CAPABILITIES,
  });
}

function validNegotiation(fixture: Fixture) {
  return {
    repositoryKeyId: fixture.repositoryKey.keyId,
    connectorId: fixture.binding.connectorId,
    offer: helloOffer(),
  };
}

function commandFixture(
  suffix: string,
  repositoryId: string,
  expiresAt = "2026-08-14T10:10:00.000Z",
): CommandSubmission {
  const payload = { expectedRunModeRevision: 1 };
  return {
    apiVersion: PROTOCOL_VERSION,
    commandId: `command_${suffix}`,
    repositoryId,
    runId: "run-alpha",
    intent: { type: "pause-run" },
    payload,
    payloadDigest: digest(payload),
    expiresAt,
  };
}

function commandIngress(fixture: Fixture, command: CommandSubmission) {
  return {
    repositoryKeyId: fixture.repositoryKey.keyId,
    connectorId: fixture.binding.connectorId,
    requestId: `request-${command.commandId}`,
    command,
    signature: signCommandIngress(fixture.repositoryKey.privateKey, command),
  };
}

function ingressContext(fixture: Fixture) {
  return { principal: fixture.principal };
}

function completeReceiptChain(prefix: RemoteReceiptChain, clock: VirtualClock): RemoteReceiptChain {
  const entries = [...prefix.entries];
  const commandId = prefix.commandId;
  const localStages = [
    {
      stage: "local-accepted" as const,
      evidence: {
        type: "local-receipt" as const,
        localCommandId: commandId,
        receiptStatus: "queued" as const,
        receiptCursor: 10,
        receiptDigest: "3".repeat(64),
      },
    },
    {
      stage: "runner-claimed" as const,
      evidence: {
        type: "local-receipt" as const,
        localCommandId: commandId,
        receiptStatus: "claimed" as const,
        receiptCursor: 11,
        receiptDigest: "4".repeat(64),
      },
    },
    {
      stage: "local-outcome" as const,
      evidence: {
        type: "local-outcome" as const,
        localCommandId: commandId,
        receiptStatus: "completed" as const,
        receiptCursor: 12,
        receiptDigest: "5".repeat(64),
      },
    },
  ];
  for (const item of localStages) {
    clock.advance(1_000);
    const prior = entries.at(-1);
    if (prior === undefined) throw new Error("receipt chain prefix is empty");
    entries.push(
      createReceiptChainEntry({
        bindingId: prefix.bindingId,
        commandId,
        stage: item.stage,
        stageSequence: entries.length + 1,
        recordedAt: clock.now(),
        previousEntryDigest: prior.entryDigest,
        evidence: item.evidence,
      }),
    );
  }
  return Object.freeze({ ...prefix, entries: Object.freeze(entries) });
}

function reportFixture(fixture: Fixture, chain?: RemoteReceiptChain): RemoteClassifiedReport {
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    reportId: "report-alpha",
    binding: fixture.binding,
    classification: "internal",
    dataPolicyDigest: POLICY_DIGEST,
    reportSequence: 1,
    previousReportDigest: null,
    createdAt: fixture.clock.now(),
    receiptChains: chain === undefined ? Object.freeze([]) : Object.freeze([chain]),
    events: Object.freeze([]),
    projections: Object.freeze([]),
    synchronization: Object.freeze({
      repositoryId: fixture.binding.repositoryId,
      localLatestCursor: 14,
      durablyEnqueuedCursor: 12,
      centrallyAcknowledgedCursor: 0,
      localObservedAt: fixture.clock.now(),
      lastEnqueuedAt: fixture.clock.now(),
      lastAcknowledgedAt: null,
    }),
  });
}

function requireAccepted(result: ReturnType<ReferenceControlPlane["acceptCommand"]>) {
  if (result.type !== "accepted") throw new Error(`expected acceptance, received ${result.code}`);
  return result;
}

function requireAcknowledged(result: ReturnType<ReferenceControlPlane["acceptReport"]>) {
  if (result.type !== "acknowledged") {
    throw new Error(`expected acknowledgement, received ${result.code}`);
  }
  return result;
}

function requireChain(result: ReturnType<ReferenceControlPlane["recordDelivery"]>) {
  if ("type" in result) throw new Error(`expected receipt chain, received ${result.code}`);
  return result;
}

function digest(value: unknown): string {
  return digestBytes(canonicalStringify(value));
}

function digestBytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
