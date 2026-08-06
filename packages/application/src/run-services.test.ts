import { createRunSnapshot, loadRepositoryDefinitions } from "@senawa/configuration";
import { DefinitionArtifactSchema, type RuntimeState } from "@senawa/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { RuntimeRevisionConflictError, type WorkerTurn } from "./ports.js";
import { projectRunStatus } from "./projections.js";
import { RunCommandService, RunQueryService } from "./run-services.js";
import { FakeClock, FakeRunPersistence, SequenceIdentifiers } from "./testing.js";

const clock = new FakeClock(new Date("2026-08-05T12:00:00.000Z"));
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("application run use cases", () => {
  it("projects task-frontier ownership without conventional phase IDs", () => {
    const renamed = structuredClone(definitions);
    const implement = renamed.workflow.spec.phases.find((phase) => phase.id === "implement");
    const verify = renamed.workflow.spec.phases.find((phase) => phase.id === "verify");
    if (
      implement === undefined ||
      implement.executor.kind !== "task-frontier" ||
      verify === undefined
    ) {
      throw new Error("standard fixture is missing task-frontier phases");
    }
    implement.id = "execute-docs";
    implement.executor.selector = { phase: "execute-docs" };
    verify.id = "audit-docs";
    verify.dependsOn = ["execute-docs"];
    renamed.workflow.spec.completesWhen = "audit-docs-accepted";
    const snapshot = createRunSnapshot("renamed-frontier", renamed, clock.now());
    const state: RuntimeState = {
      apiVersion: "senawa.dev/runtime/v1",
      identity: {
        runId: snapshot.runId,
        backend: "file",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Project renamed phases", constraints: [] },
        createdAt: snapshot.createdAt,
        fingerprint: snapshot.fingerprint,
      },
      snapshot,
      status: "running",
      endReason: null,
      phases: snapshot.workflow.spec.phases.map((phase) => ({
        id: phase.id,
        status: "pending",
        iteration: 0,
        artifactVersion: null,
        sessionId: null,
        rejectionReason: null,
      })),
      tasks: [
        {
          key: "align-docs",
          title: "Align documentation",
          dependsOn: [],
          paths: ["docs"],
          acceptance: ["Documentation is consistent"],
          role: "implementor",
          status: "pending",
          attempt: 0,
          dispatchFailures: 0,
          sessionId: null,
          steering: [],
        },
      ],
      artifacts: [],
      journal: [],
      outputs: {},
      activeTurn: null,
      dispatches: [],
      leases: { driver: null, web: null },
    };

    const projection = projectRunStatus(state);

    expect(projection.phases.find((phase) => phase.id === "execute-docs")?.executorKind).toBe(
      "task-frontier",
    );
    expect(projection.tasks[0]?.parentPhaseId).toBe("execute-docs");
  });

  it("runs start, status, dispatch, gate, approval, and report through fakes", async () => {
    const persistence = new FakeRunPersistence();
    const turns: WorkerTurn[] = [];
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn) {
          turns.push(turn);
          return {
            sessionId: turn.sessionId,
            artifact: DefinitionArtifactSchema.parse({
              summary: "Define the application boundary",
              inScope: ["application"],
              outOfScope: [],
              acceptanceCriteria: ["Application ports are explicit"],
              constraints: [],
              openQuestions: [],
            }),
            output: [{ stream: "stdout", text: "definition complete" }],
          };
        },
      },
      {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("operation"),
      { scheduleEvery: () => () => undefined },
    );
    const queries = new RunQueryService(persistence, undefined, {
      render: async (runId) => `report:${runId}`,
    });
    const runId = "application-run";

    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Exercise application ports", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });

    expect(await queries.activeRunId()).toBe(runId);
    expect(await queries.status(runId)).toMatchObject({
      runId,
      status: "running",
      cursor: 2,
    });
    expect((await commands.drive(runId, { channel: "driver" })).kind).toBe("awaiting-approval");
    expect(turns).toHaveLength(1);
    expect((await queries.status(runId))?.needs?.phaseId).toBe("define");
    expect(await queries.artifact(runId, "define")).toMatchObject({ version: 1 });
    await commands.approve(runId, "define", { channel: "direct-cli" });
    expect(await queries.report(runId)).toBe(`report:${runId}`);
    expect(persistence.snapshots.has(runId)).toBe(true);
    expect(persistence.operations.length).toBeGreaterThan(4);
  });

  it("persists normalized worker events before committing browser-visible output", async () => {
    const persistence = new OrderedEvidencePersistence();
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn, onEvent) {
          await onEvent?.({
            apiVersion: "senawa.dev/worker-event/v1",
            eventId: `${turn.turnId}:0`,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            ts: clock.now().toISOString(),
            traceId: turn.traceId,
            kind: "lifecycle",
            event: "completed",
            durationMs: 1,
          });
          return {
            sessionId: turn.sessionId,
            artifact: DefinitionArtifactSchema.parse({
              summary: "Ordered evidence",
              inScope: ["application"],
              outOfScope: [],
              acceptanceCriteria: ["Events precede output"],
              constraints: [],
              openQuestions: [],
            }),
            output: [{ stream: "stdout", text: "visible after persistence" }],
          };
        },
      },
      {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("ordered"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "ordered-evidence";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Order evidence", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });

    await commands.drive(runId, { channel: "driver" });

    expect(persistence.order).toEqual(["worker-event", "output-commit"]);
  });

  it("allocates fresh physical identities after a missing phase dispatch", async () => {
    const persistence = new FakeRunPersistence();
    const turns: WorkerTurn[] = [];
    let failFirst = true;
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn) {
          turns.push(turn);
          if (failFirst) {
            failFirst = false;
            throw new Error("transport failed before session creation");
          }
          return {
            sessionId: turn.sessionId,
            artifact: DefinitionArtifactSchema.parse({
              summary: "Recovered with fresh identities",
              inScope: ["application"],
              outOfScope: [],
              acceptanceCriteria: ["The retry is independently durable"],
              constraints: [],
              openQuestions: [],
            }),
            output: [],
          };
        },
        async inspect() {
          return { state: "missing" as const };
        },
      },
      {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("retry"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "fresh-retry-identities";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Recover a missing dispatch", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const actor = { channel: "driver" as const };

    await expect(commands.drive(runId, actor)).rejects.toThrow("transport failed");
    expect((await commands.resume(runId, actor)).kind).toBe("idle");
    expect((await commands.resume(runId, actor)).kind).toBe("awaiting-approval");

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ operation: "create", attempt: 1 });
    expect(turns[1]?.sessionId).not.toBe(turns[0]?.sessionId);
    expect(turns[1]?.turnId).not.toBe(turns[0]?.turnId);
    expect(turns[1]?.operationId).not.toBe(turns[0]?.operationId);
    expect(turns[1]?.dispatchId).not.toBe(turns[0]?.dispatchId);
  });

  it("reconciles a completed turn from durable events after the worker process exits", async () => {
    const persistence = new FakeRunPersistence();
    let executeCount = 0;
    const artifact = DefinitionArtifactSchema.parse({
      summary: "Recovered from durable worker events",
      inScope: ["application"],
      outOfScope: [],
      acceptanceCriteria: ["A restarted driver can prove completion"],
      constraints: [],
      openQuestions: [],
    });
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn, onEvent) {
          executeCount += 1;
          await onEvent?.({
            apiVersion: "senawa.dev/worker-event/v1",
            eventId: `${turn.turnId}:artifact`,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            ts: clock.now().toISOString(),
            traceId: turn.traceId,
            kind: "artifact",
            artifact,
          });
          await onEvent?.({
            apiVersion: "senawa.dev/worker-event/v1",
            eventId: `${turn.turnId}:completed`,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            ts: clock.now().toISOString(),
            traceId: turn.traceId,
            kind: "lifecycle",
            event: "completed",
            durationMs: 1,
          });
          throw new Error("driver exited after durable worker completion");
        },
        async inspect() {
          return { state: "missing" as const };
        },
      },
      {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("durable-completion"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "durable-worker-completion";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Recover completed durable work", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });

    await expect(commands.drive(runId, { channel: "driver" })).rejects.toThrow(
      "driver exited after durable worker completion",
    );
    await expect(commands.resume(runId, { channel: "driver" })).resolves.toMatchObject({
      kind: "awaiting-approval",
      phaseId: "define",
    });

    expect(executeCount).toBe(1);
    expect(await new RunQueryService(persistence).artifact(runId, "define")).toMatchObject({
      content: artifact,
    });
  });

  it("reuses durable artifact evidence when the runtime commit retries", async () => {
    const persistence = new SplitArtifactPersistence();
    const artifact = DefinitionArtifactSchema.parse({
      summary: "Reuse immutable artifact evidence",
      inScope: ["application"],
      outOfScope: [],
      acceptanceCriteria: ["A split commit does not duplicate the artifact"],
      constraints: [],
      openQuestions: [],
    });
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn) {
          return { sessionId: turn.sessionId, artifact, output: [] };
        },
      },
      {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("split-artifact"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "split-artifact-retry";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Recover split artifact persistence", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });

    await expect(commands.drive(runId, { channel: "driver" })).resolves.toMatchObject({
      kind: "awaiting-approval",
      phaseId: "define",
    });

    const state = (await persistence.readRun(runId)).state;
    expect(state.artifacts).toHaveLength(1);
    expect(state.phases[0]).toMatchObject({ artifactVersion: 1, status: "awaiting_approval" });
  });

  it("reopens an escalated task when an operator records steering", async () => {
    const persistence = new FakeRunPersistence();
    const commands = new RunCommandService(
      persistence,
      {
        async execute() {
          throw new Error("not dispatched");
        },
      },
      {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("steering-recovery"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "steering-recovery";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Recover escalated work", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const current = await persistence.readRun(runId);
    current.state.status = "paused";
    current.state.tasks = [
      {
        key: "recover-me",
        title: "Recover me",
        dependsOn: [],
        paths: ["docs"],
        acceptance: ["The task can continue"],
        role: "implementor",
        status: "escalated",
        attempt: 1,
        dispatchFailures: 2,
        sessionId: null,
        steering: [],
      },
    ];
    await persistence.commitRun({
      runId,
      expectedRevision: current.revision,
      operationId: "seed-escalation",
      state: current.state,
    });

    await commands.steer(runId, "recover-me", "Retry after confirming the prior turn completed", {
      channel: "direct-cli",
    });

    expect((await persistence.readRun(runId)).state.tasks[0]).toMatchObject({
      status: "rework",
      attempt: 1,
      dispatchFailures: 0,
      steering: ["Retry after confirming the prior turn completed"],
    });
  });

  it("forces cancellation and reconciles a stranded dispatch before terminal release", async () => {
    const persistence = new FakeRunPersistence();
    let cancelled = false;
    const commands = new RunCommandService(
      persistence,
      {
        async execute() {
          throw new Error("worker transport crashed");
        },
        async inspect() {
          return cancelled
            ? { state: "cancelled" as const, detail: "forced by operator" }
            : { state: "active" as const };
        },
        async cancel(_turn, reason) {
          cancelled = true;
          return { cancelled: true, detail: reason };
        },
      },
      {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("forced"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "forced-end";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "End stranded work", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    await expect(commands.drive(runId, { channel: "driver" })).rejects.toThrow(
      "worker transport crashed",
    );
    await expect(
      commands.end(runId, "operator abandoned work", { channel: "direct-cli" }),
    ).rejects.toThrow("active worker turn");

    await expect(
      commands.end(
        runId,
        "operator abandoned work",
        { channel: "direct-cli" },
        { force: true, graceMs: 0 },
      ),
    ).resolves.toMatchObject({ kind: "ended" });

    const state = (await persistence.readRun(runId)).state;
    expect(cancelled).toBe(true);
    expect(state.activeTurn).toBeNull();
    expect(state.dispatches.at(-1)?.status).toBe("cancelled");
    expect(state.journal.map((event) => event.event)).toContain("worker.aborted");
    expect(await persistence.getActiveRunId()).toBeNull();
  });

  it("audits sensor drift and latency from recorded evidence", async () => {
    const persistence = new FakeRunPersistence();
    let sample = 0;
    const commands = new RunCommandService(
      persistence,
      {
        async execute() {
          throw new Error("not dispatched");
        },
      },
      {
        async evaluate(input) {
          sample += 1;
          const passed = sample === 1;
          return {
            gateId: input.gateId,
            accepted: passed,
            readings: [
              {
                sensorId: "audit-sensor",
                extension: "@senawa/sensor-command",
                result: {
                  verdict: passed ? ("pass" as const) : ("fail" as const),
                  summary: "audit",
                  findings: [],
                },
                expect: { path: "/verdict", operator: "equals" as const, value: "pass" },
                matched: passed,
                advisory: false,
                durationMs: sample * 10,
                evidencePaths: [],
              },
            ],
            findings: [],
          };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("audit"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "sensor-audit";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Audit sensors", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const gateId = definitions.policy.gates[0]?.id;
    if (gateId === undefined) throw new Error("Test definitions require a gate");
    await commands.checkGate(runId, gateId, { kind: "phase", id: "define" }, { channel: "driver" });
    await commands.checkGate(runId, gateId, { kind: "phase", id: "define" }, { channel: "driver" });

    const audit = await new RunQueryService(persistence).sensorAudit(runId);
    expect(audit.sensors).toEqual([
      expect.objectContaining({
        sensorId: "audit-sensor",
        samples: 2,
        agreement: 0.5,
        driftTransitions: 1,
        p95DurationMs: 20,
      }),
    ]);
    expect(audit.hookLatency).toEqual({
      samples: 0,
      p95DurationMs: null,
      status: "unreported",
    });
  });
});

class OrderedEvidencePersistence extends FakeRunPersistence {
  readonly order: string[] = [];

  override appendWorkerEvent(input: Parameters<FakeRunPersistence["appendWorkerEvent"]>[0]) {
    this.order.push("worker-event");
    return super.appendWorkerEvent(input);
  }

  override async commitRun(input: Parameters<FakeRunPersistence["commitRun"]>[0]) {
    const hasOutput = Object.values(input.state.outputs).some((records) => records.length > 0);
    if (hasOutput && !this.order.includes("output-commit")) this.order.push("output-commit");
    return super.commitRun(input);
  }
}

class SplitArtifactPersistence extends FakeRunPersistence {
  private split = false;

  override async commitRun(input: Parameters<FakeRunPersistence["commitRun"]>[0]) {
    if (!this.split && input.state.artifacts.length > 0) {
      this.split = true;
      const previous = (await this.readRun(input.runId)).state;
      const state = structuredClone(input.state);
      state.status = previous.status;
      state.phases = previous.phases;
      state.activeTurn = previous.activeTurn;
      state.dispatches = previous.dispatches;
      await super.commitRun({ ...input, state });
      throw new RuntimeRevisionConflictError(input.runId, input.operationId);
    }
    return super.commitRun(input);
  }
}
