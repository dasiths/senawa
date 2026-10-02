import { describe, expect, it } from "vitest";
import {
  applyAdditionalAllowance,
  BUDGET_UNITS,
  BudgetError,
  type BudgetErrorCode,
  budgetCounter,
  consumeBudget,
  createAdditionalAllowanceDecision,
  createAllowanceAuthorityPolicy,
  createBudgetLedger,
  createEscalation,
  type EscalationInput,
  validateEscalation,
} from "./budgets.js";
import { type Sha256, sha256Digest } from "./canonical.js";
import { criterionId, definitionGeneration, escalationId, phaseId, taskId } from "./identity.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const CONTEXT_DIGEST = sha256Digest("a".repeat(64));
const CANDIDATE_DIGEST = sha256Digest("b".repeat(64));
const AUTHORITY_FACT = { authority: "operator", approval: "approved" } as const;
const ALLOWANCE_POLICY = createAllowanceAuthorityPolicy(
  {
    authorityFact: AUTHORITY_FACT,
    allowedUnits: ["work-attempt"],
    maxAdditionalLimit: 2,
  },
  deterministicSha256,
);

describe("independent finite budgets", () => {
  it("accepts every budget unit and snapshots immutable counters", () => {
    const counters = BUDGET_UNITS.map((unit, index) => ({ unit, limit: index + 1, used: 0 }));
    const ledger = createBudgetLedger({ counters, appliedAllowanceDecisionDigests: [] });
    counters[0] = { unit: "work-attempt", limit: 99, used: 0 };

    expect(ledger.counters).toHaveLength(BUDGET_UNITS.length);
    expect(ledger.appliedAllowanceDecisionDigests).toEqual([]);
    expect(budgetCounter(ledger, "work-attempt")).toEqual({
      unit: "work-attempt",
      limit: 1,
      used: 0,
    });
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger.counters)).toBe(true);
    expect(Object.isFrozen(ledger.counters[0])).toBe(true);
  });

  it.each(BUDGET_UNITS)("returns an exhausted fact for %s without exceeding its limit", (unit) => {
    const ledger = createBudgetLedger({
      counters: [{ unit, limit: 2, used: 1 }],
      appliedAllowanceDecisionDigests: [],
    });
    const result = consumeBudget(ledger, { unit, amount: 2 });

    expect(result).toEqual({
      outcome: "exhausted",
      ledger: {
        counters: [{ unit, limit: 2, used: 1 }],
        appliedAllowanceDecisionDigests: [],
      },
      counter: { unit, limit: 2, used: 1 },
      exhaustedFacts: [{ unit, limit: 2, used: 1, requested: 2, remaining: 1 }],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.ledger).not.toBe(ledger);
  });

  it("consumes immutably and never changes another counter", () => {
    const ledger = createBudgetLedger({
      counters: [
        { unit: "work-attempt", limit: 3, used: 1 },
        { unit: "sensor-retry", limit: 5, used: 2 },
      ],
      appliedAllowanceDecisionDigests: [],
    });
    const result = consumeBudget(ledger, { unit: "work-attempt", amount: 2 });

    expect(result.outcome).toBe("consumed");
    expect(result.ledger).not.toBe(ledger);
    expect(budgetCounter(result.ledger, "work-attempt")?.used).toBe(3);
    expect(budgetCounter(result.ledger, "sensor-retry")).toEqual(
      budgetCounter(ledger, "sensor-retry"),
    );
    expect(budgetCounter(ledger, "work-attempt")?.used).toBe(1);
  });

  it("sorts persisted allowance decisions and rejects duplicate replay history", () => {
    const laterDigest = sha256Digest("f".repeat(64));
    const earlierDigest = sha256Digest("d".repeat(64));
    const appliedAllowanceDecisionDigests = [laterDigest, earlierDigest];
    const ledger = createBudgetLedger({ counters: [], appliedAllowanceDecisionDigests });
    appliedAllowanceDecisionDigests[0] = sha256Digest("e".repeat(64));

    expect(ledger.appliedAllowanceDecisionDigests).toEqual([earlierDigest, laterDigest]);
    expect(Object.isFrozen(ledger.appliedAllowanceDecisionDigests)).toBe(true);
    expectBudgetError("duplicate-allowance", () =>
      createBudgetLedger({
        counters: [],
        appliedAllowanceDecisionDigests: [earlierDigest, earlierDigest],
      }),
    );
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid effective limit %s",
    (limit) => {
      expectBudgetError("invalid-ledger", () =>
        createBudgetLedger({
          counters: [{ unit: "work-attempt", limit, used: 0 }],
          appliedAllowanceDecisionDigests: [],
        }),
      );
    },
  );

  it("rejects invalid usage, duplicate units, unconfigured units, and overflow-safe amounts", () => {
    expectBudgetError("invalid-ledger", () =>
      createBudgetLedger({
        counters: [{ unit: "work-attempt", limit: 2, used: 3 }],
        appliedAllowanceDecisionDigests: [],
      }),
    );
    expectBudgetError("duplicate-budget", () =>
      createBudgetLedger({
        counters: [
          { unit: "work-attempt", limit: 2, used: 0 },
          { unit: "work-attempt", limit: 3, used: 0 },
        ],
        appliedAllowanceDecisionDigests: [],
      }),
    );
    const ledger = createBudgetLedger({
      counters: [{ unit: "work-attempt", limit: Number.MAX_SAFE_INTEGER, used: 1 }],
      appliedAllowanceDecisionDigests: [],
    });
    expectBudgetError("budget-not-configured", () =>
      consumeBudget(ledger, { unit: "sensor-retry", amount: 1 }),
    );
    expectBudgetError("invalid-consumption", () =>
      consumeBudget(ledger, { unit: "work-attempt", amount: Number.MAX_SAFE_INTEGER + 1 }),
    );
  });

  it("rejects exact-key additions, sparse arrays, and accessors without invoking them", () => {
    expectBudgetError("invalid-ledger", () => createBudgetLedger({ counters: [] } as never));
    expectBudgetError("invalid-ledger", () =>
      createBudgetLedger({
        counters: [],
        appliedAllowanceDecisionDigests: [],
        status: "active",
      } as never),
    );
    expectBudgetError("invalid-ledger", () =>
      createBudgetLedger({ counters: Array(1), appliedAllowanceDecisionDigests: [] } as never),
    );
    let getterCalls = 0;
    const input = Object.defineProperties(
      {},
      {
        counters: {
          enumerable: true,
          get() {
            getterCalls += 1;
            return [];
          },
        },
        appliedAllowanceDecisionDigests: { enumerable: true, value: [] },
      },
    );
    expectBudgetError("invalid-ledger", () => createBudgetLedger(input as never));
    expect(getterCalls).toBe(0);
  });
});

