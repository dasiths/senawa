import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotSdkSessionConfig, CopilotSdkSessionPort } from "@senawa/execution-host";
import {
  canonicalBytes,
  decodeAuthenticatedPrincipal,
  decodeCanonicalJsonValue,
} from "@senawa/protocol";
import type { QueuedEffectCommand, RuntimeDependencies } from "@senawa/runtime";
import { SqliteContextBroker, SqliteRunnerAuthority } from "@senawa/storage-sqlite";
import {
  acquireUnixSocketLock,
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
        const sdk = new FakeOwnedSdk(options.workingDirectory, options.baseDirectory);
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
        owner: `service-${process.pid}`,
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
  ) {}

  createCalls = 0;
  metadataCalls = 0;

  async resumeSession(): Promise<undefined> {
    return undefined;
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSessionPort> {
    this.createCalls += 1;
    if (config.sessionId === undefined) throw new Error("Expected dispatch session identity");
    return new FakeSession(config.sessionId);
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
  constructor(readonly sessionId: string) {}

  async sendAndWait(): Promise<void> {}

  async abort(): Promise<void> {}

  async disconnect(): Promise<void> {}
}
