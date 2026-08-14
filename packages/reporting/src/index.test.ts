import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  REPORTING_SNAPSHOT_VERSION,
  type ReportingRecord,
  type ReportingSectionName,
  type ReportingSnapshot,
} from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import {
  assertSecretSafePositiveProjection,
  buildDeterministicReport,
  buildReportExport,
  decodeDeterministicReport,
  encodeDeterministicReport,
  encodeReportExportManifest,
  verifyReportExport,
} from "./index.js";

const DIGEST = "a".repeat(64);
const sha256 = {
  digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  },
};

const SECTION_NAMES: readonly ReportingSectionName[] = [
  "graph",
  "trajectory",
  "actors",
  "models",
  "assets",
  "context",
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
];

function record(overrides: Partial<ReportingRecord> = {}): ReportingRecord {
  return {
    kind: "command",
    identity: "command-1",
    state: "completed",
    references: [
      { role: "result", kind: "revision", identity: DIGEST },
      { role: "source", kind: "command", identity: "command-1" },
    ],
    scalars: [
      { name: "intent", value: "close-phase" },
      { name: "transport", value: "cli" },
    ],
    ...overrides,
  };
}

function snapshot(trajectoryRecords: readonly ReportingRecord[] = [record()]): ReportingSnapshot {
  return {
    version: REPORTING_SNAPSHOT_VERSION,
    repositoryId: "repository-1",
    runId: "run-1",
    schemaVersion: 9,
    configurationSnapshotDigest: DIGEST,
    sourceVector: {
      workflowCursor: 4,
      lifecycleRevision: 4,
      contextRevision: 3,
      runnerRevision: 2,
      workspaceRevision: 1,
      humanRevision: 1,
      portalRevision: 11,
      graphRevision: DIGEST,
      remoteLocalCursor: 4,
      remoteEnqueuedCursor: 3,
      remoteAcknowledgedCursor: 2,
    },
    sections: SECTION_NAMES.map((name) => ({
      name,
      status: "complete",
      records: name === "trajectory" ? trajectoryRecords : [],
    })),
  };
}

describe("deterministic reporting", () => {
  it("matches the decoded canonical JSON golden", () => {
    const golden = readFileSync(new URL("./fixtures/minimal-report.json", import.meta.url));
    expect(decodeDeterministicReport(golden)).toEqual(buildDeterministicReport(snapshot()));
    expect(Buffer.from(encodeDeterministicReport(buildDeterministicReport(snapshot())))).toEqual(
      golden,
    );
  });

  it("emits canonical stable bytes and a verified non-restorable directory manifest", () => {
    const first = buildReportExport(snapshot(), sha256);
    const second = buildReportExport(snapshot(), sha256);
    const manifestBytes = encodeReportExportManifest(first.manifest);
    const reportBytes = requiredExportFile(first.files, "report.json");

    expect([...first.files]).toEqual([...second.files]);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest.restorable).toBe(false);
    expect(first.manifest.files.map(({ path }) => path)).toEqual(
      [...first.manifest.files.map(({ path }) => path)].sort(),
    );
    expect(verifyReportExport(manifestBytes, first.files, sha256)).toEqual(first.manifest);
    expect(decodeDeterministicReport(reportBytes)).toEqual(buildDeterministicReport(snapshot()));
  });

  it("refuses accepted transitions without source and result evidence", () => {
    expect(() =>
      buildDeterministicReport(
        snapshot([
          record({ references: [{ role: "source", kind: "command", identity: "command-1" }] }),
        ]),
      ),
    ).toThrow("must cite source and result evidence");
  });

  it("uses positive scalar projection and rejects arbitrary nested payload fields", () => {
    const hostile = snapshot();
    const unsafeRecord = {
      ...record(),
      payload: {
        token: "raw-token-corpus",
        prompt: "raw-prompt-corpus",
        path: "/secret/repository",
      },
    };
    const unsafe = {
      ...hostile,
      sections: hostile.sections.map((section) =>
        section.name === "assets" ? { ...section, records: [unsafeRecord] } : section,
      ),
    } as unknown as ReportingSnapshot;

    expect(() => buildDeterministicReport(unsafe)).toThrow("unsupported fields");
    const bytes = encodeDeterministicReport(buildDeterministicReport(hostile));
    expect(new TextDecoder().decode(bytes)).not.toContain("raw-token-corpus");
  });

  it("uses one secret scan for report, diagnostic, example, and inventory projections", () => {
    for (const hostile of [
      '{"token":"raw"}',
      '{"name":"password","value":"raw"}',
      "Authorization: Bearer opaque",
      "https://user:password@example.test/path",
      "-----BEGIN PRIVATE KEY-----",
      "github_pat_12345678901234567890",
    ]) {
      expect(() => assertSecretSafePositiveProjection(hostile, "fixture projection")).toThrow(
        "secret-shaped",
      );
    }
    expect(() =>
      assertSecretSafePositiveProjection(
        '{"classification":"secret-safe-metadata","files":["report.json"]}',
        "package inventory",
      ),
    ).not.toThrow();
  });

  it("detects changed export bytes and source-vector drift", () => {
    const bundle = buildReportExport(snapshot(), sha256);
    const manifestBytes = encodeReportExportManifest(bundle.manifest);
    const changed = new Map(bundle.files);
    changed.set("actors.jsonl", new TextEncoder().encode("{}"));
    expect(() => verifyReportExport(manifestBytes, changed, sha256)).toThrow("does not match");

    const report = JSON.parse(
      new TextDecoder().decode(requiredExportFile(bundle.files, "report.json")),
    );
    report.sourceVector.portalRevision += 1;
    const changedReport = encodeDeterministicReport(report);
    const files = new Map(bundle.files);
    files.set("report.json", changedReport);
    expect(() => verifyReportExport(manifestBytes, files, sha256)).toThrow("does not match");
  });
});

function requiredExportFile(files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`Expected export file ${path}`);
  return bytes;
}
