import {
  type JournalStoragePort,
  type LeaseStoragePort,
  type OutputLogStoragePort,
  projectRunStatus,
  type RunDocumentStoragePort,
  type RunPersistencePort,
  RuntimeRevisionConflictError,
} from "@senawa/application";
import { describe, expect, it } from "vitest";
import { createJournalEvent, createRuntimeFixture } from "./runtime-fixture.js";

export interface Reopenable<T> {
  readonly current: T;
  reopen(): T;
}

export function runtimeStateContract(create: () => Promise<Reopenable<RunPersistencePort>>): void {
  describe("runtime state contract", () => {
    it("persists revisions and terminal active ownership across restart", async () => {
      const harness = await create();
      const state = createRuntimeFixture("run-restart");
      await harness.current.publishSnapshot(state.snapshot, "start.snapshot");
      await harness.current.createRun(state, "start");
      const first = await harness.current.readRun(state.identity.runId);
      expect(first.revision).toBe("1");
      const ended = structuredClone(first.state);
      ended.status = "ended";
      ended.endReason = "contract complete";
      await harness.current.commitRun({
        runId: state.identity.runId,
        expectedRevision: first.revision,
        operationId: "end",
        state: ended,
      });
      expect((await harness.reopen().readRun(state.identity.runId)).state.status).toBe("ended");
      expect(await harness.reopen().getActiveRunId()).toBeNull();
    });

    it("rejects a stale runtime revision", async () => {
      const harness = await create();
      const state = createRuntimeFixture("run-conflict");
      await harness.current.createRun(state, "start");
      await expect(
        harness.current.commitRun({
          runId: state.identity.runId,
          expectedRevision: "0",
          operationId: "stale",
          state,
        }),
      ).rejects.toBeInstanceOf(RuntimeRevisionConflictError);
    });
  });
}

export function documentContract(create: () => Promise<Reopenable<RunDocumentStoragePort>>): void {
  describe("document contract", () => {
    it("reopens immutable snapshots and rejects changed artifact content", async () => {
      const harness = await create();
      const state = createRuntimeFixture("run-documents");
      const artifact = {
        phaseId: "phase",
        version: 1,
        path: "artifacts/phase/v1.json",
        createdAt: state.identity.createdAt,
        content: { verdict: "first" },
        consumed: {},
      } as const;
      await harness.current.publishIdentity(state.identity, "identity");
      await harness.current.publishSnapshot(state.snapshot, "snapshot");
      await harness.current.publishArtifact(artifact, state.identity.runId, "artifact");
      await harness.current.publishArtifact(artifact, state.identity.runId, "artifact-retry");
      expect((await harness.reopen().readSnapshot(state.identity.runId)).fingerprint).toBe(
        state.snapshot.fingerprint,
      );
      await expect(
        harness
          .reopen()
          .publishArtifact(
            { ...artifact, content: { verdict: "changed" } },
            state.identity.runId,
            "artifact-conflict",
          ),
      ).rejects.toThrow("conflicts");
    });
  });
}

export function journalOutputContract(
  create: () => Promise<
    Reopenable<{ readonly journal: JournalStoragePort; readonly output: OutputLogStoragePort }>
  >,
): void {
  describe("journal and output contract", () => {
    it("deduplicates stable IDs and replays durable cursors after restart", async () => {
      const harness = await create();
      const proposedEvent = createJournalEvent("run-observation", 99, "first");
      const event = await harness.current.journal.appendJournal({
        runId: proposedEvent.runId,
        entryId: "event.first",
        event: proposedEvent,
      });
      expect(event.seq).toBe(1);
      await harness.current.journal.appendJournal({
        runId: event.runId,
        entryId: "event.first",
        event: proposedEvent,
      });
      const proposedRecord = {
        apiVersion: "senawa.dev/output/v1" as const,
        seq: 99,
        ts: event.ts,
        runId: event.runId,
        owner: { kind: "task" as const, id: "task-one" },
        sessionId: "session-one",
        turnId: "turn-one",
        stream: "stdout" as const,
        text: "durable output",
      };
      const record = await harness.current.output.appendOutput({
        runId: event.runId,
        ownerKind: "task",
        ownerId: "task-one",
        entryId: "record.first",
        record: proposedRecord,
      });
      expect(record.seq).toBe(1);
      expect(await harness.reopen().journal.readJournal(event.runId, 0, 10)).toEqual([event]);
      expect(
        await harness.reopen().output.readOutput(event.runId, "task", "task-one", 0, 10),
      ).toEqual([record]);
      await expect(
        harness.reopen().journal.appendJournal({
          runId: event.runId,
          entryId: "event.first",
          event: { ...event, data: { message: "changed" } },
        }),
      ).rejects.toThrow("different content");
    });
  });
}

export function leaseContract(
  create: () => Promise<Reopenable<LeaseStoragePort> & { advance(milliseconds: number): void }>,
): void {
  describe("lease fencing contract", () => {
    it("fences an expired owner across independent store instances", async () => {
      const harness = await create();
      const first = await harness.current.acquireLease("run-lease", "driver", "owner-a", 100);
      harness.advance(101);
      const second = await harness.reopen().acquireLease("run-lease", "driver", "owner-b", 100);
      expect(second.fence).toBeGreaterThan(first.fence);
      await expect(harness.current.renewLease("run-lease", "driver", first, 100)).rejects.toThrow();
      await expect(harness.current.releaseLease("run-lease", "driver", first)).rejects.toThrow();
    });
  });
}

export function dispatchProjectionContract(
  create: () => Promise<Reopenable<RunPersistencePort>>,
): void {
  describe("dispatch and projection contract", () => {
    it("reconstructs unsettled dispatch projection after restart", async () => {
      const harness = await create();
      const state = createRuntimeFixture("run-dispatch");
      await harness.current.createRun(state, "start");
      const current = await harness.current.readRun(state.identity.runId);
      const next = structuredClone(current.state);
      next.activeTurn = {
        ownerKind: "phase",
        ownerId: "phase",
        sessionId: "session-one",
        attempt: 1,
        turnId: "turn-one",
        dispatchId: "dispatch-one",
        operationId: "operation-one",
        operation: "create",
      };
      next.dispatches.push({
        ...next.activeTurn,
        workAttempt: 1,
        dispatchFailure: 0,
        createdAt: state.identity.createdAt,
        status: "intent",
        updatedAt: state.identity.createdAt,
      });
      await harness.current.commitRun({
        runId: state.identity.runId,
        expectedRevision: current.revision,
        operationId: "dispatch",
        state: next,
      });
      const projection = projectRunStatus(
        (await harness.reopen().readRun(state.identity.runId)).state,
      );
      expect(projection.unsettledDispatch?.dispatchId).toBe("dispatch-one");
      expect(projection.unsettledDispatch?.operatorAction).toContain("Resume");
    });
  });
}
