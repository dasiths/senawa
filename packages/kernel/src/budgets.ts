import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import {
  type CriterionId,
  type DefinitionGeneration,
  type EscalationId,
  isCriterionId,
  isDefinitionGeneration,
  isEscalationId,
  isPhaseId,
  isTaskId,
  type PhaseId,
  type TaskId,
} from "./identity.js";

export const BUDGET_UNITS = [
  "work-attempt",
  "dispatch-failure",
  "sensor-retry",
  "review-iteration",
  "integration-attempt",
  "rebase-attempt",
  "elapsed-time-ms",
  "spend-nano",
] as const;

export type BudgetUnit = (typeof BUDGET_UNITS)[number];

export interface BudgetCounter {
  readonly unit: BudgetUnit;
  readonly limit: number;
  readonly used: number;
}

export interface BudgetLedger {
  readonly counters: readonly BudgetCounter[];
  readonly appliedAllowanceDecisionDigests: readonly Sha256Digest[];
}

export interface BudgetConsumptionInput {
  readonly unit: BudgetUnit;
  readonly amount: number;
}

export interface BudgetExhaustedFact {
  readonly unit: BudgetUnit;
  readonly limit: number;
  readonly used: number;
  readonly requested: number;
  readonly remaining: number;
}

export interface BudgetConsumed {
  readonly outcome: "consumed";
  readonly ledger: BudgetLedger;
  readonly counter: BudgetCounter;
  readonly exhaustedFacts: readonly [];
}

export interface BudgetExhausted {
  readonly outcome: "exhausted";
  readonly ledger: BudgetLedger;
  readonly counter: BudgetCounter;
  readonly exhaustedFacts: readonly [BudgetExhaustedFact];
}

export type BudgetConsumption = BudgetConsumed | BudgetExhausted;

export interface PhaseEscalationOwner {
  readonly kind: "phase";
  readonly phaseId: PhaseId;
  readonly definitionGeneration: DefinitionGeneration;
  readonly contextRevisionDigest: Sha256Digest;
}

export interface TaskEscalationOwner {
  readonly kind: "task";
  readonly taskId: TaskId;
  readonly definitionGeneration: DefinitionGeneration;
  readonly contextRevisionDigest: Sha256Digest;
}

export type EscalationOwner = PhaseEscalationOwner | TaskEscalationOwner;

export type EscalationTrigger =
  | { readonly kind: "budget-exhausted"; readonly fact: BudgetExhaustedFact }
  | { readonly kind: "blocked" };

export interface EscalationAttemptFact {
  readonly kind: BudgetUnit;
  readonly ordinal: number;
  readonly factDigest: Sha256Digest;
}

export const ESCALATION_RESPONSES = [
  "grant-additional",
  "reassign",
  "escalate-model",
  "approve-amendment",
  "waive",
  "supersede",
  "end-run",
] as const;

export type EscalationResponse = (typeof ESCALATION_RESPONSES)[number];

export interface EscalationInput {
  readonly escalationId: EscalationId;
  readonly owner: EscalationOwner;
  readonly trigger: EscalationTrigger;
  readonly contextDigest: Sha256Digest;
  readonly candidateDigest: Sha256Digest;
  readonly policyDigest: Sha256Digest;
  readonly unresolvedCriterionIds: readonly CriterionId[];
  readonly failedReadingDigests: readonly Sha256Digest[];
  readonly unknownReadingDigests: readonly Sha256Digest[];
  readonly attemptFacts: readonly EscalationAttemptFact[];
  readonly allowedResponses: readonly EscalationResponse[];
  readonly timestamp: string;
}

export interface Escalation extends EscalationInput {
  readonly escalationDigest: Sha256Digest;
}

export interface AdditionalAllowanceDecisionInput {
  readonly escalationDigest: Sha256Digest;
  readonly unit: BudgetUnit;
  readonly additionalLimit: number;
  readonly authorityFact: unknown;
}

