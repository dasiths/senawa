import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkerCredentialStore } from "@senawa/supervisor";
import { deterministicSha256 } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkerCredentialRecords } from "./worker-credential-records.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

const SCHEMA = `CREATE TABLE worker_credentials (
  token_digest TEXT PRIMARY KEY CHECK (length(token_digest) = 64),
  dispatch_id TEXT NOT NULL,
  credential_path TEXT NOT NULL,
  submissions_used INTEGER NOT NULL CHECK (submissions_used >= 0),
  canonical_scope TEXT NOT NULL
) STRICT;`;

function scope(runtimeDirectory: string) {
  return {
    capabilities: ["worker-submit"],
    contextId: "context_a",
    dispatchId: "dispatch_a",
    expiresAt: 4_000,
    maxSubmissions: 2,
    principalId: "principal_a",
    random: { bytes: (length: number) => new Uint8Array(length).fill(7) },
    repositoryId: "repository_a",
    runId: "run_a",
    runtimeDirectory,
  };
}

describe("durable worker credentials", () => {
  it("honours in one store what another store minted", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-credential-"));
    roots.add(root);
    const database = new DatabaseSync(join(root, "state.db"));
    database.exec(SCHEMA);

    const options = { now: () => 1_000, sha256: deterministicSha256 };
    // The minting store stands for `start`, which dispatches in its own process.
    const minting = new WorkerCredentialStore({
      ...options,
      records: new SqliteWorkerCredentialRecords(database),
    });
    const minted = minting.mint(scope(join(root, "runtime")));
    const token = readFileSync(minted.path, "utf8").trim();

    // The serving store stands for the daemon, which never saw the mint.
    const serving = new WorkerCredentialStore({
      ...options,
      records: new SqliteWorkerCredentialRecords(database),
    });
    expect(serving.identify(token)?.dispatchId).toBe("dispatch_a");

    // The submission budget is shared, not per-process, or two processes would
    // each grant the whole budget.
    serving.resolve(token, "worker-submit");
    minting.resolve(token, "worker-submit");
    expect(() => serving.resolve(token, "worker-submit")).toThrow(
      "Worker credential has no submissions left",
    );

    serving.revoke("dispatch_a");
    expect(minting.identify(token)).toBeUndefined();
    database.close();
  });
});
