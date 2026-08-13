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
  consumerKey,
  createPhaseCandidate,
  createSensorReading,
  defineGate,
  digestAccountingAssessment,
  digestSelectedTaskSet,
} from "@senawa/kernel";
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

afterEach(() => {
  for (const dispose of runnerHarnessDisposers) dispose();
  runnerHarnessDisposers.clear();
});

registerRunnerAuthorityConformance("SQLite", () => createRunnerConformanceHarness());

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
    newer.pragma("user_version = 3");
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
