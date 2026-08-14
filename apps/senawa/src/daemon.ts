import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import type { IntegrationBarrier } from "@senawa/kernel";
import {
  type CommandSubmission,
  canonicalBytes,
  decodeAuthenticatedPrincipal,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
  type SupervisorAllocationFact,
} from "@senawa/protocol";
import type { RunExecutionBinding } from "@senawa/runtime";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteContextBroker,
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
import { ProductionScheduler } from "./production-scheduler.js";
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
  let ownedWorkspaceAuthority: SqliteWorkspaceIntegrationAuthority | undefined;
  let ownedRunnerAuthority: SqliteRunnerAuthority | undefined;
  let ownedSdkPool: WorkspaceSdkPool | undefined;
  try {
    const notifier = new InMemoryRunEventNotifier(() => service?.wake());
    const authority = new SqliteSupervisorAuthority({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
      eventNotifier: notifier,
    });
    ownedAuthority = authority;
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
    const amendmentBridge = new AmendmentProposalCommandBridge({
      authority,
      broker: () => contextBroker,
      compiler: composition.amendmentCompiler ?? configurationAmendmentCompiler(dependencies),
      ownerId: `amendment-bridge-${process.pid}`,
      currentTime: () => new Date().toISOString(),
    });
    const repositoryDirectory = environment.SENAWA_REPOSITORY_DIR;
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
      scheduleBeforeEffects: ({ repositoryId, runId, lease, currentTime }) =>
        productionScheduler.schedule({ repositoryId, runId, lease, currentTime }),
      listSchedulableRuns: () => productionScheduler.listRuns(),
      deliverCompletionOutboxOnce: () => contextBroker.deliverCompletionOutboxOnce(),
      deliverAmendmentProposalOutboxOnce: () => amendmentBridge.deliverOnce(),
      closeables: [
        { close: () => contextBroker.close() },
        { close: () => workspaceAuthority.close() },
        { close: () => runnerAuthority.close() },
        ...(sdkPool === undefined
          ? []
          : [
              {
                close: () => sdkPool.close(),
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
    if (ownedSdkPool !== undefined) {
      try {
        await ownedSdkPool.close();
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
    { intent: "accept-graph-revision", roles: ["release-manager"] },
    { intent: "submit-completion", roles: ["engine", "release-manager"] },
    { intent: "evaluate-gate", roles: ["engine", "release-manager"] },
    { intent: "record-authority-decision", roles: ["release-manager"] },
    { intent: "close-phase", roles: ["engine", "release-manager"] },
    { intent: "submit-amendment-proposal", roles: ["engine", "release-manager"] },
    { intent: "withdraw-amendment-proposal", roles: ["release-manager"] },
    { intent: "record-amendment-decision", roles: ["release-manager"] },
    { intent: "apply-approved-amendment", roles: ["trusted-supervisor"] },
    { intent: "record-integration-barrier", roles: ["trusted-supervisor"] },
    { intent: "create-escalation", roles: ["engine", "release-manager"] },
    { intent: "grant-allowance", roles: ["release-manager"] },
  ]),
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

  constructor(options: WorkspaceSdkPoolOptions) {
    this.#options = options;
  }

  sdkFor(workingDirectory: string): Promise<OwnedCopilotSdkPort> {
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
        if (await sdk.sessionMetadataExists(sessionId)) {
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
