import { describe, expect, expectTypeOf, it } from "vitest";
import { canonicalValue, type Sha256 } from "./canonical.js";
import {
  type ContainsEdge,
  type CriterionDefinition,
  type CriterionDefinitionInput,
  compileWorkflowGraph,
  type DependsOnEdge,
  GraphCompilationError,
  type GraphCompilationErrorCode,
  GraphValidationError,
  type NormalizedWorkflowInput,
  type PhaseDefinition,
  type PhaseDefinitionInput,
  type SupersedesEdge,
  type TaskDefinition,
  type TaskDefinitionInput,
  validateWorkflowGraph,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from "./graph.js";
import {
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
    for (const byte of bytes) {
      accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    }
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

describe("workflow graph compilation", () => {
  it.each([
    ["software delivery", softwareDeliveryFixture()],
    ["incident response", incidentResponseFixture()],
  ])("compiles normalized %s definitions through one domain-neutral path", (_name, input) => {
    const graph = compileWorkflowGraph(input, deterministicSha256);

    expect(graph.workflowId).toBe(input.workflow.id);
    expect(graph.nodes).toHaveLength(
      1 + input.phases.length + input.executableWork.length + input.criteria.length,
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining(["workflow", "phase", "task", "criterion"]),
    );
    expect(graph.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits typed containment, dependency, and supersession edges", () => {
    const graph = compileWorkflowGraph(softwareDeliveryFixture(), deterministicSha256);

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { kind: "contains", from: workflowId("workflow_delivery"), to: phaseId("phase_build") },
        { kind: "contains", from: phaseId("phase_build"), to: taskId("task_compile") },
        {
          kind: "contains",
          from: taskId("task_test"),
          to: criterionId("criterion_tests-pass"),
        },
        { kind: "depends-on", from: phaseId("phase_release"), to: phaseId("phase_build") },
        { kind: "depends-on", from: taskId("task_test"), to: taskId("task_compile") },
        { kind: "supersedes", from: taskId("task_test"), to: taskId("task_old-check") },
      ]),
    );

    expectTypeOf<ContainsEdge["kind"]>().toEqualTypeOf<"contains">();
    expectTypeOf<DependsOnEdge["kind"]>().toEqualTypeOf<"depends-on">();
    expectTypeOf<SupersedesEdge["kind"]>().toEqualTypeOf<"supersedes">();
  });

  it("normalizes unordered references and produces stable immutable definitions", () => {
    const firstInput = softwareDeliveryFixture();
    const secondInput = softwareDeliveryFixture();
    secondInput.phases.reverse();
    secondInput.executableWork.reverse();
    secondInput.criteria.reverse();
    secondInput.executableWork[1] = {
      ...required(secondInput.executableWork[1]),
      input: { command: "test", environment: { shard: 1, clean: true } },
    };
    firstInput.executableWork[0] = {
      ...required(firstInput.executableWork[0]),
      dependsOn: [taskId("task_old-check")],
    };
    secondInput.executableWork[3] = {
      ...required(secondInput.executableWork[3]),
      dependsOn: [taskId("task_old-check")],
    };

    const first = compileWorkflowGraph(firstInput, deterministicSha256);
    const second = compileWorkflowGraph(secondInput, deterministicSha256);

    expect(first.revisionDigest).toBe(second.revisionDigest);
    expect(first.nodes).toEqual(second.nodes);
    expect(first.edges).toEqual(second.edges);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nodes)).toBe(true);
    expect(Object.isFrozen(first.edges)).toBe(true);
    for (const node of first.nodes) {
      expect(Object.isFrozen(node)).toBe(true);
      expect(Object.isFrozen(node.definition)).toBe(true);
      expect(Object.isFrozen(node.definition.source)).toBe(true);
      expect(Object.isFrozen(node.definition.input)).toBe(true);
    }
  });

  it("keeps workflow, phase, task, and criterion definitions distinct", () => {
    expectTypeOf<WorkflowDefinition>().not.toEqualTypeOf<PhaseDefinition>();
    expectTypeOf<PhaseDefinition>().not.toEqualTypeOf<TaskDefinition>();
    expectTypeOf<TaskDefinition>().not.toEqualTypeOf<CriterionDefinition>();
  });

  it("binds task completion policy into the canonical definition digest", () => {
    const firstInput = softwareDeliveryFixture();
    const secondInput = softwareDeliveryFixture();
    required(
      secondInput.executableWork.find((task) => task.id === taskId("task_test")),
    ).completionPolicy.evidencePolicy = {
      mode: "required-criteria",
      requirements: [{ kind: canonicalValue({ kind: "test-report" }), minimumCount: 1 }],
    };

    const first = compileWorkflowGraph(firstInput, deterministicSha256);
    const second = compileWorkflowGraph(secondInput, deterministicSha256);
    const firstTask = required(
      first.nodes.find((node) => node.definition.id === taskId("task_test")),
    );
    const secondTask = required(
      second.nodes.find((node) => node.definition.id === taskId("task_test")),
    );

    expect(firstTask.definition.definitionDigest).not.toBe(secondTask.definition.definitionDigest);
    expect(first.revisionDigest).not.toBe(second.revisionDigest);
  });
});

