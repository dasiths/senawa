import { validateSchemaInstance } from "@senawa/configuration";
import {
  type AgentSessionScope,
  type CanonicalValue,
  type CompletionSubmission,
  canonicalBytes,
  canonicalValue,
  decideAgentSessionResume,
  isSha256Digest,
  type Sha256,
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
  type AgentTranscriptPort,
  type ContextBrokerClient,
  PHASE_OUTPUT_LIMITS,
  type RuntimeSchemaContract,
  renderPromptPack,
  type SubmissionAdmissionResult,
  schemaValidationReceiptDigest,
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
import {
  WORKSPACE_FILE_LIMITS,
  type WorkspaceFilePatchChange,
  type WorkspaceFilePort,
} from "./workspace-files.js";

export const COPILOT_WORKER_TOOL_NAMES = Object.freeze([
  "senawa_read_asset",
  "submit_question",
  "propose_asset",
  "record_discovery",
  "propose_amendment",
  "senawa_output_schema",
  "senawa_complete",
] as const);
export const COPILOT_WORKSPACE_TOOL_NAMES = Object.freeze([
  "senawa_list_workspace",
  "senawa_read_workspace_file",
  "senawa_write_workspace_file",
  "senawa_apply_workspace_patch",
] as const);

const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const PROMPT_MAX_BYTES = 65_536;
const GENERIC_PERMISSION_FEEDBACK = "This session does not grant that operation.";
const TOOL_NAMES = new Set<string>([...COPILOT_WORKER_TOOL_NAMES, ...COPILOT_WORKSPACE_TOOL_NAMES]);

export interface CopilotWorkerRunInput {
  readonly context: unknown;
  readonly dispatch: unknown;
  readonly routeSelection: unknown;
  readonly broker: ContextBrokerClient;
  readonly grantTokens: ReadonlyMap<string, string>;
  readonly workingDirectory: string;
  readonly workspaceFiles?: WorkspaceFilePort;
  /** Accepted output schema contracts keyed by declared output name. */
  readonly phaseOutputSchemas?: ReadonlyMap<string, RuntimeSchemaContract>;
  /** Durable dispatch-scoped transcript sink for session and tool lifecycle lines. */
  readonly transcript?: AgentTranscriptPort;
  readonly sessionBaseDirectory?: string;
  readonly sessionResume?: Readonly<{
    /** How much may change and still be the same conversation. */
    readonly scope?: AgentSessionScope;
    readonly requestedBinding: unknown;
    readonly authorizedBinding?: unknown;
  }>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type CopilotWorkerRunResult =
  | {
      readonly status:
        | "completed"
        | "blocked"
        | "missing-completion"
        | "awaiting-answer"
        | "aborted";
      readonly dispatchId: string;
      readonly submissions: readonly SubmissionAdmissionResult[];
      /** Present only when durable transcript capture refused at least one line. */
      readonly transcriptRefusals?: number;
    }
  | {
      readonly status: "crashed";
      readonly dispatchId: string;
      readonly submissions: readonly SubmissionAdmissionResult[];
      readonly transcriptRefusals?: number;
      readonly error: Readonly<{ readonly code: "copilot-worker-failed" }>;
    };

export class CopilotSerialWorkerAdapter {
  readonly sdk: CopilotSdkPort;
  readonly sha256: Sha256;
  #activeDispatchId: string | undefined;
  #activeSession: CopilotSdkSessionPort | undefined;

  /**
   * Delivers a person's instruction to the agent that is working right now.
   *
   * Returns false when nobody is working, when the dispatch asked for is not the
   * one running, or when the port cannot interrupt. A caller that is told the
   * message did not land can queue it for the end of the turn, which is why this
   * reports rather than throws.
   */
  async steer(dispatchId: string, instruction: string): Promise<boolean> {
    const session = this.#activeSession;
    if (session === undefined || this.#activeDispatchId !== dispatchId) return false;
    if (session.send === undefined) return false;
    try {
      await session.send(instruction, { mode: "interrupt" });
      return true;
    } catch {
      return false;
    }
  }

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
      rejectedPhaseOutputs: 0,
      transcriptRefusals: 0,
    };
    const scope: RunScope = {
      active: true,
      dispatchId: validated.dispatch.dispatchId,
      sessionId: validated.dispatch.dispatchId,
      pending: new Set(),
      note: transcriptNoteSink(input, validated.dispatch, this.sha256, state),
    };
    scope.note("session started");
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
      const resumeDecision =
        input.sessionResume === undefined
          ? undefined
          : decideAgentSessionResume(
              input.sessionResume.requestedBinding,
              input.sessionResume.authorizedBinding,
              this.sha256,
              input.sessionResume.scope,
            );
      const resumableSessionId =
        resumeDecision?.action === "resume"
          ? String(
              (input.sessionResume?.requestedBinding as Readonly<Record<string, unknown>>)
                .predecessorSessionId,
            )
          : validated.dispatch.dispatchId;
      scope.sessionId = resumableSessionId;
      const config = sessionConfig(
        input.workingDirectory,
        validated.selection,
        tools,
        resumableSessionId,
      );
      session =
        resumeDecision?.action === "new-session"
          ? undefined
          : await this.sdk.resumeSession(resumableSessionId, {
              ...config,
              continuePendingWork: false,
            });
      session ??= await this.sdk.createSession({
        ...config,
        sessionId: validated.dispatch.dispatchId,
      });
      const expectedSessionId =
        resumeDecision?.action === "resume" ? resumableSessionId : validated.dispatch.dispatchId;
      if (session.sessionId !== expectedSessionId) {
        throw new TypeError("Copilot SDK returned a session outside exact resume authority");
      }
      scope.sessionId = session.sessionId;
      this.#activeSession = session;
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
      } else if (state.askedQuestion === true) {
        // An agent that stopped to ask has not failed. Calling it a failure
        // fences its own task, which is what made its question unanswerable.
        status = "awaiting-answer";
      }
    } catch (error) {
      status = "crashed";
    } finally {
      scope.active = false;
      if (session !== undefined) {
        // Hanging up is not part of the turn. A disconnect that fails while the
        // supervisor is stopping used to rewrite the outcome as a crash, and a
        // crash fences the task, so restarting the service killed the run.
        try {
          await session.disconnect();
        } catch {
          scope.note("session disconnect failed after the turn ended");
        }
      }
      await Promise.allSettled([...scope.pending]);
      this.#activeDispatchId = undefined;
      this.#activeSession = undefined;
      scope.note(sessionEndedNote(status));
    }
    const base = {
      status,
      dispatchId: validated.dispatch.dispatchId,
      submissions: Object.freeze([...state.submissions]),
      ...(state.transcriptRefusals === 0 ? {} : { transcriptRefusals: state.transcriptRefusals }),
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
      input.workspaceFiles !== undefined &&
      input.workspaceFiles.root !== input.workingDirectory
    ) {
      throw new TypeError("Copilot workspace files must bind the exact dispatch working directory");
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
  rejectedPhaseOutputs: number;
  transcriptRefusals: number;
  completionDisposition?: CompletionSubmission["disposition"];
  askedQuestion?: true;
}

interface RunScope {
  active: boolean;
  readonly dispatchId: string;
  sessionId: string;
  readonly pending: Set<Promise<void>>;
  readonly note: (text: string) => void;
}

/**
 * One captured record is exactly one displayed row, so multi-line output is
 * split here rather than allowed to forge extra rows in the portal terminal.
 *
 * The capture identity is the digest of the exact record, so a re-drive under a
 * new wall clock cannot reuse a retained identity and an exact replay still
 * resolves to the retained line. Nothing seeds the counter from a durable read,
 * so no read failure can strand the capture on identities the store already
 * holds. The per-run ordinal keeps two identical lines of one run distinct.
 */
/**
 * A person reads this line to learn whether the agent is coming back. The raw
 * status does not say: "awaiting-answer" is a normal pause that reads like a
 * crash, and "missing-completion" reads like a bug in senawa rather than an
 * agent that submitted nothing.
 */
function sessionEndedNote(status: CopilotWorkerRunResult["status"] | "crashed"): string {
  const endings: Readonly<Record<string, string>> = {
    completed: "session ended: the agent finished and submitted its work",
    blocked: "session ended: the agent reported it cannot continue",
    "missing-completion": "session ended: the agent stopped without submitting anything",
    "awaiting-answer": "session paused: the agent asked a question and is waiting for an answer",
    aborted: "session ended: the agent was cancelled",
    crashed: "session ended: the agent failed with an error",
  };
  return endings[status] ?? `session ended ${status}`;
}

function transcriptNoteSink(
  input: CopilotWorkerRunInput,
  dispatch: WorkerDispatch,
  sha256: Sha256,
  state: RunState,
): (text: string) => void {
  const port = input.transcript;
  if (port === undefined) return () => undefined;
  const owner = Object.freeze({ kind: "dispatch" as const, id: dispatch.dispatchId });
  let ordinal = 0;
  return (text) => {
    for (const line of text.split(/\r\n|[\n\r\u0085\u2028\u2029]/u)) {
      if (line.length === 0) continue;
      ordinal += 1;
      const occurredAt = input.broker.dependencies.currentTime();
      try {
        port.append({
          repositoryId: dispatch.repositoryId,
          runId: dispatch.runId,
          owner,
          lineId: sha256.digest(
            canonicalBytes(
              canonicalValue({
                dispatchId: dispatch.dispatchId,
                occurredAt,
                ordinal,
                stream: "system",
                text: line,
              }),
            ),
          ),
          occurredAt,
          stream: "system",
          text: line,
        });
      } catch {
        // Transcript capture is observability and must never fail a dispatch,
        // but the refusal is reported through the effect outcome details.
        state.transcriptRefusals += 1;
      }
    }
  };
}

function sessionConfig(
  workingDirectory: string,
  selection: WorkerModelRouteSelection,
  tools: readonly CopilotSdkTool[],
  authorizedSessionId: string,
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
      sessionId === authorizedSessionId && knownTools.has(toolName)
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
  if (input.workspaceFiles !== undefined) {
    tools.push(...workspaceFileTools(input.workspaceFiles, scope));
  }
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
    const slots: PhaseOutputSlot[] = [];
    if (capabilities.has(WORKER_CAPABILITIES.phaseOutput)) {
      for (const declaration of context.phaseOutputDeclarations) {
        const contract = input.phaseOutputSchemas?.get(String(declaration.outputName));
        if (contract !== undefined) slots.push({ declaration, contract });
      }
    }
    if (slots.length > 0) tools.push(outputSchemaTool(scope, Object.freeze(slots)));
    tools.push(
      completeTool(input, context, dispatch, selection, sha256, state, scope, Object.freeze(slots)),
    );
  }
  return Object.freeze(tools);
}

