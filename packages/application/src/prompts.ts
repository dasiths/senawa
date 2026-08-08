import {
  type JsonValue,
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
  const artifactSchema = JSON.parse(schemaFile.content) as { readonly $id?: unknown };
  const authoring = authoringExpectations(artifactSchema.$id);
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
      ...(authoring === undefined ? {} : { authoring }),
      artifactSchema,
    },
  });
}

interface AuthoringExpectation {
  readonly instruction: string;
  readonly expectedFields: readonly string[];
  readonly rules: readonly string[];
}

const AUTHORING_EXPECTATIONS: Readonly<Record<string, AuthoringExpectation>> = {
  "https://senawa.dev/schemas/definition/v1": {
    instruction:
      "Populate the optional structure. A definition that carries only summary, inScope, and acceptanceCriteria is schema-valid but too thin to plan from.",
    expectedFields: [
      "problemStatement",
      "currentBehavior",
      "desiredBehavior",
      "nonGoals",
      "assumptions",
      "risks",
      "evidenceNeeded",
      "openQuestions",
    ],
    rules: [
      "State the problem so a reader can disagree with it, and separate current behavior from desired behavior.",
      "Give every acceptance criterion a stable id and say how it will be measured through the structured criterion form.",
      "Mark an open question blocking only when planning genuinely cannot proceed without the answer.",
      "Every risk needs a mitigation. Do not record a risk you have no answer for; record it as an open question instead.",
    ],
  },
  "https://senawa.dev/schemas/research/v1": {
    instruction:
      "Findings carry identity so downstream artifacts can cite them. Record what the evidence does not prove.",
    expectedFields: ["questions", "alternatives", "risks", "unknowns"],
    rules: [
      "Give every finding an id, and use limits to say what that finding does not prove.",
      "Answer the definition's evidenceNeeded questions and link each finding back through answers.",
      "Every recommendation cites the finding ids that support it through basis.",
      "Record rejected alternatives with the rationale that rejected them, not only the option you chose.",
      "Classify evidenceKind honestly: measured, offline, live-model, simulated, or documentation.",
    ],
  },
  "https://senawa.dev/schemas/plan/v1": {
    instruction:
      "Produce ordered phases with todos, not a flat task list. Phases order the task frontier at import.",
    expectedFields: [
      "objectives",
      "phases",
      "decisions",
      "dependencies",
      "risks",
      "successCriteria",
      "validation",
    ],
    rules: [
      "Every phase declares an id, a title, ordered todos, and the phases it depends on.",
      "If the plan declares phases, every task must name a phase. A partly phased plan is refused.",
      "Senawa expands each task's dependsOn with the tasks of its predecessor phases, so do not restate that ordering by hand.",
      "parallelizable is an authoring signal only: the task frontier runs one task at a time today.",
      "Every decision carries the rationale that produced it and, where a real option was discarded, alternativesRejected.",
      "validation entries are declarative documentation. Only configured gate sensors execute anything.",
    ],
  },
  "https://senawa.dev/schemas/verification/v1": {
    instruction:
      "Map checks to the criteria and phases they prove, and record honest limits where they belong.",
    expectedFields: ["criteria", "phases", "deviations"],
    rules: [
      "Give every check an id, then reference those ids from criteria and phases.",
      "Cover every required definition criterion in criteria, with the source that declared it.",
      "Record an honest limit as a deviation. findings is for unresolved problems and fails the gate.",
      "Never claim a check you did not run.",
    ],
  },
};