export interface AdditionalAllowanceDecision {
  readonly escalationDigest: Sha256Digest;
  readonly unit: BudgetUnit;
  readonly additionalLimit: number;
  readonly authorityFact: CanonicalValue;
  readonly decisionDigest: Sha256Digest;
}

export interface AllowanceAuthorityPolicyInput {
  readonly authorityFact: unknown;
  readonly allowedUnits: readonly BudgetUnit[];
  readonly maxAdditionalLimit: number;
}

export interface AllowanceAuthorityPolicy {
  readonly authorityFact: CanonicalValue;
  readonly allowedUnits: readonly BudgetUnit[];
  readonly maxAdditionalLimit: number;
  readonly policyDigest: Sha256Digest;
}

export type BudgetErrorCode =
  | "invalid-ledger"
  | "duplicate-budget"
  | "budget-not-configured"
  | "invalid-consumption"
  | "invalid-escalation"
  | "duplicate-criterion"
  | "duplicate-reading"
  | "duplicate-attempt"
  | "duplicate-allowed-response"
  | "invalid-allowance"
  | "duplicate-allowance"
  | "allowance-not-authorized"
  | "allowance-mismatch"
  | "allowance-authority-mismatch"
  | "allowance-unit-not-authorized"
  | "allowance-limit-exceeded"
  | "budget-overflow";

export class BudgetError extends Error {
  readonly code: BudgetErrorCode;

  constructor(code: BudgetErrorCode, message: string) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

export function createBudgetLedger(input: BudgetLedger): BudgetLedger {
  const snapshot = snapshotCanonical(input, "invalid-ledger", "Budget ledgers");
  return canonicalValue(validateLedger(snapshot)) as unknown as BudgetLedger;
}

export function budgetCounter(ledger: BudgetLedger, unit: BudgetUnit): BudgetCounter | undefined {
  const validated = validateLedger(snapshotCanonical(ledger, "invalid-ledger", "Budget ledgers"));
  if (!isBudgetUnit(unit)) {
    fail("invalid-ledger", "Budget counter access requires a recognized unit");
  }
  return validated.counters.find((counter) => counter.unit === unit);
}

export function consumeBudget(
  ledger: BudgetLedger,
  input: BudgetConsumptionInput,
): BudgetConsumption {
  const snapshot = snapshotCanonical(
    { ledger, input },
    "invalid-consumption",
    "Budget consumption inputs",
  );
  assertExactKeys(snapshot, "budget consumption", ["ledger", "input"], "invalid-consumption");
  const validatedLedger = validateLedger(snapshot.ledger, "invalid-consumption");
  const inputSnapshot = snapshot.input;
  assertExactKeys(
    inputSnapshot,
    "budget consumption input",
    ["unit", "amount"],
    "invalid-consumption",
  );
  if (!isBudgetUnit(inputSnapshot.unit) || !isPositiveSafeInteger(inputSnapshot.amount)) {
    fail(
      "invalid-consumption",
      "Budget consumption requires a recognized unit and positive safe integer amount",
    );
  }

  const index = validatedLedger.counters.findIndex(
    (counter) => counter.unit === inputSnapshot.unit,
  );
  if (index < 0) {
    fail("budget-not-configured", `Budget ${inputSnapshot.unit} is not configured`);
  }
  const counter = validatedLedger.counters[index] as BudgetCounter;
  const remaining = counter.limit - counter.used;
  if (inputSnapshot.amount > remaining) {
    const fact = {
      unit: counter.unit,
      limit: counter.limit,
      used: counter.used,
      requested: inputSnapshot.amount,
      remaining,
    } satisfies BudgetExhaustedFact;
    return canonicalValue({
      outcome: "exhausted",
      ledger: validatedLedger,
      counter,
      exhaustedFacts: [fact],
    }) as unknown as BudgetExhausted;
  }

  const updatedCounter = {
    unit: counter.unit,
    limit: counter.limit,
    used: counter.used + inputSnapshot.amount,
  } satisfies BudgetCounter;
  const counters = validatedLedger.counters.map((current, currentIndex) =>
    currentIndex === index ? updatedCounter : current,
  );
  return canonicalValue({
    outcome: "consumed",
    ledger: {
      counters,
      appliedAllowanceDecisionDigests: validatedLedger.appliedAllowanceDecisionDigests,
    },
    counter: updatedCounter,
    exhaustedFacts: [],
  }) as unknown as BudgetConsumed;
}

export function createEscalation(input: EscalationInput, sha256: Sha256): Escalation {
  const snapshot = snapshotCanonical(input, "invalid-escalation", "Escalations");
  const content = escalationContent(snapshot);
  const escalationDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, escalationDigest }) as unknown as Escalation;
}