/**
 * The shape senawa will hold this phase's output to.
 *
 * The operating contract tells an agent to ask senawa for its output schema
 * rather than guessing. Without this there was nothing to ask, so an agent that
 * followed the contract put the question to a person and stopped the run to
 * wait for an answer senawa already had.
 */
function outputSchemaTool(scope: RunScope, slots: readonly PhaseOutputSlot[]): CopilotSdkTool {
  return tool(
    "senawa_output_schema",
    `Read the JSON Schema senawa will validate a declared output against: ${slots
      .map((slot) => String(slot.declaration.outputName))
      .join(", ")}.`,
    OUTPUT_SCHEMA_SCHEMA,
    scope,
    async (args) => {
      const value = exactObject(args, [], ["output"]);
      const wanted = value.output === undefined ? undefined : String(value.output);
      const matching =
        wanted === undefined
          ? slots
          : slots.filter((slot) => String(slot.declaration.outputName) === wanted);
      if (matching.length === 0) return failure("unknown-output");
      return success({
        outputs: matching.map((slot) => ({
          name: String(slot.declaration.outputName),
          schemaKey: String(slot.declaration.schemaKey),
          maxBytes: slot.declaration.maxBytes,
          schema: slot.contract.schema,
          referencedSchemas: slot.contract.externalSchemas.map((external) => ({
            id: external.id,
            schema: external.schema,
          })),
        })),
      });
    },
  );
}

