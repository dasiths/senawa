import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  JournalEvent,
  JsonObject,
  OutputRecord,
  PlanArtifact,
  RunSnapshot,
  WorkRequest,
} from "@senawa/domain";

export type RunStatus = "running" | "awaiting_approval" | "paused" | "finished" | "ended";
export type PhaseStatus = "pending" | "running" | "awaiting_approval" | "accepted" | "ended";
export type TaskStatus = "pending" | "in_progress" | "rework" | "closed" | "escalated" | "ended";

export interface RunIdentity {
  readonly runId: string;
  readonly workflow: string;
  readonly request: WorkRequest;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface RuntimePhase {
  readonly id: string;
  status: PhaseStatus;
  iteration: number;
  artifactVersion: number | null;
  sessionId: string | null;
  rejectionReason: string | null;
}

export type RuntimeTask = PlanArtifact["tasks"][number] & {
  status: TaskStatus;
  attempt: number;
  dispatchFailures: number;
  sessionId: string | null;
  steering: string[];
  reworkFindings?: string[];
  reworkFeedback?: RuntimeGateFeedback;
};

export interface RuntimeGateFeedback {
  readonly gateId: string;
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly remainingAttempts: number;
  readonly failedReadings: ReadonlyArray<{
    readonly sensorId: string;
    readonly summary: string;
  }>;
  readonly findings: readonly string[];
  readonly evidencePaths: readonly string[];
  readonly nextPrompt: string;
}

export interface RuntimeArtifact {
  readonly phaseId: string;
  readonly version: number;
  readonly path: string;
  readonly createdAt: string;
  readonly content: JsonObject;
  readonly consumed: Readonly<Record<string, number>>;
}

export interface RuntimeLease {
  readonly owner: string;
  readonly fence: number;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface ActiveWorkerTurn {
  readonly ownerKind: "phase" | "task";
  readonly ownerId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly turnId: string;
  readonly dispatchId: string;
  readonly operationId: string;
  readonly operation: "create" | "resume";
}

export type RuntimeDispatchStatus =
  | "intent"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface RuntimeDispatch {
  readonly dispatchId: string;
  readonly operationId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly ownerKind: "phase" | "task";
  readonly ownerId: string;
  readonly operation: "create" | "resume";
  readonly workAttempt: number;
  readonly dispatchFailure: number;
  readonly createdAt: string;
  status: RuntimeDispatchStatus;
  updatedAt: string;
  detail?: string;
}

export interface RuntimeState {
  readonly apiVersion: "senawa.dev/runtime/v1";
  readonly identity: RunIdentity;
  readonly snapshot: RunSnapshot;
  status: RunStatus;
  endReason: string | null;
  phases: RuntimePhase[];
  tasks: RuntimeTask[];
  artifacts: RuntimeArtifact[];
  journal: JournalEvent[];
  outputs: Record<string, OutputRecord[]>;
  activeTurn: ActiveWorkerTurn | null;
  dispatches: RuntimeDispatch[];
  leases: { driver: RuntimeLease | null; web: RuntimeLease | null };
  leaseFences?: { driver: number; web: number };
}

export interface RuntimeStore {
  createRun(state: RuntimeState): Promise<void>;
  getActiveRunId(): Promise<string | null>;
  readRun(runId: string): Promise<RuntimeState>;
  updateRun(runId: string, update: (draft: RuntimeState) => void): Promise<RuntimeState>;
  acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease>;
  renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease>;
  releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void>;
  getWorkDirectory(runId: string): string;
}

interface ActiveRunPointer {
  readonly runId: string;
  readonly createdAt: string;
}

interface PreviousRunPointer {
  readonly runId: string;
}

export class ActiveRunError extends Error {
  constructor(readonly runId: string) {
    super(`An active run already exists: ${runId}`);
    this.name = "ActiveRunError";
  }
}

export class LeaseConflictError extends Error {
  constructor(
    readonly kind: "driver" | "web",
    readonly owner: string,
  ) {
    super(`The ${kind} lease is held by ${owner}`);
    this.name = "LeaseConflictError";
  }
}

export class FileRuntimeStore implements RuntimeStore {
  readonly trackingDirectory: string;
  readonly lockPath: string;
  readonly activeRunPath: string;
  readonly previousRunPath: string;
  readonly archiveDirectory: string;

