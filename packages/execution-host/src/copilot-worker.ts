import {
  type CompletionSubmission,
  type Sha256,
  type TaskGenerationReference,
  validateWorkerContextBase,
  validateWorkerDispatch,
  validateWorkerModelRouteSelection,
  type WorkerContextBase,
  type WorkerDispatch,
  type WorkerModelRouteSelection,
} from "@senawa/kernel";
import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  WORKER_PROTOCOL_LIMITS,
  type WorkerSubmission,
} from "@senawa/protocol";
import {
  type ContextBrokerClient,
  renderPromptPack,
  type SubmissionAdmissionResult,
  WORKER_CAPABILITIES,
} from "@senawa/runtime";
import type {
  CopilotSdkPort,
  CopilotSdkPreToolUseResult,
  CopilotSdkSessionConfig,
  CopilotSdkSessionPort,
  CopilotSdkTool,
  CopilotSdkToolInvocation,
  CopilotSdkToolResult,
} from "./copilot-sdk-port.js";

export const COPILOT_WORKER_TOOL_NAMES = Object.freeze([
  "senawa_read_asset",
  "submit_question",
  "propose_asset",
  "record_discovery",
  "propose_amendment",
  "submit_completion",
] as const);

const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const PROMPT_MAX_BYTES = 65_536;
const GENERIC_PERMISSION_FEEDBACK = "This session does not grant that operation.";
const TOOL_NAMES = new Set<string>(COPILOT_WORKER_TOOL_NAMES);

export interface CopilotWorkerRunInput {
  readonly context: unknown;
  readonly dispatch: unknown;
  readonly routeSelection: unknown;
  readonly broker: ContextBrokerClient;
  readonly grantTokens: ReadonlyMap<string, string>;
  readonly workingDirectory: string;
  readonly sessionBaseDirectory?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  currentContextDigest(): string;
  currentTask(): TaskGenerationReference;
}

export type CopilotWorkerRunResult =
  | {
      readonly status: "completed" | "blocked" | "missing-completion" | "aborted";
      readonly dispatchId: string;
      readonly submissions: readonly SubmissionAdmissionResult[];
    }
  | {
      readonly status: "crashed";
      readonly dispatchId: string;
      readonly submissions: readonly SubmissionAdmissionResult[];
      readonly error: Readonly<{ readonly code: "copilot-worker-failed" }>;
    };

export class CopilotSerialWorkerAdapter {
  readonly sdk: CopilotSdkPort;
  readonly sha256: Sha256;
  #activeDispatchId: string | undefined;

  constructor(sdk: CopilotSdkPort, sha256: Sha256) {
    this.sdk = sdk;
    this.sha256 = sha256;
  }

  async run(input: CopilotWorkerRunInput): Promise<CopilotWorkerRunResult> {
    const validated = this.validateInput(input);
    if (this.#activeDispatchId !== undefined) {
      throw new TypeError(`Copilot worker is already running dispatch ${this.#activeDispatchId}`);
    }
    this.#activeDispatchId = validated.dispatch.dispatchId;
    const state: RunState = {
      submissions: [],
      submissionIds: new Set(),
      submissionCount: 0,
    };
    const scope: RunScope = {
      active: true,
      dispatchId: validated.dispatch.dispatchId,
      pending: new Set(),
    };
    let session: CopilotSdkSessionPort | undefined;
    let status: CopilotWorkerRunResult["status"] = "missing-completion";
    try {
      const tools = createTools(
        input,
        validated.context,
        validated.dispatch,
        validated.selection,
        this.sha256,
        state,
        scope,
      );
      const config = sessionConfig(input.workingDirectory, validated.selection, tools);
      session = await this.sdk.resumeSession(validated.dispatch.dispatchId, {
        ...config,
        continuePendingWork: false,
      });
      session ??= await this.sdk.createSession({
        ...config,
        sessionId: validated.dispatch.dispatchId,
      });
      if (session.sessionId !== validated.dispatch.dispatchId) {
        throw new TypeError("Copilot SDK returned a session with the wrong dispatch identity");
      }
      const outcome = await sendWithCancellation(
        session,
        validated.prompt,
        input.timeoutMs,
        input.signal,
        () => {
          scope.active = false;
        },
      );
      if (outcome === "aborted") {
        scope.active = false;
        status = "aborted";
      } else if (state.completionDisposition !== undefined) {
        status = state.completionDisposition === "blocked" ? "blocked" : "completed";
      }
    } catch {
      status = "crashed";
    } finally {
      scope.active = false;
      if (session !== undefined) {
        try {
          await session.disconnect();
        } catch {
          status = "crashed";
        }
      }
      await Promise.allSettled([...scope.pending]);
      this.#activeDispatchId = undefined;
    }
    const base = {
      status,
      dispatchId: validated.dispatch.dispatchId,
      submissions: Object.freeze([...state.submissions]),
    };
    return status === "crashed"
      ? Object.freeze({ ...base, status, error: Object.freeze({ code: "copilot-worker-failed" }) })
      : Object.freeze({ ...base, status });
  }

