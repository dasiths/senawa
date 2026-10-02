import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalBytes,
  canonicalStringify,
  decodeCommandEnvelope,
  encodeRemoteCommandEnvelope,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteClassifiedReport,
  type RemoteCommandEnvelope,
  type RemoteReceiptChainEntry,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import {
  createAdmissionFixture,
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
} from "@senawa/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteDeliveryConflictError,
  type RemoteRunEventAdvance,
  RemoteSequenceWindowError,
  restoreSqliteAuthority,
  SqliteAuthority,
  SqliteRemoteAuthority,
  StaleRemoteReportClaimError,
} from "../src/index.js";

const SIGNATURE = "A".repeat(86);
const binding: RemoteRepositoryBinding = Object.freeze({
  apiVersion: REMOTE_PROTOCOL_VERSION,
  bindingId: "binding_remote-storage",
  tenantId: "tenant_remote-storage",
  repositoryId: "repository_remote-storage",
  connectorId: "connector_remote-storage",
  repositoryKeyId: "key_repository-remote-storage",
  controlPlaneKeyId: "key_control-remote-storage",
  revocationEpoch: 2,
  policyDigest: "a".repeat(64),
  issuedAt: "2026-08-14T09:00:00.000Z",
});
const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
  ]),
};
const sandboxes = new Set<string>();

afterEach(() => {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true });
  sandboxes.clear();
});

