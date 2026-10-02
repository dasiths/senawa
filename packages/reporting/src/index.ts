import {
  canonicalBytes,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
} from "@senawa/kernel";
import type {
  ReportingNamedScalar,
  ReportingRecord,
  ReportingReference,
  ReportingSectionName,
  ReportingSnapshot,
  ReportingSnapshotSection,
  ReportingSourceVector,
} from "@senawa/runtime";
import { REPORTING_LIMITS, REPORTING_SNAPSHOT_VERSION } from "@senawa/runtime";

export const DETERMINISTIC_REPORT_VERSION = "senawa.dev/deterministic-report/v1" as const;
export const REPORT_EXPORT_VERSION = "senawa.dev/report-export/v1" as const;

export const REPORT_EXPORT_LIMITS = Object.freeze({
  maxFiles: 20,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxLineBytes: 16 * 1024,
});

const SECTION_ORDER: readonly ReportingSectionName[] = Object.freeze([
  "graph",
  "trajectory",
  "actors",
  "models",
  "assets",
  "context",
  "dataflow",
  "amendments",
  "escalations",
  "gates",
  "approvals",
  "costs",
  "uncertainty",
  "workspaces",
  "integration",
  "portal",
  "remote",
]);

const SECTION_SET = new Set<string>(SECTION_ORDER);
const EXPORT_PATHS = Object.freeze(
  ["report.json", ...SECTION_ORDER.map((name) => `${name}.jsonl`)].sort(compareText),
);
const TRANSITION_STATES = new Set([
  "accepted",
  "acknowledged",
  "barrier-recorded",
  "claimed",
  "closed",
  "completed",
  "local-accepted",
  "local-result",
  "passed",
  "published",
  "recorded",
  "resolved",
]);

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+/iu,
  /https?:\/\/[^\s/@"']+:[^\s/@"']+@/iu,
  /\b(?:ghp|github_pat|sk|xox[baprs])_[A-Za-z0-9_-]{12,}/u,
  /"(?:accessToken|apiKey|authorization|credential|password|privateKey|secret|token)"\s*:/iu,
  /"name"\s*:\s*"(?:accessToken|apiKey|authorization|credential|password|privateKey|secret|token)"/iu,
]);