  private validateInput(input: CopilotWorkerRunInput): {
    readonly context: WorkerContextBase;
    readonly dispatch: WorkerDispatch;
    readonly selection: WorkerModelRouteSelection;
    readonly prompt: string;
  } {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > MAX_TIMER_MILLISECONDS
    ) {
      throw new TypeError("Copilot worker timeout must be a positive supported timer integer");
    }
    if (input.workingDirectory.length === 0 || input.workingDirectory.includes("\0")) {
      throw new TypeError("Copilot worker working directory must be a non-empty NUL-free path");
    }
    if (
      this.sdk.workingDirectory !== undefined &&
      input.workingDirectory !== this.sdk.workingDirectory
    ) {
      throw new TypeError("Copilot worker working directory does not match its SDK port");
    }
    if (
      input.sessionBaseDirectory !== undefined &&
      input.sessionBaseDirectory !== this.sdk.baseDirectory
    ) {
      throw new TypeError("Copilot worker session base directory does not match its SDK port");
    }
    const context = validateWorkerContextBase(input.context, this.sha256);
    const assetBindings = new Set<string>(
      context.assets.map(({ assetBindingId }) => assetBindingId),
    );
    for (const [assetBindingId, grantToken] of input.grantTokens) {
      if (!assetBindings.has(assetBindingId) || typeof grantToken !== "string") {
        throw new TypeError("Copilot worker grant map contains an invalid asset binding");
      }
    }
    const dispatch = validateWorkerDispatch(input.dispatch, context, this.sha256);
    const selection = validateWorkerModelRouteSelection(
      input.routeSelection,
      context,
      dispatch,
      this.sha256,
    );
    if (selection.modelPolicy.provider !== "github-copilot") {
      throw new TypeError("Copilot workers require the github-copilot model provider");
    }
    const promptPack = renderPromptPack(context, dispatch, this.sha256, PROMPT_MAX_BYTES);
    if (promptPack.digest !== dispatch.promptPackDigest) {
      throw new TypeError("Rendered prompt digest does not match the exact worker dispatch");
    }
    const prompt = new TextDecoder("utf-8", { fatal: true }).decode(promptPack.utf8Bytes);
    return { context, dispatch, selection, prompt };
  }
}

interface RunState {
  readonly submissions: SubmissionAdmissionResult[];
  readonly submissionIds: Set<string>;
  submissionCount: number;
  completionDisposition?: CompletionSubmission["disposition"];
}

interface RunScope {
  active: boolean;
  readonly dispatchId: string;
  readonly pending: Set<Promise<void>>;
}

