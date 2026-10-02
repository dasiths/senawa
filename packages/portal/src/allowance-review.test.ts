import { type PortalAllowanceReview, PROTOCOL_VERSION } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import {
  allowanceCommandDraft,
  allowanceResult,
  allowanceReviewIsCurrent,
} from "./allowance-review.js";

const digest = (character: string) => character.repeat(64);
const review: PortalAllowanceReview = {
  apiVersion: PROTOCOL_VERSION,
  repositoryId: "repository_alpha",
  runId: "run_alpha",
  escalationCommandId: "runner-command_alpha",
  escalationDigest: digest("a"),
  operationId: "operation_alpha",
  unit: "model-millidollars",
  requested: 5,
  available: 1,
  createdAt: "2026-08-14T12:00:00.000Z",
  currentLimit: 10,
  maxIncrease: 15,
  ceiling: 25,
  allowancePolicyDigest: digest("b"),
  resultingMax: 25,
  expectedGraphRevision: digest("c"),
  expectedRunMode: "running",
  expectedRunModeRevision: 2,
};
const need = {
  needId: "need_escalation:runner-command_alpha",
  kind: "escalation",
  sourceId: review.escalationCommandId,
  sourceDigest: review.escalationDigest,
  sourceRevision: 4,
  title: "Budget allowance requested",
  createdAt: review.createdAt,
  exactObjectDigest: review.escalationDigest,
  allowedCommands: ["grant-allowance"],
} as const;
const overview = {
  apiVersion: PROTOCOL_VERSION,
  repositoryId: review.repositoryId,
  runId: review.runId,
  displayName: "Run alpha",
  workflowName: "workflow",
  mode: "running",
  runModeRevision: 2,
  terminal: false,
  updatedAt: review.createdAt,
  sync: {
    workflowCursor: 1,
    contextRevision: 1,
    runnerRevision: 1,
    workspaceRevision: 1,
    humanRevision: 1,
    portalRevision: 1,
    transcriptRevision: 1,
    graphRevision: review.expectedGraphRevision,
    lifecycleRevision: 1,
  },
  counts: {
    phases: 1,
    closedPhases: 0,
    tasks: 1,
    criteria: 1,
    humanNeeds: 1,
    activeEffects: 0,
    uncertainEffects: 0,
  },
} as const;

describe("allowance review view model", () => {
  it("builds the exact authority-bound grant payload and resulting limit", () => {
    expect(allowanceReviewIsCurrent(need, review, overview)).toBe(true);
    expect(allowanceResult(review, 4)).toBe(14);
    expect(allowanceCommandDraft(need, review, overview, "4")).toEqual({
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
        increaseBy: 4,
      },
      expectedGraphRevision: review.expectedGraphRevision,
      exactObjectDigest: review.escalationDigest,
    });
  });

  it("fails closed on stale guards, tampering, and increases above authority", () => {
    expect(
      allowanceReviewIsCurrent(need, review, {
        ...overview,
        runModeRevision: overview.runModeRevision + 1,
      }),
    ).toBe(false);
    expect(() => allowanceCommandDraft(need, { ...review, ceiling: 30 }, overview, "4")).toThrow(
      /stale or incomplete/,
    );
    expect(() => allowanceCommandDraft(need, review, overview, "16")).toThrow(/between 1 and 15/);
  });
});
