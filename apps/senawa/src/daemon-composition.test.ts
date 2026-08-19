import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotSdkSessionConfig, CopilotSdkSessionPort } from "@senawa/execution-host";
import {
  type CommandIntent,
  canonicalBytes,
  decodeAuthenticatedPrincipal,
  decodeCanonicalJsonValue,
} from "@senawa/protocol";
import type { QueuedEffectCommand, RuntimeDependencies } from "@senawa/runtime";
import { SqliteContextBroker, SqliteRunnerAuthority } from "@senawa/storage-sqlite";
import {
  acquireUnixSocketLock,
  HttpSupervisorClient,
  type RemoteConnectorStatus,
  readPrivateCredential,
  releaseUnixSocketLock,
  SqliteSupervisorAuthority,
} from "@senawa/supervisor";
import {
  createRuntimeGraph,
  createWorkerExecutionFixture,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type OwnedCopilotSdkPort,
  resolveSenawaServicePaths,
  runtimeDependencies,
  startSenawaService,
} from "./daemon.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("daemon worker composition", () => {
  // The shipped policy denies any intent it does not list, and the driver only
  // reaches its later intents once earlier ones succeed. `start-phase-attempt`
  // was absent from this policy for as long as a second phase was unreachable,
  // so nothing refused and nothing complained. The record below is exhaustive
  // by type, so a new intent fails to compile until someone decides who may
  // send it.
  it("says who may send every intent the protocol accepts", () => {
    const senders: Record<CommandIntent["type"], readonly string[]> = {
      "instantiate-run": ["release-manager"],
      "start-phase-attempt": ["release-manager"],
      "accept-graph-revision": ["release-manager"],
      "submit-completion": ["engine"],
      "evaluate-gate": ["engine"],
      "record-authority-decision": ["release-manager"],
      "close-phase": ["engine"],
      "record-phase-attempt-transition": ["engine"],
      "import-plan": ["engine"],
      "record-fan-out-diff-decision": ["engine"],
      "submit-amendment-proposal": ["engine"],
      "withdraw-amendment-proposal": ["release-manager"],
      "record-amendment-decision": ["engine"],
      "apply-approved-amendment": ["trusted-supervisor"],
      "record-integration-barrier": ["trusted-supervisor"],
      "create-escalation": ["engine"],
      "answer-question": ["operator"],
      "steer-agent": ["operator"],
      "override-member": ["release-manager"],
      "grant-allowance": ["release-manager"],
      "pause-run": ["operator"],
      "resume-run": ["operator"],
      "end-run": ["release-manager"],
    };
    for (const [type, roles] of Object.entries(senders)) {
      const principal = decodeAuthenticatedPrincipal({
        issuer: "senawa.local",
        subject: "policy-check",
        tenant: "local",
        assurance: "single-factor",
        roles,
      });
      expect({
        type,
        allowed: runtimeDependencies.authorization.authorize(principal, {
          type,
        } as CommandIntent),
      }).toEqual({ type, allowed: true });
    }
  });

  it("keeps the remote connector disabled by default", async () => {
    const { environment } = sandbox("senawa-daemon-remote-disabled-", false);
    const started = await startSenawaService(environment);
    expect((await started.service.status()).remoteConnectors).toEqual([]);
    await started.service.stop();
  });

  it("starts, reports, and closes an injected remote connector", async () => {
    const { environment } = sandbox("senawa-daemon-remote-injected-", false);
    const remote = new FakeRemoteConnector();
    const started = await startSenawaService(environment, {
      createRemoteConnector: async () => remote,
    });
    expect(remote.establishCalls).toBe(1);
    expect(remote.startCalls).toBe(1);
    expect((await started.service.status()).remoteConnectors).toEqual([remote.status()]);
    await started.service.stop();
    expect(remote.drainCalls).toBe(1);
    expect(remote.closeCalls).toBe(1);
  });

  it.each([
    { mode: "pause-new-local-work" as const, expectedPartitioned: true },
    { mode: "continue-authorized-local" as const, expectedPartitioned: true },
  ])("preflights before cold-start and restart scheduling in $mode", async (testCase) => {
    const fixture = sandbox(`senawa-daemon-preflight-${testCase.mode}-`, false);
    const connectors: FakeRemoteConnector[] = [];
    const start = () =>
      startSenawaService(fixture.environment, {
        createRemoteConnector: async () => {
          const connector = new FakeRemoteConnector(undefined, testCase.mode, false);
          connectors.push(connector);
          return connector;
        },
      });
    let started = await start();
    expect(connectors[0]?.calls).toEqual(["establish", "start"]);
    expect((await started.service.status()).remoteConnectors[0]).toMatchObject({
      partitioned: testCase.expectedPartitioned,
    });
    await started.service.stop();
    started = await start();
    expect(connectors[1]?.calls).toEqual(["establish", "start"]);
    await started.service.stop();
  });

  it("closes an injected connector on listener and connector startup failures", async () => {
    const listenerFailure = sandbox("senawa-daemon-remote-listener-failure-", false);
    listenerFailure.environment.SENAWA_PORTAL_PORT = "0";
    const listenerRemote = new FakeRemoteConnector();
    await expect(
      startSenawaService(listenerFailure.environment, {
        createRemoteConnector: async () => listenerRemote,
        startLoopbackServer: async () => {
          throw new Error("loopback startup failed");
        },
      }),
    ).rejects.toThrow("loopback startup failed");
    expect(listenerRemote.startCalls).toBe(0);
    expect(listenerRemote.closeCalls).toBe(1);

    const connectorFailure = sandbox("senawa-daemon-remote-start-failure-", false);
    const startRemote = new FakeRemoteConnector(new Error("remote startup failed"));
    await expect(
      startSenawaService(connectorFailure.environment, {
        createRemoteConnector: async () => startRemote,
      }),
    ).rejects.toThrow("remote startup failed");
    expect(startRemote.startCalls).toBe(1);
    expect(startRemote.closeCalls).toBe(1);
  });

  it("reserves amendment application for the trusted supervisor", () => {
    const releaseManager = decodeAuthenticatedPrincipal({
      issuer: "senawa.local",
      subject: "local-user",
      tenant: "local",
      assurance: "single-factor",
      roles: ["release-manager"],
    });
    const trustedSupervisor = decodeAuthenticatedPrincipal({
      issuer: "senawa.local",
      subject: "supervisor",
      tenant: "local",
      assurance: "hardware-backed",
      roles: ["trusted-supervisor"],
    });

    expect(
      runtimeDependencies.authorization.authorize(releaseManager, {
        type: "apply-approved-amendment",
      }),
    ).toBe(false);
    expect(
      runtimeDependencies.authorization.authorize(trustedSupervisor, {
        type: "apply-approved-amendment",
      }),
    ).toBe(true);
  });

  it("fences a failed repository writer and preserves the fence after reopen", async () => {
    const { environment } = sandbox("senawa-daemon-worker-");
    const dependencies: RuntimeDependencies = {
      ...runtimeDependencies,
      sha256: deterministicSha256,
    };
    const sdks: FakeOwnedSdk[] = [];
    let gitFactoryCalls = 0;
    const composition = {
      runtimeDependencies: dependencies,
      createCopilotSdk: async (options: { workingDirectory: string; baseDirectory: string }) => {
        // The session throws, so this is a genuine failure. A worker that merely
        // submitted nothing is spent, not failed, and keeps its task claimable.
        const sdk = new FakeOwnedSdk(options.workingDirectory, options.baseDirectory, [], true);
        sdks.push(sdk);
        return sdk;
      },
      createGitHost: async () => {
        gitFactoryCalls += 1;
        throw new Error("Repository mode must not construct the Git adapter host");
      },
    };
    let started = await startSenawaService(environment, composition);
    const graph = createRuntimeGraph();
    const worker = createWorkerExecutionFixture(graph);
    const broker = new SqliteContextBroker({
      databasePath: started.paths.databasePath,
      dependencies: {
        sha256: deterministicSha256,
        currentTime: () => runtimeFixture.currentTime,
        issueGrantToken: () => new Uint8Array(32).fill(9),
      },
    });
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: workerTaskScope(worker),
    });
    broker.close();
    started.service.authority.accept({
      envelope: runtimeCommand({
        commandId: "command_daemon-instantiate",
        intent: "instantiate-run",
        payload: {
          workflowId: runtimeFixture.workflowId,
          configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
          execution: runtimeFixture.execution,
          graph,
          phase: runtimeFixture.phase,
          approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
          escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
          allowancePolicy: runtimeFixture.allowancePolicy,
        },
      }),
      createAdmission: () => ({
        currentTime: runtimeFixture.currentTime,
        facts: { source: "daemon-composition-test" },
        allocations: [1, 2, 3].map((ordinal) => ({
          kind: "stream-event" as const,
          id: `stream-event-daemon-instantiate-${ordinal}`,
        })),
      }),
    });
    const firstCommand = workerCommand(worker, 1, "first");
    const runner = new SqliteRunnerAuthority({
      databasePath: started.paths.databasePath,
      dependencies,
    });
    runner.configureRun({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      contextDigest: worker.context.contextDigest,
      taskScopes: [{ ...workerTaskScope(worker), claimsAccepted: true }],
      budgets: [{ unit: "model-millidollars", limit: 10 }],
      lease: {
        owner: started.service.ownerId,
        fence: 1,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
    });
    runner.enqueue(firstCommand);
    runner.close();

    await expect(started.service.runCycle()).resolves.toMatchObject({ worked: true });
    const firstResult = new SqliteRunnerAuthority({
      databasePath: started.paths.databasePath,
      dependencies,
    });
    const firstSnapshot = firstResult.load({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
    });
    const firstEffect = firstSnapshot.effects[0];
    expect(firstEffect).toMatchObject({ outcome: { status: "failed", origin: "dispatch" } });
    expect(firstSnapshot.taskScopes).toEqual([
      expect.objectContaining({ taskId: worker.dispatch.task.taskId, claimsAccepted: false }),
    ]);
    firstResult.close();
    expect(sdks[0]?.createCalls).toBe(1);
    expect(gitFactoryCalls).toBe(0);
    expect(started.service.authority.operationalSnapshot().startedSessionIds).toEqual([]);
    await started.service.stop();
    const lock = acquireUnixSocketLock(started.paths.socketPath);
    releaseUnixSocketLock(lock);
    expect(existsSync(started.paths.socketPath)).toBe(false);

    started = await startSenawaService(environment, composition);
    const status = await started.service.status();
    expect(status).toMatchObject({
      health: "healthy",
      sdkSessionStore: {
        status: "healthy",
        expectedSessionCount: 0,
        missingSessionIds: [],
      },
    });
    expect(sdks[1]?.createCalls).toBe(0);
    expect(gitFactoryCalls).toBe(0);
    expect(started.service.authority.operationalSnapshot().startedSessionIds).toEqual([]);
    await started.service.stop();
  });

  it("reports worker execution unavailable without repository configuration", async () => {
    const { environment } = sandbox("senawa-daemon-unavailable-", false);
    const started = await startSenawaService(environment);

    await expect(started.service.status()).resolves.toMatchObject({
      health: "degraded",
      sdkSessionStore: {
        status: "degraded",
        expectedSessionCount: 0,
        message: expect.stringContaining("not configured"),
      },
    });
    await started.service.stop();
  });

  it("keeps daemon IPC and portal queries available when the static manifest is missing", async () => {
    const { environment } = sandbox("senawa-daemon-missing-portal-", false);
    environment.SENAWA_PORTAL_PORT = "0";
    environment.SENAWA_PORTAL_MANIFEST = join(
      environment.XDG_STATE_HOME as string,
      "missing-portal-manifest.json",
    );
    const started = await startSenawaService(environment);
    try {
      const status = await started.service.status();
      const ipcAddress = status.listeners.find(({ kind }) => kind === "ipc")?.address;
      const loopbackAddress = status.listeners.find(({ kind }) => kind === "loopback")?.address;
      if (ipcAddress === undefined || loopbackAddress === undefined) {
        throw new Error("Expected IPC and loopback listeners");
      }
      const credential = readPrivateCredential(started.paths.credentialPath);
      const ipc = new HttpSupervisorClient({
        socketPath: ipcAddress,
        credential: credential.token,
      });
      const loopback = new HttpSupervisorClient({ baseUrl: loopbackAddress });
      expect((await ipc.capabilities()).capabilities).toContain("portal-read-discovery");
      await loopback.consumePortalBootstrap((await ipc.createPortalSession()).path);
      expect(await loopback.listPortalRepositories()).toMatchObject({ repositories: [] });
      const shell = await loopback.raw("GET", "/portal/");
      expect(shell.status).toBe(503);
      expect(JSON.parse(shell.body)).toMatchObject({ code: "service-unavailable" });
      const lifecycle = await loopback.raw("GET", "/supervisor/v1/status");
      expect(lifecycle.status).toBe(404);
    } finally {
      await started.service.stop();
    }
  });

  it("removes the Unix socket and lock when a later listener fails to start", async () => {
    const { environment } = sandbox("senawa-daemon-listener-");
    environment.SENAWA_PORTAL_PORT = "0";
    const paths = resolveSenawaServicePaths(environment);

    await expect(
      startSenawaService(environment, {
        createCopilotSdk: async (options) =>
          new FakeOwnedSdk(options.workingDirectory, options.baseDirectory),
        startLoopbackServer: async () => {
          throw new Error("loopback startup failed");
        },
      }),
    ).rejects.toThrow("loopback startup failed");

    expect(existsSync(paths.socketPath)).toBe(false);
    const lock = acquireUnixSocketLock(paths.socketPath);
    releaseUnixSocketLock(lock);
  });

  it("preserves the startup failure before an SDK cleanup failure", async () => {
    const { environment } = sandbox("senawa-daemon-start-cleanup-");
    environment.SENAWA_PORTAL_PORT = "0";
    const paths = resolveSenawaServicePaths(environment);
    const startupError = new Error("loopback startup failed");
    const sdkError = new Error("sdk stop failed");

    await expect(
      startSenawaService(environment, {
        createCopilotSdk: async (options) =>
          new FakeOwnedSdk(options.workingDirectory, options.baseDirectory, [sdkError]),
        startLoopbackServer: async () => {
          throw startupError;
        },
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "Supervisor startup failed",
      errors: [
        startupError,
        {
          name: "AggregateError",
          message: "Copilot SDK shutdown failed",
          errors: [sdkError],
        },
      ],
    });

    expect(existsSync(paths.socketPath)).toBe(false);
    const lock = acquireUnixSocketLock(paths.socketPath);
    releaseUnixSocketLock(lock);
    reopenStores(paths, runtimeDependencies);
  });

  it("finishes owned cleanup and rejects when Copilot SDK shutdown fails", async () => {
    const { environment } = sandbox("senawa-daemon-sdk-stop-");
    const paths = resolveSenawaServicePaths(environment);
    const sdkError = new Error("sdk stop failed");
    const started = await startSenawaService(environment, {
      createCopilotSdk: async (options) =>
        new FakeOwnedSdk(options.workingDirectory, options.baseDirectory, [sdkError]),
    });

    await expect(started.service.stop()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Copilot SDK shutdown failed",
      errors: [sdkError],
    });
    expect(started.service.state).toBe("stopped");
    expect(() => started.service.authority.mode()).toThrow();
    expect(existsSync(paths.socketPath)).toBe(false);
    const lock = acquireUnixSocketLock(paths.socketPath);
    releaseUnixSocketLock(lock);
    reopenStores(paths, runtimeDependencies);
  });

  it("rolls back SQLite ownership when Copilot SDK creation fails", async () => {
    const { environment } = sandbox("senawa-daemon-sdk-create-");
    const paths = resolveSenawaServicePaths(environment);
    const sdkCreationError = new Error("sdk creation failed");

    await expect(
      startSenawaService(environment, {
        createCopilotSdk: async () => {
          throw sdkCreationError;
        },
      }),
    ).rejects.toBe(sdkCreationError);

    expect(existsSync(paths.socketPath)).toBe(false);
    const lock = acquireUnixSocketLock(paths.socketPath);
    releaseUnixSocketLock(lock);
    reopenStores(paths, runtimeDependencies);
  });
});

