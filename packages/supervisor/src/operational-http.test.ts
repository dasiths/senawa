import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@senawa/protocol";
import { createRoleAuthorizationPolicy } from "@senawa/runtime";
import { deterministicSha256 } from "@senawa/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import { HttpSupervisorClient } from "./http-client.js";
import { SupervisorHttpHandler, type SupervisorOperations } from "./http-handler.js";
import {
  type SupervisorHttpServerHandle,
  startLoopbackSupervisorServer,
  startUnixSupervisorServer,
} from "./http-server.js";
import { loadOrCreateLocalCredential } from "./local-security.js";
import { SupervisorService } from "./service.js";
import { PortalSessionSecurity } from "./session-security.js";

const roots = new Set<string>();
const servers = new Set<SupervisorHttpServerHandle>();

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("supervisor operational HTTP", () => {
  it("serves lifecycle operations only over authenticated Unix HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-operational-http-"));
    roots.add(root);
    const credential = loadOrCreateLocalCredential(join(root, "runtime"), {
      bytes: (length) => randomBytes(length),
    });
    const drain = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const recover = vi.fn(async () => ({ worked: true }));
    const backup = vi.fn(async (requestId: string) => ({ requestId, verified: true as const }));
    const operations: SupervisorOperations = {
      status: async () => ({
        lifecycle: "running",
        mode: "running",
        health: "healthy",
        processId: 42,
        startedAt: "2026-08-13T00:00:00.000Z",
        listeners: [{ kind: "ipc", address: join(root, "runtime", "supervisor.sock") }],
        pending: {
          queuedCommands: 0,
          claimedCommands: 0,
          wakes: 0,
          runnerEffects: 0,
          completionOutbox: 0,
          amendmentProposalOutbox: 0,
          approvedAmendments: 0,
        },
        leases: [],
        sdkSessionStore: {
          status: "healthy",
          expectedSessionCount: 0,
          missingSessionIds: [],
        },
        remoteConnectors: [],
      }),
      drain,
      stop,
      recover,
      backup,
      logs: async () => ({ afterCursor: 0, latestCursor: 0, hasMore: false, items: [] }),
    };
    const api = {
      capabilities: () => ({
        apiVersion: PROTOCOL_VERSION,
        peerId: "operational_test",
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: [],
      }),
    } as never;
    const ipc = await startUnixSupervisorServer(
      join(root, "runtime", "supervisor.sock"),
      new SupervisorHttpHandler({
        api,
        transport: "ipc",
        credential,
        operations,
        contextFactory: () => {
          throw new Error("Operational routes do not create command context");
        },
      }),
    );
    servers.add(ipc);
    const client = new HttpSupervisorClient({
      socketPath: required(ipc.socketPath),
      credential: credential.token,
    });

    await expect(client.status()).resolves.toMatchObject({ lifecycle: "running", processId: 42 });
    await client.drain();
    await expect(client.recover({ repositoryId: "repository_a", runId: "run_a" })).resolves.toEqual(
      {
        worked: true,
      },
    );
    await expect(client.logs()).resolves.toMatchObject({ items: [], latestCursor: 0 });
    await expect(
      client.backupState({ requestId: "backup-request", destinationDirectory: "/backup" }),
    ).resolves.toEqual({ requestId: "backup-request", verified: true });
    await client.stop();
    await new Promise((resolve) => setImmediate(resolve));
    expect(drain).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith("repository_a", "run_a");
    expect(backup).toHaveBeenCalledWith("backup-request", "/backup");
    expect(stop).toHaveBeenCalledOnce();

    const sessions = new PortalSessionSecurity({
      clock: { now: () => Date.now() },
      random: { bytes: (length) => randomBytes(length) },
    });
    const loopback = await startLoopbackSupervisorServer(
      0,
      (origin) =>
        new SupervisorHttpHandler({
          api,
          transport: "loopback",
          sessions,
          loopbackOrigin: origin,
          operations,
          contextFactory: () => {
            throw new Error("Operational routes do not create command context");
          },
        }),
    );
    servers.add(loopback);
    const loopbackClient = new HttpSupervisorClient({ baseUrl: required(loopback.origin) });
    await expect(loopbackClient.status()).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
  });

  it("serializes status health through stop and rejects queries after closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-operational-stop-race-"));
    roots.add(root);
    const credential = loadOrCreateLocalCredential(join(root, "runtime"), {
      bytes: (length) => randomBytes(length),
    });
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies: {
        sha256: deterministicSha256,
        authorization: createRoleAuthorizationPolicy([]),
      },
    });
    let signalHealthStarted: (() => void) | undefined;
    const healthStarted = new Promise<void>((resolve) => {
      signalHealthStarted = resolve;
    });
    let releaseHealth: (() => void) | undefined;
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse("2026-08-13T00:00:00.000Z") },
      ownerId: "owner_operational-stop-race",
      sessionStoreHealth: {
        async health(expectedSessionIds) {
          signalHealthStarted?.();
          await healthGate;
          return {
            status: "healthy",
            expectedSessionCount: expectedSessionIds.length,
            missingSessionIds: [],
          };
        },
      },
    });
    await service.start();
    const api = new SupervisorHttpHandler({
      api: {
        capabilities: () => ({
          apiVersion: PROTOCOL_VERSION,
          peerId: "operational_stop_race",
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: [],
        }),
      } as never,
      transport: "ipc",
      credential,
      operations: {
        status: () => service.status(),
        drain: () => service.drain(),
        stop: () => service.stop(),
        recover: (repositoryId, runId) => service.recover(repositoryId, runId),
        backup: async (requestId) => ({ requestId, verified: true }),
        logs: (afterCursor, limit) => service.logs(afterCursor, limit),
      },
      contextFactory: () => {
        throw new Error("Operational routes do not create command context");
      },
    });
    const ipc = await startUnixSupervisorServer(join(root, "runtime", "supervisor.sock"), api);
    servers.add(ipc);
    const client = new HttpSupervisorClient({
      socketPath: required(ipc.socketPath),
      credential: credential.token,
    });

    const status = client.status();
    await healthStarted;
    await client.stop();
    const stopping = service.stop();
    let stopSettled = false;
    void stopping.finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseHealth?.();
    await expect(status).resolves.toMatchObject({ lifecycle: "draining", mode: "draining" });
    await expect(stopping).resolves.toBeUndefined();
    await expect(client.status()).rejects.toMatchObject({
      code: "service-unavailable",
      status: 503,
    });
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected operational listener address");
  return value;
}
