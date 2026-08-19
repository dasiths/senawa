import {
  type Escalation,
  type EscalationOwner,
  type EscalationTrigger,
  validateEscalation,
} from "./budgets.js";
import {
  type AuthorityDecision,
  type PhaseCandidate,
  type PhaseClosure,
  type PhaseGenerationReference,
  validateAuthorityDecision,
  validatePhaseCandidate,
  validatePhaseClosure,
} from "./candidates.js";
import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import type { TaskGenerationReference, TerminalDisposition } from "./completion.js";
import { type GateEvaluation, type GateEvidence, validateGateEvidence } from "./gates.js";
import type { WorkflowGraph } from "./graph.js";
import {
  type CriterionId,
  type EscalationId,
  isDefinitionGeneration,
  isPhaseId,
} from "./identity.js";

export interface NoApprovalPolicy {
  readonly policy: "no-approval";
}

export interface RequiredApprovalPolicyInput {
  readonly policy: "approval-required";
  readonly authority: unknown;
}

export interface RequiredApprovalPolicy {
  readonly policy: "approval-required";
  readonly authority: CanonicalValue;
}

export type PhaseApprovalPolicyInput = NoApprovalPolicy | RequiredApprovalPolicyInput;
export type PhaseApprovalPolicy = NoApprovalPolicy | RequiredApprovalPolicy;

export interface PhaseLifecycleInput {
  readonly graph: WorkflowGraph;
  readonly phase: PhaseGenerationReference;
  readonly approvalPolicy: PhaseApprovalPolicyInput;
  readonly escalationPolicyDigest: Sha256Digest;
  readonly candidate?: PhaseCandidate;
  readonly gateEvidence?: GateEvidence;
  readonly authorityDecision?: AuthorityDecision;
  readonly closure?: PhaseClosure;
  readonly escalations?: readonly Escalation[];
  /** Set for an archived phase, whose candidate names an earlier graph revision. */
  readonly historical?: boolean;
}

export type PhaseLifecycleStatus =
  | "awaiting-completion"
  | "awaiting-gate"
  | "gate-rejected"
  | "awaiting-approval"
  | "approval-rejected"
  | "awaiting-closure"
  | "closed"
  | "escalated";

export interface TaskLifecycleAccount {
  readonly task: TaskGenerationReference;
  readonly assessmentDigest: Sha256Digest;
  readonly disposition: TerminalDisposition;
  readonly summary: string;
}

export interface TaskDispositionCounts {
  readonly completed: number;
  readonly blocked: number;
  readonly waived: number;
  readonly skipped: number;
  readonly superseded: number;
}

export interface TaskAccountingProjection {
  readonly selectedCount: number;
  readonly accountedCount: number;
  readonly dispositionCounts: TaskDispositionCounts;
  readonly accounts: readonly TaskLifecycleAccount[];
}

export interface ApprovalHumanNeed {
  readonly kind: "approval";
  readonly candidateDigest: Sha256Digest;
  readonly authority: CanonicalValue;
}

export interface EscalationHumanNeed {
  readonly kind: "escalation";
  readonly escalationId: EscalationId;
  readonly escalationDigest: Sha256Digest;
  readonly owner: EscalationOwner;
  readonly trigger: EscalationTrigger;
  readonly contextDigest: Sha256Digest;
  readonly candidateDigest: Sha256Digest;
  readonly policyDigest: Sha256Digest;
  readonly unresolvedCriterionIds: readonly CriterionId[];
  readonly failedReadingDigests: readonly Sha256Digest[];
  readonly unknownReadingDigests: readonly Sha256Digest[];
  readonly allowedResponses: Escalation["allowedResponses"];
}

export type PhaseHumanNeed = ApprovalHumanNeed | EscalationHumanNeed;

export interface LifecycleRecordDigests {
  readonly candidateDigest?: Sha256Digest;
  readonly gateEvaluationDigest?: Sha256Digest;
  readonly authorityDecisionDigest?: Sha256Digest;
  readonly closureDigest?: Sha256Digest;
  readonly escalationDigests: readonly Sha256Digest[];
}

