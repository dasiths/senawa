import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepositoryDefinitions, type WorkerProfile } from "@senawa/core";
import { ActiveRunError, FileRuntimeStore } from "@senawa/graph";
import type { GateEvaluator } from "@senawa/sensors";
import { beforeAll, describe, expect, it } from "vitest";
import { RunCommandService, RunQueryService } from "./run-services.js";
import {
  DeterministicWorkerHost,
  type WorkerHost,
  type WorkerResult,
  type WorkerTurn,
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

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("standard-delivery runtime", () => {
  it("runs rejection, plan import, gate rework, steering, and explicit finish", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = new FileRuntimeStore(root);
    const commands = new RunCommandService(
      store,
      new DeterministicWorkerHost(),
      deterministicEvaluator,
    );
    const queries = new RunQueryService(store);

    await commands.start({
      actor,
      definitions,
      request: { goal: "Implement the production runtime", constraints: [] },
      runId: "run-lifecycle",
    });
    const snapshotPaths = (await store.readRun("run-lifecycle")).snapshot.files.map(
      (file) => file.path,
    );
    expect(snapshotPaths).toContain(".agents/skills/senawa/SKILL.md");
    expect(snapshotPaths).toContain(".senawa/agents/implementor.senawa.md");
    expect(snapshotPaths.some((path) => path.startsWith(".github/agents/"))).toBe(false);
    expect(snapshotPaths.some((path) => path.startsWith(".github/hooks/"))).toBe(false);
    expect((await commands.drive("run-lifecycle", actor)).kind).toBe("awaiting-approval");
    expect((await queries.status("run-lifecycle"))?.needs?.phaseId).toBe("define");
    expect((await queries.artifact("run-lifecycle", "define"))?.version).toBe(1);

    const firstSession = (await store.readRun("run-lifecycle")).phases[0]?.sessionId;
    await commands.reject("run-lifecycle", "define", "Clarify the runtime boundary", actor);
    expect((await commands.resume("run-lifecycle", actor)).kind).toBe("awaiting-approval");
    expect((await queries.artifact("run-lifecycle", "define"))?.version).toBe(2);
    expect((await store.readRun("run-lifecycle")).phases[0]?.sessionId).toBe(firstSession);

    await commands.approve("run-lifecycle", "define", actor);
    expect((await commands.resume("run-lifecycle", actor)).phaseId).toBe("research");
    await commands.approve("run-lifecycle", "research", actor);
    expect((await commands.resume("run-lifecycle", actor)).phaseId).toBe("plan");
    await commands.approve("run-lifecycle", "plan", actor);
    expect((await store.readRun("run-lifecycle")).tasks.map((task) => task.key)).toEqual([
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
    const firstTaskAfterRefusal = (await store.readRun("run-lifecycle")).tasks[0];
    expect(firstTaskAfterRefusal?.status).toBe("rework");
    await commands.steer(
      "run-lifecycle",
      "implement-change",
      "Keep the store adapter-agnostic",
      actor,
    );
    expect((await commands.advance("run-lifecycle", actor)).kind).toBe("task-closed");
    const firstTaskAfterClose = (await store.readRun("run-lifecycle")).tasks[0];
    expect(firstTaskAfterClose?.sessionId).toBe(firstTaskAfterRefusal?.sessionId);
    expect(firstTaskAfterClose?.attempt).toBe(2);

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
    const store = new FileRuntimeStore(root);
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
    expect((await store.readRun("run-first")).endReason).toBe("Operator ended the run");
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
    const recordingHost: WorkerHost = {
      async execute(turn): Promise<WorkerResult> {
        turns.push(turn);
        return {
          sessionId: turn.sessionId ?? "recorded-session",
          artifact: { summary: "recorded" },
          output: [],
        };
      },
    };
    const firstStore = new FileRuntimeStore(firstRoot);
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

    const changedDefinitions = {
      ...definitions,
      workerProfileSources: {
        ...definitions.workerProfileSources,
        [profilePath]: `${definitions.workerProfileSources[profilePath]} `,
      },
    };
    const secondStore = new FileRuntimeStore(secondRoot);
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

    const firstSnapshot = (await firstStore.readRun("run-profile-original")).snapshot;
    const secondSnapshot = (await secondStore.readRun("run-profile-changed")).snapshot;
    expect(firstSnapshot.fingerprint).not.toBe(secondSnapshot.fingerprint);
    expect(firstSnapshot.files.find((file) => file.path === profilePath)?.content).toBe(
      definitions.workerProfileSources[profilePath],
    );
    expect(turns[0]?.profile.prompt).toBe(originalPrompt);
    expect(turns[0]?.profileDigest).toBe(
      firstSnapshot.files.find((file) => file.path === profilePath)?.sha256,
    );
  });

  it("rejects a dynamic plan task with an unknown role before import", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-runtime-"));
    const store = new FileRuntimeStore(root);
    const host: WorkerHost = {
      async execute(turn): Promise<WorkerResult> {
        return {
          sessionId: turn.sessionId ?? "unknown-role-session",
          artifact:
            turn.owner.id === "plan"
              ? {
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
                }
              : { summary: "phase artifact" },
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
    const store = new FileRuntimeStore(root);
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
    const state = await store.readRun("run-worker-claim");
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
});
