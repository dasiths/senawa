import {
  type CommandIntent,
  type CommandSubmission,
  canonicalStringify,
  type DurableReceipt,
  decodeCommandSubmission,
  encodeCommandSubmission,
  type JsonValue,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { PendingCanonicalSubmission } from "./state.js";

const PENDING_KEY = "senawa.portal.pending.v1";
const SESSION_KEY = "senawa.portal.session.v1";
const TERMINAL_RECEIPTS = new Set([
  "completed",
  "refused",
  "expired",
  "cancelled",
  "unknown-effect",
]);

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedPortalSession {
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface CommandDraft {
  readonly repositoryId: string;
  readonly runId: string;
  readonly intent: CommandIntent["type"];
  readonly payload: JsonValue;
  readonly expectedDefinitionRevision?: string;
  readonly expectedGraphRevision?: string;
  readonly exactObjectDigest?: string;
  readonly expiresAt?: string;
}

export type PendingRecoveryDecision =
  | { readonly type: "terminal"; readonly receipt: DurableReceipt }
  | { readonly type: "wait"; readonly receipt: DurableReceipt }
  | { readonly type: "retry-exact"; readonly canonicalSubmission: string }
  | { readonly type: "uncertain" };

export async function createPendingSubmission(
  draft: CommandDraft,
  now = new Date(),
): Promise<PendingCanonicalSubmission> {
  const payloadDigest = await sha256(canonicalStringify(draft.payload));
  const commandId = `command_${crypto.randomUUID()}`;
  const submission: CommandSubmission = {
    apiVersion: PROTOCOL_VERSION,
    commandId,
    repositoryId: draft.repositoryId,
    runId: draft.runId,
    intent: { type: draft.intent },
    payload: draft.payload,
    payloadDigest,
    ...(draft.expectedDefinitionRevision === undefined
      ? {}
      : { expectedDefinitionRevision: draft.expectedDefinitionRevision }),
    ...(draft.expectedGraphRevision === undefined
      ? {}
      : { expectedGraphRevision: draft.expectedGraphRevision }),
    ...(draft.exactObjectDigest === undefined
      ? {}
      : { exactObjectDigest: draft.exactObjectDigest }),
    ...(draft.expiresAt === undefined ? {} : { expiresAt: draft.expiresAt }),
  };
  return Object.freeze({
    commandId,
    canonicalSubmission: encodeCommandSubmission(submission),
    payloadDigest,
    intent: draft.intent,
    repositoryId: draft.repositoryId,
    runId: draft.runId,
    storedAt: now.toISOString(),
    exactRetryUsed: false,
  });
}

export function pendingRecoveryDecision(
  pending: PendingCanonicalSubmission,
  receipt: DurableReceipt | undefined,
): PendingRecoveryDecision {
  if (receipt !== undefined) {
    if (
      receipt.commandId !== pending.commandId ||
      receipt.repositoryId !== pending.repositoryId ||
      receipt.runId !== pending.runId
    ) {
      return Object.freeze({ type: "uncertain" });
    }
    return TERMINAL_RECEIPTS.has(receipt.status)
      ? Object.freeze({ type: "terminal", receipt })
      : Object.freeze({ type: "wait", receipt });
  }
  return pending.exactRetryUsed
    ? Object.freeze({ type: "uncertain" })
    : Object.freeze({ type: "retry-exact", canonicalSubmission: pending.canonicalSubmission });
}

export function savePending(
  storage: SessionStorageLike,
  pending: Readonly<Record<string, PendingCanonicalSubmission>>,
): void {
  const values = Object.values(pending).map(({ receipt: _receipt, ...entry }) => entry);
  if (values.length === 0) {
    storage.removeItem(PENDING_KEY);
    return;
  }
  storage.setItem(PENDING_KEY, canonicalStringify(values));
}

export function loadPending(storage: SessionStorageLike): readonly PendingCanonicalSubmission[] {
  const serialized = storage.getItem(PENDING_KEY);
  if (serialized === null) return Object.freeze([]);
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!Array.isArray(value) || value.length > 100) throw new TypeError("Invalid pending list");
    const commandIds = new Set<string>();
    const pending = value.map((entry) => decodePending(entry));
    for (const item of pending) {
      if (commandIds.has(item.commandId)) throw new TypeError("Duplicate pending command");
      commandIds.add(item.commandId);
    }
    return Object.freeze(pending);
  } catch {
    storage.removeItem(PENDING_KEY);
    return Object.freeze([]);
  }
}

export function savePortalSession(
  storage: SessionStorageLike,
  session: PersistedPortalSession,
): void {
  storage.setItem(SESSION_KEY, canonicalStringify(session));
}

export function loadPortalSession(storage: SessionStorageLike): PersistedPortalSession | undefined {
  const serialized = storage.getItem(SESSION_KEY);
  if (serialized === null) return undefined;
  try {
    const value = JSON.parse(serialized) as Readonly<Record<string, unknown>>;
    if (
      value === null ||
      typeof value !== "object" ||
      Object.keys(value).length !== 2 ||
      typeof value.csrfToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) ||
      typeof value.expiresAt !== "string" ||
      Number.isNaN(Date.parse(value.expiresAt))
    ) {
      throw new TypeError("Invalid portal session");
    }
    return Object.freeze({ csrfToken: value.csrfToken, expiresAt: value.expiresAt });
  } catch {
    storage.removeItem(SESSION_KEY);
    return undefined;
  }
}

export function clearPortalSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}

function pendingStorageKey(): string {
  return PENDING_KEY;
}

export function isTerminalReceipt(receipt: DurableReceipt): boolean {
  return TERMINAL_RECEIPTS.has(receipt.status);
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodePending(value: unknown): PendingCanonicalSubmission {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid pending entry");
  const object = value as Readonly<Record<string, unknown>>;
  const fields = [
    "commandId",
    "canonicalSubmission",
    "payloadDigest",
    "intent",
    "repositoryId",
    "runId",
    "storedAt",
    "exactRetryUsed",
  ];
  if (
    Object.keys(object).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(object, field))
  ) {
    throw new TypeError("Invalid pending fields");
  }
  if (typeof object.canonicalSubmission !== "string")
    throw new TypeError("Invalid pending submission");
  const submission = decodeCommandSubmission(object.canonicalSubmission);
  if (encodeCommandSubmission(submission) !== object.canonicalSubmission)
    throw new TypeError("Noncanonical pending submission");
  if (
    object.commandId !== submission.commandId ||
    object.payloadDigest !== submission.payloadDigest ||
    object.intent !== submission.intent.type ||
    object.repositoryId !== submission.repositoryId ||
    object.runId !== submission.runId ||
    typeof object.storedAt !== "string" ||
    Number.isNaN(Date.parse(object.storedAt)) ||
    typeof object.exactRetryUsed !== "boolean"
  ) {
    throw new TypeError("Pending submission metadata mismatch");
  }
  return Object.freeze({
    commandId: submission.commandId,
    canonicalSubmission: object.canonicalSubmission,
    payloadDigest: submission.payloadDigest,
    intent: submission.intent.type,
    repositoryId: submission.repositoryId,
    runId: submission.runId,
    storedAt: object.storedAt,
    exactRetryUsed: object.exactRetryUsed,
  });
}
