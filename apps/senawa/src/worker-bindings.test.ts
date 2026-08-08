import type { WorkerAuthorization, WorkerBindingContext, WorkerTurn } from "@senawa/application";
import { QuestionAnswerTimeoutError } from "@senawa/application";
import type { WorkerProfile } from "@senawa/domain";
import { SDK_TURN_TIMEOUT_MS, WORKER_QUESTION_WAIT_TIMEOUT_MS } from "@senawa/workers";
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
      ?.handle(
        {
          summary: "done",
          criteria: [
            {
              id: "ac-one",
              outcome: "satisfied",
              summary: "what was done",
              evidence: [
                {
                  kind: "file",
                  path: "packages/workers/src/bindings.ts",
                  relationship: "modified",
                },
              ],
            },
          ],
        },
        context,
      );

    expect(result).toMatchObject({
      accepted: true,
      code: "completion_requested",
      message: expect.stringContaining("Senawa driver"),
      data: { criteria: [{ id: "ac-one", outcome: "satisfied", evidence: 1 }] },
    });
  });

  it("refuses a completion submission without per-criterion evidence", async () => {
    const bindings = createSdkWorkerBindings(() => services()).bindingsFor(turn, authorization);
    const result = await bindings
      .find((binding) => binding.name === "senawa.task.done")
      ?.handle({ summary: "done" }, context);

    expect(result).toMatchObject({ accepted: false, code: "invalid_input" });
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
    expect(ask).toHaveBeenCalledWith(turn.runId, "Which boundary?", actor, {
      owner: turn.owner,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    });
    expect(discover).toHaveBeenCalledWith(turn.runId, "Follow-up work", actor);
    expect(note).toHaveBeenCalledWith(turn.runId, "Durable context", actor);
  });

  it("keeps ask pending until the correlated durable answer is available", async () => {
    const answer = deferred<string>();
    const ask = vi.fn(async () => ({ runId: turn.runId, questionId: "question-1" }));
    const waitForQuestionAnswer = vi.fn(() => answer.promise);
    const resume = vi.fn();
    const drive = vi.fn();
    const advance = vi.fn();
    const finish = vi.fn();
    const bindings = createSdkWorkerBindings(() =>
      services({ ask, resume, drive, advance, finish }, waitForQuestionAnswer),
    ).bindingsFor(turn, authorization);
    let settled = false;

    const result = bindings
      .find((binding) => binding.name === "senawa.ask")
      ?.handle({ question: "Which boundary?" }, context)
      .finally(() => {
        settled = true;
      });
    await flushMicrotasks();

    expect(settled).toBe(false);
    expect(waitForQuestionAnswer).toHaveBeenCalledWith(
      turn.runId,
      "question-1",
      { sessionId: turn.sessionId, turnId: turn.turnId },
      { timeoutMs: WORKER_QUESTION_WAIT_TIMEOUT_MS },
    );
    expect(WORKER_QUESTION_WAIT_TIMEOUT_MS).toBeLessThan(SDK_TURN_TIMEOUT_MS);

    answer.resolve("Keep it in application queries.");

    await expect(result).resolves.toEqual({
      accepted: true,
      code: "question_answered",
      message: "Question question-1 was answered by the human.",
      data: { questionId: "question-1", answer: "Keep it in application queries." },
    });
    expect(resume).not.toHaveBeenCalled();
    expect(drive).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("refuses ask with the blocking question when the bounded wait expires", async () => {
    const ask = vi.fn(async () => ({ runId: turn.runId, questionId: "question-1" }));
    const waitForQuestionAnswer = vi.fn(() =>
      Promise.reject(
        new QuestionAnswerTimeoutError(
          turn.runId,
          "question-1",
          "Which boundary?",
          WORKER_QUESTION_WAIT_TIMEOUT_MS,
        ),
      ),
    );
    const bindings = createSdkWorkerBindings(() =>
      services({ ask }, waitForQuestionAnswer),
    ).bindingsFor(turn, authorization);

    await expect(
      bindings
        .find((binding) => binding.name === "senawa.ask")
        ?.handle({ question: "Which boundary?" }, context),
    ).resolves.toMatchObject({
      accepted: false,
      code: "question_unanswered",
      message: expect.stringContaining("question-1"),
      data: { questionId: "question-1", question: "Which boundary?" },
    });
  });

  it("propagates a non-timeout ask failure instead of masking it as unanswered", async () => {
    const ask = vi.fn(async () => ({ runId: turn.runId, questionId: "question-1" }));
    const waitForQuestionAnswer = vi.fn(() =>
      Promise.reject(new Error("Worker turn turn-bindings is no longer active")),
    );
    const bindings = createSdkWorkerBindings(() =>
      services({ ask }, waitForQuestionAnswer),
    ).bindingsFor(turn, authorization);

    await expect(
      bindings
        .find((binding) => binding.name === "senawa.ask")
        ?.handle({ question: "Which boundary?" }, context),
    ).rejects.toThrow("is no longer active");
  });

  it("correlates concurrent asks when answers arrive in reverse order", async () => {
    const answers = new Map([
      ["question-1", deferred<string>()],
      ["question-2", deferred<string>()],
    ]);
    const ask = vi.fn(async (_runId: string, question: string) => ({
      runId: turn.runId,
      questionId: question === "First?" ? "question-1" : "question-2",
    }));
    const waitForQuestionAnswer = vi.fn(
      (_runId: string, questionId: string) => answers.get(questionId)?.promise ?? Promise.reject(),
    );
    const bindings = createSdkWorkerBindings(() =>
      services({ ask }, waitForQuestionAnswer),
    ).bindingsFor(turn, authorization);
    const binding = bindings.find((candidate) => candidate.name === "senawa.ask");
    if (binding === undefined) throw new Error("senawa.ask binding is missing");
    let firstSettled = false;
    const first = binding.handle({ question: "First?" }, context).finally(() => {
      firstSettled = true;
    });
    const second = binding.handle({ question: "Second?" }, context);
    await flushMicrotasks();

    answers.get("question-2")?.resolve("Second answer");
    await expect(second).resolves.toMatchObject({
      code: "question_answered",
      data: { questionId: "question-2", answer: "Second answer" },
    });
    expect(firstSettled).toBe(false);

    answers.get("question-1")?.resolve("First answer");
    await expect(first).resolves.toMatchObject({
      code: "question_answered",
      data: { questionId: "question-1", answer: "First answer" },
    });
  });
});

function services(
  commands: {
    ask?: ReturnType<typeof vi.fn>;
    discover?: ReturnType<typeof vi.fn>;
    note?: ReturnType<typeof vi.fn>;
    resume?: ReturnType<typeof vi.fn>;
    drive?: ReturnType<typeof vi.fn>;
    advance?: ReturnType<typeof vi.fn>;
    finish?: ReturnType<typeof vi.fn>;
  } = {},
  waitForQuestionAnswer: ReturnType<typeof vi.fn> = vi.fn(async () => "Human answer"),
): SenawaServices {
  return {
    commands: {
      ask: commands.ask ?? vi.fn(),
      discover: commands.discover ?? vi.fn(),
      note: commands.note ?? vi.fn(),
      resume: commands.resume ?? vi.fn(),
      drive: commands.drive ?? vi.fn(),
      advance: commands.advance ?? vi.fn(),
      finish: commands.finish ?? vi.fn(),
    },
    queries: { waitForQuestionAnswer },
  } as unknown as SenawaServices;
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
