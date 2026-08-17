import type { PhaseGenerationReference } from "./candidates.js";
import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import {
  type CriterionDefinitionInput,
  compileWorkflowGraph,
  type NormalizedWorkflowInput,
  normalizedWorkflowInputFromGraph,
  type PhaseDefinition,
  type PhaseDefinitionInput,
  type TaskDefinitionInput,
  validateWorkflowGraph,
  type WorkflowGraph,
} from "./graph.js";
import {
  type AmendmentId,
  type ApprovalId,
  amendmentId,
  type CriterionId,
  type DefinitionGeneration,
  isAmendmentId,
  isApprovalId,
  isCriterionId,
  isDefinitionGeneration,
  isPhaseId,
  isTaskId,
} from "./identity.js";

export const AMENDMENT_PROPOSAL_API_VERSION = "senawa.dev/amendment-proposal/v1";

export interface AddPhaseOperation {
  readonly kind: "add-phase";
  readonly phase: PhaseDefinitionInput;
}

export interface AddTaskOperation {
  readonly kind: "add-task";
  readonly task: TaskDefinitionInput;
  readonly criteria: readonly CriterionDefinitionInput[];
}

export type NormalizedAmendmentOperation = AddPhaseOperation | AddTaskOperation;

export interface AmendmentTaskGenerationReference {
  readonly taskId: import("./identity.js").TaskId;
  readonly definitionGeneration: DefinitionGeneration;
}

export interface CriterionGenerationReference {
  readonly criterionId: CriterionId;
  readonly definitionGeneration: DefinitionGeneration;
}

export interface AmendmentImpact {
  readonly addedPhases: readonly PhaseGenerationReference[];
  readonly addedTasks: readonly AmendmentTaskGenerationReference[];
  readonly addedCriteria: readonly CriterionGenerationReference[];
  readonly existingTargetPhases: readonly PhaseGenerationReference[];
  readonly affectedTaskScopes: readonly AmendmentTaskGenerationReference[];
  readonly impactDigest: Sha256Digest;
}

export interface AmendmentProposalInput {
  readonly source: unknown;
  readonly baseGraph: WorkflowGraph;
  readonly baseContextDigest: Sha256Digest;
  readonly baseConfigurationSnapshotDigest: Sha256Digest;
  readonly resultConfigurationSnapshotDigest: Sha256Digest;
  readonly operations: readonly NormalizedAmendmentOperation[];
  readonly phaseCandidateHistory: readonly PhaseGenerationReference[];
}

export interface AmendmentProposal {
  readonly apiVersion: typeof AMENDMENT_PROPOSAL_API_VERSION;
  readonly amendmentId: AmendmentId;
  readonly source: CanonicalValue;
  readonly baseGraph: WorkflowGraph;
  readonly baseContextDigest: Sha256Digest;
  readonly baseConfigurationSnapshotDigest: Sha256Digest;
  readonly resultConfigurationSnapshotDigest: Sha256Digest;
  readonly operations: readonly NormalizedAmendmentOperation[];
  readonly phaseCandidateHistory: readonly PhaseGenerationReference[];
  readonly impact: AmendmentImpact;
  readonly reviewedResultGraph: WorkflowGraph;
  readonly proposalDigest: Sha256Digest;
}

type AmendmentProposalContent = Omit<AmendmentProposal, "amendmentId" | "proposalDigest">;

export type AmendmentDecisionKind = "approve" | "reject";

export interface AmendmentDecisionInput {
  readonly decision: AmendmentDecisionKind;
  readonly approvalId: ApprovalId;
  readonly principal: unknown;
  readonly occurredAt: string;
}

export interface AmendmentDecisionContext {
  readonly currentGraph: WorkflowGraph;
  readonly phaseCandidateHistory: readonly PhaseGenerationReference[];
  readonly pendingProposals?: readonly AmendmentProposal[];
  readonly withdrawal?: AmendmentWithdrawal;
}

export interface AmendmentDecision {
  readonly decision: AmendmentDecisionKind;
  readonly approvalId: ApprovalId;
  readonly principal: CanonicalValue;
  readonly occurredAt: string;
  readonly amendmentId: AmendmentId;
  readonly proposalDigest: Sha256Digest;
  readonly baseGraphRevisionDigest: Sha256Digest;
  readonly reviewedResultGraphRevisionDigest: Sha256Digest;
  readonly decisionDigest: Sha256Digest;
}

type AmendmentDecisionContent = Omit<AmendmentDecision, "decisionDigest">;

export interface AmendmentWithdrawalInput {
  readonly principal: unknown;
  readonly occurredAt: string;
}

export interface AmendmentWithdrawal {
  readonly amendmentId: AmendmentId;
  readonly proposalDigest: Sha256Digest;
  readonly principal: CanonicalValue;
  readonly occurredAt: string;
  readonly withdrawalDigest: Sha256Digest;
}

type AmendmentWithdrawalContent = Omit<AmendmentWithdrawal, "withdrawalDigest">;

export interface AmendmentQuiescenceFactInput {
  readonly occurredAt: string;
  readonly affectedTaskScopes: readonly AmendmentTaskGenerationReference[];
  readonly liveClaimCount: number;
  readonly nonterminalEffectCount: number;
}

export interface AmendmentQuiescenceFact extends AmendmentQuiescenceFactInput {
  readonly amendmentId: AmendmentId;
  readonly proposalDigest: Sha256Digest;
  readonly factDigest: Sha256Digest;
}

type AmendmentQuiescenceFactContent = Omit<AmendmentQuiescenceFact, "factDigest">;

