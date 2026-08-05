import { z } from "zod";
import { WorkRequestSchema } from "./artifacts.js";
import { IdentifierSchema, NonEmptyStringSchema } from "./common.js";

export const CommandActorSchema = z
  .object({
    channel: z.enum(["direct-cli", "principal-agent", "web", "driver", "worker"]),
    role: IdentifierSchema.optional(),
    sessionId: NonEmptyStringSchema.optional(),
  })
  .strict();

const StartCommandSchema = z
  .object({
    command: z.literal("work.start"),
    actor: CommandActorSchema,
    workflow: IdentifierSchema,
    request: WorkRequestSchema,
    detach: z.boolean().default(false),
  })
  .strict();

const ResumeCommandSchema = z
  .object({ command: z.literal("work.resume"), actor: CommandActorSchema, runId: IdentifierSchema })
  .strict();
const ApproveCommandSchema = z
  .object({
    command: z.literal("phase.approve"),
    actor: CommandActorSchema,
    runId: IdentifierSchema,
    phaseId: IdentifierSchema,
    note: NonEmptyStringSchema.optional(),
  })
  .strict();
const RejectCommandSchema = z
  .object({
    command: z.literal("phase.reject"),
    actor: CommandActorSchema,
    runId: IdentifierSchema,
    phaseId: IdentifierSchema,
    reason: NonEmptyStringSchema,
  })
  .strict();
const SteerCommandSchema = z
  .object({
    command: z.literal("task.steer"),
    actor: CommandActorSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    instruction: NonEmptyStringSchema,
  })
  .strict();
const EndCommandSchema = z
  .object({
    command: z.literal("work.end"),
    actor: CommandActorSchema,
    runId: IdentifierSchema,
    reason: NonEmptyStringSchema,
  })
  .strict();
const FinishCommandSchema = z
  .object({ command: z.literal("work.finish"), actor: CommandActorSchema, runId: IdentifierSchema })
  .strict();

export const RunCommandSchema = z.discriminatedUnion("command", [
  StartCommandSchema,
  ResumeCommandSchema,
  ApproveCommandSchema,
  RejectCommandSchema,
  SteerCommandSchema,
  EndCommandSchema,
  FinishCommandSchema,
]);

const BrowserCommandBase = { apiVersion: z.literal("senawa.dev/browser-command/v1") };

export const BrowserRunCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      ...BrowserCommandBase,
      command: z.literal("approve"),
      phaseId: IdentifierSchema,
      note: NonEmptyStringSchema.max(1000).optional(),
    })
    .strict(),
  z
    .object({
      ...BrowserCommandBase,
      command: z.literal("reject"),
      phaseId: IdentifierSchema,
      reason: NonEmptyStringSchema.max(1000),
    })
    .strict(),
  z
    .object({
      ...BrowserCommandBase,
      command: z.literal("steer"),
      taskId: IdentifierSchema,
      instruction: NonEmptyStringSchema.max(2000),
    })
    .strict(),
  z.object({ ...BrowserCommandBase, command: z.literal("resume") }).strict(),
  z
    .object({
      ...BrowserCommandBase,
      command: z.literal("end"),
      reason: NonEmptyStringSchema.max(1000),
    })
    .strict(),
]);

export type CommandActor = z.infer<typeof CommandActorSchema>;
export type RunCommand = z.infer<typeof RunCommandSchema>;
export type BrowserRunCommand = z.infer<typeof BrowserRunCommandSchema>;
