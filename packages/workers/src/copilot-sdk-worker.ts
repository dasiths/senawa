import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  CopilotClient,
  type CopilotClientOptions,
  defineTool,
  type ModelInfo,
  type PermissionRequest,
  type PermissionRequestResult,
  type ResumeSessionConfig,
  RuntimeConnection,
  type SessionConfig,
  type SessionEvent,
  type SessionFsProvider,
  type Tool,
} from "@github/copilot-sdk";
import type {
  WorkerAdapterDescriptor,
  WorkerAuthorization,
  WorkerBindingPort,
  WorkerCancelResult,
  WorkerExecutionPort,
  WorkerModelCatalogEntry,
  WorkerModelCatalogPort,
  WorkerOutput,
  WorkerResult,
  WorkerSessionEvent,
  WorkerSessionPlan,
  WorkerSessionPort,
  WorkerSessionRequirements,
  WorkerTurn,
  WorkerTurnHandle,
  WorkerTurnObservation,
} from "@senawa/application";
import { type JsonObject, JsonObjectSchema, type WorkerCapability } from "@senawa/domain";
import { authorizeWorkerPaths, resolveWorkerPolicy } from "./authorization.js";

const sdkCapabilities: readonly WorkerCapability[] = [
  "repository.read",
  "repository.edit",
  "senawa.task.done",
  "senawa.phase.submit",
  "senawa.ask",
  "senawa.discover",
  "senawa.note",
];
export const SDK_TURN_TIMEOUT_MS = 600_000;