function sessionConfig(
  workingDirectory: string,
  selection: WorkerModelRouteSelection,
  tools: readonly CopilotSdkTool[],
): CopilotSdkSessionConfig {
  const availableTools = Object.freeze(tools.map(({ name }) => name));
  const knownTools = new Set(availableTools);
  const config: CopilotSdkSessionConfig = {
    model: selection.modelPolicy.model,
    sessionLimits: Object.freeze({ maxAiCredits: selection.limits.maxAiCredits }),
    tools,
    availableTools,
    excludedTools: Object.freeze(["builtin:*", "mcp:*"] as const),
    workingDirectory,
    additionalDirectories: Object.freeze([]),
    mcpServers: Object.freeze({}),
    toolSearch: Object.freeze({ enabled: false }),
    infiniteSessions: Object.freeze({ enabled: false }),
    largeOutput: Object.freeze({ enabled: false }),
    streaming: false,
    includeSubAgentStreamingEvents: false,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    memory: Object.freeze({ enabled: false }),
    remoteSession: "off",
    requestExtensions: false,
    requestCanvasRenderer: false,
    onPermissionRequest: () =>
      Object.freeze({ kind: "reject" as const, feedback: GENERIC_PERMISSION_FEEDBACK }),
    onPreToolUse: ({ sessionId, toolName }): CopilotSdkPreToolUseResult =>
      sessionId === selection.dispatchId && knownTools.has(toolName)
        ? Object.freeze({ permissionDecision: "allow" })
        : Object.freeze({
            permissionDecision: "deny",
            permissionDecisionReason: GENERIC_PERMISSION_FEEDBACK,
          }),
  };
  return Object.freeze(config);
}

function createTools(
  input: CopilotWorkerRunInput,
  context: WorkerContextBase,
  dispatch: WorkerDispatch,
  selection: WorkerModelRouteSelection,
  sha256: Sha256,
  state: RunState,
  scope: RunScope,
): readonly CopilotSdkTool[] {
  const capabilities = new Set(dispatch.capabilities);
  const tools: CopilotSdkTool[] = [];
  if (capabilities.has(WORKER_CAPABILITIES.assetRead) && input.grantTokens.size > 0) {
    tools.push(readAssetTool(input, context, dispatch, sha256, scope));
  }
  if (capabilities.has(WORKER_CAPABILITIES.question)) {
    tools.push(
      submissionTool(
        "submit_question",
        QUESTION_SCHEMA,
        input,
        context,
        dispatch,
        selection,
        sha256,
        state,
        scope,
        "question",
      ),
    );
  }
  if (capabilities.has(WORKER_CAPABILITIES.asset)) {
    tools.push(
      submissionTool(
        "propose_asset",
        ASSET_SCHEMA,
        input,
        context,
        dispatch,
        selection,
        sha256,
        state,
        scope,
        "asset",
      ),
    );
  }
  if (capabilities.has(WORKER_CAPABILITIES.discovery)) {
    tools.push(
      submissionTool(
        "record_discovery",
        DISCOVERY_SCHEMA,
        input,
        context,
        dispatch,
        selection,
        sha256,
        state,
        scope,
        "discovery",
      ),
    );
  }
  if (capabilities.has(WORKER_CAPABILITIES.amendmentProposal)) {
    tools.push(
      submissionTool(
        "propose_amendment",
        AMENDMENT_SCHEMA,
        input,
        context,
        dispatch,
        selection,
        sha256,
        state,
        scope,
        "amendment-proposal",
      ),
    );
  }
  if (capabilities.has(WORKER_CAPABILITIES.completion)) {
    tools.push(
      submissionTool(
        "submit_completion",
        COMPLETION_SCHEMA,
        input,
        context,
        dispatch,
        selection,
        sha256,
        state,
        scope,
        "completion",
      ),
    );
  }
  return Object.freeze(tools);
}

