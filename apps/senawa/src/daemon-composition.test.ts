import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotSdkSessionConfig, CopilotSdkSessionPort } from "@senawa/execution-host";
import { canonicalBytes, decodeCanonicalJsonValue } from "@senawa/protocol";
import type { QueuedEffectCommand, RuntimeDependencies } from "@senawa/runtime";
import { SqliteContextBroker, SqliteRunnerAuthority } from "@senawa/storage-sqlite";
import {
  acquireUnixSocketLock,
  releaseUnixSocketLock,
  SqliteSupervisorAuthority,
} from "@senawa/supervisor";
import { createWorkerExecutionFixture, deterministicSha256, runtimeFixture } from "@senawa/testing";
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
  it("allows first dispatch but blocks missing-metadata durable recovery after reopen", async () => {
    const { environment } = sandbox("senawa-daemon-worker-");
    const dependencies: RuntimeDependencies = {
      ...runtimeDependencies,
      sha256: deterministicSha256,
    };
    const sdks: FakeOwnedSdk[] = [];
    const composition = {
      runtimeDependencies: dependencies,
      createCopilotSdk: async (options: { workingDirectory: string; baseDirectory: string }) => {
        const sdk = new FakeOwnedSdk(options.workingDirectory, options.baseDirectory);
        sdks.push(sdk);
        return sdk;
      },
    };
    let started = await startSenawaService(environment, composition);
    const worker = createWorkerExecutionFixture();
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
    });
    broker.close();
    const firstCommand = workerCommand(worker, 1, "first");
    const runner = new SqliteRunnerAuthority({
      databasePath: started.paths.databasePath,
      dependencies,
    });
    runner.configureRun({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      contextDigest: worker.context.contextDigest,
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
    const firstEffect = firstResult.load({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
    }).effects[0];
    expect(firstEffect).toMatchObject({ outcome: { status: "failed", origin: "dispatch" } });
    firstResult.close();
    expect(sdks[0]?.createCalls).toBe(1);
    expect(started.service.authority.operationalSnapshot().startedSessionIds).toEqual([]);
    await started.service.stop();
    const lock = acquireUnixSocketLock(started.paths.socketPath);
    releaseUnixSocketLock(lock);
    expect(existsSync(started.paths.socketPath)).toBe(false);

    const seedAuthority = new SqliteSupervisorAuthority({
      databasePath: started.paths.databasePath,
      assetDirectory: started.paths.assetDirectory,
      dependencies,
    });
    const seedRunner = new SqliteRunnerAuthority({
      databasePath: started.paths.databasePath,
      dependencies,
    });
    const secondCommand = workerCommand(worker, 2, "recovery");
    const currentTime = new Date().toISOString();
    const lease = seedAuthority.acquireRunLease(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "owner_seed-recovery",
      currentTime,
      new Date(Date.now() + 30_000).toISOString(),
    );
    seedRunner.enqueue(secondCommand);
    seedRunner.persistIntent({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      lease: { owner: lease.ownerId, fence: lease.fence, expiresAt: lease.expiresAt },
      currentTime,
      attemptId: "attempt_seed-recovery",
      command: secondCommand,
    });
    seedAuthority.releaseRunLease(lease, currentTime);
    seedRunner.close();
    seedAuthority.close();

    started = await startSenawaService(environment, composition);
    const status = await started.service.status();
    expect(status).toMatchObject({
      health: "degraded",
      sdkSessionStore: {
        status: "degraded",
        expectedSessionCount: 1,
        missingSessionIds: [worker.dispatch.dispatchId],
      },
    });
    expect(sdks[1]?.metadataCalls).toBeGreaterThan(0);
    expect(sdks[1]?.createCalls).toBe(0);
    expect(started.service.authority.operationalSnapshot().startedSessionIds).toEqual([
      worker.dispatch.dispatchId,
    ]);
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
    contextDigest: worker.context.contextDigest,
    inputDigest: deterministicSha256.digest(canonicalBytes(input)),
    input,
    budgetReservation: { unit: "model-millidollars", amount: 1 },
    queuedAt: runtimeFixture.currentTime,
    maxReconciliationAttempts: 2,
  };
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
