import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import type {
  AccountingAssessment,
  CompletionRequirements,
  CriterionAssessment,
  CriterionOutcome,
  EvidenceAttachment,
  EvidenceRequirementAssessment,
  TaskGenerationReference,
} from "./completion.js";
import {
  CompletionAccountingError,
  reassessCompletionAccounting,
  validateCompletionRequirements,
} from "./completion.js";
import {
  createPhaseOutputAcceptance,
  type PhaseAttemptReference,
  type PhaseOutputAcceptance,
  type PhaseOutputPublication,
  validatePhaseOutputPublication,
} from "./dataflow.js";
import { type GateEvidence, validateGateEvidence } from "./gates.js";
import {
  GraphValidationError,
  type PhaseDefinition,
  type TaskDefinition,
  validateWorkflowGraph,
  type WorkflowGraph,
} from "./graph.js";
import {
  type ApprovalId,
  type DefinitionGeneration,
  isApprovalId,
  isAssetId,
  isCriterionId,
  isDefinitionGeneration,
  isPhaseId,
  isTaskId,
  type PhaseId,
} from "./identity.js";

export interface PhaseGenerationReference {
  readonly phaseId: PhaseId;
  readonly definitionGeneration: DefinitionGeneration;
}

export interface AcceptedAccountingAssessment {
  readonly assessmentDigest: Sha256Digest;
  readonly assessment: AccountingAssessment;
}

export interface PhaseCandidateInput {
  readonly phase: PhaseGenerationReference;
  readonly phaseAttempt: PhaseAttemptReference;
  readonly graphRevisionDigest: Sha256Digest;
  readonly inputBindingDigest: Sha256Digest;
  readonly requiredOutputPublications: readonly PhaseOutputPublication[];
  readonly outputSetDigest: Sha256Digest;
  readonly selectedTaskSetDigest: Sha256Digest;
  readonly tasks: readonly TaskGenerationReference[];
  readonly acceptedAccountingAssessments: readonly AcceptedAccountingAssessment[];
  readonly dependencyBarrierDigest: Sha256Digest;
  readonly integrationBarrierDigest?: Sha256Digest;
  readonly gatePolicyDigest: Sha256Digest;
}

export interface PhaseCandidate extends PhaseCandidateInput {
  readonly evidencePolicyDigest: Sha256Digest;
  readonly candidateDigest: Sha256Digest;
}

type PhaseCandidateContent = Omit<PhaseCandidate, "candidateDigest">;

export type AuthorityDecisionKind = "approve" | "reject";

export interface AuthorityDecisionInput {
  readonly decision: AuthorityDecisionKind;
  readonly approvalId: ApprovalId;
  readonly principal: unknown;
  readonly occurredAt: string;
  readonly candidateDigest: Sha256Digest;
}

export interface AuthorityDecision {
  readonly decision: AuthorityDecisionKind;
  readonly approvalId: ApprovalId;
  readonly principal: CanonicalValue;
  readonly occurredAt: string;
  readonly candidateDigest: Sha256Digest;
  readonly decisionDigest: Sha256Digest;
}

type AuthorityDecisionContent = Omit<AuthorityDecision, "decisionDigest">;

export interface NoApprovalRequired {
  readonly policy: "no-approval";
}

export interface ApprovalRequiredInput {
  readonly policy: "approval-required";
  readonly authority: unknown;
  readonly decision: AuthorityDecision;
}

export type ClosureApprovalInput = NoApprovalRequired | ApprovalRequiredInput;

export interface PhaseClosureInput {
  readonly graph: WorkflowGraph;
  readonly candidate: PhaseCandidate;
  readonly gateEvidence: GateEvidence;
  readonly approval: ClosureApprovalInput;
}

export interface NoApprovalReference {
  readonly policy: "no-approval";
}

export interface ApprovalDecisionReference {
  readonly policy: "approval-required";
  readonly authority: CanonicalValue;
  readonly decisionDigest: Sha256Digest;
}

export type ClosureApprovalReference = NoApprovalReference | ApprovalDecisionReference;

export interface PhaseClosure {
  readonly phase: PhaseGenerationReference;
  readonly phaseAttempt: PhaseAttemptReference;
  readonly graphRevisionDigest: Sha256Digest;
  readonly outputSetDigest: Sha256Digest;
  readonly candidateDigest: Sha256Digest;
  readonly gateEvaluationDigest: Sha256Digest;
  readonly approval: ClosureApprovalReference;
  readonly closureDigest: Sha256Digest;
  readonly outputAcceptances: readonly PhaseOutputAcceptance[];
}

export type CandidateErrorCode =
  | "invalid-candidate"
  | "graph-mismatch"
  | "phase-definition-mismatch"
  | "task-definition-mismatch"
  | "task-set-mismatch"
  | "invalid-task-set-digest"
  | "invalid-output-set-digest"
  | "output-attempt-mismatch"
  | "duplicate-output-slot"
  | "duplicate-task"
  | "invalid-accounting-assessment"
  | "unaccepted-accounting-assessment"
  | "invalid-assessment-digest"
  | "duplicate-accounting-assessment"
  | "unknown-accounting-assessment"
  | "missing-accounting-assessment"
  | "accounting-task-mismatch"
  | "invalid-decision"
  | "invalid-decision-digest"
  | "invalid-gate-evaluation"
  | "invalid-closure"
  | "candidate-mismatch"
  | "policy-mismatch"
  | "rejected-gate"
  | "invalid-approval-policy"
  | "rejected-authority"
  | "wrong-authority";

