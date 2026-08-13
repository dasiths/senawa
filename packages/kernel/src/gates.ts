import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import { type ConsumerKey, isConsumerKey } from "./identity.js";

export type TruthValue = "true" | "false" | "unknown";

export interface SensorReadingSucceededInput {
  readonly sensorKey: ConsumerKey;
  readonly inputDigest: Sha256Digest;
  readonly outcome: "succeeded";
  readonly data: unknown;
}

export interface SensorReadingFailedInput {
  readonly sensorKey: ConsumerKey;
  readonly inputDigest: Sha256Digest;
  readonly outcome: "failed";
  readonly error: unknown;
}

export type SensorReadingInput = SensorReadingSucceededInput | SensorReadingFailedInput;

export interface SensorReadingSucceeded {
  readonly sensorKey: ConsumerKey;
  readonly inputDigest: Sha256Digest;
  readonly outcome: "succeeded";
  readonly data: CanonicalValue;
  readonly readingDigest: Sha256Digest;
}

export interface SensorReadingFailed {
  readonly sensorKey: ConsumerKey;
  readonly inputDigest: Sha256Digest;
  readonly outcome: "failed";
  readonly error: CanonicalValue;
  readonly readingDigest: Sha256Digest;
}

export type SensorReading = SensorReadingSucceeded | SensorReadingFailed;

type SensorReadingContent =
  | Omit<SensorReadingSucceeded, "readingDigest">
  | Omit<SensorReadingFailed, "readingDigest">;

export interface ReadingAccessor {
  readonly sensorKey: ConsumerKey;
  readonly pointer: string;
}

export interface AllCondition {
  readonly operator: "all";
  readonly conditions: readonly Condition[];
}

export interface AnyCondition {
  readonly operator: "any";
  readonly conditions: readonly Condition[];
}

export interface NotCondition {
  readonly operator: "not";
  readonly condition: Condition;
}

export interface ExistsCondition {
  readonly operator: "exists";
  readonly accessor: ReadingAccessor;
}

interface ComparisonCondition<Operator extends string> {
  readonly operator: Operator;
  readonly accessor: ReadingAccessor;
  readonly expected: CanonicalValue;
}

export type EqualsCondition = ComparisonCondition<"equals">;
export type NotEqualsCondition = ComparisonCondition<"not-equals">;
export type GreaterThanCondition = ComparisonCondition<"greater-than">;
export type GreaterThanOrEqualCondition = ComparisonCondition<"greater-than-or-equal">;
export type LessThanCondition = ComparisonCondition<"less-than">;
export type LessThanOrEqualCondition = ComparisonCondition<"less-than-or-equal">;

export type Condition =
  | AllCondition
  | AnyCondition
  | NotCondition
  | ExistsCondition
  | EqualsCondition
  | NotEqualsCondition
  | GreaterThanCondition
  | GreaterThanOrEqualCondition
  | LessThanCondition
  | LessThanOrEqualCondition;

type ComparisonOperator =
  | "equals"
  | "not-equals"
  | "greater-than"
  | "greater-than-or-equal"
  | "less-than"
  | "less-than-or-equal";

export type ConditionInput =
  | { readonly operator: "all"; readonly conditions: readonly ConditionInput[] }
  | { readonly operator: "any"; readonly conditions: readonly ConditionInput[] }
  | { readonly operator: "not"; readonly condition: ConditionInput }
  | { readonly operator: "exists"; readonly accessor: ReadingAccessor }
  | {
      readonly operator:
        | "equals"
        | "not-equals"
        | "greater-than"
        | "greater-than-or-equal"
        | "less-than"
        | "less-than-or-equal";
      readonly accessor: ReadingAccessor;
      readonly expected: unknown;
    };

export interface GateRuleInput {
  readonly key: ConsumerKey;
  readonly condition: ConditionInput;
}

export interface GateDefinitionInput {
  readonly key: ConsumerKey;
  readonly blocking: readonly GateRuleInput[];
  readonly advisory: readonly GateRuleInput[];
}

export interface GateRule {
  readonly key: ConsumerKey;
  readonly condition: Condition;
}

export interface GateDefinition {
  readonly key: ConsumerKey;
  readonly blocking: readonly GateRule[];
  readonly advisory: readonly GateRule[];
  readonly policyDigest: Sha256Digest;
}