export interface PhaseLifecycleProjection {
  readonly phase: PhaseGenerationReference;
  readonly status: PhaseLifecycleStatus;
  readonly approvalPolicy: PhaseApprovalPolicy;
  readonly escalationPolicyDigest: Sha256Digest;
  readonly taskAccounting: TaskAccountingProjection;
  readonly humanNeeds: readonly PhaseHumanNeed[];
  readonly records: LifecycleRecordDigests;
  readonly projectionDigest: Sha256Digest;
}

type PhaseLifecycleProjectionContent = Omit<PhaseLifecycleProjection, "projectionDigest">;

export type LifecycleErrorCode =
  | "invalid-input"
  | "phase-mismatch"
  | "candidate-required"
  | "gate-candidate-mismatch"
  | "gate-policy-mismatch"
  | "decision-policy-mismatch"
  | "decision-candidate-mismatch"
  | "decision-before-gate"
  | "wrong-authority"
  | "closure-source-missing"
  | "closure-escalation-conflict"
  | "duplicate-escalation"
  | "escalation-candidate-mismatch"
  | "escalation-policy-mismatch"
  | "escalation-owner-mismatch"
  | "escalation-context-mismatch";

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;

  constructor(code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}

export function projectPhaseLifecycle(
  input: PhaseLifecycleInput,
  sha256: Sha256,
): PhaseLifecycleProjection {
  const snapshot = snapshotInput(input);
  const graph = snapshot.graph as unknown as WorkflowGraph;
  const phase = phaseReference(snapshot.phase);
  const approvalPolicy = validateApprovalPolicy(snapshot.approvalPolicy);
  if (!isSha256Digest(snapshot.escalationPolicyDigest)) {
    fail("invalid-input", "escalationPolicyDigest must be a SHA-256 digest");
  }

  const candidate = Object.hasOwn(snapshot, "candidate")
    ? validatePhaseCandidate(snapshot.candidate, graph, sha256, {
        historical: snapshot.historical === true,
      })
    : undefined;
  const gateEvidence = Object.hasOwn(snapshot, "gateEvidence")
    ? candidate === undefined
      ? fail("candidate-required", "Gate evidence requires a candidate")
      : lifecycleGateEvidence(snapshot.gateEvidence, candidate, sha256)
    : undefined;
  const gateEvaluation = gateEvidence?.evaluation;
  const authorityDecision = Object.hasOwn(snapshot, "authorityDecision")
    ? validateAuthorityDecision(snapshot.authorityDecision, sha256)
    : undefined;
  const escalations = validateEscalations(snapshot.escalations, sha256);

  validateCandidateRelations(phase, candidate);
  validateGateRelations(candidate, gateEvidence);
  validateDecisionRelations(approvalPolicy, candidate, gateEvaluation, authorityDecision);
  validateEscalationRelations(phase, candidate, snapshot.escalationPolicyDigest, escalations);

  const closure = Object.hasOwn(snapshot, "closure")
    ? validateClosure(
        snapshot.closure,
        graph,
        candidate,
        gateEvidence,
        approvalPolicy,
        authorityDecision,
        sha256,
        snapshot.historical === true,
      )
    : undefined;
  if (closure !== undefined && escalations.length > 0) {
    fail(
      "closure-escalation-conflict",
      "A snapshot cannot contain both a closure and an active escalation without ordering facts",
    );
  }

  const status = deriveStatus(
    candidate,
    gateEvaluation,
    approvalPolicy,
    authorityDecision,
    closure,
    escalations,
  );
  const content: PhaseLifecycleProjectionContent = {
    phase,
    status,
    approvalPolicy,
    escalationPolicyDigest: snapshot.escalationPolicyDigest,
    taskAccounting: projectTaskAccounting(candidate),
    humanNeeds: projectHumanNeeds(status, approvalPolicy, candidate, escalations),
    records: recordDigests(candidate, gateEvaluation, authorityDecision, closure, escalations),
  };
  const projectionDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, projectionDigest }) as unknown as PhaseLifecycleProjection;
}