function readAssetTool(
  input: CopilotWorkerRunInput,
  context: WorkerContextBase,
  dispatch: WorkerDispatch,
  sha256: Sha256,
  scope: RunScope,
): CopilotSdkTool {
  return tool(
    "senawa_read_asset",
    "Read one explicitly granted historical asset binding.",
    READ_SCHEMA,
    scope,
    async (args, invocation) => {
      try {
        const object = exactObject(
          args,
          ["assetBindingId", "type"],
          ["pointer", "maxBytes", "offset", "length"],
        );
        const assetBindingId = boundedString(
          object.assetBindingId,
          PROTOCOL_LIMITS.maxIdentityLength,
        );
        const grantToken = input.grantTokens.get(assetBindingId);
        if (grantToken === undefined) return failure("grant-unavailable");
        const requestId = derivedIdentity("request", dispatch.dispatchId, invocation, sha256);
        const request =
          object.type === "pointer"
            ? {
                apiVersion: PROTOCOL_VERSION,
                requestId,
                grantToken,
                assetBindingId,
                type: "pointer" as const,
                pointer: boundedString(
                  object.pointer,
                  WORKER_PROTOCOL_LIMITS.maxPointerLength,
                  true,
                ),
                maxBytes: positiveInteger(
                  object.maxBytes,
                  WORKER_PROTOCOL_LIMITS.maxAssetReadBytes,
                ),
              }
            : object.type === "chunk"
              ? {
                  apiVersion: PROTOCOL_VERSION,
                  requestId,
                  grantToken,
                  assetBindingId,
                  type: "chunk" as const,
                  offset: nonNegativeInteger(object.offset),
                  length: positiveInteger(object.length, WORKER_PROTOCOL_LIMITS.maxAssetReadBytes),
                }
              : invalidArguments();
        const result = await input.broker.readAsset({ request });
        if (result.status === "denied") {
          return success({ status: "denied", denialCode: result.receipt.denialCode });
        }
        const binding = context.assets.find(
          (candidate) => candidate.assetBindingId === assetBindingId,
        );
        if (binding === undefined) return failure("binding-unavailable");
        return success({
          status: "served",
          mediaType: binding.mediaType,
          encoding: "base64",
          byteLength: result.bytes.byteLength,
          data: Buffer.from(result.bytes).toString("base64"),
        });
      } catch {
        return failure("invalid-tool-arguments");
      }
    },
  );
}

function submissionTool(
  name: (typeof COPILOT_WORKER_TOOL_NAMES)[number],
  parameters: Readonly<Record<string, unknown>>,
  input: CopilotWorkerRunInput,
  context: WorkerContextBase | undefined,
  dispatch: WorkerDispatch,
  selection: WorkerModelRouteSelection,
  sha256: Sha256,
  state: RunState,
  scope: RunScope,
  type: WorkerSubmission["type"],
): CopilotSdkTool {
  return tool(
    name,
    `Submit a scoped ${type} proposal to the Senawa context broker.`,
    parameters,
    scope,
    async (args, invocation) => {
      try {
        const submissionId = derivedIdentity("submission", dispatch.dispatchId, invocation, sha256);
        if (!state.submissionIds.has(submissionId)) {
          if (state.submissionCount >= selection.limits.maxSubmissions) {
            return failure("submission-limit-reached");
          }
          state.submissionIds.add(submissionId);
          state.submissionCount += 1;
        }
        const payload = submissionPayload(type, args, context, dispatch);
        const result = input.broker.admitSubmission({
          submission: {
            apiVersion: PROTOCOL_VERSION,
            submissionId,
            repositoryId: dispatch.repositoryId,
            runId: dispatch.runId,
            dispatchId: dispatch.dispatchId,
            task: dispatch.task,
            contextId: dispatch.contextId,
            contextDigest: dispatch.contextDigest,
            principalId: dispatch.worker.principalId,
            type,
            ...payload,
          },
          currentContextDigest: input.currentContextDigest(),
          currentTask: input.currentTask(),
        });
        state.submissions.push(result);
        if (
          type === "completion" &&
          result.status === "accepted" &&
          result.completionFact !== undefined
        ) {
          state.completionDisposition = (payload.completion as CompletionSubmission).disposition;
        }
        return success({ status: result.status, replayed: result.replayed });
      } catch {
        return failure("submission-refused");
      }
    },
  );
}