export class CandidateError extends Error {
  readonly code: CandidateErrorCode;

  constructor(code: CandidateErrorCode, message: string) {
    super(message);
    this.name = "CandidateError";
    this.code = code;
  }
}

export function digestSelectedTaskSet(
  tasks: readonly TaskGenerationReference[],
  sha256: Sha256,
): Sha256Digest {
  const snapshot = snapshotCanonical(tasks, "invalid-candidate", "Selected task sets");
  if (!Array.isArray(snapshot)) {
    fail("invalid-candidate", "Selected task sets must be arrays");
  }
  const validated = validateAndSortTaskReferences(snapshot, "selected task set");
  return canonicalDigest(canonicalValue({ tasks: validated }), sha256);
}

export function digestPhaseOutputSet(
  publications: readonly PhaseOutputPublication[],
  sha256: Sha256,
): Sha256Digest {
  const validated = validateAndSortOutputPublications(publications, sha256);
  return canonicalDigest(canonicalValue({ publications: validated }), sha256);
}

export function digestAccountingAssessment(
  assessment: AccountingAssessment,
  sha256: Sha256,
): Sha256Digest {
  const snapshot = snapshotCanonical(
    assessment,
    "invalid-accounting-assessment",
    "Accounting assessments",
  );
  const validated = validateAccountingAssessment(snapshot);
  return canonicalDigest(canonicalValue(validated), sha256);
}

export function digestCompletionRequirements(
  requirements: readonly CompletionRequirements[],
  sha256: Sha256,
): Sha256Digest {
  const snapshot = snapshotCanonical(
    requirements,
    "invalid-candidate",
    "Completion requirement sets",
  );
  if (!Array.isArray(snapshot)) {
    fail("invalid-candidate", "Completion requirement sets must be arrays");
  }
  const validated = snapshot.map((requirement) => validateCompletionRequirements(requirement));
  validated.sort((left, right) => compareTaskReferences(left.task, right.task));
  return canonicalDigest(canonicalValue({ completionRequirements: validated }), sha256);
}

export function deriveCompletionRequirements(
  graph: WorkflowGraph,
  tasks: readonly TaskGenerationReference[],
  sha256: Sha256,
): readonly CompletionRequirements[] {
  const validatedGraph = candidateGraph(graph, sha256);
  const taskSnapshot = snapshotCanonical(tasks, "invalid-candidate", "Selected task sets");
  if (!Array.isArray(taskSnapshot)) {
    fail("invalid-candidate", "Selected task sets must be arrays");
  }
  const validatedTasks = validateAndSortTaskReferences(taskSnapshot, "selected task set");
  return deriveRequirementsFromGraph(validatedGraph, validatedTasks);
}

export function createPhaseCandidate(
  input: PhaseCandidateInput,
  graph: WorkflowGraph,
  sha256: Sha256,
): PhaseCandidate {
  const validatedGraph = candidateGraph(graph, sha256);
  const snapshot = snapshotCanonical(input, "invalid-candidate", "Phase candidates");
  const content = phaseCandidateContent(snapshot, validatedGraph, sha256, false);
  const candidateDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, candidateDigest }) as unknown as PhaseCandidate;
}

export function validatePhaseCandidate(
  value: unknown,
  graph: WorkflowGraph,
  sha256: Sha256,
): PhaseCandidate {
  const validatedGraph = candidateGraph(graph, sha256);
  const snapshot = snapshotCanonical(value, "invalid-candidate", "Phase candidates");
  const content = phaseCandidateContent(snapshot, validatedGraph, sha256, true);
  if (!isRecord(snapshot) || !isSha256Digest(snapshot.candidateDigest)) {
    fail("invalid-candidate", "candidateDigest must be a SHA-256 digest");
  }
  const computed = canonicalDigest(canonicalValue(content), sha256);
  if (computed !== snapshot.candidateDigest) {
    fail("invalid-candidate", "candidateDigest does not match the exact candidate content");
  }
  return canonicalValue({ ...content, candidateDigest: computed }) as unknown as PhaseCandidate;
}

export function createAuthorityDecision(
  input: AuthorityDecisionInput,
  sha256: Sha256,
): AuthorityDecision {
  const snapshot = snapshotCanonical(input, "invalid-decision", "Authority decisions");
  const content = authorityDecisionContent(snapshot, false);
  const decisionDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, decisionDigest }) as unknown as AuthorityDecision;
}

export function validateAuthorityDecision(value: unknown, sha256: Sha256): AuthorityDecision {
  const snapshot = snapshotCanonical(value, "invalid-decision", "Authority decisions");
  const content = authorityDecisionContent(snapshot, true);
  if (!isRecord(snapshot) || !isSha256Digest(snapshot.decisionDigest)) {
    fail("invalid-decision-digest", "decisionDigest must be a SHA-256 digest");
  }
  const computed = canonicalDigest(canonicalValue(content), sha256);
  if (computed !== snapshot.decisionDigest) {
    fail("invalid-decision-digest", "decisionDigest does not match the exact authority decision");
  }
  return canonicalValue({ ...content, decisionDigest: computed }) as unknown as AuthorityDecision;
}