export function assertSecretSafePositiveProjection(
  value: string | Uint8Array,
  label: string,
): void {
  let text: string;
  try {
    text = typeof value === "string" ? value : TEXT_DECODER.decode(value);
  } catch {
    throw new TypeError(`${label} must be valid UTF-8 before secret scanning`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new TypeError(`${label} contains secret-shaped content`);
  }
}

export interface DeterministicReport {
  readonly version: typeof DETERMINISTIC_REPORT_VERSION;
  readonly identity: {
    readonly repositoryId: string;
    readonly runId: string;
    readonly schemaVersion: number;
    readonly configurationSnapshotDigest?: string;
  };
  readonly sourceVector: ReportingSourceVector;
  readonly sections: readonly ReportingSnapshotSection[];
}

export type ExportClassification = "secret-safe-metadata";

export interface ReportExportFile {
  readonly path: string;
  readonly mediaType: "application/json" | "application/x-ndjson";
  readonly schemaVersion: string;
  readonly classification: ExportClassification;
  readonly byteLength: number;
  readonly digest: string;
  readonly recordCount: number;
}

export interface ReportExportManifest {
  readonly version: typeof REPORT_EXPORT_VERSION;
  readonly restorable: false;
  readonly repositoryId: string;
  readonly runId: string;
  readonly reportDigest: string;
  readonly sourceVector: ReportingSourceVector;
  readonly files: readonly ReportExportFile[];
}

export interface ReportExportBundle {
  readonly manifest: ReportExportManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export function buildDeterministicReport(snapshot: ReportingSnapshot): DeterministicReport {
  validateSnapshot(snapshot);
  const sections = SECTION_ORDER.map((name) => {
    const section = snapshot.sections.find((candidate) => candidate.name === name);
    if (section === undefined) throw new TypeError(`Reporting section ${name} is missing`);
    return Object.freeze({
      ...section,
      records: Object.freeze([...section.records].sort(compareRecord)),
    });
  });
  assertExplainedTransitions(sections);
  return Object.freeze({
    version: DETERMINISTIC_REPORT_VERSION,
    identity: Object.freeze({
      repositoryId: snapshot.repositoryId,
      runId: snapshot.runId,
      schemaVersion: snapshot.schemaVersion,
      ...(snapshot.configurationSnapshotDigest === undefined
        ? {}
        : { configurationSnapshotDigest: snapshot.configurationSnapshotDigest }),
    }),
    sourceVector: Object.freeze({ ...snapshot.sourceVector }),
    sections: Object.freeze(sections),
  });
}

export function encodeDeterministicReport(report: DeterministicReport): Uint8Array {
  validateReport(report);
  return canonicalBytes(canonicalValue(report));
}

export function decodeDeterministicReport(bytes: Uint8Array): DeterministicReport {
  const value = parseCanonical(bytes, "report");
  validateReport(value);
  return value;
}

export function buildReportExport(snapshot: ReportingSnapshot, sha256: Sha256): ReportExportBundle {
  const report = buildDeterministicReport(snapshot);
  const reportBytes = encodeDeterministicReport(report);
  const files = new Map<string, Uint8Array>();
  files.set("report.json", reportBytes);
  for (const section of report.sections) {
    files.set(`${section.name}.jsonl`, encodeJsonLines(section.records));
  }
  validateBundleBytes(files);
  const entries = [...files]
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, bytes]) => {
      const sectionName = path.replace(/\.jsonl$/u, "");
      const section = report.sections.find(({ name }) => name === sectionName);
      return Object.freeze({
        path,
        mediaType: path.endsWith(".jsonl")
          ? ("application/x-ndjson" as const)
          : ("application/json" as const),
        schemaVersion: path === "report.json" ? report.version : REPORTING_SNAPSHOT_VERSION,
        classification: "secret-safe-metadata" as const,
        byteLength: bytes.byteLength,
        digest: checkedDigest(sha256, bytes),
        recordCount: section?.records.length ?? 1,
      });
    });
  const manifest = Object.freeze({
    version: REPORT_EXPORT_VERSION,
    restorable: false as const,
    repositoryId: report.identity.repositoryId,
    runId: report.identity.runId,
    reportDigest: checkedDigest(sha256, reportBytes),
    sourceVector: report.sourceVector,
    files: Object.freeze(entries),
  });
  return Object.freeze({ manifest, files });
}

export function encodeReportExportManifest(manifest: ReportExportManifest): Uint8Array {
  validateManifest(manifest);
  return canonicalBytes(canonicalValue(manifest));
}

export function verifyReportExport(
  manifestBytes: Uint8Array,
  suppliedFiles: ReadonlyMap<string, Uint8Array>,
  sha256: Sha256,
): ReportExportManifest {
  const manifest = parseCanonical(manifestBytes, "export manifest");
  validateManifest(manifest);
  if (suppliedFiles.size !== manifest.files.length) {
    throw new TypeError("Export file inventory does not match the manifest");
  }
  validateBundleBytes(suppliedFiles);
  const reportBytes = suppliedFiles.get("report.json");
  if (reportBytes === undefined) throw new TypeError("Export report.json is missing");
  const report = decodeDeterministicReport(reportBytes);
  if (
    report.identity.repositoryId !== manifest.repositoryId ||
    report.identity.runId !== manifest.runId ||
    canonicalSerialize(canonicalValue(report.sourceVector)) !==
      canonicalSerialize(canonicalValue(manifest.sourceVector)) ||
    checkedDigest(sha256, reportBytes) !== manifest.reportDigest
  ) {
    throw new TypeError("Export report identity or source vector does not match the manifest");
  }
  for (const entry of manifest.files) {
    const bytes = suppliedFiles.get(entry.path);
    if (bytes === undefined) throw new TypeError(`Export file ${entry.path} is missing`);
    if (bytes.byteLength !== entry.byteLength || checkedDigest(sha256, bytes) !== entry.digest) {
      throw new TypeError(`Export file ${entry.path} does not match the manifest`);
    }
    if (entry.path === "report.json") {
      if (entry.digest !== manifest.reportDigest) {
        throw new TypeError("Export report digest does not match the manifest");
      }
    } else {
      const records = decodeJsonLines(bytes);
      if (records.length !== entry.recordCount) {
        throw new TypeError(`Export file ${entry.path} record count does not match the manifest`);
      }
      const ordered = [...records].sort(compareRecord);
      if (records.some((record, index) => record !== ordered[index])) {
        throw new TypeError(`Export file ${entry.path} is not deterministically ordered`);
      }
      const sectionName = entry.path.replace(/\.jsonl$/u, "") as ReportingSectionName;
      const reportSection = report.sections.find(({ name }) => name === sectionName);
      if (
        reportSection === undefined ||
        canonicalSerialize(canonicalValue(records)) !==
          canonicalSerialize(canonicalValue(reportSection.records))
      ) {
        throw new TypeError(`Export file ${entry.path} does not match report.json`);
      }
    }
  }
  return manifest;
}

