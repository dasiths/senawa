import { describe, expect, it } from "vitest";
import {
  deriveLiveWorkerTestTimeout,
  LIVE_WORKER_CLEANUP_TIMEOUT_MS,
  MAX_LIVE_WORKER_TIMER_MS,
} from "./live-worker-timeout.js";

describe("live worker timeout", () => {
  it("reserves a finite cleanup window above the model timeout", () => {
    expect(deriveLiveWorkerTestTimeout(30_000)).toBe(30_000 + LIVE_WORKER_CLEANUP_TIMEOUT_MS);
    expect(() => deriveLiveWorkerTestTimeout(0)).toThrow("bounded cancellation window");
    expect(() =>
      deriveLiveWorkerTestTimeout(MAX_LIVE_WORKER_TIMER_MS - LIVE_WORKER_CLEANUP_TIMEOUT_MS + 1),
    ).toThrow("bounded cancellation window");
  });
});
