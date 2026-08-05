import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ActiveRunError,
  type ActiveRunStoragePort,
  type JournalStoragePort,
  LeaseConflictError,
  type LeaseStoragePort,
  type NotificationPort,
  type OutputLogStoragePort,
  type RunDocumentStoragePort,
  type RunPersistencePort,
  type RuntimeGraphDefinition,
  RuntimeRevisionConflictError,
  type RuntimeStateStoragePort,
  type StoredRuntimeState,
  type VersionedRunState,
  type VersionedStoredRuntimeState,
} from "@senawa/application";
import type {
  JournalEvent,
  OutputRecord,
  RuntimeArtifact,
  RuntimeLease,
  RuntimeState,
  RuntimeTask,
} from "@senawa/domain";

interface RuntimeEnvelope {
  readonly revision: number;
  readonly operationId: string;
  readonly state: StoredRuntimeState;
}

interface ActiveRunPointer {
  readonly runId: string;
  readonly operationId: string;
  readonly createdAt: string;
}

interface LeaseEnvelope {
  readonly fence: number;
  readonly lease: RuntimeLease | null;
}

interface OutputDelta {
  readonly ownerKind: "run" | "phase" | "task";
  readonly ownerId: string;
  readonly record: OutputRecord;
}

interface PersistenceTransaction {
  readonly kind: "create" | "commit";
  readonly runId: string;
  readonly operationId: string;
  readonly createdAt: string;
  readonly expectedRevision?: string;
  readonly runtime: StoredRuntimeState;
  readonly identity: RuntimeState["identity"];
  readonly snapshot: RuntimeState["snapshot"];
  readonly artifacts: readonly RuntimeArtifact[];
  readonly journal: readonly JournalEvent[];
  readonly outputs: readonly OutputDelta[];
  readonly terminal: boolean;
}

export interface FileRunPersistenceStores {
  readonly runtime: RuntimeStateStoragePort;
  readonly activeRuns: ActiveRunStoragePort;
  readonly documents: RunDocumentStoragePort;
  readonly journal: JournalStoragePort;
  readonly output: OutputLogStoragePort;
  readonly leases: LeaseStoragePort;
  readonly notifications?: NotificationPort;
}

export interface FileRunPersistenceOptions {
  readonly afterStep?: (
    step: "active-run" | "documents" | "evidence" | "runtime-state",
  ) => void | Promise<void>;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

export class FileRuntimeStateStore implements RuntimeStateStoragePort {
  private readonly trackingDirectory: string;

  constructor(repositoryRoot: string) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async createRuntimeState(
    runId: string,
    state: StoredRuntimeState,
    operationId: string,
    _graph: RuntimeGraphDefinition,
  ): Promise<VersionedStoredRuntimeState> {
    const path = this.path(runId);
    const existing = await readJsonIfPresent<RuntimeEnvelope>(path);
    if (existing !== null) {
      if (existing.operationId === operationId && equal(existing.state, state)) {
        return versioned(existing);
      }
      throw new Error(`Run already exists: ${runId}`);
    }
    const envelope = { revision: 1, operationId, state } satisfies RuntimeEnvelope;
    await writeJson(path, envelope);
    return versioned(envelope);
  }

  async readRuntimeState(runId: string): Promise<VersionedStoredRuntimeState> {
    return versioned(await readJson<RuntimeEnvelope>(this.path(runId)));
  }

  async commitRuntimeState(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: StoredRuntimeState;
  }): Promise<VersionedStoredRuntimeState> {
    const path = this.path(input.runId);
    const current = await readJson<RuntimeEnvelope>(path);
    if (current.operationId === input.operationId && equal(current.state, input.state)) {
      return versioned(current);
    }
    if (String(current.revision) !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError(input.runId, input.operationId);
    }
    const envelope = {
      revision: current.revision + 1,
      operationId: input.operationId,
      state: input.state,
    } satisfies RuntimeEnvelope;
    await writeJson(path, envelope);
    return versioned(envelope);
  }

