import { createRunSnapshot, loadRepositoryDefinitions } from "@senawa/configuration";
import {
  DefinitionArtifactSchema,
  JsonObjectSchema,
  PlanArtifactSchema,
  ResearchArtifactSchema,
  type ResolvedInputManifest,
  type RuntimeState,
  VerificationArtifactSchema,
} from "@senawa/domain";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { artifactDigest, resolvePhaseInputManifest } from "./input-manifests.js";
import { RuntimeRevisionConflictError, type WorkerTurn } from "./ports.js";
import { projectPhaseBrief, projectRunStatus } from "./projections.js";
import { RunCommandService, RunQueryService } from "./run-services.js";
import { FakeClock, FakeRunPersistence, SequenceIdentifiers } from "./testing.js";

const clock = new FakeClock(new Date("2026-08-05T12:00:00.000Z"));
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("application run use cases", () => {
  it("projects a bounded deterministic artifact overview without a recommendation", () => {
    const snapshot = createRunSnapshot("brief-run", definitions, clock.now());
    const state: RuntimeState = {
      apiVersion: "senawa.dev/runtime/v1",
      identity: {
        runId: snapshot.runId,
        backend: "file",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Project an artifact overview", constraints: [] },
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
      phases: snapshot.workflow.spec.phases.map((candidate) => ({
        id: candidate.id,
        status: "pending",
        iteration: 0,
        artifactVersion: null,
        sessionId: null,
        rejectionReason: null,
      })),
      tasks: [],
      artifacts: [],
      journal: [],
      outputs: {},
      activeTurn: null,
      dispatches: [],
      leases: { driver: null, web: null },
    };
    const phase = state.phases.find((candidate) => candidate.id === "plan");
    if (phase === undefined) throw new Error("standard fixture is missing plan phase");
    phase.status = "awaiting_approval";
    phase.iteration = 1;
    phase.artifactVersion = 2;
    state.status = "awaiting_approval";
    state.artifacts.push({
      phaseId: "plan",
      version: 2,
      path: "artifacts/plan/v2.json",
      createdAt: "2026-08-05T12:00:00.000Z",
      content: {
        summary: "s".repeat(700),
        tasks: [
          {
            key: "required-task",
            title: "Required task",
            dependsOn: [],
            paths: ["packages/application"],
            repositoryChange: "required",
            acceptance: ["Pass"],
            role: "implementor",
          },
          {
            key: "forbidden-task",
            title: "Forbidden task",
            dependsOn: [],
            paths: ["docs"],
            repositoryChange: "forbidden",
            acceptance: ["Pass"],
            role: "implementor",
          },
        ],
      },
      consumed: [],
    });

    const first = projectPhaseBrief(state, "plan");
    const second = projectPhaseBrief(structuredClone(state), "plan");

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      runId: "brief-run",
      phase: "plan",
      status: "awaiting_approval",
      needs: { action: "approve-or-reject", artifact: "artifacts/plan/v2.json" },
      artifact: {
        path: "artifacts/plan/v2.json",
        version: 2,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        kind: "../schemas/plan.schema.json",
        createdAt: "2026-08-05T12:00:00.000Z",
        declared: {
          summary: { value: `${"s".repeat(497)}...`, attribution: "artifact-declared" },
        },
        counts: [
          { name: "tasks", count: 2 },
          { name: "tasks.repositoryChange.required", count: 1 },
          { name: "tasks.repositoryChange.optional", count: 0 },
          { name: "tasks.repositoryChange.forbidden", count: 1 },
        ],
        fullArtifactCommand: "senawa phase artifact plan --run brief-run --version 2",
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/recommend|approve this|reject this/iu);
  });

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
          repositoryChange: "required",
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
      workerHost: {
        kind: "simulated",
        adapter: "simulated-worker",
        adapterVersion: "1",
        legacy: false,
      },
    });
    expect((await commands.drive(runId, { channel: "driver" })).kind).toBe("awaiting-approval");
    expect(turns).toHaveLength(1);
    expect((await queries.status(runId))?.needs?.phaseId).toBe("define");
    const artifact = await queries.artifact(runId, "define");
    expect(artifact).toMatchObject({ version: 1 });
    await expect(
      commands.approve(runId, "define", { channel: "direct-cli" }, undefined, undefined, {
        expectedVersion: 2,
      }),
    ).rejects.toThrow(
      /currently awaiting artifacts\/define\/v1.json version 1 digest [0-9a-f]{64}/u,
    );
    await expect(
      commands.reject(runId, "define", "Stale digest", { channel: "direct-cli" }, undefined, {
        expectedDigest: "0".repeat(64),
      }),
    ).rejects.toThrow("Stale decision for phase define");
    if (artifact === null) throw new Error("definition artifact is missing");
    await commands.approve(runId, "define", { channel: "direct-cli" }, undefined, undefined, {
      expectedVersion: artifact.version,
      expectedDigest: artifactDigest(artifact.content),
    });
    expect(await queries.report(runId)).toBe(`report:${runId}`);
    expect(persistence.snapshots.has(runId)).toBe(true);
    expect(persistence.operations.length).toBeGreaterThan(4);
  });

  it("does not let principal-agent attribution satisfy human-direct approval", async () => {
    const persistence = new FakeRunPersistence();
    const commands = new RunCommandService(
      persistence,
      { execute: async () => ({ sessionId: "unused", output: [] }) },
      {
        evaluate: async (input) => ({
          gateId: input.gateId,
          accepted: true,
          readings: [],
          findings: [],
        }),
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("authority"),
      { scheduleEvery: () => () => undefined },
    );
    const directDefinitions = structuredClone(definitions);
    const define = directDefinitions.workflow.spec.phases.find((phase) => phase.id === "define");
    if (define?.exit === undefined) throw new Error("standard fixture is missing define approval");
    define.exit.approval = "human-direct";
    const runId = "human-direct-run";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Test direct authority", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, directDefinitions, clock.now()),
    });
    const current = await persistence.readRun(runId);
    const awaiting = structuredClone(current.state);
    awaiting.status = "awaiting_approval";
    const phase = awaiting.phases.find((candidate) => candidate.id === "define");
    if (phase === undefined) throw new Error("runtime is missing define phase");
    phase.status = "awaiting_approval";
    phase.artifactVersion = 1;
    awaiting.artifacts.push({
      phaseId: "define",
      version: 1,
      path: "artifacts/define/v1.json",
      createdAt: clock.now().toISOString(),
      content: {
        summary: "Authority fixture",
        inScope: ["application"],
        outOfScope: [],
        acceptanceCriteria: ["Human-direct authority is enforced"],
        constraints: [],
        openQuestions: [],
      },
      consumed: [],
    });
    await persistence.commitRun({
      runId,
      expectedRevision: current.revision,
      operationId: "await-direct",
      state: awaiting,
    });

    await expect(commands.approve(runId, "define", { channel: "principal-agent" })).rejects.toThrow(
      "requires human-direct approval",
    );
    await expect(
      commands.approve(runId, "define", { channel: "direct-cli" }),
    ).resolves.toMatchObject({ kind: "phase-accepted" });
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
    expect(persistence.workerEvents[0]?.workerHost).toEqual({
      kind: "simulated",
      adapter: "simulated-worker",
      adapterVersion: "1",
      legacy: false,
    });
    expect(persistence.workerEvents[0]?.configuredModel).toEqual({
      id: "claude-opus-5",
    });
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

  it("persists exact phase inputs before dispatch and reuses them during recovery", async () => {
    const persistence = new FakeRunPersistence();
    const prompts: string[] = [];
    const artifact = ResearchArtifactSchema.parse({
      summary: "Recovered research",
      findings: [{ claim: "The manifest is durable", source: "dispatch", evidenceKind: "offline" }],
      constraints: [],
      recommendations: [],
    });
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn, onEvent) {
          prompts.push(turn.prompt);
          const persisted = (await persistence.readRun(turn.runId)).state.dispatches.find(
            (dispatch) => dispatch.dispatchId === turn.dispatchId,
          );
          expect(persisted?.inputManifest?.inputs).toHaveLength(1);
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
          throw new Error("driver exited after research completion");
        },
        async inspect(turn) {
          prompts.push(turn.prompt);
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
      new SequenceIdentifiers("input-recovery"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "input-manifest-recovery";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Recover exact inputs", constraints: ["Keep references exact"] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const current = await persistence.readRun(runId);
    const define = current.state.phases.find((phase) => phase.id === "define");
    if (define === undefined) throw new Error("standard fixture is missing define");
    define.status = "accepted";
    define.iteration = 1;
    define.artifactVersion = 1;
    current.state.artifacts.push({
      phaseId: "define",
      version: 1,
      path: "artifacts/define/v1.json",
      createdAt: clock.now().toISOString(),
      content: {
        summary: "Accepted definition",
        inScope: ["packages/application"],
        outOfScope: [],
        acceptanceCriteria: ["Inputs are exact"],
        constraints: [],
        openQuestions: [],
      },
      consumed: [],
    });
    await persistence.commitRun({
      runId,
      expectedRevision: current.revision,
      operationId: "seed-definition",
      state: current.state,
    });

    await expect(commands.drive(runId, { channel: "driver" })).rejects.toThrow(
      "driver exited after research completion",
    );
    await expect(commands.resume(runId, { channel: "driver" })).resolves.toMatchObject({
      kind: "awaiting-approval",
      phaseId: "research",
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    const recovered = (await persistence.readRun(runId)).state;
    const research = recovered.artifacts.find((candidate) => candidate.phaseId === "research");
    expect(research?.consumed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "definition",
          ownerId: "define",
          path: "artifacts/define/v1.json",
          version: 1,
        }),
      ]),
    );
  });

  it("supplies and persists the verifier's exact current evidence references", async () => {
    const persistence = new FakeRunPersistence();
    let evaluatedManifest: ResolvedInputManifest | undefined;
    const runId = "verification-provenance";
    const verification = JsonObjectSchema.parse(
      VerificationArtifactSchema.parse({
        verdict: "pass",
        summary: "Current evidence passed",
        checks: [{ name: "task evidence", verdict: "pass", summary: "Task evidence is current" }],
        findings: [],
      }),
    );
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn) {
          expect(turn.owner).toEqual({ kind: "phase", id: "verify" });
          return { sessionId: turn.sessionId, artifact: verification, output: [] };
        },
      },
      {
        async evaluate(input) {
          if (input.owner.id === "verify") evaluatedManifest = input.inputManifest;
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("verification-provenance"),
      { scheduleEvery: () => () => undefined },
    );
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Persist verifier evidence", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const current = await persistence.readRun(runId);
    for (const phase of current.state.phases) {
      if (phase.id === "verify") continue;
      phase.status = "accepted";
      phase.iteration = 1;
      phase.artifactVersion = ["define", "research", "plan"].includes(phase.id) ? 1 : null;
    }
    current.state.artifacts.push(
      ...["define", "research", "plan"].map((phaseId) => ({
        phaseId,
        version: 1,
        path: `artifacts/${phaseId}/v1.json`,
        createdAt: clock.now().toISOString(),
        content: { summary: `${phaseId} evidence` },
        consumed: [],
      })),
    );
    current.state.tasks.push({
      key: "implemented",
      title: "Implemented current change",
      dependsOn: [],
      paths: ["packages/application"],
      repositoryChange: "required",
      acceptance: ["Current change is implemented"],
      role: "implementor",
      status: "closed",
      attempt: 1,
      dispatchFailures: 0,
      sessionId: "task-session",
      steering: [],
    });
    const evidencePath = "evidence/repository/tasks/implemented/attempt-1/task-dispatch/delta.json";
    current.state.dispatches.push({
      dispatchId: "task-dispatch",
      operationId: "task-operation",
      turnId: "task-turn",
      sessionId: "task-session",
      ownerKind: "task",
      ownerId: "implemented",
      operation: "create",
      workAttempt: 1,
      dispatchFailure: 0,
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
      status: "completed",
      repositoryDelta: {
        version: 1,
        kind: "repository-delta",
        runId,
        taskId: "implemented",
        attempt: 1,
        dispatchId: "task-dispatch",
        turnId: "task-turn",
        expectation: "required",
        baselineDigest: "b".repeat(64),
        headBefore: "head",
        headAfter: "head",
        preExistingChanges: [],
        changedPaths: [
          {
            path: "packages/application/src/run-services.ts",
            status: " M",
            digest: "c".repeat(64),
          },
        ],
        inScopeChanges: ["packages/application/src/run-services.ts"],
        outOfScopeChanges: [],
        frozenChanges: [],
        uncertainty: [],
        workerClaim: { reported: true, changed: true, agreement: "agree" },
        capturedAt: clock.now().toISOString(),
        digest: "d".repeat(64),
        evidencePath,
      },
    });
    current.state.journal.push(
      {
        apiVersion: "senawa.dev/event/v1",
        seq: 1,
        ts: clock.now().toISOString(),
        runId,
        event: "sensor.completed",
        actor: { channel: "driver" },
        data: {
          gateId: "task-done",
          sensorId: "task-change",
          ownerKind: "task",
          ownerId: "implemented",
          attempt: 1,
          verdict: "pass",
          matched: true,
          advisory: false,
          summary: "Current task change passed",
          evidencePaths: [evidencePath],
        },
      },
      {
        apiVersion: "senawa.dev/event/v1",
        seq: 2,
        ts: clock.now().toISOString(),
        runId,
        event: "gate.evaluated",
        actor: { channel: "driver" },
        data: {
          gateId: "task-done",
          ownerKind: "task",
          ownerId: "implemented",
          attempt: 1,
          accepted: true,
          findings: [],
          readings: [],
        },
      },
    );
    await persistence.commitRun({
      runId,
      expectedRevision: current.revision,
      operationId: "seed-verification-evidence",
      state: current.state,
    });

    await expect(commands.drive(runId, { channel: "driver" })).resolves.toMatchObject({
      kind: "awaiting-approval",
      phaseId: "verify",
    });

    expect(evaluatedManifest?.inputs.map((input) => input.ownerId)).toEqual([
      "define",
      "research",
      "plan",
      "implementation",
    ]);
    expect(evaluatedManifest?.inputs.at(-1)).toMatchObject({
      schemaKind: "senawa.dev/verification-manifest/v1",
      summary: { blockingIssueCount: 0 },
    });
    const persisted = (await persistence.readRun(runId)).state;
    const verifierDispatch = persisted.dispatches.find(
      (dispatch) => dispatch.ownerKind === "phase" && dispatch.ownerId === "verify",
    );
    const artifact = persisted.artifacts.find((candidate) => candidate.phaseId === "verify");
    expect(verifierDispatch?.inputManifest).toEqual(evaluatedManifest);
    expect(artifact?.consumed).toEqual(evaluatedManifest?.inputs);
  });

  it("imports tasks with exact source plan identity and inherited accepted evidence", async () => {
    const persistence = new FakeRunPersistence();
    let taskPrompt: Record<string, unknown> | undefined;
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn) {
          if (turn.owner.kind === "task") taskPrompt = JSON.parse(turn.prompt);
          return { sessionId: turn.sessionId, output: [] };
        },
      },
      {
        evaluate: async (input) => ({
          gateId: input.gateId,
          accepted: true,
          readings: [],
          findings: [],
        }),
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("plan-provenance"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "plan-source-provenance";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Import exact task evidence", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const current = await persistence.readRun(runId);
    for (const phaseId of ["define", "research"] as const) {
      const phase = current.state.phases.find((candidate) => candidate.id === phaseId);
      if (phase === undefined) throw new Error(`standard fixture is missing ${phaseId}`);
      phase.status = "accepted";
      phase.iteration = 1;
      phase.artifactVersion = 1;
      current.state.artifacts.push({
        phaseId,
        version: 1,
        path: `artifacts/${phaseId}/v1.json`,
        createdAt: clock.now().toISOString(),
        content: { summary: `${phaseId} evidence` },
        consumed: [],
      });
    }
    const planPhase = current.state.phases.find((phase) => phase.id === "plan");
    if (planPhase === undefined) throw new Error("standard fixture is missing plan");
    planPhase.status = "awaiting_approval";
    planPhase.iteration = 1;
    planPhase.artifactVersion = 1;
    current.state.status = "awaiting_approval";
    const planContent = PlanArtifactSchema.parse({
      summary: "Exact task plan",
      tasks: [
        {
          key: "exact-task",
          title: "Implement exact provenance",
          dependsOn: [],
          paths: ["packages/application"],
          acceptance: ["Task provenance is durable"],
          role: "implementor",
        },
      ],
    });
    const planArtifactContent = JsonObjectSchema.parse(planContent);
    const planInputs = resolvePhaseInputManifest(current.state, planPhase);
    current.state.artifacts.push({
      phaseId: "plan",
      version: 1,
      path: "artifacts/plan/v1.json",
      createdAt: clock.now().toISOString(),
      content: planArtifactContent,
      consumed: planInputs.inputs,
    });
    await persistence.commitRun({
      runId,
      expectedRevision: current.revision,
      operationId: "seed-plan-approval",
      state: current.state,
    });

    await commands.approve(runId, "plan", { channel: "direct-cli" });

    const imported = (await persistence.readRun(runId)).state.tasks[0];
    expect(imported?.sourcePlan).toEqual({
      phaseId: "plan",
      path: "artifacts/plan/v1.json",
      version: 1,
      digest: artifactDigest(planArtifactContent),
    });
    expect(imported?.inheritedInputs?.map((input) => input.name)).toEqual([
      "definition",
      "research",
    ]);
    await commands.advance(runId, { channel: "driver" });
    expect(taskPrompt).toMatchObject({
      task: "exact-task",
      title: "Implement exact provenance",
      goal: "Import exact task evidence",
      constraints: [],
      sourcePlan: {
        phaseId: "plan",
        path: "artifacts/plan/v1.json",
        version: 1,
      },
      inputManifest: {
        inputs: [
          expect.objectContaining({ name: "source-plan", ownerId: "plan" }),
          expect.objectContaining({ name: "definition", ownerId: "define" }),
          expect.objectContaining({ name: "research", ownerId: "research" }),
        ],
      },
      dependencyOutcomes: [],
    });
  });

  it("persists repository baseline before execution and delta before task gates", async () => {
    const persistence = new FakeRunPersistence();
    const order: string[] = [];
    const runId = "task-repository-evidence";
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn, onEvent) {
          const dispatch = (await persistence.readRun(runId)).state.dispatches.find(
            (candidate) => candidate.dispatchId === turn.dispatchId,
          );
          expect(dispatch?.repositoryBaseline?.digest).toBe("b".repeat(64));
          order.push("execute");
          await onEvent?.({
            apiVersion: "senawa.dev/worker-event/v1",
            eventId: "worker-diff",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            ts: clock.now().toISOString(),
            traceId: turn.traceId,
            kind: "diff",
            changed: false,
            patch: "",
          });
          return { sessionId: turn.sessionId, output: [] };
        },
      },
      {
        async evaluate(input) {
          if (input.owner.kind === "task") {
            const dispatch = (await persistence.readRun(runId)).state.dispatches.find(
              (candidate) => candidate.ownerId === input.owner.id,
            );
            expect(dispatch?.repositoryDelta?.digest).toBe("d".repeat(64));
            expect(input.repositoryEvidence?.workerClaim.agreement).toBe("disagree");
            order.push("gate");
          }
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("repository-evidence"),
      { scheduleEvery: () => () => undefined },
      30_000,
      "file",
      {
        kind: "simulated",
        adapter: "simulated-worker",
        adapterVersion: "1",
        legacy: false,
      },
      {
        async captureBaseline(input) {
          order.push("baseline");
          return {
            version: 1,
            kind: "repository-baseline",
            ...input,
            head: "head",
            entries: [],
            uncertainty: [],
            digest: "b".repeat(64),
            evidencePath: "evidence/repository/baseline.json",
          };
        },
        async captureDelta(input) {
          order.push("delta");
          expect(input.workerClaim).toMatchObject({ reported: true, changed: false });
          return {
            version: 1,
            kind: "repository-delta",
            runId: input.baseline.runId,
            taskId: input.baseline.taskId,
            attempt: input.baseline.attempt,
            dispatchId: input.baseline.dispatchId,
            turnId: input.baseline.turnId,
            expectation: input.baseline.expectation,
            baselineDigest: input.baseline.digest,
            headBefore: input.baseline.head,
            headAfter: input.baseline.head,
            preExistingChanges: [],
            changedPaths: [
              { path: "packages/application/src/run.ts", status: " M", digest: "c".repeat(64) },
            ],
            inScopeChanges: ["packages/application/src/run.ts"],
            outOfScopeChanges: [],
            frozenChanges: [],
            uncertainty: [],
            workerClaim: { reported: true, changed: false, agreement: "disagree" },
            capturedAt: input.capturedAt,
            digest: "d".repeat(64),
            evidencePath: "evidence/repository/delta.json",
          };
        },
      },
    );
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Measure task changes", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const current = await persistence.readRun(runId);
    for (const phase of current.state.phases) {
      phase.status =
        phase.id === "implement" ? "pending" : phase.id === "verify" ? "ended" : "accepted";
    }
    current.state.tasks = [
      {
        key: "measured-task",
        title: "Measure task",
        dependsOn: [],
        paths: ["packages/application"],
        repositoryChange: "required",
        acceptance: ["Measured"],
        role: "implementor",
        status: "pending",
        attempt: 0,
        dispatchFailures: 0,
        sessionId: null,
        steering: [],
      },
    ];
    await persistence.commitRun({
      runId,
      expectedRevision: current.revision,
      operationId: "seed-task-frontier",
      state: current.state,
    });

    await expect(commands.advance(runId, { channel: "driver" })).resolves.toMatchObject({
      kind: "task-closed",
    });
    expect(order).toEqual(["baseline", "execute", "delta", "gate"]);
  });

  it("does not let a plan weaken the standard required-change frontier", async () => {
    const persistence = new FakeRunPersistence();
    const commands = new RunCommandService(
      persistence,
      { execute: async (turn) => ({ sessionId: turn.sessionId, output: [] }) },
      {
        evaluate: async (input) => ({
          gateId: input.gateId,
          accepted: true,
          readings: [],
          findings: [],
        }),
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("frontier-policy"),
      { scheduleEvery: () => () => undefined },
    );
    const runId = "frontier-policy";
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Keep required changes required", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });

    await expect(
      commands.revisePlan(
        runId,
        {
          summary: "Try to weaken change evidence",
          tasks: [
            {
              key: "weakened-task",
              title: "Weakened task",
              dependsOn: [],
              paths: ["packages/application"],
              repositoryChange: "optional",
              acceptance: ["No evidence required"],
              role: "implementor",
            },
          ],
        },
        { channel: "direct-cli" },
      ),
    ).rejects.toThrow("repositoryChange optional");
  });

  it("preserves one repository attribution across interrupted task recovery", async () => {
    const persistence = new FakeRunPersistence();
    let baselineCaptures = 0;
    let deltaCaptures = 0;
    const runId = "task-evidence-recovery";
    const commands = new RunCommandService(
      persistence,
      {
        async execute(turn, onEvent) {
          await onEvent?.({
            apiVersion: "senawa.dev/worker-event/v1",
            eventId: "recovered-diff",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            ts: clock.now().toISOString(),
            traceId: turn.traceId,
            kind: "diff",
            changed: true,
            patch: "measured later",
          });
          await onEvent?.({
            apiVersion: "senawa.dev/worker-event/v1",
            eventId: "recovered-completed",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            ts: clock.now().toISOString(),
            traceId: turn.traceId,
            kind: "lifecycle",
            event: "completed",
            durationMs: 1,
          });
          throw new Error("driver interrupted after worker completion");
        },
        async inspect() {
          return { state: "missing" as const };
        },
      },
      {
        async evaluate(input) {
          expect(input.repositoryEvidence?.uncertainty).toEqual(["delta-captured-during-recovery"]);
          return {
            gateId: input.gateId,
            accepted: false,
            readings: [],
            findings: [
              {
                severity: "error",
                code: "task-change-uncertain",
                message: "Recovery attribution requires rework",
              },
            ],
          };
        },
      },
      { validatePhaseArtifact: () => undefined },
      clock,
      new SequenceIdentifiers("task-evidence-recovery"),
      { scheduleEvery: () => () => undefined },
      30_000,
      "file",
      {
        kind: "simulated",
        adapter: "simulated-worker",
        adapterVersion: "1",
        legacy: false,
      },
      {
        async captureBaseline(input) {
          baselineCaptures += 1;
          return {
            version: 1,
            kind: "repository-baseline",
            runId: input.runId,
            taskId: input.taskId,
            attempt: input.attempt,
            dispatchId: input.dispatchId,
            turnId: input.turnId,
            expectation: input.expectation,
            authorizedPaths: input.authorizedPaths,
            frozenPaths: input.frozenPaths,
            head: "head",
            entries: [],
            capturedAt: input.capturedAt,
            uncertainty: [],
            digest: "e".repeat(64),
            evidencePath: "evidence/repository/recovery-baseline.json",
          };
        },
        async captureDelta(input) {
          deltaCaptures += 1;
          expect(input.recovered).toBe(true);
          return {
            version: 1,
            kind: "repository-delta",
            runId: input.baseline.runId,
            taskId: input.baseline.taskId,
            attempt: input.baseline.attempt,
            dispatchId: input.baseline.dispatchId,
            turnId: input.baseline.turnId,
            expectation: input.baseline.expectation,
            baselineDigest: input.baseline.digest,
            headBefore: input.baseline.head,
            headAfter: input.baseline.head,
            preExistingChanges: [],
            changedPaths: [
              { path: "packages/application/src/run.ts", status: " M", digest: "f".repeat(64) },
            ],
            inScopeChanges: ["packages/application/src/run.ts"],
            outOfScopeChanges: [],
            frozenChanges: [],
            uncertainty: ["delta-captured-during-recovery"],
            workerClaim: { reported: true, changed: true, agreement: "agree" },
            capturedAt: input.capturedAt,
            digest: "1".repeat(64),
            evidencePath: "evidence/repository/recovery-delta.json",
          };
        },
      },
    );
    await commands.start({
      actor: { channel: "direct-cli" },
      request: { goal: "Recover repository evidence", constraints: [] },
      runId,
      snapshot: createRunSnapshot(runId, definitions, clock.now()),
    });
    const current = await persistence.readRun(runId);
    for (const phase of current.state.phases) {
      phase.status =
        phase.id === "implement" ? "pending" : phase.id === "verify" ? "ended" : "accepted";
    }
    current.state.tasks = [
      {
        key: "recover-evidence",
        title: "Recover evidence",
        dependsOn: [],
        paths: ["packages/application"],
        repositoryChange: "required",
        acceptance: ["Evidence survives"],
        role: "implementor",
        status: "pending",
        attempt: 0,
        dispatchFailures: 0,
        sessionId: null,
        steering: [],
      },
    ];
    await persistence.commitRun({
      runId,
      expectedRevision: current.revision,
      operationId: "seed-recovery-task",
      state: current.state,
    });

    await expect(commands.advance(runId, { channel: "driver" })).rejects.toThrow(
      "driver interrupted",
    );
    const interrupted = await persistence.readRun(runId);
    interrupted.state.status = "running";
    await persistence.commitRun({
      runId,
      expectedRevision: interrupted.revision,
      operationId: "restart-driver",
      state: interrupted.state,
    });
    await expect(commands.advance(runId, { channel: "driver" })).resolves.toMatchObject({
      kind: "task-rework",
    });

    const recovered = await persistence.readRun(runId);
    expect(baselineCaptures).toBe(1);
    expect(deltaCaptures).toBe(1);
    expect(recovered.state.dispatches).toHaveLength(1);
    expect(recovered.state.dispatches[0]?.repositoryBaseline?.digest).toBe("e".repeat(64));
    expect(recovered.state.dispatches[0]?.repositoryDelta?.digest).toBe("1".repeat(64));
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
        repositoryChange: "required",
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
      harness.workerContext,
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
    const first = await harness.commands.ask(
      harness.runId,
      "First?",
      harness.workerActor,
      harness.workerContext,
    );
    const second = await harness.commands.ask(
      harness.runId,
      "Second?",
      harness.workerActor,
      harness.workerContext,
    );
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
    const question = await harness.commands.ask(
      harness.runId,
      "Continue?",
      harness.workerActor,
      harness.workerContext,
    );
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
    const question = await harness.commands.ask(
      harness.runId,
      "Continue?",
      harness.workerActor,
      harness.workerContext,
    );
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
    const question = await harness.commands.ask(
      harness.runId,
      "Continue?",
      harness.workerActor,
      harness.workerContext,
    );
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
    const question = await harness.commands.ask(
      harness.runId,
      "Continue?",
      harness.workerActor,
      harness.workerContext,
    );
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

  it("projects multiple open worker questions and classifies replaced turns as stale", async () => {
    const harness = await createQuestionHarness("open-question-projection");
    await harness.commands.ask(
      harness.runId,
      "<img src=x onerror=alert(1)>",
      harness.workerActor,
      harness.workerContext,
    );
    const second = await harness.commands.ask(
      harness.runId,
      "Second?",
      harness.workerActor,
      harness.workerContext,
    );
    await harness.commands.ask(harness.runId, "CLI-only?", { channel: "direct-cli" });

    expect(await harness.queries.openWorkerQuestions(harness.runId)).toEqual([
      expect.objectContaining({
        question: "<img src=x onerror=alert(1)>",
        askedSeq: expect.any(Number),
        ownerKind: "phase",
        ownerId: "define",
        status: "answerable",
      }),
      expect.objectContaining({ questionId: second.questionId, status: "answerable" }),
    ]);

    await updateRuntime(harness.persistence, harness.runId, (state) => {
      if (state.activeTurn === null) throw new Error("Expected an active turn");
      state.activeTurn = { ...state.activeTurn, turnId: "replacement-turn" };
    });

    expect(await harness.queries.openWorkerQuestions(harness.runId)).toEqual([
      expect.objectContaining({ status: "stale" }),
      expect.objectContaining({ status: "stale" }),
    ]);
    await expect(
      harness.commands.answer(
        harness.runId,
        second.questionId,
        "Too late",
        { channel: "web" },
        { submissionId: "11111111-1111-4111-8111-111111111111" },
      ),
    ).rejects.toMatchObject({ name: "QuestionUnavailableError", reason: "stale" });
  });

  it("makes exact answer submission replays idempotent and rejects conflicting reuse", async () => {
    const harness = await createQuestionHarness("answer-idempotency");
    const question = await harness.commands.ask(
      harness.runId,
      "Which boundary?",
      harness.workerActor,
      harness.workerContext,
    );
    const options = { submissionId: "11111111-1111-4111-8111-111111111111" };

    await harness.commands.answer(
      harness.runId,
      question.questionId,
      "Application",
      { channel: "web" },
      options,
    );
    await updateRuntime(harness.persistence, harness.runId, (state) => {
      state.status = "ended";
      state.endReason = "run advanced after the durable answer";
      state.activeTurn = null;
    });
    await expect(
      harness.commands.answer(
        harness.runId,
        question.questionId,
        "Application",
        { channel: "web" },
        options,
      ),
    ).resolves.toEqual({ runId: harness.runId, questionId: question.questionId });
    await expect(
      harness.commands.answer(
        harness.runId,
        question.questionId,
        "Changed",
        { channel: "web" },
        options,
      ),
    ).rejects.toMatchObject({ name: "QuestionSubmissionConflictError" });
    expect(
      (await harness.persistence.readRun(harness.runId)).state.journal.filter(
        (event) => event.event === "question.answered",
      ),
    ).toHaveLength(1);
    expect(await harness.queries.openWorkerQuestions(harness.runId)).toEqual([]);
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
    workerContext: {
      owner: { kind: "phase" as const, id: "define" },
      sessionId: expectedTurn.sessionId,
      turnId: expectedTurn.turnId,
    },
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