function reopenStores(
  paths: ReturnType<typeof resolveSenawaServicePaths>,
  dependencies: RuntimeDependencies,
): void {
  const authority = new SqliteSupervisorAuthority({
    databasePath: paths.databasePath,
    assetDirectory: paths.assetDirectory,
    dependencies,
  });
  const broker = new SqliteContextBroker({
    databasePath: paths.databasePath,
    dependencies: {
      sha256: dependencies.sha256,
      currentTime: () => runtimeFixture.currentTime,
      issueGrantToken: () => new Uint8Array(32).fill(7),
    },
  });
  broker.close();
  authority.close();
}

function sandbox(
  prefix: string,
  repositoryConfigured = true,
): {
  readonly environment: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  chmodSync(root, 0o700);
  const repositoryDirectory = join(root, "repository");
  mkdirSync(repositoryDirectory, { mode: 0o700 });
  return {
    environment: {
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
      ...(repositoryConfigured ? { SENAWA_REPOSITORY_DIR: repositoryDirectory } : {}),
    },
  };
}

function workerCommand(
  worker: ReturnType<typeof createWorkerExecutionFixture>,
  sequence: number,
  suffix: string,
): QueuedEffectCommand {
  const input = decodeCanonicalJsonValue({
    dispatchId: worker.dispatch.dispatchId,
    routeSelection: worker.routeSelection,
    timeoutMs: 1_000,
    grantPolicy: {
      expiresAfterMs: 2_000,
      maxOperations: 4,
      maxBytes: 4_096,
      maxChunkBytes: 1_024,
    },
  });
  return {
    sequence,
    commandId: `command_daemon-${suffix}`,
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    operationId: `operation_daemon-${suffix}`,
    kind: "worker",
    taskScope: workerTaskScope(worker),
    contextDigest: worker.context.contextDigest,
    inputDigest: deterministicSha256.digest(canonicalBytes(input)),
    input,
    budgetReservation: { unit: "model-millidollars", amount: 1 },
    queuedAt: runtimeFixture.currentTime,
    maxReconciliationAttempts: 2,
  };
}

