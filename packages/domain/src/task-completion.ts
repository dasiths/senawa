import { z } from "zod";
import type { AcceptanceCriterion } from "./artifacts.js";
import {
  IdentifierSchema,
  matchesPathPattern,
  NonEmptyStringSchema,
  RelativePathSchema,
} from "./common.js";
import type { RepositoryDeltaEvidence } from "./runtime.js";
import type { SensorFinding, SensorReading } from "./sensors.js";

export const EvidenceRelationshipSchema = z.enum([
  "created",
  "modified",
  "deleted",
  "reviewed",
  "validated",
  "referenced",
]);

/** Senawa can confirm that these paths exist in scope but never that a worker read them. */
export const ADVISORY_EVIDENCE_RELATIONSHIPS: readonly EvidenceRelationship[] = [
  "reviewed",
  "referenced",
];

export const EvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      path: RelativePathSchema,
      relationship: EvidenceRelationshipSchema,
      note: NonEmptyStringSchema.max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sensor"),
      sensorId: IdentifierSchema,
      note: NonEmptyStringSchema.max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      command: NonEmptyStringSchema.max(500),
      note: NonEmptyStringSchema.max(300).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("repository-delta"), scope: z.enum(["in-scope", "none"]) }).strict(),
]);

export const CriterionSubmissionSchema = z
  .object({
    id: IdentifierSchema,
    outcome: z.enum(["satisfied", "blocked", "not-applicable"]),
    summary: NonEmptyStringSchema.max(2_000).optional(),
    evidence: z.array(EvidenceReferenceSchema).max(20).default([]),
  })
  .strict();

export const TaskCompletionSubmissionSchema = z
  .object({
    summary: NonEmptyStringSchema.max(2_000),
    criteria: z.array(CriterionSubmissionSchema).min(1).max(50),
  })
  .strict();

export type EvidenceRelationship = z.infer<typeof EvidenceRelationshipSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type CriterionSubmission = z.infer<typeof CriterionSubmissionSchema>;
export type TaskCompletionSubmission = z.infer<typeof TaskCompletionSubmissionSchema>;

