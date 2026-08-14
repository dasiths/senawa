import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  type Stats,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  backupCopilotSessionStore,
  restoreCopilotSessionStore,
  type SessionStorePublicationPort,
  verifyCopilotSessionStoreBackup,
} from "@senawa/execution-host";
import { canonicalStringify } from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import {
  checkSqliteAuthorityBackupIntegrity,
  restoreSqliteAuthority,
  type SqliteAuthority,
} from "@senawa/storage-sqlite";
import type { SupervisorService } from "@senawa/supervisor";
import {
  type DurableDirectoryPublicationPort,
  nodeDirectoryPublicationPort,
  publishDirectoryAtomically,
} from "./durable-directory.js";

const MAX_BACKUP_FILES = 10_000;
const MAX_BACKUP_DIRECTORIES = 10_000;
const MAX_BACKUP_FILE_BYTES = 1_073_741_824;
const MAX_BACKUP_TOTAL_BYTES = 1_073_741_824;
const MAX_MANIFEST_BYTES = 4_194_304;
const MAX_BACKUP_PATH_BYTES = 1_024;
const MAX_BACKUP_PATH_SEGMENTS = 256;

interface SupervisorStateBackupManifest {
  readonly format: "senawa-supervisor-state";
  readonly version: 1;
  readonly requestId: string;
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly digest: string;
  }[];
}

interface BackupPathIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly linkCount: number;
  readonly size: number;
  readonly kind: "directory" | "file";
}

interface BackupDirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
}

interface OwnedRestorePath {
  readonly device: number;
  readonly inode: number;
  readonly kind: "directory" | "file";
  readonly path: string;
}

