import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AsyncEffectHost,
  createRoleAuthorizationPolicy,
  type EffectInspection,
  type EffectObservation,
  type RuntimeDependencies,
} from "@senawa/runtime";
import { SqliteRunnerAuthority } from "@senawa/storage-sqlite";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import { recoverRunOnce } from "./recovery.js";
import { type SupervisorLifecycleState, SupervisorService } from "./service.js";

const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
  ]),
};
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("SupervisorService lifecycle", () => {
  it("survives a failing wake pump without an unhandled rejection", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-wake-failure-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const scheduled: { delay: number; run: () => void }[] = [];
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_wake-failure",
      timer: {
        schedule: (delayMilliseconds, callback) => {
          scheduled.push({ delay: delayMilliseconds, run: callback });
          return { cancel: () => {} };
        },
      },
    });
    await service.start();

    // wake() is invoked from synchronous notifier callbacks that discard its
    // result, so a rejecting pump would terminate the process rather than the run.
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", capture);
    try {
      vi.spyOn(authority, "listPendingWakes").mockImplementation(() => {
        throw new Error("simulated cycle failure");
      });
      service.wake();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
      expect(await service.status()).toMatchObject({ lifecycle: "running" });
      // "Let the next wake retry" assumed a next wake. A live run lost its lease
      // and died on the fence, and nothing wrote to the record afterwards, so
      // there was no notification to wake on: the pump stopped for good with
      // three agents' work unaccepted.
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.delay).toBeGreaterThan(0);
    } finally {
      process.off("unhandledRejection", capture);
      vi.restoreAllMocks();
    }

    await service.drain();
    await service.stop();
  });

  it("exposes sanitized remote partition lag and degrades aggregate health", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-remote-status-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_remote-status",
      sessionStoreHealth: {
        async health() {
          return { status: "healthy", expectedSessionCount: 0, missingSessionIds: [] };
        },
      },
      remoteConnectorStatuses: [
        {
          status: () => ({
            connectorId: "connector_remote-status",
            bindingId: "binding_remote-status",
            repositoryId: runtimeFixture.repositoryId,
            lifecycle: "running",
            health: "degraded",
            partitioned: true,
            lastAttemptAt: runtimeFixture.currentTime,
            lastSuccessfulContactAt: null,
            lastErrorCode: "transport-unavailable",
            synchronization: {
              inboundSequence: 3,
              state: "stale",
              stalenessMs: 0,
              waitingCommands: 1,
              readyCommands: 0,
              acceptedCommands: 1,
              pendingReports: 2,
              claimedReports: 1,
              localToEnqueued: 4,
              enqueuedToAcknowledged: 2,
            },
          }),
        },
      ],
    });
    await service.start();
    const status = await service.status();
    expect(status).toMatchObject({
      health: "degraded",
      remoteConnectors: [
        {
          connectorId: "connector_remote-status",
          partitioned: true,
          lastErrorCode: "transport-unavailable",
          synchronization: { localToEnqueued: 4, enqueuedToAcknowledged: 2 },
        },
      ],
    });
    expect(JSON.stringify(status)).not.toMatch(/endpoint|credential|privateKey|token/iu);
    await service.drain();
    await service.stop();
  });

  it("closes started listeners and owned resources when a later listener fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-start-cleanup-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const events: string[] = [];
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_start-cleanup",
      listeners: [
        {
          async start() {
            events.push("first.start");
            return { kind: "ipc", address: join(root, "service.sock") };
          },
          async close() {
            events.push("first.close");
          },
        },
        {
          async start() {
            events.push("second.start");
            throw new Error("second listener failed");
          },
          async close() {
            events.push("second.close");
          },
        },
      ],
      closeables: [
        {
          close: () => {
            events.push("closeable.close");
          },
        },
      ],
    });

    await expect(service.start()).rejects.toThrow("second listener failed");
    expect(events).toEqual(["first.start", "second.start", "first.close", "closeable.close"]);
    expect(service.state).toBe("stopped");
    expect(() => authority.mode()).toThrow();
  });

  it("attempts every owned cleanup after a stop-time listener failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-stop-cleanup-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const events: string[] = [];
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_stop-cleanup",
      listeners: [
        {
          async start() {
            return { kind: "ipc", address: join(root, "service.sock") };
          },
          async close() {
            events.push("listener.close");
            throw new Error("listener close failed");
          },
        },
      ],
      closeables: [
        {
          close: () => {
            events.push("closeable.close");
          },
        },
      ],
    });
    await service.start();
    await service.drain();

    await expect(service.stop()).rejects.toThrow("listener close failed");
    expect(events).toEqual(["listener.close", "closeable.close"]);
    expect(service.state).toBe("stopped");
    expect(() => authority.mode()).toThrow();
  });

  it("closes owned resources after a drainable fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-drain-cleanup-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const events: string[] = [];
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_drain-cleanup",
      drainables: [
        {
          async drain() {
            events.push("drainable.drain");
            throw new Error("connector drain failed");
          },
        },
      ],
      closeables: [
        {
          close: () => {
            events.push("closeable.close");
          },
        },
      ],
    });
    await service.start();

    await expect(service.stop()).rejects.toThrow("Supervisor drain completed with resource errors");
    expect(events).toEqual(["drainable.drain", "closeable.close"]);
    expect(service.state).toBe("stopped");
    expect(() => authority.mode()).toThrow();
  });

  it("serializes direct recovery behind an active async cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-serialized-recovery-"));
    roots.add(root);
    const databasePath = join(root, "authority.db");
    const authority = new SqliteSupervisorAuthority({
      databasePath,
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const completed = (operationId: string): EffectObservation => ({
      status: "completed",
      observedAt: runtimeFixture.currentTime,
      details: { operationId },
    });
    const host: AsyncEffectHost = {
      async dispatch(intent) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(intent.command.operationId);
        try {
          if (intent.command.operationId === "operation_serial-a") await firstGate;
          return completed(intent.command.operationId);
        } finally {
          active -= 1;
        }
      },
      async inspect(intent): Promise<EffectInspection> {
        return { ...completed(intent.command.operationId), status: "completed" };
      },
      async cancel(intent) {
        return completed(intent.command.operationId);
      },
    };
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_serialized",
      asyncEffectHost: host,
    });
    await service.start();

    const runner = new SqliteRunnerAuthority({ databasePath, dependencies });
    for (const suffix of ["a", "b"] as const) {
      const repositoryId = `repository_serial-${suffix}`;
      const runId = `run_serial-${suffix}`;
      const taskScope = {
        runId,
        taskId: `task_serial-${suffix}`,
        definitionGeneration: 1,
        acceptedContextDigest: "a".repeat(64),
        fenceGeneration: 1,
      } as const;
      runner.configureRun({
        repositoryId,
        runId,
        contextDigest: "a".repeat(64),
        taskScopes: [{ ...taskScope, claimsAccepted: true }],
        budgets: [{ unit: "model-millidollars", limit: 10 }],
        lease: {
          owner: "owner_serialized",
          fence: 1,
          expiresAt: "2026-08-12T12:00:30.000Z",
        },
      });
      runner.enqueue({
        sequence: 1,
        commandId: `command_serial-${suffix}`,
        repositoryId,
        runId,
        operationId: `operation_serial-${suffix}`,
        kind: "worker",
        taskScope,
        contextDigest: "a".repeat(64),
        inputDigest: "b".repeat(64),
        input: { dispatchId: `dispatch_serial-${suffix}` },
        budgetReservation: { unit: "model-millidollars", amount: 5 },
        queuedAt: runtimeFixture.currentTime,
        maxReconciliationAttempts: 2,
      });
    }
    runner.close();

    const cycle = service.runCycle();
    await vi.waitFor(() => expect(started).toEqual(["operation_serial-a"]));
    const recovery = service.recover("repository_serial-b", "run_serial-b");
    await Promise.resolve();
    expect(started).toEqual(["operation_serial-a"]);
    expect(maxActive).toBe(1);

    // A read does not wait for the cycle. Queueing it behind one meant the
    // supervisor answered nothing for the minutes an agent worked, which is the
    // only time a person opens the console.
    await expect(service.status()).resolves.toMatchObject({ lifecycle: "running" });
    await expect(service.logs()).resolves.toMatchObject({ afterCursor: 0 });
    expect(started).toEqual(["operation_serial-a"]);

    releaseFirst?.();
    await expect(Promise.all([cycle, recovery])).resolves.toMatchObject([
      { worked: true },
      { worked: true },
    ]);
    expect(started).toEqual(["operation_serial-a", "operation_serial-b"]);
    expect(maxActive).toBe(1);

    await service.drain();
    await service.stop();
  });

  it("recovers pending wakes before reporting running and drains before closing", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-service-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const command = runtimeCommand({
      commandId: "command_service-startup",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    authority.accept({
      envelope: command,
      createAdmission: () => ({
        currentTime: runtimeFixture.currentTime,
        facts: { source: "service-test" },
        allocations: [1, 2, 3].map((index) => ({
          kind: "stream-event" as const,
          id: `stream-event-service-${index}`,
        })),
      }),
    });
    const transitions: SupervisorLifecycleState[] = [];
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_service",
      processId: 42,
      onTransition: (state) => transitions.push(state),
    });

    await service.start();
    expect(authority.queryLatest(command.commandId)).toMatchObject({ status: "terminal" });
    expect(authority.listPendingWakes()).toEqual([]);
    await service.drain();
    await service.stop();

    expect(transitions).toEqual([
      "starting",
      "running",
      "draining",
      "drained",
      "stopping",
      "stopped",
    ]);
  });

  // A supervisor that stops mid-turn leaves a claim naming an owner that no
  // longer exists. Everything below the supervisor recovers once that owner's
  // lease expires, but the service is wake-driven with no clock of its own: the
  // cycle that found the run reported no work, the pump stopped, and nothing
  // asked again a minute later. The run was runnable in principle and unreached
  // in practice, and in the live case it sat that way indefinitely.
  it("looks at a run again when the lease blocking it runs out", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-lease-retry-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const command = runtimeCommand({
      commandId: "command_lease-retry",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    const scheduled: { delay: number; run: () => void }[] = [];
    let now = Date.parse(runtimeFixture.currentTime);
    const service = new SupervisorService({
      authority,
      clock: { now: () => now },
      ownerId: "owner_lease-retry",
      timer: {
        schedule: (delayMilliseconds, callback) => {
          scheduled.push({ delay: delayMilliseconds, run: callback });
          return { cancel: () => {} };
        },
      },
    });
    await service.start();

    // Another owner holds the run, and its lease has thirty seconds to live.
    const liveExpiry = "2026-08-12T12:00:30.000Z";
    authority.acquireRunLease(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "owner_dead",
      runtimeFixture.currentTime,
      liveExpiry,
    );
    authority.accept({
      envelope: command,
      createAdmission: () => ({
        currentTime: runtimeFixture.currentTime,
        facts: { source: "lease-retry-test" },
        allocations: [1, 2, 3].map((index) => ({
          kind: "stream-event" as const,
          id: `stream-event-lease-retry-${index}`,
        })),
      }),
    });

    expect(await service.runCycle()).toMatchObject({ worked: false });
    // The retry is scheduled at the expiry the authority already knows, not
    // immediately: retrying against a live lease spins until it dies.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delay).toBeGreaterThan(29_000);
    // A run nobody can drive says so rather than looking idle.
    expect(
      authority.queryLogs(0, 200).items.some((entry) => entry.event === "run.lease-held"),
    ).toBe(true);

    // A second refusal before the first retry fires must not stack another
    // wake: the earliest pending retry already covers it.
    expect(await service.runCycle()).toMatchObject({ worked: false });
    expect(scheduled).toHaveLength(1);

    // The command is still waiting, because nothing has driven the run.
    expect(authority.queryLatest(command.commandId)).not.toMatchObject({ status: "terminal" });

    // Time passes and the retry fires. Nobody restarted anything, and the run
    // that was runnable in principle is now driven in practice.
    now = Date.parse(liveExpiry) + 1_000;
    scheduled[0]?.run();
    await vi.waitFor(() =>
      expect(authority.queryLatest(command.commandId)).toMatchObject({ status: "terminal" }),
    );

    await service.drain();
    await service.stop();
  });

  it("refuses direct recovery under a live owner and succeeds at a higher fence after expiry", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-direct-recovery-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const command = runtimeCommand({
      commandId: "command_direct-recovery",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    authority.accept({
      envelope: command,
      createAdmission: () => ({
        currentTime: runtimeFixture.currentTime,
        facts: { source: "direct-recovery-test" },
        allocations: [1, 2, 3].map((index) => ({
          kind: "stream-event" as const,
          id: `stream-event-direct-${index}`,
        })),
      }),
    });
    const liveExpiry = "2026-08-12T12:00:30.000Z";
    const liveLease = authority.acquireRunLease(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "owner_live",
      runtimeFixture.currentTime,
      liveExpiry,
    );

    await expect(
      recoverRunOnce(authority, {
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        ownerId: "owner_direct",
        currentTime: runtimeFixture.currentTime,
      }),
    ).rejects.toThrow("held by another live owner");
    expect(authority.operationalSnapshot().leases).toMatchObject([
      { ownerId: liveLease.ownerId, fence: liveLease.fence, expiresAt: liveExpiry },
    ]);

    const recovered = await recoverRunOnce(authority, {
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      ownerId: "owner_direct",
      currentTime: "2026-08-12T12:00:31.000Z",
    });
    expect(recovered.lease.fence).toBe(liveLease.fence + 1);
    expect(recovered.receipt).toMatchObject({ status: "terminal" });
    authority.close();
  });

  it("persists exact repository registration and bounded sanitized logs", () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-operational-state-"));
    roots.add(root);
    const options = {
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    };
    let authority = new SqliteSupervisorAuthority(options);
    authority.registerRepository({
      repositoryId: "repository_registered",
      canonicalPath: join(root, "repository"),
      configSnapshotId: "config_snapshot_1",
    });
    authority.appendLog({
      recordedAt: runtimeFixture.currentTime,
      level: "info",
      event: "\u001b[31mservice.started\u0007",
      message: "ready Bearer reusable-secret\n",
      fields: { credentialToken: "reusable-secret", nested: { count: 1 } },
    });
    authority.appendLog({
      recordedAt: runtimeFixture.currentTime,
      level: "warn",
      event: "service.warning",
      message: "bounded page",
      fields: {},
    });
    expect(authority.queryLogs(0, 1)).toMatchObject({
      afterCursor: 0,
      latestCursor: 2,
      hasMore: true,
      items: [
        {
          cursor: 1,
          event: "service.started",
          message: "ready Bearer [redacted]",
          fields: { credentialToken: "[redacted]", nested: { count: 1 } },
        },
      ],
    });
    authority.close();

    authority = new SqliteSupervisorAuthority(options);
    expect(authority.queryRepository("repository_registered")).toEqual({
      repositoryId: "repository_registered",
      canonicalPath: join(root, "repository"),
      configSnapshotId: "config_snapshot_1",
    });
    expect(authority.queryLogs(1, 1)).toMatchObject({
      afterCursor: 1,
      latestCursor: 2,
      hasMore: false,
      items: [{ cursor: 2, event: "service.warning" }],
    });
    authority.close();
  });
});