describe("workflow graph validation", () => {
  it("recompiles an exact graph and returns compiler-owned authority", () => {
    const submitted = mutableGraph(softwareDeliveryFixture());

    const validated = validateWorkflowGraph(submitted, deterministicSha256);
    const submittedTask = submitted.nodes.find(
      (node) => node.kind === "task" && node.definition.id === "task_compile",
    );
    if (submittedTask === undefined) {
      throw new Error("Expected task fixture");
    }
    submittedTask.definition.input = { target: "mutated" };

    expect(validated).toEqual(compileWorkflowGraph(softwareDeliveryFixture(), deterministicSha256));
    expect(validated).not.toBe(submitted);
    expect(validated.nodes).not.toBe(submitted.nodes);
    expect(
      validated.nodes.find((node) => node.definition.id === "task_compile")?.definition.input,
    ).toEqual({ target: "application" });
  });

  it("rejects a fabricated empty graph even with a well-formed digest", () => {
    expectValidationError(() =>
      validateWorkflowGraph(
        {
          workflowId: workflowId("workflow_fabricated"),
          revisionDigest: "a".repeat(64),
          nodes: [],
          edges: [],
        },
        deterministicSha256,
      ),
    );
  });

  it.each([
    ["extra graph field", (graph: MutableGraph) => setBoundaryField(graph, "authority", true)],
    ["missing graph field", (graph: MutableGraph) => delete (graph as Partial<MutableGraph>).edges],
    [
      "extra definition field",
      (graph: MutableGraph) => setBoundaryField(required(graph.nodes[0]).definition, "owner", "x"),
    ],
    [
      "missing definition field",
      (graph: MutableGraph) => delete required(graph.nodes[0]).definition.input,
    ],
    [
      "extra source field",
      (graph: MutableGraph) =>
        setBoundaryField(required(graph.nodes[0]).definition.source, "line", 1),
    ],
    [
      "malformed definition brand",
      (graph: MutableGraph) =>
        setBoundaryField(required(graph.nodes[0]).definition, "id", "task_wrong"),
    ],
  ])("rejects %s", (_name, mutate) => {
    const graph = mutableGraph(softwareDeliveryFixture());
    mutate(graph);

    expectValidationError(() => validateWorkflowGraph(graph, deterministicSha256));
  });

  it("rejects wrong node content, graph digests, and forged edges", () => {
    const wrongNode = mutableGraph(softwareDeliveryFixture());
    required(wrongNode.nodes.find((node) => node.kind === "task")).definition.input = {
      forged: true,
    };
    const wrongDigest = mutableGraph(softwareDeliveryFixture());
    wrongDigest.revisionDigest = "b".repeat(64);
    const forgedEdge = mutableGraph(softwareDeliveryFixture());
    forgedEdge.edges.push({
      kind: "depends-on",
      from: taskId("task_compile"),
      to: taskId("task_old-check"),
    });

    expectValidationError(() => validateWorkflowGraph(wrongNode, deterministicSha256));
    expectValidationError(() => validateWorkflowGraph(wrongDigest, deterministicSha256));
    expectValidationError(() => validateWorkflowGraph(forgedEdge, deterministicSha256));
  });

  it("rejects noncanonical node and edge ordering", () => {
    const nodesReordered = mutableGraph(softwareDeliveryFixture());
    nodesReordered.nodes.reverse();
    const edgesReordered = mutableGraph(softwareDeliveryFixture());
    edgesReordered.edges.reverse();

    expectValidationError(() => validateWorkflowGraph(nodesReordered, deterministicSha256));
    expectValidationError(() => validateWorkflowGraph(edgesReordered, deterministicSha256));
  });
});