export interface GateRuleEvaluation {
  readonly key: ConsumerKey;
  readonly result: TruthValue;
}

export interface GateEvaluation {
  readonly candidateInputDigest: Sha256Digest;
  readonly policyDigest: Sha256Digest;
  readonly readingDigests: readonly Sha256Digest[];
  readonly blocking: readonly GateRuleEvaluation[];
  readonly advisory: readonly GateRuleEvaluation[];
  readonly decision: "accepted" | "rejected";
  readonly evaluationDigest: Sha256Digest;
}

export interface GateEvidence {
  readonly definition: GateDefinition;
  readonly readings: readonly SensorReading[];
  readonly evaluation: GateEvaluation;
}

export interface GateEvaluationLimits {
  readonly maxConditionDepth: number;
  readonly maxConditionNodes: number;
  readonly maxPointerSegments: number;
  readonly maxPointerLength: number;
}

export const DEFAULT_GATE_EVALUATION_LIMITS: GateEvaluationLimits = Object.freeze({
  maxConditionDepth: 32,
  maxConditionNodes: 256,
  maxPointerSegments: 64,
  maxPointerLength: 1_024,
});

export type GateErrorCode =
  | "invalid-reading"
  | "invalid-policy"
  | "invalid-condition"
  | "invalid-pointer"
  | "invalid-evaluation-input"
  | "invalid-evidence"
  | "duplicate-reading"
  | "reading-input-mismatch"
  | "condition-depth-limit"
  | "condition-node-limit";

export type GateErrorPathSegment = string | number;

export class GateError extends Error {
  readonly code: GateErrorCode;
  readonly path?: readonly GateErrorPathSegment[];

  constructor(code: GateErrorCode, message: string, path?: readonly GateErrorPathSegment[]) {
    super(message);
    this.name = "GateError";
    this.code = code;
    if (path !== undefined) this.path = Object.freeze([...path]);
  }
}

export function createSensorReading(
  input: SensorReadingSucceededInput,
  sha256: Sha256,
): SensorReadingSucceeded;
export function createSensorReading(
  input: SensorReadingFailedInput,
  sha256: Sha256,
): SensorReadingFailed;
export function createSensorReading(input: SensorReadingInput, sha256: Sha256): SensorReading {
  const snapshot = snapshotCanonical(input, "invalid-reading", "Sensor readings");
  const content = readingContent(snapshot);
  const readingDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, readingDigest }) as unknown as SensorReading;
}

export function defineGate(input: GateDefinitionInput, sha256: Sha256): GateDefinition {
  const snapshot = snapshotCanonical(input, "invalid-policy", "Gate definitions");
  const budget = { nodes: 0 };
  const content = gateContent(snapshot, budget, DEFAULT_GATE_EVALUATION_LIMITS);
  const policyDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, policyDigest }) as unknown as GateDefinition;
}

export function validateGateDefinition(value: unknown, sha256: Sha256): GateDefinition {
  const snapshot = snapshotCanonical(value, "invalid-policy", "Gate definitions");
  return validateGateDefinitionSnapshot(snapshot, sha256);
}

export function validateSensorReading(value: unknown, sha256: Sha256): SensorReading {
  const snapshot = snapshotCanonical(value, "invalid-reading", "Sensor readings");
  return validateReadingSnapshot(snapshot, sha256);
}

export function evaluateGate(
  definition: GateDefinition,
  readings: readonly SensorReading[],
  candidateInputDigest: Sha256Digest,
  sha256: Sha256,
): GateEvaluation {
  const submitted = snapshotCanonical(
    { definition, readings, candidateInputDigest },
    "invalid-evaluation-input",
    "Gate evaluation inputs",
  );
  assertExactKeys(
    submitted,
    "gate evaluation input",
    ["definition", "readings", "candidateInputDigest"],
    "invalid-evaluation-input",
  );
  if (!isSha256Digest(submitted.candidateInputDigest)) {
    fail("invalid-evaluation-input", "candidateInputDigest must be a SHA-256 digest");
  }

  const validatedDefinition = validateGateDefinitionSnapshot(submitted.definition, sha256);
  const readingIndex = validateReadings(submitted.readings, submitted.candidateInputDigest, sha256);
  const blocking = evaluateRules(validatedDefinition.blocking, readingIndex);
  const advisory = evaluateRules(validatedDefinition.advisory, readingIndex);
  const decision = blocking.every((evaluation) => evaluation.result === "true")
    ? "accepted"
    : "rejected";
  const content = {
    candidateInputDigest: submitted.candidateInputDigest,
    policyDigest: validatedDefinition.policyDigest,
    readingDigests: [...readingIndex.values()]
      .map((reading) => reading.readingDigest)
      .sort(compareText),
    blocking,
    advisory,
    decision,
  } as const;
  const evaluationDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, evaluationDigest }) as unknown as GateEvaluation;
}

