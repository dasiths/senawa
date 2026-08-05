export type HookEvent = "pre-tool" | "permission" | "post-edit";

export interface HookPayload {
  readonly toolName?: unknown;
  readonly toolArgs?: unknown;
}

interface ToolArguments extends Record<string, unknown> {
  readonly command?: unknown;
  readonly edits?: unknown;
}

const frozenPrefixes = [
  ".senawa/sensors.yaml",
  ".senawa/agents/",
  ".senawa/workflows/",
  ".senawa/schemas/",
  ".agents/rubrics/",
  "test/",
  "tests/",
] as const;

export interface EmbeddedSessionPolicy {
  readonly preToolUse: (payload: HookPayload) => Record<string, unknown>;
  readonly permissionRequest: (payload: HookPayload) => Record<string, unknown>;
  readonly postToolUse: (payload: HookPayload) => Record<string, unknown>;
}

export function createEmbeddedSessionPolicy(): EmbeddedSessionPolicy {
  return {
    preToolUse: (payload) => decideHook("pre-tool", payload),
    permissionRequest: (payload) => decideHook("permission", payload),
    postToolUse: (payload) => decideHook("post-edit", payload),
  };
}

export function decideHook(event: HookEvent, payload: HookPayload): Record<string, unknown> {
  if (event === "post-edit") return {};
  const reason = refusalReason(payload);
  if (reason === null) return {};
  if (event === "permission") {
    return { behavior: "deny", message: reason, interrupt: true };
  }
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}

function refusalReason(payload: HookPayload): string | null {
  const args = asRecord(payload.toolArgs);
  const command = stringValue(args.command);
  if (command !== null && dangerousCommand(command)) {
    return "senawa refused this: repository history and remote publication require an explicit human action";
  }

  if (isWriteTool(stringValue(payload.toolName))) {
    for (const path of candidatePaths(args)) {
      const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
      if (frozenPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) {
        return `senawa refused this: ${normalized} is a frozen policy or validation path`;
      }
    }
  }
  return null;
}

function dangerousCommand(command: string): boolean {
  return [
    /(?:^|[;&|]\s*)git\s+commit\b/u,
    /(?:^|[;&|]\s*)git\s+push\b/u,
    /(?:^|[;&|]\s*)git\s+reset\s+--hard\b/u,
    /(?:^|[;&|]\s*)git\s+clean\s+-[^\s]*f/u,
  ].some((pattern) => pattern.test(command));
}

function candidatePaths(args: ToolArguments): string[] {
  const paths: string[] = [];
  for (const key of ["path", "filePath", "filepath", "target", "destination"]) {
    const value = stringValue(args[key]);
    if (value !== null) paths.push(value);
  }
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) paths.push(...candidatePaths(asRecord(edit)));
  }
  return paths;
}

function isWriteTool(toolName: string | null): boolean {
  return toolName !== null && /edit|create|write|apply_patch/iu.test(toolName);
}

function asRecord(value: unknown): ToolArguments {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ToolArguments)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
