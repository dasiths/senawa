import {
  canonicalDigest,
  canonicalValue,
  compareFanOutEvaluations,
  compileWorkflowGraph,
  consumerKey,
  contextId,
  createPhaseAttempt,
  createPhaseOutputAcceptance,
  createPhaseOutputPublication,
  definitionGeneration,
  dispatchId,
  evaluateTaskFrontier,
  type FanOutEvaluation,
  phaseId,
  runId,
  type Sha256,
  sha256Digest,
  taskId,
} from "@senawa/kernel";
import { describe, expect, it } from "vitest";
import {
  createFanOutAmendmentOperations,
  PlanImportCoordinator,
  type PlanImportKey,
  type PlanImportPersistencePort,
} from "./plan-import.js";

const sha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const DIGEST = sha256Digest("1".repeat(64));
const OTHER_DIGEST = sha256Digest("2".repeat(64));
const PHASE_ID = phaseId("phase_implement");

describe("plan import", () => {
  it("persists evaluation before enqueuing one canonical additive proposal", () => {
    const fixture = createFixture([item("a")]);
    const persistence = new MemoryPersistence();
    const result = new PlanImportCoordinator(persistence, sha256).import(fixture.request);

    expect(result.status).toBe("proposal-enqueued");
    expect(persistence.events).toEqual(["evaluation", "proposal"]);
    expect(result.status === "proposal-enqueued" && result.proposal.operations).toHaveLength(1);
  });

  it("converges when a crash occurs after evaluation persistence and before enqueue", () => {
    const fixture = createFixture([item("a")]);
    const persistence = new MemoryPersistence();
    persistence.crashBeforeFirstEnqueue = true;
    const coordinator = new PlanImportCoordinator(persistence, sha256);

    expect(() => coordinator.import(fixture.request)).toThrow("crash-before-enqueue");
    const replay = coordinator.import(fixture.request);
    expect(replay.status).toBe("proposal-enqueued");
    expect(persistence.events).toEqual(["evaluation", "evaluation-replay", "proposal"]);
  });

  it("requires explicit review for changed or removed identities", () => {
    const priorFixture = createFixture([item("a"), item("b")]);
    const currentFixture = createFixture([
      canonicalValue({ identity: "a", dependsOn: [], value: 2 }),
    ]);
    const persistence = new MemoryPersistence();
    persistence.applied = priorFixture.evaluation;
    const result = new PlanImportCoordinator(persistence, sha256).import(currentFixture.request);

    expect(result.status).toBe("review-required");
    expect(result.diff).toMatchObject({
      status: "review-required",
      changes: [{ before: { identity: "a" }, after: { identity: "a" } }],
      removals: [{ identity: "b" }],
    });
  });

  it("refuses stale closure, graph, definition, and attempt authority", () => {
    const fixture = createFixture([item("a")]);
    const coordinator = new PlanImportCoordinator(new MemoryPersistence(), sha256);
    expect(() =>
      coordinator.import({ ...fixture.request, expectedDefinitionDigest: OTHER_DIGEST }),
    ).toThrow("exact accepted closure, fan-out, graph, snapshot, and attempt");
  });

  it("creates additive successors whose dependencies target successor identities", () => {
    const prior = createFixture([item("a"), item("b", ["a"])]).evaluation;
    const current = createFixture([
      canonicalValue({ identity: "a", dependsOn: [], value: 2 }),
      canonicalValue({ identity: "b", dependsOn: ["a"], value: 2 }),
    ]).evaluation;
    const diff = compareFanOutEvaluations(current, prior, sha256);
    const operations = createFanOutAmendmentOperations(
      diff,
      createFixture([]).request.template,
      sha256,
    );
    const tasks = operations.map((operation) => {
      if (operation.kind !== "add-task") throw new Error("Expected generated task operation");
      return operation.task;
    });
    const predecessorA = prior.members[0];
    const predecessorB = prior.members[1];
    if (predecessorA === undefined || predecessorB === undefined) {
      throw new Error("Expected two prior fan-out members");
    }
    const successorA = tasks.find((task) => task.supersedes?.includes(predecessorA.taskId));
    const successorB = tasks.find((task) => task.supersedes?.includes(predecessorB.taskId));

    expect(successorA).toBeDefined();
    expect(successorB?.dependsOn).toEqual([successorA?.id]);
    expect(successorB?.generation).toBe(2);
  });
});

class MemoryPersistence implements PlanImportPersistencePort {
  applied: FanOutEvaluation | undefined;
  recorded: FanOutEvaluation | undefined;
  events: string[] = [];
  crashBeforeFirstEnqueue = false;

  appliedEvaluation(_key: PlanImportKey): FanOutEvaluation | undefined {
    return this.applied;
  }

  recordEvaluation(
    _key: PlanImportKey,
    evaluation: FanOutEvaluation,
    expectedPriorEvaluationDigest: string | undefined,
  ): "created" | "replayed" | "conflict" {
    if (expectedPriorEvaluationDigest !== this.applied?.evaluationDigest) return "conflict";
    if (this.recorded?.evaluationDigest === evaluation.evaluationDigest) {
      this.events.push("evaluation-replay");
      return "replayed";
    }
    if (this.recorded !== undefined) return "conflict";
    this.recorded = evaluation;
    this.events.push("evaluation");
    return "created";
  }

