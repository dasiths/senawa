import { z } from "zod";
import {
  IdentifierSchema,
  JsonObjectSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  RelativePathSchema,
} from "./common.js";

export const SensorFindingSchema = z
  .object({
    severity: z.enum(["info", "warning", "error"]),
    message: NonEmptyStringSchema,
    code: NonEmptyStringSchema.optional(),
    path: RelativePathSchema.optional(),
    line: z.number().int().positive().optional(),
    evidence: NonEmptyStringSchema.optional(),
  })
  .strict();

export const SensorAssessmentSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    summary: NonEmptyStringSchema,
    findings: z.array(SensorFindingSchema),
    data: JsonValueSchema.optional(),
  })
  .strict();

export const SensorExecutionErrorSchema = z
  .object({
    error: z.literal(true),
    summary: NonEmptyStringSchema,
    retryable: z.boolean(),
  })
  .strict();

export const SensorResultSchema = z.union([SensorAssessmentSchema, SensorExecutionErrorSchema]);

export const SensorManifestSchema = z
  .object({
    apiVersion: z.literal("senawa.dev/sensor/v1"),
    name: IdentifierSchema,
    version: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    configSchema: JsonObjectSchema,
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
  })
  .strict();

const SensorExtensionReferenceSchema = z.union([
  z.object({ package: NonEmptyStringSchema }).strict(),
  z.object({ path: RelativePathSchema }).strict(),
]);

export const SensorInstanceSchema = z
  .object({
    id: IdentifierSchema,
    extension: NonEmptyStringSchema,
    kind: z.enum(["deterministic", "inferential"]),
    description: NonEmptyStringSchema,
    cost: z.enum(["cheap", "standard", "expensive"]),
    trust: z.enum(["blocking", "advisory"]).default("blocking"),
    scope: z.array(RelativePathSchema).default([]),
    stability: z
      .object({
        samples: z.number().int().positive(),
        agreement: z.number().min(0).max(1),
        measuredOn: NonEmptyStringSchema,
      })
      .strict()
      .optional(),
    config: JsonObjectSchema,
  })
  .strict();

export const GateExpectationSchema = z
  .object({
    path: z.string().startsWith("/"),
    operator: z.enum([
      "equals",
      "notEquals",
      "greaterThan",
      "greaterThanOrEqual",
      "contains",
      "matches",
      "exists",
    ]),
    value: JsonValueSchema.optional(),
  })
  .strict();

export const GateSchema = z
  .object({
    id: IdentifierSchema,
    description: NonEmptyStringSchema,
    checks: z
      .array(
        z
          .object({
            sensor: IdentifierSchema,
            expect: GateExpectationSchema,
            advisory: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
    onFail: z.enum(["rework", "block", "escalate"]),
    maxRework: z.number().int().nonnegative().optional(),
    escalateOnExhaustion: z.boolean().default(true),
  })
  .strict();

export const SensorReadingSchema = z
  .object({
    sensorId: IdentifierSchema,
    extension: NonEmptyStringSchema,
    result: SensorResultSchema,
    expect: GateExpectationSchema,
    matched: z.boolean(),
    advisory: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export const GateEvaluationSchema = z
  .object({
    gateId: IdentifierSchema,
    accepted: z.boolean(),
    readings: z.array(SensorReadingSchema),
    findings: z.array(SensorFindingSchema),
  })
  .strict();

export const RepositoryPolicySchema = z
  .object({
    version: z.literal(1),
    extensions: z.array(SensorExtensionReferenceSchema).min(1),
    sensors: z.array(SensorInstanceSchema).min(1),
    gates: z.array(GateSchema).min(1),
    frozen: z.array(RelativePathSchema).min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    const sensorIds = new Set<string>();
    for (const [index, sensor] of policy.sensors.entries()) {
      if (sensorIds.has(sensor.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate sensor id: ${sensor.id}`,
          path: ["sensors", index, "id"],
        });
      }
      sensorIds.add(sensor.id);
    }

    const gateIds = new Set<string>();
    for (const [gateIndex, gate] of policy.gates.entries()) {
      if (gateIds.has(gate.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate gate id: ${gate.id}`,
          path: ["gates", gateIndex, "id"],
        });
      }
      gateIds.add(gate.id);

      for (const [checkIndex, check] of gate.checks.entries()) {
        if (!sensorIds.has(check.sensor)) {
          context.addIssue({
            code: "custom",
            message: `Unknown sensor: ${check.sensor}`,
            path: ["gates", gateIndex, "checks", checkIndex, "sensor"],
          });
        }
      }
    }
  });

export type SensorFinding = z.infer<typeof SensorFindingSchema>;
export type SensorAssessment = z.infer<typeof SensorAssessmentSchema>;
export type SensorExecutionError = z.infer<typeof SensorExecutionErrorSchema>;
export type SensorResult = z.infer<typeof SensorResultSchema>;
export type SensorManifest = z.infer<typeof SensorManifestSchema>;
export type SensorReading = z.infer<typeof SensorReadingSchema>;
export type GateEvaluation = z.infer<typeof GateEvaluationSchema>;
export type RepositoryPolicy = z.infer<typeof RepositoryPolicySchema>;