describe("escalations", () => {
  it("creates an immutable digest-bound budget escalation with canonical set ordering", () => {
    const input = escalationInput();
    const escalation = createEscalation(input, deterministicSha256);
    input.allowedResponses[0] = "end-run";
    input.attemptFacts[0] = {
      kind: "work-attempt",
      ordinal: 2,
      factDigest: sha256Digest("d".repeat(64)),
    };

    expect(escalation.owner).toEqual({
      kind: "task",
      taskId: taskId("task_compile"),
      definitionGeneration: definitionGeneration(2),
      contextRevisionDigest: CONTEXT_DIGEST,
    });
    expect(escalation.allowedResponses).toEqual(["end-run", "grant-additional", "reassign"]);
    expect(escalation.attemptFacts[0]?.ordinal).toBe(1);
    expect(escalation.escalationDigest).toBe(
      "fbb99c16fbb99c16fbb99c16fbb99c16fbb99c16fbb99c16fbb99c16fbb99c16",
    );
    expect(Object.isFrozen(escalation)).toBe(true);
    expect(Object.isFrozen(escalation.owner)).toBe(true);
    expect(Object.isFrozen(escalation.attemptFacts)).toBe(true);
  });

  it("creates a blocked escalation for an exact phase owner", () => {
    const input = escalationInput();
    const escalation = createEscalation(
      {
        ...input,
        owner: {
          kind: "phase",
          phaseId: phaseId("phase_build"),
          definitionGeneration: definitionGeneration(2),
          contextRevisionDigest: CONTEXT_DIGEST,
        },
        trigger: { kind: "blocked" },
      },
      deterministicSha256,
    );

    expect(escalation.trigger).toEqual({ kind: "blocked" });
    expect(escalation.owner.kind).toBe("phase");
  });

  it("rejects forged identities, extra keys, duplicate responses, and duplicate evidence lists", () => {
    expectBudgetError("invalid-escalation", () =>
      createEscalation(
        { ...escalationInput(), escalationId: "escalation_BROKEN" as never },
        deterministicSha256,
      ),
    );
    expectBudgetError("invalid-escalation", () =>
      createEscalation({ ...escalationInput(), closure: true } as never, deterministicSha256),
    );
    const duplicateResponse = escalationInput();
    duplicateResponse.allowedResponses.push("reassign");
    expectBudgetError("duplicate-allowed-response", () =>
      createEscalation(duplicateResponse, deterministicSha256),
    );
    const duplicateCriterion = escalationInput();
    duplicateCriterion.unresolvedCriterionIds.push(criterionId("criterion_tests"));
    expectBudgetError("duplicate-criterion", () =>
      createEscalation(duplicateCriterion, deterministicSha256),
    );
    const duplicateReading = escalationInput();
    duplicateReading.unknownReadingDigests.push(duplicateReading.failedReadingDigests[0] as never);
    expectBudgetError("duplicate-reading", () =>
      createEscalation(duplicateReading, deterministicSha256),
    );
  });

  it("rejects sparse arrays, accessors, invalid trigger facts, and forged owner IDs", () => {
    expectBudgetError("invalid-escalation", () =>
      createEscalation(
        { ...escalationInput(), attemptFacts: Array(1) } as never,
        deterministicSha256,
      ),
    );
    let getterCalls = 0;
    const input = escalationInput();
    Object.defineProperty(input, "timestamp", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "2026-08-12T09:30:00Z";
      },
    });
    expectBudgetError("invalid-escalation", () => createEscalation(input, deterministicSha256));
    expect(getterCalls).toBe(0);
    const validEscalation = createEscalation(escalationInput(), deterministicSha256);
    const accessorEscalation = Object.defineProperty(
      { ...validEscalation, escalationDigest: undefined },
      "escalationDigest",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return validEscalation.escalationDigest;
        },
      },
    );
    expectBudgetError("invalid-escalation", () =>
      validateEscalation(accessorEscalation, deterministicSha256),
    );
    expect(getterCalls).toBe(0);
    expectBudgetError("invalid-escalation", () =>
      createEscalation(
        {
          ...escalationInput(),
          trigger: {
            kind: "budget-exhausted",
            fact: {
              unit: "work-attempt",
              limit: 3,
              used: 2,
              requested: 1,
              remaining: 1,
            },
          },
        },
        deterministicSha256,
      ),
    );
    expectBudgetError("invalid-escalation", () =>
      createEscalation(
        {
          ...escalationInput(),
          owner: {
            kind: "task",
            taskId: "phase_build" as never,
            definitionGeneration: definitionGeneration(2),
            contextRevisionDigest: CONTEXT_DIGEST,
          },
        },
        deterministicSha256,
      ),
    );
  });
});

