import { canonicalStringify, type EventStreamFrame, PROTOCOL_VERSION } from "@senawa/protocol";
import { describe, expect, it, vi } from "vitest";
import { acceptSseFrame, PortalEventStream, reconnectDelay } from "./sse.js";

const frame: EventStreamFrame = {
  apiVersion: PROTOCOL_VERSION,
  cursor: 4,
  repositoryId: "repository_one",
  runId: "run_one",
  eventId: "event_four",
  eventType: "run-paused",
  occurredAt: "2026-08-14T12:00:00.000Z",
  payload: { mode: "paused" },
  payloadDigest: "a".repeat(64),
};

describe("portal SSE model", () => {
  it("deduplicates cursors and keeps unknown typed frames inert but visible", () => {
    const initial = { cursor: 0, events: [] } as const;
    const accepted = acceptSseFrame(initial, frame);
    expect(accepted.type).toBe("accepted");
    expect(accepted.model.events).toEqual([frame]);
    expect(acceptSseFrame(accepted.model, { ...frame, eventType: "future-event" }).type).toBe(
      "duplicate",
    );
  });

  it("uses bounded exponential jitter", () => {
    expect(reconnectDelay(0, 0)).toBe(375);
    expect(reconnectDelay(8, 1)).toBeLessThanOrEqual(37_500);
    expect(reconnectDelay(99, 1)).toBe(reconnectDelay(8, 1));
  });

  it("owns reconnect cursors and stops reconnecting on a typed gap", async () => {
    const sources: FakeEventSource[] = [];
    const scheduled: (() => void)[] = [];
    const onGap = vi.fn();
    const stream = new PortalEventStream({
      create: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      onOpen: vi.fn(),
      onFrame: vi.fn(),
      onGap,
      onReconnect: vi.fn(),
      eventTypes: ["run-paused"],
      random: () => 0.5,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: vi.fn(),
    });
    stream.open("repository_one", "run_one", 3);
    expect(sources[0]?.url).toContain("after=3");
    sources[0]?.emit("run-paused", canonicalStringify(frame));
    sources[0]?.fail();
    scheduled[0]?.();
    await Promise.resolve();
    expect(sources[1]?.url).toContain("after=4");
    sources[1]?.emit(
      "gap",
      canonicalStringify({
        apiVersion: PROTOCOL_VERSION,
        code: "event-replay-gap",
        message: "gap",
        retryable: false,
      }),
    );
    expect(onGap).toHaveBeenCalledWith("gap");
    expect(sources[1]?.closed).toBe(true);
  });

  it("retries a failed reconnect preflight and ignores stale source errors", async () => {
    const sources: FakeEventSource[] = [];
    const scheduled: (() => void)[] = [];
    const onReconnect = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const stream = new PortalEventStream({
      create: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      onOpen: vi.fn(),
      onFrame: vi.fn(),
      onGap: vi.fn(),
      onReconnect,
      random: () => 0.5,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: vi.fn(),
    });
    stream.open("repository_one", "run_one", 9);
    sources[0]?.fail();
    sources[0]?.fail();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(2);
    expect(sources).toHaveLength(1);
    scheduled[1]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sources[1]?.url).toContain("after=9");
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("invalidates an in-flight reconnect preflight when another run opens", async () => {
    const sources: FakeEventSource[] = [];
    const scheduled: (() => void)[] = [];
    let resolvePreflight: ((allowed: boolean) => void) | undefined;
    const stream = new PortalEventStream({
      create: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      onOpen: vi.fn(),
      onFrame: vi.fn(),
      onGap: vi.fn(),
      onReconnect: () =>
        new Promise<boolean>((resolvePromise) => {
          resolvePreflight = resolvePromise;
        }),
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: vi.fn(),
    });
    stream.open("repository_one", "run_one", 2);
    sources[0]?.fail();
    scheduled[0]?.();
    await Promise.resolve();
    stream.open("repository_two", "run_two", 7);
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toContain("run_two/events/stream?after=7");
    resolvePreflight?.(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(sources).toHaveLength(2);
    expect(scheduled).toHaveLength(1);
  });

  it("ignores a stale queued reconnect timer after another run opens", async () => {
    const sources: FakeEventSource[] = [];
    const scheduled: (() => void)[] = [];
    const onReconnect = vi.fn();
    const stream = new PortalEventStream({
      create: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      onOpen: vi.fn(),
      onFrame: vi.fn(),
      onGap: vi.fn(),
      onReconnect,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: vi.fn(),
    });
    stream.open("repository_one", "run_one", 2);
    sources[0]?.fail();
    stream.open("repository_two", "run_two", 7);
    scheduled[0]?.();
    await Promise.resolve();
    expect(onReconnect).not.toHaveBeenCalled();
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toContain("run_two/events/stream?after=7");
  });
});

class FakeEventSource {
  readonly url: string;
  readonly listeners = new Map<string, (event: { readonly data: string }) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { readonly data: string }) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: { readonly data: string }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data });
  }
  fail(): void {
    this.onerror?.();
  }
}