export function createAdditionalAllowanceDecision(
  input: AdditionalAllowanceDecisionInput,
  sha256: Sha256,
): AdditionalAllowanceDecision {
  const snapshot = snapshotCanonical(input, "invalid-allowance", "Allowance decisions");
  const content = allowanceContent(snapshot);
  const decisionDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, decisionDigest }) as unknown as AdditionalAllowanceDecision;
}

export function createAllowanceAuthorityPolicy(
  input: AllowanceAuthorityPolicyInput,
  sha256: Sha256,
): AllowanceAuthorityPolicy {
  const snapshot = snapshotCanonical(input, "invalid-allowance", "Allowance authority policies");
  const content = allowanceAuthorityPolicyContent(snapshot);
  const policyDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, policyDigest }) as unknown as AllowanceAuthorityPolicy;
}

export function applyAdditionalAllowance(
  ledger: BudgetLedger,
  escalation: Escalation,
  decision: AdditionalAllowanceDecision,
  policy: AllowanceAuthorityPolicy,
  sha256: Sha256,
): BudgetLedger {
  const snapshot = snapshotCanonical(
    { ledger, escalation, decision, policy },
    "invalid-allowance",
    "Allowance application inputs",
  );
  assertExactKeys(
    snapshot,
    "allowance application",
    ["ledger", "escalation", "decision", "policy"],
    "invalid-allowance",
  );
  const validatedLedger = validateLedger(snapshot.ledger, "invalid-allowance");
  const validatedEscalation = validateEscalationSnapshot(snapshot.escalation, sha256);
  const validatedDecision = validateAllowanceDecision(snapshot.decision, sha256);
  const validatedPolicy = validateAllowanceAuthorityPolicy(snapshot.policy, sha256);
  if (validatedDecision.escalationDigest !== validatedEscalation.escalationDigest) {
    fail("allowance-mismatch", "Allowance decision does not bind the supplied escalation");
  }
  if (!validatedEscalation.allowedResponses.includes("grant-additional")) {
    fail("allowance-not-authorized", "Escalation does not permit an additional allowance");
  }
  if (validatedPolicy.policyDigest !== validatedEscalation.policyDigest) {
    fail("allowance-not-authorized", "Escalation does not bind the supplied allowance policy");
  }
  if (
    canonicalSerialize(validatedDecision.authorityFact) !==
    canonicalSerialize(validatedPolicy.authorityFact)
  ) {
    fail("allowance-authority-mismatch", "Allowance decision has the wrong authority fact");
  }
  if (!validatedPolicy.allowedUnits.includes(validatedDecision.unit)) {
    fail(
      "allowance-unit-not-authorized",
      `Allowance policy does not permit budget ${validatedDecision.unit}`,
    );
  }
  if (validatedDecision.additionalLimit > validatedPolicy.maxAdditionalLimit) {
    fail("allowance-limit-exceeded", "Allowance decision exceeds the policy maximum");
  }
  if (validatedLedger.appliedAllowanceDecisionDigests.includes(validatedDecision.decisionDigest)) {
    fail("duplicate-allowance", "Allowance decision has already been applied");
  }

  const index = validatedLedger.counters.findIndex(
    (counter) => counter.unit === validatedDecision.unit,
  );
  if (index < 0) {
    fail("budget-not-configured", `Budget ${validatedDecision.unit} is not configured`);
  }
  const counter = validatedLedger.counters[index] as BudgetCounter;
  if (validatedDecision.additionalLimit > Number.MAX_SAFE_INTEGER - counter.limit) {
    fail("budget-overflow", `Additional allowance overflows budget ${counter.unit}`);
  }
  const counters = validatedLedger.counters.map((current, currentIndex) =>
    currentIndex === index
      ? {
          unit: current.unit,
          limit: current.limit + validatedDecision.additionalLimit,
          used: current.used,
        }
      : current,
  );
  const appliedAllowanceDecisionDigests = [
    ...validatedLedger.appliedAllowanceDecisionDigests,
    validatedDecision.decisionDigest,
  ].sort(compareText);
  return canonicalValue({
    counters,
    appliedAllowanceDecisionDigests,
  }) as unknown as BudgetLedger;
}

