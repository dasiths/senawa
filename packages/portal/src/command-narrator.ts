import type { DurableReceipt } from "@senawa/protocol";
import { isTerminalReceipt } from "./pending.js";
import type { PendingCanonicalSubmission } from "./state.js";

export type CommandNarrationPhase = "submitted" | "acknowledged" | "resolved";

export interface CommandNarration {
  readonly commandId: string;
  readonly intent: string;
  readonly phase: CommandNarrationPhase;
  readonly receiptStatus?: string;
  /** Why the authority refused, which is the only part a person can act on. */
  readonly reason?: string;
}

export const IDLE_NARRATION = "No command has been submitted from this browser.";

/** Narration follows the one pending-command mechanism; it never tracks a command of its own. */
export function narrateSubmission(pending: PendingCanonicalSubmission): CommandNarration {
  return Object.freeze({
    commandId: pending.commandId,
    intent: pending.intent,
    phase: "submitted" as const,
  });
}

export function narrateReceipt(
  narration: CommandNarration | undefined,
  receipt: DurableReceipt,
): CommandNarration | undefined {
  if (narration === undefined || narration.commandId !== receipt.commandId) return narration;
  const reason = receipt.error?.message;
  return Object.freeze({
    commandId: narration.commandId,
    intent: narration.intent,
    phase: isTerminalReceipt(receipt) ? ("resolved" as const) : ("acknowledged" as const),
    receiptStatus: receipt.status,
    ...(reason === undefined ? {} : { reason }),
  });
}

export function narrateCleared(
  narration: CommandNarration | undefined,
  commandId: string,
): CommandNarration | undefined {
  if (narration === undefined || narration.commandId !== commandId) return narration;
  if (narration.phase === "resolved") return narration;
  return Object.freeze({ ...narration, phase: "resolved" as const });
}

export function narrationText(narration: CommandNarration | undefined): string {
  if (narration === undefined) return IDLE_NARRATION;
  if (narration.phase === "submitted") return `${narration.intent} is submitting`;
  if (narration.receiptStatus === undefined) {
    return narration.phase === "resolved"
      ? `${narration.intent} resolved without a receipt`
      : `${narration.intent} is in progress`;
  }
  // "answer-question refused" tells a person nothing they can act on, and the
  // dialog closes on refusal, so this line is all that is left of the attempt.
  const reason = narration.reason === undefined ? "" : `: ${narration.reason}`;
  return narration.phase === "resolved"
    ? `${narration.intent} ${narration.receiptStatus}${reason}`
    : `${narration.intent} is ${narration.receiptStatus}${reason}`;
}

export function narrationBusy(narration: CommandNarration | undefined): boolean {
  return narration !== undefined && narration.phase !== "resolved";
}
