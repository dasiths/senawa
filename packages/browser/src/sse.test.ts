import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunChangeNotificationPort } from "@senawa/application";
import { describe, expect, it, vi } from "vitest";
import { beginSse } from "./sse.js";

describe("SSE transport", () => {
  it("waits for writable drain before sending the next record and cleans up on close", async () => {
    const request = new EventEmitter();
    const response = new FakeResponse();
    const notifier = new TestNotifier();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    beginSse(request as IncomingMessage, response as unknown as ServerResponse, {
      runId: "backpressure-run",
      initialCursor: 0,
      notifier,
      read: async () => [{ seq: 1 }, { seq: 2 }],
      prepareHeaders: () => undefined,
      durablePollMs: 60_000,
      heartbeatMs: 60_000,
    });

    await expect.poll(() => response.frames.some((frame) => frame.startsWith("id: 1"))).toBe(true);
    expect(response.frames.some((frame) => frame.startsWith("id: 2"))).toBe(false);
    response.emit("drain");
    await expect.poll(() => response.frames.some((frame) => frame.startsWith("id: 2"))).toBe(true);

    request.emit("close");
    expect(notifier.listenerCount).toBe(0);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    clearIntervalSpy.mockRestore();
  });

  it("coalesces a notification during a flush into one follow-up read", async () => {
    const request = new EventEmitter();
    const response = new FakeResponse(false);
    const notifier = new TestNotifier();
    let reads = 0;

    beginSse(request as IncomingMessage, response as unknown as ServerResponse, {
      runId: "pending-run",
      initialCursor: 0,
      notifier,
      read: async () => {
        reads += 1;
        if (reads === 1) notifier.publishRunChanged("pending-run");
        return reads === 1 ? [{ seq: 1 }] : [];
      },
      prepareHeaders: () => undefined,
      durablePollMs: 60_000,
      heartbeatMs: 60_000,
    });

    await expect.poll(() => reads).toBe(2);
    expect(response.frames.filter((frame) => frame.startsWith("id: 1"))).toHaveLength(1);
    request.emit("close");
  });
});

class FakeResponse extends EventEmitter {
  readonly frames: string[] = [];
  private blockNextDataFrame: boolean;

  constructor(blockNextDataFrame = true) {
    super();
    this.blockNextDataFrame = blockNextDataFrame;
  }

  setHeader(): void {}

  writeHead(): this {
    return this;
  }

  write(frame: string): boolean {
    this.frames.push(frame);
    if (this.blockNextDataFrame && frame.startsWith("id: ")) {
      this.blockNextDataFrame = false;
      return false;
    }
    return true;
  }

  end(): void {
    this.emit("close");
  }
}

class TestNotifier implements RunChangeNotificationPort {
  private readonly listeners = new Set<(runId: string) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (runId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishRunChanged(runId: string): void {
    for (const listener of this.listeners) listener(runId);
  }
}
