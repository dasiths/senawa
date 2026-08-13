import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  backupCopilotSessionStore,
  restoreCopilotSessionStore,
  verifyCopilotSessionStoreBackup,
} from "@senawa/execution-host";
import { canonicalStringify } from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { restoreSqliteAuthority, type SqliteAuthority } from "@senawa/storage-sqlite";
import type { SupervisorService } from "@senawa/supervisor";

interface SupervisorStateBackupManifest {
  readonly format: "senawa-supervisor-state";
  readonly version: 1;
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly digest: string;
  }[];
}

export async function backupSupervisorState(input: {
  readonly service: Pick<SupervisorService, "authority" | "withQuiescentState">;
  readonly stopSdkClient: () => Promise<void>;
  readonly sdkDirectory: string;
  readonly destinationDirectory: string;
}): Promise<void> {
  return input.service.withQuiescentState(async (proof) => {
    proof.assertDrained();
    await input.stopSdkClient();
    proof.assertDrained();
    const destination = resolve(input.destinationDirectory);
    assertFresh(destination);
    const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
    mkdirSync(partial, { mode: 0o700 });
    try {
      await input.service.authority.commandAuthority.backup(join(partial, "sqlite"));
      backupCopilotSessionStore(input.sdkDirectory, join(partial, "sdk"));
      const manifest: SupervisorStateBackupManifest = {
        format: "senawa-supervisor-state",
        version: 1,
        files: Object.freeze(fileRecords(partial)),
      };
      writeFileSync(join(partial, "manifest.json"), canonicalStringify(manifest), {
        mode: 0o600,
        flag: "wx",
      });
      verifySupervisorStateBackup(partial);
      renameSync(partial, destination);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  });
}

export function verifySupervisorStateBackup(backupDirectory: string): void {
  const backup = resolve(backupDirectory);
  const manifest = parseManifest(readFileSync(join(backup, "manifest.json"), "utf8"));
  const actual = fileRecords(backup, new Set(["manifest.json"]));
  if (canonicalStringify(actual) !== canonicalStringify(manifest.files)) {
    throw new Error("Supervisor state backup manifest does not match its files");
  }
  verifyCopilotSessionStoreBackup(join(backup, "sdk"));
}

export function restoreSupervisorStateBackup(input: {
  readonly backupDirectory: string;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly sdkDirectory: string;
  readonly dependencies: RuntimeDependencies;
}): SqliteAuthority {
  const backup = resolve(input.backupDirectory);
  verifySupervisorStateBackup(backup);
  assertFresh(resolve(input.databasePath));
  assertFresh(resolve(input.assetDirectory));
  assertFresh(resolve(input.sdkDirectory));
  const sqliteStaging = join(
    dirname(resolve(input.databasePath)),
    `.senawa-sqlite-restore-${process.pid}-${Date.now()}`,
  );
  cpSync(join(backup, "sqlite"), sqliteStaging, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  let authority: SqliteAuthority | undefined;
  try {
    authority = restoreSqliteAuthority({
      backupPath: sqliteStaging,
      databasePath: input.databasePath,
      assetDirectory: input.assetDirectory,
      dependencies: input.dependencies,
    });
    restoreCopilotSessionStore(join(backup, "sdk"), input.sdkDirectory);
    return authority;
  } catch (error) {
    authority?.close();
    rmSync(input.databasePath, { force: true });
    rmSync(input.assetDirectory, { recursive: true, force: true });
    rmSync(input.sdkDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(sqliteStaging, { recursive: true, force: true });
  }
}

function fileRecords(root: string, excluded = new Set<string>()) {
  const records: { path: string; byteLength: number; digest: string }[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (excluded.has(relativePath)) continue;
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error("Supervisor backup refuses symbolic links");
      if (status.isDirectory()) visit(path);
      else if (status.isFile()) {
        const bytes = readFileSync(path);
        records.push({
          path: relativePath,
          byteLength: bytes.byteLength,
          digest: createHash("sha256").update(bytes).digest("hex"),
        });
      } else throw new Error("Supervisor backup accepts only regular files and directories");
    }
  };
  visit(root);
  return records;
}

function parseManifest(content: string): SupervisorStateBackupManifest {
  const value = JSON.parse(content) as SupervisorStateBackupManifest;
  if (
    value.format !== "senawa-supervisor-state" ||
    value.version !== 1 ||
    !Array.isArray(value.files) ||
    value.files.some(
      (file) =>
        typeof file.path !== "string" ||
        file.path.startsWith("/") ||
        file.path.split("/").some((part: string) => part === "" || part === "." || part === "..") ||
        !Number.isSafeInteger(file.byteLength) ||
        file.byteLength < 0 ||
        !/^[0-9a-f]{64}$/u.test(file.digest),
    )
  ) {
    throw new Error("Supervisor state backup manifest is invalid");
  }
  return value;
}

function assertFresh(path: string): void {
  if (existsSync(path)) throw new Error("Supervisor state destination must be fresh");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}