function workerTaskScope(worker: ReturnType<typeof createWorkerExecutionFixture>) {
  return {
    runId: worker.dispatch.runId,
    taskId: worker.dispatch.task.taskId,
    definitionGeneration: worker.dispatch.task.definitionGeneration,
    acceptedContextDigest: worker.context.contextDigest,
    fenceGeneration: 1,
  } as const;
}

class FakeOwnedSdk implements OwnedCopilotSdkPort {
  constructor(
    readonly workingDirectory: string,
    readonly baseDirectory: string,
    readonly stopErrors: readonly Error[] = [],
    readonly sessionFails = false,
  ) {}

  createCalls = 0;
  metadataCalls = 0;

  async resumeSession(): Promise<undefined> {
    return undefined;
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSessionPort> {
    this.createCalls += 1;
    if (config.sessionId === undefined) throw new Error("Expected dispatch session identity");
    return new FakeSession(config.sessionId, this.sessionFails);
  }

  async sessionMetadataExists(): Promise<boolean> {
    this.metadataCalls += 1;
    return false;
  }

  async stopOwnedClient(): Promise<readonly Error[]> {
    return this.stopErrors;
  }
}

class FakeSession implements CopilotSdkSessionPort {
  constructor(
    readonly sessionId: string,
    readonly fails = false,
  ) {}

