import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  DefinitionArtifactSchema,
  type JsonObject,
  JsonObjectSchema,
  PlanArtifactSchema,
  ResearchArtifactSchema,
  VerificationArtifactSchema,
  type WorkerCapability,
  type WorkerProfile,
} from "@senawa/domain";

export interface WorkerTurn {
  readonly runId: string;
  readonly owner: { readonly kind: "phase" | "task"; readonly id: string };
  readonly operation: "create" | "resume";
  readonly turnId: string;
  readonly dispatchId: string;
  readonly operationId: string;
  readonly role: string;
  readonly profile: WorkerProfile;
  readonly profileDigest: string;
  readonly resolvedModel: WorkerProfile["spec"]["model"];
  readonly attempt: number;
  readonly sessionId: string;
  readonly goal: string;
  readonly rejectionReason: string | null;
  readonly steering: readonly string[];
  readonly prompt: string;
  readonly authorization: {
    readonly taskPaths: readonly string[];
    readonly frozenPaths: readonly string[];
  };
}

export interface WorkerOutput {
  readonly stream: "stdout" | "stderr" | "system";
  readonly text: string;
}

export interface WorkerResult {
  readonly sessionId: string;
  readonly artifact?: JsonObject;
  readonly output: readonly WorkerOutput[];
}

export type WorkerTurnObservation =
  | { readonly state: "missing" }
  | { readonly state: "active" }
  | { readonly state: "completed"; readonly result: WorkerResult }
  | { readonly state: "idle" }
  | { readonly state: "cancelled"; readonly detail?: string }
  | { readonly state: "unknown"; readonly detail: string };

export interface WorkerHost {
  execute(turn: WorkerTurn): Promise<WorkerResult>;
  inspect?(turn: WorkerTurn): Promise<WorkerTurnObservation>;
}

export class DeterministicWorkerHost implements WorkerHost {
  private readonly completed = new Map<string, WorkerResult>();

  async execute(turn: WorkerTurn): Promise<WorkerResult> {
    const policy = resolveWorkerPolicy(turn);
    const output: WorkerOutput[] = [
      {
        stream: "system",
        text: `${turn.owner.kind} ${turn.owner.id} attempt ${turn.attempt} started`,
      },
      {
        stream: "system",
        text: `${policy.profileName} profile ${turn.profileDigest} loaded for ${policy.model.id} with capabilities ${policy.effectiveCapabilities.join(",")}`,
      },
      { stream: "stdout", text: `completed deterministic ${policy.profileName} turn` },
    ];

    if (turn.owner.kind === "task") {
      const result = { sessionId: turn.sessionId, output };
      this.completed.set(turn.turnId, result);
      return result;
    }

    const result = {
      sessionId: turn.sessionId,
      artifact: JsonObjectSchema.parse(artifactForPhase(turn.owner.id, turn)),
      output,
    };
    this.completed.set(turn.turnId, result);
    return result;
  }

  async inspect(turn: WorkerTurn): Promise<WorkerTurnObservation> {
    const result = this.completed.get(turn.turnId);
    return result === undefined ? { state: "missing" } : { state: "completed", result };
  }
}

export interface CopilotSubprocessHostOptions {
  readonly enabled: boolean;
  readonly repositoryRoot: string;
  readonly isolationRoot: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
}

export class CopilotSubprocessHost implements WorkerHost {
  constructor(private readonly options: CopilotSubprocessHostOptions) {}

