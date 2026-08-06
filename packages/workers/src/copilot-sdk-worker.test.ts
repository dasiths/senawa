import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelInfo,
  PermissionRequest,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import type { WorkerTurn } from "@senawa/application";
import type { JsonObject, WorkerProfile } from "@senawa/domain";
import { describe, expect, it } from "vitest";
import { DeterministicWorkerBindingRegistry, recordingBindingHandlers } from "./bindings.js";
import {
  type CopilotSdkClient,
  type CopilotSdkSession,
  CopilotSdkWorkerAdapter,
  createCopilotSdkClientOptions,
  LocalSessionFsProvider,
  sdkToolName,
} from "./copilot-sdk-worker.js";
import { runWorkerSessionConformance } from "./worker-conformance.test-support.js";

const taskProfile: WorkerProfile = {
  apiVersion: "senawa.dev/worker-profile/v1",
  kind: "WorkerProfile",
  metadata: { name: "implementor" },
  spec: {
    model: { id: "fake-model", effort: "high" },
    tools: ["repository.read", "repository.edit", "senawa.task.done", "senawa.note"],
  },
  prompt: "Implement the bounded task.",
};

const turn: WorkerTurn = {
  runId: "run-sdk",
  owner: { kind: "task", id: "task-sdk" },
  operation: "create",
  turnId: "turn-sdk-one",
  dispatchId: "dispatch-sdk",
  operationId: "operation-sdk",
  traceId: "a".repeat(32),
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  role: "implementor",
  profile: taskProfile,
  profileDigest: "c".repeat(64),
  requestedModel: taskProfile.spec.model,
  resolvedModel: taskProfile.spec.model,
  attempt: 1,
  sessionId: "session-sdk",
  goal: "Exercise the SDK adapter",
  rejectionReason: null,
  steering: [],
  prompt: "Complete the fake turn",
  authorization: {
    taskPaths: ["packages/workers"],
    frozenPaths: ["packages/workers/frozen/**"],
  },
};

runWorkerSessionConformance(
  [
    {
      name: "fake Copilot SDK",
      createAdapter() {
        return fixture().adapter;
      },
    },
  ],
  turn,
);

