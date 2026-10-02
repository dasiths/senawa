import { describe, expect, it } from "vitest";
import {
  type AcceptedAccountingAssessment,
  type AuthorityDecision,
  type AuthorityDecisionKind,
  CandidateError,
  type CandidateErrorCode,
  closePhase as closePhaseWithGraph,
  createAuthorityDecision,
  createPhaseCandidate as createPhaseCandidateWithGraph,
  deriveCompletionRequirements,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  type PhaseCandidateInput,
  validateAuthorityDecision,
  validatePhaseCandidate as validatePhaseCandidateWithGraph,
} from "./candidates.js";
import { canonicalDigest, canonicalValue, type Sha256, sha256Digest } from "./canonical.js";
import {
  type AccountingAssessment,
  assessCompletionAccounting,
  type CompletionRequirements,
  type CompletionSubmission,
  type TaskGenerationReference,
} from "./completion.js";
import { createPhaseOutputPublication, type PhaseOutputPublication } from "./dataflow.js";
import { defineGate, evaluateGate } from "./gates.js";
import { compileWorkflowGraph, type WorkflowGraph } from "./graph.js";
import {
  approvalId,
  assetId,
  consumerKey,
  contextId,
  criterionId,
  definitionGeneration,
  dispatchId,
  phaseId,
  runId,
  taskId,
  workflowId,
} from "./identity.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const GRAPH = candidateGraph(1);
const GRAPH_DIGEST = GRAPH.revisionDigest;
const DEPENDENCY_DIGEST = sha256Digest("2".repeat(64));
const INTEGRATION_DIGEST = sha256Digest("3".repeat(64));
const OTHER_DIGEST = sha256Digest("f".repeat(64));
const AUTHORITY = canonicalValue({ principalId: "principal_release", role: "release-manager" });

function createPhaseCandidate(input: PhaseCandidateInput, sha256: Sha256) {
  return createPhaseCandidateWithGraph(input, GRAPH, sha256);
}

function validatePhaseCandidate(value: unknown, sha256: Sha256) {
  return validatePhaseCandidateWithGraph(value, GRAPH, sha256);
}

function closePhase(
  input: Omit<Parameters<typeof closePhaseWithGraph>[0], "graph">,
  sha256: Sha256,
) {
  return closePhaseWithGraph({ ...input, graph: GRAPH }, sha256);
}

