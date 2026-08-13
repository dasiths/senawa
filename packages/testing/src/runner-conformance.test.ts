import {
  AsyncFencedRunner,
  AsyncRunnerCancelledError,
  FencedRunner,
  InMemoryRunnerAuthority,
  type RunnerFaultPoint,
  type RunnerLeaseFact,
} from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import { registerRunnerAuthorityConformance } from "./runner-authority-conformance.js";
import {
  configuredHarness,
  FakeAsyncEffectHost,
  FakeEffectHost,
  runnerEffectCommand,
  runnerFixture,
  runOnceInput,
  takeoverLease,
} from "./runner-conformance.js";

registerRunnerAuthorityConformance("in-memory", () => {
  const authority = new InMemoryRunnerAuthority();
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
});

describe("fenced runner crash and reconciliation matrix", () => {
  for (const point of [
    "before-intent-persist",
    "after-intent-persist",
    "before-effect-commit",
    "after-effect-commit",
  ] as const) {
    it(`recovers idempotently from ${point}`, () => {
      let armed = true;
      const authority = configuredHarness(
        new InMemoryRunnerAuthority({
          inject(candidate) {
            if (armed && candidate === point) {
              armed = false;
              throw new Error(`crash at ${point}`);
            }
          },
        }),
      );
      authority.enqueue(runnerEffectCommand());
      const host = new FakeEffectHost();
      const runner = new FencedRunner(authority, host);

      expect(() => runner.runOnce(runOnceInput())).toThrow(`crash at ${point}`);
      const snapshotAfterCrash = authority.load(runOnceInput());
      if (point === "before-intent-persist") expect(snapshotAfterCrash.effects).toHaveLength(0);
      if (point === "after-intent-persist" || point === "before-effect-commit") {
        expect(snapshotAfterCrash.effects[0]?.outcome).toBeUndefined();
      }
      if (point === "after-effect-commit") {
        expect(snapshotAfterCrash.effects[0]?.outcome?.status).toBe("completed");
      }

      const recoveryLease =
        point === "before-effect-commit" ? takeoverLease() : runnerFixture.lease;
      if (point === "before-effect-commit") {
        authority.setLease(runnerFixture.repositoryId, runnerFixture.runId, recoveryLease);
      }
      const recovered = runner.runOnce(
        runOnceInput({ lease: recoveryLease, attemptId: `runner-attempt-recover-${point}` }),
      );
      expect(recovered.type).toBe(point === "after-effect-commit" ? "idle" : "committed");
      expect(authority.load(runOnceInput()).effects[0]?.outcome?.status).toBe("completed");
      expect(host.dispatchCalls).toBe(1);
      expect(
        authority
          .queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)
          .filter(({ status }) => status === "completed"),
      ).toHaveLength(1);
    });
  }

  it("reconciles a lost dispatch response without duplicating the operation", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost({
      dispatch(intent, currentHost) {
        currentHost.observations.set(intent.command.operationId, {
          status: "completed",
          observedAt: runnerFixture.currentTime,
          outputDigest: runnerFixture.outputDigest,
          usage: { unit: intent.command.budgetReservation.unit, amount: 4 },
        });
        throw new Error("response lost after effect completion");
      },
    });

    const result = new FencedRunner(authority, host).runOnce(runOnceInput());

    expect(result).toMatchObject({ type: "committed", outcome: { status: "completed" } });
    expect(host.dispatchCalls).toBe(1);
    expect(host.inspectCalls).toBe(1);
  });

  it("keeps unknown explicit and settles conservatively at the reconciliation limit", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand({ maxReconciliationAttempts: 2 }));
    const host = new FakeEffectHost({
      dispatch() {
        throw new Error("dispatch state unavailable");
      },
      inspect() {
        return { status: "unknown", observedAt: runnerFixture.currentTime };
      },
    });
    const runner = new FencedRunner(authority, host);

    expect(runner.runOnce(runOnceInput())).toMatchObject({
      type: "committed",
      outcome: { status: "unknown", reconciliationAttempts: 1 },
    });
    expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-unknown-2" }))).toMatchObject({
      type: "committed",
      outcome: { status: "unknown", reconciliationAttempts: 2 },
    });
    expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-unknown-3" }))).toMatchObject({
      type: "committed",
      outcome: {
        status: "failed",
        details: { reason: "reconciliation-limit-reached", previousStatus: "unknown" },
        reconciliationAttempts: 2,
        usage: { reserved: 5, unreported: 5 },
      },
    });
    expect(
      authority.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
    ).toMatchObject({
      reserved: 0,
      spent: 5,
      unreported: 5,
    });
    expect(host.dispatchCalls).toBe(1);
    expect(host.inspectCalls).toBe(2);
  });

  it.each([
    ["completed", "completed"],
    ["active", "active"],
    ["cancelled", "cancelled"],
    ["unknown", "unknown"],
    ["missing", "completed"],
  ] as const)("reconciles an inspected %s effect as %s", (inspected, expected) => {
    const authority = crashAfterIntentAuthority();
    const host = new FakeEffectHost({
      inspect(intent) {
        if (inspected === "missing") {
          return { status: "missing", observedAt: runnerFixture.currentTime };
        }
        return {
          status: inspected,
          observedAt: runnerFixture.currentTime,
          ...(inspected === "completed"
            ? {
                outputDigest: runnerFixture.outputDigest,
                usage: { unit: intent.command.budgetReservation.unit, amount: 2 },
              }
            : {}),
        };
      },
    });
    const runner = new FencedRunner(authority, host);
    expect(() => runner.runOnce(runOnceInput())).toThrow("crash after durable intent");

    expect(
      runner.runOnce(runOnceInput({ attemptId: `runner-attempt-inspect-${inspected}` })),
    ).toMatchObject({ type: "committed", outcome: { status: expected } });
    expect(host.dispatchCalls).toBe(inspected === "missing" ? 1 : 0);
  });

  it("commits a reported failed dispatch as a terminal outcome", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost({
      dispatch(intent) {
        return {
          status: "failed",
          observedAt: runnerFixture.currentTime,
          details: { code: "worker-refused" },
          usage: { unit: intent.command.budgetReservation.unit, amount: 1 },
        };
      },
    });

    expect(new FencedRunner(authority, host).runOnce(runOnceInput())).toMatchObject({
      type: "committed",
      outcome: { status: "failed", usage: { reported: 1 } },
    });
    expect(new FencedRunner(authority, host).runOnce(runOnceInput())).toEqual({ type: "idle" });
  });

  it("replays an exact active attempt after a later attempt without another transition", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost({
      dispatch(intent, currentHost) {
        const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
        currentHost.observations.set(intent.command.operationId, active);
        return active;
      },
    });
    const runner = new FencedRunner(authority, host);
    const input = runOnceInput({ attemptId: "runner-attempt-replayed" });
    expect(runner.runOnce(input)).toMatchObject({
      type: "committed",
      outcome: { status: "active", reconciliationAttempts: 0 },
    });
    expect(
      runner.runOnce(runOnceInput({ attemptId: "runner-attempt-replayed-later" })),
    ).toMatchObject({
      type: "committed",
      outcome: { status: "active", reconciliationAttempts: 1 },
    });
    const inspectCalls = host.inspectCalls;
    const receiptCount = authority.queryReceipts(
      runnerFixture.repositoryId,
      runnerFixture.runId,
    ).length;

    expect(runner.runOnce(input)).toMatchObject({
      type: "committed",
      outcome: { status: "active", reconciliationAttempts: 0 },
    });
    expect(authority.queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)).toHaveLength(
      receiptCount,
    );
    expect(host.inspectCalls).toBe(inspectCalls);
  });

  it("bounds active reconciliation attempts and settles the reservation", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand({ maxReconciliationAttempts: 2 }));
    const host = new FakeEffectHost({
      dispatch(intent, currentHost) {
        const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
        currentHost.observations.set(intent.command.operationId, active);
        return active;
      },
    });
    const runner = new FencedRunner(authority, host);

    expect(runner.runOnce(runOnceInput())).toMatchObject({
      type: "committed",
      outcome: { status: "active", reconciliationAttempts: 0 },
    });
    expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-active-1" }))).toMatchObject({
      outcome: { reconciliationAttempts: 1 },
    });
    expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-active-2" }))).toMatchObject({
      outcome: { reconciliationAttempts: 2 },
    });
    expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-active-3" }))).toMatchObject({
      type: "committed",
      outcome: {
        status: "failed",
        reconciliationAttempts: 2,
        details: { reason: "reconciliation-limit-reached" },
      },
    });
    expect(host.inspectCalls).toBe(2);
    expect(
      authority.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
    ).toMatchObject({
      reserved: 0,
      spent: 5,
      unreported: 5,
    });
  });

  it("retains deep snapshots of command input and outcome details", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    const callerInput = { task: { key: "verify" } };
    authority.enqueue(runnerEffectCommand({ input: callerInput }));
    callerInput.task.key = "changed-after-queue";
    const hostDetails = { result: { code: "stable" } };
    const host = new FakeEffectHost({
      dispatch(intent) {
        expect(intent.command.input).toEqual({ task: { key: "verify" } });
        expect(Object.isFrozen((intent.command.input as { task: object }).task)).toBe(true);
        return {
          status: "completed",
          observedAt: runnerFixture.currentTime,
          details: hostDetails,
          usage: { unit: intent.command.budgetReservation.unit, amount: 1 },
        };
      },
    });
    const result = new FencedRunner(authority, host).runOnce(runOnceInput());
    hostDetails.result.code = "changed-after-commit";

    expect(result).toMatchObject({
      type: "committed",
      outcome: { details: { result: { code: "stable" } } },
    });
    expect(authority.load(runOnceInput()).effects[0]?.outcome?.details).toEqual({
      result: { code: "stable" },
    });
  });

  it("rejects a stale owner and lets a new fenced owner reconcile", () => {
    const authority = crashAfterIntentAuthority();
    const host = new FakeEffectHost();
    const oldRunner = new FencedRunner(authority, host);
    expect(() => oldRunner.runOnce(runOnceInput())).toThrow("crash after durable intent");
    const takeover = takeoverLease();
    authority.setLease(runnerFixture.repositoryId, runnerFixture.runId, takeover);

    expect(() =>
      oldRunner.runOnce(runOnceInput({ attemptId: "runner-attempt-stale-owner" })),
    ).toThrow("stale or expired lease fence");
    expect(host.dispatchCalls + host.inspectCalls + host.cancelCalls).toBe(0);
    const recovered = oldRunner.runOnce(
      runOnceInput({ lease: takeover, attemptId: "runner-attempt-takeover" }),
    );
    expect(recovered).toMatchObject({
      type: "committed",
      outcome: { owner: takeover.owner, fence: takeover.fence, status: "completed" },
    });
    expect(host.dispatchCalls).toBe(1);
  });

  it("rejects stale context and cancellation mutations without appending transitions", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost({
      dispatch(intent, currentHost) {
        const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
        currentHost.observations.set(intent.command.operationId, active);
        return active;
      },
    });
    expect(new FencedRunner(authority, host).runOnce(runOnceInput())).toMatchObject({
      outcome: { status: "active" },
    });
    const eventCount = authority.queryEvents(
      runnerFixture.repositoryId,
      runnerFixture.runId,
    ).length;
    authority.setLease(runnerFixture.repositoryId, runnerFixture.runId, takeoverLease());

    expect(() =>
      authority.updateContext({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        lease: runnerFixture.lease,
        currentTime: runnerFixture.currentTime,
        contextDigest: "f".repeat(64),
      }),
    ).toThrow("stale or expired lease fence");
    expect(() =>
      authority.requestCancellation({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        operationId: "operation_runner-effect",
        lease: runnerFixture.lease,
        currentTime: runnerFixture.currentTime,
        requestedAt: runnerFixture.currentTime,
      }),
    ).toThrow("stale or expired lease fence");
    expect(authority.queryEvents(runnerFixture.repositoryId, runnerFixture.runId)).toHaveLength(
      eventCount,
    );
  });

  it("records stale semantic output without applying it to the projection", () => {
    let failBeforeCommit = true;
    const authority = configuredHarness(
      new InMemoryRunnerAuthority({
        inject(point) {
          if (point === "before-effect-commit" && failBeforeCommit) {
            failBeforeCommit = false;
            throw new Error("crash before outcome commit");
          }
        },
      }),
    );
    authority.enqueue(runnerEffectCommand());
    const host = new FakeEffectHost();
    const runner = new FencedRunner(authority, host);
    expect(() => runner.runOnce(runOnceInput())).toThrow("crash before outcome commit");
    const takeover = takeoverLease();
    authority.setLease(runnerFixture.repositoryId, runnerFixture.runId, takeover);
    authority.updateContext({
      repositoryId: runnerFixture.repositoryId,
      runId: runnerFixture.runId,
      lease: takeover,
      currentTime: runnerFixture.currentTime,
      contextDigest: "d".repeat(64),
    });

    expect(
      runner.runOnce(runOnceInput({ lease: takeover, attemptId: "runner-attempt-stale-context" })),
    ).toMatchObject({ type: "committed", outcome: { freshness: "stale" } });
    expect(
      authority.queryProjection(runnerFixture.repositoryId, runnerFixture.runId).effects,
    ).toEqual([]);
    expect(host.dispatchCalls).toBe(1);
  });

  it("does not dispatch a missing intent after its context becomes stale", () => {
    const authority = crashAfterIntentAuthority();
    const host = new FakeEffectHost();
    const runner = new FencedRunner(authority, host);
    expect(() => runner.runOnce(runOnceInput())).toThrow("crash after durable intent");
    authority.updateContext({
      repositoryId: runnerFixture.repositoryId,
      runId: runnerFixture.runId,
      lease: runnerFixture.lease,
      currentTime: runnerFixture.currentTime,
      contextDigest: "e".repeat(64),
    });

    expect(
      runner.runOnce(runOnceInput({ attemptId: "runner-attempt-stale-missing" })),
    ).toMatchObject({
      type: "committed",
      outcome: {
        status: "cancelled",
        freshness: "stale",
        details: { reason: "stale-context-before-dispatch" },
      },
    });
    expect(host.dispatchCalls).toBe(0);
  });

  it("escalates one exhausted budget without blocking an independent budget", () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(
      runnerEffectCommand({ budgetReservation: { unit: "model-millidollars", amount: 11 } }),
    );
    authority.enqueue(
      runnerEffectCommand({
        commandId: "runner-command-retry",
        operationId: "operation_runner-retry",
        sequence: 2,
        budgetReservation: { unit: "retry", amount: 1 },
      }),
    );
    const host = new FakeEffectHost();
    const runner = new FencedRunner(authority, host);

    expect(runner.runOnce(runOnceInput())).toMatchObject({
      type: "escalated",
      escalation: { reason: "budget-exhausted", unit: "model-millidollars" },
    });
    expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-retry" }))).toMatchObject({
      type: "committed",
      outcome: { operationId: "operation_runner-retry", status: "completed" },
    });
    expect(host.dispatchCalls).toBe(1);
  });

  it("cancels before dispatch at deadline and cancels an active effect on request", () => {
    const deadlineAuthority = configuredHarness(new InMemoryRunnerAuthority());
    deadlineAuthority.enqueue(runnerEffectCommand({ deadline: "2026-08-12T12:00:00.000Z" }));
    const deadlineHost = new FakeEffectHost();
    expect(new FencedRunner(deadlineAuthority, deadlineHost).runOnce(runOnceInput())).toMatchObject(
      { type: "committed", outcome: { status: "cancelled" } },
    );
    expect(deadlineHost.dispatchCalls).toBe(0);

    const activeAuthority = configuredHarness(new InMemoryRunnerAuthority());
    activeAuthority.enqueue(runnerEffectCommand());
    const activeHost = new FakeEffectHost({
      dispatch(intent, currentHost) {
        const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
        currentHost.observations.set(intent.command.operationId, active);
        return active;
      },
    });
    const activeRunner = new FencedRunner(activeAuthority, activeHost);
    expect(activeRunner.runOnce(runOnceInput())).toMatchObject({
      type: "committed",
      outcome: { status: "active" },
    });
    activeAuthority.requestCancellation({
      repositoryId: runnerFixture.repositoryId,
      runId: runnerFixture.runId,
      operationId: "operation_runner-effect",
      lease: runnerFixture.lease,
      currentTime: runnerFixture.currentTime,
      requestedAt: runnerFixture.currentTime,
    });
    expect(
      activeAuthority.queryReceipts(runnerFixture.repositoryId, runnerFixture.runId).at(-1),
    ).toMatchObject({ status: "cancellation-requested" });
    expect(
      activeAuthority.queryEvents(runnerFixture.repositoryId, runnerFixture.runId).at(-1),
    ).toMatchObject({ eventType: "effect-cancellation-requested" });
    expect(
      activeRunner.runOnce(runOnceInput({ attemptId: "runner-attempt-cancel" })),
    ).toMatchObject({ type: "committed", outcome: { status: "cancelled" } });
    expect(activeHost.cancelCalls).toBe(1);
  });
});

