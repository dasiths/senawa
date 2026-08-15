import {
  type BudgetExhaustedFact,
  type BudgetLedger,
  consumeBudget,
  createBudgetLedger,
} from "./budgets.js";
import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import type { PhaseAttemptReference } from "./dataflow.js";
import { isDefinitionGeneration, isPhaseId, isRunId, type RunId } from "./identity.js";

export const PHASE_ATTEMPT_TRANSITION_API_VERSION = "senawa.dev/phase-attempt-transition/v1alpha1";

export type PhaseAttemptTransitionTrigger =
  | "gate-rejected"
  | "approval-rejected"
  | "upstream-changed"
  | "closure-created";

export interface PhaseIterationPolicy {
  readonly maxAttempts: number;
  readonly upstreamChange: "refuse" | "iterate";
  readonly exhaustion: "escalate" | "fail";
}

export interface PhaseAttemptTransitionInput {
  readonly repositoryId: string;
  readonly runId: RunId;
  readonly phase: PhaseAttemptReference;
  readonly attemptDigest: Sha256Digest;
  readonly predecessorTransitionDigest?: Sha256Digest;
  readonly trigger: PhaseAttemptTransitionTrigger;
  readonly triggerDigest: Sha256Digest;
  readonly policyDigest: Sha256Digest;
}

export interface PhaseAttemptTransition extends PhaseAttemptTransitionInput {
  readonly apiVersion: typeof PHASE_ATTEMPT_TRANSITION_API_VERSION;
  readonly disposition: "iterate" | "escalate" | "fail" | "closed" | "refused";
  readonly nextAttempt?: PhaseAttemptReference;
  readonly exhaustedFact?: BudgetExhaustedFact;
  readonly transitionDigest: Sha256Digest;
}

export interface PlanPhaseAttemptTransitionInput extends PhaseAttemptTransitionInput {
  readonly policy: PhaseIterationPolicy;
  readonly budgetLedger: BudgetLedger;
}

export interface PlannedPhaseAttemptTransition {
  readonly transition: PhaseAttemptTransition;
  readonly budgetLedger: BudgetLedger;
}

export class IterationError extends Error {
  readonly code: "invalid-iteration" | "attempt-limit-mismatch";

  constructor(code: IterationError["code"], message: string) {
    super(message);
    this.name = "IterationError";
    this.code = code;
  }
}

export function planPhaseAttemptTransition(
  input: PlanPhaseAttemptTransitionInput,
  sha256: Sha256,
): PlannedPhaseAttemptTransition {
  const snapshot = canonicalValue(input) as unknown as PlanPhaseAttemptTransitionInput;
  validateTransitionInput(snapshot);
  validatePolicy(snapshot.policy);
  const ledger = createBudgetLedger(snapshot.budgetLedger);
  const expectedPolicyDigest = canonicalDigest(canonicalValue(snapshot.policy), sha256);
  if (snapshot.policyDigest !== expectedPolicyDigest) {
    fail("invalid-iteration", "Phase iteration policy digest does not match its policy");
  }

  if (snapshot.trigger === "closure-created") {
    return planned(snapshot, "closed", ledger, sha256);
  }
  if (snapshot.trigger === "upstream-changed" && snapshot.policy.upstreamChange === "refuse") {
    return planned(snapshot, "refused", ledger, sha256);
  }
  if (snapshot.phase.attempt >= snapshot.policy.maxAttempts) {
    return planned(snapshot, snapshot.policy.exhaustion, ledger, sha256, {
      unit: "review-iteration",
      limit: snapshot.policy.maxAttempts,
      used: snapshot.phase.attempt,
      requested: 1,
      remaining: 0,
    });
  }

  const consumption = consumeBudget(ledger, { unit: "review-iteration", amount: 1 });
  if (consumption.outcome === "exhausted") {
    return planned(
      snapshot,
      snapshot.policy.exhaustion,
      ledger,
      sha256,
      consumption.exhaustedFacts[0],
    );
  }
  return planned(snapshot, "iterate", consumption.ledger, sha256);
}

