import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BrowserCommandIdConflictError,
  BrowserCommandInProgressError,
  type DurableBrowserCommandService,
  LeaseConflictError,
  QuestionSubmissionConflictError,
  QuestionUnavailableError,
  type RunChangeNotificationPort,
  type RunCommandService,
  type RunQueryService,
} from "@senawa/application";
import {
  BrowserQuestionAnswerSchema,
  BrowserRunCommandSchema,
  IdentifierSchema,
  type RuntimeLease,
} from "@senawa/domain";
import { beginSse } from "./sse.js";
import {
  appJs,
  cytoscapeDagreJs,
  cytoscapeJs,
  dagreJs,
  indexHtml,
  stylesCss,
} from "./static-assets.js";

const cookieName = "senawa_session";

export interface BrowserServices {
  readonly commands: Pick<RunCommandService, "answer">;
  readonly browserCommands: Pick<
    DurableBrowserCommandService,
    "submit" | "receipt" | "activeReceipt" | "receipts" | "processNext"
  >;
  readonly queries: Pick<
    RunQueryService,
    | "activeRunId"
    | "status"
    | "openWorkerQuestions"
    | "journal"
    | "output"
    | "workerEvents"
    | "phaseBrief"
    | "artifact"
  >;
  readonly notifier: RunChangeNotificationPort;
  acquireWebLease(runId: string, owner: string, ttlMs: number): Promise<RuntimeLease>;
  renewWebLease(runId: string, lease: RuntimeLease, ttlMs: number): Promise<RuntimeLease>;
  releaseWebLease(runId: string, lease: RuntimeLease): Promise<void>;
}

export interface WebSupervisorOptions {
  readonly runId?: string;
  readonly port?: number;
  readonly leaseTtlMs?: number;
}

