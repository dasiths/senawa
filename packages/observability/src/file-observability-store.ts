import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  JournalStoragePort,
  NotificationPort,
  OutputLogStoragePort,
  WorkerEventRecord,
  WorkerEventStoragePort,
} from "@senawa/application";
import type { JournalEvent, OutputRecord } from "@senawa/domain";
import { ARTIFACT_ID_PATTERN } from "@senawa/domain";

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
    assertOwnerId(ownerId, "output owner ID");
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

export class FileWorkerEventStore implements WorkerEventStoragePort {
  private readonly trackingDirectory: string;

  constructor(
    repositoryRoot: string,
    private readonly notifications?: NotificationPort,
  ) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async appendWorkerEvent(input: {
    readonly runId: string;
    readonly entryId: string;
    readonly record: WorkerEventRecord;
  }): Promise<WorkerEventRecord> {
    if (input.record.runId !== input.runId) {
      throw new Error(`Worker event run ${input.record.runId} does not match ${input.runId}`);
    }
    if (input.record.event.eventId !== input.entryId) {
      throw new Error(
        `Worker event ${input.record.event.eventId} does not match entry ${input.entryId}`,
      );
    }
    const record = await appendEntry(
      this.path(input.record),
      input.entryId,
      input.record,
      (record) => record,
      false,
      equivalentWorkerRecord,
    );
    await this.notifications?.publishRunChanged(input.runId);
    if (record.owner.kind === "task") await this.materializeTaskEvidence(record);
    return record;
  }

  async readWorkerEvents(runId: string): Promise<readonly WorkerEventRecord[]> {
    assertIdentifier(runId, "run ID");
    const paths = await listJsonlFiles(join(this.trackingDirectory, runId, "workers", "sessions"));
    return (await Promise.all(paths.map((path) => readEntries<WorkerEventRecord>(path))))
      .flat()
      .map((entry) => entry.payload)
      .toSorted(
        (left, right) =>
          left.event.ts.localeCompare(right.event.ts) ||
          left.event.eventId.localeCompare(right.event.eventId),
      );
  }

  private path(record: WorkerEventRecord): string {
    assertIdentifier(record.runId, "run ID");
    assertIdentifier(record.event.sessionId, "session ID");
    assertIdentifier(record.event.turnId, "turn ID");
    return join(
      this.trackingDirectory,
      record.runId,
      "workers",
      "sessions",
      record.event.sessionId,
      `${record.event.turnId}.jsonl`,
    );
  }

  private async materializeTaskEvidence(record: WorkerEventRecord): Promise<void> {
    assertOwnerId(record.owner.id, "task ID");
    const events = (await this.readWorkerEvents(record.runId)).filter(
      (candidate) => candidate.owner.kind === "task" && candidate.owner.id === record.owner.id,
    );
    const directory = join(this.trackingDirectory, record.runId, "tasks", record.owner.id);
    await mkdir(directory, { recursive: true });
    const transcript = events.flatMap((candidate) =>
      candidate.event.kind === "text"
        ? [
            `### ${sanitizeEvidence(candidate.event.stream, 32)}\n\n${sanitizeEvidence(candidate.event.text, 8_000)}`,
          ]
        : [],
    );
    await writeFile(
      join(directory, "transcript.md"),
      `${transcript.length === 0 ? "# No worker transcript was reported" : `# Worker transcript\n\n${transcript.join("\n\n")}`}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const latestDiff = events
      .filter((candidate) => candidate.event.kind === "diff")
      .map((candidate) => candidate.event)
      .at(-1);
    const diff =
      latestDiff?.kind === "diff" && latestDiff.changed
        ? sanitizeEvidence(latestDiff.patch, 200_000)
        : `# Senawa evidence: ${sanitizeEvidence(
            latestDiff?.kind === "diff"
              ? (latestDiff.reason ?? "Worker reported no task changes")
              : "No task diff event was reported",
            500,
          )}\n`;
    await writeFile(join(directory, "diff.patch"), diff, { encoding: "utf8", mode: 0o600 });
  }
}

export class FileSensorEvidenceStore {
  private readonly trackingDirectory: string;

  constructor(repositoryRoot: string) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async spill(input: {
    readonly runId: string;
    readonly owner: { readonly kind: "phase" | "task"; readonly id: string };
    readonly sensorId: string;
    readonly stream: "stdout" | "stderr";
    readonly content: string;
  }): Promise<string> {
    assertIdentifier(input.runId, "run ID");
    assertOwnerId(input.owner.id, "sensor owner ID");
    assertIdentifier(input.sensorId, "sensor ID");
    const content = sanitizeEvidence(input.content, 1_000_000);
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const relativePath = join(
      "sensors",
      "runs",
      input.sensorId,
      `${input.owner.kind}-${input.owner.id}-${input.stream}-${digest}.txt`,
    );
    const path = join(this.trackingDirectory, input.runId, relativePath);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if ((await readFile(path, "utf8")) !== content) {
        throw new DurableEntryConflictError(relativePath);
      }
    }
    return relativePath;
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
  validateEntryId = true,
  equivalent: (left: T, right: T) => boolean = equalJson,
): Promise<T> {
  if (validateEntryId) assertIdentifier(entryId, "entry ID");
  return withLock(`${path}.lock`, async () => {
    const entries = await readEntries<T>(path);
    const existing = entries.find((entry) => entry.entryId === entryId);
    if (existing !== undefined) {
      const replay = assignCursor(payload, entries.indexOf(existing) + 1);
      if (!equivalent(existing.payload, replay)) {
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

function equivalentWorkerRecord(left: WorkerEventRecord, right: WorkerEventRecord): boolean {
  return equalJson(normalizeWorkerRecord(left), normalizeWorkerRecord(right));
}

function normalizeWorkerRecord(record: WorkerEventRecord): unknown {
  const event = { ...record.event } as Record<string, unknown>;
  Reflect.deleteProperty(event, "ts");
  if (Reflect.get(event, "kind") === "lifecycle") {
    Reflect.deleteProperty(event, "durationMs");
  }
  return { ...record, event };
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function sanitizeEvidence(value: string, limit: number): string {
  return [...value.slice(0, limit).replaceAll("\r\n", "\n")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || (code >= 32 && (code < 127 || code > 159));
    })
    .join("")
    .replace(/<\/?(?:system|assistant|user|tool|instructions?)\b[^>]*>/giu, "[neutralized-tag]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

/** Owner ids include plan-authored task keys, which are only bound by the artifact id shape. */
function assertOwnerId(value: string, label: string): void {
  if (!ARTIFACT_ID_PATTERN.test(value) || value.length > 128) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
