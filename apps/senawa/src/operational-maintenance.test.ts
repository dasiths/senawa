import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSenawaService } from "./daemon.js";
import {
  createBackupRequest,
  readBoundedCommandFile,
  readBoundedCommandStream,
  runOperationalCli,
} from "./operational-cli.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("operational maintenance journey", () => {
  it("uses one absolute backup path for request identity and execution", () => {
    const request = createBackupRequest("relative-backup", {
      sha256: {
        digest: (bytes) => Buffer.from(bytes).toString("hex").padEnd(64, "0").slice(0, 64),
      },
    });

    expect(request.destinationDirectory).toBe(resolve("relative-backup"));
    expect(request.requestId).toBe(
      `backup_${Buffer.from(resolve("relative-backup")).toString("hex").slice(0, 40)}`,
    );
  });

  it("bounds command files and streamed input before complete buffering", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-command-input-"));
    roots.add(root);
    const atLimit = "x".repeat(256 * 1024);
    const limitPath = join(root, "limit.json");
    const oversizedPath = join(root, "oversized.json");
    writeFileSync(limitPath, atLimit);
    writeFileSync(oversizedPath, `${atLimit}x`);

    expect(readBoundedCommandFile(limitPath)).toBe(atLimit);
    expect(() => readBoundedCommandFile(oversizedPath)).toThrow("256 KiB");
    await expect(
      readBoundedCommandStream(
        (async function* () {
          yield Uint8Array.from(Buffer.from(atLimit));
        })(),
      ),
    ).resolves.toBe(atLimit);
    await expect(
      readBoundedCommandStream(
        (async function* () {
          yield Uint8Array.from(Buffer.from(atLimit));
          yield Uint8Array.of(120);
        })(),
      ),
    ).rejects.toThrow("256 KiB");
  });

  it("defers help and version flags without opening operational state", async () => {
    await expect(runOperationalCli(["service", "--help"], {})).resolves.toBeUndefined();
    await expect(runOperationalCli(["service", "--version"], {})).resolves.toBeUndefined();
  });

  it("backs up under drain, replays, verifies, diagnoses, and restores only when stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-operational-maintenance-"));
    roots.add(root);
    const secret = "fixture-private-secret";
    const environment = {
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
      SENAWA_TEST_SECRET: secret,
    };
    const started = await startSenawaService(environment);
    const backup = join(root, "backup");

    expect(await runOperationalCli(["backup", "create", backup], environment)).toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("backup-refused"),
    });
    expect(await runOperationalCli(["service", "drain"], environment)).toMatchObject({
      exitCode: 0,
    });
    const first = await runOperationalCli(["backup", "create", backup], environment);
    expect(first).toMatchObject({ exitCode: 0, output: expect.stringContaining("verified") });
    const replay = await runOperationalCli(["backup", "create", backup], environment);
    expect(replay).toEqual(first);

    const existing = join(root, "existing");
    mkdirSync(existing);
    expect(await runOperationalCli(["backup", "create", existing], environment)).toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("backup-refused"),
    });
    expect(await runOperationalCli(["backup", "verify", backup], environment)).toMatchObject({
      exitCode: 0,
      output: expect.stringContaining("verified"),
    });
    expect(await runOperationalCli(["restore", "verify", backup], environment)).toMatchObject({
      exitCode: 0,
    });
    expect(
      await runOperationalCli(
        ["restore", "apply", backup, join(root, "live-restore")],
        environment,
      ),
    ).toMatchObject({ exitCode: 1, output: expect.stringContaining("restore-refused") });

    const integrity = await runOperationalCli(["integrity", "check"], environment);
    expect(integrity).toMatchObject({
      exitCode: 0,
      output: expect.stringContaining('"status":"passed"'),
    });
    const diagnostics = join(root, "diagnostics");
    expect(
      await runOperationalCli(["diagnostics", "create", diagnostics], environment),
    ).toMatchObject({
      exitCode: 0,
      output: expect.stringContaining("secret-safe-metadata"),
    });
    const diagnosticText = readdirSync(diagnostics)
      .map((name) => readFileSync(join(diagnostics, name), "utf8"))
      .join("\n");
    expect(diagnosticText).not.toContain(secret);
    expect(await runOperationalCli(["repair", "plan"], environment)).toMatchObject({
      exitCode: 0,
      output: expect.stringContaining("verified-fresh-restore"),
    });

    const corrupt = join(root, "corrupt-backup");
    cpSync(backup, corrupt, { recursive: true });
    writeFileSync(join(corrupt, "sdk", "unexpected"), secret, { flag: "wx" });
    expect(await runOperationalCli(["backup", "verify", corrupt], environment)).toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("backup-integrity-failed"),
    });

    await started.service.stop();
    const danglingRestore = join(root, "dangling-restore");
    symlinkSync(join(root, "missing-restore-target"), danglingRestore);
    expect(
      await runOperationalCli(["restore", "apply", backup, danglingRestore], environment),
    ).toMatchObject({ exitCode: 1, output: expect.stringContaining("restore-refused") });
    expect(lstatSync(danglingRestore).isSymbolicLink()).toBe(true);
    const restoredRoot = join(root, "restored");
    expect(
      await runOperationalCli(["restore", "apply", backup, restoredRoot], environment),
    ).toEqual({ output: '{"status":"restored"}', exitCode: 0 });
    expect(existsSync(join(restoredRoot, "authority.db"))).toBe(true);
    expect(
      await runOperationalCli(["restore", "apply", backup, restoredRoot], environment),
    ).toMatchObject({ exitCode: 1, output: expect.stringContaining("restore-refused") });
    expect(
      await runOperationalCli(["repair", "apply", corrupt, join(root, "repair")], environment),
    ).toMatchObject({ exitCode: 1, output: expect.stringContaining("repair-refused") });
    expect(existsSync(join(root, "repair"))).toBe(false);
  });
});
