import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  nodeSessionStorePublicationPort,
  type SessionStorePublicationPort,
} from "@senawa/execution-host";
import { SqliteSupervisorAuthority, SupervisorService } from "@senawa/supervisor";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";
import {
  nodeDirectoryPublicationPort,
  PublishedDirectoryDurabilityError,
} from "./durable-directory.js";
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
        dependencies: runtimeDependencies,
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
      dependencies: runtimeDependencies,
    });
    expect(sdkStopped).toBe(true);
    expect(readFileSync(join(backup, "sdk", "sdk-stopped"), "utf8")).toBe("stopped");
    await service.stop();

    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).not.toThrow();
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

    const manifestPath = join(backup, "manifest.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifest) as {
      files: { path: string; byteLength: number; digest: string }[];
    };
    const firstFile = manifest.files[0];
    if (firstFile === undefined) throw new Error("Expected backup file fixture");
    const hostileManifests = [
      { ...manifest, files: [{ ...firstFile, path: "/absolute" }] },
      { ...manifest, files: [{ ...firstFile, path: "sdk/../escape" }] },
      { ...manifest, files: [{ ...firstFile, path: "sdk\\escape" }] },
      {
        ...manifest,
        files: [
          { ...firstFile, path: "sdk/caf\u00e9" },
          { ...firstFile, path: "sdk/cafe\u0301" },
        ],
      },
      { ...manifest, files: [{ ...firstFile, path: Array(257).fill("x").join("/") }] },
      { ...manifest, files: [{ ...firstFile, path: `sdk/${"x".repeat(1_021)}` }] },
      {
        ...manifest,
        files: Array.from({ length: 10_001 }, (_, index) => ({
          ...firstFile,
          path: `sdk/file-${String(index).padStart(5, "0")}`,
        })),
      },
      { ...manifest, files: [{ ...firstFile, byteLength: 1_073_741_825 }] },
    ];
    for (const hostile of hostileManifests) {
      writeFileSync(manifestPath, JSON.stringify(hostile), { mode: 0o600 });
      expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow("invalid");
    }
    writeFileSync(manifestPath, originalManifest, { mode: 0o600 });

    const statePath = join(backup, "sdk", "sessions", "state");
    const savedState = join(backup, "sdk", "sessions", "saved-state");
    renameSync(statePath, savedState);
    symlinkSync(savedState, statePath);
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow("symbolic");
    unlinkSync(statePath);
    renameSync(savedState, statePath);

    linkSync(statePath, savedState);
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow(
      "unsafe regular",
    );
    unlinkSync(savedState);

    execFileSync("mkfifo", [savedState]);
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow(
      "only regular files",
    );
    unlinkSync(savedState);

    chmodSync(statePath, 0o4600);
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow(
      "unsafe regular",
    );
    chmodSync(statePath, 0o600);

    chmodSync(join(backup, "sdk", "sessions"), 0o1700);
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow(
      "directory mode",
    );
    chmodSync(join(backup, "sdk", "sessions"), 0o700);

    writeFileSync(manifestPath, Buffer.alloc(4_194_305, 0x20), { mode: 0o600 });
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow("invalid");
    writeFileSync(manifestPath, originalManifest, { mode: 0o600 });
    appendFileSync(manifestPath, " ");
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow("invalid");
    writeFileSync(manifestPath, originalManifest, { mode: 0o600 });

    appendFileSync(statePath, "growth");
    const untouchedRestore = {
      backupDirectory: backup,
      databasePath: join(root, "untouched.db"),
      assetDirectory: join(root, "untouched-assets"),
      sdkDirectory: join(root, "untouched-sdk"),
      dependencies: runtimeDependencies,
    };
    expect(() => restoreSupervisorStateBackup(untouchedRestore)).toThrow("manifest");
    expect(existsSync(untouchedRestore.databasePath)).toBe(false);
    expect(existsSync(untouchedRestore.assetDirectory)).toBe(false);
    expect(existsSync(untouchedRestore.sdkDirectory)).toBe(false);
    writeFileSync(statePath, "session-state", { mode: 0o600 });

    truncateSync(statePath, 1_073_741_825);
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow(
      "unsafe regular",
    );
    writeFileSync(statePath, "session-state", { mode: 0o600 });

    writeFileSync(join(backup, "sdk", "sessions", "state"), "corrupt", { mode: 0o600 });
    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow("manifest");

    writeFileSync(statePath, "session-state", { mode: 0o600 });
    const canonicalParent = join(root, "canonical-parent");
    mkdirSync(canonicalParent, { mode: 0o700 });
    const nestedBackup = join(canonicalParent, "deep", "backup");
    mkdirSync(dirname(nestedBackup), { recursive: true, mode: 0o700 });
    renameSync(backup, nestedBackup);
    const movedParent = join(root, "moved-canonical-parent");
    renameSync(canonicalParent, movedParent);
    symlinkSync(movedParent, canonicalParent, "dir");
    expect(() => verifySupervisorStateBackup(nestedBackup, runtimeDependencies)).toThrow(
      "canonical",
    );
  });

  it.each(["parent-sync", "reopen"] as const)(
    "retains a verified combined backup after post-rename %s failure",
    async (fault) => {
      const root = mkdtempSync(join(tmpdir(), "senawa-state-backup-fault-"));
      roots.add(root);
      chmodSync(root, 0o700);
      const sourceSdk = join(root, "source-sdk");
      mkdirSync(sourceSdk, { mode: 0o700 });
      const authority = new SqliteSupervisorAuthority({
        databasePath: join(root, "source.db"),
        assetDirectory: join(root, "source-assets"),
        dependencies: runtimeDependencies,
      });
      const service = new SupervisorService({
        authority,
        clock: { now: () => Date.parse("2026-08-13T12:00:00.000Z") },
        ownerId: "owner_backup-fault",
      });
      await service.start();
      await service.drain();
      const destination = join(root, `backup-${fault}`);

      await expect(
        backupSupervisorState({
          service,
          stopSdkClient: async () => undefined,
          sdkDirectory: sourceSdk,
          destinationDirectory: destination,
          dependencies: runtimeDependencies,
          publicationPort: {
            ...nodeDirectoryPublicationPort,
            syncDirectory(path) {
              if (fault === "parent-sync" && path === dirname(destination)) {
                throw new Error("injected parent sync failure");
              }
              nodeDirectoryPublicationPort.syncDirectory(path);
            },
            reopen(path) {
              if (fault === "reopen" && path === destination) {
                throw new Error("injected reopen failure");
              }
              nodeDirectoryPublicationPort.reopen(path);
            },
          },
        }),
      ).rejects.toBeInstanceOf(PublishedDirectoryDurabilityError);
      expect(existsSync(destination)).toBe(true);
      expect(() => verifySupervisorStateBackup(destination, runtimeDependencies)).not.toThrow();
      await service.stop();
    },
  );

  it("refuses a single directory wider than the total entry limit", async () => {
    const { backup } = await createStateBackupFixture("wide-directory");
    const overflow = join(backup, "overflow");
    mkdirSync(overflow, { mode: 0o700 });
    for (let index = 0; index < 10_001; index += 1) {
      mkdirSync(join(overflow, `entry-${String(index).padStart(5, "0")}`), { mode: 0o700 });
    }

    expect(() => verifySupervisorStateBackup(backup, runtimeDependencies)).toThrow(
      "entry count limit",
    );
  }, 30_000);

  it.each(["database", "assets", "sdk"] as const)(
    "refuses an existing dangling symlink at the %s destination without removing it",
    async (target) => {
      const { root, backup } = await createStateBackupFixture(`dangling-${target}`);
      const restore = restorePaths(root, backup, `dangling-${target}`);
      const destination = destinationFor(restore, target);
      symlinkSync(join(root, `missing-${target}`), destination);
      expect(existsSync(destination)).toBe(false);

      expect(() => restoreSupervisorStateBackup(restore)).toThrow("fresh");
      expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    },
  );

  it("removes its exact database, asset, and SDK partials after downstream failure", async () => {
    const { root, backup } = await createStateBackupFixture("owned-cleanup");
    const restore = restorePaths(root, backup, "owned-cleanup");
    const sdkPublicationPort: SessionStorePublicationPort = {
      ...nodeSessionStorePublicationPort,
      syncDirectory(path) {
        nodeSessionStorePublicationPort.syncDirectory(path);
        if (
          dirname(path) === root &&
          basename(path).startsWith(`${basename(restore.sdkDirectory)}.partial-`)
        ) {
          throw new Error("injected downstream restore failure");
        }
      },
    };

    expect(() => restoreSupervisorStateBackup({ ...restore, sdkPublicationPort })).toThrow(
      "downstream restore failure",
    );
    expect(existsSync(restore.databasePath)).toBe(false);
    expect(existsSync(restore.assetDirectory)).toBe(false);
    expect(existsSync(restore.sdkDirectory)).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(".partial-"))).toEqual([]);
  });

  it.each(["database", "assets", "sdk"] as const)(
    "leaves a concurrent %s destination replacement untouched after downstream failure",
    async (target) => {
      const { root, backup } = await createStateBackupFixture(`replacement-${target}`);
      const restore = restorePaths(root, backup, `replacement-${target}`);
      const destination = destinationFor(restore, target);
      let replaced = false;
      const sdkPublicationPort: SessionStorePublicationPort = {
        ...nodeSessionStorePublicationPort,
        syncDirectory(path) {
          nodeSessionStorePublicationPort.syncDirectory(path);
          if (
            !replaced &&
            dirname(path) === root &&
            basename(path).startsWith(`${basename(restore.sdkDirectory)}.partial-`)
          ) {
            if (target === "sdk") {
              mkdirSync(destination, { mode: 0o700 });
            } else {
              renameSync(destination, `${destination}.displaced`);
              if (target === "assets") mkdirSync(destination, { mode: 0o700 });
            }
            if (target === "database") {
              writeFileSync(destination, "replacement", { mode: 0o600 });
            } else {
              writeFileSync(join(destination, "sentinel"), "replacement", { mode: 0o600 });
            }
            replaced = true;
            throw new Error("injected failure after concurrent replacement");
          }
        },
      };

      expect(() => restoreSupervisorStateBackup({ ...restore, sdkPublicationPort })).toThrow(
        "concurrent replacement",
      );
      expect(replaced).toBe(true);
      expect(
        target === "database"
          ? readFileSync(destination, "utf8")
          : readFileSync(join(destination, "sentinel"), "utf8"),
      ).toBe("replacement");
    },
  );
});

