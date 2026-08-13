import { createHash } from "node:crypto";
import {
  assessCompletionAccounting,
  assetId,
  type CompletionSubmission,
  consumerKey,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  definitionGeneration,
  runId,
  type Sha256,
  sha256Digest,
  taskId,
  type WorkerDispatch,
} from "@senawa/kernel";
import {
  decodeAssetReadRequest,
  decodeWorkerSubmission,
  PROTOCOL_VERSION,
  type WorkerSubmission,
} from "@senawa/protocol";
import {
  type AssetReadResult,
  type ContextBrokerClient,
  renderPromptPack,
  type SubmissionAdmissionResult,
  WORKER_CAPABILITIES,
} from "@senawa/runtime";
import { describe, expect, it, vi } from "vitest";
import type {
  CopilotSdkPort,
  CopilotSdkResumeSessionConfig,
  CopilotSdkSessionConfig,
  CopilotSdkSessionPort,
  CopilotSdkTool,
  CopilotSdkToolResult,
} from "./copilot-sdk-port.js";
import { COPILOT_WORKER_TOOL_NAMES, CopilotSerialWorkerAdapter } from "./copilot-worker.js";

const sha256: Sha256 = {
  digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
};
const GRANT_TOKEN = "A".repeat(43);
const ALL_CAPABILITIES = Object.freeze(Object.values(WORKER_CAPABILITIES));