  constructor(
    repositoryRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
    this.lockPath = join(this.trackingDirectory, ".runtime.lock");
    this.activeRunPath = join(this.trackingDirectory, "active-run.json");
    this.previousRunPath = join(this.trackingDirectory, "previous-run.json");
    this.archiveDirectory = join(this.trackingDirectory, "archive");
  }

  getWorkDirectory(runId: string): string {
    return join(this.trackingDirectory, runId);
  }

  async createRun(state: RuntimeState): Promise<void> {
    await this.withLock(async () => {
      const active = await readJsonIfPresent<ActiveRunPointer>(this.activeRunPath);
      if (active !== null) throw new ActiveRunError(active.runId);

      await this.archivePreviousRun();
      await mkdir(this.getWorkDirectory(state.identity.runId), { recursive: false });
      await this.writeRuntime(state);
      await writeJson(this.activeRunPath, {
        runId: state.identity.runId,
        createdAt: state.identity.createdAt,
      } satisfies ActiveRunPointer);
    });
  }

  async getActiveRunId(): Promise<string | null> {
    const active = await readJsonIfPresent<ActiveRunPointer>(this.activeRunPath);
    return active?.runId ?? null;
  }

  async readRun(runId: string): Promise<RuntimeState> {
    const currentPath = this.runtimePath(runId);
    const archivedPath = join(this.archiveDirectory, runId, "runtime.json");
    return normalizeRuntimeState(
      await readJson<RuntimeState>((await exists(currentPath)) ? currentPath : archivedPath),
    );
  }

  async updateRun(runId: string, update: (draft: RuntimeState) => void): Promise<RuntimeState> {
    return this.withLock(async () => {
      const previous = await this.readRun(runId);
      const next = structuredClone(previous);
      update(next);
      assertRuntimeInvariants(previous, next);
      await this.persistNewArtifacts(previous, next);
      await this.writeRuntime(next);

      if (next.status === "finished" || next.status === "ended") {
        const active = await readJsonIfPresent<ActiveRunPointer>(this.activeRunPath);
        if (active?.runId === runId) {
          await writeJson(this.previousRunPath, { runId } satisfies PreviousRunPointer);
          await rm(this.activeRunPath, { force: true });
        }
      }
      return next;
    });
  }

  async acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Lease TTL must be a positive integer");
    }
    let acquired: RuntimeLease | null = null;
    await this.updateRun(runId, (draft) => {
      const current = draft.leases[kind];
      const now = this.now();
      if (
        current !== null &&
        current.owner !== owner &&
        Date.parse(current.expiresAt) > now.getTime()
      ) {
        throw new LeaseConflictError(kind, current.owner);
      }
      const fences = draft.leaseFences ?? { driver: 0, web: 0 };
      const fence = current?.owner === owner ? current.fence : fences[kind] + 1;
      fences[kind] = Math.max(fences[kind], fence);
      draft.leaseFences = fences;
      acquired = {
        owner,
        fence,
        acquiredAt: current?.owner === owner ? current.acquiredAt : now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      draft.leases[kind] = acquired;
    });
    if (acquired === null) throw new Error("Lease acquisition failed");
    return acquired;
  }

  async renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Lease TTL must be a positive integer");
    }
    let renewed: RuntimeLease | null = null;
    await this.updateRun(runId, (draft) => {
      const current = draft.leases[kind];
      assertCurrentLease(kind, current, lease);
      const now = this.now();
      if (Date.parse(current.expiresAt) <= now.getTime()) {
        throw new LeaseConflictError(kind, current.owner);
      }
      renewed = {
        ...current,
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      draft.leases[kind] = renewed;
    });
    if (renewed === null) throw new Error("Lease renewal failed");
    return renewed;
  }

  async releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void> {
    await this.updateRun(runId, (draft) => {
      const current = draft.leases[kind];
      assertCurrentLease(kind, current, lease);
      draft.leases[kind] = null;
    });
  }

