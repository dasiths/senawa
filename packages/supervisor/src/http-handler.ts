import type { IncomingMessage, ServerResponse } from "node:http";
import { TextDecoder } from "node:util";
import {
  canonicalStringify,
  decodeCanonicalJsonValue,
  type ErrorEnvelope,
  type JsonValue,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import { type AuthenticatedIngressContext, type SupervisorApi, SupervisorApiError } from "./api.js";
import { SupervisorServiceUnavailableError } from "./command-queue.js";
import type { SupervisorLogPage, SupervisorServiceStatus } from "./contracts.js";
import { matchSupervisorHttpRoute, SupervisorHttpRouteError } from "./http-router.js";
import { authenticateLocalCredential, type LocalCredential } from "./local-security.js";
import { type PortalSessionSecurity, readCookie } from "./session-security.js";
import type { SseEventSource } from "./sse.js";

const MAX_FRAMED_BODY_BYTES = PROTOCOL_LIMITS.maxWireBytes + 1_024;
const SESSION_COOKIE = "senawa_session";
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:;\s*charset=utf-8)?$/iu;
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const;

export type SupervisorHttpTransport = "ipc" | "loopback";

export interface SupervisorHttpHandlerOptions {
  readonly api: SupervisorApi;
  readonly transport: SupervisorHttpTransport;
  readonly contextFactory: (
    request: IncomingMessage,
    transportKind: "cli" | "http",
  ) => AuthenticatedIngressContext;
  readonly credential?: LocalCredential;
  readonly sessions?: PortalSessionSecurity;
  readonly loopbackOrigin?: string;
  readonly sse?: SseEventSource;
  readonly requestTimeoutMs?: number;
  readonly operations?: SupervisorOperations;
}

export interface SupervisorOperations {
  status(): Promise<SupervisorServiceStatus>;
  drain(): Promise<void>;
  stop(): Promise<void>;
  recover(repositoryId: string, runId: string): Promise<{ readonly worked: boolean }>;
  logs(afterCursor?: number, limit?: number): Promise<SupervisorLogPage>;
}

export class SupervisorHttpHandler {
  readonly #api: SupervisorApi;
  readonly #transport: SupervisorHttpTransport;
  readonly #contextFactory: SupervisorHttpHandlerOptions["contextFactory"];
  readonly #credential: LocalCredential | undefined;
  readonly #sessions: PortalSessionSecurity | undefined;
  readonly #loopbackOrigin: string | undefined;
  readonly #expectedHost: string | undefined;
  readonly #sse: SseEventSource | undefined;
  readonly #requestTimeoutMs: number;
  readonly #operations: SupervisorOperations | undefined;

