import type { WorkerTurn } from "@senawa/application";
import type { WorkerCapability, WorkerProfile } from "@senawa/domain";

const phaseCapabilityCeiling: ReadonlySet<WorkerCapability> = new Set([
  "repository.read",
  "senawa.phase.submit",
  "senawa.ask",
  "senawa.discover",
  "senawa.note",
]);
const taskCapabilityCeiling: ReadonlySet<WorkerCapability> = new Set([
  "repository.read",
  "repository.edit",
  "process.run",
  "senawa.task.done",
  "senawa.ask",
  "senawa.discover",
  "senawa.note",
]);
const mandatoryFrozenPaths = [
  ".agents/.copilot-tracking/**",
  ".senawa/agents/**",
  ".senawa/schemas/**",
  ".senawa/sensors.yaml",
  ".senawa/workflows/**",
] as const;

export interface WorkerAuthorizationInput {
  readonly ownerKind: "phase" | "task";
  readonly requestedCapabilities: readonly WorkerCapability[];
  readonly adapterCapabilities: readonly WorkerCapability[];
  readonly taskPaths: readonly string[];
  readonly frozenPaths: readonly string[];
}

export interface ResolvedWorkerAuthorization {
  readonly effectiveCapabilities: readonly WorkerCapability[];
  readonly taskPaths: readonly string[];
  readonly frozenPaths: readonly string[];
}

export interface WorkerPathRequest {
  readonly path: string;
  readonly resolvedPath?: string;
}

export type WorkerPathAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly path: string; readonly reason: string };

export interface ResolvedWorkerPolicy {
  readonly profileName: string;
  readonly model: WorkerProfile["spec"]["model"];
  readonly requestedCapabilities: readonly WorkerCapability[];
  readonly effectiveCapabilities: readonly WorkerCapability[];
  readonly authorization: ResolvedWorkerAuthorization;
  readonly copilot: {
    readonly availableTools: readonly string[];
    readonly excludedTools: readonly string[];
    readonly allowTools: readonly string[];
    readonly denyTools: readonly string[];
  };
}

export function resolveWorkerAuthorization(
  input: WorkerAuthorizationInput,
): ResolvedWorkerAuthorization {
  const ceiling = input.ownerKind === "task" ? taskCapabilityCeiling : phaseCapabilityCeiling;
  const supported = new Set(input.adapterCapabilities);
  return {
    effectiveCapabilities: input.requestedCapabilities.filter(
      (capability) => ceiling.has(capability) && supported.has(capability),
    ),
    taskPaths: normalizePolicyPaths(input.taskPaths),
    frozenPaths: normalizePolicyPaths([...mandatoryFrozenPaths, ...input.frozenPaths]),
  };
}

export function authorizeWorkerPaths(
  authorization: ResolvedWorkerAuthorization,
  operation: "read" | "write",
  requests: readonly WorkerPathRequest[],
): WorkerPathAuthorization {
  const capability = operation === "write" ? "repository.edit" : "repository.read";
  if (!authorization.effectiveCapabilities.includes(capability)) {
    return {
      allowed: false,
      path: requests[0]?.path ?? "",
      reason: `Missing ${capability} capability`,
    };
  }
  const allowPatterns = operation === "read";
  for (const request of requests) {
    const requested = tryNormalizeRequestPath(request.path, allowPatterns);
    if (requested === null) {
      return {
        allowed: false,
        path: request.path,
        reason:
          !allowPatterns && tryNormalizeRequestPath(request.path, true) !== null
            ? "Write path must be a concrete repository-relative file"
            : "Path is not repository-relative",
      };
    }
    const resolved =
      request.resolvedPath === undefined
        ? requested
        : tryNormalizeRequestPath(request.resolvedPath, allowPatterns);
    if (resolved === null) {
      return { allowed: false, path: request.path, reason: "Resolved path escapes the repository" };
    }
    if (operation === "write") {
      // Task paths are a suggestion, not a boundary. Only the frozen set, which protects the
      // definitions a worker is judged against, refuses a write.
      if (authorization.frozenPaths.some((scope) => matchesFrozenPath(requested, scope))) {
        return { allowed: false, path: request.path, reason: "Path is frozen" };
      }
      if (authorization.frozenPaths.some((scope) => matchesFrozenPath(resolved, scope))) {
        return { allowed: false, path: request.path, reason: "Resolved path is frozen" };
      }
    }
  }
  return { allowed: true };
}