  async claimReadyTask(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
  }): Promise<RuntimeTask | null> {
    const path = this.path(input.runId);
    const current = await readJson<RuntimeEnvelope>(path);
    if (current.operationId === input.operationId) {
      const claimed = current.state.tasks.find((task) => task.status === "in_progress");
      return claimed === undefined ? null : structuredClone(claimed);
    }
    if (String(current.revision) !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError(input.runId, input.operationId);
    }
    const task = current.state.tasks.find(
      (candidate) =>
        (candidate.status === "pending" || candidate.status === "rework") &&
        candidate.dependsOn.every(
          (dependency) =>
            current.state.tasks.find((other) => other.key === dependency)?.status === "closed",
        ),
    );
    if (task === undefined) return null;
    task.status = "in_progress";
    await writeJson(path, {
      revision: current.revision + 1,
      operationId: input.operationId,
      state: current.state,
    } satisfies RuntimeEnvelope);
    return structuredClone(task);
  }

  private path(runId: string): string {
    assertIdentifier(runId, "run ID");
    return join(this.trackingDirectory, runId, "runtime-state.json");
  }
}

export class FileActiveRunRegistry implements ActiveRunStoragePort {
  private readonly path: string;

  constructor(repositoryRoot: string) {
    this.path = resolve(repositoryRoot, ".agents", ".copilot-tracking", "active-run.json");
  }

  async getActiveRunId(): Promise<string | null> {
    return (await readJsonIfPresent<ActiveRunPointer>(this.path))?.runId ?? null;
  }

  async reserveActiveRun(input: {
    readonly runId: string;
    readonly operationId: string;
    readonly createdAt: string;
  }): Promise<void> {
    const current = await readJsonIfPresent<ActiveRunPointer>(this.path);
    if (current !== null) {
      if (current.runId === input.runId && current.operationId === input.operationId) return;
      throw new ActiveRunError(current.runId);
    }
    await writeJson(this.path, input);
  }

  async releaseActiveRun(input: {
    readonly runId: string;
    readonly operationId: string;
  }): Promise<void> {
    const current = await readJsonIfPresent<ActiveRunPointer>(this.path);
    if (current === null) return;
    if (current.runId !== input.runId) throw new ActiveRunError(current.runId);
    await rm(this.path, { force: true });
  }
}

export class FileLeaseStore implements LeaseStoragePort {
  private readonly trackingDirectory: string;

  constructor(
    repositoryRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    validateTtl(ttlMs);
    return this.update(runId, kind, (current) => {
      const now = this.now();
      const live = current.lease !== null && Date.parse(current.lease.expiresAt) > now.getTime();
      if (live && current.lease?.owner !== owner) {
        throw new LeaseConflictError(kind, current.lease?.owner ?? "unknown");
      }
      const retain = live && current.lease?.owner === owner;
      const fence = retain ? current.fence : current.fence + 1;
      return {
        fence,
        lease: {
          owner,
          fence,
          acquiredAt: retain ? (current.lease?.acquiredAt ?? now.toISOString()) : now.toISOString(),
          heartbeatAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        },
      };
    }).then((envelope) => requireLease(envelope));
  }

  renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    validateTtl(ttlMs);
    return this.update(runId, kind, (current) => {
      assertCurrentLease(kind, current.lease, lease);
      const now = this.now();
      if (Date.parse(lease.expiresAt) <= now.getTime()) {
        throw new LeaseConflictError(kind, lease.owner);
      }
      return {
        fence: current.fence,
        lease: {
          ...lease,
          heartbeatAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        },
      };
    }).then((envelope) => requireLease(envelope));
  }

  async releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void> {
    await this.update(runId, kind, (current) => {
      assertCurrentLease(kind, current.lease, lease);
      return { fence: current.fence, lease: null };
    });
  }

  async inspectLease(runId: string, kind: "driver" | "web"): Promise<RuntimeLease | null> {
    return structuredClone((await this.read(runId, kind)).lease);
  }

  async readLeaseFence(runId: string, kind: "driver" | "web"): Promise<number> {
    return (await this.read(runId, kind)).fence;
  }

  private async read(runId: string, kind: "driver" | "web"): Promise<LeaseEnvelope> {
    return (
      (await readJsonIfPresent<LeaseEnvelope>(this.path(runId, kind))) ?? {
        fence: 0,
        lease: null,
      }
    );
  }

  private update(
    runId: string,
    kind: "driver" | "web",
    update: (current: LeaseEnvelope) => LeaseEnvelope,
  ): Promise<LeaseEnvelope> {
    const path = this.path(runId, kind);
    return withLock(`${path}.lock`, async () => {
      const next = update(await this.read(runId, kind));
      await writeJson(path, next);
      return next;
    });
  }

  private path(runId: string, kind: "driver" | "web"): string {
    assertIdentifier(runId, "run ID");
    return join(this.trackingDirectory, runId, "leases", `${kind}.json`);
  }
}