export interface AmendmentApplicationInput {
  readonly proposal: AmendmentProposal;
  readonly decision: AmendmentDecision;
  readonly currentGraph: WorkflowGraph;
  readonly quiescence: AmendmentQuiescenceFact;
  readonly occurredAt: string;
  readonly phaseCandidateHistory: readonly PhaseGenerationReference[];
  readonly withdrawal?: AmendmentWithdrawal;
}

export interface AmendmentApplication {
  readonly amendmentId: AmendmentId;
  readonly proposalDigest: Sha256Digest;
  readonly decisionDigest: Sha256Digest;
  readonly beforeGraphRevisionDigest: Sha256Digest;
  readonly afterGraphRevisionDigest: Sha256Digest;
  readonly quiescenceFactDigest: Sha256Digest;
  readonly occurredAt: string;
  readonly graph: WorkflowGraph;
  readonly applicationDigest: Sha256Digest;
}

type AmendmentApplicationContent = Omit<AmendmentApplication, "applicationDigest">;

export type AmendmentLifecycleStatus =
  | "reviewable"
  | "overlapping"
  | "stale"
  | "withdrawn"
  | "rejected"
  | "approved-awaiting-quiescence"
  | "applied";

export interface AmendmentLifecycleInput {
  readonly proposal: AmendmentProposal;
  readonly currentGraph: WorkflowGraph;
  readonly phaseCandidateHistory: readonly PhaseGenerationReference[];
  readonly pendingProposals?: readonly AmendmentProposal[];
  readonly decision?: AmendmentDecision;
  readonly withdrawal?: AmendmentWithdrawal;
  readonly application?: AmendmentApplication;
}

export interface AmendmentLifecycleProjection {
  readonly amendmentId: AmendmentId;
  readonly proposalDigest: Sha256Digest;
  readonly status: AmendmentLifecycleStatus;
  readonly impactDigest: Sha256Digest;
  readonly decisionDigest?: Sha256Digest;
  readonly withdrawalDigest?: Sha256Digest;
  readonly applicationDigest?: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
}

export type AmendmentErrorCode =
  | "invalid-proposal"
  | "invalid-operation"
  | "non-additive-change"
  | "candidate-history"
  | "invalid-impact"
  | "invalid-decision"
  | "stale-base"
  | "overlapping-proposal"
  | "withdrawn-proposal"
  | "invalid-withdrawal"
  | "invalid-quiescence"
  | "not-approved"
  | "invalid-application"
  | "conflicting-lifecycle";

export class AmendmentError extends Error {
  readonly code: AmendmentErrorCode;

  constructor(code: AmendmentErrorCode, message: string) {
    super(message);
    this.name = "AmendmentError";
    this.code = code;
  }
}

export function createAmendmentProposal(
  input: AmendmentProposalInput,
  sha256: Sha256,
): AmendmentProposal {
  const snapshot = snapshotCanonical(input, "invalid-proposal", "Amendment proposals");
  const content = proposalContent(snapshot, sha256);
  const proposalDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({
    ...content,
    amendmentId: amendmentId(`amendment_${proposalDigest}`),
    proposalDigest,
  }) as unknown as AmendmentProposal;
}

export function validateAmendmentProposal(
  value: unknown,
  phaseCandidateHistory: readonly PhaseGenerationReference[],
  sha256: Sha256,
): AmendmentProposal {
  const snapshot = snapshotCanonical(value, "invalid-proposal", "Amendment proposals");
  assertExactKeys(
    snapshot,
    "amendment proposal",
    [
      "apiVersion",
      "amendmentId",
      "source",
      "baseGraph",
      "baseContextDigest",
      "baseConfigurationSnapshotDigest",
      "resultConfigurationSnapshotDigest",
      "operations",
      "phaseCandidateHistory",
      "impact",
      "reviewedResultGraph",
      "proposalDigest",
    ],
    "invalid-proposal",
  );
  if (!isSha256Digest(snapshot.proposalDigest) || !isAmendmentId(snapshot.amendmentId)) {
    fail("invalid-proposal", "Proposal identity and digest must use their exact lexical forms");
  }
  validatePhaseCandidateHistory(phaseCandidateHistory);
  const content = proposalContent(snapshot, sha256);
  const proposalDigest = canonicalDigest(canonicalValue(content), sha256);
  if (proposalDigest !== snapshot.proposalDigest) {
    fail("invalid-proposal", "proposalDigest does not match the exact proposal content");
  }
  if (snapshot.amendmentId !== `amendment_${proposalDigest}`) {
    fail("invalid-proposal", "amendmentId must be content-addressed by proposalDigest");
  }
  return canonicalValue({
    ...content,
    amendmentId: snapshot.amendmentId,
    proposalDigest,
  }) as unknown as AmendmentProposal;
}

export function digestAmendmentImpact(
  impact: Omit<AmendmentImpact, "impactDigest">,
  sha256: Sha256,
): Sha256Digest {
  return canonicalDigest(canonicalValue(impact), sha256);
}

export function amendmentImpactsOverlap(left: AmendmentImpact, right: AmendmentImpact): boolean {
  const rightPhases = new Set(right.existingTargetPhases.map(({ phaseId }) => phaseId));
  if (left.existingTargetPhases.some(({ phaseId }) => rightPhases.has(phaseId))) return true;
  const rightScopes = new Set(
    right.affectedTaskScopes.map(
      ({ taskId, definitionGeneration }) => `${taskId}@${definitionGeneration}`,
    ),
  );
  return left.affectedTaskScopes.some(({ taskId, definitionGeneration }) =>
    rightScopes.has(`${taskId}@${definitionGeneration}`),
  );
}

