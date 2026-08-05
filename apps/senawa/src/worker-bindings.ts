import type { WorkerBindingContext } from "@senawa/application";
import type { WorkerBindingHandlers } from "@senawa/workers";
import { DeterministicWorkerBindingRegistry } from "@senawa/workers";
import type { SenawaServices } from "./services.js";

export function createSdkWorkerBindings(
  getServices: () => SenawaServices,
): DeterministicWorkerBindingRegistry {
  const handlers: WorkerBindingHandlers = {
    "senawa.task.done": async () => ({
      accepted: true,
      code: "completion_requested",
      message: "Task completion will be evaluated by the Senawa driver after this turn.",
    }),
    "senawa.phase.submit": async () => ({
      accepted: true,
      code: "artifact_received",
      message: "The phase artifact will be validated and evaluated by the Senawa driver.",
    }),
    "senawa.ask": async (input, context) => {
      const question = requiredString(Reflect.get(input, "question"), "question");
      const result = await getServices().commands.ask(
        context.runId,
        question,
        workerActor(context),
      );
      return {
        accepted: true,
        code: "question_recorded",
        message: `Question ${result.questionId} was recorded for the human.`,
        data: { questionId: result.questionId },
      };
    },
    "senawa.discover": async (input, context) => {
      const title = requiredString(Reflect.get(input, "title"), "title");
      const result = await getServices().commands.discover(
        context.runId,
        title,
        workerActor(context),
      );
      return {
        accepted: true,
        code: "discovery_recorded",
        message: `Discovery ${result.discoveryId} was recorded.`,
        data: { discoveryId: result.discoveryId },
      };
    },
    "senawa.note": async (input, context) => {
      const note = requiredString(Reflect.get(input, "note"), "note");
      const result = await getServices().commands.note(context.runId, note, workerActor(context));
      return {
        accepted: true,
        code: "note_recorded",
        message: `Note ${result.noteId} was recorded.`,
        data: { noteId: result.noteId },
      };
    },
  };
  return new DeterministicWorkerBindingRegistry(handlers);
}

function workerActor(context: WorkerBindingContext) {
  return {
    channel: "worker" as const,
    sessionId: context.sessionId,
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}