export class FileRunPersistence implements RunPersistencePort {
  private readonly trackingDirectory: string;
  private readonly lockPath: string;
  private readonly transactionPath: string;

  constructor(
    repositoryRoot: string,
    private readonly stores: FileRunPersistenceStores,
    private readonly options: FileRunPersistenceOptions = {},
  ) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
    this.lockPath = join(this.trackingDirectory, ".persistence.lock");
    this.transactionPath = join(this.trackingDirectory, ".persistence-transaction.json");
  }

  publishSnapshot(snapshot: RuntimeState["snapshot"], operationId: string): Promise<void> {
    return this.stores.documents.publishSnapshot(snapshot, operationId);
  }

  async createRun(state: RuntimeState, operationId: string): Promise<void> {
    await this.serialized(async () => {
      const transaction = transactionForCreate(state, operationId);
      await writeJson(this.transactionPath, transaction);
      try {
        await this.applyTransaction(transaction);
      } catch (error) {
        if (error instanceof ActiveRunError) await rm(this.transactionPath, { force: true });
        throw error;
      }
    });
  }

  getActiveRunId(): Promise<string | null> {
    return this.serialized(() => this.stores.activeRuns.getActiveRunId());
  }

  readRun(runId: string): Promise<VersionedRunState> {
    return this.serialized(() => this.readAssembled(runId));
  }

  async commitRun(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: RuntimeState;
  }): Promise<VersionedRunState> {
    return this.serialized(async () => {
      const current = await this.readAssembled(input.runId);
      if (current.revision !== input.expectedRevision) {
        throw new RuntimeRevisionConflictError(input.runId, input.operationId);
      }
      assertAggregateInvariants(current.state, input.state);
      const transaction = transactionForCommit(
        current.state,
        input.state,
        input.operationId,
        input.expectedRevision,
      );
      await writeJson(this.transactionPath, transaction);
      await this.applyTransaction(transaction);
      return this.readAssembled(input.runId);
    });
  }

  claimReadyTask(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
  }): Promise<RuntimeTask | null> {
    return this.serialized(async () => {
      const task = await this.stores.runtime.claimReadyTask(input);
      if (task !== null) await this.stores.notifications?.publishRunChanged(input.runId);
      return task;
    });
  }

  readArtifact(runId: string, phaseId: string, version?: number) {
    return this.stores.documents.readArtifact(runId, phaseId, version);
  }

  readJournal(runId: string, after: number, limit: number) {
    return this.stores.journal.readJournal(runId, after, limit);
  }

  readOutput(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
    after: number,
    limit: number,
  ) {
    return this.stores.output.readOutput(runId, ownerKind, ownerId, after, limit);
  }

  acquireLease(runId: string, kind: "driver" | "web", owner: string, ttlMs: number) {
    return this.stores.leases.acquireLease(runId, kind, owner, ttlMs);
  }

  renewLease(runId: string, kind: "driver" | "web", lease: RuntimeLease, ttlMs: number) {
    return this.stores.leases.renewLease(runId, kind, lease, ttlMs);
  }

  releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease) {
    return this.stores.leases.releaseLease(runId, kind, lease);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    return withLock(
      this.lockPath,
      async () => {
        await this.recover();
        return operation();
      },
      {
        timeoutMs: this.options.lockTimeoutMs ?? 5_000,
        staleMs: this.options.staleLockMs ?? 30_000,
      },
    );
  }

  private async recover(): Promise<void> {
    const transaction = await readJsonIfPresent<PersistenceTransaction>(this.transactionPath);
    if (transaction !== null) await this.applyTransaction(transaction);
  }

  private async applyTransaction(transaction: PersistenceTransaction): Promise<void> {
    if (transaction.kind === "create") {
      await this.stores.activeRuns.reserveActiveRun({
        runId: transaction.runId,
        operationId: transaction.operationId,
        createdAt: transaction.createdAt,
      });
      await this.options.afterStep?.("active-run");
    }
    await this.stores.documents.publishIdentity(transaction.identity, transaction.operationId);
    await this.stores.documents.publishSnapshot(transaction.snapshot, transaction.operationId);
    for (const artifact of transaction.artifacts) {
      await this.stores.documents.publishArtifact(
        artifact,
        transaction.runId,
        `${transaction.operationId}.artifact.${artifact.phaseId}.${artifact.version}`,
      );
    }
    await this.options.afterStep?.("documents");
    for (const event of transaction.journal) {
      await this.stores.journal.appendJournal({
        runId: transaction.runId,
        entryId: `${transaction.operationId}.journal.${event.seq}`,
        event,
      });
    }
    for (const output of transaction.outputs) {
      await this.stores.output.appendOutput({
        runId: transaction.runId,
        ownerKind: output.ownerKind,
        ownerId: output.ownerId,
        entryId: `${transaction.operationId}.output.${output.ownerKind}.${output.ownerId}.${output.record.seq}`,
        record: output.record,
      });
    }
    await this.options.afterStep?.("evidence");
    if (transaction.kind === "create") {
      await this.stores.runtime.createRuntimeState(
        transaction.runId,
        transaction.runtime,
        transaction.operationId,
        graphDefinition(transaction.snapshot),
      );
    } else {
      await this.stores.runtime.commitRuntimeState({
        runId: transaction.runId,
        expectedRevision: transaction.expectedRevision ?? "",
        operationId: transaction.operationId,
        state: transaction.runtime,
      });
    }
    await this.options.afterStep?.("runtime-state");
    if (transaction.terminal) {
      await this.stores.activeRuns.releaseActiveRun({
        runId: transaction.runId,
        operationId: transaction.operationId,
      });
    }
    await rm(this.transactionPath, { force: true });
    await this.stores.notifications?.publishRunChanged(transaction.runId);
  }

  private async readAssembled(runId: string): Promise<VersionedRunState> {
    const [
      runtime,
      identity,
      snapshot,
      artifacts,
      journal,
      owners,
      driver,
      web,
      driverFence,
      webFence,
    ] = await Promise.all([
      this.stores.runtime.readRuntimeState(runId),
      this.stores.documents.readIdentity(runId),
      this.stores.documents.readSnapshot(runId),
      this.stores.documents.listArtifacts(runId),
      this.stores.journal.readJournal(runId, 0, Number.MAX_SAFE_INTEGER),
      this.stores.output.listOutputOwners(runId),
      this.stores.leases.inspectLease(runId, "driver"),
      this.stores.leases.inspectLease(runId, "web"),
      this.stores.leases.readLeaseFence(runId, "driver"),
      this.stores.leases.readLeaseFence(runId, "web"),
    ]);
    const outputs: Record<string, OutputRecord[]> = {};
    await Promise.all(
      owners.map(async (owner) => {
        outputs[`${owner.kind}:${owner.id}`] = [
          ...(await this.stores.output.readOutput(
            runId,
            owner.kind,
            owner.id,
            0,
            Number.MAX_SAFE_INTEGER,
          )),
        ];
      }),
    );
    return {
      revision: runtime.revision,
      state: {
        ...runtime.state,
        identity,
        snapshot,
        artifacts: [...artifacts].toSorted((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        ),
        journal: [...journal],
        outputs,
        leases: { driver, web },
        leaseFences: { driver: driverFence, web: webFence },
      },
    };
  }
}