export function createAmendmentDecision(
  input: AmendmentDecisionInput,
  proposalValue: AmendmentProposal,
  context: AmendmentDecisionContext,
  sha256: Sha256,
): AmendmentDecision {
  const proposal = validateAmendmentProposal(proposalValue, context.phaseCandidateHistory, sha256);
  const currentGraph = validateWorkflowGraph(context.currentGraph, sha256);
  const snapshot = snapshotCanonical(input, "invalid-decision", "Amendment decisions");
  assertExactKeys(
    snapshot,
    "amendment decision input",
    ["decision", "approvalId", "principal", "occurredAt"],
    "invalid-decision",
  );
  if (
    (snapshot.decision !== "approve" && snapshot.decision !== "reject") ||
    !isApprovalId(snapshot.approvalId)
  ) {
    fail("invalid-decision", "Amendment decisions require a decision and approval identity");
  }
  assertTimestamp(snapshot.occurredAt, "invalid-decision");
  if (snapshot.decision === "approve") {
    if (currentGraph.revisionDigest !== proposal.baseGraph.revisionDigest) {
      fail("stale-base", "An amendment can be approved only against its exact base graph");
    }
    if (hasNewAffectedCandidateHistory(proposal, context.phaseCandidateHistory)) {
      fail("candidate-history", "An affected phase gained candidate history after review");
    }
    if (context.withdrawal !== undefined) {
      validateAmendmentWithdrawal(context.withdrawal, proposal, sha256);
      fail("withdrawn-proposal", "A withdrawn amendment cannot be approved");
    }
    const overlapping = validatedPendingProposals(
      context.pendingProposals,
      proposal,
      context.phaseCandidateHistory,
      sha256,
    ).some((pending) => amendmentImpactsOverlap(proposal.impact, pending.impact));
    if (overlapping) fail("overlapping-proposal", "An overlapping amendment cannot be approved");
  }
  const content: AmendmentDecisionContent = {
    decision: snapshot.decision,
    approvalId: snapshot.approvalId,
    principal: snapshot.principal as CanonicalValue,
    occurredAt: snapshot.occurredAt,
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    baseGraphRevisionDigest: proposal.baseGraph.revisionDigest,
    reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
  };
  const decisionDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, decisionDigest }) as unknown as AmendmentDecision;
}

export function validateAmendmentDecision(
  value: unknown,
  proposal: AmendmentProposal,
  sha256: Sha256,
): AmendmentDecision {
  const snapshot = snapshotCanonical(value, "invalid-decision", "Amendment decisions");
  assertExactKeys(
    snapshot,
    "amendment decision",
    [
      "decision",
      "approvalId",
      "principal",
      "occurredAt",
      "amendmentId",
      "proposalDigest",
      "baseGraphRevisionDigest",
      "reviewedResultGraphRevisionDigest",
      "decisionDigest",
    ],
    "invalid-decision",
  );
  if (
    (snapshot.decision !== "approve" && snapshot.decision !== "reject") ||
    !isApprovalId(snapshot.approvalId) ||
    !isSha256Digest(snapshot.decisionDigest)
  ) {
    fail("invalid-decision", "Amendment decision fields are invalid");
  }
  assertTimestamp(snapshot.occurredAt, "invalid-decision");
  const content: AmendmentDecisionContent = {
    decision: snapshot.decision,
    approvalId: snapshot.approvalId,
    principal: snapshot.principal as CanonicalValue,
    occurredAt: snapshot.occurredAt,
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    baseGraphRevisionDigest: proposal.baseGraph.revisionDigest,
    reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
  };
  if (
    snapshot.amendmentId !== content.amendmentId ||
    snapshot.proposalDigest !== content.proposalDigest ||
    snapshot.baseGraphRevisionDigest !== content.baseGraphRevisionDigest ||
    snapshot.reviewedResultGraphRevisionDigest !== content.reviewedResultGraphRevisionDigest
  ) {
    fail("invalid-decision", "Amendment decision is not bound to the exact reviewed proposal");
  }
  const decisionDigest = canonicalDigest(canonicalValue(content), sha256);
  if (snapshot.decisionDigest !== decisionDigest) {
    fail("invalid-decision", "decisionDigest does not match the exact decision content");
  }
  return canonicalValue({ ...content, decisionDigest }) as unknown as AmendmentDecision;
}

export function createAmendmentWithdrawal(
  input: AmendmentWithdrawalInput,
  proposal: AmendmentProposal,
  decision: AmendmentDecision | undefined,
  sha256: Sha256,
): AmendmentWithdrawal {
  if (decision !== undefined) {
    validateAmendmentDecision(decision, proposal, sha256);
    fail("conflicting-lifecycle", "A decided amendment cannot be withdrawn");
  }
  const snapshot = snapshotCanonical(input, "invalid-withdrawal", "Amendment withdrawals");
  assertExactKeys(
    snapshot,
    "amendment withdrawal input",
    ["principal", "occurredAt"],
    "invalid-withdrawal",
  );
  assertTimestamp(snapshot.occurredAt, "invalid-withdrawal");
  const content: AmendmentWithdrawalContent = {
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    principal: snapshot.principal as CanonicalValue,
    occurredAt: snapshot.occurredAt,
  };
  const withdrawalDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, withdrawalDigest }) as unknown as AmendmentWithdrawal;
}

