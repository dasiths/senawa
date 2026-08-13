import {
  canonicalStringify,
  type ErrorEnvelope,
  type EventReplayPage,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { SupervisorApi } from "./api.js";
import type { RunEventNotifier } from "./contracts.js";

const EVENT_TYPE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SSE_PAGE_LIMIT = 256;

export interface SseWritable {
  write(chunk: string): boolean;
  end(): void;
  once(event: "drain", callback: () => void): this;
  off(event: "drain", callback: () => void): this;
}

export interface SseTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface SseEventSourceOptions {
  readonly api: Pick<SupervisorApi, "listEvents">;
  readonly notifier: RunEventNotifier;
  readonly timer?: SseTimer;
  readonly heartbeatMs?: number;
  readonly maxStallMs?: number;
  readonly stopped?: () => boolean;
}

export interface SseStreamRequest {
  readonly repositoryId: string;
  readonly runId: string;
  readonly afterCursor: number;
  readonly signal: AbortSignal;
  readonly response: SseWritable;
  readonly authorized?: () => boolean;
}

export class SseEventSource {
  readonly #api: Pick<SupervisorApi, "listEvents">;
  readonly #notifier: RunEventNotifier;
  readonly #timer: SseTimer;
  readonly #heartbeatMs: number;
  readonly #maxStallMs: number;
  readonly #stopped: () => boolean;

  constructor(options: SseEventSourceOptions) {
    this.#api = options.api;
    this.#notifier = options.notifier;
    this.#timer = options.timer ?? nodeTimer;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#maxStallMs = options.maxStallMs ?? 30_000;
    this.#stopped = options.stopped ?? (() => false);
  }

  async stream(request: SseStreamRequest): Promise<void> {
    let cursor = request.afterCursor;
    let wakeGeneration = 0;
    let wake: (() => void) | undefined;
    const unsubscribe = this.#notifier.subscribe(request.repositoryId, request.runId, () => {
      wakeGeneration += 1;
      wake?.();
    });
    try {
      while (!request.signal.aborted && !this.#stopped() && this.#authorized(request)) {
        const queryGeneration = wakeGeneration;
        let page: EventReplayPage;
        try {
          page = this.#api.listEvents({
            repositoryId: request.repositoryId,
            runId: request.runId,
            afterCursor: cursor,
            limit: SSE_PAGE_LIMIT,
          });
        } catch (error) {
          if (isReplayGap(error)) {
            await this.#write(request, gapFrame());
            return;
          }
          throw error;
        }
        for (const event of page.events) {
          if (!EVENT_TYPE_PATTERN.test(event.eventType))
            throw new Error("Stored event type is invalid");
          if (!(await this.#write(request, eventFrame(event.cursor, event.eventType, event))))
            return;
          cursor = event.cursor;
        }
        if (request.signal.aborted || this.#stopped() || !this.#authorized(request)) return;
        if (page.hasMore || wakeGeneration !== queryGeneration) continue;
        const reason = await new Promise<"wake" | "heartbeat" | "abort">((resolve) => {
          let settled = false;
          const finish = (value: "wake" | "heartbeat" | "abort") => {
            if (settled) return;
            settled = true;
            this.#timer.clear(timerHandle);
            request.signal.removeEventListener("abort", onAbort);
            wake = undefined;
            resolve(value);
          };
          const onAbort = () => finish("abort");
          wake = () => finish("wake");
          const timerHandle = this.#timer.set(() => finish("heartbeat"), this.#heartbeatMs);
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) finish("abort");
          if (wakeGeneration !== queryGeneration) finish("wake");
        });
        if (reason === "abort") return;
        if (reason === "heartbeat" && !(await this.#write(request, ": heartbeat\n\n"))) return;
      }
    } finally {
      unsubscribe();
      request.response.end();
    }
  }

  async #write(request: SseStreamRequest, frame: string): Promise<boolean> {
    if (request.signal.aborted || this.#stopped() || !this.#authorized(request)) return false;
    if (request.response.write(frame)) return true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        this.#timer.clear(stallHandle);
        request.signal.removeEventListener("abort", onAbort);
        request.response.off("drain", onDrain);
        resolve(value);
      };
      const onDrain = () => finish(true);
      const onAbort = () => finish(false);
      const stallHandle = this.#timer.set(() => finish(false), this.#maxStallMs);
      request.response.once("drain", onDrain);
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #authorized(request: SseStreamRequest): boolean {
    return request.authorized?.() ?? true;
  }
}

function eventFrame(cursor: number, eventType: string, event: unknown): string {
  return `id: ${cursor}\nevent: ${eventType}\ndata: ${canonicalStringify(event)}\n\n`;
}

function gapFrame(): string {
  const error: ErrorEnvelope = {
    apiVersion: PROTOCOL_VERSION,
    code: "event-replay-gap",
    message: "Event cursor precedes the available replay range",
    retryable: false,
  };
  return `event: gap\ndata: ${canonicalStringify(error)}\n\n`;
}

function isReplayGap(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code: unknown }).code === "event-replay-gap"
  );
}

const nodeTimer: SseTimer = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