export function validateGateEvidence(
  value: unknown,
  candidateInputDigest: Sha256Digest,
  sha256: Sha256,
): GateEvidence {
  const snapshot = snapshotCanonical(value, "invalid-evidence", "Gate evidence");
  assertExactKeys(
    snapshot,
    "gate evidence",
    ["definition", "readings", "evaluation"],
    "invalid-evidence",
  );
  if (!isSha256Digest(candidateInputDigest)) {
    fail("invalid-evidence", "Gate evidence requires a candidate SHA-256 digest");
  }
  const definition = validateGateDefinitionSnapshot(snapshot.definition, sha256);
  if (!Array.isArray(snapshot.readings)) {
    fail("invalid-evidence", "Gate evidence readings must be an array");
  }
  const readings = snapshot.readings.map((reading) => validateReadingSnapshot(reading, sha256));
  const evaluation = evaluateGate(definition, readings, candidateInputDigest, sha256);
  if (
    canonicalSerialize(snapshot.evaluation as CanonicalValue) !==
    canonicalSerialize(evaluation as unknown as CanonicalValue)
  ) {
    fail("invalid-evidence", "Gate evaluation does not match its exact definition and readings");
  }
  return canonicalValue({ definition, readings, evaluation }) as unknown as GateEvidence;
}

function readingContent(value: unknown): SensorReadingContent {
  if (!isRecord(value)) {
    fail("invalid-reading", "Sensor readings must be objects");
  }
  if (value.outcome === "succeeded") {
    assertExactKeys(
      value,
      "successful sensor reading",
      ["sensorKey", "inputDigest", "outcome", "data"],
      "invalid-reading",
    );
    assertReadingEnvelope(value);
    return {
      sensorKey: value.sensorKey,
      inputDigest: value.inputDigest,
      outcome: value.outcome,
      data: value.data as CanonicalValue,
    };
  }
  if (value.outcome === "failed") {
    assertExactKeys(
      value,
      "failed sensor reading",
      ["sensorKey", "inputDigest", "outcome", "error"],
      "invalid-reading",
    );
    assertReadingEnvelope(value);
    return {
      sensorKey: value.sensorKey,
      inputDigest: value.inputDigest,
      outcome: value.outcome,
      error: value.error as CanonicalValue,
    };
  }
  fail("invalid-reading", "Sensor reading outcomes must be succeeded or failed");
}

function assertReadingEnvelope(value: Record<string, unknown>): asserts value is Record<
  string,
  unknown
> & {
  sensorKey: ConsumerKey;
  inputDigest: Sha256Digest;
} {
  if (!isConsumerKey(value.sensorKey)) {
    fail("invalid-reading", "Sensor readings must use a consumer key");
  }
  if (!isSha256Digest(value.inputDigest)) {
    fail("invalid-reading", "Sensor reading inputDigest must be a SHA-256 digest");
  }
}

function gateContent(
  value: unknown,
  budget: { nodes: number },
  limits: GateEvaluationLimits,
): Omit<GateDefinition, "policyDigest"> {
  assertExactKeys(value, "gate definition", ["key", "blocking", "advisory"], "invalid-policy");
  if (!isConsumerKey(value.key)) {
    fail("invalid-policy", "Gate definitions must use a consumer key");
  }
  const blocking = gateRules(value.blocking, "blocking", budget, limits);
  const advisory = gateRules(value.advisory, "advisory", budget, limits);
  const keys = new Map<string, readonly GateErrorPathSegment[]>();
  for (const [kind, rules] of [
    ["blocking", blocking],
    ["advisory", advisory],
  ] as const) {
    for (const [index, rule] of rules.entries()) {
      if (keys.has(rule.key)) {
        fail("invalid-policy", `Gate rule key ${rule.key} is duplicated`, [kind, index, "key"]);
      }
      keys.set(rule.key, [kind, index, "key"]);
    }
  }
  return { key: value.key, blocking, advisory };
}

