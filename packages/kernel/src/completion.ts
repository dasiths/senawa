import {
  type CanonicalValue,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256Digest,
} from "./canonical.js";
import {
  type AssetId,
  type CriterionId,
  type DefinitionGeneration,
  isAssetId,
  isCriterionId,
  isDefinitionGeneration,
  isTaskId,
  type TaskId,
} from "./identity.js";

export interface TaskGenerationReference {
  readonly taskId: TaskId;
  readonly definitionGeneration: DefinitionGeneration;
  readonly contextRevisionDigest: Sha256Digest;
}

export type TerminalDisposition = "completed" | "blocked" | "waived" | "skipped" | "superseded";

export type CriterionDisposition = "satisfied" | "unsatisfied" | "waived" | "skipped";

export interface CriterionRequirement {
  readonly criterionId: CriterionId;
  readonly required: boolean;
}

export interface EvidenceRequirement {
  readonly kind: CanonicalValue;
  readonly minimumCount: number;
}

export type EvidencePolicyMode = "none" | "task" | "required-criteria" | "all-satisfied";

export interface EvidencePolicy {
  readonly mode: EvidencePolicyMode;
  readonly requirements: readonly EvidenceRequirement[];
  readonly waiverAuthority?: CanonicalValue;
}

export interface CompletionPolicy {
  readonly criteria: readonly CriterionRequirement[];
  readonly evidencePolicy: EvidencePolicy;
}

export interface CompletionRequirements extends CompletionPolicy {
  readonly task: TaskGenerationReference;
}

export interface EvidenceAttachment {
  readonly assetId: AssetId;
  readonly kind: CanonicalValue;
  readonly descriptor: CanonicalValue;
  readonly criterionId?: CriterionId;
}

export interface CriterionOutcome {
  readonly criterionId: CriterionId;
  readonly disposition: CriterionDisposition;
  readonly authorityFact?: CanonicalValue;
}

export interface CompletionSubmission {
  readonly task: TaskGenerationReference;
  readonly disposition: TerminalDisposition;
  readonly summary: string;
  readonly criteria: readonly CriterionOutcome[];
  readonly evidence: readonly EvidenceAttachment[];
  readonly replacementTask?: TaskGenerationReference;
}

export interface EvidenceRequirementAssessment {
  readonly kind: CanonicalValue;
  readonly minimumCount: number;
  readonly attachmentCount: number;
  readonly satisfied: boolean;
}

export interface CriterionAssessment {
  readonly criterionId: CriterionId;
  readonly required: boolean;
  readonly disposition: CriterionDisposition;
  readonly evidence: readonly EvidenceRequirementAssessment[];
  readonly evidenceSatisfied: boolean;
}

export interface AccountingAssessment {
  readonly submission: CompletionSubmission;
  readonly criteria: readonly CriterionAssessment[];
  readonly taskEvidence: readonly EvidenceRequirementAssessment[];
  readonly evidencePolicySatisfied: boolean;
}

export type CompletionAccountingErrorCode =
  | "invalid-requirements"
  | "invalid-submission"
  | "invalid-assessment"
  | "task-reference-mismatch"
  | "duplicate-criterion"
  | "unknown-criterion"
  | "missing-criterion"
  | "required-skip"
  | "invalid-waiver"
  | "invalid-supersession"
  | "duplicate-evidence";

export class CompletionAccountingError extends Error {
  readonly code: CompletionAccountingErrorCode;

  constructor(code: CompletionAccountingErrorCode, message: string) {
    super(message);
    this.name = "CompletionAccountingError";
    this.code = code;
  }
}

export function assessCompletionAccounting(
  requirements: CompletionRequirements,
  submission: CompletionSubmission,
): AccountingAssessment {
  const requirementsSnapshot = snapshotInput(
    requirements,
    "invalid-requirements",
    "Completion requirements",
  );
  const submissionSnapshot = snapshotInput(
    submission,
    "invalid-submission",
    "Completion submissions",
  );
  return assessCompletionSnapshots(requirementsSnapshot, submissionSnapshot);
}

export function validateCompletionRequirements(value: unknown): CompletionRequirements {
  return validateRequirements(
    snapshotInput(value, "invalid-requirements", "Completion requirements"),
  );
}

