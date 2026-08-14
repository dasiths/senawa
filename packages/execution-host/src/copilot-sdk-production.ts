import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type {
  CopilotSdkPort,
  CopilotSdkResumeSessionConfig,
  CopilotSdkSessionConfig,
  CopilotSdkSessionPort,
} from "./copilot-sdk-port.js";

interface RuntimeCopilotSession {
  readonly sessionId: string;
  sendAndWait(message: { readonly prompt: string }, timeoutMs: number): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

interface RuntimeCopilotClient {
  createSession(config: RuntimeSessionConfig): Promise<RuntimeCopilotSession>;
  resumeSession(
    sessionId: string,
    config: RuntimeResumeSessionConfig,
  ): Promise<RuntimeCopilotSession>;
  getSessionMetadata(sessionId: string): Promise<unknown | undefined>;
  stop(): Promise<Error[]>;
}

interface RuntimeToolInvocation {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface RuntimePermissionRequest {
  readonly kind: string;
}

interface RuntimePreToolUseInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolArgs: unknown;
}

type RuntimeDefineTool = (
  name: string,
  options: {
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly skipPermission: true;
    readonly defer: "never";
    readonly handler: (args: unknown, invocation: RuntimeToolInvocation) => Promise<unknown>;
  },
) => unknown;

interface RuntimeSessionConfig extends Readonly<Record<string, unknown>> {
  readonly tools: readonly unknown[];
}

interface RuntimeResumeSessionConfig extends RuntimeSessionConfig {
  readonly continuePendingWork: false;
}

interface RuntimeCopilotSdkModule {
  readonly CopilotClient: new (options: Readonly<Record<string, unknown>>) => RuntimeCopilotClient;
  readonly defineTool: RuntimeDefineTool;
}

export interface ProductionCopilotSdkPortOptions {
  readonly repositoryDirectory: string;
  readonly workingDirectory: string;
  readonly baseDirectory: string;
  readonly allowRepositoryWorkingDirectory?: boolean;
  readonly sharedClient?: RuntimeCopilotClient;
  readonly sharedClientConfiguredForEmptyMode?: true;
}

export class ProductionCopilotSdkPort implements CopilotSdkPort {
  readonly baseDirectory: string;
  readonly workingDirectory: string;
  readonly clientOwnership: "port-created" | "shared";
  readonly #client: RuntimeCopilotClient;
  readonly #defineTool: RuntimeDefineTool;
  readonly #activeSessions = new Map<string, ProductionCopilotSdkSession>();

  private constructor(
    client: RuntimeCopilotClient,
    defineTool: RuntimeDefineTool,
    ownership: ProductionCopilotSdkPort["clientOwnership"],
    baseDirectory: string,
    workingDirectory: string,
  ) {
    this.#client = client;
    this.#defineTool = defineTool;
    this.clientOwnership = ownership;
    this.baseDirectory = baseDirectory;
    this.workingDirectory = workingDirectory;
  }

  static async create(options: ProductionCopilotSdkPortOptions): Promise<ProductionCopilotSdkPort> {
    const { CopilotClient: CopilotClientConstructor, defineTool } = (await import(
      "@github/copilot-sdk"
    )) as unknown as RuntimeCopilotSdkModule;
    const [repositoryDirectory, workingDirectory, baseDirectory] = await Promise.all([
      realpath(options.repositoryDirectory),
      realpath(options.workingDirectory),
      realpath(options.baseDirectory),
    ]);
    if (options.allowRepositoryWorkingDirectory === true) {
      if (workingDirectory !== repositoryDirectory) {
        assertOutsideRepository(workingDirectory, repositoryDirectory, "working directory");
      }
    } else {
      assertOutsideRepository(workingDirectory, repositoryDirectory, "working directory");
    }
    assertOutsideRepository(baseDirectory, repositoryDirectory, "base directory");
    if (options.sharedClient !== undefined && options.sharedClientConfiguredForEmptyMode !== true) {
      throw new TypeError("A shared Copilot client requires explicit empty-mode acknowledgement");
    }
    const client =
      options.sharedClient ??
      new CopilotClientConstructor({
        mode: "empty",
        workingDirectory,
        baseDirectory,
        logLevel: "none",
        enableRemoteSessions: false,
        sessionIdleTimeoutSeconds: 0,
      });
    return new ProductionCopilotSdkPort(
      client,
      defineTool,
      options.sharedClient === undefined ? "port-created" : "shared",
      baseDirectory,
      workingDirectory,
    );
  }

