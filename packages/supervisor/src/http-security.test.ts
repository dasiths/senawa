import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalStringify, decodeErrorEnvelope, PROTOCOL_VERSION } from "@senawa/protocol";
import { deterministicSha256, runtimeFixture, runtimePrincipal } from "@senawa/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupervisorApi } from "./api.js";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import { HttpSupervisorClient, HttpSupervisorClientError } from "./http-client.js";
import { SupervisorHttpHandler } from "./http-handler.js";
import {
  type SupervisorHttpServerHandle,
  startLoopbackSupervisorServer,
  startUnixSupervisorServer,
} from "./http-server.js";
import {
  type LocalCredential,
  loadOrCreateLocalCredential,
  prepareUnixSocketPath,
} from "./local-security.js";
import { PORTAL_CONTENT_SECURITY_POLICY, type PortalAssetSource } from "./portal-assets.js";
import { InMemoryRunEventNotifier } from "./run-event-notifier.js";
import { PortalSessionSecurity } from "./session-security.js";
import { SseEventSource } from "./sse.js";

interface SecurityFixture {
  readonly root: string;
  readonly authority: SqliteSupervisorAuthority;
  readonly api: SupervisorApi;
  readonly credential: LocalCredential;
  readonly ipcHandler: SupervisorHttpHandler;
  readonly ipc: SupervisorHttpServerHandle;
  readonly loopback: SupervisorHttpServerHandle;
  readonly sessions: PortalSessionSecurity;
}

let fixture: SecurityFixture;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "senawa-http-security-"));
  const authority = new SqliteSupervisorAuthority({
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies: {
      sha256: deterministicSha256,
      authorization: { authorize: () => true },
    },
  });
  const api = new SupervisorApi(authority);
  const credential = loadOrCreateLocalCredential(join(root, "runtime"), {
    bytes: (length) => randomBytes(length),
  });
  const sessions = new PortalSessionSecurity({
    clock: { now: () => Date.now() },
    random: { bytes: (length) => randomBytes(length) },
  });
  const contextFactory = (_request: unknown, transportKind: "cli" | "http") => ({
    principal: runtimePrincipal,
    transportKind,
    requestId: "request_security",
    admission: {
      currentTime: runtimeFixture.currentTime,
      facts: { source: "security-test" },
      allocator: { allocationsFor: () => [] },
    },
  });
  const ipcHandler = new SupervisorHttpHandler({
    api,
    transport: "ipc",
    credential,
    sessions,
    contextFactory,
  });
  const ipc = await startUnixSupervisorServer(join(root, "runtime", "supervisor.sock"), ipcHandler);
  const loopback = await startLoopbackSupervisorServer(
    0,
    (origin) =>
      new SupervisorHttpHandler({
        api,
        transport: "loopback",
        sessions,
        loopbackOrigin: origin,
        contextFactory,
        portalAssets: testPortalAssets(),
      }),
  );
  fixture = { root, authority, api, credential, ipcHandler, ipc, loopback, sessions };
});

