import {
  type AgentSessionResumeBinding,
  type AgentSessionScope,
  validateAgentSessionResumeBinding,
  validateWorkerModelRouteSelection,
  type WorkerModelRouteSelection,
} from "@senawa/kernel";
import { canonicalBytes, type JsonValue, WORKER_PROTOCOL_LIMITS } from "@senawa/protocol";
import {
  type AgentTranscriptPort,
  type AsyncEffectHost,
  type AsyncEffectHostContext,
  type ContextBrokerClient,
  type EffectInspection,
  type EffectIntent,
  type EffectObservation,
  type RuntimeSchemaContract,
  type StoredDispatch,
  WORKER_CAPABILITIES,
} from "@senawa/runtime";
import type { CopilotSdkPort } from "./copilot-sdk-port.js";
import { CopilotSerialWorkerAdapter, type CopilotWorkerRunResult } from "./copilot-worker.js";
import type { WorkspaceFilePort } from "./workspace-files.js";

const MAX_TIMER_MILLISECONDS = 2_147_483_647;

export interface CopilotWorkerGrantPolicy {
  readonly expiresAfterMs: number;
  readonly maxOperations: number;
  readonly maxBytes: number;
  readonly maxChunkBytes: number;
}

export interface CopilotWorkerEffectInput {
  readonly dispatchId: string;
  readonly routeSelection: WorkerModelRouteSelection;
  readonly timeoutMs: number;
  readonly grantPolicy: CopilotWorkerGrantPolicy;
  /** The conversation this dispatch continues, when its agent declared one. */
  readonly sessionResume?: Readonly<{
    readonly scope: AgentSessionScope;
    readonly requestedBinding: AgentSessionResumeBinding;
    readonly authorizedBinding: AgentSessionResumeBinding;
  }>;
}

export interface PhaseOutputSchemaResolverPort {
  /** Resolves accepted output schema contracts for one dispatch, keyed by declared output name. */
  resolve(stored: StoredDispatch): ReadonlyMap<string, RuntimeSchemaContract>;
}

export interface CopilotWorkerEffectHostOptions {
  readonly broker: ContextBrokerClient;
  readonly sdk: CopilotSdkPort;
  readonly workingDirectory: string;
  readonly sessionBaseDirectory?: string;
  readonly workspaceFiles?: WorkspaceFilePort;
  readonly phaseOutputSchemas?: PhaseOutputSchemaResolverPort;
  readonly transcript?: AgentTranscriptPort;
}

export class CopilotWorkerEffectHost implements AsyncEffectHost {
  readonly broker: ContextBrokerClient;
  readonly sdk: CopilotSdkPort;
  readonly adapter: CopilotSerialWorkerAdapter;
  readonly workingDirectory: string;
  readonly sessionBaseDirectory: string | undefined;
  readonly workspaceFiles: WorkspaceFilePort | undefined;
  readonly phaseOutputSchemas: PhaseOutputSchemaResolverPort | undefined;
  readonly transcript: AgentTranscriptPort | undefined;
  readonly #active = new Map<
    string,
    { readonly abort: AbortController; readonly settled: Promise<unknown> }
  >();

  constructor(options: CopilotWorkerEffectHostOptions) {
    this.broker = options.broker;
    this.sdk = options.sdk;
    this.adapter = new CopilotSerialWorkerAdapter(options.sdk, options.broker.dependencies.sha256);
    this.workingDirectory = options.workingDirectory;
    this.sessionBaseDirectory = options.sessionBaseDirectory;
    this.workspaceFiles = options.workspaceFiles;
    this.phaseOutputSchemas = options.phaseOutputSchemas;
    this.transcript = options.transcript;
  }