describe("phase candidates", () => {
  it("binds exact phase, graph, sorted task generations, assessments, barriers, and policies", () => {
    const gate = emptyGate();
    const input = candidateInput(gate.policyDigest);
    const candidate = createPhaseCandidate(input, deterministicSha256);
    input.tasks.reverse();
    input.acceptedAccountingAssessments.reverse();
    input.phase.definitionGeneration = definitionGeneration(9);

    expect(candidate.phase).toEqual({
      phaseId: phaseId("phase_verify"),
      definitionGeneration: definitionGeneration(2),
    });
    expect(candidate.tasks.map((task) => task.taskId)).toEqual([
      taskId("task_alpha"),
      taskId("task_beta"),
    ]);
    expect(candidate.acceptedAccountingAssessments.map(taskIdFromAssessment)).toEqual([
      taskId("task_alpha"),
      taskId("task_beta"),
    ]);
    expect(candidate).toMatchObject({
      graphRevisionDigest: GRAPH_DIGEST,
      dependencyBarrierDigest: DEPENDENCY_DIGEST,
      integrationBarrierDigest: INTEGRATION_DIGEST,
      gatePolicyDigest: gate.policyDigest,
    });
    expect(candidate.completionEvidencePolicyDigest).toBe(
      canonicalDigest(
        canonicalValue({
          completionRequirements: deriveCompletionRequirements(
            GRAPH,
            candidate.tasks,
            deterministicSha256,
          ),
        }),
        deterministicSha256,
      ),
    );
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.tasks)).toBe(true);
    expect(Object.isFrozen(candidate.acceptedAccountingAssessments[0]?.assessment)).toBe(true);
  });

  it("computes exact candidate and selected-set digests independent of input order", () => {
    const gate = emptyGate();
    const firstInput = candidateInput(gate.policyDigest);
    const secondInput = candidateInput(gate.policyDigest);
    secondInput.tasks.reverse();
    secondInput.acceptedAccountingAssessments.reverse();
    const first = createPhaseCandidate(firstInput, deterministicSha256);
    const second = createPhaseCandidate(secondInput, deterministicSha256);
    const { candidateDigest: _candidateDigest, ...content } = first;

    expect(first.selectedTaskSetDigest).toBe(second.selectedTaskSetDigest);
    expect(first.candidateDigest).toBe(second.candidateDigest);
    expect(first).toEqual(second);
    expect(first.candidateDigest).toBe(
      canonicalDigest(canonicalValue(content), deterministicSha256),
    );
    expect(validatePhaseCandidate(first, deterministicSha256)).toEqual(first);
  });

  it("rejects task-set and assessment digest forgery", () => {
    const gate = emptyGate();
    const wrongTaskSet = candidateInput(gate.policyDigest);
    wrongTaskSet.selectedTaskSetDigest = OTHER_DIGEST;
    expectCandidateError("invalid-task-set-digest", () =>
      createPhaseCandidate(wrongTaskSet, deterministicSha256),
    );

    const wrongAssessment = candidateInput(gate.policyDigest);
    required(wrongAssessment.acceptedAccountingAssessments[0]).assessmentDigest = OTHER_DIGEST;
    expectCandidateError("invalid-assessment-digest", () =>
      createPhaseCandidate(wrongAssessment, deterministicSha256),
    );

    const callerPolicy = {
      ...candidateInput(gate.policyDigest),
      completionEvidencePolicyDigest: OTHER_DIGEST,
    };
    expectCandidateError("invalid-candidate", () =>
      createPhaseCandidate(callerPolicy as PhaseCandidateInput, deterministicSha256),
    );

    const candidate = createPhaseCandidate(candidateInput(gate.policyDigest), deterministicSha256);
    const wrongPolicy = { ...candidate, completionEvidencePolicyDigest: OTHER_DIGEST };
    expectCandidateError("policy-mismatch", () =>
      validatePhaseCandidate(wrongPolicy, deterministicSha256),
    );
  });

  it("rejects a recomputed assessment that omits required criteria and completionEvidence", () => {
    const gate = emptyGate();
    const forged = candidateInput(gate.policyDigest);
    const accepted = required(forged.acceptedAccountingAssessments[0]);
    const forgedRequirements: CompletionRequirements = {
      task: accepted.assessment.submission.task,
      criteria: [],
      completionEvidencePolicy: { mode: "none", requirements: [] },
    };
    const assessment = assessCompletionAccounting(forgedRequirements, {
      ...accepted.assessment.submission,
      criteria: [],
      completionEvidence: [],
    });
    accepted.assessment = assessment;
    accepted.assessmentDigest = digestAccountingAssessment(assessment, deterministicSha256);

    expectCandidateError("invalid-accounting-assessment", () =>
      createPhaseCandidate(forged, deterministicSha256),
    );
  });

  it("rejects duplicate tasks and duplicate, missing, or unknown assessments", () => {
    const gate = emptyGate();
    const duplicateTask = candidateInput(gate.policyDigest);
    duplicateTask.tasks.push({ ...required(duplicateTask.tasks[0]) });
    expectCandidateError("duplicate-task", () =>
      createPhaseCandidate(duplicateTask, deterministicSha256),
    );

    const duplicateAssessment = candidateInput(gate.policyDigest);
    duplicateAssessment.acceptedAccountingAssessments[1] = {
      ...required(duplicateAssessment.acceptedAccountingAssessments[0]),
    };
    expectCandidateError("duplicate-accounting-assessment", () =>
      createPhaseCandidate(duplicateAssessment, deterministicSha256),
    );

    const missingAssessment = candidateInput(gate.policyDigest);
    missingAssessment.acceptedAccountingAssessments.pop();
    expectCandidateError("missing-accounting-assessment", () =>
      createPhaseCandidate(missingAssessment, deterministicSha256),
    );

    const unknownAssessment = candidateInput(gate.policyDigest);
    unknownAssessment.acceptedAccountingAssessments[0] = acceptedAssessment(
      assessmentFor("task_unknown", "criterion_unknown"),
    );
    expectCandidateError("unknown-accounting-assessment", () =>
      createPhaseCandidate(unknownAssessment, deterministicSha256),
    );
  });

  it("requires the complete active graph task set and excludes superseded tasks", () => {
    const gate = emptyGate();
    const empty = candidateInput(gate.policyDigest);
    empty.tasks = [];
    empty.acceptedAccountingAssessments = [];
    empty.selectedTaskSetDigest = digestSelectedTaskSet([], deterministicSha256);
    expectCandidateError("task-set-mismatch", () =>
      createPhaseCandidateWithGraph(empty, candidateGraph(1), deterministicSha256),
    );

    const partial = candidateInput(gate.policyDigest);
    partial.tasks.pop();
    partial.acceptedAccountingAssessments.pop();
    partial.selectedTaskSetDigest = digestSelectedTaskSet(partial.tasks, deterministicSha256);
    expectCandidateError("task-set-mismatch", () =>
      createPhaseCandidateWithGraph(partial, candidateGraph(1), deterministicSha256),
    );

    const includesSuperseded = candidateInput(gate.policyDigest);
    includesSuperseded.tasks.push(taskReference("task_old-alpha", definitionGeneration(1)));
    includesSuperseded.acceptedAccountingAssessments.push(
      acceptedAssessment(
        assessmentFor("task_old-alpha", "criterion_old-alpha", definitionGeneration(1)),
      ),
    );
    includesSuperseded.selectedTaskSetDigest = digestSelectedTaskSet(
      includesSuperseded.tasks,
      deterministicSha256,
    );
    expectCandidateError("task-set-mismatch", () =>
      createPhaseCandidateWithGraph(includesSuperseded, candidateGraph(1), deterministicSha256),
    );

    expect(() =>
      createPhaseCandidateWithGraph(
        candidateInput(gate.policyDigest),
        candidateGraph(1),
        deterministicSha256,
      ),
    ).not.toThrow();
  });

  it("rejects stale assessment generations and inconsistent assessment content", () => {
    const gate = emptyGate();
    const stale = candidateInput(gate.policyDigest);
    stale.acceptedAccountingAssessments[0] = acceptedAssessment(
      assessmentFor("task_beta", "criterion_beta", definitionGeneration(8)),
    );
    expectCandidateError("accounting-task-mismatch", () =>
      createPhaseCandidate(stale, deterministicSha256),
    );

    const inconsistent = candidateInput(gate.policyDigest);
    const original = required(inconsistent.acceptedAccountingAssessments[0]).assessment;
    const forged = {
      ...original,
      completionEvidenceSatisfied: false,
    } as AccountingAssessment;
    inconsistent.acceptedAccountingAssessments[0] = {
      assessment: forged,
      assessmentDigest: canonicalDigest(canonicalValue(forged), deterministicSha256),
    };
    expectCandidateError("invalid-accounting-assessment", () =>
      createPhaseCandidate(inconsistent, deterministicSha256),
    );

    const unknownEvidence = candidateInput(gate.policyDigest);
    const accepted = required(unknownEvidence.acceptedAccountingAssessments[0]);
    const forgedEvidence = {
      ...accepted.assessment,
      submission: {
        ...accepted.assessment.submission,
        completionEvidence: [
          {
            assetId: assetId("asset_forged"),
            kind: canonicalValue({ kind: "report" }),
            descriptor: canonicalValue({ result: "passed" }),
            criterionId: criterionId("criterion_unknown"),
          },
        ],
      },
    } as AccountingAssessment;
    unknownEvidence.acceptedAccountingAssessments[0] = {
      assessment: forgedEvidence,
      assessmentDigest: canonicalDigest(canonicalValue(forgedEvidence), deterministicSha256),
    };
    expectCandidateError("invalid-accounting-assessment", () =>
      createPhaseCandidate(unknownEvidence, deterministicSha256),
    );
  });

  it("accepts an unrelated graph revision but rejects stale task context", () => {
    const gate = emptyGate();
    const unrelatedGraph = candidateGraph(2);
    const unrelatedRevision = candidateInput(gate.policyDigest);
    unrelatedRevision.graphRevisionDigest = unrelatedGraph.revisionDigest;
    const candidate = createPhaseCandidateWithGraph(
      unrelatedRevision,
      unrelatedGraph,
      deterministicSha256,
    );

    expect(candidate.graphRevisionDigest).toBe(unrelatedGraph.revisionDigest);
    expect(candidate.acceptedAccountingAssessments).toEqual(
      createPhaseCandidate(candidateInput(gate.policyDigest), deterministicSha256)
        .acceptedAccountingAssessments,
    );

    expectCandidateError("graph-mismatch", () =>
      createPhaseCandidate(unrelatedRevision, deterministicSha256),
    );

    const staleGeneration = candidateInput(gate.policyDigest);
    staleGeneration.tasks[0] = {
      ...required(staleGeneration.tasks[0]),
      definitionGeneration: definitionGeneration(8),
    };
    staleGeneration.selectedTaskSetDigest = digestSelectedTaskSet(
      staleGeneration.tasks,
      deterministicSha256,
    );
    expectCandidateError("task-definition-mismatch", () =>
      createPhaseCandidate(staleGeneration, deterministicSha256),
    );

    const staleContext = candidateInput(gate.policyDigest);
    staleContext.tasks[0] = {
      ...required(staleContext.tasks[0]),
      contextRevisionDigest: OTHER_DIGEST,
    };
    staleContext.selectedTaskSetDigest = digestSelectedTaskSet(
      staleContext.tasks,
      deterministicSha256,
    );
    expectCandidateError("accounting-task-mismatch", () =>
      createPhaseCandidate(staleContext, deterministicSha256),
    );
  });

  it("rejects negative accounting assessments from the accepted set", () => {
    const gate = emptyGate();

    const blocked = candidateInput(gate.policyDigest);
    blocked.acceptedAccountingAssessments[0] = acceptedAssessment(
      assessmentWith("blocked", "satisfied", false),
    );
    expectCandidateError("unaccepted-accounting-assessment", () =>
      createPhaseCandidate(blocked, deterministicSha256),
    );

    const missingEvidence = candidateInput(gate.policyDigest);
    missingEvidence.acceptedAccountingAssessments[0] = acceptedAssessment(
      assessmentWith("completed", "satisfied", true),
    );
    expectCandidateError("unaccepted-accounting-assessment", () =>
      createPhaseCandidate(missingEvidence, deterministicSha256),
    );

    const unresolved = candidateInput(gate.policyDigest);
    unresolved.acceptedAccountingAssessments[0] = acceptedAssessment(
      assessmentWith("completed", "unsatisfied", false),
    );
    expectCandidateError("unaccepted-accounting-assessment", () =>
      createPhaseCandidate(unresolved, deterministicSha256),
    );
  });

  it("rejects accessors without invocation, sparse arrays, forged brands, and extra fields", () => {
    const gate = emptyGate();
    let getterCalls = 0;
    const accessorInput = candidateInput(gate.policyDigest);
    Object.defineProperty(accessorInput, "graphRevisionDigest", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return GRAPH_DIGEST;
      },
    });
    expectCandidateError("invalid-candidate", () =>
      createPhaseCandidate(accessorInput, deterministicSha256),
    );
    expect(getterCalls).toBe(0);

    const sparse = candidateInput(gate.policyDigest);
    sparse.tasks = Array(1) as TaskGenerationReference[];
    expectCandidateError("invalid-candidate", () =>
      createPhaseCandidate(sparse, deterministicSha256),
    );

    const forged = candidateInput(gate.policyDigest);
    forged.phase.phaseId = "task_wrong-kind" as never;
    expectCandidateError("invalid-candidate", () =>
      createPhaseCandidate(forged, deterministicSha256),
    );

    const extra = { ...candidateInput(gate.policyDigest), status: "ready" };
    expectCandidateError("invalid-candidate", () =>
      createPhaseCandidate(extra as PhaseCandidateInput, deterministicSha256),
    );
  });

  it("rejects a candidate whose content changed after its digest was issued", () => {
    const candidate = createPhaseCandidate(
      candidateInput(emptyGate().policyDigest),
      deterministicSha256,
    );
    const stale = { ...candidate, graphRevisionDigest: OTHER_DIGEST };

    expectCandidateError("graph-mismatch", () =>
      validatePhaseCandidate(stale, deterministicSha256),
    );
  });
});

