import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import {
  type CapabilityHandshake,
  canonicalStringify,
  decodeCanonicalJsonValue,
  decodeCapabilityHandshake,
  decodeErrorEnvelope,
  decodeEventReplayPage,
  decodePortalAllowanceReview,
  decodePortalArtifactContent,
  decodePortalArtifactPage,
  decodePortalEventWindow,
  decodePortalGraphEdgePage,
  decodePortalGraphNodePage,
  decodePortalGraphSummary,
  decodePortalHumanNeedPage,
  decodePortalImmutableRecord,
  decodePortalIntegrationPage,
  decodePortalQuestionPage,
  decodePortalQuestionRecord,
  decodePortalReceiptWindow,
  decodePortalRepositoryPage,
  decodePortalRunOverview,
  decodePortalRunPage,
  decodePortalWorkspacePage,
  decodeProjectionEnvelope,
  decodeReceiptPage,
  decodeSupervisorReceipt,
  type EventReplayPage,
  type JsonValue,
  type PortalAllowanceReview,
  type PortalArtifactContent,
  type PortalArtifactPage,
  type PortalEventWindow,
  type PortalGraphEdgePage,
  type PortalGraphNodePage,
  type PortalGraphSummary,
  type PortalHumanNeedPage,
  type PortalImmutableRecord,
  type PortalIntegrationPage,
  type PortalQuestionPage,
  type PortalQuestionRecord,
  type PortalReceiptWindow,
  type PortalRepositoryPage,
  type PortalRunOverview,
  type PortalRunPage,
  type PortalWorkspacePage,
  PROTOCOL_LIMITS,
  type ProjectionEnvelope,
  type ReceiptPage,
  type SupervisorReceipt,
} from "@senawa/protocol";
import {
  decodeSupervisorCommandAcceptance,
  SupervisorApiError,
  type SupervisorCommandAcceptance,
} from "./api.js";
import {
  type AmendmentReviewRecord,
  decodeAmendmentReviewRecord,
  decodeAmendmentReviewRecords,
  decodeSupervisorLogPage,
  decodeSupervisorServiceStatus,
  type SupervisorLogPage,
  type SupervisorServiceStatus,
} from "./contracts.js";

const MAX_RESPONSE_BYTES = PROTOCOL_LIMITS.maxWireBytes + 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;

export interface HttpSupervisorClientOptions {
  readonly baseUrl?: string;
  readonly socketPath?: string;
  readonly credential?: string;
  readonly requestTimeoutMs?: number;
}

export type HttpSupervisorClientErrorCode =
  | "request-timeout"
  | "response-aborted"
  | "response-too-large"
  | "transport-error";

export class HttpSupervisorClientError extends Error {
  readonly code: HttpSupervisorClientErrorCode;