function gateRules(
  value: unknown,
  kind: "blocking" | "advisory",
  budget: { nodes: number },
  limits: GateEvaluationLimits,
): readonly GateRule[] {
  if (!Array.isArray(value)) {
    fail("invalid-policy", `Gate ${kind} rules must be an array`, [kind]);
  }
  return value.map((rule, index) => {
    const rulePath: readonly GateErrorPathSegment[] = [kind, index];
    assertExactKeys(
      rule,
      `${kind} rule ${index}`,
      ["key", "condition"],
      "invalid-policy",
      rulePath,
    );
    if (!isConsumerKey(rule.key)) {
      fail("invalid-policy", `Gate ${kind} rule ${index} must use a consumer key`, [
        ...rulePath,
        "key",
      ]);
    }
    return {
      key: rule.key,
      condition: validateCondition(rule.condition, 1, budget, limits, [...rulePath, "condition"]),
    };
  });
}

function validateCondition(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  limits: GateEvaluationLimits,
  path: readonly GateErrorPathSegment[],
): Condition {
  budget.nodes += 1;
  if (budget.nodes > limits.maxConditionNodes) {
    fail(
      "condition-node-limit",
      `Gate conditions exceed the ${limits.maxConditionNodes} node limit`,
      path,
    );
  }
  if (depth > limits.maxConditionDepth) {
    fail(
      "condition-depth-limit",
      `Gate conditions exceed the ${limits.maxConditionDepth} depth limit`,
      path,
    );
  }
  if (!isRecord(value) || typeof value.operator !== "string") {
    fail("invalid-condition", "Gate conditions must be objects with an operator", path);
  }

  if (value.operator === "all" || value.operator === "any") {
    assertExactKeys(
      value,
      `${value.operator} condition`,
      ["operator", "conditions"],
      "invalid-condition",
      path,
    );
    if (!Array.isArray(value.conditions)) {
      fail("invalid-condition", `${value.operator} conditions must contain a conditions array`, [
        ...path,
        "conditions",
      ]);
    }
    return {
      operator: value.operator,
      conditions: value.conditions.map((condition, index) =>
        validateCondition(condition, depth + 1, budget, limits, [...path, "conditions", index]),
      ),
    };
  }
  if (value.operator === "not") {
    assertExactKeys(value, "not condition", ["operator", "condition"], "invalid-condition", path);
    return {
      operator: value.operator,
      condition: validateCondition(value.condition, depth + 1, budget, limits, [
        ...path,
        "condition",
      ]),
    };
  }
  if (value.operator === "exists") {
    assertExactKeys(value, "exists condition", ["operator", "accessor"], "invalid-condition", path);
    return {
      operator: value.operator,
      accessor: validateAccessor(value.accessor, limits, [...path, "accessor"]),
    };
  }
  if (isComparisonOperator(value.operator)) {
    assertExactKeys(
      value,
      `${value.operator} condition`,
      ["operator", "accessor", "expected"],
      "invalid-condition",
      path,
    );
    if (isNumberComparisonOperator(value.operator) && typeof value.expected !== "number") {
      fail("invalid-condition", `${value.operator} conditions require a numeric expected value`, [
        ...path,
        "expected",
      ]);
    }
    return {
      operator: value.operator,
      accessor: validateAccessor(value.accessor, limits, [...path, "accessor"]),
      expected: value.expected as CanonicalValue,
    };
  }
  fail("invalid-condition", `Unknown gate condition operator: ${value.operator}`, [
    ...path,
    "operator",
  ]);
}

