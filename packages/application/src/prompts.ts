import type { RuntimePhase, RuntimeState, RuntimeTask } from "@senawa/domain";

export function createPhasePrompt(
  state: Pick<RuntimeState, "artifacts" | "identity" | "phases" | "snapshot">,
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
  const schemaPath = resolveSnapshotPath(".senawa/workflows", definition.executor.output.schema);
  const schemaFile = state.snapshot.files.find((file) => file.path === schemaPath);
  if (schemaFile === undefined) {
    throw new Error(`Phase ${phase.id} frozen output schema is missing: ${schemaPath}`);
  }
  const dependencyArtifacts = Object.fromEntries(
    definition.dependsOn.flatMap((dependency) => {
      const artifact = state.artifacts
        .filter((candidate) => candidate.phaseId === dependency)
        .sort((left, right) => right.version - left.version)[0];
      return artifact === undefined ? [] : [[dependency, artifact.content]];
    }),
  );
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
    dependencyArtifacts,
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