function validateSnapshot(snapshot: ReportingSnapshot): void {
  if (snapshot.version !== REPORTING_SNAPSHOT_VERSION) {
    throw new TypeError(`Reporting snapshot must use ${REPORTING_SNAPSHOT_VERSION}`);
  }
  requireText(snapshot.repositoryId, "repositoryId");
  requireText(snapshot.runId, "runId");
  requireNonNegativeInteger(snapshot.schemaVersion, "schemaVersion");
  if (
    snapshot.configurationSnapshotDigest !== undefined &&
    !isSha256Digest(snapshot.configurationSnapshotDigest)
  ) {
    throw new TypeError("configurationSnapshotDigest must be a SHA-256 digest");
  }
  validateSourceVector(snapshot.sourceVector);
  if (snapshot.sections.length !== SECTION_ORDER.length) {
    throw new TypeError("Reporting snapshot must contain every section exactly once");
  }
  const names = new Set<string>();
  let totalRecords = 0;
  for (const section of snapshot.sections) {
    if (!SECTION_SET.has(section.name) || names.has(section.name)) {
      throw new TypeError("Reporting snapshot section names must be unique and recognized");
    }
    names.add(section.name);
    validateSection(section);
    totalRecords += section.records.length;
  }
  if (totalRecords > REPORTING_LIMITS.maxTotalRecords) {
    throw new TypeError("Reporting snapshot exceeds the total record ceiling");
  }
}

function validateReport(value: unknown): asserts value is DeterministicReport {
  const report = requireObject(value, "report");
  requireExactKeys(report, ["identity", "sections", "sourceVector", "version"], "report");
  if (report.version !== DETERMINISTIC_REPORT_VERSION) {
    throw new TypeError(`Report must use ${DETERMINISTIC_REPORT_VERSION}`);
  }
  const identity = requireObject(report.identity, "report identity");
  const identityKeys = ["repositoryId", "runId", "schemaVersion"];
  if (identity.configurationSnapshotDigest !== undefined) {
    identityKeys.push("configurationSnapshotDigest");
    if (!isSha256Digest(identity.configurationSnapshotDigest)) {
      throw new TypeError("Report configurationSnapshotDigest must be a SHA-256 digest");
    }
  }
  requireExactKeys(identity, identityKeys, "report identity");
  requireText(identity.repositoryId, "report repositoryId");
  requireText(identity.runId, "report runId");
  requireNonNegativeInteger(identity.schemaVersion, "report schemaVersion");
  validateSourceVector(report.sourceVector as ReportingSourceVector);
  if (!Array.isArray(report.sections) || report.sections.length !== SECTION_ORDER.length) {
    throw new TypeError("Report must contain every section");
  }
  report.sections.forEach((section, index) => {
    validateSection(section as ReportingSnapshotSection);
    if ((section as ReportingSnapshotSection).name !== SECTION_ORDER[index]) {
      throw new TypeError("Report sections are not in canonical order");
    }
  });
  assertExplainedTransitions(report.sections as readonly ReportingSnapshotSection[]);
}