describe("CopilotSerialWorkerAdapter", () => {
  it("resumes by dispatch identity, creates only when absent, and configures exact limits", async () => {
    const sdk = new FakeSdkPort();
    const first = harness(sdk);
    sdk.onSend = complete("completed");

    const created = await first.adapter.run(first.input);
    const resumed = await first.adapter.run(first.input);
    const changed = harness(sdk, { graph: "9", ordinal: 2 });
    const fresh = await changed.adapter.run(changed.input);

    expect([created.status, resumed.status, fresh.status]).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(sdk.resumeCalls.map(({ sessionId }) => sessionId)).toEqual([
      first.dispatch.dispatchId,
      first.dispatch.dispatchId,
      changed.dispatch.dispatchId,
    ]);
    expect(sdk.createCalls.map(({ sessionId }) => sessionId)).toEqual([
      first.dispatch.dispatchId,
      changed.dispatch.dispatchId,
    ]);
    expect(sdk.resumeCalls[0]?.config.continuePendingWork).toBe(false);
    const config = required(sdk.createCalls[0]);
    expect(config.model).toBe("gpt-5-mini");
    expect(config.sessionLimits).toEqual({ maxAiCredits: 1.25 });
    expect(first.selection.limits).toEqual({
      maxTurns: 4,
      maxSubmissions: 8,
      maxMillidollars: 2_000,
      maxAiCredits: 1.25,
    });
    expect(config).toMatchObject({
      excludedTools: ["builtin:*", "mcp:*"],
      additionalDirectories: [],
      mcpServers: {},
      toolSearch: { enabled: false },
      infiniteSessions: { enabled: false },
      largeOutput: { enabled: false },
      streaming: false,
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
      memory: { enabled: false },
      remoteSession: "off",
      requestExtensions: false,
      requestCanvasRenderer: false,
    });
  });

  it("exposes only six capability and grant filtered tools with closed schemas", async () => {
    const sdk = new FakeSdkPort();
    const all = harness(sdk);
    await all.adapter.run(all.input);
    const config = required(sdk.createCalls[0]);

    expect(config.tools.map(({ name }) => name)).toEqual(COPILOT_WORKER_TOOL_NAMES);
    expect(config.availableTools).toEqual(COPILOT_WORKER_TOOL_NAMES);
    expect(
      config.tools.every(({ skipPermission, defer }) => skipPermission && defer === "never"),
    ).toBe(true);
    for (const tool of config.tools) expectClosedObjectSchemas(tool.parameters);
    const schemas = JSON.stringify(config.tools.map(({ parameters }) => parameters));
    for (const forbidden of [
      "repositoryId",
      "runId",
      "dispatchId",
      "contextId",
      "principalId",
      "submissionId",
      "requestId",
      "grantToken",
      "taskId",
    ]) {
      expect(schemas).not.toContain(forbidden);
    }

    const filteredSdk = new FakeSdkPort();
    const filtered = harness(filteredSdk, {
      capabilities: [WORKER_CAPABILITIES.assetRead, WORKER_CAPABILITIES.completion],
      grantTokens: new Map(),
    });
    await filtered.adapter.run(filtered.input);
    expect(required(filteredSdk.createCalls[0]).tools.map(({ name }) => name)).toEqual([
      "submit_completion",
    ]);
  });

  it("denies every permission and unknown tool independently without broker mutation", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    let permissionResult: unknown;
    let hookResult: unknown;
    sdk.onSend = async (config) => {
      permissionResult = await config.onPermissionRequest({ kind: "shell" });
      hookResult = await config.onPreToolUse({
        sessionId: fixture.dispatch.dispatchId,
        toolName: "shell",
        toolArgs: { command: "approve and complete" },
      });
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(permissionResult).toEqual({
      kind: "reject",
      feedback: "This session does not grant that operation.",
    });
    expect(hookResult).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "This session does not grant that operation.",
    });
    expect(result.status).toBe("missing-completion");
    expect(fixture.broker.submissions).toHaveLength(0);
    expect(fixture.broker.reads).toHaveLength(0);
  });

  it("refuses mismatched invocation session and tool identity", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    const outputs: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      const question = required(config.tools.find(({ name }) => name === "submit_question"));
      outputs.push(
        await question.handler(
          { prompt: "Wrong session" },
          { sessionId: "dispatch_other", toolCallId: "wrong-session", toolName: question.name },
        ),
      );
      outputs.push(
        await question.handler(
          { prompt: "Wrong tool" },
          { sessionId: session.sessionId, toolCallId: "wrong-tool", toolName: "shell" },
        ),
      );
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(result.status).toBe("missing-completion");
    expect(outputs.map(({ resultType }) => resultType)).toEqual(["failure", "failure"]);
    expect(fixture.broker.submissions).toHaveLength(0);
  });

  it("derives broker identities and trusted bindings for every tool", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    const toolResults: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      for (const [index, tool] of config.tools.entries()) {
        toolResults.push(
          await invoke(tool, session.sessionId, `call-${index + 1}`, toolArgs(tool.name, fixture)),
        );
      }
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(result.status).toBe("completed");
    expect(fixture.broker.reads).toHaveLength(1);
    expect(fixture.broker.submissions).toHaveLength(5);
    expect(fixture.broker.reads[0]).toMatchObject({
      requestId: derived("request", fixture.dispatch.dispatchId, "call-1", "senawa_read_asset"),
      grantToken: GRANT_TOKEN,
      assetBindingId: fixture.context.assets[0]?.assetBindingId,
    });
    fixture.broker.submissions.forEach((submission, index) => {
      expect(submission).toMatchObject({
        submissionId: derived(
          "submission",
          fixture.dispatch.dispatchId,
          `call-${index + 2}`,
          COPILOT_WORKER_TOOL_NAMES[index + 1] as string,
        ),
        repositoryId: fixture.dispatch.repositoryId,
        runId: fixture.dispatch.runId,
        dispatchId: fixture.dispatch.dispatchId,
        task: fixture.dispatch.task,
        contextId: fixture.dispatch.contextId,
        contextDigest: fixture.dispatch.contextDigest,
        principalId: fixture.dispatch.worker.principalId,
      });
    });
    expect(fixture.broker.submissions[3]).toMatchObject({
      amendment: {
        baseGraphRevisionDigest: fixture.context.graphRevisionDigest,
        baseContextDigest: fixture.context.contextDigest,
      },
    });
    expect(toolResults.every(({ resultType }) => resultType === "success")).toBe(true);
  });

  it("keeps grant tokens out of prompt, SDK config, results, errors, and captured public state", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    const surfaces: unknown[] = [];
    sdk.onSend = async (config, session, prompt) => {
      surfaces.push(prompt, config);
      const read = required(config.tools.find(({ name }) => name === "senawa_read_asset"));
      surfaces.push(
        await invoke(read, session.sessionId, "read-secret", {
          assetBindingId: fixture.context.assets[0]?.assetBindingId,
          type: "chunk",
          offset: 0,
          length: 4,
        }),
      );
    };

    const result = await fixture.adapter.run(fixture.input);
    surfaces.push(result, sdk.publicState());

    expect(JSON.stringify(surfaces)).not.toContain(GRANT_TOKEN);
    expect(result.status).toBe("missing-completion");
  });

  it("refuses ungranted bindings and malformed arguments without broker mutation", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    const outputs: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      const read = required(config.tools.find(({ name }) => name === "senawa_read_asset"));
      const completion = required(config.tools.find(({ name }) => name === "submit_completion"));
      outputs.push(
        await invoke(read, session.sessionId, "cross-binding", {
          assetBindingId: "asset-binding_ungranted",
          type: "chunk",
          offset: 0,
          length: 4,
        }),
      );
      outputs.push(
        await invoke(completion, session.sessionId, "malformed", {
          disposition: "completed",
          summary: "not enough fields",
          authority: "forged",
        }),
      );
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(result.status).toBe("missing-completion");
    expect(outputs.map(({ resultType }) => resultType)).toEqual(["failure", "failure"]);
    expect(fixture.broker.reads).toHaveLength(0);
    expect(fixture.broker.submissions).toHaveLength(0);
  });

  it.each(["timeout", "signal"] as const)("aborts and disconnects on %s", async (mode) => {
    const sdk = new FakeSdkPort();
    const controller = new AbortController();
    const fixture = harness(sdk, { timeoutMs: 20, signal: controller.signal });
    sdk.onSend = () => new Promise<void>(() => {});
    if (mode === "signal") queueMicrotask(() => controller.abort());

    const result = await fixture.adapter.run(fixture.input);
    const session = required(sdk.sessions.get(fixture.dispatch.dispatchId));

    expect(result.status).toBe("aborted");
    expect(session.abortCalls).toBe(1);
    expect(session.disconnectCalls).toBe(1);
  });

  it("refuses a captured tool invocation after an aborted run returns", async () => {
    const sdk = new FakeSdkPort();
    const controller = new AbortController();
    const fixture = harness(sdk, { signal: controller.signal });
    let captured: CopilotSdkTool | undefined;
    sdk.onSend = async (config) => {
      captured = required(config.tools.find(({ name }) => name === "submit_completion"));
      await new Promise<void>(() => {});
    };
    const active = fixture.adapter.run(fixture.input);
    await vi.waitFor(() => expect(captured).toBeDefined());
    controller.abort();

    await expect(active).resolves.toMatchObject({ status: "aborted" });
    const output = await required(captured).handler(
      { disposition: "completed", summary: "Late", criteria: [], evidence: [] },
      {
        sessionId: fixture.dispatch.dispatchId,
        toolCallId: "late-completion",
        toolName: "submit_completion",
      },
    );

    expect(output.resultType).toBe("failure");
    expect(fixture.broker.submissions).toHaveLength(0);
  });

  it("refuses tool mutation while SDK abort is still pending", async () => {
    const sdk = new FakeSdkPort();
    const controller = new AbortController();
    const fixture = harness(sdk, { signal: controller.signal });
    let captured: CopilotSdkTool | undefined;
    let releaseAbort: (() => void) | undefined;
    sdk.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    sdk.onSend = async (config) => {
      captured = required(config.tools.find(({ name }) => name === "submit_completion"));
      await new Promise<void>(() => {});
    };
    const active = fixture.adapter.run(fixture.input);
    await vi.waitFor(() => expect(captured).toBeDefined());
    controller.abort();
    await vi.waitFor(() =>
      expect(required(sdk.sessions.get(fixture.dispatch.dispatchId)).abortCalls).toBe(1),
    );

    const output = await required(captured).handler(
      { disposition: "completed", summary: "Late", criteria: [], evidence: [] },
      {
        sessionId: fixture.dispatch.dispatchId,
        toolCallId: "abort-pending-completion",
        toolName: "submit_completion",
      },
    );
    expect(output.resultType).toBe("failure");
    expect(fixture.broker.submissions).toHaveLength(0);

    releaseAbort?.();
    await expect(active).resolves.toMatchObject({ status: "aborted" });
  });

  it("retains the serial guard until an already-started handler settles", async () => {
    const sdk = new FakeSdkPort();
    const controller = new AbortController();
    const fixture = harness(sdk, { signal: controller.signal });
    let releaseRead: (() => void) | undefined;
    fixture.broker.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    sdk.onSend = async (config, session) => {
      const read = required(config.tools.find(({ name }) => name === "senawa_read_asset"));
      void invoke(read, session.sessionId, "delayed-read", {
        assetBindingId: fixture.context.assets[0]?.assetBindingId,
        type: "chunk",
        offset: 0,
        length: 4,
      });
      await new Promise<void>(() => {});
    };
    const active = fixture.adapter.run(fixture.input);
    await vi.waitFor(() => expect(fixture.broker.reads).toHaveLength(1));
    controller.abort();
    await expect(fixture.adapter.run(fixture.input)).rejects.toThrow("already running dispatch");
    releaseRead?.();
    await expect(active).resolves.toMatchObject({ status: "aborted" });
  });

  it.each([
    ["assistant only", "accepted", undefined, "missing-completion"],
    ["stale completion", "stale", "completed", "missing-completion"],
    ["duplicate completion", "duplicate", "completed", "missing-completion"],
    ["accepted blocked", "accepted", "blocked", "blocked"],
    ["accepted completed", "accepted", "completed", "completed"],
  ] as const)(
    "classifies %s from broker admission",
    async (_name, admission, disposition, expected) => {
      const sdk = new FakeSdkPort();
      const fixture = harness(sdk);
      fixture.broker.admission = admission;
      if (disposition !== undefined) sdk.onSend = complete(disposition);

      const result = await fixture.adapter.run(fixture.input);

      expect(result.status).toBe(expected);
    },
  );

  it("enforces the Senawa submission ceiling without treating it as AI credits", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { maxSubmissions: 1 });
    const outputs: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      const question = required(config.tools.find(({ name }) => name === "submit_question"));
      outputs.push(await invoke(question, session.sessionId, "one", { prompt: "First?" }));
      outputs.push(await invoke(question, session.sessionId, "two", { prompt: "Second?" }));
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(result.status).toBe("missing-completion");
    expect(fixture.broker.submissions).toHaveLength(1);
    expect(outputs.map(({ resultType }) => resultType)).toEqual(["success", "failure"]);
    expect(required(sdk.createCalls[0]).sessionLimits).toEqual({ maxAiCredits: 1.25 });
  });

  it("rejects a prompt digest mismatch before contacting the SDK", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    const mismatchedDispatch = createWorkerDispatch(
      {
        repositoryId: fixture.dispatch.repositoryId,
        runId: fixture.dispatch.runId,
        ordinal: fixture.dispatch.ordinal,
        workerPrincipalId: fixture.dispatch.worker.principalId,
        roleKey: fixture.dispatch.worker.roleKey,
        capabilities: fixture.dispatch.capabilities,
        promptPackDigest: sha256Digest("f".repeat(64)),
      },
      fixture.context,
      sha256,
    );
    const mismatchedSelection = createWorkerModelRouteSelection(
      {
        routeIndex: fixture.selection.modelPolicy.routeIndex,
        provider: fixture.selection.modelPolicy.provider,
        model: fixture.selection.modelPolicy.model,
        ...fixture.selection.limits,
      },
      fixture.context,
      mismatchedDispatch,
      sha256,
    );

    await expect(
      fixture.adapter.run({
        ...fixture.input,
        dispatch: mismatchedDispatch,
        routeSelection: mismatchedSelection,
      }),
    ).rejects.toThrow("prompt digest");
    expect(sdk.resumeCalls).toHaveLength(0);
    expect(sdk.createCalls).toHaveLength(0);
  });

  it("rejects a non-Copilot provider before contacting the SDK", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { provider: "openai" });

    await expect(fixture.adapter.run(fixture.input)).rejects.toThrow("github-copilot");
    expect(sdk.resumeCalls).toHaveLength(0);
    expect(sdk.createCalls).toHaveLength(0);
  });

  it("allows only one active dispatch", async () => {
    const sdk = new FakeSdkPort();
    const controller = new AbortController();
    const fixture = harness(sdk, { signal: controller.signal });
    sdk.onSend = () => new Promise<void>(() => {});

    const active = fixture.adapter.run(fixture.input);
    await expect(fixture.adapter.run(fixture.input)).rejects.toThrow("already running dispatch");
    controller.abort();
    await expect(active).resolves.toMatchObject({ status: "aborted" });
  });

  it("sanitizes SDK failures and still disconnects", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    sdk.onSend = () => {
      throw new Error(GRANT_TOKEN);
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(result).toMatchObject({
      status: "crashed",
      error: { code: "copilot-worker-failed" },
    });
    expect(JSON.stringify(result)).not.toContain(GRANT_TOKEN);
    expect(required(sdk.sessions.get(fixture.dispatch.dispatchId)).disconnectCalls).toBe(1);
  });
});

