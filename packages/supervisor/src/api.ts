import {
  type AuthenticatedPrincipal,
  type CapabilityHandshake,
  type CommandSubmission,
  canonicalStringify,
  decodeAuthenticatedPrincipal,
  decodeCanonicalJsonValue,
  decodeCapabilityHandshake,
  decodeCommandEnvelope,
  decodeCommandSubmission,
  decodeRunIdentity,
  decodeSupervisorAdmissionFacts,
  decodeSupervisorReceipt,
  type EventReplayPage,
  type JsonValue,
  PORTAL_CAPABILITIES,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ProjectionEnvelope,
  ProtocolValidationError,
  type ReceiptPage,
  type SupervisorAllocationFact,
  type SupervisorReceipt,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import { PageQueryError } from "@senawa/runtime";
import type { SqliteAuthority } from "@senawa/storage-sqlite";
import {
  type SqliteSupervisorAuthority,
  SupervisorCommandConflictError,
  SupervisorServiceUnavailableError,
} from "./command-queue.js";
import type { AmendmentReviewRecord } from "./contracts.js";
import { type PortalApi, PortalApiError } from "./portal-api.js";

export type SupervisorIngressTransportKind = "cli" | "http" | "remote";

export interface SupervisorAdmissionAllocator {
  allocationsFor(submission: CommandSubmission): readonly SupervisorAllocationFact[];
}

export interface AuthenticatedIngressContext {
  readonly principal: AuthenticatedPrincipal;
  readonly transportKind: SupervisorIngressTransportKind;
  readonly requestId: string;
  readonly admission: {
    readonly currentTime: string;
    readonly facts: JsonValue;
    readonly allocator: SupervisorAdmissionAllocator;
  };
}

export interface SupervisorCommandLocation {
  readonly repositoryId: string;
  readonly runId: string;
  readonly commandId: string;
}

export interface SupervisorCommandAcceptance {
  readonly receipt: SupervisorReceipt;
  readonly location: SupervisorCommandLocation;
}

export type SupervisorApiErrorCode =
  | "invalid-request"
  | "not-found"
  | "command-conflict"
  | "event-replay-gap"
  | "service-unavailable"
  | "internal-error";

export class SupervisorApiError extends Error {
  readonly code: SupervisorApiErrorCode;
  readonly status: number;
  readonly safe: true;

  constructor(code: SupervisorApiErrorCode, status: number, message: string) {
    super(message);
    this.name = "SupervisorApiError";
    this.code = code;
    this.status = status;
    this.safe = true;
  }
}

export interface ReceiptLookupRequest {
  readonly commandId: string;
}

export interface PageQueryRequest {
  readonly repositoryId: string;
  readonly runId: string;
  readonly afterCursor?: number;
  readonly limit?: number;
}

export interface ProjectionQueryRequest {
  readonly repositoryId: string;
  readonly runId: string;
}

export interface SupervisorApiClient {
  capabilities(): CapabilityHandshake;
  submitCommand(
    submission: string | unknown,
    context: AuthenticatedIngressContext,
  ): SupervisorCommandAcceptance;
  getReceipt(request: string | unknown): SupervisorReceipt;
  listReceipts(request: string | unknown): ReceiptPage;
  listEvents(request: string | unknown): EventReplayPage;
  getProjection(request: string | unknown): ProjectionEnvelope;
  listAmendments(request: string | unknown): readonly AmendmentReviewRecord[];
  getAmendment(request: string | unknown): AmendmentReviewRecord;
}

export class SupervisorApi implements SupervisorApiClient {
  readonly authority: SqliteSupervisorAuthority;
  readonly queryAuthority: SqliteAuthority;
  readonly portal: PortalApi | undefined;
  readonly #capabilities: CapabilityHandshake;

  constructor(
    authority: SqliteSupervisorAuthority,
    peerId = "supervisor_local",
    portal?: PortalApi,
  ) {
    this.authority = authority;
    this.queryAuthority = authority.commandAuthority;
    this.portal = portal;
    this.#capabilities = decodeCapabilityHandshake({
      apiVersion: PROTOCOL_VERSION,
      peerId,
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: [
        "amendment-review",
        "command-submit",
        "event-replay",
        ...(portal === undefined ? [] : PORTAL_CAPABILITIES),
        "projection-read",
        "receipt-read",
      ].sort(),
    });
  }

  capabilities(): CapabilityHandshake {
    return this.#capabilities;
  }

  submitCommand(
    input: string | unknown,
    context: AuthenticatedIngressContext,
  ): SupervisorCommandAcceptance {
    try {
      const submission = decodeCommandSubmission(input);
      const principal = decodeAuthenticatedPrincipal(context.principal);
      if (
        context.transportKind !== "cli" &&
        context.transportKind !== "http" &&
        context.transportKind !== "remote"
      ) {
        throw invalidRequest("Transport kind must be cli, http, or remote");
      }
      const requestId = validateOpaqueIdentity(context.requestId);
      const envelope = decodeCommandEnvelope({
        ...submission,
        principal,
        transport: { kind: context.transportKind, requestId },
      });
      const receipt = this.authority.accept({
        envelope,
        createAdmission: () => {
          if (typeof context.admission?.allocator?.allocationsFor !== "function") {
            throw invalidRequest("Trusted admission allocator is required");
          }
          return decodeSupervisorAdmissionFacts({
            currentTime: context.admission.currentTime,
            facts: context.admission.facts,
            allocations: context.admission.allocator.allocationsFor(submission),
          });
        },
      });
      return decodeSupervisorCommandAcceptance({
        receipt,
        location: {
          repositoryId: receipt.repositoryId,
          runId: receipt.runId,
          commandId: receipt.commandId,
        },
      });
    } catch (error) {
      throw mapApiError(error);
    }
  }

  getReceipt(input: string | unknown): SupervisorReceipt {
    try {
      const request = receiptLookupRequest(input);
      const receipt = this.authority.queryLatest(request.commandId);
      if (receipt === undefined) {
        throw new SupervisorApiError("not-found", 404, "Command receipt was not found");
      }
      return receipt;
    } catch (error) {
      throw mapApiError(error);
    }
  }

  listReceipts(input: string | unknown): ReceiptPage {
    try {
      const request = pageQueryRequest(input);
      return this.queryAuthority.queryReceiptPage(
        request.repositoryId,
        request.runId,
        request.afterCursor,
        request.limit,
      );
    } catch (error) {
      throw mapApiError(error);
    }
  }

  listEvents(input: string | unknown): EventReplayPage {
    try {
      const request = pageQueryRequest(input);
      return this.queryAuthority.queryEventPage(
        request.repositoryId,
        request.runId,
        request.afterCursor,
        request.limit,
      );
    } catch (error) {
      throw mapApiError(error);
    }
  }

  getProjection(input: string | unknown): ProjectionEnvelope {
    try {
      const request = projectionQueryRequest(input);
      const projection = this.queryAuthority.queryProjection(request.repositoryId, request.runId);
      if (projection === undefined) {
        throw new SupervisorApiError("not-found", 404, "Projection was not found");
      }
      return projection;
    } catch (error) {
      throw mapApiError(error);
    }
  }

  listAmendments(input: string | unknown): readonly AmendmentReviewRecord[] {
    try {
      const request = projectionQueryRequest(input);
      return this.authority.queryAmendments(request.repositoryId, request.runId);
    } catch (error) {
      throw mapApiError(error);
    }
  }

  getAmendment(input: string | unknown): AmendmentReviewRecord {
    try {
      const object = exactLocalObject(input, ["repositoryId", "runId", "amendmentId"]);
      const identity = decodeRunIdentity({
        repositoryId: object.repositoryId,
        runId: object.runId,
      });
      const amendment = this.authority.queryAmendment(
        identity.repositoryId,
        identity.runId,
        validateOpaqueIdentity(object.amendmentId),
      );
      if (amendment === undefined) {
        throw new SupervisorApiError("not-found", 404, "Amendment proposal was not found");
      }
      return amendment;
    } catch (error) {
      throw mapApiError(error);
    }
  }
}

