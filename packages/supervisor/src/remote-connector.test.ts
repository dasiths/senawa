import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandSubmission,
  canonicalBytes,
  canonicalStringify,
  PROTOCOL_VERSION,
  REMOTE_CAPABILITIES,
  REMOTE_NEGOTIATION_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN,
  type RemoteClassifiedReport,
  type RemoteCommandEnvelope,
  type RemoteHelloResponse,
  type RemoteReceiptChainEntry,
  type RemoteReportAcknowledgement,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import { SqliteRemoteAuthority } from "@senawa/storage-sqlite";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SupervisorApi } from "./api.js";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import {
  intersectRemotePrincipal,
  NodeEd25519RemoteCrypto,
  REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN,
  RemoteConnector,
  type RemoteConnectorTransport,
  remoteClassifiedReportSignatureBytes,
  remoteCommandEnvelopeSignatureBytes,
  remoteReportAcknowledgementSignatureBytes,
} from "./remote-connector.js";

const roots = new Set<string>();
const POLICY_DIGEST = "a".repeat(64);
const START_TIME = Date.parse("2026-08-14T10:01:00.000Z");

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("remote connector trust boundary", () => {
  it("uses exact Ed25519 domains and intersects every upstream role with local mappings", () => {
    const keys = keyFixture();
    const envelope = unsignedEnvelope(
      bindingFixture(),
      remoteControlSubmission("command_remote-crypto"),
    );
    const signed = signEnvelope(envelope, keys.centralCrypto);
    expect(
      keys.connectorCrypto.verify(
        signed.signingKeyId,
        remoteCommandEnvelopeSignatureBytes(signed),
        signed.signature,
      ),
    ).toBe(true);
    const wrongDomain = joinedBytes(
      `${REMOTE_COMMAND_ENVELOPE_SIGNATURE_DOMAIN}wrong\n`,
      canonicalBytes(withoutSignature(signed)),
    );
    expect(keys.connectorCrypto.verify(signed.signingKeyId, wrongDomain, signed.signature)).toBe(
      false,
    );
    const signatureAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = signatureAlphabet.indexOf(signed.signature.at(-1) ?? "");
    const noncanonicalAlias = `${signed.signature.slice(0, -1)}${signatureAlphabet[finalIndex + 1]}`;
    expect(
      keys.connectorCrypto.verify(
        signed.signingKeyId,
        remoteCommandEnvelopeSignatureBytes(signed),
        noncanonicalAlias,
      ),
    ).toBe(false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      () => new NodeEd25519RemoteCrypto({ publicKeys: new Map([["key_rsa", rsa.publicKey]]) }),
    ).toThrow("Ed25519 public keys");
    expect(
      () => new NodeEd25519RemoteCrypto({ privateKeys: new Map([["key_rsa", rsa.privateKey]]) }),
    ).toThrow("Ed25519 private keys");
    expect(
      intersectRemotePrincipal(
        { ...signed.acceptedCommand.attribution.principal, roles: ["operator", "auditor"] },
        [
          roleMapping("operator", ["release-manager", "reviewer"]),
          roleMapping("auditor", ["reviewer"]),
        ],
      ).roles,
    ).toEqual(["release-manager", "reviewer"]);
    expect(() =>
      intersectRemotePrincipal(
        { ...signed.acceptedCommand.attribution.principal, roles: ["operator", "unmapped"] },
        [roleMapping("operator", ["release-manager"])],
      ),
    ).toThrowError(expect.objectContaining({ code: "role-unmapped" }));
  });

  it("persists exact local stages, retries a fenced claim, and sends only allowlisted metadata", async () => {
    const harness = createHarness();
    const envelope = harness.envelope("command_remote-complete");
    harness.transport.commandBatches.push([envelope], [envelope]);

    const firstPump = await harness.connector.pumpOnce();
    expect(firstPump, canonicalStringify(harness.connector.status())).toMatchObject({
      receivedCommands: 1,
      admittedCommands: 1,
      refusedCommands: 0,
    });
    expect(await harness.connector.pumpOnce()).toMatchObject({
      receivedCommands: 1,
      duplicateCommands: 1,
      admittedCommands: 0,
    });
    const queued = harness.supervisor.queryLatest(envelope.acceptedCommand.command.commandId);
    expect(queued).toMatchObject({ status: "queued" });
    const attributionDatabase = new Database(harness.databasePath, { readonly: true });
    const attributed = attributionDatabase
      .prepare<[string], { canonical_envelope: string }>(
        "SELECT canonical_envelope FROM supervisor_commands WHERE command_id = ?",
      )
      .get(envelope.acceptedCommand.command.commandId);
    attributionDatabase.close();
    expect(JSON.parse(requiredValue(attributed).canonical_envelope)).toMatchObject({
      principal: {
        issuer: "https://control.example.test",
        subject: "operator@example.test",
        tenant: harness.binding.tenantId,
        roles: ["release-manager"],
      },
      transport: {
        kind: "remote",
        requestId: `request_${envelope.acceptedCommand.command.commandId}`,
      },
    });
    const lease = harness.supervisor.acquireRunLease(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "owner_remote-runner",
      harness.now(),
      new Date(harness.clock.value + 60_000).toISOString(),
    );
    expect(
      harness.supervisor.drainRunOnce({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease,
        currentTime: harness.now(),
      }),
    ).toMatchObject({ status: "terminal", terminalReceipt: { status: "completed" } });

    harness.transport.failNextReport = true;
    expect(await harness.connector.pumpOnce()).toMatchObject({
      localResults: 1,
      enqueuedReports: 1,
      acknowledgedReports: 0,
      partitioned: true,
    });
    expect(harness.remote.queryPendingCounts(harness.binding.bindingId).claimedReports).toBe(1);
    harness.clock.value += 31_000;
    expect(await harness.connector.pumpOnce()).toMatchObject({
      acknowledgedReports: 1,
      partitioned: false,
    });

    const sent = harness.transport.sentReports.at(-1);
    expect(sent?.report.receiptChains[0]?.entries.map((entry) => entry.stage)).toEqual([
      "central-accepted",
      "connector-delivered",
      "local-accepted",
      "runner-claimed",
      "local-outcome",
    ]);
    expect(sent?.report.receiptChains[0]?.entries.at(-1)).toMatchObject({
      evidence: { type: "local-outcome", receiptStatus: "completed" },
    });
    expect(
      harness.keys.repositoryVerifier.verify(
        harness.binding.repositoryKeyId,
        remoteClassifiedReportSignatureBytes(requiredValue(sent).report),
        requiredValue(sent).signature,
      ),
    ).toBe(true);
    const outbound = requiredValue(sent).canonicalReport;
    for (const forbidden of [
      "fixture://runtime",
      "sourcePath",
      "privateKey",
      "credential",
      "lease",
      "token",
      "prompt",
      "assetContent",
      "sdkSessionId",
      "release-manager",
    ]) {
      expect(outbound).not.toContain(forbidden);
    }
    expect(outbound).not.toContain('"payload":');
    expect(outbound).not.toContain('"result":');
    expect(harness.connector.status()).toMatchObject({
      health: "healthy",
      partitioned: false,
      synchronization: { pendingReports: 0, claimedReports: 0 },
    });
    const database = new Database(harness.databasePath, { readonly: true });
    const durable = database
      .prepare<
        [],
        {
          processing_state: string;
          canonical_local_acceptance: string;
          canonical_local_result: string;
        }
      >(
        `SELECT processing_state, canonical_local_acceptance, canonical_local_result
         FROM remote_command_inbox`,
      )
      .get();
    const reportRow = database
      .prepare<[], { claim_fence: number; canonical_report: string; delivery_state: string }>(
        `SELECT claim_fence, canonical_report, delivery_state FROM remote_report_outbox`,
      )
      .get();
    const peerRow = database
      .prepare<
        [],
        {
          session_id: string;
          selected_protocol_version: string;
          canonical_capabilities: string;
        }
      >(
        `SELECT session_id, selected_protocol_version, canonical_capabilities
         FROM remote_peer_state`,
      )
      .get();
    database.close();
    expect(durable).toMatchObject({ processing_state: "local-result" });
    expect(durable?.canonical_local_acceptance).toContain('"stage":"local-accepted"');
    expect(durable?.canonical_local_result).toContain('"stage":"local-outcome"');
    expect(reportRow).toMatchObject({ claim_fence: 2, delivery_state: "acknowledged" });
    expect(reportRow?.canonical_report).toBe(outbound);
    expect(peerRow).toEqual({
      session_id: "session_remote-connector",
      selected_protocol_version: REMOTE_PROTOCOL_VERSION,
      canonical_capabilities: canonicalStringify(REMOTE_CAPABILITIES),
    });
    await harness.close();
  });

  it("preserves the exact server delivery receipt across independent clocks and latency", async () => {
    const harness = createHarness();
    const envelope = harness.envelope("command_remote-server-delivery-time");
    harness.transport.serverClockValue = START_TIME + 4 * 60_000;
    harness.transport.deliveryLatencyMs = 17_000;
    harness.transport.commandBatches.push([envelope]);

    expect(await harness.connector.pumpOnce()).toMatchObject({ admittedCommands: 1 });
    const record = harness.remote.listPendingLocalResults(harness.binding.bindingId)[0];
    const serverEntry = harness.transport.deliveredEntries[0];
    expect(record?.receivedAt).toBe("2026-08-14T10:01:17.000Z");
    expect(record?.deliveryEntry).toEqual(serverEntry);
    expect(record?.deliveryEntry.recordedAt).toBe("2026-08-14T10:05:00.000Z");
    expect(canonicalStringify(record?.deliveryEntry)).toBe(canonicalStringify(serverEntry));
    await harness.close();
  });

  it.each([
    ["ahead", 5 * 60_000],
    ["behind", -5 * 60_000],
  ] as const)(
    "accepts a signed server acknowledgement with the server clock %s through durable synchronization",
    async (_direction, skewMs) => {
      const harness = createHarness();
      harness.transport.serverClockValue = START_TIME + skewMs;
      harness.transport.deliveryLatencyMs = 17_000;
      const envelope = harness.envelope(`command_remote-clock-${skewMs}`);
      harness.transport.commandBatches.push([envelope]);

      expect(await harness.connector.pumpOnce()).toMatchObject({ admittedCommands: 1 });
      completeCommand(harness, envelope, `owner_clock-${Math.abs(skewMs)}`);
      expect(await harness.connector.pumpOnce()).toMatchObject({
        localResults: 1,
        enqueuedReports: 1,
        acknowledgedReports: 1,
        partitioned: false,
      });

      const sent = requiredValue(harness.transport.sentReports.at(-1));
      const delivery = requiredValue(harness.transport.deliveredEntries.at(-1));
      expect(sent.report.receiptChains[0]?.entries[1]).toEqual(delivery);
      expect(
        sent.report.receiptChains[0]?.entries.map(({ stageSequence }) => stageSequence),
      ).toEqual([1, 2, 3, 4, 5]);
      expect(harness.remote.querySynchronization(harness.binding.bindingId)).toMatchObject({
        durablyEnqueuedCursor: sent.report.synchronization.durablyEnqueuedCursor,
        centrallyAcknowledgedCursor: sent.report.synchronization.durablyEnqueuedCursor,
        lastAcknowledgedAt: new Date(START_TIME + skewMs).toISOString(),
      });
      await harness.close();

      const reopened = new SqliteRemoteAuthority({
        databasePath: harness.databasePath,
        dependencies: {
          sha256: deterministicSha256,
          authorization: createRoleAuthorizationPolicy([]),
        },
      });
      expect(reopened.querySynchronization(harness.binding.bindingId)).toMatchObject({
        centrallyAcknowledgedCursor: sent.report.synchronization.durablyEnqueuedCursor,
        lastAcknowledgedAt: new Date(START_TIME + skewMs).toISOString(),
      });
      reopened.close();
    },
  );

  it("rejects bad signature, key, binding, policy, expiry, revocation, chain, and absent mapping", async () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (harness: Harness, envelope: RemoteCommandEnvelope) => RemoteCommandEnvelope;
      readonly revocationEpoch?: number;
    }[] = [
      {
        name: "bad signature",
        mutate: (_harness, envelope) => ({ ...envelope, signature: "B".repeat(86) }),
      },
      {
        name: "wrong domain",
        mutate: (harness, envelope) => ({
          ...envelope,
          signature: harness.keys.centralCrypto.sign(
            envelope.signingKeyId,
            joinedBytes(
              "senawa.dev/remote-control/v1/wrong-domain\n",
              canonicalBytes(withoutSignature(envelope)),
            ),
          ),
        }),
      },
      {
        name: "wrong key",
        mutate: (harness, envelope) => ({
          ...envelope,
          signingKeyId: harness.binding.repositoryKeyId,
        }),
      },
      {
        name: "wrong binding",
        mutate: (harness, envelope) =>
          resignEnvelope(
            replaceBinding(envelope, { ...harness.binding, connectorId: "connector_other" }),
            harness.keys.centralCrypto,
          ),
      },
      {
        name: "wrong policy",
        mutate: (harness, envelope) =>
          resignEnvelope(
            replaceBinding(envelope, { ...harness.binding, policyDigest: "b".repeat(64) }),
            harness.keys.centralCrypto,
          ),
      },
      {
        name: "expired",
        mutate: (harness, envelope) =>
          resignEnvelope(
            replaceExpiry(envelope, new Date(harness.clock.value).toISOString()),
            harness.keys.centralCrypto,
          ),
      },
      { name: "revoked", mutate: (_harness, envelope) => envelope, revocationEpoch: 3 },
      {
        name: "sequence gap",
        mutate: (harness, envelope) =>
          resignEnvelope(
            { ...envelope, sequence: 2, previousEnvelopeDigest: "c".repeat(64) },
            harness.keys.centralCrypto,
          ),
      },
    ];
    for (const testCase of cases) {
      const harness = createHarness();
      harness.transport.revocationEpoch =
        testCase.revocationEpoch ?? harness.binding.revocationEpoch;
      harness.transport.commandBatches.push([
        testCase.mutate(
          harness,
          harness.envelope(`command_remote-${testCase.name.replaceAll(" ", "-")}`),
        ),
      ]);
      const result = await harness.connector.pumpOnce();
      expect(result, testCase.name).toMatchObject({
        receivedCommands: 1,
        admittedCommands: 0,
        refusedCommands: 1,
      });
      expect(harness.supervisor.listPendingWakes(), testCase.name).toHaveLength(0);
      expect(
        harness.remote.queryPendingCounts(harness.binding.bindingId),
        testCase.name,
      ).toMatchObject({
        readyCommands: 0,
        acceptedCommands: 0,
      });
      await harness.close();
    }

    const unmapped = createHarness({ roleMappings: [] });
    unmapped.transport.commandBatches.push([unmapped.envelope("command_remote-unmapped")]);
    expect(await unmapped.connector.pumpOnce()).toMatchObject({
      refusedCommands: 1,
      admittedCommands: 0,
    });
    expect(unmapped.supervisor.queryLatest("command_remote-unmapped")).toBeUndefined();
    expect(unmapped.remote.queryPendingCounts(unmapped.binding.bindingId).readyCommands).toBe(1);
    await unmapped.close();
  }, 15_000);

  it("records local authorization refusal as a distinct terminal outcome", async () => {
    const harness = createHarness({ roleMappings: [roleMapping("operator", ["viewer"])] });
    const envelope = harness.envelope("command_remote-local-refusal");
    harness.transport.commandBatches.push([envelope]);
    const admission = await harness.connector.pumpOnce();
    expect(admission, canonicalStringify(harness.connector.status())).toMatchObject({
      admittedCommands: 1,
    });
    const lease = harness.supervisor.acquireRunLease(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "owner_remote-refusal",
      harness.now(),
      new Date(harness.clock.value + 60_000).toISOString(),
    );
    expect(
      harness.supervisor.drainRunOnce({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease,
        currentTime: harness.now(),
      }),
    ).toMatchObject({ terminalReceipt: { status: "refused" } });
    expect(await harness.connector.pumpOnce()).toMatchObject({
      localResults: 1,
      acknowledgedReports: 1,
    });
    expect(
      harness.transport.sentReports.at(-1)?.report.receiptChains[0]?.entries.at(-1),
    ).toMatchObject({
      stage: "local-outcome",
      evidence: { type: "local-outcome", receiptStatus: "refused" },
    });
    await harness.close();
  });

  it.each(["queued", "terminal"] as const)(
    "converges a ready inbox after local supervisor acceptance is already %s",
    async (recoveryState) => {
      const harness = createHarness();
      const envelope = harness.envelope(`command_remote-replay-${recoveryState}`);
      harness.transport.commandBatches.push([envelope]);
      const recordAcceptance = harness.remote.recordLocalAcceptance.bind(harness.remote);
      Object.defineProperty(harness.remote, "recordLocalAcceptance", {
        configurable: true,
        value: () => {
          throw new Error("simulated crash before inbox acceptance write");
        },
      });
      expect(await harness.connector.pumpOnce()).toMatchObject({ refusedCommands: 1 });
      expect(harness.remote.queryPendingCounts(harness.binding.bindingId).readyCommands).toBe(1);
      expect(
        harness.supervisor.queryLatest(envelope.acceptedCommand.command.commandId),
      ).toMatchObject({
        status: "queued",
      });
      if (recoveryState === "terminal") completeCommand(harness, envelope, "owner_replay-terminal");
      Object.defineProperty(harness.remote, "recordLocalAcceptance", {
        configurable: true,
        value: recordAcceptance,
      });

      expect(await harness.connector.pumpOnce()).toMatchObject({ admittedCommands: 1 });
      expect(harness.remote.queryPendingCounts(harness.binding.bindingId)).toMatchObject({
        readyCommands: 0,
        acceptedCommands: recoveryState === "queued" ? 1 : 0,
        pendingReports: 0,
      });
      if (recoveryState === "terminal") {
        expect(
          harness.transport.sentReports
            .at(-1)
            ?.report.receiptChains[0]?.entries.map((entry) => entry.stage),
        ).toEqual([
          "central-accepted",
          "connector-delivered",
          "local-accepted",
          "runner-claimed",
          "local-outcome",
        ]);
      }
      await harness.close();
    },
  );

  it("negotiates before polling and rejects typed hello refusal", async () => {
    const harness = createHarness();
    harness.transport.helloResponse = {
      negotiationVersion: REMOTE_NEGOTIATION_VERSION,
      type: "refusal",
      code: "no-common-version",
      message: "no common version",
      supportedVersions: ["senawa.dev/remote-control/v2"],
      requiredCapabilities: REMOTE_CAPABILITIES,
    };
    expect(await harness.connector.pumpOnce()).toMatchObject({ partitioned: true });
    expect(harness.transport.negotiateCalls).toBe(1);
    expect(harness.transport.receiveCalls).toBe(0);
    expect(harness.connector.status().lastErrorCode).toBe("no-common-version");
    harness.transport.helloResponse = {
      negotiationVersion: REMOTE_NEGOTIATION_VERSION,
      type: "refusal",
      code: "missing-capability",
      message: "required capability is missing",
      supportedVersions: [REMOTE_PROTOCOL_VERSION],
      requiredCapabilities: REMOTE_CAPABILITIES,
    };
    expect(await harness.connector.pumpOnce()).toMatchObject({ partitioned: true });
    expect(harness.transport.negotiateCalls).toBe(2);
    expect(harness.transport.receiveCalls).toBe(0);
    expect(harness.connector.status().lastErrorCode).toBe("missing-capability");
    await harness.close();
  });

  it("sends only the required terminal chain when optional synchronization metadata is disabled", async () => {
    const harness = createHarness({
      synchronization: {
        classificationCeiling: "internal",
        receiptChain: false,
        events: false,
        projections: false,
        synchronizationState: false,
      },
    });
    const envelope = harness.envelope("command_remote-no-metadata");
    harness.transport.commandBatches.push([envelope]);
    await harness.connector.pumpOnce();
    completeCommand(harness, envelope, "owner_no-metadata");
    const result = await harness.connector.pumpOnce();
    expect(result).toMatchObject({
      localResults: 1,
      enqueuedReports: 1,
      acknowledgedReports: 1,
      partitioned: false,
    });
    expect(harness.transport.sentReports.at(-1)?.report).toMatchObject({
      receiptChains: [
        {
          commandId: envelope.acceptedCommand.command.commandId,
          entries: [{ stage: "central-accepted" }, {}, {}, {}, { stage: "local-outcome" }],
        },
      ],
      events: [],
      projections: [],
      synchronization: {
        localLatestCursor: 0,
        durablyEnqueuedCursor: 0,
        centrallyAcknowledgedCursor: 0,
        localObservedAt: harness.binding.issuedAt,
        lastEnqueuedAt: null,
        lastAcknowledgedAt: null,
      },
    });
    await harness.close();
  });

  it("pages event metadata from the durable cursor until more than one batch synchronizes", async () => {
    const harness = createHarness({ batchSize: 1 });
    const envelope = harness.envelope("command_remote-event-pages");
    harness.transport.commandBatches.push([envelope]);
    await harness.connector.pumpOnce();
    completeCommand(harness, envelope, "owner_event-pages");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await harness.connector.pumpOnce();
      const lag = harness.connector.status().synchronization;
      if (lag.localToEnqueued === 0 && lag.enqueuedToAcknowledged === 0) break;
    }
    const eventCursors = harness.transport.sentReports.flatMap(({ report }) =>
      report.events.map((event) => event.cursor),
    );
    expect(harness.transport.sentReports.length).toBeGreaterThan(1);
    expect(eventCursors).toEqual([...new Set(eventCursors)].sort((left, right) => left - right));
    expect(harness.connector.status().synchronization).toMatchObject({
      localToEnqueued: 0,
      enqueuedToAcknowledged: 0,
    });
    await harness.close();
  });

  it("pages two runs from independent durable cursors without skips or starvation", async () => {
    const harness = createHarness({
      batchSize: 1,
      synchronization: {
        classificationCeiling: "internal",
        receiptChain: true,
        events: true,
        projections: false,
        synchronizationState: true,
      },
    });
    const runs = seedCompletedRemoteRuns(harness, [
      { runId: "run_remote-multi-a", eventCursors: [1, 14, 20, 30] },
      { runId: "run_remote-multi-b", eventCursors: [1, 13, 15, 18] },
    ]);
    const templateHistory = harness.supervisor.queryHistory(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    Object.defineProperty(harness.supervisor, "queryHistory", {
      configurable: true,
      value: (repositoryId: string, runId: string) => {
        const commandId = requiredValue(runs.find((run) => run.runId === runId)).commandId;
        return templateHistory.map((receipt) => ({
          ...receipt,
          repositoryId,
          runId,
          commandId,
        }));
      },
    });
    const pageCalls: { readonly runId: string; readonly afterCursor: number }[] = [];
    const queryEventPage = harness.supervisorApi.queryAuthority.queryEventPage.bind(
      harness.supervisorApi.queryAuthority,
    );
    Object.defineProperty(harness.supervisorApi.queryAuthority, "queryEventPage", {
      configurable: true,
      value: (repositoryId: string, runId: string, afterCursor: number, limit: number) => {
        pageCalls.push({ runId, afterCursor });
        return queryEventPage(repositoryId, runId, afterCursor, limit);
      },
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await harness.connector.pumpOnce();
      const checkpoints = runs.map((run) =>
        harness.remote.queryRunEventCheckpoint(
          harness.binding.bindingId,
          harness.binding.repositoryId,
          run.runId,
        ),
      );
      if (
        checkpoints.every(
          (checkpoint) =>
            checkpoint.durablyEnqueuedCursor === checkpoint.localLatestCursor &&
            checkpoint.centrallyAcknowledgedCursor === checkpoint.localLatestCursor,
        )
      )
        break;
    }

    const delivered = harness.transport.sentReports.flatMap(({ report }) =>
      report.events.map((event) => `${event.runId}:${event.cursor}`),
    );
    const expected = runs.flatMap((run) =>
      run.eventCursors.map((cursor) => `${run.runId}:${cursor}`),
    );
    expect(pageCalls.length, canonicalStringify(harness.connector.status())).toBeGreaterThan(0);
    expect(harness.remote.queryPendingCounts(harness.binding.bindingId)).toMatchObject({
      pendingReports: 0,
      claimedReports: 0,
    });
    expect(harness.connector.status().lastErrorCode).toBeNull();
    expect(delivered.sort()).toEqual(expected.sort());
    expect(new Set(delivered).size).toBe(expected.length);
    expect(pageCalls.filter(({ runId }) => runId === runs[1]?.runId)[0]?.afterCursor).toBe(0);
    expect(
      pageCalls.every(({ runId, afterCursor }) => {
        const run = requiredValue(runs.find((candidate) => candidate.runId === runId));
        return afterCursor <= requiredValue(run.eventCursors.at(-1));
      }),
    ).toBe(true);
    for (const run of runs) {
      expect(
        harness.remote.queryRunEventCheckpoint(
          harness.binding.bindingId,
          harness.binding.repositoryId,
          run.runId,
        ),
      ).toMatchObject({
        localLatestCursor: run.eventCursors.at(-1),
        durablyEnqueuedCursor: run.eventCursors.at(-1),
        centrallyAcknowledgedCursor: run.eventCursors.at(-1),
      });
    }
    await harness.close();
  });
});

