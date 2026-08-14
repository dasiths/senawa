import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface DurableDirectoryPublicationPort {
  syncFile(path: string): void;
  syncDirectory(path: string): void;
  rename(source: string, destination: string): void;
  reopen(path: string): void;
}

export class PublishedDirectoryDurabilityError extends Error {
  readonly published = true;
  readonly destination: string;

  constructor(destination: string, cause: unknown) {
    super(`Directory was published at ${destination}, but final durability verification failed`, {
      cause,
    });
    this.name = "PublishedDirectoryDurabilityError";
    this.destination = destination;
  }
}

export const nodeDirectoryPublicationPort: DurableDirectoryPublicationPort = Object.freeze({
  syncFile: fsyncPath,
  syncDirectory: fsyncPath,
  rename(source: string, destination: string) {
    renameSync(source, destination);
  },
  reopen(path: string) {
    const descriptor = openSync(path, "r");
    closeSync(descriptor);
  },
});

export function publishDirectoryAtomically(
  partial: string,
  destination: string,
  port: DurableDirectoryPublicationPort,
): void {
  port.syncDirectory(partial);
  port.rename(partial, destination);
  try {
    port.syncDirectory(dirname(destination));
    port.reopen(destination);
  } catch (error) {
    throw new PublishedDirectoryDurabilityError(destination, error);
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