function validateSection(section: ReportingSnapshotSection): void {
  const expectedKeys = ["name", "records", "status"];
  if (section.reasonCode !== undefined) expectedKeys.push("reasonCode");
  requireExactKeys(section as unknown as Record<string, unknown>, expectedKeys, "report section");
  if (!SECTION_SET.has(section.name)) throw new TypeError("Report section name is invalid");
  if (!(["complete", "absent", "unavailable"] as const).includes(section.status)) {
    throw new TypeError(`Report section ${section.name} has an invalid status`);
  }
  if (section.status === "complete" && section.reasonCode !== undefined) {
    throw new TypeError(`Complete report section ${section.name} cannot have a reason code`);
  }
  if (section.status !== "complete") requireText(section.reasonCode, `${section.name} reasonCode`);
  if (!Array.isArray(section.records))
    throw new TypeError(`${section.name} records must be an array`);
  if (section.records.length > REPORTING_LIMITS.maxRecordsPerSection) {
    throw new TypeError(`Report section ${section.name} exceeds its record ceiling`);
  }
  if (section.status !== "complete" && section.records.length !== 0) {
    throw new TypeError(`Non-complete report section ${section.name} cannot contain records`);
  }
  section.records.forEach(validateRecord);
}

function validateRecord(record: ReportingRecord): void {
  const expectedKeys = ["identity", "kind", "references", "scalars"];
  if (record.sequence !== undefined) expectedKeys.push("sequence");
  if (record.state !== undefined) expectedKeys.push("state");
  if (record.occurredAt !== undefined) expectedKeys.push("occurredAt");
  if (record.digest !== undefined) expectedKeys.push("digest");
  requireExactKeys(record as unknown as Record<string, unknown>, expectedKeys, "report record");
  requireText(record.kind, "record kind");
  requireText(record.identity, "record identity");
  if (record.sequence !== undefined) requireNonNegativeInteger(record.sequence, "record sequence");
  if (record.state !== undefined) requireText(record.state, "record state");
  if (record.occurredAt !== undefined) requireText(record.occurredAt, "record occurredAt");
  if (record.digest !== undefined && !isSha256Digest(record.digest)) {
    throw new TypeError("Record digest must be a SHA-256 digest");
  }
  if (
    !Array.isArray(record.references) ||
    record.references.length > REPORTING_LIMITS.maxReferencesPerRecord
  ) {
    throw new TypeError("Record references exceed their ceiling");
  }
  if (
    !Array.isArray(record.scalars) ||
    record.scalars.length > REPORTING_LIMITS.maxScalarsPerRecord
  ) {
    throw new TypeError("Record scalars exceed their ceiling");
  }
  record.references.forEach(validateReference);
  record.scalars.forEach(validateScalar);
  assertUniqueSorted(record.references, compareReference, "record references");
  assertUniqueSorted(record.scalars, compareScalar, "record scalars");
}

function validateReference(reference: ReportingReference): void {
  requireExactKeys(
    reference as unknown as Record<string, unknown>,
    ["identity", "kind", "role"],
    "record reference",
  );
  if (!(["source", "result", "related"] as const).includes(reference.role)) {
    throw new TypeError("Record reference role is invalid");
  }
  requireText(reference.kind, "reference kind");
  requireText(reference.identity, "reference identity");
}

function validateScalar(scalar: ReportingNamedScalar): void {
  requireExactKeys(
    scalar as unknown as Record<string, unknown>,
    ["name", "value"],
    "record scalar",
  );
  requireText(scalar.name, "scalar name");
  if (!["string", "number", "boolean"].includes(typeof scalar.value)) {
    throw new TypeError("Record scalar values must be string, number, or boolean");
  }
  if (typeof scalar.value === "number" && !Number.isSafeInteger(scalar.value)) {
    throw new TypeError("Numeric record scalars must be safe integers");
  }
  if (typeof scalar.value === "string") requireText(scalar.value, `scalar ${scalar.name}`);
}

function assertExplainedTransitions(sections: readonly ReportingSnapshotSection[]): void {
  const trajectory = sections.find(({ name }) => name === "trajectory");
  if (trajectory?.status !== "complete") return;
  for (const record of trajectory.records) {
    if (
      record.state !== undefined &&
      TRANSITION_STATES.has(record.state) &&
      (!record.references.some(({ role }) => role === "source") ||
        !record.references.some(({ role }) => role === "result"))
    ) {
      throw new TypeError(
        `Accepted transition ${record.identity} must cite source and result evidence`,
      );
    }
  }
}