  async dispatch(
    intent: EffectIntent,
    context: AsyncEffectHostContext,
  ): Promise<EffectObservation> {
    const { input, stored } = this.loadBoundWorker(intent);
    const grantTokens = new Map<string, string>();
    if (stored.dispatch.capabilities.includes(WORKER_CAPABILITIES.assetRead)) {
      const expiresAt = addMilliseconds(
        this.broker.dependencies.currentTime(),
        input.grantPolicy.expiresAfterMs,
      );
      for (const asset of stored.context.assets) {
        const grant = this.broker.grantAssetAccess({
          repositoryId: stored.dispatch.repositoryId,
          runId: stored.dispatch.runId,
          dispatchId: stored.dispatch.dispatchId,
          assetBindingId: asset.assetBindingId,
          allowedPointer: "",
          readMode: "pointer-and-chunk",
          sensitivityCeiling: asset.sensitivity,
          expiresAt,
          maxOperations: input.grantPolicy.maxOperations,
          maxBytes: input.grantPolicy.maxBytes,
          maxChunkBytes: input.grantPolicy.maxChunkBytes,
        });
        grantTokens.set(asset.assetBindingId, grant.grantToken);
      }
    }

    const localAbort = new AbortController();
    const run = this.adapter.run({
      context: stored.context,
      dispatch: stored.dispatch,
      routeSelection: input.routeSelection,
      broker: this.broker,
      grantTokens,
      workingDirectory: this.workingDirectory,
      ...(this.sessionBaseDirectory === undefined
        ? {}
        : { sessionBaseDirectory: this.sessionBaseDirectory }),
      ...(this.workspaceFiles === undefined ? {} : { workspaceFiles: this.workspaceFiles }),
      ...(this.phaseOutputSchemas === undefined
        ? {}
        : { phaseOutputSchemas: this.phaseOutputSchemas.resolve(stored) }),
      ...(this.transcript === undefined ? {} : { transcript: this.transcript }),
      ...(input.sessionResume === undefined ? {} : { sessionResume: input.sessionResume }),
      timeoutMs: input.timeoutMs,
      signal: AbortSignal.any([context.signal, localAbort.signal]),
    });
    // Cancellation reports a terminal outcome, and the driver starts the next
    // attempt on one. It must not be able to do that while this worker can still
    // submit, so cancel waits on the same promise this returns.
    this.#active.set(input.dispatchId, {
      abort: localAbort,
      settled: run.catch(() => undefined),
    });
    try {
      return this.resultObservation(await run);
    } finally {
      this.#active.delete(input.dispatchId);
      grantTokens.clear();
    }
  }

  async inspect(intent: EffectIntent, _context: AsyncEffectHostContext): Promise<EffectInspection> {
    const { input } = this.loadBoundWorker(intent);
    const progress = this.broker.loadWorkerDispatchProgress(input.dispatchId);
    if (progress?.completionStatus === "accepted") {
      return {
        status: "completed",
        observedAt: this.broker.dependencies.currentTime(),
        details: { dispatchId: input.dispatchId, completionStatus: "accepted" },
        outputDigest: this.digest({ dispatchId: input.dispatchId, completionStatus: "accepted" }),
      };
    }
    const metadataExists = await this.sdk.sessionMetadataExists?.(input.dispatchId);
    return {
      status: metadataExists === true ? "active" : "unknown",
      observedAt: this.broker.dependencies.currentTime(),
      details: {
        dispatchId: input.dispatchId,
        reason: metadataExists === true ? "sdk-session-present" : "dispatch-state-uncertain",
      },
    };
  }

  async cancel(intent: EffectIntent, _context: AsyncEffectHostContext): Promise<EffectObservation> {
    const { input } = this.loadBoundWorker(intent);
    const active = this.#active.get(input.dispatchId);
    if (active !== undefined) {
      active.abort.abort();
      // Aborting only asks the turn to stop. Reporting it over before it is
      // lets the next attempt take the task scope over while this worker still
      // has tool calls in flight, and everything it then submits is refused as
      // stale.
      await active.settled;
      return {
        status: "cancelled",
        observedAt: this.broker.dependencies.currentTime(),
        details: { dispatchId: input.dispatchId, reason: "active-session-aborted" },
      };
    }
    const aborted = (await this.sdk.abortSession?.(input.dispatchId)) ?? false;
    return {
      status: aborted ? "cancelled" : "unknown",
      observedAt: this.broker.dependencies.currentTime(),
      details: {
        dispatchId: input.dispatchId,
        reason: aborted ? "sdk-session-aborted" : "dispatch-state-uncertain",
      },
    };
  }

  private resultObservation(result: CopilotWorkerRunResult): EffectObservation {
    const progress = this.broker.loadWorkerDispatchProgress(result.dispatchId);
    const acceptedCompletion = progress?.completionStatus === "accepted";
    // Only an accepted completion finishes a turn. Every other ending is a spent
    // attempt, which the authored attempt ceiling exists to bound. Reporting any
    // of them as failed fences the task for good, and a fenced task ends the run:
    // a turn that stopped to ask, a turn that submitted nothing, and a turn whose
    // session died when the supervisor restarted each killed a live run that way.
    const status =
      (result.status === "completed" || result.status === "blocked") && acceptedCompletion
        ? "completed"
        : "cancelled";
    const details: JsonValue = {
      dispatchId: result.dispatchId,
      workerStatus: result.status,
      completionStatus: acceptedCompletion ? "accepted" : "missing",
      submissionIds: result.submissions.map(({ submissionId }) => submissionId),
      ...(result.transcriptRefusals === undefined
        ? {}
        : { transcriptRefusals: result.transcriptRefusals }),
    };
    return {
      status,
      observedAt: this.broker.dependencies.currentTime(),
      details,
      outputDigest: this.digest(details),
    };
  }

  private digest(value: JsonValue): string {
    return this.broker.dependencies.sha256.digest(canonicalBytes(value));
  }

  private loadBoundWorker(intent: EffectIntent) {
    if (intent.command.kind !== "worker") {
      throw new TypeError("Copilot worker host only accepts worker effects");
    }
    const input = decodeCopilotWorkerEffectInput(intent.command.input, this.broker);
    const stored = this.broker.loadWorkerDispatch(input.dispatchId);
    if (stored === undefined) throw new TypeError("Worker effect dispatch is not registered");
    if (
      stored.dispatch.dispatchId !== input.dispatchId ||
      stored.dispatch.repositoryId !== intent.command.repositoryId ||
      stored.dispatch.runId !== intent.command.runId ||
      stored.context.contextDigest !== intent.command.contextDigest ||
      stored.dispatch.contextDigest !== intent.command.contextDigest
    ) {
      throw new TypeError("Worker effect intent does not match its registered dispatch authority");
    }
    return { input, stored };
  }
}