  constructor(code: HttpSupervisorClientErrorCode, message: string) {
    super(message);
    this.name = "HttpSupervisorClientError";
    this.code = code;
  }
}

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export class HttpSupervisorClient {
  readonly #baseUrl: URL;
  readonly #socketPath: string | undefined;
  readonly #credential: string | undefined;
  readonly #requestTimeoutMs: number;
  #sessionCookie: string | undefined;
  #csrfToken: string | undefined;

  constructor(options: HttpSupervisorClientOptions) {
    if ((options.baseUrl === undefined) === (options.socketPath === undefined)) {
      throw new TypeError("HTTP supervisor client requires exactly one baseUrl or socketPath");
    }
    this.#baseUrl = new URL(options.baseUrl ?? "http://localhost");
    this.#socketPath = options.socketPath;
    this.#credential = options.credential;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs <= 0 ||
      this.#requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new TypeError(
        `HTTP request timeout must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
  }

  async capabilities(): Promise<CapabilityHandshake> {
    return decodeCapabilityHandshake(await this.#json("GET", "/api/v1alpha1/capabilities"));
  }

  async submitCommand(input: string | unknown): Promise<SupervisorCommandAcceptance> {
    const result = await this.#request(
      "POST",
      "/api/v1alpha1/commands",
      typeof input === "string" ? input : canonicalStringify(input),
    );
    if (result.status !== 202 || typeof result.headers.location !== "string") {
      throw new Error("Supervisor command response must be 202 with Location");
    }
    const acceptance = decodeSupervisorCommandAcceptance(result.body);
    if (
      result.headers.location !== `/api/v1alpha1/commands/${acceptance.location.commandId}/receipt`
    ) {
      throw new Error("Supervisor command Location is invalid");
    }
    return acceptance;
  }

  async getReceipt(input: string | unknown): Promise<SupervisorReceipt> {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    const commandId = localObject(value).commandId;
    if (typeof commandId !== "string")
      return decodeSupervisorReceipt(await this.#json("GET", "/invalid"));
    return decodeSupervisorReceipt(
      await this.#json("GET", `/api/v1alpha1/commands/${encodeURIComponent(commandId)}/receipt`),
    );
  }

  async listReceipts(input: string | unknown): Promise<ReceiptPage> {
    return decodeReceiptPage(await this.#json("GET", pagePath(input, "receipts")));
  }

  async listEvents(input: string | unknown): Promise<EventReplayPage> {
    return decodeEventReplayPage(await this.#json("GET", pagePath(input, "events")));
  }

  async getProjection(input: string | unknown): Promise<ProjectionEnvelope> {
    const request = exactClientObject(input, ["repositoryId", "runId"]);
    return decodeProjectionEnvelope(
      await this.#json(
        "GET",
        `/api/v1alpha1/repositories/${segment(request.repositoryId)}/runs/${segment(request.runId)}/projections/phase-lifecycle`,
      ),
    );
  }

  async listAmendments(input: string | unknown): Promise<readonly AmendmentReviewRecord[]> {
    const request = exactClientObject(input, ["repositoryId", "runId"]);
    return decodeAmendmentReviewRecords(
      await this.#json("GET", amendmentPath(request.repositoryId, request.runId)),
    );
  }

  async getAmendment(input: string | unknown): Promise<AmendmentReviewRecord> {
    const request = exactClientObject(input, ["repositoryId", "runId", "amendmentId"]);
    return decodeAmendmentReviewRecord(
      await this.#json(
        "GET",
        `${amendmentPath(request.repositoryId, request.runId)}/${segment(request.amendmentId)}`,
      ),
    );
  }

  async getAmendmentSource(input: string | unknown): Promise<JsonValue> {
    const request = exactClientObject(input, ["repositoryId", "runId", "amendmentId"]);
    return decodeCanonicalJsonValue(
      await this.#json(
        "GET",
        `${amendmentPath(request.repositoryId, request.runId)}/${segment(request.amendmentId)}/source`,
      ),
    );
  }

  async listPortalRepositories(input: string | unknown = {}): Promise<PortalRepositoryPage> {
    const request = exactClientObject(input, [], ["after", "limit"]);
    return decodePortalRepositoryPage(
      await this.#json("GET", `/api/v1alpha1/repositories${lexicalQuery(request)}`),
    );
  }

  async listPortalRuns(input: string | unknown): Promise<PortalRunPage> {
    const request = exactClientObject(input, ["repositoryId"], ["after", "limit"]);
    return decodePortalRunPage(
      await this.#json(
        "GET",
        `/api/v1alpha1/repositories/${segment(request.repositoryId)}/runs${lexicalQuery(request)}`,
      ),
    );
  }

  async getPortalRunOverview(input: string | unknown): Promise<PortalRunOverview> {
    const request = exactClientObject(input, ["repositoryId", "runId"]);
    return decodePortalRunOverview(await this.#json("GET", `${portalRunPath(request)}/overview`));
  }

  async getPortalGraph(input: string | unknown): Promise<PortalGraphSummary> {
    const request = exactClientObject(input, ["repositoryId", "runId"]);
    return decodePortalGraphSummary(await this.#json("GET", `${portalRunPath(request)}/graph`));
  }

  async listPortalGraphNodes(input: string | unknown): Promise<PortalGraphNodePage> {
    return (await this.#portalGraphPage(input, "nodes")) as PortalGraphNodePage;
  }

  async listPortalGraphEdges(input: string | unknown): Promise<PortalGraphEdgePage> {
    return (await this.#portalGraphPage(input, "edges")) as PortalGraphEdgePage;
  }

  async getPortalRecord(input: string | unknown): Promise<PortalImmutableRecord> {
    const request = exactClientObject(input, ["repositoryId", "runId", "kind", "digest"]);
    return decodePortalImmutableRecord(
      await this.#json(
        "GET",
        `${portalRunPath(request)}/records/${segment(request.kind)}/${segment(request.digest)}`,
      ),
    );
  }

  async listPortalHumanNeeds(input: string | unknown): Promise<PortalHumanNeedPage> {
    const request = exactClientObject(input, ["repositoryId", "runId"], ["after", "limit"]);
    return decodePortalHumanNeedPage(
      await this.#json("GET", `${portalRunPath(request)}/needs${lexicalQuery(request)}`),
    );
  }

  async getPortalAllowanceReview(input: string | unknown): Promise<PortalAllowanceReview> {
    const request = exactClientObject(input, ["repositoryId", "runId", "escalationCommandId"]);
    return decodePortalAllowanceReview(
      await this.#json(
        "GET",
        `${portalRunPath(request)}/allowances/${segment(request.escalationCommandId)}`,
      ),
    );
  }

  async listPortalQuestions(input: string | unknown): Promise<PortalQuestionPage> {
    const request = exactClientObject(input, ["repositoryId", "runId"], ["after", "limit"]);
    return decodePortalQuestionPage(
      await this.#json("GET", `${portalRunPath(request)}/questions${lexicalQuery(request)}`),
    );
  }

  async getPortalQuestion(input: string | unknown): Promise<PortalQuestionRecord> {
    const request = exactClientObject(input, ["repositoryId", "runId", "submissionId"]);
    return decodePortalQuestionRecord(
      await this.#json(
        "GET",
        `${portalRunPath(request)}/questions/${segment(request.submissionId)}`,
      ),
    );
  }

  async listPortalArtifacts(input: string | unknown): Promise<PortalArtifactPage> {
    const request = exactClientObject(input, ["repositoryId", "runId"], ["after", "limit"]);
    return decodePortalArtifactPage(
      await this.#json("GET", `${portalRunPath(request)}/artifacts${lexicalQuery(request)}`),
    );
  }

  async getPortalArtifactContent(input: string | unknown): Promise<PortalArtifactContent> {
    const request = exactClientObject(input, [
      "repositoryId",
      "runId",
      "artifactId",
      "offset",
      "length",
    ]);
    const query = new URLSearchParams({
      offset: String(request.offset),
      length: String(request.length),
    });
    return decodePortalArtifactContent(
      await this.#json(
        "GET",
        `${portalRunPath(request)}/artifacts/${segment(request.artifactId)}/content?${query}`,
      ),
    );
  }

  async listPortalWorkspaces(input: string | unknown): Promise<PortalWorkspacePage> {
    const request = exactClientObject(input, ["repositoryId", "runId"], ["after", "limit"]);
    return decodePortalWorkspacePage(
      await this.#json("GET", `${portalRunPath(request)}/workspaces${lexicalQuery(request)}`),
    );
  }

  async listPortalIntegrations(input: string | unknown): Promise<PortalIntegrationPage> {
    const request = exactClientObject(input, ["repositoryId", "runId"], ["after", "limit"]);
    return decodePortalIntegrationPage(
      await this.#json("GET", `${portalRunPath(request)}/integrations${lexicalQuery(request)}`),
    );
  }

  async listPortalReceipts(input: string | unknown): Promise<PortalReceiptWindow> {
    return decodePortalReceiptWindow(
      await this.#json("GET", portalActivityPath(input, "receipts")),
    );
  }

  async listPortalEvents(input: string | unknown): Promise<PortalEventWindow> {
    return decodePortalEventWindow(await this.#json("GET", portalActivityPath(input, "events")));
  }

  async createPortalSession(): Promise<{ readonly expiresAt: string; readonly path: string }> {
    const value = localObject(await this.#json("POST", "/api/v1alpha1/portal-sessions"));
    if (typeof value.expiresAt !== "string" || typeof value.path !== "string") {
      throw new Error("Portal session bootstrap response is invalid");
    }
    return { expiresAt: value.expiresAt, path: value.path };
  }

  async status(): Promise<SupervisorServiceStatus> {
    return decodeSupervisorServiceStatus(await this.#json("GET", "/supervisor/v1alpha1/status"));
  }

  async drain(): Promise<void> {
    await this.#json("POST", "/supervisor/v1alpha1/drain");
  }

  async stop(): Promise<void> {
    await this.#json("POST", "/supervisor/v1alpha1/stop");
  }

  async recover(input: string | unknown): Promise<{ readonly worked: boolean }> {
    const request = exactClientObject(input, ["repositoryId", "runId"]);
    const value = localObject(
      await this.#requestJson("POST", "/supervisor/v1alpha1/recoveries", request),
    );
    if (typeof value.worked !== "boolean" || Object.keys(value).length !== 1) {
      throw new Error("Supervisor recovery response is invalid");
    }
    return Object.freeze({ worked: value.worked });
  }

  async backupState(
    input: string | unknown,
  ): Promise<{ readonly requestId: string; readonly verified: true }> {
    const request = exactClientObject(input, ["requestId", "destinationDirectory"]);
    const value = localObject(
      await this.#requestJson("POST", "/supervisor/v1alpha1/backups", request),
    );
    if (
      typeof value.requestId !== "string" ||
      value.verified !== true ||
      Object.keys(value).sort().join(",") !== "requestId,verified"
    ) {
      throw new Error("Supervisor backup response is invalid");
    }
    return Object.freeze({ requestId: value.requestId, verified: true });
  }

  async logs(afterCursor?: number, limit?: number): Promise<SupervisorLogPage> {
    const query = new URLSearchParams();
    if (afterCursor !== undefined) query.set("after", String(afterCursor));
    if (limit !== undefined) query.set("limit", String(limit));
    return decodeSupervisorLogPage(
      await this.#json("GET", `/supervisor/v1alpha1/logs${query.size === 0 ? "" : `?${query}`}`),
    );
  }

  async consumePortalBootstrap(path: string): Promise<void> {
    const result = await this.#request("GET", path);
    if (result.status !== 303 || result.headers.location !== "/portal/") {
      throw new Error("Portal bootstrap redirect is invalid");
    }
    const cookie = result.headers["set-cookie"]?.[0];
    const sessionCookie = cookie?.split(";", 1)[0];
    if (sessionCookie === undefined || !sessionCookie.startsWith("senawa_session=")) {
      throw new Error("Portal bootstrap cookie is invalid");
    }
    this.#sessionCookie = sessionCookie;
    const descriptor = localObject(await this.#json("GET", "/api/v1alpha1/session"));
    if (descriptor.csrfMode !== "available") {
      throw new Error("Portal session is not available for CSRF issuance");
    }
    const session = localObject(await this.#json("POST", "/api/v1alpha1/session"));
    if (typeof session.csrfToken !== "string") throw new Error("Portal CSRF response is invalid");
    this.#csrfToken = session.csrfToken;
  }

  async #portalGraphPage(
    input: string | unknown,
    resource: "nodes" | "edges",
  ): Promise<PortalGraphNodePage | PortalGraphEdgePage> {
    const request = exactClientObject(
      input,
      ["repositoryId", "runId", "graphRevision"],
      ["after", "limit"],
    );
    const query = new URLSearchParams({ revision: String(request.graphRevision) });
    if (request.after !== undefined) query.set("after", String(request.after));
    if (request.limit !== undefined) query.set("limit", String(request.limit));
    const value = await this.#json("GET", `${portalRunPath(request)}/graph/${resource}?${query}`);
    return resource === "nodes"
      ? decodePortalGraphNodePage(value)
      : decodePortalGraphEdgePage(value);
  }

  async raw(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<HttpResult> {
    return this.#request(method, path, body, headers, false);
  }

  async #json(method: string, path: string): Promise<string> {
    return (await this.#request(method, path)).body;
  }

  async #requestJson(method: string, path: string, input: unknown): Promise<string> {
    return (await this.#request(method, path, canonicalStringify(input))).body;
  }

  #request(
    method: string,
    path: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
    mapErrors = true,
  ): Promise<HttpResult> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...extraHeaders,
    };
    if (this.#credential !== undefined) headers.Authorization = `Bearer ${this.#credential}`;
    if (this.#sessionCookie !== undefined) headers.Cookie = this.#sessionCookie;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    } else if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = "0";
    }
    if (this.#socketPath === undefined) {
      headers.Host = this.#baseUrl.host;
      if (method === "POST" && this.#sessionCookie !== undefined) {
        headers.Origin = this.#baseUrl.origin;
        if (this.#csrfToken !== undefined) headers["X-Senawa-CSRF"] = this.#csrfToken;
      }
    } else {
      headers.Host = "localhost";
    }
    const options: RequestOptions = {
      method,
      path,
      headers,
      ...(this.#socketPath === undefined
        ? { hostname: this.#baseUrl.hostname, port: this.#baseUrl.port }
        : { socketPath: this.#socketPath }),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const settleOnce = (): boolean => {
        if (settled) return false;
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        return true;
      };
      const resolveOnce = (result: HttpResult): void => {
        if (!settleOnce()) return;
        resolve(result);
      };
      const rejectOnce = (error: Error): void => {
        if (!settleOnce()) return;
        reject(error);
      };
      const request = httpRequest(options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            rejectOnce(
              new HttpSupervisorClientError(
                "response-too-large",
                "Supervisor response is too large",
              ),
            );
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("aborted", () => {
          rejectOnce(
            new HttpSupervisorClientError(
              "response-aborted",
              "Supervisor response was interrupted",
            ),
          );
        });
        response.once("error", () => {
          rejectOnce(
            new HttpSupervisorClientError(
              "response-aborted",
              "Supervisor response was interrupted",
            ),
          );
        });
        response.once("end", () => {
          if (!response.complete) {
            rejectOnce(
              new HttpSupervisorClientError(
                "response-aborted",
                "Supervisor response was interrupted",
              ),
            );
            return;
          }
          const result = {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          if (mapErrors && result.status >= 400) {
            try {
              const error = decodeErrorEnvelope(result.body);
              rejectOnce(new SupervisorApiError(error.code as never, result.status, error.message));
            } catch (decodeError) {
              rejectOnce(
                decodeError instanceof SupervisorApiError
                  ? decodeError
                  : new Error("Invalid error response"),
              );
            }
          } else {
            resolveOnce(result);
          }
        });
      });
      deadline = setTimeout(() => {
        const error = new HttpSupervisorClientError(
          "request-timeout",
          "Supervisor request timed out",
        );
        rejectOnce(error);
        request.destroy(error);
      }, this.#requestTimeoutMs);
      request.once("error", () => {
        rejectOnce(new HttpSupervisorClientError("transport-error", "Supervisor request failed"));
      });
      if (body !== undefined) request.end(body);
      else request.end();
    });
  }
}

function pagePath(input: string | unknown, resource: "receipts" | "events"): string {
  const request = exactClientObject(input, ["repositoryId", "runId"], ["afterCursor", "limit"]);
  const query = new URLSearchParams();
  if (request.afterCursor !== undefined) query.set("after", String(request.afterCursor));
  if (request.limit !== undefined) query.set("limit", String(request.limit));
  const suffix = query.size === 0 ? "" : `?${query}`;
  return `/api/v1alpha1/repositories/${segment(request.repositoryId)}/runs/${segment(request.runId)}/${resource}${suffix}`;
}

function amendmentPath(repositoryId: unknown, runId: unknown): string {
  return `/api/v1alpha1/repositories/${segment(repositoryId)}/runs/${segment(runId)}/amendments`;
}

function portalRunPath(request: Record<string, unknown>): string {
  return `/api/v1alpha1/repositories/${segment(request.repositoryId)}/runs/${segment(request.runId)}`;
}

function lexicalQuery(request: Record<string, unknown>): string {
  const query = new URLSearchParams();
  if (request.after !== undefined) query.set("after", String(request.after));
  if (request.limit !== undefined) query.set("limit", String(request.limit));
  return query.size === 0 ? "" : `?${query}`;
}

function portalActivityPath(input: string | unknown, resource: "receipts" | "events"): string {
  const request = exactClientObject(input, ["repositoryId", "runId"], ["after", "before", "limit"]);
  if (request.after !== undefined && request.before !== undefined) throw invalidClientRequest();
  const query = new URLSearchParams();
  if (request.after !== undefined) query.set("after", String(request.after));
  if (request.before !== undefined) query.set("before", String(request.before));
  if (request.limit !== undefined) query.set("limit", String(request.limit));
  return `${portalRunPath(request)}/activity/${resource}${query.size === 0 ? "" : `?${query}`}`;
}

function localObject(input: string | unknown): Record<string, unknown> {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("HTTP client input must be an object");
  }
  return value as Record<string, unknown>;
}

function exactClientObject(
  input: string | unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const object = localObject(input);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(object).some((key) => !allowed.has(key))) throw invalidClientRequest();
  if (required.some((key) => !Object.hasOwn(object, key))) throw invalidClientRequest();
  return object;
}

function invalidClientRequest(): SupervisorApiError {
  return new SupervisorApiError("invalid-request", 400, "Request validation failed");
}

function segment(value: unknown): string {
  return encodeURIComponent(typeof value === "string" ? value : String(value));
}
