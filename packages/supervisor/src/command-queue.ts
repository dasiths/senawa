import { resolve } from "node:path";
import {
  canonicalBytes,
  canonicalStringify,
  type DurableReceipt,
  decodeAuthenticatedPrincipal,
  decodeCanonicalJsonValue,
  decodeCommandEnvelope,
  decodeSupervisorAdmissionFacts,
  decodeSupervisorReceipt,
  decodeSupervisorServiceRecord,
  decodeSupervisorWake,
  type JsonValue,
  PROTOCOL_VERSION,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import type { AdmissionFacts, RuntimeDependencies } from "@senawa/runtime";
import { type LeaseGrant, SqliteAuthority, StaleLeaseFenceError } from "@senawa/storage-sqlite";
import Database from "better-sqlite3";
import type {
  AmendmentReviewRecord,
  AuthenticatedCommandAdmission,
  DrainRunOnceInput,
  MutableRunEventNotifier,
  PendingSupervisorWake,
  SupervisorAdmissionFacts,
  SupervisorLeaseStatus,
  SupervisorLogEntry,
  SupervisorLogLevel,
  SupervisorLogPage,
  SupervisorMode,
  SupervisorPendingCounts,
  SupervisorReceipt,
  SupervisorReceiptStatus,
  SupervisorRepositoryRegistration,
  SupervisorWake,
} from "./contracts.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_DURABLE_LOG_ENTRIES = 10_000;

export type SupervisorFaultPoint =
  | "after-queued-commit-before-ack"
  | "after-claim-commit-before-execute"
  | "after-command-submit-before-terminal-ack"
  | "before-terminal-commit"
  | "after-terminal-commit-before-ack";

export interface SqliteSupervisorAuthorityOptions {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SupervisorFaultPoint) => void;
  readonly eventNotifier?: MutableRunEventNotifier;
}

export interface ApprovedAmendmentRecovery {
  readonly repositoryId: string;
  readonly runId: string;
  readonly amendmentId: string;
  readonly proposalDigest: string;
  readonly decisionDigest: string;
  readonly baseGraphRevisionDigest: string;
  readonly reviewedResultGraphRevisionDigest: string;
  readonly observedQuiescent: boolean;
}

interface CommandRow {
  readonly command_id: string;
  readonly run_key: string;
  readonly canonical_envelope: string;
  readonly canonical_admission: string;
  readonly state: SupervisorReceiptStatus;
  readonly claim_owner_id: string | null;
  readonly claim_fence: number | null;
  readonly claim_expires_at: string | null;
  readonly claim_expires_at_ms: number | null;
  readonly terminal_receipt_json: string | null;
}

interface ReceiptRow {
  readonly canonical_receipt: string;
}

interface WakeRow {
  readonly repository_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly ack_generation: number;
  readonly not_before: string;
  readonly reasons_json: string;
  readonly has_pending_work: number;
}

interface LogRow {
  readonly cursor: number;
  readonly recorded_at: string;
  readonly level: SupervisorLogLevel;
  readonly event: string;
  readonly message: string;
  readonly fields_json: string;
}

export class SupervisorCommandConflictError extends Error {
  constructor(commandId: string) {
    super(`Supervisor command ${commandId} conflicts with its durable canonical content`);
    this.name = "SupervisorCommandConflictError";
  }
}

export class SupervisorServiceUnavailableError extends Error {
  constructor(mode: SupervisorMode) {
    super(`Supervisor does not accept new commands while ${mode}`);
    this.name = "SupervisorServiceUnavailableError";
  }
}

