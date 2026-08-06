import { posix } from "node:path";
import type { RuntimePhase, RuntimeState, RuntimeTask } from "@senawa/domain";

export function createPhasePrompt(
  state: Pick<RuntimeState, "identity" | "snapshot">,
  phase: RuntimePhase,
  iteration: number,
): string {
  const definition = state.snapshot.workflow.spec.phases.find(
    (candidate) => candidate.id === phase.id,
  );
  if (definition === undefined) throw new Error(`Unknown workflow phase ${phase.id}`);
  if (definition.executor.kind !== "agent") {
    throw new Error(`Phase ${phase.id} does not have an agent output contract`);
  }
  const schemaPath = posix.normalize(
    posix.join(".senawa/workflows", definition.executor.output.schema),
  );
  const schemaFile = state.snapshot.files.find((file) => file.path === schemaPath);
  if (schemaFile === undefined) {
    throw new Error(`Phase ${phase.id} frozen output schema is missing: ${schemaPath}`);
  }
  return JSON.stringify({
    kind: "phase",
    phase: phase.id,
    iteration,
    goal: state.identity.request.goal,
    rejectionReason: phase.rejectionReason,
    submission: {
      tool: "senawa.phase.submit",
      instruction: "Submit exactly one artifact matching this frozen JSON Schema.",
      artifactSchema: JSON.parse(schemaFile.content),
    },
  });
}

export function createTaskPrompt(state: RuntimeState, task: RuntimeTask, attempt: number): string {
  return JSON.stringify({
    kind: "task",
    task: task.key,
    attempt,
    goal: state.identity.request.goal,
    paths: task.paths,
    acceptance: task.acceptance,
    steering: task.steering,
    gateFeedback:
      task.reworkFeedback ??
      (task.reworkFindings === undefined || task.reworkFindings.length === 0
        ? null
        : {
            findings: task.reworkFindings,
            nextPrompt: "Address every finding, then request completion again.",
          }),
  });
}
