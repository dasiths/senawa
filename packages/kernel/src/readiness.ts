import {
  type CanonicalValue,
  canonicalDigest,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import { validateWorkflowGraph, type WorkflowGraph } from "./graph.js";
import {
  type DefinitionGeneration,
  isDefinitionGeneration,
  isTaskId,
  type TaskId,
} from "./identity.js";

export const READINESS_FRONTIER_API_VERSION = "senawa.dev/readiness-frontier/v1";

export type NonacceptedTaskStatus = "pending" | "active" | "failed" | "cancelled";

export type TaskStatusFact = Readonly<
  | {
      readonly taskId: TaskId;
      readonly definitionGeneration: DefinitionGeneration;
      readonly status: NonacceptedTaskStatus;
    }
  | {
      readonly taskId: TaskId;
      readonly definitionGeneration: DefinitionGeneration;
      readonly status: "accepted";
      readonly accountingAssessmentDigest: Sha256Digest;
      readonly integrationBarrierDigest?: Sha256Digest;
    }
>;

export interface ReadinessFrontierOptions {
  readonly requiredIntegrationBarrierDigest?: Sha256Digest;
}

export interface ReadyTask {
  readonly taskId: TaskId;
  readonly definitionGeneration: DefinitionGeneration;
}

export interface ReadinessFrontier {
  readonly apiVersion: typeof READINESS_FRONTIER_API_VERSION;
  readonly graphRevisionDigest: Sha256Digest;
  readonly requiredIntegrationBarrierDigest?: Sha256Digest;
  readonly tasks: readonly ReadyTask[];
  readonly frontierDigest: Sha256Digest;
}

export class ReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessError";
  }
}

export function deriveReadyTaskFrontier(
  graphValue: unknown,
  factsValue: unknown,
  sha256: Sha256,
  options: ReadinessFrontierOptions = {},
): ReadinessFrontier {
  const graph = validateWorkflowGraph(graphValue, sha256);
  const facts = validateTaskStatusFacts(factsValue, graph);
  const requiredIntegrationBarrierDigest = options.requiredIntegrationBarrierDigest;
  if (
    requiredIntegrationBarrierDigest !== undefined &&
    !isSha256Digest(requiredIntegrationBarrierDigest)
  ) {
    throw new ReadinessError("Required integration barrier must be a SHA-256 digest");
  }
  const factsByTask = new Map(facts.map((fact) => [fact.taskId, fact]));
  const taskDefinitions = graph.nodes.flatMap((node) =>
    node.kind === "task" ? [node.definition] : [],
  );
  const supersededTaskIds = new Set(taskDefinitions.flatMap((definition) => definition.supersedes));
  const tasks = taskDefinitions
    .filter((definition) => !supersededTaskIds.has(definition.id))
    .filter((definition) => factsByTask.get(definition.id)?.status === "pending")
    .filter((definition) =>
      definition.dependsOn.every((dependencyId) => {
        const dependency = factsByTask.get(dependencyId);
        return (
          dependency?.status === "accepted" &&
          (requiredIntegrationBarrierDigest === undefined ||
            dependency.integrationBarrierDigest === requiredIntegrationBarrierDigest)
        );
      }),
    )
    .map((definition) => ({
      taskId: definition.id,
      definitionGeneration: definition.generation,
    }))
    .sort(compareTaskIdentity);
  const content = canonicalValue(
    requiredIntegrationBarrierDigest === undefined
      ? {
          apiVersion: READINESS_FRONTIER_API_VERSION,
          graphRevisionDigest: graph.revisionDigest,
          tasks,
        }
      : {
          apiVersion: READINESS_FRONTIER_API_VERSION,
          graphRevisionDigest: graph.revisionDigest,
          requiredIntegrationBarrierDigest,
          tasks,
        },
  );
  return canonicalValue({
    ...(content as unknown as Record<string, CanonicalValue>),
    frontierDigest: canonicalDigest(content, sha256),
  }) as unknown as ReadinessFrontier;
}

function validateTaskStatusFacts(value: unknown, graph: WorkflowGraph): readonly TaskStatusFact[] {
  const snapshot = canonicalSnapshot(value, "Task status facts");
  if (!Array.isArray(snapshot)) throw new ReadinessError("Task status facts must be an array");
  const taskDefinitions = graph.nodes.flatMap((node) =>
    node.kind === "task" ? [node.definition] : [],
  );
  const taskById = new Map(taskDefinitions.map((task) => [task.id, task]));
  const facts = snapshot.map((fact, index) => validateTaskStatusFact(fact, index, taskById));
  const sorted = [...facts].sort(compareTaskIdentity);
  if (new Set(facts.map((fact) => fact.taskId)).size !== facts.length) {
    throw new ReadinessError("Task status facts must contain each task at most once");
  }
  if (
    facts.length !== taskDefinitions.length ||
    taskDefinitions.some((task) => !facts.some((fact) => fact.taskId === task.id))
  ) {
    throw new ReadinessError("Task status facts must account for every graph task exactly once");
  }
  return Object.freeze(sorted);
}

function validateTaskStatusFact(
  value: unknown,
  index: number,
  taskById: ReadonlyMap<TaskId, { readonly generation: DefinitionGeneration }>,
): TaskStatusFact {
  if (!isRecord(value)) throw new ReadinessError(`Task status fact ${index} must be an object`);
  if (!isTaskId(value.taskId) || !isDefinitionGeneration(value.definitionGeneration)) {
    throw new ReadinessError(`Task status fact ${index} has an invalid task generation`);
  }
  const task = taskById.get(value.taskId);
  if (task === undefined || task.generation !== value.definitionGeneration) {
    throw new ReadinessError(`Task status fact ${index} is stale or absent from the graph`);
  }
  if (value.status === "accepted") {
    assertExactKeys(value, [
      "taskId",
      "definitionGeneration",
      "status",
      "accountingAssessmentDigest",
      ...(Object.hasOwn(value, "integrationBarrierDigest") ? ["integrationBarrierDigest"] : []),
    ]);
    if (!isSha256Digest(value.accountingAssessmentDigest)) {
      throw new ReadinessError(`Task status fact ${index} has an invalid accounting digest`);
    }
    if (
      Object.hasOwn(value, "integrationBarrierDigest") &&
      !isSha256Digest(value.integrationBarrierDigest)
    ) {
      throw new ReadinessError(`Task status fact ${index} has an invalid integration digest`);
    }
    return value as unknown as TaskStatusFact;
  }
  if (!isNonacceptedStatus(value.status)) {
    throw new ReadinessError(`Task status fact ${index} has an invalid status`);
  }
  assertExactKeys(value, ["taskId", "definitionGeneration", "status"]);
  return value as unknown as TaskStatusFact;
}

function isNonacceptedStatus(value: unknown): value is NonacceptedTaskStatus {
  return value === "pending" || value === "active" || value === "failed" || value === "cancelled";
}

function canonicalSnapshot(value: unknown, label: string): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    throw new ReadinessError(`${label} must contain only canonical values`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ReadinessError(
      `Task status facts must contain exactly: ${sortedExpected.join(", ")}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareTaskIdentity(
  left: { readonly taskId: TaskId },
  right: { readonly taskId: TaskId },
): number {
  return compareText(left.taskId, right.taskId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
