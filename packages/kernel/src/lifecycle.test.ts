import { describe, expect, it } from "vitest";
import { createEscalation, type Escalation } from "./budgets.js";
import {
  closePhase as closePhaseWithGraph,
  createAuthorityDecision,
  createPhaseCandidate as createPhaseCandidateWithGraph,
  deriveCompletionRequirements,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  type PhaseCandidate,
} from "./candidates.js";
import { canonicalDigest, canonicalValue, type Sha256, sha256Digest } from "./canonical.js";
import {
  assessCompletionAccounting,
  type CompletionRequirements,
  type CompletionSubmission,
} from "./completion.js";
import { defineGate, evaluateGate, type GateEvidence } from "./gates.js";
import { compileWorkflowGraph } from "./graph.js";
import {
  approvalId,
  consumerKey,
  criterionId,
  definitionGeneration,
  escalationId,
  phaseId,
  taskId,
  workflowId,
} from "./identity.js";
import {
  LifecycleError,
  type LifecycleErrorCode,
  type PhaseApprovalPolicyInput,
  type PhaseLifecycleInput,
  projectPhaseLifecycle,
} from "./lifecycle.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const PHASE = {
  phaseId: phaseId("phase_release"),
  definitionGeneration: definitionGeneration(2),
};
const TASK = {
  taskId: taskId("task_verify"),
  definitionGeneration: definitionGeneration(3),
  contextRevisionDigest: sha256Digest("a".repeat(64)),
};
const GRAPH = compileWorkflowGraph(
  {
    workflow: {
      id: workflowId("workflow_lifecycle"),
      key: consumerKey("lifecycle"),
      generation: definitionGeneration(1),
      source: { locator: "fixture://lifecycle", pointer: "" },
    },
    phases: [
      {
        id: PHASE.phaseId,
        key: consumerKey("release"),
        generation: PHASE.definitionGeneration,
        parentId: workflowId("workflow_lifecycle"),
        source: { locator: "fixture://lifecycle", pointer: "/phases/release" },
      },
    ],
    executableWork: [
      {
        id: TASK.taskId,
        key: consumerKey("verify"),
        generation: TASK.definitionGeneration,
        parentId: PHASE.phaseId,
        source: { locator: "fixture://lifecycle", pointer: "/tasks/verify" },
        completionPolicy: {
          criteria: [{ criterionId: criterionId("criterion_release-ready"), required: true }],
          completionEvidencePolicy: { mode: "none", requirements: [] },
        },
      },
    ],
    criteria: [
      {
        id: criterionId("criterion_release-ready"),
        key: consumerKey("release-ready"),
        generation: definitionGeneration(1),
        parentId: TASK.taskId,
        source: { locator: "fixture://lifecycle", pointer: "/criteria/release-ready" },
      },
    ],
  },
  deterministicSha256,
);
const GRAPH_DIGEST = GRAPH.revisionDigest;
const DEPENDENCY_DIGEST = sha256Digest("2".repeat(64));
const ESCALATION_POLICY_DIGEST = sha256Digest("4".repeat(64));
const OTHER_DIGEST = sha256Digest("f".repeat(64));
const AUTHORITY = canonicalValue({ principalId: "principal_release", role: "release-manager" });

function createPhaseCandidate(
  input: Parameters<typeof createPhaseCandidateWithGraph>[0],
  sha256: Sha256,
) {
  return createPhaseCandidateWithGraph(input, GRAPH, sha256);
}

function closePhase(
  input: Omit<Parameters<typeof closePhaseWithGraph>[0], "graph">,
  sha256: Sha256,
) {
  return closePhaseWithGraph({ ...input, graph: GRAPH }, sha256);
}

