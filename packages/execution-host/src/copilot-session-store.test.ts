import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupCopilotSessionStore,
  FilesystemCopilotSessionStore,
  nodeSessionStorePublicationPort,
  PublishedSessionStoreDurabilityError,
  restoreCopilotSessionStore,
  type SessionStoreBackupManifest,
  type SessionStorePublicationPort,
  verifyCopilotSessionStoreBackup,
} from "./copilot-session-store.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("Copilot SDK session-store health", () => {
  it("degrades when expected nonterminal session metadata is missing", async () => {
    const root = sandbox();
    const store = new FilesystemCopilotSessionStore({
      baseDirectory: root,
      metadata: { sessionMetadataExists: async (sessionId) => sessionId === "dispatch_present" },
    });

    await expect(store.health(["dispatch_missing", "dispatch_present"])).resolves.toEqual({
      status: "degraded",
      expectedSessionCount: 2,
      missingSessionIds: ["dispatch_missing"],
      message: "Expected SDK session metadata is missing",
    });
  });

  it("degrades an insecure or symbolic-link base directory", async () => {
    const root = sandbox();
    const insecure = join(root, "insecure");
    mkdirSync(insecure, { mode: 0o755 });
    const link = join(root, "link");
    symlinkSync(insecure, link);

    await expect(
      new FilesystemCopilotSessionStore({ baseDirectory: insecure }).health([]),
    ).resolves.toMatchObject({
      status: "degraded",
    });
    await expect(
      new FilesystemCopilotSessionStore({ baseDirectory: link }).health([]),
    ).resolves.toMatchObject({
      status: "degraded",
    });
  });
});

