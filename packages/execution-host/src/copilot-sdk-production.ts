import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  CopilotClient,
  type CopilotSession,
  defineTool,
  type ResumeSessionConfig,
  type SessionConfig,
} from "@github/copilot-sdk";
import type {
  CopilotSdkPort,
  CopilotSdkResumeSessionConfig,
  CopilotSdkSessionConfig,
  CopilotSdkSessionPort,
} from "./copilot-sdk-port.js";

export interface ProductionCopilotSdkPortOptions {
  readonly repositoryDirectory: string;
  readonly workingDirectory: string;
  readonly baseDirectory: string;
  readonly sharedClient?: CopilotClient;
  readonly sharedClientConfiguredForEmptyMode?: true;
}

export class ProductionCopilotSdkPort implements CopilotSdkPort {
  readonly baseDirectory: string;
  readonly workingDirectory: string;
  readonly clientOwnership: "port-created" | "shared";
  readonly #client: CopilotClient;
  readonly #activeSessions = new Map<string, ProductionCopilotSdkSession>();

  private constructor(
    client: CopilotClient,
    ownership: ProductionCopilotSdkPort["clientOwnership"],
    baseDirectory: string,
    workingDirectory: string,
  ) {
    this.#client = client;
    this.clientOwnership = ownership;
    this.baseDirectory = baseDirectory;
    this.workingDirectory = workingDirectory;
  }

  static async create(options: ProductionCopilotSdkPortOptions): Promise<ProductionCopilotSdkPort> {
    const [repositoryDirectory, workingDirectory, baseDirectory] = await Promise.all([
      realpath(options.repositoryDirectory),
      realpath(options.workingDirectory),
      realpath(options.baseDirectory),
    ]);
    assertOutsideRepository(workingDirectory, repositoryDirectory, "working directory");
    assertOutsideRepository(baseDirectory, repositoryDirectory, "base directory");
    if (options.sharedClient !== undefined && options.sharedClientConfiguredForEmptyMode !== true) {
      throw new TypeError("A shared Copilot client requires explicit empty-mode acknowledgement");
    }
    const client =
      options.sharedClient ??
      new CopilotClient({
        mode: "empty",
        workingDirectory,
        baseDirectory,
        logLevel: "none",
        enableRemoteSessions: false,
        sessionIdleTimeoutSeconds: 0,
      });
    return new ProductionCopilotSdkPort(
      client,
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
      const session = await this.#client.resumeSession(sessionId, resumeConfig(config));
      return this.#track(session);
    } catch (error) {
      let metadata: Awaited<ReturnType<CopilotClient["getSessionMetadata"]>>;
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
    const session = await this.#client.createSession(createConfig(config));
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

  #track(session: CopilotSession): ProductionCopilotSdkSession {
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
    readonly session: CopilotSession,
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

function createConfig(config: CopilotSdkSessionConfig): SessionConfig {
  return {
    ...commonConfig(config),
    ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
  };
}

function resumeConfig(config: CopilotSdkResumeSessionConfig): ResumeSessionConfig {
  return { ...commonConfig(config), continuePendingWork: false };
}

function commonConfig(config: CopilotSdkSessionConfig): SessionConfig {
  return {
    clientName: "senawa",
    model: config.model,
    sessionLimits: config.sessionLimits,
    tools: config.tools.map((tool) =>
      defineTool(tool.name, {
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
      }),
    ),
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
    onPermissionRequest: (request) => config.onPermissionRequest({ kind: request.kind }),
    hooks: {
      onPreToolUse: async (input) => {
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
