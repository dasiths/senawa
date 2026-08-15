import { describe, expect, it } from "vitest";
import { createBudgetLedger } from "./budgets.js";
import { canonicalDigest, canonicalValue, type Sha256, sha256Digest } from "./canonical.js";
import { definitionGeneration, phaseId, runId } from "./identity.js";
import { planPhaseAttemptTransition } from "./iteration.js";

const sha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const DIGEST = sha256Digest("1".repeat(64));

describe("phase attempt transitions", () => {
  it("iterates rejection append-only within the existing review budget", () => {
    const result = planPhaseAttemptTransition(input(), sha256);

    expect(result.transition).toMatchObject({
      trigger: "gate-rejected",
      disposition: "iterate",
      nextAttempt: { attempt: 2 },
    });
    expect(result.budgetLedger.counters).toEqual([{ unit: "review-iteration", limit: 2, used: 1 }]);
    expect(Object.isFrozen(result.transition)).toBe(true);
  });

  it("makes closure terminal and applies declared exhaustion without consuming beyond bounds", () => {
    const closed = planPhaseAttemptTransition({ ...input(), trigger: "closure-created" }, sha256);
    expect(closed.transition.disposition).toBe("closed");
    expect(closed.transition.nextAttempt).toBeUndefined();

    const exhausted = planPhaseAttemptTransition(
      {
        ...input(),
        phase: { ...input().phase, attempt: 2 },
        budgetLedger: createBudgetLedger({
          counters: [{ unit: "review-iteration", limit: 2, used: 1 }],
          appliedAllowanceDecisionDigests: [],
        }),
      },
      sha256,
    );
    expect(exhausted.transition.disposition).toBe("escalate");
    expect(exhausted.transition.exhaustedFact).toMatchObject({
      unit: "review-iteration",
      limit: 2,
      requested: 1,
      remaining: 0,
    });
    expect(exhausted.budgetLedger.counters[0]?.used).toBe(1);
  });

  it("refuses upstream drift unless policy explicitly iterates", () => {
    const refused = planPhaseAttemptTransition({ ...input(), trigger: "upstream-changed" }, sha256);
    expect(refused.transition.disposition).toBe("refused");
    expect(refused.budgetLedger.counters[0]?.used).toBe(0);
  });
});

function input() {
  const policy = {
    maxAttempts: 2,
    upstreamChange: "refuse" as const,
    exhaustion: "escalate" as const,
  };
  return {
    repositoryId: "repository",
    runId: runId("run_example"),
    phase: {
      phaseId: phaseId("phase_define"),
      definitionGeneration: definitionGeneration(1),
      attempt: 1,
    },
    attemptDigest: DIGEST,
    trigger: "gate-rejected" as const,
    triggerDigest: DIGEST,
    policyDigest: canonicalDigest(canonicalValue(policy), sha256),
    policy,
    budgetLedger: createBudgetLedger({
      counters: [{ unit: "review-iteration", limit: 2, used: 0 }],
      appliedAllowanceDecisionDigests: [],
    }),
  };
}
