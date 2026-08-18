import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalValue, type Sha256, sha256Digest } from "./canonical.js";
import {
  ContextError,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  resumeWorkerDispatch,
  taskGenerationReferenceForContext,
  validateTaskDependencyBarrier,
  validateWorkerContextBase,
  validateWorkerDispatch,
  validateWorkerModelRouteSelection,
  type WorkerContextBaseInput,
  type WorkerDispatchInput,
  workerSessionIdentity,
} from "./context.js";
import { createPhaseAttempt, createPhaseInputBinding } from "./dataflow.js";
import { assetId, consumerKey, definitionGeneration, phaseId, runId, taskId } from "./identity.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const digest = (character: string) => sha256Digest(character.repeat(64));

describe("worker context bases", () => {
  it("canonicalizes equivalent set-like inputs to the same context and task reference", () => {
    const firstInput = contextInput("software");
    const secondInput = contextInput("software");
    secondInput.contracts.reverse();
    secondInput.dependencyBarrier.dependencies.reverse();
    secondInput.assets.reverse();
    secondInput.capabilities.reverse();
    secondInput.budgets.reverse();

    const first = createWorkerContextBase(firstInput, deterministicSha256);
    const second = createWorkerContextBase(secondInput, deterministicSha256);

    expect(second).toEqual(first);
    expect(second.contextDigest).toBe(first.contextDigest);
    expect(second.contextId).toBe(first.contextId);
    expect(taskGenerationReferenceForContext(first, deterministicSha256)).toEqual({
      taskId: first.task.taskId,
      definitionGeneration: first.task.definitionGeneration,
      contextRevisionDigest: first.contextDigest,
    });
    expect(validateWorkerContextBase(first, deterministicSha256)).toEqual(first);
  });

  it.each([
    [
      "contracts",
      (input: MutableContextInput) => {
        required(input.contracts[0]).contractDigest = digest("3");
      },
    ],
    [
      "dependencies",
      (input: MutableContextInput) => {
        required(input.dependencyBarrier.dependencies[0]).assessmentDigest = digest("4");
      },
    ],
    [
      "assets",
      (input: MutableContextInput) => {
        required(input.assets[0]).contentDigest = digest("5");
      },
    ],
    [
      "repository base",
      (input: MutableContextInput) => {
        input.repositoryBase.treeDigest = digest("6");
      },
    ],
    [
      "model policy",
      (input: MutableContextInput) => {
        input.modelPolicy.policyDigest = digest("7");
      },
    ],
    [
      "ordered model routes reference",
      (input: MutableContextInput) => {
        input.modelPolicy.orderedRoutesDigest = digest("8");
      },
    ],
    [
      "role",
      (input: MutableContextInput) => {
        input.role.roleDigest = digest("9");
      },
    ],
    [
      "prompt bytes",
      (input: MutableContextInput) => {
        input.prompt = promptFixture("Changed ${{ input.request }}\n");
      },
    ],
    [
      "mapped input",
      (input: MutableContextInput) => {
        input.mappedInput = mappedInputFixture({ request: "changed" });
      },
    ],
    ["capabilities", (input: MutableContextInput) => input.capabilities.push("asset.annotate")],
    [
      "budgets",
      (input: MutableContextInput) => {
        required(input.budgets[0]).limit += 1;
      },
    ],
  ] as const)("changes the context digest when %s changes", (_name, mutate) => {
    const baseline = createWorkerContextBase(contextInput("software"), deterministicSha256);
    const changedInput = contextInput("software");
    mutate(changedInput);
    const changed = createWorkerContextBase(changedInput, deterministicSha256);

    expect(changed.contextDigest).not.toBe(baseline.contextDigest);
    expect(changed.contextId).not.toBe(baseline.contextId);
  });

  it.each(["graphRevisionDigest", "configurationSnapshotDigest"] as const)(
    "rejects a stale %s that no longer matches the phase attempt",
    (field) => {
      const input = contextInput("software");
      input[field] = digest("e");
      expect(() => createWorkerContextBase(input, deterministicSha256)).toThrowError(
        expect.objectContaining({ code: "context-mismatch" }),
      );
    },
  );

  it("isolates caller mutation and recursively freezes the accepted context", () => {
    const input = contextInput("software");
    const context = createWorkerContextBase(input, deterministicSha256);
    required(input.contracts[0]).contractDigest = digest("9");
    required(input.dependencyBarrier.dependencies[0]).authorityFact.result = "changed";
    required(input.assets[0]).mediaType = "application/octet-stream";
    input.capabilities.push("asset.annotate");
    required(input.budgets[0]).limit = 999;

    expect(context.contracts[0]?.contractDigest).not.toBe(digest("9"));
    expect(context.dependencyBarrier.dependencies[0]?.authorityFact).toEqual({
      result: "accepted",
    });
    expect(context.assets[0]?.mediaType).toBe("application/json");
    expect(context.capabilities).not.toContain("asset.annotate");
    expect(context.budgets[0]?.limit).not.toBe(999);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.dependencyBarrier.dependencies[0]?.authorityFact)).toBe(true);
    expect(Object.isFrozen(context.assets)).toBe(true);
  });

  it.each([
    [
      "contract",
      (input: MutableContextInput) => input.contracts.push({ ...required(input.contracts[0]) }),
    ],
    [
      "dependency",
      (input: MutableContextInput) =>
        input.dependencyBarrier.dependencies.push({
          ...required(input.dependencyBarrier.dependencies[0]),
        }),
    ],
    ["asset", (input: MutableContextInput) => input.assets.push({ ...required(input.assets[0]) })],
    [
      "capability",
      (input: MutableContextInput) => input.capabilities.push(required(input.capabilities[0])),
    ],
    [
      "budget",
      (input: MutableContextInput) => input.budgets.push({ ...required(input.budgets[0]) }),
    ],
  ] as const)("rejects a duplicate %s", (_name, duplicate) => {
    const input = contextInput("software");
    duplicate(input);
    expect(() => createWorkerContextBase(input, deterministicSha256)).toThrow(ContextError);
  });

  it("rejects forged, extra, sparse, accessor, and invalid identity boundaries", () => {
    const context = createWorkerContextBase(contextInput("software"), deterministicSha256);
    expect(() =>
      validateWorkerContextBase({ ...context, contextDigest: digest("f") }, deterministicSha256),
    ).toThrow(ContextError);
    expect(() =>
      validateWorkerContextBase({ ...context, approvalAuthority: true }, deterministicSha256),
    ).toThrow(ContextError);

    const sparse = contextInput("software");
    sparse.assets = Array(1) as MutableContextInput["assets"];
    expect(() => createWorkerContextBase(sparse, deterministicSha256)).toThrow(ContextError);

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "task", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return context.task;
      },
    });
    expect(() =>
      createWorkerContextBase(accessor as WorkerContextBaseInput, deterministicSha256),
    ).toThrow(ContextError);
    expect(getterCalls).toBe(0);

    const invalidIdentity = contextInput("software");
    invalidIdentity.task.taskId = "task_INVALID" as ReturnType<typeof taskId>;
    expect(() => createWorkerContextBase(invalidIdentity, deterministicSha256)).toThrow(
      ContextError,
    );
  });

  it.each(["software", "non-software"] as const)("supports a %s context fixture", (kind) => {
    const context = createWorkerContextBase(contextInput(kind), deterministicSha256);

    expect(context.assets).toHaveLength(2);
    expect(context.dependencyBarrier.dependencies).toHaveLength(2);
    expect(validateTaskDependencyBarrier(context.dependencyBarrier, deterministicSha256)).toEqual(
      context.dependencyBarrier,
    );
  });
});

