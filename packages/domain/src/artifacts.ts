import { z } from "zod";
import {
  ArtifactIdSchema,
  IdentifierSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
} from "./common.js";

export const WorkRequestSchema = z
  .object({
    goal: NonEmptyStringSchema,
    repository: NonEmptyStringSchema.optional(),
    constraints: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export const EvidenceKindSchema = z.enum([
  "measured",
  "offline",
  "live-model",
  "simulated",
  "documentation",
]);

export const LevelSchema = z.enum(["high", "medium", "low"]);

export const RiskSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    description: NonEmptyStringSchema.max(500),
    likelihood: LevelSchema.optional(),
    impact: LevelSchema.optional(),
    mitigation: NonEmptyStringSchema.max(500),
    owner: NonEmptyStringSchema.max(200).optional(),
  })
  .strict();

export const ConstraintEntrySchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    statement: NonEmptyStringSchema.max(500),
    source: NonEmptyStringSchema.max(300).optional(),
    kind: z.enum(["policy", "technical", "process", "external"]).optional(),
  })
  .strict();

export const OpenQuestionEntrySchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    question: NonEmptyStringSchema.max(500),
    blocking: z.boolean().default(false),
    owner: NonEmptyStringSchema.max(200).optional(),
    resolution: NonEmptyStringSchema.max(500).optional(),
  })
  .strict();

/** Declarative documentation only: `.senawa/sensors.yaml` command sensors remain the sole executor. */
export const ValidationCommandSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    command: NonEmptyStringSchema.max(300),
    expect: NonEmptyStringSchema.max(300).optional(),
    blocking: z.boolean().default(false),
  })
  .strict();

export const DefinitionCriterionSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    description: NonEmptyStringSchema.max(500),
    required: z.boolean().default(true),
    measurement: NonEmptyStringSchema.max(500).optional(),
    verifiedBy: z.enum(["deterministic-gate", "verifier-review", "human-approval"]).optional(),
  })
  .strict();

export const StakeholderSchema = z
  .object({
    name: NonEmptyStringSchema.max(200),
    role: z.enum(["requester", "owner", "reviewer", "affected"]),
    concern: NonEmptyStringSchema.max(500).optional(),
  })
  .strict();

export const AssumptionSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    statement: NonEmptyStringSchema.max(500),
    confidence: LevelSchema.optional(),
    validation: NonEmptyStringSchema.max(500).optional(),
  })
  .strict();

export const EvidenceRequestSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    question: NonEmptyStringSchema.max(500),
    expectedEvidenceKind: EvidenceKindSchema.optional(),
    why: NonEmptyStringSchema.max(500).optional(),
  })
  .strict();

/**
 * Only `PlanArtifactSchema` is parsed in production. Definition, research, and verification
 * artifacts are validated by Ajv against the frozen JSON Schema, so a refinement added here
 * would only run for the simulated worker adapter.
 */
export const DefinitionArtifactSchema = z
  .object({
    summary: NonEmptyStringSchema,
    problemStatement: NonEmptyStringSchema.max(2000).optional(),
    currentBehavior: NonEmptyStringSchema.max(2000).optional(),
    desiredBehavior: NonEmptyStringSchema.max(2000).optional(),
    inScope: z.array(NonEmptyStringSchema).min(1),
    outOfScope: z.array(NonEmptyStringSchema).default([]),
    nonGoals: z.array(NonEmptyStringSchema).max(30).default([]),
    acceptanceCriteria: z.array(DefinitionCriterionSchema).min(1),
    constraints: z.array(ConstraintEntrySchema).default([]),
    assumptions: z.array(AssumptionSchema).max(30).default([]),
    stakeholders: z.array(StakeholderSchema).max(20).default([]),
    risks: z.array(RiskSchema).max(30).default([]),
    evidenceNeeded: z.array(EvidenceRequestSchema).max(30).default([]),
    openQuestions: z.array(OpenQuestionEntrySchema).default([]),
  })
  .strict();

export const ResearchEvidenceSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    claim: NonEmptyStringSchema,
    detail: NonEmptyStringSchema.max(2000).optional(),
    source: NonEmptyStringSchema,
    evidenceKind: EvidenceKindSchema,
    confidence: LevelSchema.optional(),
    limits: z.array(NonEmptyStringSchema.max(500)).max(10).default([]),
    answers: z.array(ArtifactIdSchema).max(10).default([]),
  })
  .strict();

