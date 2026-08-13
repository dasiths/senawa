import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AsyncEffectHost,
  AsyncRunnerCancelledError,
  createRoleAuthorizationPolicy,
  type QueuedEffectCommand,
  type RuntimeDependencies,
} from "@senawa/runtime";
import { SqliteRunnerAuthority } from "@senawa/storage-sqlite";
import { deterministicSha256 } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import {
  SupervisorRunController,
  type SupervisorTimer,
  type SupervisorTimerHandle,
} from "./run-controller.js";

const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([]),
};
const repositoryId = "repository_controller";
const runId = "run_controller";
const contextDigest = "a".repeat(64);

class ManualTimer implements SupervisorTimer {
  pending: (() => void) | undefined;
  delay: number | undefined;

  schedule(delayMilliseconds: number, callback: () => void): SupervisorTimerHandle {
    this.delay = delayMilliseconds;
    this.pending = callback;
    return {
      cancel: () => {
        if (this.pending === callback) this.pending = undefined;
      },
    };
  }

  fire(): void {
    const callback = this.pending;
    this.pending = undefined;
    callback?.();
  }
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("SupervisorRunController async lease loop", () => {
  it("renews a delayed host lease and prevents a live-owner steal", async () => {
    const fixture = createFixture();
    let currentTime = "2026-08-13T12:00:00.000Z";
    let finish: (() => void) | undefined;
    let started: (() => void) | undefined;
    const hostStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hostGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const host: AsyncEffectHost = {
      async dispatch(intent) {
        started?.();
        await hostGate;
        return {
          status: "completed",
          observedAt: currentTime,
          usage: { unit: intent.command.budgetReservation.unit, amount: 1 },
        };
      },
      async inspect() {
        return { status: "unknown", observedAt: currentTime };
      },
      async cancel() {
        return { status: "cancelled", observedAt: currentTime };
      },
    };
    const controller = new SupervisorRunController({
      authority: fixture.supervisor,
      runnerAuthority: fixture.runner,
      asyncEffectHost: host,
      timer: fixture.timer,
    });
    const pending = controller.runOnceAsync({
      repositoryId,
      runId,
      ownerId: "owner_controller",
      currentTime: () => currentTime,
      attemptId: "attempt_controller-renew",
    });
    await hostStarted;

    expect(() =>
      fixture.supervisor.acquireRunLease(
        repositoryId,
        runId,
        "owner_steal",
        currentTime,
        "2026-08-13T12:00:30.000Z",
      ),
    ).toThrow("held by another live owner");
    expect(fixture.timer.delay).toBe(10_000);
    currentTime = "2026-08-13T12:00:10.000Z";
    fixture.timer.fire();
    finish?.();

    await expect(pending).resolves.toMatchObject({
      runner: { type: "committed", outcome: { status: "completed" } },
      lease: { expiresAt: "2026-08-13T12:00:40.000Z" },
    });
    fixture.close();
  });

  it("aborts on renewal failure, keeps the uncertain lease, and permits later takeover", async () => {
    const fixture = createFixture();
    let currentTime = "2026-08-13T12:00:00.000Z";
    let started: (() => void) | undefined;
    const hostStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const host: AsyncEffectHost = {
      async dispatch(_intent, { signal }) {
        started?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("raw abort")), { once: true });
        });
        throw new Error("unreachable");
      },
      async inspect() {
        throw new Error("must not inspect after renewal abort");
      },
      async cancel() {
        throw new Error("unexpected cancellation");
      },
    };
    const controller = new SupervisorRunController({
      authority: fixture.supervisor,
      runnerAuthority: fixture.runner,
      asyncEffectHost: host,
      timer: fixture.timer,
    });
    const pending = controller.runOnceAsync({
      repositoryId,
      runId,
      ownerId: "owner_controller",
      currentTime: () => currentTime,
      attemptId: "attempt_controller-abort",
    });
    await hostStarted;
    currentTime = "2026-08-13T12:00:31.000Z";
    fixture.timer.fire();

    await expect(pending).rejects.toBeInstanceOf(AsyncRunnerCancelledError);
    const takeover = fixture.supervisor.acquireRunLease(
      repositoryId,
      runId,
      "owner_takeover",
      currentTime,
      "2026-08-13T12:01:01.000Z",
    );
    expect(takeover.fence).toBe(2);
    fixture.close();
  });
});

function createFixture(): {
  supervisor: SqliteSupervisorAuthority;
  runner: SqliteRunnerAuthority;
  timer: ManualTimer;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "senawa-run-controller-"));
  roots.add(root);
  const databasePath = join(root, "authority.db");
  const supervisor = new SqliteSupervisorAuthority({
    databasePath,
    assetDirectory: join(root, "assets"),
    dependencies,
  });
  const runner = new SqliteRunnerAuthority({ databasePath, dependencies });
  runner.configureRun({
    repositoryId,
    runId,
    contextDigest,
    taskScopes: [{ ...effectTaskScope(), claimsAccepted: true }],
    budgets: [{ unit: "model-millidollars", limit: 10 }],
    lease: {
      owner: "owner_controller",
      fence: 1,
      expiresAt: "2026-08-13T12:00:30.000Z",
    },
  });
  runner.enqueue(effectCommand());
  return {
    supervisor,
    runner,
    timer: new ManualTimer(),
    close() {
      runner.close();
      supervisor.close();
    },
  };
}

function effectCommand(): QueuedEffectCommand {
  return {
    sequence: 1,
    commandId: "command_controller-effect",
    repositoryId,
    runId,
    operationId: "operation_controller-effect",
    kind: "worker",
    taskScope: effectTaskScope(),
    contextDigest,
    inputDigest: "b".repeat(64),
    input: { dispatchId: "dispatch_controller" },
    budgetReservation: { unit: "model-millidollars", amount: 5 },
    queuedAt: "2026-08-13T12:00:00.000Z",
    maxReconciliationAttempts: 2,
  };
}

function effectTaskScope() {
  return {
    runId,
    taskId: "task_controller",
    definitionGeneration: 1,
    acceptedContextDigest: contextDigest,
    fenceGeneration: 1,
  } as const;
}