function transactionForCreate(state: RuntimeState, operationId: string): PersistenceTransaction {
  return {
    kind: "create",
    runId: state.identity.runId,
    operationId,
    createdAt: state.identity.createdAt,
    runtime: storedState(state),
    identity: state.identity,
    snapshot: state.snapshot,
    artifacts: state.artifacts,
    journal: state.journal,
    outputs: outputDeltas({}, state.outputs),
    terminal: state.status === "finished" || state.status === "ended",
  };
}

function graphDefinition(snapshot: RuntimeState["snapshot"]): RuntimeGraphDefinition {
  return {
    phases: snapshot.workflow.spec.phases.map((phase) => ({
      id: phase.id,
      title: phase.id,
      dependsOn: phase.dependsOn,
      executorKind: phase.executor.kind,
    })),
  };
}

function transactionForCommit(
  previous: RuntimeState,
  next: RuntimeState,
  operationId: string,
  expectedRevision: string,
): PersistenceTransaction {
  return {
    kind: "commit",
    runId: next.identity.runId,
    operationId,
    createdAt: next.identity.createdAt,
    expectedRevision,
    runtime: storedState(next),
    identity: next.identity,
    snapshot: next.snapshot,
    artifacts: next.artifacts.slice(previous.artifacts.length),
    journal: next.journal.slice(previous.journal.length),
    outputs: outputDeltas(previous.outputs, next.outputs),
    terminal: next.status === "finished" || next.status === "ended",
  };
}

