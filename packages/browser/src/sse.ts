import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunChangeNotificationPort } from "@senawa/application";

export interface SseOptions<T extends { readonly seq: number }> {
  readonly runId: string;
  readonly initialCursor: number;
  readonly notifier: RunChangeNotificationPort;
  readonly read: (after: number) => Promise<readonly T[]>;
  readonly prepareHeaders: (response: ServerResponse) => void;
  readonly durablePollMs?: number;
  readonly heartbeatMs?: number;
}

export function beginSse<T extends { readonly seq: number }>(
  request: IncomingMessage,
  response: ServerResponse,
  options: SseOptions<T>,
): void {
  options.prepareHeaders(response);
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.writeHead(200);

  let current = options.initialCursor;
  let flushing = false;
  let pending = true;
  let stopped = false;
  let heartbeatPending = false;
  let releaseDrain: (() => void) | null = null;
  let unsubscribe: () => void = () => undefined;
  let durablePoll: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (durablePoll !== undefined) clearInterval(durablePoll);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe();
    releaseDrain?.();
  };
  request.once("close", stop);
  response.once("close", stop);
  response.once("error", stop);

  const writeFrame = async (frame: string): Promise<boolean> => {
    if (stopped) return false;
    if (response.write(frame)) return true;
    await new Promise<void>((resolve) => {
      const onDrain = () => {
        releaseDrain = null;
        resolve();
      };
      releaseDrain = () => {
        response.off("drain", onDrain);
        releaseDrain = null;
        resolve();
      };
      response.once("drain", onDrain);
    });
    return !stopped;
  };

  let writeTail = Promise.resolve(true);
  const write = (frame: string): Promise<boolean> => {
    const next = writeTail
      .then(async (writable) => writable && (await writeFrame(frame)))
      .catch(() => {
        stop();
        return false;
      });
    writeTail = next;
    return next;
  };

  const flush = async () => {
    if (stopped) return;
    if (flushing) {
      pending = true;
      return;
    }
    flushing = true;
    try {
      do {
        pending = false;
        for (const record of await options.read(current)) {
          if (record.seq <= current) continue;
          if (!(await write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`))) return;
          current = record.seq;
        }
      } while (pending && !stopped);
    } catch {
      if (!stopped) response.end();
      stop();
    } finally {
      flushing = false;
    }
  };

  unsubscribe = options.notifier.subscribe((changedRunId) => {
    if (changedRunId === options.runId) void flush();
  });
  durablePoll = setInterval(() => void flush(), options.durablePollMs ?? 250);
  durablePoll.unref();
  heartbeat = setInterval(() => {
    if (stopped || heartbeatPending) return;
    heartbeatPending = true;
    void write(": heartbeat\n\n").finally(() => {
      heartbeatPending = false;
    });
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  void write("retry: 1000\n\n").then((writable) => {
    if (writable) void flush();
  });
}
