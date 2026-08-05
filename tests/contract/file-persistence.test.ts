import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRunDocumentStore } from "@senawa/artifact-store";
import { FileJournalStore, FileOutputLogStore } from "@senawa/observability";
import {
  FileActiveRunRegistry,
  FileLeaseStore,
  FileRunPersistence,
  type FileRunPersistenceOptions,
  FileRuntimeStateStore,
} from "@senawa/runtime-file";
import {
  createJournalEvent,
  createRuntimeFixture,
  dispatchProjectionContract,
  documentContract,
  journalOutputContract,
  leaseContract,
  runtimeStateContract,
} from "@senawa/testing";
import { expect, it } from "vitest";

runtimeStateContract(async () => {
  const root = await temporaryRoot();
  return { current: persistence(root), reopen: () => persistence(root) };
});

documentContract(async () => {
  const root = await temporaryRoot();
  return {
    current: new FileRunDocumentStore(root),
    reopen: () => new FileRunDocumentStore(root),
  };
});

journalOutputContract(async () => {
  const root = await temporaryRoot();
  const stores = () => ({
    journal: new FileJournalStore(root),
    output: new FileOutputLogStore(root),
  });
  return { current: stores(), reopen: stores };
});

leaseContract(async () => {
  const root = await temporaryRoot();
  let now = new Date("2026-08-05T10:00:00.000Z");
  const store = () => new FileLeaseStore(root, () => now);
  return {
    current: store(),
    reopen: store,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
});

dispatchProjectionContract(async () => {
  const root = await temporaryRoot();
  return { current: persistence(root), reopen: () => persistence(root) };
});

it("recovers a split create interrupted after durable evidence", async () => {
  const root = await temporaryRoot();
  const state = createRuntimeFixture("run-crash-recovery");
  state.journal.push(createJournalEvent(state.identity.runId, 1, "started"));
  const crashing = persistence(root, {
    afterStep(step) {
      if (step === "evidence") throw new Error("injected persistence crash");
    },
  });

  await expect(crashing.createRun(state, "start-crash")).rejects.toThrow(
    "injected persistence crash",
  );
  const recovered = await persistence(root).readRun(state.identity.runId);
  expect(recovered.state.journal).toEqual(state.journal);
  expect(recovered.state.status).toBe("running");
  expect(await persistence(root).getActiveRunId()).toBe(state.identity.runId);
});

it("stores worker output in a session and turn stream", async () => {
  const root = await temporaryRoot();
  const output = new FileOutputLogStore(root);
  await output.appendOutput({
    runId: "run-stream",
    ownerKind: "task",
    ownerId: "task-one",
    entryId: "record.one",
    record: {
      apiVersion: "senawa.dev/output/v1",
      seq: 99,
      ts: "2026-08-05T10:00:00.000Z",
      runId: "run-stream",
      owner: { kind: "task", id: "task-one" },
      sessionId: "session-one",
      turnId: "turn-one",
      stream: "stdout",
      text: "partitioned",
    },
  });
  const path = join(
    root,
    ".agents",
    ".copilot-tracking",
    "run-stream",
    "output",
    "sessions",
    "session-one",
    "turn-one.jsonl",
  );
  expect(await readFile(path, "utf8")).toContain('"text":"partitioned"');
  expect(await output.readOutput("run-stream", "task", "task-one", 0, 10)).toHaveLength(1);
});

it("rejects reopening a run through a different runtime backend", async () => {
  const root = await temporaryRoot();
  const state = createRuntimeFixture("run-backend-mismatch");
  await persistence(root).createRun(state, "start");
  const mismatched = new FileRunPersistence(
    root,
    {
      runtime: new FileRuntimeStateStore(root),
      activeRuns: new FileActiveRunRegistry(root, "beads"),
      documents: new FileRunDocumentStore(root),
      journal: new FileJournalStore(root),
      output: new FileOutputLogStore(root),
      leases: new FileLeaseStore(root),
    },
    { backend: "beads" },
  );

  await expect(mismatched.getActiveRunId()).rejects.toThrow(
    "uses file runtime, not selected beads runtime",
  );
  await expect(mismatched.readRun(state.identity.runId)).rejects.toThrow(
    "uses file runtime, not selected beads runtime",
  );
});

function persistence(root: string, options: FileRunPersistenceOptions = {}): FileRunPersistence {
  return new FileRunPersistence(
    root,
    {
      runtime: new FileRuntimeStateStore(root),
      activeRuns: new FileActiveRunRegistry(root),
      documents: new FileRunDocumentStore(root),
      journal: new FileJournalStore(root),
      output: new FileOutputLogStore(root),
      leases: new FileLeaseStore(root),
    },
    options,
  );
}

function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "senawa-contract-"));
}