function validateSourceVector(vector: ReportingSourceVector): void {
  const required = [
    "workflowCursor",
    "lifecycleRevision",
    "contextRevision",
    "dataflowRevision",
    "runnerRevision",
    "workspaceRevision",
    "humanRevision",
    "portalRevision",
  ] as const;
  const optional = [
    "graphRevision",
    "remoteLocalCursor",
    "remoteEnqueuedCursor",
    "remoteAcknowledgedCursor",
  ] as const;
  const expected: string[] = [...required];
  for (const name of optional) if (vector[name] !== undefined) expected.push(name);
  requireExactKeys(vector as unknown as Record<string, unknown>, expected, "source vector");
  required.forEach((name) => {
    requireNonNegativeInteger(vector[name], `source vector ${name}`);
  });
  if (vector.graphRevision !== undefined && !isSha256Digest(vector.graphRevision)) {
    throw new TypeError("Source vector graphRevision must be a SHA-256 digest");
  }
  for (const name of optional.slice(1)) {
    const value = vector[name];
    if (value !== undefined) requireNonNegativeInteger(value, `source vector ${name}`);
  }
  if (
    vector.remoteLocalCursor !== undefined &&
    (vector.remoteEnqueuedCursor ?? 0) > vector.remoteLocalCursor
  ) {
    throw new TypeError("Remote enqueued cursor cannot exceed the local cursor");
  }
  if (
    vector.remoteEnqueuedCursor !== undefined &&
    (vector.remoteAcknowledgedCursor ?? 0) > vector.remoteEnqueuedCursor
  ) {
    throw new TypeError("Remote acknowledged cursor cannot exceed the enqueued cursor");
  }
}

function validateManifest(value: unknown): asserts value is ReportExportManifest {
  const manifest = requireObject(value, "export manifest");
  requireExactKeys(
    manifest,
    ["files", "reportDigest", "repositoryId", "restorable", "runId", "sourceVector", "version"],
    "export manifest",
  );
  if (manifest.version !== REPORT_EXPORT_VERSION || manifest.restorable !== false) {
    throw new TypeError("Export manifest version or non-restorable marker is invalid");
  }
  requireText(manifest.repositoryId, "manifest repositoryId");
  requireText(manifest.runId, "manifest runId");
  if (!isSha256Digest(manifest.reportDigest))
    throw new TypeError("Manifest reportDigest is invalid");
  validateSourceVector(manifest.sourceVector as ReportingSourceVector);
  if (!Array.isArray(manifest.files) || manifest.files.length > REPORT_EXPORT_LIMITS.maxFiles) {
    throw new TypeError("Manifest file inventory exceeds its ceiling");
  }
  if (
    manifest.files.length !== EXPORT_PATHS.length ||
    manifest.files.some(
      (entry, index) => !isRecordWithPath(entry) || entry.path !== EXPORT_PATHS[index],
    )
  ) {
    throw new TypeError("Manifest must contain the exact report export file set");
  }
  let previous = "";
  let totalBytes = 0;
  for (const rawEntry of manifest.files) {
    const entry = requireObject(rawEntry, "manifest file");
    requireExactKeys(
      entry,
      [
        "byteLength",
        "classification",
        "digest",
        "mediaType",
        "path",
        "recordCount",
        "schemaVersion",
      ],
      "manifest file",
    );
    if (!isSafePath(entry.path) || entry.path <= previous) {
      throw new TypeError("Manifest paths must be safe, unique, and lexically ordered");
    }
    previous = entry.path;
    if (!isSha256Digest(entry.digest)) throw new TypeError("Manifest file digest is invalid");
    if (entry.classification !== "secret-safe-metadata")
      throw new TypeError("Manifest classification is invalid");
    if (entry.mediaType !== "application/json" && entry.mediaType !== "application/x-ndjson") {
      throw new TypeError("Manifest media type is invalid");
    }
    requireText(entry.schemaVersion, "manifest schemaVersion");
    requireNonNegativeInteger(entry.byteLength, "manifest byteLength");
    requireNonNegativeInteger(entry.recordCount, "manifest recordCount");
    if (entry.byteLength > REPORT_EXPORT_LIMITS.maxFileBytes)
      throw new TypeError("Manifest file exceeds its byte ceiling");
    totalBytes += entry.byteLength;
  }
  if (totalBytes > REPORT_EXPORT_LIMITS.maxTotalBytes)
    throw new TypeError("Manifest exceeds the total byte ceiling");
}

