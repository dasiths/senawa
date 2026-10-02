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
import { deterministicSha256 } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  nodeDirectoryPublicationPort,
  PublishedDirectoryDurabilityError,
} from "./durable-directory.js";
import {
  createDiagnosticsDirectory,
  createRepairPlan,
  verifyDiagnosticsDirectory,
} from "./maintenance.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("secret-safe maintenance artifacts", () => {
  it("publishes a fresh bounded diagnostic bundle without private status fields", () => {
    const root = sandbox();
    const secret = "fixture-secret-token";
    const destination = join(root, "diagnostics");
    const manifest = createDiagnosticsDirectory({
      destinationDirectory: destination,
      productVersion: "test-version",
      integrity: integrity("passed"),
      serviceStatus: {
        lifecycle: "drained",
        mode: "drained",
        health: "degraded",
        processId: 42,
        startedAt: "2026-08-14T00:00:00.000Z",
        listeners: [{ kind: "ipc", address: `/private/${secret}/supervisor.sock` }],
        pending: {
          queuedCommands: 0,
          claimedCommands: 0,
          wakes: 0,
          runnerEffects: 0,
          completionOutbox: 0,
          amendmentProposalOutbox: 0,
          approvedAmendments: 0,
        },
        leases: [
          {
            repositoryId: secret,
            runId: secret,
            ownerId: secret,
            fence: 1,
            expiresAt: "never",
          },
        ],
        sdkSessionStore: {
          status: "degraded",
          expectedSessionCount: 1,
          missingSessionIds: [secret],
          message: secret,
        },
        remoteConnectors: [],
      },
    });

    expect(manifest.classification).toBe("secret-safe-metadata");
    expect(verifyDiagnosticsDirectory(destination)).toEqual(manifest);
    const content = readdirSync(destination)
      .map((name) => readFileSync(join(destination, name), "utf8"))
      .join("\n");
    expect(content).not.toContain(secret);
    expect(() =>
      createDiagnosticsDirectory({
        destinationDirectory: destination,
        productVersion: "test-version",
        integrity: integrity("passed"),
      }),
    ).toThrow("fresh");
  });

  it("detects manifest tampering and emits a refusal-first repair plan", () => {
    const root = sandbox();
    const destination = join(root, "diagnostics");
    createDiagnosticsDirectory({
      destinationDirectory: destination,
      productVersion: "test-version",
      integrity: integrity("failed"),
    });
    writeFileSync(join(destination, "status.json"), "{}", { flag: "w" });
    expect(() => verifyDiagnosticsDirectory(destination)).toThrow("manifest");

    const plan = createRepairPlan(integrity("failed"), deterministicSha256);
    expect(plan.allowedActions).toEqual(["verified-fresh-restore"]);
    expect(plan.refusedActions).toContain("evidence-deletion");
    expect(plan.refusedActions).toContain("synthetic-outcomes");
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses diagnostic hardlinks and symlinked directory aliases", () => {
    const root = sandbox();
    const destination = join(root, "diagnostics");
    createDiagnosticsDirectory({
      destinationDirectory: destination,
      productVersion: "test-version",
      integrity: integrity("passed"),
    });
    unlinkSync(join(destination, "integrity.json"));
    linkSync(join(destination, "status.json"), join(destination, "integrity.json"));
    expect(() => verifyDiagnosticsDirectory(destination)).toThrow("bounded regular files");

    const alias = join(root, "diagnostics-alias");
    symlinkSync(destination, alias, "dir");
    expect(() => verifyDiagnosticsDirectory(alias)).toThrow(/real directory|canonical/);
  });

  it.each(["parent-sync", "reopen"] as const)(
    "retains a verified diagnostic bundle after post-rename %s failure",
    (fault) => {
      const root = sandbox();
      const destination = join(root, `diagnostics-${fault}`);
      expect(() =>
        createDiagnosticsDirectory({
          destinationDirectory: destination,
          productVersion: "test-version",
          integrity: integrity("passed"),
          publicationPort: {
            ...nodeDirectoryPublicationPort,
            syncDirectory(path) {
              if (fault === "parent-sync" && path === dirname(destination)) {
                throw new Error("injected parent sync failure");
              }
              nodeDirectoryPublicationPort.syncDirectory(path);
            },
            reopen(path) {
              if (fault === "reopen") throw new Error("injected reopen failure");
              nodeDirectoryPublicationPort.reopen(path);
            },
          },
        }),
      ).toThrow(PublishedDirectoryDurabilityError);
      expect(existsSync(destination)).toBe(true);
      expect(verifyDiagnosticsDirectory(destination)).toBeDefined();
    },
  );
});

function integrity(status: "passed" | "failed") {
  return {
    format: "senawa-sqlite-integrity" as const,
    version: 1 as const,
    status,
    checks: [],
  };
}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "senawa-maintenance-"));
  roots.add(root);
  mkdirSync(join(root, "unused"));
  return root;
}
