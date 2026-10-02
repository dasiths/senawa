import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ConfigurationCompilationError,
  type ConfigurationSnapshot,
  compileWorkflowAmendment,
  WORKFLOW_AMENDMENT_API_VERSION,
} from "@senawa/configuration";
import {
  BoundedGitCommandPort,
  type CopilotSdkPort,
  CopilotWorkerEffectHost,
  DurableWorkspaceEffectHost,
  GitIntegrationAdapter,
  GitWorkspaceAdapter,
  ProductionCopilotSdkPort,
  type ProductionCopilotSdkPortOptions,
  RootScopedWorkspaceFiles,
  verifyGitRepository,
} from "@senawa/execution-host";
import { type IntegrationBarrier, sha256Digest } from "@senawa/kernel";
import {
  type CommandSubmission,
  canonicalBytes,
  decodeAuthenticatedPrincipal,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
  type SupervisorAllocationFact,
} from "@senawa/protocol";
import type { RunExecutionBinding } from "@senawa/runtime";
import {
  createRoleAuthorizationPolicy,
  RuntimeDataflowAuthority,
  type RuntimeDependencies,
} from "@senawa/runtime";
import {
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "@senawa/storage-sqlite";
import {
  type AmendmentCompilerPort,
  AmendmentProposalCommandBridge,
  CompletionFactCommandBridge,
  ensurePrivateRuntimeDirectory,
  InMemoryRunEventNotifier,
  loadOrCreateLocalCredential,
  PortalApi,
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
  WorkerCredentialStore,
} from "@senawa/supervisor";
import { boundWorkflowInput } from "./advance-command.js";
import { advanceRun, classifyOutcome } from "./advance-run.js";
import {
  configurationOutputSchemaFor,
  configurationPhaseOutputSchemas,
  configurationRuntimeSchemaValidator,
  phaseOutputAssetPort,
} from "./dataflow-composition.js";
import { RuntimePhaseOutputFactBridge } from "./phase-output-bridge.js";
import { optionalPortalAssetSource } from "./portal-assets.js";
import { ProductionScheduler } from "./production-scheduler.js";
import {
  createOptionalDaemonRemoteConnector,
  type DaemonRemoteConnector,
  type DaemonRemoteConnectorFactoryInput,
} from "./remote-composition.js";
import { backupSupervisorState } from "./state-backup.js";
import { SqliteWorkerCredentialRecords } from "./worker-credential-records.js";
import { BrokerWorkerDispatchLookup } from "./worker-dispatch-lookup.js";
import { SenawaWorkerApi } from "./worker-service.js";
import { BrokerWorkerSubmissionSink } from "./worker-submission-sink.js";
import {
  DurableCompletionEligibility,
  DynamicWorkspaceEffectHost,
} from "./workspace-composition.js";

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
  readonly portalSessionClock?: { now(): number };
  readonly portalSessionLifetimeMs?: number;
  readonly scheduleBeforeEffects?: ConstructorParameters<
    typeof SupervisorService
  >[0]["scheduleBeforeEffects"];
  readonly driveRunOnce?: ConstructorParameters<typeof SupervisorService>[0]["driveRunOnce"];
  readonly createCopilotSdk?: (
    options: ProductionCopilotSdkPortOptions,
  ) => Promise<OwnedCopilotSdkPort>;
  readonly startUnixServer?: typeof startUnixSupervisorServer;
  readonly startLoopbackServer?: typeof startLoopbackSupervisorServer;
  readonly amendmentCompiler?: AmendmentCompilerPort;
  readonly evaluateIntegration?: ConstructorParameters<
    typeof DurableWorkspaceEffectHost
  >[0]["evaluateIntegration"];
  readonly createGitHost?: (
    options: ConstructorParameters<typeof DurableWorkspaceEffectHost>[0],
  ) => Promise<DurableWorkspaceEffectHost>;
  readonly createRemoteConnector?: (
    input: DaemonRemoteConnectorFactoryInput,
  ) => Promise<DaemonRemoteConnector | undefined>;
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

/**
 * The store holds every run in the project, so a record it refuses to verify
 * stops the service rather than one run. Nothing here can repair that, but the
 * bare invariant message reads as a crash and says nothing about what an
 * operator should do next, so the recovery path travels with it.
 */
function openSupervisorAuthority(
  options: ConstructorParameters<typeof SqliteSupervisorAuthority>[0],
): SqliteSupervisorAuthority {
  try {
    return new SqliteSupervisorAuthority(options);
  } catch (error) {
    throw new Error(
      `Senawa cannot open its record at ${options.databasePath}. ` +
        "The record is unchanged and no work has been lost. Run `senawa integrity check` " +
        "to see the full report, and `senawa restore` to recover from a backup.",
      { cause: error },
    );
  }
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
  let workerCredentialDatabase: DatabaseSync | undefined;
  let ownedWorkspaceAuthority: SqliteWorkspaceIntegrationAuthority | undefined;
  let ownedRunnerAuthority: SqliteRunnerAuthority | undefined;
  let ownedPortalQuery: SqlitePortalQueryAuthority | undefined;
  let ownedRunDriver: { readonly close: () => void } | undefined;
  let ownedSdkPool: WorkspaceSdkPool | undefined;
  let ownedRemoteConnector: DaemonRemoteConnector | undefined;
  try {
    const notifier = new InMemoryRunEventNotifier(() => service?.wake(), true);
    const authority = openSupervisorAuthority({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
      eventNotifier: notifier,
    });
    ownedAuthority = authority;
    const portalQuery = new SqlitePortalQueryAuthority({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
    });
    ownedPortalQuery = portalQuery;
    const workspaceAuthority = new SqliteWorkspaceIntegrationAuthority({
      databasePath: paths.databasePath,
      dependencies,
    });
    ownedWorkspaceAuthority = workspaceAuthority;
    const runnerAuthority = new SqliteRunnerAuthority({
      databasePath: paths.databasePath,
      dependencies,
    });
    ownedRunnerAuthority = runnerAuthority;
    let contextBroker: SqliteContextBroker;
    const completionEligibility = new DurableCompletionEligibility({
      workspaceAuthority,
      runnerAuthority,
      sha256: dependencies.sha256,
      currentIntegrationBarrier: (repositoryId, runId) =>
        authority.commandAuthority.queryIntegrationBarrier(repositoryId, runId),
    });
    const completionBridge = new CompletionFactCommandBridge({
      authority,
      broker: () => contextBroker,
      completionEligibility,
      currentTime: () => new Date().toISOString(),
    });
    const phaseOutputBridge = new RuntimePhaseOutputFactBridge(
      new RuntimeDataflowAuthority(
        dependencies.sha256,
        configurationRuntimeSchemaValidator(),
        phaseOutputAssetPort(
          new SqliteCanonicalJsonAssetStore(authority.commandAuthority),
          (digest) => contextBroker.loadCanonicalOutputBytes(digest),
        ),
        authority.commandAuthority,
      ),
      {
        resolve: (fact) =>
          configurationOutputSchemaFor(
            (snapshotDigest) => authority.commandAuthority.getConfigurationSnapshot(snapshotDigest),
            dependencies.sha256,
            fact,
          ),
      },
    );
    contextBroker = new SqliteContextBroker({
      databasePath: paths.databasePath,
      dependencies: {
        sha256: dependencies.sha256,
        currentTime: () => new Date().toISOString(),
        issueGrantToken: () => randomBytes(32),
      },
      completionFacts: completionBridge,
      phaseOutputFacts: phaseOutputBridge,
    });
    ownedContextBroker = contextBroker;
    // A separate handle for the one table the channel owns. The authority has
    // already migrated the file; this only reads and writes credential rows.
    workerCredentialDatabase = new DatabaseSync(paths.databasePath);
    // The agent channel is served by this process and dispatched by another, so
    // both the credential records and the readable dispatch state come from
    // durable storage rather than from anything registered in memory here.
    const workerChannel = {
      api: new SenawaWorkerApi({
        lookup: new BrokerWorkerDispatchLookup({ broker: contextBroker }),
        sha256: dependencies.sha256,
        sink: new BrokerWorkerSubmissionSink({
          assets: new SqliteCanonicalJsonAssetStore(authority.commandAuthority),
          // A broker without the fact bridges: an agent's work lands in the
          // outbox for `advance` to act on, rather than driving the runner from
          // inside the request that delivered it.
          broker: new SqliteContextBroker({
            databasePath: paths.databasePath,
            dependencies: {
              currentTime: () => new Date().toISOString(),
              issueGrantToken: () => randomBytes(32),
              sha256: dependencies.sha256,
            },
          }),
          loadSnapshot: (snapshotDigest) =>
            authority.commandAuthority.getConfigurationSnapshot(snapshotDigest),
          readSteerings: (dispatchId) => authority.commandAuthority.listAgentSteerings(dispatchId),
          sha256: dependencies.sha256,
        }),
      }),
      credentials: new WorkerCredentialStore({
        now: () => Date.now(),
        records: new SqliteWorkerCredentialRecords(workerCredentialDatabase),
        sha256: dependencies.sha256,
      }),
    };
    const amendmentBridge = new AmendmentProposalCommandBridge({
      authority,
      broker: () => contextBroker,
      compiler: composition.amendmentCompiler ?? configurationAmendmentCompiler(dependencies),
      ownerId: `amendment-bridge-${processInstanceId()}`,
      currentTime: () => new Date().toISOString(),
    });
    const repositoryDirectory = environment.SENAWA_REPOSITORY_DIR;
    // Where `.senawa` lives. The supervisor drives runs itself, which means
    // compiling the workflow and running its sensors, and neither is possible
    // from the agents' workspace.
    const projectDirectory = environment.SENAWA_PROJECT_DIR ?? process.cwd();
    const supervisorWriterLimit = positiveEnvironmentInteger(
      environment.SENAWA_SUPERVISOR_WRITER_LIMIT,
      "SENAWA_SUPERVISOR_WRITER_LIMIT",
      1,
    );
    const hostWriterCapacity = positiveEnvironmentInteger(
      environment.SENAWA_HOST_WRITER_LIMIT,
      "SENAWA_HOST_WRITER_LIMIT",
      1,
    );
    const productionScheduler = new ProductionScheduler({
      authority,
      runnerAuthority,
      workspaceAuthority,
      contextBroker,
      supervisorWriterLimit,
      hostWriterLimit: hostWriterCapacity,
      sha256: dependencies.sha256,
    });
    const sdkPool =
      repositoryDirectory === undefined || repositoryDirectory.length === 0
        ? undefined
        : new WorkspaceSdkPool({
            repositoryDirectory,
            sdkDirectory: paths.sdkDirectory,
            createSdk: composition.createCopilotSdk ?? ProductionCopilotSdkPort.create,
            sha256: dependencies.sha256,
          });
    if (sdkPool !== undefined) await sdkPool.sdkFor(required(repositoryDirectory));
    ownedSdkPool = sdkPool;
    const asyncEffectHost =
      sdkPool === undefined
        ? undefined
        : new DynamicWorkspaceEffectHost({
            authority,
            workspaceAuthority,
            repositoryRoot: required(repositoryDirectory),
            hostWriterCapacity,
            createWorkerHost: async (workingRoot) => {
              const [sdk, workspaceFiles] = await Promise.all([
                sdkPool.sdkFor(workingRoot),
                RootScopedWorkspaceFiles.create(workingRoot),
              ]);
              return new CopilotWorkerEffectHost({
                broker: contextBroker,
                sdk,
                workingDirectory: workingRoot,
                ...(sdk.baseDirectory === undefined
                  ? {}
                  : { sessionBaseDirectory: sdk.baseDirectory }),
                workspaceFiles,
                phaseOutputSchemas: configurationPhaseOutputSchemas(
                  (snapshotDigest) =>
                    authority.commandAuthority.getConfigurationSnapshot(snapshotDigest),
                  dependencies.sha256,
                ),
                transcript: contextBroker.transcript,
              });
            },
            createGitHost: async (binding) => {
              const targetRef = required(binding.execution.integrationRef);
              const command = new BoundedGitCommandPort({
                gitExecutable: environment.SENAWA_GIT_EXECUTABLE ?? "/usr/bin/git",
                isolatedHome: paths.sdkDirectory,
              });
              const verified = await verifyGitRepository(command, {
                repositoryRoot: required(repositoryDirectory),
                ownedRoot: paths.copilotWorkingDirectory,
                targetRef,
              });
              const options: ConstructorParameters<typeof DurableWorkspaceEffectHost>[0] = {
                authority: workspaceAuthority,
                workspace: new GitWorkspaceAdapter(command, verified),
                integration: new GitIntegrationAdapter(command, verified),
                identity: deterministicGitIdentity,
                sha256: dependencies.sha256,
                evaluateIntegration: composition.evaluateIntegration ?? unavailableIntegrationGate,
                recordTrustedBarrier: (repositoryId, runId, integrationId, barrier) =>
                  recordTrustedIntegrationBarrier(
                    authority,
                    binding,
                    repositoryId,
                    runId,
                    integrationId,
                    barrier,
                  ),
                currentTrustedBarrier: (repositoryId, runId) =>
                  authority.commandAuthority.queryIntegrationBarrier(repositoryId, runId),
                currentTime: () => new Date().toISOString(),
              };
              return composition.createGitHost === undefined
                ? new DurableWorkspaceEffectHost(options)
                : composition.createGitHost(options);
            },
          });
    const api = new SupervisorApi(authority, "supervisor_local", new PortalApi(portalQuery));
    const remoteConnector = await (
      composition.createRemoteConnector ?? createOptionalDaemonRemoteConnector
    )({
      environment,
      databasePath: paths.databasePath,
      dependencies,
      supervisorApi: api,
      admissionAllocator: { allocationsFor: deterministicAllocations },
    });
    ownedRemoteConnector = remoteConnector;
    const portalAssets = optionalPortalAssetSource(environment);
    const sessions = new PortalSessionSecurity({
      clock: composition.portalSessionClock ?? { now: () => Date.now() },
      random: { bytes: (length) => randomBytes(length) },
      ...(composition.portalSessionLifetimeMs === undefined
        ? {}
        : { sessionLifetimeMs: composition.portalSessionLifetimeMs }),
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
      wake: () => required(service).wake(),
      recover: (repositoryId: string, runId: string) =>
        required(service).recover(repositoryId, runId),
      backup: async (requestId: string, destinationDirectory: string) => {
        const manifest = await backupSupervisorState({
          service: required(service),
          stopSdkClient: () => (sdkPool === undefined ? Promise.resolve() : sdkPool.close()),
          sdkDirectory: paths.sdkDirectory,
          destinationDirectory,
          dependencies,
          requestId,
        });
        return Object.freeze({ requestId: manifest.requestId, verified: true as const });
      },
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
              worker: workerChannel,
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
                  ...(portalAssets === undefined ? {} : { portalAssets }),
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
    const runDriver = driveRun(
      projectDirectory,
      paths,
      dependencies,
      (repositoryId, runId, event, reason, level) => {
        authority.appendLog({
          recordedAt: new Date().toISOString(),
          level,
          event,
          message: reason,
          fields: { repositoryId, runId },
        });
      },
      (repositoryId, runId, currentTime) =>
        authority.commandAuthority.recordRunFinished(repositoryId, runId, currentTime),
      asyncEffectHost !== undefined,
    );
    ownedRunDriver = runDriver;
    if (asyncEffectHost === undefined) {
      authority.appendLog({
        recordedAt: new Date().toISOString(),
        level: "error",
        event: "service.cannot-dispatch",
        message:
          "SENAWA_REPOSITORY_DIR is not configured, so this supervisor has no worker host " +
          "and no dispatch it queues will ever start",
        fields: {},
      });
    }
    service = new SupervisorService({
      authority,
      clock: { now: () => Date.now() },
      ownerId: `service-${processInstanceId()}`,
      listeners,
      sessionStoreHealth:
        sdkPool === undefined
          ? {
              health: async (expectedSessionIds) => ({
                status: "degraded" as const,
                expectedSessionCount: expectedSessionIds.length,
                missingSessionIds: Object.freeze([...expectedSessionIds]),
                message: "SENAWA_REPOSITORY_DIR is not configured; worker dispatch is disabled",
              }),
            }
          : sdkPool,
      ...(asyncEffectHost === undefined ? {} : { asyncEffectHost }),
      runnerBatchSize: Math.min(supervisorWriterLimit, hostWriterCapacity),
      failurePolicyForRun: (repositoryId, runId) =>
        workspaceAuthority.loadRunExecution(repositoryId, runId)?.execution.failurePolicy ??
        authority.commandAuthority.queryRunExecution(repositoryId, runId)?.execution.failurePolicy,
      scheduleBeforeEffects:
        composition.scheduleBeforeEffects ??
        (({ repositoryId, runId, lease, currentTime }) => {
          if (
            remoteConnector?.disconnectedMode === "pause-new-local-work" &&
            remoteConnector.status().partitioned
          ) {
            return { worked: false, batchSize: 1 };
          }
          return productionScheduler.schedule({ repositoryId, runId, lease, currentTime });
        }),
      listSchedulableRuns: () => productionScheduler.listRuns(),
      driveRunOnce: composition.driveRunOnce ?? runDriver.drive,
      deliverCompletionOutboxOnce: () => contextBroker.deliverCompletionOutboxOnce(),
      deliverAmendmentProposalOutboxOnce: () => amendmentBridge.deliverOnce(),
      ...(remoteConnector === undefined ? {} : { remoteConnectorStatuses: [remoteConnector] }),
      ...(remoteConnector === undefined ? {} : { drainables: [remoteConnector] }),
      closeables: [
        { close: () => portalQuery.close() },
        { close: () => contextBroker.close() },
        { close: () => runDriver.close() },
        { close: () => workspaceAuthority.close() },
        { close: () => runnerAuthority.close() },
        ...(sdkPool === undefined
          ? []
          : [
              {
                close: () => sdkPool.close(),
              },
            ]),
        ...(remoteConnector === undefined ? [] : [remoteConnector]),
      ],
      onTransition: (state) => {
        if (state === "stopped") resolveStopped?.();
      },
    });
    await remoteConnector?.establishContact();
    await service.start();
    try {
      remoteConnector?.start();
    } catch (error) {
      try {
        await service.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Remote connector startup failed and supervisor cleanup was incomplete",
        );
      }
      throw error;
    }
    return Object.freeze({ service, paths, waitForStop });
  } catch (error) {
    if (service !== undefined) throw error;
    const cleanupErrors: unknown[] = [];
    if (ownedSdkPool !== undefined) {
      try {
        await ownedSdkPool.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (ownedRemoteConnector !== undefined) {
      try {
        await ownedRemoteConnector.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      ownedPortalQuery?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      ownedRunDriver?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      ownedContextBroker?.close();
      workerCredentialDatabase?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      ownedWorkspaceAuthority?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      ownedRunnerAuthority?.close();
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
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "start-phase-attempt", roles: ["engine", "release-manager"] },
    { intent: "accept-graph-revision", roles: ["release-manager"] },
    { intent: "submit-completion", roles: ["engine", "release-manager"] },
    { intent: "evaluate-gate", roles: ["engine", "release-manager"] },
    { intent: "record-authority-decision", roles: ["release-manager"] },
    { intent: "close-phase", roles: ["engine", "release-manager"] },
    { intent: "record-phase-attempt-transition", roles: ["engine", "release-manager"] },
    { intent: "import-plan", roles: ["engine", "release-manager"] },
    { intent: "record-fan-out-diff-decision", roles: ["engine", "release-manager"] },
    { intent: "submit-amendment-proposal", roles: ["engine", "release-manager"] },
    { intent: "withdraw-amendment-proposal", roles: ["release-manager"] },
    { intent: "record-amendment-decision", roles: ["engine", "release-manager"] },
    { intent: "apply-approved-amendment", roles: ["trusted-supervisor"] },
    { intent: "record-integration-barrier", roles: ["trusted-supervisor"] },
    { intent: "create-escalation", roles: ["engine", "release-manager"] },
    { intent: "answer-question", roles: ["operator", "release-manager"] },
    { intent: "steer-agent", roles: ["operator", "release-manager"] },
    { intent: "override-member", roles: ["release-manager"] },
    { intent: "grant-allowance", roles: ["release-manager"] },
    { intent: "pause-run", roles: ["operator", "release-manager"] },
    { intent: "resume-run", roles: ["operator", "release-manager"] },
    { intent: "end-run", roles: ["release-manager"] },
  ]),
});

const localPrincipal = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "local-user",
  tenant: "local",
  assurance: "single-factor",
  roles: ["operator", "release-manager"],
});

/**
 * Moves a run's workflow forward from inside the supervisor.
 *
 * Without this a run only ever executes work some other process dispatched, so
 * answering a question in the portal recorded a decision that nothing acted on
 * and the run sat looking idle. Refusals are swallowed: a workflow that no
 * longer compiles, or a run this service was not started alongside, must not
 * take the supervisor down with it.
 */
function driveRun(
  projectRoot: string,
  paths: ReturnType<typeof resolveSenawaServicePaths>,
  dependencies: RuntimeDependencies,
  report: (
    repositoryId: string,
    runId: string,
    event: string,
    reason: string,
    level: "info" | "error",
  ) => void,
  /** Records that a run finished its own work. Returns whether this ended it. */
  recordFinished: (repositoryId: string, runId: string, currentTime: string) => boolean,
  /**
   * Whether anything can actually start a worker. A service with no repository
   * builds no effect host, so a dispatch is queued and never begins, and the
   * run sits looking exactly like a deadlock with nothing saying why.
   */
  canDispatch = true,
): {
  readonly drive: (input: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly currentTime: string;
  }) => Promise<boolean>;
  readonly close: () => void;
} {
  /** The last stop reported per run, so a stopped run says it once. */
  const stopped = new Map<string, string>();
  /** Runs already told that nothing here can start their work. */
  const toldCannotDispatch = new Set<string>();
  // Opening an authority pair costs about half a second on a run of three
  // phases and grows with the run, and this opened a new one every cycle, on
  // the event loop the console answers from. The clock is the cycle's, because
  // what an advance writes is stamped with the time the advance was asked for.
  let advanceTime = new Date().toISOString();
  const supervisor = new SqliteSupervisorAuthority({
    databasePath: paths.databasePath,
    assetDirectory: paths.assetDirectory,
    dependencies,
  });
  // Deliberately without the fact bridges: an agent's work lands in the outbox
  // for the advance to act on, rather than driving the runner from inside it.
  const broker = new SqliteContextBroker({
    databasePath: paths.databasePath,
    dependencies: {
      sha256: dependencies.sha256,
      currentTime: () => advanceTime,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  const drive = async ({
    repositoryId,
    runId,
    currentTime,
  }: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly currentTime: string;
  }) => {
    advanceTime = currentTime;
    // A dispatch this service can never begin is worth saying once, against the
    // run, where every other reason a run stopped is already written.
    const key = `${repositoryId}\u0000${runId}`;
    if (!canDispatch && !toldCannotDispatch.has(key)) {
      toldCannotDispatch.add(key);
      report(
        repositoryId,
        runId,
        "run.cannot-dispatch",
        "this supervisor has no worker host, so a dispatch is queued and never starts; " +
          "set SENAWA_REPOSITORY_DIR and restart the service",
        "error",
      );
    }
    try {
      const outcome = await advanceRun({
        open: { supervisor, broker },
        projectRoot,
        databasePath: paths.databasePath,
        assetDirectory: paths.assetDirectory,
        repositoryId,
        runId,
        principal: localPrincipal,
        dependencies,
        currentTime,
        workflowInput: boundWorkflowInput({ repositoryId, runId }, paths, dependencies),
        repositoryBase: {
          commitDigest: sha256Digest("0".repeat(64)),
          treeDigest: sha256Digest("0".repeat(64)),
        },
      });
      // A run that has stopped for a reason says the reason. `rejected` and
      // `gate-refused` are the driver giving up on a phase, and reporting them
      // as "no work" made a live run that had crashed its worker eight times
      // and spent its attempt ceiling indistinguishable from an idle one: the
      // pump stopped, `senawa status` said running, and the record said nothing
      // a person could act on.
      const key = `${repositoryId}\u0000${runId}`;
      if (outcome.kind === "rejected" || outcome.kind === "gate-refused") {
        const reason = `${outcome.kind} at ${outcome.phaseKey}: ${outcome.reasons.join("; ")}`;
        if (stopped.get(key) !== reason) {
          stopped.set(key, reason);
          report(repositoryId, runId, "run.stopped", reason, "error");
        }
      } else if (stopped.delete(key)) {
        // Clearing the stop silently left the record saying the run was refused
        // long after it had moved on, so anything reading the log to find out
        // what a run is doing reported a refusal that no longer held.
        report(repositoryId, runId, "run.resumed", `moved on with ${outcome.kind}`, "info");
      }
      // A run that has finished has no more work, and saying "no work" is not
      // the same as being over. `ended` was only reachable from `ending`, which
      // only a person requests, so a run that closed every phase stayed
      // `running` for ever and the portal went on offering to end it.
      if (outcome.kind === "finished" && recordFinished(repositoryId, runId, currentTime)) {
        report(
          repositoryId,
          runId,
          "run.finished",
          "every phase has closed; the run is over",
          "info",
        );
      }
      return classifyOutcome(outcome) === "progress" && outcome.kind !== "finished";
    } catch (error) {
      // A workflow that no longer compiles, or a run this service was not
      // started alongside, must not take the supervisor down. It must not
      // disappear either: a run that stops advancing for an unreported reason
      // is the hardest possible thing to diagnose. Stderr is not a place a
      // person looks, and on this service it is not kept at all, so the reason
      // goes where the rest of the run's history is.
      const reason = error instanceof Error ? error.message : String(error);
      report(repositoryId, runId, "run.drive-failed", reason, "error");
      process.stderr.write(
        `drive-run-failed ${repositoryId} ${runId}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      );
      return false;
    }
  };
  return {
    drive,
    close: () => {
      broker.close();
      supervisor.close();
    },
  };
}

function deterministicAllocations(
  submission: CommandSubmission,
): readonly SupervisorAllocationFact[] {
  const allocations: SupervisorAllocationFact[] = [1, 2, 3].map((ordinal) => ({
    kind: "stream-event" as const,
    id: allocatedId(submission.commandId, "stream-event", ordinal),
  }));
  if (
    submission.intent.type === "record-authority-decision" ||
    submission.intent.type === "record-amendment-decision"
  ) {
    allocations.push({
      kind: "approval",
      id: allocatedId(submission.commandId, "approval", 1),
    });
  }
  return allocations;
}

function configurationAmendmentCompiler(dependencies: RuntimeDependencies): AmendmentCompilerPort {
  return Object.freeze({
    compile(input: Parameters<AmendmentCompilerPort["compile"]>[0]) {
      const submission = requiredRecord(input.source.submission, "Worker amendment submission");
      const amendment = requiredRecord(submission.amendment, "Worker amendment payload");
      const context = requiredRecord(input.source.context, "Worker amendment context");
      const submissionId = requiredString(submission.submissionId, "submissionId");
      try {
        const compilation = compileWorkflowAmendment(
          {
            document: {
              apiVersion: WORKFLOW_AMENDMENT_API_VERSION,
              kind: "WorkflowAmendment",
              baseSnapshotDigest: requiredString(
                context.configurationSnapshotDigest,
                "configurationSnapshotDigest",
              ),
              baseContextDigest: requiredString(amendment.baseContextDigest, "baseContextDigest"),
              operations: amendment.operations,
            },
            locator: `worker-amendment://${submissionId}`,
            baseSnapshot: input.baseConfigurationSnapshot as ConfigurationSnapshot,
            phaseCandidateHistory: input.phaseCandidateHistory as never,
          },
          dependencies.sha256,
        );
        return {
          status: "compiled" as const,
          proposal: compilation.proposal as never,
          resultConfigurationSnapshot: compilation.resultSnapshot,
        };
      } catch (error) {
        if (!(error instanceof ConfigurationCompilationError)) throw error;
        return {
          status: "diagnostics" as const,
          diagnostics: error.diagnostics.map(({ code, locator, pointer, message }) => ({
            code,
            locator,
            pointer,
            message,
          })),
        };
      }
    },
  });
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function allocatedId(commandId: string, kind: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(`${commandId}:${kind}:${ordinal}`)
    .digest("hex")
    .slice(0, 32);
  return kind === "approval" ? `approval_${digest}` : `${kind}-${digest}`;
}