export function closePhase(input: PhaseClosureInput, sha256: Sha256): PhaseClosure {
  const snapshot = snapshotCanonical(input, "invalid-candidate", "Phase closure inputs");
  assertExactKeys(
    snapshot,
    "phase closure input",
    ["graph", "candidate", "gateEvidence", "approval"],
    "invalid-candidate",
  );
  const candidate = validatePhaseCandidate(
    snapshot.candidate,
    snapshot.graph as unknown as WorkflowGraph,
    sha256,
  );
  let gateEvidence: GateEvidence;
  try {
    gateEvidence = validateGateEvidence(snapshot.gateEvidence, candidate.candidateDigest, sha256);
  } catch {
    fail(
      "invalid-gate-evaluation",
      "Gate evidence must match its exact definition, readings, and candidate",
    );
  }
  if (gateEvidence.definition.policyDigest !== candidate.gatePolicyDigest) {
    fail("policy-mismatch", "Gate definition does not use the candidate gate policy");
  }
  if (gateEvidence.evaluation.decision !== "accepted") {
    fail("rejected-gate", "A rejected gate evaluation cannot close a phase");
  }

  const approval = closureApproval(snapshot.approval, candidate.candidateDigest, sha256);
  const content = {
    phase: candidate.phase,
    phaseAttempt: candidate.phaseAttempt,
    graphRevisionDigest: candidate.graphRevisionDigest,
    outputSetDigest: candidate.outputSetDigest,
    candidateDigest: candidate.candidateDigest,
    gateEvaluationDigest: gateEvidence.evaluation.evaluationDigest,
    approval,
  } as const;
  const closureDigest = canonicalDigest(canonicalValue(content), sha256);
  const outputAcceptances = candidate.requiredOutputPublications.map((publication) =>
    createPhaseOutputAcceptance(
      { publication, candidateDigest: candidate.candidateDigest, closureDigest },
      sha256,
    ),
  );
  return canonicalValue({
    ...content,
    closureDigest,
    outputAcceptances,
  }) as unknown as PhaseClosure;
}

export function validatePhaseClosure(
  value: unknown,
  input: PhaseClosureInput,
  sha256: Sha256,
): PhaseClosure {
  const submitted = snapshotCanonical(value, "invalid-closure", "Phase closures");
  const expected = closePhase(input, sha256);
  if (canonicalSerialize(submitted) !== canonicalSerialize(expected as unknown as CanonicalValue)) {
    fail("invalid-closure", "Phase closure does not match its exact source records");
  }
  return expected;
}

function phaseCandidateContent(
  value: unknown,
  graph: WorkflowGraph,
  sha256: Sha256,
  includesDigest: boolean,
): PhaseCandidateContent {
  assertAllowedKeys(
    value,
    "phase candidate",
    [
      "phase",
      "phaseAttempt",
      "graphRevisionDigest",
      "inputBindingDigest",
      "requiredOutputPublications",
      "outputSetDigest",
      "selectedTaskSetDigest",
      "tasks",
      "acceptedAccountingAssessments",
      "dependencyBarrierDigest",
      "gatePolicyDigest",
      ...(includesDigest ? ["evidencePolicyDigest"] : []),
      ...(includesDigest ? ["candidateDigest"] : []),
    ],
    ["integrationBarrierDigest"],
    "invalid-candidate",
  );
  const phase = phaseReference(value.phase);
  const phaseAttempt = candidatePhaseAttempt(value.phaseAttempt, phase);
  assertDigests(value, [
    "graphRevisionDigest",
    "inputBindingDigest",
    "outputSetDigest",
    "selectedTaskSetDigest",
    "dependencyBarrierDigest",
    "gatePolicyDigest",
    ...(includesDigest ? ["evidencePolicyDigest"] : []),
  ]);
  if (value.graphRevisionDigest !== graph.revisionDigest) {
    fail("graph-mismatch", "graphRevisionDigest does not match the supplied workflow graph");
  }
  if (
    Object.hasOwn(value, "integrationBarrierDigest") &&
    !isSha256Digest(value.integrationBarrierDigest)
  ) {
    fail("invalid-candidate", "integrationBarrierDigest must be a SHA-256 digest");
  }
  if (!Array.isArray(value.tasks)) {
    fail("invalid-candidate", "Candidate tasks must be an array");
  }
  const tasks = validateAndSortTaskReferences(value.tasks, "candidate tasks");
  assertPhaseAndTasksMatchGraph(phase, tasks, graph);
  const computedTaskSetDigest = canonicalDigest(canonicalValue({ tasks }), sha256);
  if (computedTaskSetDigest !== value.selectedTaskSetDigest) {
    fail(
      "invalid-task-set-digest",
      "selectedTaskSetDigest does not match the sorted exact task references",
    );
  }
  const acceptedAccountingAssessments = validateAcceptedAssessments(
    value.acceptedAccountingAssessments,
    tasks,
    graph,
    sha256,
  );
  const requirements = deriveRequirementsFromGraph(graph, tasks);
  const computedEvidencePolicyDigest = canonicalDigest(
    canonicalValue({
      completionRequirements: requirements,
    }),
    sha256,
  );
  if (includesDigest && computedEvidencePolicyDigest !== value.evidencePolicyDigest) {
    fail(
      "policy-mismatch",
      "evidencePolicyDigest does not match the sorted exact completion requirements",
    );
  }
  if (!Array.isArray(value.requiredOutputPublications)) {
    fail("invalid-candidate", "requiredOutputPublications must be an array");
  }
  const requiredOutputPublications = validateAndSortOutputPublications(
    value.requiredOutputPublications as unknown as readonly PhaseOutputPublication[],
    sha256,
  );
  for (const publication of requiredOutputPublications) {
    if (
      publication.phase.phaseId !== phaseAttempt.phaseId ||
      publication.phase.definitionGeneration !== phaseAttempt.definitionGeneration ||
      publication.phase.attempt !== phaseAttempt.attempt ||
      publication.graphRevisionDigest !== value.graphRevisionDigest ||
      publication.inputBindingDigest !== value.inputBindingDigest
    ) {
      fail(
        "output-attempt-mismatch",
        "Required output publications must bind the candidate attempt, input, and graph",
      );
    }
  }
  const computedOutputSetDigest = canonicalDigest(
    canonicalValue({ publications: requiredOutputPublications }),
    sha256,
  );
  if (computedOutputSetDigest !== value.outputSetDigest) {
    fail(
      "invalid-output-set-digest",
      "outputSetDigest does not match the sorted required output publications",
    );
  }
  const common = {
    phase,
    phaseAttempt,
    graphRevisionDigest: value.graphRevisionDigest as Sha256Digest,
    inputBindingDigest: value.inputBindingDigest as Sha256Digest,
    requiredOutputPublications,
    outputSetDigest: computedOutputSetDigest,
    selectedTaskSetDigest: computedTaskSetDigest,
    tasks,
    acceptedAccountingAssessments,
    dependencyBarrierDigest: value.dependencyBarrierDigest as Sha256Digest,
    evidencePolicyDigest: computedEvidencePolicyDigest,
    gatePolicyDigest: value.gatePolicyDigest as Sha256Digest,
  } as const;
  return Object.hasOwn(value, "integrationBarrierDigest")
    ? { ...common, integrationBarrierDigest: value.integrationBarrierDigest as Sha256Digest }
    : common;
}