export const ResearchQuestionSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    question: NonEmptyStringSchema.max(500),
    status: z.enum(["answered", "partial", "unanswered"]),
    answeredBy: z.array(ArtifactIdSchema).max(10).default([]),
  })
  .strict();

export const ResearchAlternativeSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    option: NonEmptyStringSchema.max(300),
    verdict: z.enum(["recommended", "viable", "rejected"]),
    rationale: NonEmptyStringSchema.max(1000),
    tradeoffs: z.array(NonEmptyStringSchema.max(1000)).max(10).default([]),
    evidence: z.array(ArtifactIdSchema).max(10).default([]),
  })
  .strict();

export const ResearchUnknownSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    question: NonEmptyStringSchema.max(500),
    why: NonEmptyStringSchema.max(500).optional(),
    nextResearch: NonEmptyStringSchema.max(500).optional(),
    blocking: z.boolean().default(false),
  })
  .strict();

export const ResearchRecommendationSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    statement: NonEmptyStringSchema.max(500),
    basis: z.array(ArtifactIdSchema).max(10).default([]),
    confidence: LevelSchema.optional(),
    alternativesRejected: z.array(ArtifactIdSchema).max(10).default([]),
  })
  .strict();

/** See the note on `DefinitionArtifactSchema`: research is Ajv-only in production. */
export const ResearchArtifactSchema = z
  .object({
    summary: NonEmptyStringSchema,
    findings: z.array(ResearchEvidenceSchema).min(1),
    questions: z.array(ResearchQuestionSchema).max(30).default([]),
    alternatives: z.array(ResearchAlternativeSchema).max(30).default([]),
    constraints: z.array(ConstraintEntrySchema).default([]),
    risks: z.array(RiskSchema).max(30).default([]),
    unknowns: z.array(ResearchUnknownSchema).max(30).default([]),
    recommendations: z.array(ResearchRecommendationSchema).default([]),
  })
  .strict();

export const RepositoryChangeExpectationSchema = z.enum(["required", "optional", "forbidden"]);

export const AcceptanceCriterionSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    description: NonEmptyStringSchema.max(500),
    required: z.boolean().default(true),
    satisfies: z.array(ArtifactIdSchema).max(10).default([]),
  })
  .strict();

export const AcceptanceEntrySchema = AcceptanceCriterionSchema;