describe("Copilot SDK worker adapter offline conformance", () => {
  it("uses caller-chosen create and resume while subscribing before send", async () => {
    const { adapter, client } = fixture();
    const created = await adapter.create(turn);
    await created.result;
    expect(client.created).toEqual([turn.sessionId]);
    expect(client.eventHandlerPresentAtCreate).toBe(true);
    expect(client.sessions[0]?.eventHandlerPresentAtSend).toBe(true);
    expect((await adapter.inspect(turn)).state).toBe("completed");

    const resumedTurn = { ...turn, operation: "resume" as const, turnId: "turn-sdk-two" };
    const resumed = await adapter.resume(resumedTurn);
    await resumed.result;
    expect(client.resumed).toEqual([turn.sessionId]);
    expect(client.resumeConfigs[0]?.continuePendingWork).toBe(false);
    expect(client.sessions[1]?.requestHeaders).toMatchObject({
      traceparent: turn.traceparent,
      "x-senawa-dispatch-id": turn.dispatchId,
      "x-senawa-operation-id": turn.operationId,
    });
    expect((await adapter.inspect(resumedTurn)).state).toBe("completed");

    await adapter.release(turn.sessionId, "retain");
    expect(client.sessions[1]?.disconnected).toBe(true);
    expect(client.deleted).toEqual([]);
    expect((await adapter.inspect({ ...turn, turnId: "unknown" })).state).toBe("unknown");
    await adapter.release(turn.sessionId, "archive-delete");
    expect(client.deleted).toEqual([turn.sessionId]);
    expect((await adapter.inspect({ ...turn, turnId: "unknown" })).state).toBe("missing");
  });

  it("disconnects retained sessions and stops the SDK client on shutdown", async () => {
    const { adapter, client } = fixture();
    await (await adapter.create(turn)).result;

    await adapter.shutdown();

    expect(client.sessions[0]?.disconnected).toBe(true);
    expect(client.stopCount).toBe(1);
    expect(client.deleted).toEqual([]);
  });

  it("uses the logged-in runtime home while isolating only session state", () => {
    const options = createCopilotSdkClientOptions({
      repositoryRoot: "/workspace",
      runtimePath: "/usr/local/bin/copilot",
    });

    expect(options).not.toHaveProperty("baseDirectory");
    expect(options.useLoggedInUser).toBe(true);
    expect(options.workingDirectory).toBe("/workspace");
    expect(options.sessionFs).toEqual({
      initialCwd: "/workspace",
      sessionStatePath: "/state",
      conventions: "posix",
    });
  });

  it("contains SDK session files under the assigned session root", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-sdk-fs-"));
    const provider = new LocalSessionFsProvider(root);

    await provider.writeFile("/state/events.jsonl", "one\n");
    await provider.appendFile("/state/events.jsonl", "two\n");
    expect(await provider.readFile("/state/events.jsonl")).toBe("one\ntwo\n");
    expect(await provider.exists("/state/events.jsonl")).toBe(true);
    expect(await provider.readdir("/state")).toEqual(["events.jsonl"]);
    await expect(provider.writeFile("../../outside", "denied")).rejects.toThrow("escapes");
  });

  it("routes project files to the repository while isolating runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-sdk-repository-fs-"));
    const repositoryRoot = join(root, "repository");
    const sessionRoot = join(root, "session");
    await mkdir(repositoryRoot, { recursive: true });
    await writeFile(join(repositoryRoot, "README.md"), "repository\n");
    const provider = new LocalSessionFsProvider(sessionRoot, repositoryRoot);

    expect(await provider.readFile(join(repositoryRoot, "README.md"))).toBe("repository\n");
    expect(await provider.readFile("README.md")).toBe("repository\n");
    await provider.writeFile("/state/events.jsonl", "state\n");
    expect(await readFile(join(sessionRoot, "state", "events.jsonl"), "utf8")).toBe("state\n");
    expect(() => provider.readFile(join(root, "outside.md"))).toThrow("escapes its repository");
  });

  it("normalizes lifecycle, text, tool, model, usage, and artifact events", async () => {
    const calls: Array<{
      readonly name: Parameters<typeof recordingBindingHandlers>[0][number]["name"];
      readonly input: JsonObject;
    }> = [];
    const client = new FakeSdkClient();
    client.invokePhaseSubmission = true;
    const phaseProfile: WorkerProfile = {
      ...taskProfile,
      metadata: { name: "reviewer" },
      spec: {
        model: taskProfile.spec.model,
        tools: ["repository.read", "senawa.phase.submit"],
      },
    };
    const phaseTurn: WorkerTurn = {
      ...turn,
      owner: { kind: "phase", id: "verify" },
      role: "reviewer",
      profile: phaseProfile,
    };
    const adapter = new CopilotSdkWorkerAdapter({
      repositoryRoot: "/workspace",
      isolationRoot: "/isolated",
      client,
      bindings: new DeterministicWorkerBindingRegistry(recordingBindingHandlers(calls)),
    });
    const handle = await adapter.create(phaseTurn);
    const events = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.result;

    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["lifecycle", "text", "tool", "model", "usage", "artifact"]),
    );
    expect(events.find((event) => event.kind === "text" && event.delta)).toMatchObject({
      text: "fake ",
    });
    expect(events.find((event) => event.kind === "usage")).toMatchObject({
      cumulativeNanoAiu: 42,
    });
    expect(events.find((event) => event.kind === "artifact")).toMatchObject({
      artifact: { verdict: "pass" },
    });
    expect(result.artifact).toEqual({ verdict: "pass" });
    expect(result.output).toEqual([{ stream: "stdout", text: "fake response" }]);
    expect(calls.map((call) => call.name)).toEqual(["senawa.phase.submit"]);
    expect(events.every((event) => event.eventId.includes(phaseTurn.turnId))).toBe(true);
  });

  it("uses native bindings and canonical permission policy without a hook allow", async () => {
    const calls: Array<{
      readonly name: Parameters<typeof recordingBindingHandlers>[0][number]["name"];
      readonly input: JsonObject;
    }> = [];
    const { adapter, client } = fixture(calls);
    await (await adapter.create(turn)).result;
    const config = client.createConfigs[0];
    expect(config?.tools?.map((tool) => tool.name)).toEqual(["senawa_task_done", "senawa_note"]);
    expect(config?.tools?.every((tool) => /^[a-zA-Z0-9_-]+$/u.test(tool.name))).toBe(true);
    expect(config?.availableTools).not.toContain("builtin:bash");
    expect(config?.tools?.find((tool) => tool.name === "senawa_note")?.parameters).toMatchObject({
      type: "object",
      properties: { note: { type: "string", minLength: 1 } },
      required: ["note"],
      additionalProperties: false,
    });
    await config?.tools
      ?.find((tool) => tool.name === "senawa_note")
      ?.handler?.({ note: "kept" }, fakeInvocation());
    expect(calls.map((call) => call.name)).toContain("senawa.note");

    const hookResult = await config?.hooks?.onPreToolUse?.(
      {
        sessionId: turn.sessionId,
        timestamp: new Date(),
        workingDirectory: "/workspace",
        toolName: "edit",
        toolArgs: {},
      },
      { sessionId: turn.sessionId },
    );
    expect(hookResult).toEqual({});
    expect(hookResult).not.toHaveProperty("permissionDecision", "allow");

    expect(
      await config?.onPermissionRequest?.(writeRequest("packages/workers/src/new.ts"), {
        sessionId: turn.sessionId,
      }),
    ).toEqual({ kind: "approve-once" });
    expect(
      await config?.onPermissionRequest?.(writeRequest("packages/workers/frozen/data.ts"), {
        sessionId: turn.sessionId,
      }),
    ).toMatchObject({ kind: "reject", feedback: expect.stringContaining("frozen") });
    expect(
      await config?.onPermissionRequest?.(shellRequest(), { sessionId: turn.sessionId }),
    ).toMatchObject({ kind: "reject", feedback: expect.stringContaining("command grammar") });
    expect(
      await config?.onPermissionRequest?.(
        {
          kind: "custom-tool",
          toolCallId: "unbound",
          toolName: "senawa_unbound",
          toolDescription: "Unbound Senawa-looking tool",
        },
        { sessionId: turn.sessionId },
      ),
    ).toMatchObject({ kind: "reject", feedback: expect.stringContaining("unbound") });
  });

  it("discovers models and records unsupported effort as a negotiated degradation", async () => {
    const { adapter, client } = fixture();
    const plan = await adapter.negotiate({
      requiredCapabilities: ["repository.read", "senawa.note"],
      preferredCapabilities: [],
      requireResume: true,
      requirePathEnforcement: true,
      requestedModel: { id: "fake-model", effort: "xhigh" },
    });
    expect(plan.resolvedModel).toEqual({ id: "fake-model", effort: "medium" });
    expect(plan.unsupportedPreferences).toEqual(["reasoning-effort:xhigh"]);
    expect(plan.toolTransport).toBe("native");
    expect(plan.adapter.features).toMatchObject({
      replay: false,
      inspect: "session-only",
      permissionFeedback: true,
      modelDiscovery: true,
      traceInjection: true,
    });
    const executed = {
      ...turn,
      requestedModel: { id: "fake-model", effort: "xhigh" as const },
      resolvedModel: { id: "fake-model", effort: "xhigh" as const },
    };
    await adapter.execute(executed);
    expect(client.createConfigs.at(-1)?.reasoningEffort).toBe("medium");
    await expect(
      adapter.negotiate({
        requiredCapabilities: ["repository.read"],
        requireResume: true,
        requirePathEnforcement: false,
        requestedModel: { id: "missing-model" },
      }),
    ).rejects.toThrow("model is unavailable");
  });

  it("maps explicit cancellation to abort and reports cancelled inspection", async () => {
    const { adapter, client } = fixture();
    client.blockSend = true;
    const handle = await adapter.create(turn);
    const events = (async () => {
      const collected = [];
      for await (const event of handle.events) collected.push(event);
      return collected;
    })();
    expect(await adapter.cancel(turn, "operator request")).toEqual({
      cancelled: true,
      detail: "operator request",
    });
    await expect(handle.result).rejects.toThrow("aborted fake SDK turn");
    expect(client.sessions[0]?.aborted).toBe(true);
    expect(await events).toContainEqual(
      expect.objectContaining({ kind: "lifecycle", event: "cancelled" }),
    );
    expect(await adapter.inspect(turn)).toEqual({
      state: "cancelled",
      detail: "operator request",
    });
  });
});