function validateAccessor(
  value: unknown,
  limits: GateEvaluationLimits,
  path: readonly GateErrorPathSegment[],
): ReadingAccessor {
  assertExactKeys(value, "reading accessor", ["sensorKey", "pointer"], "invalid-condition", path);
  if (!isConsumerKey(value.sensorKey)) {
    fail("invalid-condition", "Reading accessors must use a sensor consumer key", [
      ...path,
      "sensorKey",
    ]);
  }
  if (typeof value.pointer !== "string") {
    fail("invalid-pointer", "Reading accessor pointers must be strings", [...path, "pointer"]);
  }
  parsePointer(value.pointer, limits, [...path, "pointer"]);
  return { sensorKey: value.sensorKey, pointer: value.pointer };
}

function validateGateDefinitionSnapshot(value: unknown, sha256: Sha256): GateDefinition {
  assertExactKeys(
    value,
    "gate definition",
    ["key", "blocking", "advisory", "policyDigest"],
    "invalid-policy",
  );
  if (!isSha256Digest(value.policyDigest)) {
    fail("invalid-policy", "Gate policyDigest must be a SHA-256 digest");
  }
  const content = gateContent(
    { key: value.key, blocking: value.blocking, advisory: value.advisory },
    { nodes: 0 },
    DEFAULT_GATE_EVALUATION_LIMITS,
  );
  const computed = canonicalDigest(canonicalValue(content), sha256);
  if (computed !== value.policyDigest) {
    fail("invalid-policy", "Gate policyDigest does not match its exact definition");
  }
  return canonicalValue({ ...content, policyDigest: computed }) as unknown as GateDefinition;
}

function validateReadings(
  value: unknown,
  candidateInputDigest: Sha256Digest,
  sha256: Sha256,
): ReadonlyMap<ConsumerKey, SensorReading> {
  if (!Array.isArray(value)) {
    fail("invalid-evaluation-input", "Gate readings must be an array");
  }
  const index = new Map<ConsumerKey, SensorReading>();
  for (const submitted of value) {
    const reading = validateReadingSnapshot(submitted, sha256);
    if (reading.inputDigest !== candidateInputDigest) {
      fail(
        "reading-input-mismatch",
        `Reading ${reading.sensorKey} is not bound to the evaluated candidate input`,
      );
    }
    if (index.has(reading.sensorKey)) {
      fail("duplicate-reading", `Reading ${reading.sensorKey} is supplied more than once`);
    }
    index.set(reading.sensorKey, reading);
  }
  return index;
}

function validateReadingSnapshot(value: unknown, sha256: Sha256): SensorReading {
  if (!isRecord(value)) {
    fail("invalid-reading", "Sensor readings must be objects");
  }
  const expectedKeys =
    value.outcome === "succeeded"
      ? ["sensorKey", "inputDigest", "outcome", "data", "readingDigest"]
      : ["sensorKey", "inputDigest", "outcome", "error", "readingDigest"];
  assertExactKeys(value, "sensor reading", expectedKeys, "invalid-reading");
  if (!isSha256Digest(value.readingDigest)) {
    fail("invalid-reading", "Sensor readingDigest must be a SHA-256 digest");
  }
  const contentValue = { ...value };
  delete contentValue.readingDigest;
  const content = readingContent(contentValue);
  const computed = canonicalDigest(canonicalValue(content), sha256);
  if (computed !== value.readingDigest) {
    fail("invalid-reading", "Sensor readingDigest does not match its exact facts");
  }
  return canonicalValue({ ...content, readingDigest: computed }) as unknown as SensorReading;
}

function evaluateRules(
  rules: readonly GateRule[],
  readings: ReadonlyMap<ConsumerKey, SensorReading>,
): readonly GateRuleEvaluation[] {
  return rules.map((rule) => ({
    key: rule.key,
    result: evaluateCondition(rule.condition, readings),
  }));
}