describe("Copilot SDK session-store backup", () => {
  it("backs up and restores an exact regular-file tree to a fresh destination", () => {
    const root = sandbox();
    const source = join(root, "source");
    mkdirSync(join(source, "sessions", "dispatch_one"), { recursive: true, mode: 0o700 });
    chmodSync(source, 0o700);
    chmodSync(join(source, "sessions"), 0o700);
    writeFileSync(join(source, "sessions", "dispatch_one", "state.json"), '{"ok":true}', {
      mode: 0o600,
    });
    const backup = join(root, "backup");
    const restore = join(root, "restore");

    const manifest = backupCopilotSessionStore(source, backup);
    expect(manifest).toMatchObject({ fileCount: 1, format: "senawa-copilot-session-store" });
    expect(verifyCopilotSessionStoreBackup(backup)).toEqual(manifest);
    restoreCopilotSessionStore(backup, restore);
    expect(readFileSync(join(restore, "sessions", "dispatch_one", "state.json"), "utf8")).toBe(
      '{"ok":true}',
    );
    expect(() => restoreCopilotSessionStore(backup, restore)).toThrow("fresh");
  });

  it("backs up nested empty directories with exact inventory, modes, and digests", () => {
    const root = sandbox();
    const { directory: source, manifest: expected } = nestedEmptyDirectoryTree(root, "source");
    const backup = join(root, "backup");
    const restore = join(root, "restore");

    expect(backupCopilotSessionStore(source, backup)).toEqual(expected);
    expect(JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"))).toEqual(expected);
    restoreCopilotSessionStore(backup, restore);
    expect(readdirSync(join(restore, "alpha"))).toEqual([]);
    expect(readdirSync(join(restore, "nested", "empty"))).toEqual([]);
    expect(statSync(join(restore, "alpha")).mode & 0o7777).toBe(0o711);
    expect(statSync(join(restore, "nested")).mode & 0o7777).toBe(0o750);
    expect(statSync(join(restore, "nested", "empty")).mode & 0o7777).toBe(0o700);
    expect(statSync(join(restore, "nested", "state.json")).mode & 0o7777).toBe(0o640);
    expect(readFileSync(join(restore, "nested", "state.json"), "utf8")).toBe("exact-state");
  });

  it("verifies a standalone nested empty-directory backup with exact metadata", () => {
    const root = sandbox();
    const { directory: backup, manifest } = nestedEmptyDirectoryTree(root, "backup");
    writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });

    expect(verifyCopilotSessionStoreBackup(backup)).toEqual(manifest);
  });

  it("refuses backup creation from a single directory wider than the entry limit", () => {
    const root = sandbox();
    const source = join(root, "wide-source");
    mkdirSync(source, { mode: 0o700 });
    for (let index = 0; index < 10_001; index += 1) {
      mkdirSync(join(source, `entry-${String(index).padStart(5, "0")}`), { mode: 0o700 });
    }
    const backup = join(root, "wide-backup");

    expect(() => backupCopilotSessionStore(source, backup)).toThrow("entry bounds");
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith(`${basename(backup)}.partial-`))).toBe(
      false,
    );
  }, 30_000);

  it("refuses standalone verification of a single directory wider than the entry limit", () => {
    const root = sandbox();
    const backup = join(root, "wide-backup");
    mkdirSync(backup, { mode: 0o700 });
    const manifest: SessionStoreBackupManifest = {
      format: "senawa-copilot-session-store",
      version: 1,
      entries: [],
      fileCount: 0,
      byteLength: 0,
    };
    writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    for (let index = 0; index < 10_001; index += 1) {
      mkdirSync(join(backup, `entry-${String(index).padStart(5, "0")}`), { mode: 0o700 });
    }

    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("entry bounds");
  }, 30_000);

  it("refuses source symlinks and corrupted backup bytes", () => {
    const root = sandbox();
    const source = join(root, "source");
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(join(source, "state"), "original", { mode: 0o600 });
    symlinkSync("state", join(source, "state-link"));
    expect(() => backupCopilotSessionStore(source, join(root, "bad-backup"))).toThrow(
      "symbolic links",
    );

    rmSync(join(source, "state-link"));
    const backup = join(root, "backup");
    backupCopilotSessionStore(source, backup);
    writeFileSync(join(backup, "state"), "modified", { mode: 0o600 });
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("digest");
  });

  it("counts empty directories against the total entry ceiling", () => {
    const root = sandbox();
    const source = join(root, "source");
    mkdirSync(join(source, "first"), { recursive: true, mode: 0o700 });
    mkdirSync(join(source, "second"), { mode: 0o700 });
    chmodSync(source, 0o700);

    expect(() => backupCopilotSessionStore(source, join(root, "backup"), { maxFiles: 1 })).toThrow(
      "entry bounds",
    );
  });

  it.each(["backup", "restore"] as const)(
    "refuses %s destinations beneath immediate and deeper symbolic-link ancestors",
    (operation) => {
      const root = sandbox();
      const source = sessionTree(root);
      const trustedBackup = join(root, "trusted-backup");
      if (operation === "restore") backupCopilotSessionStore(source, trustedBackup);

      for (const depth of ["immediate", "deeper"] as const) {
        const outside = join(root, `${operation}-${depth}-outside`);
        mkdirSync(outside, { mode: 0o700 });
        const sentinel = join(outside, "sentinel");
        writeFileSync(sentinel, "untouched", { mode: 0o600 });
        const linkedAncestor = join(root, `${operation}-${depth}-link`);
        symlinkSync(outside, linkedAncestor, "dir");
        const destination =
          depth === "immediate"
            ? join(linkedAncestor, "target")
            : join(linkedAncestor, "missing-parent", "target");

        const publish = () =>
          operation === "backup"
            ? backupCopilotSessionStore(source, destination)
            : restoreCopilotSessionStore(trustedBackup, destination);
        expect(publish).toThrow("safe ancestors");
        expect(existsSync(join(outside, "target"))).toBe(false);
        expect(existsSync(join(outside, "missing-parent"))).toBe(false);
        expect(readFileSync(sentinel, "utf8")).toBe("untouched");
      }
    },
  );

  it.each(["backup", "restore"] as const)(
    "rejects a %s destination parent substitution before publication",
    (operation) => {
      const root = sandbox();
      const source = sessionTree(root);
      const trustedBackup = join(root, "trusted-backup");
      if (operation === "restore") backupCopilotSessionStore(source, trustedBackup);
      const parent = join(root, `${operation}-parent`);
      const movedParent = join(root, `${operation}-moved-parent`);
      const outside = join(root, `${operation}-outside`);
      mkdirSync(parent, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      const sentinel = join(outside, "sentinel");
      writeFileSync(sentinel, "untouched", { mode: 0o600 });
      const destination = join(parent, `${operation}-target`);
      let swapped = false;
      const publicationPort: SessionStorePublicationPort = {
        ...nodeSessionStorePublicationPort,
        syncDirectory(path) {
          nodeSessionStorePublicationPort.syncDirectory(path);
          if (
            !swapped &&
            dirname(path) === parent &&
            basename(path).startsWith(`${basename(destination)}.partial-`)
          ) {
            renameSync(parent, movedParent);
            symlinkSync(outside, parent, "dir");
            swapped = true;
          }
        },
      };

      const publish = () =>
        operation === "backup"
          ? backupCopilotSessionStore(source, destination, { publicationPort })
          : restoreCopilotSessionStore(trustedBackup, destination, { publicationPort });
      expect(publish).toThrow("safe ancestors");
      expect(swapped).toBe(true);
      expect(existsSync(join(outside, basename(destination)))).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    },
  );

  it("bounds manifest bytes and rejects invalid UTF-8 before parsing", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const manifestPath = join(backup, "manifest.json");

    writeFileSync(manifestPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("byte ceiling");
    writeFileSync(manifestPath, Buffer.from([0xff]), { mode: 0o600 });
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("valid UTF-8");
  });

  it("rejects a hostile declared file length before reading file content", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = readManifest(manifestPath);
    const file = manifest.entries.find(({ kind }) => kind === "file");
    if (file === undefined) throw new Error("Expected SDK file fixture");
    file.byteLength = 1_073_741_825;
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("byte bounds");
  });

  it("rejects an actual oversized file before reading its hostile content", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    writeFileSync(join(backup, "sessions", "dispatch_one", "state.json"), Buffer.alloc(1_024), {
      mode: 0o600,
    });

    expect(() => verifyCopilotSessionStoreBackup(backup, { maxBytes: 64 })).toThrow("length");
  });

  it("detects file growth and truncation relative to the exact manifest length", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const state = join(backup, "sessions", "dispatch_one", "state.json");
    const original = readFileSync(state);

    appendFileSync(state, "growth");
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("length");
    writeFileSync(state, original, { mode: 0o600 });
    truncateSync(state, original.byteLength - 1);
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("length");
  });

  it("rejects a backup beneath a replaced deep symbolic-link ancestor", () => {
    const root = sandbox();
    const parent = join(root, "deep", "parent");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const backup = join(parent, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const moved = join(root, "moved-parent");
    renameSync(parent, moved);
    symlinkSync(moved, parent, "dir");

    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("canonical");
  });

  it.each(["parent", "file"] as const)(
    "rejects source %s substitution after descriptor snapshot and leaves the target untouched",
    (substitution) => {
      const root = sandbox();
      const sourceParent = join(root, "source-parent");
      mkdirSync(sourceParent, { mode: 0o700 });
      const backup = join(sourceParent, "backup");
      backupCopilotSessionStore(sessionTree(root), backup);
      const destination = join(root, "restore");
      let substituted = false;
      const publicationPort: SessionStorePublicationPort = {
        ...nodeSessionStorePublicationPort,
        syncDirectory(path) {
          nodeSessionStorePublicationPort.syncDirectory(path);
          if (
            !substituted &&
            dirname(path) === root &&
            basename(path).startsWith("restore.partial-")
          ) {
            if (substitution === "parent") {
              const moved = join(root, "moved-source-parent");
              renameSync(sourceParent, moved);
              symlinkSync(moved, sourceParent, "dir");
            } else {
              const state = join(backup, "sessions", "dispatch_one", "state.json");
              renameSync(state, `${state}.verified`);
              writeFileSync(state, '{"ok":true}', { mode: 0o600 });
            }
            substituted = true;
          }
        },
      };

      expect(() => restoreCopilotSessionStore(backup, destination, { publicationPort })).toThrow(
        substitution === "parent" ? "canonical" : "inventory changed",
      );
      expect(substituted).toBe(true);
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("rejects special mode bits on files and directories", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const state = join(backup, "sessions", "dispatch_one", "state.json");
    chmodSync(state, 0o4600);
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("mode");
    chmodSync(state, 0o600);
    chmodSync(join(backup, "sessions"), 0o1700);
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("mode");
  });

  it("applies parent directory modes independently of manifest order and rejects conflicts", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries: Array<{ path: string; kind: "directory" | "file"; mode: number }>;
    };
    const sessions = manifest.entries.find(({ path }) => path === "sessions");
    const dispatch = manifest.entries.find(({ path }) => path === "sessions/dispatch_one");
    if (sessions === undefined || dispatch === undefined) throw new Error("Expected directories");
    sessions.mode = 0o711;
    dispatch.mode = 0o750;
    manifest.entries = [dispatch, ...manifest.entries.filter((entry) => entry !== dispatch)];
    chmodSync(join(backup, "sessions"), sessions.mode);
    chmodSync(join(backup, "sessions", "dispatch_one"), dispatch.mode);
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const destination = join(root, "restore");
    restoreCopilotSessionStore(backup, destination);
    expect(statSync(join(destination, "sessions")).mode & 0o7777).toBe(0o711);
    expect(statSync(join(destination, "sessions", "dispatch_one")).mode & 0o7777).toBe(0o750);

    const conflict = { ...sessions, mode: 0o700 };
    manifest.entries.push(conflict);
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("entry is invalid");
  });

  it("stops the actual entry walk at the ceiling for unmanifested empty directories", () => {
    const root = sandbox();
    const source = join(root, "empty-source");
    mkdirSync(source, { mode: 0o700 });
    const backup = join(root, "backup");
    backupCopilotSessionStore(source, backup);
    for (const name of ["first", "second", "third"]) {
      mkdirSync(join(backup, name), { mode: 0o700 });
    }

    expect(() => verifyCopilotSessionStoreBackup(backup, { maxFiles: 2 })).toThrow("entry bounds");
  });

  it.each([
    ["file-sync", false],
    ["manifest-sync", false],
    ["directory-sync", false],
    ["rename", false],
    ["parent-sync", true],
    ["reopen", true],
  ] as const)(
    "handles SDK backup %s failure without erasing published state",
    (fault, published) => {
      const root = sandbox();
      const source = sessionTree(root);
      const destination = join(root, `backup-${fault}`);

      expect(() =>
        backupCopilotSessionStore(source, destination, {
          publicationPort: faultingPort(fault, destination),
        }),
      ).toThrow(published ? PublishedSessionStoreDurabilityError : Error);
      expect(existsSync(destination)).toBe(published);
    },
  );

  it.each([
    ["file-sync", false],
    ["directory-sync", false],
    ["rename", false],
    ["parent-sync", true],
    ["reopen", true],
  ] as const)(
    "handles SDK restore %s failure without erasing published state",
    (fault, published) => {
      const root = sandbox();
      const source = sessionTree(root);
      const backup = join(root, "backup");
      backupCopilotSessionStore(source, backup);
      const destination = join(root, `restore-${fault}`);

      expect(() =>
        restoreCopilotSessionStore(backup, destination, {
          publicationPort: faultingPort(fault, destination),
        }),
      ).toThrow(published ? PublishedSessionStoreDurabilityError : Error);
      expect(existsSync(destination)).toBe(published);
      expect(
        readdirSync(root).some((name) => name.startsWith(`${basename(destination)}.partial-`)),
      ).toBe(false);
    },
  );

  it("leaves a concurrent replacement of its restore partial untouched", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const destination = join(root, "restore-replaced-partial");
    let replacementPartial: string | undefined;
    const publicationPort: SessionStorePublicationPort = {
      ...nodeSessionStorePublicationPort,
      syncDirectory(path) {
        nodeSessionStorePublicationPort.syncDirectory(path);
        if (
          replacementPartial === undefined &&
          dirname(path) === root &&
          basename(path).startsWith(`${basename(destination)}.partial-`)
        ) {
          renameSync(path, `${path}.displaced`);
          mkdirSync(path, { mode: 0o700 });
          writeFileSync(join(path, "sentinel"), "replacement", { mode: 0o600 });
          replacementPartial = path;
          throw new Error("injected failure after partial replacement");
        }
      },
    };

    expect(() => restoreCopilotSessionStore(backup, destination, { publicationPort })).toThrow(
      "partial replacement",
    );
    expect(replacementPartial).toBeDefined();
    expect(readFileSync(join(replacementPartial ?? "", "sentinel"), "utf8")).toBe("replacement");
    expect(existsSync(destination)).toBe(false);
  });

  it("removes the exact owned destination when rename throws after moving staging", () => {
    const root = sandbox();
    const backup = join(root, "backup");
    backupCopilotSessionStore(sessionTree(root), backup);
    const destination = join(root, "restore-rename-after-effect");
    const publicationPort: SessionStorePublicationPort = {
      ...nodeSessionStorePublicationPort,
      rename(source, target) {
        nodeSessionStorePublicationPort.rename(source, target);
        throw new Error("injected rename acknowledgement failure");
      },
    };

    expect(() => restoreCopilotSessionStore(backup, destination, { publicationPort })).toThrow(
      "rename acknowledgement failure",
    );
    expect(existsSync(destination)).toBe(false);
  });
});

