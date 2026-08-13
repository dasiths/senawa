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
import {
  canonicalDigest,
  canonicalValue,
  type HistoricalAssetBinding,
  isSha256Digest,
} from "@senawa/kernel";
import {
  canonicalStringify,
  type DurableReceipt,
  decodeCanonicalJsonValue,
  decodeCommandEnvelope,
  decodeDurableReceipt,
  decodeEventReplayPage,
  decodeEventStreamFrame,
  decodeReceiptPage,
  decodeSupervisorAdmissionFacts,
  decodeSupervisorReceipt,
  decodeSupervisorServiceRecord,
  decodeSupervisorWake,
  type EventReplayPage,
  type EventStreamFrame,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ProjectionEnvelope,
  type ReceiptPage,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import {
  type AdmissionFacts,
  type AssetReadInput,
  type AssetReadResult,
  assetReadWorstCaseBytes,
  type ClaimEffectAttemptRequest,
  type ClaimEffectAttemptResult,
  type CommandServicePort,
  type CommitEffectRequest,
  type CompletionFactPort,
  type ContextAuthoritySnapshot,
  ContextBroker,
  type ContextBrokerDependencies,
  type ContextBrokerProjection,
  ContextBrokerTransactionAbortError,
  type ContextGrantInput,
  DEFAULT_POINTER_ASSET_MAX_BYTES,
  decodePersistedAssetReadReplayKey,
  type EffectIntent,
  type EffectOutcome,
  type FencedRunnerCancellationInput,
  type FencedRunnerContextUpdateInput,
  type FinalizedEffectUsage,
  InMemoryAuthority,
  InMemoryContextAuthority,
  type InMemoryRunnerRunInput,
  PageQueryError,
  type PersistIntentRequest,
  type PersistIntentResult,
  type QueuedEffectCommand,
  type RegisterWorkerDispatchInput,
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
  readCanonicalJsonPointer,
  type SerializableAuthorityPort,
  type SubmissionAdmissionInput,
  type SubmissionAdmissionResult,
  selectEffectAttemptAction,
} from "@senawa/runtime";
import Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 4;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT_PAGES = 16_384;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

export type SqliteFaultPoint =
  | "after-command-execution"
  | "before-command-commit"
  | "after-command-commit-before-ack"
  | "after-receipt-page-metadata-read"
  | "after-event-page-metadata-read"
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

export interface RenewLeaseInput extends LeaseGrant {
  readonly currentTime: string;
  readonly newExpiresAt: string;
}

export interface ReleaseLeaseInput extends LeaseGrant {
  readonly currentTime: string;
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

export type SqliteContextBrokerFaultPoint =
  | "after-read-reservation"
  | "before-read-commit"
  | "after-read-commit-before-ack"
  | "before-context-commit"
  | "after-context-commit-before-ack"
  | "before-outbox-ack"
  | "after-outbox-ack-before-return";

export interface SqliteContextBrokerOptions {
  readonly databasePath: string;
  readonly dependencies: ContextBrokerDependencies;
  readonly completionFacts?: CompletionFactPort;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (point: SqliteContextBrokerFaultPoint) => void;
}

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
    validateOpaqueIdentity(commandId);
    const row = this.#database
      .prepare<[string], { terminal_receipt_json: string }>(
        "SELECT terminal_receipt_json FROM commands WHERE command_id = ?",
      )
      .get(commandId);
    return row === undefined ? undefined : decodeDurableReceipt(row.terminal_receipt_json);
  }

  queryReceiptHistory(repositoryId: string, runId: string): readonly DurableReceipt[] {
    return this.#readService().queryReceiptHistory(repositoryId, runId);
  }

  queryReceiptPage(
    repositoryId: string,
    runId: string,
    afterCursor = 0,
    limit: number = PROTOCOL_LIMITS.maxPageItems,
  ): ReceiptPage {
    validateBoundedPageRequest(afterCursor, limit);
    const runKey = canonicalStringify([repositoryId, runId]);
    const readPage = this.#database.transaction(() => {
      const latestCursor =
        this.#database
          .prepare<[string], { cursor: number }>("SELECT cursor FROM runs WHERE run_key = ?")
          .get(runKey)?.cursor ?? 0;
      validatePageCursor(afterCursor, latestCursor);
      this.#fault("after-receipt-page-metadata-read");
      const rows = this.#database
        .prepare<[string, number, number], { canonical_receipt: string }>(
          `SELECT canonical_receipt FROM receipt_history
           WHERE run_key = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
        )
        .all(runKey, afterCursor, limit + 1);
      return { latestCursor, rows };
    });
    const { latestCursor, rows } = readPage.deferred();
    return decodeReceiptPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      afterCursor,
      latestCursor,
      hasMore: rows.length > limit,
      receipts: rows.slice(0, limit).map((row) => decodeDurableReceipt(row.canonical_receipt)),
    });
  }

  queryEvents(repositoryId: string, runId: string, afterCursor = 0): readonly EventStreamFrame[] {
    return this.#readService().queryEvents(repositoryId, runId, afterCursor);
  }

  queryEventPage(
    repositoryId: string,
    runId: string,
    afterCursor = 0,
    limit: number = PROTOCOL_LIMITS.maxPageItems,
  ): EventReplayPage {
    validateBoundedPageRequest(afterCursor, limit);
    const runKey = canonicalStringify([repositoryId, runId]);
    const readPage = this.#database.transaction(() => {
      const latestCursor =
        this.#database
          .prepare<[string], { cursor: number }>("SELECT cursor FROM runs WHERE run_key = ?")
          .get(runKey)?.cursor ?? 0;
      const earliestAvailableCursor =
        this.#database
          .prepare<[string], { earliest_cursor: number | null }>(
            "SELECT MIN(cursor) AS earliest_cursor FROM event_frames WHERE run_key = ?",
          )
          .get(runKey)?.earliest_cursor ?? 0;
      validatePageCursor(afterCursor, latestCursor);
      validateReplayCursor(afterCursor, earliestAvailableCursor);
      this.#fault("after-event-page-metadata-read");
      const rows = this.#database
        .prepare<[string, number, number], { canonical_frame: string }>(
          `SELECT canonical_frame FROM event_frames
           WHERE run_key = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
        )
        .all(runKey, afterCursor, limit + 1);
      return { earliestAvailableCursor, latestCursor, rows };
    });
    const { earliestAvailableCursor, latestCursor, rows } = readPage.deferred();
    return decodeEventReplayPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId,
      afterCursor,
      earliestAvailableCursor,
      latestCursor,
      hasMore: rows.length > limit,
      events: rows.slice(0, limit).map((row) => decodeEventStreamFrame(row.canonical_frame)),
    });
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

  renewLease(input: RenewLeaseInput): LeaseGrant {
    return renewLeaseTransaction(this.#database, input);
  }

  releaseLease(input: ReleaseLeaseInput): void {
    releaseLeaseTransaction(this.#database, input);
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
      if (Date.parse(input.expiresAt) < Date.parse(current.expires_at)) {
        throw new TypeError("Lease reacquisition must not shorten a live expiry");
      }
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

function renewLeaseTransaction(database: Database.Database, input: RenewLeaseInput): LeaseGrant {
  validateStorageIdentifier(input.resourceKey, "resourceKey");
  validateStorageIdentifier(input.ownerId, "ownerId");
  validateTimestamp(input.currentTime, "currentTime");
  validateTimestamp(input.expiresAt, "expiresAt");
  validateTimestamp(input.newExpiresAt, "newExpiresAt");
  if (
    !Number.isSafeInteger(input.fence) ||
    input.fence <= 0 ||
    Date.parse(input.newExpiresAt) <= Date.parse(input.expiresAt) ||
    Date.parse(input.currentTime) >= Date.parse(input.expiresAt)
  ) {
    throw new TypeError("Lease renewal requires a live fence and a later expiry");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        `UPDATE leases SET expires_at = ?
         WHERE resource_key = ? AND owner_id = ? AND fence = ? AND expires_at = ?`,
      )
      .run(input.newExpiresAt, input.resourceKey, input.ownerId, input.fence, input.expiresAt);
    if (result.changes !== 1) throw new StaleLeaseFenceError(input.resourceKey, input.fence);
    database.exec("COMMIT");
    return {
      resourceKey: input.resourceKey,
      ownerId: input.ownerId,
      fence: input.fence,
      expiresAt: input.newExpiresAt,
    };
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function releaseLeaseTransaction(database: Database.Database, input: ReleaseLeaseInput): void {
  validateStorageIdentifier(input.resourceKey, "resourceKey");
  validateStorageIdentifier(input.ownerId, "ownerId");
  validateTimestamp(input.currentTime, "currentTime");
  validateTimestamp(input.expiresAt, "expiresAt");
  if (!Number.isSafeInteger(input.fence) || input.fence <= 0) {
    throw new TypeError("Lease fence must be a positive safe integer");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database
      .prepare<[string], LeaseRow>(
        "SELECT resource_key, owner_id, fence, expires_at FROM leases WHERE resource_key = ?",
      )
      .get(input.resourceKey);
    if (
      current === undefined ||
      current.owner_id !== input.ownerId ||
      current.fence !== input.fence ||
      current.expires_at !== input.expiresAt ||
      Date.parse(input.currentTime) >= Date.parse(current.expires_at)
    ) {
      throw new StaleLeaseFenceError(input.resourceKey, input.fence);
    }
    const result = database
      .prepare(
        `UPDATE leases SET expires_at = ?
         WHERE resource_key = ? AND owner_id = ? AND fence = ? AND expires_at = ?`,
      )
      .run(input.currentTime, input.resourceKey, input.ownerId, input.fence, input.expiresAt);
    if (result.changes !== 1) throw new StaleLeaseFenceError(input.resourceKey, input.fence);
    database.exec("COMMIT");
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

const CONTEXT_ASSET_CHUNK_BYTES = 65_536;
const MAX_VERIFIED_CONTEXT_ASSET_BYTES = 268_435_456;

interface ContextAuthorityStateRow {
  readonly canonical_json: string;
}

interface ContextChunkRow {
  readonly chunk_index: number;
  readonly byte_offset: number;
  readonly byte_length: number;
  readonly chunk_digest: string;
  readonly content: Uint8Array;
}

export class SqliteContextAssetAuthority {
  readCalls = 0;
  readonly broker: SqliteContextBroker;

  constructor(broker: SqliteContextBroker) {
    this.broker = broker;
  }

  put(binding: HistoricalAssetBinding, bytes: Uint8Array): void {
    this.broker.putContextAsset(binding, bytes);
  }

  readAssetRange(
    binding: HistoricalAssetBinding,
    offset: number,
    length: number,
  ): Uint8Array | undefined {
    this.readCalls += 1;
    return this.broker.readContextAssetRange(binding, offset, length);
  }

  readJsonAsset(binding: HistoricalAssetBinding, maxAssetBytes: number): Uint8Array | undefined {
    this.readCalls += 1;
    if (binding.byteLength > maxAssetBytes) return undefined;
    return this.broker.readContextAssetRange(binding, 0, binding.byteLength);
  }
}

export class SqliteContextBroker {
  readonly databasePath: string;
  readonly dependencies: ContextBrokerDependencies;
  readonly assets: SqliteContextAssetAuthority;
  readonly authority: {
    snapshot: () => ContextAuthoritySnapshot;
    projection: () => ContextBrokerProjection;
    toCanonicalJson: () => string;
    toDurableCanonicalJson: () => string;
  };
  readonly #database: Database.Database;
  readonly #completionFacts: CompletionFactPort | undefined;
  readonly #faultInjector: ((point: SqliteContextBrokerFaultPoint) => void) | undefined;
  readonly #deliveringSubmissionIds = new Set<string>();
  #readQueue: Promise<void> = Promise.resolve();

  constructor(options: SqliteContextBrokerOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = Object.freeze({
      sha256: options.dependencies.sha256,
      currentTime: options.dependencies.currentTime,
      issueGrantToken: options.dependencies.issueGrantToken,
    });
    this.#completionFacts = options.completionFacts;
    this.#faultInjector = options.faultInjector;
    ensureSafeDirectoryPath(dirname(this.databasePath));
    this.#database = new Database(this.databasePath, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    try {
      configureWriteConnection(this.#database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      applyMigrations(this.#database, this.dependencies);
      this.#verifyContextStorage();
    } catch (error) {
      this.#database.close();
      throw error;
    }
    this.assets = new SqliteContextAssetAuthority(this);
    this.authority = Object.freeze({
      snapshot: () => this.#loadAuthority().snapshot(),
      projection: () => this.#loadAuthority().projection(),
      toCanonicalJson: () => this.#loadAuthority().toCanonicalJson(),
      toDurableCanonicalJson: () => this.#readContextState(),
    });
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  registerDispatch(input: RegisterWorkerDispatchInput) {
    return this.#transact((broker) => broker.registerDispatch(input));
  }

  loadWorkerDispatch(dispatchId: string) {
    return this.#loadBroker().loadWorkerDispatch(dispatchId);
  }

  loadWorkerDispatchProgress(dispatchId: string) {
    return this.#loadBroker().loadWorkerDispatchProgress(dispatchId);
  }

  grantAssetAccess(input: ContextGrantInput) {
    return this.#transact((broker) => broker.grantAssetAccess(input));
  }

  async readAsset(input: AssetReadInput): Promise<AssetReadResult> {
    return this.#serializeRead(() => this.#readAssetTransaction(input));
  }

  async #readAssetTransaction(input: AssetReadInput): Promise<AssetReadResult> {
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const authority = this.#loadAuthority();
      const broker = new ContextBroker(this.assets, this.dependencies, authority);
      const result = await broker.readAsset(input);
      this.#persistContextAuthority(authority);
      this.#fault("before-read-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-read-commit-before-ack");
      return result;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  admitSubmission(input: SubmissionAdmissionInput): SubmissionAdmissionResult {
    const result = this.#transact((broker) => broker.admitSubmission(input));
    this.deliverCompletionFact(result.submissionId);
    return result;
  }

  deliverCompletionFact(submissionId: string): boolean {
    if (this.#completionFacts === undefined || this.#deliveringSubmissionIds.has(submissionId))
      return false;
    this.#deliveringSubmissionIds.add(submissionId);
    try {
      const pending = this.#loadAuthority().completionOutbox.get(submissionId);
      if (pending === undefined || pending.delivered) return false;
      this.#completionFacts.admitCompletionFact(pending.fact);
      this.#database.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const current = this.#loadAuthority();
        const currentPending = current.completionOutbox.get(submissionId);
        if (currentPending === undefined || currentPending.delivered) {
          this.#database.exec("COMMIT");
          committed = true;
          return false;
        }
        currentPending.delivered = true;
        this.#persistContextAuthority(current);
        this.#fault("before-outbox-ack");
        this.#database.exec("COMMIT");
        committed = true;
        this.#fault("after-outbox-ack-before-return");
        return true;
      } catch (error) {
        if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.#deliveringSubmissionIds.delete(submissionId);
    }
  }

  deliverCompletionOutboxOnce(): boolean {
    const pending = [...this.#loadAuthority().completionOutbox.entries()]
      .filter(([, fact]) => !fact.delivered)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))[0];
    return pending === undefined ? false : this.deliverCompletionFact(pending[0]);
  }

  putContextAsset(binding: HistoricalAssetBinding, input: Uint8Array): void {
    const bytes = Uint8Array.from(input);
    if (
      bytes.byteLength !== binding.byteLength ||
      this.dependencies.sha256.digest(bytes) !== binding.contentDigest
    )
      throw new TypeError("Context asset bytes do not match their historical binding");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare<[string], { content_digest: string; byte_length: number }>(
          `SELECT content_digest, byte_length FROM context_asset_bindings
           WHERE asset_binding_id = ?`,
        )
        .get(binding.assetBindingId);
      if (
        row === undefined ||
        row.content_digest !== binding.contentDigest ||
        row.byte_length !== binding.byteLength
      )
        throw new TypeError("Context asset binding is not registered with exact canonical facts");
      const chunkCount = Math.ceil(bytes.byteLength / CONTEXT_ASSET_CHUNK_BYTES);
      const existing = this.#database
        .prepare<[string], { content_digest: string; byte_length: number; chunk_count: number }>(
          `SELECT content_digest, byte_length, chunk_count FROM context_asset_manifests
           WHERE asset_binding_id = ?`,
        )
        .get(binding.assetBindingId);
      if (existing !== undefined) {
        if (
          existing.content_digest !== binding.contentDigest ||
          existing.byte_length !== binding.byteLength ||
          existing.chunk_count !== chunkCount
        )
          throw new TypeError("Context asset identity is already bound to different content");
        verifyContextAssetManifest(
          this.#database,
          binding.assetBindingId,
          this.dependencies.sha256,
        );
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare(
          `INSERT INTO context_asset_manifests(
             asset_binding_id, content_digest, byte_length, chunk_size, chunk_count
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          binding.assetBindingId,
          binding.contentDigest,
          binding.byteLength,
          CONTEXT_ASSET_CHUNK_BYTES,
          chunkCount,
        );
      const insertChunk = this.#database.prepare(
        `INSERT INTO context_asset_chunks(
           asset_binding_id, chunk_index, byte_offset, byte_length, chunk_digest, content
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const byteOffset = chunkIndex * CONTEXT_ASSET_CHUNK_BYTES;
        const chunk = bytes.slice(byteOffset, byteOffset + CONTEXT_ASSET_CHUNK_BYTES);
        insertChunk.run(
          binding.assetBindingId,
          chunkIndex,
          byteOffset,
          chunk.byteLength,
          this.dependencies.sha256.digest(chunk),
          chunk,
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  readContextAssetRange(
    binding: HistoricalAssetBinding,
    offset: number,
    length: number,
  ): Uint8Array | undefined {
    this.#fault("after-read-reservation");
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > binding.byteLength ||
      length > binding.byteLength - offset
    )
      return undefined;
    const manifest = this.#database
      .prepare<
        [string],
        { content_digest: string; byte_length: number; chunk_size: number; chunk_count: number }
      >(
        `SELECT content_digest, byte_length, chunk_size, chunk_count
         FROM context_asset_manifests WHERE asset_binding_id = ?`,
      )
      .get(binding.assetBindingId);
    if (
      manifest === undefined ||
      manifest.content_digest !== binding.contentDigest ||
      manifest.byte_length !== binding.byteLength ||
      manifest.chunk_size !== CONTEXT_ASSET_CHUNK_BYTES ||
      manifest.chunk_count !== expectedContextChunkCount(binding.byteLength)
    )
      return undefined;
    if (length === 0) {
      const empty = new Uint8Array();
      return offset === 0 &&
        binding.byteLength === 0 &&
        this.dependencies.sha256.digest(empty) !== binding.contentDigest
        ? undefined
        : empty;
    }
    const firstChunk = Math.floor(offset / CONTEXT_ASSET_CHUNK_BYTES);
    const lastChunk = Math.floor((offset + length - 1) / CONTEXT_ASSET_CHUNK_BYTES);
    const rows = this.#database
      .prepare<[string, number, number], ContextChunkRow>(
        `SELECT chunk_index, byte_offset, byte_length, chunk_digest, content
         FROM context_asset_chunks
         WHERE asset_binding_id = ? AND chunk_index BETWEEN ? AND ?
         ORDER BY chunk_index`,
      )
      .all(binding.assetBindingId, firstChunk, lastChunk);
    if (rows.length !== lastChunk - firstChunk + 1) return undefined;
    const result = new Uint8Array(length);
    for (const [index, row] of rows.entries()) {
      const content = Uint8Array.from(row.content);
      const expectedIndex = firstChunk + index;
      const expectedLength = expectedContextChunkLength(
        binding.byteLength,
        manifest.chunk_count,
        expectedIndex,
      );
      if (
        row.chunk_index !== expectedIndex ||
        row.byte_length !== content.byteLength ||
        row.byte_length !== expectedLength ||
        row.byte_offset !== row.chunk_index * CONTEXT_ASSET_CHUNK_BYTES ||
        this.dependencies.sha256.digest(content) !== row.chunk_digest
      )
        return undefined;
      const copyStart = Math.max(offset, row.byte_offset);
      const copyEnd = Math.min(offset + length, row.byte_offset + row.byte_length);
      result.set(
        content.slice(copyStart - row.byte_offset, copyEnd - row.byte_offset),
        copyStart - offset,
      );
    }
    if (
      offset === 0 &&
      length === binding.byteLength &&
      this.dependencies.sha256.digest(result) !== binding.contentDigest
    )
      return undefined;
    return result;
  }

  #serializeRead<Result>(operation: () => Promise<Result>): Promise<Result> {
    const prior = this.#readQueue;
    let release: () => void = () => undefined;
    this.#readQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prior.then(operation).finally(release);
  }

  #transact<Result>(operation: (broker: ContextBroker) => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const authority = this.#loadAuthority();
      const broker = new ContextBroker(this.assets, this.dependencies, authority);
      const result = operation(broker);
      this.#persistContextAuthority(authority);
      this.#fault("before-context-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#fault("after-context-commit-before-ack");
      return result;
    } catch (error) {
      if (!committed && this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #loadBroker(): ContextBroker {
    return new ContextBroker(this.assets, this.dependencies, this.#loadAuthority());
  }

  #readContextState(): string {
    const row = this.#database
      .prepare<[], ContextAuthorityStateRow>(
        "SELECT canonical_json FROM context_authority_state WHERE singleton = 1",
      )
      .get();
    if (row === undefined) throw new Error("SQLite context authority singleton is missing");
    return row.canonical_json;
  }

  #loadAuthority(): InMemoryContextAuthority {
    return InMemoryContextAuthority.fromDurableCanonicalJson(
      this.#readContextState(),
      this.dependencies.sha256,
    );
  }

  #persistContextAuthority(authority: InMemoryContextAuthority): void {
    const serialized = authority.toDurableCanonicalJson();
    this.#database
      .prepare("UPDATE context_authority_state SET canonical_json = ? WHERE singleton = 1")
      .run(serialized);
    this.#mirrorContextAuthority(authority);
  }

  #mirrorContextAuthority(authority: InMemoryContextAuthority): void {
    const normalized = normalizeContextAuthority(authority);
    for (const row of normalized.contextBases) {
      this.#database
        .prepare(
          `INSERT INTO context_bases(context_id, context_digest, canonical_context)
           VALUES (?, ?, ?) ON CONFLICT(context_id) DO NOTHING`,
        )
        .run(row.context_id, row.context_digest, row.canonical_context);
    }
    for (const row of normalized.dispatches) {
      this.#database
        .prepare(
          `INSERT INTO context_dispatches(
             dispatch_id, repository_id, run_id, context_id, prompt_pack_digest,
             canonical_dispatch, canonical_completion_requirements
           ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dispatch_id) DO NOTHING`,
        )
        .run(
          row.dispatch_id,
          row.repository_id,
          row.run_id,
          row.context_id,
          row.prompt_pack_digest,
          row.canonical_dispatch,
          row.canonical_completion_requirements,
        );
    }
    for (const row of normalized.bindings)
      this.#database
        .prepare(
          `INSERT INTO context_asset_bindings(
             asset_binding_id, context_id, semantic_asset_id, alias_binding_digest,
             content_digest, byte_length, media_type, sensitivity
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(asset_binding_id) DO NOTHING`,
        )
        .run(
          row.asset_binding_id,
          row.context_id,
          row.semantic_asset_id,
          row.alias_binding_digest,
          row.content_digest,
          row.byte_length,
          row.media_type,
          row.sensitivity,
        );
    this.#database.exec(
      `DELETE FROM context_audit_receipts;
       DELETE FROM context_events;
       DELETE FROM context_questions;
       DELETE FROM context_terminal_completions;
       DELETE FROM context_completion_outbox;
       DELETE FROM context_read_attempts;
       DELETE FROM context_grants;
       DELETE FROM context_submissions;`,
    );
    for (const row of normalized.grants)
      this.#database
        .prepare(
          `INSERT INTO context_grants(
             token_digest, dispatch_id, repository_id, run_id, asset_binding_id,
             canonical_envelope, operations_used, bytes_used
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.token_digest,
          row.dispatch_id,
          row.repository_id,
          row.run_id,
          row.asset_binding_id,
          row.canonical_envelope,
          row.operations_used,
          row.bytes_used,
        );
    for (const row of normalized.readAttempts) {
      this.#database
        .prepare(
          `INSERT INTO context_read_attempts(
             request_id, token_digest, dispatch_id, repository_id, run_id,
             canonical_replay_key, replay_key_digest, request_digest, status,
             result_bytes, canonical_receipt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.request_id,
          row.token_digest,
          row.dispatch_id,
          row.repository_id,
          row.run_id,
          row.canonical_replay_key,
          row.replay_key_digest,
          row.request_digest,
          row.status,
          row.result_bytes === null ? null : Uint8Array.from(row.result_bytes),
          row.canonical_receipt,
        );
    }
    for (const row of normalized.receipts) {
      this.#database
        .prepare(
          `INSERT INTO context_audit_receipts(
             receipt_cursor, request_id, repository_id, run_id, dispatch_id,
             canonical_replay_key, replay_key_digest, token_digest, request_digest,
             reserved, failure_stage, failure_fact_digest, canonical_receipt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.receipt_cursor,
          row.request_id,
          row.repository_id,
          row.run_id,
          row.dispatch_id,
          row.canonical_replay_key,
          row.replay_key_digest,
          row.token_digest,
          row.request_digest,
          row.reserved,
          row.failure_stage,
          row.failure_fact_digest,
          row.canonical_receipt,
        );
    }
    for (const row of normalized.submissions)
      this.#database
        .prepare(
          `INSERT INTO context_submissions(
             submission_id, repository_id, run_id, dispatch_id, submission_type,
             canonical_submission, canonical_result
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.submission_id,
          row.repository_id,
          row.run_id,
          row.dispatch_id,
          row.submission_type,
          row.canonical_submission,
          row.canonical_result,
        );
    for (const row of normalized.questions)
      this.#database
        .prepare(
          `INSERT INTO context_questions(submission_id, repository_id, run_id, canonical_question)
           VALUES (?, ?, ?, ?)`,
        )
        .run(row.submission_id, row.repository_id, row.run_id, row.canonical_question);
    for (const row of normalized.terminalCompletions)
      this.#database
        .prepare(
          "INSERT INTO context_terminal_completions(dispatch_id, submission_id) VALUES (?, ?)",
        )
        .run(row.dispatch_id, row.submission_id);
    for (const row of normalized.completionOutbox)
      this.#database
        .prepare(
          `INSERT INTO context_completion_outbox(
             submission_id, dispatch_id, canonical_fact, delivered
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(row.submission_id, row.dispatch_id, row.canonical_fact, row.delivered);
    for (const row of normalized.events)
      this.#database
        .prepare(
          `INSERT INTO context_events(
             cursor, repository_id, run_id, dispatch_id, event_type, canonical_event
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.cursor,
          row.repository_id,
          row.run_id,
          row.dispatch_id,
          row.event_type,
          row.canonical_event,
        );
    const projection = normalized.projection[0];
    if (projection === undefined) throw new Error("Context projection normalization failed");
    this.#database
      .prepare(
        `INSERT INTO context_projection(singleton, cursor, canonical_projection)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           cursor = excluded.cursor, canonical_projection = excluded.canonical_projection`,
      )
      .run(projection.cursor, projection.canonical_projection);
  }

  #verifyContextStorage(): void {
    const quickCheck = this.#database.pragma("quick_check(1)") as { quick_check: string }[];
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok")
      throw new Error("SQLite context authority quick_check failed");
    if ((this.#database.pragma("foreign_key_check") as unknown[]).length > 0)
      throw new Error("SQLite context authority foreign_key_check failed");
    verifyContextTables(this.#database, this.dependencies);
  }

  #fault(point: SqliteContextBrokerFaultPoint): void {
    try {
      this.#faultInjector?.(point);
    } catch (error) {
      if (point === "after-read-reservation")
        throw new ContextBrokerTransactionAbortError(
          error instanceof Error ? error.message : "Injected context read transaction abort",
        );
      throw error;
    }
  }
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

function applyMigrations(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
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

function loadMigrations(dependencies: Pick<RuntimeDependencies, "sha256">): readonly Migration[] {
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
  verifyContextTables(database, dependencies);
  verifySupervisorTables(database);
  if (!verifyAssets) return;
  for (const descriptor of readAssetDescriptors(database)) {
    verifyAssetBytes(
      resolveAssetPath(assetDirectory, descriptor.relativePath),
      descriptor,
      dependencies,
    );
  }
}

function verifyContextTables(
  database: Database.Database,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): void {
  const state = database
    .prepare<[], ContextAuthorityStateRow>(
      "SELECT canonical_json FROM context_authority_state WHERE singleton = 1",
    )
    .get();
  if (state === undefined) throw new Error("SQLite context authority singleton is missing");
  const authority = InMemoryContextAuthority.fromDurableCanonicalJson(
    state.canonical_json,
    dependencies.sha256,
  );
  verifyNormalizedContextAuthority(database, authority);
  verifyAllContextAssetManifests(database, dependencies.sha256);
  verifyDurableContextReads(database, authority);
}

function verifySupervisorTables(database: Database.Database): void {
  const repositoryRows = database
    .prepare("SELECT repository_id FROM supervisor_repositories ORDER BY repository_id")
    .all() as { readonly repository_id: string }[];
  const repositoryIds = new Set(repositoryRows.map((row) => row.repository_id));
  const registryRows = database
    .prepare(
      `SELECT repository_id, canonical_path, config_snapshot_id
       FROM supervisor_repository_registry ORDER BY repository_id`,
    )
    .all() as {
    readonly repository_id: string;
    readonly canonical_path: string;
    readonly config_snapshot_id: string;
  }[];
  for (const row of registryRows) {
    validateOpaqueIdentity(row.repository_id);
    validateOpaqueIdentity(row.config_snapshot_id);
    if (
      !repositoryIds.has(row.repository_id) ||
      resolve(row.canonical_path) !== row.canonical_path
    ) {
      throw new Error("Supervisor repository registry row is invalid");
    }
  }
  const runRows = database
    .prepare(
      `SELECT run_key, repository_id, run_id
       FROM supervisor_runs ORDER BY run_key`,
    )
    .all() as {
    readonly run_key: string;
    readonly repository_id: string;
    readonly run_id: string;
  }[];
  const commandRows = database
    .prepare(
      `SELECT command_id, run_key, accepted_sequence, canonical_envelope,
              canonical_admission, state, accepted_at, accepted_at_ms,
              claim_owner_id, claim_fence, claim_expires_at, claim_expires_at_ms,
              terminal_receipt_json
       FROM supervisor_commands ORDER BY run_key, accepted_sequence`,
    )
    .all() as SupervisorCommandVerificationRow[];
  const receiptRows = database
    .prepare(
      `SELECT run_key, sequence, command_id, status, recorded_at, recorded_at_ms,
              canonical_receipt
       FROM supervisor_receipts ORDER BY run_key, sequence`,
    )
    .all() as SupervisorReceiptVerificationRow[];
  const wakeRows = database
    .prepare(
      `SELECT w.run_key, r.repository_id, r.run_id, w.generation, w.ack_generation,
              w.not_before, w.not_before_ms, w.reasons_json
       FROM supervisor_wakes w
       JOIN supervisor_runs r ON r.run_key = w.run_key
       ORDER BY w.run_key`,
    )
    .all() as SupervisorWakeVerificationRow[];
  const authorityCommandRows = database
    .prepare(
      `SELECT command_id, run_key, canonical_envelope, terminal_receipt_json
       FROM commands ORDER BY command_id`,
    )
    .all() as {
    readonly command_id: string;
    readonly run_key: string;
    readonly canonical_envelope: string;
    readonly terminal_receipt_json: string;
  }[];

  const repositories = new Set<string>();
  for (const row of repositoryRows) {
    validateStorageIdentifier(row.repository_id, "supervisor repository_id");
    repositories.add(row.repository_id);
  }
  if (repositories.size !== repositoryRows.length) {
    throw new Error("Supervisor repositories contain duplicate identities");
  }

  const runs = new Map<
    string,
    {
      readonly repositoryId: string;
      readonly runId: string;
      readonly commands: SupervisorCommandVerificationRow[];
    }
  >();
  const referencedRepositories = new Set<string>();
  for (const row of runRows) {
    validateStorageIdentifier(row.repository_id, "supervisor run repository_id");
    validateStorageIdentifier(row.run_id, "supervisor run run_id");
    const expectedRunKey = canonicalStringify([row.repository_id, row.run_id]);
    if (row.run_key !== expectedRunKey || runs.has(row.run_key)) {
      throw new Error("Supervisor run identity does not match its canonical run key");
    }
    referencedRepositories.add(row.repository_id);
    runs.set(row.run_key, {
      repositoryId: row.repository_id,
      runId: row.run_id,
      commands: [],
    });
  }
  if ([...referencedRepositories].some((repositoryId) => !repositories.has(repositoryId))) {
    throw new Error("Supervisor run references a missing repository row");
  }

  const authorityCommands = new Map(authorityCommandRows.map((row) => [row.command_id, row]));
  const commands = new Map<string, SupervisorCommandVerificationRow>();
  for (const row of commandRows) {
    const run = runs.get(row.run_key);
    if (run === undefined || commands.has(row.command_id)) {
      throw new Error("Supervisor command references an invalid run or duplicate command identity");
    }
    const envelope = decodeCommandEnvelope(row.canonical_envelope);
    const admission = decodeSupervisorAdmissionFacts(row.canonical_admission);
    if (
      envelope.commandId !== row.command_id ||
      envelope.repositoryId !== run.repositoryId ||
      envelope.runId !== run.runId ||
      admission.currentTime !== row.accepted_at ||
      timestampEpoch(row.accepted_at, "supervisor accepted_at") !== row.accepted_at_ms ||
      !Number.isSafeInteger(row.accepted_sequence) ||
      row.accepted_sequence <= 0
    ) {
      throw new Error("Supervisor command columns diverge from canonical command content");
    }
    verifySupervisorClaimColumns(row);
    const authorityCommand = authorityCommands.get(row.command_id);
    if (authorityCommand !== undefined) {
      const authorityEnvelope = decodeCommandEnvelope(authorityCommand.canonical_envelope);
      const authorityReceipt = decodeDurableReceipt(authorityCommand.terminal_receipt_json);
      if (
        authorityCommand.run_key !== row.run_key ||
        authorityCommand.canonical_envelope !== row.canonical_envelope ||
        authorityEnvelope.commandId !== row.command_id ||
        authorityReceipt.commandId !== row.command_id ||
        authorityReceipt.repositoryId !== run.repositoryId ||
        authorityReceipt.runId !== run.runId ||
        authorityReceipt.status === "queued" ||
        authorityReceipt.status === "claimed"
      ) {
        throw new Error("Supervisor command diverges from its underlying authority command");
      }
      if (row.state === "queued") {
        throw new Error("Queued supervisor command cannot already exist in command authority");
      }
    }
    if (row.state === "terminal") {
      if (
        row.terminal_receipt_json === null ||
        authorityCommand === undefined ||
        row.terminal_receipt_json !== authorityCommand.terminal_receipt_json
      ) {
        throw new Error("Terminal supervisor command lacks its exact authority receipt");
      }
      const terminal = decodeDurableReceipt(row.terminal_receipt_json);
      if (
        terminal.commandId !== row.command_id ||
        terminal.repositoryId !== run.repositoryId ||
        terminal.runId !== run.runId ||
        terminal.status === "queued" ||
        terminal.status === "claimed"
      ) {
        throw new Error("Terminal supervisor command receipt identity or status is invalid");
      }
    } else if (row.terminal_receipt_json !== null) {
      throw new Error("Nonterminal supervisor command stores a terminal receipt");
    }
    commands.set(row.command_id, row);
    run.commands.push(row);
  }

  for (const [runKey, run] of runs) {
    if (run.commands.length === 0) {
      throw new Error("Supervisor run must contain at least one command");
    }
    for (const [index, command] of run.commands.entries()) {
      if (command.accepted_sequence !== index + 1 || command.run_key !== runKey) {
        throw new Error("Supervisor accepted command sequence is not contiguous within its run");
      }
    }
  }

  const receiptsByCommand = new Map<string, SupervisorReceiptVerificationRow[]>();
  const nextReceiptSequence = new Map<string, number>();
  for (const row of receiptRows) {
    const command = commands.get(row.command_id);
    const run = runs.get(row.run_key);
    const expectedSequence = nextReceiptSequence.get(row.run_key) ?? 1;
    const receipt = decodeSupervisorReceipt(row.canonical_receipt);
    if (
      command === undefined ||
      run === undefined ||
      command.run_key !== row.run_key ||
      row.sequence !== expectedSequence ||
      receipt.sequence !== row.sequence ||
      receipt.commandId !== row.command_id ||
      receipt.repositoryId !== run.repositoryId ||
      receipt.runId !== run.runId ||
      receipt.status !== row.status ||
      receipt.recordedAt !== row.recorded_at ||
      timestampEpoch(row.recorded_at, "supervisor recorded_at") !== row.recorded_at_ms ||
      ((row.status === "queued" || row.status === "terminal") &&
        (row.recorded_at !== command.accepted_at || row.recorded_at_ms !== command.accepted_at_ms))
    ) {
      throw new Error("Supervisor receipt columns diverge from canonical staged history");
    }
    nextReceiptSequence.set(row.run_key, expectedSequence + 1);
    const history = receiptsByCommand.get(row.command_id) ?? [];
    history.push(row);
    receiptsByCommand.set(row.command_id, history);
  }

  for (const command of commandRows) {
    const history = receiptsByCommand.get(command.command_id) ?? [];
    const expectedStatuses =
      command.state === "queued"
        ? ["queued"]
        : command.state === "claimed"
          ? ["queued", "claimed"]
          : ["queued", "claimed", "terminal"];
    if (
      canonicalStringify(history.map((row) => row.status)) !== canonicalStringify(expectedStatuses)
    ) {
      throw new Error("Supervisor command staged history does not match its latest state");
    }
    const latest = history.at(-1);
    if (latest === undefined || latest.status !== command.state) {
      throw new Error("Supervisor command latest staged receipt does not match command state");
    }
    if (command.state === "terminal") {
      const receipt = decodeSupervisorReceipt(latest.canonical_receipt);
      if (
        receipt.terminalReceipt === undefined ||
        canonicalStringify(receipt.terminalReceipt) !== command.terminal_receipt_json
      ) {
        throw new Error("Supervisor terminal staged receipt does not match authority receipt");
      }
    }
  }

  if (wakeRows.length !== runs.size) {
    throw new Error("Supervisor wakes do not exactly cover supervisor runs");
  }
  for (const row of wakeRows) {
    const run = runs.get(row.run_key);
    const reasons = JSON.parse(row.reasons_json) as unknown;
    const wake = decodeSupervisorWake({
      repositoryId: row.repository_id,
      runId: row.run_id,
      generation: row.generation,
      acknowledgedGeneration: row.ack_generation,
      notBefore: row.not_before,
      reasons,
    });
    const latestCommand = run?.commands.at(-1);
    const hasPendingWork = run?.commands.some((command) => command.state !== "terminal") ?? false;
    if (
      run === undefined ||
      wake.repositoryId !== run.repositoryId ||
      wake.runId !== run.runId ||
      row.reasons_json !== canonicalStringify(wake.reasons) ||
      row.generation !== run.commands.length ||
      latestCommand === undefined ||
      wake.notBefore !== latestCommand.accepted_at ||
      timestampEpoch(row.not_before, "supervisor wake not_before") !== row.not_before_ms ||
      (hasPendingWork && row.ack_generation >= row.generation) ||
      (!hasPendingWork && row.ack_generation !== row.generation)
    ) {
      throw new Error("Supervisor wake does not match its run command state");
    }
  }

  const serviceRows = database
    .prepare(
      `SELECT singleton, desired_mode, updated_at, updated_at_ms
       FROM supervisor_service_state ORDER BY singleton`,
    )
    .all() as {
    readonly singleton: number;
    readonly desired_mode: string;
    readonly updated_at: string;
    readonly updated_at_ms: number;
  }[];
  if (serviceRows.length !== 1 || serviceRows[0]?.singleton !== 1) {
    throw new Error("Supervisor service state must contain exactly one singleton");
  }
  const service = decodeSupervisorServiceRecord({
    mode: serviceRows[0].desired_mode,
    changedAt: serviceRows[0].updated_at,
  });
  if (
    timestampEpoch(service.changedAt, "supervisor service changedAt") !==
    serviceRows[0].updated_at_ms
  ) {
    throw new Error("Supervisor service timestamp does not match its epoch value");
  }

  const logRows = database
    .prepare(
      `SELECT cursor, recorded_at, recorded_at_ms, level, event, message, fields_json
       FROM supervisor_logs ORDER BY cursor`,
    )
    .all() as {
    readonly cursor: number;
    readonly recorded_at: string;
    readonly recorded_at_ms: number;
    readonly level: string;
    readonly event: string;
    readonly message: string;
    readonly fields_json: string;
  }[];
  let previousCursor = 0;
  for (const row of logRows) {
    const fields = decodeCanonicalJsonValue(row.fields_json);
    if (
      !Number.isSafeInteger(row.cursor) ||
      row.cursor <= previousCursor ||
      timestampEpoch(row.recorded_at, "supervisor log recordedAt") !== row.recorded_at_ms ||
      !["debug", "info", "warn", "error"].includes(row.level) ||
      row.event.length === 0 ||
      row.event.length > 128 ||
      row.message.length === 0 ||
      row.message.length > 2_048 ||
      containsControlCharacter(row.event) ||
      containsControlCharacter(row.message) ||
      canonicalStringify(fields) !== row.fields_json
    ) {
      throw new Error("Supervisor log row is invalid");
    }
    previousCursor = row.cursor;
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

interface SupervisorCommandVerificationRow {
  readonly command_id: string;
  readonly run_key: string;
  readonly accepted_sequence: number;
  readonly canonical_envelope: string;
  readonly canonical_admission: string;
  readonly state: "queued" | "claimed" | "terminal";
  readonly accepted_at: string;
  readonly accepted_at_ms: number;
  readonly claim_owner_id: string | null;
  readonly claim_fence: number | null;
  readonly claim_expires_at: string | null;
  readonly claim_expires_at_ms: number | null;
  readonly terminal_receipt_json: string | null;
}

interface SupervisorReceiptVerificationRow {
  readonly run_key: string;
  readonly sequence: number;
  readonly command_id: string;
  readonly status: "queued" | "claimed" | "terminal";
  readonly recorded_at: string;
  readonly recorded_at_ms: number;
  readonly canonical_receipt: string;
}

interface SupervisorWakeVerificationRow {
  readonly run_key: string;
  readonly repository_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly ack_generation: number;
  readonly not_before: string;
  readonly not_before_ms: number;
  readonly reasons_json: string;
}

function verifySupervisorClaimColumns(row: SupervisorCommandVerificationRow): void {
  if (row.state !== "claimed") {
    if (
      row.claim_owner_id !== null ||
      row.claim_fence !== null ||
      row.claim_expires_at !== null ||
      row.claim_expires_at_ms !== null
    ) {
      throw new Error("Nonclaimed supervisor command contains claim fields");
    }
    return;
  }
  if (
    row.claim_owner_id === null ||
    row.claim_fence === null ||
    !Number.isSafeInteger(row.claim_fence) ||
    row.claim_fence <= 0 ||
    row.claim_expires_at === null ||
    row.claim_expires_at_ms === null
  ) {
    throw new Error("Claimed supervisor command lacks exact claim fields");
  }
  validateStorageIdentifier(row.claim_owner_id, "supervisor claim owner");
  if (timestampEpoch(row.claim_expires_at, "supervisor claim expiry") !== row.claim_expires_at_ms) {
    throw new Error("Supervisor claim expiry does not match its epoch value");
  }
}

function timestampEpoch(value: string, field: string): number {
  validateTimestamp(value, field);
  const epoch = Date.parse(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (!Number.isSafeInteger(epoch) || new Date(value).toISOString() !== normalized) {
    throw new TypeError(`${field} must be an exact UTC timestamp`);
  }
  return epoch;
}

function normalizeContextAuthority(authority: InMemoryContextAuthority) {
  const snapshot = authority.snapshot();
  const durable = authority.durableSnapshot();
  const completionRequirements = new Map(
    durable.dispatches.map((record) => [
      record.dispatch.dispatchId,
      canonicalStringify(record.completionRequirements),
    ]),
  );
  return {
    contextBases: snapshot.contexts.map((context) => ({
      context_id: context.contextId,
      context_digest: context.contextDigest,
      canonical_context: canonicalStringify(context),
    })),
    dispatches: snapshot.dispatches.map((dispatch) => ({
      dispatch_id: dispatch.dispatchId,
      repository_id: dispatch.repositoryId,
      run_id: dispatch.runId,
      context_id: dispatch.contextId,
      prompt_pack_digest: dispatch.promptPackDigest,
      canonical_dispatch: canonicalStringify(dispatch),
      canonical_completion_requirements:
        completionRequirements.get(dispatch.dispatchId) ??
        (() => {
          throw new Error("Context dispatch normalization is missing completion requirements");
        })(),
    })),
    bindings: snapshot.contexts
      .flatMap((context) =>
        context.assets.map((binding) => ({
          asset_binding_id: binding.assetBindingId,
          context_id: context.contextId,
          semantic_asset_id: binding.semanticAssetId,
          alias_binding_digest: binding.aliasBindingDigest,
          content_digest: binding.contentDigest,
          byte_length: binding.byteLength,
          media_type: binding.mediaType,
          sensitivity: binding.sensitivity,
        })),
      )
      .sort((left, right) => compareNormalizedText(left.asset_binding_id, right.asset_binding_id)),
    grants: snapshot.grants.map((grant) => ({
      token_digest: grant.tokenDigest,
      dispatch_id: grant.envelope.dispatchId,
      repository_id: grant.envelope.repositoryId,
      run_id: grant.envelope.runId,
      asset_binding_id: grant.envelope.assetBindingId,
      canonical_envelope: canonicalStringify(grant.envelope),
      operations_used: grant.operationsUsed,
      bytes_used: grant.bytesUsed,
    })),
    readAttempts: durable.reads
      .map((read) => {
        return {
          request_id: read.requestId,
          token_digest: read.tokenDigest,
          dispatch_id:
            read.result.receipt.dispatchId === "dispatch_unknown"
              ? null
              : read.result.receipt.dispatchId,
          repository_id: read.result.receipt.repositoryId,
          run_id: read.result.receipt.runId,
          canonical_replay_key: read.canonicalReplayKey,
          replay_key_digest: read.replayKeyDigest,
          request_digest: read.requestDigest,
          status: read.result.status,
          result_bytes: read.result.bytes ?? null,
          canonical_receipt: canonicalStringify(read.result.receipt),
          owner_id: null,
          fence: null,
        };
      })
      .sort((left, right) => compareNormalizedText(left.request_id, right.request_id)),
    receipts: durable.receiptAttempts.map((attempt) => ({
      receipt_cursor: attempt.receiptCursor,
      request_id: attempt.receipt.requestId,
      repository_id: attempt.receipt.repositoryId,
      run_id: attempt.receipt.runId,
      dispatch_id: attempt.receipt.dispatchId,
      canonical_replay_key: attempt.canonicalReplayKey,
      replay_key_digest: attempt.replayKeyDigest,
      token_digest: attempt.tokenDigest,
      request_digest: attempt.requestDigest,
      reserved: attempt.reserved ? 1 : 0,
      failure_stage: attempt.failureStage ?? null,
      failure_fact_digest: attempt.failureFactDigest ?? null,
      canonical_receipt: canonicalStringify(attempt.receipt),
    })),
    events: snapshot.events.map((event) => ({
      cursor: event.cursor,
      repository_id: event.repositoryId,
      run_id: event.runId,
      dispatch_id: event.dispatchId,
      event_type: event.eventType,
      canonical_event: canonicalStringify(event),
    })),
    projection: [
      {
        singleton: 1,
        cursor: snapshot.projection.cursor,
        canonical_projection: canonicalStringify(snapshot.projection),
      },
    ],
    submissions: snapshot.submissions.map((stored) => ({
      submission_id: stored.submission.submissionId,
      repository_id: stored.submission.repositoryId,
      run_id: stored.submission.runId,
      dispatch_id: stored.submission.dispatchId,
      submission_type: stored.submission.type,
      canonical_submission: canonicalStringify(stored.submission),
      canonical_result: canonicalStringify(stored.result),
    })),
    questions: snapshot.questions.map((question) => ({
      submission_id: question.submissionId,
      repository_id: question.repositoryId,
      run_id: question.runId,
      canonical_question: canonicalStringify(question),
    })),
    terminalCompletions: snapshot.terminalCompletions.map((terminal) => ({
      dispatch_id: terminal.dispatchId,
      submission_id: terminal.submissionId,
    })),
    completionOutbox: snapshot.completionOutbox.map((pending) => ({
      submission_id: pending.submissionId,
      dispatch_id: pending.fact.dispatchId,
      canonical_fact: canonicalStringify(pending.fact),
      delivered: pending.delivered ? 1 : 0,
    })),
  };
}

function verifyNormalizedContextAuthority(
  database: Database.Database,
  authority: InMemoryContextAuthority,
): void {
  const expected = normalizeContextAuthority(authority);
  verifyNormalizedContextRows(
    "context_bases",
    database
      .prepare(
        `SELECT context_id, context_digest, canonical_context
         FROM context_bases ORDER BY context_id`,
      )
      .all(),
    expected.contextBases,
  );
  verifyNormalizedContextRows(
    "context_dispatches",
    database
      .prepare(
        `SELECT dispatch_id, repository_id, run_id, context_id, prompt_pack_digest,
                canonical_dispatch, canonical_completion_requirements
         FROM context_dispatches ORDER BY dispatch_id`,
      )
      .all(),
    expected.dispatches,
  );
  verifyNormalizedContextRows(
    "context_asset_bindings",
    database
      .prepare(
        `SELECT asset_binding_id, context_id, semantic_asset_id, alias_binding_digest,
                content_digest, byte_length, media_type, sensitivity
         FROM context_asset_bindings ORDER BY asset_binding_id`,
      )
      .all(),
    expected.bindings,
  );
  verifyNormalizedContextRows(
    "context_grants",
    database
      .prepare(
        `SELECT token_digest, dispatch_id, repository_id, run_id, asset_binding_id,
                canonical_envelope, operations_used, bytes_used
         FROM context_grants ORDER BY token_digest`,
      )
      .all(),
    expected.grants,
  );
  const readRows = database
    .prepare<
      [],
      {
        request_id: string;
        token_digest: string;
        dispatch_id: string | null;
        repository_id: string;
        run_id: string;
        canonical_replay_key: string;
        replay_key_digest: string;
        request_digest: string;
        status: string;
        result_bytes: Uint8Array | null;
        canonical_receipt: string | null;
        owner_id: string | null;
        fence: number | null;
      }
    >(
      `SELECT request_id, token_digest, dispatch_id, repository_id, run_id,
              canonical_replay_key, replay_key_digest, request_digest, status, result_bytes,
              canonical_receipt, owner_id, fence
       FROM context_read_attempts ORDER BY request_id`,
    )
    .all()
    .map((row) => ({
      ...row,
      result_bytes: row.result_bytes === null ? null : [...row.result_bytes],
    }));
  verifyNormalizedContextRows("context_read_attempts", readRows, expected.readAttempts);
  verifyNormalizedContextRows(
    "context_audit_receipts",
    database
      .prepare(
        `SELECT receipt_cursor, request_id, repository_id, run_id, dispatch_id,
          canonical_replay_key, replay_key_digest, token_digest, request_digest,
          reserved, failure_stage, failure_fact_digest, canonical_receipt
         FROM context_audit_receipts ORDER BY receipt_cursor`,
      )
      .all(),
    expected.receipts,
  );
  verifyNormalizedContextRows(
    "context_events",
    database
      .prepare(
        `SELECT cursor, repository_id, run_id, dispatch_id, event_type, canonical_event
         FROM context_events ORDER BY cursor`,
      )
      .all(),
    expected.events,
  );
  verifyNormalizedContextRows(
    "context_projection",
    database
      .prepare(
        "SELECT singleton, cursor, canonical_projection FROM context_projection ORDER BY singleton",
      )
      .all(),
    expected.projection,
  );
  verifyNormalizedContextRows(
    "context_submissions",
    database
      .prepare(
        `SELECT submission_id, repository_id, run_id, dispatch_id, submission_type,
                canonical_submission, canonical_result
         FROM context_submissions ORDER BY submission_id`,
      )
      .all(),
    expected.submissions,
  );
  verifyNormalizedContextRows(
    "context_questions",
    database
      .prepare(
        `SELECT submission_id, repository_id, run_id, canonical_question
         FROM context_questions ORDER BY submission_id`,
      )
      .all(),
    expected.questions,
  );
  verifyNormalizedContextRows(
    "context_terminal_completions",
    database
      .prepare(
        `SELECT dispatch_id, submission_id
         FROM context_terminal_completions ORDER BY dispatch_id`,
      )
      .all(),
    expected.terminalCompletions,
  );
  verifyNormalizedContextRows(
    "context_completion_outbox",
    database
      .prepare(
        `SELECT submission_id, dispatch_id, canonical_fact, delivered
         FROM context_completion_outbox ORDER BY submission_id`,
      )
      .all(),
    expected.completionOutbox,
  );
}

function verifyNormalizedContextRows(
  table: string,
  actual: readonly unknown[],
  expected: readonly unknown[],
): void {
  if (actual.length !== expected.length)
    throw new Error(`SQLite ${table} row count diverges from canonical context authority`);
  for (let index = 0; index < expected.length; index += 1) {
    if (canonicalStringify(actual[index]) !== canonicalStringify(expected[index]))
      throw new Error(`SQLite ${table} row ${index} diverges from canonical context authority`);
  }
}

function verifyDurableContextReads(
  database: Database.Database,
  authority: InMemoryContextAuthority,
): void {
  const snapshot = authority.snapshot();
  const durable = authority.durableSnapshot();
  const contexts = new Map<string, ContextAuthoritySnapshot["contexts"][number]>(
    snapshot.contexts.map((context) => [context.contextId, context]),
  );
  const grants = new Map(durable.grants.map((grant) => [grant.tokenDigest, grant]));
  const reads = new Map(durable.reads.map((read) => [read.requestId, read]));

  for (const read of durable.reads) {
    if (read.result.status !== "served") continue;
    const replay = decodePersistedAssetReadReplayKey(read.canonicalReplayKey);
    const grant = grants.get(replay.tokenDigest);
    if (grant === undefined)
      throw new Error("SQLite served context read does not resolve its exact persisted grant");
    const context = contexts.get(grant.envelope.contextId);
    const binding = context?.assets.find(
      ({ assetBindingId }) => assetBindingId === replay.assetBindingId,
    );
    if (binding === undefined)
      throw new Error("SQLite served context read does not resolve its historical asset binding");
    const content =
      replay.type === "pointer" && binding.byteLength <= DEFAULT_POINTER_ASSET_MAX_BYTES
        ? readVerifiedContextAssetRange(database, binding, 0, binding.byteLength)
        : undefined;
    const expected =
      replay.type === "chunk"
        ? readVerifiedContextAssetRange(database, binding, replay.offset, replay.length)
        : content === undefined
          ? undefined
          : readCanonicalJsonPointer(content, replay.pointer, replay.maxBytes);
    if (expected === undefined || !sameContextBytes(expected, read.result.bytes))
      throw new Error("SQLite durable context read bytes do not match verified historical asset");
  }

  const usage = new Map(
    durable.grants.map((grant) => [grant.tokenDigest, { operations: 0, bytes: 0 }]),
  );
  for (const attempt of durable.receiptAttempts) {
    const receipt = attempt.receipt;
    const read = reads.get(receipt.requestId);
    if (read === undefined)
      throw new Error("SQLite context receipt does not resolve its durable read");
    const replay = decodePersistedAssetReadReplayKey(attempt.canonicalReplayKey);
    const isStoredResult = canonicalStringify(receipt) === canonicalStringify(read.result.receipt);
    const grant = grants.get(attempt.tokenDigest);
    if (grant === undefined) {
      if (
        attempt.reserved ||
        receipt.status !== "denied" ||
        receipt.denialCode !== (isStoredResult ? "invalid-token" : "request-conflict") ||
        receipt.chargedOperations !== 0 ||
        receipt.chargedBytes !== 0 ||
        receipt.responseBytes !== 0 ||
        receipt.remainingOperations !== 0 ||
        receipt.remainingBytes !== 0
      )
        throw new Error("SQLite unknown-token context receipt has invalid derived accounting");
      continue;
    }
    const charged = usage.get(grant.tokenDigest);
    if (charged === undefined) throw new Error("SQLite context grant usage state is missing");
    const context = contexts.get(grant.envelope.contextId);
    const binding = context?.assets.find(
      ({ assetBindingId }) => assetBindingId === grant.envelope.assetBindingId,
    );
    if (binding === undefined)
      throw new Error("SQLite context receipt does not resolve its historical asset binding");
    const expected = deriveExpectedContextReadAccounting(
      database,
      replay,
      attempt,
      grant,
      binding,
      charged,
      isStoredResult,
    );
    if (
      attempt.tokenDigest !== replay.tokenDigest ||
      attempt.reserved !== expected.reserved ||
      receipt.status !== expected.status ||
      receipt.denialCode !== expected.denialCode ||
      receipt.chargedOperations !== expected.operations ||
      receipt.chargedBytes !== expected.bytes ||
      receipt.responseBytes !== expected.responseBytes
    )
      throw new Error("SQLite context receipt fields do not match verifier-derived accounting");
    charged.operations += expected.operations;
    charged.bytes += expected.bytes;
    if (
      charged.operations > grant.envelope.maxOperations ||
      charged.bytes > grant.envelope.maxBytes ||
      receipt.remainingOperations !== grant.envelope.maxOperations - charged.operations ||
      receipt.remainingBytes !== grant.envelope.maxBytes - charged.bytes
    )
      throw new Error("SQLite context receipt remaining budget does not match ordered usage");
  }
  for (const grant of durable.grants) {
    const charged = usage.get(grant.tokenDigest);
    if (
      charged === undefined ||
      grant.operationsUsed !== charged.operations ||
      grant.bytesUsed !== charged.bytes
    )
      throw new Error("SQLite context grant counters do not match the completed read ledger");
  }
}

interface DerivedContextReadAccounting {
  readonly status: "served" | "denied";
  readonly denialCode?: ContextAuthoritySnapshot["receipts"][number]["denialCode"];
  readonly reserved: boolean;
  readonly operations: number;
  readonly bytes: number;
  readonly responseBytes: number;
}

function deriveExpectedContextReadAccounting(
  database: Database.Database,
  replay: ReturnType<typeof decodePersistedAssetReadReplayKey>,
  attempt: ReturnType<InMemoryContextAuthority["durableSnapshot"]>["receiptAttempts"][number],
  grant: ReturnType<InMemoryContextAuthority["durableSnapshot"]>["grants"][number],
  binding: HistoricalAssetBinding,
  charged: { operations: number; bytes: number },
  isStoredResult: boolean,
): DerivedContextReadAccounting {
  const receipt = attempt.receipt;
  const denied = (
    denialCode: NonNullable<DerivedContextReadAccounting["denialCode"]>,
    reserved = false,
  ): DerivedContextReadAccounting => ({
    status: "denied",
    denialCode,
    reserved,
    operations: reserved ? 1 : 0,
    bytes: 0,
    responseBytes: 0,
  });
  if (!isStoredResult) return denied("request-conflict");
  if (replay.assetBindingId !== grant.envelope.assetBindingId) return denied("scope-denied");
  if (Date.parse(receipt.occurredAt) >= Date.parse(grant.envelope.expiresAt))
    return denied("expired");
  if (
    contextSensitivityRank(binding.sensitivity) >
    contextSensitivityRank(grant.envelope.sensitivityCeiling)
  )
    return denied("sensitivity-denied");
  if (!persistedContextRequestAllowed(replay, grant.envelope, binding))
    return denied(replay.type === "chunk" ? "invalid-range" : "invalid-pointer");
  const worstCaseBytes = assetReadWorstCaseBytes(replay);
  if (
    charged.operations + 1 > grant.envelope.maxOperations ||
    charged.bytes + worstCaseBytes > grant.envelope.maxBytes
  )
    return denied("budget-exhausted");
  const content =
    replay.type === "pointer" && binding.byteLength <= DEFAULT_POINTER_ASSET_MAX_BYTES
      ? readVerifiedContextAssetRange(database, binding, 0, binding.byteLength)
      : undefined;
  const response =
    replay.type === "chunk"
      ? readVerifiedContextAssetRange(database, binding, replay.offset, replay.length)
      : content === undefined
        ? undefined
        : readCanonicalJsonPointer(content, replay.pointer, replay.maxBytes);
  if (
    receipt.status === "denied" &&
    receipt.denialCode === "digest-mismatch" &&
    attempt.failureStage !== undefined &&
    attempt.failureFactDigest !== undefined
  )
    return denied("digest-mismatch", true);
  if (response === undefined) return denied("invalid-pointer", true);
  return {
    status: "served",
    reserved: true,
    operations: 1,
    bytes: worstCaseBytes,
    responseBytes: response.byteLength,
  };
}

function persistedContextRequestAllowed(
  request: ReturnType<typeof decodePersistedAssetReadReplayKey>,
  envelope: ReturnType<InMemoryContextAuthority["durableSnapshot"]>["grants"][number]["envelope"],
  binding: HistoricalAssetBinding,
): boolean {
  if (request.type === "chunk") {
    if (envelope.readMode === "pointer") return false;
    return (
      request.length <= envelope.maxChunkBytes &&
      request.offset <= binding.byteLength &&
      request.length <= binding.byteLength - request.offset
    );
  }
  if (envelope.readMode === "chunk") return false;
  const pointerSegments = parsePersistedJsonPointer(request.pointer);
  const allowedSegments = parsePersistedJsonPointer(envelope.allowedPointer);
  return allowedSegments.every((segment, index) => pointerSegments[index] === segment);
}

function parsePersistedJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function contextSensitivityRank(value: HistoricalAssetBinding["sensitivity"]): number {
  return ["public", "internal", "confidential", "restricted"].indexOf(value);
}

function readVerifiedContextAssetRange(
  database: Database.Database,
  binding: HistoricalAssetBinding,
  offset: number,
  length: number,
): Uint8Array | undefined {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > binding.byteLength ||
    length > binding.byteLength - offset
  )
    return undefined;
  if (length === 0) return new Uint8Array();
  const firstChunk = Math.floor(offset / CONTEXT_ASSET_CHUNK_BYTES);
  const lastChunk = Math.floor((offset + length - 1) / CONTEXT_ASSET_CHUNK_BYTES);
  const rows = database
    .prepare<[string, number, number], Pick<ContextChunkRow, "byte_offset" | "content">>(
      `SELECT byte_offset, content FROM context_asset_chunks
       WHERE asset_binding_id = ? AND chunk_index BETWEEN ? AND ?
       ORDER BY chunk_index`,
    )
    .all(binding.assetBindingId, firstChunk, lastChunk);
  if (rows.length !== lastChunk - firstChunk + 1) return undefined;
  const result = new Uint8Array(length);
  for (const row of rows) {
    const copyStart = Math.max(offset, row.byte_offset);
    const copyEnd = Math.min(offset + length, row.byte_offset + row.content.byteLength);
    result.set(
      row.content.slice(copyStart - row.byte_offset, copyEnd - row.byte_offset),
      copyStart - offset,
    );
  }
  return result;
}

function sameContextBytes(expected: Uint8Array, actual: readonly number[] | undefined): boolean {
  return (
    actual !== undefined &&
    expected.byteLength === actual.length &&
    expected.every((byte, index) => byte === actual[index])
  );
}

function compareNormalizedText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface ContextManifestVerificationRow {
  readonly asset_binding_id: string;
  readonly binding_content_digest: string;
  readonly binding_byte_length: number;
  readonly content_digest: string;
  readonly byte_length: number;
  readonly chunk_size: number;
  readonly chunk_count: number;
}

function expectedContextChunkCount(byteLength: number): number {
  return Math.ceil(byteLength / CONTEXT_ASSET_CHUNK_BYTES);
}

function expectedContextChunkLength(
  byteLength: number,
  chunkCount: number,
  chunkIndex: number,
): number {
  return chunkIndex + 1 < chunkCount
    ? CONTEXT_ASSET_CHUNK_BYTES
    : byteLength - chunkIndex * CONTEXT_ASSET_CHUNK_BYTES;
}

function verifyAllContextAssetManifests(
  database: Database.Database,
  sha256: RuntimeDependencies["sha256"],
): void {
  const manifests = database
    .prepare<[], { asset_binding_id: string }>(
      "SELECT asset_binding_id FROM context_asset_manifests ORDER BY asset_binding_id",
    )
    .all();
  for (const manifest of manifests)
    verifyContextAssetManifest(database, manifest.asset_binding_id, sha256);
}

function verifyContextAssetManifest(
  database: Database.Database,
  assetBindingId: string,
  sha256: RuntimeDependencies["sha256"],
): void {
  const manifest = database
    .prepare<[string], ContextManifestVerificationRow>(
      `SELECT
         manifest.asset_binding_id,
         binding.content_digest AS binding_content_digest,
         binding.byte_length AS binding_byte_length,
         manifest.content_digest,
         manifest.byte_length,
         manifest.chunk_size,
         manifest.chunk_count
       FROM context_asset_manifests AS manifest
       JOIN context_asset_bindings AS binding
         ON binding.asset_binding_id = manifest.asset_binding_id
       WHERE manifest.asset_binding_id = ?`,
    )
    .get(assetBindingId);
  if (manifest === undefined) throw new Error("SQLite context asset manifest is missing");
  if (
    !Number.isSafeInteger(manifest.byte_length) ||
    manifest.byte_length < 0 ||
    manifest.byte_length > MAX_VERIFIED_CONTEXT_ASSET_BYTES ||
    manifest.binding_content_digest !== manifest.content_digest ||
    manifest.binding_byte_length !== manifest.byte_length ||
    manifest.chunk_size !== CONTEXT_ASSET_CHUNK_BYTES ||
    manifest.chunk_count !== expectedContextChunkCount(manifest.byte_length)
  )
    throw new Error("SQLite context asset manifest does not match its exact binding facts");
  const rows = database
    .prepare<[string], ContextChunkRow>(
      `SELECT chunk_index, byte_offset, byte_length, chunk_digest, content
       FROM context_asset_chunks
       WHERE asset_binding_id = ?
       ORDER BY chunk_index`,
    )
    .all(assetBindingId);
  if (rows.length !== manifest.chunk_count)
    throw new Error("SQLite context asset chunk count does not match its manifest");
  const contentBytes = new Uint8Array(manifest.byte_length);
  let aggregateLength = 0;
  for (const [index, row] of rows.entries()) {
    const content = Uint8Array.from(row.content);
    const expectedLength = expectedContextChunkLength(
      manifest.byte_length,
      manifest.chunk_count,
      index,
    );
    if (
      row.chunk_index !== index ||
      row.byte_offset !== index * CONTEXT_ASSET_CHUNK_BYTES ||
      row.byte_length !== expectedLength ||
      content.byteLength !== expectedLength ||
      sha256.digest(content) !== row.chunk_digest
    )
      throw new Error("SQLite context asset chunk integrity check failed");
    contentBytes.set(content, row.byte_offset);
    aggregateLength += content.byteLength;
  }
  if (
    aggregateLength !== manifest.byte_length ||
    sha256.digest(contentBytes) !== manifest.content_digest
  )
    throw new Error("SQLite context asset full content digest check failed");
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

function validateBoundedPageRequest(afterCursor: number, limit: number): void {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
    throw new TypeError("Page cursors must be non-negative safe integers");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PROTOCOL_LIMITS.maxPageItems) {
    throw new TypeError(`Page limits must be integers from 1 to ${PROTOCOL_LIMITS.maxPageItems}`);
  }
}

function validatePageCursor(afterCursor: number, latestCursor: number): void {
  if (afterCursor > latestCursor) {
    throw new PageQueryError("cursor-ahead", "Page cursor exceeds the latest authority cursor");
  }
}

function validateReplayCursor(afterCursor: number, earliestAvailableCursor: number): void {
  if (earliestAvailableCursor > 0 && afterCursor < earliestAvailableCursor - 1) {
    throw new PageQueryError(
      "event-replay-gap",
      "Event cursor precedes the available replay range",
    );
  }
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
