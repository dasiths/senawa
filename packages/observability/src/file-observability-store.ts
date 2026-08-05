import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  JournalStoragePort,
  NotificationPort,
  OutputLogStoragePort,
} from "@senawa/application";
import type { JournalEvent, OutputRecord } from "@senawa/domain";

interface DurableEntry<T> {
  readonly entryId: string;
  readonly payload: T;
}

export class DurableEntryConflictError extends Error {
  constructor(readonly entryId: string) {
    super(`Durable entry ${entryId} was replayed with different content`);
    this.name = "DurableEntryConflictError";
  }
}

export class FileJournalStore implements JournalStoragePort {
  private readonly trackingDirectory: string;

  constructor(
    repositoryRoot: string,
    private readonly notifications?: NotificationPort,
  ) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async appendJournal(input: {
    readonly runId: string;
    readonly entryId: string;
    readonly event: JournalEvent;
  }): Promise<JournalEvent> {
    const path = this.path(input.runId);
    const event = await appendEntry(path, input.entryId, input.event, (payload, seq) => ({
      ...payload,
      seq,
    }));
    await this.notifications?.publishRunChanged(input.runId);
    return event;
  }

  async readJournal(runId: string, after: number, limit: number): Promise<readonly JournalEvent[]> {
    validateCursor(after, limit);
    return (await readEntries<JournalEvent>(this.path(runId)))
      .map((entry) => entry.payload)
      .filter((event) => event.seq > after)
      .slice(0, limit);
  }

  async journalHead(runId: string): Promise<number> {
    return (await readEntries<JournalEvent>(this.path(runId))).at(-1)?.payload.seq ?? 0;
  }

  private path(runId: string): string {
    assertIdentifier(runId, "run ID");
    return join(this.trackingDirectory, runId, "journal.jsonl");
  }
}

export class FileOutputLogStore implements OutputLogStoragePort {
  private readonly trackingDirectory: string;

  constructor(
    repositoryRoot: string,
    private readonly notifications?: NotificationPort,
  ) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async appendOutput(input: {
    readonly runId: string;
    readonly ownerKind: "run" | "phase" | "task";
    readonly ownerId: string;
    readonly entryId: string;
    readonly record: OutputRecord;
  }): Promise<OutputRecord> {
    assertIdentifier(input.entryId, "entry ID");
    const lockPath = this.ownerLockPath(input.runId, input.ownerKind, input.ownerId);
    const record = await withLock(lockPath, async () => {
      const entries = await this.allEntries(input.runId);
      const existing = entries.find((entry) => entry.entryId === input.entryId);
      if (existing !== undefined) {
        const replay = { ...input.record, seq: existing.payload.seq };
        if (JSON.stringify(existing.payload) !== JSON.stringify(replay)) {
          throw new DurableEntryConflictError(input.entryId);
        }
        return structuredClone(existing.payload);
      }
      const ownerHead = entries
        .map((entry) => entry.payload)
        .filter(
          (candidate) =>
            candidate.owner.kind === input.ownerKind && candidate.owner.id === input.ownerId,
        )
        .reduce((head, candidate) => Math.max(head, candidate.seq), 0);
      const assigned = { ...input.record, seq: ownerHead + 1 };
      await appendRawEntry(this.streamPath(input.runId, assigned), {
        entryId: input.entryId,
        payload: assigned,
      });
      return structuredClone(assigned);
    });
    await this.notifications?.publishRunChanged(input.runId);
    return record;
  }

  async readOutput(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
    after: number,
    limit: number,
  ): Promise<readonly OutputRecord[]> {
    validateCursor(after, limit);
    return (await this.allEntries(runId))
      .map((entry) => entry.payload)
      .filter(
        (record) =>
          record.owner.kind === ownerKind && record.owner.id === ownerId && record.seq > after,
      )
      .toSorted((left, right) => left.seq - right.seq)
      .slice(0, limit);
  }

  async outputHead(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
  ): Promise<number> {
    return (
      (await this.readOutput(runId, ownerKind, ownerId, 0, Number.MAX_SAFE_INTEGER)).at(-1)?.seq ??
      0
    );
  }

  async listOutputOwners(
    runId: string,
  ): Promise<readonly { readonly kind: "run" | "phase" | "task"; readonly id: string }[]> {
    assertIdentifier(runId, "run ID");
    const owners = new Map<string, { kind: "run" | "phase" | "task"; id: string }>();
    for (const { payload } of await this.allEntries(runId)) {
      owners.set(`${payload.owner.kind}:${payload.owner.id}`, payload.owner);
    }
    return [...owners.values()];
  }

  private ownerLockPath(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
  ): string {
    assertIdentifier(runId, "run ID");
    assertIdentifier(ownerId, "output owner ID");
    return join(this.trackingDirectory, runId, "output", ".locks", ownerKind, `${ownerId}.lock`);
  }

  private streamPath(runId: string, record: OutputRecord): string {
    assertIdentifier(runId, "run ID");
    if (record.sessionId !== undefined && record.turnId !== undefined) {
      return join(
        this.trackingDirectory,
        runId,
        "output",
        "sessions",
        record.sessionId,
        `${record.turnId}.jsonl`,
      );
    }
    return join(
      this.trackingDirectory,
      runId,
      "output",
      "control",
      record.owner.kind,
      `${record.owner.id}.jsonl`,
    );
  }

  private async allEntries(runId: string): Promise<DurableEntry<OutputRecord>[]> {
    assertIdentifier(runId, "run ID");
    const paths = await listJsonlFiles(join(this.trackingDirectory, runId, "output"));
    return (await Promise.all(paths.map((path) => readEntries<OutputRecord>(path)))).flat();
  }
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? listJsonlFiles(path)
        : entry.isFile() && entry.name.endsWith(".jsonl")
          ? [path]
          : [];
    }),
  );
  return paths.flat();
}

async function appendRawEntry<T>(path: string, entry: DurableEntry<T>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendEntry<T>(
  path: string,
  entryId: string,
  payload: T,
  assignCursor: (payload: T, cursor: number) => T,
): Promise<T> {
  assertIdentifier(entryId, "entry ID");
  return withLock(`${path}.lock`, async () => {
    const entries = await readEntries<T>(path);
    const existing = entries.find((entry) => entry.entryId === entryId);
    if (existing !== undefined) {
      const replay = assignCursor(payload, entries.indexOf(existing) + 1);
      if (JSON.stringify(existing.payload) !== JSON.stringify(replay)) {
        throw new DurableEntryConflictError(entryId);
      }
      return structuredClone(existing.payload);
    }
    const assigned = assignCursor(payload, entries.length + 1);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ entryId, payload: assigned } satisfies DurableEntry<T>)}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    return structuredClone(assigned);
  });
}

async function readEntries<T>(path: string): Promise<DurableEntry<T>[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  if (content.length > 0 && !content.endsWith("\n")) {
    throw new Error(`Incomplete durable JSONL record: ${path}`);
  }
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DurableEntry<T>);
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await rm(path, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${path}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

function validateCursor(after: number, limit: number): void {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("Cursor must be non-negative");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Limit must be positive");
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