describe("SQLite remote delivery authority", () => {
  it("persists exact reordered envelopes before processing and converges after reopen", () => {
    const sandbox = createSandbox();
    let authority = new SqliteRemoteAuthority(sandbox.remoteOptions);
    authority.registerPeer(binding, "2026-08-14T09:01:00.000Z", "session_remote-storage");
    const first = commandEnvelope(1, null, "alpha", "2026-08-14T11:00:00.000Z");
    for (const field of [
      "privateKey",
      "endpoint",
      "credentials",
      "sourcePath",
      "lease",
      "prompt",
      "contextBytes",
      "assetContent",
      "sdkSessionId",
      "token",
    ]) {
      expect(() =>
        authority.admitCommandEnvelope(
          commandEnvelopeWithPayload(first, {
            expectedRunModeRevision: 1,
            [field]: "must-remain-local",
          }),
          deliveryEntry(first),
          "2026-08-14T10:01:00.000Z",
        ),
      ).toThrow(/forbidden local-only field/);
    }
    expect(authority.queryPendingCounts(binding.bindingId).readyCommands).toBe(0);
    const firstDigest = digest(first);
    const second = commandEnvelope(2, firstDigest, "beta", "2026-08-14T11:00:00.000Z");

    const waiting = authority.admitCommandEnvelope(
      encodeRemoteCommandEnvelope(second),
      deliveryEntry(second),
      "2026-08-14T10:02:00.000Z",
    );
    expect(waiting.record.processingState).toBe("waiting");
    expect(
      authority.admitCommandEnvelope(second, deliveryEntry(second), "2026-08-14T10:02:00.000Z"),
    ).toMatchObject({
      type: "duplicate",
      record: { canonicalEnvelope: encodeRemoteCommandEnvelope(second) },
    });
    expect(() =>
      authority.admitCommandEnvelope(
        { ...second, signature: `${"B".repeat(85)}Q` },
        deliveryEntry(second),
        "2026-08-14T10:02:00.000Z",
      ),
    ).toThrow(RemoteDeliveryConflictError);
    expect(() =>
      authority.admitCommandEnvelope(
        commandEnvelope(66, "b".repeat(64), "outside-window", "2026-08-14T11:00:00.000Z"),
        deliveryEntry(
          commandEnvelope(66, "b".repeat(64), "outside-window", "2026-08-14T11:00:00.000Z"),
        ),
        "2026-08-14T10:02:00.000Z",
      ),
    ).toThrow(RemoteSequenceWindowError);

    expect(
      authority.admitCommandEnvelope(first, deliveryEntry(first), "2026-08-14T10:01:00.000Z").record
        .processingState,
    ).toBe("ready");
    expect(authority.listReadyCommands(binding.bindingId, "2026-08-14T10:03:00.000Z")).toHaveLength(
      2,
    );
    expect(authority.queryCheckpoint(binding.bindingId, "inbound-command")).toMatchObject({
      contiguousSequence: 2,
      lastDigest: digest(second),
    });

    const acceptance = localEntry(first, "local-accepted", "2026-08-14T10:04:00.000Z");
    const result = localEntry(first, "local-outcome", "2026-08-14T10:05:00.000Z");
    expect(authority.recordLocalAcceptance(binding.bindingId, 1, acceptance)).toBe(true);
    expect(authority.recordLocalAcceptance(binding.bindingId, 1, acceptance)).toBe(false);
    expect(authority.listPendingLocalResults(binding.bindingId)).toMatchObject([
      { sequence: 1, processingState: "local-accepted" },
    ]);
    expect(() => authority.recordLocalResult(binding.bindingId, 1, result)).toThrow(
      /must be recorded atomically with its report/,
    );

    authority.close();
    authority = new SqliteRemoteAuthority(sandbox.remoteOptions);
    expect(authority.queryPendingCounts(binding.bindingId)).toEqual({
      waitingCommands: 0,
      readyCommands: 1,
      acceptedCommands: 1,
      pendingReports: 0,
      claimedReports: 0,
    });
    const expired = commandEnvelope(3, digest(second), "expired", "2026-08-14T10:05:00.000Z");
    expect(
      authority.admitCommandEnvelope(expired, deliveryEntry(expired), "2026-08-14T10:06:00.000Z")
        .record.processingState,
    ).toBe("expired");
    authority.advanceRevocationEpoch(binding.bindingId, 3, "2026-08-14T10:07:00.000Z");
    const revoked = commandEnvelope(4, digest(expired), "revoked", "2026-08-14T11:00:00.000Z");
    expect(
      authority.admitCommandEnvelope(revoked, deliveryEntry(revoked), "2026-08-14T10:08:00.000Z")
        .record.processingState,
    ).toBe("revoked");
    authority.close();
  });

  it("retains an inbox envelope when acknowledgement is lost after commit", () => {
    const sandbox = createSandbox();
    const initialized = new SqliteRemoteAuthority(sandbox.remoteOptions);
    initialized.registerPeer(binding, "2026-08-14T09:01:00.000Z");
    initialized.close();
    const first = commandEnvelope(1, null, "crash", "2026-08-14T11:00:00.000Z");
    let injected = false;
    const faulted = new SqliteRemoteAuthority({
      ...sandbox.remoteOptions,
      faultInjector(point) {
        if (!injected && point === "after-remote-inbox-commit-before-return") {
          injected = true;
          throw new Error(`fault at ${point}`);
        }
      },
    });
    expect(() =>
      faulted.admitCommandEnvelope(first, deliveryEntry(first), "2026-08-14T10:01:00.000Z"),
    ).toThrow("fault at after-remote-inbox-commit-before-return");
    faulted.close();

    const reopened = new SqliteRemoteAuthority(sandbox.remoteOptions);
    expect(
      reopened.admitCommandEnvelope(first, deliveryEntry(first), "2026-08-14T10:01:00.000Z"),
    ).toMatchObject({
      type: "duplicate",
      record: { processingState: "ready" },
    });
    reopened.close();
  });

  it.each([
    {
      faultPoint: "before-remote-local-result-report-commit" as const,
      expectedState: "local-accepted",
      expectedReports: 0,
    },
    {
      faultPoint: "after-remote-local-result-report-commit-before-return" as const,
      expectedState: "local-result",
      expectedReports: 1,
    },
  ])("atomically commits terminal evidence and its exact report at $faultPoint", (testCase) => {
    const sandbox = createSandbox();
    const initialized = new SqliteRemoteAuthority(sandbox.remoteOptions);
    initialized.registerPeer(binding, "2026-08-14T09:01:00.000Z");
    const envelope = commandEnvelope(1, null, "atomic", "2026-08-14T11:00:00.000Z");
    initialized.admitCommandEnvelope(envelope, deliveryEntry(envelope), "2026-08-14T10:01:00.000Z");
    initialized.recordLocalAcceptance(
      binding.bindingId,
      1,
      localEntry(envelope, "local-accepted", "2026-08-14T10:04:00.000Z"),
    );
    initialized.close();
    const result = localEntry(envelope, "local-outcome", "2026-08-14T10:05:00.000Z");
    const report = terminalReport(envelope, result);
    const faulted = new SqliteRemoteAuthority({
      ...sandbox.remoteOptions,
      faultInjector(point) {
        if (point === testCase.faultPoint) throw new Error(`fault at ${point}`);
      },
    });
    expect(() =>
      faulted.recordLocalResultAndEnqueueReport(binding.bindingId, 1, result, report),
    ).toThrow(`fault at ${testCase.faultPoint}`);
    faulted.close();

    const reopened = new SqliteRemoteAuthority(sandbox.remoteOptions);
    const database = new Database(sandbox.remoteOptions.databasePath, { readonly: true });
    expect(
      database
        .prepare<[], { processing_state: string; local_result_report_id: string | null }>(
          "SELECT processing_state, local_result_report_id FROM remote_command_inbox",
        )
        .get(),
    ).toEqual({
      processing_state: testCase.expectedState,
      local_result_report_id: testCase.expectedState === "local-result" ? report.reportId : null,
    });
    database.close();
    expect(reopened.queryPendingCounts(binding.bindingId).pendingReports).toBe(
      testCase.expectedReports,
    );
    expect(reopened.recordLocalResultAndEnqueueReport(binding.bindingId, 1, result, report)).toBe(
      testCase.expectedReports === 0,
    );
    const committedHistory = readRemoteHistoryCommitment(
      sandbox.remoteOptions.databasePath,
      binding.bindingId,
    );
    expect(reopened.recordLocalResultAndEnqueueReport(binding.bindingId, 1, result, report)).toBe(
      false,
    );
    const replayedDatabase = new Database(sandbox.remoteOptions.databasePath, { readonly: true });
    expect(
      replayedDatabase
        .prepare<[], { local_result_report_id: string }>(
          "SELECT local_result_report_id FROM remote_command_inbox",
        )
        .get()?.local_result_report_id,
    ).toBe(report.reportId);
    replayedDatabase.close();
    expect(() =>
      reopened.recordLocalResultAndEnqueueReport(
        binding.bindingId,
        1,
        { ...result, recordedAt: "2026-08-14T10:05:01.000Z" },
        report,
      ),
    ).toThrow(RemoteDeliveryConflictError);
    expect(() =>
      reopened.recordLocalResultAndEnqueueReport(binding.bindingId, 1, result, {
        ...report,
        classification: "public",
      }),
    ).toThrow(RemoteDeliveryConflictError);
    expect(() =>
      reopened.recordLocalResultAndEnqueueReport(binding.bindingId, 1, result, report, {
        repositoryId: binding.repositoryId,
        runId: "run_remote-nonexistent",
        fromCursor: 0,
        throughCursor: 0,
        localLatestCursor: 0,
      }),
    ).toThrow(RemoteDeliveryConflictError);
    expect(
      readRemoteHistoryCommitment(sandbox.remoteOptions.databasePath, binding.bindingId),
    ).toEqual(committedHistory);
    const claim = reopened.claimReport(
      binding.bindingId,
      "owner_atomic",
      "2026-08-14T10:06:00.000Z",
      "2026-08-14T10:07:00.000Z",
    );
    expect(
      reopened.readClaimedReport(requireClaim(claim), "2026-08-14T10:06:00.000Z").report,
    ).toEqual(report);
    reopened.close();
  });

  it("rejects substituting another valid same-binding committed report on terminal replay", () => {
    const sandbox = createSandbox();
    const fixture = seedTwoTerminalResultReports(sandbox);
    const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
    const committedHistory = readRemoteHistoryCommitment(
      sandbox.remoteOptions.databasePath,
      binding.bindingId,
    );

    expect(
      remote.recordLocalResultAndEnqueueReport(
        binding.bindingId,
        1,
        fixture.first.result,
        fixture.first.report,
      ),
    ).toBe(false);
    expect(() =>
      remote.recordLocalResultAndEnqueueReport(
        binding.bindingId,
        1,
        fixture.first.result,
        fixture.second.report,
      ),
    ).toThrow(RemoteDeliveryConflictError);
    expect(
      readRemoteHistoryCommitment(sandbox.remoteOptions.databasePath, binding.bindingId),
    ).toEqual(committedHistory);
    remote.close();
  });

  it("rejects same-binding inbox result report reassignment during startup, backup, and restore", async () => {
    const sandbox = createSandbox();
    const fixture = seedTwoTerminalResultReports(sandbox);
    await expectCorruptionRejectedAcrossIntegritySurfaces(
      sandbox,
      "inbox-result-report-reassignment",
      (database) => {
        database
          .prepare(
            `UPDATE remote_command_inbox SET local_result_report_id = ?
             WHERE binding_id = ? AND sequence = 1`,
          )
          .run(fixture.second.report.reportId, binding.bindingId);
      },
    );
  });

  it("backs up and restores the exact inbox result report binding", async () => {
    const sandbox = createSandbox();
    const fixture = seedTwoTerminalResultReports(sandbox);
    const authority = new SqliteAuthority(sandbox.authorityOptions);
    const backupPath = join(sandbox.root, "terminal-binding-backup");
    await authority.backup(backupPath);
    authority.close();

    const restoredDatabasePath = join(sandbox.root, "terminal-binding-restored.db");
    const restored = restoreSqliteAuthority({
      ...sandbox.authorityOptions,
      databasePath: restoredDatabasePath,
      assetDirectory: join(sandbox.root, "terminal-binding-restored-assets"),
      backupPath,
    });
    restored.close();
    const restoredDatabase = new Database(restoredDatabasePath, { readonly: true });
    expect(
      restoredDatabase
        .prepare<[], { sequence: number; local_result_report_id: string }>(
          `SELECT sequence, local_result_report_id FROM remote_command_inbox
           ORDER BY sequence`,
        )
        .all(),
    ).toEqual([
      { sequence: 1, local_result_report_id: fixture.first.report.reportId },
      { sequence: 2, local_result_report_id: fixture.second.report.reportId },
    ]);
    restoredDatabase.close();
    const restoredRemote = new SqliteRemoteAuthority({
      ...sandbox.remoteOptions,
      databasePath: restoredDatabasePath,
    });
    expect(
      restoredRemote.recordLocalResultAndEnqueueReport(
        binding.bindingId,
        1,
        fixture.first.result,
        fixture.first.report,
      ),
    ).toBe(false);
    restoredRemote.close();
  });

  it("requires enqueueReport duplicate replay to match the exact durable run advances", () => {
    const sandbox = createSandbox();
    const fixture = seedGenuineSparseIntegrityFixture(sandbox);
    const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
    const report = zeroCursorReport(fixture.binding, fixture.reportId, "2026-08-14T10:03:00.000Z");
    const exactAdvance: RemoteRunEventAdvance = {
      repositoryId: fixture.binding.repositoryId,
      runId: fixture.runId,
      fromCursor: 0,
      throughCursor: 0,
      localLatestCursor: 0,
    };
    const committedHistory = readRemoteHistoryCommitment(
      sandbox.remoteOptions.databasePath,
      fixture.binding.bindingId,
    );
    expect(remote.enqueueReport(report, exactAdvance)).toBe(false);
    const changedReplays: readonly [
      string,
      RemoteClassifiedReport,
      RemoteRunEventAdvance | undefined,
    ][] = [
      ["missing", report, undefined],
      ["different cursor", report, { ...exactAdvance, throughCursor: 1, localLatestCursor: 1 }],
      ["nonexistent run", report, { ...exactAdvance, runId: "run_remote-nonexistent" }],
      [
        "cross-binding run",
        report,
        {
          ...exactAdvance,
          repositoryId: fixture.otherRepositoryId,
          runId: fixture.otherRunId,
        },
      ],
      ["nonexistent report", { ...report, reportId: "report_remote-nonexistent" }, exactAdvance],
      ["cross-binding report", { ...report, reportId: fixture.otherReportId }, exactAdvance],
    ];
    for (const [, changedReport, changedAdvance] of changedReplays) {
      expect(() => remote.enqueueReport(changedReport, changedAdvance)).toThrow(
        RemoteDeliveryConflictError,
      );
    }
    expect(() =>
      remote.enqueueReport(
        zeroCursorReport(
          {
            ...fixture.binding,
            bindingId: "binding_remote-sparse-other",
            repositoryId: fixture.otherRepositoryId,
          },
          fixture.otherReportId,
          "2026-08-14T10:04:00.000Z",
        ),
        exactAdvance,
      ),
    ).toThrow(RemoteDeliveryConflictError);
    expect(
      readRemoteHistoryCommitment(sandbox.remoteOptions.databasePath, fixture.binding.bindingId),
    ).toEqual(committedHistory);
    remote.close();
  });

  it("fences report claims, records exact acknowledgement, and advances synchronization", () => {
    const sandbox = createSandbox();
    const authority = new SqliteRemoteAuthority(sandbox.remoteOptions);
    authority.registerPeer(binding, "2026-08-14T09:01:00.000Z");
    authority.observeLocalCursor(binding.bindingId, 5, "2026-08-14T10:00:00.000Z");
    const report = classifiedReport();
    expect(authority.enqueueReport(report)).toBe(true);
    const committedReportHistory = readRemoteHistoryCommitment(
      sandbox.remoteOptions.databasePath,
      binding.bindingId,
    );
    expect(authority.enqueueReport(report)).toBe(false);
    expect(
      readRemoteHistoryCommitment(sandbox.remoteOptions.databasePath, binding.bindingId),
    ).toEqual(committedReportHistory);
    expect(authority.queryPendingCounts(binding.bindingId).pendingReports).toBe(1);
    const contender = new SqliteRemoteAuthority(sandbox.remoteOptions);

    const firstClaim = authority.claimReport(
      binding.bindingId,
      "connector_owner-a",
      "2026-08-14T10:07:00.000Z",
      "2026-08-14T10:10:00.000Z",
    );
    expect(firstClaim).toBeDefined();
    const initialClaim = requireClaim(firstClaim);
    expect(
      authority.claimReport(
        binding.bindingId,
        "connector_owner-a",
        "2026-08-14T10:08:00.000Z",
        "2026-08-14T10:12:00.000Z",
      ),
    ).toEqual(firstClaim);
    expect(
      contender.claimReport(
        binding.bindingId,
        "connector_owner-b",
        "2026-08-14T10:08:00.000Z",
        "2026-08-14T10:12:00.000Z",
      ),
    ).toBeUndefined();
    const takeover = contender.claimReport(
      binding.bindingId,
      "connector_owner-b",
      "2026-08-14T10:10:00.000Z",
      "2026-08-14T10:20:00.000Z",
    );
    expect(takeover).toMatchObject({ fence: 2, ownerId: "connector_owner-b" });
    const takeoverClaim = requireClaim(takeover);
    expect(() => authority.readClaimedReport(initialClaim, "2026-08-14T10:10:00.000Z")).toThrow(
      StaleRemoteReportClaimError,
    );
    const claimed = authority.readClaimedReport(takeoverClaim, "2026-08-14T10:11:00.000Z");
    expect(claimed.report).toEqual(report);
    expect(claimed.canonicalReport).toBe(canonicalStringify(report));

    const acknowledgement = {
      apiVersion: REMOTE_PROTOCOL_VERSION,
      bindingId: binding.bindingId,
      repositoryId: binding.repositoryId,
      reportId: report.reportId,
      reportSequence: report.reportSequence,
      reportDigest: takeoverClaim.reportDigest,
      centralReceiptId: "receipt_remote-storage",
      acknowledgedAt: "2026-08-14T10:11:00.000Z",
      signingKeyId: binding.controlPlaneKeyId,
      signature: SIGNATURE,
    } as const;
    for (const mismatch of [
      { ...acknowledgement, bindingId: "binding_other" },
      { ...acknowledgement, repositoryId: "repository_other" },
      { ...acknowledgement, reportId: "report_other" },
      { ...acknowledgement, reportSequence: 2 },
      { ...acknowledgement, reportDigest: "f".repeat(64) },
      { ...acknowledgement, signingKeyId: "key_other" },
    ]) {
      expect(() =>
        authority.acknowledgeReport(takeoverClaim, mismatch, "2026-08-14T10:11:00.000Z"),
      ).toThrow(RemoteDeliveryConflictError);
    }
    expect(
      authority.acknowledgeReport(takeoverClaim, acknowledgement, "2026-08-14T10:11:00.000Z"),
    ).toBe(true);
    const committedHistory = readRemoteHistoryCommitment(
      sandbox.remoteOptions.databasePath,
      binding.bindingId,
    );
    expect(committedHistory).toMatchObject({
      outbound_report_sequence: 1,
      outbound_report_digest: takeoverClaim.reportDigest,
      acknowledged_report_sequence: 1,
      acknowledged_report_digest: takeoverClaim.reportDigest,
      acknowledged_cursor: 5,
    });
    expect(
      authority.acknowledgeReport(takeoverClaim, acknowledgement, "2026-08-14T10:12:00.000Z"),
    ).toBe(false);
    expect(
      readRemoteHistoryCommitment(sandbox.remoteOptions.databasePath, binding.bindingId),
    ).toEqual(committedHistory);
    expect(() =>
      authority.acknowledgeReport(initialClaim, acknowledgement, "2026-08-14T10:12:00.000Z"),
    ).toThrow(StaleRemoteReportClaimError);
    expect(authority.querySynchronization(binding.bindingId)).toEqual({
      repositoryId: binding.repositoryId,
      localLatestCursor: 5,
      durablyEnqueuedCursor: 5,
      centrallyAcknowledgedCursor: 5,
      localObservedAt: "2026-08-14T10:11:00.000Z",
      lastEnqueuedAt: "2026-08-14T10:06:00.000Z",
      lastAcknowledgedAt: "2026-08-14T10:11:00.000Z",
    });
    expect(authority.queryPendingCounts(binding.bindingId)).toMatchObject({
      pendingReports: 0,
      claimedReports: 0,
    });
    contender.close();
    authority.close();
  });

  it.each([
    {
      name: "the checkpoint and all advances",
      corrupt(database: Database.Database) {
        database.exec(
          "DELETE FROM remote_report_run_event_advances; DELETE FROM remote_run_event_checkpoints",
        );
      },
    },
    {
      name: "one run advance from a multi-run report",
      corrupt(database: Database.Database) {
        database
          .prepare("DELETE FROM remote_report_run_event_advances WHERE run_id = ?")
          .run("run_remote-events-b");
      },
    },
  ])("rejects event evidence corruption after deleting $name", ({ corrupt }) => {
    const sandbox = createSandbox();
    seedEventReport(sandbox, ["run_remote-events-a", "run_remote-events-b"]);
    const database = new Database(sandbox.remoteOptions.databasePath);
    corrupt(database);
    database.close();

    expect(() => new SqliteRemoteAuthority(sandbox.remoteOptions)).toThrow(
      /remote report run event advance evidence is incomplete/,
    );
  });

  it.each([
    ["binding", "UPDATE remote_report_run_event_advances SET binding_id = 'binding_remote-wrong'"],
    ["run", "UPDATE remote_report_run_event_advances SET run_id = 'run_remote-wrong'"],
  ])("rejects a wrong report advance %s association", (_name, mutation) => {
    const sandbox = createSandbox();
    seedEventReport(sandbox, ["run_remote-events-a"]);
    const database = new Database(sandbox.remoteOptions.databasePath);
    expect(() => database.exec(mutation)).toThrow(/FOREIGN KEY constraint failed/);
    database.pragma("foreign_keys = OFF");
    database.exec(mutation);
    database.close();

    expect(() => new SqliteRemoteAuthority(sandbox.remoteOptions)).toThrow(
      /remote report run event advance is not binding-owned/,
    );
  });

  it("rejects a report advance associated with the wrong durable report", () => {
    const sandbox = createSandbox();
    const first = seedEventReport(sandbox, ["run_remote-events-a"]);
    const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
    const synchronization = remote.querySynchronization(binding.bindingId);
    remote.enqueueReport({
      ...classifiedReport(),
      reportId: "report_remote-no-events",
      reportSequence: 2,
      previousReportDigest: digest(first),
      createdAt: "2026-08-14T10:07:00.000Z",
      synchronization: {
        ...synchronization,
        localObservedAt: "2026-08-14T10:07:00.000Z",
        lastEnqueuedAt: "2026-08-14T10:07:00.000Z",
      },
    });
    remote.close();
    const database = new Database(sandbox.remoteOptions.databasePath);
    database
      .prepare("UPDATE remote_report_run_event_advances SET report_id = ?")
      .run("report_remote-no-events");
    database.close();

    expect(() => new SqliteRemoteAuthority(sandbox.remoteOptions)).toThrow(
      /remote report run event advance is not exact/,
    );
  });

  it("rejects an altered report advance cursor", () => {
    const sandbox = createSandbox();
    seedEventReport(sandbox, ["run_remote-events-a"]);
    const database = new Database(sandbox.remoteOptions.databasePath);
    database.prepare("UPDATE remote_report_run_event_advances SET through_cursor = 1").run();
    database.close();

    expect(() => new SqliteRemoteAuthority(sandbox.remoteOptions)).toThrow(
      /remote report run event advance is not exact/,
    );
  });

  it("distinguishes deleted sparse event evidence from an ordinary no-event report", () => {
    const sparseSandbox = createSandbox();
    seedSparseEventReport(sparseSandbox);
    deleteEventEvidence(sparseSandbox.remoteOptions.databasePath);
    expect(() => new SqliteRemoteAuthority(sparseSandbox.remoteOptions)).toThrow(
      /remote report run event advance evidence is incomplete/,
    );

    const ordinarySandbox = createSandbox();
    const remote = new SqliteRemoteAuthority(ordinarySandbox.remoteOptions);
    remote.registerPeer(binding, "2026-08-14T09:01:00.000Z");
    remote.observeLocalCursor(binding.bindingId, 5, "2026-08-14T10:00:00.000Z");
    remote.enqueueReport(classifiedReport());
    remote.close();
    const reopened = new SqliteRemoteAuthority(ordinarySandbox.remoteOptions);
    expect(reopened.querySynchronization(binding.bindingId).durablyEnqueuedCursor).toBe(5);
    reopened.close();
  });

  it.each([
    {
      name: "peer deletion with normalized cascades",
      corrupt(database: Database.Database) {
        database
          .prepare("DELETE FROM remote_peer_state WHERE binding_id = ?")
          .run(binding.bindingId);
      },
    },
    {
      name: "report-chain deletion with zeroed checkpoints and synchronization",
      corrupt(database: Database.Database) {
        database.exec(`
          DELETE FROM remote_report_outbox;
          DELETE FROM remote_run_event_checkpoints;
          UPDATE remote_stream_checkpoints
          SET contiguous_sequence = 0, last_digest = NULL
          WHERE stream_kind IN ('outbound-report', 'outbound-acknowledgement');
          UPDATE remote_synchronization_vectors
          SET local_latest_cursor = 0, durably_enqueued_cursor = 0,
              centrally_acknowledged_cursor = 0,
              last_enqueued_at = NULL, last_acknowledged_at = NULL;
        `);
      },
    },
    {
      name: "commitment deletion alone",
      corrupt(database: Database.Database) {
        database
          .prepare("DELETE FROM remote_history_commitments WHERE binding_id = ?")
          .run(binding.bindingId);
      },
    },
    {
      name: "missing report below retained high-water state",
      corrupt(database: Database.Database) {
        database
          .prepare("DELETE FROM remote_report_outbox WHERE report_id = ?")
          .run(classifiedReport().reportId);
      },
    },
  ])("rejects $name during startup, backup, and restore", async ({ name, corrupt }) => {
    const sandbox = createSandbox();
    seedCommittedReport(sandbox);
    await expectCorruptionRejectedAcrossIntegritySurfaces(sandbox, name, corrupt);
  });

  it.each([
    {
      name: "a nonexistent run",
      corrupt(database: Database.Database, fixture: SparseIntegrityFixture) {
        database.pragma("foreign_keys = OFF");
        database
          .prepare(
            `UPDATE remote_run_event_checkpoints SET run_id = ?
             WHERE binding_id = ? AND run_id = ?`,
          )
          .run("run_remote-missing", fixture.binding.bindingId, fixture.runId);
        database
          .prepare(
            `UPDATE remote_report_run_event_advances SET run_id = ?
             WHERE report_id = ? AND run_id = ?`,
          )
          .run("run_remote-missing", fixture.reportId, fixture.runId);
      },
    },
    {
      name: "another existing run",
      corrupt(database: Database.Database, fixture: SparseIntegrityFixture) {
        database.pragma("foreign_keys = OFF");
        database
          .prepare(
            `UPDATE remote_run_event_checkpoints
             SET repository_id = ?, run_id = ?
             WHERE binding_id = ? AND run_id = ?`,
          )
          .run(
            fixture.otherRepositoryId,
            fixture.otherRunId,
            fixture.binding.bindingId,
            fixture.runId,
          );
        database
          .prepare(
            `UPDATE remote_report_run_event_advances
             SET repository_id = ?, run_id = ?
             WHERE report_id = ? AND run_id = ?`,
          )
          .run(fixture.otherRepositoryId, fixture.otherRunId, fixture.reportId, fixture.runId);
      },
    },
    {
      name: "a cross-binding report",
      corrupt(database: Database.Database, fixture: SparseIntegrityFixture) {
        database.pragma("foreign_keys = OFF");
        database
          .prepare("UPDATE remote_report_run_event_advances SET report_id = ? WHERE report_id = ?")
          .run(fixture.otherReportId, fixture.reportId);
      },
    },
  ])(
    "rejects sparse checkpoint and advance reassignment to $name during startup, backup, and restore",
    async ({ name, corrupt }) => {
      const sandbox = createSandbox();
      const fixture = seedGenuineSparseIntegrityFixture(sandbox);
      await expectCorruptionRejectedAcrossIntegritySurfaces(sandbox, name, (database) =>
        corrupt(database, fixture),
      );
    },
  );

  it("keeps an ordinary no-remote database valid through startup, backup, and restore", async () => {
    const sandbox = createSandbox();
    const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
    remote.close();
    const authority = new SqliteAuthority(sandbox.authorityOptions);
    const backupPath = join(sandbox.root, "no-remote-backup");
    await authority.backup(backupPath);
    authority.close();
    const restoredDatabasePath = join(sandbox.root, "no-remote-restored.db");
    const restored = restoreSqliteAuthority({
      ...sandbox.authorityOptions,
      databasePath: restoredDatabasePath,
      assetDirectory: join(sandbox.root, "no-remote-restored-assets"),
      backupPath,
    });
    restored.close();
    const restoredRemote = new SqliteRemoteAuthority({
      ...sandbox.remoteOptions,
      databasePath: restoredDatabasePath,
    });
    restoredRemote.close();
  });

  it("backs up and restores exact remote state and rejects semantic corruption", async () => {
    const sandbox = createSandbox();
    const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
    remote.registerPeer(binding, "2026-08-14T09:01:00.000Z");
    const acceptedInbox = commandEnvelope(1, null, "backup-accepted", "2026-08-14T11:00:00.000Z");
    remote.admitCommandEnvelope(
      acceptedInbox,
      deliveryEntry(acceptedInbox),
      "2026-08-14T10:01:00.000Z",
    );
    remote.recordLocalAcceptance(
      binding.bindingId,
      1,
      localEntry(acceptedInbox, "local-accepted", "2026-08-14T10:02:00.000Z"),
    );
    const readyInbox = commandEnvelope(
      2,
      digest(acceptedInbox),
      "backup-ready",
      "2026-08-14T11:00:00.000Z",
    );
    remote.admitCommandEnvelope(readyInbox, deliveryEntry(readyInbox), "2026-08-14T10:03:00.000Z");
    remote.observeLocalCursor(binding.bindingId, 5, "2026-08-14T10:00:00.000Z");
    remote.enqueueReport(classifiedReport());
    remote.close();

    const authority = new SqliteAuthority(sandbox.authorityOptions);
    const backupPath = join(sandbox.root, "remote-backup");
    await authority.backup(backupPath);
    authority.close();
    const restoredDatabasePath = join(sandbox.root, "restored.db");
    const restoredAssetDirectory = join(sandbox.root, "restored-assets");
    const restored = restoreSqliteAuthority({
      ...sandbox.authorityOptions,
      databasePath: restoredDatabasePath,
      assetDirectory: restoredAssetDirectory,
      backupPath,
    });
    restored.close();
    const restoredRemote = new SqliteRemoteAuthority({
      ...sandbox.remoteOptions,
      databasePath: restoredDatabasePath,
    });
    expect(restoredRemote.querySynchronization(binding.bindingId).durablyEnqueuedCursor).toBe(5);
    expect(restoredRemote.queryPendingCounts(binding.bindingId)).toMatchObject({
      acceptedCommands: 1,
      readyCommands: 1,
      pendingReports: 1,
    });
    restoredRemote.close();

    const corruptBackup = join(sandbox.root, "corrupt-remote-backup");
    cpSync(backupPath, corruptBackup, { recursive: true });
    const database = new Database(join(corruptBackup, "authority.db"));
    database.prepare("UPDATE remote_report_outbox SET source_cursor = 4").run();
    database.close();
    expect(
      () =>
        new SqliteRemoteAuthority({
          ...sandbox.remoteOptions,
          databasePath: join(corruptBackup, "authority.db"),
        }),
    ).toThrow(/remote report row is not semantically bound/);
  });

  it("backs up and restores genuine event evidence and rejects its complete deletion", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.authorityOptions);
    const command = runtimeCommand({
      commandId: "command_remote-event-backup",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "no-approval" },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    expect(
      authority.submit(command, createAdmissionFixture().at("2026-08-14T10:00:00.000Z")).status,
    ).toBe("completed");
    const page = authority.queryEventPage(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(page.events.length).toBeGreaterThan(0);
    const eventBinding = Object.freeze({
      ...binding,
      bindingId: "binding_remote-event-backup",
      repositoryId: runtimeFixture.repositoryId,
    });
    const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
    remote.registerPeer(eventBinding, "2026-08-14T10:01:00.000Z");
    const report: RemoteClassifiedReport = Object.freeze({
      ...classifiedReport(),
      reportId: "report_remote-event-backup",
      binding: eventBinding,
      dataPolicyDigest: eventBinding.policyDigest,
      events: Object.freeze(page.events.map(eventMetadata)),
      synchronization: {
        repositoryId: eventBinding.repositoryId,
        localLatestCursor: page.latestCursor,
        durablyEnqueuedCursor: page.latestCursor,
        centrallyAcknowledgedCursor: 0,
        localObservedAt: "2026-08-14T10:02:00.000Z",
        lastEnqueuedAt: "2026-08-14T10:02:00.000Z",
        lastAcknowledgedAt: null,
      },
    });
    remote.enqueueReport(report, {
      repositoryId: eventBinding.repositoryId,
      runId: runtimeFixture.runId,
      fromCursor: 0,
      throughCursor: page.latestCursor,
      localLatestCursor: page.latestCursor,
    });
    remote.close();

    const backupPath = join(sandbox.root, "genuine-event-backup");
    await authority.backup(backupPath);
    const restoredDatabasePath = join(sandbox.root, "genuine-event-restored.db");
    const restored = restoreSqliteAuthority({
      ...sandbox.authorityOptions,
      databasePath: restoredDatabasePath,
      assetDirectory: join(sandbox.root, "genuine-event-restored-assets"),
      backupPath,
    });
    restored.close();
    const restoredRemote = new SqliteRemoteAuthority({
      ...sandbox.remoteOptions,
      databasePath: restoredDatabasePath,
    });
    expect(
      restoredRemote.queryRunEventCheckpoint(
        eventBinding.bindingId,
        eventBinding.repositoryId,
        runtimeFixture.runId,
      ),
    ).toMatchObject({
      localLatestCursor: page.latestCursor,
      durablyEnqueuedCursor: page.latestCursor,
    });
    restoredRemote.close();

    const corruptRestorePath = join(sandbox.root, "genuine-event-corrupt-restore");
    cpSync(backupPath, corruptRestorePath, { recursive: true });
    deleteEventEvidence(join(corruptRestorePath, "authority.db"));
    refreshBackupDatabaseManifest(corruptRestorePath);
    expect(() =>
      restoreSqliteAuthority({
        ...sandbox.authorityOptions,
        databasePath: join(sandbox.root, "genuine-event-corrupt-restored.db"),
        assetDirectory: join(sandbox.root, "genuine-event-corrupt-restored-assets"),
        backupPath: corruptRestorePath,
      }),
    ).toThrow(/remote report run event advance evidence is incomplete/);

    deleteEventEvidence(sandbox.remoteOptions.databasePath);
    expect(() => new SqliteRemoteAuthority(sandbox.remoteOptions)).toThrow(
      /remote report run event advance evidence is incomplete/,
    );
    await expect(
      authority.backup(join(sandbox.root, "genuine-event-corrupt-backup")),
    ).rejects.toThrow(/remote report run event advance evidence is incomplete/);
    authority.close();
  });
});

