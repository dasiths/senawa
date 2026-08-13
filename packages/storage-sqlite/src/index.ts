import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest, canonicalValue, isSha256Digest } from "@senawa/kernel";
import {
  canonicalStringify,
  type DurableReceipt,
  type EventStreamFrame,
  type ProjectionEnvelope,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import {
  type AdmissionFacts,
  type ClaimEffectAttemptRequest,
  type ClaimEffectAttemptResult,
  type CommandServicePort,
  type CommitEffectRequest,
  type EffectIntent,
  type EffectOutcome,
  type FencedRunnerCancellationInput,
  type FencedRunnerContextUpdateInput,
  type FinalizedEffectUsage,
  InMemoryAuthority,
  type InMemoryRunnerRunInput,
  type PersistIntentRequest,
  type PersistIntentResult,
  type QueuedEffectCommand,
  type RunnerAuthorityPort,
  type RunnerAuthoritySnapshot,
  type RunnerBudgetState,
  type RunnerEffectEvent,
  type RunnerEffectReceipt,
  type RunnerEscalation,
  type RunnerLeaseFact,
  type RunnerProjection,
  type RunOnceInput,
  type RuntimeAuthorityRun,
  RuntimeCommandService,
  type RuntimeDependencies,
  type RuntimeQueryPort,
  type SerializableAuthorityPort,
  selectEffectAttemptAction,
} from "@senawa/runtime";
import Database from "better-sqlite3";

const CURRENT_SCHEMA_VERSION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT_PAGES = 16_384;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

export type SqliteFaultPoint =
  | "after-command-execution"
  | "before-command-commit"
  | "after-command-commit-before-ack"
  | "after-asset-stage"
  | "after-asset-install"
  | "before-asset-descriptor-commit"
  | "after-asset-descriptor-commit-before-ack";

export interface SqliteAuthorityOptions {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SqliteFaultPoint) => void;
}

export interface AssetDescriptor {
  readonly digest: string;
  readonly byteLength: number;
  readonly relativePath: string;
  readonly mediaType?: string;
}

export interface LeaseGrant {
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export interface AcquireLeaseInput {
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly currentTime: string;
  readonly expiresAt: string;
}

export interface CancellationPlaceholderInput {
  readonly requestId: string;
  readonly runId: string;
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly requestedAt: string;
  readonly currentTime: string;
}

export type SqliteRunnerFaultPoint =
  | "before-intent-commit"
  | "after-intent-commit-before-ack"
  | "before-outcome-commit"
  | "after-outcome-commit-before-ack";

export interface SqliteRunnerAuthorityOptions {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SqliteRunnerFaultPoint) => void;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AuthorityRow {
  readonly revision: number;
  readonly canonical_json: string;
}

interface AssetRow {
  readonly digest: string;
  readonly byte_length: number;
  readonly media_type: string | null;
  readonly relative_path: string;
}

interface BackupManifest {
  readonly format: "senawa-sqlite-backup";
  readonly version: 1;
  readonly database: {
    readonly relativePath: "authority.db";
    readonly byteLength: number;
    readonly digest: string;
  };
  readonly assets: readonly AssetDescriptor[];
}

interface LeaseRow {
  readonly resource_key: string;
  readonly owner_id: string;
  readonly fence: number;
  readonly expires_at: string;
}

interface SnapshotCommand {
  readonly commandId: string;
  readonly canonicalEnvelope: string;
  readonly receipt: DurableReceipt;
  readonly admission: unknown;
}

interface SnapshotRun {
  readonly repositoryId: string;
  readonly runId: string;
  readonly cursor: number;
  readonly commands: readonly SnapshotCommand[];
  readonly receiptHistory: readonly DurableReceipt[];
  readonly events: readonly EventStreamFrame[];
  readonly records?: unknown;
  readonly projectionGeneratedAt?: string;
}

interface AuthoritySnapshot {
  readonly version: string;
  readonly runs: readonly SnapshotRun[];
}

interface CanonicalRunFragments {
  readonly repositoryId: string;
  readonly runId: string;
  readonly commands: Map<string, string>;
  readonly receiptHistory: string[];
  readonly events: string[];
  cursor: number;
  records?: string;
  projectionGeneratedAt?: string;
}

interface NormalizedSnapshot {
  readonly repositories: readonly Record<string, unknown>[];
  readonly runs: readonly Record<string, unknown>[];
  readonly commands: readonly Record<string, unknown>[];
  readonly receiptHistory: readonly Record<string, unknown>[];
  readonly eventFrames: readonly Record<string, unknown>[];
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(version: number) {
    super(
      `SQLite authority schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class StaleAuthorityRevisionError extends Error {
  constructor(expectedRevision: number) {
    super(`SQLite authority revision no longer matches expected revision ${expectedRevision}`);
    this.name = "StaleAuthorityRevisionError";
  }
}

export class LeaseUnavailableError extends Error {
  constructor(resourceKey: string) {
    super(`Lease ${resourceKey} is held by another live owner`);
    this.name = "LeaseUnavailableError";
  }
}

export class StaleLeaseFenceError extends Error {
  constructor(resourceKey: string, fence: number) {
    super(`Lease ${resourceKey} no longer accepts fence ${fence}`);
    this.name = "StaleLeaseFenceError";
  }
}

export class SqliteAuthority
  implements CommandServicePort, RuntimeQueryPort, SerializableAuthorityPort
{
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: SqliteFaultPoint) => void) | undefined;
  #cachedAuthority: InMemoryAuthority;
  #cachedCanonicalSnapshot: IncrementalCanonicalSnapshot;
  #cachedService: RuntimeCommandService;
  #cachedRevision: number;

  constructor(options: SqliteAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.assetDirectory = resolve(options.assetDirectory);
    this.dependencies = options.dependencies;
    this.#faultInjector = options.faultInjector;
    ensureSafeDirectoryPath(dirname(this.databasePath));
    ensureSafeDirectoryPath(this.assetDirectory);
    fsyncDirectory(this.assetDirectory);
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
      verifyDatabase(this.#database, this.dependencies, this.assetDirectory, true);
      const state = this.#readAuthorityRow();
      this.#cachedAuthority = InMemoryAuthority.fromCanonicalJson(
        state.canonical_json,
        this.dependencies,
      );
      this.#cachedCanonicalSnapshot = IncrementalCanonicalSnapshot.fromCanonicalJson(
        state.canonical_json,
      );
      this.#cachedService = new RuntimeCommandService(this.dependencies, this.#cachedAuthority);
      this.#cachedRevision = state.revision;
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  submit(input: string | unknown, admission: AdmissionFacts): DurableReceipt {
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const before = this.#readAuthorityRow();
      if (before.revision !== this.#cachedRevision) {
        this.#cachedAuthority = InMemoryAuthority.fromCanonicalJson(
          before.canonical_json,
          this.dependencies,
        );
        this.#cachedCanonicalSnapshot = IncrementalCanonicalSnapshot.fromCanonicalJson(
          before.canonical_json,
        );
        this.#cachedService = new RuntimeCommandService(this.dependencies, this.#cachedAuthority);
        this.#cachedRevision = before.revision;
      }
      const receipt = this.#cachedService.submit(input, admission);
      let after = before.canonical_json;
      if (!this.#cachedCanonicalSnapshot.hasCommand(receipt.commandId)) {
        const run = this.#cachedAuthority.runs.get(
          runtimeAuthorityRunKey(receipt.repositoryId, receipt.runId),
        );
        if (run === undefined) {
          throw new TypeError("Submitted command run is missing from the authority cache");
        }
        after = this.#cachedCanonicalSnapshot.appendCommand(run, receipt.commandId);
      }
      this.#fault("after-command-execution");
      if (after !== before.canonical_json) {
        const run = this.#cachedAuthority.runs.get(
          runtimeAuthorityRunKey(receipt.repositoryId, receipt.runId),
        );
        if (run === undefined) {
          throw new TypeError("Submitted command run is missing from the authority cache");
        }
        persistCommandDelta(
          this.#database,
          receipt,
          run,
          after,
          before.revision,
          this.dependencies,
        );
        this.#cachedRevision = before.revision + 1;
      }
      this.#fault("before-command-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-command-commit-before-ack");
      return receipt;
    } catch (error) {
      if (!committed) {
        if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
        const current = this.#readAuthorityRow();
        this.#cachedAuthority = InMemoryAuthority.fromCanonicalJson(
          current.canonical_json,
          this.dependencies,
        );
        this.#cachedCanonicalSnapshot = IncrementalCanonicalSnapshot.fromCanonicalJson(
          current.canonical_json,
        );
        this.#cachedService = new RuntimeCommandService(this.dependencies, this.#cachedAuthority);
        this.#cachedRevision = current.revision;
      }
      throw error;
    }
  }

  queryReceipt(commandId: string): DurableReceipt | undefined {
    return this.#readService().queryReceipt(commandId);
  }

  queryReceiptHistory(repositoryId: string, runId: string): readonly DurableReceipt[] {
    return this.#readService().queryReceiptHistory(repositoryId, runId);
  }

  queryEvents(repositoryId: string, runId: string, afterCursor = 0): readonly EventStreamFrame[] {
    return this.#readService().queryEvents(repositoryId, runId, afterCursor);
  }

  queryProjection(repositoryId: string, runId: string): ProjectionEnvelope | undefined {
    return this.#readService().queryProjection(repositoryId, runId);
  }

  toCanonicalJson(): string {
    const serialized = this.#readAuthorityRow().canonical_json;
    InMemoryAuthority.fromCanonicalJson(serialized, this.dependencies);
    return serialized;
  }

  revision(): number {
    return this.#readAuthorityRow().revision;
  }

  compareAndSwapSnapshot(expectedRevision: number, canonicalJson: string): number {
    const authority = InMemoryAuthority.fromCanonicalJson(canonicalJson, this.dependencies);
    const validated = authority.toCanonicalJson();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      persistSnapshot(
        this.#database,
        parseSnapshot(validated),
        validated,
        expectedRevision,
        this.dependencies,
      );
      this.#database.exec("COMMIT");
      return expectedRevision + 1;
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  acquireLease(input: AcquireLeaseInput): LeaseGrant {
    return acquireLeaseTransaction(this.#database, input);
  }

  recordCancellationPlaceholder(input: CancellationPlaceholderInput): void {
    validateStorageIdentifier(input.requestId, "requestId");
    validateStorageIdentifier(input.runId, "runId");
    validateStorageIdentifier(input.resourceKey, "resourceKey");
    validateStorageIdentifier(input.ownerId, "ownerId");
    if (!Number.isSafeInteger(input.fence) || input.fence <= 0) {
      throw new TypeError("fence must be a positive safe integer");
    }
    validateTimestamp(input.requestedAt, "requestedAt");
    validateTimestamp(input.currentTime, "currentTime");
    if (Date.parse(input.requestedAt) > Date.parse(input.currentTime)) {
      throw new TypeError("requestedAt must not be later than currentTime");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.#database
        .prepare<[string], LeaseRow>(
          "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
        )
        .get(input.resourceKey);
      if (
        lease === undefined ||
        lease.owner_id !== input.ownerId ||
        lease.fence !== input.fence ||
        Date.parse(lease.expires_at) <= Date.parse(input.currentTime)
      ) {
        throw new StaleLeaseFenceError(input.resourceKey, input.fence);
      }
      const result = this.#database
        .prepare(
          `INSERT INTO cancellation_requests(
             request_id, run_key, resource_key, owner_id, fence, requested_at
           )
           SELECT ?, runs.run_key, ?, ?, ?, ? FROM runs
           WHERE runs.run_id = ? AND runs.records_json IS NOT NULL`,
        )
        .run(
          input.requestId,
          input.resourceKey,
          input.ownerId,
          input.fence,
          input.requestedAt,
          input.runId,
        );
      if (result.changes !== 1) {
        throw new StaleLeaseFenceError(input.resourceKey, input.fence);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  putAsset(bytes: Uint8Array, mediaType?: string): AssetDescriptor {
    const digest = this.dependencies.sha256.digest(bytes);
    if (!isSha256Digest(digest)) {
      throw new TypeError("SHA-256 implementations must return lowercase hexadecimal digests");
    }
    const relativePath = join("sha256", digest.slice(0, 2), digest);
    const destination = resolveAssetPath(this.assetDirectory, relativePath);
    const stagingDirectory = join(this.assetDirectory, ".staging");
    ensureSafeDirectoryPath(stagingDirectory, this.assetDirectory);
    ensureSafeDirectoryPath(dirname(destination), this.assetDirectory);
    const staged = join(stagingDirectory, randomUUID());
    const descriptor: AssetDescriptor = {
      digest,
      byteLength: bytes.byteLength,
      relativePath,
      ...(mediaType === undefined ? {} : { mediaType }),
    };
    let stagedExists = false;
    try {
      const file = openSync(staged, "wx", 0o600);
      try {
        writeFileSync(file, bytes);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      stagedExists = true;
      this.#fault("after-asset-stage");
      try {
        linkSync(staged, destination);
        fsyncDirectory(dirname(destination));
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        verifyAssetBytes(destination, descriptor, this.dependencies);
      }
      unlinkSync(staged);
      fsyncDirectory(stagingDirectory);
      stagedExists = false;
      verifyAssetBytes(destination, descriptor, this.dependencies);
      this.#fault("after-asset-install");

      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#database
          .prepare<[string], AssetRow>(
            "SELECT digest, byte_length, media_type, relative_path FROM assets WHERE digest = ?",
          )
          .get(digest);
        if (current === undefined) {
          this.#database
            .prepare(
              "INSERT INTO assets(digest, byte_length, media_type, relative_path) VALUES (?, ?, ?, ?)",
            )
            .run(digest, bytes.byteLength, mediaType ?? null, relativePath);
        } else {
          assertSameDescriptor(current, descriptor);
        }
        this.#fault("before-asset-descriptor-commit");
        this.#database.exec("COMMIT");
      } catch (error) {
        if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
        throw error;
      }
      this.#fault("after-asset-descriptor-commit-before-ack");
      return descriptor;
    } finally {
      if (stagedExists) {
        rmSync(staged, { force: true });
        fsyncDirectory(stagingDirectory);
      }
    }
  }

  getAsset(digest: string): Uint8Array | undefined {
    const row = this.#database
      .prepare<[string], AssetRow>(
        "SELECT digest, byte_length, media_type, relative_path FROM assets WHERE digest = ?",
      )
      .get(digest);
    if (row === undefined) return undefined;
    const descriptor = toAssetDescriptor(row);
    const path = resolveAssetPath(this.assetDirectory, descriptor.relativePath);
    return Uint8Array.from(verifyAssetBytes(path, descriptor, this.dependencies));
  }

  async backup(destinationPath: string): Promise<void> {
    const destination = resolve(destinationPath);
    assertSafeBackupDestination(destination, this.databasePath, this.assetDirectory);
    const partial = `${destination}.partial-${randomUUID()}`;
    mkdirDurably(partial);
    const databasePath = join(partial, "authority.db");
    const assetDirectory = join(partial, "assets");
    ensureSafeDirectoryPath(assetDirectory, partial);
    this.#database.pragma("wal_checkpoint(PASSIVE)");
    try {
      await this.#database.backup(databasePath);
      fsyncFile(databasePath);
      const verification = openReadConnection(databasePath);
      let assets: readonly AssetDescriptor[];
      try {
        verifyDatabase(verification, this.dependencies, this.assetDirectory, true);
        assets = readAssetDescriptors(verification);
      } finally {
        verification.close();
      }
      copyAssetSet(assets, this.assetDirectory, assetDirectory, this.dependencies);
      const databaseBytes = readRegularFile(databasePath);
      const manifest: BackupManifest = {
        format: "senawa-sqlite-backup",
        version: 1,
        database: {
          relativePath: "authority.db",
          byteLength: databaseBytes.byteLength,
          digest: this.dependencies.sha256.digest(databaseBytes),
        },
        assets,
      };
      writeExclusiveFile(join(partial, "manifest.json"), canonicalStringify(manifest));
      verifyBackupBundle(partial, this.dependencies);
      fsyncDirectory(assetDirectory);
      fsyncDirectory(partial);
      publishBackupBundleNoReplace(partial, destination);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  #readAuthorityRow(): AuthorityRow {
    const row = this.#database
      .prepare<[], AuthorityRow>(
        "SELECT revision, canonical_json FROM authority_state WHERE singleton = 1",
      )
      .get();
    if (row === undefined) throw new Error("SQLite authority singleton is missing");
    return row;
  }

  #readService(): RuntimeCommandService {
    const authority = InMemoryAuthority.fromCanonicalJson(
      this.#readAuthorityRow().canonical_json,
      this.dependencies,
    );
    return new RuntimeCommandService(this.dependencies, authority);
  }

  #fault(point: SqliteFaultPoint): void {
    this.#faultInjector?.(point);
  }
}

export class SqliteRunnerAuthority implements RunnerAuthorityPort {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: SqliteRunnerFaultPoint) => void) | undefined;

  constructor(options: SqliteRunnerAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = options.dependencies;
    this.#faultInjector = options.faultInjector;
    ensureSafeDirectoryPath(dirname(this.databasePath));
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  configureRun(input: InMemoryRunnerRunInput): void {
    validateRunnerIdentity(input.repositoryId, "repositoryId");
    validateRunnerIdentity(input.runId, "runId");
    validateRunnerDigest(input.contextDigest, "contextDigest");
    validateRunnerLease(input.lease);
    const budgets = new Map<string, number>();
    for (const budget of input.budgets) {
      validateRunnerUnit(budget.unit);
      validateRunnerAmount(budget.limit, "budget limit");
      if (budgets.has(budget.unit)) throw new TypeError("Runner budget units must be unique");
      budgets.set(budget.unit, budget.limit);
    }
    const runKey = runnerRunKey(input.repositoryId, input.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          `INSERT INTO runner_runs(
             run_key, repository_id, run_id, context_digest, cursor
           ) VALUES (?, ?, ?, ?, 0)`,
        )
        .run(runKey, input.repositoryId, input.runId, input.contextDigest);
      const insertBudget = this.#database.prepare(
        `INSERT INTO runner_budgets(
           run_key, unit, budget_limit, reserved, spent, unreported
         ) VALUES (?, ?, ?, 0, 0, 0)`,
      );
      for (const [unit, limit] of budgets) insertBudget.run(runKey, unit, limit);
      this.#database
        .prepare("INSERT INTO runner_projections(run_key, canonical_projection) VALUES (?, ?)")
        .run(
          runKey,
          canonicalStringify({ cursor: 0, contextDigest: input.contextDigest, effects: [] }),
        );
      this.#configureLease(runKey, input.lease);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      if (isSqliteConstraint(error)) throw new TypeError("Runner run is already configured");
      throw error;
    }
  }

  enqueue(command: QueuedEffectCommand): void {
    validateRunnerCommand(command);
    const stored = snapshotRunnerValue(command);
    const runKey = runnerRunKey(command.repositoryId, command.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#requireRunnerRun(command.repositoryId, command.runId);
      this.#database
        .prepare(
          `INSERT INTO runner_commands(
             command_id, run_key, operation_id, sequence, canonical_command
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          stored.commandId,
          runKey,
          stored.operationId,
          stored.sequence,
          canonicalStringify(stored),
        );
      this.#appendTransition(stored, "queued", stored.queuedAt, undefined, { kind: stored.kind });
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      if (isSqliteConstraint(error)) {
        throw new TypeError("Runner command or operation identity is already queued or started");
      }
      throw error;
    }
  }

