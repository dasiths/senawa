import {
  type DurableReceipt,
  decodeCanonicalJsonValue,
  decodeDurableReceipt,
  decodeErrorEnvelope,
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
  decodePortalSessionDescriptor,
  decodePortalWorkspacePage,
  decodeSupervisorReceipt,
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
  type PortalRecordKind,
  type PortalRepositoryPage,
  type PortalRunOverview,
  type PortalRunPage,
  type PortalSessionDescriptor,
  type PortalWorkspacePage,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
} from "@senawa/protocol";

type Decoder<Value> = (input: string | unknown) => Value;

export class PortalTransportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "PortalTransportError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PortalHttpClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onUnauthorized?: () => void;
}

export class PortalHttpClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #onUnauthorized: () => void;
  #csrfToken: string | undefined;

  constructor(options: PortalHttpClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#onUnauthorized = options.onUnauthorized ?? (() => undefined);
  }

  setCsrfToken(token: string | undefined): void {
    this.#csrfToken = token;
  }

  session(): Promise<PortalSessionDescriptor> {
    return this.#get("/api/v1alpha1/session", decodePortalSessionDescriptor);
  }

  async issueCsrf(): Promise<string> {
    const value = await this.#request("/api/v1alpha1/session", { method: "POST" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new PortalTransportError(502, "invalid-response", "Session response was not JSON");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      typeof (parsed as { readonly csrfToken?: unknown }).csrfToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test((parsed as { readonly csrfToken: string }).csrfToken)
    ) {
      throw new PortalTransportError(502, "invalid-response", "Session token response was invalid");
    }
    return (parsed as { readonly csrfToken: string }).csrfToken;
  }

  repositories(): Promise<PortalRepositoryPage> {
    return this.#get("/api/v1alpha1/repositories?limit=100", decodePortalRepositoryPage);
  }

  runs(repositoryId: string): Promise<PortalRunPage> {
    return this.#get(`${runBase(repositoryId)}?limit=100`, decodePortalRunPage);
  }

  overview(repositoryId: string, runId: string): Promise<PortalRunOverview> {
    return this.#get(`${runBase(repositoryId, runId)}/overview`, decodePortalRunOverview);
  }

  graph(repositoryId: string, runId: string): Promise<PortalGraphSummary> {
    return this.#get(`${runBase(repositoryId, runId)}/graph`, decodePortalGraphSummary);
  }

  graphNodes(
    repositoryId: string,
    runId: string,
    revision: string,
    after = 0,
  ): Promise<PortalGraphNodePage> {
    return this.#get(
      `${runBase(repositoryId, runId)}/graph/nodes?revision=${encodeURIComponent(revision)}&after=${after}&limit=200`,
      decodePortalGraphNodePage,
    );
  }

  graphEdges(
    repositoryId: string,
    runId: string,
    revision: string,
    after = 0,
  ): Promise<PortalGraphEdgePage> {
    return this.#get(
      `${runBase(repositoryId, runId)}/graph/edges?revision=${encodeURIComponent(revision)}&after=${after}&limit=200`,
      decodePortalGraphEdgePage,
    );
  }

  needs(repositoryId: string, runId: string): Promise<PortalHumanNeedPage> {
    return this.#get(`${runBase(repositoryId, runId)}/needs?limit=100`, decodePortalHumanNeedPage);
  }

  allowanceReview(
    repositoryId: string,
    runId: string,
    escalationCommandId: string,
  ): Promise<PortalAllowanceReview> {
    return this.#get(
      `${runBase(repositoryId, runId)}/allowances/${encodeURIComponent(escalationCommandId)}`,
      decodePortalAllowanceReview,
    );
  }

  questions(repositoryId: string, runId: string): Promise<PortalQuestionPage> {
    return this.#get(
      `${runBase(repositoryId, runId)}/questions?limit=100`,
      decodePortalQuestionPage,
    );
  }

  question(
    repositoryId: string,
    runId: string,
    submissionId: string,
  ): Promise<PortalQuestionRecord> {
    return this.#get(
      `${runBase(repositoryId, runId)}/questions/${encodeURIComponent(submissionId)}`,
      decodePortalQuestionRecord,
    );
  }

  artifacts(repositoryId: string, runId: string): Promise<PortalArtifactPage> {
    return this.#get(
      `${runBase(repositoryId, runId)}/artifacts?limit=100`,
      decodePortalArtifactPage,
    );
  }

  artifactContent(
    repositoryId: string,
    runId: string,
    artifactId: string,
    offset = 0,
  ): Promise<PortalArtifactContent> {
    return this.#get(
      `${runBase(repositoryId, runId)}/artifacts/${encodeURIComponent(artifactId)}/content?offset=${offset}&length=65536`,
      decodePortalArtifactContent,
    );
  }

  workspaces(repositoryId: string, runId: string): Promise<PortalWorkspacePage> {
    return this.#get(
      `${runBase(repositoryId, runId)}/workspaces?limit=100`,
      decodePortalWorkspacePage,
    );
  }

  integrations(repositoryId: string, runId: string): Promise<PortalIntegrationPage> {
    return this.#get(
      `${runBase(repositoryId, runId)}/integrations?limit=100`,
      decodePortalIntegrationPage,
    );
  }

  events(repositoryId: string, runId: string, before?: number): Promise<PortalEventWindow> {
    const cursor = before === undefined ? "" : `&before=${before}`;
    return this.#get(
      `${runBase(repositoryId, runId)}/activity/events?limit=100${cursor}`,
      decodePortalEventWindow,
    );
  }

  receipts(repositoryId: string, runId: string, before?: number): Promise<PortalReceiptWindow> {
    const cursor = before === undefined ? "" : `&before=${before}`;
    return this.#get(
      `${runBase(repositoryId, runId)}/activity/receipts?limit=100${cursor}`,
      decodePortalReceiptWindow,
    );
  }

  record(
    repositoryId: string,
    runId: string,
    kind: PortalRecordKind,
    digest: string,
  ): Promise<PortalImmutableRecord> {
    return this.#get(
      `${runBase(repositoryId, runId)}/records/${kind}/${encodeURIComponent(digest)}`,
      decodePortalImmutableRecord,
    );
  }

  amendment(repositoryId: string, runId: string, amendmentId?: string): Promise<JsonValue> {
    const suffix = amendmentId === undefined ? "" : `/${encodeURIComponent(amendmentId)}`;
    return this.#get(
      `${runBase(repositoryId, runId)}/amendments${suffix}`,
      decodeCanonicalJsonValue,
    );
  }

  amendmentSource(repositoryId: string, runId: string, amendmentId: string): Promise<JsonValue> {
    return this.#get(
      `${runBase(repositoryId, runId)}/amendments/${encodeURIComponent(amendmentId)}/source`,
      decodeCanonicalJsonValue,
    );
  }

  async postCanonicalSubmission(canonicalSubmission: string): Promise<void> {
    const response = await this.#raw("/api/v1alpha1/commands", {
      method: "POST",
      body: canonicalSubmission,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    if (response.status !== 202) await this.#throwResponse(response);
    await readBounded(response);
  }

  async receipt(commandId: string): Promise<DurableReceipt | undefined> {
    const response = await this.#raw(
      `/api/v1alpha1/commands/${encodeURIComponent(commandId)}/receipt`,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) await this.#throwResponse(response);
    const receipt = decodeSupervisorReceipt(await readBounded(response));
    if (receipt.status === "terminal") return receipt.terminalReceipt;
    return decodeDurableReceipt({
      apiVersion: PROTOCOL_VERSION,
      commandId: receipt.commandId,
      repositoryId: receipt.repositoryId,
      runId: receipt.runId,
      status: receipt.status,
      cursor: receipt.sequence,
    });
  }

  async #get<Value>(path: string, decoder: Decoder<Value>): Promise<Value> {
    return decoder(await this.#request(path));
  }

  async #request(path: string, init: RequestInit = {}): Promise<string> {
    const response = await this.#raw(path, init);
    if (!response.ok) await this.#throwResponse(response);
    return readBounded(response);
  }

  async #raw(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(path, {
        ...init,
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(this.#csrfToken === undefined || init.method !== "POST"
            ? {}
            : { "X-Senawa-CSRF": this.#csrfToken }),
          ...init.headers,
        },
      });
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "Request deadline exceeded"
          : "Request failed";
      throw new PortalTransportError(0, "network-error", message, true);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async #throwResponse(response: Response): Promise<never> {
    if (response.status === 401) this.#onUnauthorized();
    try {
      const error = decodeErrorEnvelope(await readBounded(response));
      throw new PortalTransportError(response.status, error.code, error.message, error.retryable);
    } catch (error) {
      if (error instanceof PortalTransportError) throw error;
      throw new PortalTransportError(
        response.status,
        "request-failed",
        safeStatusMessage(response.status),
      );
    }
  }
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > PROTOCOL_LIMITS.maxWireBytes)
  ) {
    throw new PortalTransportError(
      502,
      "oversized-response",
      "Response exceeded the protocol limit",
    );
  }
  const value = await response.text();
  if (new TextEncoder().encode(value).byteLength > PROTOCOL_LIMITS.maxWireBytes) {
    throw new PortalTransportError(
      502,
      "oversized-response",
      "Response exceeded the protocol limit",
    );
  }
  return value;
}

function runBase(repositoryId: string, runId?: string): string {
  const repository = `/api/v1alpha1/repositories/${encodeURIComponent(repositoryId)}/runs`;
  return runId === undefined ? repository : `${repository}/${encodeURIComponent(runId)}`;
}

function safeStatusMessage(status: number): string {
  if (status === 401) return "Portal session expired";
  if (status === 403) return "Request was not authorized";
  if (status === 404) return "Requested portal record was not found";
  if (status === 409) return "Request conflicts with current authority state";
  if (status === 503) return "Portal authority is temporarily unavailable";
  return "Portal request failed";
}
