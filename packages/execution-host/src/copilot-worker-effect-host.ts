import { validateWorkerModelRouteSelection, type WorkerModelRouteSelection } from "@senawa/kernel";
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
  readonly #active = new Map<string, AbortController>();

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
    this.#active.set(input.dispatchId, localAbort);
    try {
      const result = await this.adapter.run({
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
        timeoutMs: input.timeoutMs,
        signal: AbortSignal.any([context.signal, localAbort.signal]),
      });
      return this.resultObservation(result);
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
      active.abort();
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
    const status =
      result.status === "aborted"
        ? "cancelled"
        : (result.status === "completed" || result.status === "blocked") && acceptedCompletion
          ? "completed"
          : "failed";
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
  assertExactObject(value, ["dispatchId", "routeSelection", "timeoutMs", "grantPolicy"]);
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
  return Object.freeze({ dispatchId: value.dispatchId, routeSelection, timeoutMs, grantPolicy });
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Copilot worker effect input must be an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
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