function workspaceFileTools(files: WorkspaceFilePort, scope: RunScope): readonly CopilotSdkTool[] {
  return Object.freeze([
    tool(
      "senawa_list_workspace",
      "List one directory inside the dispatch workspace.",
      WORKSPACE_LIST_SCHEMA,
      scope,
      async (args) => {
        try {
          const value = exactObject(args, ["path"], ["maxEntries"]);
          const entries = await files.list(
            boundedString(value.path, PROTOCOL_LIMITS.maxStringLength),
            value.maxEntries === undefined
              ? undefined
              : positiveInteger(value.maxEntries, WORKSPACE_FILE_LIMITS.maxListEntries),
          );
          return success({ entries });
        } catch {
          return failure("workspace-list-refused");
        }
      },
    ),
    tool(
      "senawa_read_workspace_file",
      "Read one UTF-8 file inside the dispatch workspace.",
      WORKSPACE_READ_SCHEMA,
      scope,
      async (args) => {
        try {
          const value = exactObject(args, ["path"], ["maxBytes"]);
          const content = await files.read(
            boundedString(value.path, PROTOCOL_LIMITS.maxStringLength),
            value.maxBytes === undefined
              ? undefined
              : positiveInteger(value.maxBytes, WORKSPACE_FILE_LIMITS.maxFileBytes),
          );
          return success({ content });
        } catch {
          return failure("workspace-read-refused");
        }
      },
    ),
    tool(
      "senawa_write_workspace_file",
      "Atomically write one UTF-8 file inside the dispatch workspace.",
      WORKSPACE_WRITE_SCHEMA,
      scope,
      async (args) => {
        try {
          const value = exactObject(args, ["path", "content"]);
          await files.write(
            boundedString(value.path, PROTOCOL_LIMITS.maxStringLength),
            boundedString(value.content, WORKSPACE_FILE_LIMITS.maxFileBytes, true),
          );
          return success({ status: "written" });
        } catch {
          return failure("workspace-write-refused");
        }
      },
    ),
    tool(
      "senawa_apply_workspace_patch",
      "Compare and replace bounded UTF-8 files inside the dispatch workspace.",
      WORKSPACE_PATCH_SCHEMA,
      scope,
      async (args) => {
        try {
          const value = exactObject(args, ["changes"]);
          if (!Array.isArray(value.changes)) return failure("workspace-patch-refused");
          const changes: WorkspaceFilePatchChange[] = value.changes.map((change) => {
            const item = exactObject(change, ["path", "expectedText", "replacementText"]);
            return {
              path: boundedString(item.path, PROTOCOL_LIMITS.maxStringLength),
              expectedText: boundedString(
                item.expectedText,
                WORKSPACE_FILE_LIMITS.maxFileBytes,
                true,
              ),
              replacementText: boundedString(
                item.replacementText,
                WORKSPACE_FILE_LIMITS.maxFileBytes,
                true,
              ),
            };
          });
          await files.applyPatch(changes);
          return success({ status: "patched", changeCount: changes.length });
        } catch {
          return failure("workspace-patch-refused");
        }
      },
    ),
  ]);
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
        });
        state.submissions.push(result);
        if (type === "question" && result.status === "accepted") state.askedQuestion = true;
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

