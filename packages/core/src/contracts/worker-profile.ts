import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema } from "./common.js";

export const WorkerCapabilitySchema = z.enum([
  "repository.read",
  "repository.edit",
  "process.run",
  "senawa.task.done",
  "senawa.phase.submit",
  "senawa.ask",
  "senawa.discover",
]);

export const WorkerProfileSchema = z
  .object({
    apiVersion: z.literal("senawa.dev/worker-profile/v1"),
    kind: z.literal("WorkerProfile"),
    metadata: z
      .object({
        name: IdentifierSchema,
      })
      .strict(),
    spec: z
      .object({
        model: z
          .object({
            id: NonEmptyStringSchema,
            effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
          })
          .strict(),
        tools: z.array(WorkerCapabilitySchema).min(1),
      })
      .strict(),
    prompt: z.string().trim().min(1).max(100_000),
  })
  .strict();

export type WorkerCapability = z.infer<typeof WorkerCapabilitySchema>;
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;
