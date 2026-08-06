import { createRunSnapshot, loadRepositoryDefinitions } from "@senawa/configuration";
import { DefinitionArtifactSchema, type RuntimeState } from "@senawa/domain";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

  it("delivers an answer that was committed before waiting", async () => {
    const harness = await createQuestionHarness("answer-before-wait");
    const question = await harness.commands.ask(
      harness.runId,
      "Which boundary?",
      harness.workerActor,
    );
    await harness.commands.answer(
      harness.runId,
      question.questionId,
      "Keep it in application queries.",
      { channel: "direct-cli" },
    );

    await expect(
      harness.queries.waitForQuestionAnswer(
        harness.runId,
        question.questionId,
        harness.expectedTurn,
      ),
    ).resolves.toBe("Keep it in application queries.");
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it("ignores unrelated answers until the matching question is answered", async () => {
    const harness = await createQuestionHarness("correlated-answer");
    const first = await harness.commands.ask(harness.runId, "First?", harness.workerActor);
    const second = await harness.commands.ask(harness.runId, "Second?", harness.workerActor);
    await harness.commands.answer(harness.runId, second.questionId, "Second answer", {
      channel: "direct-cli",
    });
    let settled = false;
    const waiting = harness.queries
      .waitForQuestionAnswer(harness.runId, first.questionId, harness.expectedTurn)
      .finally(() => {
        settled = true;
      });

    await flushMicrotasks();
    await harness.scheduler.tick();
    expect(settled).toBe(false);

    await harness.commands.answer(harness.runId, first.questionId, "First answer", {
      channel: "direct-cli",
    });
    await harness.scheduler.tick();
    await expect(waiting).resolves.toBe("First answer");
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it("cancels a pending answer wait and releases its poller", async () => {
    const harness = await createQuestionHarness("cancel-answer-wait");
    const question = await harness.commands.ask(harness.runId, "Continue?", harness.workerActor);
    const controller = new AbortController();
    const waiting = harness.queries.waitForQuestionAnswer(
      harness.runId,
      question.questionId,
      harness.expectedTurn,
      { signal: controller.signal },
    );
    const rejection = expect(waiting).rejects.toThrow("was cancelled");

    await flushMicrotasks();
    controller.abort();

    await rejection;
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it("times out a pending answer wait and releases its poller", async () => {
    const harness = await createQuestionHarness("timeout-answer-wait");
    const question = await harness.commands.ask(harness.runId, "Continue?", harness.workerActor);
    vi.spyOn(harness.persistence, "readRun").mockImplementation(() => new Promise(() => undefined));
    const waiting = harness.queries.waitForQuestionAnswer(
      harness.runId,
      question.questionId,
      harness.expectedTurn,
      { timeoutMs: 100 },
    );
    const rejection = expect(waiting).rejects.toThrow("Timed out waiting for answer");

    await flushMicrotasks();
    harness.clock.set(new Date(harness.clock.now().getTime() + 100));
    await harness.scheduler.tick();

    await rejection;
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it("rejects a pending answer when the active turn is replaced", async () => {
    const harness = await createQuestionHarness("stale-answer-turn");
    const question = await harness.commands.ask(harness.runId, "Continue?", harness.workerActor);
    const waiting = harness.queries.waitForQuestionAnswer(
      harness.runId,
      question.questionId,
      harness.expectedTurn,
    );
    const rejection = expect(waiting).rejects.toThrow("is no longer active");
    await flushMicrotasks();
    await updateRuntime(harness.persistence, harness.runId, (state) => {
      if (state.activeTurn === null) throw new Error("Expected an active turn");
      state.activeTurn = { ...state.activeTurn, turnId: "replacement-turn" };
    });

    await harness.scheduler.tick();

    await rejection;
    expect(harness.scheduler.activeCount).toBe(0);
  });

  it("rejects a pending answer when the run becomes terminal", async () => {
    const harness = await createQuestionHarness("terminal-answer-turn");
    const question = await harness.commands.ask(harness.runId, "Continue?", harness.workerActor);
    const waiting = harness.queries.waitForQuestionAnswer(
      harness.runId,
      question.questionId,
      harness.expectedTurn,
    );
    const rejection = expect(waiting).rejects.toThrow("is no longer active");
    await flushMicrotasks();
    await updateRuntime(harness.persistence, harness.runId, (state) => {
      state.status = "ended";
      state.endReason = "operator ended the run";
      state.activeTurn = null;
    });

    await harness.scheduler.tick();

    await rejection;
    expect(harness.scheduler.activeCount).toBe(0);
  });
});

async function createQuestionHarness(runId: string) {
  const persistence = new FakeRunPersistence();
  const localClock = new FakeClock(new Date("2026-08-06T12:00:00.000Z"));
  const scheduler = new ManualScheduler();
  const identifiers = new SequenceIdentifiers("question-wait");
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
    localClock,
    identifiers,
    scheduler,
  );
  await commands.start({
    actor: { channel: "direct-cli" },
    request: { goal: "Wait for a durable human answer", constraints: [] },
    runId,
    snapshot: createRunSnapshot(runId, definitions, localClock.now()),
  });
  const expectedTurn = { sessionId: "question-session", turnId: "question-turn" };
  await updateRuntime(persistence, runId, (state) => {
    state.activeTurn = {
      ownerKind: "phase",
      ownerId: "define",
      sessionId: expectedTurn.sessionId,
      attempt: 1,
      turnId: expectedTurn.turnId,
      dispatchId: "question-dispatch",
      operationId: "question-operation",
      operation: "create",
    };
  });
  return {
    runId,
    persistence,
    commands,
    queries: new RunQueryService(persistence, undefined, undefined, localClock, scheduler),
    scheduler,
    clock: localClock,
    expectedTurn,
    workerActor: { channel: "worker" as const, sessionId: expectedTurn.sessionId },
  };
}

async function updateRuntime(
  persistence: FakeRunPersistence,
  runId: string,
  update: (state: RuntimeState) => void,
): Promise<void> {
  const current = await persistence.readRun(runId);
  update(current.state);
  await persistence.commitRun({
    runId,
    expectedRevision: current.revision,
    operationId: `test-update-${current.revision}`,
    state: current.state,
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

class ManualScheduler {
  private readonly tasks = new Set<() => void>();

  get activeCount(): number {
    return this.tasks.size;
  }

  scheduleEvery(_intervalMs: number, task: () => void): () => void {
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  }

  async tick(): Promise<void> {
    for (const task of [...this.tasks]) task();
    await flushMicrotasks();
  }
}

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