  load(input: { readonly repositoryId: string; readonly runId: string }): RunnerAuthoritySnapshot {
    const run = this.#requireRunnerRun(input.repositoryId, input.runId);
    const commands = this.#database
      .prepare<[string], { canonical_command: string }>(
        `SELECT canonical_command FROM runner_commands
         WHERE run_key = ? ORDER BY sequence, command_id`,
      )
      .all(run.run_key)
      .map((row) => parseRunnerValue<QueuedEffectCommand>(row.canonical_command));
    const effects = this.#database
      .prepare<
        [string],
        {
          intent_id: string;
          canonical_intent: string;
          canonical_outcome: string | null;
          requested_at: string | null;
        }
      >(
        `SELECT i.intent_id, i.canonical_intent,
                (SELECT o.canonical_outcome FROM runner_effect_outcomes o
                 WHERE o.intent_id = i.intent_id ORDER BY o.commit_cursor DESC LIMIT 1)
                  AS canonical_outcome,
                c.requested_at
         FROM runner_effect_intents i
         LEFT JOIN runner_cancellation_requests c ON c.intent_id = i.intent_id
         WHERE i.run_key = ? ORDER BY i.intent_id`,
      )
      .all(run.run_key)
      .map((row) =>
        deepFreezeRunnerValue({
          intent: parseRunnerValue<EffectIntent>(row.canonical_intent),
          ...(row.canonical_outcome === null
            ? {}
            : { outcome: parseRunnerValue<EffectOutcome>(row.canonical_outcome) }),
          ...(row.requested_at === null ? {} : { cancellationRequestedAt: row.requested_at }),
        }),
      );
    const escalations = this.#database
      .prepare<[string], { canonical_escalation: string }>(
        `SELECT canonical_escalation FROM runner_escalations
         WHERE run_key = ? ORDER BY command_id`,
      )
      .all(run.run_key)
      .map((row) => parseRunnerValue<RunnerEscalation>(row.canonical_escalation));
    return deepFreezeRunnerValue({
      repositoryId: run.repository_id,
      runId: run.run_id,
      contextDigest: run.context_digest,
      queuedCommands: commands,
      effects,
      escalations,
    });
  }

