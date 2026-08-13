import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupCopilotSessionStore,
  FilesystemCopilotSessionStore,
  restoreCopilotSessionStore,
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
    writeFileSync(join(backup, "state"), "corrupted", { mode: 0o600 });
    expect(() => verifyCopilotSessionStoreBackup(backup)).toThrow("digest");
  });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "senawa-sdk-store-"));
  roots.add(root);
  chmodSync(root, 0o700);
  return root;
}