export function validateAmendmentWithdrawal(
  value: unknown,
  proposal: AmendmentProposal,
  sha256: Sha256,
): AmendmentWithdrawal {
  const snapshot = snapshotCanonical(value, "invalid-withdrawal", "Amendment withdrawals");
  assertExactKeys(
    snapshot,
    "amendment withdrawal",
    ["amendmentId", "proposalDigest", "principal", "occurredAt", "withdrawalDigest"],
    "invalid-withdrawal",
  );
  assertTimestamp(snapshot.occurredAt, "invalid-withdrawal");
  if (
    snapshot.amendmentId !== proposal.amendmentId ||
    snapshot.proposalDigest !== proposal.proposalDigest ||
    !isSha256Digest(snapshot.withdrawalDigest)
  ) {
    fail("invalid-withdrawal", "Withdrawal is not bound to the exact proposal");
  }
  const content: AmendmentWithdrawalContent = {
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    principal: snapshot.principal as CanonicalValue,
    occurredAt: snapshot.occurredAt,
  };
  const withdrawalDigest = canonicalDigest(canonicalValue(content), sha256);
  if (snapshot.withdrawalDigest !== withdrawalDigest) {
    fail("invalid-withdrawal", "withdrawalDigest does not match the exact withdrawal content");
  }
  return canonicalValue({ ...content, withdrawalDigest }) as unknown as AmendmentWithdrawal;
}

export function createAmendmentQuiescenceFact(
  input: AmendmentQuiescenceFactInput,
  proposal: AmendmentProposal,
  sha256: Sha256,
): AmendmentQuiescenceFact {
  const snapshot = snapshotCanonical(input, "invalid-quiescence", "Amendment quiescence facts");
  assertExactKeys(
    snapshot,
    "amendment quiescence fact input",
    ["occurredAt", "affectedTaskScopes", "liveClaimCount", "nonterminalEffectCount"],
    "invalid-quiescence",
  );
  assertTimestamp(snapshot.occurredAt, "invalid-quiescence");
  const affectedTaskScopes = validateTaskReferences(
    snapshot.affectedTaskScopes,
    "invalid-quiescence",
  );
  if (
    canonicalSerialize(canonicalValue(affectedTaskScopes)) !==
    canonicalSerialize(canonicalValue(proposal.impact.affectedTaskScopes))
  ) {
    fail("invalid-quiescence", "Quiescence fact scopes must exactly equal amendment impact scopes");
  }
  assertNonnegativeInteger(snapshot.liveClaimCount, "liveClaimCount");
  assertNonnegativeInteger(snapshot.nonterminalEffectCount, "nonterminalEffectCount");
  const content: AmendmentQuiescenceFactContent = {
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    occurredAt: snapshot.occurredAt,
    affectedTaskScopes,
    liveClaimCount: snapshot.liveClaimCount,
    nonterminalEffectCount: snapshot.nonterminalEffectCount,
  };
  const factDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, factDigest }) as unknown as AmendmentQuiescenceFact;
}

export function validateAmendmentQuiescenceFact(
  value: unknown,
  proposal: AmendmentProposal,
  sha256: Sha256,
): AmendmentQuiescenceFact {
  const snapshot = snapshotCanonical(value, "invalid-quiescence", "Amendment quiescence facts");
  assertExactKeys(
    snapshot,
    "amendment quiescence fact",
    [
      "amendmentId",
      "proposalDigest",
      "occurredAt",
      "affectedTaskScopes",
      "liveClaimCount",
      "nonterminalEffectCount",
      "factDigest",
    ],
    "invalid-quiescence",
  );
  const rebuilt = createAmendmentQuiescenceFact(
    {
      occurredAt: snapshot.occurredAt as string,
      affectedTaskScopes:
        snapshot.affectedTaskScopes as unknown as AmendmentTaskGenerationReference[],
      liveClaimCount: snapshot.liveClaimCount as number,
      nonterminalEffectCount: snapshot.nonterminalEffectCount as number,
    },
    proposal,
    sha256,
  );
  if (
    snapshot.amendmentId !== rebuilt.amendmentId ||
    snapshot.proposalDigest !== rebuilt.proposalDigest ||
    snapshot.factDigest !== rebuilt.factDigest
  ) {
    fail("invalid-quiescence", "Quiescence fact does not match its exact proposal and content");
  }
  return rebuilt;
}

export function applyApprovedAmendment(
  input: AmendmentApplicationInput,
  sha256: Sha256,
): AmendmentApplication {
  const proposal = validateAmendmentProposal(input.proposal, input.phaseCandidateHistory, sha256);
  const decision = validateAmendmentDecision(input.decision, proposal, sha256);
  if (decision.decision !== "approve") fail("not-approved", "Only an approved amendment can apply");
  if (input.withdrawal !== undefined) {
    validateAmendmentWithdrawal(input.withdrawal, proposal, sha256);
    fail("withdrawn-proposal", "A withdrawn amendment cannot apply");
  }
  if (hasNewAffectedCandidateHistory(proposal, input.phaseCandidateHistory)) {
    fail("candidate-history", "An affected phase gained candidate history after review");
  }
  const currentGraph = validateWorkflowGraph(input.currentGraph, sha256);
  if (
    canonicalSerialize(canonicalValue(currentGraph)) !==
    canonicalSerialize(canonicalValue(proposal.baseGraph))
  ) {
    fail("stale-base", "Application current graph must exactly equal the approved base graph");
  }
  const quiescence = validateAmendmentQuiescenceFact(input.quiescence, proposal, sha256);
  if (quiescence.liveClaimCount !== 0 || quiescence.nonterminalEffectCount !== 0) {
    fail("invalid-quiescence", "Affected amendment scopes must be durably quiescent before apply");
  }
  assertTimestamp(input.occurredAt, "invalid-application");
  const graph = validateWorkflowGraph(proposal.reviewedResultGraph, sha256);
  const content: AmendmentApplicationContent = {
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    decisionDigest: decision.decisionDigest,
    beforeGraphRevisionDigest: currentGraph.revisionDigest,
    afterGraphRevisionDigest: graph.revisionDigest,
    quiescenceFactDigest: quiescence.factDigest,
    occurredAt: input.occurredAt,
    graph,
  };
  const applicationDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, applicationDigest }) as unknown as AmendmentApplication;
}

