import { AsyncFencedRunner, FencedRunner, type RunnerAuthorityPort } from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import {
  configuredHarness,
  FakeAsyncEffectHost,
  FakeEffectHost,
  type RunnerAuthorityConformanceFactory,
  runnerEffectCommand,
  runnerFixture,
  runOnceInput,
} from "./runner-conformance.js";

export * from "./runner-conformance.js";

export function registerRunnerAuthorityConformance(
  name: string,
  createHarness: RunnerAuthorityConformanceFactory,
): void {
  describe(`${name} runner authority conformance`, () => {
    it("persists intent before dispatch and atomically commits outcome records", () => {
      const harness = configuredHarness(createHarness());
      const command = runnerEffectCommand();
      harness.enqueue(command);
      let observedIntent = false;
      const host = new FakeEffectHost({
        beforeDispatch(intent) {
          observedIntent = harness.authority
            .load({ repositoryId: command.repositoryId, runId: command.runId })
            .effects.some(
              (record) => record.intent.command.operationId === intent.command.operationId,
            );
        },
      });
      const runner = new FencedRunner(harness.authority, host);

      const result = runner.runOnce(runOnceInput());

      expect(result).toMatchObject({
        type: "committed",
        outcome: {
          status: "completed",
          freshness: "current",
          outputDigest: runnerFixture.outputDigest,
          usage: { unit: "model-millidollars", reserved: 5, reported: 3, unreported: 0 },
        },
      });
      expect(observedIntent).toBe(true);
      expect(host.dispatchCalls).toBe(1);
      expect(
        harness.queryReceipts(command.repositoryId, command.runId).map(({ status }) => status),
      ).toEqual(["queued", "intent", "completed"]);
      expect(
        harness.queryEvents(command.repositoryId, command.runId).map(({ eventType }) => eventType),
      ).toEqual(["effect-command-queued", "effect-intent", "effect-completed"]);
      expect(harness.queryProjection(command.repositoryId, command.runId)).toMatchObject({
        cursor: 3,
        effects: [{ operationId: command.operationId, status: "completed" }],
      });
      expect(harness.queryBudgets(command.repositoryId, command.runId)).toContainEqual({
        unit: "model-millidollars",
        limit: 10,
        reserved: 0,
        spent: 3,
        unreported: 0,
      });
    });

    it("produces the same authoritative outcome through the async fenced runner", async () => {
      const harness = configuredHarness(createHarness());
      const command = runnerEffectCommand();
      harness.enqueue(command);
      const host = new FakeAsyncEffectHost();
      const controller = new AbortController();

      const result = await new AsyncFencedRunner(harness.authority, host).runOnce({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        attemptId: "runner-attempt-async",
        signal: controller.signal,
        currentTime: () => runnerFixture.currentTime,
        currentLease: () => runnerFixture.lease,
      });

      expect(result).toMatchObject({
        type: "committed",
        outcome: {
          status: "completed",
          freshness: "current",
          outputDigest: runnerFixture.outputDigest,
          usage: { unit: "model-millidollars", reserved: 5, reported: 3, unreported: 0 },
        },
      });
      expect(host.host.dispatchCalls).toBe(1);
      expect(host.contexts).toHaveLength(1);
      expect(host.contexts[0]?.lease).toEqual(runnerFixture.lease);
      expect(
        harness.queryReceipts(command.repositoryId, command.runId).map(({ status }) => status),
      ).toEqual(["queued", "intent", "completed"]);
    });

    it("runs at most one queued effect and makes duplicate wakes idempotent", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand({ commandId: "runner-command-first", sequence: 1 }));
      harness.enqueue(
        runnerEffectCommand({
          commandId: "runner-command-second",
          operationId: "operation_runner-second",
          sequence: 2,
        }),
      );
      const host = new FakeEffectHost();
      const runner = new FencedRunner(harness.authority, host);

      expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-first" })).type).toBe(
        "committed",
      );
      expect(host.dispatchCalls).toBe(1);
      expect(
        harness.authority.load({
          repositoryId: runnerFixture.repositoryId,
          runId: runnerFixture.runId,
        }).effects,
      ).toHaveLength(1);
      expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-second" })).type).toBe(
        "committed",
      );
      expect(host.dispatchCalls).toBe(2);
      expect(runner.runOnce(runOnceInput({ attemptId: "runner-attempt-duplicate" }))).toEqual({
        type: "idle",
      });
      expect(host.dispatchCalls).toBe(2);
    });

    it("settles unreported usage conservatively", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand());
      const host = new FakeEffectHost({ reportUsage: false });

      const result = new FencedRunner(harness.authority, host).runOnce(runOnceInput());

      expect(result).toMatchObject({
        type: "committed",
        outcome: { usage: { reserved: 5, unreported: 5 } },
      });
      expect(
        harness.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
      ).toMatchObject({ reserved: 0, spent: 5, unreported: 5 });
    });

    it("keeps exact task-scoped outcomes current across a run-global context change", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand());
      expect(
        new FencedRunner(harness.authority, new FakeEffectHost()).runOnce(runOnceInput()),
      ).toMatchObject({
        type: "committed",
        outcome: { status: "completed", freshness: "current" },
      });
      expect(
        harness.queryProjection(runnerFixture.repositoryId, runnerFixture.runId),
      ).toMatchObject({
        cursor: 3,
        effects: [{ operationId: "operation_runner-effect", status: "completed" }],
      });

      harness.updateContext({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        lease: runnerFixture.lease,
        currentTime: runnerFixture.currentTime,
        contextDigest: "f".repeat(64),
      });

      expect(harness.queryProjection(runnerFixture.repositoryId, runnerFixture.runId)).toEqual({
        cursor: 4,
        contextDigest: "f".repeat(64),
        effects: [
          {
            operationId: "operation_runner-effect",
            outputDigest: runnerFixture.outputDigest,
            status: "completed",
          },
        ],
      });
      expect(
        harness.queryReceipts(runnerFixture.repositoryId, runnerFixture.runId).at(-1),
      ).toMatchObject({ cursor: 4, status: "context-updated" });
      expect(
        harness.queryEvents(runnerFixture.repositoryId, runnerFixture.runId).at(-1),
      ).toMatchObject({ cursor: 4, eventType: "runner-context-updated" });
    });

    it("bounds an uncertain cancellation and settles its reservation", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand({ maxReconciliationAttempts: 1 }));
      const host = new FakeEffectHost({
        dispatch(intent, currentHost) {
          const active = { status: "active" as const, observedAt: runnerFixture.currentTime };
          currentHost.observations.set(intent.command.operationId, active);
          return active;
        },
        cancel() {
          return { status: "unknown", observedAt: runnerFixture.currentTime };
        },
      });
      const runner = new FencedRunner(harness.authority, host);
      expect(runner.runOnce(runOnceInput())).toMatchObject({
        outcome: { status: "active", reconciliationAttempts: 0 },
      });
      harness.requestCancellation({
        repositoryId: runnerFixture.repositoryId,
        runId: runnerFixture.runId,
        operationId: "operation_runner-effect",
        lease: runnerFixture.lease,
        currentTime: runnerFixture.currentTime,
        requestedAt: runnerFixture.currentTime,
      });
      expect(
        runner.runOnce(runOnceInput({ attemptId: "runner-attempt-cancel-unknown" })),
      ).toMatchObject({
        outcome: { status: "unknown", origin: "cancellation", reconciliationAttempts: 1 },
      });
      expect(
        runner.runOnce(runOnceInput({ attemptId: "runner-attempt-cancel-settlement" })),
      ).toMatchObject({
        outcome: {
          status: "failed",
          origin: "settlement",
          reconciliationAttempts: 1,
          details: { reason: "cancellation-reconciliation-limit-reached" },
        },
      });
      expect(host.cancelCalls).toBe(1);
      expect(
        harness.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
      ).toMatchObject({ reserved: 0, spent: 5, unreported: 5 });
    });

    it("linearizes overlapping wakes before one external dispatch", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand());
      let runner: FencedRunner;
      let overlappingResult: ReturnType<FencedRunner["runOnce"]> | undefined;
      const host = new FakeEffectHost({
        dispatch(intent, currentHost) {
          overlappingResult = runner.runOnce(
            runOnceInput({ attemptId: "runner-attempt-overlapping" }),
          );
          const completed = {
            status: "completed" as const,
            observedAt: runnerFixture.currentTime,
            outputDigest: runnerFixture.outputDigest,
            usage: { unit: intent.command.budgetReservation.unit, amount: 2 },
          };
          currentHost.observations.set(intent.command.operationId, completed);
          return completed;
        },
      });
      runner = new FencedRunner(harness.authority, host);

      expect(runner.runOnce(runOnceInput())).toMatchObject({
        outcome: { status: "completed" },
      });
      expect(overlappingResult).toEqual({ type: "idle" });
      expect(host.dispatchCalls).toBe(1);
    });

    it("turns a delayed stale start plan into authoritative terminal replay", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand());
      const host = new FakeEffectHost();
      const winner = new FencedRunner(harness.authority, host);
      let interleaved = false;
      const delayedAuthority: RunnerAuthorityPort = {
        load: harness.authority.load.bind(harness.authority),
        assertLease: harness.authority.assertLease.bind(harness.authority),
        installTaskScopeFences: harness.authority.installTaskScopeFences.bind(harness.authority),
        claimEffectAttempt: harness.authority.claimEffectAttempt.bind(harness.authority),
        persistIntent(request) {
          if (!interleaved) {
            interleaved = true;
            expect(
              winner.runOnce(runOnceInput({ attemptId: "runner-attempt-stale-plan-winner" })),
            ).toMatchObject({ outcome: { status: "completed" } });
          }
          return harness.authority.persistIntent(request);
        },
        commitEffect: harness.authority.commitEffect.bind(harness.authority),
      };

      expect(
        new FencedRunner(delayedAuthority, host).runOnce(
          runOnceInput({ attemptId: "runner-attempt-stale-plan-delayed" }),
        ),
      ).toMatchObject({ outcome: { status: "completed" } });
      expect(host.dispatchCalls).toBe(1);
      expect(
        harness
          .queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)
          .filter(({ status }) => status === "completed"),
      ).toHaveLength(1);
    });

    it("refuses context mutation while an effect attempt is claimed", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand());
      const host = new FakeEffectHost({
        dispatch() {
          expect(() =>
            harness.updateContext({
              repositoryId: runnerFixture.repositoryId,
              runId: runnerFixture.runId,
              lease: runnerFixture.lease,
              currentTime: runnerFixture.currentTime,
              contextDigest: "e".repeat(64),
            }),
          ).toThrow("cannot change while an effect attempt is claimed");
          return {
            status: "completed",
            observedAt: runnerFixture.currentTime,
            usage: { unit: "model-millidollars", amount: 1 },
          };
        },
      });

      expect(new FencedRunner(harness.authority, host).runOnce(runOnceInput())).toMatchObject({
        outcome: { status: "completed", freshness: "current" },
      });
    });

    it("rolls back terminal usage above its reservation", () => {
      const harness = configuredHarness(createHarness());
      harness.enqueue(runnerEffectCommand());
      const host = new FakeEffectHost({
        dispatch(intent) {
          return {
            status: "completed",
            observedAt: runnerFixture.currentTime,
            usage: { unit: intent.command.budgetReservation.unit, amount: 6 },
          };
        },
      });

      expect(() => new FencedRunner(harness.authority, host).runOnce(runOnceInput())).toThrow(
        "must not exceed its budget reservation",
      );
      expect(
        harness.queryBudgets(runnerFixture.repositoryId, runnerFixture.runId)[0],
      ).toMatchObject({ reserved: 5, spent: 0, unreported: 0 });
      expect(
        harness
          .queryReceipts(runnerFixture.repositoryId, runnerFixture.runId)
          .map(({ status }) => status),
      ).toEqual(["queued", "intent"]);
      expect(
        harness.queryProjection(runnerFixture.repositoryId, runnerFixture.runId).effects,
      ).toEqual([]);
    });
  });
}