  assertLease(input: RunOnceInput): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(input.repositoryId, input.runId);
      this.#assertRunnerFence(run.run_key, input.lease, input.currentTime);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimEffectAttempt(request: ClaimEffectAttemptRequest): ClaimEffectAttemptResult {
    validateRunnerAttempt(request);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(request.repositoryId, request.runId);
      this.#assertRunnerFence(run.run_key, request.lease, request.currentTime);
      if (request.contextDigest !== run.context_digest) {
        throw new TypeError("Runner context changed before effect attempt claim");
      }
      const intentRow = this.#database
        .prepare<[string, string], { canonical_intent: string }>(
          `SELECT canonical_intent FROM runner_effect_intents
           WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (
        intentRow === undefined ||
        intentRow.canonical_intent !== canonicalStringify(request.intent)
      ) {
        throw new TypeError("Effect claim does not match the durable intent in this run");
      }
      const replay = this.#database
        .prepare<[string, string, string], { canonical_outcome: string }>(
          `SELECT o.canonical_outcome
           FROM runner_effect_intents i
           JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
           WHERE i.run_key = ? AND i.intent_id = ? AND o.attempt_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId, request.attemptId);
      if (replay !== undefined) {
        this.#database.exec("COMMIT");
        return { type: "replay", outcome: parseRunnerValue(replay.canonical_outcome) };
      }
      const effect = this.load({
        repositoryId: request.repositoryId,
        runId: request.runId,
      }).effects.find(
        ({ intent }) => intent.command.operationId === request.intent.command.operationId,
      );
      if (effect === undefined) throw new TypeError("Runner effect intent is not configured");
      if (effect.outcome !== undefined && isRunnerTerminal(effect.outcome.status)) {
        this.#database.exec("COMMIT");
        return { type: "replay", outcome: effect.outcome };
      }
      const action = selectEffectAttemptAction(effect, request.currentTime, request.attemptId);
      const existing = this.#database
        .prepare<[string, string], { owner_id: string; fence: number }>(
          `SELECT owner_id, fence FROM runner_effect_claims
           WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (existing !== undefined && existing.fence === request.lease.fence) {
        this.#database.exec("COMMIT");
        return { type: "busy" };
      }
      this.#database
        .prepare("DELETE FROM runner_effect_claims WHERE intent_id = ?")
        .run(request.intent.command.operationId);
      this.#database
        .prepare(
          `INSERT INTO runner_effect_claims(
             intent_id, run_key, owner_id, fence, attempt_id, context_digest, origin
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.intent.command.operationId,
          run.run_key,
          request.lease.owner,
          request.lease.fence,
          request.attemptId,
          request.contextDigest,
          action,
        );
      this.#database.exec("COMMIT");
      return { type: "claimed", action, effect };
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  persistIntent(request: PersistIntentRequest): PersistIntentResult {
    validateRunnerAttempt(request);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const run = this.#requireRunnerRun(request.repositoryId, request.runId);
      this.#assertRunnerFence(run.run_key, request.lease, request.currentTime);
      const commandRow = this.#database
        .prepare<[string, string], { canonical_command: string }>(
          `SELECT canonical_command FROM runner_commands
           WHERE run_key = ? AND command_id = ?`,
        )
        .get(run.run_key, request.command.commandId);
      if (
        commandRow === undefined ||
        commandRow.canonical_command !== canonicalStringify(request.command)
      ) {
        throw new TypeError("Runner intent command is not the exact durable queued command");
      }
      const command = parseRunnerValue<QueuedEffectCommand>(commandRow.canonical_command);
      const existing = this.#database
        .prepare<[string], { canonical_intent: string }>(
          "SELECT canonical_intent FROM runner_effect_intents WHERE intent_id = ?",
        )
        .get(command.operationId);
      if (existing !== undefined) {
        this.#database.exec("COMMIT");
        committed = true;
        return { type: "persisted", intent: parseRunnerValue(existing.canonical_intent) };
      }
      const existingEscalation = this.#database
        .prepare<[string], { canonical_escalation: string }>(
          "SELECT canonical_escalation FROM runner_escalations WHERE command_id = ?",
        )
        .get(command.commandId);
      if (existingEscalation !== undefined) {
        this.#database.exec("COMMIT");
        committed = true;
        return {
          type: "escalated",
          escalation: parseRunnerValue(existingEscalation.canonical_escalation),
        };
      }
      if (command.contextDigest !== run.context_digest) {
        throw new TypeError("Runner command context is stale before effect intent persistence");
      }
      const budget = this.#requiredBudget(run.run_key, command.budgetReservation.unit);
      const available = Math.max(0, budget.budget_limit - budget.spent - budget.reserved);
      if (command.budgetReservation.amount > available) {
        const escalation = deepFreezeRunnerValue<RunnerEscalation>({
          commandId: command.commandId,
          operationId: command.operationId,
          unit: budget.unit,
          requested: command.budgetReservation.amount,
          available,
          createdAt: request.currentTime,
          reason: "budget-exhausted",
        });
        this.#database
          .prepare(
            `INSERT INTO runner_escalations(command_id, run_key, canonical_escalation)
             VALUES (?, ?, ?)`,
          )
          .run(command.commandId, run.run_key, canonicalStringify(escalation));
        this.#appendTransition(
          command,
          "budget-escalated",
          request.currentTime,
          request.attemptId,
          {
            unit: budget.unit,
            requested: command.budgetReservation.amount,
            available,
          },
        );
        this.#fault("before-intent-commit");
        this.#database.exec("COMMIT");
        committed = true;
        this.#fault("after-intent-commit-before-ack");
        return { type: "escalated", escalation };
      }
      const intent = deepFreezeRunnerValue<EffectIntent>({
        command,
        owner: request.lease.owner,
        fence: request.lease.fence,
        attemptId: request.attemptId,
        status: "intent",
        persistedAt: request.currentTime,
      });
      this.#database
        .prepare(
          `INSERT INTO runner_effect_intents(
             intent_id, run_key, command_id, owner_id, fence, attempt_id, canonical_intent
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.operationId,
          run.run_key,
          command.commandId,
          intent.owner,
          intent.fence,
          intent.attemptId,
          canonicalStringify(intent),
        );
      this.#database
        .prepare(
          `UPDATE runner_budgets SET reserved = reserved + ?
           WHERE run_key = ? AND unit = ?`,
        )
        .run(command.budgetReservation.amount, run.run_key, command.budgetReservation.unit);
      this.#appendTransition(command, "intent", request.currentTime, request.attemptId, {
        owner: intent.owner,
        fence: intent.fence,
        contextDigest: command.contextDigest,
        inputDigest: command.inputDigest,
        budgetReservation: command.budgetReservation,
      });
      this.#fault("before-intent-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-intent-commit-before-ack");
      return { type: "persisted", intent };
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  commitEffect(request: CommitEffectRequest): EffectOutcome {
    validateRunnerAttempt(request);
    const observation = snapshotRunnerObservation(request.observation);
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const run = this.#requireRunnerRun(request.repositoryId, request.runId);
      this.#assertRunnerFence(run.run_key, request.lease, request.currentTime);
      const intentRow = this.#database
        .prepare<[string, string], { canonical_intent: string }>(
          `SELECT canonical_intent FROM runner_effect_intents
           WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (
        intentRow === undefined ||
        intentRow.canonical_intent !== canonicalStringify(request.intent)
      ) {
        throw new TypeError("Effect outcome does not match the durable intent");
      }
      const replay = this.#database
        .prepare<[string, string], { canonical_outcome: string }>(
          `SELECT canonical_outcome FROM runner_effect_outcomes
           WHERE intent_id = ? AND attempt_id = ?`,
        )
        .get(request.intent.command.operationId, request.attemptId);
      if (replay !== undefined) {
        this.#database.exec("COMMIT");
        committed = true;
        return parseRunnerValue(replay.canonical_outcome);
      }
      const previousRow = this.#database
        .prepare<[string], { canonical_outcome: string }>(
          `SELECT canonical_outcome FROM runner_effect_outcomes
           WHERE intent_id = ? ORDER BY commit_cursor DESC LIMIT 1`,
        )
        .get(request.intent.command.operationId);
      const previous =
        previousRow === undefined
          ? undefined
          : parseRunnerValue<EffectOutcome>(previousRow.canonical_outcome);
      if (previous !== undefined && isRunnerTerminal(previous.status)) {
        this.#database.exec("COMMIT");
        committed = true;
        return previous;
      }
      const claim = this.#database
        .prepare<
          [string, string],
          {
            owner_id: string;
            fence: number;
            attempt_id: string;
            context_digest: string;
            origin: EffectOutcome["origin"];
          }
        >(
          `SELECT owner_id, fence, attempt_id, context_digest, origin
           FROM runner_effect_claims WHERE run_key = ? AND intent_id = ?`,
        )
        .get(run.run_key, request.intent.command.operationId);
      if (
        claim === undefined ||
        claim.owner_id !== request.lease.owner ||
        claim.fence !== request.lease.fence ||
        claim.attempt_id !== request.attemptId ||
        claim.context_digest !== run.context_digest
      ) {
        throw new TypeError("Effect outcome does not match the live durable attempt claim");
      }
      const reservation = request.intent.command.budgetReservation;
      const usage = finalizeRunnerUsage(
        reservation,
        observation,
        isRunnerTerminal(observation.status),
      );
      const reconciliationAttempts =
        previous === undefined
          ? observation.status === "unknown"
            ? 1
            : 0
          : Math.min(
              previous.reconciliationAttempts + 1,
              request.intent.command.maxReconciliationAttempts,
            );
      const outcome = deepFreezeRunnerValue<EffectOutcome>({
        commandId: request.intent.command.commandId,
        operationId: request.intent.command.operationId,
        kind: request.intent.command.kind,
        owner: request.lease.owner,
        fence: request.lease.fence,
        attemptId: request.attemptId,
        contextDigest: request.intent.command.contextDigest,
        inputDigest: request.intent.command.inputDigest,
        status: observation.status,
        freshness:
          request.intent.command.contextDigest === run.context_digest ? "current" : "stale",
        observedAt: observation.observedAt,
        reconciliationAttempts,
        usage,
        origin: claim.origin,
        ...(observation.details === undefined ? {} : { details: observation.details }),
        ...(observation.outputDigest === undefined
          ? {}
          : { outputDigest: observation.outputDigest }),
      });
      const cursor = run.cursor + 1;
      this.#database
        .prepare(
          `INSERT INTO runner_effect_outcomes(
             intent_id, attempt_id, commit_cursor, status, canonical_outcome
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          outcome.operationId,
          outcome.attemptId,
          cursor,
          outcome.status,
          canonicalStringify(outcome),
        );
      this.#database
        .prepare("DELETE FROM runner_effect_claims WHERE run_key = ? AND intent_id = ?")
        .run(run.run_key, outcome.operationId);
      if (isRunnerTerminal(outcome.status)) {
        const budget = this.#requiredBudget(run.run_key, reservation.unit);
        if (budget.reserved < reservation.amount) {
          throw new Error("Durable effect reservation exceeds reserved budget");
        }
        this.#database
          .prepare(
            `UPDATE runner_budgets
             SET reserved = reserved - ?, spent = spent + ?, unreported = unreported + ?
             WHERE run_key = ? AND unit = ?`,
          )
          .run(
            reservation.amount,
            usage.reported ?? usage.unreported,
            usage.unreported,
            run.run_key,
            reservation.unit,
          );
      }
      this.#appendTransition(
        request.intent.command,
        outcome.status,
        outcome.observedAt,
        request.attemptId,
        {
          freshness: outcome.freshness,
          reconciliationAttempts: outcome.reconciliationAttempts,
          usage: outcome.usage,
          ...(outcome.outputDigest === undefined ? {} : { outputDigest: outcome.outputDigest }),
        },
      );
      this.#fault("before-outcome-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-outcome-commit-before-ack");
      return outcome;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  acquireRunLease(
    repositoryId: string,
    runId: string,
    owner: string,
    currentTime: string,
    expiresAt: string,
  ): RunnerLeaseFact {
    this.#requireRunnerRun(repositoryId, runId);
    const resourceKey = runnerLeaseResourceKey(repositoryId, runId, this.dependencies);
    const grant = acquireLeaseTransaction(this.#database, {
      resourceKey,
      ownerId: owner,
      currentTime,
      expiresAt,
    });
    return { owner: grant.ownerId, fence: grant.fence, expiresAt: grant.expiresAt };
  }

  updateContext(input: FencedRunnerContextUpdateInput): void {
    validateRunnerDigest(input.contextDigest, "contextDigest");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(input.repositoryId, input.runId);
      this.#assertRunnerFence(run.run_key, input.lease, input.currentTime);
      const activeClaim = this.#database
        .prepare<[string, number], { present: number }>(
          `SELECT 1 AS present FROM runner_effect_claims
           WHERE run_key = ? AND fence = ? LIMIT 1`,
        )
        .get(run.run_key, input.lease.fence);
      if (activeClaim !== undefined) {
        throw new TypeError("Runner context cannot change while an effect attempt is claimed");
      }
      this.#database.prepare("DELETE FROM runner_effect_claims WHERE run_key = ?").run(run.run_key);
      if (run.context_digest === input.contextDigest) {
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare("UPDATE runner_runs SET context_digest = ? WHERE run_key = ?")
        .run(input.contextDigest, run.run_key);
      this.#appendRunTransition(run.run_key, "context-updated", input.currentTime, {
        previousContextDigest: run.context_digest,
        contextDigest: input.contextDigest,
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(input: FencedRunnerCancellationInput): void {
    validateRunnerIdentity(input.operationId, "operationId");
    validateTimestamp(input.requestedAt, "requestedAt");
    if (Date.parse(input.requestedAt) > Date.parse(input.currentTime)) {
      throw new TypeError("requestedAt must not be later than currentTime");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#requireRunnerRun(input.repositoryId, input.runId);
      this.#assertRunnerFence(run.run_key, input.lease, input.currentTime);
      const latest = this.#database
        .prepare<
          [string, string],
          {
            canonical_intent: string;
            requested_at: string | null;
            status: EffectOutcome["status"] | null;
          }
        >(
          `SELECT i.canonical_intent, c.requested_at, o.status
           FROM runner_effect_intents i
           LEFT JOIN runner_cancellation_requests c ON c.intent_id = i.intent_id
           LEFT JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
             AND o.commit_cursor = (
               SELECT max(latest.commit_cursor) FROM runner_effect_outcomes latest
               WHERE latest.intent_id = i.intent_id
             )
           WHERE i.run_key = ? AND i.intent_id = ?`,
        )
        .get(run.run_key, input.operationId);
      if (latest === undefined) throw new TypeError("Cannot cancel an effect without an intent");
      if (latest.status !== null && isRunnerTerminal(latest.status)) {
        this.#database.exec("COMMIT");
        return;
      }
      if (latest.requested_at !== null) {
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare(
          `INSERT INTO runner_cancellation_requests(
             intent_id, owner_id, fence, requested_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(intent_id) DO NOTHING`,
        )
        .run(input.operationId, input.lease.owner, input.lease.fence, input.requestedAt);
      const intent = parseRunnerValue<EffectIntent>(latest.canonical_intent);
      this.#appendTransition(
        intent.command,
        "cancellation-requested",
        input.requestedAt,
        undefined,
        { owner: input.lease.owner, fence: input.lease.fence },
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  queryReceipts(repositoryId: string, runId: string): readonly RunnerEffectReceipt[] {
    const run = this.#requireRunnerRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { canonical_receipt: string }>(
          "SELECT canonical_receipt FROM runner_receipts WHERE run_key = ? ORDER BY cursor",
        )
        .all(run.run_key)
        .map((row) => parseRunnerValue<RunnerEffectReceipt>(row.canonical_receipt)),
    );
  }

  queryEvents(repositoryId: string, runId: string): readonly RunnerEffectEvent[] {
    const run = this.#requireRunnerRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<[string], { canonical_event: string }>(
          "SELECT canonical_event FROM runner_events WHERE run_key = ? ORDER BY cursor",
        )
        .all(run.run_key)
        .map((row) => parseRunnerValue<RunnerEffectEvent>(row.canonical_event)),
    );
  }

  queryProjection(repositoryId: string, runId: string): RunnerProjection {
    const run = this.#requireRunnerRun(repositoryId, runId);
    const row = this.#database
      .prepare<[string], { canonical_projection: string }>(
        "SELECT canonical_projection FROM runner_projections WHERE run_key = ?",
      )
      .get(run.run_key);
    if (row === undefined) throw new Error("Runner projection is missing");
    return parseRunnerValue(row.canonical_projection);
  }

  queryBudgets(repositoryId: string, runId: string): readonly RunnerBudgetState[] {
    const run = this.#requireRunnerRun(repositoryId, runId);
    return Object.freeze(
      this.#database
        .prepare<
          [string],
          {
            unit: string;
            budget_limit: number;
            reserved: number;
            spent: number;
            unreported: number;
          }
        >(
          `SELECT unit, budget_limit, reserved, spent, unreported
           FROM runner_budgets WHERE run_key = ? ORDER BY unit`,
        )
        .all(run.run_key)
        .map((row) =>
          Object.freeze({
            unit: row.unit,
            limit: row.budget_limit,
            reserved: row.reserved,
            spent: row.spent,
            unreported: row.unreported,
          }),
        ),
    );
  }

  #appendTransition(
    command: QueuedEffectCommand,
    status: RunnerEffectReceipt["status"] | "budget-escalated",
    occurredAt: string,
    attemptId: string | undefined,
    payload: unknown,
  ): void {
    const run = this.#requireRunnerRun(command.repositoryId, command.runId);
    const cursor = run.cursor + 1;
    const receipt: RunnerEffectReceipt = {
      cursor,
      repositoryId: command.repositoryId,
      runId: command.runId,
      commandId: command.commandId,
      operationId: command.operationId,
      status: status === "budget-escalated" ? "failed" : status,
      occurredAt,
      ...(attemptId === undefined ? {} : { attemptId }),
    };
    const event: RunnerEffectEvent = {
      cursor,
      repositoryId: command.repositoryId,
      runId: command.runId,
      commandId: command.commandId,
      operationId: command.operationId,
      eventType: status === "queued" ? "effect-command-queued" : `effect-${status}`,
      occurredAt,
      payload: snapshotRunnerValue(payload) as RunnerEffectEvent["payload"],
    };
    this.#database
      .prepare("INSERT INTO runner_receipts(run_key, cursor, canonical_receipt) VALUES (?, ?, ?)")
      .run(run.run_key, cursor, canonicalStringify(receipt));
    this.#database
      .prepare(
        `INSERT INTO runner_events(run_key, cursor, event_type, canonical_event)
         VALUES (?, ?, ?, ?)`,
      )
      .run(run.run_key, cursor, event.eventType, canonicalStringify(event));
    this.#database
      .prepare("UPDATE runner_runs SET cursor = ? WHERE run_key = ?")
      .run(cursor, run.run_key);
    this.#writeProjection(run.run_key);
  }

  #appendRunTransition(
    runKey: string,
    status: "context-updated",
    occurredAt: string,
    payload: RunnerEffectEvent["payload"],
  ): void {
    const run = this.#database
      .prepare<[string], { cursor: number; repository_id: string; run_id: string }>(
        "SELECT cursor, repository_id, run_id FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (run === undefined) throw new TypeError("Runner run is not configured");
    const cursor = run.cursor + 1;
    const receipt: RunnerEffectReceipt = {
      cursor,
      repositoryId: run.repository_id,
      runId: run.run_id,
      status,
      occurredAt,
    };
    const event: RunnerEffectEvent = {
      cursor,
      repositoryId: run.repository_id,
      runId: run.run_id,
      eventType: `runner-${status}`,
      occurredAt,
      payload: snapshotRunnerValue(payload) as RunnerEffectEvent["payload"],
    };
    this.#database
      .prepare("INSERT INTO runner_receipts(run_key, cursor, canonical_receipt) VALUES (?, ?, ?)")
      .run(runKey, cursor, canonicalStringify(receipt));
    this.#database
      .prepare(
        `INSERT INTO runner_events(run_key, cursor, event_type, canonical_event)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runKey, cursor, event.eventType, canonicalStringify(event));
    this.#database
      .prepare("UPDATE runner_runs SET cursor = ? WHERE run_key = ?")
      .run(cursor, runKey);
    this.#writeProjection(runKey);
  }

  #writeProjection(runKey: string): void {
    const run = this.#database
      .prepare<[string], { cursor: number; context_digest: string }>(
        "SELECT cursor, context_digest FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (run === undefined) throw new TypeError("Runner run is not configured");
    const effects = this.#database
      .prepare<[string], { canonical_outcome: string }>(
        `SELECT o.canonical_outcome FROM runner_effect_intents i
         JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
           AND o.commit_cursor = (
             SELECT max(latest.commit_cursor) FROM runner_effect_outcomes latest
             WHERE latest.intent_id = i.intent_id
           )
         WHERE i.run_key = ? ORDER BY i.intent_id`,
      )
      .all(runKey)
      .map((row) => parseRunnerValue<EffectOutcome>(row.canonical_outcome))
      .flatMap((outcome) =>
        outcome.contextDigest !== run.context_digest
          ? []
          : [
              {
                operationId: outcome.operationId,
                status: outcome.status,
                ...(outcome.outputDigest === undefined
                  ? {}
                  : { outputDigest: outcome.outputDigest }),
              },
            ],
      );
    const projection: RunnerProjection = {
      cursor: run.cursor,
      contextDigest: run.context_digest,
      effects,
    };
    this.#database
      .prepare(`UPDATE runner_projections SET canonical_projection = ? WHERE run_key = ?`)
      .run(canonicalStringify(projection), runKey);
  }

  #assertRunnerFence(runKey: string, supplied: RunnerLeaseFact, currentTime: string): void {
    validateRunnerLease(supplied);
    validateTimestamp(currentTime, "currentTime");
    const resourceKey = this.#database
      .prepare<[string], { repository_id: string; run_id: string }>(
        "SELECT repository_id, run_id FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (resourceKey === undefined) throw new TypeError("Runner run is not configured");
    const leaseKey = runnerLeaseResourceKey(
      resourceKey.repository_id,
      resourceKey.run_id,
      this.dependencies,
    );
    const lease = this.#database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(leaseKey);
    if (
      lease === undefined ||
      lease.owner_id !== supplied.owner ||
      lease.fence !== supplied.fence ||
      lease.expires_at !== supplied.expiresAt ||
      Date.parse(currentTime) >= Date.parse(lease.expires_at)
    ) {
      throw new StaleLeaseFenceError(leaseKey, supplied.fence);
    }
  }

  #configureLease(runKey: string, lease: RunnerLeaseFact): void {
    if (lease.fence !== 1)
      throw new TypeError("A newly configured runner lease must start at fence 1");
    const run = this.#database
      .prepare<[string], { repository_id: string; run_id: string }>(
        "SELECT repository_id, run_id FROM runner_runs WHERE run_key = ?",
      )
      .get(runKey);
    if (run === undefined) throw new TypeError("Runner run is not configured");
    this.#database
      .prepare("INSERT INTO leases(resource_key, owner_id, fence, expires_at) VALUES (?, ?, 1, ?)")
      .run(
        runnerLeaseResourceKey(run.repository_id, run.run_id, this.dependencies),
        lease.owner,
        lease.expiresAt,
      );
  }

  #requireRunnerRun(
    repositoryId: string,
    runId: string,
  ): {
    readonly run_key: string;
    readonly repository_id: string;
    readonly run_id: string;
    readonly context_digest: string;
    readonly cursor: number;
  } {
    validateRunnerIdentity(repositoryId, "repositoryId");
    validateRunnerIdentity(runId, "runId");
    const row = this.#database
      .prepare<
        [string, string],
        {
          run_key: string;
          repository_id: string;
          run_id: string;
          context_digest: string;
          cursor: number;
        }
      >(
        `SELECT run_key, repository_id, run_id, context_digest, cursor
         FROM runner_runs WHERE repository_id = ? AND run_id = ?`,
      )
      .get(repositoryId, runId);
    if (row === undefined) throw new TypeError("Runner run is not configured");
    return row;
  }

