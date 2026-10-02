import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalStringify, validateOpaqueIdentity } from "@senawa/protocol";

export interface CopilotSessionStoreHealth {
  readonly status: "healthy" | "degraded" | "unknown";
  readonly expectedSessionCount: number;
  readonly missingSessionIds: readonly string[];
  readonly message?: string;
}

export interface CopilotSessionMetadataPort {
  sessionMetadataExists(sessionId: string): Promise<boolean>;
}

export interface CopilotSessionStorePort {
  readonly baseDirectory: string;
  health(expectedSessionIds: readonly string[]): Promise<CopilotSessionStoreHealth>;
}

export interface CopilotSessionStoreOptions {
  readonly baseDirectory: string;
  readonly metadata?: CopilotSessionMetadataPort;
}

export interface SessionStoreBackupLimits {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly publicationPort?: SessionStorePublicationPort;
}

export interface SessionStorePublicationPort {
  syncFile(path: string): void;
  syncDirectory(path: string): void;
  rename(source: string, destination: string): void;
  reopen(path: string): void;
}

export class PublishedSessionStoreDurabilityError extends Error {
  readonly published = true;
  readonly destination: string;

  constructor(destination: string, cause: unknown) {
    super(
      `SDK session directory was published at ${destination}, but final durability verification failed`,
      { cause },
    );
    this.name = "PublishedSessionStoreDurabilityError";
    this.destination = destination;
  }
}

export interface SessionStoreBackupEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly byteLength?: number;
  readonly digest?: string;
}

export interface SessionStoreBackupManifest {
  readonly format: "senawa-copilot-session-store";
  readonly version: 1;
  readonly entries: readonly SessionStoreBackupEntry[];
  readonly fileCount: number;
  readonly byteLength: number;
}

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 1_073_741_824;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
}

interface OwnedRestoreDirectory {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
}

interface SourceEntryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly linkCount: number;
  readonly size: number;
  readonly kind: "directory" | "file";
}

interface VerifiedSessionStoreSource {
  readonly ancestors: readonly DirectoryIdentity[];
  readonly inventory: ReadonlyMap<string, SourceEntryIdentity>;
  readonly manifest: SessionStoreBackupManifest;
}
export const nodeSessionStorePublicationPort: SessionStorePublicationPort = Object.freeze({
  syncFile: fsyncPath,
  syncDirectory: fsyncPath,
  rename(source: string, destination: string) {
    renameSync(source, destination);
  },
  reopen(path: string) {
    const descriptor = openSync(path, "r");
    closeSync(descriptor);
  },
});

export class FilesystemCopilotSessionStore implements CopilotSessionStorePort {
  readonly baseDirectory: string;
  readonly #metadata: CopilotSessionMetadataPort | undefined;

  constructor(options: CopilotSessionStoreOptions) {
    this.baseDirectory = resolve(options.baseDirectory);
    this.#metadata = options.metadata;
  }

  async health(expectedSessionIds: readonly string[]): Promise<CopilotSessionStoreHealth> {
    const expected = [...new Set(expectedSessionIds.map(validateOpaqueIdentity))].sort();
    try {
      assertPrivateCanonicalDirectory(this.baseDirectory);
    } catch {
      return Object.freeze({
        status: "degraded",
        expectedSessionCount: expected.length,
        missingSessionIds: Object.freeze(expected),
        message: "SDK session store is not a canonical private directory",
      });
    }
    if (expected.length === 0) {
      return Object.freeze({
        status: "healthy",
        expectedSessionCount: 0,
        missingSessionIds: Object.freeze([]),
      });
    }
    if (this.#metadata === undefined) {
      return Object.freeze({
        status: "unknown",
        expectedSessionCount: expected.length,
        missingSessionIds: Object.freeze([]),
        message: "SDK session metadata probe is unavailable",
      });
    }
    try {
      const presence = await Promise.all(
        expected.map(async (sessionId) => ({
          sessionId,
          present: await this.#metadata?.sessionMetadataExists(sessionId),
        })),
      );
      const missingSessionIds = presence
        .filter(({ present }) => present !== true)
        .map(({ sessionId }) => sessionId);
      return Object.freeze({
        status: missingSessionIds.length === 0 ? "healthy" : "degraded",
        expectedSessionCount: expected.length,
        missingSessionIds: Object.freeze(missingSessionIds),
        ...(missingSessionIds.length === 0
          ? {}
          : { message: "Expected SDK session metadata is missing" }),
      });
    } catch {
      return Object.freeze({
        status: "unknown",
        expectedSessionCount: expected.length,
        missingSessionIds: Object.freeze([]),
        message: "SDK session metadata could not be inspected",
      });
    }
  }
}

