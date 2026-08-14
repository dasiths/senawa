import {
  decodePortalAllowanceReview,
  type PortalAllowanceReview,
  type PortalHumanNeed,
  type PortalRunOverview,
} from "@senawa/protocol";
import type { CommandDraft } from "./pending.js";

export function allowanceReviewFromSource(source: unknown): PortalAllowanceReview | undefined {
  try {
    return decodePortalAllowanceReview(source);
  } catch {
    return undefined;
  }
}

export function allowanceReviewIsCurrent(
  need: PortalHumanNeed,
  source: unknown,
  overview: PortalRunOverview,
): boolean {
  const review = allowanceReviewFromSource(source);
  return (
    review !== undefined &&
    need.kind === "escalation" &&
    need.allowedCommands.includes("grant-allowance") &&
    need.sourceId === review.escalationCommandId &&
    need.sourceDigest === review.escalationDigest &&
    need.exactObjectDigest === review.escalationDigest &&
    review.repositoryId === overview.repositoryId &&
    review.runId === overview.runId &&
    review.expectedGraphRevision === overview.sync.graphRevision &&
    review.expectedRunMode === overview.mode &&
    review.expectedRunModeRevision === overview.runModeRevision
  );
}

export function allowanceResult(review: PortalAllowanceReview, increaseBy: number): number {
  if (!Number.isSafeInteger(increaseBy) || increaseBy < 1 || increaseBy > review.maxIncrease) {
    throw new Error(`Allowance increase must be between 1 and ${review.maxIncrease}`);
  }
  return review.currentLimit + increaseBy;
}

export function allowanceCommandDraft(
  need: PortalHumanNeed,
  source: unknown,
  overview: PortalRunOverview,
  increaseByText: string | undefined,
): CommandDraft {
  if (!allowanceReviewIsCurrent(need, source, overview)) {
    throw new Error("Allowance review is stale or incomplete");
  }
  const review = decodePortalAllowanceReview(source);
  const increaseBy = Number(increaseByText);
  allowanceResult(review, increaseBy);
  return Object.freeze({
    repositoryId: review.repositoryId,
    runId: review.runId,
    intent: "grant-allowance",
    payload: {
      escalationCommandId: review.escalationCommandId,
      operationId: review.operationId,
      escalationDigest: review.escalationDigest,
      policyDigest: review.allowancePolicyDigest,
      unit: review.unit,
      expectedLimit: review.currentLimit,
      expectedRunModeRevision: review.expectedRunModeRevision,
      increaseBy,
    },
    expectedGraphRevision: review.expectedGraphRevision,
    exactObjectDigest: review.escalationDigest,
  });
}
