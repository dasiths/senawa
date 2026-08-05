import type { WorkerAuthorization, WorkerBindingContext, WorkerTurn } from "@senawa/application";
import type { WorkerProfile } from "@senawa/domain";
import { describe, expect, it, vi } from "vitest";
import type { SenawaServices } from "./services.js";
import { createSdkWorkerBindings } from "./worker-bindings.js";

const profile: WorkerProfile = {
  apiVersion: "senawa.dev/worker-profile/v1",
  kind: "WorkerProfile",
  metadata: { name: "implementor" },
  spec: {
    model: { id: "fake-model" },
    tools: ["senawa.task.done", "senawa.ask", "senawa.discover", "senawa.note"],
  },
  prompt: "Implement the task.",
};

const turn: WorkerTurn = {
  runId: "run-bindings",
  owner: { kind: "task", id: "task-bindings" },
  operation: "create",
  turnId: "turn-bindings",
  dispatchId: "dispatch-bindings",
  operationId: "operation-bindings",
  traceId: "a".repeat(32),
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  role: "implementor",
  profile,
  profileDigest: "c".repeat(64),
  resolvedModel: profile.spec.model,
  attempt: 1,
  sessionId: "session-bindings",
  goal: "Exercise production bindings",
  rejectionReason: null,
  steering: [],
  prompt: "Complete the task.",
  authorization: { taskPaths: ["packages/workers"], frozenPaths: [] },
};

const authorization: WorkerAuthorization = {
  runId: turn.runId,
  owner: turn.owner,
  profileDigest: turn.profileDigest,
  semanticCapabilities: profile.spec.tools,
  readablePaths: ["**"],
  writablePaths: ["packages/workers"],
  frozenPaths: [],
  allowedCommands: [],
};

const context: WorkerBindingContext = {
  runId: turn.runId,
  owner: turn.owner,
  sessionId: turn.sessionId,
  turnId: turn.turnId,
  authorization,
};

describe("production SDK worker bindings", () => {
  it("keeps completion as a driver-evaluated request", async () => {
    const bindings = createSdkWorkerBindings(() => services()).bindingsFor(turn, authorization);
    const result = await bindings
      .find((binding) => binding.name === "senawa.task.done")
      ?.handle({ summary: "done" }, context);

    expect(result).toMatchObject({
      accepted: true,
      code: "completion_requested",
      message: expect.stringContaining("evaluated by the Senawa driver"),
    });
  });

  it("routes ask, discover, and note through worker-attributed application commands", async () => {
    const ask = vi.fn(async () => ({ runId: turn.runId, questionId: "question-1" }));
    const discover = vi.fn(async () => ({ runId: turn.runId, discoveryId: "discovery-1" }));
    const note = vi.fn(async () => ({ runId: turn.runId, noteId: "note-1" }));
    const bindings = createSdkWorkerBindings(() => services({ ask, discover, note })).bindingsFor(
      turn,
      authorization,
    );

    await bindings
      .find((binding) => binding.name === "senawa.ask")
      ?.handle({ question: "Which boundary?" }, context);
    await bindings
      .find((binding) => binding.name === "senawa.discover")
      ?.handle({ title: "Follow-up work" }, context);
    await bindings
      .find((binding) => binding.name === "senawa.note")
      ?.handle({ note: "Durable context" }, context);

    const actor = { channel: "worker", sessionId: turn.sessionId };
    expect(ask).toHaveBeenCalledWith(turn.runId, "Which boundary?", actor);
    expect(discover).toHaveBeenCalledWith(turn.runId, "Follow-up work", actor);
    expect(note).toHaveBeenCalledWith(turn.runId, "Durable context", actor);
  });
});

function services(
  commands: {
    ask?: ReturnType<typeof vi.fn>;
    discover?: ReturnType<typeof vi.fn>;
    note?: ReturnType<typeof vi.fn>;
  } = {},
): SenawaServices {
  return {
    commands: {
      ask: commands.ask ?? vi.fn(),
      discover: commands.discover ?? vi.fn(),
      note: commands.note ?? vi.fn(),
    },
  } as unknown as SenawaServices;
}