interface SparseIntegrityFixture {
  readonly binding: RemoteRepositoryBinding;
  readonly runId: string;
  readonly reportId: string;
  readonly otherRepositoryId: string;
  readonly otherRunId: string;
  readonly otherReportId: string;
}

function seedCommittedReport(sandbox: ReturnType<typeof createSandbox>): void {
  const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
  remote.registerPeer(binding, "2026-08-14T09:01:00.000Z");
  remote.observeLocalCursor(binding.bindingId, 5, "2026-08-14T10:00:00.000Z");
  remote.enqueueReport(classifiedReport());
  remote.close();
}

function seedGenuineSparseIntegrityFixture(
  sandbox: ReturnType<typeof createSandbox>,
): SparseIntegrityFixture {
  const authority = new SqliteAuthority(sandbox.authorityOptions);
  const admissions = createAdmissionFixture();
  const firstCommand = instantiateRunCommand(
    "command_remote-sparse-primary",
    runtimeFixture.repositoryId,
    runtimeFixture.runId,
  );
  expect(authority.submit(firstCommand, admissions.at("2026-08-14T10:00:00.000Z"))).toMatchObject({
    status: "completed",
  });
  const otherRepositoryId = "repository_remote-sparse-other";
  const otherRunId = "run_remote-sparse-other";
  const otherCommand = instantiateRunCommand(
    "command_remote-sparse-other",
    otherRepositoryId,
    otherRunId,
  );
  expect(authority.submit(otherCommand, admissions.at("2026-08-14T10:01:00.000Z"))).toMatchObject({
    status: "completed",
  });
  authority.close();

  const sparseBinding = Object.freeze({
    ...binding,
    bindingId: "binding_remote-sparse-integrity",
    repositoryId: runtimeFixture.repositoryId,
  });
  const otherBinding = Object.freeze({
    ...binding,
    bindingId: "binding_remote-sparse-other",
    repositoryId: otherRepositoryId,
  });
  const reportId = "report_remote-sparse-integrity";
  const otherReportId = "report_remote-sparse-other";
  const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
  remote.registerPeer(sparseBinding, "2026-08-14T10:02:00.000Z");
  remote.registerPeer(otherBinding, "2026-08-14T10:02:00.000Z");
  remote.enqueueReport(zeroCursorReport(sparseBinding, reportId, "2026-08-14T10:03:00.000Z"), {
    repositoryId: sparseBinding.repositoryId,
    runId: runtimeFixture.runId,
    fromCursor: 0,
    throughCursor: 0,
    localLatestCursor: 0,
  });
  remote.enqueueReport(zeroCursorReport(otherBinding, otherReportId, "2026-08-14T10:04:00.000Z"));
  remote.close();
  return {
    binding: sparseBinding,
    runId: runtimeFixture.runId,
    reportId,
    otherRepositoryId,
    otherRunId,
    otherReportId,
  };
}

