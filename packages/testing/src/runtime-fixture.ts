import type { JournalEvent, RunSnapshot, RuntimeState, RuntimeTask } from "@senawa/domain";

const actor = { channel: "driver" as const };

export function createJournalEvent(runId: string, seq: number, message: string): JournalEvent {
  return {
    apiVersion: "senawa.dev/event/v1",
    seq,
    ts: "2026-08-05T10:00:00.000Z",
    runId,
    event: "work.resumed",
    actor,
    data: { message },
  };
}

export function createRuntimeFixture(runId: string): RuntimeState {
  const snapshot = {
    apiVersion: "senawa.dev/snapshot/v2",
    runId,
    createdAt: "2026-08-05T10:00:00.000Z",
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
      backend: "file",
      workflow: "test",
      request: { goal: "test", constraints: [] },
      createdAt: snapshot.createdAt,
      fingerprint: snapshot.fingerprint,
      workerHost: {
        kind: "simulated",
        adapter: "simulated-worker",
        adapterVersion: "1",
        legacy: false,
      },
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
    dispatches: [],
    leases: { driver: null, web: null },
    leaseFences: { driver: 0, web: 0 },
  };
}

export function createTaskRuntimeFixture(runId: string): RuntimeState {
  const state = createRuntimeFixture(runId);
  const task = (key: string, dependsOn: string[] = []): RuntimeTask => ({
    key,
    title: key,
    dependsOn,
    paths: [`src/${key}.ts`],
    repositoryChange: "required",
    acceptance: [`${key} passes`],
    role: "worker",
    status: "pending",
    attempt: 0,
    dispatchFailures: 0,
    sessionId: null,
    steering: [],
    reworkFindings: [],
  });
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
                repositoryChanges: ["required"],
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
    tasks: [task("task-one"), task("task-two", ["task-one"])],
  };
}
