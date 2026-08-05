import { z } from "zod";
import { IdentifierSchema, NonEmptyStringSchema, TimestampSchema } from "./common.js";

export const OutputOwnerSchema = z
  .object({ kind: z.enum(["run", "phase", "task"]), id: IdentifierSchema })
  .strict();

export const OutputRecordSchema = z
  .object({
    apiVersion: z.literal("senawa.dev/output/v1"),
    seq: z.number().int().positive(),
    ts: TimestampSchema,
    runId: IdentifierSchema,
    owner: OutputOwnerSchema,
    sessionId: IdentifierSchema.optional(),
    turnId: IdentifierSchema.optional(),
    stream: z.enum(["stdout", "stderr", "system"]),
    text: NonEmptyStringSchema,
  })
  .strict()
  .refine((record) => (record.sessionId === undefined) === (record.turnId === undefined), {
    message: "sessionId and turnId must be provided together",
  });

export type OutputRecord = z.infer<typeof OutputRecordSchema>;