  #requiredBudget(
    runKey: string,
    unit: string,
  ): {
    readonly unit: string;
    readonly budget_limit: number;
    readonly reserved: number;
    readonly spent: number;
  } {
    const row = this.#database
      .prepare<
        [string, string],
        { unit: string; budget_limit: number; reserved: number; spent: number }
      >(
        `SELECT unit, budget_limit, reserved, spent FROM runner_budgets
         WHERE run_key = ? AND unit = ?`,
      )
      .get(runKey, unit);
    if (row === undefined) throw new TypeError("Runner command names an unknown budget unit");
    return row;
  }

  #fault(point: SqliteRunnerFaultPoint): void {
    this.#faultInjector?.(point);
  }
}

function acquireLeaseTransaction(
  database: Database.Database,
  input: AcquireLeaseInput,
): LeaseGrant {
  validateStorageIdentifier(input.resourceKey, "resourceKey");
  validateStorageIdentifier(input.ownerId, "ownerId");
  validateTimestamp(input.currentTime, "currentTime");
  validateTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(input.expiresAt) <= Date.parse(input.currentTime)) {
    throw new TypeError("Lease expiry must be later than currentTime");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(input.resourceKey);
    let fence = 1;
    if (current === undefined) {
      database
        .prepare(
          "INSERT INTO leases(resource_key, owner_id, fence, expires_at) VALUES (?, ?, 1, ?)",
        )
        .run(input.resourceKey, input.ownerId, input.expiresAt);
    } else if (
      current.owner_id === input.ownerId &&
      Date.parse(current.expires_at) > Date.parse(input.currentTime)
    ) {
      fence = current.fence;
      database
        .prepare("UPDATE leases SET expires_at = ? WHERE resource_key = ?")
        .run(input.expiresAt, input.resourceKey);
    } else {
      if (
        current.owner_id !== input.ownerId &&
        Date.parse(current.expires_at) > Date.parse(input.currentTime)
      ) {
        throw new LeaseUnavailableError(input.resourceKey);
      }
      fence = current.fence + 1;
      database
        .prepare("UPDATE leases SET owner_id = ?, fence = ?, expires_at = ? WHERE resource_key = ?")
        .run(input.ownerId, fence, input.expiresAt, input.resourceKey);
    }
    database.exec("COMMIT");
    return {
      resourceKey: input.resourceKey,
      ownerId: input.ownerId,
      fence,
      expiresAt: input.expiresAt,
    };
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function runnerRunKey(repositoryId: string, runId: string): string {
  return canonicalStringify([repositoryId, runId]);
}

function runnerLeaseResourceKey(
  repositoryId: string,
  runId: string,
  dependencies: RuntimeDependencies,
): string {
  const digest = dependencies.sha256.digest(
    new TextEncoder().encode(canonicalStringify([repositoryId, runId])),
  );
  if (!isSha256Digest(digest)) throw new TypeError("Invalid runner lease resource digest");
  return `runner:${digest}`;
}

function finalizeRunnerUsage(
  reservation: QueuedEffectCommand["budgetReservation"],
  observation: CommitEffectRequest["observation"],
  terminal: boolean,
): FinalizedEffectUsage {
  if (observation.usage !== undefined && observation.usage.unit !== reservation.unit) {
    throw new TypeError("Effect usage unit must match its budget reservation");
  }
  if (observation.usage !== undefined && observation.usage.amount > reservation.amount) {
    throw new TypeError("Effect reported usage must not exceed its budget reservation");
  }
  return Object.freeze({
    unit: reservation.unit,
    reserved: reservation.amount,
    ...(observation.usage === undefined ? {} : { reported: observation.usage.amount }),
    unreported: terminal && observation.usage === undefined ? reservation.amount : 0,
  });
}

function validateRunnerAttempt(request: {
  readonly repositoryId: string;
  readonly runId: string;
  readonly lease: RunnerLeaseFact;
  readonly currentTime: string;
  readonly attemptId: string;
}): void {
  validateRunnerIdentity(request.repositoryId, "repositoryId");
  validateRunnerIdentity(request.runId, "runId");
  validateRunnerLease(request.lease);
  validateTimestamp(request.currentTime, "currentTime");
  validateRunnerIdentity(request.attemptId, "attemptId");
}

function validateRunnerCommand(command: QueuedEffectCommand): void {
  if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) {
    throw new TypeError("Runner command sequence must be a positive safe integer");
  }
  validateRunnerIdentity(command.commandId, "commandId");
  validateRunnerIdentity(command.repositoryId, "repositoryId");
  validateRunnerIdentity(command.runId, "runId");
  validateRunnerIdentity(command.operationId, "operationId");
  if (!["worker", "sensor", "git", "asset", "time"].includes(command.kind)) {
    throw new TypeError("Runner command effect kind is invalid");
  }
  validateRunnerDigest(command.contextDigest, "contextDigest");
  validateRunnerDigest(command.inputDigest, "inputDigest");
  canonicalStringify(command.input);
  validateRunnerUnit(command.budgetReservation.unit);
  validateRunnerAmount(command.budgetReservation.amount, "budget reservation");
  validateTimestamp(command.queuedAt, "queuedAt");
  if (command.deadline !== undefined) validateTimestamp(command.deadline, "deadline");
  if (
    !Number.isSafeInteger(command.maxReconciliationAttempts) ||
    command.maxReconciliationAttempts < 1
  ) {
    throw new TypeError("Runner reconciliation limit must be a positive safe integer");
  }
}

