import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveRunError } from "@senawa/application";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import type { WorkerProfile } from "@senawa/domain";
import type { GateEvaluator } from "@senawa/sensors";
import { createFileTestComposition } from "@senawa/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { RunCommandService, RunQueryService } from "./run-services.js";
import {
  buildCopilotArguments,
  DeterministicWorkerHost,
  type WorkerHost,
  type WorkerResult,
  type WorkerTurn,
  type WorkerTurnObservation,
} from "./worker-host.js";

const actor = { channel: "direct-cli" as const };
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;
const deterministicEvaluator: GateEvaluator = {
  async evaluate(input) {
    const accepted = input.owner.kind === "phase" || input.attempt > 1;
    return {
      gateId: input.gateId,
      accepted,
      readings: [],
      findings: accepted
        ? []
        : [
            {
              severity: "error",
              code: "seeded-refusal",
              message: "Seeded first-attempt gate refusal",
            },
          ],
    };
  },
};

function filePersistence(root: string) {
  return createFileTestComposition(root).persistence;
}

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("standard-delivery runtime", () => {
  it("runs rejection, plan import, gate rework, steering, and explicit finish", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const workerTurns: WorkerTurn[] = [];
    const deterministicHost = new DeterministicWorkerHost();
    const commands = new RunCommandService(
      store,
      {
        async execute(turn) {
          workerTurns.push(turn);
          return deterministicHost.execute(turn);
        },
      },
      deterministicEvaluator,
    );
    const queries = new RunQueryService(store);

    await commands.start({
      actor,
      definitions,
      request: { goal: "Implement the production runtime", constraints: [] },
      runId: "run-lifecycle",
    });
    const snapshotPaths = (await store.readRun("run-lifecycle")).state.snapshot.files.map(
      (file) => file.path,
    );
    expect(snapshotPaths).toContain(".agents/skills/senawa/SKILL.md");
    expect(snapshotPaths).toContain(".senawa/agents/implementor.senawa.md");
    expect(snapshotPaths.some((path) => path.startsWith(".github/agents/"))).toBe(false);
    expect(snapshotPaths.some((path) => path.startsWith(".github/hooks/"))).toBe(false);
    expect((await commands.drive("run-lifecycle", actor)).kind).toBe("awaiting-approval");
    expect((await queries.status("run-lifecycle"))?.needs?.phaseId).toBe("define");
    expect((await queries.artifact("run-lifecycle", "define"))?.version).toBe(1);

    const firstSession = (await store.readRun("run-lifecycle")).state.phases[0]?.sessionId;
    await commands.reject("run-lifecycle", "define", "Clarify the runtime boundary", actor);
    expect((await commands.resume("run-lifecycle", actor)).kind).toBe("awaiting-approval");
    expect((await queries.artifact("run-lifecycle", "define"))?.version).toBe(2);
    expect((await store.readRun("run-lifecycle")).state.phases[0]?.sessionId).toBe(firstSession);

    await commands.approve("run-lifecycle", "define", actor);
    expect((await commands.resume("run-lifecycle", actor)).phaseId).toBe("research");
    await commands.approve("run-lifecycle", "research", actor);
    expect((await commands.resume("run-lifecycle", actor)).phaseId).toBe("plan");
    await commands.approve("run-lifecycle", "plan", actor);
    expect((await store.readRun("run-lifecycle")).state.tasks.map((task) => task.key)).toEqual([
      "implement-change",
      "validate-change",
    ]);
    expect((await queries.status("run-lifecycle"))?.tasks).toEqual([
      expect.objectContaining({
        key: "implement-change",
        parentPhaseId: "implement",
        dependsOn: [],
      }),
      expect.objectContaining({
        key: "validate-change",
        parentPhaseId: "implement",
        dependsOn: ["implement-change"],
      }),
    ]);

    expect((await commands.advance("run-lifecycle", actor)).kind).toBe("task-rework");
    const firstTaskAfterRefusal = (await store.readRun("run-lifecycle")).state.tasks[0];
    expect(firstTaskAfterRefusal?.status).toBe("rework");
    await commands.steer(
      "run-lifecycle",
      "implement-change",
      "Keep the store adapter-agnostic",
      actor,
    );
    expect((await commands.advance("run-lifecycle", actor)).kind).toBe("task-closed");
    const firstTaskAfterClose = (await store.readRun("run-lifecycle")).state.tasks[0];
    expect(firstTaskAfterClose?.sessionId).toBe(firstTaskAfterRefusal?.sessionId);
    expect(firstTaskAfterClose?.attempt).toBe(2);
    const firstTaskTurns = workerTurns.filter(
      (turn) => turn.owner.kind === "task" && turn.owner.id === "implement-change",
    );
    expect(firstTaskTurns[1]?.prompt).toContain("Seeded first-attempt gate refusal");
    expect(JSON.parse(firstTaskTurns[1]?.prompt ?? "{}").gateFeedback).toMatchObject({
      gateId: "task-done",
      attempt: 1,
      maximumAttempts: 3,
      remainingAttempts: 2,
      findings: ["Seeded first-attempt gate refusal"],
      nextPrompt: "Address every failed reading and finding, then request completion again.",
    });

    expect((await commands.advance("run-lifecycle", actor)).kind).toBe("task-rework");
    expect((await commands.advance("run-lifecycle", actor)).kind).toBe("task-closed");
    expect((await commands.advance("run-lifecycle", actor)).kind).toBe("phase-accepted");
    expect((await commands.advance("run-lifecycle", actor)).phaseId).toBe("verify");
    await commands.approve("run-lifecycle", "verify", actor);
    await commands.finish("run-lifecycle", actor);

    const status = await queries.status("run-lifecycle");
    expect(status?.status).toBe("finished");
    expect(status?.progress).toEqual({ phases: "5/5 accepted", tasks: "2/2 closed" });
    expect(JSON.stringify(status).length).toBeLessThan(6_000);
    expect(await store.getActiveRunId()).toBeNull();
    expect(
      (await queries.journal("run-lifecycle")).some((event) => event.event === "task.rework"),
    ).toBe(true);
    expect(
      (await queries.output("run-lifecycle", "task", "implement-change")).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a competing run and releases the pointer only after graceful end", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const commands = new RunCommandService(
      store,
      new DeterministicWorkerHost(),
      deterministicEvaluator,
    );
    const input = {
      actor,
      definitions,
      request: { goal: "First run", constraints: [] },
      runId: "run-first",
    };
    await commands.start(input);
    await expect(commands.start({ ...input, runId: "run-contender" })).rejects.toBeInstanceOf(
      ActiveRunError,
    );

    await commands.end("run-first", "Operator ended the run", actor);
    expect(await store.getActiveRunId()).toBeNull();
    await commands.start({ ...input, runId: "run-replacement" });
    expect(await store.getActiveRunId()).toBe("run-replacement");
    expect((await store.readRun("run-first")).state.endReason).toBe("Operator ended the run");
  });

  it("fingerprints exact profile sources and dispatches the frozen snapshot", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const profilePath = ".senawa/agents/definer.senawa.md";
    const sourceDefiner = Object.values(definitions.workerProfiles).find(
      (profile) => profile.metadata.name === "definer",
    );
    if (sourceDefiner === undefined) throw new Error("Missing definer fixture");
    const mutableProfiles: Record<string, WorkerProfile> & { definer: WorkerProfile } = {
      ...structuredClone(definitions.workerProfiles),
      definer: structuredClone(sourceDefiner),
    };
    const localDefinitions = {
      ...definitions,
      workerProfiles: mutableProfiles,
      workerProfileSources: structuredClone(definitions.workerProfileSources),
    };
    const turns: WorkerTurn[] = [];
    const deterministicHost = new DeterministicWorkerHost();
    const recordingHost: WorkerHost = {
      async execute(turn): Promise<WorkerResult> {
        turns.push(turn);
        return deterministicHost.execute(turn);
      },
    };
    const firstStore = filePersistence(firstRoot);
    const firstCommands = new RunCommandService(firstStore, recordingHost, deterministicEvaluator);
    await firstCommands.start({
      actor,
      definitions: localDefinitions,
      request: { goal: "Freeze profile", constraints: [] },
      runId: "run-profile-original",
    });
    const definerProfile = mutableProfiles.definer;
    const originalPrompt = definerProfile.prompt;
    mutableProfiles.definer = { ...definerProfile, prompt: "mutated after start" };
    await firstCommands.advance("run-profile-original", actor);
    await firstCommands.reject(
      "run-profile-original",
      "define",
      "Exercise explicit session resume",
      actor,
    );
    await firstCommands.resume("run-profile-original", actor);

    const changedDefinitions = {
      ...definitions,
      workerProfileSources: {
        ...definitions.workerProfileSources,
        [profilePath]: `${definitions.workerProfileSources[profilePath]} `,
      },
    };
    const secondStore = filePersistence(secondRoot);
    await new RunCommandService(
      secondStore,
      new DeterministicWorkerHost(),
      deterministicEvaluator,
    ).start({
      actor,
      definitions: changedDefinitions,
      request: { goal: "Drift profile", constraints: [] },
      runId: "run-profile-changed",
    });

    const firstSnapshot = (await firstStore.readRun("run-profile-original")).state.snapshot;
    const secondSnapshot = (await secondStore.readRun("run-profile-changed")).state.snapshot;
    expect(firstSnapshot.fingerprint).not.toBe(secondSnapshot.fingerprint);
    expect(firstSnapshot.files.find((file) => file.path === profilePath)?.content).toBe(
      definitions.workerProfileSources[profilePath],
    );
    expect(turns[0]?.profile.prompt).toBe(originalPrompt);
    expect(turns[0]?.profileDigest).toBe(
      firstSnapshot.files.find((file) => file.path === profilePath)?.sha256,
    );
    expect(turns[0]?.operation).toBe("create");
    const firstTurnArguments = buildCopilotArguments(turns[0] as WorkerTurn);
    expect(firstTurnArguments).toContain("--session-id");
    expect(firstTurnArguments.some((argument) => argument.startsWith("--resume="))).toBe(false);
    expect(turns[1]?.operation).toBe("resume");
    expect(turns[1]?.sessionId).toBe(turns[0]?.sessionId);
    const resumedTurnArguments = buildCopilotArguments(turns[1] as WorkerTurn);
    expect(resumedTurnArguments).toContain(`--resume=${turns[0]?.sessionId}`);
    expect(resumedTurnArguments).not.toContain("--session-id");
  });

  it("rejects a dynamic plan task with an unknown role before import", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    const host: WorkerHost = {
      async execute(turn): Promise<WorkerResult> {
        if (turn.owner.id !== "plan") return deterministicHost.execute(turn);
        return {
          sessionId: turn.sessionId,
          artifact: {
            summary: "Invalid plan",
            tasks: [
              {
                key: "unknown-role",
                title: "Use an unknown role",
                dependsOn: [],
                paths: ["packages"],
                acceptance: ["Must fail closed"],
                role: "not-installed",
              },
            ],
          },
          output: [],
        };
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator);
    await commands.start({
      actor,
      definitions,
      request: { goal: "Reject unknown plan role", constraints: [] },
      runId: "run-unknown-role",
    });
    await commands.drive("run-unknown-role", actor);
    await commands.approve("run-unknown-role", "define", actor);
    await commands.resume("run-unknown-role", actor);
    await commands.approve("run-unknown-role", "research", actor);
    await commands.resume("run-unknown-role", actor);

    await expect(commands.approve("run-unknown-role", "plan", actor)).rejects.toThrow(
      "Plan task unknown-role references missing worker profile not-installed",
    );
  });

  it("does not let worker output close a gate rejected by Senawa", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    const claimingHost: WorkerHost = {
      async execute(turn) {
        const result = await deterministicHost.execute(turn);
        return {
          ...result,
          output: [...result.output, { stream: "stdout", text: "gate accepted=true" }],
        };
      },
    };
    const rejectingEvaluator: GateEvaluator = {
      async evaluate(input) {
        const accepted = input.owner.kind === "phase";
        return {
          gateId: input.gateId,
          accepted,
          readings: [
            {
              sensorId: "unit-tests",
              extension: "@senawa/sensor-command",
              result: {
                verdict: "fail",
                summary: "Unit tests failed",
                findings: [{ severity: "error", code: "command-failed", message: "Tests are red" }],
              },
              expect: { path: "/verdict", operator: "equals", value: "pass" },
              matched: false,
              advisory: false,
              durationMs: 4,
            },
          ],
          findings: accepted
            ? []
            : [{ severity: "error", code: "command-failed", message: "Tests are red" }],
        };
      },
    };
    const commands = new RunCommandService(store, claimingHost, rejectingEvaluator);
    await commands.start({
      actor,
      definitions,
      request: { goal: "Reject worker gate claims", constraints: [] },
      runId: "run-worker-claim",
    });
    await commands.drive("run-worker-claim", actor);
    await commands.approve("run-worker-claim", "define", actor);
    await commands.resume("run-worker-claim", actor);
    await commands.approve("run-worker-claim", "research", actor);
    await commands.resume("run-worker-claim", actor);
    await commands.approve("run-worker-claim", "plan", actor);

    expect((await commands.advance("run-worker-claim", actor)).kind).toBe("task-rework");
    const state = (await store.readRun("run-worker-claim")).state;
    expect(state.tasks[0]?.status).toBe("rework");
    expect(state.journal.some((event) => event.event === "sensor.started")).toBe(true);
    expect(state.journal.some((event) => event.event === "sensor.completed")).toBe(true);
    expect(
      state.journal.some(
        (event) =>
          event.event === "gate.evaluated" && Reflect.get(event.data, "accepted") === false,
      ),
    ).toBe(true);
  });

  it("rejects a phase artifact that violates its frozen output schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const host: WorkerHost = {
      async execute(turn) {
        return {
          sessionId: turn.sessionId,
          artifact: { summary: "Missing required definition fields" },
          output: [],
        };
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator);
    await commands.start({
      actor,
      definitions,
      request: { goal: "Reject invalid phase artifacts", constraints: [] },
      runId: "run-invalid-artifact",
    });

    await expect(commands.advance("run-invalid-artifact", actor)).rejects.toThrow(
      "does not match its frozen output schema",
    );
    const state = (await store.readRun("run-invalid-artifact")).state;
    expect(state.status).toBe("paused");
    expect(state.activeTurn).toBeNull();
    expect(state.artifacts).toEqual([]);
    expect(state.phases[0]?.artifactVersion).toBeNull();
  });

  it("adopts a completed unsettled phase turn without rerunning the worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    let completed: WorkerResult | undefined;
    let phaseExecutions = 0;
    const host: WorkerHost = {
      async execute(turn) {
        const result = await deterministicHost.execute(turn);
        if (turn.owner.kind === "phase") {
          phaseExecutions += 1;
          if (phaseExecutions === 1) {
            completed = result;
            throw new Error("driver crashed after phase completion");
          }
        }
        return result;
      },
      async inspect(): Promise<WorkerTurnObservation> {
        return completed === undefined
          ? { state: "unknown", detail: "fixture has no phase result" }
          : { state: "completed", result: completed };
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator);
    await commands.start({
      actor,
      definitions,
      request: { goal: "Recover a completed phase", constraints: [] },
      runId: "run-phase-recovery",
    });

    await expect(commands.advance("run-phase-recovery", actor)).rejects.toThrow(
      "driver crashed after phase completion",
    );
    expect((await commands.resume("run-phase-recovery", actor)).kind).toBe("awaiting-approval");
    const state = (await store.readRun("run-phase-recovery")).state;
    expect(phaseExecutions).toBe(1);
    expect(state.activeTurn).toBeNull();
    expect(state.phases[0]).toEqual(
      expect.objectContaining({ status: "awaiting_approval", artifactVersion: 1 }),
    );
    expect(state.dispatches.at(-1)?.status).toBe("completed");
  });

  it("adopts a completed unsettled dispatch after restart without duplicate work", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    let completed: WorkerResult | undefined;
    let taskExecutions = 0;
    let inspections = 0;
    let crashedOperationId: string | undefined;
    const executedOperationIds: string[] = [];
    const host: WorkerHost = {
      async execute(turn) {
        const result = await deterministicHost.execute(turn);
        if (turn.owner.kind === "task") {
          taskExecutions += 1;
          executedOperationIds.push(turn.operationId);
          if (taskExecutions === 1) {
            completed = result;
            crashedOperationId = turn.operationId;
            throw new Error("driver crashed after the host completed the turn");
          }
        }
        return result;
      },
      async inspect(): Promise<WorkerTurnObservation> {
        inspections += 1;
        return completed === undefined
          ? { state: "unknown", detail: "fixture has no completed result" }
          : { state: "completed", result: completed };
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator);
    await startAtTaskFrontier(commands, "run-adopt-completed");

    await expect(commands.advance("run-adopt-completed", actor)).rejects.toThrow(
      "driver crashed after the host completed the turn",
    );
    const unsettled = (await store.readRun("run-adopt-completed")).state;
    expect(unsettled.activeTurn).not.toBeNull();
    expect(unsettled.dispatches.at(-1)).toEqual(
      expect.objectContaining({ status: "intent", ownerId: "implement-change", workAttempt: 1 }),
    );

    const restartedStore = filePersistence(root);
    const restartedCommands = new RunCommandService(restartedStore, host, deterministicEvaluator);
    expect((await restartedCommands.resume("run-adopt-completed", actor)).kind).toBe(
      "awaiting-approval",
    );
    const reconciled = (await restartedStore.readRun("run-adopt-completed")).state;
    expect(inspections).toBe(1);
    expect(executedOperationIds.filter((id) => id === crashedOperationId)).toHaveLength(1);
    expect(reconciled.activeTurn).toBeNull();
    expect(reconciled.tasks[0]).toEqual(
      expect.objectContaining({ attempt: 2, dispatchFailures: 0, status: "closed" }),
    );
    expect(
      reconciled.dispatches.find((dispatch) => dispatch.operationId === crashedOperationId)?.status,
    ).toBe("completed");
  });

  it.each(["active", "unknown"] as const)(
    "does not duplicate an %s unsettled dispatch",
    async (observationState) => {
      const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
      const store = filePersistence(root);
      const deterministicHost = new DeterministicWorkerHost();
      let taskExecutions = 0;
      const host: WorkerHost = {
        async execute(turn) {
          if (turn.owner.kind === "task") {
            taskExecutions += 1;
            throw new Error("inspection required");
          }
          return deterministicHost.execute(turn);
        },
        async inspect(): Promise<WorkerTurnObservation> {
          return observationState === "active"
            ? { state: "active" }
            : { state: "unknown", detail: "host cannot prove turn state" };
        },
      };
      const runId = `run-${observationState}-dispatch`;
      const commands = new RunCommandService(store, host, deterministicEvaluator);
      await startAtTaskFrontier(commands, runId);
      await expect(commands.advance(runId, actor)).rejects.toThrow("inspection required");

      expect((await commands.resume(runId, actor)).kind).toBe("idle");
      const state = (await store.readRun(runId)).state;
      const status = await new RunQueryService(store).status(runId);
      expect(taskExecutions).toBe(1);
      expect(state.status).toBe("paused");
      expect(state.activeTurn).not.toBeNull();
      expect(state.dispatches.at(-1)?.status).toBe(observationState);
      expect(status?.unsettledDispatch).toEqual(
        expect.objectContaining({
          ownerId: "implement-change",
          status: observationState,
          operatorAction: expect.stringContaining("before resuming"),
        }),
      );
    },
  );

  it("records a cancelled unsettled dispatch without retrying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    let taskExecutions = 0;
    const host: WorkerHost = {
      async execute(turn) {
        if (turn.owner.kind === "task") {
          taskExecutions += 1;
          throw new Error("turn cancellation requires inspection");
        }
        return deterministicHost.execute(turn);
      },
      async inspect(): Promise<WorkerTurnObservation> {
        return { state: "cancelled", detail: "cancelled by the worker host" };
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator);
    await startAtTaskFrontier(commands, "run-cancelled-dispatch");
    await expect(commands.advance("run-cancelled-dispatch", actor)).rejects.toThrow(
      "turn cancellation requires inspection",
    );

    expect((await commands.resume("run-cancelled-dispatch", actor)).kind).toBe("idle");
    const state = (await store.readRun("run-cancelled-dispatch")).state;
    expect(taskExecutions).toBe(1);
    expect(state.status).toBe("paused");
    expect(state.activeTurn).toBeNull();
    expect(state.tasks[0]).toEqual(
      expect.objectContaining({ attempt: 0, dispatchFailures: 0, status: "pending" }),
    );
    expect(state.dispatches.at(-1)?.status).toBe("cancelled");
  });

  it("reissues only a recorded resume operation when inspection proves the session idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    const operationCalls = new Map<string, number>();
    let interruptedOperationId: string | undefined;
    const host: WorkerHost = {
      async execute(turn) {
        if (
          turn.owner.kind === "task" &&
          turn.owner.id === "implement-change" &&
          turn.attempt === 2
        ) {
          const calls = (operationCalls.get(turn.operationId) ?? 0) + 1;
          operationCalls.set(turn.operationId, calls);
          interruptedOperationId = turn.operationId;
          if (calls === 1) throw new Error("resume operation was not observed starting");
        }
        return deterministicHost.execute(turn);
      },
      async inspect(): Promise<WorkerTurnObservation> {
        return { state: "idle" };
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator);
    await startAtTaskFrontier(commands, "run-idle-resume");
    expect((await commands.advance("run-idle-resume", actor)).kind).toBe("task-rework");
    await expect(commands.advance("run-idle-resume", actor)).rejects.toThrow(
      "resume operation was not observed starting",
    );

    expect((await commands.resume("run-idle-resume", actor)).kind).toBe("awaiting-approval");
    expect(interruptedOperationId).toBeDefined();
    expect(operationCalls.get(interruptedOperationId as string)).toBe(2);
    const state = (await store.readRun("run-idle-resume")).state;
    const dispatch = state.dispatches.find(
      (candidate) => candidate.operationId === interruptedOperationId,
    );
    expect(dispatch).toEqual(expect.objectContaining({ operation: "resume", status: "completed" }));
  });

  it("uses a dispatch failure budget without consuming the work rework attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    const taskTurns: WorkerTurn[] = [];
    const host: WorkerHost = {
      async execute(turn) {
        if (turn.owner.kind === "task") {
          taskTurns.push(turn);
          throw new Error("session did not start");
        }
        return deterministicHost.execute(turn);
      },
      async inspect(): Promise<WorkerTurnObservation> {
        return { state: "missing" };
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator);
    await startAtTaskFrontier(commands, "run-dispatch-budget");

    await expect(commands.advance("run-dispatch-budget", actor)).rejects.toThrow(
      "session did not start",
    );
    expect((await commands.resume("run-dispatch-budget", actor)).kind).toBe("idle");
    await expect(commands.advance("run-dispatch-budget", actor)).rejects.toThrow(
      "session did not start",
    );
    expect((await commands.resume("run-dispatch-budget", actor)).kind).toBe("task-escalated");

    const state = (await store.readRun("run-dispatch-budget")).state;
    expect(state.tasks[0]).toEqual(
      expect.objectContaining({ attempt: 0, dispatchFailures: 2, status: "escalated" }),
    );
    expect(taskTurns).toHaveLength(2);
    expect(taskTurns[1]?.dispatchId).not.toBe(taskTurns[0]?.dispatchId);
    expect(taskTurns[1]?.operationId).toBe(taskTurns[0]?.operationId);
    expect(taskTurns[1]?.turnId).toBe(taskTurns[0]?.turnId);
    expect(state.journal.filter((event) => event.event === "dispatch.failed")).toHaveLength(2);
  });

  it("renews the driver lease throughout a long worker turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = filePersistence(root);
    const deterministicHost = new DeterministicWorkerHost();
    const host: WorkerHost = {
      async execute(turn) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return deterministicHost.execute(turn);
      },
    };
    const commands = new RunCommandService(store, host, deterministicEvaluator, undefined, 60);
    await commands.start({
      actor,
      definitions,
      request: { goal: "Keep the driver lease alive", constraints: [] },
      runId: "run-heartbeat",
    });

    const advancing = commands.advance("run-heartbeat", actor);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const initialHeartbeat = (await store.readRun("run-heartbeat")).state.leases.driver
      ?.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const renewedHeartbeat = (await store.readRun("run-heartbeat")).state.leases.driver
      ?.heartbeatAt;
    expect(renewedHeartbeat).not.toBe(initialHeartbeat);
    await expect(
      store.acquireLease("run-heartbeat", "driver", "driver-contender", 60),
    ).rejects.toThrow();
    expect((await advancing).kind).toBe("awaiting-approval");
  });
});

async function startAtTaskFrontier(commands: RunCommandService, runId: string): Promise<void> {
  await commands.start({
    actor,
    definitions,
    request: { goal: "Exercise dispatch recovery", constraints: [] },
    runId,
  });
  await commands.drive(runId, actor);
  await commands.approve(runId, "define", actor);
  await commands.resume(runId, actor);
  await commands.approve(runId, "research", actor);
  await commands.resume(runId, actor);
  await commands.approve(runId, "plan", actor);
}