describe("additional allowance decisions", () => {
  it("binds authority and escalation content, increases only the limit, and keeps usage", () => {
    const escalation = createEscalation(escalationInput(), deterministicSha256);
    const authorityFact: { authority: string; approval: string } = { ...AUTHORITY_FACT };
    const decision = createAdditionalAllowanceDecision(
      {
        escalationDigest: escalation.escalationDigest,
        unit: "work-attempt",
        additionalLimit: 2,
        authorityFact,
      },
      deterministicSha256,
    );
    authorityFact.approval = "revoked";
    const ledger = createBudgetLedger({
      counters: [
        { unit: "work-attempt", limit: 3, used: 3 },
        { unit: "sensor-retry", limit: 4, used: 1 },
      ],
      appliedAllowanceDecisionDigests: [],
    });
    const updated = applyAdditionalAllowance(
      ledger,
      escalation,
      decision,
      ALLOWANCE_POLICY,
      deterministicSha256,
    );

    expect(decision.authorityFact).toEqual({ authority: "operator", approval: "approved" });
    expect(decision.decisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(budgetCounter(updated, "work-attempt")).toEqual({
      unit: "work-attempt",
      limit: 5,
      used: 3,
    });
    expect(budgetCounter(updated, "sensor-retry")).toEqual(budgetCounter(ledger, "sensor-retry"));
    expect(updated.appliedAllowanceDecisionDigests).toEqual([decision.decisionDigest]);
    expect(Object.isFrozen(updated.appliedAllowanceDecisionDigests)).toBe(true);
    expect(budgetCounter(ledger, "work-attempt")?.limit).toBe(3);
  });

  it("refuses replay without changing the already-applied allowance", () => {
    const escalation = createEscalation(escalationInput(), deterministicSha256);
    const decision = allowanceDecision(escalation.escalationDigest);
    const ledger = createBudgetLedger({
      counters: [{ unit: "work-attempt", limit: 3, used: 2 }],
      appliedAllowanceDecisionDigests: [],
    });
    const updated = applyAdditionalAllowance(
      ledger,
      escalation,
      decision,
      ALLOWANCE_POLICY,
      deterministicSha256,
    );

    expectBudgetError("duplicate-allowance", () =>
      applyAdditionalAllowance(
        updated,
        escalation,
        decision,
        ALLOWANCE_POLICY,
        deterministicSha256,
      ),
    );
    expect(budgetCounter(updated, "work-attempt")).toEqual({
      unit: "work-attempt",
      limit: 4,
      used: 2,
    });
  });

  it("rejects wrong authority, wrong unit, and excessive additional limits", () => {
    const escalation = createEscalation(escalationInput(), deterministicSha256);
    const ledger = createBudgetLedger({
      counters: [
        { unit: "work-attempt", limit: 3, used: 3 },
        { unit: "sensor-retry", limit: 3, used: 1 },
      ],
      appliedAllowanceDecisionDigests: [],
    });
    const wrongAuthority = createAdditionalAllowanceDecision(
      {
        escalationDigest: escalation.escalationDigest,
        unit: "work-attempt",
        additionalLimit: 1,
        authorityFact: { authority: "different-operator", approval: "approved" },
      },
      deterministicSha256,
    );
    expectBudgetError("allowance-authority-mismatch", () =>
      applyAdditionalAllowance(
        ledger,
        escalation,
        wrongAuthority,
        ALLOWANCE_POLICY,
        deterministicSha256,
      ),
    );
    const wrongUnit = createAdditionalAllowanceDecision(
      {
        escalationDigest: escalation.escalationDigest,
        unit: "sensor-retry",
        additionalLimit: 1,
        authorityFact: AUTHORITY_FACT,
      },
      deterministicSha256,
    );
    expectBudgetError("allowance-unit-not-authorized", () =>
      applyAdditionalAllowance(
        ledger,
        escalation,
        wrongUnit,
        ALLOWANCE_POLICY,
        deterministicSha256,
      ),
    );
    const tooLarge = createAdditionalAllowanceDecision(
      {
        escalationDigest: escalation.escalationDigest,
        unit: "work-attempt",
        additionalLimit: 3,
        authorityFact: AUTHORITY_FACT,
      },
      deterministicSha256,
    );
    expectBudgetError("allowance-limit-exceeded", () =>
      applyAdditionalAllowance(ledger, escalation, tooLarge, ALLOWANCE_POLICY, deterministicSha256),
    );
  });

  it("rejects mismatched, unauthorized, forged, and overflowing allowance decisions", () => {
    const escalation = createEscalation(escalationInput(), deterministicSha256);
    const decision = allowanceDecision(escalation.escalationDigest);
    const ledger = createBudgetLedger({
      counters: [{ unit: "work-attempt", limit: Number.MAX_SAFE_INTEGER, used: 1 }],
      appliedAllowanceDecisionDigests: [],
    });
    expectBudgetError("budget-overflow", () =>
      applyAdditionalAllowance(ledger, escalation, decision, ALLOWANCE_POLICY, deterministicSha256),
    );

    const otherEscalation = createEscalation(
      { ...escalationInput(), escalationId: escalationId("escalation_other") },
      deterministicSha256,
    );
    expectBudgetError("allowance-mismatch", () =>
      applyAdditionalAllowance(
        ledger,
        otherEscalation,
        decision,
        ALLOWANCE_POLICY,
        deterministicSha256,
      ),
    );
    const unauthorized = createEscalation(
      { ...escalationInput(), allowedResponses: ["end-run"] },
      deterministicSha256,
    );
    const unauthorizedDecision = createAdditionalAllowanceDecision(
      {
        escalationDigest: unauthorized.escalationDigest,
        unit: "work-attempt",
        additionalLimit: 1,
        authorityFact: AUTHORITY_FACT,
      },
      deterministicSha256,
    );
    expectBudgetError("allowance-not-authorized", () =>
      applyAdditionalAllowance(
        ledger,
        unauthorized,
        unauthorizedDecision,
        ALLOWANCE_POLICY,
        deterministicSha256,
      ),
    );
    expectBudgetError("invalid-allowance", () =>
      applyAdditionalAllowance(
        ledger,
        escalation,
        { ...decision, decisionDigest: sha256Digest("f".repeat(64)) },
        ALLOWANCE_POLICY,
        deterministicSha256,
      ),
    );
    expectBudgetError("invalid-allowance", () =>
      applyAdditionalAllowance(
        ledger,
        escalation,
        decision,
        { ...ALLOWANCE_POLICY, maxAdditionalLimit: 3 },
        deterministicSha256,
      ),
    );
    const unboundPolicy = createAllowanceAuthorityPolicy(
      {
        authorityFact: AUTHORITY_FACT,
        allowedUnits: ["work-attempt"],
        maxAdditionalLimit: 1,
      },
      deterministicSha256,
    );
    expectBudgetError("allowance-not-authorized", () =>
      applyAdditionalAllowance(ledger, escalation, decision, unboundPolicy, deterministicSha256),
    );
  });
});

function allowanceDecision(escalationDigest: ReturnType<typeof sha256Digest>) {
  return createAdditionalAllowanceDecision(
    {
      escalationDigest,
      unit: "work-attempt",
      additionalLimit: 1,
      authorityFact: AUTHORITY_FACT,
    },
    deterministicSha256,
  );
}

function escalationInput(): EscalationInput & {
  allowedResponses: ("grant-additional" | "reassign" | "end-run")[];
  unresolvedCriterionIds: ReturnType<typeof criterionId>[];
  failedReadingDigests: ReturnType<typeof sha256Digest>[];
  unknownReadingDigests: ReturnType<typeof sha256Digest>[];
  attemptFacts: {
    kind: "work-attempt";
    ordinal: number;
    factDigest: ReturnType<typeof sha256Digest>;
  }[];
} {
  return {
    escalationId: escalationId("escalation_compile-budget"),
    owner: {
      kind: "task",
      taskId: taskId("task_compile"),
      definitionGeneration: definitionGeneration(2),
      contextRevisionDigest: CONTEXT_DIGEST,
    },
    trigger: {
      kind: "budget-exhausted",
      fact: {
        unit: "work-attempt",
        limit: 3,
        used: 3,
        requested: 1,
        remaining: 0,
      },
    },
    contextDigest: CONTEXT_DIGEST,
    candidateDigest: CANDIDATE_DIGEST,
    policyDigest: ALLOWANCE_POLICY.policyDigest,
    unresolvedCriterionIds: [criterionId("criterion_tests")],
    failedReadingDigests: [sha256Digest("e".repeat(64))],
    unknownReadingDigests: [sha256Digest("f".repeat(64))],
    attemptFacts: [
      {
        kind: "work-attempt",
        ordinal: 1,
        factDigest: sha256Digest("d".repeat(64)),
      },
    ],
    allowedResponses: ["reassign", "grant-additional", "end-run"],
    timestamp: "2026-08-12T09:30:00Z",
  };
}

function expectBudgetError(code: BudgetErrorCode, operation: () => unknown): void {
  try {
    operation();
    throw new Error(`Expected BudgetError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetError);
    expect((error as BudgetError).code).toBe(code);
  }
}