export const PlanTaskSchema = z
  .object({
    key: ArtifactIdSchema,
    title: NonEmptyStringSchema,
    dependsOn: z.array(ArtifactIdSchema).default([]),
    paths: z.array(RelativePathSchema).min(1),
    repositoryChange: RepositoryChangeExpectationSchema.optional(),
    acceptance: z.array(AcceptanceEntrySchema).min(1).max(50),
    /** Strict on purpose: this must name a worker profile that the repository ships. */
    role: IdentifierSchema,
    phase: ArtifactIdSchema.optional(),
    order: z.number().int().min(1).max(1000).optional(),
    rationale: NonEmptyStringSchema.max(1000).optional(),
    execution: z
      .object({
        model: NonEmptyStringSchema.optional(),
        effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
        effortMode: z.enum(["required", "preferred"]).optional(),
        group: ArtifactIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PlanPhaseTodoSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    text: NonEmptyStringSchema.max(500),
    taskKey: ArtifactIdSchema.optional(),
    optional: z.boolean().default(false),
  })
  .strict();

/**
 * `parallelizable` is an authoring signal only. The task frontier caps concurrency at 1,
 * so declaring a phase parallelizable never changes scheduling today.
 */
export const PlanPhaseSchema = z
  .object({
    id: ArtifactIdSchema,
    title: NonEmptyStringSchema.max(200),
    order: z.number().int().min(1).max(100).optional(),
    intent: NonEmptyStringSchema.max(1000).optional(),
    parallelizable: z.boolean().default(false),
    dependsOn: z.array(ArtifactIdSchema).max(20).default([]),
    todos: z.array(PlanPhaseTodoSchema).max(30).default([]),
    exitCriteria: z.array(NonEmptyStringSchema.max(500)).max(20).default([]),
    validation: z.array(ValidationCommandSchema).max(20).default([]),
  })
  .strict();

export const PlanDecisionSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    decision: NonEmptyStringSchema.max(500),
    rationale: NonEmptyStringSchema.max(1000),
    status: z.enum(["proposed", "accepted", "superseded"]).default("proposed"),
    evidence: z.array(NonEmptyStringSchema.max(300)).max(10).default([]),
    alternativesRejected: z
      .array(
        z
          .object({
            option: NonEmptyStringSchema.max(300),
            reason: NonEmptyStringSchema.max(500),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();

export const PlanDependencySchema = z
  .object({
    description: NonEmptyStringSchema.max(500),
    kind: z.enum(["internal", "external", "artifact", "contract"]).optional(),
    blocking: z.boolean().default(false),
  })
  .strict();

export const PlanSuccessCriterionSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    description: NonEmptyStringSchema.max(500),
    satisfies: z.array(ArtifactIdSchema).max(10).default([]),
  })
  .strict();

export const PlanArtifactSchema = z
  .object({
    summary: NonEmptyStringSchema,
    objectives: z.array(NonEmptyStringSchema.max(500)).max(20).default([]),
    contextSummary: NonEmptyStringSchema.max(4000).optional(),
    phases: z.array(PlanPhaseSchema).max(20).default([]),
    decisions: z.array(PlanDecisionSchema).max(30).default([]),
    dependencies: z.array(PlanDependencySchema).max(30).default([]),
    risks: z.array(RiskSchema).max(30).default([]),
    successCriteria: z.array(PlanSuccessCriterionSchema).max(30).default([]),
    validation: z.array(ValidationCommandSchema).max(30).default([]),
    openQuestions: z.array(OpenQuestionEntrySchema).max(30).default([]),
    tasks: z.array(PlanTaskSchema).min(1),
  })
  .strict()
  .superRefine((plan, context) => {
    const keys = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (keys.has(task.key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate task key: ${task.key}`,
          path: ["tasks", index, "key"],
        });
      }
      keys.add(task.key);
    }

    for (const [index, task] of plan.tasks.entries()) {
      for (const dependency of task.dependsOn) {
        if (!keys.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `Unknown task dependency: ${dependency}`,
            path: ["tasks", index, "dependsOn"],
          });
        }
      }
      const criterionIds = new Set<string>();
      for (const [position, criterion] of normalizeAcceptance(task.acceptance).entries()) {
        if (criterionIds.has(criterion.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate acceptance criterion id: ${criterion.id}`,
            path: ["tasks", index, "acceptance", position],
          });
        }
        criterionIds.add(criterion.id);
      }
    }

    refinePlanPhases(plan, keys, context);
  });

