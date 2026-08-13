import { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "node:path";
import type { SupervisorRandom } from "./contracts.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CREDENTIAL_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const LOCK_RECORD_VERSION = 1;
const PROCESS_START_TIME_PATTERN = /^[1-9][0-9]*$/u;
const activeUnixSocketLocks = new WeakSet<UnixSocketLock>();

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface UnixSocketIdentity extends FileIdentity {}

export interface UnixSocketLock {
  readonly socketPath: string;
  readonly lockPath: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
}

interface LockRecord {
  readonly pid: number;
  readonly startTime: string;
  readonly version: typeof LOCK_RECORD_VERSION;
}

export interface LocalCredential {
  readonly token: string;
  readonly bytes: Uint8Array;
}

export function ensurePrivateRuntimeDirectory(runtimeDirectory: string): string {
  const absolute = resolve(runtimeDirectory);
  assertNoSymlinkComponents(dirname(absolute));
  if (!existsSync(absolute)) mkdirSync(absolute, { mode: PRIVATE_DIRECTORY_MODE });
  assertNoSymlinkComponents(absolute);
  const metadata = lstatSync(absolute);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error("Supervisor runtime directory must be private and owned by the current user");
  }
  return absolute;
}

export function loadOrCreateLocalCredential(
  runtimeDirectory: string,
  random: SupervisorRandom,
  fileName = "credential",
): LocalCredential {
  const directory = ensurePrivateRuntimeDirectory(runtimeDirectory);
  const path = resolve(directory, fileName);
  if (dirname(path) !== directory)
    throw new Error("Credential path must remain in the runtime directory");
  try {
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      const bytes = exactRandomBytes(random, CREDENTIAL_BYTES);
      const token = Buffer.from(bytes).toString("base64url");
      writeSync(descriptor, token, undefined, "ascii");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(directory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  return readPrivateCredential(path);
}

export function readPrivateCredential(path: string): LocalCredential {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw new Error("Supervisor credential must be a private file owned by the current user");
  }
  const token = readFileSync(path, "ascii");
  if (!BASE64URL_PATTERN.test(token)) throw new Error("Supervisor credential is invalid");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== CREDENTIAL_BYTES || bytes.toString("base64url") !== token) {
    throw new Error("Supervisor credential is invalid");
  }
  return Object.freeze({ token, bytes: Uint8Array.from(bytes) });
}

export function authenticateLocalCredential(
  authorization: string | undefined,
  expected: LocalCredential,
): boolean {
  const prefix = "Bearer ";
  const token = authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : "";
  const candidate = BASE64URL_PATTERN.test(token)
    ? Buffer.from(token, "base64url")
    : Buffer.alloc(32);
  return candidate.length === expected.bytes.length && timingSafeEqual(candidate, expected.bytes);
}

export function requirePrivateUnixSocketPath(socketPath: string): string {
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath) {
    throw new Error("Supervisor socket path must be absolute and contain no traversal");
  }
  const parent = dirname(socketPath);
  if (basename(socketPath).length === 0 || resolve(parent, basename(socketPath)) !== socketPath) {
    throw new Error("Supervisor socket path must be a direct child of its runtime directory");
  }
  ensurePrivateRuntimeDirectory(parent);
  return socketPath;
}

export function acquireUnixSocketLock(socketPath: string): UnixSocketLock {
  const absolute = requirePrivateUnixSocketPath(socketPath);
  if (process.platform !== "linux") {
    throw new Error("Supervisor Unix socket locking requires Linux process identity");
  }
  const lockPath = `${absolute}.lock`;
  const record = formatLockRecord({
    pid: process.pid,
    startTime: readLinuxProcessStartTime(process.pid),
    version: LOCK_RECORD_VERSION,
  });

  for (;;) {
    let descriptor: number;
    try {
      descriptor = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (removeStaleUnixSocketLock(lockPath)) continue;
      continue;
    }

    const identity = fileIdentity(fstatSync(descriptor));
    try {
      fchmodSync(descriptor, PRIVATE_FILE_MODE);
      writeFileSync(descriptor, record, "utf8");
      fsyncSync(descriptor);
      fsyncDirectory(dirname(lockPath));
      const lock = Object.freeze({ socketPath: absolute, lockPath, descriptor, identity });
      activeUnixSocketLocks.add(lock);
      return lock;
    } catch (error) {
      closeSync(descriptor);
      unlinkIfSameIdentity(lockPath, identity);
      throw error;
    }
  }
}