type PublicationFault =
  | "file-sync"
  | "manifest-sync"
  | "directory-sync"
  | "rename"
  | "parent-sync"
  | "reopen";

function faultingPort(fault: PublicationFault, destination: string): SessionStorePublicationPort {
  return {
    syncFile(path) {
      if (fault === "manifest-sync" && path.endsWith("/manifest.json")) throw faultError(fault);
      if (fault === "file-sync" && !path.endsWith("/manifest.json")) throw faultError(fault);
      nodeSessionStorePublicationPort.syncFile(path);
    },
    syncDirectory(path) {
      if (fault === "parent-sync" && path === dirname(destination)) throw faultError(fault);
      if (fault === "directory-sync" && path !== dirname(destination)) throw faultError(fault);
      nodeSessionStorePublicationPort.syncDirectory(path);
    },
    rename(source, target) {
      if (fault === "rename") throw faultError(fault);
      nodeSessionStorePublicationPort.rename(source, target);
    },
    reopen(path) {
      if (fault === "reopen") throw faultError(fault);
      nodeSessionStorePublicationPort.reopen(path);
    },
  };
}

function sessionTree(root: string): string {
  const source = join(root, "source");
  mkdirSync(join(source, "sessions", "dispatch_one"), { recursive: true, mode: 0o700 });
  chmodSync(source, 0o700);
  chmodSync(join(source, "sessions"), 0o700);
  writeFileSync(join(source, "sessions", "dispatch_one", "state.json"), '{"ok":true}', {
    mode: 0o600,
  });
  return source;
}