async function createStateBackupFixture(label: string): Promise<{
  readonly root: string;
  readonly backup: string;
}> {
  const root = mkdtempSync(join(tmpdir(), `senawa-state-backup-${label}-`));
  roots.add(root);
  chmodSync(root, 0o700);
  const sourceSdk = join(root, "source-sdk");
  mkdirSync(sourceSdk, { mode: 0o700 });
  const authority = new SqliteSupervisorAuthority({
    databasePath: join(root, "source.db"),
    assetDirectory: join(root, "source-assets"),
    dependencies: runtimeDependencies,
  });
  const service = new SupervisorService({
    authority,
    clock: { now: () => Date.parse("2026-08-13T12:00:00.000Z") },
    ownerId: `owner_${label.replaceAll("-", "_")}`,
  });
  await service.start();
  await service.drain();
  const backup = join(root, "backup");
  await backupSupervisorState({
    service,
    stopSdkClient: async () => undefined,
    sdkDirectory: sourceSdk,
    destinationDirectory: backup,
    dependencies: runtimeDependencies,
  });
  await service.stop();
  return { root, backup };
}

function restorePaths(root: string, backup: string, label: string) {
  return {
    backupDirectory: backup,
    databasePath: join(root, `${label}.db`),
    assetDirectory: join(root, `${label}-assets`),
    sdkDirectory: join(root, `${label}-sdk`),
    dependencies: runtimeDependencies,
  };
}

function destinationFor(
  restore: ReturnType<typeof restorePaths>,
  target: "database" | "assets" | "sdk",
): string {
  if (target === "database") return restore.databasePath;
  if (target === "assets") return restore.assetDirectory;
  return restore.sdkDirectory;
}
