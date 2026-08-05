import type {
  JournalEvent,
  OutputRecord,
  RunSnapshot,
  RuntimeArtifact,
  RuntimeLease,
  RuntimeState,
} from "@senawa/domain";
import {
  type ClockPort,
  type IdentifierPort,
  type RunPersistencePort,
  RuntimeRevisionConflictError,
  type VersionedRunState,
} from "./ports.js";

export class FakeClock implements ClockPort {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date): void {
    this.current = new Date(value);
  }
}

export class SequenceIdentifiers implements IdentifierPort {
  private next = 0;

  constructor(private readonly prefix = "id") {}

  createId(): string {
    this.next += 1;
    return `${this.prefix}-${this.next}`;
  }
}

export class FakeRunPersistence implements RunPersistencePort {
  readonly operations: string[] = [];
  readonly snapshots = new Map<string, RunSnapshot>();
  private readonly runs = new Map<string, RuntimeState>();
  private readonly revisions = new Map<string, number>();
  private readonly leases = new Map<string, RuntimeLease>();
  private activeRunId: string | null = null;

  async createRun(state: RuntimeState, operationId: string): Promise<void> {
    if (this.activeRunId !== null)
      throw new Error(`An active run already exists: ${this.activeRunId}`);
    if (this.runs.has(state.identity.runId))
      throw new Error(`Run already exists: ${state.identity.runId}`);
    this.operations.push(operationId);
    this.runs.set(state.identity.runId, structuredClone(state));
    this.revisions.set(state.identity.runId, 1);
    this.activeRunId = state.identity.runId;
  }

  getActiveRunId(): Promise<string | null> {
    return Promise.resolve(this.activeRunId);
  }

  async readRun(runId: string): Promise<VersionedRunState> {
    const state = this.requireRun(runId);
    return { state: structuredClone(state), revision: String(this.revisions.get(runId) ?? 0) };
  }

  async commitRun(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: RuntimeState;
  }): Promise<VersionedRunState> {
    const revision = this.revisions.get(input.runId) ?? 0;
    if (input.expectedRevision !== String(revision)) {
      throw new RuntimeRevisionConflictError(input.runId, input.operationId);
    }
    this.operations.push(input.operationId);
    this.runs.set(input.runId, structuredClone(input.state));
    this.revisions.set(input.runId, revision + 1);
    if (input.state.status === "finished" || input.state.status === "ended") {
      if (this.activeRunId === input.runId) this.activeRunId = null;
    }
    return this.readRun(input.runId);
  }

  publishSnapshot(snapshot: RunSnapshot, operationId: string): Promise<void> {
    const previous = this.snapshots.get(snapshot.runId);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
      throw new Error(`Snapshot conflict for ${snapshot.runId}`);
    }
    this.operations.push(operationId);
    this.snapshots.set(snapshot.runId, structuredClone(snapshot));
    return Promise.resolve();
  }

  async readArtifact(
    runId: string,
    phaseId: string,
    version?: number,
  ): Promise<RuntimeArtifact | null> {
    const matches = this.requireRun(runId).artifacts.filter(
      (artifact) => artifact.phaseId === phaseId,
    );
    return version === undefined
      ? (structuredClone(matches.at(-1)) ?? null)
      : (structuredClone(matches.find((artifact) => artifact.version === version)) ?? null);
  }

  readJournal(runId: string, after: number, limit: number): Promise<readonly JournalEvent[]> {
    return Promise.resolve(
      structuredClone(
        this.requireRun(runId)
          .journal.filter((event) => event.seq > after)
          .slice(0, limit),
      ),
    );
  }

  readOutput(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
    after: number,
    limit: number,
  ): Promise<readonly OutputRecord[]> {
    const records = this.requireRun(runId).outputs[`${ownerKind}:${ownerId}`] ?? [];
    return Promise.resolve(
      structuredClone(records.filter((record) => record.seq > after).slice(0, limit)),
    );
  }

  acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    const key = `${runId}:${kind}`;
    const current = this.leases.get(key);
    const now = new Date();
    const lease: RuntimeLease = {
      owner,
      fence: current?.owner === owner ? current.fence : (current?.fence ?? 0) + 1,
      acquiredAt: current?.owner === owner ? current.acquiredAt : now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.leases.set(key, lease);
    return Promise.resolve(lease);
  }

  renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    const key = `${runId}:${kind}`;
    const current = this.leases.get(key);
    if (current?.owner !== lease.owner || current.fence !== lease.fence) {
      throw new Error(`Lease conflict for ${key}`);
    }
    const now = new Date();
    const renewed = {
      ...current,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.leases.set(key, renewed);
    return Promise.resolve(renewed);
  }

  releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void> {
    const key = `${runId}:${kind}`;
    const current = this.leases.get(key);
    if (current?.owner !== lease.owner || current.fence !== lease.fence) {
      throw new Error(`Lease conflict for ${key}`);
    }
    this.leases.delete(key);
    return Promise.resolve();
  }

  private requireRun(runId: string): RuntimeState {
    const state = this.runs.get(runId);
    if (state === undefined) throw new Error(`Unknown run ${runId}`);
    return state;
  }
}