interface PhaseOutputSlot {
  readonly declaration: WorkerContextBase["phaseOutputDeclarations"][number];
  readonly contract: RuntimeSchemaContract;
}

/**
 * The one successful completion path. Every declared output is validated before
 * any of them is admitted, so a refused completion never leaves an accepted
 * output waiting for a second request.
 */
function completeTool(
  input: CopilotWorkerRunInput,
  context: WorkerContextBase,
  dispatch: WorkerDispatch,
  selection: WorkerModelRouteSelection,
  sha256: Sha256,
  state: RunState,
  scope: RunScope,
  slots: readonly PhaseOutputSlot[],
): CopilotSdkTool {
  const names = slots.map((slot) => String(slot.declaration.outputName));
  return tool(
    "senawa_complete",
    names.length === 0
      ? "Ask Senawa to grant completion for this phase. Senawa decides whether the work is done."
      : `Ask Senawa to grant completion, carrying every required output: ${names.join(", ")}. Senawa decides whether the work is done.`,
    completeParameters(slots),
    scope,
    async (args, invocation) => {
      try {
        let completion: Readonly<Record<string, unknown>>;
        let outputs: Readonly<Record<string, unknown>>;
        let notes: unknown;
        try {
          const wrapper = exactObject(
            args,
            ["disposition", "summary", "criteria", "completionEvidence"],
            slots.length === 0 ? [] : ["outputs", "changeNotes"],
          );
          completion = {
            disposition: wrapper.disposition,
            summary: wrapper.summary,
            criteria: wrapper.criteria,
            completionEvidence: wrapper.completionEvidence,
          };
          outputs =
            slots.length === 0
              ? {}
              : exactObject(decodedObject(wrapper.outputs), names, [], "outputs");
          notes = wrapper.changeNotes;
        } catch (error) {
          // Without the reason an agent can only guess, and it guesses many
          // times: one live planner retried twenty-six times before giving up.
          return failure(
            "completion-arguments-invalid",
            error instanceof Error ? error.message : undefined,
          );
        }
        for (const slot of slots) {
          const name = String(slot.declaration.outputName);
          const identity = {
            attemptId: derivedIdentity("attempt", dispatch.dispatchId, invocation, sha256),
            dispatchId: dispatch.dispatchId,
            outputName: name,
            invocation,
          };
          const durable = input.broker.countRejectedPhaseOutputAttempts?.(
            dispatch.dispatchId,
            name,
          );
          const rejected = Math.max(durable ?? 0, state.rejectedPhaseOutputs);
          if (rejected >= PHASE_OUTPUT_LIMITS.maxAttempts) {
            return outputFailure("output-attempt-budget-exhausted", []);
          }
          const refusal = checkOutput(slot, outputs[name]);
          if (refusal !== undefined) {
            return recordRejected(input, state, sha256, identity, refusal.reason, refusal.findings);
          }
        }
        for (const slot of slots) {
          const name = String(slot.declaration.outputName);
          const accepted = await submitPhaseOutput(
            { input, context, dispatch, selection, sha256, state, scope, slot },
            { output: outputs[name], ...(notes === undefined ? {} : { changeNotes: notes }) },
            scopedInvocation(invocation, `output:${name}`),
            name,
            Math.min(slot.declaration.maxBytes, PHASE_OUTPUT_LIMITS.maxOutputBytes),
          );
          if (accepted.resultType !== "success") return accepted;
        }
        return admitCompletion(
          { input, context, dispatch, selection, sha256, state },
          completion,
          slots.length === 0 ? invocation : scopedInvocation(invocation, "completion"),
        );
      } catch {
        // A throwing handler would send raw exception text to the model.
        return failure("completion-refused");
      }
    },
  );
}