function snapshotInput(input: PhaseLifecycleInput): Record<string, unknown> {
  let snapshot: CanonicalValue;
  try {
    snapshot = canonicalValue(input);
  } catch {
    return fail("invalid-input", "Lifecycle input must be a stable canonical JSON value");
  }
  assertAllowedKeys(
    snapshot,
    ["graph", "phase", "approvalPolicy", "escalationPolicyDigest"],
    ["candidate", "gateEvidence", "authorityDecision", "closure", "escalations", "historical"],
  );
  return snapshot;
}

function phaseReference(value: unknown): PhaseGenerationReference {
  assertExactKeys(value, ["phaseId", "definitionGeneration"]);
  if (!isPhaseId(value.phaseId) || !isDefinitionGeneration(value.definitionGeneration)) {
    fail("invalid-input", "Lifecycle phase must be an exact phase generation reference");
  }
  return value as unknown as PhaseGenerationReference;
}

function validateApprovalPolicy(value: unknown): PhaseApprovalPolicy {
  if (!isRecord(value)) fail("invalid-input", "Approval policy must be an object");
  if (value.policy === "no-approval") {
    assertExactKeys(value, ["policy"]);
    return { policy: "no-approval" };
  }
  if (value.policy !== "approval-required") {
    fail("invalid-input", "Approval policy must be no-approval or approval-required");
  }
  assertExactKeys(value, ["policy", "authority"]);
  return { policy: value.policy, authority: value.authority as CanonicalValue };
}

function validateEscalations(value: unknown, sha256: Sha256): readonly Escalation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("invalid-input", "Lifecycle escalations must be an array");
  const escalations = value.map((escalation) => validateEscalation(escalation, sha256));
  const ids = new Set<EscalationId>();
  const digests = new Set<Sha256Digest>();
  for (const escalation of escalations) {
    if (ids.has(escalation.escalationId) || digests.has(escalation.escalationDigest)) {
      fail("duplicate-escalation", "Lifecycle escalations must have unique identities and digests");
    }
    ids.add(escalation.escalationId);
    digests.add(escalation.escalationDigest);
  }
  return escalations.sort((left, right) =>
    compareText(left.escalationDigest, right.escalationDigest),
  );
}

function validateCandidateRelations(
  phase: PhaseGenerationReference,
  candidate: PhaseCandidate | undefined,
): void {
  if (candidate !== undefined && !samePhase(phase, candidate.phase)) {
    fail("phase-mismatch", "Candidate does not belong to the projected phase generation");
  }
}

function validateGateRelations(
  candidate: PhaseCandidate | undefined,
  gateEvidence: GateEvidence | undefined,
): void {
  if (gateEvidence === undefined) return;
  if (candidate === undefined) fail("candidate-required", "Gate evidence requires a candidate");
  if (gateEvidence.definition.policyDigest !== candidate.gatePolicyDigest) {
    fail("gate-policy-mismatch", "Gate definition does not use the candidate gate policy");
  }
}

function lifecycleGateEvidence(
  value: unknown,
  candidate: PhaseCandidate,
  sha256: Sha256,
): GateEvidence {
  try {
    return validateGateEvidence(value, candidate.candidateDigest, sha256);
  } catch {
    return fail(
      "invalid-input",
      "Gate evidence must match its exact definition, readings, and candidate",
    );
  }
}