export interface CopilotSdkSession {
  readonly sessionId: string;
  sendAndWait(
    options: {
      readonly prompt: string;
      readonly requestHeaders?: Record<string, string>;
    },
    timeout?: number,
  ): Promise<{ readonly data: { readonly content: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotSdkClient {
  start(): Promise<void>;
  stop(): Promise<readonly Error[]>;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: SessionConfig): Promise<CopilotSdkSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSdkSession>;
  listSessions(): Promise<readonly { readonly sessionId: string }[]>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface CopilotSdkWorkerOptions {
  readonly repositoryRoot: string;
  readonly isolationRoot: string;
  readonly bindings: WorkerBindingPort;
  readonly runtimePath?: string;
  readonly client?: CopilotSdkClient;
}

export const COPILOT_SDK_WORKER_ADAPTER_VERSION = "1.0.7";

export class CopilotSdkWorkerAdapter
  implements WorkerSessionPort, WorkerExecutionPort, WorkerModelCatalogPort
{
  private readonly client: CopilotSdkClient;
  private readonly sessions = new Map<string, CopilotSdkSession>();
  private readonly active = new Map<string, CopilotSdkSession>();
  private readonly completed = new Map<string, WorkerResult>();
  private readonly cancelled = new Map<string, string>();
  private started = false;
  private traceparent: string | undefined;

  constructor(private readonly options: CopilotSdkWorkerOptions) {
    this.client =
      options.client ??
      new CopilotClient(
        createCopilotSdkClientOptions(options, () =>
          this.traceparent === undefined ? {} : { traceparent: this.traceparent },
        ),
      );
  }

  async describe(): Promise<WorkerAdapterDescriptor> {
    return {
      name: "copilot-sdk",
      version: COPILOT_SDK_WORKER_ADAPTER_VERSION,
      capabilities: sdkCapabilities,
      features: {
        callerChosenIdentity: true,
        resume: true,
        inspect: "session-only",
        replay: false,
        streaming: true,
        cancellation: true,
        nativeTypedTools: true,
        commandBridge: false,
        pathEnforcement: "policy",
        usageCheckpoints: true,
        permissionFeedback: true,
        modelDiscovery: true,
        traceInjection: true,
      },
    };
  }

  async listModels(): Promise<readonly WorkerModelCatalogEntry[]> {
    await this.ensureStarted();
    return (await this.client.listModels())
      .map((model) => ({
        id: model.id,
        name: model.name,
        supportedEfforts: model.supportedReasoningEfforts ?? [],
        ...(model.defaultReasoningEffort === undefined
          ? {}
          : { defaultEffort: model.defaultReasoningEffort }),
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id));
  }

  async negotiate(requirements: WorkerSessionRequirements): Promise<WorkerSessionPlan> {
    const adapter = await this.describe();
    const missing = requirements.requiredCapabilities.filter(
      (capability) => !adapter.capabilities.includes(capability),
    );
    if (missing.length > 0) {
      throw new Error(
        `Worker adapter ${adapter.name} lacks required capabilities: ${missing.join(", ")}`,
      );
    }
    if (requirements.requireResume && !adapter.features.resume) {
      throw new Error(`Worker adapter ${adapter.name} cannot resume sessions`);
    }
    if (requirements.requirePathEnforcement && adapter.features.pathEnforcement === "none") {
      throw new Error(`Worker adapter ${adapter.name} cannot enforce repository paths`);
    }
    await this.ensureStarted();
    const models = await this.client.listModels();
    const model = models.find((candidate) => candidate.id === requirements.requestedModel.id);
    if (model === undefined) {
      throw new Error(`Copilot SDK model is unavailable: ${requirements.requestedModel.id}`);
    }
    const requestedEffort = requirements.requestedModel.effort;
    const supportedEfforts = model.supportedReasoningEfforts ?? [];
    if (
      requestedEffort !== undefined &&
      !supportedEfforts.includes(requestedEffort) &&
      requirements.requestedModel.effortMode !== "preferred"
    ) {
      throw new Error(
        `Copilot SDK model ${model.id} does not support required effort ${requestedEffort}; supported efforts: ${supportedEfforts.join(", ") || "none"}`,
      );
    }
    const effort =
      requestedEffort === undefined || supportedEfforts.includes(requestedEffort)
        ? requestedEffort
        : model.defaultReasoningEffort;
    return {
      adapter,
      resolvedModel: {
        id: model.id,
        ...(effort === undefined ? {} : { effort }),
        ...(requirements.requestedModel.effortMode === undefined
          ? {}
          : { effortMode: requirements.requestedModel.effortMode }),
      },
      grantedCapabilities: requirements.requiredCapabilities,
      toolTransport: "native",
      unsupportedPreferences: [
        ...(requirements.preferredCapabilities ?? []).filter(
          (capability) => !adapter.capabilities.includes(capability),
        ),
        ...(requestedEffort !== undefined && effort !== requestedEffort
          ? [`reasoning-effort:${requestedEffort}`]
          : []),
      ],
    };
  }

  async create(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    if (this.sessions.has(turn.sessionId)) {
      throw new Error(`Worker session already exists: ${turn.sessionId}`);
    }
    return this.startTurn({ ...turn, operation: "create" });
  }

  async resume(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    return this.startTurn({ ...turn, operation: "resume" });
  }

  async execute(
    turn: WorkerTurn,
    onEvent?: (event: WorkerSessionEvent) => Promise<void>,
  ): Promise<WorkerResult> {
    const requestedCapabilities = turn.profile.spec.tools;
    const requiredCapabilities = requestedCapabilities.filter((capability) =>
      turn.owner.kind === "phase"
        ? capability === "repository.read" || capability === "senawa.phase.submit"
        : capability === "repository.read" ||
          capability === "repository.edit" ||
          capability === "senawa.task.done",
    );
    const plan = await this.negotiate({
      requiredCapabilities,
      preferredCapabilities: requestedCapabilities.filter(
        (capability) => !requiredCapabilities.includes(capability),
      ),
      requireResume: turn.operation === "resume",
      requirePathEnforcement: turn.owner.kind === "task",
      requestedModel: turn.requestedModel ?? turn.resolvedModel,
    });
    const plannedTurn = {
      ...turn,
      requestedModel: turn.requestedModel ?? turn.resolvedModel,
      resolvedModel: plan.resolvedModel,
    };
    const handle =
      plannedTurn.operation === "create"
        ? await this.create(plannedTurn)
        : await this.resume(plannedTurn);
    const events = (async () => {
      if (onEvent === undefined) return;
      for await (const event of handle.events) await onEvent(event);
    })();
    try {
      const result = await handle.result;
      await events;
      return result;
    } catch (error) {
      await events;
      throw error;
    }
  }

  async inspect(turn: WorkerTurn): Promise<WorkerTurnObservation> {
    const result = this.completed.get(turn.turnId);
    if (result !== undefined) return { state: "completed", result };
    if (this.active.has(turn.turnId)) return { state: "active" };
    const cancellation = this.cancelled.get(turn.turnId);
    if (cancellation !== undefined) return { state: "cancelled", detail: cancellation };
    await this.ensureStarted();
    const exists = (await this.client.listSessions()).some(
      (session) => session.sessionId === turn.sessionId,
    );
    if (!exists) return { state: "missing" };
    return {
      state: "unknown",
      detail: "Copilot SDK session history cannot prove this Senawa turn outcome",
    };
  }

  async cancel(turn: WorkerTurn, reason: string): Promise<WorkerCancelResult> {
    const session = this.active.get(turn.turnId);
    if (session === undefined) return { cancelled: false, detail: "Turn is not active" };
    this.cancelled.set(turn.turnId, reason);
    try {
      await session.abort();
    } catch (error) {
      this.cancelled.delete(turn.turnId);
      throw error;
    }
    return { cancelled: true, detail: reason };
  }

  async release(sessionId: string, disposition: "retain" | "archive-delete"): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) await session.disconnect();
    this.sessions.delete(sessionId);
    if (disposition === "archive-delete") await this.client.deleteSession(sessionId);
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    const sessions = new Set([...this.sessions.values(), ...this.active.values()]);
    await Promise.all([...sessions].map((session) => session.disconnect()));
    this.sessions.clear();
    this.active.clear();
    this.traceparent = undefined;
    const errors = await this.client.stop();
    this.started = false;
    if (errors.length > 0) throw new AggregateError(errors, "Copilot SDK shutdown failed");
  }

  private async startTurn(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    await this.ensureStarted();
    this.traceparent = turn.traceparent;
    const queue = new EventQueue<WorkerSessionEvent>();
    const output: WorkerOutput[] = [];
    let artifact: JsonObject | undefined;
    let completion: JsonObject | undefined;
    const authorization = workerAuthorization(turn);
    const bindings = this.options.bindings.bindingsFor(turn, authorization);
    const transportNames = new Map<string, string>();
    for (const binding of bindings) {
      const transportName = sdkToolName(binding.name);
      const existing = transportNames.get(transportName);
      if (existing !== undefined && existing !== binding.name) {
        throw new Error(
          `SDK tool name collision: ${existing} and ${binding.name} both map to ${transportName}`,
        );
      }
      transportNames.set(transportName, binding.name);
    }
    const tools = bindings.map((binding) =>
      defineTool(sdkToolName(binding.name), {
        description: binding.description,
        parameters: binding.inputSchema,
        defer: "never",
        handler: async (value, invocation) => {
          const input = JsonObjectSchema.parse(value);
          const result = await binding.handle(input, {
            runId: turn.runId,
            owner: turn.owner,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            authorization,
            traceparent: invocation.traceparent ?? turn.traceparent,
            ...(invocation.tracestate === undefined ? {} : { tracestate: invocation.tracestate }),
          });
          if (binding.name === "senawa.phase.submit" && result.accepted) {
            artifact = JsonObjectSchema.parse(Reflect.get(input, "artifact"));
            queue.push(event(turn, `artifact:${binding.name}`, "artifact", { artifact }));
          }
          if (binding.name === "senawa.task.done" && result.accepted) {
            completion = input;
            queue.push(
              event(turn, `completion:${binding.name}`, "completion", { submission: input }),
            );
          }
          return result;
        },
      }),
    );
    const eventHandler = (event: SessionEvent) => {
      for (const normalized of normalizeSdkEvent(turn, event, transportNames)) {
        queue.push(normalized);
        if (normalized.kind === "text" && !normalized.delta) {
          output.push({ stream: normalized.stream, text: normalized.text });
        }
      }
    };
    const boundToolNames = new Set(tools.map((tool) => tool.name));
    const permissionHandler = (request: PermissionRequest): PermissionRequestResult => {
      const decision = authorizeSdkRequest(
        turn,
        request,
        this.options.repositoryRoot,
        boundToolNames,
      );
      if (decision.kind === "reject") {
        queue.push(
          event(turn, `permission:${request.toolCallId ?? queue.size}`, "tool", {
            name: toolName(request, transportNames),
            state: "denied",
            detail: decision.feedback ?? "Senawa denied the request",
          }),
        );
      }
      return decision;
    };
    const base = {
      clientName: "senawa",
      model: turn.resolvedModel.id,
      ...(turn.resolvedModel.effort === undefined
        ? {}
        : { reasoningEffort: turn.resolvedModel.effort }),
      workingDirectory: this.options.repositoryRoot,
      tools: tools as Tool[],
      availableTools: sdkAvailableTools(turn, tools),
      excludedTools: ["task", "list_agents", "read_agent", "write_agent"],
      enableConfigDiscovery: false,
      enableFileHooks: false,
      infiniteSessions: { enabled: false },
      streaming: true,
      onPermissionRequest: permissionHandler,
      hooks: { onPreToolUse: () => ({}) },
      onEvent: eventHandler,
      createSessionFsProvider: (session) =>
        new LocalSessionFsProvider(
          resolve(this.options.isolationRoot, "sessions", session.sessionId),
          this.options.repositoryRoot,
        ),
    } satisfies ResumeSessionConfig;
    const session =
      turn.operation === "create"
        ? await this.client.createSession({
            ...base,
            sessionId: turn.sessionId,
            systemMessage: { mode: "append", content: turn.profile.prompt },
          })
        : await this.resumeSession(turn.sessionId, base);
    this.sessions.set(turn.sessionId, session);
    this.active.set(turn.turnId, session);
    queue.push(
      event(turn, "lifecycle:identity", "lifecycle", {
        event: turn.operation === "create" ? "created" : "resumed",
      }),
    );
    queue.push(event(turn, "lifecycle:started", "lifecycle", { event: "started" }));
    queue.push(
      event(turn, "model:resolved", "model", {
        requested: turn.requestedModel?.id ?? turn.resolvedModel.id,
        resolved: turn.resolvedModel.id,
        ...(turn.requestedModel?.effort === undefined
          ? {}
          : { requestedEffort: turn.requestedModel.effort }),
        ...(turn.resolvedModel.effort === undefined
          ? {}
          : { resolvedEffort: turn.resolvedModel.effort }),
        reason:
          turn.requestedModel?.id === turn.resolvedModel.id &&
          turn.requestedModel?.effort === turn.resolvedModel.effort
            ? "exact"
            : "negotiated",
      }),
    );
    const startedAt = Date.now();
    const result = session
      .sendAndWait(
        {
          prompt: turn.prompt,
          requestHeaders: {
            traceparent: turn.traceparent,
            "x-senawa-dispatch-id": turn.dispatchId,
            "x-senawa-operation-id": turn.operationId,
          },
        },
        SDK_TURN_TIMEOUT_MS,
      )
      .then((response) => {
        if (response?.data.content !== undefined && output.length === 0) {
          output.push({ stream: "stdout", text: response.data.content });
          queue.push(
            event(turn, "assistant:fallback", "text", {
              stream: "stdout",
              text: response.data.content,
            }),
          );
        }
        const value: WorkerResult = {
          sessionId: turn.sessionId,
          ...(artifact === undefined ? {} : { artifact }),
          ...(completion === undefined ? {} : { completion }),
          output,
        };
        this.completed.set(turn.turnId, value);
        queue.push(
          event(turn, "lifecycle:completed", "lifecycle", {
            event: "completed",
            durationMs: Math.max(0, Date.now() - startedAt),
          }),
        );
        queue.close();
        return value;
      })
      .catch((error: unknown) => {
        queue.push(
          event(turn, "lifecycle:failed", "lifecycle", {
            event: this.cancelled.has(turn.turnId) ? "cancelled" : "failed",
            detail: error instanceof Error ? error.message : String(error),
            durationMs: Math.max(0, Date.now() - startedAt),
          }),
        );
        queue.close();
        throw error;
      })
      .finally(() => {
        this.active.delete(turn.turnId);
      });
    return { turn, events: queue, result };
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.client.start();
    this.started = true;
  }

  private async resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotSdkSession> {
    await this.sessions.get(sessionId)?.disconnect();
    return this.client.resumeSession(sessionId, { ...config, continuePendingWork: false });
  }
}

export function createCopilotSdkClientOptions(
  options: Pick<CopilotSdkWorkerOptions, "repositoryRoot" | "runtimePath">,
  onGetTraceContext: () => Record<string, string> = () => ({}),
): CopilotClientOptions {
  return {
    connection: RuntimeConnection.forStdio({ path: options.runtimePath ?? "copilot" }),
    mode: "empty",
    workingDirectory: options.repositoryRoot,
    useLoggedInUser: true,
    logLevel: "none",
    sessionFs: {
      initialCwd: options.repositoryRoot,
      sessionStatePath: "/state",
      conventions: "posix",
    },
    onGetTraceContext,
  };
}

export class LocalSessionFsProvider implements SessionFsProvider {
  private readonly root: string;
  private readonly repositoryRoot: string | undefined;

  constructor(root: string, repositoryRoot?: string) {
    this.root = resolve(root);
    this.repositoryRoot = repositoryRoot === undefined ? undefined : resolve(repositoryRoot);
  }

  readFile(path: string): Promise<string> {
    return readFile(this.path(path), "utf8");
  }

  async writeFile(path: string, content: string, mode?: number): Promise<void> {
    const target = this.path(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, mode === undefined ? undefined : { mode });
  }

  async appendFile(path: string, content: string, mode?: number): Promise<void> {
    const target = this.path(path);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, content, mode === undefined ? undefined : { mode });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.path(path));
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async stat(path: string) {
    const details = await stat(this.path(path));
    return {
      isFile: details.isFile(),
      isDirectory: details.isDirectory(),
      size: details.size,
      mtime: details.mtime.toISOString(),
      birthtime: details.birthtime.toISOString(),
    };
  }

  async mkdir(path: string, recursive: boolean, mode?: number): Promise<void> {
    await mkdir(this.path(path), { recursive, ...(mode === undefined ? {} : { mode }) });
  }

  readdir(path: string): Promise<string[]> {
    return readdir(this.path(path));
  }

  async readdirWithTypes(path: string) {
    const entries = await readdir(this.path(path), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }));
  }

  rm(path: string, recursive: boolean, force: boolean): Promise<void> {
    return rm(this.path(path), { recursive, force });
  }

  async rename(source: string, destination: string): Promise<void> {
    const target = this.path(destination);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.path(source), target);
  }

  private path(path: string): string {
    if (this.repositoryRoot !== undefined && path !== "/state" && !path.startsWith("/state/")) {
      const target = isAbsolute(path) ? resolve(path) : resolve(this.repositoryRoot, path);
      this.assertWithin(target, this.repositoryRoot, path, "repository");
      return target;
    }
    const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
    const target = resolve(this.root, normalized);
    this.assertWithin(target, this.root, path, "session root");
    return target;
  }

  private assertWithin(target: string, root: string, path: string, boundary: string): void {
    const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (target !== root && !target.startsWith(rootPrefix)) {
      throw new Error(`Session filesystem path escapes its ${boundary}: ${path}`);
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function workerAuthorization(turn: WorkerTurn): WorkerAuthorization {
  const policy = resolveWorkerPolicy(turn, sdkCapabilities);
  return {
    runId: turn.runId,
    owner: turn.owner,
    profileDigest: turn.profileDigest,
    semanticCapabilities: policy.effectiveCapabilities,
    readablePaths: ["**"],
    writablePaths: policy.authorization.taskPaths,
    frozenPaths: policy.authorization.frozenPaths,
    allowedCommands: [],
  };
}

function authorizeSdkRequest(
  turn: WorkerTurn,
  request: PermissionRequest,
  repositoryRoot: string,
  boundToolNames: ReadonlySet<string>,
): PermissionRequestResult {
  const authorization = resolveWorkerPolicy(turn, sdkCapabilities).authorization;
  if ("requestSandboxBypass" in request && request.requestSandboxBypass === true) {
    return { kind: "reject", feedback: "Senawa denies sandbox bypass requests" };
  }
  if (request.kind === "read") {
    const result = authorizeWorkerPaths(authorization, "read", [
      { path: policyPath(repositoryRoot, request.path) },
    ]);
    return result.allowed
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: `Senawa denied read: ${result.reason}` };
  }
  if (request.kind === "write") {
    const result = authorizeWorkerPaths(authorization, "write", [
      { path: policyPath(repositoryRoot, request.fileName) },
    ]);
    return result.allowed
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: `Senawa denied write: ${result.reason}` };
  }
  if (request.kind === "custom-tool") {
    return boundToolNames.has(request.toolName)
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: "Senawa denied an unbound custom tool" };
  }
  return {
    kind: "reject",
    feedback:
      request.kind === "shell"
        ? "Senawa denies SDK shell execution because no bounded command grammar was authorized"
        : `Senawa does not authorize ${request.kind} requests`,
  };
}