  async sendAndWait(): Promise<void> {
    if (this.fails) throw new Error("Fake Copilot session failed");
  }

  async abort(): Promise<void> {}

  async disconnect(): Promise<void> {}
}

class FakeRemoteConnector {
  readonly calls: string[] = [];
  startCalls = 0;
  establishCalls = 0;
  drainCalls = 0;
  closeCalls = 0;

  constructor(
    readonly startError?: Error,
    readonly disconnectedMode:
      | "continue-authorized-local"
      | "pause-new-local-work" = "continue-authorized-local",
    readonly establishResult = true,
  ) {}

  async establishContact(): Promise<boolean> {
    this.establishCalls += 1;
    this.calls.push("establish");
    return this.establishResult;
  }

  start(): void {
    this.startCalls += 1;
    this.calls.push("start");
    if (this.startError !== undefined) throw this.startError;
  }

  async drain(): Promise<void> {
    this.drainCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  status(): RemoteConnectorStatus {
    return {
      connectorId: "connector-fixture",
      bindingId: "binding-fixture",
      repositoryId: "repository-fixture",
      lifecycle: this.startCalls === 0 ? "stopped" : "running",
      health: "healthy",
      partitioned: this.establishCalls > 0 && !this.establishResult,
      lastAttemptAt: null,
      lastSuccessfulContactAt: null,
      lastErrorCode: null,
      synchronization: {
        state: "never-synchronized",
        stalenessMs: null,
        inboundSequence: 0,
        waitingCommands: 0,
        readyCommands: 0,
        acceptedCommands: 0,
        pendingReports: 0,
        claimedReports: 0,
        localToEnqueued: 0,
        enqueuedToAcknowledged: 0,
      },
    };
  }
}
