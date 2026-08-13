import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type CopilotSdkPort,
  CopilotWorkerEffectHost,
  FilesystemCopilotSessionStore,
  ProductionCopilotSdkPort,
  type ProductionCopilotSdkPortOptions,
} from "@senawa/execution-host";
import {
  type CommandSubmission,
  decodeAuthenticatedPrincipal,
  type SupervisorAllocationFact,
} from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { SqliteContextBroker } from "@senawa/storage-sqlite";
import {
  CompletionFactCommandBridge,
  ensurePrivateRuntimeDirectory,
  InMemoryRunEventNotifier,
  loadOrCreateLocalCredential,
  PortalSessionSecurity,
  SqliteSupervisorAuthority,
  SseEventSource,
  SupervisorApi,
  SupervisorHttpHandler,
  type SupervisorHttpServerHandle,
  type SupervisorListener,
  SupervisorService,
  startLoopbackSupervisorServer,
  startUnixSupervisorServer,
} from "@senawa/supervisor";

export interface SenawaServicePaths {
  readonly runtimeDirectory: string;
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly credentialPath: string;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly sdkDirectory: string;
  readonly copilotWorkingDirectory: string;
  readonly serviceLogPath: string;
}

export interface StartedSenawaService {
  readonly service: SupervisorService;
  readonly paths: SenawaServicePaths;
  readonly waitForStop: Promise<void>;
}

export interface OwnedCopilotSdkPort extends CopilotSdkPort {
  sessionMetadataExists(sessionId: string): Promise<boolean>;
  stopOwnedClient(): Promise<readonly Error[]>;
}

export interface SenawaServiceCompositionOptions {
  readonly runtimeDependencies?: RuntimeDependencies;
  readonly createCopilotSdk?: (
    options: ProductionCopilotSdkPortOptions,
  ) => Promise<OwnedCopilotSdkPort>;
  readonly startUnixServer?: typeof startUnixSupervisorServer;
  readonly startLoopbackServer?: typeof startLoopbackSupervisorServer;
}

export function resolveSenawaServicePaths(
  environment: NodeJS.ProcessEnv = process.env,
): SenawaServicePaths {
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  const runtimeBase = environment.XDG_RUNTIME_DIR ?? join(tmpdir(), `senawa-${uid}`);
  const stateBase = environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const runtimeDirectory = resolve(runtimeBase, "senawa");
  const stateDirectory = resolve(stateBase, "senawa");
  return Object.freeze({
    runtimeDirectory,
    stateDirectory,
    socketPath: join(runtimeDirectory, "supervisor.sock"),
    credentialPath: join(runtimeDirectory, "credential"),
    databasePath: join(stateDirectory, "authority.db"),
    assetDirectory: join(stateDirectory, "assets"),
    sdkDirectory: join(stateDirectory, "copilot-sdk"),
    copilotWorkingDirectory: join(stateDirectory, "copilot-work"),
    serviceLogPath: join(stateDirectory, "service.log"),
  });
}