function snapshotRunnerObservation(
  observation: CommitEffectRequest["observation"],
): CommitEffectRequest["observation"] {
  if (!["active", "completed", "failed", "cancelled", "unknown"].includes(observation.status)) {
    throw new TypeError("Effect observation status is invalid");
  }
  validateTimestamp(observation.observedAt, "observedAt");
  if (observation.details !== undefined) canonicalStringify(observation.details);
  if (observation.outputDigest !== undefined) {
    validateRunnerDigest(observation.outputDigest, "outputDigest");
  }
  if (observation.usage !== undefined) {
    validateRunnerUnit(observation.usage.unit);
    validateRunnerAmount(observation.usage.amount, "reported usage");
  }
  return snapshotRunnerValue(observation);
}

function validateRunnerLease(lease: RunnerLeaseFact): void {
  validateRunnerIdentity(lease.owner, "lease owner");
  if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) {
    throw new TypeError("Lease fence must be a positive safe integer");
  }
  validateTimestamp(lease.expiresAt, "lease expiry");
}

function validateRunnerDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
}

function validateRunnerIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
}

function validateRunnerUnit(unit: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(unit)) {
    throw new TypeError("Budget unit must be a lowercase bounded key");
  }
}

function validateRunnerAmount(amount: number, subject: string): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError(`${subject} must be a non-negative safe integer`);
  }
}

function isRunnerTerminal(status: EffectOutcome["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function snapshotRunnerValue<T>(value: T): T {
  return parseRunnerValue(canonicalStringify(value));
}

function parseRunnerValue<T>(serialized: string): T {
  return deepFreezeRunnerValue(JSON.parse(serialized) as T);
}

function deepFreezeRunnerValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeRunnerValue(child);
    Object.freeze(value);
  }
  return value;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