class FakeSdkPort implements CopilotSdkPort {
  readonly baseDirectory = "/tmp/senawa-copilot";
  readonly workingDirectory = "/tmp/senawa-copilot/work";
  readonly sessions = new Map<string, FakeSession>();
  readonly resumeCalls: { sessionId: string; config: CopilotSdkResumeSessionConfig }[] = [];
  readonly createCalls: CopilotSdkSessionConfig[] = [];
  onSend?: (
    config: CopilotSdkSessionConfig,
    session: FakeSession,
    prompt: string,
  ) => Promise<void> | void;
  abortGate?: Promise<void>;

  async resumeSession(
    sessionId: string,
    config: CopilotSdkResumeSessionConfig,
  ): Promise<CopilotSdkSessionPort | undefined> {
    this.resumeCalls.push({ sessionId, config });
    const session = this.sessions.get(sessionId);
    if (session !== undefined) session.config = config;
    return session;
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSessionPort> {
    this.createCalls.push(config);
    const sessionId = required(config.sessionId);
    const session = new FakeSession(sessionId, config, this);
    this.sessions.set(sessionId, session);
    return session;
  }

  publicState(): unknown {
    return {
      baseDirectory: this.baseDirectory,
      createCalls: this.createCalls,
      resumeCalls: this.resumeCalls,
      sessions: [...this.sessions].map(([sessionId, session]) => ({
        sessionId,
        abortCalls: session.abortCalls,
        disconnectCalls: session.disconnectCalls,
      })),
    };
  }
}

class FakeSession implements CopilotSdkSessionPort {
  abortCalls = 0;
  disconnectCalls = 0;