describe("async fenced runner lease lifecycle", () => {
  for (const point of [
    "before-intent-persist",
    "after-intent-persist",
    "before-effect-commit",
    "after-effect-commit",
  ] as const) {
    it(`recovers idempotently from async ${point}`, async () => {
      let armed = true;
      const authority = configuredHarness(
        new InMemoryRunnerAuthority({
          inject(candidate) {
            if (armed && candidate === point) {
              armed = false;
              throw new Error(`crash at ${point}`);
            }
          },
        }),
      );
      authority.enqueue(runnerEffectCommand());
      const host = new FakeAsyncEffectHost();
      const runner = new AsyncFencedRunner(authority, host);
      const asyncInput = (
        lease: RunnerLeaseFact,
        attemptId: string,
      ): Parameters<AsyncFencedRunner["runOnce"]>[0] => ({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        attemptId,
        signal: new AbortController().signal,
        currentTime: () => runnerFixture.currentTime,
        currentLease: () => lease,
      });

      await expect(
        runner.runOnce(asyncInput(runnerFixture.lease, `runner-attempt-async-${point}`)),
      ).rejects.toThrow(`crash at ${point}`);
      const recoveryLease =
        point === "before-effect-commit" ? takeoverLease() : runnerFixture.lease;
      if (point === "before-effect-commit") {
        authority.setLease(runnerFixture.repositoryId, runnerFixture.runId, recoveryLease);
      }
      const recovered = await runner.runOnce(
        asyncInput(recoveryLease, `runner-attempt-async-recover-${point}`),
      );

      expect(recovered.type).toBe(point === "after-effect-commit" ? "idle" : "committed");
      expect(authority.load(runOnceInput()).effects[0]?.outcome?.status).toBe("completed");
      expect(host.host.dispatchCalls).toBe(1);
      expect(
        authority
          .queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)
          .filter(({ status }) => status === "completed"),
      ).toHaveLength(1);
    });
  }

  it("commits with a renewed lease from the same fence after a delayed host result", async () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand());
    let releaseHost: (() => void) | undefined;
    const hostStarted = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    let lease: RunnerLeaseFact = runnerFixture.lease;
    const renewedLease = { ...lease, expiresAt: "2026-08-12T15:00:00.000Z" };
    const runner = new AsyncFencedRunner(authority, {
      async dispatch(intent) {
        await hostStarted;
        return {
          status: "completed",
          observedAt: runnerFixture.currentTime,
          usage: { unit: intent.command.budgetReservation.unit, amount: 1 },
        };
      },
      async inspect() {
        return { status: "unknown", observedAt: runnerFixture.currentTime };
      },
      async cancel() {
        return { status: "cancelled", observedAt: runnerFixture.currentTime };
      },
    });

    const pending = runner.runOnce({
      repositoryId: runnerFixture.repositoryId,
      runId: runnerFixture.runId,
      attemptId: "runner-attempt-renewed",
      signal: new AbortController().signal,
      currentTime: () => runnerFixture.currentTime,
      currentLease: () => lease,
    });
    await Promise.resolve();
    lease = renewedLease;
    authority.setLease(runnerFixture.repositoryId, runnerFixture.runId, renewedLease);
    releaseHost?.();

    await expect(pending).resolves.toMatchObject({
      type: "committed",
      outcome: { status: "completed", fence: renewedLease.fence },
    });
  });

  it("leaves a durable claim without an outcome when renewal aborts the host", async () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand());
    const abortController = new AbortController();
    let hostStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      hostStarted = resolve;
    });
    const runner = new AsyncFencedRunner(authority, {
      dispatch: async (_intent, { signal }) => {
        hostStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("raw renewal failure")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
      async inspect() {
        throw new Error("inspect must not run after abort");
      },
      async cancel() {
        throw new Error("cancel must not run after abort");
      },
    });
    const pending = runner.runOnce({
      repositoryId: runnerFixture.repositoryId,
      runId: runnerFixture.runId,
      attemptId: "runner-attempt-aborted",
      signal: abortController.signal,
      currentTime: () => runnerFixture.currentTime,
      currentLease: () => runnerFixture.lease,
    });
    await started;
    abortController.abort();

    await expect(pending).rejects.toEqual(new AsyncRunnerCancelledError());
    expect(authority.load(runOnceInput()).effects[0]?.outcome).toBeUndefined();
  });

  it("uses one inspection under a higher takeover fence after an aborted dispatch", async () => {
    const authority = configuredHarness(new InMemoryRunnerAuthority());
    authority.enqueue(runnerEffectCommand());
    const abortController = new AbortController();
    let started: (() => void) | undefined;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = new AsyncFencedRunner(authority, {
      dispatch: async (_intent, { signal }) => {
        started?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("lost response")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
      async inspect() {
        throw new Error("aborted owner must not inspect");
      },
      async cancel() {
        throw new Error("unexpected cancellation");
      },
    }).runOnce({
      repositoryId: runnerFixture.repositoryId,
      runId: runnerFixture.runId,
      attemptId: "runner-attempt-first-owner",
      signal: abortController.signal,
      currentTime: () => runnerFixture.currentTime,
      currentLease: () => runnerFixture.lease,
    });
    await dispatched;
    abortController.abort();
    await expect(first).rejects.toBeInstanceOf(AsyncRunnerCancelledError);

    const takeover = takeoverLease();
    authority.setLease(runnerFixture.repositoryId, runnerFixture.runId, takeover);
    let inspections = 0;
    let dispatches = 0;
    const result = await new AsyncFencedRunner(authority, {
      async dispatch() {
        dispatches += 1;
        return { status: "completed", observedAt: runnerFixture.currentTime };
      },
      async inspect() {
        inspections += 1;
        return {
          status: "completed",
          observedAt: runnerFixture.currentTime,
          outputDigest: runnerFixture.outputDigest,
        };
      },
      async cancel() {
        throw new Error("unexpected cancellation");
      },
    }).runOnce({
      repositoryId: runnerFixture.repositoryId,
      runId: runnerFixture.runId,
      attemptId: "runner-attempt-takeover",
      signal: new AbortController().signal,
      currentTime: () => runnerFixture.currentTime,
      currentLease: () => takeover,
    });

    expect(result).toMatchObject({ outcome: { status: "completed", origin: "inspection" } });
    expect(inspections).toBe(1);
    expect(dispatches).toBe(0);
  });
});

function crashAfterIntentAuthority(): InMemoryRunnerAuthority {
  let armed = true;
  const authority = configuredHarness(
    new InMemoryRunnerAuthority({
      inject(point: RunnerFaultPoint) {
        if (point === "after-intent-persist" && armed) {
          armed = false;
          throw new Error("crash after durable intent");
        }
      },
    }),
  );
  authority.enqueue(runnerEffectCommand());
  return authority;
}