export async function startSenawaService(
  environment: NodeJS.ProcessEnv = process.env,
  composition: SenawaServiceCompositionOptions = {},
): Promise<StartedSenawaService> {
  const dependencies = composition.runtimeDependencies ?? runtimeDependencies;
  const paths = resolveSenawaServicePaths(environment);
  mkdirSync(dirname(paths.runtimeDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.stateDirectory), { recursive: true, mode: 0o700 });
  ensurePrivateRuntimeDirectory(paths.runtimeDirectory);
  ensurePrivateRuntimeDirectory(paths.stateDirectory);
  ensurePrivateRuntimeDirectory(paths.sdkDirectory);
  ensurePrivateRuntimeDirectory(paths.copilotWorkingDirectory);
  const credential = loadOrCreateLocalCredential(paths.runtimeDirectory, {
    bytes: (length) => randomBytes(length),
  });
  let service: SupervisorService | undefined;
  let ownedAuthority: SqliteSupervisorAuthority | undefined;
  let ownedContextBroker: SqliteContextBroker | undefined;
  let ownedSdk: OwnedCopilotSdkPort | undefined;
  try {
    const notifier = new InMemoryRunEventNotifier(() => service?.wake());
    const authority = new SqliteSupervisorAuthority({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
      eventNotifier: notifier,
    });
    ownedAuthority = authority;
    let contextBroker: SqliteContextBroker;
    const completionBridge = new CompletionFactCommandBridge({
      authority,
      broker: () => contextBroker,
      currentTime: () => new Date().toISOString(),
    });
    contextBroker = new SqliteContextBroker({
      databasePath: paths.databasePath,
      dependencies: {
        sha256: dependencies.sha256,
        currentTime: () => new Date().toISOString(),
        issueGrantToken: () => randomBytes(32),
      },
      completionFacts: completionBridge,
    });
    ownedContextBroker = contextBroker;
    const repositoryDirectory = environment.SENAWA_REPOSITORY_DIR;
    const sdk =
      repositoryDirectory === undefined || repositoryDirectory.length === 0
        ? undefined
        : await (composition.createCopilotSdk ?? ProductionCopilotSdkPort.create)({
            repositoryDirectory,
            workingDirectory: paths.copilotWorkingDirectory,
            baseDirectory: paths.sdkDirectory,
          });
    ownedSdk = sdk;
    const asyncEffectHost =
      sdk === undefined
        ? undefined
        : new CopilotWorkerEffectHost({
            broker: contextBroker,
            sdk,
            workingDirectory: paths.copilotWorkingDirectory,
            sessionBaseDirectory: paths.sdkDirectory,
          });
    const api = new SupervisorApi(authority);
    const sessions = new PortalSessionSecurity({
      clock: { now: () => Date.now() },
      random: { bytes: (length) => randomBytes(length) },
    });
    const sse = new SseEventSource({
      api,
      notifier,
      stopped: () => service?.state === "stopped" || service?.state === "stopping",
    });
    const contextFactory = () => ({
      principal: localPrincipal,
      transportKind: "cli" as const,
      requestId: "request-local-supervisor",
      admission: {
        currentTime: new Date().toISOString(),
        facts: { source: "local-supervisor" },
        allocator: { allocationsFor: deterministicAllocations },
      },
    });
    const operations = {
      status: () => required(service).status(),
      drain: () => required(service).drain(),
      stop: () => required(service).stop(),
      recover: (repositoryId: string, runId: string) =>
        required(service).recover(repositoryId, runId),
      logs: (afterCursor?: number, limit?: number) => required(service).logs(afterCursor, limit),
    };
    const listeners: SupervisorListener[] = [
      listener(
        async () =>
          (composition.startUnixServer ?? startUnixSupervisorServer)(
            paths.socketPath,
            new SupervisorHttpHandler({
              api,
              transport: "ipc",
              credential,
              sessions,
              contextFactory,
              sse,
              operations,
            }),
          ),
        "ipc",
      ),
    ];
    const portalPort = optionalPort(environment.SENAWA_PORTAL_PORT);
    if (portalPort !== undefined) {
      listeners.push(
        listener(
          () =>
            (composition.startLoopbackServer ?? startLoopbackSupervisorServer)(
              portalPort,
              (origin) =>
                new SupervisorHttpHandler({
                  api,
                  transport: "loopback",
                  sessions,
                  loopbackOrigin: origin,
                  contextFactory: () => ({ ...contextFactory(), transportKind: "http" }),
                  sse,
                  operations,
                }),
            ),
          "loopback",
        ),
      );
    }
    let resolveStopped: (() => void) | undefined;
    const waitForStop = new Promise<void>((resolvePromise) => {
      resolveStopped = resolvePromise;
    });
    service = new SupervisorService({
      authority,
      clock: { now: () => Date.now() },
      ownerId: `service-${process.pid}`,
      listeners,
      sessionStoreHealth:
        sdk === undefined
          ? {
              health: async (expectedSessionIds) => ({
                status: "degraded" as const,
                expectedSessionCount: expectedSessionIds.length,
                missingSessionIds: Object.freeze([...expectedSessionIds]),
                message: "SENAWA_REPOSITORY_DIR is not configured; worker dispatch is disabled",
              }),
            }
          : new FilesystemCopilotSessionStore({
              baseDirectory: paths.sdkDirectory,
              metadata: sdk,
            }),
      ...(asyncEffectHost === undefined ? {} : { asyncEffectHost }),
      deliverCompletionOutboxOnce: () => contextBroker.deliverCompletionOutboxOnce(),
      closeables: [
        { close: () => contextBroker.close() },
        ...(sdk === undefined
          ? []
          : [
              {
                close: () => stopOwnedCopilotSdk(sdk),
              },
            ]),
      ],
      onTransition: (state) => {
        if (state === "stopped") resolveStopped?.();
      },
    });
    await service.start();
    return Object.freeze({ service, paths, waitForStop });
  } catch (error) {
    if (service !== undefined) throw error;
    const cleanupErrors: unknown[] = [];
    if (ownedSdk !== undefined) {
      try {
        await stopOwnedCopilotSdk(ownedSdk);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      ownedContextBroker?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      ownedAuthority?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Senawa service startup failed");
    }
    throw error;
  }
}

export async function runSenawaServiceForeground(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const started = await startSenawaService(environment);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void started.service.stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await started.waitForStop;
}

export const runtimeDependencies: RuntimeDependencies = Object.freeze({
  sha256: {
    digest(bytes: Uint8Array) {
      return createHash("sha256").update(bytes).digest("hex");
    },
  },
  authorization: { authorize: () => true },
});

const localPrincipal = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "local-user",
  tenant: "local",
  assurance: "single-factor",
  roles: ["operator", "release-manager"],
});

function deterministicAllocations(
  submission: CommandSubmission,
): readonly SupervisorAllocationFact[] {
  const allocations: SupervisorAllocationFact[] = [1, 2, 3].map((ordinal) => ({
    kind: "stream-event" as const,
    id: allocatedId(submission.commandId, "stream-event", ordinal),
  }));
  if (submission.intent.type === "record-authority-decision") {
    allocations.push({
      kind: "approval",
      id: allocatedId(submission.commandId, "approval", 1),
    });
  }
  return allocations;
}

function allocatedId(commandId: string, kind: string, ordinal: number): string {
  return `${kind}-${createHash("sha256").update(`${commandId}:${kind}:${ordinal}`).digest("hex").slice(0, 32)}`;
}

function listener(
  startServer: () => Promise<SupervisorHttpServerHandle>,
  kind: "ipc" | "loopback",
): SupervisorListener {
  let handle: SupervisorHttpServerHandle | undefined;
  return {
    async start() {
      handle = await startServer();
      const address = kind === "ipc" ? required(handle.socketPath) : required(handle.origin);
      return Object.freeze({ kind, address });
    },
    async close() {
      if (handle !== undefined) await handle.close();
    },
  };
}

function optionalPort(input: string | undefined): number | undefined {
  if (input === undefined || input === "") return undefined;
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("SENAWA_PORTAL_PORT must be an integer from 0 to 65535");
  }
  return port;
}

async function stopOwnedCopilotSdk(sdk: OwnedCopilotSdkPort): Promise<void> {
  const errors = await sdk.stopOwnedClient();
  if (errors.length > 0) throw new AggregateError(errors, "Copilot SDK shutdown failed");
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Senawa service composition is not ready");
  return value;
}