function candidatePhaseAttempt(
  value: unknown,
  phase: PhaseGenerationReference,
): PhaseAttemptReference {
  assertExactKeys(
    value,
    "candidate phase attempt",
    ["phaseId", "definitionGeneration", "attempt"],
    "invalid-candidate",
  );
  if (
    !isPhaseId(value.phaseId) ||
    !isDefinitionGeneration(value.definitionGeneration) ||
    typeof value.attempt !== "number" ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1
  ) {
    fail("invalid-candidate", "Candidate phase attempts require a positive finite ordinal");
  }
  if (
    value.phaseId !== phase.phaseId ||
    value.definitionGeneration !== phase.definitionGeneration
  ) {
    fail("phase-definition-mismatch", "Candidate phase attempt does not match its phase");
  }
  return value as unknown as PhaseAttemptReference;
}

function validateAndSortOutputPublications(
  publications: readonly PhaseOutputPublication[],
  sha256: Sha256,
): readonly PhaseOutputPublication[] {
  const validated = publications.map((publication) =>
    validatePhaseOutputPublication(publication, sha256),
  );
  validated.sort((left, right) => compareText(left.outputName, right.outputName));
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index - 1]?.outputName === validated[index]?.outputName) {
      fail("duplicate-output-slot", `Output slot ${validated[index]?.outputName} is duplicated`);
    }
  }
  return validated;
}

function phaseReference(value: unknown): PhaseGenerationReference {
  assertExactKeys(
    value,
    "candidate phase",
    ["phaseId", "definitionGeneration"],
    "invalid-candidate",
  );
  if (!isPhaseId(value.phaseId) || !isDefinitionGeneration(value.definitionGeneration)) {
    fail("invalid-candidate", "Candidate phases require a phase identity and generation");
  }
  return value as unknown as PhaseGenerationReference;
}

function validateAndSortTaskReferences(
  values: readonly unknown[],
  path: string,
): readonly TaskGenerationReference[] {
  const tasks = values.map((value, index) => taskReference(value, `${path}[${index}]`));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.taskId)) {
      fail("duplicate-task", `Task ${task.taskId} is selected more than once`);
    }
    seen.add(task.taskId);
  }
  return tasks.sort(compareTaskReferences);
}

function taskReference(value: unknown, path: string): TaskGenerationReference {
  assertExactKeys(
    value,
    path,
    ["taskId", "definitionGeneration", "contextRevisionDigest"],
    "invalid-candidate",
  );
  if (
    !isTaskId(value.taskId) ||
    !isDefinitionGeneration(value.definitionGeneration) ||
    !isSha256Digest(value.contextRevisionDigest)
  ) {
    fail("invalid-candidate", `${path} is not an exact task generation reference`);
  }
  return value as unknown as TaskGenerationReference;
}