/** One tool call makes several submissions, so each needs its own derived identity. */
function scopedInvocation(
  invocation: CopilotSdkToolInvocation,
  scope: string,
): CopilotSdkToolInvocation {
  return { ...invocation, toolName: `${invocation.toolName}#${scope}` };
}

/** Validates one output without admitting it, so every output is checked first. */
function checkOutput(
  slot: PhaseOutputSlot,
  value: unknown,
):
  | { readonly reason: string; readonly findings: readonly Readonly<Record<string, string>>[] }
  | undefined {
  const maxBytes = Math.min(slot.declaration.maxBytes, PHASE_OUTPUT_LIMITS.maxOutputBytes);
  try {
    assertBoundedArgument(value, maxBytes);
  } catch {
    return { reason: "output-too-large", findings: [] };
  }
  let canonical: CanonicalValue;
  try {
    canonical = canonicalValue(value);
  } catch {
    return { reason: "output-arguments-invalid", findings: [] };
  }
  if (canonicalBytes(canonical).byteLength > maxBytes) {
    return { reason: "output-too-large", findings: [] };
  }
  const findings = validateSchemaInstance(
    slot.contract.schema,
    canonical,
    slot.contract.externalSchemas.map(({ id, schema }) => ({ id, schema })),
  );
  if (findings.length === 0) return undefined;
  return {
    reason: "output-schema-invalid",
    findings: findings.map(({ pointer, schemaPointer, keyword }) => ({
      instancePointer: pointer,
      ...(schemaPointer === undefined ? {} : { schemaPointer }),
      ...(keyword === undefined ? {} : { keyword }),
    })),
  };
}

function admitCompletion(
  bound: {
    readonly input: CopilotWorkerRunInput;
    readonly context: WorkerContextBase | undefined;
    readonly dispatch: WorkerDispatch;
    readonly selection: WorkerModelRouteSelection;
    readonly sha256: Sha256;
    readonly state: RunState;
  },
  args: Readonly<Record<string, unknown>>,
  invocation: CopilotSdkToolInvocation,
): CopilotSdkToolResult {
  const { input, context, dispatch, selection, sha256, state } = bound;
  const submissionId = derivedIdentity("submission", dispatch.dispatchId, invocation, sha256);
  if (!state.submissionIds.has(submissionId)) {
    if (state.submissionCount >= selection.limits.maxSubmissions) {
      return failure("submission-limit-reached");
    }
    state.submissionIds.add(submissionId);
    state.submissionCount += 1;
  }
  const payload = submissionPayload("completion", args, context, dispatch);
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
      type: "completion",
      ...payload,
    },
  });
  state.submissions.push(result);
  if (result.status === "accepted" && result.completionFact !== undefined) {
    state.completionDisposition = (payload.completion as CompletionSubmission).disposition;
  }
  return success({ status: result.status, replayed: result.replayed });
}

