import { FileRunDocumentStore } from "@senawa/artifact-store";
import {
  FileJournalStore,
  FileOutputLogStore,
  FileWorkerEventStore,
  RunChangeNotifier,
} from "@senawa/observability";
import {
  FileActiveRunRegistry,
  FileLeaseStore,
  FileRunPersistence,
  FileRuntimeStateStore,
} from "@senawa/runtime-file";

export function createFileTestComposition(
  repositoryRoot: string,
  now: () => Date = () => new Date(),
): { readonly persistence: FileRunPersistence; readonly notifier: RunChangeNotifier } {
  const notifier = new RunChangeNotifier();
  return {
    notifier,
    persistence: new FileRunPersistence(repositoryRoot, {
      runtime: new FileRuntimeStateStore(repositoryRoot),
      activeRuns: new FileActiveRunRegistry(repositoryRoot),
      documents: new FileRunDocumentStore(repositoryRoot),
      journal: new FileJournalStore(repositoryRoot, notifier),
      output: new FileOutputLogStore(repositoryRoot, notifier),
      workerEvents: new FileWorkerEventStore(repositoryRoot),
      leases: new FileLeaseStore(repositoryRoot, now),
      notifications: notifier,
    }),
  };
}