export function releaseUnixSocketLock(lock: UnixSocketLock): void {
  if (!activeUnixSocketLocks.delete(lock)) return;
  let heldIdentity: FileIdentity | undefined;
  try {
    heldIdentity = fileIdentity(fstatSync(lock.descriptor));
  } finally {
    closeSync(lock.descriptor);
  }
  if (
    sameIdentity(heldIdentity, lock.identity) &&
    unlinkIfSameIdentity(lock.lockPath, heldIdentity)
  ) {
    fsyncDirectory(dirname(lock.lockPath));
  }
}

export async function prepareUnixSocketBindingPath(lock: UnixSocketLock): Promise<string> {
  if (!activeUnixSocketLocks.has(lock)) {
    throw new Error("Supervisor socket binding requires its active singleton lock");
  }
  const socketPath = requirePrivateUnixSocketPath(lock.socketPath);
  const bindingPath = `${socketPath}.bind`;
  if (dirname(bindingPath) !== dirname(socketPath)) {
    throw new Error("Supervisor private socket binding must remain in its runtime directory");
  }
  let initial: Stats;
  try {
    initial = lstatSync(bindingPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return bindingPath;
    throw error;
  }
  assertPrivateSocket(initial, "Supervisor private socket binding is not a private socket");
  if (await hasLiveUnixPeer(bindingPath)) {
    throw new Error("Supervisor private socket binding unexpectedly has a live peer");
  }
  let current: Stats;
  try {
    current = lstatSync(bindingPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return bindingPath;
    throw error;
  }
  assertPrivateSocket(current, "Supervisor private socket binding is not a private socket");
  if (!sameIdentity(fileIdentity(initial), fileIdentity(current))) {
    throw new Error("Supervisor private socket binding changed during stale cleanup");
  }
  unlinkSync(bindingPath);
  fsyncDirectory(dirname(bindingPath));
  return bindingPath;
}

export async function prepareUnixSocketPath(
  socketPath: string,
  lock?: UnixSocketLock,
): Promise<string> {
  const absolute = requirePrivateUnixSocketPath(socketPath);
  if (lock !== undefined && (!activeUnixSocketLocks.has(lock) || lock.socketPath !== absolute)) {
    throw new Error("Supervisor socket path preparation requires its active singleton lock");
  }
  assertNoSymlinkComponents(dirname(absolute));
  if (!existsSync(absolute)) return absolute;
  const metadata = lstatSync(absolute);
  if (
    !metadata.isSocket() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw new Error("Supervisor socket path is not a private socket owned by the current user");
  }
  if (await hasLiveUnixPeer(absolute)) throw new Error("Supervisor socket already has a live peer");
  unlinkSync(absolute);
  fsyncDirectory(dirname(absolute));
  return absolute;
}

export function secureUnixSocket(socketPath: string): UnixSocketIdentity {
  const before = lstatSync(socketPath);
  if (!before.isSocket() || before.isSymbolicLink() || before.uid !== currentUid()) {
    throw new Error("Supervisor socket could not be secured");
  }
  const identity = fileIdentity(before);
  try {
    chmodSync(socketPath, PRIVATE_FILE_MODE);
    const metadata = lstatSync(socketPath);
    if (
      !metadata.isSocket() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !sameIdentity(fileIdentity(metadata), identity)
    ) {
      throw new Error("Supervisor socket could not be secured");
    }
    return identity;
  } catch (error) {
    unlinkUnixSocketIfSame(socketPath, identity);
    throw error;
  }
}

export function unlinkUnixSocketIfSame(socketPath: string, identity: UnixSocketIdentity): void {
  if (unlinkIfSameIdentity(socketPath, identity)) fsyncDirectory(dirname(socketPath));
}

export function publishUnixSocket(
  bindingPath: string,
  socketPath: string,
  identity: UnixSocketIdentity,
): void {
  const binding = lstatSync(bindingPath);
  if (!binding.isSocket() || !sameIdentity(fileIdentity(binding), identity)) {
    throw new Error("Supervisor private socket binding changed before publication");
  }
  if (existsSync(socketPath)) {
    throw new Error("Supervisor socket path appeared before publication");
  }
  renameSync(bindingPath, socketPath);
  const published = lstatSync(socketPath);
  if (!published.isSocket() || !sameIdentity(fileIdentity(published), identity)) {
    throw new Error("Supervisor socket publication failed");
  }
  fsyncDirectory(dirname(socketPath));
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  if (!isAbsolute(absolute)) throw new Error("Supervisor local paths must be absolute");
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Supervisor local paths must not contain symbolic links");
    }
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeStaleUnixSocketLock(lockPath: string): boolean {
  let initial: Stats;
  try {
    initial = lstatSync(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  assertPrivateLock(initial);

  let descriptor: number;
  try {
    descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    assertPrivateLock(metadata);
    if (!sameIdentity(fileIdentity(initial), fileIdentity(metadata))) return false;
    const record = parseLockRecord(readFileSync(descriptor, "utf8"));
    if (linuxProcessMatches(record)) {
      throw new Error("Supervisor socket already has a live singleton lock");
    }
    return unlinkIfSameIdentity(lockPath, fileIdentity(metadata));
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateLock(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
    metadata.size > 256
  ) {
    throw new Error("Supervisor singleton lock must be a private file owned by the current user");
  }
}

function assertPrivateSocket(metadata: Stats, message: string): void {
  if (
    !metadata.isSocket() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw new Error(message);
  }
}

function formatLockRecord(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function parseLockRecord(value: string): LockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Supervisor singleton lock record is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Supervisor singleton lock record is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.startTime !== "string" ||
    !PROCESS_START_TIME_PATTERN.test(record.startTime) ||
    record.version !== LOCK_RECORD_VERSION
  ) {
    throw new Error("Supervisor singleton lock record is invalid");
  }
  const exact: LockRecord = {
    pid: record.pid as number,
    startTime: record.startTime,
    version: LOCK_RECORD_VERSION,
  };
  if (formatLockRecord(exact) !== value) {
    throw new Error("Supervisor singleton lock record is invalid");
  }
  return exact;
}

function linuxProcessMatches(record: LockRecord): boolean {
  try {
    return readLinuxProcessStartTime(record.pid) === record.startTime;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function readLinuxProcessStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  if (!stat.startsWith(`${pid} (`)) throw new Error("Linux process identity is invalid");
  const commandEnd = stat.lastIndexOf(") ");
  if (commandEnd === -1) throw new Error("Linux process identity is invalid");
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !PROCESS_START_TIME_PATTERN.test(startTime)) {
    throw new Error("Linux process identity is invalid");
  }
  return startTime;
}

function fileIdentity(metadata: Stats): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function unlinkIfSameIdentity(path: string, identity: FileIdentity): boolean {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  if (!sameIdentity(fileIdentity(metadata), identity)) return false;
  unlinkSync(path);
  return true;
}

function exactRandomBytes(random: SupervisorRandom, length: number): Uint8Array {
  const bytes = random.bytes(length);
  if (bytes.length !== length) throw new Error(`Random source must return exactly ${length} bytes`);
  return Uint8Array.from(bytes);
}

function hasLiveUnixPeer(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (isNodeError(error) && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
        resolvePromise(false);
      } else {
        reject(error);
      }
    });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("Supervisor local IPC requires a Unix host");
  return process.getuid();
}
