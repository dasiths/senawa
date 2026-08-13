import {
  type CommandEnvelope,
  decodeCanonicalJsonValue,
  type JsonValue,
  type SupervisorAdmissionFacts,
  type SupervisorAllocationFact,
  type SupervisorMode,
  type SupervisorReceipt,
  type SupervisorReceiptStatus,
  type SupervisorWake,
} from "@senawa/protocol";
import type { LeaseGrant } from "@senawa/storage-sqlite";

export type {
  SupervisorAdmissionFacts,
  SupervisorAllocationFact as AllocationFact,
  SupervisorMode,
  SupervisorReceipt,
  SupervisorReceiptStatus,
  SupervisorWake,
};

export interface AuthenticatedCommandAdmission {
  readonly envelope: CommandEnvelope;
  readonly createAdmission: () => SupervisorAdmissionFacts;
}

export interface DrainRunOnceInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly lease: LeaseGrant;
  readonly currentTime: string;
}

export interface PendingSupervisorWake extends SupervisorWake {
  readonly hasPendingWork: boolean;
}

export interface SupervisorClock {
  now(): number;
}

export interface SupervisorRandom {
  bytes(length: number): Uint8Array;
}

export interface RunEventNotifier {
  subscribe(repositoryId: string, runId: string, callback: () => void): () => void;
}

export interface MutableRunEventNotifier extends RunEventNotifier {
  notify(repositoryId: string, runId: string): void;
}

export type SupervisorHealth = "healthy" | "degraded";
export type SupervisorLogLevel = "debug" | "info" | "warn" | "error";

export interface SupervisorListenerStatus {
  readonly kind: "ipc" | "loopback";
  readonly address: string;
}

export interface SupervisorPendingCounts {
  readonly queuedCommands: number;
  readonly claimedCommands: number;
  readonly wakes: number;
  readonly runnerEffects: number;
  readonly completionOutbox: number;
}

export interface SupervisorLeaseStatus {
  readonly repositoryId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAt: string;
}

export interface CopilotSessionStoreHealth {
  readonly status: "healthy" | "degraded" | "unknown";
  readonly expectedSessionCount: number;
  readonly missingSessionIds: readonly string[];
  readonly message?: string;
}

export interface CopilotSessionStoreHealthPort {
  health(expectedSessionIds: readonly string[]): Promise<CopilotSessionStoreHealth>;
}

export interface SupervisorServiceStatus {
  readonly lifecycle: "stopped" | "starting" | "running" | "draining" | "drained" | "stopping";
  readonly mode: SupervisorMode;
  readonly health: SupervisorHealth;
  readonly processId: number;
  readonly startedAt: string;
  readonly listeners: readonly SupervisorListenerStatus[];
  readonly pending: SupervisorPendingCounts;
  readonly leases: readonly SupervisorLeaseStatus[];
  readonly sdkSessionStore: CopilotSessionStoreHealth;
}

export interface SupervisorLogEntry {
  readonly cursor: number;
  readonly recordedAt: string;
  readonly level: SupervisorLogLevel;
  readonly event: string;
  readonly message: string;
  readonly fields: JsonValue;
}

export interface SupervisorLogPage {
  readonly afterCursor: number;
  readonly latestCursor: number;
  readonly hasMore: boolean;
  readonly items: readonly SupervisorLogEntry[];
}

export interface SupervisorRepositoryRegistration {
  readonly repositoryId: string;
  readonly canonicalPath: string;
  readonly configSnapshotId: string;
}