function validateLedger(value: unknown, code: BudgetErrorCode = "invalid-ledger"): BudgetLedger {
  assertExactKeys(value, "budget ledger", ["counters", "appliedAllowanceDecisionDigests"], code);
  if (!Array.isArray(value.counters)) {
    fail(code, "Budget ledger counters must be an array");
  }
  const seen = new Set<BudgetUnit>();
  const counters = value.counters.map((counter, index) => {
    assertExactKeys(counter, `budget counter ${index}`, ["unit", "limit", "used"], code);
    if (!isBudgetUnit(counter.unit)) {
      fail(code, `Budget counter ${index} has an unrecognized unit`);
    }
    if (!isPositiveSafeInteger(counter.limit)) {
      fail(code, `Budget ${counter.unit} limit must be a positive safe integer`);
    }
    if (!isNonnegativeSafeInteger(counter.used) || counter.used > counter.limit) {
      fail(code, `Budget ${counter.unit} used must be a nonnegative safe integer within its limit`);
    }
    if (seen.has(counter.unit)) {
      fail("duplicate-budget", `Budget ${counter.unit} is configured more than once`);
    }
    seen.add(counter.unit);
    return counter as unknown as BudgetCounter;
  });
  counters.sort((left, right) => compareText(left.unit, right.unit));
  const appliedAllowanceDecisionDigests = sortedDigestList(
    value.appliedAllowanceDecisionDigests,
    "applied allowance decision",
    code,
    "duplicate-allowance",
  );
  return { counters, appliedAllowanceDecisionDigests };
}

function escalationContent(value: unknown): EscalationInput {
  assertExactKeys(
    value,
    "escalation",
    [
      "escalationId",
      "owner",
      "trigger",
      "contextDigest",
      "candidateDigest",
      "policyDigest",
      "unresolvedCriterionIds",
      "failedReadingDigests",
      "unknownReadingDigests",
      "attemptFacts",
      "allowedResponses",
      "timestamp",
    ],
    "invalid-escalation",
  );
  if (!isEscalationId(value.escalationId)) {
    fail("invalid-escalation", "Escalations must use an escalation identity");
  }
  const owner = escalationOwner(value.owner);
  const trigger = escalationTrigger(value.trigger);
  if (!isSha256Digest(value.contextDigest)) {
    fail("invalid-escalation", "Escalation contextDigest must be a SHA-256 digest");
  }
  if (!isSha256Digest(value.candidateDigest)) {
    fail("invalid-escalation", "Escalation candidateDigest must be a SHA-256 digest");
  }
  if (!isSha256Digest(value.policyDigest)) {
    fail("invalid-escalation", "Escalation policyDigest must be a SHA-256 digest");
  }
  if (!isTimestamp(value.timestamp)) {
    fail("invalid-escalation", "Escalation timestamp must be an RFC 3339 UTC timestamp");
  }

  const unresolvedCriterionIds = uniqueSortedValues(
    value.unresolvedCriterionIds,
    "unresolved criterion",
    isCriterionId,
    "duplicate-criterion",
  ) as CriterionId[];
  const failedReadingDigests = digestList(value.failedReadingDigests, "failed reading");
  const unknownReadingDigests = digestList(value.unknownReadingDigests, "unknown reading");
  const allReadingDigests = new Set(failedReadingDigests);
  if (unknownReadingDigests.some((digest) => allReadingDigests.has(digest))) {
    fail("duplicate-reading", "A reading digest cannot be both failed and unknown");
  }
  const attemptFacts = validateAttemptFacts(value.attemptFacts);
  const allowedResponses = uniqueSortedValues(
    value.allowedResponses,
    "allowed response",
    isEscalationResponse,
    "duplicate-allowed-response",
  ) as EscalationResponse[];
  if (allowedResponses.length === 0) {
    fail("invalid-escalation", "Escalations require at least one allowed response");
  }

  return {
    escalationId: value.escalationId,
    owner,
    trigger,
    contextDigest: value.contextDigest,
    candidateDigest: value.candidateDigest,
    policyDigest: value.policyDigest,
    unresolvedCriterionIds,
    failedReadingDigests,
    unknownReadingDigests,
    attemptFacts,
    allowedResponses,
    timestamp: value.timestamp,
  };
}