describe("remote connector bounded lifecycle", () => {
  it("refuses an oversized transport batch before persisting any envelope", async () => {
    const harness = createHarness();
    const envelope = harness.envelope("command_remote-batch-limit");
    harness.transport.commandBatches.push(Array.from({ length: 9 }, () => envelope));
    expect(await harness.connector.pumpOnce()).toMatchObject({
      receivedCommands: 0,
      admittedCommands: 0,
      partitioned: true,
    });
    expect(harness.connector.status()).toMatchObject({ lastErrorCode: "batch-limit" });
    expect(harness.remote.queryPendingCounts(harness.binding.bindingId)).toMatchObject({
      waitingCommands: 0,
      readyCommands: 0,
      acceptedCommands: 0,
    });
    await harness.close();
  });

  it("shows partition health and enforces absolute deadlines", async () => {
    const harness = createHarness({
      transport: {
        negotiate: async () => helloSelection(),
        receiveCommands: () => new Promise(() => undefined),
        sendReport: () => new Promise(() => undefined),
      },
      networkDeadlineMs: 5,
    });
    expect(await harness.connector.pumpOnce()).toMatchObject({ partitioned: true });
    expect(harness.connector.status()).toMatchObject({
      health: "degraded",
      partitioned: true,
      lastErrorCode: "deadline-exceeded",
    });
    await harness.close();
  });

  it("cancels an in-flight pump and drains a background connector whose transport ignores abort", async () => {
    const harness = createHarness({
      transport: {
        negotiate: async () => helloSelection(),
        receiveCommands: () => new Promise(() => undefined),
        sendReport: () => new Promise(() => undefined),
      },
      networkDeadlineMs: 60_000,
    });
    const cancellation = new AbortController();
    const pumping = harness.connector.pumpOnce(cancellation.signal);
    cancellation.abort();
    await expect(pumping).rejects.toMatchObject({ name: "AbortError" });

    const background = createHarness({
      transport: {
        negotiate: async () => helloSelection(),
        receiveCommands: () => new Promise(() => undefined),
        sendReport: () => new Promise(() => undefined),
      },
      networkDeadlineMs: 60_000,
    });
    background.connector.start();
    await Promise.resolve();
    await background.connector.drain();
    expect(background.connector.lifecycle).toBe("drained");
    await background.connector.close();
    expect(background.connector.lifecycle).toBe("closed");
    await harness.close();
    background.remote.close();
    background.supervisor.close();
  });

  it("bounds and cancels report sends even when transport ignores abort", async () => {
    const harness = createHarness({ networkDeadlineMs: 5 });
    const envelope = harness.envelope("command_remote-report-deadline");
    harness.transport.commandBatches.push([envelope]);
    await harness.connector.pumpOnce();
    completeCommand(harness, envelope, "owner_report-deadline");
    harness.transport.hangReports = true;
    expect(await harness.connector.pumpOnce()).toMatchObject({ partitioned: true });
    expect(harness.connector.status().lastErrorCode).toBe("deadline-exceeded");
    harness.clock.value += 31_000;
    const cancellation = new AbortController();
    const pumping = harness.connector.pumpOnce(cancellation.signal);
    cancellation.abort();
    await expect(pumping).rejects.toMatchObject({ name: "AbortError" });
    await harness.close();
  });
});

