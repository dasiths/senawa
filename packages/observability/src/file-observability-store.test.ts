import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerEventRecord } from "@senawa/application";
import { afterEach, describe, expect, it } from "vitest";
import { DurableEntryConflictError, FileWorkerEventStore } from "./file-observability-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("FileWorkerEventStore", () => {
  it("deduplicates stable event IDs and rejects conflicting replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-worker-events-"));
    temporaryDirectories.push(root);
    const store = new FileWorkerEventStore(root);
    const record = workerEvent("turn-1:0", "created");
    if (record.event.kind !== "lifecycle") throw new Error("Expected lifecycle fixture");

    await store.appendWorkerEvent({ runId: record.runId, entryId: record.event.eventId, record });
    await store.appendWorkerEvent({ runId: record.runId, entryId: record.event.eventId, record });
    await store.appendWorkerEvent({
      runId: record.runId,
      entryId: record.event.eventId,
      record: {
        ...record,
        event: { ...record.event, ts: "2026-08-05T00:01:00.000Z", durationMs: 25 },
      },
    });

    expect(await store.readWorkerEvents(record.runId)).toEqual([record]);
    expect(
      await readFile(
        join(
          root,
          ".agents",
          ".copilot-tracking",
          record.runId,
          "tasks",
          record.owner.id,
          "transcript.md",
        ),
        "utf8",
      ),
    ).toContain("No worker transcript was reported");
    expect(
      await readFile(
        join(
          root,
          ".agents",
          ".copilot-tracking",
          record.runId,
          "tasks",
          record.owner.id,
          "diff.patch",
        ),
        "utf8",
      ),
    ).toContain("No task diff event was reported");
    await expect(
      store.appendWorkerEvent({
        runId: record.runId,
        entryId: record.event.eventId,
        record: workerEvent("turn-1:0", "failed"),
      }),
    ).rejects.toBeInstanceOf(DurableEntryConflictError);
  });
});

function workerEvent(eventId: string, event: "created" | "failed"): WorkerEventRecord {
  return {
    runId: "run-1",
    owner: { kind: "task", id: "task-1" },
    dispatchId: "dispatch-1",
    operationId: "operation-1",
    role: "implementor",
    attempt: 1,
    event: {
      apiVersion: "senawa.dev/worker-event/v1",
      eventId,
      sessionId: "session-1",
      turnId: "turn-1",
      ts: "2026-08-05T00:00:00.000Z",
      kind: "lifecycle",
      event,
    },
  };
}
