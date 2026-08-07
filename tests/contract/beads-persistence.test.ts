import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FileRunDocumentStore } from "@senawa/artifact-store";
import type { RuntimeState, RuntimeTask } from "@senawa/domain";
import { FileJournalStore, FileOutputLogStore, FileWorkerEventStore } from "@senawa/observability";
import { BeadsClient, BeadsRuntimeStateStore } from "@senawa/runtime-beads";
import {
  FileActiveRunRegistry,
  FileLeaseStore,
  FileRunPersistence,
  type FileRunPersistenceOptions,
} from "@senawa/runtime-file";
import {
  createJournalEvent,
  createRuntimeFixture,
  dispatchProjectionContract,
  leaseContract,
  runtimeStateContract,
} from "@senawa/testing";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

runtimeStateContract(async () => {
  const root = await beadsRoot();
  return { current: persistence(root), reopen: () => persistence(root) };
});

leaseContract(async () => {
  const root = await beadsRoot();
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
  const root = await beadsRoot();
  return { current: persistence(root), reopen: () => persistence(root) };
});

describe("Beads runtime state", () => {
  it("imports tasks additively, claims atomically, and reconstructs closed work", async () => {
    const root = await beadsRoot();
    const runtime = new BeadsRuntimeStateStore(root);
    const stores = persistence(root, runtime);
    const state = taskFixture("run-beads-tasks", [
      task("task-one"),
      task("task-two", ["task-one"]),
    ]);
    await stores.createRun(state, "start");

    const initial = await stores.readRun(state.identity.runId);
    await expect(
      runtime.claimReadyTask({
        runId: state.identity.runId,
        expectedRevision: initial.revision,
        operationId: "claim-one",
      }),
    ).resolves.toMatchObject({
      key: "task-one",
      status: "in_progress",
    });
    const afterClaim = await stores.readRun(state.identity.runId);
    await expect(
      runtime.claimReadyTask({
        runId: state.identity.runId,
        expectedRevision: afterClaim.revision,
        operationId: "claim-blocked",
      }),
    ).resolves.toBeNull();

    const claimed = await stores.readRun(state.identity.runId);
    const closed = structuredClone(claimed.state);
    const first = closed.tasks.find((candidate) => candidate.key === "task-one");
    if (first === undefined) throw new Error("missing task-one");
    first.status = "closed";
    closed.tasks.push(task("task-three", ["task-one"]));
    await stores.commitRun({
      runId: state.identity.runId,
      expectedRevision: claimed.revision,
      operationId: "close-and-import",
      state: closed,
    });

    const reopened = await persistence(root).readRun(state.identity.runId);
    expect(reopened.state.tasks.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["task-one", "closed"],
      ["task-two", "pending"],
      ["task-three", "pending"],
    ]);
    const all = await new BeadsClient(root).json<Array<{ readonly issue_type: string }>>([
      "list",
      "--all",
      "--limit",
      "0",
    ]);
    expect(all.some((issue) => issue.issue_type === "event")).toBe(true);
  });

  it("creates and resolves human gates before closing an approved phase", async () => {
    const root = await beadsRoot();
    const stores = persistence(root);
    const state = createRuntimeFixture("run-beads-gate");
    await stores.createRun(state, "start");
    const current = await stores.readRun(state.identity.runId);
    const waiting = structuredClone(current.state);
    waiting.status = "awaiting_approval";
    requireFirstPhase(waiting).status = "awaiting_approval";
    const gated = await stores.commitRun({
      runId: state.identity.runId,
      expectedRevision: current.revision,
      operationId: "await-human",
      state: waiting,
    });
    expect(await new BeadsClient(root).json<unknown[]>(["gate", "list"])).toHaveLength(1);

    const accepted = structuredClone(gated.state);
    accepted.status = "running";
    requireFirstPhase(accepted).status = "accepted";
    await stores.commitRun({
      runId: state.identity.runId,
      expectedRevision: gated.revision,
      operationId: "approve-human",
      state: accepted,
    });
    const remaining = await new BeadsClient(root).json<unknown[] | null>(["gate", "list"]);
    expect(remaining ?? []).toHaveLength(0);
    expect((await persistence(root).readRun(state.identity.runId)).state.phases[0]?.status).toBe(
      "accepted",
    );
  });

  it("refreshes a long-lived reader after an independent recovery commits", async () => {
    const root = await beadsRoot();
    const state = createRuntimeFixture("run-cross-instance-recovery");
    const longLived = persistence(root);
    await longLived.createRun(state, "start-cross-instance-recovery");
    const primed = await longLived.readRun(state.identity.runId);
    const next = structuredClone(primed.state);
    requireFirstPhase(next).status = "running";
    const event = createJournalEvent(state.identity.runId, 1, "runtime recovery committed");
    next.journal.push(event);
    const interrupted = persistence(root, new BeadsRuntimeStateStore(root), {
      afterStep(step) {
        if (step === "evidence") throw new Error("injected persistence crash");
      },
    });

    await expect(
      interrupted.commitRun({
        runId: state.identity.runId,
        expectedRevision: primed.revision,
        operationId: "commit-cross-instance-recovery",
        state: next,
      }),
    ).rejects.toThrow("injected persistence crash");
    await expect(longLived.readJournal(state.identity.runId, 0, 10)).resolves.toEqual([event]);

    const recovered = await persistence(root).readRun(state.identity.runId);
    const refreshed = await longLived.readRun(state.identity.runId);
    expect(refreshed.revision).toBe(recovered.revision);
    expect(refreshed.revision).not.toBe(primed.revision);
    expect(refreshed.state.phases[0]?.status).toBe("running");
    expect(refreshed.state.journal).toEqual([event]);
  });

  it("recovers each split transition step through the durable operation", async () => {
    for (const injectedStep of [
      "pending-metadata",
      "coarse-status",
      "state-event",
      "final-metadata",
    ] as const) {
      const root = await beadsRoot();
      const state = createRuntimeFixture(`run-recover-${injectedStep}`);
      const stable = persistence(root);
      await stable.createRun(state, "start");
      const current = await stable.readRun(state.identity.runId);
      const next = structuredClone(current.state);
      requireFirstPhase(next).status = "running";
      let injected = false;
      const runtime = new BeadsRuntimeStateStore(root, {
        afterTransitionStep(step) {
          if (!injected && step === injectedStep) {
            injected = true;
            throw new Error(`injected ${step}`);
          }
        },
      });
      await expect(
        persistence(root, runtime).commitRun({
          runId: state.identity.runId,
          expectedRevision: current.revision,
          operationId: `recover-${injectedStep}`,
          state: next,
        }),
      ).rejects.toThrow(`injected ${injectedStep}`);
      const recovered = await persistence(root).readRun(state.identity.runId);
      expect(recovered.state.phases[0]?.status).toBe("running");
    }
  });
});