function instantiateRunCommand(commandId: string, repositoryId: string, runId: string) {
  const template = runtimeCommand({
    commandId,
    intent: "instantiate-run",
    payload: {
      workflowId: runtimeFixture.workflowId,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      execution: runtimeFixture.execution,
      graph: createRuntimeGraph(),
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "no-approval" },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
      allowancePolicy: runtimeFixture.allowancePolicy,
    },
  });
  return decodeCommandEnvelope({
    ...template,
    commandId,
    repositoryId,
    runId,
    transport: { kind: "cli", requestId: `request_${commandId}` },
  });
}

function zeroCursorReport(
  reportBinding: RemoteRepositoryBinding,
  reportId: string,
  createdAt: string,
): RemoteClassifiedReport {
  return Object.freeze({
    ...classifiedReport(),
    reportId,
    binding: reportBinding,
    dataPolicyDigest: reportBinding.policyDigest,
    createdAt,
    synchronization: {
      repositoryId: reportBinding.repositoryId,
      localLatestCursor: 0,
      durablyEnqueuedCursor: 0,
      centrallyAcknowledgedCursor: 0,
      localObservedAt: createdAt,
      lastEnqueuedAt: null,
      lastAcknowledgedAt: null,
    },
  });
}

async function expectCorruptionRejectedAcrossIntegritySurfaces(
  sandbox: ReturnType<typeof createSandbox>,
  name: string,
  corrupt: (database: Database.Database) => void,
): Promise<void> {
  const authority = new SqliteAuthority(sandbox.authorityOptions);
  const suffix = name.replaceAll(/[^a-z0-9]+/giu, "-").replaceAll(/^-|-$/gu, "");
  const healthyBackup = join(sandbox.root, `${suffix}-healthy-backup`);
  await authority.backup(healthyBackup);
  try {
    corruptDatabase(sandbox.remoteOptions.databasePath, corrupt);
    expect(() => new SqliteRemoteAuthority(sandbox.remoteOptions)).toThrow(/remote|foreign key/iu);
    await expect(authority.backup(join(sandbox.root, `${suffix}-rejected-backup`))).rejects.toThrow(
      /remote|foreign key/iu,
    );

    const corruptRestore = join(sandbox.root, `${suffix}-corrupt-restore`);
    cpSync(healthyBackup, corruptRestore, { recursive: true });
    corruptDatabase(join(corruptRestore, "authority.db"), corrupt);
    refreshBackupDatabaseManifest(corruptRestore);
    expect(() =>
      restoreSqliteAuthority({
        ...sandbox.authorityOptions,
        databasePath: join(sandbox.root, `${suffix}-restored.db`),
        assetDirectory: join(sandbox.root, `${suffix}-restored-assets`),
        backupPath: corruptRestore,
      }),
    ).toThrow(/remote|foreign key/iu);
  } finally {
    authority.close();
  }
}