function policyPath(repositoryRoot: string, path: string): string {
  if (!isAbsolute(path)) return path;
  return relative(repositoryRoot, path).replaceAll("\\", "/") || ".";
}

function sdkAvailableTools(turn: WorkerTurn, tools: readonly Tool[]): string[] {
  const policy = resolveWorkerPolicy(turn, sdkCapabilities);
  return [
    ...policy.copilot.availableTools
      .filter((name) => name !== "bash")
      .map((name) => `builtin:${name}`),
    ...tools.map((tool) => `custom:${tool.name}`),
  ];
}

function toolName(request: PermissionRequest, transportNames: ReadonlyMap<string, string>): string {
  switch (request.kind) {
    case "custom-tool":
      return transportNames.get(request.toolName) ?? request.toolName;
    case "mcp":
      return `${request.serverName}.${request.toolName}`;
    default:
      return request.kind;
  }
}

function normalizeSdkEvent(
  turn: WorkerTurn,
  native: SessionEvent,
  transportNames: ReadonlyMap<string, string>,
): WorkerSessionEvent[] {
  switch (native.type) {
    case "assistant.message":
      return [
        event(
          turn,
          native.id,
          "text",
          { stream: "stdout", text: native.data.content },
          native.timestamp,
        ),
        ...(native.data.model === undefined
          ? []
          : [
              event(
                turn,
                `${native.id}:model`,
                "model",
                {
                  requested: turn.requestedModel?.id ?? turn.resolvedModel.id,
                  resolved: native.data.model,
                  reason: "runtime",
                },
                native.timestamp,
              ),
            ]),
      ];
    case "assistant.message_delta":
      return [
        event(
          turn,
          native.id,
          "text",
          { stream: "stdout", text: native.data.deltaContent, delta: true },
          native.timestamp,
        ),
      ];
    case "tool.execution_start":
      return [
        event(
          turn,
          native.id,
          "tool",
          {
            name: transportNames.get(native.data.toolName) ?? native.data.toolName,
            state: "started",
          },
          native.timestamp,
        ),
      ];
    case "tool.execution_complete":
      return [
        event(
          turn,
          native.id,
          "tool",
          {
            name:
              transportNames.get(native.data.toolDescription?.name ?? "") ??
              native.data.toolDescription?.name ??
              native.data.toolCallId,
            state: native.data.success ? "completed" : "failed",
            ...(native.data.error?.message === undefined
              ? {}
              : { detail: native.data.error.message }),
          },
          native.timestamp,
        ),
      ];
    case "session.usage_checkpoint":
      return [
        event(
          turn,
          native.id,
          "usage",
          { cumulativeNanoAiu: native.data.totalNanoAiu },
          native.timestamp,
        ),
      ];
    default:
      return [];
  }
}

