import { describe, expect, it } from "vitest";
import { type Sha256, sha256Digest } from "./canonical.js";
import type { CompletionPolicy } from "./completion.js";
import { compileWorkflowGraph, type NormalizedWorkflowInput } from "./graph.js";
import {
  consumerKey,
  criterionId,
  definitionGeneration,
  phaseId,
  taskId,
  workflowId,
} from "./identity.js";
import { deriveReadyTaskFrontier, ReadinessError, type TaskStatusFact } from "./readiness.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const digest = (character: string) => sha256Digest(character.repeat(64));

describe("dependency-ready task frontiers", () => {
  it("derives pending roots and newly unblocked tasks in stable identity order", () => {
    const graph = readinessGraph();
    const initial = deriveReadyTaskFrontier(graph, initialFacts(), deterministicSha256);
    const progressedFacts = initialFacts();
    progressedFacts[0] = accepted("task_a", "a");
    progressedFacts[1] = { ...progressedFacts[1], status: "active" } as TaskStatusFact;
    const progressed = deriveReadyTaskFrontier(graph, progressedFacts, deterministicSha256);

    expect(initial.tasks.map(({ taskId: id }) => id)).toEqual(["task_a", "task_b"]);
    expect(progressed.tasks.map(({ taskId: id }) => id)).toEqual(["task_c"]);
    expect(progressed.graphRevisionDigest).toBe(graph.revisionDigest);
    expect(Object.isFrozen(progressed)).toBe(true);
    expect(Object.isFrozen(progressed.tasks)).toBe(true);
  });

  it("requires the configured integration barrier on accepted dependencies", () => {
    const facts = initialFacts();
    facts[0] = accepted("task_a", "a");
    facts[1] = { ...facts[1], status: "active" } as TaskStatusFact;

    const absent = deriveReadyTaskFrontier(readinessGraph(), facts, deterministicSha256, {
      requiredIntegrationBarrierDigest: digest("9"),
    });
    facts[0] = { ...accepted("task_a", "a"), integrationBarrierDigest: digest("9") };
    const present = deriveReadyTaskFrontier(readinessGraph(), facts, deterministicSha256, {
      requiredIntegrationBarrierDigest: digest("9"),
    });

    expect(absent.tasks).toEqual([]);
    expect(present.tasks.map(({ taskId: id }) => id)).toEqual(["task_c"]);
    expect(present.requiredIntegrationBarrierDigest).toBe(digest("9"));
  });

  it("does not return superseded task definitions", () => {
    const frontier = deriveReadyTaskFrontier(readinessGraph(), initialFacts(), deterministicSha256);

    expect(frontier.tasks.map(({ taskId: id }) => id)).not.toContain("task_old");
  });

  it("normalizes task status fact arrival order", () => {
    const ordered = deriveReadyTaskFrontier(readinessGraph(), initialFacts(), deterministicSha256);
    const reversed = deriveReadyTaskFrontier(
      readinessGraph(),
      initialFacts().reverse(),
      deterministicSha256,
    );

    expect(reversed).toEqual(ordered);
  });

  it.each([
    ["missing", (facts: TaskStatusFact[]) => facts.pop()],
    [
      "duplicate",
      (facts: TaskStatusFact[]) => facts.splice(1, 1, { ...facts[0] } as TaskStatusFact),
    ],
    [
      "stale generation",
      (facts: TaskStatusFact[]) => {
        facts[0] = { ...facts[0], definitionGeneration: definitionGeneration(2) } as TaskStatusFact;
      },
    ],
    [
      "unknown status",
      (facts: TaskStatusFact[]) => {
        facts[0] = { ...facts[0], status: "ready" } as unknown as TaskStatusFact;
      },
    ],
    [
      "extra accepted field",
      (facts: TaskStatusFact[]) => {
        facts[0] = { ...accepted("task_a", "a"), completionOrder: 1 } as unknown as TaskStatusFact;
      },
    ],
  ] as const)("rejects %s task status facts", (_name, mutate) => {
    const facts = initialFacts();
    mutate(facts);
    expect(() => deriveReadyTaskFrontier(readinessGraph(), facts, deterministicSha256)).toThrow(
      ReadinessError,
    );
  });
});

function readinessGraph() {
  return compileWorkflowGraph(readinessInput(), deterministicSha256);
}

function readinessInput(): NormalizedWorkflowInput {
  const phase = phaseId("phase_work");
  const tasks = [
    taskDefinition("task_a", [], []),
    taskDefinition("task_b", [], []),
    taskDefinition("task_c", ["task_a"], ["task_old"]),
    taskDefinition("task_d", ["task_b"], []),
    taskDefinition("task_old", [], []),
  ];
  return {
    workflow: {
      id: workflowId("workflow_ready"),
      key: consumerKey("ready"),
      generation: definitionGeneration(1),
      source: { locator: "fixture://readiness", pointer: "/workflow" },
    },
    phases: [
      {
        id: phase,
        key: consumerKey("work"),
        generation: definitionGeneration(1),
        parentId: workflowId("workflow_ready"),
        source: { locator: "fixture://readiness", pointer: "/phases/work" },
      },
    ],
    executableWork: tasks.map((task) => ({ ...task, parentId: phase })),
    criteria: tasks.map((task) => ({
      id: criterionId(`criterion_${task.id.slice("task_".length)}`),
      key: consumerKey(task.key),
      generation: definitionGeneration(1),
      parentId: task.id,
      source: { locator: "fixture://readiness", pointer: `/criteria/${task.key}` },
    })),
  };
}

function taskDefinition(idValue: string, dependencies: string[], supersedes: string[]) {
  const id = taskId(idValue);
  const key = consumerKey(idValue.slice("task_".length));
  const completionPolicy: CompletionPolicy = {
    criteria: [
      {
        criterionId: criterionId(`criterion_${idValue.slice("task_".length)}`),
        required: true,
      },
    ],
    completionEvidencePolicy: { mode: "none", requirements: [] },
  };
  return {
    id,
    key,
    generation: definitionGeneration(idValue === "task_c" ? 2 : 1),
    source: { locator: "fixture://readiness", pointer: `/tasks/${key}` },
    dependsOn: dependencies.map(taskId),
    supersedes: supersedes.map(taskId),
    completionPolicy,
  };
}

function initialFacts(): TaskStatusFact[] {
  return ["task_a", "task_b", "task_c", "task_d", "task_old"].map((idValue) => ({
    taskId: taskId(idValue),
    definitionGeneration: definitionGeneration(idValue === "task_c" ? 2 : 1),
    status: "pending",
  }));
}

function accepted(
  idValue: string,
  digestCharacter: string,
): Extract<TaskStatusFact, { readonly status: "accepted" }> {
  return {
    taskId: taskId(idValue),
    definitionGeneration: definitionGeneration(1),
    status: "accepted",
    accountingAssessmentDigest: digest(digestCharacter),
  };
}