function validateDecisionRelations(
  approvalPolicy: PhaseApprovalPolicy,
  candidate: PhaseCandidate | undefined,
  gateEvaluation: GateEvaluation | undefined,
  authorityDecision: AuthorityDecision | undefined,
): void {
  if (authorityDecision === undefined) return;
  if (approvalPolicy.policy !== "approval-required") {
    fail("decision-policy-mismatch", "A no-approval policy cannot have an authority decision");
  }
  if (candidate === undefined)
    fail("candidate-required", "Authority decision requires a candidate");
  if (gateEvaluation === undefined || gateEvaluation.decision !== "accepted") {
    fail("decision-before-gate", "Authority decision requires an accepted gate evaluation");
  }
  if (authorityDecision.candidateDigest !== candidate.candidateDigest) {
    fail("decision-candidate-mismatch", "Authority decision is not bound to the current candidate");
  }
  if (
    canonicalSerialize(authorityDecision.principal) !== canonicalSerialize(approvalPolicy.authority)
  ) {
    fail("wrong-authority", "Authority decision principal does not match the required authority");
  }
}

function validateEscalationRelations(
  phase: PhaseGenerationReference,
  candidate: PhaseCandidate | undefined,
  escalationPolicyDigest: Sha256Digest,
  escalations: readonly Escalation[],
): void {
  if (escalations.length > 0 && candidate === undefined) {
    fail("candidate-required", "Escalations require a current candidate");
  }
  for (const escalation of escalations) {
    if (escalation.candidateDigest !== candidate?.candidateDigest) {
      fail("escalation-candidate-mismatch", "Escalation is not bound to the current candidate");
    }
    if (escalation.policyDigest !== escalationPolicyDigest) {
      fail("escalation-policy-mismatch", "Escalation does not use the current escalation policy");
    }
    validateEscalationOwner(phase, candidate as PhaseCandidate, escalation);
  }
}

function validateEscalationOwner(
  phase: PhaseGenerationReference,
  candidate: PhaseCandidate,
  escalation: Escalation,
): void {
  const owner = escalation.owner;
  if (owner.kind === "phase") {
    if (
      owner.phaseId !== phase.phaseId ||
      owner.definitionGeneration !== phase.definitionGeneration
    ) {
      fail(
        "escalation-owner-mismatch",
        "Phase escalation owner does not match the projected phase",
      );
    }
  } else {
    const task = candidate.tasks.find((item) => item.taskId === owner.taskId);
    if (
      task === undefined ||
      task.definitionGeneration !== owner.definitionGeneration ||
      task.contextRevisionDigest !== owner.contextRevisionDigest
    ) {
      fail("escalation-owner-mismatch", "Task escalation owner is not an exact candidate task");
    }
  }
  if (owner.contextRevisionDigest !== escalation.contextDigest) {
    fail("escalation-context-mismatch", "Escalation context does not match its owner revision");
  }
}

function validateClosure(
  value: unknown,
  graph: WorkflowGraph,
  candidate: PhaseCandidate | undefined,
  gateEvidence: GateEvidence | undefined,
  approvalPolicy: PhaseApprovalPolicy,
  authorityDecision: AuthorityDecision | undefined,
  sha256: Sha256,
  historical: boolean,
): PhaseClosure {
  if (candidate === undefined || gateEvidence === undefined) {
    return fail(
      "closure-source-missing",
      "Closure requires its current candidate and gate evidence",
    );
  }
  const approval =
    approvalPolicy.policy === "no-approval"
      ? approvalPolicy
      : authorityDecision === undefined
        ? fail("closure-source-missing", "Required-approval closure needs its authority decision")
        : { ...approvalPolicy, decision: authorityDecision };
  return validatePhaseClosure(
    value,
    {
      graph,
      candidate,
      gateEvidence,
      approval,
      ...(historical ? { historical: true } : {}),
    },
    sha256,
  );
}

function deriveStatus(
  candidate: PhaseCandidate | undefined,
  gateEvaluation: GateEvaluation | undefined,
  approvalPolicy: PhaseApprovalPolicy,
  authorityDecision: AuthorityDecision | undefined,
  closure: PhaseClosure | undefined,
  escalations: readonly Escalation[],
): PhaseLifecycleStatus {
  if (escalations.length > 0) return "escalated";
  if (candidate === undefined) return "awaiting-completion";
  if (gateEvaluation === undefined) return "awaiting-gate";
  if (gateEvaluation.decision === "rejected") return "gate-rejected";
  if (approvalPolicy.policy === "approval-required" && authorityDecision === undefined) {
    return "awaiting-approval";
  }
  if (authorityDecision?.decision === "reject") return "approval-rejected";
  if (closure !== undefined) return "closed";
  return "awaiting-closure";
}

