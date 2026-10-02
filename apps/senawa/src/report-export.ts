import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Sha256 } from "@senawa/kernel";
import {
  buildReportExport,
  encodeReportExportManifest,
  REPORT_EXPORT_LIMITS,
  type ReportExportManifest,
  verifyReportExport,
} from "@senawa/reporting";
import type { ReportingSnapshotPort } from "@senawa/runtime";
import {
  SqliteReportingSnapshotAuthority,
  type SqliteReportingSnapshotAuthorityOptions,
} from "@senawa/storage-sqlite/reporting-snapshot";
import {
  type DurableDirectoryPublicationPort,
  nodeDirectoryPublicationPort,
  publishDirectoryAtomically,
} from "./durable-directory.js";

const MAX_MANIFEST_BYTES = 1_048_576;

export interface ExportReportingDirectoryInput {
  readonly snapshotPort: ReportingSnapshotPort;
  readonly repositoryId: string;
  readonly runId: string;
  readonly destinationDirectory: string;
  readonly sha256: Sha256;
  readonly publicationPort?: DurableDirectoryPublicationPort;
}

export interface ExportSqliteReportingDirectoryInput
  extends Omit<SqliteReportingSnapshotAuthorityOptions, "captureObserver"> {
  readonly repositoryId: string;
  readonly runId: string;
  readonly destinationDirectory: string;
}

export function exportSqliteReportingDirectory(
  input: ExportSqliteReportingDirectoryInput,
): ReportExportManifest {
  const snapshotPort = new SqliteReportingSnapshotAuthority({
    databasePath: input.databasePath,
    dependencies: input.dependencies,
  });
  try {
    return exportReportingDirectory({
      snapshotPort,
      repositoryId: input.repositoryId,
      runId: input.runId,
      destinationDirectory: input.destinationDirectory,
      sha256: input.dependencies.sha256,
    });
  } finally {
    snapshotPort.close();
  }
}

export function exportReportingDirectory(
  input: ExportReportingDirectoryInput,
): ReportExportManifest {
  const destination = resolve(input.destinationDirectory);
  assertFresh(destination);
  assertSafeDestinationParent(destination);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  assertSafeDestinationParent(destination);
  const partial = `${destination}.partial-${randomUUID()}`;
  const publicationPort = input.publicationPort ?? nodeDirectoryPublicationPort;
  mkdirSync(partial, { mode: 0o700 });
  try {
    const snapshot = input.snapshotPort.captureReportingSnapshot(input.repositoryId, input.runId);
    const bundle = buildReportExport(snapshot, input.sha256);
    for (const [path, bytes] of [...bundle.files].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      writeBoundedFile(join(partial, path), bytes, publicationPort);
    }
    writeBoundedFile(
      join(partial, "manifest.json"),
      encodeReportExportManifest(bundle.manifest),
      publicationPort,
    );
    verifyReportingDirectory(partial, input.sha256);
    publishDirectoryAtomically(partial, destination, publicationPort);
    return verifyReportingDirectory(destination, input.sha256);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

export function verifyReportingDirectory(directory: string, sha256: Sha256): ReportExportManifest {
  const root = resolve(directory);
  const rootStatus = lstatSync(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new TypeError("Report export must be a regular directory");
  }
  if (realpathSync(root) !== root) throw new TypeError("Report export path must be canonical");
  const names = readdirSync(root).sort();
  if (
    names.length === 0 ||
    names.length > REPORT_EXPORT_LIMITS.maxFiles + 1 ||
    names.at(-1) === undefined ||
    !names.includes("manifest.json")
  ) {
    throw new TypeError("Report export has an invalid file inventory");
  }
  const files = new Map<string, Uint8Array>();
  let manifestBytes: Uint8Array | undefined;
  let totalBytes = 0;
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*\.(?:json|jsonl)$/u.test(name)) {
      throw new TypeError("Report export contains an unsafe path");
    }
    const path = join(root, name);
    const status = lstatSync(path);
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      status.nlink !== 1 ||
      (status.mode & 0o7000) !== 0
    ) {
      throw new TypeError("Report export accepts only regular files");
    }
    const maximum =
      name === "manifest.json" ? MAX_MANIFEST_BYTES : REPORT_EXPORT_LIMITS.maxFileBytes;
    if (status.size > maximum)
      throw new TypeError(`Report export file ${name} exceeds its ceiling`);
    const bytes = readFileSync(path);
    totalBytes += bytes.byteLength;
    if (totalBytes > REPORT_EXPORT_LIMITS.maxTotalBytes + MAX_MANIFEST_BYTES) {
      throw new TypeError("Report export exceeds its total byte ceiling");
    }
    if (name === "manifest.json") manifestBytes = bytes;
    else files.set(name, bytes);
  }
  if (manifestBytes === undefined) throw new TypeError("Report export manifest is missing");
  return verifyReportExport(manifestBytes, files, sha256);
}

function writeBoundedFile(
  path: string,
  bytes: Uint8Array,
  publicationPort: DurableDirectoryPublicationPort,
): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  publicationPort.syncFile(path);
}

function assertFresh(path: string): void {
  if (existsSync(path)) throw new TypeError("Report export destination must be fresh");
  try {
    lstatSync(path);
    throw new TypeError("Report export destination must be fresh");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function assertSafeDestinationParent(path: string): void {
  let current = dirname(path);
  for (;;) {
    if (existsSync(current)) {
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(current) !== current) {
        throw new TypeError("Report export destination parent must be a real directory");
      }
      return;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new TypeError("Report export destination parent must be a real directory");
    }
    current = parent;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
