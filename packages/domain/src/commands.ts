import { z } from "zod";
import { WorkRequestSchema } from "./artifacts.js";
import {
  ArtifactIdSchema,
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  TimestampSchema,
} from "./common.js";

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
    expectedVersion: z.number().int().positive().optional(),
    expectedDigest: Sha256Schema.optional(),
    note: NonEmptyStringSchema.optional(),
  })
  .strict();
const RejectCommandSchema = z
  .object({
    command: z.literal("phase.reject"),
    actor: CommandActorSchema,
    runId: IdentifierSchema,
    phaseId: IdentifierSchema,
    expectedVersion: z.number().int().positive().optional(),
    expectedDigest: Sha256Schema.optional(),
    reason: NonEmptyStringSchema,
  })
  .strict();
const SteerCommandSchema = z
  .object({
    command: z.literal("task.steer"),
    actor: CommandActorSchema,
    runId: IdentifierSchema,
    taskId: ArtifactIdSchema,
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

const BrowserCommandBase = {
  apiVersion: z.literal("senawa.dev/browser-command/v1"),
  commandId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
};

export const BrowserQuestionAnswerSchema = z
  .object({
    apiVersion: z.literal("senawa.dev/question-answer/v1"),
    submissionId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    answer: NonEmptyStringSchema.max(4000),
  })
  .strict();

export const BrowserRunCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      ...BrowserCommandBase,
      command: z.literal("approve"),
      phaseId: IdentifierSchema,
      expectedVersion: z.number().int().positive().optional(),
      expectedDigest: Sha256Schema.optional(),
      note: NonEmptyStringSchema.max(1000).optional(),
    })
    .strict(),
  z
    .object({
      ...BrowserCommandBase,
      command: z.literal("reject"),
      phaseId: IdentifierSchema,
      expectedVersion: z.number().int().positive().optional(),
      expectedDigest: Sha256Schema.optional(),
      reason: NonEmptyStringSchema.max(1000),
    })
    .strict(),
  z
    .object({
      ...BrowserCommandBase,
      command: z.literal("steer"),
      taskId: ArtifactIdSchema,
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

const BrowserCommandReceiptBase = {
  apiVersion: z.literal("senawa.dev/browser-command-receipt/v1"),
  seq: z.number().int().positive(),
  commandId: BrowserCommandBase.commandId,
  runId: IdentifierSchema,
  payload: BrowserRunCommandSchema,
  payloadDigest: Sha256Schema,
  submittedAt: TimestampSchema,
};

const BrowserCommandClaim = {
  attempt: z.number().int().positive(),
  startedAt: TimestampSchema,
  claimOwner: IdentifierSchema,
  claimFence: z.number().int().positive(),
  claimExpiresAt: TimestampSchema,
};

const BrowserCommandTransitionResultSchema = z
  .object({
    runId: IdentifierSchema,
    kind: z.enum([
      "started",
      "phase-submitted",
      "awaiting-approval",
      "task-closed",
      "task-rework",
      "task-escalated",
      "phase-accepted",
      "finished",
      "ended",
      "idle",
    ]),
    phaseId: IdentifierSchema.optional(),
    taskId: ArtifactIdSchema.optional(),
  })
  .strict();

export const BrowserCommandReceiptErrorSchema = z
  .object({
    code: z.literal("command_refused"),
    message: NonEmptyStringSchema.max(500),
  })
  .strict();

export const BrowserCommandReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...BrowserCommandReceiptBase,
      status: z.literal("queued"),
      attempt: z.literal(0),
    })
    .strict(),
  z
    .object({
      ...BrowserCommandReceiptBase,
      ...BrowserCommandClaim,
      status: z.literal("running"),
    })
    .strict(),
  z
    .object({
      ...BrowserCommandReceiptBase,
      ...BrowserCommandClaim,
      status: z.literal("completed"),
      completedAt: TimestampSchema,
      result: BrowserCommandTransitionResultSchema,
    })
    .strict(),
  z
    .object({
      ...BrowserCommandReceiptBase,
      ...BrowserCommandClaim,
      status: z.literal("refused"),
      completedAt: TimestampSchema,
      error: BrowserCommandReceiptErrorSchema,
    })
    .strict(),
]);

export type CommandActor = z.infer<typeof CommandActorSchema>;
export type RunCommand = z.infer<typeof RunCommandSchema>;
export type BrowserRunCommand = z.infer<typeof BrowserRunCommandSchema>;
export type BrowserQuestionAnswer = z.infer<typeof BrowserQuestionAnswerSchema>;
export type BrowserCommandReceipt = z.infer<typeof BrowserCommandReceiptSchema>;
export type BrowserCommandReceiptError = z.infer<typeof BrowserCommandReceiptErrorSchema>;