function validateAcceptedAssessments(
  value: unknown,
  tasks: readonly TaskGenerationReference[],
  graph: WorkflowGraph,
  sha256: Sha256,
): readonly AcceptedAccountingAssessment[] {
  if (!Array.isArray(value)) {
    fail("invalid-candidate", "acceptedAccountingAssessments must be an array");
  }
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const requirementsByTask = new Map(
    deriveRequirementsFromGraph(graph, tasks).map((requirements) => [
      requirements.task.taskId,
      requirements,
    ]),
  );
  const acceptedByTask = new Map<string, AcceptedAccountingAssessment>();
  for (const [index, submitted] of value.entries()) {
    const path = `acceptedAccountingAssessments[${index}]`;
    assertExactKeys(
      submitted,
      path,
      ["assessmentDigest", "assessment"],
      "invalid-accounting-assessment",
    );
    if (!isSha256Digest(submitted.assessmentDigest)) {
      fail("invalid-assessment-digest", `${path}.assessmentDigest must be a SHA-256 digest`);
    }
    if (!isRecord(submitted.assessment) || !isRecord(submitted.assessment.submission)) {
      fail("invalid-accounting-assessment", `${path}.assessment must contain a submission`);
    }
    const submittedTask = taskReference(
      submitted.assessment.submission.task,
      `${path}.assessment.submission.task`,
    );
    const requirements = requirementsByTask.get(submittedTask.taskId);
    if (requirements === undefined) {
      fail(
        "unknown-accounting-assessment",
        `${path} belongs to a task outside the selected task set`,
      );
    }
    const expectedTask = taskById.get(submittedTask.taskId);
    if (expectedTask === undefined) {
      fail(
        "unknown-accounting-assessment",
        `${path} belongs to a task outside the selected task set`,
      );
    }
    if (!sameTaskReference(expectedTask, submittedTask)) {
      fail("accounting-task-mismatch", `${path} is stale for its selected task generation`);
    }
    const assessment = reassessAccountingAssessment(requirements, submitted.assessment, path);
    assertAcceptedAccountingAssessment(assessment, path);
    const computed = canonicalDigest(canonicalValue(assessment), sha256);
    if (computed !== submitted.assessmentDigest) {
      fail(
        "invalid-assessment-digest",
        `${path}.assessmentDigest does not match its exact assessment`,
      );
    }
    if (!sameTaskReference(expectedTask, assessment.submission.task)) {
      fail("accounting-task-mismatch", `${path} is stale for its selected task generation`);
    }
    if (acceptedByTask.has(expectedTask.taskId)) {
      fail(
        "duplicate-accounting-assessment",
        `Task ${expectedTask.taskId} has more than one accepted assessment`,
      );
    }
    acceptedByTask.set(expectedTask.taskId, {
      assessmentDigest: computed,
      assessment,
    });
  }
  for (const task of tasks) {
    if (!acceptedByTask.has(task.taskId)) {
      fail(
        "missing-accounting-assessment",
        `Task ${task.taskId} has no accepted accounting assessment`,
      );
    }
  }
  return tasks.map((task) => acceptedByTask.get(task.taskId) as AcceptedAccountingAssessment);
}

function reassessAccountingAssessment(
  requirements: CompletionRequirements,
  assessment: unknown,
  path: string,
): AccountingAssessment {
  try {
    return reassessCompletionAccounting(requirements, assessment as AccountingAssessment);
  } catch (error) {
    if (error instanceof CompletionAccountingError) {
      fail("invalid-accounting-assessment", `${path} cannot be reassessed: ${error.message}`);
    }
    throw error;
  }
}

function candidateGraph(value: unknown, sha256: Sha256): WorkflowGraph {
  try {
    return validateWorkflowGraph(value, sha256);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail("invalid-candidate", `Supplied workflow graph is invalid: ${error.message}`);
    }
    throw error;
  }
}

function assertPhaseAndTasksMatchGraph(
  phase: PhaseGenerationReference,
  tasks: readonly TaskGenerationReference[],
  graph: WorkflowGraph,
): void {
  const phaseDefinition = graph.nodes.find(
    (node): node is { readonly kind: "phase"; readonly definition: PhaseDefinition } =>
      node.kind === "phase" && node.definition.id === phase.phaseId,
  )?.definition;
  if (phaseDefinition === undefined || phaseDefinition.generation !== phase.definitionGeneration) {
    fail(
      "phase-definition-mismatch",
      "Candidate phase generation does not match the supplied workflow graph",
    );
  }

  const directTasks = graph.nodes
    .filter(
      (node): node is { readonly kind: "task"; readonly definition: TaskDefinition } =>
        node.kind === "task" && node.definition.parentId === phase.phaseId,
    )
    .map((node) => node.definition);
  const supersededTaskIds = new Set(directTasks.flatMap((task) => task.supersedes));
  const activeTasks = directTasks
    .filter((task) => !supersededTaskIds.has(task.id))
    .sort((left, right) => compareText(left.id, right.id));
  const taskById = new Map(activeTasks.map((task) => [task.id, task]));
  if (
    tasks.length !== activeTasks.length ||
    activeTasks.some((definition, index) => tasks[index]?.taskId !== definition.id)
  ) {
    fail(
      "task-set-mismatch",
      "Candidate tasks must exactly cover the active direct tasks owned by the phase",
    );
  }
  for (const task of tasks) {
    const definition = taskById.get(task.taskId);
    if (definition === undefined) {
      fail(
        "task-set-mismatch",
        `Selected task ${task.taskId} is not an active task for the candidate phase`,
      );
    }
    if (definition.generation !== task.definitionGeneration) {
      fail(
        "task-definition-mismatch",
        `Selected task ${task.taskId} generation does not match the active graph definition`,
      );
    }
  }
}