describe("phase lifecycle projection", () => {
  it("derives awaiting-completion without accepting mutable status authority", () => {
    const projection = projectPhaseLifecycle(baseInput(), deterministicSha256);
    const { projectionDigest: _projectionDigest, ...content } = projection;

    expect(projection.status).toBe("awaiting-completion");
    expect(projection.taskAccounting).toEqual({
      selectedCount: 0,
      accountedCount: 0,
      dispositionCounts: {
        completed: 0,
        blocked: 0,
        waived: 0,
        skipped: 0,
        superseded: 0,
      },
      accounts: [],
    });
    expect(projection.records).toEqual({ escalationDigests: [] });
    expect(projection.projectionDigest).toBe(
      canonicalDigest(canonicalValue(content), deterministicSha256),
    );
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.taskAccounting)).toBe(true);
  });

  it("derives awaiting-gate, gate-rejected, and awaiting-approval from exact records", () => {
    const accepted = acceptedFacts();
    expect(
      projectPhaseLifecycle({ ...baseInput(), candidate: accepted.candidate }, deterministicSha256)
        .status,
    ).toBe("awaiting-gate");

    const rejected = rejectedFacts();
    expect(
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: rejected.candidate,
          gateEvidence: rejected.gateEvidence,
        },
        deterministicSha256,
      ).status,
    ).toBe("gate-rejected");

    const awaitingApproval = projectPhaseLifecycle(
      {
        ...baseInput({ policy: "approval-required", authority: AUTHORITY }),
        candidate: accepted.candidate,
        gateEvidence: accepted.gateEvidence,
      },
      deterministicSha256,
    );
    expect(awaitingApproval.status).toBe("awaiting-approval");
    expect(awaitingApproval.humanNeeds).toEqual([
      {
        kind: "approval",
        candidateDigest: accepted.candidate.candidateDigest,
        authority: AUTHORITY,
      },
    ]);
  });

  it("derives approval rejection, awaiting closure, and closed only from revalidated facts", () => {
    const facts = acceptedFacts();
    const rejected = authorityDecision(facts.candidate, "reject");
    expect(
      projectPhaseLifecycle(
        {
          ...baseInput({ policy: "approval-required", authority: AUTHORITY }),
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
          authorityDecision: rejected,
        },
        deterministicSha256,
      ).status,
    ).toBe("approval-rejected");

    expect(
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
        },
        deterministicSha256,
      ).status,
    ).toBe("awaiting-closure");

    const approved = authorityDecision(facts.candidate, "approve");
    const approvalPolicy = { policy: "approval-required", authority: AUTHORITY } as const;
    const closure = closePhase(
      {
        candidate: facts.candidate,
        gateEvidence: facts.gateEvidence,
        approval: { ...approvalPolicy, decision: approved },
      },
      deterministicSha256,
    );
    const closed = projectPhaseLifecycle(
      {
        ...baseInput(approvalPolicy),
        candidate: facts.candidate,
        gateEvidence: facts.gateEvidence,
        authorityDecision: approved,
        closure,
      },
      deterministicSha256,
    );

    expect(closed.status).toBe("closed");
    expect(closed.records.closureDigest).toBe(closure.closureDigest);
    expect(closed.humanNeeds).toEqual([]);
  });

  // A phase closes once, so member scope is still one candidate -- but one
  // decision has nowhere to record the second member's answer. The lifecycle
  // carries a decision per task and stays open while any task is owed one.
  it("keeps a member-scoped phase awaiting approval until every member is decided", () => {
    const facts = acceptedFacts();
    const policy = { policy: "approval-required", authority: AUTHORITY, scope: "member" } as const;
    const forTask = (taskId: string) =>
      createAuthorityDecision(
        {
          decision: "approve",
          approvalId: approvalId(`approval_${taskId.replace(/[^a-z0-9]/gu, "")}`),
          principal: AUTHORITY,
          occurredAt: "2026-08-12T16:00:00.000Z",
          candidateDigest: facts.candidate.candidateDigest,
          taskId,
        },
        deterministicSha256,
      );
    const only = String(facts.candidate.tasks[0]?.taskId);
    const base = {
      ...baseInput(policy),
      candidate: facts.candidate,
      gateEvidence: facts.gateEvidence,
      authorityDecision: authorityDecision(facts.candidate, "approve"),
    };

    // The phase's own decision is in, but the member's is not.
    expect(projectPhaseLifecycle(base, deterministicSha256).status).toBe("awaiting-approval");

    // With every member decided it may close.
    expect(
      projectPhaseLifecycle({ ...base, authorityDecisions: [forTask(only)] }, deterministicSha256)
        .status,
    ).toBe("awaiting-closure");

    // One member cannot stand in for another.
    expect(() =>
      projectPhaseLifecycle(
        { ...base, authorityDecisions: [forTask(only), forTask(only)] },
        deterministicSha256,
      ),
    ).toThrow(/decided twice/u);

    // A decision that names no task is not a member's.
    expect(() =>
      projectPhaseLifecycle(
        { ...base, authorityDecisions: [authorityDecision(facts.candidate, "approve")] },
        deterministicSha256,
      ),
    ).toThrow(/must name the task/u);

    // And a phase-scoped policy will not carry them at all.
    expect(() =>
      projectPhaseLifecycle(
        {
          ...baseInput({ policy: "approval-required", authority: AUTHORITY }),
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
          authorityDecision: authorityDecision(facts.candidate, "approve"),
          authorityDecisions: [forTask(only)],
        },
        deterministicSha256,
      ),
    ).toThrow(/member-scoped approval policy/u);
  });

  it("projects task accounting and active escalation details for human action", () => {
    const facts = acceptedFacts();
    const escalation = taskEscalation(facts.candidate);
    const projection = projectPhaseLifecycle(
      {
        ...baseInput(),
        candidate: facts.candidate,
        gateEvidence: facts.gateEvidence,
        escalations: [escalation],
      },
      deterministicSha256,
    );

    expect(projection.status).toBe("escalated");
    expect(projection.taskAccounting).toMatchObject({
      selectedCount: 1,
      accountedCount: 1,
      dispositionCounts: { completed: 1, blocked: 0, waived: 0, skipped: 0, superseded: 0 },
      accounts: [{ task: TASK, disposition: "completed", summary: "Verified release" }],
    });
    expect(projection.humanNeeds).toEqual([
      {
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
      },
    ]);
  });

  it("canonicalizes multiple current escalations independent of caller order", () => {
    const facts = acceptedFacts();
    const first = taskEscalation(facts.candidate);
    const second = taskEscalation(facts.candidate, "escalation_second");
    const forward = projectPhaseLifecycle(
      { ...baseInput(), candidate: facts.candidate, escalations: [first, second] },
      deterministicSha256,
    );
    const reverse = projectPhaseLifecycle(
      { ...baseInput(), candidate: facts.candidate, escalations: [second, first] },
      deterministicSha256,
    );

    expect(forward).toEqual(reverse);
    expect(forward.records.escalationDigests).toEqual(
      [first.escalationDigest, second.escalationDigest].sort(),
    );
  });

  it("rejects mismatched phase, gate, approval, and escalation relations", () => {
    const facts = acceptedFacts();
    expectLifecycleError("phase-mismatch", () =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          phase: { ...PHASE, definitionGeneration: definitionGeneration(9) },
          candidate: facts.candidate,
        },
        deterministicSha256,
      ),
    );

    const staleGate = evaluateGate(facts.gate, [], OTHER_DIGEST, deterministicSha256);
    expectLifecycleError("invalid-input", () =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          gateEvidence: { definition: facts.gate, readings: [], evaluation: staleGate },
        },
        deterministicSha256,
      ),
    );

    const otherGate = defineGate(
      { key: consumerKey("other-gate"), blocking: [], advisory: [] },
      deterministicSha256,
    );
    const wrongPolicyGate = evaluateGate(
      otherGate,
      [],
      facts.candidate.candidateDigest,
      deterministicSha256,
    );
    expectLifecycleError("gate-policy-mismatch", () =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          gateEvidence: { definition: otherGate, readings: [], evaluation: wrongPolicyGate },
        },
        deterministicSha256,
      ),
    );

    const staleDecision = createAuthorityDecision(
      {
        decision: "approve",
        approvalId: approvalId("approval_stale"),
        principal: AUTHORITY,
        occurredAt: "2026-08-12T16:00:00.000Z",
        candidateDigest: OTHER_DIGEST,
      },
      deterministicSha256,
    );
    expectLifecycleError("decision-candidate-mismatch", () =>
      projectPhaseLifecycle(
        {
          ...baseInput({ policy: "approval-required", authority: AUTHORITY }),
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
          authorityDecision: staleDecision,
        },
        deterministicSha256,
      ),
    );

    const wrongAuthorityDecision = createAuthorityDecision(
      {
        decision: "approve",
        approvalId: approvalId("approval_wrong-authority"),
        principal: { principalId: "principal_other" },
        occurredAt: "2026-08-12T16:00:00.000Z",
        candidateDigest: facts.candidate.candidateDigest,
      },
      deterministicSha256,
    );
    expectLifecycleError("wrong-authority", () =>
      projectPhaseLifecycle(
        {
          ...baseInput({ policy: "approval-required", authority: AUTHORITY }),
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
          authorityDecision: wrongAuthorityDecision,
        },
        deterministicSha256,
      ),
    );

    const escalation = taskEscalation(facts.candidate);
    expectLifecycleError("escalation-policy-mismatch", () =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          escalationPolicyDigest: OTHER_DIGEST,
          candidate: facts.candidate,
          escalations: [escalation],
        },
        deterministicSha256,
      ),
    );

    const staleEscalation = createEscalation(
      { ...escalationInput(facts.candidate), candidateDigest: OTHER_DIGEST },
      deterministicSha256,
    );
    expectLifecycleError("escalation-candidate-mismatch", () =>
      projectPhaseLifecycle(
        { ...baseInput(), candidate: facts.candidate, escalations: [staleEscalation] },
        deterministicSha256,
      ),
    );

    const wrongOwner = createEscalation(
      {
        ...escalationInput(facts.candidate),
        owner: { ...TASK, kind: "task", taskId: taskId("task_other") },
      },
      deterministicSha256,
    );
    expectLifecycleError("escalation-owner-mismatch", () =>
      projectPhaseLifecycle(
        { ...baseInput(), candidate: facts.candidate, escalations: [wrongOwner] },
        deterministicSha256,
      ),
    );

    const wrongContext = createEscalation(
      { ...escalationInput(facts.candidate), contextDigest: OTHER_DIGEST },
      deterministicSha256,
    );
    expectLifecycleError("escalation-context-mismatch", () =>
      projectPhaseLifecycle(
        { ...baseInput(), candidate: facts.candidate, escalations: [wrongContext] },
        deterministicSha256,
      ),
    );
  });

  it("rejects forged records and a closure with any active escalation", () => {
    const facts = acceptedFacts();
    expect(() =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: { ...facts.candidate, candidateDigest: OTHER_DIGEST },
        },
        deterministicSha256,
      ),
    ).toThrow();

    const rejected = rejectedFacts();
    const rejectedEvaluation = rejected.gateEvidence.evaluation;
    const forgedContent = {
      candidateInputDigest: rejectedEvaluation.candidateInputDigest,
      policyDigest: rejectedEvaluation.policyDigest,
      readingDigests: rejectedEvaluation.readingDigests,
      blocking: [{ key: consumerKey("required-reading"), result: "true" }],
      advisory: rejectedEvaluation.advisory,
      decision: "accepted",
    } as const;
    const forgedEvaluation = {
      ...forgedContent,
      evaluationDigest: canonicalDigest(canonicalValue(forgedContent), deterministicSha256),
    };
    expectLifecycleError("invalid-input", () =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: rejected.candidate,
          gateEvidence: { ...rejected.gateEvidence, evaluation: forgedEvaluation },
        },
        deterministicSha256,
      ),
    );
    expectLifecycleError("invalid-input", () =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          gateEvidence: {
            readings: facts.gateEvidence.readings,
            evaluation: facts.gateEvidence.evaluation,
          } as never,
        },
        deterministicSha256,
      ),
    );

    expect(() =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          gateEvidence: {
            ...facts.gateEvidence,
            evaluation: { ...facts.gateEvidence.evaluation, evaluationDigest: OTHER_DIGEST },
          },
        },
        deterministicSha256,
      ),
    ).toThrow();

    const closure = closePhase(
      {
        candidate: facts.candidate,
        gateEvidence: facts.gateEvidence,
        approval: { policy: "no-approval" },
      },
      deterministicSha256,
    );
    expect(() =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
          closure: { ...closure, closureDigest: OTHER_DIGEST },
        },
        deterministicSha256,
      ),
    ).toThrow();

    const escalation = taskEscalation(facts.candidate);
    expect(() =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          escalations: [{ ...escalation, escalationDigest: OTHER_DIGEST }],
        },
        deterministicSha256,
      ),
    ).toThrow();

    expectLifecycleError("closure-escalation-conflict", () =>
      projectPhaseLifecycle(
        {
          ...baseInput(),
          candidate: facts.candidate,
          gateEvidence: facts.gateEvidence,
          closure,
          escalations: [escalation],
        },
        deterministicSha256,
      ),
    );
  });

  it("rejects accessors, sparse arrays, extra fields, and premature decisions", () => {
    let getterCalls = 0;
    const accessorInput = baseInput();
    Object.defineProperty(accessorInput, "candidate", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return acceptedFacts().candidate;
      },
    });
    expectLifecycleError("invalid-input", () =>
      projectPhaseLifecycle(accessorInput, deterministicSha256),
    );
    expect(getterCalls).toBe(0);

    const facts = acceptedFacts();
    const accessorEvidenceInput = baseInput();
    Object.assign(accessorEvidenceInput, { candidate: facts.candidate });
    Object.defineProperty(accessorEvidenceInput, "gateEvidence", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return facts.gateEvidence;
      },
    });
    expectLifecycleError("invalid-input", () =>
      projectPhaseLifecycle(accessorEvidenceInput, deterministicSha256),
    );
    expect(getterCalls).toBe(0);

    expectLifecycleError("invalid-input", () =>
      projectPhaseLifecycle(
        { ...baseInput(), escalations: Array(1) } as PhaseLifecycleInput,
        deterministicSha256,
      ),
    );
    expectLifecycleError("invalid-input", () =>
      projectPhaseLifecycle({ ...baseInput(), status: "closed" } as never, deterministicSha256),
    );

    expectLifecycleError("decision-before-gate", () =>
      projectPhaseLifecycle(
        {
          ...baseInput({ policy: "approval-required", authority: AUTHORITY }),
          candidate: facts.candidate,
          authorityDecision: authorityDecision(facts.candidate, "approve"),
        },
        deterministicSha256,
      ),
    );
  });
});