export function validateAmendmentApplication(
  value: unknown,
  input: Omit<AmendmentApplicationInput, "occurredAt">,
  sha256: Sha256,
): AmendmentApplication {
  const snapshot = snapshotCanonical(value, "invalid-application", "Amendment applications");
  if (!isRecord(snapshot) || typeof snapshot.occurredAt !== "string") {
    fail("invalid-application", "Application must contain an occurrence time");
  }
  const expected = applyApprovedAmendment({ ...input, occurredAt: snapshot.occurredAt }, sha256);
  if (canonicalSerialize(snapshot) !== canonicalSerialize(canonicalValue(expected))) {
    fail("invalid-application", "Application does not match its exact approved source records");
  }
  return expected;
}

export function projectAmendmentLifecycle(
  input: AmendmentLifecycleInput,
  sha256: Sha256,
): AmendmentLifecycleProjection {
  const proposal = validateAmendmentProposal(input.proposal, input.phaseCandidateHistory, sha256);
  const currentGraph = validateWorkflowGraph(input.currentGraph, sha256);
  const pending = validatedPendingProposals(
    input.pendingProposals,
    proposal,
    input.phaseCandidateHistory,
    sha256,
  );
  const decision =
    input.decision === undefined
      ? undefined
      : validateAmendmentDecision(input.decision, proposal, sha256);
  const withdrawal =
    input.withdrawal === undefined
      ? undefined
      : validateAmendmentWithdrawal(input.withdrawal, proposal, sha256);
  if (decision !== undefined && withdrawal !== undefined) {
    fail("conflicting-lifecycle", "An amendment cannot be both decided and withdrawn");
  }
  const application =
    input.application === undefined
      ? undefined
      : validateLifecycleApplication(input.application, proposal, decision, sha256);
  const status: AmendmentLifecycleStatus =
    application !== undefined
      ? "applied"
      : withdrawal !== undefined
        ? "withdrawn"
        : decision?.decision === "reject"
          ? "rejected"
          : currentGraph.revisionDigest !== proposal.baseGraph.revisionDigest ||
              hasNewAffectedCandidateHistory(proposal, input.phaseCandidateHistory)
            ? "stale"
            : decision?.decision === "approve"
              ? "approved-awaiting-quiescence"
              : pending.some((item) => amendmentImpactsOverlap(proposal.impact, item.impact))
                ? "overlapping"
                : "reviewable";
  const content = {
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    status,
    impactDigest: proposal.impact.impactDigest,
    ...(decision === undefined ? {} : { decisionDigest: decision.decisionDigest }),
    ...(withdrawal === undefined ? {} : { withdrawalDigest: withdrawal.withdrawalDigest }),
    ...(application === undefined ? {} : { applicationDigest: application.applicationDigest }),
  };
  const projectionDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({
    ...content,
    projectionDigest,
  }) as unknown as AmendmentLifecycleProjection;
}

function proposalContent(value: unknown, sha256: Sha256): AmendmentProposalContent {
  if (!isRecord(value)) fail("invalid-proposal", "Amendment proposal input must be an object");
  const inputKeys = [
    "source",
    "baseGraph",
    "baseContextDigest",
    "baseConfigurationSnapshotDigest",
    "resultConfigurationSnapshotDigest",
    "operations",
    "phaseCandidateHistory",
  ];
  const proposalKeys = [
    "apiVersion",
    "amendmentId",
    ...inputKeys,
    "impact",
    "reviewedResultGraph",
    "proposalDigest",
  ];
  const isCompiled = Object.hasOwn(value, "proposalDigest");
  assertExactKeys(
    value,
    "amendment proposal",
    isCompiled ? proposalKeys : inputKeys,
    "invalid-proposal",
  );
  if (isCompiled && value.apiVersion !== AMENDMENT_PROPOSAL_API_VERSION) {
    fail("invalid-proposal", `apiVersion must be ${AMENDMENT_PROPOSAL_API_VERSION}`);
  }
  if (
    !isSha256Digest(value.baseContextDigest) ||
    !isSha256Digest(value.baseConfigurationSnapshotDigest) ||
    !isSha256Digest(value.resultConfigurationSnapshotDigest)
  ) {
    fail("invalid-proposal", "Proposal context and configuration bindings must be SHA-256 digests");
  }
  const baseGraph = validateWorkflowGraph(value.baseGraph, sha256);
  const operations = validateOperations(value.operations);
  if (operations.length === 0)
    fail("invalid-operation", "Amendments require at least one additive operation");
  const phaseCandidateHistory = validatePhaseCandidateHistory(value.phaseCandidateHistory);
  const reviewedResultGraph = compileAmendmentGraph(
    baseGraph,
    operations,
    phaseCandidateHistory,
    sha256,
  );
  const impact = computeAmendmentImpact(baseGraph, operations, sha256);
  if (isCompiled) {
    if (
      canonicalSerialize(canonicalValue(value.reviewedResultGraph)) !==
      canonicalSerialize(canonicalValue(reviewedResultGraph))
    ) {
      fail(
        "non-additive-change",
        "Reviewed result graph does not equal canonical additive compilation",
      );
    }
    if (
      canonicalSerialize(canonicalValue(value.impact)) !==
      canonicalSerialize(canonicalValue(impact))
    ) {
      fail("invalid-impact", "Recorded amendment impact does not equal computed impact");
    }
  }
  return {
    apiVersion: AMENDMENT_PROPOSAL_API_VERSION,
    source: value.source as CanonicalValue,
    baseGraph,
    baseContextDigest: value.baseContextDigest,
    baseConfigurationSnapshotDigest: value.baseConfigurationSnapshotDigest,
    resultConfigurationSnapshotDigest: value.resultConfigurationSnapshotDigest,
    operations,
    phaseCandidateHistory,
    impact,
    reviewedResultGraph,
  };
}