function deriveRequirementsFromGraph(
  graph: WorkflowGraph,
  tasks: readonly TaskGenerationReference[],
): readonly CompletionRequirements[] {
  const taskById = new Map(
    graph.nodes
      .filter(
        (node): node is { readonly kind: "task"; readonly definition: TaskDefinition } =>
          node.kind === "task",
      )
      .map((node) => [node.definition.id, node.definition]),
  );
  return canonicalValue(
    tasks.map((task) => {
      const definition = taskById.get(task.taskId);
      if (definition === undefined || definition.generation !== task.definitionGeneration) {
        fail(
          "task-definition-mismatch",
          `Selected task ${task.taskId} generation does not match the supplied graph`,
        );
      }
      return {
        task,
        criteria: definition.completionPolicy.criteria,
        evidencePolicy: definition.completionPolicy.evidencePolicy,
      };
    }),
  ) as unknown as readonly CompletionRequirements[];
}

function assertAcceptedAccountingAssessment(assessment: AccountingAssessment, path: string): void {
  if (assessment.submission.disposition !== "completed") {
    fail("unaccepted-accounting-assessment", `${path} must contain a completed task disposition`);
  }
  if (!assessment.evidencePolicySatisfied) {
    fail("unaccepted-accounting-assessment", `${path} does not satisfy its evidence policy`);
  }
  const unresolved = assessment.criteria.find(
    (criterion) =>
      criterion.required &&
      criterion.disposition !== "satisfied" &&
      criterion.disposition !== "waived",
  );
  if (unresolved !== undefined) {
    fail(
      "unaccepted-accounting-assessment",
      `${path} leaves required criterion ${unresolved.criterionId} unresolved`,
    );
  }
}

function validateAccountingAssessment(value: unknown): AccountingAssessment {
  assertExactKeys(
    value,
    "accounting assessment",
    ["submission", "criteria", "taskEvidence", "evidencePolicySatisfied"],
    "invalid-accounting-assessment",
  );
  const submission = completionSubmission(value.submission);
  if (!Array.isArray(value.criteria) || !Array.isArray(value.taskEvidence)) {
    fail("invalid-accounting-assessment", "Assessment criteria and taskEvidence must be arrays");
  }
  const criteria = value.criteria.map((item, index) =>
    criterionAssessment(item, `accounting assessment.criteria[${index}]`),
  );
  const taskEvidence = value.taskEvidence.map((item, index) =>
    evidenceRequirementAssessment(item, `accounting assessment.taskEvidence[${index}]`),
  );
  if (typeof value.evidencePolicySatisfied !== "boolean") {
    fail("invalid-accounting-assessment", "evidencePolicySatisfied must be a boolean");
  }

  const outcomeByCriterion = new Map<string, CriterionOutcome>();
  for (const outcome of submission.criteria) {
    if (outcomeByCriterion.has(outcome.criterionId)) {
      fail("invalid-accounting-assessment", `Criterion ${outcome.criterionId} is duplicated`);
    }
    outcomeByCriterion.set(outcome.criterionId, outcome);
  }
  for (const attachment of submission.evidence) {
    if (attachment.criterionId !== undefined && !outcomeByCriterion.has(attachment.criterionId)) {
      fail(
        "invalid-accounting-assessment",
        `Evidence asset ${attachment.assetId} names an unknown criterion`,
      );
    }
  }
  assertUniqueEvidenceKinds(taskEvidence, "accounting assessment.taskEvidence");
  assertEvidenceCounts(
    taskEvidence,
    submission.evidence.filter((attachment) => attachment.criterionId === undefined),
    "accounting assessment.taskEvidence",
  );
  const assessmentIds = new Set<string>();
  for (const assessment of criteria) {
    if (assessmentIds.has(assessment.criterionId)) {
      fail("invalid-accounting-assessment", `Criterion ${assessment.criterionId} is duplicated`);
    }
    assessmentIds.add(assessment.criterionId);
    const outcome = outcomeByCriterion.get(assessment.criterionId);
    if (outcome === undefined || outcome.disposition !== assessment.disposition) {
      fail(
        "invalid-accounting-assessment",
        `Criterion ${assessment.criterionId} does not match its submitted outcome`,
      );
    }
    if (assessment.required && assessment.disposition === "skipped") {
      fail("invalid-accounting-assessment", "Required criteria cannot be skipped");
    }
    if (
      assessment.required &&
      assessment.disposition === "waived" &&
      !Object.hasOwn(outcome, "authorityFact")
    ) {
      fail("invalid-accounting-assessment", "Required waived criteria need authority facts");
    }
    assertEvidenceCounts(
      assessment.evidence,
      submission.evidence.filter((attachment) => attachment.criterionId === assessment.criterionId),
      `Criterion ${assessment.criterionId} evidence`,
    );
  }
  if (
    outcomeByCriterion.size !== assessmentIds.size ||
    [...outcomeByCriterion.keys()].some((criterionId) => !assessmentIds.has(criterionId))
  ) {
    fail("invalid-accounting-assessment", "Every submitted criterion needs one assessment");
  }
  const evidencePolicySatisfied =
    taskEvidence.every((item) => item.satisfied) &&
    criteria.every((item) => item.evidenceSatisfied);
  if (evidencePolicySatisfied !== value.evidencePolicySatisfied) {
    fail(
      "invalid-accounting-assessment",
      "evidencePolicySatisfied does not match the recorded evidence assessments",
    );
  }
  return { submission, criteria, taskEvidence, evidencePolicySatisfied };
}

