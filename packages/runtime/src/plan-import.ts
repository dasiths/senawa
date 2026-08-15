import {
  type AmendmentProposal,
  type CanonicalValue,
  type CompletionPolicy,
  type CriterionDefinitionInput,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  compareFanOutEvaluations,
  consumerKey,
  createAmendmentProposal,
  criterionId,
  definitionGeneration,
  type EvidencePolicy,
  type FanOutDiff,
  type FanOutEvaluation,
  type FanOutMember,
  type NormalizedAmendmentOperation,
  type PhaseAttempt,
  type PhaseGenerationReference,
  type PhaseId,
  type Sha256,
  type Sha256Digest,
  type TaskDefinitionInput,
  taskId,
  validatePhaseAttempt,
  validatePhaseOutputAcceptance,
  validatePhaseOutputPublication,
  type WorkflowGraph,
} from "@senawa/kernel";

export interface GeneratedCriterionTemplate {
  readonly key: string;
  readonly generation: number;
  readonly required: boolean;
  readonly input: CanonicalValue;
}

export interface GeneratedTaskAuthorityTemplate {
  readonly templateDigest: Sha256Digest;
  readonly binding: CanonicalValue;
  readonly parentPhaseId: PhaseId;
  readonly criteria: readonly GeneratedCriterionTemplate[];
  readonly evidencePolicy: EvidencePolicy;
}

export interface FanOutDiffDecision {
  readonly diffDigest: Sha256Digest;
  readonly changed: "supersede-changed";
  readonly removed: "retain-removed";
  readonly authorityDigest: Sha256Digest;
}

export interface PlanImportPersistencePort {
  appliedEvaluation(key: PlanImportKey): FanOutEvaluation | undefined;
  recordEvaluation(
    key: PlanImportKey,
    evaluation: FanOutEvaluation,
    expectedPriorEvaluationDigest: Sha256Digest | undefined,
  ): "created" | "replayed" | "conflict";
  enqueueProposal(key: PlanImportKey, proposal: AmendmentProposal): "created" | "replayed";
}

export interface PlanImportKey {
  readonly repositoryId: string;
  readonly runId: string;
  readonly attemptDigest: Sha256Digest;
  readonly forEachKey: string;
}

export interface ImportPlanRequest {
  readonly evaluation: FanOutEvaluation;
  readonly phaseAttempt: PhaseAttempt;
  readonly publication: unknown;
  readonly acceptance: unknown;
  readonly expectedClosureDigest: Sha256Digest;
  readonly expectedDefinitionDigest: Sha256Digest;
  readonly baseGraph: WorkflowGraph;
  readonly baseContextDigest: Sha256Digest;
  readonly baseConfigurationSnapshotDigest: Sha256Digest;
  readonly resultConfigurationSnapshotDigest: Sha256Digest;
  readonly phaseCandidateHistory: readonly PhaseGenerationReference[];
  readonly template: GeneratedTaskAuthorityTemplate;
  readonly diffDecision?: FanOutDiffDecision;
}

export type ImportPlanResult =
  | {
      readonly status: "idempotent";
      readonly evaluation: FanOutEvaluation;
      readonly diff: FanOutDiff;
    }
  | {
      readonly status: "review-required";
      readonly evaluation: FanOutEvaluation;
      readonly diff: FanOutDiff;
    }
  | {
      readonly status: "proposal-enqueued";
      readonly evaluation: FanOutEvaluation;
      readonly diff: FanOutDiff;
      readonly proposal: AmendmentProposal;
    };

export class PlanImportError extends Error {
  readonly code:
    | "stale-plan-authority"
    | "concurrent-plan-import"
    | "fan-out-review-required"
    | "invalid-diff-decision";

  constructor(code: PlanImportError["code"], message: string) {
    super(message);
    this.name = "PlanImportError";
    this.code = code;
  }
}

export class PlanImportCoordinator {
  readonly persistence: PlanImportPersistencePort;
  readonly sha256: Sha256;

  constructor(persistence: PlanImportPersistencePort, sha256: Sha256) {
    this.persistence = persistence;
    this.sha256 = sha256;
  }

  import(request: ImportPlanRequest): ImportPlanResult {
    const publication = validatePhaseOutputPublication(request.publication, this.sha256);
    const attempt = validatePhaseAttempt(request.phaseAttempt, this.sha256);
    const acceptance = validatePhaseOutputAcceptance(request.acceptance, publication, this.sha256);
    const evaluation = request.evaluation;
    if (
      acceptance.closureDigest !== request.expectedClosureDigest ||
      evaluation.sourceBindingDigest !== acceptance.acceptanceDigest ||
      evaluation.definitionDigest !== request.expectedDefinitionDigest ||
      evaluation.templateDigest !== request.template.templateDigest ||
      canonicalDigest(request.template.binding, this.sha256) !== request.template.templateDigest ||
      evaluation.graphRevisionDigest !== request.baseGraph.revisionDigest ||
      evaluation.configurationSnapshotDigest !== request.baseConfigurationSnapshotDigest ||
      evaluation.attemptDigest !== attempt.attemptDigest ||
      canonicalSerialize(canonicalValue(publication.phase)) !==
        canonicalSerialize(canonicalValue(attempt.phase))
    ) {
      throw new PlanImportError(
        "stale-plan-authority",
        "Plan import does not bind the exact accepted closure, fan-out, graph, snapshot, and attempt",
      );
    }
    const key: PlanImportKey = {
      repositoryId: evaluation.repositoryId,
      runId: evaluation.runId,
      attemptDigest: evaluation.attemptDigest,
      forEachKey: evaluation.forEachKey,
    };
    const prior = this.persistence.appliedEvaluation(key);
    const diff = compareFanOutEvaluations(evaluation, prior, this.sha256);
    const recorded = this.persistence.recordEvaluation(key, evaluation, prior?.evaluationDigest);
    if (recorded === "conflict") {
      throw new PlanImportError(
        "concurrent-plan-import",
        "Plan import CAS lost to another evaluator",
      );
    }
    if (diff.status === "idempotent") return { status: "idempotent", evaluation, diff };
    if (diff.status === "review-required" && request.diffDecision === undefined) {
      return { status: "review-required", evaluation, diff };
    }
    validateDiffDecision(diff, request.diffDecision);
    const operations = createFanOutAmendmentOperations(diff, request.template, this.sha256);
    if (operations.length === 0) return { status: "idempotent", evaluation, diff };
    const proposal = createAmendmentProposal(
      {
        source: {
          kind: "import-plan",
          evaluationDigest: evaluation.evaluationDigest,
          diffDigest: diff.diffDigest,
          acceptanceDigest: acceptance.acceptanceDigest,
        },
        baseGraph: request.baseGraph,
        baseContextDigest: request.baseContextDigest,
        baseConfigurationSnapshotDigest: request.baseConfigurationSnapshotDigest,
        resultConfigurationSnapshotDigest: request.resultConfigurationSnapshotDigest,
        operations,
        phaseCandidateHistory: request.phaseCandidateHistory,
      },
      this.sha256,
    );
    this.persistence.enqueueProposal(key, proposal);
    return { status: "proposal-enqueued", evaluation, diff, proposal };
  }
}

