import type { MutableRunEventNotifier } from "./contracts.js";

export class InMemoryRunEventNotifier implements MutableRunEventNotifier {
  readonly #subscribers = new Map<string, Set<() => void>>();
  readonly #onNotify: (() => void) | undefined;
  readonly #defer: boolean;

  constructor(onNotify?: () => void, defer = false) {
    this.#onNotify = onNotify;
    this.#defer = defer;
  }

  subscribe(repositoryId: string, runId: string, callback: () => void): () => void {
    const key = runKey(repositoryId, runId);
    const callbacks = this.#subscribers.get(key) ?? new Set<() => void>();
    callbacks.add(callback);
    this.#subscribers.set(key, callbacks);
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) this.#subscribers.delete(key);
    };
  }

  notify(repositoryId: string, runId: string): void {
    if (this.#defer) {
      queueMicrotask(() => this.#dispatch(repositoryId, runId));
      return;
    }
    this.#dispatch(repositoryId, runId);
  }

  #dispatch(repositoryId: string, runId: string): void {
    try {
      this.#onNotify?.();
    } catch {
      // A transport wake cannot alter already committed supervisor state.
    }
    for (const callback of this.#subscribers.get(runKey(repositoryId, runId)) ?? []) {
      try {
        callback();
      } catch {
        // A transport wake cannot alter already committed supervisor state.
      }
    }
  }
}

function runKey(repositoryId: string, runId: string): string {
  return `${repositoryId.length}:${repositoryId}${runId.length}:${runId}`;
}
