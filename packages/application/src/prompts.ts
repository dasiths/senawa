import type { RuntimePhase, RuntimeState, RuntimeTask } from "@senawa/domain";

export function createPhasePrompt(
  state: RuntimeState,
  phase: RuntimePhase,
  iteration: number,
): string {
  return JSON.stringify({
    kind: "phase",
    phase: phase.id,
    iteration,
    goal: state.identity.request.goal,
    rejectionReason: phase.rejectionReason,
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
