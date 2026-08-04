import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BrowserRunCommandSchema, type CommandActor } from "@senawa/core";
import { LeaseConflictError } from "@senawa/graph";
import type { SenawaServices } from "@senawa/orchestrator";
import { appJs, indexHtml, stylesCss } from "./static-assets.js";

const actor: CommandActor = { channel: "web" };
const cookieName = "senawa_session";

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
  services: SenawaServices,
  options: WebSupervisorOptions = {},
): Promise<WebSupervisor> {
  const selectedRunId = options.runId ?? (await services.queries.activeRunId());
  if (selectedRunId === null) throw new Error("No active run exists");
  const runId = selectedRunId;
  await services.queries.status(runId);

  const owner = `web-${randomUUID()}`;
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  await services.acquireWebLease(runId, owner, leaseTtlMs);
  const bootstrapToken = randomBytes(32).toString("base64url");
  const sessionToken = randomBytes(32).toString("base64url");
  let bootstrapAvailable = true;
  let expectedHost = "";
  let expectedOrigin = "";
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
        url.pathname === `/runs/${encodeURIComponent(runId)}` &&
        bootstrapAvailable &&
        url.searchParams.get("bootstrap") === bootstrapToken
      ) {
        bootstrapAvailable = false;
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
      await route(request, response, url, runId, expectedOrigin, services);
    } catch (error) {
      sendJson(response, statusForError(error), {
        error: { code: "request_failed", message: errorMessage(error) },
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
    await services.releaseWebLease(runId, owner).catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Web listener has no port");
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  const heartbeat = setInterval(
    () => {
      void services.acquireWebLease(runId, owner, leaseTtlMs).catch(() => void close());
    },
    Math.max(1_000, Math.floor(leaseTtlMs / 3)),
  );
  heartbeat.unref();

  async function close(): Promise<void> {
    if (closing !== null) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await services.releaseWebLease(runId, owner).catch(() => undefined);
      resolveClosed();
    })();
    return closing;
  }

  return {
    runId,
    url: `${expectedOrigin}/runs/${encodeURIComponent(runId)}`,
    bootstrapUrl: `${expectedOrigin}/runs/${encodeURIComponent(runId)}?bootstrap=${bootstrapToken}`,
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
  services: SenawaServices,
): Promise<void> {
  if (request.method === "GET" && url.pathname === `/runs/${encodeURIComponent(runId)}`) {
    sendText(response, 200, indexHtml, "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    sendText(response, 200, appJs, "text/javascript; charset=utf-8");
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
    beginSse(request, response, runId, cursor(url, request), services, (after) =>
      services.queries.journal(runId, after, 500),
    );
    return;
  }

  const streamMatch = url.pathname.match(
    new RegExp(`^${escapeRegex(prefix)}/streams/([^/]+)/(records|events)$`, "u"),
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
    } else {
      beginSse(request, response, runId, after, services, (next) =>
        services.queries.output(runId, owner.kind, owner.id, next, 500),
      );
    }
    return;
  }

  const artifactMatch = url.pathname.match(
    new RegExp(`^${escapeRegex(prefix)}/phases/([a-z0-9._-]+)/artifacts/([1-9][0-9]*)$`, "u"),
  );
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
    if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
      sendJson(response, 415, { error: { code: "content_type", message: "JSON required" } });
      return;
    }
    const command = BrowserRunCommandSchema.parse(await readJsonBody(request));
    const result = await executeBrowserCommand(command, runId, services);
    sendJson(response, 202, {
      apiVersion: "senawa.dev/browser-command-result/v1",
      accepted: true,
      result,
      snapshot: await services.queries.status(runId),
    });
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "Not found" } });
}

async function executeBrowserCommand(
  command: ReturnType<typeof BrowserRunCommandSchema.parse>,
  runId: string,
  services: SenawaServices,
) {
  switch (command.command) {
    case "approve":
      return services.commands.approve(runId, command.phaseId, actor, command.note);
    case "reject":
      return services.commands.reject(runId, command.phaseId, command.reason, actor);
    case "steer":
      return services.commands.steer(runId, command.taskId, command.instruction, actor);
    case "resume":
      return services.commands.resume(runId, actor);
    case "end":
      return services.commands.end(runId, command.reason, actor);
  }
}

function beginSse<T extends { seq: number }>(
  request: IncomingMessage,
  response: ServerResponse,
  runId: string,
  initialCursor: number,
  services: SenawaServices,
  read: (after: number) => Promise<readonly T[]>,
): void {
  securityHeaders(response, "text/event-stream; charset=utf-8");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.writeHead(200);
  response.write("retry: 1000\n\n");
  let current = initialCursor;
  let flushing = false;
  let pending = true;
  const flush = async () => {
    if (flushing) {
      pending = true;
      return;
    }
    flushing = true;
    try {
      do {
        pending = false;
        for (const record of await read(current)) {
          if (record.seq <= current) continue;
          response.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
          current = record.seq;
        }
      } while (pending);
    } catch {
      response.end();
    } finally {
      flushing = false;
    }
  };
  const unsubscribe = services.notifier.subscribe((changedRunId) => {
    if (changedRunId === runId) void flush();
  });
  void flush();
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
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

function parseStream(value: string): { kind: "run" | "phase" | "task"; id: string } {
  const match = value.match(/^(run|phase|task):([a-z0-9]+(?:[._-][a-z0-9]+)*)$/u);
  if (match === null) throw new Error("Unknown output stream");
  return { kind: match[1] as "run" | "phase" | "task", id: match[2] ?? "" };
}

function cursor(url: URL, request: IncomingMessage): number {
  const raw = url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
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
    "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'",
  );
}

class BodyTooLargeError extends Error {}

function statusForError(error: unknown): number {
  if (error instanceof BodyTooLargeError) return 413;
  if (error instanceof LeaseConflictError) return 409;
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return 400;
  }
  return 409;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
