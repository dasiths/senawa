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
  readonly amendmentProposalOutbox: number;
  readonly approvedAmendments: number;
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

export type RemoteConnectorLifecycle = "stopped" | "running" | "draining" | "drained" | "closed";

export interface RemoteConnectorSyncLag {
  readonly state: "never-synchronized" | "current" | "stale";
  readonly stalenessMs: number | null;
  readonly inboundSequence: number;
  readonly waitingCommands: number;
  readonly readyCommands: number;
  readonly acceptedCommands: number;
  readonly pendingReports: number;
  readonly claimedReports: number;
  readonly localToEnqueued: number;
  readonly enqueuedToAcknowledged: number;
}

export interface RemoteConnectorStatus {
  readonly connectorId: string;
  readonly bindingId: string;
  readonly repositoryId: string;
  readonly lifecycle: RemoteConnectorLifecycle;
  readonly health: SupervisorHealth;
  readonly partitioned: boolean;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessfulContactAt: string | null;
  readonly lastErrorCode: string | null;
  readonly synchronization: RemoteConnectorSyncLag;
}

export interface RemoteConnectorStatusPort {
  status(): RemoteConnectorStatus;
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
  readonly remoteConnectors: readonly RemoteConnectorStatus[];
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

export interface AmendmentReviewRecord {
  readonly repositoryId: string;
  readonly runId: string;
  readonly proposal: JsonValue;
  readonly lifecycle: JsonValue;
  readonly decision?: JsonValue;
  readonly withdrawal?: JsonValue;
  readonly application?: JsonValue;
  readonly workerSource?: JsonValue;
  readonly bridgeOutcome?: JsonValue;
}

export function decodeAmendmentReviewRecord(input: string | unknown): AmendmentReviewRecord {
  const object = exactObject(
    input,
    ["repositoryId", "runId", "proposal", "lifecycle"],
    ["decision", "withdrawal", "application", "workerSource", "bridgeOutcome"],
  );
  return Object.freeze({
    repositoryId: nonControlText(object.repositoryId, "repositoryId"),
    runId: nonControlText(object.runId, "runId"),
    proposal: decodeCanonicalJsonValue(object.proposal),
    lifecycle: decodeCanonicalJsonValue(object.lifecycle),
    ...(object.decision === undefined
      ? {}
      : { decision: decodeCanonicalJsonValue(object.decision) }),
    ...(object.withdrawal === undefined
      ? {}
      : { withdrawal: decodeCanonicalJsonValue(object.withdrawal) }),
    ...(object.application === undefined
      ? {}
      : { application: decodeCanonicalJsonValue(object.application) }),
    ...(object.workerSource === undefined
      ? {}
      : { workerSource: decodeCanonicalJsonValue(object.workerSource) }),
    ...(object.bridgeOutcome === undefined
      ? {}
      : { bridgeOutcome: decodeCanonicalJsonValue(object.bridgeOutcome) }),
  });
}

export function decodeAmendmentReviewRecords(
  input: string | unknown,
): readonly AmendmentReviewRecord[] {
  const value = decodeCanonicalJsonValue(input);
  if (!Array.isArray(value)) throw new TypeError("Amendment review records must be an array");
  return Object.freeze(value.map(decodeAmendmentReviewRecord));
}

export function decodeSupervisorServiceStatus(input: string | unknown): SupervisorServiceStatus {
  const object = exactObject(
    input,
    [
      "lifecycle",
      "mode",
      "health",
      "processId",
      "startedAt",
      "listeners",
      "pending",
      "leases",
      "sdkSessionStore",
    ],
    ["remoteConnectors"],
  );
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
    "amendmentProposalOutbox",
    "approvedAmendments",
  ]);
  const pending = Object.freeze({
    queuedCommands: safeInteger(pendingObject.queuedCommands, "queuedCommands", 0),
    claimedCommands: safeInteger(pendingObject.claimedCommands, "claimedCommands", 0),
    wakes: safeInteger(pendingObject.wakes, "wakes", 0),
    runnerEffects: safeInteger(pendingObject.runnerEffects, "runnerEffects", 0),
    completionOutbox: safeInteger(pendingObject.completionOutbox, "completionOutbox", 0),
    amendmentProposalOutbox: safeInteger(
      pendingObject.amendmentProposalOutbox,
      "amendmentProposalOutbox",
      0,
    ),
    approvedAmendments: safeInteger(pendingObject.approvedAmendments, "approvedAmendments", 0),
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
  const remoteValues = object.remoteConnectors ?? [];
  if (!Array.isArray(remoteValues)) throw new TypeError("remoteConnectors must be an array");
  const remoteConnectors = remoteValues.map((value) => {
    const connector = exactObject(value, [
      "connectorId",
      "bindingId",
      "repositoryId",
      "lifecycle",
      "health",
      "partitioned",
      "lastAttemptAt",
      "lastSuccessfulContactAt",
      "lastErrorCode",
      "synchronization",
    ]);
    if (typeof connector.partitioned !== "boolean") {
      throw new TypeError("remote connector partitioned must be boolean");
    }
    const synchronization = exactObject(connector.synchronization, [
      "state",
      "stalenessMs",
      "inboundSequence",
      "waitingCommands",
      "readyCommands",
      "acceptedCommands",
      "pendingReports",
      "claimedReports",
      "localToEnqueued",
      "enqueuedToAcknowledged",
    ]);
    return Object.freeze({
      connectorId: nonControlText(connector.connectorId, "remote connector ID"),
      bindingId: nonControlText(connector.bindingId, "remote binding ID"),
      repositoryId: nonControlText(connector.repositoryId, "remote repository ID"),
      lifecycle: enumValue(connector.lifecycle, [
        "stopped",
        "running",
        "draining",
        "drained",
        "closed",
      ] as const),
      health: enumValue(connector.health, ["healthy", "degraded"] as const),
      partitioned: connector.partitioned,
      lastAttemptAt: nullableTimestampValue(connector.lastAttemptAt, "remote lastAttemptAt"),
      lastSuccessfulContactAt: nullableTimestampValue(
        connector.lastSuccessfulContactAt,
        "remote lastSuccessfulContactAt",
      ),
      lastErrorCode: nullableText(connector.lastErrorCode, "remote lastErrorCode"),
      synchronization: Object.freeze({
        state: enumValue(synchronization.state, [
          "never-synchronized",
          "current",
          "stale",
        ] as const),
        stalenessMs:
          synchronization.stalenessMs === null
            ? null
            : safeInteger(synchronization.stalenessMs, "stalenessMs", 0),
        inboundSequence: safeInteger(synchronization.inboundSequence, "inboundSequence", 0),
        waitingCommands: safeInteger(synchronization.waitingCommands, "waitingCommands", 0),
        readyCommands: safeInteger(synchronization.readyCommands, "readyCommands", 0),
        acceptedCommands: safeInteger(synchronization.acceptedCommands, "acceptedCommands", 0),
        pendingReports: safeInteger(synchronization.pendingReports, "pendingReports", 0),
        claimedReports: safeInteger(synchronization.claimedReports, "claimedReports", 0),
        localToEnqueued: safeInteger(synchronization.localToEnqueued, "localToEnqueued", 0),
        enqueuedToAcknowledged: safeInteger(
          synchronization.enqueuedToAcknowledged,
          "enqueuedToAcknowledged",
          0,
        ),
      }),
    });
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
    remoteConnectors: Object.freeze(remoteConnectors),
  });
}

function nullableTimestampValue(value: unknown, field: string): string | null {
  return value === null ? null : timestampValue(value, field);
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : nonControlText(value, field);
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
