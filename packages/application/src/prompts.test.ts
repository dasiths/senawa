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
    const state: Pick<RuntimeState, "identity" | "snapshot"> = {
      identity: {
        runId: snapshot.runId,
        backend: "beads",
        workflow: snapshot.workflow.metadata.name,
        request: { goal: "Reconcile documentation", constraints: [] },
        createdAt: snapshot.createdAt,
        fingerprint: snapshot.fingerprint,
      },
      snapshot,
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
});