export function restoreSqliteAuthority(
  options: SqliteAuthorityOptions & { readonly backupPath: string },
): SqliteAuthority {
  const databasePath = resolve(options.databasePath);
  const backupPath = resolve(options.backupPath);
  const assetDirectory = resolve(options.assetDirectory);
  const bundle = verifyBackupBundle(backupPath, options.dependencies);
  assertFreshRestoreDestinations(databasePath, assetDirectory, backupPath);
  const suffix = randomUUID();
  const databasePartial = `${databasePath}.restore.partial-${suffix}`;
  const assetPartial = `${assetDirectory}.restore.partial-${suffix}`;
  mkdirDurably(assetPartial);
  let assetsPublished = false;
  let databasePublished = false;
  try {
    copyAssetSet(bundle.manifest.assets, bundle.assetDirectory, assetPartial, options.dependencies);
    copyFileSync(bundle.databasePath, databasePartial, constants.COPYFILE_EXCL);
    fsyncFile(databasePartial);
    verifyDatabaseArtifact(databasePartial, bundle.manifest, options.dependencies);
    const copied = openReadConnection(databasePartial);
    try {
      verifyDatabase(copied, options.dependencies, assetPartial, true);
    } finally {
      copied.close();
    }
    assertFreshRestoreDestinations(databasePath, assetDirectory, backupPath);
    publishAssetDirectoryNoReplace(assetPartial, assetDirectory);
    assetsPublished = true;
    linkSync(databasePartial, databasePath);
    databasePublished = true;
    fsyncDirectory(dirname(databasePath));
    unlinkSync(databasePartial);
    fsyncDirectory(dirname(databasePartial));
  } catch (error) {
    rmSync(databasePartial, { force: true });
    rmSync(assetPartial, { recursive: true, force: true });
    if (databasePublished) {
      rmSync(databasePath, { force: true });
      fsyncDirectory(dirname(databasePath));
    }
    if (assetsPublished) {
      rmSync(assetDirectory, { recursive: true, force: true });
      fsyncDirectory(dirname(assetDirectory));
    }
    throw error;
  }
  return new SqliteAuthority(options);
}

function configureWriteConnection(database: Database.Database, busyTimeoutMs: number): void {
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  retrySqliteLock(() => database.pragma("journal_mode = WAL"), busyTimeoutMs);
  database.pragma("synchronous = FULL");
  database.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
}

function retrySqliteLock<T>(operation: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteLockError(error) || Date.now() >= deadline) throw error;
      const remaining = Math.max(1, Math.min(10, deadline - Date.now()));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
    }
  }
}

function openReadConnection(path: string): Database.Database {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
  database.pragma("query_only = ON");
  return database;
}

function applyMigrations(database: Database.Database, dependencies: RuntimeDependencies): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > CURRENT_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
  const migrations = loadMigrations(dependencies);
  for (const migration of migrations) {
    const apply = database.transaction(() => {
      const lockedVersion = database.pragma("user_version", { simple: true }) as number;
      if (lockedVersion > CURRENT_SCHEMA_VERSION) {
        throw new UnsupportedSchemaVersionError(lockedVersion);
      }
      if (migration.version <= lockedVersion) return;
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO migration_metadata(version, name, checksum) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, migration.checksum);
      database.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
  }
  verifyMigrationMetadata(database, migrations);
}

function loadMigrations(dependencies: RuntimeDependencies): readonly Migration[] {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/u.test(name))
    .sort()
    .map((name) => {
      const version = Number.parseInt(name.slice(0, 3), 10);
      const sql = readFileSync(join(MIGRATIONS_DIRECTORY, name), "utf8");
      const checksum = dependencies.sha256.digest(new TextEncoder().encode(sql));
      if (!isSha256Digest(checksum)) throw new TypeError("Invalid migration SHA-256 digest");
      return { version, name, sql, checksum };
    });
}

function verifyMigrationMetadata(
  database: Database.Database,
  migrations: readonly Migration[],
): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > CURRENT_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
  const rows = database
    .prepare<[], { version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM migration_metadata ORDER BY version",
    )
    .all();
  const expected = migrations.filter((migration) => migration.version <= version);
  if (
    rows.length !== expected.length ||
    rows.some((row, index) => {
      const migration = expected[index];
      return (
        migration === undefined ||
        row.version !== migration.version ||
        row.name !== migration.name ||
        row.checksum !== migration.checksum
      );
    })
  ) {
    throw new Error("SQLite migration metadata does not match packaged migration checksums");
  }
}

function verifyDatabase(
  database: Database.Database,
  dependencies: RuntimeDependencies,
  assetDirectory: string,
  verifyAssets: boolean,
): void {
  const quickCheck = database.pragma("quick_check(1)") as { quick_check: string }[];
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error(`SQLite quick_check failed: ${canonicalStringify(quickCheck)}`);
  }
  const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error(`SQLite foreign_key_check failed: ${canonicalStringify(foreignKeyFailures)}`);
  }
  verifyMigrationMetadata(database, loadMigrations(dependencies));
  const state = database
    .prepare<[], AuthorityRow>(
      "SELECT revision, canonical_json FROM authority_state WHERE singleton = 1",
    )
    .get();
  if (state === undefined) throw new Error("SQLite authority singleton is missing");
  InMemoryAuthority.fromCanonicalJson(state.canonical_json, dependencies);
  verifyNormalizedSnapshot(database, parseSnapshot(state.canonical_json), dependencies);
  if (!verifyAssets) return;
  for (const descriptor of readAssetDescriptors(database)) {
    verifyAssetBytes(
      resolveAssetPath(assetDirectory, descriptor.relativePath),
      descriptor,
      dependencies,
    );
  }
}

function readAssetDescriptors(database: Database.Database): readonly AssetDescriptor[] {
  return database
    .prepare<[], AssetRow>(
      "SELECT digest, byte_length, media_type, relative_path FROM assets ORDER BY digest",
    )
    .all()
    .map(toAssetDescriptor);
}

function persistSnapshot(
  database: Database.Database,
  snapshot: AuthoritySnapshot,
  serialized: string,
  expectedRevision: number,
  dependencies: RuntimeDependencies,
): void {
  const normalized = normalizeSnapshot(snapshot, dependencies);
  database.exec(
    "UPDATE repositories SET active_run_key = NULL; DELETE FROM event_frames; DELETE FROM receipt_history;",
  );
  const insertRepository = database.prepare(
    "INSERT INTO repositories(repository_id, active_run_key) VALUES (?, NULL) ON CONFLICT(repository_id) DO NOTHING",
  );
  const upsertRun = database.prepare(
    `INSERT INTO runs(
       run_key, repository_id, run_id, cursor, records_json, projection_generated_at, revision_digest
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_key) DO UPDATE SET
       cursor = excluded.cursor,
       records_json = excluded.records_json,
       projection_generated_at = excluded.projection_generated_at,
       revision_digest = excluded.revision_digest`,
  );
  const upsertCommand = database.prepare(
    `INSERT INTO commands(
       command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(command_id) DO UPDATE SET
       run_key = excluded.run_key,
       canonical_envelope = excluded.canonical_envelope,
       admission_json = excluded.admission_json,
       terminal_receipt_json = excluded.terminal_receipt_json`,
  );
  const insertReceipt = database.prepare(
    `INSERT INTO receipt_history(
       run_key, cursor, command_id, ordinal, status, canonical_receipt
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO event_frames(
       event_id, run_key, cursor, command_id, event_type, canonical_frame
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const repository of normalized.repositories) {
    insertRepository.run(repository.repository_id);
  }
  for (const run of normalized.runs) {
    upsertRun.run(
      run.run_key,
      run.repository_id,
      run.run_id,
      run.cursor,
      run.records_json,
      run.projection_generated_at,
      run.revision_digest,
    );
  }
  for (const command of normalized.commands) {
    upsertCommand.run(
      command.command_id,
      command.run_key,
      command.canonical_envelope,
      command.admission_json,
      command.terminal_receipt_json,
    );
  }
  const desiredCommandIds = new Set(normalized.commands.map((row) => row.command_id as string));
  const deleteClaimsForCommand = database.prepare("DELETE FROM claims WHERE command_id = ?");
  const deleteCommand = database.prepare("DELETE FROM commands WHERE command_id = ?");
  for (const row of database
    .prepare<[], { command_id: string }>("SELECT command_id FROM commands")
    .all()) {
    if (!desiredCommandIds.has(row.command_id)) {
      deleteClaimsForCommand.run(row.command_id);
      deleteCommand.run(row.command_id);
    }
  }
  for (const receipt of normalized.receiptHistory) {
    insertReceipt.run(
      receipt.run_key,
      receipt.cursor,
      receipt.command_id,
      receipt.ordinal,
      receipt.status,
      receipt.canonical_receipt,
    );
  }
  for (const event of normalized.eventFrames) {
    insertEvent.run(
      event.event_id,
      event.run_key,
      event.cursor,
      event.command_id,
      event.event_type,
      event.canonical_frame,
    );
  }
  const desiredRunKeys = new Set(normalized.runs.map((row) => row.run_key as string));
  const deleteRun = database.prepare("DELETE FROM runs WHERE run_key = ?");
  for (const row of database.prepare<[], { run_key: string }>("SELECT run_key FROM runs").all()) {
    if (!desiredRunKeys.has(row.run_key)) deleteRun.run(row.run_key);
  }
  const desiredRepositoryIds = new Set(
    normalized.repositories.map((row) => row.repository_id as string),
  );
  const deleteRepository = database.prepare("DELETE FROM repositories WHERE repository_id = ?");
  for (const row of database
    .prepare<[], { repository_id: string }>("SELECT repository_id FROM repositories")
    .all()) {
    if (!desiredRepositoryIds.has(row.repository_id)) deleteRepository.run(row.repository_id);
  }
  const updateRepository = database.prepare(
    "UPDATE repositories SET active_run_key = ? WHERE repository_id = ?",
  );
  for (const repository of normalized.repositories) {
    updateRepository.run(repository.active_run_key, repository.repository_id);
  }
  const result = database
    .prepare(
      `UPDATE authority_state
       SET revision = revision + 1, canonical_json = ?
       WHERE singleton = 1 AND revision = ?`,
    )
    .run(serialized, expectedRevision);
  if (result.changes !== 1) throw new StaleAuthorityRevisionError(expectedRevision);
}

function persistCommandDelta(
  database: Database.Database,
  receipt: DurableReceipt,
  run: RuntimeAuthorityRun,
  serialized: string,
  expectedRevision: number,
  dependencies: RuntimeDependencies,
): void {
  const runKey = canonicalStringify([run.repositoryId, run.runId]);
  const command = run.commands.get(receipt.commandId);
  const receipts = run.receiptHistory.slice(-3);
  const events = run.events.slice(-3);
  if (
    command === undefined ||
    receipts.some((entry) => entry.commandId !== receipt.commandId) ||
    events.some((entry) => entry.commandId !== receipt.commandId) ||
    receipts.length !== 3 ||
    events.length !== 3
  ) {
    throw new TypeError("Incremental command persistence requires one complete lifecycle");
  }
  const recordsJson = run.records === undefined ? null : canonicalStringify(run.records);
  database
    .prepare(
      "INSERT INTO repositories(repository_id, active_run_key) VALUES (?, NULL) ON CONFLICT(repository_id) DO NOTHING",
    )
    .run(run.repositoryId);
  database
    .prepare(
      `INSERT INTO runs(
         run_key, repository_id, run_id, cursor, records_json, projection_generated_at,
         revision_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key) DO UPDATE SET
         cursor = excluded.cursor,
         records_json = excluded.records_json,
         projection_generated_at = excluded.projection_generated_at,
         revision_digest = excluded.revision_digest`,
    )
    .run(
      runKey,
      run.repositoryId,
      run.runId,
      run.cursor,
      recordsJson,
      run.projectionGeneratedAt ?? null,
      run.records === undefined
        ? null
        : canonicalDigest(canonicalValue(run.records), dependencies.sha256),
    );
  if (run.records !== undefined) {
    database
      .prepare("UPDATE repositories SET active_run_key = ? WHERE repository_id = ?")
      .run(runKey, run.repositoryId);
  }
  database
    .prepare(
      `INSERT INTO commands(
         command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.commandId,
      runKey,
      command.canonicalEnvelope,
      canonicalStringify(command.admission),
      canonicalStringify(command.receipt),
    );
  const insertReceipt = database.prepare(
    `INSERT INTO receipt_history(
       run_key, cursor, command_id, ordinal, status, canonical_receipt
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [index, lifecycleReceipt] of receipts.entries()) {
    insertReceipt.run(
      runKey,
      lifecycleReceipt.cursor,
      receipt.commandId,
      index + 1,
      lifecycleReceipt.status,
      canonicalStringify(lifecycleReceipt),
    );
  }
  const insertEvent = database.prepare(
    `INSERT INTO event_frames(
       event_id, run_key, cursor, command_id, event_type, canonical_frame
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    insertEvent.run(
      event.eventId,
      runKey,
      event.cursor,
      receipt.commandId,
      event.eventType,
      canonicalStringify(event),
    );
  }
  const result = database
    .prepare(
      `UPDATE authority_state
       SET revision = revision + 1, canonical_json = ?
       WHERE singleton = 1 AND revision = ?`,
    )
    .run(serialized, expectedRevision);
  if (result.changes !== 1) throw new StaleAuthorityRevisionError(expectedRevision);
}

function runtimeAuthorityRunKey(repositoryId: string, runId: string): string {
  return `${repositoryId}\u0000${runId}`;
}

class IncrementalCanonicalSnapshot {
  readonly #version: string;
  readonly #runs: Map<string, CanonicalRunFragments>;
  readonly #commandIds: Set<string>;
  #serialized: string;

  private constructor(snapshot: AuthoritySnapshot, serialized: string) {
    this.#version = snapshot.version;
    this.#runs = new Map(
      snapshot.runs.map((run) => [
        runtimeAuthorityRunKey(run.repositoryId, run.runId),
        {
          repositoryId: run.repositoryId,
          runId: run.runId,
          cursor: run.cursor,
          commands: new Map(
            run.commands.map((command) => [command.commandId, canonicalStringify(command)]),
          ),
          receiptHistory: run.receiptHistory.map((receipt) => canonicalStringify(receipt)),
          events: run.events.map((event) => canonicalStringify(event)),
          ...(run.records === undefined ? {} : { records: canonicalStringify(run.records) }),
          ...(run.projectionGeneratedAt === undefined
            ? {}
            : { projectionGeneratedAt: run.projectionGeneratedAt }),
        },
      ]),
    );
    this.#commandIds = new Set(
      snapshot.runs.flatMap((run) => run.commands.map((command) => command.commandId)),
    );
    this.#serialized = serialized;
  }

  static fromCanonicalJson(serialized: string): IncrementalCanonicalSnapshot {
    return new IncrementalCanonicalSnapshot(parseSnapshot(serialized), serialized);
  }

  hasCommand(commandId: string): boolean {
    return this.#commandIds.has(commandId);
  }

  appendCommand(run: RuntimeAuthorityRun, commandId: string): string {
    const command = run.commands.get(commandId);
    const receipts = run.receiptHistory.slice(-3);
    const events = run.events.slice(-3);
    if (
      command === undefined ||
      receipts.length !== 3 ||
      events.length !== 3 ||
      receipts.some((entry) => entry.commandId !== commandId) ||
      events.some((entry) => entry.commandId !== commandId)
    ) {
      throw new TypeError("Incremental canonical persistence requires one complete lifecycle");
    }
    const key = runtimeAuthorityRunKey(run.repositoryId, run.runId);
    let fragments = this.#runs.get(key);
    if (fragments === undefined) {
      fragments = {
        repositoryId: run.repositoryId,
        runId: run.runId,
        cursor: 0,
        commands: new Map(),
        receiptHistory: [],
        events: [],
      };
      this.#runs.set(key, fragments);
    }
    fragments.commands.set(commandId, canonicalStringify({ commandId, ...command }));
    fragments.receiptHistory.push(...receipts.map((receipt) => canonicalStringify(receipt)));
    fragments.events.push(...events.map((event) => canonicalStringify(event)));
    fragments.cursor = run.cursor;
    if (run.records === undefined) delete fragments.records;
    else fragments.records = canonicalStringify(run.records);
    if (run.projectionGeneratedAt === undefined) delete fragments.projectionGeneratedAt;
    else fragments.projectionGeneratedAt = run.projectionGeneratedAt;
    this.#commandIds.add(commandId);
    this.#serialized = this.#serialize();
    return this.#serialized;
  }

  #serialize(): string {
    const runs = [...this.#runs.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, run]) => serializeCanonicalRun(run));
    return `{"runs":[${runs.join(",")}],"version":${JSON.stringify(this.#version)}}`;
  }
}

