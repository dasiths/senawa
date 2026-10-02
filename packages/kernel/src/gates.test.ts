import { describe, expect, it } from "vitest";
import {
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  type Sha256,
  sha256Digest,
} from "./canonical.js";
import {
  type ConditionInput,
  createSensorReading,
  DEFAULT_GATE_EVALUATION_LIMITS,
  defineGate,
  evaluateGate,
  GateError,
  type GateErrorCode,
  type GateEvidence,
  type GateRuleInput,
  type SensorReading,
  type TruthValue,
  validateGateDefinition,
  validateGateEvidence,
  validateSensorReading,
} from "./gates.js";
import { consumerKey } from "./identity.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const INPUT_DIGEST = sha256Digest("a".repeat(64));
const OTHER_INPUT_DIGEST = sha256Digest("b".repeat(64));
const METRICS_KEY = consumerKey("metrics");
const FAILED_KEY = consumerKey("failed-sensor");

describe("sensor readings", () => {
  it("creates immutable content-addressed success and failure facts", () => {
    const data = { nested: { count: 5 }, values: [true, null] };
    const error = { code: "process-failed", exitCode: 2 };
    const succeeded = createSensorReading(
      { sensorKey: METRICS_KEY, inputDigest: INPUT_DIGEST, outcome: "succeeded", data },
      deterministicSha256,
    );
    const failed = createSensorReading(
      { sensorKey: FAILED_KEY, inputDigest: INPUT_DIGEST, outcome: "failed", error },
      deterministicSha256,
    );
    data.nested.count = 99;
    error.exitCode = 0;

    expect(succeeded).toMatchObject({ outcome: "succeeded", data: { nested: { count: 5 } } });
    expect(failed).toMatchObject({ outcome: "failed", error: { exitCode: 2 } });
    expect(Object.isFrozen(succeeded)).toBe(true);
    if (succeeded.outcome !== "succeeded") throw new Error("Expected a successful reading");
    expect(Object.isFrozen(succeeded.data)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
  });

  // A gate evaluates once per candidate and a candidate is phase-shaped, so a
  // reading could only ever be about the phase's work. A member's gate needs a
  // reading addressed to that member, inside the one evaluation.
  it("lets a reading name the task it read, without moving a phase-scoped one", () => {
    const phaseScoped = createSensorReading(
      { sensorKey: METRICS_KEY, inputDigest: INPUT_DIGEST, outcome: "succeeded", data: { ok: 1 } },
      deterministicSha256,
    );
    const memberScoped = createSensorReading(
      {
        sensorKey: METRICS_KEY,
        inputDigest: INPUT_DIGEST,
        outcome: "succeeded",
        data: { ok: 1 },
        taskId: "task_alpha",
      },
      deterministicSha256,
    );

    expect(memberScoped.taskId).toBe("task_alpha");
    expect(validateSensorReading(memberScoped, deterministicSha256)).toEqual(memberScoped);

    // Two members read separately are two readings of the same sensor.
    const sibling = createSensorReading(
      {
        sensorKey: METRICS_KEY,
        inputDigest: INPUT_DIGEST,
        outcome: "succeeded",
        data: { ok: 1 },
        taskId: "task_beta",
      },
      deterministicSha256,
    );
    expect(sibling.readingDigest).not.toBe(memberScoped.readingDigest);

    // A reading that names no task is what it always was, so nothing recorded
    // moves.
    expect(phaseScoped).not.toHaveProperty("taskId");
    expect(phaseScoped.readingDigest).not.toBe(memberScoped.readingDigest);

    expect(() =>
      createSensorReading(
        {
          sensorKey: METRICS_KEY,
          inputDigest: INPUT_DIGEST,
          outcome: "succeeded",
          data: { ok: 1 },
          taskId: "",
        } as never,
        deterministicSha256,
      ),
    ).toThrow(/task identities/u);
  });

  it("is deterministic across property order", () => {
    const first = createSensorReading(
      {
        sensorKey: METRICS_KEY,
        inputDigest: INPUT_DIGEST,
        outcome: "succeeded",
        data: { zeta: 2, nested: { beta: true, alpha: "fixed" } },
      },
      deterministicSha256,
    );
    const second = createSensorReading(
      {
        outcome: "succeeded",
        data: { nested: { alpha: "fixed", beta: true }, zeta: 2 },
        inputDigest: INPUT_DIGEST,
        sensorKey: METRICS_KEY,
      },
      deterministicSha256,
    );
    expect(first.readingDigest).toBe(second.readingDigest);
    expect(canonicalSerialize(first.data)).toBe(canonicalSerialize(second.data));
  });

  it("rejects exact-schema additions, sparse data, and accessors without invoking them", () => {
    expectGateError("invalid-reading", () =>
      createSensorReading(
        {
          sensorKey: METRICS_KEY,
          inputDigest: INPUT_DIGEST,
          outcome: "succeeded",
          data: null,
          authority: true,
        } as never,
        deterministicSha256,
      ),
    );
    expectGateError("invalid-reading", () =>
      createSensorReading(
        {
          sensorKey: METRICS_KEY,
          inputDigest: INPUT_DIGEST,
          outcome: "succeeded",
          data: Array(1),
        },
        deterministicSha256,
      ),
    );
    let getterCalls = 0;
    const reading = Object.assign(
      Object.defineProperty({}, "data", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return null;
        },
      }),
      { sensorKey: METRICS_KEY, inputDigest: INPUT_DIGEST, outcome: "succeeded" },
    );
    expectGateError("invalid-reading", () =>
      createSensorReading(reading as never, deterministicSha256),
    );
    expect(getterCalls).toBe(0);
  });
});