  private runtimePath(runId: string): string {
    return join(this.getWorkDirectory(runId), "runtime.json");
  }

  private async archivePreviousRun(): Promise<void> {
    const previous = await readJsonIfPresent<PreviousRunPointer>(this.previousRunPath);
    if (previous === null) return;
    const source = this.getWorkDirectory(previous.runId);
    if (await exists(source)) {
      await mkdir(this.archiveDirectory, { recursive: true });
      await rename(source, join(this.archiveDirectory, previous.runId));
    }
    await rm(this.previousRunPath, { force: true });
  }

  private async persistNewArtifacts(previous: RuntimeState, next: RuntimeState): Promise<void> {
    for (const artifact of next.artifacts.slice(previous.artifacts.length)) {
      const path = join(this.getWorkDirectory(next.identity.runId), artifact.path);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(artifact.content, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    }
  }

  private async writeRuntime(state: RuntimeState): Promise<void> {
    await writeJson(this.runtimePath(state.identity.runId), state);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.trackingDirectory, { recursive: true });
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}:${randomUUID()}\n`, "utf8");
          return await operation();
        } finally {
          await handle.close();
          await rm(this.lockPath, { force: true });
        }
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const lockStat = await stat(this.lockPath).catch(() => null);
        if (lockStat !== null && Date.now() - lockStat.mtimeMs > 30_000) {
          await rm(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the runtime store lock");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
  }
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

function normalizeRuntimeState(state: RuntimeState): RuntimeState {
  state.dispatches ??= [];
  for (const task of state.tasks) task.dispatchFailures ??= 0;
  const fences = state.leaseFences ?? { driver: 0, web: 0 };
  for (const kind of ["driver", "web"] as const) {
    const lease = state.leases[kind];
    if (lease !== null && !Number.isSafeInteger(lease.fence)) {
      state.leases[kind] = { ...lease, fence: Math.max(1, fences[kind]) };
    }
    fences[kind] = Math.max(fences[kind], state.leases[kind]?.fence ?? 0);
  }
  state.leaseFences = fences;
  return state;
}

function assertRuntimeInvariants(previous: RuntimeState, next: RuntimeState): void {
  if (JSON.stringify(previous.identity) !== JSON.stringify(next.identity)) {
    throw new Error("Run identity is immutable");
  }
  if (JSON.stringify(previous.snapshot) !== JSON.stringify(next.snapshot)) {
    throw new Error("Run snapshot is immutable");
  }
  assertAppendOnly("journal", previous.journal, next.journal);
  assertAppendOnly("artifacts", previous.artifacts, next.artifacts);
  for (const [owner, records] of Object.entries(previous.outputs)) {
    assertAppendOnly(`output stream ${owner}`, records, next.outputs[owner] ?? []);
  }
  if (next.dispatches.length < previous.dispatches.length) {
    throw new Error("Dispatch records cannot be removed");
  }
  const dispatchIds = new Set<string>();
  for (const [index, dispatch] of next.dispatches.entries()) {
    if (dispatchIds.has(dispatch.dispatchId)) throw new Error("Dispatch IDs must be unique");
    dispatchIds.add(dispatch.dispatchId);
    const prior = previous.dispatches[index];
    if (
      prior !== undefined &&
      JSON.stringify(dispatchIdentity(prior)) !== JSON.stringify(dispatchIdentity(dispatch))
    ) {
      throw new Error("Dispatch identity is immutable");
    }
  }
  if (
    next.activeTurn !== null &&
    next.tasks.filter((task) => task.status === "in_progress").length > 1
  ) {
    throw new Error("Only one worker turn may be active");
  }
}

function dispatchIdentity(dispatch: RuntimeDispatch): object {
  const { status: _status, updatedAt: _updatedAt, detail: _detail, ...identity } = dispatch;
  return identity;
}

function assertAppendOnly(name: string, previous: unknown[], next: unknown[]): void {
  if (
    next.length < previous.length ||
    JSON.stringify(next.slice(0, previous.length)) !== JSON.stringify(previous)
  ) {
    throw new Error(`${name} is append-only`);
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
