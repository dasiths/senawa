export interface CopilotSdkToolInvocation {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface CopilotSdkToolResult {
  readonly resultType: "success" | "failure" | "rejected" | "denied" | "timeout";
  readonly textResultForLlm: string;
}

export interface CopilotSdkTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly skipPermission: true;
  readonly defer: "never";
  handler(args: unknown, invocation: CopilotSdkToolInvocation): Promise<CopilotSdkToolResult>;
}

export interface CopilotSdkPermissionRequest {
  readonly kind: string;
}

export interface CopilotSdkPermissionResult {
  readonly kind: "reject";
  readonly feedback: string;
}

export interface CopilotSdkPreToolUseInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolArgs: unknown;
}

export interface CopilotSdkPreToolUseResult {
  readonly permissionDecision: "allow" | "deny";
  readonly permissionDecisionReason?: string;
}

export interface CopilotSdkSessionConfig {
  readonly sessionId?: string;
  readonly model: string;
  readonly sessionLimits: Readonly<{ readonly maxAiCredits: number }>;
  readonly tools: readonly CopilotSdkTool[];
  readonly availableTools: readonly string[];
  readonly excludedTools: readonly ["builtin:*", "mcp:*"];
  readonly workingDirectory: string;
  readonly additionalDirectories: readonly string[];
  readonly mcpServers: Readonly<Record<string, never>>;
  readonly toolSearch: Readonly<{ readonly enabled: false }>;
  readonly infiniteSessions: Readonly<{ readonly enabled: false }>;
  readonly largeOutput: Readonly<{ readonly enabled: false }>;
  readonly streaming: false;
  readonly includeSubAgentStreamingEvents: false;
  readonly enableConfigDiscovery: false;
  readonly skipCustomInstructions: true;
  readonly enableOnDemandInstructionDiscovery: false;
  readonly enableFileHooks: false;
  readonly enableHostGitOperations: false;
  readonly enableSessionStore: false;
  readonly enableSkills: false;
  readonly memory: Readonly<{ readonly enabled: false }>;
  readonly remoteSession: "off";
  readonly requestExtensions: false;
  readonly requestCanvasRenderer: false;
  readonly onPermissionRequest: (
    request: CopilotSdkPermissionRequest,
  ) => Promise<CopilotSdkPermissionResult> | CopilotSdkPermissionResult;
  readonly onPreToolUse: (
    input: CopilotSdkPreToolUseInput,
  ) => Promise<CopilotSdkPreToolUseResult> | CopilotSdkPreToolUseResult;
}

export interface CopilotSdkResumeSessionConfig extends CopilotSdkSessionConfig {
  readonly continuePendingWork: false;
}

export interface CopilotSdkSessionPort {
  readonly sessionId: string;
  sendAndWait(prompt: string, timeoutMs: number): Promise<void>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotSdkPort {
  readonly baseDirectory?: string;
  readonly workingDirectory?: string;
  resumeSession(
    sessionId: string,
    config: CopilotSdkResumeSessionConfig,
  ): Promise<CopilotSdkSessionPort | undefined>;
  createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSessionPort>;
  sessionMetadataExists?(sessionId: string): Promise<boolean>;
  abortSession?(sessionId: string): Promise<boolean>;
}