export async function backupSupervisorState(input: {
  readonly service: Pick<SupervisorService, "authority" | "withQuiescentState">;
  readonly stopSdkClient: () => Promise<void>;
  readonly sdkDirectory: string;
  readonly destinationDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly requestId?: string;
  readonly publicationPort?: DurableDirectoryPublicationPort;
}): Promise<SupervisorStateBackupManifest> {
  return input.service.withQuiescentState(async (proof) => {
    proof.assertDrained();
    await input.stopSdkClient();
    proof.assertDrained();
    const destination = resolve(input.destinationDirectory);
    const requestId = input.requestId ?? "direct-backup";
    if (existsSync(destination)) {
      const existing = verifySupervisorStateBackup(destination, input.dependencies);
      if (input.requestId !== undefined && existing.requestId === requestId) return existing;
      throw new Error("Supervisor state destination must be fresh");
    }
    assertFreshDirectoryDestination(destination);
    const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
    const publicationPort = input.publicationPort ?? nodeDirectoryPublicationPort;
    mkdirSync(partial, { mode: 0o700 });
    try {
      await input.service.authority.commandAuthority.backup(join(partial, "sqlite"));
      backupCopilotSessionStore(input.sdkDirectory, join(partial, "sdk"), {
        publicationPort,
      });
      const manifest: SupervisorStateBackupManifest = {
        format: "senawa-supervisor-state",
        version: 1,
        requestId,
        files: Object.freeze(fileRecords(partial)),
      };
      writeFileSync(join(partial, "manifest.json"), canonicalStringify(manifest), {
        mode: 0o600,
        flag: "wx",
      });
      publicationPort.syncFile(join(partial, "manifest.json"));
      verifySupervisorStateBackup(partial, input.dependencies);
      publishDirectoryAtomically(partial, destination, publicationPort);
      return verifySupervisorStateBackup(destination, input.dependencies);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  });
}

export function verifySupervisorStateBackup(
  backupDirectory: string,
  dependencies: RuntimeDependencies,
): SupervisorStateBackupManifest {
  return withVerifiedSupervisorStateBackup(backupDirectory, dependencies, (_snapshot, manifest) =>
    Object.freeze(manifest),
  );
}

export function restoreSupervisorStateBackup(input: {
  readonly backupDirectory: string;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly sdkDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly sdkPublicationPort?: SessionStorePublicationPort;
}): SqliteAuthority {
  return withVerifiedSupervisorStateBackup(input.backupDirectory, input.dependencies, (backup) => {
    const databasePath = resolve(input.databasePath);
    const assetDirectory = resolve(input.assetDirectory);
    const sdkDirectory = resolve(input.sdkDirectory);
    assertFresh(databasePath);
    assertFresh(assetDirectory);
    assertFresh(sdkDirectory);
    let authority: SqliteAuthority | undefined;
    let database: OwnedRestorePath | undefined;
    let assets: OwnedRestorePath | undefined;
    let sdk: OwnedRestorePath | undefined;
    try {
      authority = restoreSqliteAuthority({
        backupPath: join(backup, "sqlite"),
        databasePath,
        assetDirectory,
        dependencies: input.dependencies,
      });
      database = captureOwnedRestorePath(databasePath, "file");
      assets = captureOwnedRestorePath(assetDirectory, "directory");
      restoreCopilotSessionStore(
        join(backup, "sdk"),
        sdkDirectory,
        input.sdkPublicationPort === undefined ? {} : { publicationPort: input.sdkPublicationPort },
      );
      sdk = captureOwnedRestorePath(sdkDirectory, "directory");
      return authority;
    } catch (error) {
      authority?.close();
      if (isPublishedDestinationError(error, sdkDirectory)) throw error;
      removeOwnedRestorePath(sdk);
      removeOwnedRestorePath(assets);
      removeOwnedRestorePath(database);
      throw error;
    }
  });
}

export function restoreSupervisorStateRoot(input: {
  readonly backupDirectory: string;
  readonly destinationStateRoot: string;
  readonly dependencies: RuntimeDependencies;
}): SqliteAuthority {
  const destination = resolve(input.destinationStateRoot);
  assertFreshDirectoryDestination(destination);
  mkdirSync(destination, { mode: 0o700 });
  const ownedDestination = captureOwnedRestorePath(destination, "directory");
  try {
    return restoreSupervisorStateBackup({
      backupDirectory: input.backupDirectory,
      databasePath: join(destination, "authority.db"),
      assetDirectory: join(destination, "assets"),
      sdkDirectory: join(destination, "copilot-sdk"),
      dependencies: input.dependencies,
    });
  } catch (error) {
    if (isPublishedDestinationWithin(error, destination)) throw error;
    removeOwnedEmptyDirectory(ownedDestination);
    throw error;
  }
}

function captureOwnedRestorePath(
  path: string,
  expectedKind: OwnedRestorePath["kind"],
): OwnedRestorePath {
  const status = lstatSync(path);
  const kind = status.isFile() ? "file" : status.isDirectory() ? "directory" : undefined;
  if (kind !== expectedKind) throw new Error("Supervisor restore created an unexpected path type");
  return { device: status.dev, inode: status.ino, kind, path };
}

function removeOwnedRestorePath(owned: OwnedRestorePath | undefined): void {
  if (owned === undefined || !matchesOwnedRestorePath(owned)) return;
  rmSync(owned.path, { recursive: owned.kind === "directory", force: true });
}

function removeOwnedEmptyDirectory(owned: OwnedRestorePath): void {
  if (!matchesOwnedRestorePath(owned)) return;
  try {
    rmdirSync(owned.path);
  } catch (error) {
    if (!isNodeError(error, "ENOTEMPTY") && !isNodeError(error, "ENOENT")) throw error;
  }
}

function matchesOwnedRestorePath(owned: OwnedRestorePath): boolean {
  const status = lstatIfPresent(owned.path);
  return (
    status !== undefined &&
    status.dev === owned.device &&
    status.ino === owned.inode &&
    (owned.kind === "file" ? status.isFile() : status.isDirectory())
  );
}

function isPublishedDestinationError(error: unknown, destination: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as Readonly<Record<string, unknown>>;
  return record.published === true && record.destination === destination;
}

function isPublishedDestinationWithin(error: unknown, root: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const destination = (error as Readonly<Record<string, unknown>>).destination;
  return (
    (error as Readonly<Record<string, unknown>>).published === true &&
    typeof destination === "string" &&
    (destination === root || destination.startsWith(`${root}${sep}`))
  );
}

function withVerifiedSupervisorStateBackup<T>(
  backupDirectory: string,
  dependencies: RuntimeDependencies,
  operation: (snapshot: string, manifest: SupervisorStateBackupManifest) => T,
): T {
  const backup = resolve(backupDirectory);
  const ancestors = inspectCanonicalBackupComponents(backup);
  const manifestStatus = lstatSync(join(backup, "manifest.json"));
  const manifestIdentity = backupPathIdentity(manifestStatus);
  if (
    manifestIdentity.kind !== "file" ||
    manifestIdentity.linkCount !== 1 ||
    manifestIdentity.mode !== 0o600 ||
    manifestIdentity.size > MAX_MANIFEST_BYTES
  ) {
    throw new Error("Supervisor state backup manifest is invalid");
  }
  const manifestBytes = readPinnedBytes(
    join(backup, "manifest.json"),
    manifestIdentity,
    MAX_MANIFEST_BYTES,
  );
  const manifestText = decodeManifest(manifestBytes);
  const manifest = parseManifest(manifestText);
  if (canonicalStringify(manifest) !== manifestText) {
    throw new Error("Supervisor state backup manifest is invalid");
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "senawa-state-backup-verified-"));
  chmodSync(temporaryRoot, 0o700);
  const snapshot = join(temporaryRoot, "backup");
  mkdirSync(snapshot, { mode: 0o700 });
  try {
    writeFileSync(join(snapshot, "manifest.json"), manifestBytes, {
      mode: 0o600,
      flag: "wx",
    });
    const scanned = scanBackupTree(backup, new Set(["manifest.json"]), snapshot);
    const scannedManifest = scanned.inventory.get("manifest.json");
    if (
      scannedManifest === undefined ||
      !sameBackupIdentity(scannedManifest, manifestIdentity) ||
      [...scanned.inventory.keys()]
        .filter((path) => !path.includes("/"))
        .sort()
        .join(",") !== "manifest.json,sdk,sqlite"
    ) {
      throw new Error("Supervisor state backup inventory is invalid");
    }
    if (canonicalStringify(scanned.records) !== canonicalStringify(manifest.files)) {
      throw new Error("Supervisor state backup manifest does not match its files");
    }
    if (
      checkSqliteAuthorityBackupIntegrity({
        backupPath: join(snapshot, "sqlite"),
        dependencies,
      }).status !== "passed"
    ) {
      throw new Error("Supervisor state backup SQLite integrity verification failed");
    }
    verifyCopilotSessionStoreBackup(join(snapshot, "sdk"));
    const finalAncestors = inspectCanonicalBackupComponents(backup);
    const finalScan = scanBackupTree(backup, new Set(["manifest.json"]));
    if (
      !sameBackupAncestors(ancestors, finalAncestors) ||
      !sameBackupInventory(scanned.inventory, finalScan.inventory) ||
      canonicalStringify(finalScan.records) !== canonicalStringify(manifest.files)
    ) {
      throw new Error("Supervisor state backup source changed during verification");
    }
    return operation(snapshot, manifest);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function fileRecords(root: string, excluded = new Set<string>()) {
  inspectCanonicalBackupComponents(root);
  return scanBackupTree(root, excluded).records;
}

function scanBackupTree(root: string, excluded: ReadonlySet<string>, destination?: string) {
  const records: { path: string; byteLength: number; digest: string }[] = [];
  const inventory = new Map<string, BackupPathIdentity>();
  const normalizedPaths = new Set<string>();
  let entryCount = 0;
  let directoryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const names = readBoundedDirectoryNames(directory, MAX_BACKUP_FILES - entryCount);
    for (const name of names) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split(sep).join("/");
      entryCount += 1;
      if (entryCount > MAX_BACKUP_FILES) {
        throw new Error("Supervisor backup exceeds its entry count limit");
      }
      const normalizedPath = validateBackupPath(relativePath);
      if (normalizedPaths.has(normalizedPath)) {
        throw new Error("Supervisor backup contains duplicate normalized paths");
      }
      normalizedPaths.add(normalizedPath);
      const status = lstatSync(path);
      const identity = backupPathIdentity(status);
      inventory.set(relativePath, identity);
      assertPinnedPath(path, identity);
      if (identity.kind === "directory") {
        directoryCount += 1;
        if (directoryCount > MAX_BACKUP_DIRECTORIES) {
          throw new Error("Supervisor backup exceeds its directory count limit");
        }
        if (destination !== undefined) {
          mkdirSync(join(destination, ...relativePath.split("/")), {
            recursive: true,
            mode: 0o700,
          });
        }
        visit(path);
      } else {
        fileCount += 1;
        if (fileCount > MAX_BACKUP_FILES) {
          throw new Error("Supervisor backup exceeds its file count limit");
        }
        if (identity.linkCount !== 1 || identity.size > MAX_BACKUP_FILE_BYTES) {
          throw new Error("Supervisor backup contains an unsafe regular file");
        }
        totalBytes += identity.size;
        if (totalBytes > MAX_BACKUP_TOTAL_BYTES) {
          throw new Error("Supervisor backup exceeds its total byte limit");
        }
        const destinationPath =
          destination === undefined || excluded.has(relativePath)
            ? undefined
            : join(destination, ...relativePath.split("/"));
        if (destinationPath !== undefined) {
          mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
        }
        const digest = streamPinnedFile(path, identity, destinationPath);
        if (destinationPath !== undefined) chmodSync(destinationPath, identity.mode);
        if (!excluded.has(relativePath)) {
          records.push({ path: relativePath, byteLength: identity.size, digest });
        }
      }
    }
  };
  visit(root);
  if (destination !== undefined) {
    for (const [path, identity] of [...inventory]
      .filter(([, identity]) => identity.kind === "directory")
      .sort(([left], [right]) => right.split("/").length - left.split("/").length)) {
      chmodSync(join(destination, ...path.split("/")), identity.mode);
    }
  }
  return { inventory, records };
}