function completeParameters(slots: readonly PhaseOutputSlot[]): Readonly<Record<string, unknown>> {
  if (slots.length === 0) return COMPLETION_SCHEMA;
  const properties: Record<string, unknown> = {};
  for (const slot of slots) {
    const schema = slot.contract.schema as Readonly<Record<string, unknown>>;
    const guidance: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key !== "$schema" && key !== "$id") guidance[key] = value;
    }
    const maxBytes = Math.min(slot.declaration.maxBytes, PHASE_OUTPUT_LIMITS.maxOutputBytes);
    properties[String(slot.declaration.outputName)] = {
      ...guidance,
      description: `Accepted "${String(slot.declaration.outputName)}" output. Canonical JSON must not exceed ${maxBytes} bytes.`,
    };
  }
  const base = COMPLETION_SCHEMA as {
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required: readonly string[];
  };
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [...base.required, "outputs"],
    properties: {
      ...base.properties,
      outputs: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: slots.map((slot) => String(slot.declaration.outputName)),
        properties,
      }),
      changeNotes: {
        type: "array",
        maxItems: PHASE_OUTPUT_LIMITS.maxChangeNotes,
        items: stringSchema(PHASE_OUTPUT_LIMITS.maxChangeNoteLength),
      },
    },
  });
}

async function submitPhaseOutput(
  bound: {
    readonly input: CopilotWorkerRunInput;
    readonly context: WorkerContextBase;
    readonly dispatch: WorkerDispatch;
    readonly selection: WorkerModelRouteSelection;
    readonly sha256: Sha256;
    readonly state: RunState;
    readonly scope: RunScope;
    readonly slot: PhaseOutputSlot;
  },
  args: unknown,
  invocation: CopilotSdkToolInvocation,
  outputName: string,
  maxBytes: number,
): Promise<CopilotSdkToolResult> {
  const { input, context, dispatch, selection, sha256, state, slot } = bound;
  const attemptId = derivedIdentity("attempt", dispatch.dispatchId, invocation, sha256);
  const identity = { attemptId, dispatchId: dispatch.dispatchId, outputName, invocation };
  const durableRejected = input.broker.countRejectedPhaseOutputAttempts?.(
    dispatch.dispatchId,
    outputName,
  );
  const rejected = Math.max(durableRejected ?? 0, state.rejectedPhaseOutputs);
  if (rejected >= PHASE_OUTPUT_LIMITS.maxAttempts) {
    return outputFailure("output-attempt-budget-exhausted", []);
  }
  let canonical: CanonicalValue;
  let output: unknown;
  try {
    const wrapper = exactObject(args, ["output"], ["changeNotes"]);
    changeNotes(wrapper.changeNotes);
    output = wrapper.output;
  } catch {
    return recordRejected(input, state, sha256, identity, "output-arguments-invalid", []);
  }
  try {
    assertBoundedArgument(output, maxBytes);
  } catch {
    return recordRejected(input, state, sha256, identity, "output-too-large", []);
  }
  try {
    canonical = canonicalValue(output);
  } catch {
    return recordRejected(input, state, sha256, identity, "output-arguments-invalid", []);
  }
  const bytes = canonicalBytes(canonical);
  if (bytes.byteLength > maxBytes) {
    return recordRejected(input, state, sha256, identity, "output-too-large", []);
  }
  const findings = validateSchemaInstance(
    slot.contract.schema,
    canonical,
    slot.contract.externalSchemas.map(({ id, schema }) => ({ id, schema })),
  );
  if (findings.length > 0) {
    return recordRejected(
      input,
      state,
      sha256,
      identity,
      "output-schema-invalid",
      findings.map(({ pointer, schemaPointer, keyword }) => ({
        instancePointer: pointer,
        ...(schemaPointer === undefined ? {} : { schemaPointer }),
        ...(keyword === undefined ? {} : { keyword }),
      })),
    );
  }
  const submissionId = derivedIdentity("submission", dispatch.dispatchId, invocation, sha256);
  if (!state.submissionIds.has(submissionId)) {
    if (state.submissionCount >= selection.limits.maxSubmissions) {
      return failure("submission-limit-reached");
    }
    state.submissionIds.add(submissionId);
    state.submissionCount += 1;
  }
  const contentDigest = sha256.digest(bytes);
  if (!isSha256Digest(contentDigest)) {
    return recordRejected(input, state, sha256, identity, "output-digest-invalid", []);
  }
  const validationReceiptDigest = schemaValidationReceiptDigest(
    "phase output",
    slot.contract,
    contentDigest,
    sha256,
  );
  let result: SubmissionAdmissionResult;
  try {
    input.broker.installCanonicalOutputAsset?.(
      {
        contentDigest,
        byteLength: bytes.byteLength,
        mediaType: "application/json",
        schemaResourceDigest: slot.contract.schemaResourceDigest,
        validationReceiptDigest,
      },
      bytes,
    );
    result = input.broker.admitSubmission({
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
        type: "phase-output",
        output: {
          phase: context.phaseAttempt.phase,
          outputName,
          schemaKey: slot.contract.key,
          schemaResourceDigest: slot.contract.schemaResourceDigest,
          contentDigest,
          byteLength: bytes.byteLength,
          mediaType: "application/json",
          sensitivity: slot.declaration.sensitivity,
          graphRevisionDigest: context.graphRevisionDigest,
          configurationSnapshotDigest: context.configurationSnapshotDigest,
          inputBindingDigest: context.phaseInputBinding.bindingDigest,
          validationReceiptDigest,
        },
      },
    });
  } catch {
    // A refused admission still consumed a bounded attempt and staged its bytes.
    return recordRejected(input, state, sha256, identity, "submission-refused", []);
  }
  state.submissions.push(result);
  if (result.status !== "accepted") {
    // A stale or duplicate admission is not an acceptance and must read as one.
    return recordRejected(input, state, sha256, identity, `output-${result.status}`, []);
  }
  try {
    input.broker.recordPhaseOutputAttempt?.({
      dispatchId: dispatch.dispatchId,
      attemptId,
      outputName,
      toolCallId: invocation.toolCallId,
      outcome: "accepted",
      submissionId,
    });
  } catch {
    // The submission is already durable and attributable through its own identity.
  }
  return success({ status: result.status, replayed: result.replayed });
}