function nestedEmptyDirectoryTree(
  root: string,
  name: string,
): { readonly directory: string; readonly manifest: SessionStoreBackupManifest } {
  const directory = join(root, name);
  mkdirSync(join(directory, "alpha"), { recursive: true, mode: 0o711 });
  mkdirSync(join(directory, "nested", "empty"), { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  chmodSync(join(directory, "alpha"), 0o711);
  chmodSync(join(directory, "nested"), 0o750);
  const bytes = Buffer.from("exact-state");
  writeFileSync(join(directory, "nested", "state.json"), bytes, { mode: 0o640 });
  return {
    directory,
    manifest: {
      format: "senawa-copilot-session-store",
      version: 1,
      entries: [
        { path: "alpha", kind: "directory", mode: 0o711 },
        { path: "nested", kind: "directory", mode: 0o750 },
        { path: "nested/empty", kind: "directory", mode: 0o700 },
        {
          path: "nested/state.json",
          kind: "file",
          mode: 0o640,
          byteLength: bytes.byteLength,
          digest: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
      fileCount: 1,
      byteLength: bytes.byteLength,
    },
  };
}

function faultError(point: string): Error {
  return new Error(`injected ${point} failure`);
}

function readManifest(path: string): {
  entries: Array<{ kind: "directory" | "file"; byteLength?: number }>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    entries: Array<{ kind: "directory" | "file"; byteLength?: number }>;
  };
}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "senawa-sdk-store-"));
  roots.add(root);
  chmodSync(root, 0o700);
  return root;
}