function readBoundedDirectoryNames(directory: string, remainingEntries: number): string[] {
  const names: string[] = [];
  const handle = opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      names.push(entry.name);
      if (names.length > remainingEntries) {
        throw new Error("Supervisor backup exceeds its entry count limit");
      }
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
}

function inspectCanonicalBackupComponents(path: string): readonly BackupDirectoryIdentity[] {
  if (!isAbsolute(path)) throw new Error("Supervisor state backup path must be absolute");
  const root = parse(path).root;
  const identities: BackupDirectoryIdentity[] = [];
  let current = root;
  for (const component of ["", ...relative(root, path).split(sep).filter(Boolean)]) {
    if (component !== "") current = join(current, component);
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(current) !== current) {
      throw new Error("Supervisor state backup ancestors must be canonical real directories");
    }
    identities.push({ device: status.dev, inode: status.ino, path: current });
  }
  if ((lstatSync(path).mode & 0o7777) !== 0o700) {
    throw new Error("Supervisor state backup root mode is invalid");
  }
  return identities;
}

function backupPathIdentity(status: Stats): BackupPathIdentity {
  if (status.isSymbolicLink()) {
    throw new Error("Supervisor backup refuses symbolic links");
  }
  if (!status.isDirectory() && !status.isFile()) {
    throw new Error("Supervisor backup accepts only regular files and directories");
  }
  if ((status.mode & 0o7000) !== 0) {
    throw new Error(
      status.isFile()
        ? "Supervisor backup contains an unsafe regular file"
        : "Supervisor backup contains unsafe directory mode bits",
    );
  }
  return {
    device: status.dev,
    inode: status.ino,
    mode: status.mode & 0o7777,
    linkCount: status.nlink,
    size: status.size,
    kind: status.isDirectory() ? "directory" : "file",
  };
}