export function validateEscalation(value: unknown, sha256: Sha256): Escalation {
  const snapshot = snapshotCanonical(value, "invalid-escalation", "Escalations");
  return validateEscalationSnapshot(snapshot, sha256);
}

function validateEscalationSnapshot(value: unknown, sha256: Sha256): Escalation {
  assertRecord(value, "escalation", "invalid-escalation");
  const { escalationDigest, ...input } = value;
  if (Object.keys(value).length !== 13 || !isSha256Digest(escalationDigest)) {
    fail("invalid-escalation", "Escalation record has invalid fields or digest");
  }
  const content = escalationContent(input);
  if (canonicalDigest(canonicalValue(content), sha256) !== escalationDigest) {
    fail("invalid-escalation", "Escalation digest does not match its content");
  }
  return canonicalValue({ ...content, escalationDigest }) as unknown as Escalation;
}

function escalationOwner(value: unknown): EscalationOwner {
  assertRecord(value, "escalation owner", "invalid-escalation");
  if (value.kind === "phase") {
    assertExactKeys(
      value,
      "phase escalation owner",
      ["kind", "phaseId", "definitionGeneration", "contextRevisionDigest"],
      "invalid-escalation",
    );
    if (!isPhaseId(value.phaseId)) {
      fail("invalid-escalation", "Phase escalation owner must use a phase identity");
    }
  } else if (value.kind === "task") {
    assertExactKeys(
      value,
      "task escalation owner",
      ["kind", "taskId", "definitionGeneration", "contextRevisionDigest"],
      "invalid-escalation",
    );
    if (!isTaskId(value.taskId)) {
      fail("invalid-escalation", "Task escalation owner must use a task identity");
    }
  } else {
    fail("invalid-escalation", "Escalation owner kind must be phase or task");
  }
  if (!isDefinitionGeneration(value.definitionGeneration)) {
    fail("invalid-escalation", "Escalation owner must bind a definition generation");
  }
  if (!isSha256Digest(value.contextRevisionDigest)) {
    fail("invalid-escalation", "Escalation owner must bind a context revision digest");
  }
  return value as unknown as EscalationOwner;
}

function escalationTrigger(value: unknown): EscalationTrigger {
  assertRecord(value, "escalation trigger", "invalid-escalation");
  if (value.kind === "blocked") {
    assertExactKeys(value, "blocked trigger", ["kind"], "invalid-escalation");
    return { kind: "blocked" };
  }
  if (value.kind !== "budget-exhausted") {
    fail("invalid-escalation", "Escalation trigger kind is not recognized");
  }
  assertExactKeys(value, "budget trigger", ["kind", "fact"], "invalid-escalation");
  return { kind: "budget-exhausted", fact: exhaustedFact(value.fact) };
}

