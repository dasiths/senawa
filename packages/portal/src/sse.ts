import {
  decodeErrorEnvelope,
  decodeEventStreamFrame,
  type EventStreamFrame,
} from "@senawa/protocol";

export interface PortalSseModel {
  readonly cursor: number;
  readonly events: readonly EventStreamFrame[];
}

export type PortalSseTransition =
  | { readonly type: "duplicate"; readonly model: PortalSseModel }
  | { readonly type: "accepted"; readonly model: PortalSseModel };

export function acceptSseFrame(
  model: PortalSseModel,
  input: string | unknown,
): PortalSseTransition {
  const event = decodeEventStreamFrame(input);
  if (event.cursor <= model.cursor) return Object.freeze({ type: "duplicate", model });
  return Object.freeze({
    type: "accepted",
    model: Object.freeze({
      cursor: event.cursor,
      events: Object.freeze([...model.events, event].slice(-500)),
    }),
  });
}

export function reconnectDelay(attempt: number, randomValue: number): number {
  const boundedAttempt = Math.max(0, Math.min(8, Math.floor(attempt)));
  const boundedRandom = Math.max(0, Math.min(1, randomValue));
  const base = Math.min(30_000, 500 * 2 ** boundedAttempt);
  return Math.floor(base * (0.75 + boundedRandom * 0.5));
}

interface EventSourceEvent {
  readonly data: string;
}

interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: EventSourceEvent) => void) | null;
  addEventListener(type: string, listener: (event: EventSourceEvent) => void): void;
  close(): void;
}

export interface PortalEventStreamOptions {
  readonly create: (url: string) => EventSourceLike;
  readonly onOpen: () => void;
  readonly onFrame: (frame: EventStreamFrame) => void;
  readonly onGap: (message: string) => void;
  readonly onReconnect: (attempt: number) => boolean | undefined | Promise<boolean | undefined>;
  readonly eventTypes?: readonly string[];
  readonly random?: () => number;
  readonly schedule?: (callback: () => void, delay: number) => number;
  readonly cancel?: (handle: number) => void;
}

const DEFAULT_EVENT_TYPES = Object.freeze([
  "run-instantiated",
  "command-queued",
  "command-completed",
  "command-refused",
  "phase-started",
  "phase-closed",
  "amendment-proposed",
  "amendment-decision-recorded",
  "run-paused",
  "run-resumed",
  "run-ending",
  "run-ended",
]);

export class PortalEventStream {
  readonly #options: PortalEventStreamOptions;
  #source: EventSourceLike | undefined;
  #url: string | undefined;
  #cursor = 0;
  #attempt = 0;
  #timer: number | undefined;
  #closed = false;
  #generation = 0;

  constructor(options: PortalEventStreamOptions) {
    this.#options = options;
  }

  open(repositoryId: string, runId: string, afterCursor: number): void {
    this.close();
    this.#closed = false;
    this.#cursor = afterCursor;
    this.#attempt = 0;
    this.#url = `/api/v1alpha1/repositories/${encodeURIComponent(repositoryId)}/runs/${encodeURIComponent(runId)}/events/stream`;
    this.#connect(this.#generation);
  }

  close(): void {
    this.#generation += 1;
    this.#closed = true;
    this.#source?.close();
    this.#source = undefined;
    if (this.#timer !== undefined) (this.#options.cancel ?? clearTimeout)(this.#timer);
    this.#timer = undefined;
  }

  #connect(generation: number): void {
    if (this.#closed || this.#url === undefined || generation !== this.#generation) return;
    const separator = this.#url.includes("?") ? "&" : "?";
    const source = this.#options.create(`${this.#url}${separator}after=${this.#cursor}`);
    this.#source = source;
    source.onopen = () => {
      if (generation !== this.#generation || this.#source !== source) return;
      this.#attempt = 0;
      this.#options.onOpen();
    };
    const receive = (event: EventSourceEvent) => {
      if (generation !== this.#generation || this.#source !== source) return;
      try {
        const frame = decodeEventStreamFrame(event.data);
        if (frame.cursor <= this.#cursor) return;
        this.#cursor = frame.cursor;
        this.#options.onFrame(frame);
      } catch {
        // Malformed and unknown data cannot mutate the client model.
      }
    };
    source.onmessage = receive;
    for (const eventType of this.#options.eventTypes ?? DEFAULT_EVENT_TYPES) {
      source.addEventListener(eventType, receive);
    }
    source.addEventListener("gap", (event) => {
      source.close();
      if (generation !== this.#generation || this.#source !== source) return;
      this.#source = undefined;
      try {
        this.#options.onGap(decodeErrorEnvelope(event.data).message);
      } catch {
        this.#options.onGap("Event replay gap requires a full resynchronization");
      }
    });
    source.onerror = () => {
      source.close();
      if (generation !== this.#generation || this.#source !== source) return;
      this.#source = undefined;
      this.#scheduleReconnect(generation);
    };
  }

  #scheduleReconnect(generation: number): void {
    if (this.#closed || this.#timer !== undefined || generation !== this.#generation) return;
    this.#attempt += 1;
    const attempt = this.#attempt;
    const delay = reconnectDelay(attempt, (this.#options.random ?? Math.random)());
    this.#timer = (this.#options.schedule ?? window.setTimeout)(() => {
      if (this.#closed || generation !== this.#generation) return;
      this.#timer = undefined;
      void Promise.resolve(this.#options.onReconnect(attempt)).then(
        (allowed) => {
          if (this.#closed || generation !== this.#generation) return;
          if (allowed === false) this.#scheduleReconnect(generation);
          else this.#connect(generation);
        },
        () => this.#scheduleReconnect(generation),
      );
    }, delay);
  }
}
