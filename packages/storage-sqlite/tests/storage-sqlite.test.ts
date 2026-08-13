import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type AccountingAssessment,
  type CompletionSubmission,
  consumerKey,
  createPhaseCandidate,
  createSensorReading,
  criterionId,
  defineGate,
  digestAccountingAssessment,
  digestSelectedTaskSet,
} from "@senawa/kernel";
import { canonicalStringify, PROTOCOL_VERSION } from "@senawa/protocol";
import {
  createRoleAuthorizationPolicy,
  FencedRunner,
  type RuntimeDependencies,
} from "@senawa/runtime";
import {
  createAdmissionFixture,
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
} from "@senawa/testing";
import {
  type RuntimeAuthorityConformanceHarness,
  registerRuntimeAuthorityConformance,
} from "@senawa/testing/authority-conformance";
import {
  type ContextBrokerHarness,
  contextBrokerSha256,
  FakeGrantTokenIssuer,
  FakeTrustedClock,
  initializeContextBrokerHarness,
  registerContextBrokerConformance,
} from "@senawa/testing/context-broker-conformance";
import {
  FakeEffectHost,
  type RunnerAuthorityConformanceHarness,
  registerRunnerAuthorityConformance,
  runnerEffectCommand,
  runnerFixture,
  runOnceInput,
} from "@senawa/testing/runner-conformance";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  LeaseUnavailableError,
  restoreSqliteAuthority,
  SqliteAuthority,
  type SqliteAuthorityOptions,
  SqliteContextBroker,
  type SqliteFaultPoint,
  SqliteRunnerAuthority,
  StaleAuthorityRevisionError,
  StaleLeaseFenceError,
  UnsupportedSchemaVersionError,
} from "../src/index.js";

const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy(
    [
      "instantiate-run",
      "accept-graph-revision",
      "submit-completion",
      "evaluate-gate",
      "record-authority-decision",
      "close-phase",
    ].map((intent) => ({
      intent: intent as Parameters<typeof createRoleAuthorizationPolicy>[0][number]["intent"],
      roles: ["release-manager"],
    })),
  ),
};

registerRuntimeAuthorityConformance("SQLite", dependencies, () => createConformanceHarness());

const runnerHarnessDisposers = new Set<() => void>();
const contextHarnessDisposers = new Set<() => void>();

afterEach(() => {
  for (const dispose of runnerHarnessDisposers) dispose();
  runnerHarnessDisposers.clear();
  for (const dispose of contextHarnessDisposers) dispose();
  contextHarnessDisposers.clear();
});

registerRunnerAuthorityConformance("SQLite", () => createRunnerConformanceHarness());
registerContextBrokerConformance("SQLite", () => createSqliteContextBrokerHarness());