function projectTaskAccounting(candidate: PhaseCandidate | undefined): TaskAccountingProjection {
  const dispositionCounts: Record<TerminalDisposition, number> = {
    completed: 0,
    blocked: 0,
    waived: 0,
    skipped: 0,
    superseded: 0,
  };
  if (candidate === undefined) {
    return { selectedCount: 0, accountedCount: 0, dispositionCounts, accounts: [] };
  }
  const accounts = candidate.acceptedAccountingAssessments.map((accepted) => {
    const submission = accepted.assessment.submission;
    dispositionCounts[submission.disposition] += 1;
    return {
      task: submission.task,
      assessmentDigest: accepted.assessmentDigest,
      disposition: submission.disposition,
      summary: submission.summary,
    };
  });
  return {
    selectedCount: candidate.tasks.length,
    accountedCount: accounts.length,
    dispositionCounts,
    accounts,
  };
}

function projectHumanNeeds(
  status: PhaseLifecycleStatus,
  approvalPolicy: PhaseApprovalPolicy,
  candidate: PhaseCandidate | undefined,
  escalations: readonly Escalation[],
): readonly PhaseHumanNeed[] {
  if (status === "escalated") {
    return escalations.map((escalation) => ({
      kind: "escalation",
      escalationId: escalation.escalationId,
      escalationDigest: escalation.escalationDigest,
      owner: escalation.owner,
      trigger: escalation.trigger,
      contextDigest: escalation.contextDigest,
      candidateDigest: escalation.candidateDigest,
      policyDigest: escalation.policyDigest,
      unresolvedCriterionIds: escalation.unresolvedCriterionIds,
      failedReadingDigests: escalation.failedReadingDigests,
      unknownReadingDigests: escalation.unknownReadingDigests,
      allowedResponses: escalation.allowedResponses,
    }));
  }
  if (status === "awaiting-approval" && approvalPolicy.policy === "approval-required") {
    return [
      {
        kind: "approval",
        candidateDigest: (candidate as PhaseCandidate).candidateDigest,
        authority: approvalPolicy.authority,
      },
    ];
  }
  return [];
}

function recordDigests(
  candidate: PhaseCandidate | undefined,
  gateEvaluation: GateEvaluation | undefined,
  authorityDecision: AuthorityDecision | undefined,
  closure: PhaseClosure | undefined,
  escalations: readonly Escalation[],
): LifecycleRecordDigests {
  return {
    ...(candidate === undefined ? {} : { candidateDigest: candidate.candidateDigest }),
    ...(gateEvaluation === undefined
      ? {}
      : { gateEvaluationDigest: gateEvaluation.evaluationDigest }),
    ...(authorityDecision === undefined
      ? {}
      : { authorityDecisionDigest: authorityDecision.decisionDigest }),
    ...(closure === undefined ? {} : { closureDigest: closure.closureDigest }),
    escalationDigests: escalations.map((escalation) => escalation.escalationDigest),
  };
}

function samePhase(left: PhaseGenerationReference, right: PhaseGenerationReference): boolean {
  return left.phaseId === right.phaseId && left.definitionGeneration === right.definitionGeneration;
}

function assertAllowedKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("invalid-input", "Lifecycle input must be an object");
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    fail(
      "invalid-input",
      `Lifecycle input fields must be exactly ${required.join(", ")} plus current records`,
    );
  }
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("invalid-input", "Lifecycle record must be an object");
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("invalid-input", `Lifecycle record fields must be exactly ${expected.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: LifecycleErrorCode, message: string): never {
  throw new LifecycleError(code, message);
}