export function decodeSupervisorCommandAcceptance(
  input: string | unknown,
): SupervisorCommandAcceptance {
  const object = exactLocalObject(input, ["receipt", "location"]);
  const receipt = decodeSupervisorReceipt(object.receipt);
  const location = exactLocalObject(object.location, ["repositoryId", "runId", "commandId"]);
  const identity = decodeRunIdentity({
    repositoryId: location.repositoryId,
    runId: location.runId,
  });
  validateOpaqueIdentity(location.commandId);
  if (
    identity.repositoryId !== receipt.repositoryId ||
    identity.runId !== receipt.runId ||
    location.commandId !== receipt.commandId
  ) {
    throw invalidRequest("Acceptance location must match its receipt");
  }
  return Object.freeze({
    receipt,
    location: Object.freeze({
      repositoryId: identity.repositoryId,
      runId: identity.runId,
      commandId: location.commandId as string,
    }),
  });
}

export function encodeSupervisorCommandAcceptance(input: unknown): string {
  return canonicalStringify(decodeSupervisorCommandAcceptance(input));
}

function receiptLookupRequest(input: string | unknown): ReceiptLookupRequest {
  const object = exactLocalObject(input, ["commandId"]);
  return Object.freeze({ commandId: validateOpaqueIdentity(object.commandId) });
}