function encodeJsonLines(records: readonly ReportingRecord[]): Uint8Array {
  const text = records.map((record) => canonicalSerialize(canonicalValue(record))).join("\n");
  const bytes = TEXT_ENCODER.encode(text);
  for (const line of text.split("\n")) {
    if (TEXT_ENCODER.encode(line).byteLength > REPORT_EXPORT_LIMITS.maxLineBytes) {
      throw new TypeError("Export JSONL record exceeds the line byte ceiling");
    }
  }
  return bytes;
}

function decodeJsonLines(bytes: Uint8Array): ReportingRecord[] {
  const text = TEXT_DECODER.decode(bytes);
  if (text.endsWith("\n"))
    throw new TypeError("Export JSONL files cannot have a trailing blank record");
  if (text === "") return [];
  return text.split("\n").map((line) => {
    if (TEXT_ENCODER.encode(line).byteLength > REPORT_EXPORT_LIMITS.maxLineBytes) {
      throw new TypeError("Export JSONL record exceeds the line byte ceiling");
    }
    const value = parseCanonical(TEXT_ENCODER.encode(line), "JSONL record");
    validateRecord(value as ReportingRecord);
    return value as ReportingRecord;
  });
}

function parseCanonical(bytes: Uint8Array, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    throw new TypeError(`${label} must contain valid UTF-8 canonical JSON`);
  }
  if (canonicalSerialize(canonicalValue(value)) !== TEXT_DECODER.decode(bytes)) {
    throw new TypeError(`${label} must use canonical JSON encoding`);
  }
  return value;
}

function validateBundleBytes(files: ReadonlyMap<string, Uint8Array>): void {
  if (files.size > REPORT_EXPORT_LIMITS.maxFiles) throw new TypeError("Export has too many files");
  let totalBytes = 0;
  for (const [path, bytes] of files) {
    if (!isSafePath(path)) throw new TypeError(`Export path ${path} is unsafe`);
    if (bytes.byteLength > REPORT_EXPORT_LIMITS.maxFileBytes)
      throw new TypeError(`Export file ${path} exceeds its byte ceiling`);
    assertSecretSafePositiveProjection(bytes, `Export file ${path}`);
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > REPORT_EXPORT_LIMITS.maxTotalBytes)
    throw new TypeError("Export exceeds its total byte ceiling");
}

function compareRecord(left: ReportingRecord, right: ReportingRecord): number {
  return (
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    compareText(left.kind, right.kind) ||
    compareText(left.identity, right.identity)
  );
}

function compareReference(left: ReportingReference, right: ReportingReference): number {
  return (
    compareText(left.role, right.role) ||
    compareText(left.kind, right.kind) ||
    compareText(left.identity, right.identity)
  );
}

function compareScalar(left: ReportingNamedScalar, right: ReportingNamedScalar): number {
  return compareText(left.name, right.name) || compareText(String(left.value), String(right.value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUniqueSorted<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1] as T, values[index] as T) >= 0) {
      throw new TypeError(`${label} must be unique and deterministically ordered`);
    }
  }
}

function checkedDigest(sha256: Sha256, bytes: Uint8Array): string {
  const digest = sha256.digest(bytes);
  if (!isSha256Digest(digest))
    throw new TypeError("SHA-256 implementations must return lowercase hexadecimal digests");
  return digest;
}

function isSafePath(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]*\.(?:json|jsonl)$/u.test(value);
}

function isRecordWithPath(value: unknown): value is { readonly path: string } {
  return value !== null && typeof value === "object" && "path" in value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    TEXT_ENCODER.encode(value).byteLength > REPORTING_LIMITS.maxTextBytes
  ) {
    throw new TypeError(`${label} must be bounded non-empty text`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}