function corruptDatabase(
  databasePath: string,
  corrupt: (database: Database.Database) => void,
): void {
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    corrupt(database);
  } finally {
    database.close();
  }
}

function readRemoteHistoryCommitment(databasePath: string, bindingId: string) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM remote_history_commitments WHERE binding_id = ?",
      )
      .get(bindingId);
  } finally {
    database.close();
  }
}

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "senawa-remote-storage-"));
  sandboxes.add(root);
  const databasePath = join(root, "authority.db");
  const assetDirectory = join(root, "assets");
  mkdirSync(assetDirectory);
  return {
    root,
    remoteOptions: { databasePath, dependencies },
    authorityOptions: { databasePath, assetDirectory, dependencies },
  };
}

function seedTwoTerminalResultReports(sandbox: ReturnType<typeof createSandbox>) {
  const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
  remote.registerPeer(binding, "2026-08-14T09:01:00.000Z");
  const firstEnvelope = commandEnvelope(1, null, "terminal-first", "2026-08-14T11:00:00.000Z");
  const secondEnvelope = commandEnvelope(
    2,
    digest(firstEnvelope),
    "terminal-second",
    "2026-08-14T11:00:00.000Z",
  );
  remote.admitCommandEnvelope(
    firstEnvelope,
    deliveryEntry(firstEnvelope),
    "2026-08-14T10:01:00.000Z",
  );
  remote.admitCommandEnvelope(
    secondEnvelope,
    deliveryEntry(secondEnvelope),
    "2026-08-14T10:02:00.000Z",
  );
  remote.recordLocalAcceptance(
    binding.bindingId,
    1,
    localEntry(firstEnvelope, "local-accepted", "2026-08-14T10:04:00.000Z"),
  );
  remote.recordLocalAcceptance(
    binding.bindingId,
    2,
    localEntry(secondEnvelope, "local-accepted", "2026-08-14T10:04:00.000Z"),
  );
  const firstResult = localEntry(firstEnvelope, "local-outcome", "2026-08-14T10:05:00.000Z");
  const firstReport = terminalReport(firstEnvelope, firstResult);
  remote.recordLocalResultAndEnqueueReport(binding.bindingId, 1, firstResult, firstReport);
  const secondResult = localEntry(secondEnvelope, "local-outcome", "2026-08-14T10:06:00.000Z");
  const secondReport = Object.freeze({
    ...terminalReport(secondEnvelope, secondResult),
    reportId: "report_remote-atomic-second",
    reportSequence: 2,
    previousReportDigest: digest(firstReport),
    createdAt: "2026-08-14T10:07:00.000Z",
    synchronization: {
      ...firstReport.synchronization,
      localObservedAt: "2026-08-14T10:07:00.000Z",
      lastEnqueuedAt: "2026-08-14T10:07:00.000Z",
    },
  });
  remote.recordLocalResultAndEnqueueReport(binding.bindingId, 2, secondResult, secondReport);
  remote.close();
  return Object.freeze({
    first: Object.freeze({ result: firstResult, report: firstReport }),
    second: Object.freeze({ result: secondResult, report: secondReport }),
  });
}

