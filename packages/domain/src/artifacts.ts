import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema, RelativePathSchema } from "./common.js";

export const WorkRequestSchema = z
  .object({
    goal: NonEmptyStringSchema,
    repository: NonEmptyStringSchema.optional(),
    constraints: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export const DefinitionArtifactSchema = z
  .object({
    summary: NonEmptyStringSchema,
    inScope: z.array(NonEmptyStringSchema).min(1),
    outOfScope: z.array(NonEmptyStringSchema).default([]),
    acceptanceCriteria: z.array(NonEmptyStringSchema).min(1),
    constraints: z.array(NonEmptyStringSchema).default([]),
    openQuestions: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export const ResearchEvidenceSchema = z
  .object({
    claim: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    evidenceKind: z.enum(["measured", "offline", "live-model", "simulated", "documentation"]),
  })
  .strict();

export const ResearchArtifactSchema = z
  .object({
    summary: NonEmptyStringSchema,
    findings: z.array(ResearchEvidenceSchema).min(1),
    constraints: z.array(NonEmptyStringSchema).default([]),
    recommendations: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export const PlanTaskSchema = z
  .object({
    key: IdentifierSchema,
    title: NonEmptyStringSchema,
    dependsOn: z.array(IdentifierSchema).default([]),
    paths: z.array(RelativePathSchema).min(1),
    repositoryChange: z.enum(["required", "optional", "forbidden"]).default("required"),
    acceptance: z.array(NonEmptyStringSchema).min(1),
    role: IdentifierSchema,
    execution: z
      .object({
        model: NonEmptyStringSchema.optional(),
        effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
        effortMode: z.enum(["required", "preferred"]).optional(),
        group: IdentifierSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PlanArtifactSchema = z
  .object({
    summary: NonEmptyStringSchema,
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
    }
  });

export const VerificationCheckSchema = z
  .object({
    name: NonEmptyStringSchema,
    verdict: z.enum(["pass", "fail", "error"]),
    summary: NonEmptyStringSchema,
    evidence: RelativePathSchema.optional(),
  })
  .strict();

export const VerificationArtifactSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    summary: NonEmptyStringSchema,
    checks: z.array(VerificationCheckSchema).min(1),
    findings: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export type DefinitionArtifact = z.infer<typeof DefinitionArtifactSchema>;
export type ResearchArtifact = z.infer<typeof ResearchArtifactSchema>;
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;
export type RepositoryChangeExpectation = z.infer<typeof PlanTaskSchema>["repositoryChange"];
export type VerificationArtifact = z.infer<typeof VerificationArtifactSchema>;
