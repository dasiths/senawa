import type {
  JournalEvent,
  JsonObject,
  RuntimeArtifact,
  RuntimeDispatch,
  RuntimePhase,
  RuntimeState,
  RuntimeTask,
} from "@senawa/domain";
import { artifactDigest } from "./input-manifests.js";

export interface OpenWorkerQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly askedAt: string;
  readonly askedSeq: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly ownerKind: "phase" | "task";
  readonly ownerId: string;
  readonly status: "answerable" | "stale";
}

export function projectOpenWorkerQuestions(state: RuntimeState): readonly OpenWorkerQuestion[] {
  const answered = new Set(
    state.journal
      .filter((event) => event.event === "question.answered")
      .map((event) => Reflect.get(event.data, "questionId"))
      .filter((questionId): questionId is string => typeof questionId === "string"),
  );
  return state.journal
    .filter((event) => event.event === "question.asked")
    .flatMap((event) => projectOpenWorkerQuestion(state, event, answered));
}

function projectOpenWorkerQuestion(
  state: RuntimeState,
  event: JournalEvent,
  answered: ReadonlySet<string>,
): readonly OpenWorkerQuestion[] {
  const questionId = Reflect.get(event.data, "questionId");
  const question = Reflect.get(event.data, "question");
  const sessionId = Reflect.get(event.data, "sessionId");
  const turnId = Reflect.get(event.data, "turnId");
  const ownerKind = Reflect.get(event.data, "ownerKind");
  const ownerId = Reflect.get(event.data, "ownerId");
  if (
    event.actor.channel !== "worker" ||
    typeof questionId !== "string" ||
    typeof question !== "string" ||
    typeof sessionId !== "string" ||
    typeof turnId !== "string" ||
    (ownerKind !== "phase" && ownerKind !== "task") ||
    typeof ownerId !== "string" ||
    answered.has(questionId)
  ) {
    return [];
  }
  const active = state.activeTurn;
  return [
    {
      questionId,
      question,
      askedAt: event.ts,
      askedSeq: event.seq,
      sessionId,
      turnId,
      ownerKind,
      ownerId,
      status:
        state.status === "running" &&
        active?.sessionId === sessionId &&
        active.turnId === turnId &&
        active.ownerKind === ownerKind &&
        active.ownerId === ownerId
          ? "answerable"
          : "stale",
    },
  ];
}

export type RunStatusNeed =
  | {
      readonly action: "approve-or-reject";
      readonly phaseId: string;
      readonly artifact: string;
    }
  | {
      readonly action: "answer-question";
      readonly questionId: string;
      readonly question: string;
      readonly ownerKind: "phase" | "task";
      readonly ownerId: string;
      readonly askedAt: string;
      readonly answerCommand: string;
    };