function fixture(
  calls: Array<{
    readonly name: Parameters<typeof recordingBindingHandlers>[0][number]["name"];
    readonly input: JsonObject;
  }> = [],
) {
  const client = new FakeSdkClient();
  const adapter = new CopilotSdkWorkerAdapter({
    repositoryRoot: "/workspace",
    isolationRoot: "/isolated",
    client,
    bindings: new DeterministicWorkerBindingRegistry(recordingBindingHandlers(calls)),
  });
  return { adapter, client };
}

class FakeSdkClient implements CopilotSdkClient {
  readonly created: string[] = [];
  readonly resumed: string[] = [];
  readonly deleted: string[] = [];
  readonly createConfigs: SessionConfig[] = [];
  readonly resumeConfigs: ResumeSessionConfig[] = [];
  readonly sessions: FakeSdkSession[] = [];
  readonly retainedSessions = new Set<string>();
  eventHandlerPresentAtCreate = false;
  invokePhaseSubmission = false;
  blockSend = false;
  stopCount = 0;

  async start(): Promise<void> {}

  async stop(): Promise<readonly Error[]> {
    this.stopCount += 1;
    return [];
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "fake-model",
        name: "Fake model",
        capabilities: {} as ModelInfo["capabilities"],
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ];
  }

  async createSession(config: SessionConfig): Promise<CopilotSdkSession> {
    const id = config.sessionId ?? "generated";
    this.created.push(id);
    this.createConfigs.push(config);
    this.eventHandlerPresentAtCreate = config.onEvent !== undefined;
    this.retainedSessions.add(id);
    return this.makeSession(id, config);
  }

  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSdkSession> {
    this.resumed.push(sessionId);
    this.resumeConfigs.push(config);
    this.retainedSessions.add(sessionId);
    return this.makeSession(sessionId, config);
  }

  async listSessions(): Promise<readonly { readonly sessionId: string }[]> {
    return [...this.retainedSessions].map((sessionId) => ({ sessionId }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
    this.retainedSessions.delete(sessionId);
  }

  private makeSession(sessionId: string, config: SessionConfig | ResumeSessionConfig) {
    const session = new FakeSdkSession(
      sessionId,
      config,
      () => this.invokePhaseSubmission,
      () => this.blockSend,
    );
    this.sessions.push(session);
    return session;
  }
}

class FakeSdkSession implements CopilotSdkSession {
  aborted = false;
  disconnected = false;
  eventHandlerPresentAtSend = false;
  requestHeaders: Record<string, string> | undefined;
  private rejectBlocked: ((error: Error) => void) | undefined;

  constructor(
    readonly sessionId: string,
    private readonly config: SessionConfig | ResumeSessionConfig,
    private readonly shouldSubmitArtifact: () => boolean,
    private readonly shouldBlock: () => boolean,
  ) {}

  async sendAndWait(options: {
    readonly prompt: string;
    readonly requestHeaders?: Record<string, string>;
  }): Promise<{ readonly data: { readonly content: string } } | undefined> {
    this.eventHandlerPresentAtSend = this.config.onEvent !== undefined;
    this.requestHeaders = options.requestHeaders;
    if (this.shouldBlock()) {
      return new Promise((_resolve, reject) => {
        this.rejectBlocked = reject;
      });
    }
    if (this.shouldSubmitArtifact()) {
      await this.config.tools
        ?.find((tool) => tool.name === "senawa_phase_submit")
        ?.handler?.({ artifact: { verdict: "pass" } }, fakeInvocation());
    }
    for (const native of nativeEvents()) this.config.onEvent?.(native);
    return { data: { content: "fake response" } };
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.rejectBlocked?.(new Error("aborted fake SDK turn"));
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

function nativeEvents(): SessionEvent[] {
  const at = "2026-08-05T00:00:00.000Z";
  return [
    native("assistant.message_delta", "delta", at, {
      messageId: "message",
      deltaContent: "fake ",
    }),
    native("tool.execution_start", "tool-start", at, {
      toolCallId: "call",
      toolName: "senawa_phase_submit",
    }),
    native("tool.execution_complete", "tool-complete", at, {
      toolCallId: "call",
      success: true,
      toolDescription: { name: "senawa_phase_submit" },
    }),
    native("session.usage_checkpoint", "usage", at, { totalNanoAiu: 42 }),
    native("assistant.message", "message", at, {
      messageId: "message",
      content: "fake response",
      model: "fake-model",
    }),
  ];
}

function native(
  type: SessionEvent["type"],
  id: string,
  timestamp: string,
  data: object,
): SessionEvent {
  return { type, id, timestamp, parentId: null, data } as SessionEvent;
}

function writeRequest(fileName: string): PermissionRequest {
  return {
    kind: "write",
    fileName,
    diff: "",
    intention: "test write",
    canOfferSessionApproval: false,
  };
}

function shellRequest(): PermissionRequest {
  return {
    kind: "shell",
    fullCommandText: "pnpm test",
    commands: [{ identifier: "pnpm", readOnly: false }],
    possiblePaths: [],
    possibleUrls: [],
    intention: "test",
    canOfferSessionApproval: false,
    hasWriteFileRedirection: false,
  };
}

function fakeInvocation() {
  return {
    sessionId: turn.sessionId,
    toolCallId: "tool-call",
    toolName: "senawa_note",
    arguments: {},
  };
}

describe("SDK tool transport names", () => {
  it("maps semantic names to provider-safe identifiers", () => {
    expect(sdkToolName("senawa.phase.submit")).toBe("senawa_phase_submit");
    expect(sdkToolName("senawa.task.done")).toBe("senawa_task_done");
  });
});