export function decodeSupervisorServiceStatus(input: string | unknown): SupervisorServiceStatus {
  const object = exactObject(input, [
    "lifecycle",
    "mode",
    "health",
    "processId",
    "startedAt",
    "listeners",
    "pending",
    "leases",
    "sdkSessionStore",
  ]);
  const lifecycle = enumValue(object.lifecycle, [
    "stopped",
    "starting",
    "running",
    "draining",
    "drained",
    "stopping",
  ] as const);
  const mode = enumValue(object.mode, ["running", "draining", "drained", "stopped"] as const);
  const health = enumValue(object.health, ["healthy", "degraded"] as const);
  const processId = safeInteger(object.processId, "processId", 1);
  const startedAt = timestampValue(object.startedAt, "startedAt");
  if (!Array.isArray(object.listeners)) throw new TypeError("listeners must be an array");
  const listeners = object.listeners.map((value) => {
    const listener = exactObject(value, ["kind", "address"]);
    return Object.freeze({
      kind: enumValue(listener.kind, ["ipc", "loopback"] as const),
      address: nonControlText(listener.address, "listener address"),
    });
  });
  const pendingObject = exactObject(object.pending, [
    "queuedCommands",
    "claimedCommands",
    "wakes",
    "runnerEffects",
    "completionOutbox",
  ]);
  const pending = Object.freeze({
    queuedCommands: safeInteger(pendingObject.queuedCommands, "queuedCommands", 0),
    claimedCommands: safeInteger(pendingObject.claimedCommands, "claimedCommands", 0),
    wakes: safeInteger(pendingObject.wakes, "wakes", 0),
    runnerEffects: safeInteger(pendingObject.runnerEffects, "runnerEffects", 0),
    completionOutbox: safeInteger(pendingObject.completionOutbox, "completionOutbox", 0),
  });
  if (!Array.isArray(object.leases)) throw new TypeError("leases must be an array");
  const leases = object.leases.map((value) => {
    const lease = exactObject(value, ["repositoryId", "runId", "ownerId", "fence", "expiresAt"]);
    return Object.freeze({
      repositoryId: nonControlText(lease.repositoryId, "repositoryId"),
      runId: nonControlText(lease.runId, "runId"),
      ownerId: nonControlText(lease.ownerId, "ownerId"),
      fence: safeInteger(lease.fence, "fence", 1),
      expiresAt: timestampValue(lease.expiresAt, "expiresAt"),
    });
  });
  const sdkObject = exactObject(
    object.sdkSessionStore,
    ["status", "expectedSessionCount", "missingSessionIds"],
    ["message"],
  );
  if (!Array.isArray(sdkObject.missingSessionIds)) {
    throw new TypeError("missingSessionIds must be an array");
  }
  const sdkSessionStore = Object.freeze({
    status: enumValue(sdkObject.status, ["healthy", "degraded", "unknown"] as const),
    expectedSessionCount: safeInteger(sdkObject.expectedSessionCount, "expectedSessionCount", 0),
    missingSessionIds: Object.freeze(
      sdkObject.missingSessionIds.map((value) => nonControlText(value, "missing session ID")),
    ),
    ...(sdkObject.message === undefined
      ? {}
      : { message: nonControlText(sdkObject.message, "SDK health message") }),
  });
  return Object.freeze({
    lifecycle,
    mode,
    health,
    processId,
    startedAt,
    listeners: Object.freeze(listeners),
    pending,
    leases: Object.freeze(leases),
    sdkSessionStore,
  });
}

export function decodeSupervisorLogPage(input: string | unknown): SupervisorLogPage {
  const object = exactObject(input, ["afterCursor", "latestCursor", "hasMore", "items"]);
  const afterCursor = safeInteger(object.afterCursor, "afterCursor", 0);
  const latestCursor = safeInteger(object.latestCursor, "latestCursor", 0);
  if (typeof object.hasMore !== "boolean" || !Array.isArray(object.items)) {
    throw new TypeError("Log page shape is invalid");
  }
  const items = object.items.map((value) => {
    const item = exactObject(value, [
      "cursor",
      "recordedAt",
      "level",
      "event",
      "message",
      "fields",
    ]);
    return Object.freeze({
      cursor: safeInteger(item.cursor, "log cursor", 1),
      recordedAt: timestampValue(item.recordedAt, "recordedAt"),
      level: enumValue(item.level, ["debug", "info", "warn", "error"] as const),
      event: nonControlText(item.event, "log event"),
      message: nonControlText(item.message, "log message"),
      fields: decodeCanonicalJsonValue(item.fields),
    });
  });
  if (afterCursor > latestCursor || items.some((item) => item.cursor <= afterCursor)) {
    throw new TypeError("Log page cursors are invalid");
  }
  return Object.freeze({
    afterCursor,
    latestCursor,
    hasMore: object.hasMore,
    items: Object.freeze(items),
  });
}

function exactObject(
  input: string | unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const value = decodeCanonicalJsonValue(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Local contract value must be an object");
  }
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Local contract contains an unknown field");
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Local contract is missing a field");
  }
  return value as Readonly<Record<string, unknown>>;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new TypeError("Enum value is invalid");
  return value;
}

function safeInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}

function timestampValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a timestamp`);
  }
  return value;
}

function nonControlText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || containsControlCharacter(value)) {
    throw new TypeError(`${field} must be non-control text`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