describe("three-valued conditions", () => {
  const leaves: Record<TruthValue, ConditionInput> = {
    true: equals("/truth", true),
    false: equals("/truth", false),
    unknown: equals("/missing", true),
  };

  it.each([
    ["true", "true", "true"],
    ["true", "false", "false"],
    ["true", "unknown", "unknown"],
    ["false", "true", "false"],
    ["false", "false", "false"],
    ["false", "unknown", "false"],
    ["unknown", "true", "unknown"],
    ["unknown", "false", "false"],
    ["unknown", "unknown", "unknown"],
  ] as const)("all(%s, %s) is %s", (left, right, expected) => {
    expect(evaluateSingle({ operator: "all", conditions: [leaves[left], leaves[right]] })).toBe(
      expected,
    );
  });

  it.each([
    ["true", "true", "true"],
    ["true", "false", "true"],
    ["true", "unknown", "true"],
    ["false", "true", "true"],
    ["false", "false", "false"],
    ["false", "unknown", "unknown"],
    ["unknown", "true", "true"],
    ["unknown", "false", "unknown"],
    ["unknown", "unknown", "unknown"],
  ] as const)("any(%s, %s) is %s", (left, right, expected) => {
    expect(evaluateSingle({ operator: "any", conditions: [leaves[left], leaves[right]] })).toBe(
      expected,
    );
  });

  it.each([
    ["true", "false"],
    ["false", "true"],
    ["unknown", "unknown"],
  ] as const)("not(%s) is %s", (input, expected) => {
    expect(evaluateSingle({ operator: "not", condition: leaves[input] })).toBe(expected);
  });

  it("uses empty all and any identities", () => {
    expect(evaluateSingle({ operator: "all", conditions: [] })).toBe("true");
    expect(evaluateSingle({ operator: "any", conditions: [] })).toBe("false");
  });

  it("evaluates exists, equality, inequality, and every number comparison", () => {
    const trueConditions: ConditionInput[] = [
      { operator: "exists", accessor: accessor("/nullValue") },
      { operator: "equals", accessor: accessor("/nested"), expected: { b: 2, a: 1 } },
      { operator: "not-equals", accessor: accessor("/count"), expected: 6 },
      { operator: "greater-than", accessor: accessor("/count"), expected: 4 },
      { operator: "greater-than-or-equal", accessor: accessor("/count"), expected: 5 },
      { operator: "less-than", accessor: accessor("/count"), expected: 6 },
      { operator: "less-than-or-equal", accessor: accessor("/count"), expected: 5 },
    ];
    for (const condition of trueConditions) expect(evaluateSingle(condition)).toBe("true");
    expect(evaluateSingle({ operator: "exists", accessor: accessor("/absent") })).toBe("false");
    expect(
      evaluateSingle({ operator: "greater-than", accessor: accessor("/text"), expected: 4 }),
    ).toBe("unknown");
  });

  it("resolves root, escaped object keys, and bounded array indices", () => {
    expect(evaluateSingle({ operator: "exists", accessor: accessor("") })).toBe("true");
    expect(evaluateSingle(equals("/a~1b/~0key", 7))).toBe("true");
    expect(evaluateSingle(equals("/items/0", "first"))).toBe("true");
    expect(evaluateSingle({ operator: "exists", accessor: accessor("/items/01") })).toBe("false");
    expect(evaluateSingle({ operator: "exists", accessor: accessor("/items/-") })).toBe("false");
  });

  it("propagates missing and failed readings as unknown", () => {
    const definition = gate([
      rule("missing", equals("/truth", true, consumerKey("not-supplied"))),
      rule("failed", equals("/truth", true, FAILED_KEY)),
    ]);
    const evaluation = evaluateGate(
      definition,
      [metricsReading(), failedReading()],
      INPUT_DIGEST,
      deterministicSha256,
    );
    expect(evaluation.blocking.map((item) => item.result)).toEqual(["unknown", "unknown"]);
    expect(evaluation.decision).toBe("rejected");
  });
});