interface PhaseOutputAttemptIdentity {
  readonly attemptId: string;
  readonly dispatchId: string;
  readonly outputName: string;
  readonly invocation: CopilotSdkToolInvocation;
}

function recordRejected(
  input: CopilotWorkerRunInput,
  state: RunState,
  sha256: Sha256,
  identity: PhaseOutputAttemptIdentity,
  code: string,
  findings: readonly Readonly<Record<string, string>>[],
): CopilotSdkToolResult {
  const reported = findings.slice(0, PHASE_OUTPUT_LIMITS.maxReportedFindings);
  const findingsDigest = sha256.digest(
    canonicalBytes(canonicalValue({ code, findings: reported })),
  );
  state.rejectedPhaseOutputs += 1;
  if (input.broker.recordPhaseOutputAttempt === undefined) {
    // Without a durable ledger the budget is only process-local, so report the code as is.
    return outputFailure(code, reported);
  }
  try {
    input.broker.recordPhaseOutputAttempt({
      dispatchId: identity.dispatchId,
      attemptId: identity.attemptId,
      outputName: identity.outputName,
      toolCallId: identity.invocation.toolCallId,
      outcome: "rejected",
      findingsDigest,
    });
  } catch {
    return outputFailure("attempt-refused", []);
  }
  return outputFailure(code, reported);
}

/** Bounds raw tool arguments iteratively before any canonical materialization. */
function assertBoundedArgument(value: unknown, maxBytes: number): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 1 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    nodes += 1;
    bytes += 2;
    if (nodes > PHASE_OUTPUT_LIMITS.maxOutputNodes) invalidArguments();
    if (bytes > maxBytes) invalidArguments();
    if (entry.depth > PHASE_OUTPUT_LIMITS.maxOutputDepth) invalidArguments();
    const current = entry.value;
    if (typeof current === "string") {
      bytes += current.length;
      if (bytes > maxBytes) invalidArguments();
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    const children = Array.isArray(current) ? current : Object.entries(current);
    for (const child of children) {
      if (Array.isArray(current)) {
        stack.push({ value: child, depth: entry.depth + 1 });
        continue;
      }
      const [key, nested] = child as [string, unknown];
      bytes += key.length;
      if (bytes > maxBytes) invalidArguments();
      stack.push({ value: nested, depth: entry.depth + 1 });
    }
  }
}

function outputFailure(
  code: string,
  findings: readonly Readonly<Record<string, string>>[],
): CopilotSdkToolResult {
  return Object.freeze({
    resultType: "failure",
    textResultForLlm: JSON.stringify({ status: "rejected", code, findings }),
  });
}

