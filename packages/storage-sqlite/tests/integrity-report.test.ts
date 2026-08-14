import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoleAuthorizationPolicy } from "@senawa/runtime";
import { deterministicSha256 } from "@senawa/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSqliteAuthorityBackupIntegrity,
  checkSqliteAuthorityIntegrity,
  SqliteAuthority,
} from "../src/index.js";

const roots = new Set<string>();
const dependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([]),
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("sanitized SQLite integrity reports", () => {
  it("reports fixed passing categories for live state and verified backups", async () => {
    const fixture = createFixture();

    const live = checkSqliteAuthorityIntegrity(fixture);
    expect(live.status).toBe("passed");
    expect(live.checks.every(({ status }) => status === "passed")).toBe(true);

    const authority = new SqliteAuthority(fixture);
    const backupPath = join(fixture.root, "backup");
    await authority.backup(backupPath);
    authority.close();
    expect(checkSqliteAuthorityBackupIntegrity({ backupPath, dependencies })).toEqual(live);
  });

  it("returns a stable migration category without raw database details", () => {
    const fixture = createFixture();
    const corruptChecksum = "b".repeat(64);
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE migration_metadata SET checksum = ? WHERE version = 1")
      .run(corruptChecksum);
    database.close();

    const report = checkSqliteAuthorityIntegrity(fixture);
    expect(report.status).toBe("failed");
    expect(report.checks.find(({ status }) => status === "failed")).toEqual({
      category: "migrations",
      status: "failed",
      code: "migrations-failed",
    });
    expect(JSON.stringify(report)).not.toContain(corruptChecksum);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "senawa-integrity-report-"));
  roots.add(root);
  const fixture = {
    root,
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    dependencies,
  };
  const authority = new SqliteAuthority(fixture);
  authority.close();
  return fixture;
}