  async execute(turn: WorkerTurn): Promise<WorkerResult> {
    if (!this.options.enabled) {
      throw new Error(
        "Copilot subprocess execution is disabled; live mode must be explicitly enabled",
      );
    }

    const arguments_ = buildCopilotArguments(turn);

    const result = await runSubprocess(
      this.options.executable ?? "copilot",
      arguments_,
      this.options.repositoryRoot,
      {
        ...process.env,
        COPILOT_HOME: join(this.options.isolationRoot, turn.runId),
      },
      this.options.timeoutMs ?? 240_000,
    );
    if (result.code !== 0) {
      throw new Error(`Copilot worker exited ${result.code}: ${result.stderr.trim()}`);
    }

    let artifact: JsonObject | undefined;
    if (turn.owner.kind === "phase") {
      try {
        artifact = JSON.parse(result.stdout) as JsonObject;
      } catch (error) {
        throw new Error("Copilot phase output was not a JSON artifact", { cause: error });
      }
    }
    return {
      sessionId: turn.sessionId,
      ...(artifact === undefined ? {} : { artifact }),
      output: [
        ...(result.stdout.trim() === ""
          ? []
          : [{ stream: "stdout" as const, text: result.stdout.trim() }]),
        ...(result.stderr.trim() === ""
          ? []
          : [{ stream: "stderr" as const, text: result.stderr.trim() }]),
      ],
    };
  }

  async inspect(): Promise<WorkerTurnObservation> {
    return {
      state: "unknown",
      detail: "The subprocess adapter cannot prove external turn state after driver loss",
    };
  }
}

export function buildCopilotArguments(turn: WorkerTurn): string[] {
  const policy = resolveWorkerPolicy(turn, subprocessAdapterCapabilities);
  const firstPrompt = `${turn.profile.prompt}\n\n${turn.prompt}`;
  const arguments_ =
    turn.operation === "resume"
      ? [`--resume=${turn.sessionId}`, "-p", turn.prompt]
      : ["-p", firstPrompt, "--session-id", turn.sessionId, "--model", policy.model.id];
  arguments_.push("--available-tools", policy.copilot.availableTools.join(","));
  arguments_.push("--excluded-tools", policy.copilot.excludedTools.join(","));
  for (const tool of policy.copilot.allowTools) arguments_.push("--allow-tool", tool);
  for (const tool of policy.copilot.denyTools) arguments_.push("--deny-tool", tool);
  arguments_.push(
    "--deny-tool",
    "shell(git commit)",
    "--deny-tool",
    "shell(git push)",
    "--no-ask-user",
    "-s",
  );
  return arguments_;
}

