import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTAL_CAPABILITIES } from "@senawa/protocol";
import { SqlitePortalQueryAuthority } from "@senawa/storage-sqlite";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
} from "@senawa/testing";
import { describe, expect, it } from "vitest";
import { SupervisorApi } from "./api.js";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import { HttpSupervisorClient } from "./http-client.js";
import { SupervisorHttpHandler } from "./http-handler.js";
import { startLoopbackSupervisorServer, startUnixSupervisorServer } from "./http-server.js";
import { loadOrCreateLocalCredential } from "./local-security.js";
import { PortalApi } from "./portal-api.js";
import { PortalSessionSecurity } from "./session-security.js";

describe("portal API transport", () => {
  it("returns identical bounded reads over authenticated IPC and loopback sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-portal-transport-"));
    const databasePath = join(root, "authority.db");
    const assetDirectory = join(root, "assets");
    const dependencies = {
      sha256: deterministicSha256,
      authorization: { authorize: () => true },
    };
    const authority = new SqliteSupervisorAuthority({
      databasePath,
      assetDirectory,
      dependencies,
    });
    const graph = createRuntimeGraph();
    let allocation = 0;
    authority.commandAuthority.submit(
      runtimeCommand({
        commandId: "command_portal-transport-instantiate",
        intent: "instantiate-run",
        payload: {
          workflowId: runtimeFixture.workflowId,
          configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
          execution: runtimeFixture.execution,
          graph,
          phase: runtimeFixture.phase,
          approvalPolicy: { policy: "no-approval" },
          escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
          allowancePolicy: runtimeFixture.allowancePolicy,
        },
      }),
      {
        currentTime: runtimeFixture.currentTime,
        facts: { source: "portal-transport-test" },
        allocateId: () => {
          allocation += 1;
          return `stream-event-portal-transport-${allocation}`;
        },
      },
    );
    const query = new SqlitePortalQueryAuthority({ databasePath, assetDirectory, dependencies });
    const api = new SupervisorApi(authority, "supervisor_portal-test", new PortalApi(query));
    const sessions = new PortalSessionSecurity({
      clock: { now: () => Date.now() },
      random: { bytes: (length) => randomBytes(length) },
    });
    const credential = loadOrCreateLocalCredential(join(root, "runtime"), {
      bytes: (length) => randomBytes(length),
    });
    const contextFactory = () => {
      throw new Error("Portal read transport must not construct command admission");
    };
    const ipc = await startUnixSupervisorServer(
      join(root, "runtime", "portal.sock"),
      new SupervisorHttpHandler({
        api,
        transport: "ipc",
        credential,
        sessions,
        contextFactory,
      }),
    );
    const loopback = await startLoopbackSupervisorServer(
      0,
      (origin) =>
        new SupervisorHttpHandler({
          api,
          transport: "loopback",
          sessions,
          loopbackOrigin: origin,
          contextFactory,
        }),
    );
    try {
      const ipcClient = new HttpSupervisorClient({
        socketPath: required(ipc.socketPath),
        credential: credential.token,
      });
      const loopbackClient = new HttpSupervisorClient({ baseUrl: required(loopback.origin) });
      await loopbackClient.consumePortalBootstrap((await ipcClient.createPortalSession()).path);

      const expectedCapabilities = [...PORTAL_CAPABILITIES];
      expect((await ipcClient.capabilities()).capabilities).toEqual(
        expect.arrayContaining(expectedCapabilities),
      );
      expect((await loopbackClient.capabilities()).capabilities).toEqual(
        (await ipcClient.capabilities()).capabilities,
      );
      expect(await loopbackClient.listPortalRepositories()).toEqual(
        await ipcClient.listPortalRepositories(),
      );
      const identity = {
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
      };
      const overview = await ipcClient.getPortalRunOverview(identity);
      expect(await loopbackClient.getPortalRunOverview(identity)).toEqual(overview);
      expect(overview.sync).toMatchObject({ graphRevision: graph.revisionDigest });
      expect(await loopbackClient.getPortalGraph(identity)).toEqual(
        await ipcClient.getPortalGraph(identity),
      );
      expect(
        await loopbackClient.listPortalGraphNodes({
          ...identity,
          graphRevision: graph.revisionDigest,
          limit: 2,
        }),
      ).toEqual(
        await ipcClient.listPortalGraphNodes({
          ...identity,
          graphRevision: graph.revisionDigest,
          limit: 2,
        }),
      );
      expect(
        (await loopbackClient.listPortalEvents({ ...identity, limit: 2 })).events,
      ).toHaveLength(2);
    } finally {
      await loopback.close();
      await ipc.close();
      query.close();
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Required portal transport fixture value is missing");
  return value;
}
