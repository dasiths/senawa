import { describe, expect, it } from "vitest";
import {
  AmendmentError,
  amendmentImpactsOverlap,
  applyApprovedAmendment,
  createAmendmentDecision,
  createAmendmentProposal,
  createAmendmentQuiescenceFact,
  createAmendmentWithdrawal,
  projectAmendmentLifecycle,
  validateAmendmentProposal,
} from "./amendments.js";
import { canonicalValue, type Sha256, sha256Digest } from "./canonical.js";
import { compileWorkflowGraph, type NormalizedWorkflowInput } from "./graph.js";
import {
  amendmentId,
  approvalId,
  consumerKey,
  criterionId,
  definitionGeneration,
  phaseId,
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
const DIGEST = sha256Digest("a".repeat(64));
const OCCURRED_AT = "2026-08-13T12:00:00.000Z";

describe("additive amendment proposals", () => {
  it("normalizes operations and binds the exact base, impact, and reviewed graph", () => {
    const proposal = proposalWith([addTask("verify", "build")]);
    const reordered = proposalWith([addPhase("release"), addTask("verify", "build")]);
    const reverse = proposalWith([addTask("verify", "build"), addPhase("release")]);

    expect(proposal.amendmentId).toBe(amendmentId(`amendment_${proposal.proposalDigest}`));
    expect(proposal.baseGraph).toEqual(BASE_GRAPH);
    expect(proposal.reviewedResultGraph.nodes).toHaveLength(BASE_GRAPH.nodes.length + 2);
    expect(proposal.impact.existingTargetPhases).toEqual([
      { phaseId: phaseId("phase_build"), definitionGeneration: definitionGeneration(1) },
    ]);
    expect(proposal.impact.affectedTaskScopes).toEqual([
      { taskId: taskId("task_compile"), definitionGeneration: definitionGeneration(1) },
    ]);
    expect(reverse).toEqual(reordered);
    expect(validateAmendmentProposal(proposal, [], deterministicSha256)).toEqual(proposal);
  });

  it.each([
    [
      "superseding phase",
      () => ({
        ...addPhase("release"),
        phase: { ...addPhase("release").phase, supersedes: [phaseId("phase_build")] },
      }),
    ],
    [
      "superseding task",
      () => ({
        ...addTask("verify", "build"),
        task: { ...addTask("verify", "build").task, supersedes: [taskId("task_compile")] },
      }),
    ],
    [
      "reparented criterion",
      () => ({
        ...addTask("verify", "build"),
        criteria: [{ ...addTask("verify", "build").criteria[0], parentId: taskId("task_compile") }],
      }),
    ],
    ["duplicate identity", () => addTask("compile", "build", taskId("task_compile"))],
  ])("rejects a %s", (_name, operation) => {
    expectAmendmentError(
      () => proposalWith([operation() as ReturnType<typeof addTask>]),
      ["non-additive-change", "invalid-operation"],
    );
  });

  it("rejects adding work to an existing phase with candidate history", () => {
    expectAmendmentError(
      () =>
        proposalWith(
          [addTask("verify", "build")],
          [{ phaseId: phaseId("phase_build"), definitionGeneration: definitionGeneration(1) }],
        ),
      ["candidate-history"],
    );
  });

  it("allows a task with owned criteria in a jointly added phase", () => {
    const proposal = proposalWith([addTask("publish", "release"), addPhase("release")]);

    expect(proposal.impact.addedPhases).toHaveLength(1);
    expect(proposal.impact.addedTasks).toHaveLength(1);
    expect(proposal.impact.addedCriteria).toHaveLength(1);
    expect(proposal.impact.existingTargetPhases).toEqual([]);
    expect(proposal.impact.affectedTaskScopes).toEqual([]);
  });

  it("detects overlapping existing phase impacts", () => {
    const first = proposalWith([addTask("verify", "build")]);
    const second = proposalWith([addTask("package", "build")]);
    const disjoint = proposalWith([addPhase("release")]);

    expect(amendmentImpactsOverlap(first.impact, second.impact)).toBe(true);
    expect(amendmentImpactsOverlap(first.impact, disjoint.impact)).toBe(false);
  });
});

describe("amendment decisions and application", () => {
  it("keeps unrelated candidate history current and marks affected history stale", () => {
    const proposal = proposalWith([addTask("verify", "build")]);
    const unrelatedHistory = [
      { phaseId: phaseId("phase_release"), definitionGeneration: definitionGeneration(1) },
    ];
    const affectedHistory = [
      { phaseId: phaseId("phase_build"), definitionGeneration: definitionGeneration(1) },
    ];

    expect(
      projectAmendmentLifecycle(
        { proposal, currentGraph: BASE_GRAPH, phaseCandidateHistory: unrelatedHistory },
        deterministicSha256,
      ).status,
    ).toBe("reviewable");
    expect(
      projectAmendmentLifecycle(
        { proposal, currentGraph: BASE_GRAPH, phaseCandidateHistory: affectedHistory },
        deterministicSha256,
      ).status,
    ).toBe("stale");
    expectAmendmentError(
      () =>
        createAmendmentDecision(
          decisionInput(),
          proposal,
          { ...context(BASE_GRAPH), phaseCandidateHistory: affectedHistory },
          deterministicSha256,
        ),
      ["candidate-history"],
    );
  });

  it("refuses stale and overlapping approval", () => {
    const proposal = proposalWith([addTask("verify", "build")]);
    const changed = proposalWith([addPhase("release")]).reviewedResultGraph;
    const decision = decisionInput();

    expectAmendmentError(
      () => createAmendmentDecision(decision, proposal, context(changed), deterministicSha256),
      ["stale-base"],
    );
    expectAmendmentError(
      () =>
        createAmendmentDecision(
          decision,
          proposal,
          {
            ...context(BASE_GRAPH),
            pendingProposals: [proposalWith([addTask("package", "build")])],
          },
          deterministicSha256,
        ),
      ["overlapping-proposal"],
    );
  });

  it("projects withdrawal exactly and refuses later approval", () => {
    const proposal = proposalWith([addPhase("release")]);
    const withdrawal = createAmendmentWithdrawal(
      { principal: { id: "human-reviewer" }, occurredAt: OCCURRED_AT },
      proposal,
      undefined,
      deterministicSha256,
    );

    expect(
      projectAmendmentLifecycle(
        {
          proposal,
          currentGraph: BASE_GRAPH,
          phaseCandidateHistory: [],
          withdrawal,
        },
        deterministicSha256,
      ).status,
    ).toBe("withdrawn");
    expectAmendmentError(
      () =>
        createAmendmentDecision(
          decisionInput(),
          proposal,
          { ...context(BASE_GRAPH), withdrawal },
          deterministicSha256,
        ),
      ["withdrawn-proposal"],
    );
  });

  it("applies the approved reviewed graph without recompiling raw source", () => {
    const proposal = proposalWith([addTask("verify", "build")]);
    const decision = createAmendmentDecision(
      decisionInput(),
      proposal,
      context(BASE_GRAPH),
      deterministicSha256,
    );
    const quiescence = createAmendmentQuiescenceFact(
      {
        occurredAt: OCCURRED_AT,
        affectedTaskScopes: proposal.impact.affectedTaskScopes,
        liveClaimCount: 0,
        nonterminalEffectCount: 0,
      },
      proposal,
      deterministicSha256,
    );
    const application = applyApprovedAmendment(
      {
        proposal,
        decision,
        currentGraph: BASE_GRAPH,
        quiescence,
        occurredAt: OCCURRED_AT,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );

    expect(application.graph).toEqual(proposal.reviewedResultGraph);
    expect(application.afterGraphRevisionDigest).toBe(proposal.reviewedResultGraph.revisionDigest);
    expect(
      projectAmendmentLifecycle(
        {
          proposal,
          currentGraph: application.graph,
          phaseCandidateHistory: [],
          decision,
          application,
        },
        deterministicSha256,
      ).status,
    ).toBe("applied");
  });

  it("refuses application while affected work is not quiescent", () => {
    const proposal = proposalWith([addTask("verify", "build")]);
    const decision = createAmendmentDecision(
      decisionInput(),
      proposal,
      context(BASE_GRAPH),
      deterministicSha256,
    );
    const quiescence = createAmendmentQuiescenceFact(
      {
        occurredAt: OCCURRED_AT,
        affectedTaskScopes: proposal.impact.affectedTaskScopes,
        liveClaimCount: 1,
        nonterminalEffectCount: 0,
      },
      proposal,
      deterministicSha256,
    );

    expectAmendmentError(
      () =>
        applyApprovedAmendment(
          {
            proposal,
            decision,
            currentGraph: BASE_GRAPH,
            quiescence,
            occurredAt: OCCURRED_AT,
            phaseCandidateHistory: [],
          },
          deterministicSha256,
        ),
      ["invalid-quiescence"],
    );
  });
});

const BASE_INPUT: NormalizedWorkflowInput = {
  workflow: {
    id: workflowId("workflow_delivery"),
    key: consumerKey("delivery"),
    generation: definitionGeneration(1),
    source: { locator: "fixture://base", pointer: "/workflow" },
  },
  phases: [
    {
      id: phaseId("phase_build"),
      key: consumerKey("build"),
      generation: definitionGeneration(1),
      parentId: workflowId("workflow_delivery"),
      source: { locator: "fixture://base", pointer: "/phases/build" },
    },
  ],
  executableWork: [
    {
      id: taskId("task_compile"),
      key: consumerKey("compile"),
      generation: definitionGeneration(1),
      parentId: phaseId("phase_build"),
      source: { locator: "fixture://base", pointer: "/phases/build/work/compile" },
      completionPolicy: {
        criteria: [],
        completionEvidencePolicy: { mode: "none", requirements: [] },
      },
    },
  ],
  criteria: [],
};
const BASE_GRAPH = compileWorkflowGraph(BASE_INPUT, deterministicSha256);

function addPhase(key: string) {
  return {
    kind: "add-phase" as const,
    phase: {
      id: phaseId(`phase_${key}`),
      key: consumerKey(key),
      generation: definitionGeneration(1),
      parentId: BASE_INPUT.workflow.id,
      dependsOn: [phaseId("phase_build")],
      source: { locator: "fixture://amendment", pointer: `/operations/${key}` },
    },
  };
}

function addTask(key: string, phase: string, id = taskId(`task_${key}`)) {
  const criterion = criterionId(`criterion_${key}`);
  return {
    kind: "add-task" as const,
    task: {
      id,
      key: consumerKey(key),
      generation: definitionGeneration(1),
      parentId: phaseId(`phase_${phase}`),
      dependsOn: [taskId("task_compile")],
      source: { locator: "fixture://amendment", pointer: `/operations/${key}` },
      input: canonicalValue({ command: key }),
      completionPolicy: {
        criteria: [{ criterionId: criterion, required: true }],
        completionEvidencePolicy: { mode: "none" as const, requirements: [] },
      },
    },
    criteria: [
      {
        id: criterion,
        key: consumerKey(key),
        generation: definitionGeneration(1),
        parentId: id,
        source: { locator: "fixture://amendment", pointer: `/operations/${key}/criteria/${key}` },
      },
    ],
  };
}

function proposalWith(
  operations: Array<ReturnType<typeof addTask> | ReturnType<typeof addPhase>>,
  phaseCandidateHistory: Array<{
    phaseId: ReturnType<typeof phaseId>;
    definitionGeneration: ReturnType<typeof definitionGeneration>;
  }> = [],
) {
  return createAmendmentProposal(
    {
      source: { kind: "human", requestDigest: DIGEST },
      baseGraph: BASE_GRAPH,
      baseContextDigest: DIGEST,
      baseConfigurationSnapshotDigest: DIGEST,
      resultConfigurationSnapshotDigest: sha256Digest("b".repeat(64)),
      operations,
      phaseCandidateHistory,
    },
    deterministicSha256,
  );
}

function decisionInput() {
  return {
    decision: "approve" as const,
    approvalId: approvalId("approval_amendment"),
    principal: { id: "human-reviewer" },
    occurredAt: OCCURRED_AT,
  };
}

function context(currentGraph: typeof BASE_GRAPH) {
  return { currentGraph, phaseCandidateHistory: [] };
}

function expectAmendmentError(run: () => unknown, codes: string[]) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AmendmentError);
    expect(codes).toContain((error as AmendmentError).code);
    return;
  }
  throw new Error("Expected amendment operation to fail");
}
