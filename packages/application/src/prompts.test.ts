import { createRunSnapshot, loadRepositoryDefinitions } from "@senawa/configuration";
import type { RuntimePhase, RuntimeState } from "@senawa/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { resolvePhaseInputManifest } from "./input-manifests.js";
import { createPhasePrompt } from "./prompts.js";

let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("phase worker prompts", () => {
  it("includes the frozen output schema and resumed rejection context", () => {
    const snapshot = structuredClone(
      createRunSnapshot("run-prompt-schema", definitions, new Date("2026-08-06T00:00:00.000Z")),
    );
    const schemaFile = snapshot.files.find(
      (file) => file.path === ".senawa/schemas/definition.schema.json",
    );
    if (schemaFile === undefined) throw new Error("fixture requires the definition schema");
    schemaFile.content = JSON.stringify({
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
      additionalProperties: false,
    });
    const phase: RuntimePhase = {
      id: "define",
      status: "pending",
      iteration: 2,
      artifactVersion: null,
      sessionId: null,
      rejectionReason: "Keep the scope documentation-only",
    };
    const state: Pick<RuntimeState, "artifacts" | "identity" | "phases" | "snapshot"> = {
      identity: {
        runId: snapshot.runId,
        backend: "beads",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Reconcile documentation", constraints: [] },
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
      artifacts: [],
      phases: [phase],
    };

    expect(JSON.parse(createPhasePrompt(state, phase, 2))).toMatchObject({
      kind: "phase",
      phase: phase.id,
      iteration: 2,
      rejectionReason: "Keep the scope documentation-only",
      submission: {
        tool: "senawa.phase.submit",
        artifactSchema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
          additionalProperties: false,
        },
      },
    });
  });

  it("gives planners the exact resolved inputs and configured task role", () => {
    const snapshot = createRunSnapshot(
      "run-plan-prompt",
      definitions,
      new Date("2026-08-06T00:00:00.000Z"),
    );
    const state: Pick<RuntimeState, "artifacts" | "identity" | "phases" | "snapshot"> = {
      identity: {
        runId: snapshot.runId,
        backend: "beads",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Reconcile documentation", constraints: [] },
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
      phases: [
        {
          id: "research",
          status: "accepted",
          iteration: 1,
          artifactVersion: 1,
          sessionId: "research-session",
          rejectionReason: null,
        },
      ],
      artifacts: [
        {
          phaseId: "research",
          version: 1,
          path: "artifacts/research/v1.json",
          createdAt: snapshot.createdAt,
          content: { summary: "Approved evidence" },
          consumed: { define: 1 },
        },
      ],
    };
    const phase: RuntimePhase = {
      id: "plan",
      status: "pending",
      iteration: 1,
      artifactVersion: null,
      sessionId: null,
      rejectionReason: null,
    };

    const inputManifest = {
      version: 1 as const,
      inputs: [
        {
          name: "research",
          reference: "phases.research.output",
          ownerKind: "phase" as const,
          ownerId: "research",
          path: "artifacts/research/v1.json",
          version: 1,
          digest: "a".repeat(64),
          schemaKind: "phase-artifact" as const,
          summary: { summary: "Approved evidence" },
          content: { summary: "Approved evidence" },
        },
      ],
    };

    expect(JSON.parse(createPhasePrompt(state, phase, 1, inputManifest))).toMatchObject({
      repository: { pathConvention: expect.stringContaining("repository-relative") },
      dependencyPhases: { research: { status: "accepted", iteration: 1 } },
      inputManifest,
      taskPlanning: {
        requiredRole: "implementor",
        instruction: expect.stringContaining("Every planned task"),
      },
    });
  });

  it("uses executor inputs as the sole dataflow source on rerun", () => {
    const snapshot = createRunSnapshot(
      "run-rerun-inputs",
      definitions,
      new Date("2026-08-06T00:00:00.000Z"),
    );
    const phases = snapshot.workflow.spec.phases.map((definition) => ({
      id: definition.id,
      status: (definition.id === "define" || definition.id === "research"
        ? "accepted"
        : "pending") as RuntimePhase["status"],
      iteration: 1,
      artifactVersion:
        definition.id === "define" || definition.id === "research" || definition.id === "plan"
          ? 1
          : null,
      sessionId: null,
      rejectionReason: null,
    }));
    const state: RuntimeState = {
      apiVersion: "senawa.dev/runtime/v1",
      identity: {
        runId: snapshot.runId,
        backend: "file",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Rerun planning", constraints: [] },
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
      phases,
      tasks: [],
      artifacts: ["define", "research", "plan"].map((phaseId) => ({
        phaseId,
        version: 1,
        path: `artifacts/${phaseId}/v1.json`,
        createdAt: snapshot.createdAt,
        content: { summary: `${phaseId} artifact` },
        consumed: [],
      })),
      journal: [],
      outputs: {},
      activeTurn: null,
      dispatches: [],
      leases: { driver: null, web: null },
    };
    const plan = phases.find((phase) => phase.id === "plan");
    if (plan === undefined) throw new Error("standard fixture is missing plan");

    const manifest = resolvePhaseInputManifest(state, plan);

    expect(manifest.inputs.map((input) => input.ownerId)).toEqual(["define", "research"]);
    expect(manifest.inputs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ ownerId: "plan" })]),
    );

    const planDefinition = state.snapshot.workflow.spec.phases.find(
      (candidate) => candidate.id === "plan",
    );
    if (planDefinition?.executor.kind !== "agent" || planDefinition.executor.input === undefined) {
      throw new Error("standard fixture is missing plan inputs");
    }
    Reflect.deleteProperty(planDefinition.executor.input, "definition");
    expect(resolvePhaseInputManifest(state, plan).inputs.map((input) => input.ownerId)).toEqual([
      "research",
    ]);
  });

  it("resolves verification artifacts and bounded implementation evidence exactly", () => {
    const snapshot = createRunSnapshot(
      "run-verification-inputs",
      definitions,
      new Date("2026-08-06T00:00:00.000Z"),
    );
    const phases = snapshot.workflow.spec.phases.map((definition) => ({
      id: definition.id,
      status: (definition.id === "verify" ? "pending" : "accepted") as RuntimePhase["status"],
      iteration: 1,
      artifactVersion: ["define", "research", "plan"].includes(definition.id) ? 1 : null,
      sessionId: null,
      rejectionReason: null,
    }));
    const state: RuntimeState = {
      apiVersion: "senawa.dev/runtime/v1",
      identity: {
        runId: snapshot.runId,
        backend: "file",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Verify exact evidence", constraints: [] },
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
      phases,
      tasks: [
        {
          key: "implemented",
          title: "Implemented task",
          dependsOn: [],
          paths: ["packages/application"],
          repositoryChange: "required",
          acceptance: ["Done"],
          role: "implementor",
          status: "closed",
          attempt: 2,
          dispatchFailures: 0,
          sessionId: "task-session",
          steering: [],
        },
      ],
      artifacts: ["define", "research", "plan"].map((phaseId) => ({
        phaseId,
        version: 1,
        path: `artifacts/${phaseId}/v1.json`,
        createdAt: snapshot.createdAt,
        content: { summary: `${phaseId} artifact` },
        consumed: [],
      })),
      journal: [
        {
          apiVersion: "senawa.dev/event/v1",
          seq: 1,
          ts: snapshot.createdAt,
          runId: snapshot.runId,
          event: "sensor.completed",
          actor: { channel: "driver" },
          data: {
            gateId: "task-done",
            sensorId: "task-change",
            ownerKind: "task",
            ownerId: "implemented",
            attempt: 2,
            verdict: "pass",
            matched: true,
            advisory: false,
            summary: "Trusted repository change evidence satisfied required policy",
            evidencePaths: [
              "evidence/repository/tasks/implemented/attempt-2/task-dispatch/delta.json",
            ],
          },
        },
        {
          apiVersion: "senawa.dev/event/v1",
          seq: 2,
          ts: snapshot.createdAt,
          runId: snapshot.runId,
          event: "gate.evaluated",
          actor: { channel: "driver" },
          data: {
            gateId: "task-done",
            ownerKind: "task",
            ownerId: "implemented",
            attempt: 2,
            accepted: true,
            findings: [],
            readings: [
              {
                sensorId: "task-change",
                matched: true,
                advisory: false,
                summary: "Trusted repository change evidence satisfied required policy",
              },
            ],
          },
        },
      ],
      outputs: {},
      activeTurn: null,
      dispatches: [
        {
          dispatchId: "task-dispatch",
          operationId: "task-operation",
          turnId: "task-turn",
          sessionId: "task-session",
          ownerKind: "task",
          ownerId: "implemented",
          operation: "create",
          workAttempt: 2,
          dispatchFailure: 0,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.createdAt,
          status: "completed",
          repositoryDelta: {
            version: 1,
            kind: "repository-delta",
            runId: snapshot.runId,
            taskId: "implemented",
            attempt: 2,
            dispatchId: "task-dispatch",
            turnId: "task-turn",
            expectation: "required",
            baselineDigest: "b".repeat(64),
            headBefore: "head",
            headAfter: "head",
            preExistingChanges: [],
            changedPaths: [
              { path: "packages/application/src/run.ts", status: " M", digest: "c".repeat(64) },
            ],
            inScopeChanges: ["packages/application/src/run.ts"],
            outOfScopeChanges: [],
            frozenChanges: [],
            uncertainty: [],
            workerClaim: { reported: true, changed: true, agreement: "agree" },
            capturedAt: snapshot.createdAt,
            digest: "d".repeat(64),
            evidencePath:
              "evidence/repository/tasks/implemented/attempt-2/task-dispatch/delta.json",
          },
        },
      ],
      leases: { driver: null, web: null },
    };
    const verify = phases.find((phase) => phase.id === "verify");
    if (verify === undefined) throw new Error("standard fixture is missing verify");

    const manifest = resolvePhaseInputManifest(state, verify);

    expect(manifest.inputs.map((input) => input.reference)).toEqual([
      "phases.define.output",
      "phases.research.output",
      "phases.plan.output",
      "evidence.implementation",
    ]);
    expect(manifest.inputs.at(-1)).toMatchObject({
      path: "evidence/implementation/v2.json",
      schemaKind: "senawa.dev/verification-manifest/v1",
      summary: {
        taskCount: 1,
        closedTaskCount: 1,
        measuredTaskCount: 1,
        unresolvedEvidenceCount: 0,
        blockingIssueCount: 0,
        repositoryEvidence: "measured-task-deltas",
      },
      content: {
        kind: "verification-manifest",
        executionClassification: "simulated",
        liveProofEligible: false,
        tasks: [
          expect.objectContaining({
            outcome: { status: "closed", attempt: 2 },
            repositoryEvidence: expect.objectContaining({
              path: "evidence/repository/tasks/implemented/attempt-2/task-dispatch/delta.json",
              digest: "d".repeat(64),
              inScopeChanges: ["packages/application/src/run.ts"],
            }),
            gateEvidence: expect.arrayContaining([
              expect.objectContaining({
                gateId: "task-done",
                sensorId: "task-change",
                verdict: "pass",
                accepted: true,
              }),
            ]),
          }),
        ],
        readPaths: expect.arrayContaining([
          {
            kind: "repository-delta",
            path: "evidence/repository/tasks/implemented/attempt-2/task-dispatch/delta.json",
            readPath:
              ".agents/.copilot-tracking/run-verification-inputs/evidence/repository/tasks/implemented/attempt-2/task-dispatch/delta.json",
            digest: "d".repeat(64),
          },
        ]),
        blockingIssues: [],
      },
    });
  });
});