function completionSubmission(value: unknown): AccountingAssessment["submission"] {
  if (!isRecord(value)) {
    fail("invalid-accounting-assessment", "Assessment submissions must be objects");
  }
  const superseded = value.disposition === "superseded";
  assertExactKeys(
    value,
    "accounting assessment submission",
    [
      "task",
      "disposition",
      "summary",
      "criteria",
      "evidence",
      ...(superseded ? ["replacementTask"] : []),
    ],
    "invalid-accounting-assessment",
  );
  const task = taskReference(value.task, "accounting assessment submission.task");
  if (!isTerminalDisposition(value.disposition)) {
    fail("invalid-accounting-assessment", "Assessment submission disposition is not terminal");
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    fail("invalid-accounting-assessment", "Assessment submission summary must be non-empty");
  }
  if (!Array.isArray(value.criteria) || !Array.isArray(value.evidence)) {
    fail("invalid-accounting-assessment", "Submission criteria and evidence must be arrays");
  }
  const criteria = value.criteria.map((item, index) =>
    criterionOutcome(item, `accounting assessment submission.criteria[${index}]`),
  );
  const evidence = value.evidence.map((item, index) =>
    evidenceAttachment(item, `accounting assessment submission.evidence[${index}]`),
  );
  const assetIds = new Set<string>();
  for (const attachment of evidence) {
    if (assetIds.has(attachment.assetId)) {
      fail("invalid-accounting-assessment", `Evidence asset ${attachment.assetId} is duplicated`);
    }
    assetIds.add(attachment.assetId);
  }
  if (superseded) {
    const replacementTask = taskReference(
      value.replacementTask,
      "accounting assessment submission.replacementTask",
    );
    if (sameTaskReference(task, replacementTask)) {
      fail("invalid-accounting-assessment", "Supersession replacement must be distinct");
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
  return { task, disposition: value.disposition, summary: value.summary, criteria, evidence };
}

function criterionOutcome(value: unknown, path: string): CriterionOutcome {
  assertAllowedKeys(
    value,
    path,
    ["criterionId", "disposition"],
    ["authorityFact"],
    "invalid-accounting-assessment",
  );
  if (!isCriterionId(value.criterionId) || !isCriterionDisposition(value.disposition)) {
    fail("invalid-accounting-assessment", `${path} is not a valid criterion outcome`);
  }
  if (value.disposition !== "waived" && Object.hasOwn(value, "authorityFact")) {
    fail("invalid-accounting-assessment", `${path}.authorityFact is valid only for waivers`);
  }
  return value as unknown as CriterionOutcome;
}

function evidenceAttachment(value: unknown, path: string): EvidenceAttachment {
  assertAllowedKeys(
    value,
    path,
    ["assetId", "kind", "descriptor"],
    ["criterionId"],
    "invalid-accounting-assessment",
  );
  if (!isAssetId(value.assetId)) {
    fail("invalid-accounting-assessment", `${path}.assetId must be an asset identity`);
  }
  if (Object.hasOwn(value, "criterionId") && !isCriterionId(value.criterionId)) {
    fail("invalid-accounting-assessment", `${path}.criterionId must be a criterion identity`);
  }
  return value as unknown as EvidenceAttachment;
}

function criterionAssessment(value: unknown, path: string): CriterionAssessment {
  assertExactKeys(
    value,
    path,
    ["criterionId", "required", "disposition", "evidence", "evidenceSatisfied"],
    "invalid-accounting-assessment",
  );
  if (
    !isCriterionId(value.criterionId) ||
    typeof value.required !== "boolean" ||
    !isCriterionDisposition(value.disposition) ||
    !Array.isArray(value.evidence) ||
    typeof value.evidenceSatisfied !== "boolean"
  ) {
    fail("invalid-accounting-assessment", `${path} is not a valid criterion assessment`);
  }
  const evidence = value.evidence.map((item, index) =>
    evidenceRequirementAssessment(item, `${path}.evidence[${index}]`),
  );
  assertUniqueEvidenceKinds(evidence, `${path}.evidence`);
  const evidenceSatisfied = evidence.every((item) => item.satisfied);
  if (evidenceSatisfied !== value.evidenceSatisfied) {
    fail("invalid-accounting-assessment", `${path}.evidenceSatisfied is inconsistent`);
  }
  return {
    criterionId: value.criterionId,
    required: value.required,
    disposition: value.disposition,
    evidence,
    evidenceSatisfied,
  };
}

function assertUniqueEvidenceKinds(
  assessments: readonly EvidenceRequirementAssessment[],
  path: string,
): void {
  const kinds = new Set<string>();
  for (const assessment of assessments) {
    const kind = canonicalSerialize(assessment.kind);
    if (kinds.has(kind)) {
      fail("invalid-accounting-assessment", `${path} contains a duplicate evidence kind`);
    }
    kinds.add(kind);
  }
}

function assertEvidenceCounts(
  assessments: readonly EvidenceRequirementAssessment[],
  attachments: readonly EvidenceAttachment[],
  path: string,
): void {
  for (const assessment of assessments) {
    const kind = canonicalSerialize(assessment.kind);
    const attachmentCount = attachments.filter(
      (attachment) => canonicalSerialize(attachment.kind) === kind,
    ).length;
    if (attachmentCount !== assessment.attachmentCount) {
      fail("invalid-accounting-assessment", `${path} attachment count is inconsistent`);
    }
  }
}

function evidenceRequirementAssessment(
  value: unknown,
  path: string,
): EvidenceRequirementAssessment {
  assertExactKeys(
    value,
    path,
    ["kind", "minimumCount", "attachmentCount", "satisfied"],
    "invalid-accounting-assessment",
  );
  if (
    !isPositiveSafeInteger(value.minimumCount) ||
    !isNonnegativeSafeInteger(value.attachmentCount) ||
    typeof value.satisfied !== "boolean"
  ) {
    fail("invalid-accounting-assessment", `${path} has invalid evidence counts`);
  }
  const satisfied = value.attachmentCount >= value.minimumCount;
  if (satisfied !== value.satisfied) {
    fail("invalid-accounting-assessment", `${path}.satisfied is inconsistent with its counts`);
  }
  return {
    kind: value.kind as CanonicalValue,
    minimumCount: value.minimumCount,
    attachmentCount: value.attachmentCount,
    satisfied,
  };
}

function authorityDecisionContent(
  value: unknown,
  includesDigest: boolean,
): AuthorityDecisionContent {
  if (!isRecord(value)) {
    fail("invalid-decision", "Authority decisions must be objects");
  }
  if (value.decision !== "approve" && value.decision !== "reject") {
    fail("invalid-decision", "Authority decision type must be approve or reject");
  }
  assertAllowedKeys(
    value,
    "authority decision",
    [
      "decision",
      "approvalId",
      "principal",
      "occurredAt",
      "candidateDigest",
      ...(includesDigest ? ["decisionDigest"] : []),
    ],
    [],
    "invalid-decision",
  );
  if (!isApprovalId(value.approvalId)) {
    fail("invalid-decision", "Authority decisions require an approval identity");
  }
  if (!isTimestamp(value.occurredAt)) {
    fail("invalid-decision", "Authority decision timestamps must use UTC ISO 8601 milliseconds");
  }
  if (!isSha256Digest(value.candidateDigest)) {
    fail("invalid-decision", "Authority decisions require a candidate digest");
  }
  return {
    decision: value.decision,
    approvalId: value.approvalId,
    principal: value.principal as CanonicalValue,
    occurredAt: value.occurredAt,
    candidateDigest: value.candidateDigest,
  } as const;
}

function closureApproval(
  value: unknown,
  candidateDigest: Sha256Digest,
  sha256: Sha256,
): ClosureApprovalReference {
  if (!isRecord(value)) {
    fail("invalid-approval-policy", "Closure approval policy must be an object");
  }
  if (value.policy === "no-approval") {
    assertExactKeys(value, "closure approval", ["policy"], "invalid-approval-policy");
    return { policy: value.policy };
  }
  if (value.policy !== "approval-required") {
    fail("invalid-approval-policy", "Closure approval policy is not recognized");
  }
  assertExactKeys(
    value,
    "closure approval",
    ["policy", "authority", "decision"],
    "invalid-approval-policy",
  );
  const decision = validateAuthorityDecision(value.decision, sha256);
  if (decision.candidateDigest !== candidateDigest) {
    fail("candidate-mismatch", "Authority decision is not bound to the closing candidate");
  }
  if (decision.decision !== "approve") {
    fail("rejected-authority", "Only an approving authority decision can close a phase");
  }
  const authority = value.authority as CanonicalValue;
  if (canonicalSerialize(authority) !== canonicalSerialize(decision.principal)) {
    fail("wrong-authority", "Authority decision principal does not match the required authority");
  }
  return { policy: value.policy, authority, decisionDigest: decision.decisionDigest };
}

function assertDigests(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (!isSha256Digest(value[key])) {
      fail("invalid-candidate", `${key} must be a SHA-256 digest`);
    }
  }
}

function snapshotCanonical(
  value: unknown,
  code: CandidateErrorCode,
  subject: string,
): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    return fail(code, `${subject} must be stable canonical JSON values`);
  }
}