describe("worker model route selections", () => {
  it("binds an exact policy route and independent ceilings to the dispatch", () => {
    const context = createWorkerContextBase(contextInput("software"), deterministicSha256);
    const dispatch = createWorkerDispatch(dispatchInput(), context, deterministicSha256);
    const selection = createWorkerModelRouteSelection(
      routeSelectionInput(),
      context,
      dispatch,
      deterministicSha256,
    );

    expect(selection).toMatchObject({
      dispatchId: dispatch.dispatchId,
      contextId: context.contextId,
      contextDigest: context.contextDigest,
      modelPolicy: {
        ...context.modelPolicy,
        routeIndex: 0,
        provider: "github-copilot",
        model: "gpt-5-mini",
      },
      limits: {
        maxTurns: 4,
        maxSubmissions: 3,
        maxMillidollars: 2_000,
        maxAiCredits: 1.25,
      },
    });
    expect(
      validateWorkerModelRouteSelection(selection, context, dispatch, deterministicSha256),
    ).toEqual(selection);
  });

  it.each([
    [
      "dispatch",
      (value: MutableRouteSelection) => {
        value.dispatchId = "dispatch_forged";
      },
    ],
    [
      "context",
      (value: MutableRouteSelection) => {
        value.contextDigest = digest("e");
      },
    ],
    [
      "policy",
      (value: MutableRouteSelection) => {
        value.modelPolicy.policyDigest = digest("e");
      },
    ],
    [
      "route",
      (value: MutableRouteSelection) => {
        value.modelPolicy.routeIndex += 1;
      },
    ],
    [
      "provider",
      (value: MutableRouteSelection) => {
        value.modelPolicy.provider = "other";
      },
    ],
    [
      "model",
      (value: MutableRouteSelection) => {
        value.modelPolicy.model = "other";
      },
    ],
    [
      "turns",
      (value: MutableRouteSelection) => {
        value.limits.maxTurns += 1;
      },
    ],
    [
      "submissions",
      (value: MutableRouteSelection) => {
        value.limits.maxSubmissions += 1;
      },
    ],
    [
      "millidollars",
      (value: MutableRouteSelection) => {
        value.limits.maxMillidollars += 1;
      },
    ],
    [
      "AI credits",
      (value: MutableRouteSelection) => {
        value.limits.maxAiCredits += 1;
      },
    ],
    [
      "digest",
      (value: MutableRouteSelection) => {
        value.selectionDigest = digest("e");
      },
    ],
  ] as const)("rejects a forged %s binding", (_name, mutate) => {
    const context = createWorkerContextBase(contextInput("software"), deterministicSha256);
    const dispatch = createWorkerDispatch(dispatchInput(), context, deterministicSha256);
    const selection = structuredClone(
      createWorkerModelRouteSelection(
        routeSelectionInput(),
        context,
        dispatch,
        deterministicSha256,
      ),
    ) as MutableRouteSelection;
    mutate(selection);

    expect(() =>
      validateWorkerModelRouteSelection(selection, context, dispatch, deterministicSha256),
    ).toThrow(ContextError);
  });

  it.each([
    { ...routeSelectionInput(), routeIndex: -1 },
    { ...routeSelectionInput(), provider: "auto" },
    { ...routeSelectionInput(), model: "auto" },
    { ...routeSelectionInput(), maxTurns: 0 },
    { ...routeSelectionInput(), maxSubmissions: 0 },
    { ...routeSelectionInput(), maxMillidollars: 0 },
    { ...routeSelectionInput(), maxAiCredits: 0 },
    { ...routeSelectionInput(), maxAiCredits: 1e-20 },
    { ...routeSelectionInput(), maxAiCredits: Number.POSITIVE_INFINITY },
  ])("rejects invalid route input %#", (input) => {
    const context = createWorkerContextBase(contextInput("software"), deterministicSha256);
    const dispatch = createWorkerDispatch(dispatchInput(), context, deterministicSha256);
    expect(() =>
      createWorkerModelRouteSelection(input, context, dispatch, deterministicSha256),
    ).toThrow(ContextError);
  });
});