export function resolveWorkerPolicy(
  turn: WorkerTurn,
  adapterCapabilities: readonly WorkerCapability[] = turn.profile.spec.tools,
): ResolvedWorkerPolicy {
  if (turn.profile.metadata.name !== turn.role) {
    throw new Error(
      `Worker turn role ${turn.role} does not match profile ${turn.profile.metadata.name}`,
    );
  }
  const authorization = resolveWorkerAuthorization({
    ownerKind: turn.owner.kind,
    requestedCapabilities: turn.profile.spec.tools,
    adapterCapabilities,
    taskPaths: turn.authorization.taskPaths,
    frozenPaths: turn.authorization.frozenPaths,
  });
  const allowTools = new Set<string>();
  const availableTools = new Set<string>();
  for (const capability of authorization.effectiveCapabilities) {
    for (const tool of copilotToolsForCapability(capability)) allowTools.add(tool);
    for (const tool of visibleCopilotToolsForCapability(capability)) availableTools.add(tool);
  }
  return {
    profileName: turn.profile.metadata.name,
    model: turn.resolvedModel,
    requestedCapabilities: turn.profile.spec.tools,
    effectiveCapabilities: authorization.effectiveCapabilities,
    authorization,
    copilot: {
      availableTools: [...availableTools],
      excludedTools: ["task", "list_agents", "read_agent", "write_agent"],
      allowTools: [...allowTools],
      denyTools: [
        ...(authorization.effectiveCapabilities.includes("repository.edit") ? [] : ["write"]),
        ...(authorization.effectiveCapabilities.includes("process.run") ? [] : ["shell"]),
      ],
    },
  };
}

function normalizePolicyPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => normalizeRepositoryPath(path)))].sort();
}

function normalizeRepositoryPath(path: string): string {
  const normalized = tryNormalizePolicyPath(path);
  if (normalized === null) throw new Error(`Invalid repository-relative policy path: ${path}`);
  return normalized;
}

// Scope paths are prefixes, so a wildcard is only meaningful as a trailing `**`.
function tryNormalizePolicyPath(path: string): string | null {
  return normalizeSegments(path, (part, index, segments) => {
    if (part.includes("*") && part !== "**") return false;
    return !(part === "**" && index !== segments.length - 1);
  });
}

// Request paths are concrete for writes; reads may be glob or grep patterns.
function tryNormalizeRequestPath(path: string, allowPatterns: boolean): string | null {
  return normalizeSegments(path, (part) => allowPatterns || !part.includes("*"));
}

function normalizeSegments(
  path: string,
  acceptSegment: (part: string, index: number, segments: readonly string[]) => boolean,
): string | null {
  const candidate = path.trim().replaceAll("\\", "/");
  if (candidate === "" || candidate.startsWith("/") || /^[a-z]:\//iu.test(candidate)) return null;
  const segments = candidate.split("/");
  const parts: string[] = [];
  for (const [index, part] of segments.entries()) {
    if (part === "" || part === ".") continue;
    if (part.startsWith("..")) return null;
    if (!acceptSegment(part, index, segments)) return null;
    parts.push(part);
  }
  return parts.length === 0 ? "." : parts.join("/");
}

function isWithinScope(path: string, scope: string): boolean {
  const prefix = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function matchesFrozenPath(path: string, scope: string): boolean {
  return scope.endsWith("/**") ? isWithinScope(path, scope) : path === scope;
}

function visibleCopilotToolsForCapability(capability: WorkerCapability): readonly string[] {
  switch (capability) {
    case "repository.read":
      return ["view", "glob", "grep"];
    case "repository.edit":
      return ["edit", "create", "apply_patch"];
    case "process.run":
    case "senawa.task.done":
    case "senawa.phase.submit":
    case "senawa.ask":
    case "senawa.discover":
    case "senawa.note":
      return ["bash"];
  }
}

function copilotToolsForCapability(capability: WorkerCapability): readonly string[] {
  switch (capability) {
    case "repository.read":
      return ["view", "glob", "grep"];
    case "repository.edit":
      return ["write"];
    case "process.run":
      return ["shell(senawa:*)"];
    case "senawa.task.done":
    case "senawa.phase.submit":
    case "senawa.ask":
    case "senawa.discover":
    case "senawa.note":
      return [];
  }
}