function commandEnvelope(
  sequence: number,
  previousEnvelopeDigest: string | null,
  suffix: string,
  expiresAt: string,
): RemoteCommandEnvelope {
  const payload = { expectedRunModeRevision: sequence };
  const command = {
    apiVersion: PROTOCOL_VERSION,
    commandId: `command_remote-${suffix}`,
    repositoryId: binding.repositoryId,
    runId: "run_remote-storage",
    intent: { type: "pause-run" as const },
    payload,
    payloadDigest: digest(payload),
    expiresAt,
  };
  const acceptedCommand = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    acceptanceId: `acceptance_remote-${suffix}`,
    binding,
    attribution: {
      principal: {
        issuer: "https://control.example.test",
        subject: "operator@example.test",
        tenant: binding.tenantId,
        assurance: "multi-factor" as const,
        roles: ["operator"],
      },
      transport: { kind: "remote" as const, requestId: `request_remote-${suffix}` },
    },
    command,
    commandDigest: digest(command),
    acceptedAt: "2026-08-14T10:00:00.000Z",
    expiresAt,
  };
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    sequence,
    previousEnvelopeDigest,
    acceptedCommand,
    acceptedCommandDigest: digest(acceptedCommand),
    issuedAt: "2026-08-14T10:00:30.000Z",
    signingKeyId: binding.controlPlaneKeyId,
    signature: SIGNATURE,
  });
}

