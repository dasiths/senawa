import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalEvent, RunSnapshot } from "@senawa/core";
import { describe, expect, it } from "vitest";
import {
  ActiveRunError,
  FileRuntimeStore,
  LeaseConflictError,
  type RuntimeState,
} from "./runtime-store.js";

const actor = { channel: "driver" as const };

describe("FileRuntimeStore", () => {
  it("serializes append-only updates and enforces repository ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-graph-"));
    const store = new FileRuntimeStore(root);
    await store.createRun(runtime("run-one"));

    await expect(store.createRun(runtime("run-two"))).rejects.toBeInstanceOf(ActiveRunError);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.updateRun("run-one", (draft) => {
          draft.journal.push(event(draft, `event-${index}`));
        }),
      ),
    );

    const stored = await store.readRun("run-one");
    expect(stored.journal).toHaveLength(8);
    expect(stored.journal.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(
      store.updateRun("run-one", (draft) => {
        draft.journal.shift();
      }),
    ).rejects.toThrow("journal is append-only");
  });

  it("refuses live lease contenders and archives a terminal run on replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-graph-"));
    const store = new FileRuntimeStore(root, () => new Date("2026-08-04T10:00:00.000Z"));
    await store.createRun(runtime("run-one"));
    await store.acquireLease("run-one", "driver", "driver-a", 30_000);
    await expect(
      store.acquireLease("run-one", "driver", "driver-b", 30_000),
    ).rejects.toBeInstanceOf(LeaseConflictError);

    await store.updateRun("run-one", (draft) => {
      draft.status = "ended";
      draft.endReason = "superseded";
    });
    expect(await store.getActiveRunId()).toBeNull();

    await store.createRun(runtime("run-two"));
    expect(await store.getActiveRunId()).toBe("run-two");
    expect((await store.readRun("run-one")).status).toBe("ended");
  });
});

function event(state: RuntimeState, message: string): JournalEvent {
  return {
    apiVersion: "senawa.dev/event/v1",
    seq: state.journal.length + 1,
    ts: "2026-08-04T10:00:00.000Z",
    runId: state.identity.runId,
    event: "work.resumed",
    actor,
    data: { message },
  };
}

function runtime(runId: string): RuntimeState {
  const snapshot = {
    apiVersion: "senawa.dev/snapshot/v2",
    runId,
    createdAt: "2026-08-04T10:00:00.000Z",
    fingerprint: "a".repeat(64),
    workflow: {
      apiVersion: "senawa.dev/workflow/v1",
      kind: "Workflow",
      metadata: { name: "test", description: "test workflow" },
      spec: {
        inputSchema: "../schemas/request.json",
        completesWhen: "phase-accepted",
        phases: [
          {
            id: "phase",
            dependsOn: [],
            executor: {
              kind: "agent",
              role: "worker",
              resumeAcrossIterations: true,
              output: { path: "artifact.json", schema: "../schemas/artifact.json" },
            },
            exit: { gate: "artifact", approval: "human" },
            iteration: { max: 1, onUpstreamChange: "flag" },
          },
        ],
      },
    },
    policy: {
      version: 1,
      extensions: [{ package: "sensor" }],
      sensors: [
        {
          id: "present",
          extension: "sensor",
          kind: "deterministic",
          description: "present",
          cost: "cheap",
          trust: "blocking",
          scope: [],
          config: {},
        },
      ],
      gates: [
        {
          id: "artifact",
          description: "artifact",
          checks: [
            {
              sensor: "present",
              expect: { path: "/verdict", operator: "equals", value: "pass" },
              advisory: false,
            },
          ],
          onFail: "block",
          escalateOnExhaustion: true,
        },
      ],
      frozen: [".senawa/sensors.yaml"],
    },
    workerProfiles: {
      worker: {
        apiVersion: "senawa.dev/worker-profile/v1",
        kind: "WorkerProfile",
        metadata: { name: "worker" },
        spec: { model: { id: "test-model" }, tools: ["repository.read"] },
        prompt: "Test worker",
      },
    },
    files: [
      {
        path: "workflow.yaml",
        sha256: "b".repeat(64),
        mediaType: "application/yaml",
        content: "workflow",
      },
    ],
  } satisfies RunSnapshot;
  return {
    apiVersion: "senawa.dev/runtime/v1",
    identity: {
      runId,
      workflow: "test",
      request: { goal: "test", constraints: [] },
      createdAt: snapshot.createdAt,
      fingerprint: snapshot.fingerprint,
    },
    snapshot,
    status: "running",
    endReason: null,
    phases: [
      {
        id: "phase",
        status: "pending",
        iteration: 0,
        artifactVersion: null,
        sessionId: null,
        rejectionReason: null,
      },
    ],
    tasks: [],
    artifacts: [],
    journal: [],
    outputs: {},
    activeTurn: null,
    leases: { driver: null, web: null },
  };
}
