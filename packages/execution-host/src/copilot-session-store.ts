import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  assertFreshDestination(destination);
  const maximumFiles = boundedLimit(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maximumBytes = boundedLimit(limits.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
  mkdirSync(partial, { mode: 0o700 });
  try {
    const entries: SessionStoreBackupEntry[] = [];
    let fileCount = 0;
    let byteLength = 0;
    const visit = (relativePath: string): void => {
      const sourcePath = relativePath === "" ? source : join(source, relativePath);
      const status = lstatSync(sourcePath);
      if (status.isSymbolicLink()) throw new Error("SDK session backup refuses symbolic links");
      if (status.isDirectory()) {
        if (relativePath !== "") {
          mkdirSync(join(partial, relativePath), { mode: status.mode & 0o777 });
          entries.push({
            path: portable(relativePath),
            kind: "directory",
            mode: status.mode & 0o777,
          });
        }
        for (const name of readdirSync(sourcePath).sort()) {
          if (name === "." || name === ".." || name.includes(sep))
            throw new Error("Invalid SDK entry");
          visit(relativePath === "" ? name : join(relativePath, name));
        }
        return;
      }
      if (!status.isFile())
        throw new Error("SDK session backup accepts only files and directories");
      fileCount += 1;
      byteLength += status.size;
      if (fileCount > maximumFiles || byteLength > maximumBytes) {
        throw new Error("SDK session backup exceeds configured bounds");
      }
      const bytes = readFileSync(sourcePath);
      const destinationPath = join(partial, relativePath);
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, status.mode & 0o777);
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
    verifyCopilotSessionStoreBackup(partial, limits);
    renameSync(partial, destination);
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
  const manifestPath = join(backup, "manifest.json");
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  const maximumFiles = boundedLimit(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maximumBytes = boundedLimit(limits.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  if (manifest.fileCount > maximumFiles || manifest.byteLength > maximumBytes) {
    throw new Error("SDK session backup manifest exceeds configured bounds");
  }
  let files = 0;
  let bytes = 0;
  const expected = new Set(["manifest.json"]);
  for (const entry of manifest.entries) {
    const relativePath = safeRelativePath(entry.path);
    expected.add(relativePath);
    const path = join(backup, relativePath);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) throw new Error("SDK session backup contains a symbolic link");
    if (entry.kind === "directory") {
      if (!status.isDirectory()) throw new Error("SDK session backup directory entry is invalid");
    } else {
      if (!status.isFile()) throw new Error("SDK session backup file entry is invalid");
      const content = readFileSync(path);
      if (content.byteLength !== entry.byteLength || digest(content) !== entry.digest) {
        throw new Error("SDK session backup file digest is invalid");
      }
      files += 1;
      bytes += content.byteLength;
    }
    if ((status.mode & 0o777) !== entry.mode) throw new Error("SDK session backup mode is invalid");
  }
  const actual = listRelativeEntries(backup);
  if (
    actual.some((entry) => !expected.has(entry)) ||
    files !== manifest.fileCount ||
    bytes !== manifest.byteLength
  ) {
    throw new Error("SDK session backup manifest does not exactly cover its files");
  }
  return manifest;
}

export function restoreCopilotSessionStore(
  backupDirectory: string,
  destinationDirectory: string,
  limits: SessionStoreBackupLimits = {},
): void {
  const backup = resolve(backupDirectory);
  const destination = resolve(destinationDirectory);
  const manifest = verifyCopilotSessionStoreBackup(backup, limits);
  assertFreshDestination(destination);
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
  mkdirSync(partial, { mode: 0o700 });
  try {
    for (const entry of manifest.entries.filter(({ kind }) => kind === "directory")) {
      mkdirSync(join(partial, safeRelativePath(entry.path)), { recursive: true, mode: entry.mode });
    }
    for (const entry of manifest.entries.filter(({ kind }) => kind === "file")) {
      const relativePath = safeRelativePath(entry.path);
      mkdirSync(dirname(join(partial, relativePath)), { recursive: true, mode: 0o700 });
      copyFileSync(join(backup, relativePath), join(partial, relativePath));
      chmodSync(join(partial, relativePath), entry.mode);
    }
    renameSync(partial, destination);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
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

function assertFreshDestination(path: string): void {
  if (
    existsSync(path) ||
    (existsSync(dirname(path)) && lstatSync(dirname(path)).isSymbolicLink())
  ) {
    throw new Error("SDK session destination must be fresh with a safe parent");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function parseManifest(input: string): SessionStoreBackupManifest {
  const value = JSON.parse(input) as SessionStoreBackupManifest;
  if (
    value.format !== "senawa-copilot-session-store" ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    !Number.isSafeInteger(value.fileCount) ||
    !Number.isSafeInteger(value.byteLength)
  ) {
    throw new Error("SDK session backup manifest is invalid");
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

function listRelativeEntries(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = portable(relative(root, path));
      entries.push(relativePath);
      if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  visit(root);
  return entries;
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

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedLimit(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${field} must be positive`);
  return result;
}
