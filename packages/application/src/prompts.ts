import type {
  ResolvedInputManifest,
  RuntimePhase,
  RuntimeState,
  RuntimeTask,
} from "@senawa/domain";

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
    repositoryChange: task.repositoryChange,
    acceptance: task.acceptance,
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