describe("worker dispatches", () => {
  it("rejects capability widening and any extra authority field", () => {
    const context = createWorkerContextBase(contextInput("software"), deterministicSha256);
    const widening = dispatchInput();
    widening.capabilities.push("graph.mutate");
    expect(() => createWorkerDispatch(widening, context, deterministicSha256)).toThrowError(
      expect.objectContaining({ code: "capability-widening" }),
    );

    expect(() =>
      createWorkerDispatch(
        { ...dispatchInput(), approvalAuthority: true } as WorkerDispatchInput,
        context,
        deterministicSha256,
      ),
    ).toThrow(ContextError);
  });

  it("keeps resume identity stable for unchanged context and changes it with context", () => {
    const firstContext = createWorkerContextBase(contextInput("software"), deterministicSha256);
    const first = createWorkerDispatch(dispatchInput(), firstContext, deterministicSha256);
    const resumed = resumeWorkerDispatch(dispatchInput(), firstContext, deterministicSha256);
    const changedInput = contextInput("software");
    changedInput.role = { ...changedInput.role, roleDigest: digest("e") };
    const changedContext = createWorkerContextBase(changedInput, deterministicSha256);
    const changed = resumeWorkerDispatch(dispatchInput(), changedContext, deterministicSha256);

    expect(resumed).toEqual(first);
    expect(workerSessionIdentity(resumed, firstContext, deterministicSha256)).toBe(
      first.dispatchId,
    );
    expect(changed.dispatchId).not.toBe(first.dispatchId);
    expect(changed.task.contextRevisionDigest).toBe(changedContext.contextDigest);
  });

  it("recompiles exact dispatches and rejects forged identity or context bindings", () => {
    const context = createWorkerContextBase(contextInput("software"), deterministicSha256);
    const dispatch = createWorkerDispatch(dispatchInput(), context, deterministicSha256);

    expect(validateWorkerDispatch(dispatch, context, deterministicSha256)).toEqual(dispatch);
    expect(() =>
      validateWorkerDispatch(
        { ...dispatch, dispatchId: "dispatch_fabricated" },
        context,
        deterministicSha256,
      ),
    ).toThrow(ContextError);

    const changedInput = contextInput("software");
    changedInput.role = { ...changedInput.role, roleDigest: digest("e") };
    const changedContext = createWorkerContextBase(changedInput, deterministicSha256);
    expect(() => validateWorkerDispatch(dispatch, changedContext, deterministicSha256)).toThrow(
      ContextError,
    );
  });
});

