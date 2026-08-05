import type { RunChangeNotificationPort } from "@senawa/application";

export type RunChangeListener = (runId: string) => void;

export class RunChangeNotifier implements RunChangeNotificationPort {
  private readonly listeners = new Set<RunChangeListener>();

  subscribe(listener: RunChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishRunChanged(runId: string): void {
    for (const listener of this.listeners) listener(runId);
  }

  publish(runId: string): void {
    this.publishRunChanged(runId);
  }
}
