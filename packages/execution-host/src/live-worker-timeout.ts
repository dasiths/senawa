export const LIVE_WORKER_CLEANUP_TIMEOUT_MS = 15_000;
export const MAX_LIVE_WORKER_TIMER_MS = 2_147_483_647;

export function deriveLiveWorkerTestTimeout(modelTimeoutMs: number): number {
  if (
    !Number.isSafeInteger(modelTimeoutMs) ||
    modelTimeoutMs < 1 ||
    modelTimeoutMs > MAX_LIVE_WORKER_TIMER_MS - LIVE_WORKER_CLEANUP_TIMEOUT_MS
  ) {
    throw new TypeError("Live worker model timeout leaves no bounded cancellation window");
  }
  return modelTimeoutMs + LIVE_WORKER_CLEANUP_TIMEOUT_MS;
}