function assertPinnedPath(path: string, expected: BackupPathIdentity): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (expected.kind === "directory" ? constants.O_DIRECTORY : 0),
  );
  try {
    if (!matchesBackupIdentity(fstatSync(descriptor), expected)) {
      throw new Error("Supervisor backup entry changed while opening");
    }
  } finally {
    closeSync(descriptor);
  }
}

function readPinnedBytes(
  path: string,
  expected: BackupPathIdentity,
  maximumBytes: number,
): Uint8Array {
  if (expected.size > maximumBytes) throw new Error("Supervisor state backup manifest is invalid");
  const bytes = Buffer.alloc(expected.size);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!matchesBackupIdentity(fstatSync(descriptor), expected)) {
      throw new Error("Supervisor state backup manifest changed while opening");
    }
    readExact(descriptor, bytes, expected.size);
    assertNoAdditionalByte(descriptor);
    if (!matchesBackupIdentity(fstatSync(descriptor), expected)) {
      throw new Error("Supervisor state backup manifest changed while reading");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function streamPinnedFile(
  path: string,
  expected: BackupPathIdentity,
  destination: string | undefined,
): string {
  const sourceDescriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const destinationDescriptor =
    destination === undefined
      ? undefined
      : openSync(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
  try {
    if (!matchesBackupIdentity(fstatSync(sourceDescriptor), expected)) {
      throw new Error("Supervisor backup file changed while opening");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(expected.size, 1)));
    let remaining = expected.size;
    while (remaining > 0) {
      const count = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, remaining),
        null,
      );
      if (count === 0) throw new Error("Supervisor backup file was truncated while reading");
      hash.update(buffer.subarray(0, count));
      if (destinationDescriptor !== undefined) writeAll(destinationDescriptor, buffer, count);
      remaining -= count;
    }
    assertNoAdditionalByte(sourceDescriptor);
    if (!matchesBackupIdentity(fstatSync(sourceDescriptor), expected)) {
      throw new Error("Supervisor backup file changed while reading");
    }
    return hash.digest("hex");
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

function sameBackupAncestors(
  left: readonly BackupDirectoryIdentity[],
  right: readonly BackupDirectoryIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (identity, index) =>
        identity.path === right[index]?.path &&
        identity.device === right[index]?.device &&
        identity.inode === right[index]?.inode,
    )
  );
}

