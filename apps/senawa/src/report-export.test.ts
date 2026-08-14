import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  REPORTING_SNAPSHOT_VERSION,
  type ReportingSectionName,
  type ReportingSnapshot,
} from "@senawa/runtime";
import { SqliteAuthority } from "@senawa/storage-sqlite";
import {
  createAdmissionFixture,
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
} from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DurableDirectoryPublicationPort,
  nodeDirectoryPublicationPort,
  PublishedDirectoryDurabilityError,
} from "./durable-directory.js";
import { runOperationalCli } from "./operational-cli.js";
import {
  exportReportingDirectory,
  exportSqliteReportingDirectory,
  verifyReportingDirectory,
} from "./report-export.js";

const roots = new Set<string>();
const DIGEST = "a".repeat(64);
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
const sha256 = {
  digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  },
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("deterministic report directory export", () => {
  it("publishes a verified fresh directory with deterministic bytes and a non-restorable manifest", () => {
    const root = sandbox();
    const first = join(root, "first");
    const second = join(root, "second");
    const port = { captureReportingSnapshot: () => snapshot() };

    const firstManifest = exportReportingDirectory({
      snapshotPort: port,
      repositoryId: "repository-1",
      runId: "run-1",
      destinationDirectory: first,
      sha256,
    });
    const secondManifest = exportReportingDirectory({
      snapshotPort: port,
      repositoryId: "repository-1",
      runId: "run-1",
      destinationDirectory: second,
      sha256,
    });

    expect(firstManifest).toEqual(secondManifest);
    expect(firstManifest.restorable).toBe(false);
    expect(verifyReportingDirectory(first, sha256)).toEqual(firstManifest);
    expect(directoryBytes(first)).toEqual(directoryBytes(second));
    expect(() =>
      exportReportingDirectory({
        snapshotPort: port,
        repositoryId: "repository-1",
        runId: "run-1",
        destinationDirectory: first,
        sha256,
      }),
    ).toThrow("fresh");
  });

  it("refuses changed, unknown, and symbolic-link files", () => {
    const root = sandbox();
    const port = { captureReportingSnapshot: () => snapshot() };

    const changed = join(root, "changed");
    exportReportingDirectory({
      snapshotPort: port,
      repositoryId: "repository-1",
      runId: "run-1",
      destinationDirectory: changed,
      sha256,
    });
    writeFileSync(join(changed, "actors.jsonl"), "{}", { flag: "w" });
    expect(() => verifyReportingDirectory(changed, sha256)).toThrow("does not match");

    const unknown = join(root, "unknown");
    exportReportingDirectory({
      snapshotPort: port,
      repositoryId: "repository-1",
      runId: "run-1",
      destinationDirectory: unknown,
      sha256,
    });
    writeFileSync(join(unknown, "extra.json"), "{}", { flag: "wx" });
    expect(() => verifyReportingDirectory(unknown, sha256)).toThrow("inventory");

    const linked = join(root, "linked");
    exportReportingDirectory({
      snapshotPort: port,
      repositoryId: "repository-1",
      runId: "run-1",
      destinationDirectory: linked,
      sha256,
    });
    unlinkSync(join(linked, "actors.jsonl"));
    symlinkSync(join(linked, "graph.jsonl"), join(linked, "actors.jsonl"));
    expect(() => verifyReportingDirectory(linked, sha256)).toThrow("regular files");

    const hardLinked = join(root, "hard-linked");
    exportReportingDirectory({
      snapshotPort: port,
      repositoryId: "repository-1",
      runId: "run-1",
      destinationDirectory: hardLinked,
      sha256,
    });
    unlinkSync(join(hardLinked, "actors.jsonl"));
    linkSync(join(hardLinked, "graph.jsonl"), join(hardLinked, "actors.jsonl"));
    expect(() => verifyReportingDirectory(hardLinked, sha256)).toThrow("regular files");

    const alias = join(root, "export-alias");
    symlinkSync(linked, alias, "dir");
    expect(() => verifyReportingDirectory(alias, sha256)).toThrow(/regular directory|canonical/);
  });

  it.each([
    ["file-sync", false],
    ["manifest-sync", false],
    ["directory-sync", false],
    ["rename", false],
    ["parent-sync", true],
    ["reopen", true],
  ] as const)(
    "handles report publication %s failure without erasing published state",
    (fault, published) => {
      const root = sandbox();
      const destination = join(root, `report-${fault}`);

      expect(() =>
        exportReportingDirectory({
          snapshotPort: { captureReportingSnapshot: () => snapshot() },
          repositoryId: "repository-1",
          runId: "run-1",
          destinationDirectory: destination,
          sha256,
          publicationPort: faultingPublicationPort(fault, destination),
        }),
      ).toThrow(published ? PublishedDirectoryDurabilityError : Error);
      expect(existsSync(destination)).toBe(published);
      if (published) expect(verifyReportingDirectory(destination, sha256)).toBeDefined();
    },
  );

  it("rejects a symlinked destination parent before creating staging entries", () => {
    const root = sandbox();
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent, "dir");

    expect(() =>
      exportReportingDirectory({
        snapshotPort: { captureReportingSnapshot: () => snapshot() },
        repositoryId: "repository-1",
        runId: "run-1",
        destinationDirectory: join(linkedParent, "report"),
        sha256,
      }),
    ).toThrow("destination parent");
    expect(readdirSync(realParent)).toEqual([]);
  });

  it("composes SQLite capture through verified directory publication", () => {
    const root = sandbox();
    const databasePath = join(root, "authority.db");
    const assetDirectory = join(root, "assets");
    const dependencies = {
      sha256: deterministicSha256,
      authorization: { authorize: () => true },
    };
    const authority = new SqliteAuthority({ databasePath, assetDirectory, dependencies });
    const command = runtimeCommand({
      commandId: "command_report-export-instantiate",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "no-approval" },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    expect(authority.submit(command, createAdmissionFixture().at()).status).toBe("completed");
    authority.close();

    const destinationDirectory = join(root, "sqlite-export");
    const manifest = exportSqliteReportingDirectory({
      databasePath,
      dependencies,
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      destinationDirectory,
    });

    expect(manifest.restorable).toBe(false);
    expect(verifyReportingDirectory(destinationDirectory, deterministicSha256)).toEqual(manifest);
  });

  it("exposes bounded create and verify commands while refusing export restore", async () => {
    const root = sandbox();
    const environment = {
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
    };
    const dependencies = {
      sha256: deterministicSha256,
      authorization: { authorize: () => true },
    };
    const databasePath = join(root, "state", "senawa", "authority.db");
    const authority = new SqliteAuthority({
      databasePath,
      assetDirectory: join(root, "state", "senawa", "assets"),
      dependencies,
    });
    const command = runtimeCommand({
      commandId: "command_report-export-cli",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "no-approval" },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    expect(authority.submit(command, createAdmissionFixture().at()).status).toBe("completed");
    authority.close();

    const destination = join(root, "cli-export");
    const created = await runOperationalCli(
      ["report", "create", runtimeFixture.repositoryId, runtimeFixture.runId, destination],
      environment,
      dependencies,
    );
    expect(JSON.parse(created?.output ?? "null")).toMatchObject({ restorable: false });
    const verified = await runOperationalCli(
      ["export", "verify", destination],
      environment,
      dependencies,
    );
    expect(verified).toEqual(created);
    expect(await runOperationalCli(["export", "restore", destination], environment)).toEqual({
      output: "Report exports are non-restorable; restore requires a verified backup",
      exitCode: 1,
    });
  });
});

function snapshot(): ReportingSnapshot {
  return {
    version: REPORTING_SNAPSHOT_VERSION,
    repositoryId: "repository-1",
    runId: "run-1",
    schemaVersion: 9,
    configurationSnapshotDigest: DIGEST,
    sourceVector: {
      workflowCursor: 1,
      lifecycleRevision: 1,
      contextRevision: 0,
      runnerRevision: 0,
      workspaceRevision: 0,
      humanRevision: 0,
      portalRevision: 1,
      graphRevision: DIGEST,
    },
    sections: SECTION_NAMES.map((name) => ({
      name,
      status: "complete",
      records:
        name === "trajectory"
          ? [
              {
                kind: "command",
                identity: "command-1",
                state: "completed",
                references: [
                  { role: "result", kind: "revision", identity: DIGEST },
                  { role: "source", kind: "command", identity: "command-1" },
                ],
                scalars: [{ name: "intent", value: "instantiate-run" }],
              },
            ]
          : [],
    })),
  };
}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "senawa-report-export-"));
  roots.add(root);
  return root;
}