export const TASK_COMPLETION_SUBMISSION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "criteria"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    criteria: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "outcome"],
        properties: {
          id: { type: "string", description: "An acceptance criterion id from this task prompt" },
          outcome: { enum: ["satisfied", "blocked", "not-applicable"] },
          summary: { type: "string", minLength: 1, maxLength: 2000 },
          evidence: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: {
                kind: { enum: ["file", "sensor", "command", "repository-delta"] },
                path: { type: "string", description: "Repository-relative path for kind file" },
                relationship: {
                  enum: ["created", "modified", "deleted", "reviewed", "validated", "referenced"],
                },
                sensorId: { type: "string", description: "Gate sensor id for kind sensor" },
                command: { type: "string", description: "Configured command for kind command" },
                scope: { enum: ["in-scope", "none"] },
                note: { type: "string", maxLength: 300 },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type EvidenceResolution = "resolved" | "advisory" | "unresolved" | "contradicted";

export type EvidenceResolutionSource =
  | "repository-delta"
  | "authorized-paths"
  | "frozen-paths"
  | "gate-sensor"
  | "none";

export interface ResolvedEvidenceReference {
  readonly claim: EvidenceReference;
  readonly resolution: EvidenceResolution;
  readonly source: EvidenceResolutionSource;
  readonly detail: string;
}

export type CriterionVerdict = "satisfied" | "waived" | "unresolved" | "contradicted" | "unclaimed";

export interface AssessedCriterion {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
  readonly claimed: "satisfied" | "blocked" | "not-applicable" | "unreported";
  readonly verdict: CriterionVerdict;
  readonly evidence: readonly ResolvedEvidenceReference[];
}

export interface TaskCompletionAssessment {
  readonly version: 1;
  readonly kind: "task-completion-assessment";
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly dispatchId: string;
  readonly turnId: string;
  readonly stage: "pre-gate" | "final";
  readonly gateId: string | null;
  readonly submission: {
    readonly present: boolean;
    readonly valid: boolean;
    readonly duplicateCount: number;
  };
  readonly criteria: readonly AssessedCriterion[];
  readonly unmatchedClaims: readonly string[];
  readonly repositoryDeltaDigest: string | null;
  readonly verdict: "pass" | "fail";
  readonly findings: readonly SensorFinding[];
  readonly uncertainty: readonly string[];
  readonly assessedAt: string;
}

export interface TaskCompletionAssessmentEvidence extends TaskCompletionAssessment {
  readonly digest: string;
  readonly evidencePath: string;
}

export interface GateSensorDescriptor {
  readonly sensorId: string;
  readonly command: string | null;
  readonly scope: readonly string[];
  readonly advisory: boolean;
}

export interface TaskCompletionAssessmentInput {
  readonly stage: "pre-gate" | "final";
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly dispatchId: string;
  readonly turnId: string;
  readonly gateId: string | null;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly submission: TaskCompletionSubmission | null;
  readonly submissionPresent: boolean;
  readonly duplicateCount: number;
  readonly repositoryDelta: RepositoryDeltaEvidence | null;
  readonly authorizedPaths: readonly string[];
  readonly frozenPaths: readonly string[];
  readonly gateSensors: readonly GateSensorDescriptor[];
  readonly readings: readonly SensorReading[];
  readonly recovered: boolean;
  readonly assessedAt: string;
}

export function assessTaskCompletion(
  input: TaskCompletionAssessmentInput,
): TaskCompletionAssessment {
  const claims = new Map(input.submission?.criteria.map((claim) => [claim.id, claim]) ?? []);
  const findings: SensorFinding[] = [];
  const valid = input.submission !== null;
  if (!valid) {
    findings.push({
      severity: "error",
      code: input.submissionPresent
        ? "acceptance-submission-invalid"
        : "acceptance-submission-missing",
      message: input.submissionPresent
        ? "The worker completion submission did not match the completion contract"
        : "The worker did not submit task completion through senawa.task.done",
    });
  }
  if (input.duplicateCount > 1) {
    findings.push({
      severity: "warning",
      code: "acceptance-submission-duplicated",
      message: `The worker submitted completion ${input.duplicateCount} times; the last submission was assessed`,
    });
  }

  const criteria = input.criteria.map((criterion) =>
    assessCriterion(criterion, claims.get(criterion.id) ?? null, input, findings),
  );
  const unmatchedClaims = [...claims.keys()].filter(
    (id) => !input.criteria.some((criterion) => criterion.id === id),
  );
  for (const id of unmatchedClaims) {
    findings.push({
      severity: "error",
      code: "acceptance-claim-unmatched",
      message: `The worker claimed acceptance criterion ${id}, which this task does not define`,
    });
  }

  const blocking = findings.some((finding) => finding.severity === "error");
  return {
    version: 1,
    kind: "task-completion-assessment",
    runId: input.runId,
    taskId: input.taskId,
    attempt: input.attempt,
    dispatchId: input.dispatchId,
    turnId: input.turnId,
    stage: input.stage,
    gateId: input.gateId,
    submission: {
      present: input.submissionPresent,
      valid,
      duplicateCount: input.duplicateCount,
    },
    criteria,
    unmatchedClaims,
    repositoryDeltaDigest: input.repositoryDelta?.digest ?? null,
    verdict: blocking ? "fail" : "pass",
    findings,
    uncertainty: input.recovered ? ["assessment-computed-during-recovery"] : [],
    assessedAt: input.assessedAt,
  };
}

function assessCriterion(
  criterion: AcceptanceCriterion,
  claim: CriterionSubmission | null,
  input: TaskCompletionAssessmentInput,
  findings: SensorFinding[],
): AssessedCriterion {
  const severity = criterion.required ? "error" : "warning";
  if (claim === null) {
    if (criterion.required) {
      findings.push({
        severity,
        code: "acceptance-criterion-unreported",
        message: `Acceptance criterion ${criterion.id} has no reported outcome: ${criterion.description}`,
      });
    }
    return {
      id: criterion.id,
      description: criterion.description,
      required: criterion.required,
      claimed: "unreported",
      verdict: criterion.required ? "unclaimed" : "waived",
      evidence: [],
    };
  }

  const evidence = claim.evidence.map((reference) => resolveReference(reference, input));
  const contradicted = evidence.filter((entry) => entry.resolution === "contradicted");
  for (const entry of contradicted) {
    findings.push({
      severity: "error",
      code: "acceptance-evidence-contradicted",
      message: `Acceptance criterion ${criterion.id} cites contradicted evidence: ${entry.detail}`,
      ...(input.repositoryDelta === null ? {} : { evidence: input.repositoryDelta.evidencePath }),
    });
  }
  if (contradicted.length > 0) {
    return criterionOutcome(criterion, claim, evidence, "contradicted");
  }

  if (claim.outcome !== "satisfied") {
    if (criterion.required) {
      findings.push({
        severity,
        code: "acceptance-criterion-not-satisfied",
        message: `Acceptance criterion ${criterion.id} was reported as ${claim.outcome}, which cannot satisfy a required criterion`,
      });
      return criterionOutcome(criterion, claim, evidence, "unresolved");
    }
    return criterionOutcome(criterion, claim, evidence, "waived");
  }

  const resolving = evidence.filter((entry) => entry.resolution === "resolved");
  const unresolvable = evidence.filter((entry) => entry.resolution === "unresolved");
  if (resolving.length === 0 || unresolvable.length > 0) {
    findings.push({
      severity,
      code: "acceptance-evidence-unresolved",
      message:
        unresolvable.length > 0
          ? `Acceptance criterion ${criterion.id} cites unresolvable evidence: ${unresolvable[0]?.detail}`
          : `Acceptance criterion ${criterion.id} has no resolving evidence: ${criterion.description}`,
      ...(input.repositoryDelta === null ? {} : { evidence: input.repositoryDelta.evidencePath }),
    });
    return criterionOutcome(criterion, claim, evidence, "unresolved");
  }
  return criterionOutcome(criterion, claim, evidence, "satisfied");
}

function criterionOutcome(
  criterion: AcceptanceCriterion,
  claim: CriterionSubmission,
  evidence: readonly ResolvedEvidenceReference[],
  verdict: CriterionVerdict,
): AssessedCriterion {
  return {
    id: criterion.id,
    description: criterion.description,
    required: criterion.required,
    claimed: claim.outcome,
    verdict,
    evidence,
  };
}

function resolveReference(
  claim: EvidenceReference,
  input: TaskCompletionAssessmentInput,
): ResolvedEvidenceReference {
  if (claim.kind === "repository-delta") {
    const delta = input.repositoryDelta;
    if (delta === null) {
      return unresolved(
        claim,
        "repository-delta",
        "No repository delta was measured for this attempt",
      );
    }
    if (claim.scope === "in-scope") {
      return delta.inScopeChanges.length > 0
        ? resolved(
            claim,
            "repository-delta",
            `Measured in-scope changes: ${delta.inScopeChanges.join(", ")}`,
          )
        : contradicted(
            claim,
            "repository-delta",
            "No in-scope change was measured for this attempt",
          );
    }
    return delta.changedPaths.length === 0
      ? resolved(claim, "repository-delta", "No repository change was measured for this attempt")
      : contradicted(
          claim,
          "repository-delta",
          `A repository change was measured for this attempt: ${delta.changedPaths.map((entry) => entry.path).join(", ")}`,
        );
  }

  if (claim.kind === "sensor" || claim.kind === "command") {
    const descriptor = input.gateSensors.find((sensor) =>
      claim.kind === "sensor"
        ? sensor.sensorId === claim.sensorId
        : sensor.command !== null && sensor.command === claim.command.trim(),
    );
    if (descriptor === undefined) {
      return unresolved(
        claim,
        "gate-sensor",
        claim.kind === "sensor"
          ? `Sensor ${claim.sensorId} is not a check of gate ${input.gateId ?? "unknown"}`
          : `Command ${claim.command} does not match a configured sensor of gate ${input.gateId ?? "unknown"}`,
      );
    }
    if (input.stage === "pre-gate") {
      return resolved(
        claim,
        "gate-sensor",
        `Gate ${input.gateId ?? "unknown"} runs ${descriptor.sensorId}`,
      );
    }
    const reading = input.readings.find((candidate) => candidate.sensorId === descriptor.sensorId);
    if (reading === undefined) {
      return unresolved(
        claim,
        "gate-sensor",
        `Sensor ${descriptor.sensorId} produced no reading for this attempt`,
      );
    }
    return reading.matched && "verdict" in reading.result && reading.result.verdict === "pass"
      ? resolved(claim, "gate-sensor", `Sensor ${descriptor.sensorId} passed for this attempt`)
      : contradicted(
          claim,
          "gate-sensor",
          `Sensor ${descriptor.sensorId} did not pass for this attempt`,
        );
  }

  if (input.frozenPaths.some((pattern) => matchesPathPattern(claim.path, pattern))) {
    return contradicted(claim, "frozen-paths", `${claim.path} is inside a frozen path`);
  }
  if (!input.authorizedPaths.some((pattern) => matchesPathPattern(claim.path, pattern))) {
    return contradicted(
      claim,
      "authorized-paths",
      `${claim.path} is outside the authorized write scope for this task`,
    );
  }
  if (ADVISORY_EVIDENCE_RELATIONSHIPS.includes(claim.relationship)) {
    return {
      claim,
      resolution: "advisory",
      source: "authorized-paths",
      detail: `${claim.path} is in scope; Senawa did not verify that the worker ${claim.relationship} it`,
    };
  }
  if (claim.relationship === "validated") {
    const descriptor = input.gateSensors.find(
      (sensor) =>
        !sensor.advisory &&
        (sensor.scope.length === 0 ||
          sensor.scope.some((pattern) => matchesPathPattern(claim.path, pattern))),
    );
    if (descriptor === undefined) {
      return unresolved(claim, "gate-sensor", `No blocking gate sensor covers ${claim.path}`);
    }
    if (input.stage === "pre-gate") {
      return resolved(
        claim,
        "gate-sensor",
        `Gate ${input.gateId ?? "unknown"} runs ${descriptor.sensorId} over ${claim.path}`,
      );
    }
    const reading = input.readings.find((candidate) => candidate.sensorId === descriptor.sensorId);
    return reading?.matched === true
      ? resolved(claim, "gate-sensor", `Sensor ${descriptor.sensorId} passed over ${claim.path}`)
      : contradicted(
          claim,
          "gate-sensor",
          `Sensor ${descriptor.sensorId} did not pass over ${claim.path}`,
        );
  }

  const delta = input.repositoryDelta;
  if (delta === null) {
    return unresolved(
      claim,
      "repository-delta",
      "No repository delta was measured for this attempt",
    );
  }
  if (delta.frozenChanges.includes(claim.path)) {
    return contradicted(claim, "frozen-paths", `${claim.path} changed inside a frozen path`);
  }
  if (delta.outOfScopeChanges.includes(claim.path)) {
    return contradicted(
      claim,
      "authorized-paths",
      `${claim.path} changed outside the authorized write scope for this task`,
    );
  }
  const entry = delta.changedPaths.find((candidate) => candidate.path === claim.path);
  if (entry === undefined || !delta.inScopeChanges.includes(claim.path)) {
    return unresolved(
      claim,
      "repository-delta",
      `${claim.path} does not appear in the measured in-scope delta for this attempt`,
    );
  }
  return statusMatchesRelationship(entry.status, claim.relationship)
    ? resolved(claim, "repository-delta", `${claim.path} was ${claim.relationship} in this attempt`)
    : contradicted(
        claim,
        "repository-delta",
        `${claim.path} was measured as "${entry.status}", which does not match the claimed relationship ${claim.relationship}`,
      );
}

function statusMatchesRelationship(status: string, relationship: EvidenceRelationship): boolean {
  const codes = status.trim();
  if (relationship === "created") return codes.includes("?") || codes.includes("A");
  if (relationship === "deleted") return codes.includes("D");
  return codes.includes("M") || codes.includes("R") || codes.includes("T");
}

function resolved(
  claim: EvidenceReference,
  source: EvidenceResolutionSource,
  detail: string,
): ResolvedEvidenceReference {
  return { claim, resolution: "resolved", source, detail };
}

function unresolved(
  claim: EvidenceReference,
  source: EvidenceResolutionSource,
  detail: string,
): ResolvedEvidenceReference {
  return { claim, resolution: "unresolved", source, detail };
}

function contradicted(
  claim: EvidenceReference,
  source: EvidenceResolutionSource,
  detail: string,
): ResolvedEvidenceReference {
  return { claim, resolution: "contradicted", source, detail };
}
