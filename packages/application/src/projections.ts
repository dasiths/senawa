import type { RuntimeDispatch, RuntimePhase, RuntimeState, RuntimeTask } from "@senawa/domain";

export interface RunStatusProjection {
  readonly runId: string;
  readonly backend: RuntimeState["identity"]["backend"];
  readonly workflow: string;
  readonly status: RuntimeState["status"];
  readonly needs: null | {
    readonly action: "approve-or-reject";
    readonly phaseId: string;
    readonly artifact: string;
  };
  readonly progress: { readonly phases: string; readonly tasks: string };
  readonly phases: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly executorKind: "agent" | "task-frontier" | "sensor-only" | "human" | "foreach";
    readonly dependsOn: readonly string[];
    readonly status: RuntimePhase["status"];
    readonly iteration: number;
    readonly artifactVersion: number | null;
  }>;
  readonly tasks: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly role: string;
    readonly parentPhaseId: string;
    readonly dependsOn: readonly string[];
    readonly status: RuntimeTask["status"];
    readonly attempt: number;
    readonly dispatchFailures: number;
  }>;
  readonly unsettledDispatch: null | {
    readonly dispatchId: string;
    readonly operationId: string;
    readonly turnId: string;
    readonly sessionId: string;
    readonly ownerKind: "phase" | "task";
    readonly ownerId: string;
    readonly status: RuntimeDispatch["status"];
    readonly detail: string | null;
    readonly operatorAction: string;
  };
  readonly frontier: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly role: string;
  }>;
  readonly cursor: number;
  readonly outputCursor: number;
  readonly endReason: string | null;
}

export function projectRunStatus(state: RuntimeState): RunStatusProjection {
  const awaiting = state.phases.find((phase) => phase.status === "awaiting_approval");
  const acceptedPhases = state.phases.filter((phase) => phase.status === "accepted").length;
  const closedTasks = state.tasks.filter((task) => task.status === "closed").length;
  const unsettledDispatch =
    state.activeTurn === null
      ? undefined
      : state.dispatches.find((dispatch) => dispatch.dispatchId === state.activeTurn?.dispatchId);
  const frontier = state.tasks
    .filter(
      (task) =>
        (task.status === "pending" || task.status === "rework") &&
        task.dependsOn.every(
          (dependency) =>
            state.tasks.find((candidate) => candidate.key === dependency)?.status === "closed",
        ),
    )
    .slice(0, 10)
    .map((task) => ({ key: task.key, title: truncate(task.title, 160), role: task.role }));
  return {
    runId: state.identity.runId,
    backend: state.identity.backend,
    workflow: state.identity.workflow,
    status: state.status,
    needs:
      awaiting === undefined || awaiting.artifactVersion === null
        ? null
        : {
            action: "approve-or-reject",
            phaseId: awaiting.id,
            artifact: `artifacts/${awaiting.id}/v${awaiting.artifactVersion}.json`,
          },
    progress: {
      phases: `${acceptedPhases}/${state.phases.length} accepted`,
      tasks: `${closedTasks}/${state.tasks.length} closed`,
    },
    phases: state.phases.slice(0, 12).map((phase) => {
      const definition = workflowPhase(state, phase.id);
      const executor = definition.executor;
      return {
        id: phase.id,
        role:
          executor.kind === "sensor-only"
            ? "sensor"
            : "role" in executor
              ? executor.role
              : executor.kind,
        executorKind: executor.kind,
        dependsOn: definition.dependsOn,
        status: phase.status,
        iteration: phase.iteration,
        artifactVersion: phase.artifactVersion,
      };
    }),
    tasks: state.tasks.slice(0, 12).map((task) => ({
      key: task.key,
      title: truncate(task.title, 160),
      role: task.role,
      parentPhaseId: "implement",
      dependsOn: task.dependsOn,
      status: task.status,
      attempt: task.attempt,
      dispatchFailures: task.dispatchFailures,
    })),
    unsettledDispatch:
      unsettledDispatch === undefined
        ? null
        : {
            dispatchId: unsettledDispatch.dispatchId,
            operationId: unsettledDispatch.operationId,
            turnId: unsettledDispatch.turnId,
            sessionId: unsettledDispatch.sessionId,
            ownerKind: unsettledDispatch.ownerKind,
            ownerId: unsettledDispatch.ownerId,
            status: unsettledDispatch.status,
            detail: unsettledDispatch.detail ?? null,
            operatorAction: dispatchOperatorAction(unsettledDispatch),
          },
    frontier,
    cursor: state.journal.at(-1)?.seq ?? 0,
    outputCursor: Object.values(state.outputs).reduce(
      (total, records) => total + records.length,
      0,
    ),
    endReason: state.endReason === null ? null : truncate(state.endReason, 500),
  };
}

function workflowPhase(state: RuntimeState, phaseId: string) {
  const phase = state.snapshot.workflow.spec.phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) throw new Error(`Unknown workflow phase ${phaseId}`);
  return phase;
}

function dispatchOperatorAction(dispatch: RuntimeDispatch): string {
  if (dispatch.status === "active") {
    return "Wait for the worker turn to finish or cancel it in the worker host before resuming";
  }
  if (dispatch.status === "unknown") {
    return "Inspect or cancel the worker turn in the worker host before resuming";
  }
  return "Resume the run to reconcile the recorded worker operation";
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}