function exhaustedFact(value: unknown): BudgetExhaustedFact {
  assertExactKeys(
    value,
    "budget exhausted fact",
    ["unit", "limit", "used", "requested", "remaining"],
    "invalid-escalation",
  );
  if (
    !isBudgetUnit(value.unit) ||
    !isPositiveSafeInteger(value.limit) ||
    !isNonnegativeSafeInteger(value.used) ||
    value.used > value.limit ||
    !isPositiveSafeInteger(value.requested) ||
    value.remaining !== value.limit - value.used ||
    value.requested <= value.remaining
  ) {
    fail("invalid-escalation", "Budget exhausted fact is inconsistent");
  }
  return value as unknown as BudgetExhaustedFact;
}

function validateAttemptFacts(value: unknown): EscalationAttemptFact[] {
  if (!Array.isArray(value)) {
    fail("invalid-escalation", "Escalation attemptFacts must be an array");
  }
  const factDigests = new Set<Sha256Digest>();
  const attempts = new Set<string>();
  const facts = value.map((fact, index) => {
    assertExactKeys(
      fact,
      `attempt fact ${index}`,
      ["kind", "ordinal", "factDigest"],
      "invalid-escalation",
    );
    if (
      !isBudgetUnit(fact.kind) ||
      !isPositiveSafeInteger(fact.ordinal) ||
      !isSha256Digest(fact.factDigest)
    ) {
      fail("invalid-escalation", `Attempt fact ${index} is invalid`);
    }
    const attemptKey = `${fact.kind}:${fact.ordinal}`;
    if (attempts.has(attemptKey) || factDigests.has(fact.factDigest)) {
      fail("duplicate-attempt", `Attempt fact ${index} is duplicated`);
    }
    attempts.add(attemptKey);
    factDigests.add(fact.factDigest);
    return fact as unknown as EscalationAttemptFact;
  });
  facts.sort((left, right) =>
    left.kind === right.kind ? left.ordinal - right.ordinal : compareText(left.kind, right.kind),
  );
  return facts;
}

function allowanceContent(value: unknown): Omit<AdditionalAllowanceDecision, "decisionDigest"> {
  assertExactKeys(
    value,
    "allowance decision",
    ["escalationDigest", "unit", "additionalLimit", "authorityFact"],
    "invalid-allowance",
  );
  if (!isSha256Digest(value.escalationDigest)) {
    fail("invalid-allowance", "Allowance decision must bind an escalation digest");
  }
  if (!isBudgetUnit(value.unit) || !isPositiveSafeInteger(value.additionalLimit)) {
    fail(
      "invalid-allowance",
      "Allowance decision requires a recognized unit and positive safe integer limit",
    );
  }
  return {
    escalationDigest: value.escalationDigest,
    unit: value.unit,
    additionalLimit: value.additionalLimit,
    authorityFact: value.authorityFact as CanonicalValue,
  };
}

function validateAllowanceDecision(value: unknown, sha256: Sha256): AdditionalAllowanceDecision {
  assertRecord(value, "allowance decision", "invalid-allowance");
  const { decisionDigest, ...input } = value;
  if (Object.keys(value).length !== 5 || !isSha256Digest(decisionDigest)) {
    fail("invalid-allowance", "Allowance decision record has invalid fields or digest");
  }
  const content = allowanceContent(input);
  if (canonicalDigest(canonicalValue(content), sha256) !== decisionDigest) {
    fail("invalid-allowance", "Allowance decision digest does not match its content");
  }
  return { ...content, decisionDigest };
}

function allowanceAuthorityPolicyContent(
  value: unknown,
): Omit<AllowanceAuthorityPolicy, "policyDigest"> {
  assertExactKeys(
    value,
    "allowance authority policy",
    ["authorityFact", "allowedUnits", "maxAdditionalLimit"],
    "invalid-allowance",
  );
  const allowedUnits = uniqueSortedBudgetUnits(value.allowedUnits);
  if (allowedUnits.length === 0) {
    fail("invalid-allowance", "Allowance authority policies require at least one allowed unit");
  }
  if (!isPositiveSafeInteger(value.maxAdditionalLimit)) {
    fail("invalid-allowance", "Allowance authority policy maximum must be a positive safe integer");
  }
  return {
    authorityFact: value.authorityFact as CanonicalValue,
    allowedUnits,
    maxAdditionalLimit: value.maxAdditionalLimit,
  };
}