type MutableContextInput = ReturnType<typeof contextInput>;

function contextInput(kind: "software" | "non-software") {
  const task = {
    taskId: taskId(kind === "software" ? "task_implement" : "task_curate-exhibit"),
    definitionGeneration: definitionGeneration(2),
  };
  const graphRevisionDigest = digest("a");
  const configurationSnapshotDigest = digest("b");
  const mappedInput = mappedInputFixture({ request: kind });
  const phase = {
    phaseId: phaseId("phase_delivery"),
    definitionGeneration: definitionGeneration(1),
    attempt: 1,
  };
  const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: [] }), deterministicSha256);
  const phaseInputBinding = createPhaseInputBinding(
    {
      phase,
      schemaKey: consumerKey("phase-input"),
      schemaResourceDigest: digest("e"),
      mappings: [],
      contentDigest: mappedInput.valueDigest,
      byteLength: 22,
      validationReceiptDigest: digest("f"),
      sourceSetDigest,
    },
    deterministicSha256,
  );
  const phaseAttempt = createPhaseAttempt(
    {
      repositoryId: "repository_fixture",
      runId: runId("run_fixture"),
      phase,
      inputBindingDigest: phaseInputBinding.bindingDigest,
      sourceSetDigest,
      executorDigest: digest("0"),
      graphRevisionDigest,
      configurationSnapshotDigest,
      upstreamClosureSetDigest: digest("1"),
      upstreamOutputSetDigest: digest("2"),
    },
    deterministicSha256,
  );
  return {
    task,
    graphRevisionDigest,
    configurationSnapshotDigest,
    contracts: [
      {
        kind: "task-definition" as const,
        key: consumerKey("primary-task"),
        contractDigest: digest("c"),
      },
      {
        kind: "completion-policy" as const,
        key: consumerKey("completion"),
        contractDigest: digest("d"),
      },
    ],
    dependencyBarrier: {
      task: { ...task },
      dependencies: [
        {
          task: {
            taskId: taskId("task_research"),
            definitionGeneration: definitionGeneration(1),
            contextRevisionDigest: digest("1"),
          },
          disposition: "completed" as const,
          assessmentDigest: digest("2"),
          authorityFact: { result: "accepted" },
        },
        {
          task: {
            taskId: taskId("task_source-material"),
            definitionGeneration: definitionGeneration(3),
            contextRevisionDigest: digest("3"),
          },
          disposition: "waived" as const,
          assessmentDigest: digest("4"),
          authorityFact: { decisionDigest: digest("5"), reason: "curator-approved" },
        },
      ],
    },
    assets: [
      {
        semanticAssetId: assetId("asset_primary-input"),
        aliasBindingDigest: digest("6"),
        contentDigest: digest("7"),
        mediaType: kind === "software" ? "application/json" : "text/csv",
        sensitivity: "internal" as const,
        byteLength: 128,
      },
      {
        semanticAssetId: assetId("asset_reference"),
        aliasBindingDigest: digest("8"),
        contentDigest: digest("9"),
        mediaType: kind === "software" ? "text/markdown" : "image/png",
        sensitivity: "public" as const,
        byteLength: 4096,
      },
    ],
    repositoryBase: { commitDigest: digest("0"), treeDigest: digest("a") },
    modelPolicy: {
      key: consumerKey("worker-policy"),
      policyDigest: digest("b"),
      orderedRoutesDigest: digest("c"),
    },
    role: { key: consumerKey("implementer"), roleDigest: digest("d") },
    prompt: promptFixture(),
    mappedInput,
    phaseAttempt,
    phaseInputBinding,
    phaseOutputDeclarations: [],
    capabilities: ["asset.read", "completion.submit"],
    budgets: [{ unit: "work-attempt" as const, limit: 3 }],
  };
}

