import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEd25519FixtureKeyPair,
  DeterministicControlPlaneSimulator,
  DeterministicRandom,
  InProcessControlPlaneTransport,
  ReferenceControlPlane,
  signCommandIngress,
  VirtualClock,
} from "@senawa/control-plane";
import {
  type CommandSubmission,
  canonicalBytes,
  canonicalStringify,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCommandEnvelope,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import { SqliteRemoteAuthority } from "@senawa/storage-sqlite";
import {
  NodeEd25519RemoteCrypto,
  RemoteConnector,
  remoteClassifiedReportSignatureBytes,
  SqliteSupervisorAuthority,
  SupervisorApi,
} from "@senawa/supervisor";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";

const roots = new Set<string>();
const INITIAL_TIME = "2026-08-14T10:00:00.000Z";
const POLICY_DIGEST = "a".repeat(64);

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("remote control-plane system conformance", () => {
  it("delivers an exact signed command through all five stages and exact acknowledgement", async () => {
    const fixture = createFixture();
    const accepted = fixture.accept(
      remoteSubmission("command_system-complete", "pause-run", {
        expectedRunModeRevision: 0,
      }),
    );
    expect(accepted.envelope.acceptedCommand.attribution.principal).toEqual(
      fixture.serverPrincipal,
    );
    expect(accepted.envelope.acceptedCommand.commandDigest).toBe(
      deterministicSha256.digest(canonicalBytes(accepted.envelope.acceptedCommand.command)),
    );
    expect(accepted.envelope.acceptedCommandDigest).toBe(
      deterministicSha256.digest(canonicalBytes(accepted.envelope.acceptedCommand)),
    );
    const canonicalEnvelope = canonicalStringify(accepted.envelope);

    const admission = await fixture.connector.pumpOnce();
    expect(admission, canonicalStringify(fixture.connector.status())).toMatchObject({
      receivedCommands: 1,
      admittedCommands: 1,
      refusedCommands: 0,
    });
    const persisted = fixture.remote.listPendingLocalResults(fixture.binding.bindingId)[0];
    expect(canonicalStringify(persisted?.envelope)).toBe(canonicalEnvelope);
    expect(fixture.supervisor.queryLatest("command_system-complete")).toMatchObject({
      status: "queued",
    });

    fixture.runLocalCommands();
    expect(fixture.supervisor.queryLatest("command_system-complete")).toMatchObject({
      status: "terminal",
      terminalReceipt: { status: "completed" },
    });
    expect(await fixture.connector.pumpOnce()).toMatchObject({
      localResults: 1,
      enqueuedReports: 1,
      acknowledgedReports: 1,
    });

    const sent = required(fixture.transport.sentReports()[0]);
    const acknowledgement = required(fixture.transport.acknowledgements()[0]);
    expect(sent.canonicalReport).toBe(canonicalStringify(sent.report));
    expect(
      fixture.repositoryVerifier.verify(
        fixture.binding.repositoryKeyId,
        remoteClassifiedReportSignatureBytes(sent.report),
        sent.signature,
      ),
    ).toBe(true);
    expect(sent.report.classification).toBe("internal");
    expect(sent.report.receiptChains[0]?.entries.map(({ stage }) => stage)).toEqual([
      "central-accepted",
      "connector-delivered",
      "local-accepted",
      "runner-claimed",
      "local-outcome",
    ]);
    expect(
      fixture.authority.receiptChain(fixture.binding.bindingId, "command_system-complete"),
    ).toEqual(sent.report.receiptChains[0]);
    expect(acknowledgement.reportId).toBe(sent.report.reportId);
    expect(fixture.remote.querySynchronization(fixture.binding.bindingId)).toMatchObject({
      localLatestCursor: sent.report.synchronization.localLatestCursor,
      durablyEnqueuedCursor: sent.report.synchronization.durablyEnqueuedCursor,
      centrallyAcknowledgedCursor: sent.report.synchronization.durablyEnqueuedCursor,
    });
    expect(fixture.connector.status().synchronization).toMatchObject({
      state: "current",
      localToEnqueued: 0,
      enqueuedToAcknowledged: 0,
      pendingReports: 0,
    });
    const staleCursor = sent.report.synchronization.localLatestCursor + 1;
    fixture.clock.advance(1_000);
    fixture.remote.observeLocalCursor(fixture.binding.bindingId, staleCursor, fixture.clock.now());
    expect(fixture.connector.status().synchronization).toMatchObject({
      state: "stale",
      localToEnqueued: 1,
      stalenessMs: 1_000,
    });

    for (const forbidden of [
      fixture.root,
      "PRIVATE KEY",
      "credential",
      "sourcePath",
      "lease",
      "prompt",
      "sdkSessionId",
      "assetContent",
    ]) {
      expect(sent.canonicalReport).not.toContain(forbidden);
    }
    await fixture.close();
  });

  it("converges after duplicate, reorder, drop, partition, and reconnect without local authority gain", async () => {
    const fixture = createFixture();
    const commands = [
      fixture.accept(
        remoteSubmission("command_fault-one", "pause-run", { expectedRunModeRevision: 0 }),
      ),
      fixture.accept(
        remoteSubmission("command_fault-two", "resume-run", { expectedRunModeRevision: 1 }),
      ),
      fixture.accept(
        remoteSubmission("command_fault-three", "pause-run", { expectedRunModeRevision: 2 }),
      ),
    ];
    const frames = fixture.simulator.enqueue(fixture.binding.bindingId);
    const first = required(frames[0]);
    const second = required(frames[1]);
    const third = required(frames[2]);
    const duplicate = fixture.simulator.duplicate(first.frameId);
    fixture.simulator.drop(third.frameId);
    fixture.simulator.reorder([second.frameId, duplicate.frameId, first.frameId]);
    fixture.simulator.partition(fixture.binding.bindingId);

    expect(await fixture.connector.pumpOnce()).toMatchObject({ partitioned: true });
    expect(fixture.connector.status()).toMatchObject({ health: "degraded", partitioned: true });
    for (const command of commands) {
      expect(
        fixture.supervisor.queryLatest(command.envelope.acceptedCommand.command.commandId),
      ).toBeUndefined();
    }
    const acceptedWhilePartitioned = fixture.accept(
      remoteSubmission("command_fault-partition", "resume-run", {
        expectedRunModeRevision: 3,
      }),
    );
    expect(
      fixture.supervisor.queryLatest(
        acceptedWhilePartitioned.envelope.acceptedCommand.command.commandId,
      ),
    ).toBeUndefined();

    fixture.simulator.reconnect(fixture.binding.bindingId);
    expect(await fixture.connector.pumpOnce()).toMatchObject({
      receivedCommands: 5,
      admittedCommands: 1,
      duplicateCommands: 1,
      refusedCommands: 3,
      partitioned: false,
    });
    expect(await fixture.connector.pumpOnce()).toMatchObject({
      receivedCommands: 3,
      admittedCommands: 3,
      duplicateCommands: 0,
      refusedCommands: 0,
    });
    expect(fixture.connector.status()).toMatchObject({
      health: "healthy",
      partitioned: false,
      synchronization: { inboundSequence: 4, readyCommands: 0, acceptedCommands: 4 },
    });
    expect(
      fixture.remote
        .listPendingLocalResults(fixture.binding.bindingId)
        .map(({ envelope }) => canonicalStringify(envelope)),
    ).toEqual([
      canonicalStringify(commands[0]?.envelope),
      canonicalStringify(commands[1]?.envelope),
      canonicalStringify(commands[2]?.envelope),
      canonicalStringify(acceptedWhilePartitioned.envelope),
    ]);
    await fixture.close();
  });

  it("refuses expired and revoked deliveries before local admission", async () => {
    const expired = createFixture();
    expired.accept(
      remoteSubmission(
        "command_expired-system",
        "pause-run",
        { expectedRunModeRevision: 0 },
        "2026-08-14T10:00:01.000Z",
      ),
    );
    expired.simulator.enqueue(expired.binding.bindingId);
    expired.simulator.expire(1_000);
    expect(await expired.connector.pumpOnce()).toMatchObject({
      receivedCommands: 0,
      admittedCommands: 0,
    });
    expect(expired.supervisor.queryLatest("command_expired-system")).toBeUndefined();
    await expired.close();

    const revoked = createFixture();
    revoked.accept(
      remoteSubmission("command_revoked-system", "pause-run", {
        expectedRunModeRevision: 0,
      }),
    );
    revoked.simulator.enqueue(revoked.binding.bindingId);
    revoked.simulator.revoke(revoked.binding.bindingId);
    expect(await revoked.connector.pumpOnce()).toMatchObject({
      receivedCommands: 0,
      admittedCommands: 0,
    });
    expect(revoked.supervisor.queryLatest("command_revoked-system")).toBeUndefined();
    expect(revoked.remote.queryPendingCounts(revoked.binding.bindingId)).toMatchObject({
      waitingCommands: 0,
      readyCommands: 0,
      acceptedCommands: 0,
    });
    await revoked.close();
  });

  it("reports stale approval and amendment decisions as local refusals", async () => {
    const fixture = createFixture();
    const graphRevision = createRuntimeGraph().revisionDigest;
    fixture.accept(
      remoteSubmission(
        "command_stale-approval-system",
        "record-authority-decision",
        { decision: "approve" },
        undefined,
        {
          expectedGraphRevision: graphRevision,
          exactObjectDigest: "b".repeat(64),
        },
      ),
    );
    fixture.accept(
      remoteSubmission(
        "command_stale-amendment-system",
        "record-amendment-decision",
        {
          amendmentId: "amendment_stale-system",
          proposalDigest: "c".repeat(64),
          decision: "approve",
          reviewedResultGraphRevisionDigest: "d".repeat(64),
        },
        undefined,
        {
          expectedGraphRevision: graphRevision,
          exactObjectDigest: "c".repeat(64),
        },
      ),
    );
    expect(await fixture.connector.pumpOnce()).toMatchObject({ admittedCommands: 2 });
    fixture.runLocalCommands(4);
    for (const commandId of ["command_stale-approval-system", "command_stale-amendment-system"]) {
      expect(fixture.supervisor.queryLatest(commandId)).toMatchObject({
        status: "terminal",
        terminalReceipt: { status: "refused" },
      });
    }
    expect(await fixture.connector.pumpOnce()).toMatchObject({
      localResults: 2,
      enqueuedReports: 2,
      acknowledgedReports: 2,
    });
    expect(
      fixture.transport
        .sentReports()
        .flatMap(({ report }) => report.receiptChains)
        .map((chain) => chain.entries.at(-1)),
    ).toEqual([
      expect.objectContaining({
        stage: "local-outcome",
        evidence: expect.objectContaining({ receiptStatus: "refused" }),
      }),
      expect.objectContaining({
        stage: "local-outcome",
        evidence: expect.objectContaining({ receiptStatus: "refused" }),
      }),
    ]);
    await fixture.close();
  });
});

interface SystemFixture {
  readonly root: string;
  readonly clock: VirtualClock;
  readonly binding: RemoteRepositoryBinding;
  readonly authority: ReferenceControlPlane;
  readonly simulator: DeterministicControlPlaneSimulator;
  readonly transport: InProcessControlPlaneTransport;
  readonly supervisor: SqliteSupervisorAuthority;
  readonly remote: SqliteRemoteAuthority;
  readonly connector: RemoteConnector;
  readonly serverPrincipal: {
    readonly issuer: string;
    readonly subject: string;
    readonly tenant: string;
    readonly assurance: "multi-factor";
    readonly roles: readonly string[];
  };
  readonly repositoryVerifier: NodeEd25519RemoteCrypto;
  accept(command: CommandSubmission): { readonly envelope: RemoteCommandEnvelope };
  runLocalCommands(limit?: number): void;
  close(): Promise<void>;
}

function createFixture(): SystemFixture {
  const root = mkdtempSync(join(tmpdir(), "senawa-remote-system-"));
  roots.add(root);
  const databasePath = join(root, "authority.db");
  const dependencies: RuntimeDependencies = {
    sha256: deterministicSha256,
    authorization: createRoleAuthorizationPolicy([
      { intent: "instantiate-run", roles: ["release-manager"] },
      { intent: "pause-run", roles: ["release-manager"] },
      { intent: "resume-run", roles: ["release-manager"] },
      { intent: "record-authority-decision", roles: ["release-manager"] },
      { intent: "record-amendment-decision", roles: ["release-manager"] },
    ]),
  };
  const supervisor = new SqliteSupervisorAuthority({
    databasePath,
    assetDirectory: join(root, "assets"),
    dependencies,
  });
  const supervisorApi = new SupervisorApi(supervisor);
  initializeLocalRun(supervisorApi, supervisor, INITIAL_TIME);
  const remote = new SqliteRemoteAuthority({ databasePath, dependencies });
  const clock = new VirtualClock(INITIAL_TIME);
  const random = new DeterministicRandom("system");
  const repositoryKey = createEd25519FixtureKeyPair("key-repository-system", "77".repeat(32));
  const controlPlaneKey = createEd25519FixtureKeyPair("key-control-plane-system", "88".repeat(32));
  const binding: RemoteRepositoryBinding = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: "binding-system",
    tenantId: "tenant-system",
    repositoryId: runtimeFixture.repositoryId,
    connectorId: "connector-system",
    repositoryKeyId: repositoryKey.keyId,
    controlPlaneKeyId: controlPlaneKey.keyId,
    revocationEpoch: 0,
    policyDigest: POLICY_DIGEST,
    issuedAt: clock.now(),
  };
  const serverPrincipal = {
    issuer: "https://identity.example.test",
    subject: "operator-system",
    tenant: binding.tenantId,
    assurance: "multi-factor" as const,
    roles: ["operator"],
  };
  const authority = new ReferenceControlPlane({
    clock,
    random,
    serverPeerId: "control-plane-system",
    signingKey: controlPlaneKey,
    sha256: deterministicSha256,
  });
  authority.register({ binding, repositoryPublicKey: repositoryKey.publicKey });
  const simulator = new DeterministicControlPlaneSimulator({ authority, clock, random });
  const transport = new InProcessControlPlaneTransport({ authority, simulator, binding });
  const crypto = new NodeEd25519RemoteCrypto({
    publicKeys: new Map([[controlPlaneKey.keyId, controlPlaneKey.publicKey]]),
    privateKeys: new Map([[repositoryKey.keyId, repositoryKey.privateKey]]),
  });
  const repositoryVerifier = new NodeEd25519RemoteCrypto({
    publicKeys: new Map([[repositoryKey.keyId, repositoryKey.publicKey]]),
  });
  let reportSequence = 0;
  const connector = new RemoteConnector({
    authority: remote,
    supervisorApi,
    binding,
    policy: {
      policyDigest: POLICY_DIGEST,
      roleMappings: [
        {
          issuer: serverPrincipal.issuer,
          tenant: binding.tenantId,
          upstreamRole: "operator",
          localRoles: ["release-manager"],
        },
      ],
      maximumRemoteAuthorizationLeaseSeconds: 900,
      synchronization: {
        classificationCeiling: "internal",
        receiptChain: true,
        events: true,
        projections: true,
        synchronizationState: true,
      },
    },
    transport,
    verifier: crypto,
    signer: crypto,
    clock: { now: () => Date.parse(clock.now()) },
    ids: {
      allocate: () => {
        reportSequence += 1;
        return `report_system-${reportSequence}`;
      },
    },
    admissionAllocator: {
      allocationsFor: (submission) =>
        [1, 2, 3].map((ordinal) => ({
          kind: "stream-event" as const,
          id: `stream-event-${submission.commandId}-${ordinal}`,
        })),
    },
    ownerId: "owner_remote-system",
    batchSize: 8,
    pollIntervalMs: 60_000,
  });
  return {
    root,
    clock,
    binding,
    authority,
    simulator,
    transport,
    supervisor,
    remote,
    connector,
    serverPrincipal,
    repositoryVerifier,
    accept(command) {
      const result = authority.acceptCommand(
        {
          repositoryKeyId: repositoryKey.keyId,
          connectorId: binding.connectorId,
          requestId: `request-${command.commandId}`,
          command,
          signature: signCommandIngress(repositoryKey.privateKey, command),
          principal: {
            issuer: "https://attacker.invalid",
            subject: "attacker",
            tenant: "tenant-attacker",
            assurance: "single-factor",
            roles: ["administrator"],
          },
        } as Parameters<ReferenceControlPlane["acceptCommand"]>[0],
        { principal: serverPrincipal },
      );
      if (result.type !== "accepted") throw new Error(`command refused: ${result.code}`);
      return result;
    },
    runLocalCommands(limit = 1) {
      const lease = supervisor.acquireRunLease(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "owner_remote-system-runner",
        clock.now(),
        new Date(Date.parse(clock.now()) + 60_000).toISOString(),
      );
      for (let index = 0; index < limit; index += 1) {
        supervisor.drainRunOnce({
          repositoryId: runtimeFixture.repositoryId,
          runId: runtimeFixture.runId,
          lease,
          currentTime: clock.now(),
        });
      }
      supervisor.releaseRunLease(lease, clock.now());
    },
    async close() {
      await connector.close();
      remote.close();
      supervisor.close();
    },
  };
}