function baseInput(
  approvalPolicy: PhaseApprovalPolicyInput = { policy: "no-approval" },
): PhaseLifecycleInput {
  return {
    graph: GRAPH,
    phase: PHASE,
    approvalPolicy,
    escalationPolicyDigest: ESCALATION_POLICY_DIGEST,
  };
}

function acceptedFacts(): {
  candidate: PhaseCandidate;
  gateEvidence: GateEvidence;
  gate: ReturnType<typeof defineGate>;
} {
  const gate = defineGate(
    { key: consumerKey("release-gate"), blocking: [], advisory: [] },
    deterministicSha256,
  );
  const candidate = createCandidate(gate.policyDigest);
  return {
    candidate,
    gate,
    gateEvidence: {
      definition: gate,
      readings: [],
      evaluation: evaluateGate(gate, [], candidate.candidateDigest, deterministicSha256),
    },
  };
}

function rejectedFacts(): { candidate: PhaseCandidate; gateEvidence: GateEvidence } {
  const gate = defineGate(
    {
      key: consumerKey("rejecting-gate"),
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
  const phaseCandidate = createCandidate(gate.policyDigest);
  return {
    candidate: phaseCandidate,
    gateEvidence: {
      definition: gate,
      readings: [],
      evaluation: evaluateGate(gate, [], phaseCandidate.candidateDigest, deterministicSha256),
    },
  };
}

function createCandidate(gatePolicyDigest: ReturnType<typeof sha256Digest>): PhaseCandidate {
  const criterion = criterionId("criterion_release-ready");
  const requirements = deriveCompletionRequirements(
    GRAPH,
    [TASK],
    deterministicSha256,
  )[0] as CompletionRequirements;
  const submission: CompletionSubmission = {
    task: TASK,
    disposition: "completed",
    summary: "Verified release",
    criteria: [{ criterionId: criterion, disposition: "satisfied" }],
    completionEvidence: [],
  };
  const assessment = assessCompletionAccounting(requirements, submission);
  const accepted = {
    assessment,
    assessmentDigest: digestAccountingAssessment(assessment, deterministicSha256),
  };
  return createPhaseCandidate(
    {
      phase: PHASE,
      phaseAttempt: { ...PHASE, attempt: 1 },
      graphRevisionDigest: GRAPH_DIGEST,
      inputBindingDigest: DEPENDENCY_DIGEST,
      requiredOutputPublications: [],
      outputSetDigest: digestPhaseOutputSet([], deterministicSha256),
      selectedTaskSetDigest: digestSelectedTaskSet([TASK], deterministicSha256),
      tasks: [TASK],
      acceptedAccountingAssessments: [accepted],
      dependencyBarrierDigest: DEPENDENCY_DIGEST,
      gatePolicyDigest,
    },
    deterministicSha256,
  );
}

function authorityDecision(phaseCandidate: PhaseCandidate, decision: "approve" | "reject") {
  return createAuthorityDecision(
    {
      decision,
      approvalId: approvalId(`approval_${decision}`),
      principal: AUTHORITY,
      occurredAt: "2026-08-12T16:00:00.000Z",
      candidateDigest: phaseCandidate.candidateDigest,
    },
    deterministicSha256,
  );
}

function taskEscalation(phaseCandidate: PhaseCandidate, token = "escalation_release"): Escalation {
  return createEscalation(
    { ...escalationInput(phaseCandidate), escalationId: escalationId(token) },
    deterministicSha256,
  );
}

function escalationInput(phaseCandidate: PhaseCandidate): {
  escalationId: ReturnType<typeof escalationId>;
  owner: {
    kind: "task";
    taskId: ReturnType<typeof taskId>;
    definitionGeneration: ReturnType<typeof definitionGeneration>;
    contextRevisionDigest: ReturnType<typeof sha256Digest>;
  };
  trigger: { kind: "blocked" };
  contextDigest: ReturnType<typeof sha256Digest>;
  candidateDigest: ReturnType<typeof sha256Digest>;
  policyDigest: ReturnType<typeof sha256Digest>;
  unresolvedCriterionIds: ReturnType<typeof criterionId>[];
  failedReadingDigests: ReturnType<typeof sha256Digest>[];
  unknownReadingDigests: ReturnType<typeof sha256Digest>[];
  attemptFacts: [];
  allowedResponses: ["reassign", "approve-amendment"];
  timestamp: string;
} {
  return {
    escalationId: escalationId("escalation_release"),
    owner: { kind: "task", ...TASK },
    trigger: { kind: "blocked" },
    contextDigest: TASK.contextRevisionDigest,
    candidateDigest: phaseCandidate.candidateDigest,
    policyDigest: ESCALATION_POLICY_DIGEST,
    unresolvedCriterionIds: [criterionId("criterion_release-ready")],
    failedReadingDigests: [],
    unknownReadingDigests: [],
    attemptFacts: [],
    allowedResponses: ["reassign", "approve-amendment"],
    timestamp: "2026-08-12T16:05:00Z",
  };
}

function expectLifecycleError(code: LifecycleErrorCode, operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LifecycleError);
    expect((error as LifecycleError).code).toBe(code);
    return;
  }
  throw new Error(`Expected LifecycleError with code ${code}`);
}

type _NoMutableStatusInput = Extract<keyof PhaseLifecycleInput, "status"> extends never
  ? true
  : never;
const noMutableStatusInput: _NoMutableStatusInput = true;
void noMutableStatusInput;
