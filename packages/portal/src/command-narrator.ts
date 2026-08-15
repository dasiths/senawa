import type { DurableReceipt } from "@senawa/protocol";
import { isTerminalReceipt } from "./pending.js";
import type { PendingCanonicalSubmission } from "./state.js";

export type CommandNarrationPhase = "submitted" | "acknowledged" | "resolved";

export interface CommandNarration {
  readonly commandId: string;
  readonly intent: string;
  readonly phase: CommandNarrationPhase;
  readonly receiptStatus?: string;
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
  return Object.freeze({
    commandId: narration.commandId,
    intent: narration.intent,
    phase: isTerminalReceipt(receipt) ? ("resolved" as const) : ("acknowledged" as const),
    receiptStatus: receipt.status,
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
  return narration.phase === "resolved"
    ? `${narration.intent} ${narration.receiptStatus}`
    : `${narration.intent} is ${narration.receiptStatus}`;
}

export function narrationBusy(narration: CommandNarration | undefined): boolean {
  return narration !== undefined && narration.phase !== "resolved";
}