interface Harness {
  readonly root: string;
  readonly databasePath: string;
  readonly clock: { value: number; now(): number };
  readonly binding: RemoteRepositoryBinding;
  readonly keys: ReturnType<typeof keyFixture>;
  readonly supervisor: SqliteSupervisorAuthority;
  readonly supervisorApi: SupervisorApi;
  readonly remote: SqliteRemoteAuthority;
  readonly connector: RemoteConnector;
  readonly transport: FixtureTransport;
  envelope(commandId: string): RemoteCommandEnvelope;
  now(): string;
  close(): Promise<void>;
}

function createHarness(
  options: {
    readonly roleMappings?: ReturnType<typeof roleMapping>[];
    readonly transport?: RemoteConnectorTransport;
    readonly networkDeadlineMs?: number;
    readonly synchronization?: RemoteConnector["policy"]["synchronization"];
    readonly batchSize?: number;
  } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "senawa-remote-connector-"));
  roots.add(root);
  const databasePath = join(root, "authority.db");
  const dependencies: RuntimeDependencies = {
    sha256: deterministicSha256,
    authorization: createRoleAuthorizationPolicy([
      { intent: "instantiate-run", roles: ["release-manager"] },
      { intent: "pause-run", roles: ["release-manager"] },
    ]),
  };
  const supervisor = new SqliteSupervisorAuthority({
    databasePath,
    assetDirectory: join(root, "assets"),
    dependencies,
  });
  const supervisorApi = new SupervisorApi(supervisor);
  initializeLocalRun(supervisorApi, supervisor, clockTime(START_TIME));
  const remote = new SqliteRemoteAuthority({ databasePath, dependencies });
  const binding = bindingFixture();
  const keys = keyFixture();
  const clock = {
    value: START_TIME,
    now() {
      return this.value;
    },
  };
  const fixtureTransport = new FixtureTransport(binding, keys, clock);
  let reportSequence = 0;
  const connector = new RemoteConnector({
    authority: remote,
    supervisorApi,
    binding,
    policy: {
      policyDigest: POLICY_DIGEST,
      roleMappings: options.roleMappings ?? [roleMapping("operator", ["release-manager"])],
      maximumRemoteAuthorizationLeaseSeconds: 900,
      synchronization: options.synchronization ?? {
        classificationCeiling: "internal",
        receiptChain: true,
        events: true,
        projections: true,
        synchronizationState: true,
      },
    },
    transport: options.transport ?? fixtureTransport,
    verifier: keys.connectorCrypto,
    signer: keys.connectorCrypto,
    clock,
    ids: {
      allocate() {
        reportSequence += 1;
        return `report_remote-${reportSequence}`;
      },
    },
    admissionAllocator: {
      allocationsFor(submission) {
        return [1, 2, 3].map((ordinal) => ({
          kind: "stream-event" as const,
          id: `stream-event-${submission.commandId}-${ordinal}`,
        }));
      },
    },
    ownerId: "owner_remote-connector",
    batchSize: options.batchSize ?? 8,
    ...(options.networkDeadlineMs === undefined
      ? {}
      : { networkDeadlineMs: options.networkDeadlineMs }),
    reportClaimMs: 30_000,
    pollIntervalMs: 60_000,
  });
  return {
    root,
    databasePath,
    clock,
    binding,
    keys,
    supervisor,
    supervisorApi,
    remote,
    connector,
    transport: fixtureTransport,
    envelope(commandId) {
      return signEnvelope(
        unsignedEnvelope(binding, remoteControlSubmission(commandId)),
        keys.centralCrypto,
      );
    },
    now() {
      return new Date(clock.value).toISOString();
    },
    async close() {
      await connector.close();
      remote.close();
      supervisor.close();
    },
  };
}