describe("authority decisions", () => {
  it.each<AuthorityDecisionKind>(["approve", "reject"])(
    "creates an immutable content-addressed %s decision",
    (decision) => {
      const input = authorityDecisionInput(decision);
      const record = createAuthorityDecision(input, deterministicSha256);
      expect(record.decision).toBe(decision);
      expect(record.principal).toEqual(AUTHORITY);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.principal)).toBe(true);
      expect(validateAuthorityDecision(record, deterministicSha256)).toEqual(record);
      const { decisionDigest: _decisionDigest, ...content } = record;
      expect(record.decisionDigest).toBe(
        canonicalDigest(canonicalValue(content), deterministicSha256),
      );
    },
  );

  it("rejects phase waivers and scoped obligations", () => {
    expectCandidateError("invalid-decision", () =>
      createAuthorityDecision(
        { ...authorityDecisionInput("approve"), decision: "waive" } as never,
        deterministicSha256,
      ),
    );
    const approval = { ...authorityDecisionInput("approve"), scopedObligation: { task: "alpha" } };
    expectCandidateError("invalid-decision", () =>
      createAuthorityDecision(approval, deterministicSha256),
    );
  });

  // A phase closes once, so a member-scoped approval is still one candidate.
  // What it needs is a decision addressed to a task within it, which is the
  // thing the kernel could not say and why approve.scope: member was refused.
  it("lets a decision name the task it covers, without moving a phase-scoped one", () => {
    const phaseScoped = createAuthorityDecision(
      authorityDecisionInput("approve"),
      deterministicSha256,
    );
    const memberScoped = createAuthorityDecision(
      { ...authorityDecisionInput("approve"), taskId: "task_alpha" },
      deterministicSha256,
    );

    expect(memberScoped.taskId).toBe("task_alpha");
    expect(validateAuthorityDecision(memberScoped, deterministicSha256)).toEqual(memberScoped);

    // Two members approved separately are two decisions, not one repeated.
    const sibling = createAuthorityDecision(
      { ...authorityDecisionInput("approve"), taskId: "task_beta" },
      deterministicSha256,
    );
    expect(sibling.decisionDigest).not.toBe(memberScoped.decisionDigest);

    // And a decision that names no task is byte-for-byte what it always was,
    // so nothing already recorded moves.
    expect(phaseScoped).not.toHaveProperty("taskId");
    expect(phaseScoped.decisionDigest).not.toBe(memberScoped.decisionDigest);

    expectCandidateError("invalid-decision", () =>
      createAuthorityDecision(
        { ...authorityDecisionInput("approve"), taskId: "" } as never,
        deterministicSha256,
      ),
    );
  });

  it("rejects accessors, forged approval brands, timestamps, extras, and decision digests", () => {
    let getterCalls = 0;
    const accessor = authorityDecisionInput("approve");
    Object.defineProperty(accessor, "principal", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return AUTHORITY;
      },
    });
    expectCandidateError("invalid-decision", () =>
      createAuthorityDecision(accessor, deterministicSha256),
    );
    expect(getterCalls).toBe(0);

    expectCandidateError("invalid-decision", () =>
      createAuthorityDecision(
        { ...authorityDecisionInput("approve"), approvalId: "phase_wrong-kind" as never },
        deterministicSha256,
      ),
    );
    expectCandidateError("invalid-decision", () =>
      createAuthorityDecision(
        { ...authorityDecisionInput("approve"), occurredAt: "2026-08-12" },
        deterministicSha256,
      ),
    );
    expectCandidateError("invalid-decision", () =>
      createAuthorityDecision(
        { ...authorityDecisionInput("approve"), mutableStatus: "approved" } as never,
        deterministicSha256,
      ),
    );

    const decision = createAuthorityDecision(
      authorityDecisionInput("approve"),
      deterministicSha256,
    );
    expectCandidateError("invalid-decision-digest", () =>
      validateAuthorityDecision({ ...decision, decisionDigest: OTHER_DIGEST }, deterministicSha256),
    );
  });
});

