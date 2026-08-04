import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema, RelativePathSchema } from "./common.js";

const DefinitionReferenceSchema = NonEmptyStringSchema.refine(
  (value) => !value.startsWith("/"),
  "Expected a path relative to the workflow definition",
);

const ArtifactOutputSchema = z
  .object({
    path: RelativePathSchema,
    schema: DefinitionReferenceSchema,
  })
  .strict();

const AgentExecutorSchema = z
  .object({
    kind: z.literal("agent"),
    role: IdentifierSchema,
    resumeAcrossIterations: z.boolean().default(true),
    input: z.record(IdentifierSchema, NonEmptyStringSchema).optional(),
    output: ArtifactOutputSchema,
  })
  .strict();

const TaskFrontierExecutorSchema = z
  .object({
    kind: z.literal("task-frontier"),
    role: IdentifierSchema,
    selector: z.record(IdentifierSchema, NonEmptyStringSchema).optional(),
    concurrency: z.number().int().positive().max(1),
    reentrant: z.boolean().default(true),
  })
  .strict();

const SensorOnlyExecutorSchema = z
  .object({
    kind: z.literal("sensor-only"),
    gate: IdentifierSchema,
  })
  .strict();

const HumanExecutorSchema = z
  .object({
    kind: z.literal("human"),
    prompt: NonEmptyStringSchema,
  })
  .strict();

const ForeachExecutorSchema = z
  .object({
    kind: z.literal("foreach"),
    role: IdentifierSchema,
    source: NonEmptyStringSchema,
    concurrency: z.number().int().positive().max(1),
  })
  .strict();

export const WorkflowExecutorSchema = z.discriminatedUnion("kind", [
  AgentExecutorSchema,
  TaskFrontierExecutorSchema,
  SensorOnlyExecutorSchema,
  HumanExecutorSchema,
  ForeachExecutorSchema,
]);

const PhaseIterationSchema = z
  .object({
    max: z.number().int().positive(),
    onUpstreamChange: z.enum(["cascade", "flag", "independent"]),
  })
  .strict();

const TaskLoopSchema = z
  .object({
    until: z.literal("all-selected-tasks-closed"),
    each: z
      .object({
        gate: IdentifierSchema,
        rework: z
          .object({
            resumeSession: z.boolean(),
            maxAttempts: z.number().int().positive(),
          })
          .strict(),
        dispatch: z
          .object({
            maxFailures: z.number().int().nonnegative(),
          })
          .strict(),
        onExhausted: z.literal("escalate"),
      })
      .strict(),
  })
  .strict();

export const WorkflowPhaseSchema = z
  .object({
    id: IdentifierSchema,
    dependsOn: z.array(IdentifierSchema).default([]),
    executor: WorkflowExecutorSchema,
    actions: z
      .array(
        z
          .object({
            kind: z.literal("import-plan"),
            source: NonEmptyStringSchema,
          })
          .strict(),
      )
      .optional(),
    exit: z
      .object({
        gate: IdentifierSchema,
        approval: z.literal("human").optional(),
      })
      .strict()
      .optional(),
    loop: TaskLoopSchema.optional(),
    iteration: PhaseIterationSchema,
  })
  .strict();

export const WorkflowSchema = z
  .object({
    apiVersion: z.literal("senawa.dev/workflow/v1"),
    kind: z.literal("Workflow"),
    metadata: z
      .object({
        name: IdentifierSchema,
        description: NonEmptyStringSchema,
      })
      .strict(),
    spec: z
      .object({
        inputSchema: DefinitionReferenceSchema,
        completesWhen: IdentifierSchema,
        phases: z.array(WorkflowPhaseSchema).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((workflow, context) => {
    const phaseIds = new Set<string>();
    for (const [index, phase] of workflow.spec.phases.entries()) {
      if (phaseIds.has(phase.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate phase id: ${phase.id}`,
          path: ["spec", "phases", index, "id"],
        });
      }
      phaseIds.add(phase.id);
    }

    for (const [index, phase] of workflow.spec.phases.entries()) {
      for (const dependency of phase.dependsOn) {
        if (!phaseIds.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `Unknown phase dependency: ${dependency}`,
            path: ["spec", "phases", index, "dependsOn"],
          });
        }
      }

      if (phase.executor.kind === "task-frontier" && phase.loop === undefined) {
        context.addIssue({
          code: "custom",
          message: "A task-frontier executor requires a bounded loop",
          path: ["spec", "phases", index, "loop"],
        });
      }
    }

    const completionTargets = new Set(
      workflow.spec.phases
        .filter((phase) => phase.exit !== undefined)
        .map((phase) => `${phase.id}-accepted`),
    );
    if (!completionTargets.has(workflow.spec.completesWhen)) {
      context.addIssue({
        code: "custom",
        message: `Unknown completion condition: ${workflow.spec.completesWhen}`,
        path: ["spec", "completesWhen"],
      });
    }
  });

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