  async resumeSession(
    sessionId: string,
    config: CopilotSdkResumeSessionConfig,
  ): Promise<CopilotSdkSessionPort | undefined> {
    try {
      const session = await this.#client.resumeSession(
        sessionId,
        resumeConfig(config, this.#defineTool),
      );
      return this.#track(session);
    } catch (error) {
      let metadata: unknown | undefined;
      try {
        metadata = await this.#client.getSessionMetadata(sessionId);
      } catch {
        throw error;
      }
      if (metadata === undefined) return undefined;
      throw error;
    }
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSessionPort> {
    const session = await this.#client.createSession(createConfig(config, this.#defineTool));
    return this.#track(session);
  }

  async sessionMetadataExists(sessionId: string): Promise<boolean> {
    return (await this.#client.getSessionMetadata(sessionId)) !== undefined;
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const session = this.#activeSessions.get(sessionId);
    if (session === undefined) return false;
    await session.abort();
    return true;
  }

  async stopOwnedClient(): Promise<readonly Error[]> {
    if (this.clientOwnership !== "port-created") {
      throw new TypeError("A shared Copilot client must be stopped by its external owner");
    }
    return this.#client.stop();
  }

  #track(session: RuntimeCopilotSession): ProductionCopilotSdkSession {
    const tracked = new ProductionCopilotSdkSession(session, () => {
      if (this.#activeSessions.get(session.sessionId) === tracked) {
        this.#activeSessions.delete(session.sessionId);
      }
    });
    this.#activeSessions.set(session.sessionId, tracked);
    return tracked;
  }
}

class ProductionCopilotSdkSession implements CopilotSdkSessionPort {
  constructor(
    readonly session: RuntimeCopilotSession,
    readonly onDisconnect: () => void,
  ) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  async sendAndWait(prompt: string, timeoutMs: number): Promise<void> {
    await this.session.sendAndWait({ prompt }, timeoutMs);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async disconnect(): Promise<void> {
    try {
      await this.session.disconnect();
    } finally {
      this.onDisconnect();
    }
  }
}

function createConfig(
  config: CopilotSdkSessionConfig,
  defineTool: RuntimeDefineTool,
): RuntimeSessionConfig {
  return {
    ...commonConfig(config, defineTool),
    ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
  };
}

function resumeConfig(
  config: CopilotSdkResumeSessionConfig,
  defineTool: RuntimeDefineTool,
): RuntimeResumeSessionConfig {
  return { ...commonConfig(config, defineTool), continuePendingWork: false };
}

function commonConfig(
  config: CopilotSdkSessionConfig,
  defineTool: RuntimeDefineTool | undefined,
): RuntimeSessionConfig {
  return {
    clientName: "senawa",
    model: config.model,
    sessionLimits: config.sessionLimits,
    tools: config.tools.map((tool) => {
      if (defineTool === undefined) {
        throw new TypeError("Copilot SDK tools require the loaded production adapter");
      }
      return defineTool(tool.name, {
        description: tool.description,
        parameters: tool.parameters,
        skipPermission: true,
        defer: "never",
        handler: (args, invocation) =>
          tool.handler(args, {
            sessionId: invocation.sessionId,
            toolCallId: invocation.toolCallId,
            toolName: invocation.toolName,
          }),
      });
    }),
    availableTools: [...config.availableTools],
    excludedTools: [...config.excludedTools],
    workingDirectory: config.workingDirectory,
    additionalDirectories: [],
    mcpServers: {},
    toolSearch: { enabled: false },
    infiniteSessions: { enabled: false },
    largeOutput: { enabled: false },
    streaming: false,
    includeSubAgentStreamingEvents: false,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    skillDirectories: [],
    pluginDirectories: [],
    instructionDirectories: [],
    disabledMcpServers: [],
    customAgents: [],
    memory: { enabled: false },
    remoteSession: "off",
    requestExtensions: false,
    requestCanvasRenderer: false,
    enableMcpApps: false,
    enableExperimentalMode: false,
    enableSessionTelemetry: false,
    onPermissionRequest: (request: RuntimePermissionRequest) =>
      config.onPermissionRequest({ kind: request.kind }),
    hooks: {
      onPreToolUse: async (input: RuntimePreToolUseInput) => {
        const result = await config.onPreToolUse({
          sessionId: input.sessionId,
          toolName: input.toolName,
          toolArgs: input.toolArgs,
        });
        return {
          permissionDecision: result.permissionDecision,
          ...(result.permissionDecisionReason === undefined
            ? {}
            : { permissionDecisionReason: result.permissionDecisionReason }),
        };
      },
    },
  };
}

function assertOutsideRepository(path: string, repositoryDirectory: string, label: string): void {
  const repositoryToPath = relative(repositoryDirectory, path);
  const pathToRepository = relative(path, repositoryDirectory);
  if (
    repositoryToPath === "" ||
    (!repositoryToPath.startsWith("..") && !isAbsolute(repositoryToPath)) ||
    (!pathToRepository.startsWith("..") && !isAbsolute(pathToRepository))
  ) {
    throw new TypeError(`Copilot SDK ${label} must be outside the repository`);
  }
}