function storedState(state: RuntimeState): StoredRuntimeState {
  const {
    identity: _identity,
    snapshot: _snapshot,
    artifacts: _artifacts,
    journal: _journal,
    outputs: _outputs,
    leases: _leases,
    leaseFences: _leaseFences,
    ...runtime
  } = state;
  return runtime;
}

function outputDeltas(
  previous: Readonly<Record<string, readonly OutputRecord[]>>,
  next: Readonly<Record<string, readonly OutputRecord[]>>,
): OutputDelta[] {
  const deltas: OutputDelta[] = [];
  for (const [owner, records] of Object.entries(next)) {
    const match = owner.match(/^(run|phase|task):(.+)$/u);
    if (match === null) throw new Error(`Invalid output owner ${owner}`);
    const priorLength = previous[owner]?.length ?? 0;
    for (const record of records.slice(priorLength)) {
      deltas.push({
        ownerKind: match[1] as "run" | "phase" | "task",
        ownerId: match[2] ?? "",
        record,
      });
    }
  }
  return deltas;
}

function assertAggregateInvariants(previous: RuntimeState, next: RuntimeState): void {
  if (!equal(previous.identity, next.identity)) throw new Error("Run identity is immutable");
  if (!equal(previous.snapshot, next.snapshot)) throw new Error("Run snapshot is immutable");
  assertAppendOnly("journal", previous.journal, next.journal);
  assertAppendOnly("artifacts", previous.artifacts, next.artifacts);
  for (const [owner, records] of Object.entries(previous.outputs)) {
    assertAppendOnly(`output stream ${owner}`, records, next.outputs[owner] ?? []);
  }
}

function assertAppendOnly(
  name: string,
  previous: readonly unknown[],
  next: readonly unknown[],
): void {
  if (next.length < previous.length || !equal(previous, next.slice(0, previous.length))) {
    throw new Error(`${name} is append-only`);
  }
}

function versioned(envelope: RuntimeEnvelope): VersionedStoredRuntimeState {
  return { state: structuredClone(envelope.state), revision: String(envelope.revision) };
}

function requireLease(envelope: LeaseEnvelope): RuntimeLease {
  if (envelope.lease === null) throw new Error("Lease operation did not produce a lease");
  return envelope.lease;
}

function assertCurrentLease(
  kind: "driver" | "web",
  current: RuntimeLease | null,
  expected: RuntimeLease,
): asserts current is RuntimeLease {
  if (current === null || current.owner !== expected.owner || current.fence !== expected.fence) {
    throw new LeaseConflictError(kind, current?.owner ?? "no active owner");
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Lease TTL must be a positive integer");
  }
}

async function withLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: { readonly timeoutMs: number; readonly staleMs: number } = {
    timeoutMs: 5_000,
    staleMs: 30_000,
  },
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}:${randomUUID()}\n`, "utf8");
        return await operation();
      } finally {
        await handle.close();
        await rm(path, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const lockStat = await stat(path).catch(() => null);
      if (lockStat !== null && Date.now() - lockStat.mtimeMs > options.staleMs) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${path}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