function evaluateCondition(
  condition: Condition,
  readings: ReadonlyMap<ConsumerKey, SensorReading>,
): TruthValue {
  switch (condition.operator) {
    case "all": {
      let result: TruthValue = "true";
      for (const child of condition.conditions) {
        const childResult = evaluateCondition(child, readings);
        if (childResult === "false") return "false";
        if (childResult === "unknown") result = "unknown";
      }
      return result;
    }
    case "any": {
      let result: TruthValue = "false";
      for (const child of condition.conditions) {
        const childResult = evaluateCondition(child, readings);
        if (childResult === "true") return "true";
        if (childResult === "unknown") result = "unknown";
      }
      return result;
    }
    case "not":
      return invert(evaluateCondition(condition.condition, readings));
    case "exists": {
      const resolved = resolveAccessor(condition.accessor, readings);
      if (resolved.kind === "unavailable") return "unknown";
      return resolved.kind === "found" ? "true" : "false";
    }
    default: {
      const resolved = resolveAccessor(condition.accessor, readings);
      if (resolved.kind !== "found") return "unknown";
      if (condition.operator === "equals" || condition.operator === "not-equals") {
        const equals =
          canonicalSerialize(resolved.value) === canonicalSerialize(condition.expected);
        const result = equals ? "true" : "false";
        return condition.operator === "equals" ? result : invert(result);
      }
      if (typeof resolved.value !== "number" || typeof condition.expected !== "number") {
        return "unknown";
      }
      switch (condition.operator) {
        case "greater-than":
          return truth(resolved.value > condition.expected);
        case "greater-than-or-equal":
          return truth(resolved.value >= condition.expected);
        case "less-than":
          return truth(resolved.value < condition.expected);
        case "less-than-or-equal":
          return truth(resolved.value <= condition.expected);
      }
    }
  }
}

type ResolvedAccessor =
  | { readonly kind: "found"; readonly value: CanonicalValue }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };

function resolveAccessor(
  accessor: ReadingAccessor,
  readings: ReadonlyMap<ConsumerKey, SensorReading>,
): ResolvedAccessor {
  const reading = readings.get(accessor.sensorKey);
  if (reading === undefined || reading.outcome === "failed") {
    return { kind: "unavailable" };
  }
  let current: CanonicalValue = reading.data;
  for (const segment of parsePointer(accessor.pointer, DEFAULT_GATE_EVALUATION_LIMITS)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return { kind: "missing" };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return { kind: "missing" };
      current = current[index] as CanonicalValue;
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) return { kind: "missing" };
      current = (current as unknown as { readonly [key: string]: CanonicalValue })[
        segment
      ] as CanonicalValue;
    } else {
      return { kind: "missing" };
    }
  }
  return { kind: "found", value: current };
}

function parsePointer(
  pointer: string,
  limits: GateEvaluationLimits,
  path?: readonly GateErrorPathSegment[],
): readonly string[] {
  if (pointer.length > limits.maxPointerLength) {
    fail(
      "invalid-pointer",
      `JSON Pointers cannot exceed ${limits.maxPointerLength} characters`,
      path,
    );
  }
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    fail("invalid-pointer", "JSON Pointers must be empty or begin with /", path);
  }
  const encoded = pointer.slice(1).split("/");
  if (encoded.length > limits.maxPointerSegments) {
    fail(
      "invalid-pointer",
      `JSON Pointers cannot exceed ${limits.maxPointerSegments} segments`,
      path,
    );
  }
  return encoded.map((segment) => {
    if (/~(?:[^01]|$)/.test(segment)) {
      fail("invalid-pointer", "JSON Pointer escapes must use ~0 or ~1", path);
    }
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function isComparisonOperator(value: string): value is ComparisonOperator {
  return [
    "equals",
    "not-equals",
    "greater-than",
    "greater-than-or-equal",
    "less-than",
    "less-than-or-equal",
  ].includes(value);
}

function isNumberComparisonOperator(
  value: string,
): value is "greater-than" | "greater-than-or-equal" | "less-than" | "less-than-or-equal" {
  return value !== "equals" && value !== "not-equals";
}

function snapshotCanonical(value: unknown, code: GateErrorCode, subject: string): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    fail(code, `${subject} must be stable canonical JSON values`);
  }
}

function assertExactKeys(
  value: unknown,
  subject: string,
  expectedKeys: readonly string[],
  code: GateErrorCode,
  path?: readonly GateErrorPathSegment[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    fail(code, `${subject} must be an object`, path);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${subject} fields must be exactly: ${expected.join(", ")}`, path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invert(value: TruthValue): TruthValue {
  if (value === "unknown") return value;
  return value === "true" ? "false" : "true";
}

function truth(value: boolean): TruthValue {
  return value ? "true" : "false";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: GateErrorCode, message: string, path?: readonly GateErrorPathSegment[]): never {
  throw new GateError(code, message, path);
}
