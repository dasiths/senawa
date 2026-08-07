import { FileRunDocumentStore } from "@senawa/artifact-store";
import {
  FileJournalStore,
  FileOutputLogStore,
  FileWorkerEventStore,
  GitRepositoryEvidenceStore,
  RunChangeNotifier,
} from "@senawa/observability";
import {
  FileActiveRunRegistry,
  FileBrowserCommandReceiptStore,
  FileLeaseStore,
  FileRunPersistence,
  FileRuntimeStateStore,
} from "@senawa/runtime-file";

export function createFileTestComposition(
  repositoryRoot: string,
  now: () => Date = () => new Date(),
): {
  readonly persistence: FileRunPersistence;
  readonly notifier: RunChangeNotifier;
  readonly receiptStore: FileBrowserCommandReceiptStore;
  readonly repositoryEvidence: GitRepositoryEvidenceStore;
} {
  const notifier = new RunChangeNotifier();
  const leases = new FileLeaseStore(repositoryRoot, now);
  return {
    notifier,
    receiptStore: new FileBrowserCommandReceiptStore(repositoryRoot, leases, now, notifier),
    repositoryEvidence: new GitRepositoryEvidenceStore(repositoryRoot),
    persistence: new FileRunPersistence(repositoryRoot, {
      runtime: new FileRuntimeStateStore(repositoryRoot),
      activeRuns: new FileActiveRunRegistry(repositoryRoot),
      documents: new FileRunDocumentStore(repositoryRoot),
      journal: new FileJournalStore(repositoryRoot, notifier),
      output: new FileOutputLogStore(repositoryRoot, notifier),
      workerEvents: new FileWorkerEventStore(repositoryRoot),
      leases,
      notifications: notifier,
    }),
  };
}