afterEach(async () => {
  await fixture.loopback.close();
  await fixture.ipc.close();
  fixture.authority.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

describe("supervisor HTTP security", () => {
  it("serves only authenticated verified portal assets with strict immutable headers", async () => {
    const origin = required(fixture.loopback.origin);
    expectError(await raw({ origin, path: "/portal/" }), 401, "unauthorized");
    const bootstrap = await createBootstrap();
    const redirect = await raw({ origin, path: bootstrap.path });
    const cookie = required(redirect.headers["set-cookie"]?.[0]?.split(";", 1)[0]);

    const shell = await raw({ origin, path: "/portal/", headers: { Cookie: cookie } });
    expect(shell.status).toBe(200);
    expect(shell.body).toBe("<!doctype html><main id=app></main>");
    expect(shell.headers["content-security-policy"]).toBe(PORTAL_CONTENT_SECURITY_POLICY);
    expect(shell.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(shell.headers["referrer-policy"]).toBe("no-referrer");
    expect(shell.headers["x-content-type-options"]).toBe("nosniff");
    expect(shell.headers["x-frame-options"]).toBe("DENY");
    expect(shell.headers["cache-control"]).toBe("no-store");
    expect(shell.headers["access-control-allow-origin"]).toBeUndefined();

    const asset = await raw({
      origin,
      path: "/portal/assets/app.abc123.js",
      headers: { Cookie: cookie },
    });
    expect(asset.status).toBe(200);
    expect(asset.body).toBe("console.log('portal')");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.etag).toBe(`"sha256-${"a".repeat(64)}"`);
    const unchanged = await raw({
      origin,
      path: "/portal/assets/app.abc123.js",
      headers: { Cookie: cookie, "If-None-Match": required(asset.headers.etag as string) },
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBe("");

    expectError(
      await raw({
        origin,
        path: "/portal/assets/%3Cscript%3E.js",
        headers: { Cookie: cookie },
      }),
      400,
      "invalid-request",
    );
    const missing = await raw({
      origin,
      path: "/portal/assets/missing.abc123.js",
      headers: { Cookie: cookie },
    });
    expectError(missing, 404, "not-found");
    expect(missing.body).not.toContain("missing.abc123.js");

    const unavailable = await startLoopbackSupervisorServer(
      0,
      (unavailableOrigin) =>
        new SupervisorHttpHandler({
          api: fixture.api,
          transport: "loopback",
          sessions: fixture.sessions,
          loopbackOrigin: unavailableOrigin,
          contextFactory: (_request, transportKind) => ({
            principal: runtimePrincipal,
            transportKind,
            requestId: "request_unavailable-assets",
            admission: {
              currentTime: runtimeFixture.currentTime,
              facts: {},
              allocator: { allocationsFor: () => [] },
            },
          }),
        }),
    );
    try {
      expectError(
        await raw({
          origin: required(unavailable.origin),
          path: "/portal/",
          headers: { Cookie: cookie },
        }),
        503,
        "service-unavailable",
      );
    } finally {
      await unavailable.close();
    }
  });

  it("authenticates every IPC request without reflecting credential or hostile output", async () => {
    const valid = await raw({
      socketPath: required(fixture.ipc.socketPath),
      path: "/api/v1/capabilities",
      headers: ipcHeaders(fixture.credential.token),
    });
    expect(valid.status).toBe(200);

    const wrong = await raw({
      socketPath: required(fixture.ipc.socketPath),
      path: "/api/v1/missing/%1b%5b31m",
      headers: ipcHeaders("A".repeat(43)),
    });
    expect(wrong.status).toBe(401);
    expect(decodeErrorEnvelope(wrong.body)).toMatchObject({ code: "unauthorized" });
    expect(wrong.body).not.toContain("AAAA");
    expect(wrong.body).not.toContain("31m");
  });

  it("enforces exact Host, rejects forwarding headers, and does not emit CORS headers", async () => {
    const origin = required(fixture.loopback.origin);
    const badHost = await raw({
      origin,
      path: "/portal/bootstrap?token=invalid",
      host: "localhost",
    });
    expectError(badHost, 400, "invalid-request");

    const forwarded = await raw({
      origin,
      path: "/portal/bootstrap?token=invalid",
      headers: { "X-Forwarded-For": "127.0.0.1" },
    });
    expectError(forwarded, 400, "invalid-request");
    expect(forwarded.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("consumes bootstrap once, issues CSRF once, and requires session, Origin, and CSRF", async () => {
    const origin = required(fixture.loopback.origin);
    const bootstrap = await createBootstrap();
    const first = await raw({ origin, path: bootstrap.path });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/portal/");
    const setCookie = first.headers["set-cookie"]?.[0];
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure");
    const cookie = required(setCookie?.split(";", 1)[0]);

    expectError(await raw({ origin, path: bootstrap.path }), 401, "unauthorized");
    expectError(await raw({ origin, path: "/api/v1/session" }), 401, "unauthorized");

    const descriptor = await raw({
      origin,
      path: "/api/v1/session",
      headers: { Cookie: cookie },
    });
    expect(descriptor.status).toBe(200);
    expect(JSON.parse(descriptor.body)).toMatchObject({ csrfMode: "available" });
    const csrfResponse = await raw({
      origin,
      method: "POST",
      path: "/api/v1/session",
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(csrfResponse.status).toBe(200);
    const csrf = (JSON.parse(csrfResponse.body) as { csrfToken: string }).csrfToken;
    const readOnly = await raw({
      origin,
      path: "/api/v1/session",
      headers: { Cookie: cookie },
    });
    expect(readOnly.status).toBe(200);
    expect(JSON.parse(readOnly.body)).toMatchObject({ csrfMode: "read-only" });
    expectError(
      await raw({
        origin,
        method: "POST",
        path: "/api/v1/session",
        headers: { Cookie: cookie, Origin: origin },
      }),
      409,
      "command-conflict",
    );

    const body = canonicalStringify(invalidButFramedSubmission());
    expectError(
      await raw({
        origin,
        method: "POST",
        path: "/api/v1/commands",
        body,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
      }),
      403,
      "forbidden",
    );
    expectError(
      await raw({
        origin,
        method: "POST",
        path: "/api/v1/commands",
        body,
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "X-Senawa-CSRF": "A".repeat(43),
        },
      }),
      403,
      "forbidden",
    );
    const authenticated = await raw({
      origin,
      method: "POST",
      path: "/api/v1/commands",
      body,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Senawa-CSRF": csrf,
      },
    });
    expectError(authenticated, 400, "invalid-request");
  });

  it("closes loopback SSE at session expiry before delivering later events", async () => {
    const sessions = new PortalSessionSecurity({
      clock: { now: () => Date.now() },
      random: { bytes: (length) => randomBytes(length) },
      sessionLifetimeMs: 40,
    });
    const session = sessions.consumeBootstrap(sessions.createBootstrap().token);
    if (session === undefined) throw new Error("Expected portal session");
    const notifier = new InMemoryRunEventNotifier();
    let eventAvailable = false;
    const event = {
      apiVersion: PROTOCOL_VERSION,
      cursor: 1,
      repositoryId: "repository_expiry",
      runId: "run_expiry",
      eventId: "event_expiry",
      eventType: "phase-started",
      occurredAt: runtimeFixture.currentTime,
      payload: { afterExpiry: true },
      payloadDigest: "0".repeat(64),
    } as const;
    const eventApi = {
      listEvents() {
        return {
          apiVersion: PROTOCOL_VERSION,
          repositoryId: event.repositoryId,
          runId: event.runId,
          afterCursor: 0,
          earliestAvailableCursor: eventAvailable ? 1 : 0,
          latestCursor: eventAvailable ? 1 : 0,
          hasMore: false,
          events: eventAvailable ? [event] : [],
        };
      },
    };
    const server = await startLoopbackSupervisorServer(
      0,
      (origin) =>
        new SupervisorHttpHandler({
          api: eventApi as unknown as SupervisorApi,
          transport: "loopback",
          sessions,
          loopbackOrigin: origin,
          sse: new SseEventSource({ api: eventApi, notifier, heartbeatMs: 10_000 }),
          portalAssets: testPortalAssets(),
          contextFactory: () => {
            throw new Error("Context is not used by SSE");
          },
        }),
    );
    try {
      const body = await streamBody({
        origin: required(server.origin),
        path: "/api/v1/repositories/repository_expiry/runs/run_expiry/events/stream",
        cookie: `senawa_session=${session.token}`,
        afterOpen() {
          setTimeout(() => {
            eventAvailable = true;
            notifier.notify(event.repositoryId, event.runId);
          }, 60);
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(body).not.toContain("phase-started");
      expect(body).not.toContain("afterExpiry");
      const expiredCookie = `senawa_session=${session.token}`;
      expectError(
        await raw({
          origin: required(server.origin),
          path: "/portal/",
          headers: { Cookie: expiredCookie },
        }),
        401,
        "unauthorized",
      );
      expectError(
        await raw({
          origin: required(server.origin),
          path: "/api/v1/capabilities",
          headers: { Cookie: expiredCookie },
        }),
        401,
        "unauthorized",
      );
    } finally {
      await server.close();
    }
  });

  it("suppresses replay returned after the portal session expires", async () => {
    const sessions = new PortalSessionSecurity({
      clock: { now: () => Date.now() },
      random: { bytes: (length) => randomBytes(length) },
      sessionLifetimeMs: 40,
    });
    const session = sessions.consumeBootstrap(sessions.createBootstrap().token);
    if (session === undefined) throw new Error("Expected portal session");
    let queryCount = 0;
    const event = {
      apiVersion: PROTOCOL_VERSION,
      cursor: 1,
      repositoryId: "repository_blocked-replay",
      runId: "run_blocked-replay",
      eventId: "event_blocked-replay",
      eventType: "phase-started",
      occurredAt: runtimeFixture.currentTime,
      payload: { afterExpiry: true },
      payloadDigest: "0".repeat(64),
    } as const;
    const eventApi = {
      listEvents() {
        queryCount += 1;
        if (queryCount > 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        }
        const available = queryCount > 1;
        return {
          apiVersion: PROTOCOL_VERSION,
          repositoryId: event.repositoryId,
          runId: event.runId,
          afterCursor: 0,
          earliestAvailableCursor: available ? 1 : 0,
          latestCursor: available ? 1 : 0,
          hasMore: false,
          events: available ? [event] : [],
        };
      },
    };
    const server = await startLoopbackSupervisorServer(
      0,
      (origin) =>
        new SupervisorHttpHandler({
          api: eventApi as unknown as SupervisorApi,
          transport: "loopback",
          sessions,
          loopbackOrigin: origin,
          sse: new SseEventSource({
            api: eventApi,
            notifier: new InMemoryRunEventNotifier(),
            heartbeatMs: 10_000,
          }),
          contextFactory: () => {
            throw new Error("Context is not used by SSE");
          },
        }),
    );
    try {
      const body = await streamBody({
        origin: required(server.origin),
        path: "/api/v1/repositories/repository_blocked-replay/runs/run_blocked-replay/events/stream",
        cookie: `senawa_session=${session.token}`,
        afterOpen() {},
      });
      expect(queryCount).toBe(2);
      expect(body).not.toContain("phase-started");
      expect(body).not.toContain("afterExpiry");
    } finally {
      await server.close();
    }
  });

  it.each([
    ["GET", "http://127.0.0.1/api/v1/capabilities", undefined, 400],
    ["GET", "/api//v1/capabilities", undefined, 400],
    ["GET", "/api/%2e/v1/capabilities", undefined, 400],
    ["GET", "/api%2fv1/capabilities", undefined, 400],
    ["GET", "/api/v1/capabilities?x=1", undefined, 400],
    ["POST", "/api/v1/commands", "{}", 415],
  ] as const)("rejects hostile IPC framing %s %s", async (method, path, body, status) => {
    const response = await raw({
      socketPath: required(fixture.ipc.socketPath),
      method,
      path,
      ...(body === undefined ? {} : { body }),
      headers: ipcHeaders(fixture.credential.token),
    });
    expectError(response, status, "invalid-request");
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects an oversized Content-Length before JSON parsing", async () => {
    const response = await raw({
      socketPath: required(fixture.ipc.socketPath),
      method: "POST",
      path: "/api/v1/commands",
      body: "",
      headers: {
        ...ipcHeaders(fixture.credential.token),
        "Content-Length": String(262_144 + 1_025),
        "Content-Type": "application/json",
      },
    });
    expectError(response, 413, "invalid-request");
  });

  it("rejects invalid UTF-8 before command submission", async () => {
    const submit = vi.spyOn(fixture.api, "submitCommand");
    const pendingBefore = fixture.authority.listPendingWakes();
    const response = await raw({
      socketPath: required(fixture.ipc.socketPath),
      method: "POST",
      path: "/api/v1/commands",
      body: Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]),
      headers: {
        ...ipcHeaders(fixture.credential.token),
        "Content-Type": "application/json",
      },
    });

    expectError(response, 400, "invalid-request");
    expect(submit).not.toHaveBeenCalled();
    expect(fixture.authority.listPendingWakes()).toEqual(pendingBefore);
  });

  it("authenticates Expect requests without sending interim responses", async () => {
    const continueUnauthorized = await raw({
      socketPath: required(fixture.ipc.socketPath),
      path: "/api/v1/capabilities",
      headers: { ...ipcHeaders("A".repeat(43)), Expect: "100-continue" },
    });
    expectError(continueUnauthorized, 401, "unauthorized");
    expect(continueUnauthorized.interimStatuses).toEqual([]);

    const unsupportedUnauthorized = await raw({
      socketPath: required(fixture.ipc.socketPath),
      path: "/api/v1/capabilities",
      headers: { ...ipcHeaders("A".repeat(43)), Expect: "unsupported" },
    });
    expectError(unsupportedUnauthorized, 401, "unauthorized");
    expect(unsupportedUnauthorized.interimStatuses).toEqual([]);

    const authenticated = await raw({
      socketPath: required(fixture.ipc.socketPath),
      path: "/api/v1/capabilities",
      headers: { ...ipcHeaders(fixture.credential.token), Expect: "100-continue" },
    });
    expectError(authenticated, 417, "invalid-request");
    expect(authenticated.interimStatuses).toEqual([]);
  });
});

describe("supervisor Unix socket security", () => {
  it("refuses wrong socket mode and a symbolic-link socket path", async () => {
    const socketPath = required(fixture.ipc.socketPath);
    chmodSync(socketPath, 0o666);
    await expect(prepareUnixSocketPath(socketPath)).rejects.toThrow("private socket");
    chmodSync(socketPath, 0o600);

    const link = join(fixture.root, "runtime", "linked.sock");
    symlinkSync(socketPath, link);
    await expect(prepareUnixSocketPath(link)).rejects.toThrow("private socket");
  });

  it("refuses concurrent startup while the current socket has a live peer", async () => {
    await expect(prepareUnixSocketPath(required(fixture.ipc.socketPath))).rejects.toThrow(
      "live peer",
    );
  });

  it("requires an exact private parent and a traversal-free socket path", async () => {
    const publicRuntime = join(fixture.root, "public-runtime");
    mkdirSync(publicRuntime, { mode: 0o755 });
    chmodSync(publicRuntime, 0o755);
    await expect(
      startUnixSupervisorServer(join(publicRuntime, "supervisor.sock"), fixture.ipcHandler),
    ).rejects.toThrow("private and owned");
    await expect(
      startUnixSupervisorServer(
        `${join(fixture.root, "runtime")}/nested/../traversal.sock`,
        fixture.ipcHandler,
      ),
    ).rejects.toThrow("no traversal");
  });

  it("refuses wrong-mode and symbolic-link singleton locks", async () => {
    const runtime = join(fixture.root, "runtime");
    const wrongModeSocket = join(runtime, "wrong-mode.sock");
    const wrongModeLock = `${wrongModeSocket}.lock`;
    writeFileSync(wrongModeLock, staleLockRecord(), { mode: 0o600 });
    chmodSync(wrongModeLock, 0o644);
    await expect(startUnixSupervisorServer(wrongModeSocket, fixture.ipcHandler)).rejects.toThrow(
      "private file",
    );

    const linkedSocket = join(runtime, "linked-lock.sock");
    const lockTarget = join(runtime, "lock-target");
    writeFileSync(lockTarget, staleLockRecord(), { mode: 0o600 });
    symlinkSync(lockTarget, `${linkedSocket}.lock`);
    await expect(startUnixSupervisorServer(linkedSocket, fixture.ipcHandler)).rejects.toThrow(
      "private file",
    );

    const malformedSocket = join(runtime, "malformed-lock.sock");
    writeFileSync(`${malformedSocket}.lock`, staleLockRecord().trim(), { mode: 0o600 });
    await expect(startUnixSupervisorServer(malformedSocket, fixture.ipcHandler)).rejects.toThrow(
      "record is invalid",
    );
  });

  it("removes its lock when socket preparation fails", async () => {
    const socketPath = join(fixture.root, "runtime", "invalid-existing.sock");
    writeFileSync(socketPath, "not a socket", { mode: 0o600 });

    await expect(startUnixSupervisorServer(socketPath, fixture.ipcHandler)).rejects.toThrow(
      "private socket",
    );
    expect(existsSync(`${socketPath}.lock`)).toBe(false);
  });

  it("removes a stale exact lock and refuses a live PID/start-time lock", async () => {
    const staleSocket = join(fixture.root, "runtime", "stale-lock.sock");
    writeFileSync(`${staleSocket}.lock`, staleLockRecord(), { mode: 0o600 });
    const recovered = await startUnixSupervisorServer(staleSocket, fixture.ipcHandler);
    await recovered.close();
    expect(existsSync(staleSocket)).toBe(false);
    expect(existsSync(`${staleSocket}.lock`)).toBe(false);

    await expect(
      startUnixSupervisorServer(required(fixture.ipc.socketPath), fixture.ipcHandler),
    ).rejects.toThrow("live singleton lock");
  });

  it("recovers a private binding socket left by an abrupt pre-publication exit", async () => {
    const socketPath = join(fixture.root, "runtime", "crashed-binding.sock");
    const supervisorModule = new URL("../dist/index.js", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const { startUnixSupervisorServer } = await import(process.env.SUPERVISOR_MODULE); await startUnixSupervisorServer(process.env.SOCKET_PATH, { handle() {} }, { fault(point) { if (point === "afterPrivateBindBeforePublish") process.exit(86); } });',
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SOCKET_PATH: socketPath, SUPERVISOR_MODULE: supervisorModule },
      },
    );
    expect(result.status, result.stderr).toBe(86);
    expect(lstatSync(`${socketPath}.bind`).isSocket()).toBe(true);
    expect(existsSync(`${socketPath}.lock`)).toBe(true);

    const recovered = await startUnixSupervisorServer(socketPath, fixture.ipcHandler);
    const response = await raw({
      socketPath,
      path: "/api/v1/capabilities",
      headers: ipcHeaders(fixture.credential.token),
    });
    expect(response.status).toBe(200);

    await recovered.close();
    expect(
      readdirSync(join(fixture.root, "runtime")).filter((entry) =>
        entry.startsWith("crashed-binding.sock"),
      ),
    ).toEqual([]);
  });

  it("refuses unsafe or live private binding socket artifacts", async () => {
    const runtime = join(fixture.root, "runtime");
    const wrongTypeSocket = join(runtime, "wrong-binding-type.sock");
    writeFileSync(`${wrongTypeSocket}.bind`, "not a socket", { mode: 0o600 });
    await expect(startUnixSupervisorServer(wrongTypeSocket, fixture.ipcHandler)).rejects.toThrow(
      "private socket binding",
    );
    expect(existsSync(`${wrongTypeSocket}.lock`)).toBe(false);

    const wrongModeSocket = join(runtime, "wrong-binding-mode.sock");
    createStaleSocket(`${wrongModeSocket}.bind`);
    chmodSync(`${wrongModeSocket}.bind`, 0o666);
    await expect(startUnixSupervisorServer(wrongModeSocket, fixture.ipcHandler)).rejects.toThrow(
      "private socket binding",
    );
    expect(existsSync(`${wrongModeSocket}.lock`)).toBe(false);

    const linkedSocket = join(runtime, "linked-binding.sock");
    symlinkSync(`${wrongModeSocket}.bind`, `${linkedSocket}.bind`);
    await expect(startUnixSupervisorServer(linkedSocket, fixture.ipcHandler)).rejects.toThrow(
      "private socket binding",
    );
    expect(existsSync(`${linkedSocket}.lock`)).toBe(false);

    const liveSocket = join(runtime, "live-binding.sock");
    const peer = await startRawUnixPeer(`${liveSocket}.bind`, () => undefined);
    chmodSync(`${liveSocket}.bind`, 0o600);
    try {
      await expect(startUnixSupervisorServer(liveSocket, fixture.ipcHandler)).rejects.toThrow(
        "unexpectedly has a live peer",
      );
      expect(existsSync(`${liveSocket}.lock`)).toBe(false);
    } finally {
      await peer.close();
    }
  });

  it("retains a live lock when the socket pathname is replaced", async () => {
    const socketPath = required(fixture.ipc.socketPath);
    unlinkSync(socketPath);
    writeFileSync(socketPath, "replacement", { mode: 0o600 });

    await expect(startUnixSupervisorServer(socketPath, fixture.ipcHandler)).rejects.toThrow(
      "live singleton lock",
    );
    await fixture.ipc.close();
    expect(readFileSync(socketPath, "utf8")).toBe("replacement");
  });

  it("elects one reachable server across 50 starts against a stale socket", async () => {
    const socketPath = join(fixture.root, "runtime", "concurrent-stale.sock");
    createStaleSocket(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    const attempts = await Promise.allSettled(
      Array.from({ length: 50 }, () => startUnixSupervisorServer(socketPath, fixture.ipcHandler)),
    );
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<SupervisorHttpServerHandle> =>
        attempt.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    const response = await raw({
      socketPath,
      path: "/api/v1/capabilities",
      headers: ipcHeaders(fixture.credential.token),
    });
    expect(response.status).toBe(200);

    await winners[0]?.value.close();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(`${socketPath}.lock`)).toBe(false);
    expect(
      readdirSync(join(fixture.root, "runtime")).filter((entry) =>
        entry.startsWith("concurrent-stale.sock"),
      ),
    ).toEqual([]);
  });
});

describe("HTTP supervisor client transport bounds", () => {
  it("rejects invalid request timeout bounds", () => {
    expect(
      () => new HttpSupervisorClient({ socketPath: "/tmp/unused.sock", requestTimeoutMs: 0 }),
    ).toThrow("integer from 1");
    expect(
      () => new HttpSupervisorClient({ socketPath: "/tmp/unused.sock", requestTimeoutMs: 300_001 }),
    ).toThrow("integer from 1");
  });

  it("times out a hanging Unix peer with a sanitized typed error", async () => {
    const socketPath = join(fixture.root, "runtime", "hanging.sock");
    const peer = await startRawUnixPeer(socketPath, () => undefined);
    try {
      const client = new HttpSupervisorClient({
        socketPath,
        credential: fixture.credential.token,
        requestTimeoutMs: 50,
      });
      const startedAt = Date.now();
      const error = await capturedError(client.capabilities());

      expect(error).toBeInstanceOf(HttpSupervisorClientError);
      expect(error).toMatchObject({ code: "request-timeout" });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(error.message).not.toContain(fixture.credential.token);
    } finally {
      await peer.close();
    }
  });

  it("enforces an absolute deadline while a Unix peer drips response bytes", async () => {
    const socketPath = join(fixture.root, "runtime", "slow-drip.sock");
    let socketClosed = false;
    const peer = await startRawUnixPeer(socketPath, (socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n");
      const interval = setInterval(() => {
        if (!socket.destroyed) socket.write("x");
      }, 20);
      socket.once("error", () => clearInterval(interval));
      socket.once("close", () => {
        clearInterval(interval);
        socketClosed = true;
      });
    });
    try {
      const client = new HttpSupervisorClient({
        socketPath,
        credential: fixture.credential.token,
        requestTimeoutMs: 150,
      });
      const startedAt = Date.now();
      const error = await capturedError(client.capabilities());
      const elapsed = Date.now() - startedAt;

      expect(error).toBeInstanceOf(HttpSupervisorClientError);
      expect(error).toMatchObject({ code: "request-timeout" });
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(1_000);
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      await peer.close();
    }
  });

  it("rejects a truncated Unix peer response without exposing credentials", async () => {
    const socketPath = join(fixture.root, "runtime", "truncated.sock");
    const peer = await startRawUnixPeer(socketPath, (socket) => {
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n{",
      );
    });
    try {
      const client = new HttpSupervisorClient({
        socketPath,
        credential: fixture.credential.token,
        requestTimeoutMs: 500,
      });
      const error = await capturedError(client.capabilities());

      expect(error).toBeInstanceOf(HttpSupervisorClientError);
      expect(error).toMatchObject({ code: "response-aborted" });
      expect(error.message).not.toContain(fixture.credential.token);
    } finally {
      await peer.close();
    }
  });
});

async function createBootstrap(): Promise<{ readonly path: string }> {
  const response = await raw({
    socketPath: required(fixture.ipc.socketPath),
    method: "POST",
    path: "/api/v1/portal-sessions",
    headers: { ...ipcHeaders(fixture.credential.token), "Content-Length": "0" },
  });
  expect(response.status).toBe(201);
  return JSON.parse(response.body) as { path: string };
}

interface RawRequest {
  readonly origin?: string;
  readonly socketPath?: string;
  readonly method?: string;
  readonly path: string;
  readonly host?: string;
  readonly body?: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly interimStatuses: readonly number[];
}

function raw(input: RawRequest): Promise<RawResponse> {
  const url = input.origin === undefined ? new URL("http://localhost") : new URL(input.origin);
  const headers: Record<string, string> = { Host: input.host ?? url.host, ...input.headers };
  if (input.body !== undefined && headers["Content-Length"] === undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(input.body));
  }
  return new Promise((resolve, reject) => {
    const interimStatuses: number[] = [];
    const request = httpRequest(
      {
        method: input.method ?? "GET",
        path: input.path,
        headers,
        ...(input.socketPath === undefined
          ? { hostname: url.hostname, port: url.port }
          : { socketPath: input.socketPath }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            interimStatuses,
          }),
        );
      },
    );
    request.on("information", ({ statusCode }) => interimStatuses.push(statusCode));
    request.once("error", reject);
    request.end(input.body);
  });
}

function streamBody(input: {
  readonly origin: string;
  readonly path: string;
  readonly cookie: string;
  afterOpen(): void;
}): Promise<string> {
  const url = new URL(input.origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: input.path,
        headers: { Host: url.host, Cookie: input.cookie },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.once("error", reject);
        input.afterOpen();
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function ipcHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function expectError(response: RawResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(decodeErrorEnvelope(response.body)).toMatchObject({ code });
}

function testPortalAssets(): PortalAssetSource {
  const shellBytes = new TextEncoder().encode("<!doctype html><main id=app></main>");
  const scriptBytes = new TextEncoder().encode("console.log('portal')");
  return Object.freeze({
    shell: () => ({
      name: "index.html",
      digest: "b".repeat(64),
      byteLength: shellBytes.byteLength,
      contentType: "text/html; charset=utf-8",
      bytes: shellBytes,
    }),
    asset: (name: string) =>
      name === "app.abc123.js"
        ? {
            name,
            digest: "a".repeat(64),
            byteLength: scriptBytes.byteLength,
            contentType: "text/javascript; charset=utf-8",
            bytes: scriptBytes,
          }
        : undefined,
  });
}

function invalidButFramedSubmission() {
  return {
    apiVersion: PROTOCOL_VERSION,
    commandId: "command_security",
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    intent: { type: "instantiate-run" },
    payload: {},
    payloadDigest: "0".repeat(64),
    principal: runtimePrincipal,
  };
}

function required(value: string | undefined): string {
  if (value === undefined) throw new Error("Expected test value is missing");
  return value;
}

async function startRawUnixPeer(
  socketPath: string,
  onConnection: (socket: Socket) => void,
): Promise<{ readonly close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await listenUnixPeer(server, socketPath);
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function listenUnixPeer(server: NetServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function capturedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
    throw new Error("Expected operation to fail");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

function staleLockRecord(): string {
  return `${JSON.stringify({ pid: 2_147_483_647, startTime: "1", version: 1 })}\n`;
}

function createStaleSocket(socketPath: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { chmodSync } from "node:fs"; import { createServer } from "node:net"; createServer().listen(process.env.SOCKET_PATH, () => { chmodSync(process.env.SOCKET_PATH, 0o600); process.exit(0); });',
    ],
    { encoding: "utf8", env: { ...process.env, SOCKET_PATH: socketPath } },
  );
  if (result.status !== 0) {
    throw new Error(`Could not create stale socket: ${result.stderr}`);
  }
}