describe("gate policy and evaluation", () => {
  it("fails closed for blocking false and unknown but records nonblocking advisory results", () => {
    const blockingFalse = evaluateGate(
      gate([rule("must-pass", equals("/truth", false))]),
      [metricsReading()],
      INPUT_DIGEST,
      deterministicSha256,
    );
    const blockingUnknown = evaluateGate(
      gate([rule("must-exist", equals("/missing", true))]),
      [metricsReading()],
      INPUT_DIGEST,
      deterministicSha256,
    );
    const advisoryFalse = evaluateGate(
      gate([], [rule("quality-note", equals("/truth", false))]),
      [metricsReading()],
      INPUT_DIGEST,
      deterministicSha256,
    );
    expect(blockingFalse.decision).toBe("rejected");
    expect(blockingUnknown.decision).toBe("rejected");
    expect(advisoryFalse).toMatchObject({
      decision: "accepted",
      advisory: [{ key: consumerKey("quality-note"), result: "false" }],
    });
  });

  it("binds immutable evaluations to exact input, policy, and reading digests", () => {
    const definition = gate([rule("must-pass", equals("/truth", true))]);
    const reading = metricsReading();
    const evaluation = evaluateGate(definition, [reading], INPUT_DIGEST, deterministicSha256);
    expect(evaluation).toMatchObject({
      candidateInputDigest: INPUT_DIGEST,
      policyDigest: definition.policyDigest,
      readingDigests: [reading.readingDigest],
      decision: "accepted",
    });
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(Object.isFrozen(evaluation.blocking)).toBe(true);
  });

  it("is deterministic across property and reading order", () => {
    const firstPolicy = gate([rule("must-pass", equals("/truth", true))]);
    const secondPolicy = defineGate(
      {
        advisory: [],
        blocking: [
          {
            condition: {
              expected: true,
              accessor: { pointer: "/truth", sensorKey: METRICS_KEY },
              operator: "equals",
            },
            key: consumerKey("must-pass"),
          },
        ],
        key: consumerKey("quality"),
      },
      deterministicSha256,
    );
    const metrics = metricsReading();
    const failed = failedReading();
    const first = evaluateGate(firstPolicy, [metrics, failed], INPUT_DIGEST, deterministicSha256);
    const second = evaluateGate(secondPolicy, [failed, metrics], INPUT_DIGEST, deterministicSha256);
    expect(firstPolicy.policyDigest).toBe(secondPolicy.policyDigest);
    expect(first.evaluationDigest).toBe(second.evaluationDigest);
    expect(first).toEqual(second);
  });

  it("rejects stale, duplicate, and digest-forged readings and policies", () => {
    const definition = gate([rule("must-pass", equals("/truth", true))]);
    const reading = metricsReading();
    const stale = createSensorReading(
      {
        sensorKey: METRICS_KEY,
        inputDigest: OTHER_INPUT_DIGEST,
        outcome: "succeeded",
        data: { truth: true },
      },
      deterministicSha256,
    );
    expectGateError("reading-input-mismatch", () =>
      evaluateGate(definition, [stale], INPUT_DIGEST, deterministicSha256),
    );
    expectGateError("duplicate-reading", () =>
      evaluateGate(definition, [reading, reading], INPUT_DIGEST, deterministicSha256),
    );
    expectGateError("invalid-reading", () =>
      evaluateGate(
        definition,
        [{ ...reading, readingDigest: sha256Digest("c".repeat(64)) }],
        INPUT_DIGEST,
        deterministicSha256,
      ),
    );
    expectGateError("invalid-policy", () =>
      evaluateGate(
        { ...definition, policyDigest: sha256Digest("d".repeat(64)) },
        [reading],
        INPUT_DIGEST,
        deterministicSha256,
      ),
    );
  });

  it("rejects malformed ASTs, accessors, sparse arrays, pointers, and numeric types", () => {
    const malformed: Array<[GateErrorCode, ConditionInput]> = [
      ["invalid-condition", { operator: "unknown" } as never],
      [
        "invalid-condition",
        {
          operator: "exists",
          accessor: { sensorKey: METRICS_KEY, pointer: "", extra: true },
        } as never,
      ],
      ["invalid-pointer", { operator: "exists", accessor: accessor("truth") }],
      [
        "invalid-condition",
        { operator: "greater-than", accessor: accessor("/count"), expected: "5" },
      ],
    ];
    for (const [code, condition] of malformed) {
      expectGateError(code, () => gate([rule("malformed", condition)]));
    }
    expectGateError(
      "invalid-pointer",
      () => gate([rule("malformed", { operator: "exists", accessor: accessor("/bad~2escape") })]),
      ["blocking", 0, "condition", "accessor", "pointer"],
    );
    expectGateError("invalid-policy", () =>
      gate([
        rule("sparse", {
          operator: "all",
          conditions: Array(1) as ConditionInput[],
        }),
      ]),
    );
  });

  it("enforces depth, node, pointer segment, and pointer length budgets", () => {
    let tooDeep: ConditionInput = equals("/truth", true);
    for (let index = 0; index < DEFAULT_GATE_EVALUATION_LIMITS.maxConditionDepth; index += 1) {
      tooDeep = { operator: "not", condition: tooDeep };
    }
    expectGateError("condition-depth-limit", () => gate([rule("too-deep", tooDeep)]));

    const tooMany = Array.from({ length: DEFAULT_GATE_EVALUATION_LIMITS.maxConditionNodes }, () =>
      equals("/truth", true),
    );
    expectGateError("condition-node-limit", () =>
      gate([rule("too-many", { operator: "all", conditions: tooMany })]),
    );
    const tooManySegments = `/${Array.from(
      { length: DEFAULT_GATE_EVALUATION_LIMITS.maxPointerSegments + 1 },
      () => "x",
    ).join("/")}`;
    expectGateError("invalid-pointer", () =>
      gate([rule("segments", { operator: "exists", accessor: accessor(tooManySegments) })]),
    );
    expectGateError("invalid-pointer", () =>
      gate([
        rule("length", {
          operator: "exists",
          accessor: accessor(`/${"x".repeat(DEFAULT_GATE_EVALUATION_LIMITS.maxPointerLength)}`),
        }),
      ]),
    );
  });

  it("rejects duplicate rule keys and consequence fields", () => {
    try {
      gate([rule("same", equals("/truth", true))], [rule("same", equals("/truth", true))]);
      throw new Error("Expected duplicate gate rule error");
    } catch (error) {
      expect(error).toBeInstanceOf(GateError);
      expect(error).toMatchObject({
        code: "invalid-policy",
        path: ["advisory", 0, "key"],
      });
    }
    expectGateError("invalid-policy", () =>
      defineGate(
        {
          key: consumerKey("quality"),
          blocking: [],
          advisory: [],
          consequence: "close-phase",
        } as never,
        deterministicSha256,
      ),
    );
  });

  it("revalidates exact gate evidence from its definition and readings", () => {
    const definition = gate([rule("must-pass", equals("/truth", true))]);
    const reading = metricsReading();
    const evaluation = evaluateGate(definition, [reading], INPUT_DIGEST, deterministicSha256);
    const evidence = validateGateEvidence(
      { definition, readings: [reading], evaluation },
      INPUT_DIGEST,
      deterministicSha256,
    );

    expect(evidence).toEqual({ definition, readings: [reading], evaluation });
    expect(validateGateDefinition(definition, deterministicSha256)).toEqual(definition);
    expect(validateSensorReading(reading, deterministicSha256)).toEqual(reading);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.readings)).toBe(true);
  });

  it("rejects fabricated accepted evaluations even when their digest is recomputed", () => {
    const definition = gate([rule("must-pass", equals("/truth", false))]);
    const reading = metricsReading();
    const rejected = evaluateGate(definition, [reading], INPUT_DIGEST, deterministicSha256);
    const forgedContent = {
      candidateInputDigest: rejected.candidateInputDigest,
      policyDigest: rejected.policyDigest,
      readingDigests: rejected.readingDigests,
      blocking: [{ key: consumerKey("must-pass"), result: "true" }],
      advisory: rejected.advisory,
      decision: "accepted",
    } as const;
    const forged = {
      ...forgedContent,
      evaluationDigest: canonicalDigest(canonicalValue(forgedContent), deterministicSha256),
    };

    expectGateError("invalid-evidence", () =>
      validateGateEvidence(
        { definition, readings: [reading], evaluation: forged },
        INPUT_DIGEST,
        deterministicSha256,
      ),
    );
  });

  it("rejects wrong readings, missing source fields, and accessors without invocation", () => {
    const definition = gate([rule("must-pass", equals("/truth", true))]);
    const reading = metricsReading();
    const evaluation = evaluateGate(definition, [reading], INPUT_DIGEST, deterministicSha256);
    const wrongReading = createSensorReading(
      {
        sensorKey: METRICS_KEY,
        inputDigest: INPUT_DIGEST,
        outcome: "succeeded",
        data: { truth: false },
      },
      deterministicSha256,
    );
    expectGateError("invalid-evidence", () =>
      validateGateEvidence(
        { definition, readings: [wrongReading], evaluation },
        INPUT_DIGEST,
        deterministicSha256,
      ),
    );
    expectGateError("invalid-evidence", () =>
      validateGateEvidence(
        { readings: [reading], evaluation } as never,
        INPUT_DIGEST,
        deterministicSha256,
      ),
    );

    let getterCalls = 0;
    const accessorEvidence = Object.assign(
      Object.defineProperty({}, "evaluation", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return evaluation;
        },
      }),
      { definition, readings: [reading] },
    );
    expectGateError("invalid-evidence", () =>
      validateGateEvidence(
        accessorEvidence as unknown as GateEvidence,
        INPUT_DIGEST,
        deterministicSha256,
      ),
    );
    expect(getterCalls).toBe(0);
  });
});

