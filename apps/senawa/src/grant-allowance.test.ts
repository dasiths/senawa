import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";
import { grantAllowance } from "./grant-allowance.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function scope() {
  const root = await mkdtemp(join(tmpdir(), "senawa-grant-"));
  roots.add(root);
  return {
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    repositoryId: "repository_grant",
    runId: "run_grant",
    principal: runtimePrincipal,
    dependencies: runtimeDependencies,
    currentTime: "2026-08-17T00:00:00.000Z",
  };
}

describe("raising a budget from the command line", () => {
  // Until this existed a person at a terminal could watch a run stop for a
  // budget and had no way to raise it: the only surface was the portal.
  it("names the run rather than leaking a storage error", async () => {
    const result = grantAllowance(await scope());
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no such run");
  });
});
