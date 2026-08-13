import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSupervisorAuthority, SupervisorService } from "@senawa/supervisor";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";
import {
  backupSupervisorState,
  restoreSupervisorStateBackup,
  verifySupervisorStateBackup,
} from "./state-backup.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("combined supervisor state backup", () => {
  it("verifies and restores SQLite plus SDK state only to fresh destinations", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-state-backup-"));
    roots.add(root);
    chmodSync(root, 0o700);
    const sourceSdk = join(root, "source-sdk");
    mkdirSync(join(sourceSdk, "sessions"), { recursive: true, mode: 0o700 });
    chmodSync(sourceSdk, 0o700);
    writeFileSync(join(sourceSdk, "sessions", "state"), "session-state", { mode: 0o600 });
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "source.db"),
      assetDirectory: join(root, "source-assets"),
      dependencies: runtimeDependencies,
    });
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse("2026-08-13T12:00:00.000Z") },
      ownerId: "owner_backup",
    });
    await service.start();
    const backup = join(root, "backup");
    let sdkStopped = false;
    await expect(
      backupSupervisorState({
        service,
        stopSdkClient: async () => {
          sdkStopped = true;
        },
        sdkDirectory: sourceSdk,
        destinationDirectory: backup,
      }),
    ).rejects.toThrow("drained");
    expect(sdkStopped).toBe(false);

    await service.drain();
    await backupSupervisorState({
      service,
      stopSdkClient: async () => {
        sdkStopped = true;
        await expect(service.recover("repository_backup", "run_backup")).rejects.toThrow(
          "running service",
        );
        authority.appendLog({
          recordedAt: "2026-08-13T12:00:00.000Z",
          level: "info",
          event: "backup.sdk-stopped",
          message: "SDK stopped before snapshot",
          fields: {},
        });
        writeFileSync(join(sourceSdk, "sdk-stopped"), "stopped", { mode: 0o600 });
      },
      sdkDirectory: sourceSdk,
      destinationDirectory: backup,
    });
    expect(sdkStopped).toBe(true);
    expect(readFileSync(join(backup, "sdk", "sdk-stopped"), "utf8")).toBe("stopped");
    await service.stop();

    expect(() => verifySupervisorStateBackup(backup)).not.toThrow();
    const restore = {
      backupDirectory: backup,
      databasePath: join(root, "restored.db"),
      assetDirectory: join(root, "restored-assets"),
      sdkDirectory: join(root, "restored-sdk"),
      dependencies: runtimeDependencies,
    };
    const restored = restoreSupervisorStateBackup(restore);
    expect(restored.queryReceipt("command_missing")).toBeUndefined();
    restored.close();
    const restoredSupervisor = new SqliteSupervisorAuthority({
      databasePath: restore.databasePath,
      assetDirectory: restore.assetDirectory,
      dependencies: runtimeDependencies,
    });
    expect(restoredSupervisor.queryLogs().items).toMatchObject([
      { event: "service.started" },
      { event: "service.draining" },
      { event: "service.drained" },
      { event: "backup.sdk-stopped" },
    ]);
    restoredSupervisor.close();
    expect(() => restoreSupervisorStateBackup(restore)).toThrow("fresh");

    writeFileSync(join(backup, "sdk", "sessions", "state"), "corrupt", { mode: 0o600 });
    expect(() => verifySupervisorStateBackup(backup)).toThrow("manifest");
  });
});
