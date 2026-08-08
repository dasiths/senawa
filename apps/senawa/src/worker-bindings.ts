import type { WorkerBindingContext } from "@senawa/application";
import { QuestionAnswerTimeoutError } from "@senawa/application";
import { TaskCompletionSubmissionSchema } from "@senawa/domain";
import type { WorkerBindingHandlers } from "@senawa/workers";
import {
  DeterministicWorkerBindingRegistry,
  WORKER_QUESTION_WAIT_TIMEOUT_MS,
} from "@senawa/workers";
import type { SenawaServices } from "./services.js";

export function createSdkWorkerBindings(
  getServices: () => SenawaServices,
): DeterministicWorkerBindingRegistry {
  const handlers: WorkerBindingHandlers = {
    "senawa.task.done": async (input) => {
      const submission = TaskCompletionSubmissionSchema.safeParse(input);
      if (!submission.success) {
        return {
          accepted: false,
          code: "invalid_input",
          message:
            "Report a summary and, for every acceptance criterion, an id, an outcome, and resolving evidence.",
        };
      }
      return {
        accepted: true,
        code: "completion_requested",
        message:
          "The Senawa driver will resolve every claimed evidence reference against measured evidence after this turn.",
        data: {
          criteria: submission.data.criteria.map((criterion) => ({
            id: criterion.id,
            outcome: criterion.outcome,
            evidence: criterion.evidence.length,
          })),
        },
      };
    },
    "senawa.phase.submit": async () => ({
      accepted: true,
      code: "artifact_received",
      message: "The phase artifact will be validated and evaluated by the Senawa driver.",
    }),
    "senawa.ask": async (input, context) => {
      const question = requiredString(Reflect.get(input, "question"), "question");
      const services = getServices();
      const result = await services.commands.ask(context.runId, question, workerActor(context), {
        owner: context.owner,
        sessionId: context.sessionId,
        turnId: context.turnId,
      });
      try {
        const answer = await services.queries.waitForQuestionAnswer(
          context.runId,
          result.questionId,
          { sessionId: context.sessionId, turnId: context.turnId },
          { timeoutMs: WORKER_QUESTION_WAIT_TIMEOUT_MS },
        );
        return {
          accepted: true,
          code: "question_answered",
          message: `Question ${result.questionId} was answered by the human.`,
          data: { questionId: result.questionId, answer },
        };
      } catch (error) {
        if (!(error instanceof QuestionAnswerTimeoutError)) throw error;
        return {
          accepted: false,
          code: "question_unanswered",
          message: `${error.message} The question stays open, so end this turn and report that ${result.questionId} is blocking it. Do not guess the answer.`,
          data: { questionId: result.questionId, question },
        };
      }
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