export interface ResolvedWorkerPolicy {
  readonly profileName: string;
  readonly model: WorkerProfile["spec"]["model"];
  readonly systemMessage: { readonly mode: "append"; readonly content: string };
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

const phaseCapabilityCeiling: ReadonlySet<WorkerCapability> = new Set([
  "repository.read",
  "senawa.phase.submit",
  "senawa.ask",
  "senawa.discover",
]);
const taskCapabilityCeiling: ReadonlySet<WorkerCapability> = new Set([
  "repository.read",
  "repository.edit",
  "process.run",
  "senawa.task.done",
  "senawa.ask",
  "senawa.discover",
]);
const mandatoryFrozenPaths = [
  ".agents/.copilot-tracking/**",
  ".senawa/agents/**",
  ".senawa/schemas/**",
  ".senawa/sensors.yaml",
  ".senawa/workflows/**",
] as const;
const subprocessAdapterCapabilities: readonly WorkerCapability[] = ["repository.read"];

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

export function resolveWorkerAuthorization(
  input: WorkerAuthorizationInput,
): ResolvedWorkerAuthorization {
  const ceiling = input.ownerKind === "task" ? taskCapabilityCeiling : phaseCapabilityCeiling;
  const adapterCapabilities = new Set(input.adapterCapabilities);
  return {
    effectiveCapabilities: input.requestedCapabilities.filter(
      (capability) => ceiling.has(capability) && adapterCapabilities.has(capability),
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
  for (const request of requests) {
    const requested = tryNormalizeRepositoryPath(request.path);
    if (requested === null) {
      return { allowed: false, path: request.path, reason: "Path is not repository-relative" };
    }
    const resolved =
      request.resolvedPath === undefined
        ? requested
        : tryNormalizeRepositoryPath(request.resolvedPath);
    if (resolved === null) {
      return { allowed: false, path: request.path, reason: "Resolved path escapes the repository" };
    }
    if (operation === "write") {
      if (!authorization.taskPaths.some((scope) => isWithinScope(requested, scope))) {
        return { allowed: false, path: request.path, reason: "Path is outside the task scope" };
      }
      if (!authorization.taskPaths.some((scope) => isWithinScope(resolved, scope))) {
        return {
          allowed: false,
          path: request.path,
          reason: "Resolved path escapes the task scope",
        };
      }
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
  const effectiveCapabilities = authorization.effectiveCapabilities;
  const allowTools = new Set<string>();
  const availableTools = new Set<string>();
  for (const capability of effectiveCapabilities) {
    for (const tool of copilotToolsForCapability(capability)) allowTools.add(tool);
    for (const tool of visibleCopilotToolsForCapability(capability)) availableTools.add(tool);
  }
  return {
    profileName: turn.profile.metadata.name,
    model: turn.resolvedModel,
    systemMessage: { mode: "append", content: turn.profile.prompt },
    requestedCapabilities: turn.profile.spec.tools,
    effectiveCapabilities,
    authorization,
    copilot: {
      availableTools: [...availableTools],
      excludedTools: ["task", "list_agents", "read_agent", "write_agent"],
      allowTools: [...allowTools],
      denyTools: [
        ...(effectiveCapabilities.includes("repository.edit") ? [] : ["write"]),
        ...(effectiveCapabilities.includes("process.run") ? [] : ["shell"]),
      ],
    },
  };
}

function normalizePolicyPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => normalizeRepositoryPath(path)))].sort();
}

function normalizeRepositoryPath(path: string): string {
  const normalized = tryNormalizeRepositoryPath(path);
  if (normalized === null) throw new Error(`Invalid repository-relative policy path: ${path}`);
  return normalized;
}

function tryNormalizeRepositoryPath(path: string): string | null {
  const alternateSeparatorsNormalized = path.trim().replaceAll("\\", "/");
  if (
    alternateSeparatorsNormalized === "" ||
    alternateSeparatorsNormalized.startsWith("/") ||
    /^[a-z]:\//iu.test(alternateSeparatorsNormalized)
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const part of alternateSeparatorsNormalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." || (part.includes("*") && part !== "**")) return null;
    if (part === "**" && alternateSeparatorsNormalized.split("/").at(-1) !== "**") return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
}

function isWithinScope(path: string, scope: string): boolean {
  const prefix = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function matchesFrozenPath(path: string, scope: string): boolean {
  if (scope.endsWith("/**")) return isWithinScope(path, scope);
  return path === scope;
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
      return [];
  }
}

function artifactForPhase(phaseId: string, turn: WorkerTurn): unknown {
  switch (phaseId) {
    case "define":
      return DefinitionArtifactSchema.parse({
        summary: `Define ${turn.goal}`,
        inScope: [turn.goal],
        outOfScope: [],
        acceptanceCriteria: ["The requested change is implemented and verified"],
        constraints: [],
        openQuestions: [],
      });
    case "research":
      return ResearchArtifactSchema.parse({
        summary: `Research for ${turn.goal}`,
        findings: [
          {
            claim: "The deterministic host provides offline lifecycle evidence",
            source: "deterministic-worker",
            evidenceKind: "simulated",
          },
        ],
        constraints: [],
        recommendations: ["Implement the bounded plan"],
      });
    case "plan":
      return PlanArtifactSchema.parse({
        summary: `Plan for ${turn.goal}`,
        tasks: [
          {
            key: "implement-change",
            title: "Implement the requested change",
            dependsOn: [],
            paths: ["packages"],
            acceptance: ["The requested behavior is implemented"],
            role: "implementor",
          },
          {
            key: "validate-change",
            title: "Validate the requested change",
            dependsOn: ["implement-change"],
            paths: ["packages"],
            acceptance: ["Focused validation passes"],
            role: "implementor",
          },
        ],
      });
    case "verify":
      return VerificationArtifactSchema.parse({
        verdict: "pass",
        summary: `Verified ${turn.goal}`,
        checks: [{ name: "deterministic-check", verdict: "pass", summary: "Validation passed" }],
        findings: [],
      });
    default:
      return { summary: `${phaseId} completed`, goal: turn.goal };
  }
}

async function runSubprocess(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, arguments_, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}