export function backupCopilotSessionStore(
  sourceDirectory: string,
  destinationDirectory: string,
  limits: SessionStoreBackupLimits = {},
): SessionStoreBackupManifest {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  assertPrivateCanonicalDirectory(source);
  const destinationParent = assertFreshDestination(destination);
  const maximumFiles = boundedLimit(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maximumBytes = boundedLimit(limits.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const publicationPort = limits.publicationPort ?? nodeSessionStorePublicationPort;
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
  mkdirSync(partial, { mode: 0o700 });
  try {
    const entries: SessionStoreBackupEntry[] = [];
    let entryCount = 0;
    let fileCount = 0;
    let byteLength = 0;
    const visit = (relativePath: string): void => {
      const sourcePath = relativePath === "" ? source : join(source, relativePath);
      const status = lstatSync(sourcePath);
      if (status.isSymbolicLink()) throw new Error("SDK session backup refuses symbolic links");
      if (status.isDirectory()) {
        if ((status.mode & 0o7000) !== 0) {
          throw new Error("SDK session backup refuses special mode bits");
        }
        if (relativePath !== "") {
          entryCount += 1;
          if (entryCount > maximumFiles) {
            throw new Error("SDK session backup exceeds configured entry bounds");
          }
          mkdirSync(join(partial, relativePath), { mode: status.mode & 0o777 });
          entries.push({
            path: portable(relativePath),
            kind: "directory",
            mode: status.mode & 0o777,
          });
        }
        for (const name of readBoundedDirectoryNames(sourcePath, maximumFiles - entryCount)) {
          if (name === "." || name === ".." || name.includes(sep))
            throw new Error("Invalid SDK entry");
          visit(relativePath === "" ? name : join(relativePath, name));
        }
        if (relativePath !== "") publicationPort.syncDirectory(join(partial, relativePath));
        return;
      }
      if (!status.isFile())
        throw new Error("SDK session backup accepts only files and directories");
      if ((status.mode & 0o7000) !== 0) {
        throw new Error("SDK session backup refuses special mode bits");
      }
      fileCount += 1;
      entryCount += 1;
      byteLength += status.size;
      if (entryCount > maximumFiles || byteLength > maximumBytes) {
        throw new Error("SDK session backup exceeds configured bounds");
      }
      const bytes = readFileSync(sourcePath);
      const destinationPath = join(partial, relativePath);
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, status.mode & 0o777);
      publicationPort.syncFile(destinationPath);
      entries.push({
        path: portable(relativePath),
        kind: "file",
        mode: status.mode & 0o777,
        byteLength: bytes.byteLength,
        digest: digest(bytes),
      });
    };
    visit("");
    const manifest: SessionStoreBackupManifest = Object.freeze({
      format: "senawa-copilot-session-store",
      version: 1,
      entries: Object.freeze(entries),
      fileCount,
      byteLength,
    });
    writeFileSync(join(partial, "manifest.json"), canonicalStringify(manifest), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    publicationPort.syncFile(join(partial, "manifest.json"));
    verifyCopilotSessionStoreBackup(partial, limits);
    publicationPort.syncDirectory(partial);
    assertUnchangedDestinationParent(destination, destinationParent);
    publicationPort.rename(partial, destination);
    try {
      publicationPort.syncDirectory(dirname(destination));
      publicationPort.reopen(destination);
    } catch (error) {
      throw new PublishedSessionStoreDurabilityError(destination, error);
    }
    return manifest;
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

export function verifyCopilotSessionStoreBackup(
  backupDirectory: string,
  limits: SessionStoreBackupLimits = {},
): SessionStoreBackupManifest {
  const backup = resolve(backupDirectory);
  const maximumFiles = boundedLimit(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maximumBytes = boundedLimit(limits.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const source = verifySessionStoreSource(backup, maximumFiles, maximumBytes);
  recheckSessionStoreSource(backup, source, maximumFiles);
  return source.manifest;
}

function verifySessionStoreSource(
  backup: string,
  maximumFiles: number,
  maximumBytes: number,
  destination?: string,
  publicationPort?: SessionStorePublicationPort,
): VerifiedSessionStoreSource {
  const ancestors = inspectCanonicalSourceComponents(backup);
  const inventory = captureSourceInventory(backup, maximumFiles + 1);
  const manifestIdentity = inventory.get("manifest.json");
  if (
    manifestIdentity === undefined ||
    manifestIdentity.kind !== "file" ||
    manifestIdentity.mode !== 0o600 ||
    manifestIdentity.linkCount !== 1 ||
    manifestIdentity.size > MAX_MANIFEST_BYTES
  ) {
    throw new Error("SDK session backup manifest exceeds its byte ceiling");
  }
  const manifest = parseManifest(
    decodeUtf8(
      readPinnedRegularFile(join(backup, "manifest.json"), manifestIdentity, manifestIdentity.size),
    ),
    maximumFiles,
  );
  if (manifest.fileCount > maximumFiles || manifest.byteLength > maximumBytes) {
    throw new Error("SDK session backup manifest exceeds configured bounds");
  }
  let declaredFiles = 0;
  let declaredBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    const byteLength = entry.byteLength ?? -1;
    declaredFiles += 1;
    if (byteLength > maximumBytes - declaredBytes) {
      throw new Error("SDK session backup manifest exceeds configured byte bounds");
    }
    declaredBytes += byteLength;
  }
  if (declaredFiles !== manifest.fileCount || declaredBytes !== manifest.byteLength) {
    throw new Error("SDK session backup manifest does not exactly cover its declared files");
  }
  const expected = new Set(["manifest.json"]);
  let verifiedBytes = 0;
  const directories: SessionStoreBackupEntry[] = [];
  for (const entry of manifest.entries) {
    const relativePath = safeRelativePath(entry.path);
    const portablePath = portable(relativePath);
    expected.add(portablePath);
    const identity = inventory.get(portablePath);
    if (identity === undefined || identity.mode !== entry.mode) {
      throw new Error("SDK session backup mode is invalid");
    }
    if (entry.kind === "directory") {
      if (identity.kind !== "directory") {
        throw new Error("SDK session backup directory entry is invalid");
      }
      directories.push(entry);
      if (destination !== undefined) {
        mkdirSync(join(destination, relativePath), { recursive: true, mode: 0o700 });
      }
    } else {
      if (identity.kind !== "file" || identity.linkCount !== 1) {
        throw new Error("SDK session backup file entry is invalid");
      }
      const byteLength = entry.byteLength ?? -1;
      if (identity.size !== byteLength || byteLength > maximumBytes - verifiedBytes) {
        throw new Error("SDK session backup file length is invalid");
      }
      const destinationPath =
        destination === undefined ? undefined : join(destination, relativePath);
      if (destinationPath !== undefined) {
        mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
      }
      if (
        copyAndDigestPinnedRegularFile(
          join(backup, relativePath),
          byteLength,
          identity,
          destinationPath,
        ) !== entry.digest
      ) {
        throw new Error("SDK session backup file digest is invalid");
      }
      if (destinationPath !== undefined) {
        chmodSync(destinationPath, entry.mode);
        publicationPort?.syncFile(destinationPath);
      }
      verifiedBytes += byteLength;
    }
  }
  if (
    [...inventory.keys()].some((entry) => !expected.has(entry)) ||
    inventory.size !== expected.size
  ) {
    throw new Error("SDK session backup manifest does not exactly cover its files");
  }
  if (destination !== undefined) {
    for (const entry of directories.sort(compareDeepestPathFirst)) {
      chmodSync(join(destination, safeRelativePath(entry.path)), entry.mode);
    }
  }
  return { ancestors, inventory, manifest };
}

export function restoreCopilotSessionStore(
  backupDirectory: string,
  destinationDirectory: string,
  limits: SessionStoreBackupLimits = {},
): void {
  const backup = resolve(backupDirectory);
  const destination = resolve(destinationDirectory);
  const destinationParent = assertFreshDestination(destination);
  const maximumFiles = boundedLimit(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maximumBytes = boundedLimit(limits.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const publicationPort = limits.publicationPort ?? nodeSessionStorePublicationPort;
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
  mkdirSync(partial, { mode: 0o700 });
  const ownedPartial = captureOwnedRestoreDirectory(partial);
  const ownedDestination = { ...ownedPartial, path: destination };
  try {
    const source = verifySessionStoreSource(
      backup,
      maximumFiles,
      maximumBytes,
      partial,
      publicationPort,
    );
    for (const entry of [...source.manifest.entries]
      .filter(({ kind }) => kind === "directory")
      .sort(compareDeepestPathFirst)) {
      publicationPort.syncDirectory(join(partial, safeRelativePath(entry.path)));
    }
    publicationPort.syncDirectory(partial);
    recheckSessionStoreSource(backup, source, maximumFiles);
    assertUnchangedDestinationParent(destination, destinationParent);
    publicationPort.rename(partial, destination);
    try {
      publicationPort.syncDirectory(dirname(destination));
      publicationPort.reopen(destination);
    } catch (error) {
      throw new PublishedSessionStoreDurabilityError(destination, error);
    }
  } catch (error) {
    removeOwnedRestoreDirectory(ownedPartial);
    if (!(error instanceof PublishedSessionStoreDurabilityError)) {
      removeOwnedRestoreDirectory(ownedDestination);
    }
    throw error;
  }
}

function captureOwnedRestoreDirectory(path: string): OwnedRestoreDirectory {
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("SDK session restore created an unexpected staging entry");
  }
  return { device: status.dev, inode: status.ino, path };
}

function removeOwnedRestoreDirectory(owned: OwnedRestoreDirectory): void {
  const status = lstatIfPresent(owned.path);
  if (
    status === undefined ||
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.dev !== owned.device ||
    status.ino !== owned.inode
  ) {
    return;
  }
  rmSync(owned.path, { recursive: true, force: true });
}

function assertPrivateCanonicalDirectory(path: string): void {
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("SDK session store must be a canonical directory");
  }
  if ((status.mode & 0o077) !== 0 || (status.mode & 0o700) !== 0o700) {
    throw new Error("SDK session store must be private");
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error("SDK session store must be owned by the current user");
  }
}

function assertFreshDestination(path: string): DirectoryIdentity {
  const parent = dirname(path);
  inspectSafeDirectoryComponents(parent);
  assertPathAbsent(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const identity = inspectSafeDirectoryComponents(parent);
  if (identity === undefined) throw new Error("SDK session destination parent is missing");
  assertPathAbsent(path);
  return identity;
}

function assertUnchangedDestinationParent(destination: string, expected: DirectoryIdentity): void {
  const current = inspectSafeDirectoryComponents(dirname(destination));
  assertPathAbsent(destination);
  if (
    current === undefined ||
    current.path !== expected.path ||
    current.device !== expected.device ||
    current.inode !== expected.inode
  ) {
    throw new Error("SDK session destination parent changed before publication");
  }
}

function inspectSafeDirectoryComponents(directory: string): DirectoryIdentity | undefined {
  if (!isAbsolute(directory)) throw new Error("SDK session destination parent must be absolute");
  const root = parse(directory).root;
  const trustedRoot = realpathSync(root);
  let current = root;
  for (const component of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, component);
    const status = lstatIfPresent(current);
    if (status === undefined) return undefined;
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("SDK session destination must be fresh with safe ancestors");
    }
    const canonical = realpathSync(current);
    if (!isContainedPath(trustedRoot, canonical) || canonical !== current) {
      throw new Error("SDK session destination ancestor is not canonical");
    }
  }
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(directory) !== directory) {
    throw new Error("SDK session destination must be fresh with safe ancestors");
  }
  return { device: status.dev, inode: status.ino, path: directory };
}

function assertPathAbsent(path: string): void {
  if (lstatIfPresent(path) !== undefined) {
    throw new Error("SDK session destination must be fresh with safe ancestors");
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return (
    offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
  );
}

function parseManifest(input: string, maximumEntries: number): SessionStoreBackupManifest {
  const value = JSON.parse(input) as SessionStoreBackupManifest;
  if (
    value.format !== "senawa-copilot-session-store" ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0
  ) {
    throw new Error("SDK session backup manifest is invalid");
  }
  if (value.entries.length > maximumEntries) {
    throw new Error("SDK session backup manifest exceeds configured entry bounds");
  }
  const paths = new Set<string>();
  for (const entry of value.entries) {
    const path = safeRelativePath(entry.path);
    if (paths.has(path) || (entry.kind !== "file" && entry.kind !== "directory")) {
      throw new Error("SDK session backup entry is invalid");
    }
    paths.add(path);
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("SDK session backup mode is invalid");
    }
    if (
      entry.kind === "file" &&
      (!Number.isSafeInteger(entry.byteLength) ||
        (entry.byteLength ?? -1) < 0 ||
        !/^[0-9a-f]{64}$/u.test(entry.digest ?? ""))
    ) {
      throw new Error("SDK session backup file metadata is invalid");
    }
  }
  return value;
}

function inspectCanonicalSourceComponents(directory: string): readonly DirectoryIdentity[] {
  if (!isAbsolute(directory)) throw new Error("SDK session backup root must be absolute");
  const identities: DirectoryIdentity[] = [];
  const root = parse(directory).root;
  let current = root;
  for (const component of ["", ...relative(root, directory).split(sep).filter(Boolean)]) {
    if (component !== "") current = join(current, component);
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(current) !== current) {
      throw new Error("SDK session backup ancestors must be canonical real directories");
    }
    identities.push({ device: status.dev, inode: status.ino, path: current });
  }
  if ((lstatSync(directory).mode & 0o7777) !== 0o700) {
    throw new Error("SDK session backup root mode is invalid");
  }
  return identities;
}

function captureSourceInventory(
  root: string,
  maximumEntries: number,
): ReadonlyMap<string, SourceEntryIdentity> {
  const entries = new Map<string, SourceEntryIdentity>();
  const visit = (directory: string): void => {
    for (const name of readBoundedDirectoryNames(directory, maximumEntries - entries.size)) {
      const path = join(directory, name);
      const relativePath = portable(relative(root, path));
      const status = lstatSync(path);
      if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
        throw new Error("SDK session backup accepts only real files and directories");
      }
      if ((status.mode & 0o7000) !== 0) {
        throw new Error("SDK session backup mode is invalid");
      }
      const identity: SourceEntryIdentity = {
        device: status.dev,
        inode: status.ino,
        mode: status.mode & 0o7777,
        linkCount: status.nlink,
        size: status.size,
        kind: status.isDirectory() ? "directory" : "file",
      };
      assertOpenedIdentity(path, identity);
      entries.set(relativePath, identity);
      if (entries.size > maximumEntries) {
        throw new Error("SDK session backup exceeds configured entry bounds");
      }
      if (identity.kind === "directory") visit(path);
    }
  };
  visit(root);
  return entries;
}

function readBoundedDirectoryNames(directory: string, remainingEntries: number): string[] {
  const names: string[] = [];
  const handle = opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      names.push(entry.name);
      if (names.length > remainingEntries) {
        throw new Error("SDK session backup exceeds configured entry bounds");
      }
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
}

function assertOpenedIdentity(path: string, expected: SourceEntryIdentity): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (expected.kind === "directory" ? constants.O_DIRECTORY : 0),
  );
  try {
    if (!matchesSourceIdentity(fstatSync(descriptor), expected)) {
      throw new Error("SDK session backup entry changed while opening");
    }
  } finally {
    closeSync(descriptor);
  }
}