function refinePlanPhases(
  plan: {
    readonly phases: readonly z.infer<typeof PlanPhaseSchema>[];
    readonly tasks: readonly z.infer<typeof PlanTaskSchema>[];
  },
  taskKeys: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  const phaseIds = new Set<string>();
  for (const [index, phase] of plan.phases.entries()) {
    if (phaseIds.has(phase.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate plan phase id: ${phase.id}`,
        path: ["phases", index, "id"],
      });
    }
    phaseIds.add(phase.id);
  }

  for (const [index, phase] of plan.phases.entries()) {
    for (const dependency of phase.dependsOn) {
      if (!phaseIds.has(dependency)) {
        context.addIssue({
          code: "custom",
          message: `Unknown plan phase dependency: ${dependency}`,
          path: ["phases", index, "dependsOn"],
        });
      }
    }
    for (const [position, todo] of phase.todos.entries()) {
      if (todo.taskKey === undefined) continue;
      if (!taskKeys.has(todo.taskKey)) {
        context.addIssue({
          code: "custom",
          message: `Unknown plan phase todo task: ${todo.taskKey}`,
          path: ["phases", index, "todos", position, "taskKey"],
        });
      }
    }
  }

  const cycle = findPhaseCycle(plan.phases);
  if (cycle !== null) {
    context.addIssue({
      code: "custom",
      message: `Plan phase dependencies form a cycle: ${cycle.join(" -> ")}`,
      path: ["phases"],
    });
  }

  for (const [index, task] of plan.tasks.entries()) {
    if (task.phase !== undefined && !phaseIds.has(task.phase)) {
      context.addIssue({
        code: "custom",
        message: `Unknown task phase: ${task.phase}`,
        path: ["tasks", index, "phase"],
      });
    }
  }

  if (plan.phases.length === 0) return;
  const phased = plan.tasks.filter((task) => task.phase !== undefined);
  if (phased.length > 0 && phased.length !== plan.tasks.length) {
    context.addIssue({
      code: "custom",
      message:
        "A plan that declares phases must assign every task to a phase or assign none of them",
      path: ["tasks"],
    });
  }
}

/** Returns the first dependency cycle as a readable path, or null when the graph is acyclic. */
function findPhaseCycle(
  phases: readonly { readonly id: string; readonly dependsOn: readonly string[] }[],
): readonly string[] | null {
  const edges = new Map(phases.map((phase) => [phase.id, phase.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const walk = (id: string): readonly string[] | null => {
    if (visited.has(id)) return null;
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    visiting.add(id);
    stack.push(id);
    for (const dependency of edges.get(id) ?? []) {
      if (!edges.has(dependency)) continue;
      const found = walk(dependency);
      if (found !== null) return found;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const phase of phases) {
    const found = walk(phase.id);
    if (found !== null) return found;
  }
  return null;
}

export const VerificationEvidenceReferenceSchema = z
  .object({
    kind: z.enum(["file", "artifact", "sensor", "command", "repository-delta"]),
    ref: NonEmptyStringSchema.max(300),
  })
  .strict();

export const VerificationCheckSchema = z
  .object({
    id: ArtifactIdSchema.optional(),
    name: NonEmptyStringSchema,
    verdict: z.enum(["pass", "fail", "error"]),
    summary: NonEmptyStringSchema,
    evidence: RelativePathSchema.optional(),
    criterionId: ArtifactIdSchema.optional(),
    taskKey: ArtifactIdSchema.optional(),
    phaseId: ArtifactIdSchema.optional(),
    command: NonEmptyStringSchema.max(300).optional(),
    evidenceRefs: z.array(VerificationEvidenceReferenceSchema).max(10).default([]),
  })
  .strict();

export const VerificationCriterionSchema = z
  .object({
    id: ArtifactIdSchema,
    source: z.enum(["definition", "plan", "task"]),
    verdict: z.enum(["pass", "fail", "not-verifiable"]),
    summary: NonEmptyStringSchema.max(500).optional(),
    checks: z.array(ArtifactIdSchema).max(10).default([]),
  })
  .strict();

export const VerificationPhaseSchema = z
  .object({
    id: ArtifactIdSchema,
    verdict: z.enum(["pass", "fail", "not-verifiable"]),
    summary: NonEmptyStringSchema.max(500).optional(),
    checks: z.array(ArtifactIdSchema).max(20).default([]),
    tasks: z.array(ArtifactIdSchema).max(50).default([]),
  })
  .strict();

/** Non-blocking counterpart to `findings`, which fails the `work-done` gate when non-empty. */
export const VerificationDeviationSchema = z
  .object({
    description: NonEmptyStringSchema.max(500),
    rationale: NonEmptyStringSchema.max(500),
    impact: z.enum(["none", "low", "medium", "high"]).optional(),
  })
  .strict();

/** See the note on `DefinitionArtifactSchema`: verification is Ajv-only in production. */
export const VerificationArtifactSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    summary: NonEmptyStringSchema,
    checks: z.array(VerificationCheckSchema).min(1),
    criteria: z.array(VerificationCriterionSchema).max(100).default([]),
    phases: z.array(VerificationPhaseSchema).max(20).default([]),
    deviations: z.array(VerificationDeviationSchema).max(20).default([]),
    findings: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export type DefinitionArtifact = z.infer<typeof DefinitionArtifactSchema>;
export type ResearchArtifact = z.infer<typeof ResearchArtifactSchema>;
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;
/** Pre-parse shape: every field carrying a zod default is optional for callers. */
export type PlanArtifactInput = z.input<typeof PlanArtifactSchema>;
export type PlanPhase = z.infer<typeof PlanPhaseSchema>;
export type RepositoryChangeExpectation = z.infer<typeof RepositoryChangeExpectationSchema>;
export type AcceptanceEntry = z.infer<typeof AcceptanceEntrySchema>;
export type VerificationArtifact = z.infer<typeof VerificationArtifactSchema>;

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
}

/** Content-addressed so a criterion keeps its identity when a plan reorders criteria. */
export function deriveAcceptanceCriterionId(description: string): string {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(description.trim())) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return `ac-${hash.toString(16).padStart(16, "0")}`;
}

export function normalizeAcceptance(
  acceptance: readonly {
    id?: string | undefined;
    description: string;
    required?: boolean | undefined;
  }[],
): readonly AcceptanceCriterion[] {
  return acceptance.map((entry) => ({
    id: entry.id ?? deriveAcceptanceCriterionId(entry.description),
    description: entry.description,
    required: entry.required ?? true,
  }));
}
