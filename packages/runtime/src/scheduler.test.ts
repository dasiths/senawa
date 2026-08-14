import { describe, expect, it } from "vitest";
import {
  effectiveWriterLimit,
  planFailurePolicyActions,
  planReadySiblingBatch,
  type ReadyEffectFact,
  type ReadyTaskFact,
} from "./scheduler.js";

const worktreePolicy = Object.freeze({
  workspaceMode: "worktree" as const,
  maxWriterConcurrency: 4,
  failurePolicy: "continue" as const,
});

describe("runtime sibling scheduler", () => {
  it("uses the minimum workflow, supervisor, host, and durable writer limit", () => {
    expect(
      effectiveWriterLimit(worktreePolicy, {
        supervisorWriterLimit: 3,
        hostWriterLimit: 2,
        availableDurableWriterCapacity: 1,
      }),
    ).toBe(1);
    expect(
      effectiveWriterLimit(worktreePolicy, {
        supervisorWriterLimit: 3,
        hostWriterLimit: 2,
        availableDurableWriterCapacity: 0,
      }),
    ).toBe(0);
  });

  it("forces repository mode to one writer", () => {
    expect(
      effectiveWriterLimit(
        { workspaceMode: "repository", maxWriterConcurrency: 1, failurePolicy: "continue" },
        {
          supervisorWriterLimit: 8,
          hostWriterLimit: 8,
          availableDurableWriterCapacity: 8,
        },
      ),
    ).toBe(1);
  });

  it("plans the same stable bounded sibling set for every fact permutation", () => {
    const tasks: readonly ReadyTaskFact[] = [
      { taskId: "task-c", definitionGeneration: 1 },
      { taskId: "task-a", definitionGeneration: 2 },
      { taskId: "task-b", definitionGeneration: 1 },
    ];
    const effects: readonly ReadyEffectFact[] = [
      { taskId: "task-b", operationId: "operation-b", status: "queued" },
      { taskId: "task-c", operationId: "operation-c", status: "queued" },
      { taskId: "task-a", operationId: "operation-a", status: "queued" },
      { taskId: "task-z", operationId: "operation-active", status: "active" },
    ];
    const schedules = permutations(tasks).flatMap((taskPermutation) =>
      permutations(effects).map((effectPermutation) =>
        planReadySiblingBatch(
          worktreePolicy,
          {
            supervisorWriterLimit: 2,
            hostWriterLimit: 3,
            availableDurableWriterCapacity: 4,
          },
          taskPermutation,
          effectPermutation,
        ),
      ),
    );

    expect(new Set(schedules.map((schedule) => JSON.stringify(schedule))).size).toBe(1);
    expect(schedules[0]).toEqual({
      effectiveWriterLimit: 2,
      members: [
        { taskId: "task-a", definitionGeneration: 2, operationId: "operation-a" },
        { taskId: "task-b", definitionGeneration: 1, operationId: "operation-b" },
      ],
    });
  });

  it("defines deterministic continue and fail-fast actions", () => {
    const siblings = [
      { taskId: "task-c", operationId: "operation-c", status: "active" as const },
      { taskId: "task-a", operationId: "operation-a", status: "failed" as const },
      { taskId: "task-b", operationId: "operation-b", status: "queued" as const },
    ];

    expect(planFailurePolicyActions("continue", siblings)).toEqual([
      { type: "fence-task", taskId: "task-a" },
    ]);
    expect(planFailurePolicyActions("fail-fast", siblings)).toEqual([
      { type: "stop-new-writer-admission" },
      { type: "fence-task", taskId: "task-a" },
      { type: "fence-task", taskId: "task-b" },
      { type: "fence-task", taskId: "task-c" },
      { type: "request-cancellation", operationId: "operation-c" },
    ]);
  });
});

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((remaining) => [
      value,
      ...remaining,
    ]),
  );
}