class FixtureTransport implements RemoteConnectorTransport {
  readonly commandBatches: RemoteCommandEnvelope[][] = [];
  readonly sentReports: Parameters<RemoteConnectorTransport["sendReport"]>[0][] = [];
  readonly deliveredEntries: RemoteReceiptChainEntry[] = [];
  readonly binding: RemoteRepositoryBinding;
  readonly keys: ReturnType<typeof keyFixture>;
  readonly clock: { value: number };
  revocationEpoch: number;
  failNextReport = false;
  hangReports = false;
  helloResponse: RemoteHelloResponse = helloSelection();
  negotiateCalls = 0;
  receiveCalls = 0;
  serverClockValue: number;
  deliveryLatencyMs = 0;

  constructor(
    binding: RemoteRepositoryBinding,
    keys: ReturnType<typeof keyFixture>,
    clock: { value: number },
  ) {
    this.binding = binding;
    this.keys = keys;
    this.clock = clock;
    this.serverClockValue = clock.value;
    this.revocationEpoch = binding.revocationEpoch;
  }

  async negotiate(input: Parameters<RemoteConnectorTransport["negotiate"]>[0]) {
    this.negotiateCalls += 1;
    expect(input.offer.peerId).toBe(this.binding.connectorId);
    return this.helloResponse;
  }

