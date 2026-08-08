import {
  normalizeAcceptance,
  type ResolvedInputManifest,
  type RuntimePhase,
  type RuntimeState,
  type RuntimeTask,
  TASK_COMPLETION_SUBMISSION_JSON_SCHEMA,
} from "@senawa/domain";
import { effectiveRepositoryChange } from "./repository-change.js";

export function createPhasePrompt(
  state: Pick<RuntimeState, "artifacts" | "identity" | "phases" | "snapshot">,
  phase: RuntimePhase,
  iteration: number,
  inputManifest: ResolvedInputManifest = { version: 1, inputs: [] },
): string {
  const definition = state.snapshot.workflow.spec.phases.find(
    (candidate) => candidate.id === phase.id,
  );
  if (definition === undefined) throw new Error(`Unknown workflow phase ${phase.id}`);
  if (definition.executor.kind !== "agent") {
    throw new Error(`Phase ${phase.id} does not have an agent output contract`);
  }
  const schemaPath = resolveSnapshotPath(".senawa/workflows", definition.executor.output.schema);
  const schemaFile = state.snapshot.files.find((file) => file.path === schemaPath);
  if (schemaFile === undefined) {
    throw new Error(`Phase ${phase.id} frozen output schema is missing: ${schemaPath}`);
  }
  const dependencyPhases = Object.fromEntries(
    definition.dependsOn.map((dependency) => {
      const runtimePhase = state.phases.find((candidate) => candidate.id === dependency);
      if (runtimePhase === undefined) throw new Error(`Unknown dependency phase ${dependency}`);
      return [dependency, { status: runtimePhase.status, iteration: runtimePhase.iteration }];
    }),
  );
  const taskFrontier = state.snapshot.workflow.spec.phases.find(
    (candidate) => candidate.executor.kind === "task-frontier",
  );
  return JSON.stringify({
    kind: "phase",
    phase: phase.id,
    iteration,
    goal: state.identity.request.goal,
    rejectionReason: phase.rejectionReason,
    repository: {
      pathConvention:
        "Use repository-relative paths only. Never guess an absolute repository root.",
    },
    dependencyPhases,
    inputManifest,
    ...(definition.actions?.some((action) => action.kind === "import-plan") &&
    taskFrontier?.executor.kind === "task-frontier"
      ? {
          taskPlanning: {
            requiredRole: taskFrontier.executor.role,
            instruction: "Every planned task must use this configured task-frontier role.",
          },
        }
      : {}),
    submission: {
      tool: "senawa.phase.submit",
      instruction: "Submit exactly one artifact matching this frozen JSON Schema.",
      artifactSchema: JSON.parse(schemaFile.content),
    },
  });
}

function resolveSnapshotPath(base: string, reference: string): string {
  const parts = base.split("/").filter(Boolean);
  for (const segment of reference.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.pop() === undefined)
        throw new Error(`Snapshot path escapes repository: ${reference}`);
      continue;
    }
    parts.push(segment);
  }
  if (parts.length === 0) throw new Error(`Snapshot path is empty: ${reference}`);
  return parts.join("/");
}

export function createTaskPrompt(
  state: RuntimeState,
  task: RuntimeTask,
  attempt: number,
  inputManifest: ResolvedInputManifest = {
    version: 1,
    inputs: task.inheritedInputs ?? [],
  },
): string {
  const dependencyOutcomes = task.dependsOn.map((dependency) => {
    const resolved = state.tasks.find((candidate) => candidate.key === dependency);
    return {
      key: dependency,
      status: resolved?.status ?? "missing",
      attempt: resolved?.attempt ?? 0,
    };
  });
  return JSON.stringify({
    kind: "task",
    task: task.key,
    title: task.title,
    attempt,
    goal: state.identity.request.goal,
    constraints: state.identity.request.constraints,
    role: task.role,
    paths: task.paths,
    repositoryChange: effectiveRepositoryChange(state, task),
    acceptanceCriteria: normalizeAcceptance(task.acceptance),
    completion: {
      tool: "senawa.task.done",
      instruction:
        "Before ending the turn, report an outcome and resolving evidence for every required acceptance criterion, addressed by its id.",
      evidenceKinds: {
        file: "A repository-relative path with a relationship of created, modified, deleted, reviewed, validated, or referenced.",
        sensor: "A gate sensor id that ran for this attempt.",
        command: "A command that exactly matches a configured gate sensor command.",
        "repository-delta":
          "scope in-scope when this attempt changed authorized files, or none when it changed nothing.",
      },
      resolutionRules: [
        "created, modified, and deleted resolve only against the measured in-scope repository delta for this attempt.",
        "reviewed and referenced are advisory: Senawa records them but never accepts them as proof on their own.",
        "validated resolves only against a blocking gate sensor that covers the path.",
        "Any path outside the authorized paths, or inside a frozen path, refuses the criterion.",
        "blocked and not-applicable never satisfy a required criterion.",
      ],
      submissionSchema: TASK_COMPLETION_SUBMISSION_JSON_SCHEMA,
    },
    sourcePlan: task.sourcePlan ?? null,
    inputManifest,
    dependencyOutcomes,
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