function submissionPayload(
  type: WorkerSubmission["type"],
  args: unknown,
  context: WorkerContextBase | undefined,
  dispatch: WorkerDispatch,
): Record<string, unknown> {
  if (type === "question") {
    const value = exactObject(args, ["prompt"], ["details"]);
    return {
      question: {
        prompt: boundedString(value.prompt, WORKER_PROTOCOL_LIMITS.maxQuestionLength),
        ...(value.details === undefined
          ? {}
          : { details: boundedString(value.details, PROTOCOL_LIMITS.maxStringLength) }),
      },
    };
  }
  if (type === "asset") {
    const value = exactObject(args, [
      "assetId",
      "contentDigest",
      "byteLength",
      "mediaType",
      "sensitivity",
      "summary",
    ]);
    return {
      asset: {
        assetId: value.assetId,
        contentDigest: value.contentDigest,
        byteLength: value.byteLength,
        mediaType: value.mediaType,
        sensitivity: value.sensitivity,
        summary: value.summary,
      },
    };
  }
  if (type === "discovery") {
    const value = exactObject(args, ["summary", "details"]);
    return { discovery: { summary: value.summary, details: value.details } };
  }
  if (type === "amendment-proposal") {
    if (context === undefined) return invalidArguments();
    const value = exactObject(args, ["summary", "operations"]);
    return {
      amendment: {
        baseGraphRevisionDigest: context.graphRevisionDigest,
        baseContextDigest: dispatch.contextDigest,
        summary: value.summary,
        operations: value.operations,
      },
    };
  }
  const value = exactObject(args, ["disposition", "summary", "criteria", "evidence"]);
  return {
    completion: {
      task: dispatch.task,
      disposition: value.disposition,
      summary: value.summary,
      criteria: value.criteria,
      evidence: value.evidence,
    },
  };
}

async function sendWithCancellation(
  session: CopilotSdkSessionPort,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onCancel: () => void,
): Promise<"finished" | "aborted"> {
  if (signal?.aborted === true) {
    onCancel();
    await session.abort();
    return "aborted";
  }
  let cancel = (): void => {};
  const cancelled = new Promise<"aborted">((resolve) => {
    cancel = () => {
      onCancel();
      resolve("aborted");
    };
  });
  const timeout = setTimeout(cancel, timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const outcome = await Promise.race([
      session.sendAndWait(prompt, timeoutMs).then(() => "finished" as const),
      cancelled,
    ]);
    if (outcome === "aborted") await session.abort();
    return outcome;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

function tool(
  name: CopilotSdkTool["name"],
  description: string,
  parameters: Readonly<Record<string, unknown>>,
  scope: RunScope,
  handler: CopilotSdkTool["handler"],
): CopilotSdkTool {
  if (!TOOL_NAMES.has(name)) throw new TypeError("Unknown Copilot worker tool");
  return Object.freeze({
    name,
    description,
    parameters,
    skipPermission: true,
    defer: "never",
    handler(args: unknown, invocation: CopilotSdkToolInvocation) {
      if (
        !scope.active ||
        invocation.sessionId !== scope.dispatchId ||
        invocation.toolName !== name
      ) {
        return Promise.resolve(failure("invocation-refused"));
      }
      const execution = handler(args, invocation);
      const pending = execution.then(
        () => undefined,
        () => undefined,
      );
      scope.pending.add(pending);
      void pending.finally(() => scope.pending.delete(pending));
      return execution;
    },
  });
}

function derivedIdentity(
  prefix: "request" | "submission",
  dispatchId: string,
  invocation: CopilotSdkToolInvocation,
  sha256: Sha256,
): string {
  const digest = sha256.digest(
    new TextEncoder().encode(`${dispatchId}\0${invocation.toolCallId}\0${invocation.toolName}`),
  );
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError("SHA-256 returned an invalid digest");
  return `${prefix}_${digest}`;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalidArguments();
  const object = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(object).some((key) => !allowed.has(key))) return invalidArguments();
  if (required.some((key) => !Object.hasOwn(object, key))) return invalidArguments();
  return object;
}

function boundedString(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!empty && value.length === 0) ||
    value.includes("\0")
  )
    return invalidArguments();
  return value;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalidArguments();
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidArguments();
  return value as number;
}

function invalidArguments(): never {
  throw new TypeError("Invalid tool arguments");
}

function success(value: unknown): CopilotSdkToolResult {
  return Object.freeze({ resultType: "success", textResultForLlm: JSON.stringify(value) });
}

function failure(code: string): CopilotSdkToolResult {
  return Object.freeze({
    resultType: "failure",
    textResultForLlm: JSON.stringify({ status: "failed", code }),
  });
}