  enqueueProposal(): "created" | "replayed" {
    if (this.crashBeforeFirstEnqueue) {
      this.crashBeforeFirstEnqueue = false;
      throw new Error("crash-before-enqueue");
    }
    this.events.push("proposal");
    return "created";
  }
}

function createFixture(items: readonly ReturnType<typeof item>[]) {
  const phase = {
    phaseId: PHASE_ID,
    definitionGeneration: definitionGeneration(1),
    attempt: 1,
  };
  const attempt = createPhaseAttempt(
    {
      repositoryId: "repository",
      runId: runId("run_example"),
      phase,
      inputBindingDigest: DIGEST,
      sourceSetDigest: DIGEST,
      executorDigest: DIGEST,
      graphRevisionDigest: DIGEST,
      configurationSnapshotDigest: DIGEST,
      upstreamClosureSetDigest: DIGEST,
      upstreamOutputSetDigest: DIGEST,
    },
    sha256,
  );
  const graph = compileWorkflowGraph(
    {
      workflow: {
        id: "workflow_example" as never,
        key: consumerKey("workflow"),
        generation: definitionGeneration(1),
        source: { locator: "test://workflow", pointer: "/workflow" },
      },
      phases: [
        {
          id: PHASE_ID,
          key: consumerKey("implement"),
          generation: definitionGeneration(1),
          parentId: "workflow_example" as never,
          source: { locator: "test://workflow", pointer: "/phases/implement" },
        },
      ],
      executableWork: [],
      criteria: [],
    },
    sha256,
  );
  const publication = createPhaseOutputPublication(
    {
      repositoryId: "repository",
      runId: runId("run_example"),
      phase,
      outputName: consumerKey("plan"),
      schemaKey: consumerKey("plan-schema"),
      schemaResourceDigest: DIGEST,
      contentDigest: DIGEST,
      byteLength: 1,
      mediaType: "application/json",
      sensitivity: "internal",
      producingTask: {
        taskId: taskId("task_planner"),
        definitionGeneration: definitionGeneration(1),
        contextRevisionDigest: DIGEST,
      },
      dispatchId: dispatchId("dispatch_planner"),
      contextId: contextId("context_planner"),
      contextDigest: DIGEST,
      graphRevisionDigest: graph.revisionDigest,
      configurationSnapshotDigest: DIGEST,
      inputBindingDigest: DIGEST,
      validationReceiptDigest: DIGEST,
    },
    sha256,
  );
  const acceptance = createPhaseOutputAcceptance(
    { publication, candidateDigest: DIGEST, closureDigest: DIGEST },
    sha256,
  );
  const templateBinding = canonicalValue({
    key: "implementation",
    repositoryChanges: "required",
  });
  const templateDigest = canonicalDigest(templateBinding, sha256);
  const evaluation = evaluateTaskFrontier(
    {
      repositoryId: "repository",
      runId: "run_example",
      attemptDigest: attempt.attemptDigest,
      forEachKey: consumerKey("plan-tasks"),
      definitionDigest: DIGEST,
      sourceBindingDigest: acceptance.acceptanceDigest,
      sourceValue: canonicalValue({ tasks: items }),
      collectionPointer: "/tasks",
      collectionSchemaDigest: DIGEST,
      itemSchemaDigest: DIGEST,
      identityPointer: "/identity",
      template: {
        key: consumerKey("implement"),
        parentPhaseId: PHASE_ID,
        generation: definitionGeneration(1),
        templateDigest,
        inputSchemaDigest: DIGEST,
        inputMappings: [
          {
            key: consumerKey("item"),
            source: { kind: "current-item", pointer: "" },
            destinationPointer: "",
          },
        ],
        dependencyIdentityPointer: "/dependsOn",
      },
      sourceBindings: [],
      mappingPolicy: {
        dependencyPhases: [],
        declaredPhaseOutputs: [],
        implementationEvidenceViews: [],
        allowCurrentItem: true,
      },
      limits: {
        maxSelectedItems: 256,
        maxTotalTasks: 1024,
        maxConcurrency: 32,
        exhaustion: "fail",
      },
      acceptedTotalTasks: 0,
      graphRevisionDigest: graph.revisionDigest,
      configurationSnapshotDigest: DIGEST,
    },
    { validate: () => [] },
    sha256,
  );
  return {
    evaluation,
    request: {
      evaluation,
      phaseAttempt: attempt,
      publication,
      acceptance,
      expectedClosureDigest: DIGEST,
      expectedDefinitionDigest: DIGEST,
      baseGraph: graph,
      baseContextDigest: DIGEST,
      baseConfigurationSnapshotDigest: DIGEST,
      resultConfigurationSnapshotDigest: OTHER_DIGEST,
      phaseCandidateHistory: [],
      template: {
        templateDigest,
        binding: templateBinding,
        parentPhaseId: PHASE_ID,
        criteria: [],
        evidencePolicy: { mode: "none" as const, requirements: [] },
      },
    },
  };
}

function item(identity: string, dependsOn: string[] = []) {
  return canonicalValue({ identity, dependsOn, value: 1 });
}