function compileAmendmentGraph(
  baseGraph: WorkflowGraph,
  operations: readonly NormalizedAmendmentOperation[],
  phaseCandidateHistory: readonly PhaseGenerationReference[],
  sha256: Sha256,
): WorkflowGraph {
  const baseInput = inputFromGraph(baseGraph, sha256);
  const phases = [...baseInput.phases];
  const executableWork = [...baseInput.executableWork];
  const criteria = [...baseInput.criteria];
  const basePhaseIds = new Set(baseInput.phases.map(({ id }) => id));
  const historyPhaseIds = new Set(phaseCandidateHistory.map(({ phaseId }) => phaseId));
  for (const operation of operations) {
    if (operation.kind === "add-phase") {
      phases.push(operation.phase);
    } else {
      if (
        basePhaseIds.has(operation.task.parentId) &&
        historyPhaseIds.has(operation.task.parentId)
      ) {
        fail(
          "candidate-history",
          `Phase ${operation.task.parentId} has candidate history and cannot receive tasks`,
        );
      }
      executableWork.push(operation.task);
      criteria.push(...operation.criteria);
    }
  }
  let result: WorkflowGraph;
  try {
    result = compileWorkflowGraph(
      {
        workflow: baseInput.workflow,
        phases,
        executableWork,
        criteria,
      },
      sha256,
    );
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    fail("non-additive-change", `Amendment does not compile as an additive graph${detail}`);
  }
  assertBasePreserved(baseGraph, result);
  return result;
}

function inputFromGraph(graph: WorkflowGraph, sha256: Sha256): NormalizedWorkflowInput {
  return normalizedWorkflowInputFromGraph(graph, sha256);
}

function validateOperations(value: unknown): readonly NormalizedAmendmentOperation[] {
  if (!Array.isArray(value)) fail("invalid-operation", "Amendment operations must be an array");
  const operations = value.map((item, index) => validateOperation(item, index));
  const sorted = [...operations].sort(compareOperations);
  const identities = new Set<string>();
  for (const operation of sorted) {
    const definitions =
      operation.kind === "add-phase" ? [operation.phase] : [operation.task, ...operation.criteria];
    for (const definition of definitions) {
      if (identities.has(definition.id))
        fail("invalid-operation", `Amendment identity ${definition.id} is duplicated`);
      identities.add(definition.id);
    }
  }
  return Object.freeze(sorted);
}

function validateOperation(value: unknown, index: number): NormalizedAmendmentOperation {
  if (!isRecord(value)) fail("invalid-operation", `Operation ${index} must be an object`);
  if (value.kind === "add-phase") {
    assertExactKeys(value, `operation ${index}`, ["kind", "phase"], "invalid-operation");
    const phase = value.phase as PhaseDefinitionInput;
    if (
      !isRecord(phase) ||
      !isPhaseId(phase.id) ||
      (phase.supersedes !== undefined && phase.supersedes.length > 0)
    ) {
      fail(
        "non-additive-change",
        "Added phases require a new phase identity and cannot supersede definitions",
      );
    }
    return canonicalValue({ kind: value.kind, phase }) as unknown as AddPhaseOperation;
  }
  if (value.kind === "add-task") {
    assertExactKeys(value, `operation ${index}`, ["kind", "task", "criteria"], "invalid-operation");
    const task = value.task as TaskDefinitionInput;
    if (
      !isRecord(task) ||
      !isTaskId(task.id) ||
      (task.supersedes !== undefined && task.supersedes.length > 0) ||
      !Array.isArray(value.criteria)
    ) {
      fail(
        "non-additive-change",
        "Added tasks require a new task identity, owned criteria, and no supersession",
      );
    }
    const criteria = value.criteria as unknown as CriterionDefinitionInput[];
    for (const criterion of criteria) {
      if (
        !isRecord(criterion) ||
        !isCriterionId(criterion.id) ||
        criterion.parentId !== task.id ||
        (criterion.supersedes !== undefined && criterion.supersedes.length > 0)
      ) {
        fail(
          "non-additive-change",
          "Added criteria must be owned by the added task and cannot supersede definitions",
        );
      }
    }
    return canonicalValue({ kind: value.kind, task, criteria }) as unknown as AddTaskOperation;
  }
  return fail("invalid-operation", `Operation ${index} kind is not additive`);
}