function sameBackupInventory(
  left: ReadonlyMap<string, BackupPathIdentity>,
  right: ReadonlyMap<string, BackupPathIdentity>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([path, identity]) => {
      const candidate = right.get(path);
      return candidate !== undefined && sameBackupIdentity(identity, candidate);
    })
  );
}

function sameBackupIdentity(left: BackupPathIdentity, right: BackupPathIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.linkCount === right.linkCount &&
    left.size === right.size &&
    left.kind === right.kind
  );
}

function matchesBackupIdentity(status: Stats, expected: BackupPathIdentity): boolean {
  return (
    (expected.kind === "file" ? status.isFile() : status.isDirectory()) &&
    status.dev === expected.device &&
    status.ino === expected.inode &&
    status.nlink === expected.linkCount &&
    status.size === expected.size &&
    (status.mode & 0o7777) === expected.mode
  );
}

function readExact(descriptor: number, target: Uint8Array, byteLength: number): void {
  let offset = 0;
  while (offset < byteLength) {
    const count = readSync(descriptor, target, offset, byteLength - offset, null);
    if (count === 0) throw new Error("Supervisor backup file was truncated while reading");
    offset += count;
  }
}

function assertNoAdditionalByte(descriptor: number): void {
  if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
    throw new Error("Supervisor backup file grew while reading");
  }
}

function writeAll(descriptor: number, source: Uint8Array, byteLength: number): void {
  let offset = 0;
  while (offset < byteLength) {
    offset += writeSync(descriptor, source, offset, byteLength - offset);
  }
}

function decodeManifest(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Supervisor state backup manifest is invalid");
  }
}

function parseManifest(content: string): SupervisorStateBackupManifest {
  const value = JSON.parse(content) as SupervisorStateBackupManifest;
  const normalizedPaths = Array.isArray(value?.files)
    ? value.files.map((file) =>
        typeof file?.path === "string" ? validateBackupPath(file.path) : "<invalid>",
      )
    : [];
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "files,format,requestId,version" ||
    value.format !== "senawa-supervisor-state" ||
    value.version !== 1 ||
    typeof value.requestId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/u.test(value.requestId) ||
    !Array.isArray(value.files) ||
    value.files.length > MAX_BACKUP_FILES ||
    value.files.some(
      (file, index) =>
        file === null ||
        typeof file !== "object" ||
        Object.keys(file).sort().join(",") !== "byteLength,digest,path" ||
        typeof file.path !== "string" ||
        normalizedPaths[index] === "<invalid>" ||
        !Number.isSafeInteger(file.byteLength) ||
        file.byteLength < 0 ||
        file.byteLength > MAX_BACKUP_FILE_BYTES ||
        !/^[0-9a-f]{64}$/u.test(file.digest),
    ) ||
    new Set(normalizedPaths).size !== value.files.length ||
    value.files.reduce((total, file) => total + file.byteLength, 0) > MAX_BACKUP_TOTAL_BYTES ||
    value.files.some(
      (file, index) => index > 0 && file.path <= (value.files[index - 1]?.path ?? ""),
    )
  ) {
    throw new Error("Supervisor state backup manifest is invalid");
  }
  return value;
}

function validateBackupPath(path: string): string {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    Buffer.byteLength(path, "utf8") > MAX_BACKUP_PATH_BYTES ||
    segments.length > MAX_BACKUP_PATH_SEGMENTS ||
    segments.some((part) => part === "" || part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error("Supervisor state backup manifest is invalid");
  }
  return path.normalize("NFC");
}

function assertFresh(path: string): void {
  if (lstatIfPresent(path) !== undefined) {
    throw new Error("Supervisor state destination must be fresh");
  }
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertFreshDirectoryDestination(path: string): void {
  assertFresh(path);
  const parentPath = dirname(path);
  const parent = lstatSync(parentPath);
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    realpathSync(parentPath) !== resolve(parentPath)
  ) {
    throw new Error("Supervisor state destination parent must be a real directory");
  }
}
