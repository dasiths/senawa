import { FileRunDocumentStore } from "@senawa/artifact-store";
import type { RuntimeBackend } from "@senawa/domain";
import {
  FileJournalStore,
  FileOutputLogStore,
  FileWorkerEventStore,
  RunChangeNotifier,
} from "@senawa/observability";
import { type BeadsClient, BeadsRuntimeStateStore } from "@senawa/runtime-beads";
import {
  FileActiveRunRegistry,
  FileLeaseStore,
  FileRunPersistence,
  FileRuntimeStateStore,
} from "@senawa/runtime-file";

export interface RuntimeCompositionOptions {
  readonly beadsClient?: BeadsClient;
}

export function selectRuntime(arguments_: readonly string[]): RuntimeBackend {
  const selected = optionValue(arguments_, "--runtime") ?? "beads";
  if (selected !== "file" && selected !== "beads") {
    throw new Error(`Unsupported runtime backend: ${selected}`);
  }
  return selected;
}

export function createRuntimeComposition(
  repositoryRoot: string,
  backend: RuntimeBackend,
  options: RuntimeCompositionOptions = {},
) {
  const notifier = new RunChangeNotifier();
  const runtime =
    backend === "beads"
      ? new BeadsRuntimeStateStore(
          repositoryRoot,
          options.beadsClient === undefined ? {} : { client: options.beadsClient },
        )
      : new FileRuntimeStateStore(repositoryRoot);
  const persistence = new FileRunPersistence(
    repositoryRoot,
    {
      runtime,
      activeRuns: new FileActiveRunRegistry(repositoryRoot, backend),
      documents: new FileRunDocumentStore(repositoryRoot),
      journal: new FileJournalStore(repositoryRoot, notifier),
      output: new FileOutputLogStore(repositoryRoot, notifier),
      workerEvents: new FileWorkerEventStore(repositoryRoot),
      leases: new FileLeaseStore(repositoryRoot),
      notifications: notifier,
    },
    backend === "beads" ? { backend, lockTimeoutMs: 120_000, staleLockMs: 300_000 } : { backend },
  );
  return { persistence, notifier };
}

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}