function computeAmendmentImpact(
  baseGraph: WorkflowGraph,
  operations: readonly NormalizedAmendmentOperation[],
  sha256: Sha256,
): AmendmentImpact {
  const basePhaseById = new Map(
    baseGraph.nodes.flatMap((node) =>
      node.kind === "phase" ? [[node.definition.id, node.definition] as const] : [],
    ),
  );
  const baseTasks = baseGraph.nodes.flatMap((node) =>
    node.kind === "task" ? [node.definition] : [],
  );
  const supersededTaskIds = new Set(baseTasks.flatMap(({ supersedes }) => supersedes));
  const addedPhases = operations
    .flatMap((operation) =>
      operation.kind === "add-phase"
        ? [
            {
              phaseId: operation.phase.id,
              definitionGeneration: operation.phase.generation,
            },
          ]
        : [],
    )
    .sort(comparePhaseReferences);
  const addedTasks = operations
    .flatMap((operation) =>
      operation.kind === "add-task"
        ? [
            {
              taskId: operation.task.id,
              definitionGeneration: operation.task.generation,
            },
          ]
        : [],
    )
    .sort(compareTaskReferences);
  const addedCriteria = operations
    .flatMap((operation) =>
      operation.kind === "add-task"
        ? operation.criteria.map((criterion) => ({
            criterionId: criterion.id,
            definitionGeneration: criterion.generation,
          }))
        : [],
    )
    .sort(compareCriterionReferences);
  const targetIds = new Set(
    operations.flatMap((operation) =>
      operation.kind === "add-task" && basePhaseById.has(operation.task.parentId)
        ? [operation.task.parentId]
        : [],
    ),
  );
  const existingTargetPhases = [...targetIds]
    .map((phaseId) => {
      const phase = basePhaseById.get(phaseId) as PhaseDefinition;
      return { phaseId, definitionGeneration: phase.generation };
    })
    .sort(comparePhaseReferences);
  const affectedTaskScopes = baseTasks
    .filter((task) => targetIds.has(task.parentId) && !supersededTaskIds.has(task.id))
    .map((task) => ({ taskId: task.id, definitionGeneration: task.generation }))
    .sort(compareTaskReferences);
  const content = {
    addedPhases,
    addedTasks,
    addedCriteria,
    existingTargetPhases,
    affectedTaskScopes,
  };
  return canonicalValue({
    ...content,
    impactDigest: digestAmendmentImpact(content, sha256),
  }) as unknown as AmendmentImpact;
}

function assertBasePreserved(base: WorkflowGraph, result: WorkflowGraph): void {
  const resultNodes = new Map(result.nodes.map((node) => [node.definition.id, node]));
  for (const node of base.nodes) {
    const candidate = resultNodes.get(node.definition.id);
    if (
      candidate === undefined ||
      canonicalSerialize(canonicalValue(candidate)) !== canonicalSerialize(canonicalValue(node))
    ) {
      fail("non-additive-change", `Base definition ${node.definition.id} was changed or removed`);
    }
  }
  const resultEdges = new Set(result.edges.map((edge) => canonicalSerialize(canonicalValue(edge))));
  for (const edge of base.edges) {
    if (!resultEdges.has(canonicalSerialize(canonicalValue(edge)))) {
      fail("non-additive-change", "A base graph edge was changed or removed");
    }
  }
}

function validatePhaseCandidateHistory(value: unknown): readonly PhaseGenerationReference[] {
  if (!Array.isArray(value)) fail("candidate-history", "Phase candidate history must be an array");
  const references = value
    .map((item, index) => {
      assertExactKeys(
        item,
        `phase candidate history ${index}`,
        ["phaseId", "definitionGeneration"],
        "candidate-history",
      );
      if (!isPhaseId(item.phaseId) || !isDefinitionGeneration(item.definitionGeneration)) {
        fail("candidate-history", "Candidate history requires exact phase generation references");
      }
      return { phaseId: item.phaseId, definitionGeneration: item.definitionGeneration };
    })
    .sort(comparePhaseReferences);
  assertUniqueReferences(
    references.map(({ phaseId, definitionGeneration }) => `${phaseId}@${definitionGeneration}`),
    "candidate-history",
  );
  return Object.freeze(references);
}

function hasNewAffectedCandidateHistory(
  proposal: AmendmentProposal,
  currentHistory: readonly PhaseGenerationReference[],
): boolean {
  const affectedPhaseIds = new Set(
    proposal.impact.existingTargetPhases.map(({ phaseId }) => phaseId),
  );
  const recorded = new Set(
    proposal.phaseCandidateHistory
      .filter(({ phaseId }) => affectedPhaseIds.has(phaseId))
      .map(({ phaseId, definitionGeneration }) => `${phaseId}@${definitionGeneration}`),
  );
  return validatePhaseCandidateHistory(currentHistory)
    .filter(({ phaseId }) => affectedPhaseIds.has(phaseId))
    .some(
      ({ phaseId, definitionGeneration }) => !recorded.has(`${phaseId}@${definitionGeneration}`),
    );
}

function validateTaskReferences(
  value: unknown,
  code: AmendmentErrorCode,
): readonly AmendmentTaskGenerationReference[] {
  if (!Array.isArray(value)) fail(code, "Task scopes must be an array");
  const references = value
    .map((item, index) => {
      assertExactKeys(item, `task scope ${index}`, ["taskId", "definitionGeneration"], code);
      if (!isTaskId(item.taskId) || !isDefinitionGeneration(item.definitionGeneration)) {
        fail(code, "Task scopes require exact task generation references");
      }
      return { taskId: item.taskId, definitionGeneration: item.definitionGeneration };
    })
    .sort(compareTaskReferences);
  assertUniqueReferences(
    references.map(({ taskId, definitionGeneration }) => `${taskId}@${definitionGeneration}`),
    code,
  );
  return Object.freeze(references);
}

