import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalBytes,
  canonicalStringify,
  decodeEventStreamFrame,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteClassifiedReport,
  type RemoteCommandEnvelope,
  type RemoteReceiptChain,
  type RemoteReceiptChainEntry,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
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
  SqliteAuthority,
  type SqliteAuthorityOptions,
  SqliteRemoteAuthority,
} from "../src/index.js";
import { SqliteReportingSnapshotAuthority } from "../src/reporting-snapshot.js";

const sandboxes = new Set<string>();
const SECRET_SUBJECT = "token-password-endpoint-path-secret-corpus";
const RESTRICTED_SUMMARY = "Violet harbor notes reserved for the incident council";
const OTHER_RUN_ID = "run_z-reporting-other";
const SIGNATURE = "A".repeat(86);

const dependencies = {
  sha256: deterministicSha256,
  authorization: { authorize: () => true },
};

afterEach(() => {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true });
  sandboxes.clear();
});

describe("SQLite reporting snapshot authority", () => {
  it("captures every secret-safe section from a validated authority", () => {
    const fixture = createAuthority();
    const reporting = new SqliteReportingSnapshotAuthority({
      databasePath: fixture.options.databasePath,
      dependencies,
    });

    const snapshot = reporting.captureReportingSnapshot(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );

    expect(snapshot.sections.map(({ name }) => name)).toEqual([
      "graph",
      "trajectory",
      "actors",
      "models",
      "assets",
      "context",
      "dataflow",
      "amendments",
      "escalations",
      "gates",
      "approvals",
      "costs",
      "uncertainty",
      "workspaces",
      "integration",
      "portal",
      "remote",
    ]);
    expect(
      snapshot.sections.every(({ status }) =>
        ["complete", "absent", "unavailable"].includes(status),
      ),
    ).toBe(true);
    expect(snapshot.sections.find(({ name }) => name === "graph")?.records.length).toBeGreaterThan(
      0,
    );
    expect(snapshot.sections.find(({ name }) => name === "trajectory")?.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "command", state: "completed" })]),
    );
    expect(snapshot.configurationSnapshotDigest).toBe(runtimeFixture.configurationSnapshotDigest);
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_SUBJECT);

    reporting.close();
    fixture.authority.close();
  });

  it("holds one read transaction and returns one internally consistent source vector", () => {
    const fixture = createAuthority();
    const baselineReader = new SqliteReportingSnapshotAuthority({
      databasePath: fixture.options.databasePath,
      dependencies,
    });
    const baseline = baselineReader.captureReportingSnapshot(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    baselineReader.close();

    let observed = false;
    const reporting = new SqliteReportingSnapshotAuthority({
      databasePath: fixture.options.databasePath,
      dependencies,
      captureObserver() {
        observed = true;
        const writer = new Database(fixture.options.databasePath);
        writer
          .prepare(
            `UPDATE portal_run_revisions SET portal_revision = portal_revision + 1
             WHERE repository_id = ? AND run_id = ?`,
          )
          .run(runtimeFixture.repositoryId, runtimeFixture.runId);
        writer.close();
      },
    });
    const captured = reporting.captureReportingSnapshot(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    reporting.close();

    const verification = new Database(fixture.options.databasePath, { readonly: true });
    const current = verification
      .prepare<[string, string], { portal_revision: number }>(
        `SELECT portal_revision FROM portal_run_revisions
         WHERE repository_id = ? AND run_id = ?`,
      )
      .get(runtimeFixture.repositoryId, runtimeFixture.runId);
    verification.close();

    expect(observed).toBe(true);
    expect(captured.sourceVector).toEqual(baseline.sourceVector);
    expect(current?.portal_revision).toBe(baseline.sourceVector.portalRevision + 1);
    fixture.authority.close();
  });

  it("excludes unpatterned worker summary text from worker asset metadata", () => {
    const fixture = createAuthority();
    seedRestrictedWorkerAsset(fixture.options.databasePath);
    const reporting = new SqliteReportingSnapshotAuthority({
      databasePath: fixture.options.databasePath,
      dependencies,
    });

    const snapshot = reporting.captureReportingSnapshot(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    const workerAsset = snapshot.sections
      .find(({ name }) => name === "assets")
      ?.records.find(({ kind }) => kind === "worker-asset");

    expect(workerAsset).toMatchObject({
      identity: "asset_restricted-summary",
      digest: "e".repeat(64),
    });
    expect(workerAsset?.scalars).toEqual([
      { name: "byteLength", value: 47 },
      { name: "mediaType", value: "text/plain" },
      { name: "verifiedStored", value: false },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(RESTRICTED_SUMMARY);

    reporting.close();
    fixture.authority.close();
  });

  it("surfaces a refused transcript capture count on the effect record", () => {
    const fixture = createAuthority();
    seedWorkerEffectOutcome(fixture.options.databasePath, { transcriptRefusals: 3 });
    seedWorkerEffectOutcome(fixture.options.databasePath, {}, "quiet");
    const reporting = new SqliteReportingSnapshotAuthority({
      databasePath: fixture.options.databasePath,
      dependencies,
    });

    const snapshot = reporting.captureReportingSnapshot(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    const effects = snapshot.sections
      .find(({ name }) => name === "trajectory")
      ?.records.filter(({ kind }) => kind === "effect");

    expect(
      effects?.find(({ identity }) => identity === "intent_transcript-refusals")?.scalars,
    ).toEqual(expect.arrayContaining([{ name: "transcriptRefusals", value: 3 }]));
    // A run that refused nothing carries no count at all, so a non-zero value is
    // the only thing an operator ever reads here.
    expect(
      effects
        ?.find(({ identity }) => identity === "intent_transcript-refusals-quiet")
        ?.scalars.map(({ name }) => name),
    ).not.toContain("transcriptRefusals");

    reporting.close();
    fixture.authority.close();
  });

  it("links allowance resolutions to actor, policy, escalation, limits, result, and time", () => {
    const fixture = createAuthority();
    seedAllowanceResolution(fixture.options.databasePath);
    const reporting = new SqliteReportingSnapshotAuthority({
      databasePath: fixture.options.databasePath,
      dependencies,
    });

    const snapshot = reporting.captureReportingSnapshot(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    const resolution = snapshot.sections
      .find(({ name }) => name === "escalations")
      ?.records.find(({ kind }) => kind === "allowance-resolution");

    expect(resolution).toMatchObject({
      identity: "command_report-instantiate",
      state: "granted",
      occurredAt: "2026-08-14T10:10:00.000Z",
      references: expect.arrayContaining([
        { role: "source", kind: "command", identity: "command_report-instantiate" },
        { role: "related", kind: "runner-escalation", identity: "command_escalation-report" },
        { role: "related", kind: "allowance-policy", identity: "a".repeat(64) },
        { role: "related", kind: "principal", identity: "f".repeat(64) },
        { role: "result", kind: "runner-budget-limit", identity: "worker:15" },
      ]),
      scalars: [
        { name: "escalationDigest", value: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        { name: "increaseBy", value: 5 },
        { name: "priorLimit", value: 10 },
        { name: "resultingLimit", value: 15 },
        { name: "unit", value: "worker" },
      ],
    });

    reporting.close();
    fixture.authority.close();
  });

  it("projects only run-attributable remote chains from a multi-run binding and report", () => {
    const fixture = createAuthority();
    seedMultiRunRemoteEvidence(fixture.options.databasePath);
    const reporting = new SqliteReportingSnapshotAuthority({
      databasePath: fixture.options.databasePath,
      dependencies,
    });

    const snapshot = reporting.captureReportingSnapshot(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    const records = snapshot.sections.find(({ name }) => name === "remote")?.records ?? [];

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote-command-chain", identity: "binding_reporting:1" }),
        expect.objectContaining({ kind: "remote-report", identity: "report_multi-run" }),
        expect.objectContaining({ kind: "remote-event", identity: expect.stringContaining("1") }),
        expect.objectContaining({
          kind: "remote-projection",
          identity: "report_multi-run:overview:revision_run-a",
        }),
      ]),
    );
    expect(records).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote-command-chain", identity: "binding_reporting:2" }),
        expect.objectContaining({
          kind: "remote-projection",
          identity: "report_multi-run:overview:revision_run-b-only",
        }),
      ]),
    );
    const reportRecord = records.find(({ kind }) => kind === "remote-report");
    expect(reportRecord?.scalars).toEqual(
      expect.arrayContaining([
        { name: "fromCursor", value: 0 },
        { name: "localLatestCursor", value: snapshot.sourceVector.workflowCursor },
        { name: "throughCursor", value: snapshot.sourceVector.workflowCursor },
      ]),
    );
    expect(reportRecord?.scalars.some(({ name }) => name === "sourceCursor")).toBe(false);

    reporting.close();
    fixture.authority.close();
  });
});

function createAuthority(): {
  readonly authority: SqliteAuthority;
  readonly options: SqliteAuthorityOptions;
} {
  const root = mkdtempSync(join(tmpdir(), "senawa-reporting-snapshot-"));
  sandboxes.add(root);
  const assetDirectory = join(root, "assets");
  mkdirSync(assetDirectory);
  const options: SqliteAuthorityOptions = {
    databasePath: join(root, "authority.db"),
    assetDirectory,
    dependencies,
  };
  const authority = new SqliteAuthority(options);
  const template = runtimeCommand({
    commandId: "command_report-principal-template",
    intent: "pause-run",
    payload: { expectedRunModeRevision: 0 },
  });
  const command = runtimeCommand({
    commandId: "command_report-instantiate",
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
  const secretBearingCommand = {
    ...command,
    principal: { ...template.principal, subject: SECRET_SUBJECT },
  };
  const admission = createAdmissionFixture();
  expect(authority.submit(secretBearingCommand, admission.at()).status).toBe("completed");
  return { authority, options };
}

const remoteBinding: RemoteRepositoryBinding = Object.freeze({
  apiVersion: REMOTE_PROTOCOL_VERSION,
  bindingId: "binding_reporting",
  tenantId: "tenant_reporting",
  repositoryId: runtimeFixture.repositoryId,
  connectorId: "connector_reporting",
  repositoryKeyId: "key_repository-reporting",
  controlPlaneKeyId: "key_control-reporting",
  revocationEpoch: 1,
  policyDigest: "a".repeat(64),
  issuedAt: "2026-08-14T09:00:00.000Z",
});

function seedMultiRunRemoteEvidence(databasePath: string): void {
  const historical = new Database(databasePath);
  const otherRunKey = canonicalStringify([runtimeFixture.repositoryId, OTHER_RUN_ID]);
  const otherCommandId = "command_historical-run-b";
  const otherPayload = { runId: OTHER_RUN_ID };
  const otherFrame = {
    apiVersion: PROTOCOL_VERSION,
    cursor: 1,
    repositoryId: runtimeFixture.repositoryId,
    runId: OTHER_RUN_ID,
    eventId: "event_run-b-only",
    eventType: "historical-run-event",
    occurredAt: "2026-08-14T09:59:00.000Z",
    payload: otherPayload,
    payloadDigest: digest(otherPayload),
    commandId: otherCommandId,
  };
  historical
    .prepare(
      `INSERT INTO runs(run_key, repository_id, run_id, cursor)
       VALUES (?, ?, ?, 1)`,
    )
    .run(otherRunKey, runtimeFixture.repositoryId, OTHER_RUN_ID);
  historical
    .prepare(
      `INSERT INTO commands(
         command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
       ) VALUES (?, ?, '{}', '{}', '{}')`,
    )
    .run(otherCommandId, otherRunKey);
  historical
    .prepare(
      `INSERT INTO event_frames(
         event_id, run_key, cursor, command_id, event_type, canonical_frame
       ) VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .run(
      otherFrame.eventId,
      otherRunKey,
      otherCommandId,
      otherFrame.eventType,
      canonicalStringify(otherFrame),
    );
  historical.close();

  const remote = new SqliteRemoteAuthority({ databasePath, dependencies });
  remote.registerPeer(remoteBinding, "2026-08-14T09:01:00.000Z");
  const first = remoteEnvelope(1, null, runtimeFixture.runId, "run-a");
  const firstDelivery = remoteDeliveryEntry(first);
  remote.admitCommandEnvelope(first, firstDelivery, "2026-08-14T10:01:00.000Z");
  const second = remoteEnvelope(2, digest(first), OTHER_RUN_ID, "run-b");
  const secondDelivery = remoteDeliveryEntry(second);
  remote.admitCommandEnvelope(second, secondDelivery, "2026-08-14T10:02:00.000Z");

  const database = new Database(databasePath, { readonly: true });
  const runRows = [runtimeFixture.runId, OTHER_RUN_ID].map((runId) => {
    const run = database
      .prepare<[string, string], { run_key: string; cursor: number }>(
        "SELECT run_key, cursor FROM runs WHERE repository_id = ? AND run_id = ?",
      )
      .get(runtimeFixture.repositoryId, runId);
    if (run === undefined) throw new Error(`Missing reporting test run ${runId}`);
    const events = database
      .prepare<[string], { canonical_frame: string }>(
        "SELECT canonical_frame FROM event_frames WHERE run_key = ? ORDER BY cursor",
      )
      .all(run.run_key)
      .map(({ canonical_frame }) => {
        const event = decodeEventStreamFrame(canonical_frame);
        return {
          cursor: event.cursor,
          repositoryId: event.repositoryId,
          runId: event.runId,
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          payloadDigest: event.payloadDigest,
          ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
        };
      });
    return { runId, cursor: run.cursor, events };
  });
  database.close();
  const aggregateCursor = runRows.reduce((total, run) => total + run.cursor, 0);
  const report: RemoteClassifiedReport = Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    reportId: "report_multi-run",
    binding: remoteBinding,
    classification: "internal",
    dataPolicyDigest: "b".repeat(64),
    reportSequence: 1,
    previousReportDigest: null,
    createdAt: "2026-08-14T10:06:00.000Z",
    receiptChains: Object.freeze([
      remoteReceiptChain(first, firstDelivery),
      remoteReceiptChain(second, secondDelivery),
    ]),
    events: Object.freeze(runRows.flatMap(({ events }) => events)),
    projections: Object.freeze(
      runRows.map(({ runId, cursor }) => ({
        cursor,
        repositoryId: runtimeFixture.repositoryId,
        runId,
        projectionType: "overview",
        revision: runId === runtimeFixture.runId ? "revision_run-a" : "revision_run-b-only",
        generatedAt: "2026-08-14T10:05:00.000Z",
        payloadDigest: runId === runtimeFixture.runId ? "c".repeat(64) : "d".repeat(64),
        lifecycleStatus: "active",
        counts: { tasks: 1, readyTasks: 0, humanNeeds: 0, activeEffects: 0, uncertainEffects: 0 },
      })),
    ),
    synchronization: {
      repositoryId: runtimeFixture.repositoryId,
      localLatestCursor: aggregateCursor,
      durablyEnqueuedCursor: aggregateCursor,
      centrallyAcknowledgedCursor: 0,
      localObservedAt: "2026-08-14T10:06:00.000Z",
      lastEnqueuedAt: "2026-08-14T10:06:00.000Z",
      lastAcknowledgedAt: null,
    },
  });
  remote.enqueueReport(
    report,
    runRows.map(({ runId, cursor }) => ({
      repositoryId: runtimeFixture.repositoryId,
      runId,
      fromCursor: 0,
      throughCursor: cursor,
      localLatestCursor: cursor,
    })),
  );
  remote.close();
}

function seedRestrictedWorkerAsset(databasePath: string): void {
  const database = new Database(databasePath);
  database
    .prepare(
      `INSERT INTO context_bases(context_id, context_digest, canonical_context)
       VALUES (?, ?, ?)`,
    )
    .run("context_restricted-summary", "1".repeat(64), "{}");
  database
    .prepare(
      `INSERT INTO context_dispatches(
         dispatch_id, repository_id, run_id, context_id, prompt_pack_digest,
         canonical_dispatch, canonical_completion_requirements, canonical_task_scope
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "dispatch_restricted-summary",
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "context_restricted-summary",
      "2".repeat(64),
      "{}",
      "{}",
      "{}",
    );
  database
    .prepare(
      `INSERT INTO context_submissions(
         submission_id, repository_id, run_id, dispatch_id,
         submission_type, canonical_submission, canonical_result
       ) VALUES (?, ?, ?, ?, 'asset', ?, ?)`,
    )
    .run(
      "submission_restricted-summary",
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "dispatch_restricted-summary",
      canonicalStringify({
        asset: {
          assetId: "asset_restricted-summary",
          contentDigest: "e".repeat(64),
          mediaType: "text/plain",
          summary: RESTRICTED_SUMMARY,
          byteLength: 47,
        },
      }),
      canonicalStringify({ status: "accepted" }),
    );
  database.close();
}

function seedWorkerEffectOutcome(
  databasePath: string,
  details: Readonly<Record<string, number>>,
  suffix = "",
): void {
  const database = new Database(databasePath);
  const runKey = canonicalStringify([runtimeFixture.repositoryId, runtimeFixture.runId]);
  const label = suffix.length === 0 ? "" : `-${suffix}`;
  const commandId = `command_transcript-refusals${label}`;
  const intentId = `intent_transcript-refusals${label}`;
  const operationId = `operation_transcript-refusals${label}`;
  const sequence = suffix.length === 0 ? 20 : 21;
  try {
    database
      .prepare(
        `INSERT OR IGNORE INTO runner_runs(
           run_key, repository_id, run_id, context_digest, cursor
         ) VALUES (?, ?, ?, ?, 0)`,
      )
      .run(runKey, runtimeFixture.repositoryId, runtimeFixture.runId, "9".repeat(64));
    database
      .prepare(
        `INSERT INTO runner_commands(
           command_id, run_key, operation_id, sequence, canonical_command
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        commandId,
        runKey,
        operationId,
        sequence,
        canonicalStringify({ commandId, kind: "worker", operationId }),
      );
    database
      .prepare(
        `INSERT INTO runner_effect_intents(
           intent_id, run_key, command_id, owner_id, fence, attempt_id, canonical_intent
         ) VALUES (?, ?, ?, 'owner_report', 1, 'attempt_report', ?)`,
      )
      .run(
        intentId,
        runKey,
        commandId,
        canonicalStringify({ command: { commandId, kind: "worker", operationId } }),
      );
    database
      .prepare(
        `INSERT INTO runner_effect_outcomes(
           intent_id, attempt_id, commit_cursor, status, canonical_outcome
         ) VALUES (?, 'attempt_report', ?, 'completed', ?)`,
      )
      .run(
        intentId,
        sequence,
        canonicalStringify({
          details: { dispatchId: "dispatch_report", ...details },
          observedAt: "2026-08-14T10:12:00.000Z",
          origin: "dispatch",
          status: "completed",
        }),
      );
  } finally {
    database.close();
  }
}

function seedAllowanceResolution(databasePath: string): void {
  const database = new Database(databasePath);
  const runKey = canonicalStringify([runtimeFixture.repositoryId, runtimeFixture.runId]);
  const escalation = {
    commandId: "command_escalation-report",
    operationId: "operation_escalation-report",
    unit: "worker",
    requested: 4,
    available: 0,
    createdAt: "2026-08-14T10:05:00.000Z",
  };
  database
    .prepare(
      `INSERT OR IGNORE INTO runner_runs(
         run_key, repository_id, run_id, context_digest, cursor
       ) VALUES (?, ?, ?, ?, 0)`,
    )
    .run(runKey, runtimeFixture.repositoryId, runtimeFixture.runId, "9".repeat(64));
  database
    .prepare(
      `INSERT INTO runner_budgets(run_key, unit, budget_limit, reserved, spent, unreported)
       VALUES (?, 'worker', 15, 0, 0, 0)`,
    )
    .run(runKey);
  database
    .prepare(
      `INSERT INTO runner_commands(
         command_id, run_key, operation_id, sequence, canonical_command
       ) VALUES (?, ?, ?, 1, ?)`,
    )
    .run(
      escalation.commandId,
      runKey,
      escalation.operationId,
      canonicalStringify({ kind: "worker", commandId: escalation.commandId }),
    );
  database
    .prepare(
      `INSERT INTO runner_escalations(command_id, run_key, canonical_escalation)
       VALUES (?, ?, ?)`,
    )
    .run(escalation.commandId, runKey, canonicalStringify(escalation));
  database
    .prepare(
      `INSERT INTO runner_allowance_policies(run_key, policy_digest, canonical_policy)
       VALUES (?, ?, ?)`,
    )
    .run(runKey, "a".repeat(64), canonicalStringify({ policyDigest: "a".repeat(64) }));
  database
    .prepare(
      `INSERT INTO runner_allowance_resolutions(
         escalation_command_id, run_key, command_id, escalation_digest, policy_digest,
         unit, prior_limit, increase_by, resulting_limit, principal_digest,
         canonical_principal, resolved_at
       ) VALUES (?, ?, ?, ?, ?, 'worker', 10, 5, 15, ?, ?, ?)`,
    )
    .run(
      escalation.commandId,
      runKey,
      "command_report-instantiate",
      digest(escalation),
      "a".repeat(64),
      "f".repeat(64),
      canonicalStringify({ subject: "operator" }),
      "2026-08-14T10:10:00.000Z",
    );
  database.close();
}

function remoteEnvelope(
  sequence: number,
  previousEnvelopeDigest: string | null,
  runId: string,
  suffix: string,
): RemoteCommandEnvelope {
  const payload = { expectedRunModeRevision: 1 };
  const command = {
    apiVersion: PROTOCOL_VERSION,
    commandId: `command_remote-${suffix}`,
    repositoryId: runtimeFixture.repositoryId,
    runId,
    intent: { type: "pause-run" as const },
    payload,
    payloadDigest: digest(payload),
    expiresAt: "2026-08-14T11:00:00.000Z",
  };
  const acceptedCommand = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    acceptanceId: `acceptance_remote-${suffix}`,
    binding: remoteBinding,
    attribution: {
      principal: {
        issuer: "https://control.example.test",
        subject: "operator@example.test",
        tenant: remoteBinding.tenantId,
        assurance: "multi-factor" as const,
        roles: ["operator"],
      },
      transport: { kind: "remote" as const, requestId: `request_remote-${suffix}` },
    },
    command,
    commandDigest: digest(command),
    acceptedAt: "2026-08-14T10:00:00.000Z",
    expiresAt: command.expiresAt,
  };
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    sequence,
    previousEnvelopeDigest,
    acceptedCommand,
    acceptedCommandDigest: digest(acceptedCommand),
    issuedAt: "2026-08-14T10:00:30.000Z",
    signingKeyId: remoteBinding.controlPlaneKeyId,
    signature: SIGNATURE,
  });
}

function remoteDeliveryEntry(envelope: RemoteCommandEnvelope): RemoteReceiptChainEntry {
  return Object.freeze({
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: remoteBinding.bindingId,
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
  });
}

function remoteReceiptChain(
  envelope: RemoteCommandEnvelope,
  delivery: RemoteReceiptChainEntry,
): RemoteReceiptChain {
  return Object.freeze({
    bindingId: remoteBinding.bindingId,
    commandId: envelope.acceptedCommand.command.commandId,
    entries: Object.freeze([
      {
        apiVersion: REMOTE_PROTOCOL_VERSION,
        bindingId: remoteBinding.bindingId,
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
      delivery,
    ]),
  });
}

function digest(value: unknown): string {
  return deterministicSha256.digest(canonicalBytes(value));
}