function remoteSubmission(
  commandId: string,
  intent: "pause-run" | "resume-run" | "record-authority-decision" | "record-amendment-decision",
  payload: object,
  expiresAt = "2026-08-14T10:10:00.000Z",
  guards: Readonly<{
    expectedGraphRevision?: string;
    exactObjectDigest?: string;
  }> = {},
): CommandSubmission {
  const envelope = runtimeCommand({ commandId, intent, payload, expiresAt, ...guards });
  const { principal: _principal, transport: _transport, ...submission } = envelope;
  return submission;
}

function initializeLocalRun(
  api: SupervisorApi,
  supervisor: SqliteSupervisorAuthority,
  currentTime: string,
): void {
  const local = runtimeCommand({
    commandId: "command_local-system-bootstrap",
    intent: "instantiate-run",
    payload: {
      workflowId: runtimeFixture.workflowId,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      execution: runtimeFixture.execution,
      graph: createRuntimeGraph(),
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
      allowancePolicy: runtimeFixture.allowancePolicy,
    },
  });
  const { principal: _principal, transport: _transport, ...submission } = local;
  api.submitCommand(submission, {
    principal: runtimePrincipal,
    transportKind: "cli",
    requestId: "request_local-system-bootstrap",
    admission: {
      currentTime,
      facts: { source: "local-system-bootstrap" },
      allocator: {
        allocationsFor: () =>
          [1, 2, 3].map((ordinal) => ({
            kind: "stream-event" as const,
            id: `stream-event-local-system-bootstrap-${ordinal}`,
          })),
      },
    },
  });
  const lease = supervisor.acquireRunLease(
    runtimeFixture.repositoryId,
    runtimeFixture.runId,
    "owner_local-system-bootstrap",
    currentTime,
    new Date(Date.parse(currentTime) + 60_000).toISOString(),
  );
  supervisor.drainRunOnce({
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    lease,
    currentTime,
  });
  supervisor.releaseRunLease(lease, currentTime);
  const wake = supervisor.queryWake(runtimeFixture.repositoryId, runtimeFixture.runId);
  if (wake !== undefined) {
    supervisor.acknowledgeWake(wake.repositoryId, wake.runId, wake.generation);
  }
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("required fixture value is missing");
  return value;
}