export class SqliteSupervisorAuthority {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly commandAuthority: SqliteAuthority;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: SupervisorFaultPoint) => void) | undefined;
  readonly #eventNotifier: MutableRunEventNotifier | undefined;

  constructor(options: SqliteSupervisorAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = options.dependencies;
    this.#faultInjector = options.faultInjector;
    this.#eventNotifier = options.eventNotifier;
    this.commandAuthority = new SqliteAuthority({
      databasePath: this.databasePath,
      assetDirectory: options.assetDirectory,
      dependencies: options.dependencies,
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    try {
      this.#database = new Database(this.databasePath, {
        timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      });
      this.#database.pragma("journal_mode = WAL");
      this.#database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
      this.#database.pragma("foreign_keys = ON");
      this.#database.pragma("trusted_schema = OFF");
    } catch (error) {
      this.commandAuthority.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
    this.commandAuthority.close();
  }

  accept(input: AuthenticatedCommandAdmission): SupervisorReceipt {
    const envelope = decodeCommandEnvelope(input.envelope);
    const canonicalEnvelope = canonicalStringify(envelope);
    const runKey = canonicalStringify([envelope.repositoryId, envelope.runId]);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare<[string], CommandRow>(
          `SELECT command_id, run_key, canonical_envelope, canonical_admission, state,
              claim_owner_id, claim_fence, claim_expires_at, claim_expires_at_ms,
              terminal_receipt_json
           FROM supervisor_commands WHERE command_id = ?`,
        )
        .get(envelope.commandId);
      if (existing !== undefined) {
        if (existing.canonical_envelope !== canonicalEnvelope) {
          throw new SupervisorCommandConflictError(envelope.commandId);
        }
        const replay = this.#requiredLatestReceipt(envelope.commandId);
        this.#database.exec("COMMIT");
        return replay;
      }
      const mode = this.mode();
      if (mode === "drained" || mode === "stopped") {
        throw new SupervisorServiceUnavailableError(mode);
      }
      const admission = normalizeAdmission(input.createAdmission());
      const canonicalAdmission = canonicalStringify(admission);
      const acceptedAtMs = timestampToEpoch(admission.currentTime, "currentTime");
      this.#assertNotBackdated(runKey, acceptedAtMs);
      this.#database
        .prepare("INSERT OR IGNORE INTO supervisor_repositories(repository_id) VALUES (?)")
        .run(envelope.repositoryId);
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO supervisor_runs(run_key, repository_id, run_id)
           VALUES (?, ?, ?)`,
        )
        .run(runKey, envelope.repositoryId, envelope.runId);
      const acceptedSequence = this.#nextAcceptedSequence(runKey);
      this.#database
        .prepare(
          `INSERT INTO supervisor_commands(
             command_id, run_key, accepted_sequence, canonical_envelope, canonical_admission,
             state, accepted_at, accepted_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          envelope.commandId,
          runKey,
          acceptedSequence,
          canonicalEnvelope,
          canonicalAdmission,
          admission.currentTime,
          acceptedAtMs,
        );
      const receipt = this.#appendReceipt(
        runKey,
        envelope.commandId,
        envelope.repositoryId,
        envelope.runId,
        "queued",
        admission.currentTime,
      );
      this.#database
        .prepare(
          `INSERT INTO supervisor_wakes(
             run_key, generation, ack_generation, not_before, not_before_ms, reasons_json
             ) VALUES (?, 1, 0, ?, ?, ?)
           ON CONFLICT(run_key) DO UPDATE SET
             generation = supervisor_wakes.generation + 1,
             not_before = excluded.not_before,
               not_before_ms = excluded.not_before_ms,
             reasons_json = excluded.reasons_json`,
        )
        .run(runKey, admission.currentTime, acceptedAtMs, canonicalStringify(["command-accepted"]));
      this.#database.exec("COMMIT");
      this.#eventNotifier?.notify(envelope.repositoryId, envelope.runId);
      this.#fault("after-queued-commit-before-ack");
      return receipt;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  acquireRunLease(
    repositoryId: string,
    runId: string,
    ownerId: string,
    currentTime: string,
    expiresAt: string,
  ): LeaseGrant {
    return this.commandAuthority.acquireLease({
      resourceKey: this.#leaseResourceKey(repositoryId, runId),
      ownerId,
      currentTime,
      expiresAt,
    });
  }

  renewRunLease(lease: LeaseGrant, currentTime: string, newExpiresAt: string): LeaseGrant {
    return this.commandAuthority.renewLease({ ...lease, currentTime, newExpiresAt });
  }

  releaseRunLease(lease: LeaseGrant, currentTime: string): void {
    this.commandAuthority.releaseLease({ ...lease, currentTime });
  }

  drainRunOnce(input: DrainRunOnceInput): SupervisorReceipt | undefined {
    validateTimestamp(input.currentTime, "currentTime");
    const runKey = canonicalStringify([input.repositoryId, input.runId]);
    const expectedResourceKey = this.#leaseResourceKey(input.repositoryId, input.runId);
    if (input.lease.resourceKey !== expectedResourceKey) {
      throw new StaleLeaseFenceError(expectedResourceKey, input.lease.fence);
    }
    const claimed = this.#claim(runKey, input);
    if (claimed === undefined) return undefined;
    this.#fault("after-claim-commit-before-execute");
    const admission = parseAdmission(claimed.canonical_admission);
    const priorReceipt = this.commandAuthority.queryReceipt(claimed.command_id);
    let allocationIndex = 0;
    const runtimeAdmission: AdmissionFacts = {
      currentTime: admission.currentTime,
      facts: admission.facts,
      allocateId(kind) {
        const allocation = admission.allocations[allocationIndex];
        if (allocation === undefined || allocation.kind !== kind) {
          throw new TypeError("Supervisor allocation sequence does not match runtime demand");
        }
        allocationIndex += 1;
        return allocation.id;
      },
    };
    const terminal = this.commandAuthority.submit(claimed.canonical_envelope, runtimeAdmission);
    if (priorReceipt === undefined && allocationIndex !== admission.allocations.length) {
      throw new TypeError("Supervisor admission contains unused allocation facts");
    }
    this.#fault("after-command-submit-before-terminal-ack");
    return this.#ackTerminal(claimed, input, terminal);
  }

  queryLatest(commandId: string): SupervisorReceipt | undefined {
    validateOpaqueIdentity(commandId);
    return this.#latestReceipt(commandId);
  }

  queryHistory(repositoryId: string, runId: string): readonly SupervisorReceipt[] {
    const runKey = canonicalStringify([
      validateOpaqueIdentity(repositoryId),
      validateOpaqueIdentity(runId),
    ]);
    return this.#database
      .prepare<[string], ReceiptRow>(
        `SELECT canonical_receipt FROM supervisor_receipts
         WHERE run_key = ? ORDER BY sequence`,
      )
      .all(runKey)
      .map((row) => parseSupervisorReceipt(row.canonical_receipt));
  }

  queryAmendments(repositoryId: string, runId: string): readonly AmendmentReviewRecord[] {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const projection = this.commandAuthority.queryProjection(repositoryId, runId);
    if (projection === undefined) return Object.freeze([]);
    const projectionPayload = localRecord(projection.payload, "Amendment lifecycle projection");
    const lifecycles = Array.isArray(projectionPayload.amendments)
      ? projectionPayload.amendments
      : [];
    const lifecycleById = new Map(
      lifecycles.map((value) => {
        const lifecycle = localRecord(value, "Amendment lifecycle");
        if (typeof lifecycle.amendmentId !== "string") {
          throw new Error("Amendment lifecycle identity is invalid");
        }
        return [lifecycle.amendmentId, value] as const;
      }),
    );
    const runKey = canonicalStringify([repositoryId, runId]);
    const rows = this.#database
      .prepare<
        [string],
        {
          amendment_id: string;
          canonical_proposal: string;
          canonical_decision: string | null;
          canonical_withdrawal: string | null;
          canonical_application: string | null;
          canonical_source: string | null;
          canonical_outcome: string | null;
        }
      >(
        `SELECT p.amendment_id, p.canonical_proposal,
                d.canonical_decision, w.canonical_withdrawal, a.canonical_application,
                (
                  SELECT o.canonical_source
                  FROM amendment_proposal_bridge_outcomes b
                  JOIN context_amendment_outbox o ON o.submission_id = b.submission_id
                  WHERE json_extract(b.canonical_outcome, '$.amendmentId') = p.amendment_id
                  ORDER BY b.submission_id LIMIT 1
                ) AS canonical_source,
                (
                  SELECT b.canonical_outcome
                  FROM amendment_proposal_bridge_outcomes b
                  WHERE json_extract(b.canonical_outcome, '$.amendmentId') = p.amendment_id
                  ORDER BY b.submission_id LIMIT 1
                ) AS canonical_outcome
         FROM amendment_proposals p
         LEFT JOIN amendment_decisions d ON d.amendment_id = p.amendment_id
         LEFT JOIN amendment_withdrawals w ON w.amendment_id = p.amendment_id
         LEFT JOIN amendment_applications a ON a.amendment_id = p.amendment_id
         WHERE p.run_key = ? ORDER BY p.amendment_id`,
      )
      .all(runKey);
    return Object.freeze(
      rows.map((row) => {
        const lifecycle = lifecycleById.get(row.amendment_id);
        if (lifecycle === undefined) {
          throw new Error("Stored amendment lacks its derived lifecycle projection");
        }
        return Object.freeze({
          repositoryId,
          runId,
          proposal: decodeCanonicalJsonValue(row.canonical_proposal),
          lifecycle,
          ...(row.canonical_decision === null
            ? {}
            : { decision: decodeCanonicalJsonValue(row.canonical_decision) }),
          ...(row.canonical_withdrawal === null
            ? {}
            : { withdrawal: decodeCanonicalJsonValue(row.canonical_withdrawal) }),
          ...(row.canonical_application === null
            ? {}
            : { application: decodeCanonicalJsonValue(row.canonical_application) }),
          ...(row.canonical_source === null
            ? {}
            : { workerSource: decodeCanonicalJsonValue(row.canonical_source) }),
          ...(row.canonical_outcome === null
            ? {}
            : { bridgeOutcome: decodeCanonicalJsonValue(row.canonical_outcome) }),
        });
      }),
    );
  }

  queryAmendment(
    repositoryId: string,
    runId: string,
    amendmentId: string,
  ): AmendmentReviewRecord | undefined {
    validateOpaqueIdentity(amendmentId);
    return this.queryAmendments(repositoryId, runId).find((record) => {
      const proposal = localRecord(record.proposal, "Amendment proposal");
      return proposal.amendmentId === amendmentId;
    });
  }

  queryWake(repositoryId: string, runId: string): SupervisorWake | undefined {
    const row = this.#wakeRow(repositoryId, runId);
    return row === undefined ? undefined : wakeFromRow(row);
  }

  listPendingWakes(): readonly PendingSupervisorWake[] {
    return this.#database
      .prepare<[], WakeRow>(
        `SELECT r.repository_id, r.run_id, w.generation, w.ack_generation, w.not_before,
                w.reasons_json,
                EXISTS(
                  SELECT 1 FROM supervisor_commands c
                  WHERE c.run_key = w.run_key AND c.state != 'terminal'
                ) AS has_pending_work
         FROM supervisor_wakes w JOIN supervisor_runs r ON r.run_key = w.run_key
         WHERE w.generation > w.ack_generation OR EXISTS(
           SELECT 1 FROM supervisor_commands c
           WHERE c.run_key = w.run_key AND c.state != 'terminal'
         )
         ORDER BY r.repository_id, r.run_id`,
      )
      .all()
      .map((row) => ({ ...wakeFromRow(row), hasPendingWork: row.has_pending_work === 1 }));
  }

  acknowledgeWake(repositoryId: string, runId: string, observedGeneration: number): boolean {
    const runKey = canonicalStringify([
      validateOpaqueIdentity(repositoryId),
      validateOpaqueIdentity(runId),
    ]);
    if (!Number.isSafeInteger(observedGeneration) || observedGeneration < 0) {
      throw new TypeError("observedGeneration must be a non-negative safe integer");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database
        .prepare(
          `UPDATE supervisor_wakes SET ack_generation = ?
           WHERE run_key = ? AND generation = ? AND ack_generation < ?
             AND NOT EXISTS(
               SELECT 1 FROM supervisor_commands c
               WHERE c.run_key = supervisor_wakes.run_key AND c.state != 'terminal'
             )`,
        )
        .run(observedGeneration, runKey, observedGeneration, observedGeneration);
      this.#database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  mode(): SupervisorMode {
    const row = this.#database
      .prepare<[], { desired_mode: string; updated_at: string }>(
        `SELECT desired_mode, updated_at
         FROM supervisor_service_state WHERE singleton = 1`,
      )
      .get();
    if (row === undefined) throw new Error("Supervisor service state is missing");
    return decodeSupervisorServiceRecord({
      mode: row.desired_mode,
      changedAt: row.updated_at,
    }).mode;
  }

  setMode(mode: SupervisorMode, currentTime: string): void {
    const currentTimeMs = timestampToEpoch(currentTime, "currentTime");
    const result = this.#database
      .prepare(
        `UPDATE supervisor_service_state SET desired_mode = ?, updated_at = ?, updated_at_ms = ?
         WHERE singleton = 1 AND updated_at_ms <= ?`,
      )
      .run(mode, currentTime, currentTimeMs, currentTimeMs);
    if (result.changes !== 1) throw new TypeError("Supervisor mode update must not backdate state");
  }

  registerRepository(input: SupervisorRepositoryRegistration): void {
    const repositoryId = validateOpaqueIdentity(input.repositoryId);
    const canonicalPath = resolve(input.canonicalPath);
    const configSnapshotId = validateOpaqueIdentity(input.configSnapshotId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("INSERT OR IGNORE INTO supervisor_repositories(repository_id) VALUES (?)")
        .run(repositoryId);
      this.#database
        .prepare(
          `INSERT INTO supervisor_repository_registry(repository_id, canonical_path, config_snapshot_id)
           VALUES (?, ?, ?)
           ON CONFLICT(repository_id) DO UPDATE SET
             canonical_path = excluded.canonical_path,
             config_snapshot_id = excluded.config_snapshot_id`,
        )
        .run(repositoryId, canonicalPath, configSnapshotId);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  queryRepository(repositoryId: string): SupervisorRepositoryRegistration | undefined {
    const row = this.#database
      .prepare<
        [string],
        { repository_id: string; canonical_path: string; config_snapshot_id: string }
      >(
        `SELECT repository_id, canonical_path, config_snapshot_id
         FROM supervisor_repository_registry WHERE repository_id = ?`,
      )
      .get(validateOpaqueIdentity(repositoryId));
    return row === undefined
      ? undefined
      : Object.freeze({
          repositoryId: row.repository_id,
          canonicalPath: row.canonical_path,
          configSnapshotId: row.config_snapshot_id,
        });
  }

  appendLog(input: {
    readonly recordedAt: string;
    readonly level: SupervisorLogLevel;
    readonly event: string;
    readonly message: string;
    readonly fields: unknown;
  }): SupervisorLogEntry {
    const recordedAtMs = timestampToEpoch(input.recordedAt, "recordedAt");
    if (!["debug", "info", "warn", "error"].includes(input.level)) {
      throw new TypeError("Supervisor log level is invalid");
    }
    const event = sanitizeLogText(input.event, 128);
    const message = sanitizeLogText(input.message, 2_048);
    const fields = sanitizeLogFields(decodeCanonicalJsonValue(input.fields));
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const cursor = this.#database
        .prepare<[], { cursor: number }>(
          "SELECT COALESCE(MAX(cursor), 0) + 1 AS cursor FROM supervisor_logs",
        )
        .get()?.cursor;
      if (cursor === undefined) throw new Error("Supervisor log cursor allocation failed");
      this.#database
        .prepare(
          `INSERT INTO supervisor_logs(cursor, recorded_at, recorded_at_ms, level, event, message, fields_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cursor,
          input.recordedAt,
          recordedAtMs,
          input.level,
          event,
          message,
          canonicalStringify(fields),
        );
      this.#database
        .prepare(
          `DELETE FROM supervisor_logs WHERE cursor <= (
             SELECT COALESCE(MAX(cursor), 0) - ? FROM supervisor_logs
           )`,
        )
        .run(MAX_DURABLE_LOG_ENTRIES);
      this.#database.exec("COMMIT");
      return Object.freeze({
        cursor,
        recordedAt: input.recordedAt,
        level: input.level,
        event,
        message,
        fields,
      });
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  queryLogs(afterCursor = 0, limit = 100): SupervisorLogPage {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
      throw new TypeError("afterCursor is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_024)
      throw new TypeError("limit is invalid");
    const latestCursor =
      this.#database
        .prepare<[], { cursor: number }>(
          "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM supervisor_logs",
        )
        .get()?.cursor ?? 0;
    if (afterCursor > latestCursor) throw new TypeError("afterCursor is ahead of the log");
    const rows = this.#database
      .prepare<[number, number], LogRow>(
        `SELECT cursor, recorded_at, level, event, message, fields_json
         FROM supervisor_logs WHERE cursor > ? ORDER BY cursor LIMIT ?`,
      )
      .all(afterCursor, limit + 1);
    const items = rows.slice(0, limit).map(logFromRow);
    return Object.freeze({
      afterCursor,
      latestCursor,
      hasMore: rows.length > limit,
      items: Object.freeze(items),
    });
  }

  operationalSnapshot(): {
    readonly pending: SupervisorPendingCounts;
    readonly leases: readonly SupervisorLeaseStatus[];
    readonly startedSessionIds: readonly string[];
  } {
    const commandCounts = this.#database
      .prepare<[], { queued: number; claimed: number }>(
        `SELECT
           SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN state = 'claimed' THEN 1 ELSE 0 END) AS claimed
         FROM supervisor_commands`,
      )
      .get() ?? { queued: 0, claimed: 0 };
    const scalar = (sql: string): number =>
      this.#database.prepare<[], { count: number }>(sql).get()?.count ?? 0;
    const leaseRows = this.#database
      .prepare<[], { resource_key: string; owner_id: string; fence: number; expires_at: string }>(
        `SELECT resource_key, owner_id, fence, expires_at FROM leases
         WHERE resource_key LIKE 'runner:%' ORDER BY resource_key`,
      )
      .all();
    const leasesByResource = new Map(leaseRows.map((row) => [row.resource_key, row]));
    const leases = this.#database
      .prepare<[], { repository_id: string; run_id: string }>(
        "SELECT repository_id, run_id FROM supervisor_runs ORDER BY repository_id, run_id",
      )
      .all()
      .flatMap((run) => {
        const resourceKey = this.#leaseResourceKey(run.repository_id, run.run_id);
        const row = leasesByResource.get(resourceKey);
        return row === undefined
          ? []
          : [
              {
                repositoryId: run.repository_id,
                runId: run.run_id,
                ownerId: row.owner_id,
                fence: row.fence,
                expiresAt: row.expires_at,
              },
            ];
      });
    const startedSessionIds = this.#database
      .prepare<[], { dispatch_id: string }>(
        `SELECT DISTINCT json_extract(c.canonical_command, '$.input.dispatchId') AS dispatch_id
         FROM runner_effect_intents i
         JOIN runner_commands c ON c.command_id = i.command_id
         WHERE json_extract(c.canonical_command, '$.kind') = 'worker'
           AND json_type(c.canonical_command, '$.input.dispatchId') = 'text'
           AND NOT EXISTS (
             SELECT 1 FROM runner_effect_outcomes o
             WHERE o.intent_id = i.intent_id
               AND o.status IN ('completed', 'failed', 'cancelled')
           )
         ORDER BY dispatch_id`,
      )
      .all()
      .map((row) => row.dispatch_id);
    return Object.freeze({
      pending: Object.freeze({
        queuedCommands: commandCounts.queued ?? 0,
        claimedCommands: commandCounts.claimed ?? 0,
        wakes: scalar(
          "SELECT COUNT(*) AS count FROM supervisor_wakes WHERE generation > ack_generation",
        ),
        runnerEffects: scalar(
          "SELECT COUNT(*) AS count FROM runner_effect_intents i WHERE NOT EXISTS (SELECT 1 FROM runner_effect_outcomes o WHERE o.intent_id = i.intent_id AND o.status IN ('completed', 'failed', 'cancelled'))",
        ),
        completionOutbox: scalar(
          "SELECT COUNT(*) AS count FROM context_completion_outbox WHERE delivered = 0",
        ),
        amendmentProposalOutbox: scalar(
          "SELECT COUNT(*) AS count FROM context_amendment_outbox WHERE delivered = 0",
        ),
        approvedAmendments: scalar(
          `SELECT COUNT(*) AS count FROM amendment_decisions d
           LEFT JOIN amendment_applications a ON a.amendment_id = d.amendment_id
           WHERE d.decision = 'approve' AND a.amendment_id IS NULL`,
        ),
      }),
      leases: Object.freeze(leases),
      startedSessionIds: Object.freeze(startedSessionIds),
    });
  }

  listRunnableRuns(): readonly { readonly repositoryId: string; readonly runId: string }[] {
    return Object.freeze(
      this.#database
        .prepare<[], { repository_id: string; run_id: string }>(
          `SELECT r.repository_id, r.run_id
           FROM runner_runs r
           LEFT JOIN run_control_state control ON control.run_key = r.run_key
           WHERE ((control.mode IS NULL OR control.mode = 'running') AND EXISTS (
             SELECT 1 FROM runner_commands c
             WHERE c.run_key = r.run_key AND NOT EXISTS (
               SELECT 1 FROM runner_effect_intents i WHERE i.command_id = c.command_id
             )
           )) OR ((control.mode IS NULL OR control.mode IN ('running', 'paused', 'ending')) AND EXISTS (
             SELECT 1 FROM runner_effect_intents i
             WHERE i.run_key = r.run_key AND NOT EXISTS (
               SELECT 1 FROM runner_effect_outcomes o
               WHERE o.intent_id = i.intent_id AND o.status IN ('completed', 'failed', 'cancelled')
             )
           ))
           ORDER BY r.repository_id, r.run_id`,
        )
        .all()
        .map((row) => Object.freeze({ repositoryId: row.repository_id, runId: row.run_id })),
    );
  }

  listPendingAmendmentProposalRuns(): readonly {
    readonly repositoryId: string;
    readonly runId: string;
  }[] {
    return Object.freeze(
      this.#database
        .prepare<[], { repository_id: string; run_id: string }>(
          `SELECT DISTINCT
             json_extract(canonical_source, '$.submission.repositoryId') AS repository_id,
             json_extract(canonical_source, '$.submission.runId') AS run_id
           FROM context_amendment_outbox WHERE delivered = 0
           ORDER BY repository_id, run_id`,
        )
        .all()
        .map((row) => Object.freeze({ repositoryId: row.repository_id, runId: row.run_id })),
    );
  }

  listApprovedAmendmentRecoveries(): readonly ApprovedAmendmentRecovery[] {
    const rows = this.#database
      .prepare<
        [],
        {
          repository_id: string;
          run_id: string;
          amendment_id: string;
          proposal_digest: string;
          decision_digest: string;
          base_graph_revision_digest: string;
          reviewed_graph_revision_digest: string;
          canonical_proposal: string;
        }
      >(
        `SELECT r.repository_id, r.run_id, p.amendment_id, p.proposal_digest,
                d.decision_digest, p.base_graph_revision_digest,
                p.reviewed_graph_revision_digest, p.canonical_proposal
         FROM amendment_proposals p
         JOIN runs r ON r.run_key = p.run_key
         JOIN amendment_decisions d ON d.amendment_id = p.amendment_id
         LEFT JOIN amendment_applications a ON a.amendment_id = p.amendment_id
         WHERE d.decision = 'approve' AND a.amendment_id IS NULL
         ORDER BY r.repository_id, r.run_id, p.amendment_id`,
      )
      .all();
    return Object.freeze(
      rows.flatMap((row) => {
        const review = this.queryAmendment(row.repository_id, row.run_id, row.amendment_id);
        if (review === undefined) {
          throw new Error("Approved amendment lacks its review projection");
        }
        const lifecycle = localRecord(review.lifecycle, "Approved amendment lifecycle");
        if (lifecycle.status !== "approved-awaiting-quiescence") return [];
        const proposal = localRecord(
          decodeCanonicalJsonValue(row.canonical_proposal),
          "Stored amendment proposal",
        );
        const impact = localRecord(proposal.impact, "Stored amendment impact");
        if (!Array.isArray(impact.affectedTaskScopes)) {
          throw new Error("Stored amendment impact lacks affected task scopes");
        }
        const observedQuiescent = impact.affectedTaskScopes.every((value) => {
          const scope = localRecord(value, "Stored amendment task scope");
          if (typeof scope.taskId !== "string" || typeof scope.definitionGeneration !== "number") {
            throw new Error("Stored amendment task scope is invalid");
          }
          const runKey = canonicalStringify([row.repository_id, row.run_id]);
          const liveClaims =
            this.#database
              .prepare<[string, string, number], { count: number }>(
                `SELECT COUNT(*) AS count FROM runner_effect_claims c
               JOIN runner_effect_intents i ON i.intent_id = c.intent_id
               WHERE i.run_key = ?
                 AND json_extract(i.canonical_intent, '$.command.taskScope.taskId') = ?
                 AND json_extract(i.canonical_intent, '$.command.taskScope.definitionGeneration') = ?`,
              )
              .get(runKey, scope.taskId, scope.definitionGeneration)?.count ?? 0;
          const nonterminalEffects =
            this.#database
              .prepare<[string, string, number], { count: number }>(
                `SELECT COUNT(*) AS count FROM runner_effect_intents i
               WHERE i.run_key = ?
                 AND json_extract(i.canonical_intent, '$.command.taskScope.taskId') = ?
                 AND json_extract(i.canonical_intent, '$.command.taskScope.definitionGeneration') = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM runner_effect_outcomes o
                   WHERE o.intent_id = i.intent_id
                     AND o.status IN ('completed', 'failed', 'cancelled')
                 )`,
              )
              .get(runKey, scope.taskId, scope.definitionGeneration)?.count ?? 0;
          return liveClaims === 0 && nonterminalEffects === 0;
        });
        return [
          Object.freeze({
            repositoryId: row.repository_id,
            runId: row.run_id,
            amendmentId: row.amendment_id,
            proposalDigest: row.proposal_digest,
            decisionDigest: row.decision_digest,
            baseGraphRevisionDigest: row.base_graph_revision_digest,
            reviewedResultGraphRevisionDigest: row.reviewed_graph_revision_digest,
            observedQuiescent,
          }),
        ];
      }),
    );
  }

  queueApprovedAmendmentApply(recovery: ApprovedAmendmentRecovery, currentTime: string): boolean {
    if (!recovery.observedQuiescent) return false;
    const attempts = this.#database
      .prepare<[], { canonical_envelope: string; state: SupervisorReceiptStatus }>(
        "SELECT canonical_envelope, state FROM supervisor_commands ORDER BY accepted_sequence",
      )
      .all()
      .filter((row) => {
        const envelope = decodeCommandEnvelope(row.canonical_envelope);
        if (envelope.intent.type !== "apply-approved-amendment") return false;
        const payload = localRecord(envelope.payload, "Apply amendment payload");
        return payload.amendmentId === recovery.amendmentId;
      });
    if (attempts.some(({ state }) => state !== "terminal")) return false;
    const priorAttempts = attempts.length;
    const payload = {
      amendmentId: recovery.amendmentId,
      proposalDigest: recovery.proposalDigest,
      decisionDigest: recovery.decisionDigest,
      reviewedResultGraphRevisionDigest: recovery.reviewedResultGraphRevisionDigest,
    } as const;
    const commandId = `command_amendment-apply-${recovery.proposalDigest.slice(0, 20)}-${priorAttempts + 1}`;
    const envelope = decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId,
      principal: trustedSupervisorPrincipal,
      transport: { kind: "runner", requestId: `request_${commandId}` },
      repositoryId: recovery.repositoryId,
      runId: recovery.runId,
      intent: { type: "apply-approved-amendment" },
      payload,
      payloadDigest: this.dependencies.sha256.digest(canonicalBytes(payload)),
      expectedGraphRevision: recovery.baseGraphRevisionDigest,
      exactObjectDigest: recovery.decisionDigest,
    });
    this.accept({
      envelope,
      createAdmission: () => ({
        currentTime,
        facts: {
          source: "approved-amendment-recovery",
          amendmentId: recovery.amendmentId,
          observedQuiescent: true,
        },
        allocations: [1, 2, 3].map((ordinal) => ({
          kind: "stream-event" as const,
          id: `stream-event-amendment-apply-${recovery.proposalDigest.slice(0, 16)}-${priorAttempts + 1}-${ordinal}`,
        })),
      }),
    });
    return true;
  }

  #claim(runKey: string, input: DrainRunOnceInput): CommandRow | undefined {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (this.mode() !== "running") {
        this.#database.exec("COMMIT");
        return undefined;
      }
      this.#assertLease(input.lease, input.currentTime);
      const currentTimeMs = timestampToEpoch(input.currentTime, "currentTime");
      const claimExpiresAtMs = timestampToEpoch(input.lease.expiresAt, "lease.expiresAt");
      const command = this.#database
        .prepare<[string, number, number], CommandRow>(
          `SELECT command_id, run_key, canonical_envelope, canonical_admission, state,
                  claim_owner_id, claim_fence, claim_expires_at, claim_expires_at_ms,
                  terminal_receipt_json
           FROM supervisor_commands
           WHERE run_key = ? AND (
             state = 'queued' OR (state = 'claimed' AND (
               claim_fence < ? OR claim_expires_at_ms <= ?
             ))
           )
           ORDER BY accepted_sequence LIMIT 1`,
        )
        .get(runKey, input.lease.fence, currentTimeMs);
      if (command === undefined) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const update = this.#database
        .prepare(
          `UPDATE supervisor_commands SET state = 'claimed', claim_owner_id = ?,
             claim_fence = ?, claim_expires_at = ?, claim_expires_at_ms = ?
           WHERE command_id = ? AND run_key = ? AND state = ?
             AND claim_owner_id IS ? AND claim_fence IS ?
             AND claim_expires_at IS ? AND claim_expires_at_ms IS ?`,
        )
        .run(
          input.lease.ownerId,
          input.lease.fence,
          input.lease.expiresAt,
          claimExpiresAtMs,
          command.command_id,
          command.run_key,
          command.state,
          command.claim_owner_id,
          command.claim_fence,
          command.claim_expires_at,
          command.claim_expires_at_ms,
        );
      if (update.changes !== 1) {
        throw new StaleLeaseFenceError(input.lease.resourceKey, input.lease.fence);
      }
      if (command.state === "queued") {
        const envelope = decodeCommandEnvelope(command.canonical_envelope);
        this.#appendReceipt(
          runKey,
          command.command_id,
          envelope.repositoryId,
          envelope.runId,
          "claimed",
          input.currentTime,
        );
      }
      this.#database.exec("COMMIT");
      return { ...command, state: "claimed" };
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #ackTerminal(
    command: CommandRow,
    input: DrainRunOnceInput,
    terminal: DurableReceipt,
  ): SupervisorReceipt {
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      this.#assertLease(input.lease, input.currentTime);
      const current = this.#database
        .prepare<[string], CommandRow>(
          `SELECT command_id, run_key, canonical_envelope, canonical_admission, state,
              claim_owner_id, claim_fence, claim_expires_at, claim_expires_at_ms,
              terminal_receipt_json
           FROM supervisor_commands WHERE command_id = ?`,
        )
        .get(command.command_id);
      if (current?.state === "terminal") {
        const replay = this.#requiredLatestReceipt(command.command_id);
        this.#database.exec("COMMIT");
        return replay;
      }
      if (
        current === undefined ||
        current.state !== "claimed" ||
        current.claim_owner_id !== input.lease.ownerId ||
        current.claim_fence !== input.lease.fence ||
        current.claim_expires_at !== input.lease.expiresAt
      ) {
        throw new StaleLeaseFenceError(input.lease.resourceKey, input.lease.fence);
      }
      const envelope = decodeCommandEnvelope(current.canonical_envelope);
      const admission = parseAdmission(current.canonical_admission);
      const receipt = this.#appendReceipt(
        current.run_key,
        current.command_id,
        envelope.repositoryId,
        envelope.runId,
        "terminal",
        admission.currentTime,
        terminal,
      );
      this.#database
        .prepare(
          `UPDATE supervisor_commands SET state = 'terminal', claim_owner_id = NULL,
             claim_fence = NULL, claim_expires_at = NULL, claim_expires_at_ms = NULL,
             terminal_receipt_json = ?
           WHERE command_id = ?`,
        )
        .run(canonicalStringify(terminal), current.command_id);
      this.#database
        .prepare(
          `UPDATE supervisor_wakes SET ack_generation = generation
           WHERE run_key = ? AND NOT EXISTS(
             SELECT 1 FROM supervisor_commands c
             WHERE c.run_key = supervisor_wakes.run_key AND c.state != 'terminal'
           )`,
        )
        .run(current.run_key);
      this.#fault("before-terminal-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#eventNotifier?.notify(envelope.repositoryId, envelope.runId);
      this.#fault("after-terminal-commit-before-ack");
      return receipt;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #appendReceipt(
    runKey: string,
    commandId: string,
    repositoryId: string,
    runId: string,
    status: SupervisorReceiptStatus,
    recordedAt: string,
    terminalReceipt?: DurableReceipt,
  ): SupervisorReceipt {
    const recordedAtMs = timestampToEpoch(recordedAt, "recordedAt");
    const sequence = this.#nextReceiptSequence(runKey);
    const receipt: SupervisorReceipt = {
      sequence,
      commandId,
      repositoryId,
      runId,
      status,
      recordedAt,
      ...(terminalReceipt === undefined ? {} : { terminalReceipt }),
    };
    const canonicalReceipt = canonicalStringify(receipt);
    this.#database
      .prepare(
        `INSERT INTO supervisor_receipts(
            run_key, sequence, command_id, status, recorded_at, recorded_at_ms, canonical_receipt
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runKey, sequence, commandId, status, recordedAt, recordedAtMs, canonicalReceipt);
    return receipt;
  }

  #requiredLatestReceipt(commandId: string): SupervisorReceipt {
    const receipt = this.#latestReceipt(commandId);
    if (receipt === undefined) {
      throw new Error("Supervisor command is missing its staged receipt");
    }
    return receipt;
  }

  #latestReceipt(commandId: string): SupervisorReceipt | undefined {
    const row = this.#database
      .prepare<[string], ReceiptRow>(
        `SELECT canonical_receipt FROM supervisor_receipts
         WHERE command_id = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(commandId);
    if (row === undefined) return undefined;
    return parseSupervisorReceipt(row.canonical_receipt);
  }

  #nextAcceptedSequence(runKey: string): number {
    const row = this.#database
      .prepare<[string], { next_sequence: number }>(
        `SELECT coalesce(max(accepted_sequence), 0) + 1 AS next_sequence
         FROM supervisor_commands WHERE run_key = ?`,
      )
      .get(runKey);
    return row?.next_sequence ?? 1;
  }

  #nextReceiptSequence(runKey: string): number {
    const row = this.#database
      .prepare<[string], { next_sequence: number }>(
        `SELECT coalesce(max(sequence), 0) + 1 AS next_sequence
         FROM supervisor_receipts WHERE run_key = ?`,
      )
      .get(runKey);
    return row?.next_sequence ?? 1;
  }

  #assertNotBackdated(runKey: string, currentTimeMs: number): void {
    const row = this.#database
      .prepare<[string], { latest: number | null }>(
        "SELECT max(accepted_at_ms) AS latest FROM supervisor_commands WHERE run_key = ?",
      )
      .get(runKey);
    if (row?.latest !== null && row?.latest !== undefined && row.latest > currentTimeMs) {
      throw new TypeError("Supervisor acceptance must not backdate run state");
    }
  }

  #assertLease(lease: LeaseGrant, currentTime: string): void {
    validateTimestamp(currentTime, "currentTime");
    const row = this.#database
      .prepare<[string], { owner_id: string; fence: number; expires_at: string }>(
        "SELECT owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(lease.resourceKey);
    if (
      row === undefined ||
      row.owner_id !== lease.ownerId ||
      row.fence !== lease.fence ||
      row.expires_at !== lease.expiresAt ||
      Date.parse(currentTime) >= Date.parse(row.expires_at)
    ) {
      throw new StaleLeaseFenceError(lease.resourceKey, lease.fence);
    }
  }

  #leaseResourceKey(repositoryId: string, runId: string): string {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const digest = this.dependencies.sha256.digest(canonicalBytes([repositoryId, runId]));
    return `runner:${digest}`;
  }

  #wakeRow(repositoryId: string, runId: string): WakeRow | undefined {
    const runKey = canonicalStringify([
      validateOpaqueIdentity(repositoryId),
      validateOpaqueIdentity(runId),
    ]);
    return this.#database
      .prepare<[string], WakeRow>(
        `SELECT r.repository_id, r.run_id, w.generation, w.ack_generation, w.not_before,
                w.reasons_json,
                EXISTS(
                  SELECT 1 FROM supervisor_commands c
                  WHERE c.run_key = w.run_key AND c.state != 'terminal'
                ) AS has_pending_work
         FROM supervisor_wakes w JOIN supervisor_runs r ON r.run_key = w.run_key
         WHERE w.run_key = ?`,
      )
      .get(runKey);
  }

  #fault(point: SupervisorFaultPoint): void {
    this.#faultInjector?.(point);
  }
}

const trustedSupervisorPrincipal = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "amendment-recovery",
  tenant: "local",
  assurance: "hardware-backed",
  roles: ["trusted-supervisor"],
});

function localRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function logFromRow(row: LogRow): SupervisorLogEntry {
  return Object.freeze({
    cursor: row.cursor,
    recordedAt: row.recorded_at,
    level: row.level,
    event: row.event,
    message: row.message,
    fields: decodeCanonicalJsonValue(row.fields_json),
  });
}

function sanitizeLogText(value: string, maximumLength: number): string {
  if (typeof value !== "string") throw new TypeError("Supervisor log text must be a string");
  const sanitized = stripAnsiSequences(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
    .split("")
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("")
    .slice(0, maximumLength);
  if (sanitized.length === 0) throw new TypeError("Supervisor log text must not be empty");
  return sanitized;
}

function stripAnsiSequences(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    output += value[index];
  }
  return output;
}

function sanitizeLogFields(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sanitizeLogFields);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /(?:authorization|credential|password|secret|token)/iu.test(key)
          ? "[redacted]"
          : sanitizeLogFields(child),
      ]),
    ) as Record<string, JsonValue>;
  }
  return value;
}

function normalizeAdmission(input: SupervisorAdmissionFacts): SupervisorAdmissionFacts {
  return decodeSupervisorAdmissionFacts(input);
}

function parseAdmission(canonical: string): SupervisorAdmissionFacts {
  return decodeSupervisorAdmissionFacts(canonical);
}

function parseSupervisorReceipt(canonical: string): SupervisorReceipt {
  return decodeSupervisorReceipt(canonical);
}

function wakeFromRow(row: WakeRow): SupervisorWake {
  return decodeSupervisorWake({
    repositoryId: row.repository_id,
    runId: row.run_id,
    generation: row.generation,
    acknowledgedGeneration: row.ack_generation,
    notBefore: row.not_before,
    reasons: JSON.parse(row.reasons_json),
  });
}

function validateTimestamp(value: string, subject: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== (value.includes(".") ? value : value.replace("Z", ".000Z"))
  ) {
    throw new TypeError(`${subject} must be an exact UTC timestamp`);
  }
}

function timestampToEpoch(value: string, subject: string): number {
  validateTimestamp(value, subject);
  return Date.parse(value);
}
