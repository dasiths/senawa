import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalValue, type Sha256, sha256Digest } from "./canonical.js";
import {
  createPhaseAttempt,
  createPhaseInputBinding,
  createPhaseOutputAcceptance,
  createPhaseOutputPublication,
  createWorkflowInputBinding,
  DataflowError,
  type DataflowErrorCode,
  evaluateDataMappings,
  validatePhaseAttempt,
  validatePhaseOutputPublication,
  validateWorkflowInputBinding,
  valueAtJsonPointer,
} from "./dataflow.js";
import {
  consumerKey,
  contextId,
  definitionGeneration,
  dispatchId,
  phaseId,
  runId,
  taskId,
} from "./identity.js";

const sha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const DIGEST = sha256Digest("1".repeat(64));
const OTHER_DIGEST = sha256Digest("2".repeat(64));

describe("data mappings", () => {
  it("assembles object destinations deterministically from exact accepted sources", () => {
    const declarations = [
      {
        key: consumerKey("request"),
        source: { kind: "workflow-input" as const, pointer: "/request" },
        destinationPointer: "/definition/request",
      },
      {
        key: consumerKey("research"),
        source: {
          kind: "phase-output" as const,
          phase: consumerKey("research"),
          output: consumerKey("result"),
          pointer: "/findings/0",
        },
        destinationPointer: "/research/first",
      },
    ];
    const bindings = [
      {
        source: { kind: "workflow-input" as const },
        sourceBindingDigest: DIGEST,
        value: canonicalValue({ request: "build", nullable: null }),
      },
      {
        source: {
          kind: "phase-output" as const,
          phase: consumerKey("research"),
          output: consumerKey("result"),
        },
        sourceBindingDigest: OTHER_DIGEST,
        acceptanceDigest: DIGEST,
        value: canonicalValue({ findings: ["one", "two"] }),
      },
    ];
    const policy = {
      dependencyPhases: [consumerKey("research")],
      declaredPhaseOutputs: [{ phase: consumerKey("research"), output: consumerKey("result") }],
      completionEvidenceViews: [],
      allowCurrentItem: false,
    };

    const first = evaluateDataMappings(declarations, bindings, policy, sha256);
    const second = evaluateDataMappings(
      [...declarations].reverse(),
      [...bindings].reverse(),
      policy,
      sha256,
    );

    expect(first).toEqual(second);
    expect(first.value).toEqual({
      definition: { request: "build" },
      research: { first: "one" },
    });
    expect(first.mappings.map(({ mappingKey }) => mappingKey)).toEqual(["request", "research"]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("supports RFC 6901 escaping, arrays, numeric object members, null, and exclusive root copies", () => {
    const source = canonicalValue({ "a/b": { "~key": [null] }, "0": "object-member" });
    expect(valueAtJsonPointer(source, "/a~1b/~0key/0")).toBeNull();
    expect(valueAtJsonPointer(source, "/0")).toBe("object-member");

    const evaluated = evaluateDataMappings(
      [
        {
          key: consumerKey("root"),
          source: { kind: "workflow-input", pointer: "" },
          destinationPointer: "",
        },
      ],
      [{ source: { kind: "workflow-input" }, sourceBindingDigest: DIGEST, value: source }],
      emptyPolicy(),
      sha256,
    );
    expect(evaluated.value).toEqual(source);
  });

  it.each([
    ["mapping-destination-collision", "/a", "/a/b"],
    ["mapping-destination-collision", "", "/a"],
    ["mapping-destination-collision", "/a", "/a"],
  ] as const)("rejects %s for destinations %s and %s", (code, first, second) => {
    expectDataflowError(code, () =>
      evaluateDataMappings(
        [mapping("first", first), mapping("second", second)],
        [workflowBinding()],
        emptyPolicy(),
        sha256,
      ),
    );
  });

  it("rejects malformed, missing, implicit dependency, unaccepted, current-item, and unallowlisted sources", () => {
    expectDataflowError("invalid-json-pointer", () =>
      valueAtJsonPointer(canonicalValue({}), "/bad~2"),
    );
    expectDataflowError("mapping-source-missing", () =>
      valueAtJsonPointer(canonicalValue({ present: null }), "/missing"),
    );

    const outputMapping = {
      key: consumerKey("output"),
      source: {
        kind: "phase-output" as const,
        phase: consumerKey("upstream"),
        output: consumerKey("result"),
        pointer: "",
      },
      destinationPointer: "/result",
    };
    expectDataflowError("phase-dependency-violation", () =>
      evaluateDataMappings([outputMapping], [], emptyPolicy(), sha256),
    );
    expectDataflowError("mapping-source-missing", () =>
      evaluateDataMappings(
        [outputMapping],
        [],
        {
          ...emptyPolicy(),
          dependencyPhases: [consumerKey("upstream")],
          declaredPhaseOutputs: [{ phase: consumerKey("upstream"), output: consumerKey("result") }],
        },
        sha256,
      ),
    );
    expectDataflowError("current-item-not-allowed", () =>
      evaluateDataMappings(
        [{ ...mapping("item", "/item"), source: { kind: "current-item", pointer: "" } }],
        [],
        emptyPolicy(),
        sha256,
      ),
    );
    expectDataflowError("completion-evidence-not-allowed", () =>
      evaluateDataMappings(
        [
          {
            ...mapping("evidence", "/evidence"),
            source: {
              kind: "completion-evidence",
              phase: consumerKey("implement"),
              view: consumerKey("accepted"),
              pointer: "",
            },
          },
        ],
        [],
        { ...emptyPolicy(), dependencyPhases: [consumerKey("implement")] },
        sha256,
      ),
    );
  });
});

describe("dataflow records", () => {
  it("creates exact workflow input, phase input, and append-only attempt records", () => {
    const workflowInput = createWorkflowInputBinding(
      {
        repositoryId: "repository",
        runId: runId("run_example"),
        workflowId: "workflow_example",
        graphRevisionDigest: DIGEST,
        configurationSnapshotDigest: OTHER_DIGEST,
        schemaKey: consumerKey("request"),
        schemaResourceDigest: DIGEST,
        contentDigest: OTHER_DIGEST,
        byteLength: 17,
        validationReceiptDigest: DIGEST,
      },
      sha256,
    );
    expect(validateWorkflowInputBinding(workflowInput, sha256)).toEqual(workflowInput);

    const evaluated = evaluateDataMappings(
      [mapping("request", "/request")],
      [workflowBinding()],
      emptyPolicy(),
      sha256,
    );
    const phase = {
      phaseId: phaseId("phase_define"),
      definitionGeneration: definitionGeneration(1),
      attempt: 1,
    };
    const input = createPhaseInputBinding(
      {
        phase,
        schemaKey: consumerKey("define-input"),
        schemaResourceDigest: DIGEST,
        mappings: evaluated.mappings,
        contentDigest: evaluated.contentDigest,
        byteLength: 19,
        validationReceiptDigest: OTHER_DIGEST,
        sourceSetDigest: evaluated.sourceSetDigest,
      },
      sha256,
    );
    const attempt = createPhaseAttempt(
      {
        repositoryId: "repository",
        runId: runId("run_example"),
        phase,
        inputBindingDigest: input.bindingDigest,
        sourceSetDigest: input.sourceSetDigest,
        executorDigest: DIGEST,
        graphRevisionDigest: OTHER_DIGEST,
        configurationSnapshotDigest: DIGEST,
        upstreamClosureSetDigest: OTHER_DIGEST,
        upstreamOutputSetDigest: DIGEST,
      },
      sha256,
    );
    expect(validatePhaseAttempt(attempt, sha256)).toEqual(attempt);
    expect(attempt.phase.attempt).toBe(1);
    expect(Object.isFrozen(attempt)).toBe(true);
    expectDataflowError("invalid-dataflow-record", () =>
      createPhaseAttempt(
        { ...attempt, phase: { ...phase, attempt: Number.POSITIVE_INFINITY } },
        sha256,
      ),
    );
    expectDataflowError("invalid-dataflow-record", () =>
      validatePhaseAttempt({ ...attempt, executorDigest: OTHER_DIGEST }, sha256),
    );
  });

  it("binds publications to exact producer, context, attempt, schema, input, graph, and snapshot", () => {
    const publication = createPhaseOutputPublication(publicationInput(), sha256);
    expect(validatePhaseOutputPublication(publication, sha256)).toEqual(publication);
    expect(publication.publicationId).toBe(`publication_${publication.publicationDigest}`);
    expect(publication.publicationDigest).toBe(
      canonicalDigest(
        canonicalValue(
          (({ publicationId: _id, publicationDigest: _digest, ...value }) => value)(publication),
        ),
        sha256,
      ),
    );
    expectDataflowError("invalid-dataflow-record", () =>
      validatePhaseOutputPublication({ ...publication, contextDigest: DIGEST }, sha256),
    );

    const acceptance = createPhaseOutputAcceptance(
      { publication, candidateDigest: DIGEST, closureDigest: OTHER_DIGEST },
      sha256,
    );
    expect(acceptance).toMatchObject({
      publicationId: publication.publicationId,
      publicationDigest: publication.publicationDigest,
      candidateDigest: DIGEST,
      closureDigest: OTHER_DIGEST,
    });
    expect(Object.isFrozen(acceptance)).toBe(true);
  });
});

function mapping(key: string, destinationPointer: string) {
  return {
    key: consumerKey(key),
    source: { kind: "workflow-input" as const, pointer: "/request" },
    destinationPointer,
  };
}

function workflowBinding() {
  return {
    source: { kind: "workflow-input" as const },
    sourceBindingDigest: DIGEST,
    value: canonicalValue({ request: "build" }),
  };
}

function emptyPolicy() {
  return {
    dependencyPhases: [],
    declaredPhaseOutputs: [],
    completionEvidenceViews: [],
    allowCurrentItem: false,
  };
}

function publicationInput() {
  return {
    repositoryId: "repository",
    runId: runId("run_example"),
    phase: {
      phaseId: phaseId("phase_define"),
      definitionGeneration: definitionGeneration(1),
      attempt: 1,
    },
    outputName: consumerKey("definition"),
    schemaKey: consumerKey("definition-output"),
    schemaResourceDigest: DIGEST,
    contentDigest: OTHER_DIGEST,
    byteLength: 42,
    mediaType: "application/json" as const,
    producingTask: {
      taskId: taskId("task_executor"),
      definitionGeneration: definitionGeneration(1),
      contextRevisionDigest: DIGEST,
    },
    dispatchId: dispatchId("dispatch_executor"),
    contextId: contextId("context_executor"),
    contextDigest: OTHER_DIGEST,
    graphRevisionDigest: DIGEST,
    configurationSnapshotDigest: OTHER_DIGEST,
    inputBindingDigest: DIGEST,
    validationReceiptDigest: OTHER_DIGEST,
  };
}

function expectDataflowError(code: DataflowErrorCode, action: () => unknown): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DataflowError);
    expect((error as DataflowError).code).toBe(code);
  }
}