let cachedProcessInstanceId: string | undefined;

/**
 * Returns an identifier unique to this process instance.
 *
 * Runner owner identifiers seed attempt identifiers, and attempt identifiers
 * decide whether an in-flight effect belongs to the current runner. A process
 * identifier alone is not unique over time: the operating system reuses it, and
 * the attempt counter restarts at zero in every process, so a restarted daemon
 * that inherits a recycled process identifier would mint attempt identifiers
 * that collide with a previous process and claim its effects as its own.
 */
function processInstanceId(): string {
  cachedProcessInstanceId ??= `${process.pid}-${randomBytes(8).toString("hex")}`;
  return cachedProcessInstanceId;
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

interface WorkspaceSdkPoolOptions {
  readonly repositoryDirectory: string;
  readonly sdkDirectory: string;
  readonly createSdk: NonNullable<SenawaServiceCompositionOptions["createCopilotSdk"]>;
  readonly sha256: RuntimeDependencies["sha256"];
}

class WorkspaceSdkPool {
  readonly #options: WorkspaceSdkPoolOptions;
  readonly #sdks = new Map<string, Promise<OwnedCopilotSdkPort>>();
  #closed = false;

  constructor(options: WorkspaceSdkPoolOptions) {
    this.#options = options;
  }

  sdkFor(workingDirectory: string): Promise<OwnedCopilotSdkPort> {
    if (this.#closed) throw new Error("Copilot SDK pool is closed");
    const existing = this.#sdks.get(workingDirectory);
    if (existing !== undefined) return existing;
    const baseDirectory = join(
      this.#options.sdkDirectory,
      `workspace-${this.#options.sha256.digest(new TextEncoder().encode(workingDirectory))}`,
    );
    ensurePrivateRuntimeDirectory(baseDirectory);
    const created = this.#options.createSdk({
      repositoryDirectory: this.#options.repositoryDirectory,
      workingDirectory,
      baseDirectory,
      allowRepositoryWorkingDirectory: true,
    });
    this.#sdks.set(workingDirectory, created);
    return created;
  }

  async health(expectedSessionIds: readonly string[]) {
    const sdks = await Promise.all(this.#sdks.values());
    const missingSessionIds: string[] = [];
    for (const sessionId of expectedSessionIds) {
      let present = false;
      for (const sdk of sdks) {
        // A client that is not connected cannot answer, and asking it must not
        // end the supervisor cycle. An unanswerable root reports the session as
        // missing, which is what a degraded reading is for.
        let exists = false;
        try {
          exists = (await sdk.sessionMetadataExists(sessionId)) === true;
        } catch {
          exists = false;
        }
        if (exists) {
          present = true;
          break;
        }
      }
      if (!present) missingSessionIds.push(sessionId);
    }
    return Object.freeze({
      status: missingSessionIds.length === 0 ? ("healthy" as const) : ("degraded" as const),
      expectedSessionCount: expectedSessionIds.length,
      missingSessionIds: Object.freeze(missingSessionIds),
      ...(missingSessionIds.length === 0
        ? {}
        : { message: "One or more durable worker sessions are missing from isolated SDK roots" }),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    for (const sdk of await Promise.all(this.#sdks.values())) {
      try {
        await stopOwnedCopilotSdk(sdk);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Copilot SDK pool shutdown failed");
  }
}

const deterministicGitIdentity = Object.freeze({
  authorName: "Senawa Worker",
  authorEmail: "worker@senawa.invalid",
  authorDate: "2000-01-01T00:00:00Z",
  committerName: "Senawa Integration",
  committerEmail: "integration@senawa.invalid",
  committerDate: "2000-01-01T00:00:00Z",
});

async function unavailableIntegrationGate() {
  return Object.freeze({
    decision: "failed" as const,
    evidence: { reason: "post-integration validation callback is not configured" },
  });
}

const trustedSupervisorPrincipal = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "workspace-integration-supervisor",
  tenant: "local",
  assurance: "hardware-backed",
  roles: ["trusted-supervisor"],
});

export function recordTrustedIntegrationBarrier(
  authority: SqliteSupervisorAuthority,
  binding: RunExecutionBinding,
  repositoryId: string,
  runId: string,
  integrationId: string,
  barrier: IntegrationBarrier,
): void {
  const payload = {
    integrationId,
    configurationSnapshotDigest: binding.configurationSnapshotDigest,
    barrier,
  } as const;
  const commandId = `command_integration-barrier-${barrier.barrierDigest.slice(0, 32)}`;
  const envelope = decodeCommandEnvelope({
    apiVersion: PROTOCOL_VERSION,
    commandId,
    principal: trustedSupervisorPrincipal,
    transport: { kind: "runner", requestId: `request_${commandId}` },
    repositoryId,
    runId,
    intent: { type: "record-integration-barrier" },
    payload,
    payloadDigest: authority.dependencies.sha256.digest(canonicalBytes(payload)),
    expectedGraphRevision: barrier.graphRevisionDigest,
    exactObjectDigest: barrier.barrierDigest,
  });
  let ordinal = 0;
  const receipt = authority.commandAuthority.submit(envelope, {
    currentTime: new Date().toISOString(),
    facts: { source: "workspace-integration-supervisor", integrationId },
    allocateId: () => {
      ordinal += 1;
      return `stream-event-${barrier.barrierDigest.slice(0, 24)}-${ordinal}`;
    },
  });
  if (receipt.status !== "completed") {
    throw new Error("Trusted integration barrier command was not accepted");
  }
}

function positiveEnvironmentInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Senawa service composition is not ready");
  return value;
}