function localEntry(
  envelope: RemoteCommandEnvelope,
  stage: "local-accepted" | "local-outcome",
  recordedAt: string,
): RemoteReceiptChainEntry {
  const outcome = stage === "local-outcome";
  return {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: binding.bindingId,
    commandId: envelope.acceptedCommand.command.commandId,
    stage,
    stageSequence: outcome ? 5 : 3,
    recordedAt,
    previousEntryDigest: outcome ? "4".repeat(64) : "2".repeat(64),
    entryDigest: outcome ? "5".repeat(64) : "3".repeat(64),
    evidence: outcome
      ? {
          type: "local-outcome",
          localCommandId: envelope.acceptedCommand.command.commandId,
          receiptStatus: "completed",
          receiptCursor: 12,
          receiptDigest: "5".repeat(64),
        }
      : {
          type: "local-receipt",
          localCommandId: envelope.acceptedCommand.command.commandId,
          receiptStatus: "queued",
          receiptCursor: 10,
          receiptDigest: "3".repeat(64),
        },
  };
}

function deliveryEntry(envelope: RemoteCommandEnvelope): RemoteReceiptChainEntry {
  return {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: binding.bindingId,
    commandId: envelope.acceptedCommand.command.commandId,
    stage: "connector-delivered",
    stageSequence: 2,
    recordedAt: "2026-08-14T10:01:00.000Z",
    previousEntryDigest: "1".repeat(64),
    entryDigest: "2".repeat(64),
    evidence: {
      type: "connector-delivery",
      envelopeSequence: envelope.sequence,
      envelopeDigest: digest(envelope),
    },
  };
}

function commandEnvelopeWithPayload(
  envelope: RemoteCommandEnvelope,
  payload: Record<string, unknown>,
): RemoteCommandEnvelope {
  const command = {
    ...envelope.acceptedCommand.command,
    payload,
    payloadDigest: digest(payload),
  };
  const acceptedCommand = {
    ...envelope.acceptedCommand,
    command,
    commandDigest: digest(command),
  };
  return {
    ...envelope,
    acceptedCommand,
    acceptedCommandDigest: digest(acceptedCommand),
  };
}

function classifiedReport(): RemoteClassifiedReport {
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    reportId: "report_remote-storage",
    binding,
    classification: "internal",
    dataPolicyDigest: "b".repeat(64),
    reportSequence: 1,
    previousReportDigest: null,
    createdAt: "2026-08-14T10:06:00.000Z",
    receiptChains: [],
    events: [],
    projections: [],
    synchronization: {
      repositoryId: binding.repositoryId,
      localLatestCursor: 5,
      durablyEnqueuedCursor: 5,
      centrallyAcknowledgedCursor: 0,
      localObservedAt: "2026-08-14T10:06:00.000Z",
      lastEnqueuedAt: "2026-08-14T10:06:00.000Z",
      lastAcknowledgedAt: null,
    },
  });
}