function readPinnedRegularFile(
  path: string,
  expected: SourceEntryIdentity,
  expectedBytes: number,
): Uint8Array {
  const bytes = Buffer.alloc(expectedBytes);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!matchesSourceIdentity(opened, expected) || opened.size !== expectedBytes) {
      throw new Error("SDK session backup manifest changed while opening");
    }
    readExact(descriptor, bytes, expectedBytes);
    assertNoAdditionalByte(descriptor);
    const final = fstatSync(descriptor);
    if (!matchesSourceIdentity(final, expected) || final.size !== expectedBytes) {
      throw new Error("SDK session backup manifest changed while read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error("SDK session backup manifest is not valid UTF-8");
  }
}

function copyAndDigestPinnedRegularFile(
  path: string,
  expectedBytes: number,
  expected: SourceEntryIdentity,
  destination: string | undefined,
): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const destinationDescriptor =
    destination === undefined
      ? undefined
      : openSync(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
  try {
    const opened = fstatSync(descriptor);
    if (!matchesSourceIdentity(opened, expected) || opened.size !== expectedBytes) {
      throw new Error("SDK session backup file length is invalid");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(READ_BUFFER_BYTES, Math.max(expectedBytes, 1)));
    let remaining = expectedBytes;
    while (remaining > 0) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, remaining), null);
      if (count === 0) throw new Error("SDK session backup file was truncated while read");
      hash.update(buffer.subarray(0, count));
      if (destinationDescriptor !== undefined) writeAll(destinationDescriptor, buffer, count);
      remaining -= count;
    }
    assertNoAdditionalByte(descriptor);
    const final = fstatSync(descriptor);
    if (!matchesSourceIdentity(final, expected) || final.size !== expectedBytes) {
      throw new Error("SDK session backup file changed while read");
    }
    return hash.digest("hex");
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(descriptor);
  }
}

