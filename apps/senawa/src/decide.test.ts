import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";
import { decidePhase } from "./decide.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function scope() {
  const root = await mkdtemp(join(tmpdir(), "senawa-decide-"));
  roots.add(root);
  return {
    databasePath: join(root, "authority.db"),
    assetDirectory: join(root, "assets"),
    repositoryId: "repository_decide",
    runId: "run_decide",
    principal: runtimePrincipal,
    dependencies: runtimeDependencies,
    currentTime: "2026-08-17T00:00:00.000Z",
  };
}

describe("recording a decision from the command line", () => {
  it("refuses a rejection with no reason before it touches the authority", async () => {
    const result = decidePhase({ ...(await scope()), decision: "reject" });
    // The reason becomes the next attempt's input, so a rejection without one
    // spends an attempt and teaches nothing.
    expect(result).toEqual({
      exitCode: 2,
      output: "A rejection must carry a reason. The next attempt is given it word for word.",
    });
  });

  it("names the run rather than leaking a storage error", async () => {
    const result = decidePhase({ ...(await scope()), decision: "approve" });
    expect(result.exitCode).toBe(1);
    // The refusal names the run rather than leaking a storage driver message.
    expect(result.output).toContain("no such run");
  });
});
