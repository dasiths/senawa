import { createRunSnapshot, loadRepositoryDefinitions } from "@senawa/configuration";
import type { RuntimePhase, RuntimeState } from "@senawa/domain";
import { beforeAll, describe, expect, it } from "vitest";
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
    const state: Pick<RuntimeState, "artifacts" | "identity" | "snapshot"> = {
      identity: {
        runId: snapshot.runId,
        backend: "beads",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Reconcile documentation", constraints: [] },
        createdAt: snapshot.createdAt,
        fingerprint: snapshot.fingerprint,
      },
      snapshot,
      artifacts: [],
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

  it("gives planners approved evidence and the configured task role", () => {
    const snapshot = createRunSnapshot(
      "run-plan-prompt",
      definitions,
      new Date("2026-08-06T00:00:00.000Z"),
    );
    const state: Pick<RuntimeState, "artifacts" | "identity" | "snapshot"> = {
      identity: {
        runId: snapshot.runId,
        backend: "beads",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Reconcile documentation", constraints: [] },
        createdAt: snapshot.createdAt,
        fingerprint: snapshot.fingerprint,
      },
      snapshot,
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

    expect(JSON.parse(createPhasePrompt(state, phase, 1))).toMatchObject({
      repository: { pathConvention: expect.stringContaining("repository-relative") },
      dependencyArtifacts: { research: { summary: "Approved evidence" } },
      taskPlanning: {
        requiredRole: "implementor",
        instruction: expect.stringContaining("Every planned task"),
      },
    });
  });
});