  constructor(
    readonly sessionId: string,
    public config: CopilotSdkSessionConfig,
    readonly sdk: FakeSdkPort,
  ) {}

  async sendAndWait(prompt: string, _timeoutMs: number): Promise<void> {
    await this.sdk.onSend?.(this.config, this, prompt);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    await this.sdk.abortGate;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
}

class CapturingBroker implements ContextBrokerClient {
  readonly reads: ReturnType<typeof decodeAssetReadRequest>[] = [];
  readonly submissions: WorkerSubmission[] = [];
  admission: SubmissionAdmissionResult["status"] = "accepted";
  readGate?: Promise<void>;
  readonly dependencies = {
    sha256,
    currentTime: () => "2026-08-13T00:00:00.000Z",
    issueGrantToken: () => Uint8Array.from({ length: 32 }, () => 7),
  };

  registerDispatch(): WorkerDispatch {
    throw new Error("Not used by adapter tests");
  }

  loadWorkerDispatch(): never {
    throw new Error("Not used by adapter tests");
  }

  loadWorkerDispatchProgress(): never {
    throw new Error("Not used by adapter tests");
  }

  grantAssetAccess(): never {
    throw new Error("Not used by adapter tests");
  }

  async readAsset(input: { readonly request: unknown }): Promise<AssetReadResult> {
    const request = decodeAssetReadRequest(input.request);
    this.reads.push(request);
    await this.readGate;
    return {
      status: "served",
      receipt: {
        apiVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        requestDigest: sha256Digest("1".repeat(64)),
        repositoryId: "repository_fixture",
        runId: "run_fixture",
        dispatchId: "dispatch_fixture",
        contextId: "context_fixture",
        assetBindingId: request.assetBindingId,
        principalId: "principal_fixture",
        status: "served",
        occurredAt: "2026-08-13T00:00:00.000Z",
        chargedOperations: 1,
        chargedBytes: 4,
        responseBytes: 4,
        remainingOperations: 1,
        remainingBytes: 4,
      },
      bytes: new TextEncoder().encode("data"),
    };
  }