function assertExactKeys(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
  code: CandidateErrorCode,
): asserts value is Record<string, unknown> {
  assertAllowedKeys(value, path, expectedKeys, [], code);
}

function assertAllowedKeys(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: CandidateErrorCode,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
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

function sameTaskReference(left: TaskGenerationReference, right: TaskGenerationReference): boolean {
  return (
    left.taskId === right.taskId &&
    left.definitionGeneration === right.definitionGeneration &&
    left.contextRevisionDigest === right.contextRevisionDigest
  );
}

function compareTaskReferences(
  left: TaskGenerationReference,
  right: TaskGenerationReference,
): number {
  return compareText(
    `${left.taskId}\u0000${left.definitionGeneration}\u0000${left.contextRevisionDigest}`,
    `${right.taskId}\u0000${right.definitionGeneration}\u0000${right.contextRevisionDigest}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTerminalDisposition(
  value: unknown,
): value is AccountingAssessment["submission"]["disposition"] {
  return (
    value === "completed" ||
    value === "blocked" ||
    value === "waived" ||
    value === "skipped" ||
    value === "superseded"
  );
}

function isCriterionDisposition(value: unknown): value is CriterionOutcome["disposition"] {
  return (
    value === "satisfied" || value === "unsatisfied" || value === "waived" || value === "skipped"
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: CandidateErrorCode, message: string): never {
  throw new CandidateError(code, message);
}