function authoringExpectations(schemaId: unknown): AuthoringExpectation | undefined {
  return typeof schemaId === "string" ? AUTHORING_EXPECTATIONS[schemaId] : undefined;
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

export interface PromptCapabilityReport {
  readonly granted: readonly string[];
  readonly unavailable: readonly string[];
}

export function createTaskPrompt(
  state: RuntimeState,
  task: RuntimeTask,
  attempt: number,
  inputManifest: ResolvedInputManifest = {
    version: 1,
    inputs: task.inheritedInputs ?? [],
  },
  capabilities?: PromptCapabilityReport,
): string {
  const dependencyOutcomes = task.dependsOn.map((dependency) => {
    const resolved = state.tasks.find((candidate) => candidate.key === dependency);
    return {
      key: dependency,
      status: resolved?.status ?? "missing",
      attempt: resolved?.attempt ?? 0,
    };
  });
  const planContext = resolvePlanContext(task, inputManifest);
  return JSON.stringify({
    kind: "task",
    task: task.key,
    title: task.title,
    attempt,
    goal: state.identity.request.goal,
    constraints: state.identity.request.constraints,
    role: task.role,
    suggestedPaths: task.paths,
    ...(capabilities === undefined ? {} : { capabilities: capabilityBlock(capabilities) }),
    repositoryChange: effectiveRepositoryChange(state, task),
    acceptanceCriteria: normalizeAcceptance(task.acceptance),
    completion: {
      tool: "senawa.task.done",
      instruction:
        "Before ending the turn, report an outcome and an account of what you did for every required acceptance criterion, addressed by its id. Senawa records what you state; it does not verify it, so an omission is lost work.",
      evidenceKinds: {
        file: "A repository-relative path with a relationship of created, modified, deleted, reviewed, validated, or referenced.",
        sensor: "A gate sensor id that ran for this attempt.",
        command: "A command that exactly matches a configured gate sensor command.",
        "repository-delta":
          "scope in-scope when this attempt changed files, or none when it changed nothing.",
      },
      resolutionRules: [
        "suggestedPaths indicate where this work is expected to land. Edit whatever the task actually requires; writing elsewhere is recorded, not refused.",
        "Frozen paths are the one hard boundary: worker profiles, workflows, schemas, and sensor policy cannot be edited.",
        "Every required criterion needs an outcome and a short account of what you did.",
        "blocked and not-applicable are honest outcomes, but they never satisfy a required criterion.",
      ],
      submissionSchema: TASK_COMPLETION_SUBMISSION_JSON_SCHEMA,
    },
    sourcePlan: task.sourcePlan ?? null,
    ...(planContext === undefined ? {} : { planContext }),
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

function capabilityBlock(capabilities: PromptCapabilityReport) {
  const instructions = [
    "Only the granted capabilities are available in this session. A capability that is not granted is denied by the worker host and cannot be obtained.",
    "Never claim an acceptance criterion that needs an unavailable capability. Report that criterion as blocked and name the missing capability.",
  ];
  if (!capabilities.granted.includes("process.run")) {
    instructions.push(
      "This session cannot execute commands. `command` evidence resolves only through configured gate sensors that run after this turn.",
    );
  }
  return {
    granted: capabilities.granted,
    unavailable: capabilities.unavailable,
    instructions,
  };
}

/**
 * A bounded projection of the task's own plan phase. The manifest already carries the whole
 * plan, so this block exists to point the worker at its phase, not to restate the plan.
 */
function resolvePlanContext(task: RuntimeTask, inputManifest: ResolvedInputManifest) {
  if (task.phase === undefined) return undefined;
  const sourcePlan = inputManifest.inputs.find((input) => input.name === "source-plan");
  if (sourcePlan === undefined) return undefined;
  const declared = Reflect.get(sourcePlan.content, "phases");
  if (!Array.isArray(declared)) return undefined;
  const phases = declared.filter(
    (entry): entry is Record<string, JsonValue> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  const current = phases.find((entry) => Reflect.get(entry, "id") === task.phase);
  if (current === undefined) return undefined;
  return {
    instruction:
      "This is the plan phase that owns this task. Stay inside it; the full plan is in the input manifest.",
    phase: {
      id: task.phase,
      title: Reflect.get(current, "title") ?? null,
      intent: Reflect.get(current, "intent") ?? null,
      todos: Reflect.get(current, "todos") ?? [],
      exitCriteria: Reflect.get(current, "exitCriteria") ?? [],
      validation: Reflect.get(current, "validation") ?? [],
    },
    phaseOrder: phases.flatMap((entry) => {
      const id = Reflect.get(entry, "id");
      return typeof id === "string" ? [id] : [];
    }),
  };
}