function validatedPendingProposals(
  value: readonly AmendmentProposal[] | undefined,
  proposal: AmendmentProposal,
  history: readonly PhaseGenerationReference[],
  sha256: Sha256,
): readonly AmendmentProposal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("invalid-proposal", "Pending proposals must be an array");
  return value
    .map((item) => validateAmendmentProposal(item, history, sha256))
    .filter((item) => item.amendmentId !== proposal.amendmentId)
    .sort((left, right) => compareText(left.amendmentId, right.amendmentId));
}

function validateLifecycleApplication(
  value: unknown,
  proposal: AmendmentProposal,
  decision: AmendmentDecision | undefined,
  sha256: Sha256,
): AmendmentApplication {
  if (decision === undefined || decision.decision !== "approve") {
    fail("conflicting-lifecycle", "An application requires its approval decision");
  }
  const snapshot = snapshotCanonical(value, "invalid-application", "Amendment applications");
  assertExactKeys(
    snapshot,
    "amendment application",
    [
      "amendmentId",
      "proposalDigest",
      "decisionDigest",
      "beforeGraphRevisionDigest",
      "afterGraphRevisionDigest",
      "quiescenceFactDigest",
      "occurredAt",
      "graph",
      "applicationDigest",
    ],
    "invalid-application",
  );
  assertTimestamp(snapshot.occurredAt, "invalid-application");
  const graph = validateWorkflowGraph(snapshot.graph, sha256);
  if (
    snapshot.amendmentId !== proposal.amendmentId ||
    snapshot.proposalDigest !== proposal.proposalDigest ||
    snapshot.decisionDigest !== decision.decisionDigest ||
    snapshot.beforeGraphRevisionDigest !== proposal.baseGraph.revisionDigest ||
    snapshot.afterGraphRevisionDigest !== proposal.reviewedResultGraph.revisionDigest ||
    canonicalSerialize(canonicalValue(graph)) !==
      canonicalSerialize(canonicalValue(proposal.reviewedResultGraph)) ||
    !isSha256Digest(snapshot.quiescenceFactDigest) ||
    !isSha256Digest(snapshot.applicationDigest)
  ) {
    fail("invalid-application", "Lifecycle application is not bound to the exact approved graph");
  }
  const content: AmendmentApplicationContent = {
    amendmentId: proposal.amendmentId,
    proposalDigest: proposal.proposalDigest,
    decisionDigest: decision.decisionDigest,
    beforeGraphRevisionDigest: proposal.baseGraph.revisionDigest,
    afterGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
    quiescenceFactDigest: snapshot.quiescenceFactDigest,
    occurredAt: snapshot.occurredAt,
    graph,
  };
  const applicationDigest = canonicalDigest(canonicalValue(content), sha256);
  if (snapshot.applicationDigest !== applicationDigest) {
    fail("invalid-application", "applicationDigest does not match the exact application content");
  }
  return canonicalValue({ ...content, applicationDigest }) as unknown as AmendmentApplication;
}

function compareOperations(
  left: NormalizedAmendmentOperation,
  right: NormalizedAmendmentOperation,
): number {
  return (
    compareText(left.kind, right.kind) ||
    compareText(operationIdentity(left), operationIdentity(right))
  );
}

function operationIdentity(operation: NormalizedAmendmentOperation): string {
  return operation.kind === "add-phase" ? operation.phase.id : operation.task.id;
}

function comparePhaseReferences(
  left: PhaseGenerationReference,
  right: PhaseGenerationReference,
): number {
  return (
    compareText(left.phaseId, right.phaseId) ||
    left.definitionGeneration - right.definitionGeneration
  );
}

function compareTaskReferences(
  left: AmendmentTaskGenerationReference,
  right: AmendmentTaskGenerationReference,
): number {
  return (
    compareText(left.taskId, right.taskId) || left.definitionGeneration - right.definitionGeneration
  );
}

function compareCriterionReferences(
  left: CriterionGenerationReference,
  right: CriterionGenerationReference,
): number {
  return (
    compareText(left.criterionId, right.criterionId) ||
    left.definitionGeneration - right.definitionGeneration
  );
}

function snapshotCanonical(
  value: unknown,
  code: AmendmentErrorCode,
  label: string,
): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    return fail(code, `${label} must be stable canonical JSON values`);
  }
}

function assertExactKeys(
  value: unknown,
  label: string,
  keys: readonly string[],
  code: AmendmentErrorCode,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail(code, `${label} must be an object`);
  const expected = [...keys].sort(compareText);
  const actual = Object.keys(value).sort(compareText);
  if (canonicalSerialize(canonicalValue(actual)) !== canonicalSerialize(canonicalValue(expected))) {
    fail(code, `${label} must contain exactly ${expected.join(", ")}`);
  }
}

function assertTimestamp(value: unknown, code: AmendmentErrorCode): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    fail(code, "occurredAt must be a canonical UTC timestamp");
  }
}

function assertNonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid-quiescence", `${label} must be a non-negative safe integer`);
  }
}

function assertUniqueReferences(values: readonly string[], code: AmendmentErrorCode): void {
  if (new Set(values).size !== values.length) fail(code, "References must be unique");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: AmendmentErrorCode, message: string): never {
  throw new AmendmentError(code, message);
}
