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
});