function persistence(
  root: string,
  runtime: BeadsRuntimeStateStore = new BeadsRuntimeStateStore(root),
  options: FileRunPersistenceOptions = {},
): FileRunPersistence {
  return new FileRunPersistence(
    root,
    {
      runtime,
      activeRuns: new FileActiveRunRegistry(root),
      documents: new FileRunDocumentStore(root),
      journal: new FileJournalStore(root),
      output: new FileOutputLogStore(root),
      workerEvents: new FileWorkerEventStore(root),
      leases: new FileLeaseStore(root),
    },
    { lockTimeoutMs: 120_000, staleLockMs: 300_000, ...options },
  );
}

async function beadsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-beads-contract-"));
  await execute("git", ["init", "--quiet", root]);
  await execute("git", ["-C", root, "config", "user.email", "phase7@example.com"]);
  await execute("git", ["-C", root, "config", "user.name", "phase7"]);
  await execute("git", ["-C", root, "config", "beads.role", "maintainer"]);
  return root;
}

function taskFixture(runId: string, tasks: RuntimeTask[]): RuntimeState {
  const state = createRuntimeFixture(runId);
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      workflow: {
        ...state.snapshot.workflow,
        spec: {
          ...state.snapshot.workflow.spec,
          phases: [
            {
              id: "phase",
              dependsOn: [],
              executor: {
                kind: "task-frontier",
                role: "worker",
                concurrency: 1,
                reentrant: true,
              },
              loop: {
                until: "all-selected-tasks-closed",
                each: {
                  gate: "artifact",
                  rework: { resumeSession: true, maxAttempts: 2 },
                  dispatch: { maxFailures: 2 },
                  onExhausted: "escalate",
                },
              },
              iteration: { max: 2, onUpstreamChange: "flag" },
            },
          ],
        },
      },
    },
    tasks,
  };
}

function task(key: string, dependsOn: string[] = []): RuntimeTask {
  return {
    key,
    title: key,
    dependsOn,
    paths: [`src/${key}.ts`],
    acceptance: [`${key} passes`],
    role: "worker",
    status: "pending",
    attempt: 0,
    dispatchFailures: 0,
    sessionId: null,
    steering: [],
    reworkFindings: [],
  };
}

function requireFirstPhase(state: RuntimeState): RuntimeState["phases"][number] {
  const phase = state.phases[0];
  if (phase === undefined) throw new Error("runtime fixture has no phase");
  return phase;
}
