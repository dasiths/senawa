import type { DurableReceipt } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import {
  IDLE_NARRATION,
  narrateCleared,
  narrateReceipt,
  narrateSubmission,
  narrationBusy,
  narrationText,
} from "./command-narrator.js";
import type { PendingCanonicalSubmission } from "./state.js";

const pending: PendingCanonicalSubmission = Object.freeze({
  commandId: "command_one",
  canonicalSubmission: "{}",
  payloadDigest: "digest",
  intent: "answer-question",
  repositoryId: "repository_one",
  runId: "run_one",
  storedAt: "2026-08-15T00:00:00.000Z",
  exactRetryUsed: false,
});

function receipt(commandId: string, status: string): DurableReceipt {
  return {
    apiVersion: "senawa.dev/protocol/v1",
    commandId,
    repositoryId: "repository_one",
    runId: "run_one",
    cursor: 1,
    status,
    recordedAt: "2026-08-15T00:00:01.000Z",
  } as unknown as DurableReceipt;
}

describe("command narrator", () => {
  it("names no command until one is submitted", () => {
    expect(narrationText(undefined)).toBe(IDLE_NARRATION);
    expect(narrationBusy(undefined)).toBe(false);
  });

  it("announces submission, acknowledgement, and resolution of one command", () => {
    const submitted = narrateSubmission(pending);
    expect(narrationText(submitted)).toBe("answer-question is submitting");
    expect(narrationBusy(submitted)).toBe(true);

    const running = narrateReceipt(submitted, receipt("command_one", "running"));
    expect(running?.phase).toBe("acknowledged");
    expect(narrationText(running)).toBe("answer-question is running");
    expect(narrationBusy(running)).toBe(true);

    const completed = narrateReceipt(running, receipt("command_one", "completed"));
    expect(completed?.phase).toBe("resolved");
    expect(narrationText(completed)).toBe("answer-question completed");
    expect(narrationBusy(completed)).toBe(false);
  });

  it("treats every terminal receipt status as resolved", () => {
    const submitted = narrateSubmission(pending);
    for (const status of ["completed", "refused", "expired", "cancelled", "unknown-effect"]) {
      expect(narrateReceipt(submitted, receipt("command_one", status))?.phase).toBe("resolved");
    }
  });

  it("ignores receipts and clears for another command", () => {
    const submitted = narrateSubmission(pending);
    expect(narrateReceipt(submitted, receipt("command_two", "completed"))).toBe(submitted);
    expect(narrateCleared(submitted, "command_two")).toBe(submitted);
    expect(narrateReceipt(undefined, receipt("command_one", "completed"))).toBeUndefined();
  });

  it("resolves a cleared command that never reported a terminal receipt", () => {
    const cleared = narrateCleared(narrateSubmission(pending), "command_one");
    expect(cleared?.phase).toBe("resolved");
    expect(narrationText(cleared)).toBe("answer-question resolved without a receipt");
    expect(narrationBusy(cleared)).toBe(false);
    expect(narrateCleared(cleared, "command_one")).toBe(cleared);
  });
});
