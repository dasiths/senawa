import { createHash } from "node:crypto";
import {
  type AuthenticatedPrincipal,
  type CommandSubmission,
  canonicalStringify,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import { describe, expect, it } from "vitest";

import { ReferenceControlPlane, signCommandIngress } from "./authority.js";
import { createEd25519FixtureKeyPair, DeterministicRandom, VirtualClock } from "./fixtures.js";
import { DeterministicControlPlaneSimulator } from "./simulator.js";

describe("deterministic control-plane simulator", () => {
  it("duplicates, delays, reorders, drops, and partitions visibility only", () => {
    const fixture = createSimulatorFixture();
    for (const suffix of ["one", "two", "three"]) accept(fixture, suffix);
    const canonicalBefore = canonicalStringify(
      fixture.authority.envelopes(fixture.binding.bindingId),
    );
    const frames = fixture.simulator.enqueue(fixture.binding.bindingId);
    const first = frames[0];
    const second = frames[1];
    const third = frames[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected three scheduled delivery frames");
    }
    const duplicate = fixture.simulator.duplicate(first.frameId);
    fixture.simulator.delay(second.frameId, 60_000);
    fixture.simulator.drop(third.frameId);
    fixture.simulator.reorder([duplicate.frameId, first.frameId, second.frameId]);

    fixture.simulator.partition(fixture.binding.bindingId);
    expect(fixture.simulator.poll(fixture.binding.bindingId)).toEqual([]);
    expect(fixture.simulator.pending()).toHaveLength(3);
    fixture.simulator.reconnect(fixture.binding.bindingId);
    expect(
      fixture.simulator.poll(fixture.binding.bindingId).map(({ frame }) => frame.sequence),
    ).toEqual([1, 1]);
    expect(fixture.simulator.pending()).toHaveLength(1);
    fixture.clock.advance(60_000);
    expect(
      fixture.simulator.poll(fixture.binding.bindingId).map(({ frame }) => frame.sequence),
    ).toEqual([2]);
    expect(fixture.simulator.pending()).toEqual([]);
    expect(canonicalStringify(fixture.authority.envelopes(fixture.binding.bindingId))).toBe(
      canonicalBefore,
    );
  });

  it("makes expiry and revocation deterministic without rewriting accepted records", () => {
    const expired = createSimulatorFixture();
    accept(expired, "expires", "2026-08-14T10:01:00.000Z");
    const expiredEnvelope = canonicalStringify(
      expired.authority.envelopes(expired.binding.bindingId)[0],
    );
    expired.simulator.enqueue(expired.binding.bindingId);
    expired.simulator.expire(60_000);
    expect(expired.simulator.poll(expired.binding.bindingId)[0]?.result).toMatchObject({
      type: "refusal",
      code: "expired",
    });
    expect(canonicalStringify(expired.authority.envelopes(expired.binding.bindingId)[0])).toBe(
      expiredEnvelope,
    );

    const revoked = createSimulatorFixture();
    accept(revoked, "revoked");
    revoked.simulator.enqueue(revoked.binding.bindingId);
    revoked.simulator.revoke(revoked.binding.bindingId);
    expect(revoked.simulator.poll(revoked.binding.bindingId)[0]?.result).toMatchObject({
      type: "refusal",
      code: "revoked",
    });
    expect(
      revoked.authority.acceptCommand(ingress(revoked, command(revoked, "after-revoke")), {
        principal: revoked.principal,
      }),
    ).toMatchObject({ type: "refusal", code: "revoked" });
  });

  it("honors afterSequence without letting older duplicates starve the page", () => {
    const fixture = createSimulatorFixture();
    for (const suffix of ["one", "two", "three"]) accept(fixture, suffix);
    const frames = fixture.simulator.enqueue(fixture.binding.bindingId);
    const first = frames[0];
    if (first === undefined) throw new Error("expected the first delivery frame");
    fixture.simulator.duplicate(first.frameId);
    expect(
      fixture.simulator.poll(fixture.binding.bindingId, 1, 1).map(({ frame }) => frame.sequence),
    ).toEqual([2]);
    expect(
      fixture.simulator.poll(fixture.binding.bindingId, 1, 2).map(({ frame }) => frame.sequence),
    ).toEqual([3]);
    expect(fixture.simulator.pending()).toEqual([]);
  });
});

interface SimulatorFixture {
  readonly authority: ReferenceControlPlane;
  readonly binding: RemoteRepositoryBinding;
  readonly clock: VirtualClock;
  readonly principal: AuthenticatedPrincipal;
  readonly repositoryKey: ReturnType<typeof createEd25519FixtureKeyPair>;
  readonly simulator: DeterministicControlPlaneSimulator;
}

function createSimulatorFixture(): SimulatorFixture {
  const clock = new VirtualClock("2026-08-14T10:00:00.000Z");
  const random = new DeterministicRandom("simulator");
  const repositoryKey = createEd25519FixtureKeyPair("repository-key-sim", "55".repeat(32));
  const controlPlaneKey = createEd25519FixtureKeyPair("control-plane-key-sim", "66".repeat(32));
  const binding: RemoteRepositoryBinding = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: "binding-sim",
    tenantId: "tenant-sim",
    repositoryId: "repository-sim",
    connectorId: "connector-sim",
    repositoryKeyId: repositoryKey.keyId,
    controlPlaneKeyId: controlPlaneKey.keyId,
    revocationEpoch: 0,
    policyDigest: "a".repeat(64),
    issuedAt: clock.now(),
  };
  const principal: AuthenticatedPrincipal = {
    issuer: "https://fixture.control-plane.test",
    subject: "operator-sim",
    tenant: binding.tenantId,
    assurance: "multi-factor",
    roles: ["operator"],
  };
  const authority = new ReferenceControlPlane({
    clock,
    random,
    serverPeerId: "control-plane-sim",
    signingKey: controlPlaneKey,
  });
  authority.register({ binding, repositoryPublicKey: repositoryKey.publicKey });
  const simulator = new DeterministicControlPlaneSimulator({ authority, clock, random });
  simulator.registerBinding(binding.bindingId, binding.revocationEpoch);
  return {
    authority,
    binding,
    clock,
    principal,
    repositoryKey,
    simulator,
  };
}

function accept(fixture: SimulatorFixture, suffix: string, expiresAt?: string): void {
  const result = fixture.authority.acceptCommand(
    ingress(fixture, command(fixture, suffix, expiresAt)),
    { principal: fixture.principal },
  );
  if (result.type !== "accepted") throw new Error(`expected acceptance, received ${result.code}`);
}

function command(
  fixture: SimulatorFixture,
  suffix: string,
  expiresAt = "2026-08-14T10:10:00.000Z",
): CommandSubmission {
  const payload = { expectedRunModeRevision: 1 };
  return {
    apiVersion: PROTOCOL_VERSION,
    commandId: `command_${suffix}`,
    repositoryId: fixture.binding.repositoryId,
    runId: "run-sim",
    intent: { type: "pause-run" },
    payload,
    payloadDigest: digest(payload),
    expiresAt,
  };
}

function ingress(fixture: SimulatorFixture, submission: CommandSubmission) {
  return {
    repositoryKeyId: fixture.repositoryKey.keyId,
    connectorId: fixture.binding.connectorId,
    requestId: `request-${submission.commandId}`,
    command: submission,
    signature: signCommandIngress(fixture.repositoryKey.privateKey, submission),
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}
