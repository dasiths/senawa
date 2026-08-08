import { z } from "zod";
import type { AcceptanceCriterion } from "./artifacts.js";
import {
  ArtifactIdSchema,
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
    /** Echoes an acceptance criterion id from the plan, which the planner authored. */
    id: ArtifactIdSchema,
    outcome: z.enum(["satisfied", "blocked", "not-applicable"]),
    /** Required: Senawa records this account rather than verifying it, so an omission is lost work. */
    summary: NonEmptyStringSchema.max(2_000),
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
        required: ["id", "outcome", "summary"],
        properties: {
          id: { type: "string", description: "An acceptance criterion id from this task prompt" },
          outcome: { enum: ["satisfied", "blocked", "not-applicable"] },
          summary: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
            description: "What you actually did for this criterion. Recorded, not verified.",
          },
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

export type EvidenceResolution = "recorded" | "contradicted";

export type EvidenceResolutionSource = "repository-delta" | "frozen-paths" | "none";

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

  const evidence = claim.evidence.map((reference) => recordReference(reference, input));

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

  // The claim is the evidence. Senawa records what the worker states and does not verify it.
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

function recordReference(
  claim: EvidenceReference,
  input: TaskCompletionAssessmentInput,
): ResolvedEvidenceReference {
  if (claim.kind === "file" && input.frozenPaths.some((p) => matchesPathPattern(claim.path, p))) {
    return contradicted(claim, "frozen-paths", `${claim.path} is inside a frozen path`);
  }
  const delta = input.repositoryDelta;
  if (claim.kind === "file" && delta !== null) {
    const measured = delta.changedPaths.some((entry) => entry.path === claim.path);
    return {
      claim,
      resolution: "recorded",
      source: "repository-delta",
      detail: measured
        ? `${claim.path} was ${claim.relationship} and a change was measured for this attempt`
        : `${claim.path} was ${claim.relationship}; no change was measured for this attempt`,
    };
  }
  return {
    claim,
    resolution: "recorded",
    source: "none",
    detail: `Recorded as stated by the worker`,
  };
}

function statusMatchesRelationship(status: string, relationship: EvidenceRelationship): boolean {
  const codes = status.trim();
  if (relationship === "created") return codes.includes("?") || codes.includes("A");
  if (relationship === "deleted") return codes.includes("D");
  return codes.includes("M") || codes.includes("R") || codes.includes("T");
}

function contradicted(
  claim: EvidenceReference,
  source: EvidenceResolutionSource,
  detail: string,
): ResolvedEvidenceReference {
  return { claim, resolution: "contradicted", source, detail };
}