export function validateCompletionPolicy(value: unknown): CompletionPolicy {
  const snapshot = snapshotInput(value, "invalid-requirements", "Completion policies");
  return validatePolicy(snapshot, "completion policy");
}

export function reassessCompletionAccounting(
  requirements: CompletionRequirements,
  submittedAssessment: AccountingAssessment,
): AccountingAssessment {
  const snapshot = snapshotInput(
    { requirements, submittedAssessment },
    "invalid-assessment",
    "Completion reassessment inputs",
  );
  assertExactKeys(
    snapshot,
    "completion reassessment input",
    ["requirements", "submittedAssessment"],
    "invalid-assessment",
  );
  if (
    snapshot.submittedAssessment === null ||
    typeof snapshot.submittedAssessment !== "object" ||
    Array.isArray(snapshot.submittedAssessment) ||
    !Object.hasOwn(snapshot.submittedAssessment, "submission")
  ) {
    fail("invalid-assessment", "Submitted accounting assessments must contain a submission");
  }
  const assessmentSnapshot = snapshot.submittedAssessment as CanonicalValue &
    Record<string, CanonicalValue>;

  let reassessed: AccountingAssessment;
  try {
    reassessed = assessCompletionSnapshots(snapshot.requirements, assessmentSnapshot.submission);
  } catch (error) {
    if (error instanceof CompletionAccountingError) {
      fail(
        "invalid-assessment",
        `Submitted accounting assessment cannot be reassessed: ${error.message}`,
      );
    }
    throw error;
  }
  if (
    canonicalSerialize(assessmentSnapshot) !==
    canonicalSerialize(reassessed as unknown as CanonicalValue)
  ) {
    fail(
      "invalid-assessment",
      "Submitted accounting assessment does not match reassessment from exact requirements",
    );
  }
  return reassessed;
}

function assessCompletionSnapshots(
  requirementsSnapshot: unknown,
  submissionSnapshot: unknown,
): AccountingAssessment {
  const validatedRequirements = validateRequirements(requirementsSnapshot);
  const validatedSubmission = validateSubmission(submissionSnapshot);
  assertSameTaskReference(validatedRequirements.task, validatedSubmission.task);

  const requirementsByCriterion = new Map<CriterionId, CriterionRequirement>();
  for (const requirement of validatedRequirements.criteria) {
    if (requirementsByCriterion.has(requirement.criterionId)) {
      fail(
        "duplicate-criterion",
        `Criterion ${requirement.criterionId} is declared more than once`,
      );
    }
    requirementsByCriterion.set(requirement.criterionId, requirement);
  }

  const outcomesByCriterion = new Map<CriterionId, CriterionOutcome>();
  for (const outcome of validatedSubmission.criteria) {
    if (outcomesByCriterion.has(outcome.criterionId)) {
      fail(
        "duplicate-criterion",
        `Criterion ${outcome.criterionId} has more than one submitted outcome`,
      );
    }
    const requirement = requirementsByCriterion.get(outcome.criterionId);
    if (requirement === undefined) {
      fail("unknown-criterion", `Criterion ${outcome.criterionId} is not declared for the task`);
    }
    assertCriterionOutcome(requirement, outcome, validatedRequirements.evidencePolicy);
    outcomesByCriterion.set(outcome.criterionId, outcome);
  }

  for (const requirement of validatedRequirements.criteria) {
    if (!outcomesByCriterion.has(requirement.criterionId)) {
      fail("missing-criterion", `Criterion ${requirement.criterionId} has no submitted outcome`);
    }
  }

  assertEvidenceReferences(validatedSubmission.evidence, requirementsByCriterion);
  const taskEvidence =
    validatedRequirements.evidencePolicy.mode === "task"
      ? assessEvidenceRequirements(
          validatedRequirements.evidencePolicy.requirements,
          validatedSubmission.evidence.filter((attachment) => attachment.criterionId === undefined),
        )
      : [];

  const criterionAssessments = validatedRequirements.criteria.map((requirement) => {
    const outcome = outcomesByCriterion.get(requirement.criterionId) as CriterionOutcome;
    const evidenceRequired =
      (validatedRequirements.evidencePolicy.mode === "required-criteria" && requirement.required) ||
      (validatedRequirements.evidencePolicy.mode === "all-satisfied" &&
        outcome.disposition === "satisfied");
    const evidence = evidenceRequired
      ? assessEvidenceRequirements(
          validatedRequirements.evidencePolicy.requirements,
          validatedSubmission.evidence.filter(
            (attachment) => attachment.criterionId === requirement.criterionId,
          ),
        )
      : [];
    return {
      criterionId: requirement.criterionId,
      required: requirement.required,
      disposition: outcome.disposition,
      evidence,
      evidenceSatisfied: evidence.every((assessment) => assessment.satisfied),
    };
  });

  return canonicalValue({
    submission: validatedSubmission,
    criteria: criterionAssessments,
    taskEvidence,
    evidencePolicySatisfied:
      taskEvidence.every((assessment) => assessment.satisfied) &&
      criterionAssessments.every((assessment) => assessment.evidenceSatisfied),
  }) as unknown as AccountingAssessment;
}

