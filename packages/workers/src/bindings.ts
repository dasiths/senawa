import type {
  WorkerAuthorization,
  WorkerBinding,
  WorkerBindingContext,
  WorkerBindingName,
  WorkerBindingResult,
  WorkerTurn,
} from "@senawa/application";
import type { JsonObject, WorkerCapability } from "@senawa/domain";

export type WorkerBindingHandler = (
  input: JsonObject,
  context: WorkerBindingContext,
) => Promise<WorkerBindingResult>;

export type WorkerBindingHandlers = Readonly<Record<WorkerBindingName, WorkerBindingHandler>>;

const bindingDefinitions: readonly {
  readonly name: WorkerBindingName;
  readonly capability: WorkerCapability;
  readonly description: string;
  readonly required: readonly string[];
}[] = [
  {
    name: "senawa.task.done",
    capability: "senawa.task.done",
    description: "Submit task completion",
    required: ["summary"],
  },
  {
    name: "senawa.phase.submit",
    capability: "senawa.phase.submit",
    description: "Submit a phase artifact",
    required: ["artifact"],
  },
  {
    name: "senawa.ask",
    capability: "senawa.ask",
    description: "Ask a bounded question",
    required: ["question"],
  },
  {
    name: "senawa.discover",
    capability: "senawa.discover",
    description: "Record discovered work",
    required: ["title"],
  },
  {
    name: "senawa.note",
    capability: "senawa.note",
    description: "Record a durable note",
    required: ["note"],
  },
];

export class DeterministicWorkerBindingRegistry {
  constructor(private readonly handlers: WorkerBindingHandlers) {}

  bindingsFor(_turn: WorkerTurn, authorization: WorkerAuthorization): readonly WorkerBinding[] {
    return bindingDefinitions
      .filter((definition) => authorization.semanticCapabilities.includes(definition.capability))
      .map((definition) => ({
        name: definition.name,
        capability: definition.capability,
        description: definition.description,
        inputSchema: {
          type: "object",
          required: [...definition.required],
          additionalProperties: false,
        },
        handle: async (input, context) => {
          if (
            context.runId !== authorization.runId ||
            context.owner.kind !== authorization.owner.kind ||
            context.owner.id !== authorization.owner.id
          ) {
            return {
              accepted: false,
              code: "owner_mismatch",
              message: "Binding context is outside the authorized owner",
            };
          }
          for (const property of definition.required) {
            if (!(property in input)) {
              return {
                accepted: false,
                code: "invalid_input",
                message: `Missing required property: ${property}`,
              };
            }
          }
          return this.handlers[definition.name](input, context);
        },
      }));
  }
}

export function recordingBindingHandlers(
  calls: Array<{ readonly name: WorkerBindingName; readonly input: JsonObject }>,
): WorkerBindingHandlers {
  return Object.fromEntries(
    bindingDefinitions.map(({ name }) => [
      name,
      async (input: JsonObject) => {
        calls.push({ name, input });
        return { accepted: true, code: "recorded", message: `${name} recorded` };
      },
    ]),
  ) as unknown as WorkerBindingHandlers;
}