const stringSchema = (maxLength: number, minLength = 1) =>
  Object.freeze({ type: "string", minLength, maxLength });
const identitySchema = (prefix?: string) =>
  Object.freeze({
    ...stringSchema(PROTOCOL_LIMITS.maxIdentityLength),
    pattern:
      prefix === undefined
        ? "^[a-z0-9][a-z0-9._:-]{0,127}$"
        : `^${prefix}[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`,
  });
const digestSchema = Object.freeze({
  ...stringSchema(64, 64),
  pattern: "^[0-9a-f]{64}$",
});
const closedObject = (properties: Record<string, unknown>, required: readonly string[]) =>
  Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze([...required]),
    additionalProperties: false,
  });

const READ_SCHEMA = Object.freeze({
  oneOf: Object.freeze([
    closedObject(
      {
        assetBindingId: identitySchema("asset-binding_"),
        type: { const: "pointer" },
        pointer: stringSchema(WORKER_PROTOCOL_LIMITS.maxPointerLength, 0),
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: WORKER_PROTOCOL_LIMITS.maxAssetReadBytes,
        },
      },
      ["assetBindingId", "type", "pointer", "maxBytes"],
    ),
    closedObject(
      {
        assetBindingId: identitySchema("asset-binding_"),
        type: { const: "chunk" },
        offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        length: { type: "integer", minimum: 1, maximum: WORKER_PROTOCOL_LIMITS.maxAssetReadBytes },
      },
      ["assetBindingId", "type", "offset", "length"],
    ),
  ]),
});
const QUESTION_SCHEMA = closedObject(
  {
    prompt: stringSchema(WORKER_PROTOCOL_LIMITS.maxQuestionLength),
    details: stringSchema(PROTOCOL_LIMITS.maxStringLength),
  },
  ["prompt"],
);
const ASSET_SCHEMA = closedObject(
  {
    assetId: identitySchema("asset_"),
    contentDigest: digestSchema,
    byteLength: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    mediaType: {
      ...stringSchema(127, 3),
      pattern: "^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$",
    },
    sensitivity: { enum: ["public", "internal", "confidential", "restricted"] },
    summary: stringSchema(WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength),
  },
  ["assetId", "contentDigest", "byteLength", "mediaType", "sensitivity", "summary"],
);
const DISCOVERY_SCHEMA = closedObject(
  {
    summary: stringSchema(WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength),
    details: stringSchema(PROTOCOL_LIMITS.maxStringLength),
  },
  ["summary", "details"],
);
const AMENDMENT_SCHEMA = closedObject(
  {
    summary: stringSchema(WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength),
    operations: stringSchema(PROTOCOL_LIMITS.maxStringLength),
  },
  ["summary", "operations"],
);
const CRITERION_SCHEMA = closedObject(
  {
    criterionId: identitySchema("criterion_"),
    disposition: { enum: ["satisfied", "unsatisfied", "waived", "skipped"] },
    authorityFact: stringSchema(PROTOCOL_LIMITS.maxStringLength),
  },
  ["criterionId", "disposition"],
);
const EVIDENCE_SCHEMA = closedObject(
  {
    assetId: identitySchema("asset_"),
    kind: stringSchema(PROTOCOL_LIMITS.maxStringLength),
    descriptor: stringSchema(PROTOCOL_LIMITS.maxStringLength),
    criterionId: identitySchema("criterion_"),
  },
  ["assetId", "kind", "descriptor"],
);
const COMPLETION_SCHEMA = closedObject(
  {
    disposition: { enum: ["completed", "blocked", "waived", "skipped"] },
    summary: stringSchema(WORKER_PROTOCOL_LIMITS.maxSubmissionSummaryLength),
    criteria: {
      type: "array",
      maxItems: WORKER_PROTOCOL_LIMITS.maxCompletionItems,
      items: CRITERION_SCHEMA,
    },
    evidence: {
      type: "array",
      maxItems: WORKER_PROTOCOL_LIMITS.maxCompletionItems,
      items: EVIDENCE_SCHEMA,
    },
  },
  ["disposition", "summary", "criteria", "evidence"],
);