export function validatePhaseAttemptTransition(
  value: unknown,
  sha256: Sha256,
): PhaseAttemptTransition {
  const snapshot = canonicalValue(value) as unknown as PhaseAttemptTransition;
  validateTransitionInput(snapshot);
  if (!["iterate", "escalate", "fail", "closed", "refused"].includes(snapshot.disposition)) {
    fail("invalid-iteration", "Phase attempt transition disposition is not recognized");
  }
  const expected = compileTransition(
    snapshot,
    snapshot.disposition,
    sha256,
    snapshot.exhaustedFact,
  );
  if (
    canonicalSerialize(snapshot as unknown as CanonicalValue) !==
    canonicalSerialize(canonicalValue(expected))
  ) {
    fail("invalid-iteration", "Phase attempt transition does not match canonical authority");
  }
  return expected;
}

function planned(
  input: PhaseAttemptTransitionInput,
  disposition: PhaseAttemptTransition["disposition"],
  budgetLedger: BudgetLedger,
  sha256: Sha256,
  exhaustedFact?: BudgetExhaustedFact,
): PlannedPhaseAttemptTransition {
  return canonicalValue({
    transition: compileTransition(input, disposition, sha256, exhaustedFact),
    budgetLedger,
  }) as unknown as PlannedPhaseAttemptTransition;
}

function compileTransition(
  input: PhaseAttemptTransitionInput,
  disposition: PhaseAttemptTransition["disposition"],
  sha256: Sha256,
  exhaustedFact?: BudgetExhaustedFact,
): PhaseAttemptTransition {
  const content = {
    repositoryId: input.repositoryId,
    runId: input.runId,
    phase: input.phase,
    attemptDigest: input.attemptDigest,
    ...(input.predecessorTransitionDigest === undefined
      ? {}
      : { predecessorTransitionDigest: input.predecessorTransitionDigest }),
    trigger: input.trigger,
    triggerDigest: input.triggerDigest,
    policyDigest: input.policyDigest,
    disposition,
    ...(disposition === "iterate"
      ? {
          nextAttempt: {
            ...input.phase,
            attempt: input.phase.attempt + 1,
          },
        }
      : {}),
    ...(exhaustedFact === undefined ? {} : { exhaustedFact }),
  };
  const transitionDigest = canonicalDigest(
    canonicalValue({ apiVersion: PHASE_ATTEMPT_TRANSITION_API_VERSION, ...content }),
    sha256,
  );
  return canonicalValue({
    apiVersion: PHASE_ATTEMPT_TRANSITION_API_VERSION,
    ...content,
    transitionDigest,
  }) as unknown as PhaseAttemptTransition;
}

function validateTransitionInput(input: PhaseAttemptTransitionInput): void {
  if (
    typeof input.repositoryId !== "string" ||
    input.repositoryId.length === 0 ||
    input.repositoryId.length > 256 ||
    !isRunId(input.runId) ||
    !isPhaseId(input.phase?.phaseId) ||
    !isDefinitionGeneration(input.phase?.definitionGeneration) ||
    !Number.isSafeInteger(input.phase?.attempt) ||
    input.phase.attempt < 1 ||
    !isSha256Digest(input.attemptDigest) ||
    (input.predecessorTransitionDigest !== undefined &&
      !isSha256Digest(input.predecessorTransitionDigest)) ||
    !isSha256Digest(input.triggerDigest) ||
    !isSha256Digest(input.policyDigest) ||
    !["gate-rejected", "approval-rejected", "upstream-changed", "closure-created"].includes(
      input.trigger,
    )
  ) {
    fail("invalid-iteration", "Phase attempt transition input is invalid");
  }
}

function validatePolicy(policy: PhaseIterationPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    !["refuse", "iterate"].includes(policy.upstreamChange) ||
    !["escalate", "fail"].includes(policy.exhaustion)
  ) {
    fail("invalid-iteration", "Phase iteration policy must be finite and recognized");
  }
}

function fail(code: IterationError["code"], message: string): never {
  throw new IterationError(code, message);
}