function changeNotes(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PHASE_OUTPUT_LIMITS.maxChangeNotes)
    return invalidArguments();
  return value.map((note) => boundedString(note, PHASE_OUTPUT_LIMITS.maxChangeNoteLength));
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
  const value = exactObject(args, ["disposition", "summary", "criteria", "completionEvidence"]);
  return {
    completion: {
      task: dispatch.task,
      disposition: value.disposition,
      summary: value.summary,
      criteria: value.criteria,
      completionEvidence: value.completionEvidence,
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
        invocation.sessionId !== scope.sessionId ||
        invocation.toolName !== name
      ) {
        scope.note(`tool ${name} refused`);
        return Promise.resolve(failure("invocation-refused"));
      }
      const execution = handler(args, invocation);
      const pending = execution.then(
        (result) => {
          scope.note(`tool ${name} ${result.resultType}`);
        },
        () => {
          scope.note(`tool ${name} failure`);
        },
      );
      scope.pending.add(pending);
      void pending.finally(() => scope.pending.delete(pending));
      return execution;
    },
  });
}

function derivedIdentity(
  prefix: "request" | "submission" | "attempt",
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
  label = "arguments",
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalidArguments(`${label} must be an object`);
  const object = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    return invalidArguments(
      `${label} has unexpected ${unexpected.join(", ")}; allowed are ${[...allowed].join(", ")}`,
    );
  }
  const missing = required.filter((key) => !Object.hasOwn(object, key));
  if (missing.length > 0) return invalidArguments(`${label} is missing ${missing.join(", ")}`);
  return object;
}

/** A model routinely hands a nested object back as encoded JSON, which is not a mistake worth a turn. */
function decodedObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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

function invalidArguments(detail = "arguments do not match the tool schema"): never {
  throw new TypeError(`Invalid tool arguments: ${detail}`);
}

function success(value: unknown): CopilotSdkToolResult {
  return Object.freeze({ resultType: "success", textResultForLlm: JSON.stringify(value) });
}

function failure(code: string, detail?: string): CopilotSdkToolResult {
  return Object.freeze({
    resultType: "failure",
    textResultForLlm: JSON.stringify({
      status: "failed",
      code,
      ...(detail === undefined ? {} : { detail }),
    }),
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
const WORKSPACE_PATH_SCHEMA = stringSchema(PROTOCOL_LIMITS.maxStringLength);
const WORKSPACE_CONTENT_SCHEMA = stringSchema(WORKSPACE_FILE_LIMITS.maxFileBytes, 0);
const OUTPUT_SCHEMA_SCHEMA = closedObject({ output: { type: "string", maxLength: 128 } }, []);
const WORKSPACE_LIST_SCHEMA = closedObject(
  {
    path: WORKSPACE_PATH_SCHEMA,
    maxEntries: {
      type: "integer",
      minimum: 1,
      maximum: WORKSPACE_FILE_LIMITS.maxListEntries,
    },
  },
  ["path"],
);
const WORKSPACE_READ_SCHEMA = closedObject(
  {
    path: WORKSPACE_PATH_SCHEMA,
    maxBytes: { type: "integer", minimum: 1, maximum: WORKSPACE_FILE_LIMITS.maxFileBytes },
  },
  ["path"],
);
const WORKSPACE_WRITE_SCHEMA = closedObject(
  { path: WORKSPACE_PATH_SCHEMA, content: WORKSPACE_CONTENT_SCHEMA },
  ["path", "content"],
);
const WORKSPACE_PATCH_CHANGE_SCHEMA = closedObject(
  {
    path: WORKSPACE_PATH_SCHEMA,
    expectedText: WORKSPACE_CONTENT_SCHEMA,
    replacementText: WORKSPACE_CONTENT_SCHEMA,
  },
  ["path", "expectedText", "replacementText"],
);
const WORKSPACE_PATCH_SCHEMA = closedObject(
  {
    changes: {
      type: "array",
      minItems: 1,
      maxItems: WORKSPACE_FILE_LIMITS.maxPatchChanges,
      items: WORKSPACE_PATCH_CHANGE_SCHEMA,
    },
  },
  ["changes"],
);
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
    completionEvidence: {
      type: "array",
      maxItems: WORKER_PROTOCOL_LIMITS.maxCompletionItems,
      items: EVIDENCE_SCHEMA,
    },
  },
  ["disposition", "summary", "criteria", "completionEvidence"],
);
