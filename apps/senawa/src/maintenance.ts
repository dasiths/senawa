import { createHash, randomUUID } from "node:crypto";
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
import { canonicalBytes, canonicalStringify } from "@senawa/protocol";
import { assertSecretSafePositiveProjection } from "@senawa/reporting";
import type { SqliteIntegrityReport } from "@senawa/storage-sqlite";
import type { SupervisorServiceStatus } from "@senawa/supervisor";
import {
  type DurableDirectoryPublicationPort,
  nodeDirectoryPublicationPort,
  publishDirectoryAtomically,
} from "./durable-directory.js";

const MAX_DIAGNOSTIC_FILE_BYTES = 1_048_576;
const DIAGNOSTIC_FILE_NAMES = Object.freeze(["integrity.json", "status.json", "system.json"]);

interface DiagnosticManifest {
  readonly format: "senawa-diagnostics";
  readonly version: 1;
  readonly classification: "secret-safe-metadata";
  readonly exclusions: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly digest: string;
  }[];
}

export function createDiagnosticsDirectory(input: {
  readonly destinationDirectory: string;
  readonly productVersion: string;
  readonly integrity: SqliteIntegrityReport;
  readonly serviceStatus?: SupervisorServiceStatus;
  readonly publicationPort?: DurableDirectoryPublicationPort;
}): DiagnosticManifest {
  const destination = resolve(input.destinationDirectory);
  assertFreshDirectoryDestination(destination);
  const partial = `${destination}.partial-${randomUUID()}`;
  const publicationPort = input.publicationPort ?? nodeDirectoryPublicationPort;
  mkdirSync(partial, { mode: 0o700 });
  try {
    writeDiagnosticFile(
      join(partial, "system.json"),
      canonicalStringify({
        product: "senawa",
        version: input.productVersion,
        runtime: {
          node: process.versions.node,
          platform: process.platform,
          architecture: process.arch,
        },
      }),
      publicationPort,
    );
    writeDiagnosticFile(
      join(partial, "integrity.json"),
      canonicalStringify(input.integrity),
      publicationPort,
    );
    writeDiagnosticFile(
      join(partial, "status.json"),
      canonicalStringify(sanitizeServiceStatus(input.serviceStatus)),
      publicationPort,
    );
    const manifest: DiagnosticManifest = Object.freeze({
      format: "senawa-diagnostics",
      version: 1,
      classification: "secret-safe-metadata",
      exclusions: Object.freeze([
        "credentials",
        "environment",
        "local-paths",
        "logs",
        "payloads",
        "prompts-and-answers",
        "sdk-session-content",
      ]),
      files: Object.freeze(diagnosticFileRecords(partial)),
    });
    writeDiagnosticFile(
      join(partial, "manifest.json"),
      canonicalStringify(manifest),
      publicationPort,
    );
    verifyDiagnosticsDirectory(partial);
    publishDirectoryAtomically(partial, destination, publicationPort);
    return verifyDiagnosticsDirectory(destination);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

export function verifyDiagnosticsDirectory(directory: string): DiagnosticManifest {
  const root = resolve(directory);
  const rootStatus = lstatSync(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("Diagnostics bundle must be a real directory");
  }
  if (realpathSync(root) !== root) throw new Error("Diagnostics bundle path must be canonical");
  const names = readdirSync(root).sort();
  if (names.join(",") !== [...DIAGNOSTIC_FILE_NAMES, "manifest.json"].sort().join(",")) {
    throw new Error("Diagnostics bundle inventory is invalid");
  }
  const manifest = parseDiagnosticManifest(readBoundedRegularFile(join(root, "manifest.json")));
  if (canonicalStringify(diagnosticFileRecords(root)) !== canonicalStringify(manifest.files)) {
    throw new Error("Diagnostics bundle manifest does not match its files");
  }
  return manifest;
}

export function createRepairPlan(
  integrity: SqliteIntegrityReport,
  sha256: { digest(bytes: Uint8Array): string },
) {
  const plan = Object.freeze({
    format: "senawa-repair-plan" as const,
    version: 1 as const,
    mode: "refusal-first" as const,
    integrityStatus: integrity.status,
    allowedActions: Object.freeze(["verified-fresh-restore"]),
    refusedActions: Object.freeze([
      "digest-recalculation",
      "evidence-deletion",
      "history-truncation",
      "in-place-restore",
      "synthetic-outcomes",
      "usage-or-accounting-rewrite",
    ]),
  });
  return Object.freeze({
    ...plan,
    planDigest: sha256.digest(canonicalBytes(plan)),
  });
}

function sanitizeServiceStatus(status: SupervisorServiceStatus | undefined) {
  if (status === undefined) return Object.freeze({ availability: "unavailable" as const });
  return Object.freeze({
    availability: "available" as const,
    lifecycle: status.lifecycle,
    mode: status.mode,
    health: status.health,
    pending: status.pending,
    leaseCount: status.leases.length,
    sdkSessionStore: {
      status: status.sdkSessionStore.status,
      expectedSessionCount: status.sdkSessionStore.expectedSessionCount,
      missingSessionCount: status.sdkSessionStore.missingSessionIds.length,
    },
    remoteConnectors: status.remoteConnectors.map((connector) => ({
      lifecycle: connector.lifecycle,
      health: connector.health,
      partitioned: connector.partitioned,
      lastErrorCode: connector.lastErrorCode,
      synchronization: connector.synchronization,
    })),
  });
}

function diagnosticFileRecords(root: string) {
  return DIAGNOSTIC_FILE_NAMES.map((name) => {
    const content = readBoundedRegularFile(join(root, name));
    return Object.freeze({
      path: name,
      byteLength: Buffer.byteLength(content),
      digest: createHash("sha256").update(content).digest("hex"),
    });
  });
}

function parseDiagnosticManifest(content: string): DiagnosticManifest {
  const value = JSON.parse(content) as DiagnosticManifest;
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "classification,exclusions,files,format,version" ||
    value.format !== "senawa-diagnostics" ||
    value.version !== 1 ||
    value.classification !== "secret-safe-metadata" ||
    !Array.isArray(value.exclusions) ||
    !Array.isArray(value.files) ||
    value.files.length !== DIAGNOSTIC_FILE_NAMES.length ||
    value.files.some(
      (file, index) =>
        file === null ||
        typeof file !== "object" ||
        Object.keys(file).sort().join(",") !== "byteLength,digest,path" ||
        file.path !== DIAGNOSTIC_FILE_NAMES[index] ||
        !Number.isSafeInteger(file.byteLength) ||
        file.byteLength < 0 ||
        !/^[0-9a-f]{64}$/u.test(file.digest),
    )
  ) {
    throw new Error("Diagnostics bundle manifest is invalid");
  }
  return value;
}

function writeDiagnosticFile(
  path: string,
  content: string,
  publicationPort: DurableDirectoryPublicationPort,
): void {
  if (Buffer.byteLength(content) > MAX_DIAGNOSTIC_FILE_BYTES) {
    throw new Error("Diagnostics file exceeds its byte limit");
  }
  assertSecretSafePositiveProjection(content, "Diagnostics file");
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
  publicationPort.syncFile(path);
}

function readBoundedRegularFile(path: string): string {
  const status = lstatSync(path);
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.nlink !== 1 ||
    status.size > MAX_DIAGNOSTIC_FILE_BYTES
  ) {
    throw new Error("Diagnostics bundle accepts only bounded regular files");
  }
  const content = readFileSync(path, "utf8");
  assertSecretSafePositiveProjection(content, "Diagnostics file");
  return content;
}

function assertFreshDirectoryDestination(path: string): void {
  if (existsSync(path)) throw new Error("Diagnostics destination must be fresh");
  const parentPath = dirname(path);
  const parent = lstatSync(parentPath);
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    realpathSync(parentPath) !== resolve(parentPath)
  ) {
    throw new Error("Diagnostics destination parent must be a real directory");
  }
}
