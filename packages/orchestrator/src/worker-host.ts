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
} from "@senawa/core";

export interface WorkerTurn {
  readonly runId: string;
  readonly owner: { readonly kind: "phase" | "task"; readonly id: string };
  readonly role: string;
  readonly profile: WorkerProfile;
  readonly profileDigest: string;
  readonly resolvedModel: WorkerProfile["spec"]["model"];
  readonly attempt: number;
  readonly sessionId: string | null;
  readonly goal: string;
  readonly rejectionReason: string | null;
  readonly steering: readonly string[];
  readonly prompt: string;
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

export interface WorkerHost {
  execute(turn: WorkerTurn): Promise<WorkerResult>;
}

export class DeterministicWorkerHost implements WorkerHost {
  async execute(turn: WorkerTurn): Promise<WorkerResult> {
    const policy = resolveWorkerPolicy(turn);
    const sessionId =
      turn.sessionId ?? `deterministic-${turn.runId}-${turn.owner.kind}-${turn.owner.id}`;
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

    if (turn.owner.kind === "task") return { sessionId, output };

    return {
      sessionId,
      artifact: JsonObjectSchema.parse(artifactForPhase(turn.owner.id, turn)),
      output,
    };
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

    const sessionId = turn.sessionId ?? crypto.randomUUID();
    const arguments_ = buildCopilotArguments(turn, sessionId);

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
      sessionId,
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
}

export function buildCopilotArguments(
  turn: WorkerTurn,
  sessionId = turn.sessionId ?? crypto.randomUUID(),
): string[] {
  const policy = resolveWorkerPolicy(turn);
  const firstPrompt = `${turn.profile.prompt}\n\n${turn.prompt}`;
  const arguments_ = turn.sessionId
    ? [`--resume=${sessionId}`, "-p", turn.prompt]
    : ["-p", firstPrompt, "--session-id", sessionId, "--model", policy.model.id];
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

export function resolveWorkerPolicy(turn: WorkerTurn): ResolvedWorkerPolicy {
  if (turn.profile.metadata.name !== turn.role) {
    throw new Error(
      `Worker turn role ${turn.role} does not match profile ${turn.profile.metadata.name}`,
    );
  }
  const ceiling = turn.owner.kind === "task" ? taskCapabilityCeiling : phaseCapabilityCeiling;
  const effectiveCapabilities = turn.profile.spec.tools.filter((capability) =>
    ceiling.has(capability),
  );
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