  admitSubmission(input: {
    readonly submission: unknown;
    readonly currentContextDigest: string;
    readonly currentTask: Parameters<ContextBrokerClient["admitSubmission"]>[0]["currentTask"];
  }): SubmissionAdmissionResult {
    const submission = decodeWorkerSubmission(input.submission);
    this.submissions.push(submission);
    const base = {
      submissionId: submission.submissionId,
      type: submission.type,
      status: this.admission,
      replayed: false,
    } as const;
    if (submission.type !== "completion" || this.admission !== "accepted") return base;
    return {
      ...base,
      completionFact: {
        submissionId: submission.submissionId,
        repositoryId: submission.repositoryId,
        runId: submission.runId,
        dispatchId: submission.dispatchId,
        assessment: assessCompletionAccounting(
          {
            task: input.currentTask,
            criteria: [],
            evidencePolicy: { mode: "none", requirements: [] },
          },
          {
            ...submission.completion,
            task: input.currentTask,
          } as unknown as CompletionSubmission,
        ),
      },
    };
  }

  deliverCompletionFact(): boolean {
    return true;
  }
}

function harness(
  sdk: FakeSdkPort,
  options: {
    readonly graph?: string;
    readonly ordinal?: number;
    readonly capabilities?: readonly string[];
    readonly grantTokens?: ReadonlyMap<string, string>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly maxSubmissions?: number;
    readonly provider?: string;
  } = {},
) {
  const capabilities = options.capabilities ?? ALL_CAPABILITIES;
  const task = { taskId: taskId("task_worker"), definitionGeneration: definitionGeneration(1) };
  const context = createWorkerContextBase(
    {
      task,
      graphRevisionDigest: sha256Digest((options.graph ?? "1").repeat(64)),
      configurationSnapshotDigest: sha256Digest("2".repeat(64)),
      contracts: [],
      dependencyBarrier: { task, dependencies: [] },
      assets: [
        {
          semanticAssetId: assetId("asset_source"),
          aliasBindingDigest: sha256Digest("3".repeat(64)),
          contentDigest: sha256Digest("4".repeat(64)),
          mediaType: "text/plain",
          sensitivity: "internal",
          byteLength: 4,
        },
      ],
      repositoryBase: {
        commitDigest: sha256Digest("5".repeat(64)),
        treeDigest: sha256Digest("6".repeat(64)),
      },
      modelPolicy: {
        key: consumerKey("worker-policy"),
        policyDigest: sha256Digest("7".repeat(64)),
        orderedRoutesDigest: sha256Digest("8".repeat(64)),
      },
      role: { key: consumerKey("implementer"), roleDigest: sha256Digest("9".repeat(64)) },
      capabilities,
      budgets: [{ unit: "work-attempt", limit: 4 }],
    },
    sha256,
  );
  const dispatchInput = {
    repositoryId: "repository_fixture",
    runId: runId("run_fixture"),
    ordinal: options.ordinal ?? 1,
    workerPrincipalId: "principal_worker",
    roleKey: consumerKey("implementer"),
    capabilities,
    promptPackDigest: sha256Digest("0".repeat(64)),
  };
  const provisional = createWorkerDispatch(dispatchInput, context, sha256);
  const prompt = renderPromptPack(context, provisional, sha256, 65_536);
  const dispatch = createWorkerDispatch(
    { ...dispatchInput, promptPackDigest: prompt.digest },
    context,
    sha256,
  );
  const selection = createWorkerModelRouteSelection(
    {
      routeIndex: 0,
      provider: options.provider ?? "github-copilot",
      model: "gpt-5-mini",
      maxTurns: 4,
      maxSubmissions: options.maxSubmissions ?? 8,
      maxMillidollars: 2_000,
      maxAiCredits: 1.25,
    },
    context,
    dispatch,
    sha256,
  );
  const broker = new CapturingBroker();
  const grantTokens =
    options.grantTokens ?? new Map([[required(context.assets[0]).assetBindingId, GRANT_TOKEN]]);
  const input = {
    context,
    dispatch,
    routeSelection: selection,
    broker,
    grantTokens,
    workingDirectory: "/tmp/senawa-copilot/work",
    sessionBaseDirectory: sdk.baseDirectory,
    timeoutMs: options.timeoutMs ?? 1_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    currentContextDigest: () => context.contextDigest,
    currentTask: () => dispatch.task,
  };
  return {
    adapter: new CopilotSerialWorkerAdapter(sdk, sha256),
    broker,
    context,
    dispatch,
    selection,
    input,
  };
}

function complete(disposition: "completed" | "blocked") {
  return async (config: CopilotSdkSessionConfig, session: FakeSession): Promise<void> => {
    const tool = required(config.tools.find(({ name }) => name === "submit_completion"));
    await invoke(tool, session.sessionId, `completion-${disposition}`, {
      disposition,
      summary: disposition === "blocked" ? "Blocked" : "Completed",
      criteria: [],
      evidence: [],
    });
  };
}

function toolArgs(name: string, fixture: ReturnType<typeof harness>): unknown {
  switch (name) {
    case "senawa_read_asset":
      return {
        assetBindingId: fixture.context.assets[0]?.assetBindingId,
        type: "chunk",
        offset: 0,
        length: 4,
      };
    case "submit_question":
      return { prompt: "Question?", details: "Details" };
    case "propose_asset":
      return {
        assetId: "asset_proposed",
        contentDigest: "a".repeat(64),
        byteLength: 12,
        mediaType: "text/plain",
        sensitivity: "internal",
        summary: "Proposed asset",
      };
    case "record_discovery":
      return { summary: "Discovery", details: "Details" };
    case "propose_amendment":
      return { summary: "Amendment", operations: "Add one task" };
    case "submit_completion":
      return { disposition: "completed", summary: "Completed", criteria: [], evidence: [] };
    default:
      throw new Error(`Unknown fixture tool ${name}`);
  }
}

function invoke(
  tool: CopilotSdkTool,
  sessionId: string,
  toolCallId: string,
  args: unknown,
): Promise<CopilotSdkToolResult> {
  return tool.handler(args, { sessionId, toolCallId, toolName: tool.name });
}

function derived(
  prefix: "request" | "submission",
  dispatchId: string,
  toolCallId: string,
  toolName: string,
): string {
  return `${prefix}_${sha256.digest(new TextEncoder().encode(`${dispatchId}\0${toolCallId}\0${toolName}`))}`;
}

function expectClosedObjectSchemas(schema: Readonly<Record<string, unknown>>): void {
  if (schema.type === "object") expect(schema.additionalProperties).toBe(false);
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== null && typeof entry === "object") {
          expectClosedObjectSchemas(entry as Readonly<Record<string, unknown>>);
        }
      }
    } else if (value !== null && typeof value === "object") {
      expectClosedObjectSchemas(value as Readonly<Record<string, unknown>>);
    }
  }
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}