function validateDiffDecision(diff: FanOutDiff, decision: FanOutDiffDecision | undefined): void {
  if (diff.status !== "review-required") return;
  if (
    decision === undefined ||
    decision.diffDigest !== diff.diffDigest ||
    decision.changed !== "supersede-changed" ||
    decision.removed !== "retain-removed"
  ) {
    throw new PlanImportError(
      "invalid-diff-decision",
      "Changed and removed fan-out members require an exact explicit diff decision",
    );
  }
}

export function createFanOutAmendmentOperations(
  diff: FanOutDiff,
  template: GeneratedTaskAuthorityTemplate,
  sha256: Sha256,
): readonly NormalizedAmendmentOperation[] {
  const successorByPredecessor = new Map(
    diff.changes.map(({ before, after }) => [
      before.taskId,
      successorTaskId(before, after, sha256),
    ]),
  );
  const additions = diff.additions.map((member) =>
    taskOperation(member, template, successorByPredecessor, sha256),
  );
  const successors = diff.changes.map(({ before, after }) =>
    taskOperation(after, template, successorByPredecessor, sha256, before),
  );
  return canonicalValue([
    ...additions,
    ...successors,
  ]) as unknown as readonly NormalizedAmendmentOperation[];
}

function taskOperation(
  member: FanOutMember,
  template: GeneratedTaskAuthorityTemplate,
  successorByPredecessor: ReadonlyMap<string, ReturnType<typeof taskId>>,
  sha256: Sha256,
  predecessor?: FanOutMember,
): NormalizedAmendmentOperation {
  const successorDigest =
    predecessor === undefined
      ? undefined
      : canonicalDigest(
          canonicalValue({ predecessor: predecessor.memberDigest, successor: member.memberDigest }),
          sha256,
        );
  const generatedTaskId =
    predecessor === undefined ? member.taskId : successorTaskId(predecessor, member, sha256);
  const generation =
    predecessor === undefined
      ? member.generation
      : definitionGeneration(predecessor.generation + 1);
  const criteria: CriterionDefinitionInput[] = template.criteria.map((criterion) => {
    const digest = canonicalDigest(
      canonicalValue({ taskId: generatedTaskId, criterionKey: criterion.key }),
      sha256,
    );
    return {
      id: criterionId(`criterion_${digest}`),
      key: consumerKey(criterion.key),
      generation: definitionGeneration(criterion.generation),
      parentId: generatedTaskId,
      source: {
        locator: `senawa://fan-out/${member.memberDigest}`,
        pointer: `/criteria/${criterion.key}`,
      },
      input: criterion.input,
    };
  });
  const completionPolicy: CompletionPolicy = {
    criteria: criteria.map((criterion, index) => ({
      criterionId: criterion.id,
      required: template.criteria[index]?.required ?? false,
    })),
    evidencePolicy: template.evidencePolicy,
  };
  const task: TaskDefinitionInput = {
    id: generatedTaskId,
    key:
      predecessor === undefined
        ? member.taskKey
        : consumerKey(`${member.taskKey.slice(0, 46)}-${successorDigest?.slice(0, 16)}`),
    generation,
    parentId: template.parentPhaseId,
    dependsOn: member.dependencyTaskIds.map(
      (dependency) => successorByPredecessor.get(dependency) ?? dependency,
    ),
    ...(predecessor === undefined ? {} : { supersedes: [predecessor.taskId] }),
    source: { locator: `senawa://fan-out/${member.memberDigest}`, pointer: "/task" },
    input: {
      fanOutIdentity: member.identity,
      itemDigest: member.itemDigest,
      mappedInput: member.input,
      mappedInputDigest: member.inputDigest,
      templateDigest: template.templateDigest,
      templateBinding: template.binding,
    },
    completionPolicy,
  };
  return { kind: "add-task", task, criteria };
}

function successorTaskId(predecessor: FanOutMember, successor: FanOutMember, sha256: Sha256) {
  return taskId(
    `task_${canonicalDigest(
      canonicalValue({
        predecessor: predecessor.memberDigest,
        successor: successor.memberDigest,
      }),
      sha256,
    )}`,
  );
}
