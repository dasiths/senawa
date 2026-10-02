import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkerCredentialStore } from "@senawa/supervisor";
import { SqliteWorkerCredentialRecords } from "./worker-credential-records.js";

/** How long a dispatched agent may hold its credential before it stops working. */
const CREDENTIAL_LIFETIME_MS = 60 * 60 * 1000;

/** How many submissions one dispatch may make before the credential is spent. */
const CREDENTIAL_SUBMISSIONS = 16;

export interface MintDispatchCredentialInput {
  readonly databasePath: string;
  readonly runtimeDirectory: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly contextId: string;
  readonly principalId: string;
  readonly sha256: { digest(bytes: Uint8Array): string };
  readonly now: () => number;
}

/**
 * Mints the credential a dispatched agent presents to the worker channel.
 *
 * Dispatch happens here and the channel is served by the daemon, so the record
 * has to be durable for the agent to be able to say anything at all. Without
 * this the agent holds a dispatch identity and no way to use it.
 */
export function mintDispatchCredential(input: MintDispatchCredentialInput): string {
  // `start` can dispatch before any service has run, so the runtime root may
  // not exist yet. The store creates its own levels but not the parents.
  mkdirSync(dirname(input.runtimeDirectory), { mode: 0o700, recursive: true });
  const database = new DatabaseSync(input.databasePath);
  try {
    const store = new WorkerCredentialStore({
      now: input.now,
      records: new SqliteWorkerCredentialRecords(database),
      sha256: input.sha256,
    });
    return store.mint({
      // Read verbs need only a recognised credential; submissions spend these.
      capabilities: [
        "worker.submit.completion",
        "worker.submit.phase-output",
        "worker.submit.question",
      ],
      contextId: input.contextId,
      dispatchId: input.dispatchId,
      expiresAt: input.now() + CREDENTIAL_LIFETIME_MS,
      maxSubmissions: CREDENTIAL_SUBMISSIONS,
      principalId: input.principalId,
      random: { bytes: (length: number) => randomBytes(length) },
      repositoryId: input.repositoryId,
      runId: input.runId,
      runtimeDirectory: input.runtimeDirectory,
    }).path;
  } finally {
    database.close();
  }
}
