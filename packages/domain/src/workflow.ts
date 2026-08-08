import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema, RelativePathSchema } from "./common.js";

const DefinitionReferenceSchema = NonEmptyStringSchema.refine(
  (value) => !value.startsWith("/"),
  "Expected a path relative to the workflow definition",
);

const ArtifactOutputSchema = z
  .object({ path: RelativePathSchema, schema: DefinitionReferenceSchema })
  .strict();
export const WorkflowInputReferenceSchema = z.union([
  z.string().regex(/^phases\.[a-z0-9]+(?:[._-][a-z0-9]+)*\.output$/, {
    message: "Expected phases.<phaseId>.output or evidence.implementation",
  }),
  z.literal("evidence.implementation"),
]);
const AgentExecutorSchema = z
  .object({
    kind: z.literal("agent"),
    role: IdentifierSchema,
    resumeAcrossIterations: z.boolean().default(true),
    input: z.record(IdentifierSchema, WorkflowInputReferenceSchema).optional(),
    output: ArtifactOutputSchema,
  })
  .strict();
const TaskFrontierExecutorSchema = z
  .object({
    kind: z.literal("task-frontier"),
    role: IdentifierSchema,
    selector: z.record(IdentifierSchema, NonEmptyStringSchema).optional(),
    repositoryChanges: z
      .array(z.enum(["required", "optional", "forbidden"]))
      .min(1)
      .default(["required"]),
    concurrency: z.number().int().positive().max(1),
    reentrant: z.boolean().default(true),
  })
  .strict();
const SensorOnlyExecutorSchema = z
  .object({ kind: z.literal("sensor-only"), gate: IdentifierSchema })
  .strict();
const HumanExecutorSchema = z
  .object({ kind: z.literal("human"), prompt: NonEmptyStringSchema })
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
          .object({ resumeSession: z.boolean(), maxAttempts: z.number().int().positive() })
          .strict(),
        dispatch: z.object({ maxFailures: z.number().int().nonnegative() }).strict(),
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
      .array(z.object({ kind: z.literal("import-plan"), source: NonEmptyStringSchema }).strict())
      .optional(),
    exit: z
      .object({ gate: IdentifierSchema, approval: z.enum(["human", "human-direct"]).optional() })
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
    metadata: z.object({ name: IdentifierSchema, description: NonEmptyStringSchema }).strict(),
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
      if (phase.executor.kind === "agent") {
        const references = Object.values(phase.executor.input ?? {});
        const duplicate = references.find(
          (reference, referenceIndex) => references.indexOf(reference) !== referenceIndex,
        );
        if (duplicate !== undefined) {
          context.addIssue({
            code: "custom",
            message: `Duplicate workflow input reference: ${duplicate}`,
            path: ["spec", "phases", index, "executor", "input"],
          });
        }
        const ancestors = phaseAncestors(workflow.spec.phases, phase.id);
        for (const [name, reference] of Object.entries(phase.executor.input ?? {})) {
          if (reference === "evidence.implementation") {
            const hasTaskFrontierAncestor = workflow.spec.phases.some(
              (candidate) =>
                ancestors.has(candidate.id) && candidate.executor.kind === "task-frontier",
            );
            if (!hasTaskFrontierAncestor) {
              context.addIssue({
                code: "custom",
                message: `Implementation evidence input ${name} requires a task-frontier ancestor`,
                path: ["spec", "phases", index, "executor", "input", name],
              });
            }
            continue;
          }
          const referencedId = reference.slice("phases.".length, -".output".length);
          const referenced = workflow.spec.phases.find(
            (candidate) => candidate.id === referencedId,
          );
          if (referenced === undefined) {
            context.addIssue({
              code: "custom",
              message: `Unknown workflow input phase: ${referencedId}`,
              path: ["spec", "phases", index, "executor", "input", name],
            });
          } else if (referenced.executor.kind !== "agent") {
            context.addIssue({
              code: "custom",
              message: `Workflow input phase ${referencedId} has no artifact output`,
              path: ["spec", "phases", index, "executor", "input", name],
            });
          } else if (!ancestors.has(referencedId)) {
            context.addIssue({
              code: "custom",
              message: `Workflow input phase ${referencedId} is not an ancestor of ${phase.id}`,
              path: ["spec", "phases", index, "executor", "input", name],
            });
          }
        }
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

function phaseAncestors(phases: readonly z.infer<typeof WorkflowPhaseSchema>[], phaseId: string) {
  const ancestors = new Set<string>();
  const pending = [...(phases.find((phase) => phase.id === phaseId)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || ancestors.has(candidate)) continue;
    ancestors.add(candidate);
    pending.push(...(phases.find((phase) => phase.id === candidate)?.dependsOn ?? []));
  }
  return ancestors;
}

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;
export type WorkflowInputReference = z.infer<typeof WorkflowInputReferenceSchema>;