  async receiveCommands() {
    this.receiveCalls += 1;
    const envelopes = this.commandBatches.shift() ?? [];
    const deliveries = envelopes.map((envelope) => {
      const receiptEntry = serverDeliveryEntry(
        envelope,
        new Date(this.serverClockValue).toISOString(),
      );
      this.deliveredEntries.push(receiptEntry);
      return Object.freeze({ envelope, receiptEntry });
    });
    this.clock.value += this.deliveryLatencyMs;
    return {
      revocationEpoch: this.revocationEpoch,
      deliveries,
    };
  }

  async sendReport(input: Parameters<RemoteConnectorTransport["sendReport"]>[0]) {
    this.sentReports.push(input);
    expect(
      this.keys.repositoryVerifier.verify(
        input.signingKeyId,
        remoteClassifiedReportSignatureBytes(input.report),
        input.signature,
      ),
    ).toBe(true);
    if (this.failNextReport) {
      this.failNextReport = false;
      throw new Error("simulated partition after durable claim");
    }
    if (this.hangReports) return new Promise<never>(() => undefined);
    const acknowledgement = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      bindingId: this.binding.bindingId,
      repositoryId: this.binding.repositoryId,
      reportId: input.report.reportId,
      reportSequence: input.report.reportSequence,
      reportDigest: deterministicSha256.digest(canonicalBytes(input.report)),
      centralReceiptId: `central-${input.report.reportId}`,
      acknowledgedAt: new Date(this.serverClockValue).toISOString(),
      signingKeyId: this.binding.controlPlaneKeyId,
      signature: "A".repeat(86),
    } satisfies RemoteReportAcknowledgement;
    return {
      ...acknowledgement,
      signature: this.keys.centralCrypto.sign(
        this.binding.controlPlaneKeyId,
        remoteReportAcknowledgementSignatureBytes(acknowledgement),
      ),
    };
  }
}