function snapshotInput(
  value: unknown,
  code: "invalid-requirements" | "invalid-submission" | "invalid-assessment",
  label: string,
): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    return fail(code, `${label} must be stable canonical JSON values`);
  }
}

function validateRequirements(value: unknown): CompletionRequirements {
  assertExactKeys(
    value,
    "requirements",
    ["task", "criteria", "evidencePolicy"],
    "invalid-requirements",
  );
  taskReference(value.task, "requirements.task", "invalid-requirements");
  validatePolicy(
    { criteria: value.criteria, evidencePolicy: value.evidencePolicy },
    "requirements",
  );
  return value as unknown as CompletionRequirements;
}

function validatePolicy(value: unknown, path: string): CompletionPolicy {
  assertExactKeys(value, path, ["criteria", "evidencePolicy"], "invalid-requirements");
  if (!Array.isArray(value.criteria)) {
    fail("invalid-requirements", `${path}.criteria must be an array`);
  }
  const seenCriteria = new Set<CriterionId>();
  value.criteria.forEach((criterion, index) => {
    const criterionPath = `${path}.criteria[${index}]`;
    assertExactKeys(criterion, criterionPath, ["criterionId", "required"], "invalid-requirements");
    if (!isCriterionId(criterion.criterionId) || typeof criterion.required !== "boolean") {
      fail(
        "invalid-requirements",
        `${criterionPath} must contain a criterion identity and required boolean`,
      );
    }
    if (seenCriteria.has(criterion.criterionId)) {
      fail("duplicate-criterion", `Criterion ${criterion.criterionId} is declared more than once`);
    }
    seenCriteria.add(criterion.criterionId);
  });
  evidencePolicy(value.evidencePolicy, `${path}.evidencePolicy`);
  return value as unknown as CompletionPolicy;
}

function evidencePolicy(value: unknown, path: string): EvidencePolicy {
  assertAllowedKeys(
    value,
    path,
    ["mode", "requirements"],
    ["waiverAuthority"],
    "invalid-requirements",
  );
  if (
    value.mode !== "none" &&
    value.mode !== "task" &&
    value.mode !== "required-criteria" &&
    value.mode !== "all-satisfied"
  ) {
    fail("invalid-requirements", "Evidence policy mode is not recognized");
  }
  if (!Array.isArray(value.requirements)) {
    fail("invalid-requirements", "Evidence policy requirements must be an array");
  }
  if (value.mode === "none" && value.requirements.length !== 0) {
    fail("invalid-requirements", "The none evidence policy cannot declare requirements");
  }
  if (value.mode !== "none" && value.requirements.length === 0) {
    fail("invalid-requirements", "Evidence policies other than none require at least one kind");
  }

  const seenKinds = new Set<string>();
  const requirements = value.requirements.map((requirement, index) => {
    const requirementPath = `${path}.requirements[${index}]`;
    assertExactKeys(requirement, requirementPath, ["kind", "minimumCount"], "invalid-requirements");
    const minimumCount = requirement.minimumCount;
    if (
      typeof minimumCount !== "number" ||
      !Number.isSafeInteger(minimumCount) ||
      minimumCount < 1
    ) {
      fail(
        "invalid-requirements",
        `${requirementPath}.minimumCount must be a positive safe integer`,
      );
    }
    const serializedKind = canonicalSerialize(requirement.kind as CanonicalValue);
    if (seenKinds.has(serializedKind)) {
      fail(
        "invalid-requirements",
        `${requirementPath}.kind duplicates another evidence requirement`,
      );
    }
    seenKinds.add(serializedKind);
    return requirement as unknown as EvidenceRequirement;
  });

  return Object.hasOwn(value, "waiverAuthority")
    ? { mode: value.mode, requirements, waiverAuthority: value.waiverAuthority as CanonicalValue }
    : { mode: value.mode, requirements };
}