function validateAllowanceAuthorityPolicy(
  value: unknown,
  sha256: Sha256,
): AllowanceAuthorityPolicy {
  assertRecord(value, "allowance authority policy", "invalid-allowance");
  const { policyDigest, ...input } = value;
  if (Object.keys(value).length !== 4 || !isSha256Digest(policyDigest)) {
    fail("invalid-allowance", "Allowance authority policy has invalid fields or digest");
  }
  const content = allowanceAuthorityPolicyContent(input);
  if (canonicalDigest(canonicalValue(content), sha256) !== policyDigest) {
    fail("invalid-allowance", "Allowance authority policy digest does not match its content");
  }
  return { ...content, policyDigest };
}

function uniqueSortedBudgetUnits(value: unknown): BudgetUnit[] {
  if (!Array.isArray(value)) {
    fail("invalid-allowance", "Allowance authority policy allowedUnits must be an array");
  }
  const seen = new Set<BudgetUnit>();
  const units = value.map((unit, index) => {
    if (!isBudgetUnit(unit)) {
      fail("invalid-allowance", `Allowance authority policy unit ${index} is invalid`);
    }
    if (seen.has(unit)) {
      fail("invalid-allowance", `Allowance authority policy unit ${unit} is duplicated`);
    }
    seen.add(unit);
    return unit;
  });
  units.sort(compareText);
  return units;
}

function sortedDigestList(
  value: unknown,
  subject: string,
  code: BudgetErrorCode,
  duplicateCode: BudgetErrorCode,
): Sha256Digest[] {
  if (!Array.isArray(value)) {
    fail(code, `${subject} digests must be an array`);
  }
  const seen = new Set<Sha256Digest>();
  const digests = value.map((digest, index) => {
    if (!isSha256Digest(digest)) {
      fail(code, `${subject} digest ${index} is invalid`);
    }
    if (seen.has(digest)) {
      fail(duplicateCode, `${subject} digest ${digest} is duplicated`);
    }
    seen.add(digest);
    return digest;
  });
  digests.sort(compareText);
  return digests;
}

function digestList(value: unknown, subject: string): Sha256Digest[] {
  return uniqueSortedValues(value, subject, isSha256Digest, "duplicate-reading") as Sha256Digest[];
}

function uniqueSortedValues(
  value: unknown,
  subject: string,
  validate: (candidate: unknown) => boolean,
  duplicateCode: BudgetErrorCode,
): string[] {
  if (!Array.isArray(value)) {
    fail("invalid-escalation", `Escalation ${subject} values must be an array`);
  }
  const seen = new Set<string>();
  const result = value.map((item, index) => {
    if (!validate(item)) {
      fail("invalid-escalation", `Escalation ${subject} ${index} is invalid`);
    }
    const text = item as string;
    if (seen.has(text)) {
      fail(duplicateCode, `Escalation ${subject} ${text} is duplicated`);
    }
    seen.add(text);
    return text;
  });
  result.sort(compareText);
  return result;
}

function snapshotCanonical(value: unknown, code: BudgetErrorCode, subject: string): CanonicalValue {
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
  code: BudgetErrorCode,
): asserts value is Record<string, unknown> {
  assertRecord(value, subject, code);
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${subject} fields must be exactly: ${expected.join(", ")}`);
  }
}

function assertRecord(
  value: unknown,
  subject: string,
  code: BudgetErrorCode,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${subject} must be an object`);
  }
}

function isBudgetUnit(value: unknown): value is BudgetUnit {
  return typeof value === "string" && (BUDGET_UNITS as readonly string[]).includes(value);
}

function isEscalationResponse(value: unknown): value is EscalationResponse {
  return typeof value === "string" && (ESCALATION_RESPONSES as readonly string[]).includes(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/.test(
      value,
    )
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: BudgetErrorCode, message: string): never {
  throw new BudgetError(code, message);
}