describe("phase closure", () => {
  it("closes from an accepted candidate-bound gate and exact required approval", () => {
    const { candidate, gateEvidence } = closureFacts();
    const decision = createAuthorityDecision(
      authorityDecisionInput("approve", candidate.candidateDigest),
      deterministicSha256,
    );
    const closure = closePhase(
      {
        candidate,
        gateEvidence,
        approval: { policy: "approval-required", authority: AUTHORITY, decision },
      },
      deterministicSha256,
    );
    const {
      closureDigest: _closureDigest,
      outputAcceptances: _outputAcceptances,
      ...content
    } = closure;

    expect(closure).toMatchObject({
      phase: candidate.phase,
      phaseAttempt: candidate.phaseAttempt,
      graphRevisionDigest: candidate.graphRevisionDigest,
      outputSetDigest: candidate.outputSetDigest,
      candidateDigest: candidate.candidateDigest,
      gateEvaluationDigest: gateEvidence.evaluation.evaluationDigest,
      approval: { policy: "approval-required", decisionDigest: decision.decisionDigest },
    });
    expect(closure.closureDigest).toBe(
      canonicalDigest(canonicalValue(content), deterministicSha256),
    );
    expect(Object.isFrozen(closure)).toBe(true);
    expect(Object.isFrozen(closure.approval)).toBe(true);
    expect(closure.outputAcceptances).toEqual([]);
  });

  it("closes under an explicit no-approval policy", () => {
    const noApprovalFacts = closureFacts();
    expect(
      closePhase(
        {
          candidate: noApprovalFacts.candidate,
          gateEvidence: noApprovalFacts.gateEvidence,
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ).approval,
    ).toEqual({ policy: "no-approval" });
  });

  it("creates one exact output acceptance for every required publication", () => {
    const gate = emptyGate();
    const input = candidateInput(gate.policyDigest);
    const publication = createPhaseOutputPublication(
      {
        repositoryId: "repository_fixture",
        runId: runId("run_fixture"),
        phase: input.phaseAttempt,
        outputName: consumerKey("verification"),
        schemaKey: consumerKey("verification-output"),
        schemaResourceDigest: DEPENDENCY_DIGEST,
        contentDigest: INTEGRATION_DIGEST,
        byteLength: 42,
        mediaType: "application/json",
        producingTask: required(input.tasks[0]),
        dispatchId: dispatchId("dispatch_verifier"),
        contextId: contextId("context_verifier"),
        contextDigest: OTHER_DIGEST,
        graphRevisionDigest: input.graphRevisionDigest,
        configurationSnapshotDigest: DEPENDENCY_DIGEST,
        inputBindingDigest: input.inputBindingDigest,
        validationReceiptDigest: INTEGRATION_DIGEST,
      },
      deterministicSha256,
    );
    input.requiredOutputPublications = [publication];
    input.outputSetDigest = digestPhaseOutputSet([publication], deterministicSha256);
    const candidate = createPhaseCandidate(input, deterministicSha256);
    const gateEvidence = {
      definition: gate,
      readings: [],
      evaluation: evaluateGate(gate, [], candidate.candidateDigest, deterministicSha256),
    };
    const closure = closePhase(
      { candidate, gateEvidence, approval: { policy: "no-approval" } },
      deterministicSha256,
    );

    expect(closure.outputAcceptances).toEqual([
      expect.objectContaining({
        publicationId: publication.publicationId,
        publicationDigest: publication.publicationDigest,
        candidateDigest: candidate.candidateDigest,
        closureDigest: closure.closureDigest,
      }),
    ]);
  });

  it("rejects stale candidate bindings, wrong gate policies, and rejected gates", () => {
    const { candidate, gate } = closureFacts();
    const staleEvaluation = evaluateGate(gate, [], OTHER_DIGEST, deterministicSha256);
    expectCandidateError("invalid-gate-evaluation", () =>
      closePhase(
        {
          candidate,
          gateEvidence: { definition: gate, readings: [], evaluation: staleEvaluation },
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ),
    );

    const otherGate = defineGate(
      { key: consumerKey("other-gate"), blocking: [], advisory: [] },
      deterministicSha256,
    );
    const wrongPolicy = evaluateGate(otherGate, [], candidate.candidateDigest, deterministicSha256);
    expectCandidateError("policy-mismatch", () =>
      closePhase(
        {
          candidate,
          gateEvidence: { definition: otherGate, readings: [], evaluation: wrongPolicy },
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ),
    );

    const rejectingGate = defineGate(
      {
        key: consumerKey("rejecting-gate"),
        blocking: [
          {
            key: consumerKey("missing-reading"),
            condition: {
              operator: "exists",
              accessor: { sensorKey: consumerKey("absent"), pointer: "" },
            },
          },
        ],
        advisory: [],
      },
      deterministicSha256,
    );
    const rejectingCandidate = createPhaseCandidate(
      candidateInput(rejectingGate.policyDigest),
      deterministicSha256,
    );
    const rejected = evaluateGate(
      rejectingGate,
      [],
      rejectingCandidate.candidateDigest,
      deterministicSha256,
    );
    expectCandidateError("rejected-gate", () =>
      closePhase(
        {
          candidate: rejectingCandidate,
          gateEvidence: { definition: rejectingGate, readings: [], evaluation: rejected },
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ),
    );
  });

  it("rejects fabricated acceptance with a recomputed digest and incomplete source completionEvidence", () => {
    const definition = defineGate(
      {
        key: consumerKey("source-bound-gate"),
        blocking: [
          {
            key: consumerKey("required-reading"),
            condition: {
              operator: "exists",
              accessor: { sensorKey: consumerKey("missing-sensor"), pointer: "" },
            },
          },
        ],
        advisory: [],
      },
      deterministicSha256,
    );
    const candidate = createPhaseCandidate(
      candidateInput(definition.policyDigest),
      deterministicSha256,
    );
    const rejected = evaluateGate(definition, [], candidate.candidateDigest, deterministicSha256);
    const forgedContent = {
      candidateInputDigest: rejected.candidateInputDigest,
      policyDigest: rejected.policyDigest,
      readingDigests: rejected.readingDigests,
      blocking: [{ key: consumerKey("required-reading"), result: "true" }],
      advisory: rejected.advisory,
      decision: "accepted",
    } as const;
    const forged = {
      ...forgedContent,
      evaluationDigest: canonicalDigest(canonicalValue(forgedContent), deterministicSha256),
    };

    expectCandidateError("invalid-gate-evaluation", () =>
      closePhase(
        {
          candidate,
          gateEvidence: { definition, readings: [], evaluation: forged },
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ),
    );
    expectCandidateError("invalid-gate-evaluation", () =>
      closePhase(
        {
          candidate,
          gateEvidence: { readings: [], evaluation: rejected } as never,
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ),
    );
  });

  it("rejects stale, rejecting, and wrong-principal authority decisions", () => {
    const facts = closureFacts();
    const stale = createAuthorityDecision(
      authorityDecisionInput("approve", OTHER_DIGEST),
      deterministicSha256,
    );
    expectClosureDecisionError("candidate-mismatch", facts, stale, AUTHORITY);

    const rejected = createAuthorityDecision(
      authorityDecisionInput("reject", facts.candidate.candidateDigest),
      deterministicSha256,
    );
    expectClosureDecisionError("rejected-authority", facts, rejected, AUTHORITY);

    const approved = createAuthorityDecision(
      authorityDecisionInput("approve", facts.candidate.candidateDigest),
      deterministicSha256,
    );
    expectClosureDecisionError(
      "wrong-authority",
      facts,
      approved,
      canonicalValue({ principalId: "principal_other", role: "release-manager" }),
    );
  });

  it("rejects forged gate and authority digests plus mutable status fields", () => {
    const facts = closureFacts();
    const forgedGate = { ...facts.gateEvidence.evaluation, evaluationDigest: OTHER_DIGEST };
    expectCandidateError("invalid-gate-evaluation", () =>
      closePhase(
        {
          candidate: facts.candidate,
          gateEvidence: { ...facts.gateEvidence, evaluation: forgedGate },
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ),
    );

    const decision = createAuthorityDecision(
      authorityDecisionInput("approve", facts.candidate.candidateDigest),
      deterministicSha256,
    );
    expectClosureDecisionError(
      "invalid-decision-digest",
      facts,
      { ...decision, decisionDigest: OTHER_DIGEST },
      AUTHORITY,
    );

    expectCandidateError("invalid-approval-policy", () =>
      closePhase(
        {
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
          approval: { policy: "no-approval", status: "closed" } as never,
        },
        deterministicSha256,
      ),
    );

    let getterCalls = 0;
    const accessorEvidence = Object.assign(
      Object.defineProperty({}, "evaluation", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return facts.gateEvidence.evaluation;
        },
      }),
      {
        definition: facts.gateEvidence.definition,
        readings: facts.gateEvidence.readings,
      },
    );
    expectCandidateError("invalid-candidate", () =>
      closePhase(
        {
          candidate: facts.candidate,
          gateEvidence: accessorEvidence as never,
          approval: { policy: "no-approval" },
        },
        deterministicSha256,
      ),
    );
    expect(getterCalls).toBe(0);
  });
});

function candidateInput(gatePolicyDigest: ReturnType<typeof sha256Digest>): MutableCandidateInput {
  const tasks = [taskReference("task_beta"), taskReference("task_alpha")];
  const acceptedAccountingAssessments = [
    acceptedAssessment(assessmentFor("task_beta", "criterion_beta")),
    acceptedAssessment(assessmentFor("task_alpha", "criterion_alpha")),
  ];
  return {
    phase: {
      phaseId: phaseId("phase_verify"),
      definitionGeneration: definitionGeneration(2),
    },
    phaseAttempt: {
      phaseId: phaseId("phase_verify"),
      definitionGeneration: definitionGeneration(2),
      attempt: 1,
    },
    graphRevisionDigest: GRAPH_DIGEST,
    inputBindingDigest: OTHER_DIGEST,
    requiredOutputPublications: [],
    outputSetDigest: digestPhaseOutputSet([], deterministicSha256),
    selectedTaskSetDigest: digestSelectedTaskSet(tasks, deterministicSha256),
    tasks,
    acceptedAccountingAssessments,
    dependencyBarrierDigest: DEPENDENCY_DIGEST,
    integrationBarrierDigest: INTEGRATION_DIGEST,
    gatePolicyDigest,
  };
}

function candidateGraph(revision: 1 | 2): WorkflowGraph {
  return compileWorkflowGraph(
    {
      workflow: {
        id: workflowId("workflow_candidate"),
        key: consumerKey("candidate"),
        generation: definitionGeneration(1),
        source: { locator: "fixture://candidate", pointer: "" },
      },
      phases: [
        {
          id: phaseId("phase_verify"),
          key: consumerKey("verify"),
          generation: definitionGeneration(2),
          parentId: workflowId("workflow_candidate"),
          source: { locator: "fixture://candidate", pointer: "/phases/verify" },
        },
        ...(revision === 2
          ? [
              {
                id: phaseId("phase_unrelated"),
                key: consumerKey("unrelated"),
                generation: definitionGeneration(1),
                parentId: workflowId("workflow_candidate"),
                source: { locator: "fixture://candidate", pointer: "/phases/unrelated" },
              },
            ]
          : []),
      ],
      executableWork: [
        {
          id: taskId("task_old-alpha"),
          key: consumerKey("old-alpha"),
          generation: definitionGeneration(1),
          parentId: phaseId("phase_verify"),
          source: { locator: "fixture://candidate", pointer: "/tasks/old-alpha" },
          completionPolicy: {
            criteria: [],
            completionEvidencePolicy: { mode: "none", requirements: [] },
          },
        },
        {
          id: taskId("task_alpha"),
          key: consumerKey("alpha"),
          generation: definitionGeneration(2),
          parentId: phaseId("phase_verify"),
          supersedes: [taskId("task_old-alpha")],
          source: { locator: "fixture://candidate", pointer: "/tasks/alpha" },
          completionPolicy: {
            criteria: [{ criterionId: criterionId("criterion_alpha"), required: true }],
            completionEvidencePolicy: { mode: "none", requirements: [] },
          },
        },
        {
          id: taskId("task_beta"),
          key: consumerKey("beta"),
          generation: definitionGeneration(2),
          parentId: phaseId("phase_verify"),
          source: { locator: "fixture://candidate", pointer: "/tasks/beta" },
          completionPolicy: {
            criteria: [{ criterionId: criterionId("criterion_beta"), required: true }],
            completionEvidencePolicy: {
              mode: "required-criteria",
              requirements: [{ kind: canonicalValue({ kind: "report" }), minimumCount: 1 }],
            },
          },
        },
      ],
      criteria: [
        {
          id: criterionId("criterion_alpha"),
          key: consumerKey("alpha"),
          generation: definitionGeneration(1),
          parentId: taskId("task_alpha"),
          source: { locator: "fixture://candidate", pointer: "/criteria/alpha" },
        },
        {
          id: criterionId("criterion_beta"),
          key: consumerKey("beta"),
          generation: definitionGeneration(1),
          parentId: taskId("task_beta"),
          source: { locator: "fixture://candidate", pointer: "/criteria/beta" },
        },
      ],
    },
    deterministicSha256,
  );
}

function taskReference(
  token: string,
  generation = definitionGeneration(2),
): TaskGenerationReference {
  return {
    taskId: taskId(token),
    definitionGeneration: generation,
    contextRevisionDigest: sha256Digest(token.endsWith("alpha") ? "a".repeat(64) : "b".repeat(64)),
  };
}

function assessmentFor(
  taskToken: string,
  criterionToken: string,
  generation = definitionGeneration(2),
): { requirements: CompletionRequirements; assessment: AccountingAssessment } {
  const task = taskReference(taskToken, generation);
  const criterion = criterionId(criterionToken);
  const requirements: CompletionRequirements = {
    task,
    criteria: [{ criterionId: criterion, required: true }],
    completionEvidencePolicy:
      taskToken === "task_beta"
        ? {
            mode: "required-criteria",
            requirements: [{ kind: canonicalValue({ kind: "report" }), minimumCount: 1 }],
          }
        : { mode: "none", requirements: [] },
  };
  const submission: CompletionSubmission = {
    task,
    disposition: "completed",
    summary: `Completed ${taskToken}`,
    criteria: [{ criterionId: criterion, disposition: "satisfied" }],
    completionEvidence:
      requirements.completionEvidencePolicy.mode === "none"
        ? []
        : [
            {
              assetId: assetId(`asset_${taskToken.replace("task_", "")}`),
              kind: canonicalValue({ kind: "report" }),
              descriptor: canonicalValue({ result: "passed" }),
              criterionId: criterion,
            },
          ],
  };
  return { requirements, assessment: assessCompletionAccounting(requirements, submission) };
}

function assessmentWith(
  taskDisposition: CompletionSubmission["disposition"],
  criterionDisposition: CompletionSubmission["criteria"][number]["disposition"],
  requireEvidence: boolean,
): { requirements: CompletionRequirements; assessment: AccountingAssessment } {
  const task = taskReference(requireEvidence ? "task_beta" : "task_alpha");
  const criterion = criterionId(requireEvidence ? "criterion_beta" : "criterion_alpha");
  const requirements = required(
    deriveCompletionRequirements(GRAPH, [task], deterministicSha256)[0],
  );
  return {
    requirements,
    assessment: assessCompletionAccounting(requirements, {
      task,
      disposition: taskDisposition,
      summary: "Negative accounting fixture",
      criteria: [{ criterionId: criterion, disposition: criterionDisposition }],
      completionEvidence: [],
    }),
  };
}

function acceptedAssessment(fixture: {
  requirements: CompletionRequirements;
  assessment: AccountingAssessment;
}): MutableAcceptedAssessment {
  return {
    assessment: fixture.assessment,
    assessmentDigest: digestAccountingAssessment(fixture.assessment, deterministicSha256),
  };
}

function emptyGate() {
  return defineGate(
    { key: consumerKey("closure-gate"), blocking: [], advisory: [] },
    deterministicSha256,
  );
}

function closureFacts() {
  const gate = emptyGate();
  const candidate = createPhaseCandidate(candidateInput(gate.policyDigest), deterministicSha256);
  const evaluation = evaluateGate(gate, [], candidate.candidateDigest, deterministicSha256);
  return {
    candidate,
    gate,
    gateEvidence: { definition: gate, readings: [], evaluation },
  };
}

function authorityDecisionInput(
  decision: AuthorityDecisionKind,
  candidateDigest = sha256Digest("c".repeat(64)),
): MutableAuthorityDecisionInput {
  return {
    decision,
    approvalId: approvalId("approval_release"),
    principal: AUTHORITY,
    occurredAt: "2026-08-12T15:30:00.000Z",
    candidateDigest,
  };
}

function taskIdFromAssessment(accepted: AcceptedAccountingAssessment) {
  return accepted.assessment.submission.task.taskId;
}

function expectClosureDecisionError(
  code: CandidateErrorCode,
  facts: ReturnType<typeof closureFacts>,
  decision: AuthorityDecision,
  authority: unknown,
): void {
  expectCandidateError(code, () =>
    closePhase(
      {
        candidate: facts.candidate,
        gateEvidence: facts.gateEvidence,
        approval: { policy: "approval-required", authority, decision },
      },
      deterministicSha256,
    ),
  );
}

function expectCandidateError(code: CandidateErrorCode, operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateError);
    expect((error as CandidateError).code).toBe(code);
    return;
  }
  throw new Error(`Expected CandidateError with code ${code}`);
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}

interface MutableCandidateInput {
  phase: {
    phaseId: ReturnType<typeof phaseId>;
    definitionGeneration: ReturnType<typeof definitionGeneration>;
  };
  phaseAttempt: {
    phaseId: ReturnType<typeof phaseId>;
    definitionGeneration: ReturnType<typeof definitionGeneration>;
    attempt: number;
  };
  graphRevisionDigest: ReturnType<typeof sha256Digest>;
  inputBindingDigest: ReturnType<typeof sha256Digest>;
  requiredOutputPublications: PhaseOutputPublication[];
  outputSetDigest: ReturnType<typeof sha256Digest>;
  selectedTaskSetDigest: ReturnType<typeof sha256Digest>;
  tasks: TaskGenerationReference[];
  acceptedAccountingAssessments: MutableAcceptedAssessment[];
  dependencyBarrierDigest: ReturnType<typeof sha256Digest>;
  integrationBarrierDigest?: ReturnType<typeof sha256Digest>;
  gatePolicyDigest: ReturnType<typeof sha256Digest>;
}

interface MutableAcceptedAssessment {
  assessmentDigest: ReturnType<typeof sha256Digest>;
  assessment: AccountingAssessment;
}

interface MutableAuthorityDecisionInput {
  decision: AuthorityDecisionKind;
  approvalId: ReturnType<typeof approvalId>;
  principal: unknown;
  occurredAt: string;
  candidateDigest: ReturnType<typeof sha256Digest>;
}

describe("authority decision reasons", () => {
  it("carries a reason and binds it into the decision digest", () => {
    const base = {
      decision: "reject" as const,
      approvalId: approvalId("approval_reason"),
      principal: { subject: "operator" },
      occurredAt: "2026-08-17T00:00:00.000Z",
      candidateDigest: sha256Digest("1".repeat(64)),
    };
    const withoutReason = createAuthorityDecision(base, deterministicSha256);
    const withReason = createAuthorityDecision(
      { ...base, reason: "The plan omits the migration step" },
      deterministicSha256,
    );
    expect(withReason.reason).toBe("The plan omits the migration step");
    // The reason is part of what was decided, so it cannot be revised after the
    // fact without producing a different decision.
    expect(withReason.decisionDigest).not.toBe(withoutReason.decisionDigest);
    expect(validateAuthorityDecision(withReason, deterministicSha256)).toEqual(withReason);
  });

  it("refuses an empty reason rather than recording a decision that says nothing", () => {
    expect(() =>
      createAuthorityDecision(
        {
          decision: "reject",
          approvalId: approvalId("approval_empty"),
          principal: { subject: "operator" },
          occurredAt: "2026-08-17T00:00:00.000Z",
          candidateDigest: sha256Digest("1".repeat(64)),
          reason: "",
        },
        deterministicSha256,
      ),
    ).toThrow();
  });
});