function bindingFixture(): RemoteRepositoryBinding {
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: "binding_remote-connector",
    tenantId: "tenant_remote-connector",
    repositoryId: runtimeFixture.repositoryId,
    connectorId: "connector_remote-connector",
    repositoryKeyId: "key_repository-connector",
    controlPlaneKeyId: "key_control-plane",
    revocationEpoch: 2,
    policyDigest: POLICY_DIGEST,
    issuedAt: "2026-08-14T09:00:00.000Z",
  });
}

function helloSelection() {
  return Object.freeze({
    negotiationVersion: REMOTE_NEGOTIATION_VERSION,
    type: "selection" as const,
    sessionId: "session_remote-connector",
    serverPeerId: "control-plane_test",
    selectedVersion: REMOTE_PROTOCOL_VERSION,
    capabilities: REMOTE_CAPABILITIES,
  });
}

function roleMapping(upstreamRole: string, localRoles: readonly string[]) {
  return Object.freeze({
    issuer: "https://control.example.test",
    tenant: "tenant_remote-connector",
    upstreamRole,
    localRoles: Object.freeze([...localRoles]),
  });
}

function remoteControlSubmission(commandId: string): CommandSubmission {
  const envelope = runtimeCommand({
    commandId,
    intent: "pause-run",
    payload: { expectedRunModeRevision: 0 },
    expiresAt: "2026-08-14T10:10:00.000Z",
  });
  const { principal: _principal, transport: _transport, ...submission } = envelope;
  return submission;
}

