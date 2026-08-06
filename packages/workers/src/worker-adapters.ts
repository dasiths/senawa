import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import type {
  WorkerAdapterDescriptor,
  WorkerCancelResult,
  WorkerExecutionPort,
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
import {
  DefinitionArtifactSchema,
  JsonObjectSchema,
  PlanArtifactSchema,
  ResearchArtifactSchema,
  VerificationArtifactSchema,
  type WorkerCapability,
} from "@senawa/domain";
import { resolveWorkerPolicy } from "./authorization.js";

const deterministicCapabilities: readonly WorkerCapability[] = [
  "repository.read",
  "repository.edit",
  "process.run",
  "senawa.task.done",
  "senawa.phase.submit",
  "senawa.ask",
  "senawa.discover",
  "senawa.note",
];
const subprocessCapabilities: readonly WorkerCapability[] = ["repository.read"];

export class DeterministicWorkerAdapter implements WorkerSessionPort, WorkerExecutionPort {
  protected readonly sessions = new Set<string>();
  protected readonly completed = new Map<string, WorkerResult>();
  protected readonly cancelled = new Map<string, string>();

  async describe(): Promise<WorkerAdapterDescriptor> {
    return descriptor("deterministic", deterministicCapabilities, {
      inspect: "exact",
      replay: true,
      streaming: true,
      cancellation: true,
      nativeTypedTools: true,
      commandBridge: true,
      pathEnforcement: "policy",
      usageCheckpoints: true,
      permissionFeedback: false,
      modelDiscovery: false,
      traceInjection: true,
    });
  }

  async negotiate(requirements: WorkerSessionRequirements): Promise<WorkerSessionPlan> {
    return negotiate(await this.describe(), requirements);
  }

  async create(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    if (this.sessions.has(turn.sessionId)) {
      throw new Error(`Worker session already exists: ${turn.sessionId}`);
    }
    this.sessions.add(turn.sessionId);
    return this.start({ ...turn, operation: "create" });
  }

  async resume(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    this.sessions.add(turn.sessionId);
    return this.start({ ...turn, operation: "resume" });
  }

  async execute(
    turn: WorkerTurn,
    onEvent?: (event: WorkerSessionEvent) => Promise<void>,
  ): Promise<WorkerResult> {
    this.sessions.add(turn.sessionId);
    return consumeHandle(this.start(turn), onEvent);
  }

  async inspect(turn: WorkerTurn): Promise<WorkerTurnObservation> {
    const result = this.completed.get(turn.turnId);
    if (result !== undefined) return { state: "completed", result };
    const detail = this.cancelled.get(turn.turnId);
    if (detail !== undefined) return { state: "cancelled", detail };
    return this.sessions.has(turn.sessionId) ? { state: "idle" } : { state: "missing" };
  }

  async cancel(turn: WorkerTurn, reason: string): Promise<WorkerCancelResult> {
    if (this.completed.has(turn.turnId)) {
      return { cancelled: false, detail: "Turn already completed" };
    }
    this.cancelled.set(turn.turnId, reason);
    return { cancelled: true, detail: reason };
  }

  async release(sessionId: string, disposition: "retain" | "archive-delete"): Promise<void> {
    if (disposition === "archive-delete") this.sessions.delete(sessionId);
  }

  protected start(turn: WorkerTurn): WorkerTurnHandle {
    const result = Promise.resolve().then(() => {
      const value = deterministicResult(turn);
      this.completed.set(turn.turnId, value);
      return value;
    });
    return createHandle(turn, result, { usageNanoAiu: 0, costUsdMicros: 0 });
  }
}

export class RecordingWorkerAdapter extends DeterministicWorkerAdapter {
  readonly operations: Array<{
    readonly operation: WorkerTurn["operation"];
    readonly turn: WorkerTurn;
  }> = [];

  override async create(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    this.operations.push({ operation: "create", turn });
    return super.create(turn);
  }

  override async resume(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    this.operations.push({ operation: "resume", turn });
    return super.resume(turn);
  }
}

export interface SubprocessWorkerOptions {
  readonly enabled: boolean;
  readonly repositoryRoot: string;
  readonly isolationRoot: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

export class SubprocessWorkerAdapter implements WorkerSessionPort, WorkerExecutionPort {
  private readonly sessions = new Set<string>();
  private readonly completed = new Map<string, WorkerResult>();
  private readonly active = new Map<string, ChildProcess>();

  constructor(private readonly options: SubprocessWorkerOptions) {}

  async describe(): Promise<WorkerAdapterDescriptor> {
    return descriptor("copilot-subprocess", subprocessCapabilities, {
      inspect: "session-only",
      replay: false,
      streaming: true,
      cancellation: true,
      nativeTypedTools: false,
      commandBridge: false,
      pathEnforcement: "none",
      usageCheckpoints: false,
      permissionFeedback: false,
      modelDiscovery: false,
      traceInjection: true,
    });
  }

  async negotiate(requirements: WorkerSessionRequirements): Promise<WorkerSessionPlan> {
    return negotiate(await this.describe(), requirements);
  }

  async create(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    if (this.sessions.has(turn.sessionId)) {
      throw new Error(`Worker session already exists: ${turn.sessionId}`);
    }
    this.sessions.add(turn.sessionId);
    return this.start({ ...turn, operation: "create" });
  }

  async resume(turn: WorkerTurn): Promise<WorkerTurnHandle> {
    this.sessions.add(turn.sessionId);
    return this.start({ ...turn, operation: "resume" });
  }

  async execute(
    turn: WorkerTurn,
    onEvent?: (event: WorkerSessionEvent) => Promise<void>,
  ): Promise<WorkerResult> {
    this.sessions.add(turn.sessionId);
    const result = await this.run(turn, onEvent);
    this.completed.set(turn.turnId, result);
    return result;
  }

  async inspect(turn: WorkerTurn): Promise<WorkerTurnObservation> {
    const result = this.completed.get(turn.turnId);
    if (result !== undefined) return { state: "completed", result };
    if (this.active.has(turn.turnId)) return { state: "active" };
    if (!this.sessions.has(turn.sessionId)) return { state: "missing" };
    return {
      state: "unknown",
      detail: "Subprocess turn state is not provable after process loss",
    };
  }

  async cancel(turn: WorkerTurn, reason: string): Promise<WorkerCancelResult> {
    const child = this.active.get(turn.turnId);
    if (child === undefined) return { cancelled: false, detail: "Turn is not active" };
    child.kill("SIGTERM");
    const escalation = setTimeout(() => child.kill("SIGKILL"), this.options.killGraceMs ?? 1_000);
    escalation.unref();
    return { cancelled: true, detail: reason };
  }

  async release(sessionId: string, disposition: "retain" | "archive-delete"): Promise<void> {
    if (disposition === "archive-delete") this.sessions.delete(sessionId);
  }

  private start(turn: WorkerTurn): WorkerTurnHandle {
    if (!this.options.enabled) {
      throw new Error(
        "Copilot subprocess execution is disabled; live mode must be explicitly enabled",
      );
    }
    const result = this.run(turn).then((value) => {
      this.completed.set(turn.turnId, value);
      return value;
    });
    return createHandle(turn, result);
  }

  private async run(
    turn: WorkerTurn,
    onEvent?: (event: WorkerSessionEvent) => Promise<void>,
  ): Promise<WorkerResult> {
    const arguments_ = buildCopilotArguments(turn);
    let eventIndex = 0;
    const workerEvent = (value: UnsavedWorkerEvent): WorkerSessionEvent =>
      ({
        ...value,
        eventId: `${turn.turnId}:subprocess:${eventIndex++}`,
        ts: new Date().toISOString(),
        traceId: turn.traceId,
      }) as WorkerSessionEvent;
    const publish = async (value: UnsavedWorkerEvent) => onEvent?.(workerEvent(value));
    await publish({
      apiVersion: "senawa.dev/worker-event/v1",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      kind: "lifecycle",
      event: turn.operation === "create" ? "created" : "resumed",
    });
    await publish({
      apiVersion: "senawa.dev/worker-event/v1",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      kind: "lifecycle",
      event: "started",
    });
    await publish({
      apiVersion: "senawa.dev/worker-event/v1",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      kind: "model",
      requested: turn.requestedModel?.id ?? turn.resolvedModel.id,
      resolved: turn.resolvedModel.id,
      reason: "exact",
    });
    const startedAt = Date.now();
    return new Promise((resolveResult, rejectResult) => {
      const child = spawn(this.options.executable ?? "copilot", arguments_, {
        cwd: this.options.repositoryRoot,
        env: {
          ...process.env,
          COPILOT_HOME: join(this.options.isolationRoot, turn.runId),
          TRACEPARENT: turn.traceparent,
          SENAWA_DISPATCH_ID: turn.dispatchId,
          SENAWA_OPERATION_ID: turn.operationId,
          SENAWA_TRACE_ID: turn.traceId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.set(turn.turnId, child);
      let stdout = "";
      let stderr = "";
      let eventWrites = Promise.resolve();
      const publishChunk = (stream: "stdout" | "stderr", text: string) => {
        eventWrites = eventWrites.then(() =>
          publish({
            apiVersion: "senawa.dev/worker-event/v1",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: "text",
            stream,
            text,
            delta: true,
          }),
        );
      };
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        publishChunk("stdout", chunk);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        publishChunk("stderr", chunk);
      });
      const timeout = setTimeout(() => child.kill("SIGTERM"), this.options.timeoutMs ?? 240_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        this.active.delete(turn.turnId);
        rejectResult(error);
      });
      child.once("close", async (code) => {
        clearTimeout(timeout);
        this.active.delete(turn.turnId);
        try {
          await eventWrites;
        } catch (error) {
          rejectResult(error);
          return;
        }
        if (code !== 0) {
          await publish({
            apiVersion: "senawa.dev/worker-event/v1",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: "lifecycle",
            event: "failed",
            detail: stderr.trim() || `Subprocess exited ${code ?? 1}`,
            durationMs: Math.max(0, Date.now() - startedAt),
          });
          rejectResult(new Error(`Copilot worker exited ${code ?? 1}: ${stderr.trim()}`));
          return;
        }
        let artifact: ReturnType<typeof JsonObjectSchema.parse> | undefined;
        if (turn.owner.kind === "phase") {
          try {
            artifact = JsonObjectSchema.parse(JSON.parse(stdout));
          } catch (error) {
            rejectResult(
              new Error("Copilot phase output was not a JSON artifact", { cause: error }),
            );
            return;
          }
        }
        if (artifact !== undefined) {
          await publish({
            apiVersion: "senawa.dev/worker-event/v1",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: "artifact",
            artifact,
          });
        }
        await publish({
          apiVersion: "senawa.dev/worker-event/v1",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          kind: "lifecycle",
          event: "completed",
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        resolveResult({
          sessionId: turn.sessionId,
          ...(artifact === undefined ? {} : { artifact }),
          output: outputs(stdout, stderr),
        });
      });
    });
  }
}

export const CopilotSubprocessHost = SubprocessWorkerAdapter;
export const DeterministicWorkerHost = DeterministicWorkerAdapter;
export type CopilotSubprocessHostOptions = SubprocessWorkerOptions;

export function buildCopilotArguments(turn: WorkerTurn): string[] {
  const policy = resolveWorkerPolicy(turn, subprocessCapabilities);
  const arguments_ =
    turn.operation === "resume"
      ? [`--resume=${turn.sessionId}`, "-p", turn.prompt]
      : [
          "-p",
          `${turn.profile.prompt}\n\n${turn.prompt}`,
          "--session-id",
          turn.sessionId,
          "--model",
          policy.model.id,
        ];
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

function descriptor(
  name: string,
  capabilities: readonly WorkerCapability[],
  features: Omit<WorkerAdapterDescriptor["features"], "callerChosenIdentity" | "resume">,
): WorkerAdapterDescriptor {
  return {
    name,
    version: "1",
    capabilities,
    features: { callerChosenIdentity: true, resume: true, ...features },
  };
}

function negotiate(
  adapter: WorkerAdapterDescriptor,
  requirements: WorkerSessionRequirements,
): WorkerSessionPlan {
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
    throw new Error(`Worker adapter ${adapter.name} cannot enforce required path containment`);
  }
  const preferred = requirements.preferredCapabilities ?? [];
  return {
    adapter,
    resolvedModel: requirements.requestedModel,
    grantedCapabilities: requirements.requiredCapabilities,
    toolTransport: adapter.features.nativeTypedTools
      ? "native"
      : adapter.features.commandBridge
        ? "command-bridge"
        : "none",
    unsupportedPreferences: preferred.filter(
      (capability) => !adapter.capabilities.includes(capability),
    ),
  };
}

function createHandle(
  turn: WorkerTurn,
  result: Promise<WorkerResult>,
  usage?: { readonly usageNanoAiu: number; readonly costUsdMicros: number },
): WorkerTurnHandle {
  return {
    turn,
    result,
    events: (async function* () {
      let index = 0;
      const startedAt = Date.now();
      const event = (value: UnsavedWorkerEvent): WorkerSessionEvent =>
        ({
          ...value,
          eventId: `${turn.turnId}:${index++}`,
          ts: new Date().toISOString(),
          traceId: turn.traceId,
        }) as WorkerSessionEvent;
      yield event({
        apiVersion: "senawa.dev/worker-event/v1",
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        kind: "lifecycle",
        event: turn.operation === "create" ? "created" : "resumed",
      });
      yield event({
        apiVersion: "senawa.dev/worker-event/v1",
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        kind: "lifecycle",
        event: "started",
      });
      yield event({
        apiVersion: "senawa.dev/worker-event/v1",
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        kind: "model",
        requested: turn.requestedModel?.id ?? turn.resolvedModel.id,
        resolved: turn.resolvedModel.id,
        ...(turn.requestedModel?.effort === undefined
          ? {}
          : { requestedEffort: turn.requestedModel.effort }),
        ...(turn.resolvedModel.effort === undefined
          ? {}
          : { resolvedEffort: turn.resolvedModel.effort }),
        reason:
          (turn.requestedModel?.id ?? turn.resolvedModel.id) === turn.resolvedModel.id &&
          (turn.requestedModel?.effort ?? turn.resolvedModel.effort) === turn.resolvedModel.effort
            ? "exact"
            : "degraded",
      });
      try {
        const outcome = await result;
        for (const output of outcome.output) {
          yield event({
            apiVersion: "senawa.dev/worker-event/v1",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: "text",
            stream: output.stream,
            text: output.text,
          });
        }
        if (outcome.artifact !== undefined) {
          yield event({
            apiVersion: "senawa.dev/worker-event/v1",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: "artifact",
            artifact: outcome.artifact,
          });
        }
        if (turn.owner.kind === "task") {
          yield event({
            apiVersion: "senawa.dev/worker-event/v1",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: "diff",
            changed: false,
            patch: "",
            reason: "Worker adapter reported no task diff",
          });
        }
        if (usage !== undefined) {
          yield event({
            apiVersion: "senawa.dev/worker-event/v1",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: "usage",
            cumulativeNanoAiu: usage.usageNanoAiu,
            cumulativeCostUsdMicros: usage.costUsdMicros,
          });
        }
        yield event({
          apiVersion: "senawa.dev/worker-event/v1",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          kind: "lifecycle",
          event: "completed",
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      } catch (error) {
        yield event({
          apiVersion: "senawa.dev/worker-event/v1",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          kind: "lifecycle",
          event: "failed",
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      }
    })(),
  };
}

async function consumeHandle(
  handle: WorkerTurnHandle,
  onEvent?: (event: WorkerSessionEvent) => Promise<void>,
): Promise<WorkerResult> {
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

type DistributiveOmit<Event, Key extends PropertyKey> = Event extends unknown
  ? Omit<Event, Key>
  : never;
type UnsavedWorkerEvent = DistributiveOmit<WorkerSessionEvent, "eventId" | "ts">;

function outputs(stdout: string, stderr: string): WorkerOutput[] {
  return [
    ...(stdout.trim() === "" ? [] : [{ stream: "stdout" as const, text: stdout.trim() }]),
    ...(stderr.trim() === "" ? [] : [{ stream: "stderr" as const, text: stderr.trim() }]),
  ];
}

function deterministicResult(turn: WorkerTurn): WorkerResult {
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
  return turn.owner.kind === "task"
    ? { sessionId: turn.sessionId, output }
    : {
        sessionId: turn.sessionId,
        artifact: JsonObjectSchema.parse(artifactForPhase(turn.owner.id, turn)),
        output,
      };
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
            claim: "The deterministic adapter provides simulated lifecycle evidence",
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