export interface WebSupervisor {
  readonly runId: string;
  readonly url: string;
  readonly bootstrapUrl: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function startWebSupervisor(
  services: BrowserServices,
  options: WebSupervisorOptions = {},
): Promise<WebSupervisor> {
  const selectedRunId = options.runId ?? (await services.queries.activeRunId());
  if (selectedRunId === null) throw new Error("No active run exists");
  const runId = selectedRunId;
  await services.queries.status(runId);

  const owner = `web-${randomUUID()}`;
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  let webLease = await services.acquireWebLease(runId, owner, leaseTtlMs);
  const bootstrapToken = randomBytes(32).toString("base64url");
  const sessionToken = randomBytes(32).toString("base64url");
  let expectedHost = "";
  let expectedOrigin = "";
  let stopping = false;
  let draining: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== expectedHost) {
        sendJson(response, 403, { error: { code: "host_rejected", message: "Host rejected" } });
        return;
      }
      const url = new URL(request.url ?? "/", expectedOrigin);
      if (
        request.method === "GET" &&
        url.pathname === `/bootstrap/${bootstrapToken}/runs/${encodeURIComponent(runId)}`
      ) {
        response.setHeader(
          "Set-Cookie",
          `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
        );
        securityHeaders(response, "text/plain; charset=utf-8");
        response.writeHead(303, { Location: `/runs/${encodeURIComponent(runId)}` });
        response.end();
        return;
      }
      if (!authorized(request, sessionToken)) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "Unauthorized" } });
        return;
      }
      await route(request, response, url, runId, expectedOrigin, services, () => void drain());
    } catch (error) {
      sendJson(response, statusForError(error), {
        error: { code: errorCode(error), message: errorMessage(error) },
      });
    }
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    await services.releaseWebLease(runId, webLease).catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Web listener has no port");
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  const heartbeat = setInterval(
    () => {
      void services
        .renewWebLease(runId, webLease, leaseTtlMs)
        .then((renewed) => {
          webLease = renewed;
        })
        .catch(() => void close());
    },
    Math.max(1_000, Math.floor(leaseTtlMs / 3)),
  );
  heartbeat.unref();
  void drain();

  function drain(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (draining !== null) return draining;
    draining = (async () => {
      while (
        !stopping &&
        (await services.browserCommands.processNext(runId, webLease, leaseTtlMs))
      ) {
        // Version 1 permits one nonterminal command, but loop after recovery for completeness.
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        draining = null;
      });
    return draining;
  }

  async function close(): Promise<void> {
    if (closing !== null) return closing;
    closing = (async () => {
      stopping = true;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await draining;
      clearInterval(heartbeat);
      await services.releaseWebLease(runId, webLease).catch(() => undefined);
      resolveClosed();
    })();
    return closing;
  }

  return {
    runId,
    url: `${expectedOrigin}/runs/${encodeURIComponent(runId)}`,
    bootstrapUrl: `${expectedOrigin}/bootstrap/${bootstrapToken}/runs/${encodeURIComponent(runId)}`,
    closed,
    close,
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runId: string,
  expectedOrigin: string,
  services: BrowserServices,
  commandSubmitted: () => void,
): Promise<void> {
  if (request.method === "GET" && url.pathname === `/runs/${encodeURIComponent(runId)}`) {
    sendText(response, 200, indexHtml, "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    sendText(response, 200, appJs, "text/javascript; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/dagre.js") {
    sendText(response, 200, dagreJs, "text/javascript; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/cytoscape.js") {
    sendText(response, 200, cytoscapeJs, "text/javascript; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/cytoscape-dagre.js") {
    sendText(response, 200, cytoscapeDagreJs, "text/javascript; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/styles.css") {
    sendText(response, 200, stylesCss, "text/css; charset=utf-8");
    return;
  }

  const prefix = `/api/v1/runs/${encodeURIComponent(runId)}`;
  if (request.method === "GET" && url.pathname === `${prefix}/snapshot`) {
    sendJson(response, 200, await services.queries.status(runId));
    return;
  }
  if (request.method === "GET" && url.pathname === `${prefix}/events`) {
    sendJson(
      response,
      200,
      await services.queries.journal(runId, cursor(url, request), limit(url)),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === `${prefix}/events/stream`) {
    beginSse(request, response, {
      runId,
      initialCursor: cursor(url, request),
      notifier: services.notifier,
      read: (after) => services.queries.journal(runId, after, 500),
      prepareHeaders: (target) => securityHeaders(target, "text/event-stream; charset=utf-8"),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === `${prefix}/questions/open`) {
    sendJson(response, 200, {
      apiVersion: "senawa.dev/open-worker-questions/v1",
      questions: await services.queries.openWorkerQuestions(runId),
    });
    return;
  }
  const answerMatch = url.pathname.match(
    new RegExp(`^${escapeRegex(prefix)}/questions/([^/]+)/answer$`, "u"),
  );
  if (request.method === "POST" && answerMatch !== null) {
    if (request.headers.origin !== expectedOrigin) {
      sendJson(response, 403, { error: { code: "origin_rejected", message: "Origin rejected" } });
      return;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      sendJson(response, 415, { error: { code: "content_type", message: "JSON required" } });
      return;
    }
    const questionId = IdentifierSchema.parse(decodeURIComponent(answerMatch[1] ?? ""));
    const input = BrowserQuestionAnswerSchema.parse(await readJsonBody(request));
    await services.commands.answer(runId, questionId, input.answer, { channel: "web" }, input);
    sendJson(response, 200, {
      apiVersion: "senawa.dev/question-answer-result/v1",
      questionId,
      status: "answered",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === `${prefix}/commands/active`) {
    sendJson(response, 200, {
      apiVersion: "senawa.dev/browser-command-receipt-result/v1",
      receipt: await services.browserCommands.activeReceipt(runId),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === `${prefix}/commands/events`) {
    beginSse(request, response, {
      runId,
      initialCursor: cursor(url, request),
      notifier: services.notifier,
      read: (after) => services.browserCommands.receipts(runId, after, 500),
      prepareHeaders: (target) => securityHeaders(target, "text/event-stream; charset=utf-8"),
    });
    return;
  }
  const receiptMatch = url.pathname.match(
    new RegExp(
      `^${escapeRegex(prefix)}/commands/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`,
      "u",
    ),
  );
  if (request.method === "GET" && receiptMatch !== null) {
    const receipt = await services.browserCommands.receipt(runId, receiptMatch[1] ?? "");
    if (receipt === null) {
      sendJson(response, 404, { error: { code: "not_found", message: "Receipt not found" } });
    } else {
      sendJson(response, 200, {
        apiVersion: "senawa.dev/browser-command-receipt-result/v1",
        receipt,
      });
    }
    return;
  }

  const streamMatch = url.pathname.match(
    new RegExp(`^${escapeRegex(prefix)}/streams/([^/]+)/(records|events|worker-events)$`, "u"),
  );
  if (request.method === "GET" && streamMatch !== null) {
    const owner = parseStream(decodeURIComponent(streamMatch[1] ?? ""));
    const after = cursor(url, request);
    if (streamMatch[2] === "records") {
      sendJson(
        response,
        200,
        await services.queries.output(runId, owner.kind, owner.id, after, limit(url)),
      );
    } else if (streamMatch[2] === "events") {
      beginSse(request, response, {
        runId,
        initialCursor: after,
        notifier: services.notifier,
        read: (next) => services.queries.output(runId, owner.kind, owner.id, next, 500),
        prepareHeaders: (target) => securityHeaders(target, "text/event-stream; charset=utf-8"),
      });
    } else if (owner.kind === "run") {
      sendJson(response, 400, {
        error: { code: "invalid_stream", message: "Run owners have no worker event stream" },
      });
    } else {
      const workerKind: "phase" | "task" = owner.kind === "phase" ? "phase" : "task";
      beginSse(request, response, {
        runId,
        initialCursor: after,
        notifier: services.notifier,
        read: (next) => services.queries.workerEvents(runId, workerKind, owner.id, next, 500),
        prepareHeaders: (target) => securityHeaders(target, "text/event-stream; charset=utf-8"),
      });
    }
    return;
  }

  const artifactMatch = url.pathname.match(
    new RegExp(`^${escapeRegex(prefix)}/phases/([a-z0-9._-]+)/artifacts/([1-9][0-9]*)$`, "u"),
  );
  const briefMatch = url.pathname.match(
    new RegExp(`^${escapeRegex(prefix)}/phases/([a-z0-9._-]+)/brief$`, "u"),
  );
  if (request.method === "GET" && briefMatch !== null) {
    sendJson(response, 200, await services.queries.phaseBrief(runId, briefMatch[1] ?? ""));
    return;
  }
  if (request.method === "GET" && artifactMatch !== null) {
    const artifact = await services.queries.artifact(
      runId,
      artifactMatch[1] ?? "",
      Number(artifactMatch[2]),
    );
    if (artifact === null) {
      sendJson(response, 404, { error: { code: "not_found", message: "Artifact not found" } });
    } else {
      sendJson(response, 200, artifact);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === `${prefix}/commands`) {
    if (request.headers.origin !== expectedOrigin) {
      sendJson(response, 403, { error: { code: "origin_rejected", message: "Origin rejected" } });
      return;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      sendJson(response, 415, { error: { code: "content_type", message: "JSON required" } });
      return;
    }
    const command = BrowserRunCommandSchema.parse(await readJsonBody(request));
    const receipt = await services.browserCommands.submit(runId, command);
    response.setHeader("Location", `${prefix}/commands/${encodeURIComponent(receipt.commandId)}`);
    sendJson(response, 202, {
      apiVersion: "senawa.dev/browser-command-receipt-result/v1",
      receipt,
    });
    commandSubmitted();
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "Not found" } });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 8_192) throw new BodyTooLargeError();
  }
  return JSON.parse(body || "{}");
}

function authorized(request: IncomingMessage, token: string): boolean {
  return (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${cookieName}=${token}`);
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function parseStream(value: string): { kind: "run" | "phase" | "task"; id: string } {
  const match = value.match(/^(run|phase|task):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u);
  if (match === null) throw new Error("Unknown output stream");
  return { kind: match[1] as "run" | "phase" | "task", id: match[2] ?? "" };
}

function cursor(url: URL, request: IncomingMessage): number {
  const raw = request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid replay cursor");
  return value;
}

function limit(url: URL): number {
  const value = Number(url.searchParams.get("limit") ?? "200");
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Error("Invalid limit");
  return value;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(response, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

function sendText(
  response: ServerResponse,
  status: number,
  value: string,
  contentType: string,
): void {
  if (response.headersSent) return;
  securityHeaders(response, contentType);
  response.writeHead(status);
  response.end(value);
}

function securityHeaders(response: ServerResponse, contentType: string): void {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
  );
}

class BodyTooLargeError extends Error {}

function statusForError(error: unknown): number {
  if (error instanceof BodyTooLargeError) return 413;
  if (
    error instanceof LeaseConflictError ||
    error instanceof BrowserCommandIdConflictError ||
    error instanceof BrowserCommandInProgressError ||
    error instanceof QuestionUnavailableError ||
    error instanceof QuestionSubmissionConflictError
  ) {
    return 409;
  }
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return 400;
  }
  return 409;
}

function errorCode(error: unknown): string {
  if (error instanceof QuestionUnavailableError) return "question_unavailable";
  if (error instanceof QuestionSubmissionConflictError) return "submission_conflict";
  return "request_failed";
}

function errorMessage(error: unknown): string {
  if (error instanceof QuestionUnavailableError) return "Question is no longer available";
  if (error instanceof QuestionSubmissionConflictError)
    return "Submission conflicts with an answer";
  if (
    error instanceof LeaseConflictError ||
    error instanceof BrowserCommandIdConflictError ||
    error instanceof BrowserCommandInProgressError
  ) {
    return error.message;
  }
  if (error instanceof BodyTooLargeError) return "Request body too large";
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return "Invalid request";
  }
  return "Request failed";
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