describe("graph invariants", () => {
  it.each([
    [
      "omitted owned criterion",
      (input: MutableWorkflowInput) => {
        required(
          input.executableWork.find((task) => task.id === taskId("task_contain")),
        ).completionPolicy.criteria = [];
      },
    ],
    [
      "unknown criterion",
      (input: MutableWorkflowInput) => {
        required(input.executableWork[0]).completionPolicy.criteria = [
          { criterionId: criterionId("criterion_unknown"), required: true },
        ];
      },
    ],
    [
      "duplicate criterion",
      (input: MutableWorkflowInput) => {
        const policy = required(
          input.executableWork.find((task) => task.id === taskId("task_contain")),
        ).completionPolicy;
        policy.criteria.push({ ...required(policy.criteria[0]) });
      },
    ],
  ])("rejects a completion policy with an %s", (_name, mutate) => {
    const input = incidentResponseFixture();
    mutate(input);

    expectCompilationError("invalid-completion-policy", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it("rejects stateful accessors without invoking them", () => {
    const input = incidentResponseFixture();
    let reads = 0;
    Object.defineProperty(input.workflow, "id", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? workflowId("workflow_incident") : taskId("task_wrong-kind");
      },
    });

    expectCompilationError("invalid-input", () => compileWorkflowGraph(input, deterministicSha256));
    expect(reads).toBe(0);
  });

  it.each([
    ["workflow", (input: MutableWorkflowInput) => input.workflow, "phase_wrong-kind"],
    ["phase", (input: MutableWorkflowInput) => required(input.phases[0]), "task_wrong-kind"],
    [
      "task",
      (input: MutableWorkflowInput) => required(input.executableWork[0]),
      "phase_wrong-kind",
    ],
    ["criterion", (input: MutableWorkflowInput) => required(input.criteria[0]), "task_wrong-kind"],
  ])("rejects a forged %s identity at the JavaScript boundary", (_kind, select, id) => {
    const input = incidentResponseFixture();
    setBoundaryField(select(input), "id", id);

    expectCompilationError("invalid-identity", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it.each([
    ["workflow", (input: MutableWorkflowInput) => input.workflow],
    ["phase", (input: MutableWorkflowInput) => required(input.phases[0])],
    ["task", (input: MutableWorkflowInput) => required(input.executableWork[0])],
    ["criterion", (input: MutableWorkflowInput) => required(input.criteria[0])],
  ])("rejects an invalid %s consumer key", (_kind, select) => {
    const input = incidentResponseFixture();
    setBoundaryField(select(input), "key", "Invalid Key");

    expectCompilationError("invalid-key", () => compileWorkflowGraph(input, deterministicSha256));
  });

  it.each([
    ["workflow", (input: MutableWorkflowInput) => input.workflow],
    ["phase", (input: MutableWorkflowInput) => required(input.phases[0])],
    ["task", (input: MutableWorkflowInput) => required(input.executableWork[0])],
    ["criterion", (input: MutableWorkflowInput) => required(input.criteria[0])],
  ])("rejects an invalid %s generation", (_kind, select) => {
    const input = incidentResponseFixture();
    setBoundaryField(select(input), "generation", 0);

    expectCompilationError("invalid-generation", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it.each([
    [
      "phase dependency",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.phases[0]), "dependsOn", [taskId("task_contain")]),
    ],
    [
      "phase supersession",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.phases[0]), "supersedes", [taskId("task_contain")]),
    ],
    [
      "task dependency",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.executableWork[0]), "dependsOn", [phaseId("phase_triage")]),
    ],
    [
      "task supersession",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.executableWork[0]), "supersedes", [
          phaseId("phase_triage"),
        ]),
    ],
    [
      "criterion supersession",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.criteria[0]), "supersedes", [taskId("task_contain")]),
    ],
  ])("rejects a forged %s identity before normalization", (_relation, mutate) => {
    const input = incidentResponseFixture();
    mutate(input);

    expectCompilationError("invalid-relation", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it("rejects sparse relations as unstable canonical input", () => {
    const sparseInput = incidentResponseFixture();
    setBoundaryField(required(sparseInput.phases[0]), "dependsOn", Array(1));

    expectCompilationError("invalid-input", () =>
      compileWorkflowGraph(sparseInput, deterministicSha256),
    );
  });

  it("rejects dense non-array relations before normalization", () => {
    const scalarInput = incidentResponseFixture();
    setBoundaryField(required(scalarInput.executableWork[0]), "supersedes", "task_contain");

    expectCompilationError("invalid-relation", () =>
      compileWorkflowGraph(scalarInput, deterministicSha256),
    );
  });

  it.each([
    [
      "phase",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.phases[0]), "parentId", taskId("task_contain")),
    ],
    [
      "task",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.executableWork[0]), "parentId", taskId("task_contain")),
    ],
    [
      "criterion",
      (input: MutableWorkflowInput) =>
        setBoundaryField(required(input.criteria[0]), "parentId", phaseId("phase_triage")),
    ],
  ])("rejects a forged %s parent identity", (_kind, mutate) => {
    const input = incidentResponseFixture();
    mutate(input);

    expectCompilationError("invalid-parent", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it("rejects duplicate consumer keys within the same parent and kind", () => {
    const input = incidentResponseFixture();
    input.executableWork.push({
      ...required(input.executableWork[0]),
      id: taskId("task_duplicate-triage"),
    });

    expectCompilationError("duplicate-key", () => compileWorkflowGraph(input, deterministicSha256));
  });

  it("allows the same consumer key for different parents or definition kinds", () => {
    const input = incidentResponseFixture();
    input.phases.push({
      id: phaseId("phase_followup"),
      key: consumerKey("followup"),
      generation: definitionGeneration(1),
      parentId: input.workflow.id,
      source: source("incident", "/phases/followup"),
    });
    input.executableWork.push({
      id: taskId("task_followup-triage"),
      key: consumerKey("triage"),
      generation: definitionGeneration(1),
      parentId: phaseId("phase_followup"),
      source: source("incident", "/tasks/followup-triage"),
      completionPolicy: emptyCompletionPolicy(),
    });

    expect(() => compileWorkflowGraph(input, deterministicSha256)).not.toThrow();
  });

  it("rejects duplicate immutable identities", () => {
    const input = incidentResponseFixture();
    input.phases.push({ ...required(input.phases[0]) });

    expectCompilationError("duplicate-id", () => compileWorkflowGraph(input, deterministicSha256));
  });

  it.each([
    [
      "parent",
      (input: MutableWorkflowInput) => {
        input.executableWork[0] = {
          ...required(input.executableWork[0]),
          parentId: phaseId("phase_missing"),
        };
      },
    ],
    [
      "dependency",
      (input: MutableWorkflowInput) => {
        input.executableWork[0] = {
          ...required(input.executableWork[0]),
          dependsOn: [taskId("task_missing")],
        };
      },
    ],
    [
      "supersession",
      (input: MutableWorkflowInput) => {
        input.executableWork[0] = {
          ...required(input.executableWork[0]),
          supersedes: [taskId("task_missing")],
        };
      },
    ],
  ])("rejects an unknown %s reference", (_name, mutate) => {
    const input = incidentResponseFixture();
    mutate(input);

    expectCompilationError("unknown-reference", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it("rejects containment cycles", () => {
    const input = incidentResponseFixture();
    input.phases[0] = {
      ...required(input.phases[0]),
      parentId: phaseId("phase_mitigate"),
    };
    input.phases[1] = {
      ...required(input.phases[1]),
      parentId: phaseId("phase_triage"),
    };

    expectCompilationError("containment-cycle", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it.each([
    [
      "phase",
      (input: MutableWorkflowInput) => {
        input.phases[0] = {
          ...required(input.phases[0]),
          dependsOn: [phaseId("phase_mitigate")],
        };
        input.phases[1] = {
          ...required(input.phases[1]),
          dependsOn: [phaseId("phase_triage")],
        };
      },
    ],
    [
      "task",
      (input: MutableWorkflowInput) => {
        input.executableWork[0] = {
          ...required(input.executableWork[0]),
          dependsOn: [taskId("task_contain")],
        };
        input.executableWork[1] = {
          ...required(input.executableWork[1]),
          dependsOn: [taskId("task_assess")],
        };
      },
    ],
  ])("rejects %s dependency cycles", (_name, mutate) => {
    const input = incidentResponseFixture();
    mutate(input);

    expectCompilationError("dependency-cycle", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it("rejects supersession cycles before generation checks", () => {
    const input = incidentResponseFixture();
    input.executableWork[0] = {
      ...required(input.executableWork[0]),
      supersedes: [taskId("task_contain")],
    };
    input.executableWork[1] = {
      ...required(input.executableWork[1]),
      supersedes: [taskId("task_assess")],
    };

    expectCompilationError("supersession-cycle", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it("rejects parent identities with the wrong entity kind", () => {
    const input = incidentResponseFixture();
    input.executableWork[0] = {
      ...required(input.executableWork[0]),
      parentId: taskId("task_contain") as unknown as ReturnType<typeof phaseId>,
    };

    expectCompilationError("invalid-parent", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it.each([
    [
      "different owners",
      (input: MutableWorkflowInput) => {
        input.executableWork[1] = {
          ...required(input.executableWork[1]),
          generation: definitionGeneration(2),
          supersedes: [taskId("task_assess")],
        };
      },
    ],
    [
      "non-increasing generations",
      (input: MutableWorkflowInput) => {
        input.executableWork[0] = {
          ...required(input.executableWork[0]),
          supersedes: [taskId("task_observe")],
        };
      },
    ],
  ])("rejects supersession with %s", (_name, mutate) => {
    const input = incidentResponseFixture();
    mutate(input);

    expectCompilationError("invalid-supersession", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it("rejects invalid source pointers before producing graph nodes", () => {
    const input = incidentResponseFixture();
    input.criteria[0] = {
      ...required(input.criteria[0]),
      source: { locator: "", pointer: "/criteria/contained" },
    };

    expectCompilationError("invalid-source", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });

  it.each([
    ["locator", 42],
    ["pointer", null],
  ])("rejects a non-string source %s at the JavaScript boundary", (field, value) => {
    const input = incidentResponseFixture();
    setBoundaryField(required(input.phases[0]).source, field, value);

    expectCompilationError("invalid-source", () =>
      compileWorkflowGraph(input, deterministicSha256),
    );
  });
});

interface MutableWorkflowInput {
  workflow: WorkflowDefinitionInput;
  phases: PhaseDefinitionInput[];
  executableWork: MutableTaskDefinitionInput[];
  criteria: CriterionDefinitionInput[];
}

interface MutableTaskDefinitionInput extends Omit<TaskDefinitionInput, "completionPolicy"> {
  completionPolicy: {
    criteria: Array<{ criterionId: ReturnType<typeof criterionId>; required: boolean }>;
    evidencePolicy: TaskDefinitionInput["completionPolicy"]["evidencePolicy"];
  };
}

interface MutableGraph {
  workflowId: string;
  revisionDigest: string;
  nodes: Array<{
    kind: string;
    definition: Record<string, unknown> & {
      input: unknown;
      source: Record<string, unknown>;
    };
  }>;
  edges: Array<{ kind: string; from: string; to: string }>;
}

function mutableGraph(input: MutableWorkflowInput): MutableGraph {
  return JSON.parse(
    JSON.stringify(compileWorkflowGraph(input, deterministicSha256)),
  ) as MutableGraph;
}

function softwareDeliveryFixture(): MutableWorkflowInput {
  return {
    workflow: {
      id: workflowId("workflow_delivery"),
      key: consumerKey("delivery"),
      generation: definitionGeneration(1),
      source: source("software", ""),
      input: { service: "payments", releaseChannel: "staging" },
    },
    phases: [
      {
        id: phaseId("phase_build"),
        key: consumerKey("build"),
        generation: definitionGeneration(1),
        parentId: workflowId("workflow_delivery"),
        source: source("software", "/phases/build"),
      },
      {
        id: phaseId("phase_release"),
        key: consumerKey("release"),
        generation: definitionGeneration(1),
        parentId: workflowId("workflow_delivery"),
        dependsOn: [phaseId("phase_build")],
        source: source("software", "/phases/release"),
      },
    ],
    executableWork: [
      {
        id: taskId("task_compile"),
        key: consumerKey("compile"),
        generation: definitionGeneration(1),
        parentId: phaseId("phase_build"),
        source: source("software", "/tasks/compile"),
        input: { target: "application" },
        completionPolicy: emptyCompletionPolicy(),
      },
      {
        id: taskId("task_old-check"),
        key: consumerKey("old-check"),
        generation: definitionGeneration(1),
        parentId: phaseId("phase_build"),
        source: source("software", "/tasks/old-check"),
        completionPolicy: emptyCompletionPolicy(),
      },
      {
        id: taskId("task_test"),
        key: consumerKey("test"),
        generation: definitionGeneration(2),
        parentId: phaseId("phase_build"),
        dependsOn: [taskId("task_compile")],
        supersedes: [taskId("task_old-check")],
        source: source("software", "/tasks/test"),
        input: { environment: { clean: true, shard: 1 }, command: "test" },
        completionPolicy: {
          criteria: [{ criterionId: criterionId("criterion_tests-pass"), required: true }],
          evidencePolicy: { mode: "none", requirements: [] },
        },
      },
      {
        id: taskId("task_publish"),
        key: consumerKey("publish"),
        generation: definitionGeneration(1),
        parentId: phaseId("phase_release"),
        source: source("software", "/tasks/publish"),
        completionPolicy: emptyCompletionPolicy(),
      },
    ],
    criteria: [
      {
        id: criterionId("criterion_tests-pass"),
        key: consumerKey("tests-pass"),
        generation: definitionGeneration(1),
        parentId: taskId("task_test"),
        source: source("software", "/criteria/tests-pass"),
        input: { expected: "passed" },
      },
    ],
  } satisfies NormalizedWorkflowInput;
}

function incidentResponseFixture(): MutableWorkflowInput {
  return {
    workflow: {
      id: workflowId("workflow_incident"),
      key: consumerKey("incident"),
      generation: definitionGeneration(1),
      source: source("incident", ""),
      input: { severity: "major", affectedService: "customer-support" },
    },
    phases: [
      {
        id: phaseId("phase_triage"),
        key: consumerKey("triage"),
        generation: definitionGeneration(1),
        parentId: workflowId("workflow_incident"),
        source: source("incident", "/phases/triage"),
      },
      {
        id: phaseId("phase_mitigate"),
        key: consumerKey("mitigate"),
        generation: definitionGeneration(1),
        parentId: workflowId("workflow_incident"),
        dependsOn: [phaseId("phase_triage")],
        source: source("incident", "/phases/mitigate"),
      },
    ],
    executableWork: [
      {
        id: taskId("task_assess"),
        key: consumerKey("triage"),
        generation: definitionGeneration(1),
        parentId: phaseId("phase_triage"),
        source: source("incident", "/tasks/assess"),
        input: { action: "assess-impact" },
        completionPolicy: emptyCompletionPolicy(),
      },
      {
        id: taskId("task_contain"),
        key: consumerKey("contain"),
        generation: definitionGeneration(1),
        parentId: phaseId("phase_mitigate"),
        dependsOn: [taskId("task_assess")],
        source: source("incident", "/tasks/contain"),
        input: { action: "isolate-failure" },
        completionPolicy: {
          criteria: [{ criterionId: criterionId("criterion_contained"), required: true }],
          evidencePolicy: { mode: "none", requirements: [] },
        },
      },
      {
        id: taskId("task_observe"),
        key: consumerKey("observe"),
        generation: definitionGeneration(2),
        parentId: phaseId("phase_triage"),
        source: source("incident", "/tasks/observe"),
        completionPolicy: emptyCompletionPolicy(),
      },
    ],
    criteria: [
      {
        id: criterionId("criterion_contained"),
        key: consumerKey("contained"),
        generation: definitionGeneration(1),
        parentId: taskId("task_contain"),
        source: source("incident", "/criteria/contained"),
        input: { signal: "impact-stable" },
      },
    ],
  } satisfies NormalizedWorkflowInput;
}

function source(fixture: string, pointer: string) {
  return { locator: `fixture://${fixture}`, pointer };
}

function emptyCompletionPolicy() {
  return { criteria: [], evidencePolicy: { mode: "none" as const, requirements: [] } };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Fixture definition is missing");
  }
  return value;
}

function setBoundaryField(target: object, field: string, value: unknown): void {
  (target as Record<string, unknown>)[field] = value;
}

function expectCompilationError(code: GraphCompilationErrorCode, compile: () => unknown): void {
  try {
    compile();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphCompilationError);
    expect((error as GraphCompilationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected graph compilation to fail with ${code}`);
}

function expectValidationError(validate: () => unknown): void {
  expect(validate).toThrow(GraphValidationError);
}