  constructor(options: SupervisorHttpHandlerOptions) {
    this.#api = options.api;
    this.#transport = options.transport;
    this.#contextFactory = options.contextFactory;
    this.#credential = options.credential;
    this.#sessions = options.sessions;
    this.#loopbackOrigin = options.loopbackOrigin;
    this.#expectedHost =
      options.loopbackOrigin === undefined ? undefined : new URL(options.loopbackOrigin).host;
    this.#sse = options.sse;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#operations = options.operations;
    if (this.#transport === "ipc" && this.#credential === undefined) {
      throw new TypeError("IPC HTTP requires a local credential");
    }
    if (
      this.#transport === "loopback" &&
      (this.#sessions === undefined ||
        this.#loopbackOrigin === undefined ||
        !this.#loopbackOrigin.startsWith("http://127.0.0.1:"))
    ) {
      throw new TypeError("Loopback HTTP requires sessions and an exact 127.0.0.1 origin");
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.#validateConnectionHeaders(request);
      if (this.#transport === "ipc") this.#authenticateIpc(request);
      const route = matchSupervisorHttpRoute(request.method ?? "", request.url ?? "");
      const sessionToken = this.#authenticate(request, route.kind);
      this.#validateExpectation(request);
      this.#validateBodyHeaders(request, route.kind);

      switch (route.kind) {
        case "supervisor-status":
          requireIpc(this.#transport);
          requireNoBody(request);
          return sendJson(response, 200, await this.#requiredOperations().status());
        case "supervisor-drain":
          requireIpc(this.#transport);
          requireNoBody(request);
          await this.#requiredOperations().drain();
          return sendJson(response, 202, { accepted: true });
        case "supervisor-stop":
          requireIpc(this.#transport);
          requireNoBody(request);
          sendJson(response, 202, { accepted: true });
          setImmediate(
            () =>
              void this.#requiredOperations()
                .stop()
                .catch(() => undefined),
          );
          return;
        case "supervisor-recovery": {
          requireIpc(this.#transport);
          const recovery = recoveryRequest(await readJsonBody(request, this.#requestTimeoutMs));
          return sendJson(
            response,
            202,
            await this.#requiredOperations().recover(recovery.repositoryId, recovery.runId),
          );
        }
        case "supervisor-logs":
          requireIpc(this.#transport);
          requireNoBody(request);
          return sendJson(
            response,
            200,
            await this.#requiredOperations().logs(route.afterCursor, route.limit),
          );
        case "capabilities":
          requireNoBody(request);
          return sendJson(response, 200, this.#api.capabilities());
        case "commands": {
          const body = await readJsonBody(request, this.#requestTimeoutMs);
          const acceptance = this.#api.submitCommand(
            body,
            this.#contextFactory(request, this.#transport === "ipc" ? "cli" : "http"),
          );
          return sendJson(response, 202, acceptance, {
            Location: `/api/v1alpha1/commands/${acceptance.location.commandId}/receipt`,
          });
        }
        case "command-receipt":
          requireNoBody(request);
          return sendJson(response, 200, this.#api.getReceipt({ commandId: route.commandId }));
        case "receipt-page":
          requireNoBody(request);
          return sendJson(response, 200, this.#api.listReceipts(pageRequest(route)));
        case "event-page":
          requireNoBody(request);
          return sendJson(response, 200, this.#api.listEvents(pageRequest(route)));
        case "phase-lifecycle":
          requireNoBody(request);
          return sendJson(
            response,
            200,
            this.#api.getProjection({ repositoryId: route.repositoryId, runId: route.runId }),
          );
        case "amendment-list":
          requireNoBody(request);
          return sendJson(
            response,
            200,
            this.#api.listAmendments({ repositoryId: route.repositoryId, runId: route.runId }),
          );
        case "amendment-record":
          requireNoBody(request);
          return sendJson(
            response,
            200,
            this.#api.getAmendment({
              repositoryId: route.repositoryId,
              runId: route.runId,
              amendmentId: requiredValue(route.amendmentId),
            }),
          );
        case "amendment-source": {
          requireNoBody(request);
          const amendmentId = requiredValue(route.amendmentId);
          const amendment = this.#api.getAmendment({
            repositoryId: route.repositoryId,
            runId: route.runId,
            amendmentId,
          });
          return sendJson(response, 200, {
            repositoryId: amendment.repositoryId,
            runId: amendment.runId,
            amendmentId,
            source: amendment.workerSource ?? localProposalSource(amendment.proposal),
            ...(amendment.bridgeOutcome === undefined
              ? {}
              : { bridgeOutcome: amendment.bridgeOutcome }),
          });
        }
        case "portal-session-bootstrap": {
          requireIpc(this.#transport);
          requireNoBody(request);
          const bootstrap = this.#requiredSessions().createBootstrap();
          return sendJson(response, 201, {
            expiresAt: new Date(bootstrap.expiresAt).toISOString(),
            path: `/portal/bootstrap?token=${bootstrap.token}`,
          });
        }
        case "portal-bootstrap": {
          requireLoopback(this.#transport);
          requireNoBody(request);
          const session = this.#requiredSessions().consumeBootstrap(route.token);
          if (session === undefined)
            throw httpError("unauthorized", 401, "Portal bootstrap is invalid");
          response.writeHead(303, {
            "Cache-Control": "no-store",
            Location: "/portal/",
            "Set-Cookie": `${SESSION_COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/`,
            "X-Content-Type-Options": "nosniff",
          });
          response.end();
          return;
        }
        case "portal-session": {
          requireLoopback(this.#transport);
          requireNoBody(request);
          const csrfToken = this.#requiredSessions().issueCsrf(requiredValue(sessionToken));
          if (csrfToken === undefined) {
            throw httpError("command-conflict", 409, "CSRF token was already delivered");
          }
          return sendJson(response, 200, { csrfToken });
        }
        case "event-stream":
          requireNoBody(request);
          return await this.#streamEvents(request, response, route, sessionToken);
      }
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendHttpError(response, error);
    }
  }

  #validateConnectionHeaders(request: IncomingMessage): void {
    if (request.httpVersionMajor !== 1 || request.httpVersionMinor !== 1) {
      throw httpError("invalid-request", 400, "HTTP/1.1 is required");
    }
    for (const header of FORWARDED_HEADERS) {
      if (request.headers[header] !== undefined) {
        throw httpError("invalid-request", 400, "Forwarding headers are not accepted");
      }
    }
    const hosts = request.headersDistinct.host ?? [];
    if (hosts.length !== 1 || hosts[0] === "") {
      throw httpError("invalid-request", 400, "Host header is required exactly once");
    }
    if (this.#expectedHost !== undefined && hosts[0] !== this.#expectedHost) {
      throw httpError("invalid-request", 400, "Host header is invalid");
    }
  }

  #validateExpectation(request: IncomingMessage): void {
    if (request.headers.expect !== undefined) {
      throw httpError("invalid-request", 417, "HTTP expectations are not accepted");
    }
  }

  #authenticate(request: IncomingMessage, routeKind: string): string | undefined {
    if (this.#transport === "ipc") {
      if (routeKind === "portal-bootstrap" || routeKind === "portal-session") throw notFound();
      return undefined;
    }
    if (routeKind.startsWith("supervisor-")) throw notFound();
    if (routeKind === "portal-session-bootstrap") throw notFound();
    const originValues = request.headersDistinct.origin ?? [];
    if (
      originValues.length > 1 ||
      (originValues[0] !== undefined && originValues[0] !== this.#loopbackOrigin)
    ) {
      throw httpError("forbidden", 403, "Origin is invalid");
    }
    if (routeKind === "portal-bootstrap") return undefined;
    const cookies = request.headersDistinct.cookie ?? [];
    const sessionToken = cookies.length === 1 ? readCookie(cookies[0], SESSION_COOKIE) : undefined;
    if (!this.#requiredSessions().validateSession(sessionToken)) {
      throw httpError("unauthorized", 401, "Portal session is invalid");
    }
    if (request.method === "POST") {
      if (originValues[0] !== this.#loopbackOrigin)
        throw httpError("forbidden", 403, "Origin is required");
      const csrfValues = request.headersDistinct["x-senawa-csrf"] ?? [];
      if (
        csrfValues.length !== 1 ||
        !this.#requiredSessions().validateCsrf(requiredValue(sessionToken), csrfValues[0])
      ) {
        throw httpError("forbidden", 403, "CSRF validation failed");
      }
    }
    return sessionToken;
  }

  #authenticateIpc(request: IncomingMessage): void {
    const values = request.headersDistinct.authorization ?? [];
    if (
      values.length !== 1 ||
      !authenticateLocalCredential(values[0], requiredValue(this.#credential))
    ) {
      throw httpError("unauthorized", 401, "IPC authorization failed");
    }
  }

  #validateBodyHeaders(request: IncomingMessage, routeKind: string): void {
    if (request.headers["content-encoding"] !== undefined) {
      throw httpError("invalid-request", 415, "Content encoding is not accepted");
    }
    const contentLengths = request.headersDistinct["content-length"] ?? [];
    if (
      contentLengths.length > 1 ||
      (contentLengths.length === 1 && !DECIMAL_PATTERN.test(contentLengths[0] ?? ""))
    ) {
      throw httpError("invalid-request", 400, "Content length is invalid");
    }
    if (contentLengths.length === 1 && request.headers["transfer-encoding"] !== undefined) {
      throw httpError("invalid-request", 400, "Request body framing is ambiguous");
    }
    const length = contentLengths.length === 1 ? Number(contentLengths[0]) : 0;
    if (!Number.isSafeInteger(length) || length > MAX_FRAMED_BODY_BYTES) {
      throw httpError("invalid-request", 413, "Request body is too large");
    }
    if (routeKind === "commands") {
      const contentTypes = request.headersDistinct["content-type"] ?? [];
      if (contentTypes.length !== 1 || !JSON_CONTENT_TYPE_PATTERN.test(contentTypes[0] ?? "")) {
        throw httpError("invalid-request", 415, "Content type must be application/json");
      }
    }
  }

  async #streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    route: {
      readonly repositoryId: string;
      readonly runId: string;
      readonly afterCursor?: number;
    },
    _sessionToken: string | undefined,
  ): Promise<void> {
    if (this.#sse === undefined)
      throw httpError("service-unavailable", 503, "Event stream is unavailable");
    const lastEventIds = request.headersDistinct["last-event-id"] ?? [];
    if (lastEventIds.length > 1)
      throw httpError("invalid-request", 400, "Last-Event-ID is invalid");
    const headerCursor = lastEventIds[0] === undefined ? undefined : parseCursor(lastEventIds[0]);
    if (
      route.afterCursor !== undefined &&
      headerCursor !== undefined &&
      route.afterCursor !== headerCursor
    ) {
      throw httpError("invalid-request", 400, "Event cursors conflict");
    }
    const afterCursor = route.afterCursor ?? headerCursor ?? 0;
    try {
      this.#api.listEvents({
        repositoryId: route.repositoryId,
        runId: route.runId,
        afterCursor,
        limit: 1,
      });
    } catch (error) {
      if (!(error instanceof SupervisorApiError) || error.code !== "event-replay-gap") throw error;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    const controller = new AbortController();
    const onClose = () => controller.abort();
    const sessionRemainingMs =
      this.#transport === "loopback"
        ? this.#requiredSessions().sessionRemainingMs(requiredValue(_sessionToken))
        : undefined;
    if (this.#transport === "loopback" && sessionRemainingMs === undefined) {
      throw httpError("unauthorized", 401, "Portal session is invalid");
    }
    const expiryTimeout =
      sessionRemainingMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), sessionRemainingMs);
    response.once("close", onClose);
    try {
      await this.#sse.stream({
        repositoryId: route.repositoryId,
        runId: route.runId,
        afterCursor,
        signal: controller.signal,
        response,
        ...(this.#transport === "loopback"
          ? {
              authorized: () =>
                this.#requiredSessions().validateSession(requiredValue(_sessionToken)),
            }
          : {}),
      });
    } finally {
      if (expiryTimeout !== undefined) clearTimeout(expiryTimeout);
      response.off("close", onClose);
    }
  }

  #requiredSessions(): PortalSessionSecurity {
    return requiredValue(this.#sessions);
  }

  #requiredOperations(): SupervisorOperations {
    if (this.#operations === undefined) {
      throw httpError("service-unavailable", 503, "Supervisor operations are unavailable");
    }
    return this.#operations;
  }
}

function recoveryRequest(input: string): { readonly repositoryId: string; readonly runId: string } {
  const value = decodeCanonicalJsonValue(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidRecovery();
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== 2 ||
    !Object.hasOwn(object, "repositoryId") ||
    !Object.hasOwn(object, "runId") ||
    typeof object.repositoryId !== "string" ||
    typeof object.runId !== "string"
  ) {
    throw invalidRecovery();
  }
  return { repositoryId: object.repositoryId, runId: object.runId };
}

function localProposalSource(proposal: JsonValue): JsonValue {
  if (proposal === null || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new Error("Amendment proposal source is unavailable");
  }
  return (proposal as Readonly<Record<string, JsonValue>>).source as JsonValue;
}

function invalidRecovery(): SupervisorApiError {
  return new SupervisorApiError("invalid-request", 400, "Recovery request is invalid");
}

function pageRequest(route: {
  readonly repositoryId: string;
  readonly runId: string;
  readonly afterCursor?: number;
  readonly limit?: number;
}) {
  return {
    repositoryId: route.repositoryId,
    runId: route.runId,
    ...(route.afterCursor === undefined ? {} : { afterCursor: route.afterCursor }),
    ...(route.limit === undefined ? {} : { limit: route.limit }),
  };
}

function requireNoBody(request: IncomingMessage): void {
  const length = request.headers["content-length"];
  if (
    (length !== undefined && length !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw httpError("invalid-request", 400, "Request body is not accepted");
  }
}

function readJsonBody(request: IncomingMessage, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    const timeout = setTimeout(
      () => reject(httpError("invalid-request", 408, "Request timed out")),
      timeoutMs,
    );
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAMED_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(Buffer.from(chunk));
      }
    });
    request.once("end", () => {
      clearTimeout(timeout);
      if (tooLarge) reject(httpError("invalid-request", 413, "Request body is too large"));
      else {
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          reject(httpError("invalid-request", 400, "Request body is not valid UTF-8"));
        }
      }
    });
    request.once("aborted", () => {
      clearTimeout(timeout);
      reject(httpError("invalid-request", 400, "Request was aborted"));
    });
    request.once("error", () => {
      clearTimeout(timeout);
      reject(httpError("invalid-request", 400, "Request could not be read"));
    });
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = canonicalStringify(value);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function sendHttpError(response: ServerResponse, error: unknown): void {
  const mapped = mapHttpError(error);
  const envelope: ErrorEnvelope = {
    apiVersion: PROTOCOL_VERSION,
    code: mapped.code,
    message: mapped.message,
    retryable: mapped.status === 503,
  };
  sendJson(response, mapped.status, envelope);
}

function mapHttpError(error: unknown): {
  readonly code: string;
  readonly status: number;
  readonly message: string;
} {
  if (error instanceof SupervisorApiError) return error;
  if (error instanceof SupervisorHttpRouteError) {
    return {
      code: error.status === 404 ? "not-found" : "invalid-request",
      status: error.status,
      message: error.message,
    };
  }
  if (error instanceof SupervisorHttpError) return error;
  if (error instanceof SupervisorServiceUnavailableError) {
    return {
      code: "service-unavailable",
      status: 503,
      message: "Supervisor operations are unavailable",
    };
  }
  return { code: "internal-error", status: 500, message: "Supervisor request failed" };
}

class SupervisorHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SupervisorHttpError";
    this.code = code;
    this.status = status;
  }
}

function httpError(code: string, status: number, message: string): SupervisorHttpError {
  return new SupervisorHttpError(code, status, message);
}

function notFound(): SupervisorHttpError {
  return httpError("not-found", 404, "Route was not found");
}

function requireIpc(transport: SupervisorHttpTransport): void {
  if (transport !== "ipc") throw notFound();
}

function requireLoopback(transport: SupervisorHttpTransport): void {
  if (transport !== "loopback") throw notFound();
}

function parseCursor(raw: string): number {
  if (!DECIMAL_PATTERN.test(raw))
    throw httpError("invalid-request", 400, "Last-Event-ID is invalid");
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor))
    throw httpError("invalid-request", 400, "Last-Event-ID is invalid");
  return cursor;
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required supervisor HTTP dependency is missing");
  return value;
}