function initializeLocalRun(
  api: SupervisorApi,
  supervisor: SqliteSupervisorAuthority,
  currentTime: string,
): void {
  const local = runtimeCommand({
    commandId: "command_local-bootstrap",
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
    requestId: "request_local-bootstrap",
    admission: {
      currentTime,
      facts: { source: "local-bootstrap" },
      allocator: {
        allocationsFor() {
          return [1, 2, 3].map((ordinal) => ({
            kind: "stream-event" as const,
            id: `stream-event-local-bootstrap-${ordinal}`,
          }));
        },
      },
    },
  });
  const lease = supervisor.acquireRunLease(
    runtimeFixture.repositoryId,
    runtimeFixture.runId,
    "owner_local-bootstrap",
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

function completeCommand(harness: Harness, envelope: RemoteCommandEnvelope, ownerId: string): void {
  const command = envelope.acceptedCommand.command;
  const lease = harness.supervisor.acquireRunLease(
    command.repositoryId,
    command.runId,
    ownerId,
    harness.now(),
    new Date(harness.clock.value + 60_000).toISOString(),
  );
  harness.supervisor.drainRunOnce({
    repositoryId: command.repositoryId,
    runId: command.runId,
    lease,
    currentTime: harness.now(),
  });
}

function seedCompletedRemoteRuns(
  harness: Harness,
  inputs: readonly { readonly runId: string; readonly eventCursors: readonly number[] }[],
): readonly {
  readonly runId: string;
  readonly commandId: string;
  readonly eventCursors: readonly number[];
}[] {
  const database = new Database(harness.databasePath);
  const seeded: {
    readonly runId: string;
    readonly commandId: string;
    readonly eventCursors: readonly number[];
  }[] = [];
  let previousEnvelopeDigest: string | null = null;
  let previousReportDigest: string | null = null;
  for (const [index, input] of inputs.entries()) {
    const base = harness.envelope(`command_remote-multi-${index + 1}`);
    const command = { ...base.acceptedCommand.command, runId: input.runId };
    const acceptedCommand = {
      ...base.acceptedCommand,
      command,
      commandDigest: deterministicSha256.digest(canonicalBytes(command)),
    };
    const unsigned = {
      ...base,
      sequence: index + 1,
      previousEnvelopeDigest,
      acceptedCommand,
      acceptedCommandDigest: deterministicSha256.digest(canonicalBytes(acceptedCommand)),
    };
    const envelope = resignEnvelope(unsigned, harness.keys.centralCrypto);
    previousEnvelopeDigest = deterministicSha256.digest(canonicalBytes(envelope));
    const runKey = canonicalStringify([harness.binding.repositoryId, input.runId]);
    const latestCursor = requiredValue(input.eventCursors.at(-1));
    database
      .prepare(
        `INSERT INTO runs(
           run_key, repository_id, run_id, cursor, records_json,
           projection_generated_at, revision_digest
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(runKey, harness.binding.repositoryId, input.runId, latestCursor);
    database
      .prepare(
        `INSERT INTO commands(
           command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
         ) VALUES (?, ?, ?, '{}', '{}')`,
      )
      .run(command.commandId, runKey, canonicalStringify(command));
    for (const cursor of input.eventCursors) {
      const payload = { cursor, runId: input.runId };
      const frame = {
        apiVersion: PROTOCOL_VERSION,
        cursor,
        repositoryId: harness.binding.repositoryId,
        runId: input.runId,
        eventId: `event_multi-${index + 1}-${cursor}`,
        eventType: "run-synchronization-test",
        occurredAt: harness.now(),
        payload,
        payloadDigest: deterministicSha256.digest(canonicalBytes(payload)),
        commandId: command.commandId,
      };
      database
        .prepare(
          `INSERT INTO event_frames(
             event_id, run_key, cursor, command_id, event_type, canonical_frame
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          frame.eventId,
          runKey,
          cursor,
          command.commandId,
          frame.eventType,
          canonicalStringify(frame),
        );
    }
    harness.remote.admitCommandEnvelope(
      envelope,
      serverDeliveryEntry(envelope, harness.now()),
      harness.now(),
    );
    harness.remote.recordLocalAcceptance(
      harness.binding.bindingId,
      envelope.sequence,
      seededReceiptChain(envelope, harness.now()).entries[2] as RemoteReceiptChainEntry,
    );
    const chain = seededReceiptChain(envelope, harness.now());
    const result = chain.entries[4] as RemoteReceiptChainEntry;
    const report: RemoteClassifiedReport = Object.freeze({
      apiVersion: REMOTE_PROTOCOL_VERSION,
      reportId: `report_remote-seed-${index + 1}`,
      binding: harness.binding,
      classification: "internal",
      dataPolicyDigest: POLICY_DIGEST,
      reportSequence: index + 1,
      previousReportDigest,
      createdAt: harness.now(),
      receiptChains: [chain],
      events: [],
      projections: [],
      synchronization: {
        repositoryId: harness.binding.repositoryId,
        localLatestCursor: 0,
        durablyEnqueuedCursor: 0,
        centrallyAcknowledgedCursor: 0,
        localObservedAt: harness.binding.issuedAt,
        lastEnqueuedAt: null,
        lastAcknowledgedAt: null,
      },
    });
    harness.remote.recordLocalResultAndEnqueueReport(
      harness.binding.bindingId,
      envelope.sequence,
      result,
      report,
    );
    const claim = requiredValue(
      harness.remote.claimReport(
        harness.binding.bindingId,
        `owner_seed-${index + 1}`,
        harness.now(),
        new Date(Date.parse(harness.now()) + 60_000).toISOString(),
      ),
    );
    harness.remote.acknowledgeReport(
      claim,
      {
        apiVersion: REMOTE_PROTOCOL_VERSION,
        bindingId: harness.binding.bindingId,
        repositoryId: harness.binding.repositoryId,
        reportId: report.reportId,
        reportSequence: report.reportSequence,
        reportDigest: deterministicSha256.digest(canonicalBytes(report)),
        centralReceiptId: `receipt_${report.reportId}`,
        acknowledgedAt: harness.now(),
        signingKeyId: harness.binding.controlPlaneKeyId,
        signature: "A".repeat(86),
      },
      harness.now(),
    );
    previousReportDigest = deterministicSha256.digest(canonicalBytes(report));
    seeded.push({
      runId: input.runId,
      commandId: command.commandId,
      eventCursors: input.eventCursors,
    });
  }
  database.close();
  return Object.freeze(seeded);
}

function seededReceiptChain(envelope: RemoteCommandEnvelope, recordedAt: string) {
  const entries: RemoteReceiptChainEntry[] = [];
  const append = (
    stage: RemoteReceiptChainEntry["stage"],
    evidence: RemoteReceiptChainEntry["evidence"],
  ) => {
    const content = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      bindingId: envelope.acceptedCommand.binding.bindingId,
      commandId: envelope.acceptedCommand.command.commandId,
      stage,
      stageSequence: entries.length + 1,
      recordedAt,
      previousEntryDigest: entries.at(-1)?.entryDigest ?? null,
      evidence,
    };
    entries.push(
      Object.freeze({
        ...content,
        entryDigest: deterministicSha256.digest(
          joinedBytes(REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN, canonicalBytes(content)),
        ),
      }),
    );
  };
  append("central-accepted", {
    type: "central-acceptance",
    acceptanceId: envelope.acceptedCommand.acceptanceId,
    acceptanceDigest: envelope.acceptedCommandDigest,
  });
  append("connector-delivered", {
    type: "connector-delivery",
    envelopeSequence: envelope.sequence,
    envelopeDigest: deterministicSha256.digest(canonicalBytes(envelope)),
  });
  append("local-accepted", {
    type: "local-receipt",
    localCommandId: envelope.acceptedCommand.command.commandId,
    receiptStatus: "queued",
    receiptCursor: 10,
    receiptDigest: "3".repeat(64),
  });
  append("runner-claimed", {
    type: "local-receipt",
    localCommandId: envelope.acceptedCommand.command.commandId,
    receiptStatus: "claimed",
    receiptCursor: 11,
    receiptDigest: "4".repeat(64),
  });
  append("local-outcome", {
    type: "local-outcome",
    localCommandId: envelope.acceptedCommand.command.commandId,
    receiptStatus: "completed",
    receiptCursor: 12,
    receiptDigest: "5".repeat(64),
  });
  return Object.freeze({
    bindingId: envelope.acceptedCommand.binding.bindingId,
    commandId: envelope.acceptedCommand.command.commandId,
    entries: Object.freeze(entries),
  });
}

function clockTime(value: number): string {
  return new Date(value).toISOString();
}

function serverDeliveryEntry(
  envelope: RemoteCommandEnvelope,
  recordedAt: string,
): RemoteReceiptChainEntry {
  const centralContent = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: envelope.acceptedCommand.binding.bindingId,
    commandId: envelope.acceptedCommand.command.commandId,
    stage: "central-accepted" as const,
    stageSequence: 1,
    recordedAt: envelope.acceptedCommand.acceptedAt,
    previousEntryDigest: null,
    evidence: {
      type: "central-acceptance" as const,
      acceptanceId: envelope.acceptedCommand.acceptanceId,
      acceptanceDigest: envelope.acceptedCommandDigest,
    },
  };
  const previousEntryDigest = deterministicSha256.digest(
    joinedBytes(REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN, canonicalBytes(centralContent)),
  );
  const content = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: envelope.acceptedCommand.binding.bindingId,
    commandId: envelope.acceptedCommand.command.commandId,
    stage: "connector-delivered" as const,
    stageSequence: 2,
    recordedAt,
    previousEntryDigest,
    evidence: {
      type: "connector-delivery" as const,
      envelopeSequence: envelope.sequence,
      envelopeDigest: deterministicSha256.digest(canonicalBytes(envelope)),
    },
  };
  return Object.freeze({
    ...content,
    entryDigest: deterministicSha256.digest(
      joinedBytes(REMOTE_RECEIPT_ENTRY_DIGEST_DOMAIN, canonicalBytes(content)),
    ),
  });
}