function dispatchInput() {
  return {
    repositoryId: "repository_fixture",
    runId: runId("run_fixture"),
    ordinal: 1,
    workerPrincipalId: "principal_worker-1",
    roleKey: consumerKey("implementer"),
    capabilities: ["completion.submit"],
    promptResource: {
      key: promptFixture().key,
      resourceDigest: promptFixture().resourceDigest,
      contentDigest: promptFixture().contentDigest,
    },
    promptPackDigest: digest("f"),
  };
}

function promptFixture(utf8 = "Work on ${{ input.request }}\n") {
  const key = consumerKey("implementer-prompt");
  const path = "prompts/implementer.md";
  const inputPaths = ["/request"];
  const bytes = new TextEncoder().encode(utf8);
  const contentDigest = sha256Digest(deterministicSha256.digest(bytes));
  const source = {
    path,
    mediaType: "text/markdown; charset=utf-8",
    byteLength: bytes.byteLength,
    contentDigest,
    utf8,
  };
  return {
    key,
    path,
    resourceDigest: canonicalDigest(
      canonicalValue({ key, source, inputPaths }),
      deterministicSha256,
    ),
    contentDigest,
    byteLength: bytes.byteLength,
    utf8,
    inputPaths,
  };
}

function mappedInputFixture(value: unknown) {
  const canonical = canonicalValue(value);
  return { value: canonical, valueDigest: canonicalDigest(canonical, deterministicSha256) };
}

function routeSelectionInput() {
  return {
    routeIndex: 0,
    provider: "github-copilot",
    model: "gpt-5-mini",
    maxTurns: 4,
    maxSubmissions: 3,
    maxMillidollars: 2_000,
    maxAiCredits: 1.25,
  };
}

interface MutableRouteSelection {
  dispatchId: string;
  contextDigest: string;
  selectionDigest: string;
  modelPolicy: {
    policyDigest: string;
    routeIndex: number;
    provider: string;
    model: string;
  };
  limits: {
    maxTurns: number;
    maxSubmissions: number;
    maxMillidollars: number;
    maxAiCredits: number;
  };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