function directoryBytes(directory: string): readonly [string, string][] {
  return readdirSync(directory)
    .sort()
    .map((name) => [name, readFileSync(join(directory, name), "hex")]);
}

type PublicationFault =
  | "file-sync"
  | "manifest-sync"
  | "directory-sync"
  | "rename"
  | "parent-sync"
  | "reopen";

function faultingPublicationPort(
  fault: PublicationFault,
  destination: string,
): DurableDirectoryPublicationPort {
  return {
    syncFile(path) {
      if (fault === "manifest-sync" && path.endsWith("/manifest.json")) throw faultError(fault);
      if (fault === "file-sync" && !path.endsWith("/manifest.json")) throw faultError(fault);
      nodeDirectoryPublicationPort.syncFile(path);
    },
    syncDirectory(path) {
      if (fault === "parent-sync" && path === dirname(destination)) throw faultError(fault);
      if (fault === "directory-sync" && path !== dirname(destination)) throw faultError(fault);
      nodeDirectoryPublicationPort.syncDirectory(path);
    },
    rename(source, target) {
      if (fault === "rename") throw faultError(fault);
      nodeDirectoryPublicationPort.rename(source, target);
    },
    reopen(path) {
      if (fault === "reopen") throw faultError(fault);
      nodeDirectoryPublicationPort.reopen(path);
    },
  };
}

function faultError(point: string): Error {
  return new Error(`injected ${point} failure`);
}
