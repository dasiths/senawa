import { describe, expect, expectTypeOf, it } from "vitest";
import {
  amendmentId,
  approvalId,
  assetId,
  consumerKey,
  criterionId,
  definitionGeneration,
  dispatchId,
  escalationId,
  eventId,
  isAmendmentId,
  isApprovalId,
  isAssetId,
  isConsumerKey,
  isCriterionId,
  isDefinitionGeneration,
  isDispatchId,
  isEscalationId,
  isEventId,
  isPhaseId,
  isRunId,
  isTaskId,
  isWorkflowId,
  phaseId,
  type RunId,
  runId,
  taskId,
  type WorkflowId,
  workflowId,
} from "./identity.js";

const identityCases = [
  ["workflow_alpha-1", workflowId, isWorkflowId],
  ["run_alpha-1", runId, isRunId],
  ["phase_alpha-1", phaseId, isPhaseId],
  ["task_alpha-1", taskId, isTaskId],
  ["criterion_alpha-1", criterionId, isCriterionId],
  ["asset_alpha-1", assetId, isAssetId],
  ["dispatch_alpha-1", dispatchId, isDispatchId],
  ["approval_alpha-1", approvalId, isApprovalId],
  ["amendment_alpha-1", amendmentId, isAmendmentId],
  ["escalation_alpha-1", escalationId, isEscalationId],
  ["event_alpha-1", eventId, isEventId],
] as const;

describe("opaque identities", () => {
  it.each(identityCases)("constructs and validates %s", (value, construct, validate) => {
    expect(construct(value)).toBe(value);
    expect(validate(value)).toBe(true);
    expect(validate("workflow_wrong-kind")).toBe(value.startsWith("workflow_"));
  });

  it.each(identityCases)("rejects malformed values for %s", (_value, construct, validate) => {
    expect(validate(null)).toBe(false);
    expect(validate("missing-prefix")).toBe(false);
    expect(() => construct("invalid_VALUE")).toThrow(TypeError);
  });

  it("keeps identity kinds distinct in the type system", () => {
    expectTypeOf<WorkflowId>().not.toEqualTypeOf<RunId>();
  });
});

describe("consumer keys", () => {
  it.each(["research", "phase-1", "1-verification", "a"])("accepts %s", (value) => {
    expect(consumerKey(value)).toBe(value);
    expect(isConsumerKey(value)).toBe(true);
  });

  it.each(["", "UPPER", "-leading", "trailing-", "has space", "a".repeat(64)])(
    "rejects %s",
    (value) => {
      expect(isConsumerKey(value)).toBe(false);
      expect(() => consumerKey(value)).toThrow(TypeError);
    },
  );
});

describe("definition generations", () => {
  it("accepts positive safe integers", () => {
    expect(definitionGeneration(1)).toBe(1);
    expect(definitionGeneration(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(isDefinitionGeneration(2)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects %s",
    (value) => {
      expect(isDefinitionGeneration(value)).toBe(false);
      expect(() => definitionGeneration(value)).toThrow(TypeError);
    },
  );
});
