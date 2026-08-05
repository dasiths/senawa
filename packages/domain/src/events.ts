import { z } from "zod";
import { CommandActorSchema } from "./commands.js";
import {
  IdentifierSchema,
  JsonObjectSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "./common.js";

export const JournalEventNameSchema = z.enum([
  "work.started",
  "work.paused",
  "work.resumed",
  "work.finished",
  "work.ended",
  "workflow.instantiated",
  "phase.started",
  "phase.submitted",
  "phase.approved",
  "phase.rejected",
  "plan.imported",
  "plan.revised",
  "task.dispatching",
  "task.dispatched",
  "dispatch.failed",
  "task.completion-requested",
  "task.rework",
  "task.closed",
  "task.escalated",
  "sensor.started",
  "sensor.completed",
  "sensor.error",
  "gate.evaluated",
  "question.asked",
  "question.answered",
  "discovery.recorded",
  "note.recorded",
  "steering.recorded",
]);

export const JournalEventSchema = z
  .object({
    apiVersion: z.literal("senawa.dev/event/v1"),
    seq: z.number().int().positive(),
    ts: TimestampSchema,
    runId: IdentifierSchema,
    event: JournalEventNameSchema,
    actor: CommandActorSchema,
    traceId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    nodeId: NonEmptyStringSchema.optional(),
    data: JsonObjectSchema.default({}),
  })
  .strict();

export type JournalEvent = z.infer<typeof JournalEventSchema>;
export type JournalEventName = z.infer<typeof JournalEventNameSchema>;