function unsignedEnvelope(
  binding: RemoteRepositoryBinding,
  command: CommandSubmission,
): RemoteCommandEnvelope {
  const acceptedCommand = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    acceptanceId: `acceptance_${command.commandId}`,
    binding,
    attribution: {
      principal: {
        issuer: "https://control.example.test",
        subject: "operator@example.test",
        tenant: binding.tenantId,
        assurance: "multi-factor" as const,
        roles: ["operator"],
      },
      transport: { kind: "remote" as const, requestId: `request_${command.commandId}` },
    },
    command,
    commandDigest: deterministicSha256.digest(canonicalBytes(command)),
    acceptedAt: "2026-08-14T10:00:00.000Z",
    expiresAt: requiredValue(command.expiresAt),
  };
  return {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    sequence: 1,
    previousEnvelopeDigest: null,
    acceptedCommand,
    acceptedCommandDigest: deterministicSha256.digest(canonicalBytes(acceptedCommand)),
    issuedAt: "2026-08-14T10:00:30.000Z",
    signingKeyId: binding.controlPlaneKeyId,
    signature: "A".repeat(86),
  };
}

function signEnvelope(
  envelope: RemoteCommandEnvelope,
  centralCrypto: NodeEd25519RemoteCrypto,
): RemoteCommandEnvelope {
  return resignEnvelope(envelope, centralCrypto);
}

function resignEnvelope(
  envelope: RemoteCommandEnvelope,
  centralCrypto: NodeEd25519RemoteCrypto,
): RemoteCommandEnvelope {
  return {
    ...envelope,
    signature: centralCrypto.sign(
      envelope.signingKeyId,
      remoteCommandEnvelopeSignatureBytes(envelope),
    ),
  };
}

function replaceBinding(
  envelope: RemoteCommandEnvelope,
  binding: RemoteRepositoryBinding,
): RemoteCommandEnvelope {
  const acceptedCommand = {
    ...envelope.acceptedCommand,
    binding,
    attribution: {
      ...envelope.acceptedCommand.attribution,
      principal: { ...envelope.acceptedCommand.attribution.principal, tenant: binding.tenantId },
    },
  };
  return {
    ...envelope,
    acceptedCommand,
    acceptedCommandDigest: deterministicSha256.digest(canonicalBytes(acceptedCommand)),
    signingKeyId: binding.controlPlaneKeyId,
  };
}

function replaceExpiry(envelope: RemoteCommandEnvelope, expiresAt: string): RemoteCommandEnvelope {
  const command = { ...envelope.acceptedCommand.command, expiresAt };
  const acceptedCommand = {
    ...envelope.acceptedCommand,
    command,
    commandDigest: deterministicSha256.digest(canonicalBytes(command)),
    expiresAt,
  };
  return {
    ...envelope,
    acceptedCommand,
    acceptedCommandDigest: deterministicSha256.digest(canonicalBytes(acceptedCommand)),
  };
}

function keyFixture() {
  const central = generateKeyPairSync("ed25519");
  const repository = generateKeyPairSync("ed25519");
  return {
    centralCrypto: new NodeEd25519RemoteCrypto({
      privateKeys: new Map([["key_control-plane", central.privateKey]]),
    }),
    connectorCrypto: new NodeEd25519RemoteCrypto({
      publicKeys: new Map([["key_control-plane", central.publicKey]]),
      privateKeys: new Map([["key_repository-connector", repository.privateKey]]),
    }),
    repositoryVerifier: new NodeEd25519RemoteCrypto({
      publicKeys: new Map([["key_repository-connector", repository.publicKey]]),
    }),
  };
}

function withoutSignature(envelope: RemoteCommandEnvelope) {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function joinedBytes(prefix: string, content: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(prefix);
  const result = new Uint8Array(domain.length + content.length);
  result.set(domain);
  result.set(content, domain.length);
  return result;
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value is missing");
  return value;
}