function serializeCanonicalRun(run: CanonicalRunFragments): string {
  const commands = [...run.commands.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, command]) => command);
  return `{"commands":[${commands.join(",")}],"cursor":${run.cursor},"events":[${run.events.join(",")}]${
    run.projectionGeneratedAt === undefined
      ? ""
      : `,"projectionGeneratedAt":${JSON.stringify(run.projectionGeneratedAt)}`
  },"receiptHistory":[${run.receiptHistory.join(",")}]${
    run.records === undefined ? "" : `,"records":${run.records}`
  },"repositoryId":${JSON.stringify(run.repositoryId)},"runId":${JSON.stringify(run.runId)}}`;
}

function parseSnapshot(serialized: string): AuthoritySnapshot {
  return JSON.parse(serialized) as AuthoritySnapshot;
}

function verifyNormalizedSnapshot(
  database: Database.Database,
  snapshot: AuthoritySnapshot,
  dependencies: RuntimeDependencies,
): void {
  const expected = normalizeSnapshot(snapshot, dependencies);
  const actual: NormalizedSnapshot = {
    repositories: database
      .prepare("SELECT repository_id, active_run_key FROM repositories ORDER BY repository_id")
      .all() as Record<string, unknown>[],
    runs: database
      .prepare(
        `SELECT run_key, repository_id, run_id, cursor, records_json,
                projection_generated_at, revision_digest
         FROM runs ORDER BY run_key`,
      )
      .all() as Record<string, unknown>[],
    commands: database
      .prepare(
        `SELECT command_id, run_key, canonical_envelope, admission_json, terminal_receipt_json
         FROM commands ORDER BY command_id`,
      )
      .all() as Record<string, unknown>[],
    receiptHistory: database
      .prepare(
        `SELECT run_key, cursor, command_id, ordinal, status, canonical_receipt
         FROM receipt_history ORDER BY run_key, cursor`,
      )
      .all() as Record<string, unknown>[],
    eventFrames: database
      .prepare(
        `SELECT event_id, run_key, cursor, command_id, event_type, canonical_frame
         FROM event_frames ORDER BY run_key, cursor`,
      )
      .all() as Record<string, unknown>[],
  };
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error("SQLite normalized authority tables diverge from canonical snapshot");
  }
}

function normalizeSnapshot(
  snapshot: AuthoritySnapshot,
  dependencies: RuntimeDependencies,
): NormalizedSnapshot {
  const repositories = new Map<string, string | null>();
  const runs: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const receiptHistory: Record<string, unknown>[] = [];
  const eventFrames: Record<string, unknown>[] = [];
  for (const run of snapshot.runs) {
    const runKey = canonicalStringify([run.repositoryId, run.runId]);
    const activeRunKey = repositories.get(run.repositoryId);
    if (run.records !== undefined) {
      if (activeRunKey !== undefined && activeRunKey !== null) {
        throw new TypeError(`Repository ${run.repositoryId} has multiple active runs`);
      }
      repositories.set(run.repositoryId, runKey);
    } else if (activeRunKey === undefined) {
      repositories.set(run.repositoryId, null);
    }
    const recordsJson = run.records === undefined ? null : canonicalStringify(run.records);
    runs.push({
      run_key: runKey,
      repository_id: run.repositoryId,
      run_id: run.runId,
      cursor: run.cursor,
      records_json: recordsJson,
      projection_generated_at: run.projectionGeneratedAt ?? null,
      revision_digest:
        run.records === undefined
          ? null
          : canonicalDigest(canonicalValue(run.records), dependencies.sha256),
    });
    for (const command of run.commands) {
      commands.push({
        command_id: command.commandId,
        run_key: runKey,
        canonical_envelope: command.canonicalEnvelope,
        admission_json: canonicalStringify(command.admission),
        terminal_receipt_json: canonicalStringify(command.receipt),
      });
    }
    const ordinals = new Map<string, number>();
    for (const receipt of run.receiptHistory) {
      const ordinal = (ordinals.get(receipt.commandId) ?? 0) + 1;
      ordinals.set(receipt.commandId, ordinal);
      receiptHistory.push({
        run_key: runKey,
        cursor: receipt.cursor,
        command_id: receipt.commandId,
        ordinal,
        status: receipt.status,
        canonical_receipt: canonicalStringify(receipt),
      });
    }
    for (const event of run.events) {
      if (event.commandId === undefined) {
        throw new TypeError("Persisted command event must identify its command");
      }
      eventFrames.push({
        event_id: event.eventId,
        run_key: runKey,
        cursor: event.cursor,
        command_id: event.commandId,
        event_type: event.eventType,
        canonical_frame: canonicalStringify(event),
      });
    }
  }
  return {
    repositories: [...repositories.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([repositoryId, activeRunKey]) => ({
        repository_id: repositoryId,
        active_run_key: activeRunKey,
      })),
    runs: runs.sort(compareNormalized("run_key")),
    commands: commands.sort(compareNormalized("command_id")),
    receiptHistory: receiptHistory.sort(compareNormalized("run_key", "cursor")),
    eventFrames: eventFrames.sort(compareNormalized("run_key", "cursor")),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNormalized(
  primary: string,
  secondary?: string,
): (left: Record<string, unknown>, right: Record<string, unknown>) => number {
  return (left, right) => {
    const primaryOrder = compareText(String(left[primary]), String(right[primary]));
    if (primaryOrder !== 0 || secondary === undefined) return primaryOrder;
    const leftSecondary = left[secondary];
    const rightSecondary = right[secondary];
    if (typeof leftSecondary === "number" && typeof rightSecondary === "number") {
      return leftSecondary - rightSecondary;
    }
    return compareText(String(leftSecondary), String(rightSecondary));
  };
}

function toAssetDescriptor(row: AssetRow): AssetDescriptor {
  return {
    digest: row.digest,
    byteLength: row.byte_length,
    relativePath: row.relative_path,
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
  };
}

function assertSameDescriptor(row: AssetRow, descriptor: AssetDescriptor): void {
  if (
    row.byte_length !== descriptor.byteLength ||
    row.relative_path !== descriptor.relativePath ||
    row.media_type !== (descriptor.mediaType ?? null)
  ) {
    throw new Error(`Asset digest ${descriptor.digest} is bound to a different descriptor`);
  }
}

function verifyAssetBytes(
  path: string,
  descriptor: AssetDescriptor,
  dependencies: RuntimeDependencies,
): Buffer {
  let bytes: Buffer;
  let file: number | undefined;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== descriptor.byteLength) {
      throw new Error("size mismatch");
    }
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error(`Committed asset ${descriptor.digest} is missing or unreadable`, {
      cause: error,
    });
  } finally {
    if (file !== undefined) closeSync(file);
  }
  if (dependencies.sha256.digest(bytes) !== descriptor.digest) {
    throw new Error(`Committed asset ${descriptor.digest} failed digest verification`);
  }
  return bytes;
}