function gate(blocking: GateRuleInput[], advisory: GateRuleInput[] = []) {
  return defineGate({ key: consumerKey("quality"), blocking, advisory }, deterministicSha256);
}

function rule(key: string, condition: ConditionInput): GateRuleInput {
  return { key: consumerKey(key), condition };
}

function accessor(pointer: string, sensorKey = METRICS_KEY) {
  return { sensorKey, pointer };
}

function equals(pointer: string, expected: unknown, sensorKey = METRICS_KEY): ConditionInput {
  return { operator: "equals", accessor: accessor(pointer, sensorKey), expected };
}

function metricsReading(): SensorReading {
  return createSensorReading(
    {
      sensorKey: METRICS_KEY,
      inputDigest: INPUT_DIGEST,
      outcome: "succeeded",
      data: {
        truth: true,
        count: 5,
        text: "5",
        nullValue: null,
        nested: { a: 1, b: 2 },
        "a/b": { "~key": 7 },
        items: ["first"],
      },
    },
    deterministicSha256,
  );
}

function failedReading(): SensorReading {
  return createSensorReading(
    {
      sensorKey: FAILED_KEY,
      inputDigest: INPUT_DIGEST,
      outcome: "failed",
      error: { code: "sensor-failed" },
    },
    deterministicSha256,
  );
}

function evaluateSingle(condition: ConditionInput): TruthValue {
  const evaluation = evaluateGate(
    gate([rule("condition", condition)]),
    [metricsReading()],
    INPUT_DIGEST,
    deterministicSha256,
  );
  return evaluation.blocking[0]?.result ?? "unknown";
}

function expectGateError(
  code: GateErrorCode,
  action: () => unknown,
  path?: readonly (string | number)[],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).code).toBe(code);
    if (path !== undefined) {
      expect((error as GateError).path).toEqual(path);
      expect(Object.isFrozen((error as GateError).path)).toBe(true);
    }
    return;
  }
  throw new Error(`Expected gate operation to fail with ${code}`);
}
