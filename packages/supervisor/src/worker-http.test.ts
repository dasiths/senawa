import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@senawa/protocol";
import { deterministicSha256, runtimeFixture, runtimePrincipal } from "@senawa/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupervisorApi, SupervisorApiError } from "./api.js";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import { HttpSupervisorClient } from "./http-client.js";
import { SupervisorHttpHandler } from "./http-handler.js";
import { type SupervisorHttpServerHandle, startUnixSupervisorServer } from "./http-server.js";
import { loadOrCreateLocalCredential } from "./local-security.js";
import type { WorkerApi } from "./worker-api.js";
import { WorkerCredentialStore } from "./worker-credential.js";

const CAPABILITIES = [
  "worker.submit.completion",
  "worker.submit.phase-output",
  "worker.submit.question",
];

interface Fixture {
  readonly root: string;
  readonly authority: SqliteSupervisorAuthority;
  readonly ipc: SupervisorHttpServerHandle;
  readonly socketPath: string;
  readonly operatorToken: string;
  readonly workerToken: string;
  readonly credentials: WorkerCredentialStore;
  readonly submissions: JsonValue[];
}

let fixture: Fixture;

const workerApi: WorkerApi = {
  context: (scope) => Promise.resolve({ dispatchId: scope.dispatchId } as JsonValue),
  outputSchema: () => Promise.resolve({ type: "object" } as JsonValue),
  submit: (_scope, submission) => {
    fixture.submissions.push(submission);
    return Promise.resolve({ accepted: true } as JsonValue);
  },
};

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "senawa-worker-http-"));
  const authority = new SqliteSupervisorAuthority({
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies: { sha256: deterministicSha256, authorization: { authorize: () => true } },
  });
  const runtimeDirectory = join(root, "runtime");
  const credential = loadOrCreateLocalCredential(runtimeDirectory, {
    bytes: (length) => randomBytes(length),
  });
  const credentials = new WorkerCredentialStore({
    sha256: deterministicSha256,
    now: () => Date.now(),
  });
  const minted = credentials.mint({
    repositoryId: "repository_demo",
    runId: "run_demo",
    dispatchId: "dispatch_demo",
    contextId: "context_demo",
    principalId: "principal_demo",
    capabilities: CAPABILITIES,
    expiresAt: Date.now() + 600_000,
    maxSubmissions: 4,
    runtimeDirectory,
    random: { bytes: (length) => randomBytes(length) },
  });
  const handler = new SupervisorHttpHandler({
    api: new SupervisorApi(authority),
    transport: "ipc",
    credential,
    contextFactory: (_request, transportKind) => ({
      principal: runtimePrincipal,
      transportKind,
      requestId: "request_worker",
      admission: {
        currentTime: runtimeFixture.currentTime,
        facts: { source: "worker-test" },
        allocator: { allocationsFor: () => [] },
      },
    }),
    worker: { api: workerApi, credentials },
  });
  const socketPath = join(runtimeDirectory, "supervisor.sock");
  const ipc = await startUnixSupervisorServer(socketPath, handler);
  fixture = {
    root,
    authority,
    ipc,
    socketPath,
    operatorToken: credential.token,
    workerToken: readFileSync(minted.path, "utf8").trim(),
    credentials,
    submissions: [],
  };
});

afterEach(async () => {
  await fixture.ipc.close();
  fixture.authority.close();
  rmSync(fixture.root, { recursive: true, force: true });
});

async function expectRefusal(work: Promise<unknown>, status: number): Promise<void> {
  await expect(work).rejects.toSatisfy(
    (error: unknown) => error instanceof SupervisorApiError && error.status === status,
  );
}

function client(token: string): HttpSupervisorClient {
  return new HttpSupervisorClient({ socketPath: fixture.socketPath, credential: token });
}

describe("worker HTTP channel", () => {
  it("serves the worker its own context and schema", async () => {
    const worker = client(fixture.workerToken);
    expect(await worker.workerContext("dispatch_demo")).toEqual({ dispatchId: "dispatch_demo" });
    expect(await worker.workerOutputSchema("dispatch_demo")).toEqual({ type: "object" });
  });

  it("accepts a submission and spends one unit of the worker's budget", async () => {
    const worker = client(fixture.workerToken);
    const submission = { kind: "question", question: "Which branch?" } as JsonValue;
    expect(await worker.submitWorkerSubmission("dispatch_demo", submission)).toEqual({
      accepted: true,
    });
    expect(fixture.submissions).toEqual([submission]);
  });

  it("refuses a worker reaching any human authority operation", async () => {
    const worker = client(fixture.workerToken);
    // The operator API is not merely unauthorised for a worker: it does not
    // resolve at all, so a worker cannot enumerate what it is missing.
    await expectRefusal(worker.listReceipts({ repositoryId: "r", runId: "r", limit: 1 }), 404);
    await expectRefusal(worker.capabilities(), 404);
  });

  it("refuses an operator token on the worker channel", async () => {
    // The operator holds strictly more authority, so letting it act as a worker
    // would make every submission's provenance a guess.
    await expectRefusal(client(fixture.operatorToken).workerContext("dispatch_demo"), 404);
  });

  it("refuses a revoked worker credential", async () => {
    fixture.credentials.revoke("dispatch_demo");
    await expectRefusal(client(fixture.workerToken).workerContext("dispatch_demo"), 401);
  });

  it("refuses a submission once the budget is spent", async () => {
    const worker = client(fixture.workerToken);
    const submission = { kind: "question", question: "Again?" } as JsonValue;
    for (let index = 0; index < 4; index += 1) {
      await worker.submitWorkerSubmission("dispatch_demo", submission);
    }
    await expectRefusal(worker.submitWorkerSubmission("dispatch_demo", submission), 403);
  });
});