function validateSubmission(value: unknown): CompletionSubmission {
  assertAllowedKeys(
    value,
    "submission",
    ["task", "disposition", "summary", "criteria", "evidence"],
    ["replacementTask"],
    "invalid-submission",
  );
  const task = taskReference(value.task, "submission.task", "invalid-submission");
  if (!isTerminalDisposition(value.disposition)) {
    fail("invalid-submission", "Submission disposition is not terminal");
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    fail("invalid-submission", "Submission summary must be a non-empty string");
  }
  if (!Array.isArray(value.criteria) || !Array.isArray(value.evidence)) {
    fail("invalid-submission", "Submission criteria and evidence must be arrays");
  }
  const criteria = value.criteria.map((outcome, index) =>
    criterionOutcome(outcome, `submission.criteria[${index}]`),
  );
  const evidence = value.evidence.map((attachment, index) =>
    evidenceAttachment(attachment, `submission.evidence[${index}]`),
  );

  const hasReplacement = Object.hasOwn(value, "replacementTask");
  if (value.disposition === "superseded") {
    if (!hasReplacement) {
      fail("invalid-supersession", "A superseded submission requires a replacement task");
    }
    const replacementTask = taskReference(
      value.replacementTask,
      "submission.replacementTask",
      "invalid-supersession",
    );
    if (sameTaskReference(task, replacementTask)) {
      fail("invalid-supersession", "A replacement task must differ from the superseded task");
    }
    return {
      task,
      disposition: value.disposition,
      summary: value.summary,
      criteria,
      evidence,
      replacementTask,
    };
  }
  if (hasReplacement) {
    fail("invalid-supersession", "Only a superseded submission may name a replacement task");
  }
  return { task, disposition: value.disposition, summary: value.summary, criteria, evidence };
}

function taskReference(
  value: unknown,
  path: string,
  code: CompletionAccountingErrorCode,
): TaskGenerationReference {
  assertExactKeys(value, path, ["taskId", "definitionGeneration", "contextRevisionDigest"], code);
  if (!isTaskId(value.taskId)) {
    fail(code, `${path}.taskId must be a task identity`);
  }
  if (!isDefinitionGeneration(value.definitionGeneration)) {
    fail(code, `${path}.definitionGeneration must be a definition generation`);
  }
  if (!isSha256Digest(value.contextRevisionDigest)) {
    fail(code, `${path}.contextRevisionDigest must be a SHA-256 digest`);
  }
  return value as unknown as TaskGenerationReference;
}

function criterionOutcome(value: unknown, path: string): CriterionOutcome {
  assertAllowedKeys(
    value,
    path,
    ["criterionId", "disposition"],
    ["authorityFact"],
    "invalid-submission",
  );
  if (!isCriterionId(value.criterionId) || !isCriterionDisposition(value.disposition)) {
    fail(
      "invalid-submission",
      `${path} must contain a criterion identity and recognized disposition`,
    );
  }
  if (value.disposition !== "waived" && Object.hasOwn(value, "authorityFact")) {
    fail("invalid-waiver", `${path}.authorityFact is valid only for a waived criterion`);
  }
  return value as unknown as CriterionOutcome;
}