describe("SQLite context broker durability", () => {
  it("replays exact read bytes after reopen with one charge and no raw token on disk", async () => {
    const harness = createSqliteContextBrokerHarness();
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(harness, grant.grantToken, "request_reopen", 0, 16);
    const first = await broker.readAsset({ request });
    expect(first.status).toBe("served");
    const databasePath = broker.databasePath;
    broker.close();

    const reopened = reopenContextBroker(databasePath, harness);
    try {
      const replay = await reopened.readAsset({ request });
      expect(replay).toEqual(first);
      expect(reopened.authority.snapshot().grants[0]).toMatchObject({
        operationsUsed: 1,
        bytesUsed: 16,
      });
      expect(reopened.authority.snapshot().receipts).toHaveLength(1);
      reopened.close();
      expect(readFileSync(databasePath).toString("latin1")).not.toContain(grant.grantToken);
    } finally {
      reopened.close();
    }
  });

  it("serializes independent exact readers to one durable result and one charge", async () => {
    const harness = createSqliteContextBrokerHarness();
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(harness, grant.grantToken, "request_concurrent", 0, 16);
    const databasePath = broker.databasePath;
    broker.close();
    const workerSource = `const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.storageModuleUrl).then(({ SqliteContextBroker }) => {
        const sha256 = { digest(bytes) {
          let accumulator = 0x811c9dc5;
          for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
          return accumulator.toString(16).padStart(8, "0").repeat(8);
        } };
        const broker = new SqliteContextBroker({
          databasePath: workerData.databasePath,
          dependencies: {
            sha256,
            currentTime: () => "2026-08-13T10:00:00.000Z",
            issueGrantToken: () => new Uint8Array(32),
          },
          busyTimeoutMs: 2000,
        });
        parentPort.postMessage("ready");
        parentPort.once("message", async () => {
          try {
            const result = await broker.readAsset({ request: workerData.request });
            parentPort.postMessage({
              status: result.status,
              bytes: result.status === "served" ? Array.from(result.bytes) : undefined,
            });
          } catch (error) {
            parentPort.postMessage({ error: String(error) });
          } finally {
            broker.close();
          }
        });
      });`;
    const workerData = {
      databasePath,
      request,
      storageModuleUrl: new URL("../dist/index.js", import.meta.url).href,
    };
    const workers = [
      new Worker(workerSource, { eval: true, workerData }),
      new Worker(workerSource, { eval: true, workerData }),
    ];
    try {
      await Promise.all(workers.map((worker) => once(worker, "message")));
      const results = workers.map((worker) => once(worker, "message"));
      for (const worker of workers) worker.postMessage("start");
      const observed = (await Promise.all(results)).map(([result]) => result);
      expect(observed).toEqual([
        { status: "served", bytes: [...harness.bytes.slice(0, 16)] },
        { status: "served", bytes: [...harness.bytes.slice(0, 16)] },
      ]);
      const reopened = reopenContextBroker(databasePath, harness);
      try {
        expect(reopened.authority.snapshot().grants[0]).toMatchObject({
          operationsUsed: 1,
          bytesUsed: 16,
        });
        expect(reopened.authority.snapshot().receipts).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });

  it("serializes same-instance exact readers to one durable result and one asset read", async () => {
    const harness = createSqliteContextBrokerHarness();
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(harness, grant.grantToken, "request_same-instance", 0, 16);
    const baselineReads = broker.assets.readCalls;

    const [first, replay] = await Promise.all([
      broker.readAsset({ request }),
      broker.readAsset({ request }),
    ]);

    expect(replay).toEqual(first);
    expect(broker.assets.readCalls - baselineReads).toBe(1);
    expect(broker.authority.snapshot().grants[0]).toMatchObject({
      operationsUsed: 1,
      bytesUsed: 16,
    });
    expect(broker.authority.snapshot().receipts).toHaveLength(1);
  });

  it("persists exact conflict attribution and distinct-request budget exhaustion", async () => {
    const harness = createSqliteContextBrokerHarness();
    const grant = harness.broker.grantAssetAccess({
      repositoryId: harness.dispatch.repositoryId,
      runId: harness.dispatch.runId,
      dispatchId: harness.dispatch.dispatchId,
      assetBindingId: harness.context.assets[0]?.assetBindingId ?? "missing",
      allowedPointer: "/work",
      readMode: "chunk",
      sensitivityCeiling: "confidential",
      expiresAt: "2026-08-13T11:00:00.000Z",
      maxOperations: 1,
      maxBytes: 4,
      maxChunkBytes: 4,
    });
    const firstRequest = contextChunkRequest(harness, grant.grantToken, "request_budget", 0, 4);
    expect((await harness.broker.readAsset({ request: firstRequest })).status).toBe("served");
    const conflict = await harness.broker.readAsset({
      request: { ...firstRequest, offset: 1 },
    });
    expect(conflict.receipt).toMatchObject({
      denialCode: "request-conflict",
      repositoryId: harness.dispatch.repositoryId,
      runId: harness.dispatch.runId,
      dispatchId: harness.dispatch.dispatchId,
    });
    const exhausted = await harness.broker.readAsset({
      request: contextChunkRequest(harness, grant.grantToken, "request_exhausted", 4, 1),
    });
    expect(exhausted.receipt).toMatchObject({
      denialCode: "budget-exhausted",
      chargedOperations: 0,
      chargedBytes: 0,
    });
  });

  for (const point of [
    "after-read-reservation",
    "before-read-commit",
    "after-read-commit-before-ack",
  ] as const) {
    it(`recovers exact read state after ${point}`, async () => {
      const harness = createSqliteContextBrokerHarness();
      const original = harness.broker as SqliteContextBroker;
      const grant = issueContextGrant(harness);
      const request = contextChunkRequest(harness, grant.grantToken, `request_${point}`, 0, 8);
      const databasePath = original.databasePath;
      original.close();
      let armed = true;
      const faulting = new SqliteContextBroker({
        databasePath,
        dependencies: harness.broker.dependencies,
        busyTimeoutMs: 500,
        faultInjector(candidate) {
          if (armed && candidate === point) {
            armed = false;
            throw new Error(`injected ${point}`);
          }
        },
      });
      await expect(faulting.readAsset({ request })).rejects.toThrow(`injected ${point}`);
      faulting.close();

      const reopened = reopenContextBroker(databasePath, harness);
      try {
        const replay = await reopened.readAsset({ request });
        expect(replay.status).toBe("served");
        expect(reopened.authority.snapshot().grants[0]).toMatchObject({
          operationsUsed: 1,
          bytesUsed: 8,
        });
        expect(reopened.authority.snapshot().receipts).toHaveLength(1);
      } finally {
        reopened.close();
      }
    });
  }

  it("keeps a completion outbox pending across reopen and acknowledges idempotent delivery", () => {
    const harness = createSqliteContextBrokerHarness();
    const original = harness.broker as SqliteContextBroker;
    const databasePath = original.databasePath;
    original.close();
    const failing = new SqliteContextBroker({
      databasePath,
      dependencies: harness.broker.dependencies,
      completionFacts: {
        admitCompletionFact() {
          throw new Error("simulated outbox delivery loss");
        },
      },
    });
    const submission = contextCompletionSubmission(harness, "submission_pending-outbox");
    expect(() =>
      failing.admitSubmission({
        submission,
        currentContextDigest: harness.context.contextDigest,
        currentTask: harness.dispatch.task,
      }),
    ).toThrow("simulated outbox delivery loss");
    expect(failing.authority.snapshot().completionOutbox[0]).toMatchObject({ delivered: false });
    failing.close();

    const delivered = new Set<string>();
    const reopened = new SqliteContextBroker({
      databasePath,
      dependencies: harness.broker.dependencies,
      completionFacts: {
        admitCompletionFact(fact) {
          delivered.add(fact.submissionId);
        },
      },
    });
    try {
      expect(reopened.deliverCompletionFact(submission.submissionId)).toBe(true);
      expect(reopened.deliverCompletionFact(submission.submissionId)).toBe(false);
      expect(delivered).toEqual(new Set([submission.submissionId]));
      expect(reopened.authority.snapshot().completionOutbox[0]).toMatchObject({
        delivered: true,
      });
    } finally {
      reopened.close();
    }
  });

  it("refuses reentrant same-instance completion outbox delivery", () => {
    const harness = createSqliteContextBrokerHarness();
    const original = harness.broker as SqliteContextBroker;
    const databasePath = original.databasePath;
    original.close();
    let broker: SqliteContextBroker;
    let reentrantResult: boolean | undefined;
    broker = new SqliteContextBroker({
      databasePath,
      dependencies: harness.broker.dependencies,
      completionFacts: {
        admitCompletionFact(fact) {
          reentrantResult = broker.deliverCompletionFact(fact.submissionId);
        },
      },
    });
    try {
      const submission = contextCompletionSubmission(harness, "submission_reentrant-outbox");
      expect(
        broker.admitSubmission({
          submission,
          currentContextDigest: harness.context.contextDigest,
          currentTask: harness.dispatch.task,
        }),
      ).toMatchObject({ status: "accepted" });
      expect(reentrantResult).toBe(false);
      expect(broker.authority.snapshot().completionOutbox[0]).toMatchObject({ delivered: true });
    } finally {
      broker.close();
    }
  });

  it("refuses semantic canonical grant corruption on startup", () => {
    const scenarios = [
      {
        name: "raw grant token",
        mutate(envelope: Record<string, unknown>, token: string) {
          envelope.grantToken = token;
        },
      },
      {
        name: "changed byte budget",
        mutate(envelope: Record<string, unknown>) {
          envelope.maxBytes = 513;
        },
      },
      {
        name: "changed pointer scope",
        mutate(envelope: Record<string, unknown>) {
          envelope.allowedPointer = "";
        },
      },
    ];
    for (const scenario of scenarios) {
      const harness = createSqliteContextBrokerHarness();
      const broker = harness.broker as SqliteContextBroker;
      const grant = issueContextGrant(harness);
      const databasePath = broker.databasePath;
      broker.close();
      mutateDurableContextState(databasePath, (snapshot) => {
        const grantRecord = snapshot.grants[0];
        if (grantRecord === undefined) throw new Error("Expected context grant fixture");
        const envelope = grantRecord.envelope;
        scenario.mutate(envelope, grant.grantToken);
      });
      expect(
        () =>
          new SqliteContextBroker({
            databasePath,
            dependencies: harness.broker.dependencies,
          }),
        scenario.name,
      ).toThrow();
    }
  });

  it("refuses normalized context row divergence on startup", () => {
    const harness = createSqliteContextBrokerHarness();
    const broker = harness.broker as SqliteContextBroker;
    issueContextGrant(harness);
    const databasePath = broker.databasePath;
    broker.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE context_grants SET bytes_used = bytes_used + 1").run();
    database.close();

    expect(
      () =>
        new SqliteContextBroker({
          databasePath,
          dependencies: harness.broker.dependencies,
        }),
    ).toThrow(/context_grants/u);
  });

  it("refuses coordinated durable read bytes corruption on startup and backup", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(harness, grant.grantToken, "request_corrupt-bytes", 0, 4);
    expect((await broker.readAsset({ request })).status).toBe("served");
    broker.close();
    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      const bytes = snapshot.reads[0]?.result.bytes;
      if (bytes === undefined) throw new Error("Expected served durable read bytes");
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    });
    const database = new Database(sandbox.options.databasePath);
    const row = database
      .prepare<[], { result_bytes: Uint8Array }>(
        "SELECT result_bytes FROM context_read_attempts WHERE request_id = 'request_corrupt-bytes'",
      )
      .get();
    if (row === undefined) throw new Error("Expected normalized served read bytes");
    const corrupt = Uint8Array.from(row.result_bytes);
    corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
    database
      .prepare("UPDATE context_read_attempts SET result_bytes = ? WHERE request_id = ?")
      .run(corrupt, request.requestId);
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/durable context read bytes/u);
      await expect(authority.backup(join(sandbox.root, "corrupt-bytes-backup"))).rejects.toThrow(
        /durable context read bytes/u,
      );
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("refuses coordinated zeroed grant usage on startup and backup", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = harness.broker.grantAssetAccess({
      repositoryId: harness.dispatch.repositoryId,
      runId: harness.dispatch.runId,
      dispatchId: harness.dispatch.dispatchId,
      assetBindingId: harness.context.assets[0]?.assetBindingId ?? "missing",
      allowedPointer: "/work",
      readMode: "chunk",
      sensitivityCeiling: "confidential",
      expiresAt: "2026-08-13T11:00:00.000Z",
      maxOperations: 1,
      maxBytes: 4,
      maxChunkBytes: 4,
    });
    const request = contextChunkRequest(harness, grant.grantToken, "request_zeroed-usage", 0, 4);
    expect((await broker.readAsset({ request })).status).toBe("served");
    broker.close();
    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      const grantRecord = snapshot.grants[0];
      if (grantRecord === undefined) throw new Error("Expected durable context grant");
      grantRecord.operationsUsed = 0;
      grantRecord.bytesUsed = 0;
    });
    const database = new Database(sandbox.options.databasePath);
    database.prepare("UPDATE context_grants SET operations_used = 0, bytes_used = 0").run();
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/grant counters/u);
      await expect(authority.backup(join(sandbox.root, "zeroed-usage-backup"))).rejects.toThrow(
        /grant counters/u,
      );
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("refuses coordinated remaining budget corruption on startup and backup", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(
      harness,
      grant.grantToken,
      "request_corrupt-remaining",
      0,
      4,
    );
    expect((await broker.readAsset({ request })).status).toBe("served");
    broker.close();
    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      for (const receipt of durableReceiptsForAttempt(snapshot, 0))
        receipt.remainingOperations += 1;
    });
    const database = new Database(sandbox.options.databasePath);
    for (const table of ["context_read_attempts", "context_audit_receipts"] as const) {
      const row = database
        .prepare<[], { canonical_receipt: string }>(
          `SELECT canonical_receipt FROM ${table} WHERE request_id = 'request_corrupt-remaining'`,
        )
        .get();
      if (row === undefined) throw new Error(`Expected normalized receipt in ${table}`);
      const receipt = JSON.parse(row.canonical_receipt) as { remainingOperations: number };
      receipt.remainingOperations += 1;
      database
        .prepare(`UPDATE ${table} SET canonical_receipt = ? WHERE request_id = ?`)
        .run(canonicalStringify(receipt), request.requestId);
    }
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/remaining budget/u);
      await expect(authority.backup(join(sandbox.root, "remaining-budget-backup"))).rejects.toThrow(
        /remaining budget/u,
      );
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("derives served byte charges instead of trusting coordinated receipt accounting", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(harness, grant.grantToken, "request_derived-charge", 0, 4);
    expect((await broker.readAsset({ request })).status).toBe("served");
    broker.close();
    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      const grantRecord = snapshot.grants[0];
      if (grantRecord === undefined) throw new Error("Expected durable context grant");
      grantRecord.bytesUsed = 5;
      for (const receipt of durableReceiptsForAttempt(snapshot, 0)) {
        receipt.chargedBytes = 5;
        receipt.remainingBytes = 507;
      }
    });
    const database = new Database(sandbox.options.databasePath);
    database.prepare("UPDATE context_grants SET bytes_used = 5").run();
    mutateNormalizedContextReceipt(
      database,
      "context_read_attempts",
      request.requestId,
      (receipt) => {
        receipt.chargedBytes = 5;
        receipt.remainingBytes = 507;
      },
    );
    mutateNormalizedContextReceipt(
      database,
      "context_audit_receipts",
      request.requestId,
      (receipt) => {
        receipt.chargedBytes = 5;
        receipt.remainingBytes = 507;
      },
    );
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/verifier-derived accounting/u);
      await expect(authority.backup(join(sandbox.root, "derived-charge-backup"))).rejects.toThrow(
        /verifier-derived accounting/u,
      );
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("derives post-reservation invalid pointer operation charges", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextPointerRequest(
      harness,
      grant.grantToken,
      "request_derived-pointer",
      "/work/missing",
      32,
    );
    const result = await broker.readAsset({ request });
    expect(result.receipt).toMatchObject({
      denialCode: "invalid-pointer",
      chargedOperations: 1,
    });
    broker.close();
    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      const grantRecord = snapshot.grants[0];
      if (grantRecord === undefined) throw new Error("Expected durable context grant");
      grantRecord.operationsUsed = 0;
      for (const receipt of durableReceiptsForAttempt(snapshot, 0)) {
        receipt.chargedOperations = 0;
        receipt.remainingOperations = 4;
      }
    });
    const database = new Database(sandbox.options.databasePath);
    database.prepare("UPDATE context_grants SET operations_used = 0").run();
    mutateNormalizedContextReceipt(
      database,
      "context_read_attempts",
      request.requestId,
      (receipt) => {
        receipt.chargedOperations = 0;
        receipt.remainingOperations = 4;
      },
    );
    mutateNormalizedContextReceipt(
      database,
      "context_audit_receipts",
      request.requestId,
      (receipt) => {
        receipt.chargedOperations = 0;
        receipt.remainingOperations = 4;
      },
    );
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/verifier-derived accounting/u);
      await expect(authority.backup(join(sandbox.root, "derived-pointer-backup"))).rejects.toThrow(
        /verifier-derived accounting/u,
      );
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("rejects coordinated invalid-pointer relabeling without failure provenance", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextPointerRequest(
      harness,
      grant.grantToken,
      "request_relabel-pointer",
      "/work/missing",
      32,
    );
    expect((await broker.readAsset({ request })).receipt).toMatchObject({
      denialCode: "invalid-pointer",
      chargedOperations: 1,
    });
    broker.close();
    const cleanBackupPath = join(sandbox.root, "clean-pointer-backup");
    await authority.backup(cleanBackupPath);
    const corruptBackupPath = join(sandbox.root, "corrupt-pointer-backup");
    cpSync(cleanBackupPath, corruptBackupPath, { recursive: true });
    coordinateContextReceiptDenialRelabel(
      sandbox.options.databasePath,
      request.requestId,
      "digest-mismatch",
    );
    coordinateContextReceiptDenialRelabel(
      join(corruptBackupPath, "authority.db"),
      request.requestId,
      "digest-mismatch",
    );
    refreshBackupDatabaseManifest(corruptBackupPath);

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/failure provenance/u);
      await expect(authority.backup(join(sandbox.root, "relabel-pointer-backup"))).rejects.toThrow(
        /failure provenance/u,
      );
      expect(() =>
        restoreSqliteAuthority({
          ...sandbox.options,
          databasePath: join(sandbox.root, "relabel-restored.db"),
          assetDirectory: join(sandbox.root, "relabel-restored-assets"),
          backupPath: corruptBackupPath,
        }),
      ).toThrow(/failure provenance/u);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("reopens genuine digest mismatch provenance and rejects its stage corruption", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(
      harness,
      grant.grantToken,
      "request_transient-integrity",
      0,
      4,
    );
    broker.assets.readAssetRange = () => undefined;
    expect((await broker.readAsset({ request })).receipt).toMatchObject({
      denialCode: "digest-mismatch",
      chargedOperations: 1,
    });
    broker.close();

    const reopened = new SqliteContextBroker({
      databasePath: sandbox.options.databasePath,
      dependencies: harness.broker.dependencies,
    });
    expect(reopened.authority.snapshot().receipts[0]).toMatchObject({
      denialCode: "digest-mismatch",
    });
    reopened.close();

    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      const attempt = snapshot.receiptAttempts[0];
      if (attempt?.failureStage !== "asset-integrity")
        throw new Error("Expected durable asset-integrity failure provenance");
      attempt.failureStage = "asset-read";
    });
    const database = new Database(sandbox.options.databasePath);
    database
      .prepare(
        `UPDATE context_audit_receipts SET failure_stage = 'asset-read'
         WHERE request_id = ?`,
      )
      .run(request.requestId);
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/failure fact digest/u);
      await expect(authority.backup(join(sandbox.root, "failure-stage-backup"))).rejects.toThrow(
        /failure fact digest/u,
      );
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("rejects coordinated replay key changes that retain the admitted digest", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextPointerRequest(
      harness,
      grant.grantToken,
      "request_replay-digest",
      "/work/items/0",
      64,
    );
    expect((await broker.readAsset({ request })).status).toBe("served");
    broker.close();
    let changedReplayKey = "";
    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      const read = snapshot.reads[0];
      const attempt = snapshot.receiptAttempts[0];
      if (read === undefined || attempt === undefined)
        throw new Error("Expected durable read attempt identity");
      const replay = JSON.parse(read.canonicalReplayKey) as { maxBytes: number };
      replay.maxBytes = 65;
      changedReplayKey = canonicalStringify(replay);
      read.canonicalReplayKey = changedReplayKey;
      attempt.canonicalReplayKey = changedReplayKey;
    });
    const database = new Database(sandbox.options.databasePath);
    database
      .prepare("UPDATE context_read_attempts SET canonical_replay_key = ? WHERE request_id = ?")
      .run(changedReplayKey, request.requestId);
    database
      .prepare("UPDATE context_audit_receipts SET canonical_replay_key = ? WHERE request_id = ?")
      .run(changedReplayKey, request.requestId);
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/replay key digest/u);
      await expect(authority.backup(join(sandbox.root, "replay-digest-backup"))).rejects.toThrow(
        /replay key digest/u,
      );
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("attributes equivalent-grant conflicts by exact token digest", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const firstGrant = issueContextGrant(harness);
    const secondGrant = issueContextGrant(harness);
    const request = contextChunkRequest(
      harness,
      firstGrant.grantToken,
      "request_exact-conflict-token",
      0,
      4,
    );
    expect((await broker.readAsset({ request })).status).toBe("served");
    const conflict = await broker.readAsset({
      request: { ...request, grantToken: secondGrant.grantToken, offset: 1 },
    });
    expect(conflict.receipt).toMatchObject({
      denialCode: "request-conflict",
      remainingOperations: 4,
      remainingBytes: 512,
    });
    broker.close();
    mutateDurableContextState(sandbox.options.databasePath, (snapshot) => {
      const receipt = snapshot.receipts[1];
      const attemptReceipt = snapshot.receiptAttempts[1]?.receipt;
      if (receipt === undefined || attemptReceipt === undefined)
        throw new Error("Expected durable conflict receipt");
      for (const target of [receipt, attemptReceipt]) {
        target.remainingOperations = 3;
        target.remainingBytes = 508;
      }
    });
    const database = new Database(sandbox.options.databasePath);
    mutateNormalizedContextReceipt(
      database,
      "context_audit_receipts",
      request.requestId,
      (receipt) => {
        if (receipt.denialCode !== "request-conflict") return;
        receipt.remainingOperations = 3;
        receipt.remainingBytes = 508;
      },
      "receipt_cursor = 2",
    );
    database.close();

    try {
      expect(
        () =>
          new SqliteContextBroker({
            databasePath: sandbox.options.databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/remaining budget/u);
      await expect(
        authority.backup(join(sandbox.root, "exact-conflict-token-backup")),
      ).rejects.toThrow(/remaining budget/u);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("refuses startup after persisted context chunk corruption", () => {
    const harness = createSqliteContextBrokerHarness();
    const broker = harness.broker as SqliteContextBroker;
    const databasePath = broker.databasePath;
    broker.close();
    const database = new Database(databasePath);
    const row = database
      .prepare<[], { asset_binding_id: string; chunk_index: number; content: Uint8Array }>(
        `SELECT asset_binding_id, chunk_index, content
         FROM context_asset_chunks ORDER BY asset_binding_id, chunk_index LIMIT 1`,
      )
      .get();
    if (row === undefined) throw new Error("Expected context chunk fixture");
    const corrupt = Uint8Array.from(row.content);
    corrupt[0] = corrupt[0] === 0 ? 1 : 0;
    database
      .prepare(
        `UPDATE context_asset_chunks SET content = ?
         WHERE asset_binding_id = ? AND chunk_index = ?`,
      )
      .run(corrupt, row.asset_binding_id, row.chunk_index);
    database.close();
    expect(
      () =>
        new SqliteContextBroker({
          databasePath,
          dependencies: harness.broker.dependencies,
        }),
    ).toThrow(/chunk integrity/u);
  });

  it.each(["coordinated-content-digest", "offset", "chunk-count"] as const)(
    "refuses startup after context asset %s corruption",
    (corruption) => {
      const harness = createSqliteContextBrokerHarness();
      const broker = harness.broker as SqliteContextBroker;
      const databasePath = broker.databasePath;
      broker.close();
      const database = new Database(databasePath);
      if (corruption === "coordinated-content-digest") {
        const row = database
          .prepare<[], { asset_binding_id: string; chunk_index: number; content: Uint8Array }>(
            `SELECT asset_binding_id, chunk_index, content
             FROM context_asset_chunks ORDER BY asset_binding_id, chunk_index LIMIT 1`,
          )
          .get();
        if (row === undefined) throw new Error("Expected context chunk fixture");
        const corrupt = Uint8Array.from(row.content);
        corrupt[0] = corrupt[0] === 0 ? 1 : 0;
        database
          .prepare(
            `UPDATE context_asset_chunks
             SET content = ?, chunk_digest = ?
             WHERE asset_binding_id = ? AND chunk_index = ?`,
          )
          .run(corrupt, contextBrokerSha256.digest(corrupt), row.asset_binding_id, row.chunk_index);
      } else if (corruption === "offset") {
        database
          .prepare(
            `UPDATE context_asset_chunks SET byte_offset = byte_offset + 1
             WHERE chunk_index = 0`,
          )
          .run();
      } else {
        database.prepare("UPDATE context_asset_manifests SET chunk_count = chunk_count + 1").run();
      }
      database.close();

      expect(
        () =>
          new SqliteContextBroker({
            databasePath,
            dependencies: harness.broker.dependencies,
          }),
      ).toThrow(/context asset/u);
    },
  );

  it("backs up and restores durable context chunks and exact read replay", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    const broker = harness.broker as SqliteContextBroker;
    const grant = issueContextGrant(harness);
    const request = contextChunkRequest(harness, grant.grantToken, "request_backup-context", 0, 16);
    const first = await broker.readAsset({ request });
    broker.close();
    const backupPath = join(sandbox.root, "context-backup");
    try {
      await authority.backup(backupPath);
      authority.close();
      const restoredDatabasePath = join(sandbox.root, "context-restored.db");
      const restoredAssetDirectory = join(sandbox.root, "context-restored-assets");
      const restoredAuthority = restoreSqliteAuthority({
        ...sandbox.options,
        databasePath: restoredDatabasePath,
        assetDirectory: restoredAssetDirectory,
        backupPath,
      });
      restoredAuthority.close();
      const restoredBroker = new SqliteContextBroker({
        databasePath: restoredDatabasePath,
        dependencies: harness.broker.dependencies,
      });
      try {
        expect(await restoredBroker.readAsset({ request })).toEqual(first);
        expect(restoredBroker.authority.snapshot().receipts).toHaveLength(1);
      } finally {
        restoredBroker.close();
      }
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("does not alter command or runner authority snapshots", () => {
    const sandbox = createSandbox();
    let commandAuthority = new SqliteAuthority(sandbox.options);
    let runnerAuthority = configuredSqliteRunner(new SqliteRunnerAuthority(sandbox.options));
    const commandSnapshot = commandAuthority.toCanonicalJson();
    const runnerSnapshot = runnerAuthority.load(runOnceInput());
    commandAuthority.close();
    runnerAuthority.close();
    const harness = createSqliteContextBrokerHarnessAt(sandbox.options.databasePath, () => {});
    try {
      issueContextGrant(harness);
      (harness.broker as SqliteContextBroker).close();
      commandAuthority = new SqliteAuthority(sandbox.options);
      runnerAuthority = new SqliteRunnerAuthority(sandbox.options);
      expect(commandAuthority.toCanonicalJson()).toBe(commandSnapshot);
      expect(runnerAuthority.load(runOnceInput())).toEqual(runnerSnapshot);
    } finally {
      commandAuthority.close();
      runnerAuthority.close();
      sandbox.dispose();
    }
  });
});

describe("SQLite runner durability and fencing", () => {
  for (const point of [
    "before-intent-commit",
    "after-intent-commit-before-ack",
    "before-outcome-commit",
    "after-outcome-commit-before-ack",
  ] as const) {
    it(`recovers exactly once across reopen after ${point}`, () => {
      const sandbox = createSandbox();
      let armed = true;
      let authority = configuredSqliteRunner(
        new SqliteRunnerAuthority({
          ...sandbox.options,
          faultInjector(candidate) {
            if (armed && candidate === point) {
              armed = false;
              throw new Error(`crash at ${point}`);
            }
          },
        }),
      );
      authority.enqueue(runnerEffectCommand());
      const host = new FakeEffectHost();
      try {
        expect(() => new FencedRunner(authority, host).runOnce(runOnceInput())).toThrow(
          `crash at ${point}`,
        );
        authority.close();
        authority = new SqliteRunnerAuthority(sandbox.options);

        const recoveryLease =
          point === "before-outcome-commit"
            ? authority.acquireRunLease(
                runnerFixture.repositoryId,
                runnerFixture.runId,
                "runner-owner-crash-recovery",
                "2026-08-12T13:00:00.001Z",
                "2026-08-12T14:00:00.000Z",
              )
            : runnerFixture.lease;
        const recovered = new FencedRunner(authority, host).runOnce(
          runOnceInput({
            lease: recoveryLease,
            currentTime:
              point === "before-outcome-commit"
                ? "2026-08-12T13:00:00.002Z"
                : runnerFixture.currentTime,
            attemptId: `runner-attempt-recover-${point}`,
          }),
        );
        expect(recovered.type).toBe(
          point === "after-outcome-commit-before-ack" ? "idle" : "committed",
        );
        expect(authority.load(runOnceInput()).effects[0]?.outcome?.status).toBe("completed");
        expect(host.dispatchCalls).toBe(1);
        expect(
          authority
            .queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)
            .filter(({ status }) => status === "completed"),
        ).toHaveLength(1);
      } finally {
        authority.close();
        sandbox.dispose();
      }
    });
  }

  it("rejects a stale fence and reconciles under the takeover fence", () => {
    const sandbox = createSandbox();
    let armed = true;
    let authority = configuredSqliteRunner(
      new SqliteRunnerAuthority({
        ...sandbox.options,
        faultInjector(point) {
          if (armed && point === "after-intent-commit-before-ack") {
            armed = false;
            throw new Error("crash after intent commit");
          }
        },
      }),
    );
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost();
    try {
      expect(() => new FencedRunner(authority, host).runOnce(runOnceInput())).toThrow(
        "crash after intent commit",
      );
      authority.close();
      authority = new SqliteRunnerAuthority(sandbox.options);
      const takeover = authority.acquireRunLease(
        runnerFixture.repositoryId,
        runnerFixture.runId,
        "runner-owner-takeover",
        "2026-08-12T13:00:00.001Z",
        "2026-08-12T14:00:00.000Z",
      );

      expect(() =>
        new FencedRunner(authority, host).runOnce(
          runOnceInput({
            currentTime: "2026-08-12T12:30:00.000Z",
            attemptId: "runner-attempt-stale-owner",
          }),
        ),
      ).toThrow(StaleLeaseFenceError);
      expect(host.dispatchCalls + host.inspectCalls + host.cancelCalls).toBe(0);
      expect(
        new FencedRunner(authority, host).runOnce(
          runOnceInput({
            lease: takeover,
            currentTime: "2026-08-12T13:00:00.002Z",
            attemptId: "runner-attempt-takeover",
          }),
        ),
      ).toMatchObject({
        type: "committed",
        outcome: { owner: takeover.owner, fence: takeover.fence, status: "completed" },
      });
      expect(host.dispatchCalls).toBe(1);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("refuses to commit another run's intent under the wrong fence", () => {
    const sandbox = createSandbox();
    const authority = configuredSqliteRunner(new SqliteRunnerAuthority(sandbox.options));
    const otherRunId = "run_runner-other";
    authority.configureRun({
      repositoryId: runnerFixture.repositoryId,
      runId: otherRunId,
      contextDigest: runnerFixture.contextDigest,
      budgets: [{ unit: "model-millidollars", limit: 10 }],
      lease: runnerFixture.lease,
    });
    const command = runnerEffectCommand({
      commandId: "runner-command-other-run",
      runId: otherRunId,
      operationId: "operation_runner-other-run",
    });
    authority.enqueue(command);
    try {
      const persisted = authority.persistIntent({
        ...runOnceInput({ runId: otherRunId, attemptId: "runner-attempt-other-intent" }),
        command,
      });
      if (persisted.type !== "persisted") throw new Error("Expected durable intent");
      expect(
        authority.claimEffectAttempt({
          ...runOnceInput({ runId: otherRunId, attemptId: "runner-attempt-other-outcome" }),
          intent: persisted.intent,
          contextDigest: runnerFixture.contextDigest,
        }),
      ).toMatchObject({ type: "claimed", action: "inspection" });

      expect(() =>
        authority.commitEffect({
          ...runOnceInput({ attemptId: "runner-attempt-other-outcome" }),
          intent: persisted.intent,
          observation: {
            status: "completed",
            observedAt: runnerFixture.currentTime,
            usage: { unit: "model-millidollars", amount: 2 },
          },
        }),
      ).toThrow("does not match the durable intent");
      expect(
        authority.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
      ).toMatchObject({ reserved: 0, spent: 0 });
      expect(authority.queryBudgets(runnerFixture.repositoryId, otherRunId)[0]).toMatchObject({
        reserved: 5,
        spent: 0,
      });
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("keeps duplicate wakes and exact attempts idempotent after reopen", () => {
    const sandbox = createSandbox();
    let authority = configuredSqliteRunner(new SqliteRunnerAuthority(sandbox.options));
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost();
    try {
      expect(new FencedRunner(authority, host).runOnce(runOnceInput()).type).toBe("committed");
      authority.close();
      authority = new SqliteRunnerAuthority(sandbox.options);
      expect(new FencedRunner(authority, host).runOnce(runOnceInput())).toEqual({ type: "idle" });
      expect(host.dispatchCalls).toBe(1);
      expect(
        authority
          .queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)
          .filter(({ status }) => status === "completed"),
      ).toHaveLength(1);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("does not append exact active replays or replace terminal outcomes", () => {
    const sandbox = createSandbox();
    const authority = configuredSqliteRunner(new SqliteRunnerAuthority(sandbox.options));
    authority.enqueue(runnerEffectCommand());
    const activeHost = new FakeEffectHost({
      dispatch(intent, currentHost) {
        const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
        currentHost.observations.set(intent.command.operationId, active);
        return active;
      },
    });
    const input = runOnceInput({ attemptId: "runner-attempt-exact-replay" });
    try {
      const runner = new FencedRunner(authority, activeHost);
      expect(runner.runOnce(input)).toMatchObject({ outcome: { status: "active" } });
      const receiptCount = authority.queryReceipts(
        runnerFixture.repositoryId,
        runnerFixture.runId,
      ).length;
      const hostCalls = activeHost.dispatchCalls + activeHost.inspectCalls + activeHost.cancelCalls;
      expect(runner.runOnce(input)).toMatchObject({ outcome: { status: "active" } });
      expect(authority.queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)).toHaveLength(
        receiptCount,
      );
      expect(activeHost.dispatchCalls + activeHost.inspectCalls + activeHost.cancelCalls).toBe(
        hostCalls,
      );

      const completed = runner.runOnce(runOnceInput({ attemptId: "runner-attempt-completed" }));
      expect(completed).toMatchObject({ outcome: { status: "active" } });
      const intent = authority.load(runOnceInput()).effects[0]?.intent;
      if (intent === undefined) throw new Error("Expected durable effect intent");
      expect(
        authority.claimEffectAttempt({
          ...runOnceInput({ attemptId: "runner-attempt-terminal" }),
          intent,
          contextDigest: runnerFixture.contextDigest,
        }),
      ).toMatchObject({ type: "claimed", action: "inspection" });
      const terminal = authority.commitEffect({
        ...runOnceInput({ attemptId: "runner-attempt-terminal" }),
        intent,
        observation: {
          status: "completed",
          observedAt: runnerFixture.currentTime,
          outputDigest: runnerFixture.outputDigest,
          usage: { unit: "model-millidollars", amount: 2 },
        },
      });
      expect(
        authority.commitEffect({
          ...runOnceInput({ attemptId: "runner-attempt-conflicting-terminal" }),
          intent,
          observation: { status: "failed", observedAt: runnerFixture.currentTime },
        }),
      ).toEqual(terminal);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it.each(["active", "unknown"] as const)("bounds durable %s reconciliation attempts", (status) => {
    const sandbox = createSandbox();
    let authority = configuredSqliteRunner(new SqliteRunnerAuthority(sandbox.options));
    authority.enqueue(runnerEffectCommand({ maxReconciliationAttempts: 1 }));
    const host = new FakeEffectHost({
      dispatch(intent, currentHost) {
        if (status === "unknown") throw new Error("dispatch state unavailable");
        const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
        currentHost.observations.set(intent.command.operationId, active);
        return active;
      },
      inspect() {
        return { status, observedAt: runnerFixture.currentTime };
      },
    });
    try {
      expect(new FencedRunner(authority, host).runOnce(runOnceInput())).toMatchObject({
        outcome: { status },
      });
      authority.close();
      authority = new SqliteRunnerAuthority(sandbox.options);
      const runner = new FencedRunner(authority, host);
      if (status === "active") {
        expect(
          runner.runOnce(runOnceInput({ attemptId: "runner-attempt-active-reconcile" })),
        ).toMatchObject({ outcome: { status: "active", reconciliationAttempts: 1 } });
      }
      expect(
        runner.runOnce(runOnceInput({ attemptId: "runner-attempt-bounded-settlement" })),
      ).toMatchObject({
        type: "committed",
        outcome: {
          status: "failed",
          details: { reason: "reconciliation-limit-reached", previousStatus: status },
          reconciliationAttempts: 1,
          usage: { reserved: 5, unreported: 5 },
        },
      });
      expect(
        authority.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
      ).toMatchObject({ reserved: 0, spent: 5, unreported: 5 });
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("persists fenced cancellation and cancels an active effect after reopen", () => {
    const sandbox = createSandbox();
    let authority = configuredSqliteRunner(new SqliteRunnerAuthority(sandbox.options));
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost({
      dispatch(intent, currentHost) {
        const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
        currentHost.observations.set(intent.command.operationId, active);
        return active;
      },
    });
    try {
      expect(new FencedRunner(authority, host).runOnce(runOnceInput())).toMatchObject({
        outcome: { status: "active" },
      });
      authority.requestCancellation({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        operationId: "operation_runner-effect",
        requestedAt: runnerFixture.currentTime,
        lease: runnerFixture.lease,
        currentTime: runnerFixture.currentTime,
      });
      expect(
        authority.queryReceipts(runnerFixture.repositoryId, runnerFixture.runId).at(-1),
      ).toMatchObject({ status: "cancellation-requested" });
      expect(
        authority.queryEvents(runnerFixture.repositoryId, runnerFixture.runId).at(-1),
      ).toMatchObject({ eventType: "effect-cancellation-requested" });
      authority.close();
      authority = new SqliteRunnerAuthority(sandbox.options);

      expect(
        new FencedRunner(authority, host).runOnce(
          runOnceInput({ attemptId: "runner-attempt-cancel" }),
        ),
      ).toMatchObject({ outcome: { status: "cancelled" } });
      expect(host.cancelCalls).toBe(1);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("records stale context outcomes without projecting them", () => {
    const sandbox = createSandbox();
    let armed = true;
    let authority = configuredSqliteRunner(
      new SqliteRunnerAuthority({
        ...sandbox.options,
        faultInjector(point) {
          if (armed && point === "after-intent-commit-before-ack") {
            armed = false;
            throw new Error("crash after intent commit");
          }
        },
      }),
    );
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost();
    try {
      expect(() => new FencedRunner(authority, host).runOnce(runOnceInput())).toThrow(
        "crash after intent commit",
      );
      authority.close();
      authority = new SqliteRunnerAuthority(sandbox.options);
      authority.updateContext({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        contextDigest: "d".repeat(64),
        lease: runnerFixture.lease,
        currentTime: runnerFixture.currentTime,
      });

      expect(
        new FencedRunner(authority, host).runOnce(
          runOnceInput({ attemptId: "runner-attempt-stale-context" }),
        ),
      ).toMatchObject({
        outcome: {
          status: "cancelled",
          freshness: "stale",
          details: { reason: "stale-context-before-dispatch" },
        },
      });
      expect(
        authority.queryProjection(runnerFixture.repositoryId, runnerFixture.runId).effects,
      ).toEqual([]);
      expect(host.dispatchCalls).toBe(0);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("persists budget escalation without reserving exhausted spend", () => {
    const sandbox = createSandbox();
    let authority = configuredSqliteRunner(new SqliteRunnerAuthority(sandbox.options));
    authority.enqueue(
      runnerEffectCommand({ budgetReservation: { unit: "model-millidollars", amount: 11 } }),
    );
    try {
      expect(
        new FencedRunner(authority, new FakeEffectHost()).runOnce(runOnceInput()),
      ).toMatchObject({
        type: "escalated",
        escalation: { reason: "budget-exhausted", available: 10 },
      });
      authority.close();
      authority = new SqliteRunnerAuthority(sandbox.options);
      expect(authority.load(runOnceInput()).escalations).toHaveLength(1);
      expect(
        authority.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
      ).toMatchObject({ reserved: 0, spent: 0 });
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("does not alter canonical command snapshots or connection caches", () => {
    const sandbox = createSandbox();
    const commandAuthority = new SqliteAuthority(sandbox.options);
    const runnerAuthority = new SqliteRunnerAuthority(sandbox.options);
    try {
      commandAuthority.submit(instantiateCommand("command_runner-isolation"), admission());
      const before = commandAuthority.toCanonicalJson();
      const revision = commandAuthority.revision();
      configuredSqliteRunner(runnerAuthority);
      runnerAuthority.enqueue(runnerEffectCommand());
      expect(
        new FencedRunner(runnerAuthority, new FakeEffectHost()).runOnce(runOnceInput()).type,
      ).toBe("committed");

      expect(commandAuthority.toCanonicalJson()).toBe(before);
      expect(commandAuthority.revision()).toBe(revision);
      expect(commandAuthority.queryReceipt("command_runner-isolation")?.status).toBe("completed");
    } finally {
      runnerAuthority.close();
      commandAuthority.close();
      sandbox.dispose();
    }
  });
});

describe("SQLite authority durability", () => {
  it("allows two concurrent constructors to initialize one database", async () => {
    const sandbox = createSandbox();
    const workerSource = `const { parentPort, workerData } = require("node:worker_threads");
      const { createHash } = require("node:crypto");
      import(workerData.storageModuleUrl).then((storage) => {
        parentPort.postMessage("ready");
        parentPort.once("message", () => {
          try {
            const authority = new storage.SqliteAuthority({
              databasePath: workerData.databasePath,
              assetDirectory: workerData.assetDirectory,
              busyTimeoutMs: 1_000,
              dependencies: {
                sha256: {
                  digest(bytes) {
                    return createHash("sha256").update(bytes).digest("hex");
                  },
                },
                authorization: { authorize() { return false; } },
              },
            });
            parentPort.postMessage({ revision: authority.revision() });
            authority.close();
          } catch (error) {
            parentPort.postMessage({ error: error instanceof Error ? error.stack : String(error) });
          }
        });
      });`;
    const workerData = {
      databasePath: sandbox.options.databasePath,
      assetDirectory: sandbox.options.assetDirectory,
      storageModuleUrl: new URL("../src/index.ts", import.meta.url).href,
    };
    const workers = [
      new Worker(workerSource, {
        eval: true,
        execArgv: ["--experimental-strip-types"],
        workerData,
      }),
      new Worker(workerSource, {
        eval: true,
        execArgv: ["--experimental-strip-types"],
        workerData,
      }),
    ];
    try {
      await Promise.all(workers.map((worker) => once(worker, "message")));
      const results = workers.map((worker) => once(worker, "message"));
      for (const worker of workers) worker.postMessage("start");
      expect((await Promise.all(results)).map(([result]) => result)).toEqual([
        { revision: 0 },
        { revision: 0 },
      ]);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      sandbox.dispose();
    }
  });

  it("serializes concurrent independent writers and rejects a stale revision", async () => {
    const sandbox = createSandbox();
    const first = new SqliteAuthority(sandbox.options);
    const second = new SqliteAuthority(sandbox.options);
    const writer = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const Database = require("better-sqlite3");
       const database = new Database(workerData);
       database.exec("BEGIN IMMEDIATE");
       parentPort.postMessage("locked");
       setTimeout(() => {
         database.exec("COMMIT");
         database.close();
       }, 100);`,
      { eval: true, workerData: sandbox.options.databasePath },
    );
    try {
      const staleRevision = second.revision();
      const staleSnapshot = second.toCanonicalJson();
      await once(writer, "message");
      const writerExit = once(writer, "exit");
      const receipt = first.submit(instantiateCommand("command_independent-writer"), admission());
      await writerExit;
      expect(receipt.status).toBe("completed");
      expect(second.queryReceipt(receipt.commandId)).toEqual(receipt);
      expect(() => second.compareAndSwapSnapshot(staleRevision, staleSnapshot)).toThrow(
        StaleAuthorityRevisionError,
      );
      expect(second.toCanonicalJson()).toBe(first.toCanonicalJson());
    } finally {
      first.close();
      second.close();
      await writer.terminate();
      sandbox.dispose();
    }
  });

  it("refreshes stale connection caches before executing the next command", () => {
    const sandbox = createSandbox();
    const first = new SqliteAuthority(sandbox.options);
    const second = new SqliteAuthority(sandbox.options);
    const connectionAdmission = createAdmissionFixture();
    try {
      expect(
        first.submit(instantiateCommand("command_cache-owner"), connectionAdmission.at()).status,
      ).toBe("completed");
      const conflictCommand = {
        ...instantiateCommand("command_cache-conflict"),
        runId: "run_cache-conflict",
      };
      const repositoryConflict = second.submit(conflictCommand, connectionAdmission.at());
      expect(repositoryConflict.error?.code).toBe("repository-run-conflict");

      const conflict = first.submit(
        instantiateCommand(conflictCommand.commandId),
        connectionAdmission.at(),
      );
      expect(conflict.error?.code).toBe("command-id-conflict");
      expect(first.revision()).toBe(2);
      expect(first.queryReceipt(conflictCommand.commandId)).toEqual(repositoryConflict);
    } finally {
      first.close();
      second.close();
      sandbox.dispose();
    }
  });

  it("completes a full command journey across connection reopen", () => {
    const sandbox = createSandbox();
    let authority = new SqliteAuthority(sandbox.options);
    const journeyAdmission = createAdmissionFixture();
    try {
      const graph = createRuntimeGraph();
      expect(
        authority.submit(instantiateCommand("command_journey-instantiate"), journeyAdmission.at())
          .status,
      ).toBe("completed");
      authority = reopen(authority, sandbox.options);

      const completion = authority.submit(
        runtimeCommand({
          commandId: "command_journey-completion",
          intent: "submit-completion",
          payload: completionPayload(),
          expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
          expectedGraphRevision: graph.revisionDigest,
        }),
        journeyAdmission.at(),
      );
      expect(completion.status).toBe("completed");
      authority = reopen(authority, sandbox.options);

      const assessment = (completion.result as unknown as { assessment: AccountingAssessment })
        .assessment;
      const gate = acceptedGate(graph, assessment);
      expect(
        authority.submit(
          runtimeCommand({
            commandId: "command_journey-gate",
            intent: "evaluate-gate",
            payload: {
              phase: runtimeFixture.phase,
              dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
              gateDefinition: gate.definition,
              readings: [gate.reading],
            },
            expectedGraphRevision: graph.revisionDigest,
            exactObjectDigest: gate.candidateDigest,
          }),
          journeyAdmission.at(),
        ).status,
      ).toBe("completed");
      authority = reopen(authority, sandbox.options);

      const closure = authority.submit(
        runtimeCommand({
          commandId: "command_journey-close",
          intent: "close-phase",
          payload: {},
          expectedGraphRevision: graph.revisionDigest,
          exactObjectDigest: gate.candidateDigest,
        }),
        journeyAdmission.at(),
      );
      expect(closure.status).toBe("completed");
      authority = reopen(authority, sandbox.options);
      expect(
        authority.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)?.payload,
      ).toMatchObject({ status: "closed" });
      expect(
        authority.queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId),
      ).toHaveLength(12);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("rolls back before commit and makes post-commit acknowledgement loss retryable", () => {
    for (const faultPoint of [
      "before-command-commit",
      "after-command-commit-before-ack",
    ] as const) {
      const sandbox = createSandbox();
      let armed = true;
      const options = {
        ...sandbox.options,
        faultInjector(point: SqliteFaultPoint) {
          if (armed && point === faultPoint) {
            armed = false;
            throw new Error(`injected ${point}`);
          }
        },
      };
      const command = instantiateCommand(`command_${faultPoint}`);
      const authority = new SqliteAuthority(options);
      expect(() => authority.submit(command, admission())).toThrow(`injected ${faultPoint}`);
      authority.close();

      const reopened = new SqliteAuthority(sandbox.options);
      try {
        if (faultPoint === "before-command-commit") {
          expect(reopened.queryReceipt(command.commandId)).toBeUndefined();
        } else {
          const committed = reopened.queryReceipt(command.commandId);
          expect(committed?.status).toBe("completed");
          expect(reopened.submit(command, admission())).toEqual(committed);
        }
      } finally {
        reopened.close();
        sandbox.dispose();
      }
    }
  });

  it.each(["after-command-execution", "before-command-commit"] as const)(
    "restores the connection cache after a %s rollback",
    (faultPoint) => {
      const sandbox = createSandbox();
      let armed = true;
      const command = instantiateCommand(`command_cache-rollback-${faultPoint}`);
      const authority = new SqliteAuthority({
        ...sandbox.options,
        faultInjector(point) {
          if (armed && point === faultPoint) {
            armed = false;
            throw new Error(`injected ${faultPoint}`);
          }
        },
      });
      try {
        expect(() => authority.submit(command, admission())).toThrow(`injected ${faultPoint}`);
        const retry = authority.submit(command, admission());
        expect(retry.status).toBe("completed");
        expect(authority.revision()).toBe(1);
        expect(
          authority.queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId),
        ).toHaveLength(3);
      } finally {
        authority.close();
        const reopened = new SqliteAuthority(sandbox.options);
        expect(reopened.queryReceipt(command.commandId)?.status).toBe("completed");
        reopened.close();
        sandbox.dispose();
      }
    },
  );

  it("appends normalized command lifecycles without rewriting prior history", () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const incrementalAdmission = createAdmissionFixture();
    try {
      authority.submit(instantiateCommand("command_incremental-first"), incrementalAdmission.at());
      const database = new Database(sandbox.options.databasePath);
      database.exec(`
        CREATE TRIGGER reject_command_update
        BEFORE UPDATE ON commands BEGIN
          SELECT RAISE(ABORT, 'existing command update');
        END;
        CREATE TRIGGER reject_receipt_delete
        BEFORE DELETE ON receipt_history BEGIN
          SELECT RAISE(ABORT, 'receipt history delete');
        END;
        CREATE TRIGGER reject_event_delete
        BEFORE DELETE ON event_frames BEGIN
          SELECT RAISE(ABORT, 'event frame delete');
        END;
      `);
      database.close();

      const refusal = authority.submit(
        {
          ...instantiateCommand("command_incremental-second"),
          payloadDigest: "0".repeat(64),
        },
        incrementalAdmission.at(),
      );
      expect(refusal.error?.code).toBe("payload-digest-mismatch");
      expect(
        authority.queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId),
      ).toHaveLength(6);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("increments lease fences on takeover and refuses stale-owner writes", () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    try {
      authority.submit(instantiateCommand("command_lease-run"), admission());
      const first = authority.acquireLease({
        resourceKey: "runner",
        ownerId: "owner_first",
        currentTime: "2026-08-12T12:00:00.000Z",
        expiresAt: "2026-08-12T12:01:00.000Z",
      });
      expect(first.fence).toBe(1);
      expect(() =>
        authority.acquireLease({
          resourceKey: "runner",
          ownerId: "owner_second",
          currentTime: "2026-08-12T12:00:30.000Z",
          expiresAt: "2026-08-12T12:02:00.000Z",
        }),
      ).toThrow(LeaseUnavailableError);
      const second = authority.acquireLease({
        resourceKey: "runner",
        ownerId: "owner_second",
        currentTime: "2026-08-12T12:01:01.000Z",
        expiresAt: "2026-08-12T12:03:00.000Z",
      });
      expect(second.fence).toBe(2);
      expect(() =>
        authority.recordCancellationPlaceholder({
          requestId: "cancellation_stale",
          runId: runtimeFixture.runId,
          resourceKey: first.resourceKey,
          ownerId: first.ownerId,
          fence: first.fence,
          requestedAt: "2026-08-12T12:01:02.000Z",
          currentTime: "2026-08-12T12:01:02.000Z",
        }),
      ).toThrow(StaleLeaseFenceError);
      const third = authority.acquireLease({
        resourceKey: "runner",
        ownerId: "owner_second",
        currentTime: "2026-08-12T12:03:01.000Z",
        expiresAt: "2026-08-12T12:04:00.000Z",
      });
      expect(third.fence).toBe(3);
      expect(() =>
        authority.recordCancellationPlaceholder({
          requestId: "cancellation_current",
          runId: runtimeFixture.runId,
          resourceKey: third.resourceKey,
          ownerId: third.ownerId,
          fence: third.fence,
          requestedAt: "2026-08-12T12:03:02.000Z",
          currentTime: "2026-08-12T12:03:02.000Z",
        }),
      ).not.toThrow();
      expect(() =>
        authority.recordCancellationPlaceholder({
          requestId: "cancellation_backdated",
          runId: runtimeFixture.runId,
          resourceKey: third.resourceKey,
          ownerId: third.ownerId,
          fence: third.fence,
          requestedAt: "2026-08-12T12:03:59.000Z",
          currentTime: "2026-08-12T12:03:58.000Z",
        }),
      ).toThrow(/requestedAt must not be later/);
      expect(() =>
        authority.recordCancellationPlaceholder({
          requestId: "cancellation_expired",
          runId: runtimeFixture.runId,
          resourceKey: third.resourceKey,
          ownerId: third.ownerId,
          fence: third.fence,
          requestedAt: "2026-08-12T12:03:59.000Z",
          currentTime: "2026-08-12T12:04:00.000Z",
        }),
      ).toThrow(StaleLeaseFenceError);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("rejects empty and oversized lease and cancellation identifiers", () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    try {
      expect(() =>
        authority.acquireLease({
          resourceKey: "",
          ownerId: "owner",
          currentTime: "2026-08-12T12:00:00.000Z",
          expiresAt: "2026-08-12T12:01:00.000Z",
        }),
      ).toThrow(/resourceKey/);
      expect(() =>
        authority.acquireLease({
          resourceKey: "runner",
          ownerId: "x".repeat(129),
          currentTime: "2026-08-12T12:00:00.000Z",
          expiresAt: "2026-08-12T12:01:00.000Z",
        }),
      ).toThrow(/ownerId/);
      expect(() =>
        authority.recordCancellationPlaceholder({
          requestId: "",
          runId: "run",
          resourceKey: "runner",
          ownerId: "owner",
          fence: 1,
          requestedAt: "2026-08-12T12:00:00.000Z",
          currentTime: "2026-08-12T12:00:00.000Z",
        }),
      ).toThrow(/requestId/);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("CAS to the empty snapshot clears active pointers and normalized run rows", () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    try {
      authority.submit(instantiateCommand("command_cas-removal"), admission());
      const emptySnapshot = '{"runs":[],"version":"senawa.dev/runtime-memory/v1alpha1"}';
      authority.compareAndSwapSnapshot(authority.revision(), emptySnapshot);
      expect(authority.toCanonicalJson()).toBe(emptySnapshot);
      authority.close();

      const database = new Database(sandbox.options.databasePath, { readonly: true });
      try {
        expect(
          database
            .prepare(
              `SELECT
                 (SELECT count(*) FROM repositories) AS repositories,
                 (SELECT count(*) FROM runs) AS runs,
                 (SELECT count(*) FROM commands) AS commands,
                 (SELECT count(*) FROM receipt_history) AS receipts,
                 (SELECT count(*) FROM event_frames) AS events`,
            )
            .get(),
        ).toEqual({ repositories: 0, runs: 0, commands: 0, receipts: 0, events: 0 });
      } finally {
        database.close();
      }
      expect(() => new SqliteAuthority(sandbox.options)).not.toThrow();
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it.each([
    ["missing row", "DELETE FROM event_frames WHERE cursor = 1"],
    ["altered row", "UPDATE runs SET cursor = cursor + 1"],
  ])("refuses startup when normalized tables contain an %s", (_case, sql) => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    authority.submit(
      instantiateCommand(`command_normalized-${_case.replace(" ", "-")}`),
      admission(),
    );
    authority.close();
    const tampered = new Database(sandbox.options.databasePath);
    tampered.exec(sql);
    tampered.close();
    expect(() => new SqliteAuthority(sandbox.options)).toThrow(/normalized authority tables/);
    sandbox.dispose();
  });

  it("never commits an asset descriptor before digest bytes are installed", () => {
    for (const faultPoint of [
      "after-asset-stage",
      "after-asset-install",
      "before-asset-descriptor-commit",
      "after-asset-descriptor-commit-before-ack",
    ] as const) {
      const sandbox = createSandbox();
      let armed = true;
      const authority = new SqliteAuthority({
        ...sandbox.options,
        faultInjector(point) {
          if (armed && point === faultPoint) {
            armed = false;
            throw new Error(`injected ${point}`);
          }
        },
      });
      const bytes = new TextEncoder().encode(`asset:${faultPoint}`);
      const digest = deterministicSha256.digest(bytes);
      expect(() => authority.putAsset(bytes, "text/plain")).toThrow(`injected ${faultPoint}`);
      authority.close();

      const reopened = new SqliteAuthority(sandbox.options);
      try {
        if (faultPoint === "after-asset-descriptor-commit-before-ack") {
          expect(reopened.getAsset(digest)).toEqual(bytes);
          expect(reopened.putAsset(bytes, "text/plain").digest).toBe(digest);
        } else {
          expect(reopened.getAsset(digest)).toBeUndefined();
        }
      } finally {
        reopened.close();
        sandbox.dispose();
      }
    }
  });

  it("refuses reads and startup when committed asset bytes are missing", () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const descriptor = authority.putAsset(new TextEncoder().encode("required asset"));
    rmSync(join(sandbox.options.assetDirectory, descriptor.relativePath));
    try {
      expect(() => authority.getAsset(descriptor.digest)).toThrow(/missing or unreadable/);
    } finally {
      authority.close();
    }
    expect(() => new SqliteAuthority(sandbox.options)).toThrow(/missing or unreadable/);
    sandbox.dispose();
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked CAS shard escape", () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const outside = join(sandbox.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(sandbox.options.assetDirectory, "sha256"));
    try {
      expect(() => authority.putAsset(new TextEncoder().encode("escape attempt"))).toThrow(
        /not a real directory/,
      );
      expect(existsSync(join(outside, "escape attempt"))).toBe(false);
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("refuses non-directory and hard-linked CAS destinations", () => {
    for (const scenario of ["non-directory", "hard-link"] as const) {
      const sandbox = createSandbox();
      const authority = new SqliteAuthority(sandbox.options);
      const bytes = new TextEncoder().encode(`asset ${scenario}`);
      const digest = deterministicSha256.digest(bytes);
      const shardRoot = join(sandbox.options.assetDirectory, "sha256");
      if (scenario === "non-directory") {
        writeFileSync(shardRoot, "not a directory");
      } else {
        const shard = join(shardRoot, digest.slice(0, 2));
        mkdirSync(shard, { recursive: true });
        const outside = join(sandbox.root, "outside-asset");
        writeFileSync(outside, bytes);
        linkSync(outside, join(shard, digest));
      }
      try {
        expect(() => authority.putAsset(bytes)).toThrow(
          scenario === "non-directory" ? /not a real directory/ : /missing or unreadable/,
        );
        expect(authority.getAsset(digest)).toBeUndefined();
      } finally {
        authority.close();
        sandbox.dispose();
      }
    }
  });

  it("applies atomic migrations and refuses checksum drift and newer schemas", () => {
    const sandbox = createSandbox();
    const interrupted = new Database(sandbox.options.databasePath);
    interrupted.exec("BEGIN; CREATE TABLE interrupted_probe(value TEXT); ROLLBACK;");
    interrupted.close();
    const authority = new SqliteAuthority(sandbox.options);
    authority.close();

    const tampered = new Database(sandbox.options.databasePath);
    tampered
      .prepare("UPDATE migration_metadata SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
    tampered.close();
    expect(() => new SqliteAuthority(sandbox.options)).toThrow(/migration metadata/);

    const newerPath = join(sandbox.root, "newer.db");
    const newer = new Database(newerPath);
    newer.pragma("user_version = 4");
    newer.close();
    expect(
      () =>
        new SqliteAuthority({
          ...sandbox.options,
          databasePath: newerPath,
        }),
    ).toThrow(UnsupportedSchemaVersionError);
    sandbox.dispose();
  });

  it("backs up, verifies, and restores a self-contained bundle", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const command = instantiateCommand("command_backup");
    const bytes = new TextEncoder().encode("backup asset");
    try {
      const receipt = authority.submit(command, admission());
      const descriptor = authority.putAsset(bytes, "text/plain");
      const backupPath = join(sandbox.root, "backup.db");
      await authority.backup(backupPath);
      expect(() =>
        restoreSqliteAuthority({
          ...sandbox.options,
          backupPath,
        }),
      ).toThrow(/must not already exist/);
      authority.close();
      rmSync(sandbox.options.assetDirectory, { recursive: true });

      const restoredPath = join(sandbox.root, "restored.db");
      const restoredAssetDirectory = join(sandbox.root, "restored-assets");
      const restored = restoreSqliteAuthority({
        ...sandbox.options,
        databasePath: restoredPath,
        assetDirectory: restoredAssetDirectory,
        backupPath,
      });
      try {
        expect(restored.queryReceipt(command.commandId)).toEqual(receipt);
        expect(restored.getAsset(descriptor.digest)).toEqual(bytes);
        expect(
          Uint8Array.from(readFileSync(join(restoredAssetDirectory, descriptor.relativePath))),
        ).toEqual(bytes);
      } finally {
        restored.close();
      }

      const corruptPath = join(sandbox.root, "corrupt.db");
      cpSync(backupPath, corruptPath, { recursive: true });
      const corruptDatabasePath = join(corruptPath, "authority.db");
      const corrupt = readFileSync(corruptDatabasePath);
      corrupt.fill(0, 0, Math.min(128, corrupt.length));
      writeFileSync(corruptDatabasePath, corrupt);
      expect(() =>
        restoreSqliteAuthority({
          ...sandbox.options,
          databasePath: join(sandbox.root, "corrupt-restored.db"),
          assetDirectory: join(sandbox.root, "corrupt-restored-assets"),
          backupPath: corruptPath,
        }),
      ).toThrow();
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it("refuses active, nested, and existing backup destinations without replacement", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const existing = join(sandbox.root, "existing-backup");
    mkdirSync(existing);
    writeFileSync(join(existing, "sentinel"), "keep");
    try {
      await expect(authority.backup(sandbox.options.databasePath)).rejects.toThrow(
        /already exists/,
      );
      await expect(authority.backup(sandbox.options.assetDirectory)).rejects.toThrow(
        /already exists/,
      );
      await expect(authority.backup(`${sandbox.options.databasePath}-wal`)).rejects.toThrow(
        /already exists|overlaps active authority storage/,
      );
      await expect(authority.backup(`${sandbox.options.databasePath}-shm`)).rejects.toThrow(
        /already exists|overlaps active authority storage/,
      );
      await expect(
        authority.backup(join(sandbox.options.assetDirectory, "nested-backup")),
      ).rejects.toThrow(/overlaps active authority storage/);
      if (process.platform !== "win32") {
        const alias = join(sandbox.root, "authority-alias");
        symlinkSync(sandbox.root, alias);
        await expect(authority.backup(join(alias, "backup"))).rejects.toThrow(
          /not a real directory/,
        );
      }
      await expect(authority.backup(existing)).rejects.toThrow(/already exists/);
      expect(readFileSync(join(existing, "sentinel"), "utf8")).toBe("keep");
    } finally {
      authority.close();
      sandbox.dispose();
    }
  });

  it.each(["missing", "corrupt"])("refuses %s assets in a backup bundle", async (failure) => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const descriptor = authority.putAsset(new TextEncoder().encode("bundled asset"));
    const backupPath = join(sandbox.root, "backup");
    await authority.backup(backupPath);
    authority.close();
    const assetPath = join(backupPath, "assets", descriptor.relativePath);
    if (failure === "missing") {
      rmSync(assetPath);
    } else {
      const corrupt = readFileSync(assetPath);
      corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
      writeFileSync(assetPath, corrupt);
    }
    const restoreRoot = join(sandbox.root, `restore-${failure}`);
    const databasePath = join(restoreRoot, "authority.db");
    const assetDirectory = join(restoreRoot, "assets");
    try {
      expect(() =>
        restoreSqliteAuthority({
          ...sandbox.options,
          databasePath,
          assetDirectory,
          backupPath,
        }),
      ).toThrow(/missing or unreadable|digest verification/);
      expect(existsSync(databasePath)).toBe(false);
      expect(existsSync(assetDirectory)).toBe(false);
    } finally {
      sandbox.dispose();
    }
  });

  it("refuses restore over an existing database or asset destination", async () => {
    const sandbox = createSandbox();
    const authority = new SqliteAuthority(sandbox.options);
    const backupPath = join(sandbox.root, "backup");
    await authority.backup(backupPath);
    authority.close();
    const restoreRoot = join(sandbox.root, "restore-existing");
    mkdirSync(restoreRoot);
    const databasePath = join(restoreRoot, "authority.db");
    const assetDirectory = join(restoreRoot, "assets");
    writeFileSync(databasePath, "keep database");
    expect(() =>
      restoreSqliteAuthority({
        ...sandbox.options,
        databasePath,
        assetDirectory,
        backupPath,
      }),
    ).toThrow(/must not already exist/);
    expect(readFileSync(databasePath, "utf8")).toBe("keep database");

    rmSync(databasePath);
    mkdirSync(assetDirectory);
    writeFileSync(join(assetDirectory, "sentinel"), "keep assets");
    expect(() =>
      restoreSqliteAuthority({
        ...sandbox.options,
        databasePath,
        assetDirectory,
        backupPath,
      }),
    ).toThrow(/must not already exist/);
    expect(readFileSync(join(assetDirectory, "sentinel"), "utf8")).toBe("keep assets");
    sandbox.dispose();
  });

  it.skipIf(process.platform === "win32")(
    "surfaces read-only storage failures without returning a receipt",
    () => {
      const sandbox = createSandbox();
      const initialized = new SqliteAuthority(sandbox.options);
      initialized.close();
      chmodSync(sandbox.options.databasePath, 0o444);
      chmodSync(sandbox.root, 0o555);
      let authority: SqliteAuthority | undefined;
      try {
        expect(() => {
          authority = new SqliteAuthority(sandbox.options);
          authority.submit(instantiateCommand("command_read-only"), admission());
        }).toThrow(/readonly|read-only|SQLITE_READONLY/i);
      } finally {
        authority?.close();
        chmodSync(sandbox.root, 0o755);
        chmodSync(sandbox.options.databasePath, 0o644);
        sandbox.dispose();
      }
    },
  );
});

function createConformanceHarness(): RuntimeAuthorityConformanceHarness {
  const sandbox = createSandbox();
  const authority = new SqliteAuthority(sandbox.options);
  return createHarness(sandbox, authority);
}

function configuredSqliteRunner(authority: SqliteRunnerAuthority): SqliteRunnerAuthority {
  authority.configureRun({
    repositoryId: runnerFixture.repositoryId,
    runId: runnerFixture.runId,
    contextDigest: runnerFixture.contextDigest,
    budgets: [
      { unit: "model-millidollars", limit: 10 },
      { unit: "retry", limit: 2 },
    ],
    lease: runnerFixture.lease,
  });
  return authority;
}

function createRunnerConformanceHarness(): RunnerAuthorityConformanceHarness {
  const sandbox = createSandbox();
  const authority = new SqliteRunnerAuthority(sandbox.options);
  runnerHarnessDisposers.add(() => {
    authority.close();
    sandbox.dispose();
  });
  return {
    authority,
    configureRun: authority.configureRun.bind(authority),
    enqueue: authority.enqueue.bind(authority),
    updateContext: authority.updateContext.bind(authority),
    requestCancellation: authority.requestCancellation.bind(authority),
    queryReceipts: authority.queryReceipts.bind(authority),
    queryEvents: authority.queryEvents.bind(authority),
    queryProjection: authority.queryProjection.bind(authority),
    queryBudgets: authority.queryBudgets.bind(authority),
  };
}

function createSqliteContextBrokerHarness() {
  const root = mkdtempSync(join(tmpdir(), "senawa-context-sqlite-"));
  return createSqliteContextBrokerHarnessAt(join(root, "authority.db"), () => {
    rmSync(root, { recursive: true, force: true });
  });
}

function createSqliteContextBrokerHarnessAt(databasePath: string, cleanup: () => void) {
  const clock = new FakeTrustedClock();
  const tokens = new FakeGrantTokenIssuer();
  const completionFacts: unknown[] = [];
  const broker = new SqliteContextBroker({
    databasePath,
    dependencies: {
      sha256: contextBrokerSha256,
      currentTime: clock.currentTime,
      issueGrantToken: tokens.issue,
    },
    completionFacts: {
      admitCompletionFact(fact) {
        if (!completionFacts.some((entry) => JSON.stringify(entry) === JSON.stringify(fact)))
          completionFacts.push(fact);
      },
    },
    busyTimeoutMs: 500,
  });
  const dispose = () => {
    broker.close();
    cleanup();
  };
  contextHarnessDisposers.add(dispose);
  return initializeContextBrokerHarness({
    authority: broker.authority,
    assetPort: broker.assets,
    broker,
    completionFacts,
    clock,
    tokens,
    dispose,
  });
}

function issueContextGrant(harness: ContextBrokerHarness) {
  return harness.broker.grantAssetAccess({
    repositoryId: harness.dispatch.repositoryId,
    runId: harness.dispatch.runId,
    dispatchId: harness.dispatch.dispatchId,
    assetBindingId: harness.context.assets[0]?.assetBindingId ?? "missing",
    allowedPointer: "/work",
    readMode: "pointer-and-chunk",
    sensitivityCeiling: "confidential",
    expiresAt: "2026-08-13T11:00:00.000Z",
    maxOperations: 4,
    maxBytes: 512,
    maxChunkBytes: 64,
  });
}

function contextChunkRequest(
  harness: ContextBrokerHarness,
  grantToken: string,
  requestId: string,
  offset: number,
  length: number,
) {
  return {
    apiVersion: PROTOCOL_VERSION,
    requestId,
    grantToken,
    assetBindingId: harness.context.assets[0]?.assetBindingId ?? "missing",
    type: "chunk" as const,
    offset,
    length,
  };
}

function contextPointerRequest(
  harness: ContextBrokerHarness,
  grantToken: string,
  requestId: string,
  pointer: string,
  maxBytes: number,
) {
  return {
    apiVersion: PROTOCOL_VERSION,
    requestId,
    grantToken,
    assetBindingId: harness.context.assets[0]?.assetBindingId ?? "missing",
    type: "pointer" as const,
    pointer,
    maxBytes,
  };
}

function contextCompletionSubmission(harness: ContextBrokerHarness, submissionId: string) {
  const completion: CompletionSubmission = {
    task: harness.dispatch.task,
    disposition: "completed",
    summary: "Completed durable SQLite context work",
    criteria: [{ criterionId: criterionId("criterion_done"), disposition: "satisfied" }],
    evidence: [],
  };
  return {
    apiVersion: PROTOCOL_VERSION,
    submissionId,
    repositoryId: harness.dispatch.repositoryId,
    runId: harness.dispatch.runId,
    dispatchId: harness.dispatch.dispatchId,
    task: harness.dispatch.task,
    contextId: harness.context.contextId,
    contextDigest: harness.context.contextDigest,
    principalId: harness.dispatch.worker.principalId,
    type: "completion" as const,
    completion,
  };
}

interface MutableDurableContextReceipt {
  status: "served" | "denied";
  chargedOperations: number;
  chargedBytes: number;
  responseBytes: number;
  remainingOperations: number;
  remainingBytes: number;
  denialCode?: string;
}

interface MutableDurableContextState {
  readonly grants: Array<{
    readonly envelope: Record<string, unknown>;
    operationsUsed: number;
    bytesUsed: number;
  }>;
  readonly reads: Array<{
    canonicalReplayKey: string;
    readonly result: {
      readonly receipt: MutableDurableContextReceipt;
      readonly bytes?: number[];
    };
  }>;
  readonly receipts: MutableDurableContextReceipt[];
  readonly receiptAttempts: Array<{
    canonicalReplayKey: string;
    failureStage?: "asset-read" | "asset-integrity";
    failureFactDigest?: string;
    readonly receipt: MutableDurableContextReceipt;
  }>;
}

function coordinateContextReceiptDenialRelabel(
  databasePath: string,
  requestId: string,
  denialCode: string,
): void {
  mutateDurableContextState(databasePath, (snapshot) => {
    for (const receipt of durableReceiptsForAttempt(snapshot, 0)) {
      receipt.status = "denied";
      receipt.denialCode = denialCode;
    }
  });
  const database = new Database(databasePath);
  try {
    for (const table of ["context_read_attempts", "context_audit_receipts"] as const)
      mutateNormalizedContextReceipt(database, table, requestId, (receipt) => {
        receipt.status = "denied";
        receipt.denialCode = denialCode;
      });
  } finally {
    database.close();
  }
}

function refreshBackupDatabaseManifest(backupPath: string): void {
  const databaseBytes = Uint8Array.from(readFileSync(join(backupPath, "authority.db")));
  const manifestPath = join(backupPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    database: { byteLength: number; digest: string };
  };
  manifest.database.byteLength = databaseBytes.byteLength;
  manifest.database.digest = deterministicSha256.digest(databaseBytes);
  writeFileSync(manifestPath, canonicalStringify(manifest));
}

function durableReceiptsForAttempt(
  snapshot: MutableDurableContextState,
  index: number,
): MutableDurableContextReceipt[] {
  const resultReceipt = snapshot.reads[index]?.result.receipt;
  const auditReceipt = snapshot.receipts[index];
  const attemptReceipt = snapshot.receiptAttempts[index]?.receipt;
  if (resultReceipt === undefined || auditReceipt === undefined || attemptReceipt === undefined)
    throw new Error("Expected all durable receipt representations");
  return [resultReceipt, auditReceipt, attemptReceipt];
}

function mutateNormalizedContextReceipt(
  database: Database.Database,
  table: "context_read_attempts" | "context_audit_receipts",
  requestId: string,
  mutate: (receipt: MutableDurableContextReceipt) => void,
  extraPredicate = "1 = 1",
): void {
  const row = database
    .prepare<[string], { canonical_receipt: string }>(
      `SELECT canonical_receipt FROM ${table} WHERE request_id = ? AND ${extraPredicate}`,
    )
    .get(requestId);
  if (row === undefined) throw new Error(`Expected normalized receipt in ${table}`);
  const receipt = JSON.parse(row.canonical_receipt) as MutableDurableContextReceipt;
  mutate(receipt);
  database
    .prepare(`UPDATE ${table} SET canonical_receipt = ? WHERE request_id = ? AND ${extraPredicate}`)
    .run(canonicalStringify(receipt), requestId);
}

function mutateDurableContextState(
  databasePath: string,
  mutate: (snapshot: MutableDurableContextState) => void,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare<[], { canonical_json: string }>(
        "SELECT canonical_json FROM context_authority_state WHERE singleton = 1",
      )
      .get();
    if (row === undefined) throw new Error("Expected durable context authority fixture");
    const snapshot = JSON.parse(row.canonical_json) as MutableDurableContextState;
    mutate(snapshot);
    database
      .prepare("UPDATE context_authority_state SET canonical_json = ? WHERE singleton = 1")
      .run(canonicalStringify(snapshot));
  } finally {
    database.close();
  }
}

function reopenContextBroker(
  databasePath: string,
  harness: ContextBrokerHarness,
): SqliteContextBroker {
  return new SqliteContextBroker({
    databasePath,
    dependencies: harness.broker.dependencies,
    busyTimeoutMs: 500,
  });
}

function createHarness(
  sandbox: ReturnType<typeof createSandbox>,
  authority: SqliteAuthority,
): RuntimeAuthorityConformanceHarness {
  return {
    service: authority,
    canonicalJson: () => authority.toCanonicalJson(),
    reopen() {
      authority.close();
      return createHarness(sandbox, new SqliteAuthority(sandbox.options));
    },
    dispose() {
      authority.close();
      sandbox.dispose();
    },
  };
}

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "senawa-storage-sqlite-"));
  const options: SqliteAuthorityOptions = {
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies,
    busyTimeoutMs: 500,
  };
  return {
    root,
    options,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function reopen(authority: SqliteAuthority, options: SqliteAuthorityOptions): SqliteAuthority {
  authority.close();
  return new SqliteAuthority(options);
}

function admission() {
  return createAdmissionFixture().at();
}

function instantiateCommand(commandId: string) {
  return runtimeCommand({
    commandId,
    intent: "instantiate-run",
    payload: {
      workflowId: runtimeFixture.workflowId,
      graph: createRuntimeGraph(),
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "no-approval" as const },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
    },
  });
}

function completionPayload() {
  return {
    submission: {
      task: runtimeFixture.task,
      disposition: "completed" as const,
      summary: "Verified SQLite persistence journey",
      criteria: [{ criterionId: runtimeFixture.criterionId, disposition: "satisfied" as const }],
      evidence: [],
    },
  };
}

function acceptedGate(
  graph: ReturnType<typeof createRuntimeGraph>,
  assessment: AccountingAssessment,
) {
  const definition = defineGate(
    {
      key: consumerKey("release"),
      blocking: [
        {
          key: consumerKey("verified"),
          condition: {
            operator: "equals",
            accessor: { sensorKey: consumerKey("quality"), pointer: "/passed" },
            expected: true,
          },
        },
      ],
      advisory: [],
    },
    deterministicSha256,
  );
  const candidate = createPhaseCandidate(
    {
      phase: runtimeFixture.phase,
      graphRevisionDigest: graph.revisionDigest,
      selectedTaskSetDigest: digestSelectedTaskSet([runtimeFixture.task], deterministicSha256),
      tasks: [runtimeFixture.task],
      acceptedAccountingAssessments: [
        {
          assessmentDigest: digestAccountingAssessment(assessment, deterministicSha256),
          assessment,
        },
      ],
      dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
      gatePolicyDigest: definition.policyDigest,
    },
    graph,
    deterministicSha256,
  );
  const reading = createSensorReading(
    {
      sensorKey: consumerKey("quality"),
      inputDigest: candidate.candidateDigest,
      outcome: "succeeded",
      data: { passed: true },
    },
    deterministicSha256,
  );
  return { definition, reading, candidateDigest: candidate.candidateDigest };
}
