import { type DurableReceipt, decodeCommandSubmission, PROTOCOL_VERSION } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import {
  clearPortalSession,
  createPendingSubmission,
  loadPending,
  pendingRecoveryDecision,
  type SessionStorageLike,
  savePending,
} from "./pending.js";

class MemoryStorage implements SessionStorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("pending canonical submissions", () => {
  it("persists the exact command and retries it without allocating another identity", async () => {
    const pending = await createPendingSubmission({
      repositoryId: "repository_one",
      runId: "run_one",
      intent: "pause-run",
      payload: { expectedRunModeRevision: 4 },
    });
    const storage = new MemoryStorage();
    savePending(storage, { [pending.commandId]: pending });
    const restored = loadPending(storage)[0];
    if (restored === undefined) throw new Error("Pending command was not restored");
    expect(decodeCommandSubmission(restored.canonicalSubmission).commandId).toBe(pending.commandId);
    expect(pendingRecoveryDecision(restored, undefined)).toEqual({
      type: "retry-exact",
      canonicalSubmission: pending.canonicalSubmission,
    });
    expect(pendingRecoveryDecision({ ...restored, exactRetryUsed: true }, undefined)).toEqual({
      type: "uncertain",
    });
  });

  it("clears only after a terminal receipt decision", async () => {
    const pending = await createPendingSubmission({
      repositoryId: "repository_one",
      runId: "run_one",
      intent: "resume-run",
      payload: { expectedRunModeRevision: 5 },
    });
    const receipt: DurableReceipt = {
      apiVersion: PROTOCOL_VERSION,
      commandId: pending.commandId,
      repositoryId: pending.repositoryId,
      runId: pending.runId,
      status: "completed",
      cursor: 8,
    };
    expect(pendingRecoveryDecision(pending, receipt)).toEqual({ type: "terminal", receipt });
    expect(pendingRecoveryDecision(pending, { ...receipt, status: "claimed" })).toMatchObject({
      type: "wait",
    });
    expect(pendingRecoveryDecision(pending, { ...receipt, commandId: "command_other" })).toEqual({
      type: "uncertain",
    });
    expect(
      pendingRecoveryDecision(pending, { ...receipt, repositoryId: "repository_other" }),
    ).toEqual({ type: "uncertain" });
    expect(pendingRecoveryDecision(pending, { ...receipt, runId: "run_other" })).toEqual({
      type: "uncertain",
    });
  });

  it("removes only session authority and preserves pending recovery bytes", async () => {
    const pending = await createPendingSubmission({
      repositoryId: "repository_one",
      runId: "run_one",
      intent: "pause-run",
      payload: { expectedRunModeRevision: 6 },
    });
    const storage = new MemoryStorage();
    savePending(storage, { [pending.commandId]: pending });
    storage.setItem(
      "senawa.portal.session.v1",
      JSON.stringify({ csrfToken: "x".repeat(43), expiresAt: "2026-08-14T20:00:00.000Z" }),
    );
    clearPortalSession(storage);
    expect(loadPending(storage)).toEqual([pending]);
    expect(storage.getItem("senawa.portal.session.v1")).toBeNull();
  });
});
