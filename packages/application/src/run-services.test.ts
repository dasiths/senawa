import { createRunSnapshot, loadRepositoryDefinitions } from "@senawa/configuration";
import { DefinitionArtifactSchema } from "@senawa/domain";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkerTurn } from "./ports.js";
import { RunCommandService, RunQueryService } from "./run-services.js";
import { FakeClock, FakeRunPersistence, SequenceIdentifiers } from "./testing.js";

const clock = new FakeClock(new Date("2026-08-05T12:00:00.000Z"));
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("application run use cases", () => {
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