function projectionQueryRequest(input: string | unknown): ProjectionQueryRequest {
  const object = exactLocalObject(input, ["repositoryId", "runId"]);
  return decodeRunIdentity(object);
}

function pageQueryRequest(input: string | unknown): PageQueryRequest {
  const object = exactLocalObject(input, ["repositoryId", "runId"], ["afterCursor", "limit"]);
  const identity = decodeRunIdentity({ repositoryId: object.repositoryId, runId: object.runId });
  const afterCursor = Object.hasOwn(object, "afterCursor") ? object.afterCursor : undefined;
  const limit = Object.hasOwn(object, "limit") ? object.limit : undefined;
  if (
    afterCursor !== undefined &&
    (typeof afterCursor !== "number" || !Number.isSafeInteger(afterCursor) || afterCursor < 0)
  ) {
    throw invalidRequest("afterCursor must be a non-negative safe integer");
  }
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > PROTOCOL_LIMITS.maxPageItems)
  ) {
    throw invalidRequest(`limit must be an integer from 1 to ${PROTOCOL_LIMITS.maxPageItems}`);
  }
  return Object.freeze({
    ...identity,
    ...(afterCursor === undefined ? {} : { afterCursor }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function exactLocalObject(
  input: string | unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const value = decodeCanonicalJsonValue(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("Request must be an object");
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidRequest(`Unknown request field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw invalidRequest(`Missing request field: ${key}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function invalidRequest(message: string): SupervisorApiError {
  return new SupervisorApiError("invalid-request", 400, message);
}

function mapApiError(error: unknown): SupervisorApiError {
  if (error instanceof SupervisorApiError) return error;
  if (error instanceof ProtocolValidationError) {
    return invalidRequest("Request validation failed");
  }
  if (error instanceof PageQueryError) {
    if (error.code === "cursor-ahead")
      return invalidRequest("Page cursor exceeds the latest authority cursor");
    if (error.code === "scope-mismatch")
      return invalidRequest("Page scope does not name its own run");
    return new SupervisorApiError(
      "event-replay-gap",
      409,
      "Event cursor precedes the available replay range",
    );
  }
  if (error instanceof PortalApiError) {
    return new SupervisorApiError(error.code, error.status, error.message);
  }
  if (error instanceof SupervisorCommandConflictError) {
    return new SupervisorApiError(
      "command-conflict",
      409,
      "Command identity conflicts with an existing command",
    );
  }
  if (error instanceof SupervisorServiceUnavailableError) {
    return new SupervisorApiError(
      "service-unavailable",
      503,
      "Supervisor is not accepting new commands",
    );
  }
  return new SupervisorApiError("internal-error", 500, "Supervisor request failed");
}