export function decodeCopilotWorkerEffectInput(
  value: unknown,
  broker: ContextBrokerClient,
): CopilotWorkerEffectInput {
  assertExactObject(
    value,
    ["dispatchId", "routeSelection", "timeoutMs", "grantPolicy"],
    ["sessionResume"],
  );
  if (typeof value.dispatchId !== "string" || value.dispatchId.length === 0) {
    throw new TypeError("Copilot worker effect dispatchId must be non-empty");
  }
  const stored = broker.loadWorkerDispatch(value.dispatchId);
  if (stored === undefined) throw new TypeError("Copilot worker effect dispatch is not registered");
  const routeSelection = validateWorkerModelRouteSelection(
    value.routeSelection,
    stored.context,
    stored.dispatch,
    broker.dependencies.sha256,
  );
  const timeoutMs = positiveTimer(value.timeoutMs, "timeoutMs");
  assertExactObject(value.grantPolicy, [
    "expiresAfterMs",
    "maxOperations",
    "maxBytes",
    "maxChunkBytes",
  ]);
  const grantPolicy = {
    expiresAfterMs: positiveTimer(value.grantPolicy.expiresAfterMs, "expiresAfterMs"),
    maxOperations: positiveInteger(value.grantPolicy.maxOperations, "maxOperations"),
    maxBytes: positiveInteger(value.grantPolicy.maxBytes, "maxBytes"),
    maxChunkBytes: positiveInteger(value.grantPolicy.maxChunkBytes, "maxChunkBytes"),
  };
  if (grantPolicy.maxOperations > WORKER_PROTOCOL_LIMITS.maxGrantOperations) {
    throw new TypeError("Copilot worker grant operation budget exceeds protocol limits");
  }
  if (grantPolicy.maxBytes > WORKER_PROTOCOL_LIMITS.maxGrantBytes) {
    throw new TypeError("Copilot worker grant byte budget exceeds protocol limits");
  }
  if (grantPolicy.maxChunkBytes > WORKER_PROTOCOL_LIMITS.maxAssetReadBytes) {
    throw new TypeError("Copilot worker grant chunk budget exceeds protocol limits");
  }
  if (grantPolicy.expiresAfterMs <= timeoutMs) {
    throw new TypeError("Copilot worker grants must outlive the operation timeout");
  }
  if (grantPolicy.maxChunkBytes > grantPolicy.maxBytes) {
    throw new TypeError("Copilot worker grant chunk budget must not exceed total bytes");
  }
  const sessionResume =
    value.sessionResume === undefined
      ? undefined
      : decodeSessionResume(value.sessionResume, broker.dependencies.sha256);
  return Object.freeze({
    dispatchId: value.dispatchId,
    routeSelection,
    timeoutMs,
    grantPolicy,
    ...(sessionResume === undefined ? {} : { sessionResume }),
  });
}

function decodeSessionResume(
  value: unknown,
  sha256: Parameters<typeof validateAgentSessionResumeBinding>[1],
): CopilotWorkerEffectInput["sessionResume"] {
  assertExactObject(value, ["scope", "requestedBinding", "authorizedBinding"]);
  if (value.scope !== "attempt" && value.scope !== "phase" && value.scope !== "run") {
    throw new TypeError("Copilot worker effect session scope must be attempt, phase, or run");
  }
  return Object.freeze({
    scope: value.scope,
    requestedBinding: validateAgentSessionResumeBinding(value.requestedBinding, sha256),
    authorizedBinding: validateAgentSessionResumeBinding(value.authorizedBinding, sha256),
  });
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Copilot worker effect input must be an object");
  }
  const actual = Object.keys(value).sort();
  const permitted = new Set([...keys, ...optional]);
  if (actual.some((key) => !permitted.has(key))) {
    throw new TypeError("Copilot worker effect input contains unexpected fields");
  }
  const missing = keys.filter((key) => !actual.includes(key));
  if (missing.length > 0) {
    throw new TypeError("Copilot worker effect input contains unexpected fields");
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function positiveTimer(value: unknown, field: string): number {
  const integer = positiveInteger(value, field);
  if (integer > MAX_TIMER_MILLISECONDS) throw new TypeError(`${field} exceeds timer limits`);
  return integer;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch))
    throw new TypeError("Context broker current time must be a timestamp");
  return new Date(epoch + milliseconds).toISOString();
}
