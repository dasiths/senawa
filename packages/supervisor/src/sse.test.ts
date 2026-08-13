import { EventEmitter } from "node:events";
import {
  canonicalStringify,
  type EventReplayPage,
  type EventStreamFrame,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import { InMemoryRunEventNotifier } from "./run-event-notifier.js";
import { SseEventSource, type SseTimer, type SseWritable } from "./sse.js";

describe("supervisor SSE source", () => {
  it("subscribes before replay and catches an event committed during the first query", async () => {
    const notifier = new InMemoryRunEventNotifier();
    let queryCount = 0;
    const controller = new AbortController();
    const response = new FakeResponse(() => controller.abort());
    const source = new SseEventSource({
      notifier,
      api: {
        listEvents() {
          queryCount += 1;
          if (queryCount === 1) {
            notifier.notify("repository_a", "run_a");
            return page(0, []);
          }
          return page(3, [event(3)]);
        },
      },
    });

    await source.stream(streamRequest(response, controller.signal));

    expect(queryCount).toBe(2);
    expect(response.frames).toEqual([
      `id: 3\nevent: phase-started\ndata: ${canonicalStringify(event(3))}\n\n`,
    ]);
  });

  it("emits a canonical typed gap and closes", async () => {
    const response = new FakeResponse();
    const source = new SseEventSource({
      notifier: new InMemoryRunEventNotifier(),
      api: {
        listEvents() {
          throw Object.assign(new Error("private storage detail"), { code: "event-replay-gap" });
        },
      },
    });

    await source.stream(streamRequest(response, new AbortController().signal));

    expect(response.frames).toHaveLength(1);
    expect(response.frames[0]).toContain("event: gap\n");
    expect(response.frames[0]).not.toContain("private storage detail");
    expect(response.ended).toBe(true);
  });

  it("injects a cursor-free heartbeat while idle", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const response = new FakeResponse(() => controller.abort());
    const source = new SseEventSource({
      notifier: new InMemoryRunEventNotifier(),
      timer,
      api: { listEvents: () => page(0, []) },
    });

    const streaming = source.stream(streamRequest(response, controller.signal));
    await settle();
    timer.fireNext();
    await streaming;

    expect(response.frames).toEqual([": heartbeat\n\n"]);
  });

  it("retains one queued frame until drain and closes on a bounded stall", async () => {
    const timer = new FakeTimer();
    const response = new FakeResponse(undefined, false);
    let queryCount = 0;
    const source = new SseEventSource({
      notifier: new InMemoryRunEventNotifier(),
      timer,
      maxStallMs: 30_000,
      api: {
        listEvents() {
          queryCount += 1;
          return page(8, [event(8)]);
        },
      },
    });

    const streaming = source.stream(streamRequest(response, new AbortController().signal));
    await settle();
    expect(queryCount).toBe(1);
    expect(response.frames).toHaveLength(1);
    timer.fireNext();
    await streaming;

    expect(queryCount).toBe(1);
    expect(response.ended).toBe(true);
  });
});

class FakeResponse extends EventEmitter implements SseWritable {
  readonly frames: string[] = [];
  readonly #afterWrite: (() => void) | undefined;
  readonly #writeResult: boolean;
  ended = false;

  constructor(afterWrite?: () => void, writeResult = true) {
    super();
    this.#afterWrite = afterWrite;
    this.#writeResult = writeResult;
  }

  write(chunk: string): boolean {
    this.frames.push(chunk);
    this.#afterWrite?.();
    return this.#writeResult;
  }

  end(): void {
    this.ended = true;
  }

  override once(event: "drain", callback: () => void): this {
    return super.once(event, callback);
  }

  override off(event: "drain", callback: () => void): this {
    return super.off(event, callback);
  }
}

class FakeTimer implements SseTimer {
  readonly callbacks: (() => void)[] = [];

  set(callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }

  clear(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index !== -1) this.callbacks.splice(index, 1);
  }

  fireNext(): void {
    const callback = this.callbacks.shift();
    if (callback === undefined) throw new Error("No timer is pending");
    callback();
  }
}

function streamRequest(response: SseWritable, signal: AbortSignal) {
  return {
    repositoryId: "repository_a",
    runId: "run_a",
    afterCursor: 0,
    signal,
    response,
  };
}

function page(latestCursor: number, events: readonly EventStreamFrame[]): EventReplayPage {
  return {
    apiVersion: PROTOCOL_VERSION,
    repositoryId: "repository_a",
    runId: "run_a",
    afterCursor: 0,
    earliestAvailableCursor: events[0]?.cursor ?? 0,
    latestCursor,
    hasMore: false,
    events,
  };
}

function event(cursor: number): EventStreamFrame {
  return {
    apiVersion: PROTOCOL_VERSION,
    cursor,
    repositoryId: "repository_a",
    runId: "run_a",
    eventId: `event_${cursor}`,
    eventType: "phase-started",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: { value: cursor },
    payloadDigest: "0".repeat(64),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
