import { createHash } from "node:crypto";
import {
  createEd25519FixtureKeyPair,
  DeterministicRandom,
  ReferenceControlPlane,
  signCommandIngress,
  VirtualClock,
} from "@senawa/control-plane";
import {
  canonicalBytes,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteClassifiedReport,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import {
  NodeEd25519RemoteCrypto,
  remoteClassifiedReportSignatureBytes,
  remoteCommandEnvelopeSignatureBytes,
  remoteReportAcknowledgementSignatureBytes,
} from "@senawa/supervisor";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-14T10:00:00.000Z";
const POLICY_DIGEST = "a".repeat(64);

describe("remote signature interoperability", () => {
  it("uses the same domains for command envelopes, reports, and acknowledgements", () => {
    const repositoryKey = createEd25519FixtureKeyPair("key-repository", "11".repeat(32));
    const controlPlaneKey = createEd25519FixtureKeyPair("key-control-plane", "22".repeat(32));
    const binding: RemoteRepositoryBinding = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      bindingId: "binding-system",
      tenantId: "tenant-system",
      repositoryId: "repository-system",
      connectorId: "connector-system",
      repositoryKeyId: repositoryKey.keyId,
      controlPlaneKeyId: controlPlaneKey.keyId,
      revocationEpoch: 0,
      policyDigest: POLICY_DIGEST,
      issuedAt: NOW,
    };
    const authority = new ReferenceControlPlane({
      clock: new VirtualClock(NOW),
      random: new DeterministicRandom("system"),
      serverPeerId: "control-plane-system",
      signingKey: controlPlaneKey,
    });
    authority.register({ binding, repositoryPublicKey: repositoryKey.publicKey });
    const connectorCrypto = new NodeEd25519RemoteCrypto({
      publicKeys: new Map([[controlPlaneKey.keyId, controlPlaneKey.publicKey]]),
      privateKeys: new Map([[repositoryKey.keyId, repositoryKey.privateKey]]),
    });
    const command = {
      apiVersion: PROTOCOL_VERSION,
      commandId: "command_system",
      repositoryId: binding.repositoryId,
      runId: "run-system",
      intent: { type: "pause-run" as const },
      payload: { expectedRunModeRevision: 0 },
      payloadDigest: createHash("sha256")
        .update('{"expectedRunModeRevision":0}', "utf8")
        .digest("hex"),
      expiresAt: "2026-08-14T10:10:00.000Z",
    };
    const accepted = authority.acceptCommand(
      {
        repositoryKeyId: repositoryKey.keyId,
        connectorId: binding.connectorId,
        requestId: "request-system",
        command,
        signature: signCommandIngress(repositoryKey.privateKey, command),
      },
      {
        principal: {
          issuer: "https://control.example.test",
          subject: "operator-system",
          tenant: binding.tenantId,
          assurance: "multi-factor",
          roles: ["operator"],
        },
      },
    );
    if (accepted.type !== "accepted") throw new Error(`command refused: ${accepted.code}`);
    expect(
      connectorCrypto.verify(
        controlPlaneKey.keyId,
        remoteCommandEnvelopeSignatureBytes(accepted.envelope),
        accepted.envelope.signature,
      ),
    ).toBe(true);

    const report: RemoteClassifiedReport = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      reportId: "report-system",
      binding,
      classification: "internal",
      dataPolicyDigest: POLICY_DIGEST,
      reportSequence: 1,
      previousReportDigest: null,
      createdAt: NOW,
      receiptChains: [],
      events: [],
      projections: [],
      synchronization: {
        repositoryId: binding.repositoryId,
        localLatestCursor: 0,
        durablyEnqueuedCursor: 0,
        centrallyAcknowledgedCursor: 0,
        localObservedAt: NOW,
        lastEnqueuedAt: null,
        lastAcknowledgedAt: null,
      },
    };
    const reportAcceptance = authority.acceptReport({
      repositoryKeyId: repositoryKey.keyId,
      connectorId: binding.connectorId,
      report,
      signature: connectorCrypto.sign(
        repositoryKey.keyId,
        remoteClassifiedReportSignatureBytes(report),
      ),
    });
    if (reportAcceptance.type !== "acknowledged") {
      throw new Error(`report refused: ${reportAcceptance.code}`);
    }
    expect(
      connectorCrypto.verify(
        controlPlaneKey.keyId,
        remoteReportAcknowledgementSignatureBytes(reportAcceptance.acknowledgement),
        reportAcceptance.acknowledgement.signature,
      ),
    ).toBe(true);
    expect(reportAcceptance.acknowledgement.reportDigest).toBe(
      createHash("sha256").update(canonicalBytes(report)).digest("hex"),
    );
  });
});