function resolveAssetPath(assetDirectory: string, relativePath: string): string {
  const root = resolve(assetDirectory);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new TypeError("Asset descriptor path must remain inside the asset directory");
  }
  assertExistingPathComponentsAreDirectories(dirname(path), root);
  return path;
}

function copyAssetSet(
  assets: readonly AssetDescriptor[],
  sourceRoot: string,
  destinationRoot: string,
  dependencies: RuntimeDependencies,
): void {
  ensureSafeDirectoryPath(destinationRoot);
  for (const descriptor of assets) {
    const source = resolveAssetPath(sourceRoot, descriptor.relativePath);
    verifyAssetBytes(source, descriptor, dependencies);
    const destination = resolveAssetPath(destinationRoot, descriptor.relativePath);
    ensureSafeDirectoryPath(dirname(destination), destinationRoot);
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    verifyAssetBytes(destination, descriptor, dependencies);
    fsyncFile(destination);
    fsyncDirectory(dirname(destination));
  }
  fsyncDirectory(destinationRoot);
}

function publishBackupBundleNoReplace(partial: string, destination: string): void {
  let destinationCreated = false;
  try {
    mkdirSync(destination, { mode: 0o700 });
    destinationCreated = true;
    fsyncDirectory(destination);
    fsyncDirectory(dirname(destination));
    renameSync(join(partial, "authority.db"), join(destination, "authority.db"));
    renameSync(join(partial, "assets"), join(destination, "assets"));
    fsyncDirectory(destination);
    renameSync(join(partial, "manifest.json"), join(destination, "manifest.json"));
    fsyncDirectory(destination);
    rmSync(partial, { recursive: true });
    fsyncDirectory(dirname(partial));
  } catch (error) {
    if (destinationCreated) {
      rmSync(destination, { recursive: true, force: true });
      fsyncDirectory(dirname(destination));
    }
    if (isNodeError(error, "EEXIST")) {
      throw new Error("SQLite backup destination already exists", { cause: error });
    }
    throw error;
  }
}

function publishAssetDirectoryNoReplace(partial: string, destination: string): void {
  let destinationCreated = false;
  try {
    mkdirSync(destination, { mode: 0o700 });
    destinationCreated = true;
    fsyncDirectory(destination);
    fsyncDirectory(dirname(destination));
    for (const entry of readdirSync(partial)) {
      renameSync(join(partial, entry), join(destination, entry));
    }
    fsyncDirectory(destination);
    rmSync(partial, { recursive: true });
    fsyncDirectory(dirname(partial));
  } catch (error) {
    if (destinationCreated) {
      rmSync(destination, { recursive: true, force: true });
      fsyncDirectory(dirname(destination));
    }
    if (isNodeError(error, "EEXIST")) {
      throw new Error("SQLite restore asset destination already exists", { cause: error });
    }
    throw error;
  }
}

function verifyBackupBundle(
  backupPath: string,
  dependencies: RuntimeDependencies,
): {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly manifest: BackupManifest;
} {
  const root = resolve(backupPath);
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("SQLite backup must be a real directory");
  }
  ensureSafeDirectoryPath(root);
  const databasePath = join(root, "authority.db");
  const assetDirectory = join(root, "assets");
  const assetMetadata = lstatSync(assetDirectory);
  if (assetMetadata.isSymbolicLink() || !assetMetadata.isDirectory()) {
    throw new Error("SQLite backup assets must be a real directory");
  }
  ensureSafeDirectoryPath(assetDirectory, root);
  const manifest = parseBackupManifest(
    readRegularFile(join(root, "manifest.json")).toString("utf8"),
  );
  verifyDatabaseArtifact(databasePath, manifest, dependencies);
  const database = openReadConnection(databasePath);
  try {
    verifyDatabase(database, dependencies, assetDirectory, true);
    if (
      canonicalStringify(readAssetDescriptors(database)) !== canonicalStringify(manifest.assets)
    ) {
      throw new Error("SQLite backup asset manifest does not match its database");
    }
  } finally {
    database.close();
  }
  return { databasePath, assetDirectory, manifest };
}

function verifyDatabaseArtifact(
  databasePath: string,
  manifest: BackupManifest,
  dependencies: RuntimeDependencies,
): void {
  const databaseBytes = readRegularFile(databasePath);
  if (
    databaseBytes.byteLength !== manifest.database.byteLength ||
    dependencies.sha256.digest(databaseBytes) !== manifest.database.digest
  ) {
    throw new Error("SQLite backup database does not match its manifest");
  }
}

function parseBackupManifest(serialized: string): BackupManifest {
  const value = JSON.parse(serialized) as Partial<BackupManifest>;
  if (
    value.format !== "senawa-sqlite-backup" ||
    value.version !== 1 ||
    value.database?.relativePath !== "authority.db" ||
    !Number.isSafeInteger(value.database.byteLength) ||
    (value.database.byteLength ?? -1) < 0 ||
    !isSha256Digest(value.database.digest ?? "") ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("SQLite backup manifest is invalid");
  }
  for (const descriptor of value.assets) {
    if (
      typeof descriptor !== "object" ||
      descriptor === null ||
      !isSha256Digest(descriptor.digest) ||
      !Number.isSafeInteger(descriptor.byteLength) ||
      descriptor.byteLength < 0 ||
      descriptor.relativePath !==
        join("sha256", descriptor.digest.slice(0, 2), descriptor.digest) ||
      (descriptor.mediaType !== undefined && typeof descriptor.mediaType !== "string")
    ) {
      throw new Error("SQLite backup manifest is invalid");
    }
  }
  return value as BackupManifest;
}

function assertSafeBackupDestination(
  destination: string,
  databasePath: string,
  assetDirectory: string,
): void {
  assertPathMissing(destination, "SQLite backup destination already exists");
  const plannedDestination = plannedRealPath(destination);
  for (const activePath of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    assetDirectory,
  ]) {
    const canonicalActivePath = pathEntryExists(activePath)
      ? realpathSync(activePath)
      : plannedRealPath(activePath);
    if (pathsOverlap(plannedDestination, canonicalActivePath)) {
      throw new Error("SQLite backup destination overlaps active authority storage");
    }
  }
}

function assertFreshRestoreDestinations(
  databasePath: string,
  assetDirectory: string,
  backupPath: string,
): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, assetDirectory]) {
    assertPathMissing(
      path,
      "SQLite restore destination database and assets must not already exist",
    );
  }
  const realBackup = realpathSync(backupPath);
  const realDatabase = plannedRealPath(databasePath);
  const realAssets = plannedRealPath(assetDirectory);
  if (pathsOverlap(realBackup, realDatabase) || pathsOverlap(realBackup, realAssets)) {
    throw new Error("SQLite restore destination must not overlap its backup bundle");
  }
  if (pathsOverlap(realDatabase, realAssets)) {
    throw new Error("SQLite restore database and asset destinations must not overlap");
  }
}

function plannedRealPath(path: string): string {
  ensureSafeDirectoryPath(dirname(path));
  return join(realpathSync(dirname(path)), basename(path));
}

function pathsOverlap(first: string, second: string): boolean {
  const fromFirst = relative(first, second);
  const fromSecond = relative(second, first);
  return (
    fromFirst === "" ||
    (fromFirst !== ".." && !fromFirst.startsWith(`..${sep}`)) ||
    (fromSecond !== ".." && !fromSecond.startsWith(`..${sep}`))
  );
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function assertPathMissing(path: string, message: string): void {
  if (pathEntryExists(path)) throw new Error(message);
}

function readRegularFile(path: string): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`Filesystem path is not an independent regular file: ${path}`);
    }
    return readFileSync(file);
  } finally {
    closeSync(file);
  }
}

function writeExclusiveFile(path: string, contents: string): void {
  const file = openSync(path, "wx", 0o600);
  try {
    writeFileSync(file, contents);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  fsyncDirectory(dirname(path));
}

function mkdirDurably(path: string): void {
  assertPathMissing(path, `Filesystem destination already exists: ${path}`);
  ensureSafeDirectoryPath(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  fsyncDirectory(path);
  fsyncDirectory(dirname(path));
}

function assertExistingPathComponentsAreDirectories(path: string, containmentRoot: string): void {
  const root = resolve(containmentRoot);
  const absolute = resolve(path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error("Filesystem path escapes its containment root");
  }
  let current = root;
  const rootMetadata = lstatSync(current);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Filesystem path component is not a real directory: ${current}`);
  }
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Filesystem path component is not a real directory: ${current}`);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
  if (pathEntryExists(absolute)) {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(absolute);
    const realRelative = relative(realRoot, realPath);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`)) {
      throw new Error("Filesystem path escapes its real containment root");
    }
  }
}

function ensureSafeDirectoryPath(path: string, containmentRoot?: string): void {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const parent = current;
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Filesystem path component is not a real directory: ${current}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
        const metadata = lstatSync(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Filesystem path component is not a real directory: ${current}`);
        }
      }
      fsyncDirectory(current);
      fsyncDirectory(parent);
    }
  }
  if (containmentRoot !== undefined) {
    const realRoot = realpathSync(resolve(containmentRoot));
    const realDirectory = realpathSync(absolute);
    const fromRoot = relative(realRoot, realDirectory);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error("Asset directory path escapes its real asset root");
    }
  }
}

function fsyncFile(path: string): void {
  const file = openSync(path, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function fsyncDirectory(path: string): void {
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function validateTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a UTC RFC 3339 timestamp`);
  }
}

function validateStorageIdentifier(value: string, field: string): void {
  try {
    validateOpaqueIdentity(value);
  } catch (error) {
    throw new TypeError(`${field} must be a non-empty bounded identity`, { cause: error });
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isSqliteLockError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))
  );
}