export function sdkToolName(name: string): string {
  const value = name.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new Error(`Unable to create an SDK-safe tool name for ${name}`);
  }
  return value;
}

type EventKind = WorkerSessionEvent["kind"];
type EventData<Kind extends EventKind> = Omit<
  Extract<WorkerSessionEvent, { readonly kind: Kind }>,
  "apiVersion" | "eventId" | "sessionId" | "turnId" | "ts" | "traceId" | "kind"
>;

function event<Kind extends EventKind>(
  turn: WorkerTurn,
  id: string,
  kind: Kind,
  data: EventData<Kind>,
  timestamp = new Date().toISOString(),
): Extract<WorkerSessionEvent, { readonly kind: Kind }> {
  return {
    apiVersion: "senawa.dev/worker-event/v1",
    eventId: `${turn.turnId}:sdk:${id}`,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    ts: timestamp,
    traceId: turn.traceId,
    kind,
    ...data,
  } as Extract<WorkerSessionEvent, { readonly kind: Kind }>;
}

class EventQueue<Value> implements AsyncIterable<Value> {
  private readonly values: Value[] = [];
  private readonly waiters: Array<(value: IteratorResult<Value>) => void> = [];
  private ended = false;

  get size(): number {
    return this.values.length;
  }

  push(value: Value): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.ended) return { value: undefined, done: true };
        return new Promise<IteratorResult<Value>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