function evidenceAttachment(value: unknown, path: string): EvidenceAttachment {
  assertAllowedKeys(
    value,
    path,
    ["assetId", "kind", "descriptor"],
    ["criterionId"],
    "invalid-submission",
  );
  if (!isAssetId(value.assetId)) {
    fail("invalid-submission", `${path}.assetId must be an asset identity`);
  }
  if (Object.hasOwn(value, "criterionId") && !isCriterionId(value.criterionId)) {
    fail("invalid-submission", `${path}.criterionId must be a criterion identity`);
  }
  return value as unknown as EvidenceAttachment;
}

function assertCriterionOutcome(
  requirement: CriterionRequirement,
  outcome: CriterionOutcome,
  policy: EvidencePolicy,
): void {
  if (requirement.required && outcome.disposition === "skipped") {
    fail("required-skip", `Required criterion ${requirement.criterionId} cannot be skipped`);
  }
  if (requirement.required && outcome.disposition === "waived") {
    if (!Object.hasOwn(policy, "waiverAuthority") || !Object.hasOwn(outcome, "authorityFact")) {
      fail(
        "invalid-waiver",
        `Required criterion ${requirement.criterionId} needs the configured waiver authority`,
      );
    }
    if (
      canonicalSerialize(outcome.authorityFact as CanonicalValue) !==
      canonicalSerialize(policy.waiverAuthority as CanonicalValue)
    ) {
      fail(
        "invalid-waiver",
        `Required criterion ${requirement.criterionId} has the wrong waiver authority`,
      );
    }
  }
}

function assertEvidenceReferences(
  attachments: readonly EvidenceAttachment[],
  criteria: ReadonlyMap<CriterionId, CriterionRequirement>,
): void {
  const assetIds = new Set<AssetId>();
  for (const attachment of attachments) {
    if (assetIds.has(attachment.assetId)) {
      fail("duplicate-evidence", `Evidence asset ${attachment.assetId} is attached more than once`);
    }
    assetIds.add(attachment.assetId);
    if (attachment.criterionId !== undefined && !criteria.has(attachment.criterionId)) {
      fail(
        "unknown-criterion",
        `Evidence asset ${attachment.assetId} names unknown criterion ${attachment.criterionId}`,
      );
    }
  }
}

function assessEvidenceRequirements(
  requirements: readonly EvidenceRequirement[],
  attachments: readonly EvidenceAttachment[],
): EvidenceRequirementAssessment[] {
  return requirements.map((requirement) => {
    const expectedKind = canonicalSerialize(requirement.kind);
    const attachmentCount = attachments.filter(
      (attachment) => canonicalSerialize(attachment.kind) === expectedKind,
    ).length;
    return {
      kind: requirement.kind,
      minimumCount: requirement.minimumCount,
      attachmentCount,
      satisfied: attachmentCount >= requirement.minimumCount,
    };
  });
}

function assertSameTaskReference(
  expected: TaskGenerationReference,
  actual: TaskGenerationReference,
): void {
  if (!sameTaskReference(expected, actual)) {
    fail("task-reference-mismatch", "Submission task generation does not match requirements");
  }
}

function sameTaskReference(left: TaskGenerationReference, right: TaskGenerationReference): boolean {
  return (
    left.taskId === right.taskId &&
    left.definitionGeneration === right.definitionGeneration &&
    left.contextRevisionDigest === right.contextRevisionDigest
  );
}

function isTerminalDisposition(value: unknown): value is TerminalDisposition {
  return (
    value === "completed" ||
    value === "blocked" ||
    value === "waived" ||
    value === "skipped" ||
    value === "superseded"
  );
}

function isCriterionDisposition(value: unknown): value is CriterionDisposition {
  return (
    value === "satisfied" || value === "unsatisfied" || value === "waived" || value === "skipped"
  );
}

function assertExactKeys(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
  code: CompletionAccountingErrorCode,
): asserts value is Record<string, unknown> {
  assertAllowedKeys(value, path, expectedKeys, [], code);
}

function assertAllowedKeys(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: CompletionAccountingErrorCode,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${path} must be an object`);
  }
  const actual = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    fail(
      code,
      `${path} fields must be exactly ${requiredKeys.join(", ")}${
        optionalKeys.length === 0 ? "" : ` with optional ${optionalKeys.join(", ")}`
      }`,
    );
  }
}

function fail(code: CompletionAccountingErrorCode, message: string): never {
  throw new CompletionAccountingError(code, message);
}