function recheckSessionStoreSource(
  backup: string,
  expected: VerifiedSessionStoreSource,
  maximumFiles: number,
): void {
  const ancestors = inspectCanonicalSourceComponents(backup);
  if (
    ancestors.length !== expected.ancestors.length ||
    ancestors.some((identity, index) => !sameDirectoryIdentity(identity, expected.ancestors[index]))
  ) {
    throw new Error("SDK session backup root or parent changed during verification");
  }
  const inventory = captureSourceInventory(backup, maximumFiles + 1);
  if (
    inventory.size !== expected.inventory.size ||
    [...inventory].some(([path, identity]) => {
      const prior = expected.inventory.get(path);
      return prior === undefined || !sameSourceIdentity(identity, prior);
    })
  ) {
    throw new Error("SDK session backup inventory changed during verification");
  }
}

function matchesSourceIdentity(status: Stats, expected: SourceEntryIdentity): boolean {
  return (
    (expected.kind === "file" ? status.isFile() : status.isDirectory()) &&
    status.dev === expected.device &&
    status.ino === expected.inode &&
    status.nlink === expected.linkCount &&
    status.size === expected.size &&
    (status.mode & 0o7777) === expected.mode
  );
}

function sameSourceIdentity(left: SourceEntryIdentity, right: SourceEntryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.linkCount === right.linkCount &&
    left.size === right.size &&
    left.kind === right.kind
  );
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity | undefined,
): boolean {
  return (
    right !== undefined &&
    left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function writeAll(descriptor: number, source: Uint8Array, byteLength: number): void {
  let offset = 0;
  while (offset < byteLength) {
    offset += writeSync(descriptor, source, offset, byteLength - offset);
  }
}

function readExact(descriptor: number, target: Uint8Array, byteLength: number): void {
  let offset = 0;
  while (offset < byteLength) {
    const count = readSync(descriptor, target, offset, byteLength - offset, null);
    if (count === 0) throw new Error("SDK session backup file was truncated while read");
    offset += count;
  }
}

function assertNoAdditionalByte(descriptor: number): void {
  if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
    throw new Error("SDK session backup file grew while read");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeRelativePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("SDK session backup path is invalid");
  }
  return path.split("/").join(sep);
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function compareDeepestPathFirst(
  left: SessionStoreBackupEntry,
  right: SessionStoreBackupEntry,
): number {
  return (
    right.path.split("/").length - left.path.split("/").length ||
    right.path.localeCompare(left.path)
  );
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedLimit(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${field} must be positive`);
  return result;
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
