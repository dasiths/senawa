import { createHash } from "node:crypto";
import {
  assessCompletionAccounting,
  assetId,
  type CompletionSubmission,
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createAgentSessionResumeBinding,
  createPhaseAttempt,
  createPhaseInputBinding,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  definitionGeneration,
  phaseId,
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
  type AgentTranscriptLine,
  type AgentTranscriptOwner,
  type AgentTranscriptPort,
  AgentTranscriptRefusalError,
  type AssetReadResult,
  type ContextBrokerClient,
  evaluatePhaseOutputAttempt,
  type InstalledCanonicalOutputAsset,
  type PhaseOutputAttemptInput,
  type PhaseOutputAttemptResult,
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
import {
  COPILOT_WORKER_TOOL_NAMES,
  COPILOT_WORKSPACE_TOOL_NAMES,
  CopilotSerialWorkerAdapter,
} from "./copilot-worker.js";
import type {
  WorkspaceFileEntry,
  WorkspaceFilePatchChange,
  WorkspaceFilePort,
} from "./workspace-files.js";

const sha256: Sha256 = {
  digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
};
const GRANT_TOKEN = "A".repeat(43);
const ALL_CAPABILITIES = Object.freeze(Object.values(WORKER_CAPABILITIES));
// Completion carries its outputs, so the base harness still offers every tool.
const GRANTED_WORKER_TOOL_NAMES = COPILOT_WORKER_TOOL_NAMES;
const OUTPUT_SCHEMA = canonicalValue({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://senawa.test/worker/verification-output",
  type: "object",
  additionalProperties: false,
  required: ["verified", "summary"],
  properties: {
    verified: { type: "boolean" },
    summary: { type: "string", minLength: 1, maxLength: 200 },
  },
});
const OUTPUT_CONTRACT = Object.freeze({
  key: "verification-output",
  schemaResourceDigest: sha256Digest("c".repeat(64)),
  validatorProfileDigest: sha256Digest("d".repeat(64)),
  schema: OUTPUT_SCHEMA,
  externalSchemas: [],
});
const OUTPUT_DECLARATION = Object.freeze({
  outputName: consumerKey("verification"),
  schemaKey: consumerKey("verification-output"),
  schemaResourceDigest: OUTPUT_CONTRACT.schemaResourceDigest,
  maxBytes: 4_096,
  sensitivity: "internal" as const,
});

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

  it("resumes only an exact authority binding and creates a new session on mismatch", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk);
    sdk.onSend = complete("completed");
    await fixture.adapter.run(fixture.input);
    const authorized = resumeBinding(fixture);

    await fixture.adapter.run({
      ...fixture.input,
      sessionResume: { requestedBinding: authorized, authorizedBinding: authorized },
    });
    const resumeCount = sdk.resumeCalls.length;
    const mismatched = createAgentSessionResumeBinding(
      { ...resumeBindingInput(fixture), repositoryTreeDigest: sha256Digest("f".repeat(64)) },
      sha256,
    );
    await fixture.adapter.run({
      ...fixture.input,
      sessionResume: { requestedBinding: mismatched, authorizedBinding: authorized },
    });

    expect(sdk.resumeCalls).toHaveLength(resumeCount);
    expect(required(sdk.createCalls.at(-1)).sessionId).toBe(fixture.dispatch.dispatchId);
  });

  it("exposes only six capability and grant filtered tools with closed schemas", async () => {
    const sdk = new FakeSdkPort();
    const all = harness(sdk);
    await all.adapter.run(all.input);
    const config = required(sdk.createCalls[0]);

    expect(config.tools.map(({ name }) => name)).toEqual(GRANTED_WORKER_TOOL_NAMES);
    expect(config.availableTools).toEqual(GRANTED_WORKER_TOOL_NAMES);
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
      "senawa_complete",
    ]);
  });

  it("adds only four dispatch-bound workspace tools while retaining empty SDK mode", async () => {
    const sdk = new FakeSdkPort();
    const workspaceFiles = new FakeWorkspaceFiles(sdk.workingDirectory);
    const fixture = harness(sdk, { workspaceFiles });
    const outputs: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      const tools = new Map(config.tools.map((candidate) => [candidate.name, candidate]));
      outputs.push(
        await invoke(required(tools.get("senawa_list_workspace")), session.sessionId, "list", {
          path: ".",
          maxEntries: 10,
        }),
        await invoke(required(tools.get("senawa_read_workspace_file")), session.sessionId, "read", {
          path: "src/a.txt",
          maxBytes: 64,
        }),
        await invoke(
          required(tools.get("senawa_write_workspace_file")),
          session.sessionId,
          "write",
          {
            path: "src/a.txt",
            content: "written\n",
          },
        ),
        await invoke(
          required(tools.get("senawa_apply_workspace_patch")),
          session.sessionId,
          "patch",
          {
            changes: [
              {
                path: "src/a.txt",
                expectedText: "written\n",
                replacementText: "patched\n",
              },
            ],
          },
        ),
      );
      expect(config.availableTools).toEqual([
        ...COPILOT_WORKSPACE_TOOL_NAMES,
        ...GRANTED_WORKER_TOOL_NAMES,
      ]);
      expect(config).toMatchObject({
        excludedTools: ["builtin:*", "mcp:*"],
        enableHostGitOperations: false,
        additionalDirectories: [],
        mcpServers: {},
      });
      for (const configuredTool of config.tools) {
        expectClosedObjectSchemas(configuredTool.parameters);
      }
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(result.status).toBe("missing-completion");
    expect(outputs.every(({ resultType }) => resultType === "success")).toBe(true);
    expect(workspaceFiles.calls.map(({ operation }) => operation)).toEqual([
      "list",
      "read",
      "write",
      "patch",
    ]);
  });

  it("refuses a workspace file port that is not bound to the dispatch root", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { workspaceFiles: new FakeWorkspaceFiles("/tmp/other-root") });

    await expect(fixture.adapter.run(fixture.input)).rejects.toThrow(
      "exact dispatch working directory",
    );
    expect(sdk.createCalls).toHaveLength(0);
  });

  it("records only dispatch-scoped session and tool lifecycle lines in the transcript", async () => {
    const sdk = new FakeSdkPort();
    const transcript = new RecordingTranscript();
    const fixture = harness(sdk, { transcript });
    const hostileSummary = `<script>alert(1)</script> ${GRANT_TOKEN} /etc/shadow`;
    sdk.onSend = async (config, session) => {
      const tools = new Map(config.tools.map((candidate) => [candidate.name, candidate]));
      await invoke(required(tools.get("propose_asset")), session.sessionId, "hostile", {
        assetId: "asset_hostile",
        contentDigest: "a".repeat(64),
        byteLength: 12,
        mediaType: "text/plain",
        sensitivity: "internal",
        summary: hostileSummary,
        grantToken: GRANT_TOKEN,
      });
      await invoke(required(tools.get("record_discovery")), "session_other", "stolen", {
        summary: "Discovery",
        details: "Details",
      });
      await complete("completed")(config, session);
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(result.status).toBe("completed");
    expect(transcript.lines.map(({ text }) => text)).toEqual([
      "session started",
      "tool propose_asset failure",
      "tool record_discovery refused",
      "tool senawa_complete success",
      "session ended completed",
    ]);
    for (const line of transcript.lines) {
      expect(line).toMatchObject({
        repositoryId: fixture.dispatch.repositoryId,
        runId: fixture.dispatch.runId,
        owner: { kind: "dispatch", id: fixture.dispatch.dispatchId },
        occurredAt: "2026-08-13T00:00:00.000Z",
        stream: "system",
      });
      // One record is exactly one row, and its identity makes a replay recognisable.
      expect(line.text).not.toMatch(/[\n\r\u0085\u2028\u2029]/u);
      expect(line.lineId).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(new Set(transcript.lines.map(({ lineId }) => lineId)).size).toBe(
      transcript.lines.length,
    );
    const captured = JSON.stringify(transcript.lines);
    for (const forbidden of [
      hostileSummary,
      GRANT_TOKEN,
      "asset_hostile",
      "alert(1)",
      "/etc/shadow",
      fixture.context.prompt.contentDigest,
      "Completed",
    ]) {
      expect(captured).not.toContain(forbidden);
    }
  });

  it("continues a re-driven dispatch without reusing a retained capture identity", async () => {
    const transcript = new RecordingTranscript();
    const firstSdk = new FakeSdkPort();
    firstSdk.onSend = complete("completed");
    const first = harness(firstSdk, { transcript });
    expect((await first.adapter.run(first.input)).status).toBe("completed");
    expect(transcript.lines).toHaveLength(3);

    // A host restart re-drives the same dispatch under a new wall clock. Nothing
    // seeds the capture from a durable read, so no read failure can strand it on
    // the identities the owner already retains, and every line still lands.
    const secondSdk = new FakeSdkPort();
    secondSdk.onSend = complete("completed");
    const second = harness(secondSdk, { transcript });
    expect(second.dispatch.dispatchId).toBe(first.dispatch.dispatchId);
    second.broker.currentTime = "2026-08-13T01:00:00.000Z";
    const redriven = await second.adapter.run(second.input);

    expect(redriven.status).toBe("completed");
    expect(redriven.transcriptRefusals).toBeUndefined();
    expect(transcript.lines).toHaveLength(6);
    expect(new Set(transcript.lines.map(({ lineId }) => lineId)).size).toBe(6);
    expect(transcript.lines.map(({ occurredAt }) => occurredAt)).toEqual([
      ...Array.from({ length: 3 }, () => "2026-08-13T00:00:00.000Z"),
      ...Array.from({ length: 3 }, () => "2026-08-13T01:00:00.000Z"),
    ]);
  });

  it("keeps an exact replay of one dispatch idempotent", async () => {
    const transcript = new RecordingTranscript();
    const firstSdk = new FakeSdkPort();
    firstSdk.onSend = complete("completed");
    const first = harness(firstSdk, { transcript });
    expect((await first.adapter.run(first.input)).status).toBe("completed");
    const retained = transcript.lines.map(({ lineId }) => lineId);

    // An exact replay reproduces every record, so the durable store recognises
    // each identity and neither duplicates a row nor refuses the capture.
    const replaySdk = new FakeSdkPort();
    replaySdk.onSend = complete("completed");
    const replay = harness(replaySdk, { transcript });
    const replayed = await replay.adapter.run(replay.input);

    expect(replayed.transcriptRefusals).toBeUndefined();
    expect(transcript.lines.map(({ lineId }) => lineId)).toEqual(retained);
  });

  it("reports refused transcript capture through the run result", async () => {
    const failing = new RecordingTranscript(true);
    const sdk = new FakeSdkPort();
    sdk.onSend = complete("completed");
    const fixture = harness(sdk, { transcript: failing });

    const result = await fixture.adapter.run(fixture.input);

    expect(result.status).toBe("completed");
    // One refusal for every line capture attempted, and nothing else to fail.
    expect(result.transcriptRefusals).toBe(3);
    expect(failing.lines).toHaveLength(0);
  });

  it("reports the exact ending status and survives a failing transcript sink", async () => {
    const failing = new RecordingTranscript(true);
    const blockingSdk = new FakeSdkPort();
    blockingSdk.onSend = complete("blocked");
    const blocked = harness(blockingSdk, { transcript: failing });
    expect((await blocked.adapter.run(blocked.input)).status).toBe("blocked");
    expect(failing.lines).toHaveLength(0);

    const transcript = new RecordingTranscript();
    const abortSdk = new FakeSdkPort();
    const controller = new AbortController();
    abortSdk.onSend = async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const aborted = harness(abortSdk, { transcript, signal: controller.signal });
    expect((await aborted.adapter.run(aborted.input)).status).toBe("aborted");
    expect(transcript.lines.map(({ text }) => text)).toEqual([
      "session started",
      "session ended aborted",
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
      const completion = required(config.tools.find(({ name }) => name === "senawa_complete"));
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
      captured = required(config.tools.find(({ name }) => name === "senawa_complete"));
      await new Promise<void>(() => {});
    };
    const active = fixture.adapter.run(fixture.input);
    await vi.waitFor(() => expect(captured).toBeDefined());
    controller.abort();

    await expect(active).resolves.toMatchObject({ status: "aborted" });
    const output = await required(captured).handler(
      { disposition: "completed", summary: "Late", criteria: [], completionEvidence: [] },
      {
        sessionId: fixture.dispatch.dispatchId,
        toolCallId: "late-completion",
        toolName: "senawa_complete",
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
      captured = required(config.tools.find(({ name }) => name === "senawa_complete"));
      await new Promise<void>(() => {});
    };
    const active = fixture.adapter.run(fixture.input);
    await vi.waitFor(() => expect(captured).toBeDefined());
    controller.abort();
    await vi.waitFor(() =>
      expect(required(sdk.sessions.get(fixture.dispatch.dispatchId)).abortCalls).toBe(1),
    );

    const output = await required(captured).handler(
      { disposition: "completed", summary: "Late", criteria: [], completionEvidence: [] },
      {
        sessionId: fixture.dispatch.dispatchId,
        toolCallId: "abort-pending-completion",
        toolName: "senawa_complete",
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
        promptResource: fixture.dispatch.promptResource,
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

  it("accepts a corrected phase output after bounded structured rejections", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { phaseOutput: true });
    const outputs: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      const tool = required(config.tools.find((candidate) => candidate.name === "senawa_complete"));
      expectClosedObjectSchemas(tool.parameters as Readonly<Record<string, unknown>>);
      outputs.push(
        await invoke(tool, session.sessionId, "call_invalid", {
          disposition: "completed",
          summary: "Completed",
          criteria: [],
          completionEvidence: [],
          outputs: { verification: { verified: "yes" } },
        }),
        await invoke(tool, session.sessionId, "call_extra", {
          disposition: "completed",
          summary: "Completed",
          criteria: [],
          completionEvidence: [],
          outputs: { verification: { verified: true, summary: "ok", extra: 1 } },
        }),
        await invoke(tool, session.sessionId, "call_valid", {
          disposition: "completed",
          summary: "Completed",
          criteria: [],
          completionEvidence: [],
          outputs: { verification: { verified: true, summary: "Both generated tasks completed" } },
          changeNotes: ["edited alpha.txt"],
        }),
      );
    };

    const result = await fixture.adapter.run(fixture.input);

    // The corrected call carries the output and the completion together.
    expect(result.status).toBe("completed");
    expect(outputs.map(({ resultType }) => resultType)).toEqual(["failure", "failure", "success"]);
    const firstFailure = JSON.parse(required(outputs[0]).textResultForLlm) as {
      readonly code: string;
      readonly findings: readonly { readonly instancePointer: string }[];
    };
    expect(firstFailure.code).toBe("output-schema-invalid");
    expect(
      firstFailure.findings.some(({ instancePointer }) => instancePointer === "/verified"),
    ).toBe(true);
    expect(required(outputs[0]).textResultForLlm).not.toContain("json-schema.org");
    expect(fixture.broker.outputAttempts.map(({ outcome }) => outcome)).toEqual([
      "rejected",
      "rejected",
      "accepted",
    ]);
    expect(fixture.broker.installedOutputs).toHaveLength(1);
    const submission = required(
      fixture.broker.submissions.find(({ type }) => type === "phase-output"),
    );
    if (submission.type !== "phase-output") throw new Error("Expected a phase output submission");
    expect(submission.output).toMatchObject({
      outputName: "verification",
      schemaKey: "verification-output",
      mediaType: "application/json",
      sensitivity: "internal",
    });
    expect(submission.output.validationReceiptDigest).toBe(
      required(fixture.broker.installedOutputs[0]).validationReceiptDigest,
    );
    expect(JSON.stringify(fixture.broker.outputAttempts)).not.toContain("summary");
  });

  it("refuses phase output beyond its finite attempt budget", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { phaseOutput: true });
    const outputs: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      const tool = required(config.tools.find((candidate) => candidate.name === "senawa_complete"));
      for (const attempt of ["one", "two", "three", "four"]) {
        outputs.push(
          await invoke(tool, session.sessionId, `call_${attempt}`, {
            disposition: "completed",
            summary: "Completed",
            criteria: [],
            completionEvidence: [],
            outputs: { verification: { verified: "no" } },
          }),
        );
      }
      outputs.push(
        await invoke(tool, session.sessionId, "call_valid", {
          disposition: "completed",
          summary: "Completed",
          criteria: [],
          completionEvidence: [],
          outputs: { verification: { verified: true, summary: "late" } },
        }),
      );
    };

    await fixture.adapter.run(fixture.input);

    expect(outputs.every(({ resultType }) => resultType === "failure")).toBe(true);
    expect(
      outputs.map(({ textResultForLlm }) => JSON.parse(textResultForLlm).code as string),
    ).toEqual([
      "output-schema-invalid",
      "output-schema-invalid",
      "output-schema-invalid",
      "output-attempt-budget-exhausted",
      "output-attempt-budget-exhausted",
    ]);
    expect(fixture.broker.outputAttempts).toHaveLength(3);
    expect(fixture.broker.installedOutputs).toHaveLength(0);
    expect(fixture.broker.submissions).toHaveLength(0);
  });

  it("publishes nothing when a completion carries an invalid output", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { phaseOutput: true });
    let refusal: CopilotSdkToolResult | undefined;
    sdk.onSend = async (config, session) => {
      const tool = required(config.tools.find(({ name }) => name === "senawa_complete"));
      refusal = await invoke(tool, session.sessionId, "call_partial", {
        disposition: "completed",
        summary: "Completed",
        criteria: [],
        completionEvidence: [],
        outputs: { verification: { verified: "not a boolean" } },
      });
    };

    const result = await fixture.adapter.run(fixture.input);

    expect(required(refusal).resultType).toBe("failure");
    expect(JSON.parse(required(refusal).textResultForLlm).code).toBe("output-schema-invalid");
    // Neither half of the request may survive a refusal.
    expect(fixture.broker.installedOutputs).toHaveLength(0);
    expect(fixture.broker.submissions).toHaveLength(0);
    expect(result.status).toBe("missing-completion");
  });

  it("refuses phase output larger than its declared ceiling", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { phaseOutput: true });
    const outputs: CopilotSdkToolResult[] = [];
    sdk.onSend = async (config, session) => {
      const tool = required(config.tools.find((candidate) => candidate.name === "senawa_complete"));
      outputs.push(
        await invoke(tool, session.sessionId, "call_large", {
          disposition: "completed",
          summary: "Completed",
          criteria: [],
          completionEvidence: [],
          outputs: { verification: { verified: true, summary: "x".repeat(8_000) } },
        }),
        await invoke(tool, session.sessionId, "call_unknown_key", {
          disposition: "completed",
          summary: "Completed",
          criteria: [],
          completionEvidence: [],
          outputs: { verification: { verified: true, summary: "ok" } },
          unexpected: true,
        }),
      );
    };

    await fixture.adapter.run(fixture.input);

    expect(
      outputs.map(({ textResultForLlm }) => JSON.parse(textResultForLlm).code as string),
    ).toEqual(["output-too-large", "completion-arguments-invalid"]);
    expect(fixture.broker.installedOutputs).toHaveLength(0);
  });

  it("keeps the generated output tool schema closed and identity free", async () => {
    const sdk = new FakeSdkPort();
    const fixture = harness(sdk, { phaseOutput: true });

    await fixture.adapter.run(fixture.input);

    const tool = required(
      required(sdk.createCalls[0]).tools.find(({ name }) => name === "senawa_complete"),
    );
    expectClosedObjectSchemas(tool.parameters);
    const parameters = JSON.stringify(tool.parameters);
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
      expect(parameters).not.toContain(forbidden);
    }
    const properties = required(tool.parameters.properties) as Readonly<Record<string, unknown>>;
    const outputs = required(properties.outputs) as Readonly<Record<string, unknown>>;
    const nested = required(outputs.properties) as Readonly<Record<string, unknown>>;
    const output = required(nested.verification) as Readonly<Record<string, unknown>>;
    expect(Object.hasOwn(output, "$schema")).toBe(false);
    expect(Object.hasOwn(output, "$id")).toBe(false);
    expect(output).toMatchObject({ type: "object", additionalProperties: false });
    expect(tool.skipPermission).toBe(true);
    expect(tool.defer).toBe("never");
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
  /** A host restart brings a new wall clock, which is what makes a re-drive collide. */
  currentTime = "2026-08-13T00:00:00.000Z";
  readonly dependencies = {
    sha256,
    currentTime: () => this.currentTime,
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

  admitSubmission(input: { readonly submission: unknown }): SubmissionAdmissionResult {
    const submission = decodeWorkerSubmission(input.submission);
    this.submissions.push(submission);
    const base = {
      submissionId: submission.submissionId,
      type: submission.type,
      status: this.admission,
      replayed: false,
    } as const;
    if (submission.type !== "completion" || this.admission !== "accepted") return base;
    const task = submission.completion.task as unknown as CompletionSubmission["task"];
    return {
      ...base,
      completionFact: {
        submissionId: submission.submissionId,
        repositoryId: submission.repositoryId,
        runId: submission.runId,
        dispatchId: submission.dispatchId,
        assessment: assessCompletionAccounting(
          {
            task,
            criteria: [],
            completionEvidencePolicy: { mode: "none", requirements: [] },
          },
          {
            ...submission.completion,
            task,
          } as unknown as CompletionSubmission,
        ),
      },
    };
  }

  deliverCompletionFact(): boolean {
    return true;
  }

  readonly installedOutputs: InstalledCanonicalOutputAsset[] = [];
  readonly outputAttempts: PhaseOutputAttemptInput[] = [];

  installCanonicalOutputAsset(asset: InstalledCanonicalOutputAsset, bytes: Uint8Array): void {
    if (bytes.byteLength !== asset.byteLength) throw new TypeError("Inexact output bytes");
    this.installedOutputs.push(asset);
  }

  recordPhaseOutputAttempt(input: PhaseOutputAttemptInput): PhaseOutputAttemptResult {
    const { result, insert } = evaluatePhaseOutputAttempt(this.outputAttempts, input);
    if (insert) this.outputAttempts.push(input);
    return result;
  }

  countRejectedPhaseOutputAttempts(dispatchId: string, outputName: string): number {
    return this.outputAttempts.filter(
      (attempt) =>
        attempt.outcome === "rejected" &&
        attempt.dispatchId === dispatchId &&
        attempt.outputName === outputName,
    ).length;
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
    readonly workspaceFiles?: WorkspaceFilePort;
    readonly phaseOutput?: boolean;
    readonly transcript?: AgentTranscriptPort;
  } = {},
) {
  const capabilities = options.capabilities ?? ALL_CAPABILITIES;
  const task = { taskId: taskId("task_worker"), definitionGeneration: definitionGeneration(1) };
  const graphRevisionDigest = sha256Digest((options.graph ?? "1").repeat(64));
  const configurationSnapshotDigest = sha256Digest("2".repeat(64));
  const mappedInput = workerMappedInput();
  const phase = {
    phaseId: phaseId("phase_worker"),
    definitionGeneration: definitionGeneration(1),
    attempt: options.ordinal ?? 1,
  };
  const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: [] }), sha256);
  const phaseInputBinding = createPhaseInputBinding(
    {
      phase,
      schemaKey: consumerKey("worker-input"),
      schemaResourceDigest: sha256Digest("a".repeat(64)),
      mappings: [],
      contentDigest: mappedInput.valueDigest,
      byteLength: 2,
      validationReceiptDigest: sha256Digest("b".repeat(64)),
      sourceSetDigest,
    },
    sha256,
  );
  const phaseAttempt = createPhaseAttempt(
    {
      repositoryId: "repository_fixture",
      runId: runId("run_fixture"),
      phase,
      inputBindingDigest: phaseInputBinding.bindingDigest,
      sourceSetDigest,
      executorDigest: sha256Digest("c".repeat(64)),
      graphRevisionDigest,
      configurationSnapshotDigest,
      upstreamClosureSetDigest: sha256Digest("d".repeat(64)),
      upstreamOutputSetDigest: sha256Digest("e".repeat(64)),
    },
    sha256,
  );
  const context = createWorkerContextBase(
    {
      task,
      graphRevisionDigest,
      configurationSnapshotDigest,
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
      prompt: workerPrompt(),
      mappedInput,
      phaseAttempt,
      phaseInputBinding,
      phaseOutputDeclarations: options.phaseOutput === true ? [OUTPUT_DECLARATION] : [],
      completionPolicy: {
        criteria: [],
        completionEvidencePolicy: { mode: "none", requirements: [] },
      },
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
    promptResource: workerPromptReference(),
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
    ...(options.workspaceFiles === undefined ? {} : { workspaceFiles: options.workspaceFiles }),
    ...(options.phaseOutput === true
      ? { phaseOutputSchemas: new Map([["verification", OUTPUT_CONTRACT]]) }
      : {}),
    ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
    sessionBaseDirectory: sdk.baseDirectory,
    timeoutMs: options.timeoutMs ?? 1_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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

function resumeBinding(fixture: ReturnType<typeof harness>) {
  return createAgentSessionResumeBinding(resumeBindingInput(fixture), sha256);
}

function resumeBindingInput(fixture: ReturnType<typeof harness>) {
  return {
    predecessorDispatchId: fixture.dispatch.dispatchId,
    predecessorSessionId: fixture.dispatch.dispatchId,
    promptResourceDigest: fixture.context.prompt.resourceDigest,
    promptContentDigest: fixture.context.prompt.contentDigest,
    promptPackDigest: fixture.dispatch.promptPackDigest,
    mappedInputDigest: fixture.context.mappedInput.valueDigest,
    contextId: fixture.context.contextId,
    contextDigest: fixture.context.contextDigest,
    graphRevisionDigest: fixture.context.graphRevisionDigest,
    configurationSnapshotDigest: fixture.context.configurationSnapshotDigest,
    taskId: fixture.context.task.taskId,
    taskGeneration: fixture.context.task.definitionGeneration,
    modelSelectionDigest: fixture.selection.selectionDigest,
    repositoryCommitDigest: fixture.context.repositoryBase.commitDigest,
    repositoryTreeDigest: fixture.context.repositoryBase.treeDigest,
  };
}

function workerPrompt() {
  const key = consumerKey("implementer-prompt");
  const path = "prompts/implementer.md";
  const utf8 = "Complete the assigned work.\n";
  const bytes = new TextEncoder().encode(utf8);
  const contentDigest = sha256Digest(sha256.digest(bytes));
  const inputPaths: readonly string[] = [];
  const source = {
    path,
    mediaType: "text/markdown; charset=utf-8",
    byteLength: bytes.byteLength,
    contentDigest,
    utf8,
  };
  return {
    key,
    path,
    resourceDigest: canonicalDigest(canonicalValue({ key, source, inputPaths }), sha256),
    contentDigest,
    byteLength: bytes.byteLength,
    utf8,
    inputPaths,
  };
}

function workerPromptReference() {
  const prompt = workerPrompt();
  return {
    key: prompt.key,
    resourceDigest: prompt.resourceDigest,
    contentDigest: prompt.contentDigest,
  };
}

function workerMappedInput() {
  const value = canonicalValue({});
  return { value, valueDigest: canonicalDigest(value, sha256) };
}

function complete(disposition: "completed" | "blocked") {
  return async (config: CopilotSdkSessionConfig, session: FakeSession): Promise<void> => {
    const tool = required(config.tools.find(({ name }) => name === "senawa_complete"));
    await invoke(tool, session.sessionId, `completion-${disposition}`, {
      disposition,
      summary: disposition === "blocked" ? "Blocked" : "Completed",
      criteria: [],
      completionEvidence: [],
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
    case "senawa_complete":
      return {
        disposition: "completed",
        summary: "Completed",
        criteria: [],
        completionEvidence: [],
      };
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

class RecordingTranscript implements AgentTranscriptPort {
  readonly lines: AgentTranscriptLine[] = [];

  constructor(private readonly failing = false) {}

  /** Mirrors the durable rule: an exact replay is idempotent, a conflict is refused. */
  append(record: AgentTranscriptLine): void {
    if (this.failing)
      throw new AgentTranscriptRefusalError("unknown-run", "Transcript sink is unavailable");
    const retained = this.lines.find(
      (line) => sameOwner(line.owner, record.owner) && line.lineId === record.lineId,
    );
    if (retained === undefined) {
      this.lines.push(record);
      return;
    }
    if (
      retained.occurredAt !== record.occurredAt ||
      retained.stream !== record.stream ||
      retained.text !== record.text
    ) {
      throw new AgentTranscriptRefusalError(
        "line-conflict",
        "Agent transcript line conflicts with prior content",
      );
    }
  }
}

function sameOwner(left: AgentTranscriptOwner, right: AgentTranscriptOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

class FakeWorkspaceFiles implements WorkspaceFilePort {
  readonly calls: { readonly operation: "list" | "read" | "write" | "patch" }[] = [];

  constructor(readonly root: string) {}

  async list(_path: string, _maxEntries?: number): Promise<readonly WorkspaceFileEntry[]> {
    this.calls.push({ operation: "list" });
    return [{ path: "src/a.txt", type: "file", size: 7 }];
  }

  async read(_path: string, _maxBytes?: number): Promise<string> {
    this.calls.push({ operation: "read" });
    return "before\n";
  }

  async write(_path: string, _content: string): Promise<void> {
    this.calls.push({ operation: "write" });
  }

  async applyPatch(_changes: readonly WorkspaceFilePatchChange[]): Promise<void> {
    this.calls.push({ operation: "patch" });
  }
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
