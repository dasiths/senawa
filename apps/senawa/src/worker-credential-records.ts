import type { DatabaseSync } from "node:sqlite";
import type {
  WorkerCredentialRecord,
  WorkerCredentialRecords,
  WorkerCredentialScope,
} from "@senawa/supervisor";

interface Row {
  readonly credential_path: string;
  readonly submissions_used: number;
  readonly canonical_scope: string;
}

/**
 * Durable worker credentials.
 *
 * `start` and `advance` mint in their own process; the daemon serves the agent
 * channel in another. Holding the records in memory made the documented worker
 * verbs unreachable, so they live beside every other piece of authority state.
 * Only the token digest is stored, exactly as the local IPC credential does.
 */
export class SqliteWorkerCredentialRecords implements WorkerCredentialRecords {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  read(tokenDigest: string): WorkerCredentialRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT credential_path, submissions_used, canonical_scope
           FROM worker_credentials WHERE token_digest = ?`,
      )
      .get(tokenDigest) as unknown as Row | undefined;
    if (row === undefined) return undefined;
    return {
      path: row.credential_path,
      scope: JSON.parse(row.canonical_scope) as WorkerCredentialScope,
      used: row.submissions_used,
    };
  }

  write(tokenDigest: string, record: WorkerCredentialRecord): void {
    this.#database
      .prepare(
        `INSERT INTO worker_credentials
           (token_digest, dispatch_id, credential_path, submissions_used, canonical_scope)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (token_digest) DO UPDATE SET
           dispatch_id = excluded.dispatch_id,
           credential_path = excluded.credential_path,
           submissions_used = excluded.submissions_used,
           canonical_scope = excluded.canonical_scope`,
      )
      .run(
        tokenDigest,
        record.scope.dispatchId,
        record.path,
        record.used,
        JSON.stringify(record.scope),
      );
  }

  spend(tokenDigest: string): void {
    this.#database
      .prepare(
        `UPDATE worker_credentials
            SET submissions_used = submissions_used + 1
          WHERE token_digest = ?`,
      )
      .run(tokenDigest);
  }

  forget(dispatchId: string): readonly string[] {
    const rows = this.#database
      .prepare(`SELECT credential_path FROM worker_credentials WHERE dispatch_id = ?`)
      .all(dispatchId) as unknown as readonly { readonly credential_path: string }[];
    this.#database.prepare(`DELETE FROM worker_credentials WHERE dispatch_id = ?`).run(dispatchId);
    return rows.map((row) => row.credential_path);
  }
}