export interface RunStatusProjection {
  readonly runId: string;
  readonly backend: RuntimeState["identity"]["backend"];
  readonly workerHost: RuntimeState["identity"]["workerHost"];
  readonly workflow: string;
  readonly status: RuntimeState["status"];
  readonly needs: RunStatusNeed | null;
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

export interface PhaseBriefProjection {
  readonly runId: string;
  readonly backend: RuntimeState["identity"]["backend"];
  readonly phase: string;
  readonly status: RuntimePhase["status"];
  readonly iteration: number;
  readonly artifactVersion: number | null;
  readonly needs: RunStatusProjection["needs"];
  readonly artifact: null | {
    readonly path: string;
    readonly version: number;
    readonly digest: string;
    readonly kind: string;
    readonly createdAt: string;
    readonly declared: {
      readonly summary?: { readonly value: string; readonly attribution: "artifact-declared" };
      readonly verdict?: { readonly value: string; readonly attribution: "artifact-declared" };
    };
    readonly counts: ReadonlyArray<{ readonly name: string; readonly count: number }>;
    readonly fullArtifactCommand: string;
  };
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
    workerHost: state.identity.workerHost,
    workflow: state.identity.workflow,
    status: state.status,
    needs: projectRunNeed(state, awaiting),
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
      parentPhaseId: taskFrontierPhaseId(state, task),
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

// A live worker question outranks approval: it blocks a running turn right now.
function projectRunNeed(
  state: RuntimeState,
  awaiting: RuntimePhase | undefined,
): RunStatusNeed | null {
  const pending = projectOpenWorkerQuestions(state)
    .filter((question) => question.status === "answerable")
    .sort((left, right) => left.askedSeq - right.askedSeq)[0];
  if (pending !== undefined) {
    return {
      action: "answer-question",
      questionId: pending.questionId,
      question: truncate(pending.question, 500),
      ownerKind: pending.ownerKind,
      ownerId: pending.ownerId,
      askedAt: pending.askedAt,
      answerCommand: `senawa answer ${pending.questionId} "<answer>" --run ${state.identity.runId}`,
    };
  }
  if (awaiting === undefined || awaiting.artifactVersion === null) return null;
  return {
    action: "approve-or-reject",
    phaseId: awaiting.id,
    artifact: `artifacts/${awaiting.id}/v${awaiting.artifactVersion}.json`,
  };
}

export function projectPhaseBrief(state: RuntimeState, phaseId: string): PhaseBriefProjection {
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) throw new Error(`Unknown phase ${phaseId}`);
  const artifact =
    phase.artifactVersion === null
      ? undefined
      : state.artifacts.find(
          (candidate) =>
            candidate.phaseId === phaseId && candidate.version === phase.artifactVersion,
        );
  const needs = projectRunStatus(state).needs;
  return {
    runId: state.identity.runId,
    backend: state.identity.backend,
    phase: phase.id,
    status: phase.status,
    iteration: phase.iteration,
    artifactVersion: phase.artifactVersion,
    needs:
      needs?.action === "approve-or-reject" && needs.phaseId === phaseId
        ? needs
        : needs?.action === "answer-question" &&
            needs.ownerKind === "phase" &&
            needs.ownerId === phaseId
          ? needs
          : null,
    artifact: artifact === undefined ? null : projectArtifactOverview(state, artifact),
  };
}

function projectArtifactOverview(state: RuntimeState, artifact: RuntimeArtifact) {
  const content = artifact.content as JsonObject & {
    readonly summary?: unknown;
    readonly verdict?: unknown;
  };
  const summary = typeof content.summary === "string" ? truncate(content.summary, 500) : undefined;
  const verdict = typeof content.verdict === "string" ? truncate(content.verdict, 80) : undefined;
  return {
    path: artifact.path,
    version: artifact.version,
    digest: artifactDigest(artifact.content),
    kind: artifactKind(state, artifact.phaseId),
    createdAt: artifact.createdAt,
    declared: {
      ...(summary === undefined
        ? {}
        : { summary: { value: summary, attribution: "artifact-declared" as const } }),
      ...(verdict === undefined
        ? {}
        : { verdict: { value: verdict, attribution: "artifact-declared" as const } }),
    },
    counts: artifactCounts(artifact.content),
    fullArtifactCommand: `senawa phase artifact ${artifact.phaseId} --run ${state.identity.runId} --version ${artifact.version}`,
  };
}

function artifactKind(state: RuntimeState, phaseId: string): string {
  const executor = workflowPhase(state, phaseId).executor;
  return executor.kind === "agent" ? executor.output.schema : "non-agent-executor";
}

function artifactCounts(content: JsonObject): ReadonlyArray<{ name: string; count: number }> {
  const tasks = Reflect.get(content, "tasks");
  if (Array.isArray(tasks)) {
    return [
      { name: "tasks", count: tasks.length },
      ...(["required", "optional", "forbidden"] as const).map((expectation) => ({
        name: `tasks.repositoryChange.${expectation}`,
        count: tasks.filter(
          (task) =>
            task !== null &&
            typeof task === "object" &&
            !Array.isArray(task) &&
            Reflect.get(task, "repositoryChange") === expectation,
        ).length,
      })),
    ];
  }
  const findings = Reflect.get(content, "findings");
  if (Array.isArray(findings) && findings.some(isResearchEvidence)) {
    return [
      { name: "findings", count: findings.length },
      ...(["measured", "offline", "live-model", "simulated", "documentation"] as const).map(
        (kind) => ({
          name: `findings.evidenceKind.${kind}`,
          count: findings.filter(
            (finding) => isResearchEvidence(finding) && finding.evidenceKind === kind,
          ).length,
        }),
      ),
      { name: "constraints", count: arrayLength(Reflect.get(content, "constraints")) },
    ];
  }
  const checks = Reflect.get(content, "checks");
  if (Array.isArray(checks)) {
    return [
      { name: "checks", count: checks.length },
      ...(["pass", "fail", "error"] as const).map((verdict) => ({
        name: `checks.verdict.${verdict}`,
        count: checks.filter(
          (check) =>
            check !== null &&
            typeof check === "object" &&
            !Array.isArray(check) &&
            Reflect.get(check, "verdict") === verdict,
        ).length,
      })),
      { name: "findings", count: arrayLength(findings) },
    ];
  }
  return [
    { name: "inScope", count: arrayLength(Reflect.get(content, "inScope")) },
    { name: "outOfScope", count: arrayLength(Reflect.get(content, "outOfScope")) },
    {
      name: "acceptanceCriteria",
      count: arrayLength(Reflect.get(content, "acceptanceCriteria")),
    },
    { name: "constraints", count: arrayLength(Reflect.get(content, "constraints")) },
    { name: "openQuestions", count: arrayLength(Reflect.get(content, "openQuestions")) },
  ];
}

function isResearchEvidence(value: unknown): value is { readonly evidenceKind: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "evidenceKind") === "string"
  );
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function workflowPhase(state: RuntimeState, phaseId: string) {
  const phase = state.snapshot.workflow.spec.phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) throw new Error(`Unknown workflow phase ${phaseId}`);
  return phase;
}

function taskFrontierPhaseId(state: RuntimeState, task: RuntimeTask): string {
  const frontiers = state.snapshot.workflow.spec.phases.filter(
    (phase) => phase.executor.kind === "task-frontier",
  );
  const matchingRole = frontiers.filter(
    (phase) => phase.executor.kind === "task-frontier" && phase.executor.role === task.role,
  );
  const roleMatch = matchingRole[0];
  if (matchingRole.length === 1 && roleMatch !== undefined) return roleMatch.id;
  const onlyFrontier = frontiers[0];
  if (frontiers.length === 1 && onlyFrontier !== undefined) return onlyFrontier.id;
  throw new Error(`Task ${task.key} does not map to one task-frontier phase`);
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