function seedEventReport(
  sandbox: ReturnType<typeof createSandbox>,
  runIds: readonly string[],
): RemoteClassifiedReport {
  const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
  remote.registerPeer(binding, "2026-08-14T09:01:00.000Z");
  const database = new Database(sandbox.remoteOptions.databasePath);
  database.prepare("INSERT INTO repositories(repository_id) VALUES (?)").run(binding.repositoryId);
  const events: RemoteClassifiedReport["events"][number][] = [];
  const advances: RemoteRunEventAdvance[] = [];
  for (const [runIndex, runId] of [...runIds].sort().entries()) {
    const runKey = canonicalStringify([binding.repositoryId, runId]);
    const commandId = `command_remote-events-${runIndex + 1}`;
    database
      .prepare(
        `INSERT INTO runs(run_key, repository_id, run_id, cursor)
         VALUES (?, ?, ?, 2)`,
      )
      .run(runKey, binding.repositoryId, runId);
    database
      .prepare(
        `INSERT INTO commands(
           command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
         ) VALUES (?, ?, '{}', '{}', '{}')`,
      )
      .run(commandId, runKey);
    for (const cursor of [1, 2]) {
      const payload = { cursor, runId };
      const frame = {
        apiVersion: PROTOCOL_VERSION,
        cursor,
        repositoryId: binding.repositoryId,
        runId,
        eventId: `event_remote-${runIndex + 1}-${cursor}`,
        eventType: "remote-integrity-test",
        occurredAt: "2026-08-14T10:00:00.000Z",
        payload,
        payloadDigest: digest(payload),
        commandId,
      };
      database
        .prepare(
          `INSERT INTO event_frames(
             event_id, run_key, cursor, command_id, event_type, canonical_frame
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(frame.eventId, runKey, cursor, commandId, frame.eventType, canonicalStringify(frame));
      events.push(eventMetadata(frame));
    }
    advances.push({
      repositoryId: binding.repositoryId,
      runId,
      fromCursor: 0,
      throughCursor: 2,
      localLatestCursor: 2,
    });
  }
  database.close();
  const aggregateCursor = runIds.length * 2;
  const report: RemoteClassifiedReport = Object.freeze({
    ...classifiedReport(),
    reportId: "report_remote-events",
    events: Object.freeze(events),
    synchronization: {
      repositoryId: binding.repositoryId,
      localLatestCursor: aggregateCursor,
      durablyEnqueuedCursor: aggregateCursor,
      centrallyAcknowledgedCursor: 0,
      localObservedAt: "2026-08-14T10:06:00.000Z",
      lastEnqueuedAt: "2026-08-14T10:06:00.000Z",
      lastAcknowledgedAt: null,
    },
  });
  remote.enqueueReport(report, advances);
  remote.close();
  return report;
}

function seedSparseEventReport(sandbox: ReturnType<typeof createSandbox>): void {
  const remote = new SqliteRemoteAuthority(sandbox.remoteOptions);
  remote.registerPeer(binding, "2026-08-14T09:01:00.000Z");
  const runId = "run_remote-sparse-events";
  const database = new Database(sandbox.remoteOptions.databasePath);
  database.prepare("INSERT INTO repositories(repository_id) VALUES (?)").run(binding.repositoryId);
  database
    .prepare(
      `INSERT INTO runs(run_key, repository_id, run_id, cursor)
       VALUES (?, ?, ?, 2)`,
    )
    .run(canonicalStringify([binding.repositoryId, runId]), binding.repositoryId, runId);
  database.close();
  remote.enqueueReport(
    {
      ...classifiedReport(),
      reportId: "report_remote-sparse-events",
      synchronization: {
        repositoryId: binding.repositoryId,
        localLatestCursor: 2,
        durablyEnqueuedCursor: 2,
        centrallyAcknowledgedCursor: 0,
        localObservedAt: "2026-08-14T10:06:00.000Z",
        lastEnqueuedAt: "2026-08-14T10:06:00.000Z",
        lastAcknowledgedAt: null,
      },
    },
    {
      repositoryId: binding.repositoryId,
      runId,
      fromCursor: 0,
      throughCursor: 2,
      localLatestCursor: 2,
    },
  );
  remote.close();
}

function eventMetadata(event: {
  readonly cursor: number;
  readonly repositoryId: string;
  readonly runId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payloadDigest: string;
  readonly commandId?: string;
}): RemoteClassifiedReport["events"][number] {
  return Object.freeze({
    cursor: event.cursor,
    repositoryId: event.repositoryId,
    runId: event.runId,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payloadDigest: event.payloadDigest,
    ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
  });
}

function deleteEventEvidence(databasePath: string): void {
  const database = new Database(databasePath);
  database.exec(
    "DELETE FROM remote_report_run_event_advances; DELETE FROM remote_run_event_checkpoints",
  );
  database.close();
}

function refreshBackupDatabaseManifest(backupPath: string): void {
  const databaseBytes = Uint8Array.from(readFileSync(join(backupPath, "authority.db")));
  const manifestPath = join(backupPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    database: { byteLength: number; digest: string };
  };
  manifest.database.byteLength = databaseBytes.byteLength;
  manifest.database.digest = deterministicSha256.digest(databaseBytes);
  writeFileSync(manifestPath, canonicalStringify(manifest));
}

function terminalReport(
  envelope: RemoteCommandEnvelope,
  result: RemoteReceiptChainEntry,
): RemoteClassifiedReport {
  const acceptance = localEntry(envelope, "local-accepted", "2026-08-14T10:04:00.000Z");
  const claimed: RemoteReceiptChainEntry = {
    ...acceptance,
    stage: "runner-claimed",
    stageSequence: 4,
    recordedAt: "2026-08-14T10:04:30.000Z",
    previousEntryDigest: acceptance.entryDigest,
    entryDigest: "4".repeat(64),
    evidence: { ...acceptance.evidence, receiptStatus: "claimed", receiptCursor: 11 },
  };
  return Object.freeze({
    ...classifiedReport(),
    reportId: "report_remote-atomic",
    dataPolicyDigest: binding.policyDigest,
    receiptChains: [
      {
        bindingId: binding.bindingId,
        commandId: envelope.acceptedCommand.command.commandId,
        entries: [
          {
            apiVersion: REMOTE_PROTOCOL_VERSION,
            bindingId: binding.bindingId,
            commandId: envelope.acceptedCommand.command.commandId,
            stage: "central-accepted",
            stageSequence: 1,
            recordedAt: envelope.acceptedCommand.acceptedAt,
            previousEntryDigest: null,
            entryDigest: "1".repeat(64),
            evidence: {
              type: "central-acceptance",
              acceptanceId: envelope.acceptedCommand.acceptanceId,
              acceptanceDigest: envelope.acceptedCommandDigest,
            },
          },
          deliveryEntry(envelope),
          acceptance,
          claimed,
          result,
        ],
      },
    ],
  });
}

function digest(value: unknown): string {
  return dependencies.sha256.digest(canonicalBytes(value));
}

function requireClaim<T>(claim: T | undefined): T {
  if (claim === undefined) throw new Error("Expected a remote report claim");
  return claim;
}
