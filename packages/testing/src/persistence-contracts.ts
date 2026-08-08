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
import {
  createJournalEvent,
  createRuntimeFixture,
  createTaskRuntimeFixture,
} from "./runtime-fixture.js";

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
      expect(first.state.identity.workerHost).toEqual({
        kind: "simulated",
        adapter: "simulated-worker",
        adapterVersion: "1",
      });
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

    it("claims one dependency-ready task with a stable operation receipt", async () => {
      const harness = await create();
      const state = createTaskRuntimeFixture("run-claim");
      await harness.current.createRun(state, "start");
      const current = await harness.current.readRun(state.identity.runId);
      const input = {
        runId: state.identity.runId,
        expectedRevision: current.revision,
        operationId: "claim-one",
      };
      await expect(harness.current.claimReadyTask(input)).resolves.toMatchObject({
        key: "task-one",
        status: "in_progress",
      });
      await expect(harness.reopen().claimReadyTask(input)).resolves.toMatchObject({
        key: "task-one",
        status: "in_progress",
      });
      const claimed = await harness.reopen().readRun(state.identity.runId);
      expect(claimed.revision).toBe("2");
      const rework = structuredClone(claimed.state);
      const first = rework.tasks.find((task) => task.key === "task-one");
      if (first === undefined) throw new Error("claim fixture lost task-one");
      first.status = "rework";
      const reopened = await harness.reopen().commitRun({
        runId: state.identity.runId,
        expectedRevision: claimed.revision,
        operationId: "rework-one",
        state: rework,
      });
      await expect(
        harness.reopen().claimReadyTask({
          runId: state.identity.runId,
          expectedRevision: reopened.revision,
          operationId: "claim-rework",
        }),
      ).resolves.toMatchObject({ key: "task-one", status: "in_progress" });
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

    it("preserves exact task repository evidence after restart", async () => {
      const harness = await create();
      const state = createRuntimeFixture("run-task-evidence");
      state.dispatches.push({
        dispatchId: "dispatch-task",
        operationId: "operation-task",
        turnId: "turn-task",
        sessionId: "session-task",
        ownerKind: "task",
        ownerId: "task-one",
        operation: "create",
        workAttempt: 1,
        dispatchFailure: 0,
        createdAt: state.identity.createdAt,
        updatedAt: state.identity.createdAt,
        status: "completed",
        repositoryBaseline: {
          version: 1,
          kind: "repository-baseline",
          runId: state.identity.runId,
          taskId: "task-one",
          attempt: 1,
          dispatchId: "dispatch-task",
          turnId: "turn-task",
          expectation: "required",
          authorizedPaths: ["packages/application"],
          frozenPaths: [".senawa/**"],
          head: "head-before",
          entries: [{ path: "README.md", status: " M", digest: "a".repeat(64) }],
          capturedAt: state.identity.createdAt,
          uncertainty: [],
          digest: "b".repeat(64),
          evidencePath: "evidence/repository/tasks/task-one/baseline.json",
        },
        repositoryDelta: {
          version: 1,
          kind: "repository-delta",
          runId: state.identity.runId,
          taskId: "task-one",
          attempt: 1,
          dispatchId: "dispatch-task",
          turnId: "turn-task",
          expectation: "required",
          baselineDigest: "b".repeat(64),
          headBefore: "head-before",
          headAfter: "head-before",
          preExistingChanges: ["README.md"],
          changedPaths: [
            { path: "packages/application/src/run.ts", status: " M", digest: "c".repeat(64) },
          ],
          inScopeChanges: ["packages/application/src/run.ts"],
          outOfScopeChanges: [],
          frozenChanges: [],
          uncertainty: [],
          workerClaim: { reported: true, changed: false, agreement: "disagree" },
          capturedAt: state.identity.createdAt,
          digest: "d".repeat(64),
          evidencePath: "evidence/repository/tasks/task-one/delta.json",
        },
      });

      await harness.current.createRun(state, "start-task-evidence");

      const reopened = await harness.reopen().readRun(state.identity.runId);
      expect(reopened.state.dispatches[0]?.repositoryBaseline).toEqual(
        state.dispatches[0]?.repositoryBaseline,
      );
      expect(reopened.state.dispatches[0]?.repositoryDelta).toEqual(
        state.dispatches[0]?.repositoryDelta,
      );
    });
  });
}
