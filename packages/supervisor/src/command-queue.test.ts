import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalStringify,
  decodeCommandSubmission,
  type ProtocolValidationError,
} from "@senawa/protocol";
import { createRoleAuthorizationPolicy, type RuntimeDependencies } from "@senawa/runtime";
import {
  LeaseUnavailableError,
  restoreSqliteAuthority,
  StaleLeaseFenceError,
} from "@senawa/storage-sqlite";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteSupervisorAuthority,
  type SqliteSupervisorAuthorityOptions,
  SupervisorCommandConflictError,
  type SupervisorFaultPoint,
} from "./command-queue.js";

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

describe("supervisor command admission boundary", () => {
  it("signals run subscribers after queued and terminal commits", () => {
    const notifications: string[] = [];
    const options = sandboxOptions();
    const supervisor = new SqliteSupervisorAuthority({
      ...options,
      eventNotifier: {
        subscribe: () => () => undefined,
        notify(repositoryId, runId) {
          notifications.push(`${repositoryId}/${runId}`);
        },
      },
    });
    try {
      const input = admissionInput("command_supervisor-notifier");
      supervisor.accept(input);
      expect(notifications).toEqual([`${runtimeFixture.repositoryId}/${runtimeFixture.runId}`]);
      const lease = acquire(supervisor, "owner_notifier", runtimeFixture.currentTime);
      supervisor.drainRunOnce({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease,
        currentTime: runtimeFixture.currentTime,
      });
      expect(notifications).toEqual([
        `${runtimeFixture.repositoryId}/${runtimeFixture.runId}`,
        `${runtimeFixture.repositoryId}/${runtimeFixture.runId}`,
      ]);
    } finally {
      supervisor.close();
    }
  });

  it("accepts no client attribution and rejects principal or transport injection", () => {
    const input = admissionInput("command_supervisor-codec");
    expect(decodeCommandSubmission(input.submission)).toEqual(input.submission);
    for (const field of ["principal", "transport"] as const) {
      expect(() =>
        decodeCommandSubmission({ ...input.submission, [field]: input[field] }),
      ).toThrowError(
        expect.objectContaining<Partial<ProtocolValidationError>>({
          code: "unknown-field",
          path: `$.${field}`,
        }),
      );
    }
  });

  it("replays a lost acceptance response and leaves conflicts nonmutating", () => {
    const options = sandboxOptions();
    const input = admissionInput("command_supervisor-lost-response");
    const fault = onceFault("after-queued-commit-before-ack");
    let supervisor = new SqliteSupervisorAuthority({ ...options, faultInjector: fault });
    expect(() => supervisor.accept(input)).toThrow("fault:after-queued-commit-before-ack");
    supervisor.close();
    supervisor = new SqliteSupervisorAuthority(options);
    try {
      const unavailableAdmission = () => {
        throw new Error("allocator unavailable");
      };
      expect(supervisor.accept({ ...input, createAdmission: unavailableAdmission })).toEqual(
        supervisor.queryLatest(input.envelope.commandId),
      );
      const wake = supervisor.queryWake(runtimeFixture.repositoryId, runtimeFixture.runId);
      const history = supervisor.queryHistory(runtimeFixture.repositoryId, runtimeFixture.runId);
      expect(() =>
        supervisor.accept({
          ...input,
          envelope: { ...input.envelope, payloadDigest: "0".repeat(64) },
          createAdmission: unavailableAdmission,
        }),
      ).toThrow(SupervisorCommandConflictError);
      expect(supervisor.queryWake(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(wake);
      expect(supervisor.queryHistory(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
        history,
      );
    } finally {
      supervisor.close();
    }
  });
});

describe("SQLite supervisor crash recovery", () => {
  it.each([
    "after-queued-commit-before-ack",
    "after-claim-commit-before-execute",
    "after-command-submit-before-terminal-ack",
    "before-terminal-commit",
    "after-terminal-commit-before-ack",
  ] as const)("recovers exact command authority after %s", (point) => {
    const baseline = runUninterrupted("command_supervisor-crash");
    const options = sandboxOptions();
    const input = admissionInput("command_supervisor-crash");
    let supervisor = new SqliteSupervisorAuthority({ ...options, faultInjector: onceFault(point) });
    let staleLease: ReturnType<SqliteSupervisorAuthority["acquireRunLease"]> | undefined;
    try {
      if (point === "after-queued-commit-before-ack") {
        expect(() => supervisor.accept(input)).toThrow(`fault:${point}`);
      } else {
        supervisor.accept(input);
        staleLease = acquire(supervisor, "owner_initial", runtimeFixture.currentTime);
        expect(() =>
          supervisor.drainRunOnce({
            repositoryId: runtimeFixture.repositoryId,
            runId: runtimeFixture.runId,
            lease: staleLease as NonNullable<typeof staleLease>,
            currentTime: runtimeFixture.currentTime,
          }),
        ).toThrow(`fault:${point}`);
      }
    } finally {
      supervisor.close();
    }

    supervisor = new SqliteSupervisorAuthority(options);
    try {
      let terminal = supervisor.queryLatest(input.submission.commandId);
      if (terminal?.status !== "terminal") {
        const recoveryLease = acquire(supervisor, "owner_recovery", "2026-08-12T12:01:01.000Z");
        terminal = supervisor.drainRunOnce({
          repositoryId: runtimeFixture.repositoryId,
          runId: runtimeFixture.runId,
          lease: recoveryLease,
          currentTime: "2026-08-12T12:01:01.000Z",
        });
        if (staleLease !== undefined) {
          expect(() =>
            supervisor.drainRunOnce({
              repositoryId: runtimeFixture.repositoryId,
              runId: runtimeFixture.runId,
              lease: staleLease as NonNullable<typeof staleLease>,
              currentTime: "2026-08-12T12:01:01.000Z",
            }),
          ).toThrow(StaleLeaseFenceError);
        }
      }
      expect(terminal).toEqual(baseline.terminal);
      expect(supervisor.commandAuthority.toCanonicalJson()).toBe(baseline.canonicalJson);
      expect(supervisor.commandAuthority.queryReceipt(input.submission.commandId)).toEqual(
        baseline.commandReceipt,
      );
      expect(
        supervisor.commandAuthority.queryEvents(runtimeFixture.repositoryId, runtimeFixture.runId),
      ).toEqual(baseline.events);
      expect(
        supervisor.commandAuthority.queryProjection(
          runtimeFixture.repositoryId,
          runtimeFixture.runId,
        ),
      ).toEqual(baseline.projection);
      expect(
        supervisor
          .queryHistory(runtimeFixture.repositoryId, runtimeFixture.runId)
          .filter((receipt) => receipt.status === "claimed"),
      ).toHaveLength(1);
    } finally {
      supervisor.close();
    }
  });
});

describe("SQLite supervisor semantic verification", () => {
  it("refuses a canonical receipt with an unknown field on backup, startup, and restore", async () => {
    const options = sandboxOptions();
    const supervisor = new SqliteSupervisorAuthority(options);
    const input = admissionInput("command_supervisor-corrupt-receipt");
    supervisor.accept(input);
    const lease = acquire(supervisor, "owner_corrupt-receipt", runtimeFixture.currentTime);
    supervisor.drainRunOnce({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      lease,
      currentTime: runtimeFixture.currentTime,
    });
    const backupPath = join(options.assetDirectory, "..", "clean-backup");
    await supervisor.commandAuthority.backup(backupPath);

    corruptLatestSupervisorReceipt(options.databasePath);
    await expect(
      supervisor.commandAuthority.backup(join(options.assetDirectory, "..", "refused-backup")),
    ).rejects.toThrow(/not allowed/);
    supervisor.close();
    expect(() => new SqliteSupervisorAuthority(options)).toThrow(/not allowed/);

    const backupDatabasePath = join(backupPath, "authority.db");
    corruptLatestSupervisorReceipt(backupDatabasePath);
    refreshBackupDatabaseManifest(backupPath);
    expect(() =>
      restoreSqliteAuthority({
        databasePath: join(options.assetDirectory, "..", "restored.db"),
        assetDirectory: join(options.assetDirectory, "..", "restored-assets"),
        dependencies: options.dependencies,
        ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
        backupPath,
      }),
    ).toThrow(/not allowed/);
  });

  it("refuses coordinated queued receipt timestamp corruption on backup, startup, and restore", async () => {
    const options = sandboxOptions();
    const supervisor = new SqliteSupervisorAuthority(options);
    supervisor.accept(admissionInput("command_supervisor-corrupt-queued-time"));
    const backupPath = join(options.assetDirectory, "..", "clean-time-backup");
    await supervisor.commandAuthority.backup(backupPath);

    shiftQueuedSupervisorReceiptTime(options.databasePath, "2026-08-12T12:00:00.500Z");
    await expect(
      supervisor.commandAuthority.backup(join(options.assetDirectory, "..", "refused-time-backup")),
    ).rejects.toThrow(/Supervisor/);
    supervisor.close();
    expect(() => new SqliteSupervisorAuthority(options)).toThrow(/Supervisor/);

    shiftQueuedSupervisorReceiptTime(join(backupPath, "authority.db"), "2026-08-12T12:00:00.500Z");
    refreshBackupDatabaseManifest(backupPath);
    expect(() =>
      restoreSqliteAuthority({
        databasePath: join(options.assetDirectory, "..", "restored-time.db"),
        assetDirectory: join(options.assetDirectory, "..", "restored-time-assets"),
        dependencies: options.dependencies,
        ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
        backupPath,
      }),
    ).toThrow(/Supervisor/);
  });

  it.each([
    {
      name: "command epoch",
      mutate(database: Database.Database) {
        database.exec("UPDATE supervisor_commands SET accepted_at_ms = accepted_at_ms + 1");
      },
    },
    {
      name: "wake generation",
      mutate(database: Database.Database) {
        database.exec("UPDATE supervisor_wakes SET generation = generation + 1");
      },
    },
    {
      name: "command state history",
      mutate(database: Database.Database) {
        database
          .prepare(
            `UPDATE supervisor_commands
             SET state = 'claimed', claim_owner_id = 'owner_corrupt', claim_fence = 1,
                 claim_expires_at = ?, claim_expires_at_ms = ?`,
          )
          .run("2026-08-12T12:01:00.000Z", Date.parse("2026-08-12T12:01:00.000Z"));
      },
    },
    {
      name: "service state epoch",
      mutate(database: Database.Database) {
        database.exec("UPDATE supervisor_service_state SET updated_at_ms = updated_at_ms + 1");
      },
    },
  ])("refuses semantic $name corruption on startup", ({ mutate }) => {
    const options = sandboxOptions();
    const supervisor = new SqliteSupervisorAuthority(options);
    supervisor.accept(admissionInput("command_supervisor-semantic-corruption"));
    supervisor.close();
    const database = new Database(options.databasePath);
    mutate(database);
    database.close();
    expect(() => new SqliteSupervisorAuthority(options)).toThrow(/Supervisor/);
  });
});

describe("SQLite supervisor wakes, lifecycle, and leases", () => {
  it("refuses mixed-precision acceptance and mode backdating", () => {
    const supervisor = new SqliteSupervisorAuthority(sandboxOptions());
    try {
      supervisor.accept({
        ...admissionInput("command_supervisor-time-first"),
        createAdmission: () => ({
          ...admissionInput("command_supervisor-time-first").admission,
          currentTime: "2026-08-12T12:00:00.500Z",
        }),
      });
      expect(
        supervisor.queryWake(runtimeFixture.repositoryId, runtimeFixture.runId)?.notBefore,
      ).toBe("2026-08-12T12:00:00.500Z");
      expect(() => supervisor.accept(admissionInput("command_supervisor-time-second"))).toThrow(
        /must not backdate/,
      );

      supervisor.setMode("draining", "2026-08-12T12:00:01.500Z");
      expect(() => supervisor.setMode("running", "2026-08-12T12:00:01Z")).toThrow(
        /must not backdate/,
      );
    } finally {
      supervisor.close();
    }
  });

  it("discovers pending work after reopen without relying on notifications", () => {
    const options = sandboxOptions();
    let supervisor = new SqliteSupervisorAuthority(options);
    supervisor.accept(admissionInput("command_supervisor-wake"));
    expect(supervisor.listPendingWakes()).toEqual(supervisor.listPendingWakes());
    supervisor.close();
    supervisor = new SqliteSupervisorAuthority(options);
    try {
      expect(supervisor.listPendingWakes()).toMatchObject([
        { generation: 1, acknowledgedGeneration: 0, hasPendingWork: true },
      ]);
    } finally {
      supervisor.close();
    }
  });

  it("uses generation CAS so acceptance wins an acknowledge race", () => {
    const supervisor = new SqliteSupervisorAuthority(sandboxOptions());
    try {
      supervisor.accept(admissionInput("command_supervisor-wake-first"));
      const lease = acquire(supervisor, "owner_wake", runtimeFixture.currentTime);
      const terminal = supervisor.drainRunOnce({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease,
        currentTime: runtimeFixture.currentTime,
      });
      const observed = supervisor.queryWake(runtimeFixture.repositoryId, runtimeFixture.runId);
      const history = supervisor.queryHistory(runtimeFixture.repositoryId, runtimeFixture.runId);
      expect(supervisor.accept(admissionInput("command_supervisor-wake-first"))).toEqual(terminal);
      expect(supervisor.queryWake(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
        observed,
      );
      expect(supervisor.queryHistory(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
        history,
      );
      supervisor.accept(admissionInput("command_supervisor-wake-second"));
      expect(
        supervisor.acknowledgeWake(
          runtimeFixture.repositoryId,
          runtimeFixture.runId,
          observed?.generation ?? 0,
        ),
      ).toBe(false);
      expect(supervisor.listPendingWakes()).toMatchObject([
        { generation: 2, acknowledgedGeneration: 1, hasPendingWork: true },
      ]);
    } finally {
      supervisor.close();
    }
  });

  it("persists draining mode, keeps accepting, and starts no work", () => {
    const options = sandboxOptions();
    let supervisor = new SqliteSupervisorAuthority(options);
    supervisor.setMode("draining", runtimeFixture.currentTime);
    const queued = supervisor.accept(admissionInput("command_supervisor-draining"));
    const lease = acquire(supervisor, "owner_draining", runtimeFixture.currentTime);
    expect(
      supervisor.drainRunOnce({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease,
        currentTime: runtimeFixture.currentTime,
      }),
    ).toBeUndefined();
    expect(supervisor.queryLatest(queued.commandId)?.status).toBe("queued");
    supervisor.close();
    supervisor = new SqliteSupervisorAuthority(options);
    try {
      expect(supervisor.mode()).toBe("draining");
      expect(supervisor.listPendingWakes()).toHaveLength(1);
    } finally {
      supervisor.close();
    }
  });

  it("renews and releases one live lease while foreground takeover fails closed", () => {
    const supervisor = new SqliteSupervisorAuthority(sandboxOptions());
    try {
      const first = acquire(supervisor, "owner_live", runtimeFixture.currentTime);
      expect(() => acquire(supervisor, "owner_foreground", "2026-08-12T12:00:30.000Z")).toThrow(
        LeaseUnavailableError,
      );
      const renewed = supervisor.renewRunLease(
        first,
        "2026-08-12T12:00:30.000Z",
        "2026-08-12T12:02:00.000Z",
      );
      expect(() =>
        supervisor.renewRunLease(first, "2026-08-12T12:00:31.000Z", "2026-08-12T12:03:00.000Z"),
      ).toThrow(StaleLeaseFenceError);
      supervisor.releaseRunLease(renewed, "2026-08-12T12:00:40.000Z");
      expect(acquire(supervisor, "owner_foreground", "2026-08-12T12:00:40.000Z").fence).toBe(2);
    } finally {
      supervisor.close();
    }
  });

  it("releases a mixed-precision live lease for immediate higher-fence reclaim", () => {
    const supervisor = new SqliteSupervisorAuthority(sandboxOptions());
    try {
      const first = supervisor.acquireRunLease(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "owner_mixed-first",
        "2026-08-12T12:00:00Z",
        "2026-08-12T12:00:01.500Z",
      );
      supervisor.releaseRunLease(first, "2026-08-12T12:00:01Z");
      const second = supervisor.acquireRunLease(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "owner_mixed-second",
        "2026-08-12T12:00:01Z",
        "2026-08-12T12:00:02Z",
      );
      expect(second.fence).toBe(2);
      expect(() => supervisor.releaseRunLease(first, "2026-08-12T12:00:01Z")).toThrow(
        StaleLeaseFenceError,
      );
      expect(() => supervisor.releaseRunLease(second, second.expiresAt)).toThrow(
        StaleLeaseFenceError,
      );
    } finally {
      supervisor.close();
    }
  });

  it("reclaims a claimed command immediately with a strictly higher live fence", () => {
    const options = sandboxOptions();
    const point = "after-claim-commit-before-execute" as const;
    let supervisor = new SqliteSupervisorAuthority({ ...options, faultInjector: onceFault(point) });
    const input = admissionInput("command_supervisor-higher-fence");
    const staleLease = acquire(supervisor, "owner_first", runtimeFixture.currentTime);
    supervisor.accept(input);
    expect(() =>
      supervisor.drainRunOnce({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease: staleLease,
        currentTime: runtimeFixture.currentTime,
      }),
    ).toThrow(`fault:${point}`);
    supervisor.releaseRunLease(staleLease, "2026-08-12T12:00:01.000Z");
    const recoveryLease = acquire(supervisor, "owner_second", "2026-08-12T12:00:01.000Z");
    expect(recoveryLease.fence).toBeGreaterThan(staleLease.fence);
    supervisor.close();

    supervisor = new SqliteSupervisorAuthority(options);
    try {
      expect(
        supervisor.drainRunOnce({
          repositoryId: runtimeFixture.repositoryId,
          runId: runtimeFixture.runId,
          lease: recoveryLease,
          currentTime: "2026-08-12T12:00:01.000Z",
        }),
      ).toMatchObject({ commandId: input.envelope.commandId, status: "terminal" });
      expect(
        supervisor
          .queryHistory(runtimeFixture.repositoryId, runtimeFixture.runId)
          .filter((receipt) => receipt.status === "claimed"),
      ).toHaveLength(1);
      expect(() =>
        supervisor.drainRunOnce({
          repositoryId: runtimeFixture.repositoryId,
          runId: runtimeFixture.runId,
          lease: staleLease,
          currentTime: "2026-08-12T12:00:01.000Z",
        }),
      ).toThrow(StaleLeaseFenceError);
    } finally {
      supervisor.close();
    }
  });

  it("reclaims a claimed command after its claim expires", () => {
    const options = sandboxOptions();
    const point = "after-claim-commit-before-execute" as const;
    let supervisor = new SqliteSupervisorAuthority({ ...options, faultInjector: onceFault(point) });
    const input = admissionInput("command_supervisor-expired-claim");
    supervisor.accept(input);
    const expiredLease = acquire(supervisor, "owner_expired", runtimeFixture.currentTime);
    expect(() =>
      supervisor.drainRunOnce({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease: expiredLease,
        currentTime: runtimeFixture.currentTime,
      }),
    ).toThrow(`fault:${point}`);
    supervisor.close();

    supervisor = new SqliteSupervisorAuthority(options);
    try {
      const recoveryTime = "2026-08-12T12:01:01.000Z";
      const recoveryLease = acquire(supervisor, "owner_recovery", recoveryTime);
      expect(
        supervisor.drainRunOnce({
          repositoryId: runtimeFixture.repositoryId,
          runId: runtimeFixture.runId,
          lease: recoveryLease,
          currentTime: recoveryTime,
        }),
      ).toMatchObject({ commandId: input.submission.commandId, status: "terminal" });
    } finally {
      supervisor.close();
    }
  });
});

function admissionInput(commandId: string) {
  const command = instantiateCommand(commandId);
  const { principal, transport, ...submission } = command;
  const admission = {
    currentTime: runtimeFixture.currentTime,
    facts: { source: "runtime-conformance" },
    allocations: [1, 2, 3].map((index) => ({
      kind: "stream-event" as const,
      id: `stream-event-${index}`,
    })),
  };
  return {
    submission,
    principal,
    transport,
    envelope: command,
    admission,
    createAdmission: () => admission,
  };
}

function instantiateCommand(commandId: string) {
  return runtimeCommand({
    commandId,
    intent: "instantiate-run",
    payload: {
      workflowId: runtimeFixture.workflowId,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      execution: runtimeFixture.execution,
      graph: createRuntimeGraph(),
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "approval-required" as const, authority: runtimePrincipal },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
    },
  });
}

function sandboxOptions(): SqliteSupervisorAuthorityOptions {
  const root = mkdtempSync(join(tmpdir(), "senawa-supervisor-"));
  roots.add(root);
  return {
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies,
    busyTimeoutMs: 500,
  };
}

function acquire(supervisor: SqliteSupervisorAuthority, owner: string, currentTime: string) {
  return supervisor.acquireRunLease(
    runtimeFixture.repositoryId,
    runtimeFixture.runId,
    owner,
    currentTime,
    currentTime === runtimeFixture.currentTime
      ? "2026-08-12T12:01:00.000Z"
      : "2026-08-12T12:02:00.000Z",
  );
}

function runUninterrupted(commandId: string) {
  const supervisor = new SqliteSupervisorAuthority(sandboxOptions());
  try {
    const input = admissionInput(commandId);
    supervisor.accept(input);
    const lease = acquire(supervisor, "owner_initial", runtimeFixture.currentTime);
    const terminal = supervisor.drainRunOnce({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      lease,
      currentTime: runtimeFixture.currentTime,
    });
    return {
      terminal,
      canonicalJson: supervisor.commandAuthority.toCanonicalJson(),
      commandReceipt: supervisor.commandAuthority.queryReceipt(commandId),
      events: supervisor.commandAuthority.queryEvents(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
      ),
      projection: supervisor.commandAuthority.queryProjection(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
      ),
    };
  } finally {
    supervisor.close();
  }
}

function onceFault(expected: SupervisorFaultPoint) {
  let fired = false;
  return (observed: SupervisorFaultPoint) => {
    if (!fired && observed === expected) {
      fired = true;
      throw new Error(`fault:${expected}`);
    }
  };
}

function corruptLatestSupervisorReceipt(databasePath: string): void {
  const database = new Database(databasePath);
  const row = database
    .prepare<[], { run_key: string; sequence: number; canonical_receipt: string }>(
      `SELECT run_key, sequence, canonical_receipt
       FROM supervisor_receipts ORDER BY sequence DESC LIMIT 1`,
    )
    .get();
  if (row === undefined) throw new Error("Expected a supervisor receipt to corrupt");
  database
    .prepare(
      `UPDATE supervisor_receipts SET canonical_receipt = ?
       WHERE run_key = ? AND sequence = ?`,
    )
    .run(
      canonicalStringify({
        ...(JSON.parse(row.canonical_receipt) as Record<string, unknown>),
        bogus: true,
      }),
      row.run_key,
      row.sequence,
    );
  database.close();
}

function shiftQueuedSupervisorReceiptTime(databasePath: string, recordedAt: string): void {
  const database = new Database(databasePath);
  const row = database
    .prepare<[], { run_key: string; sequence: number; canonical_receipt: string }>(
      `SELECT run_key, sequence, canonical_receipt
       FROM supervisor_receipts WHERE status = 'queued' ORDER BY sequence LIMIT 1`,
    )
    .get();
  if (row === undefined) throw new Error("Expected a queued supervisor receipt to corrupt");
  database
    .prepare(
      `UPDATE supervisor_receipts
       SET recorded_at = ?, recorded_at_ms = ?, canonical_receipt = ?
       WHERE run_key = ? AND sequence = ?`,
    )
    .run(
      recordedAt,
      Date.parse(recordedAt),
      canonicalStringify({
        ...(JSON.parse(row.canonical_receipt) as Record<string, unknown>),
        recordedAt,
      }),
      row.run_key,
      row.sequence,
    );
  database.close();
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
