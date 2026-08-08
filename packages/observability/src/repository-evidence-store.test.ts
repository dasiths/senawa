import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitRepositoryEvidenceStore } from "./repository-evidence-store.js";

const execute = promisify(execFile);

describe("GitRepositoryEvidenceStore", () => {
  it("separates dirty baseline, in-scope, out-of-scope, and frozen changes", async () => {
    const root = await createRepository();
    await writeFile(join(root, "README.md"), "pre-existing dirty state\n", "utf8");
    const store = new GitRepositoryEvidenceStore(root);
    const baseline = await store.captureBaseline({
      runId: "run-evidence",
      taskId: "task-one",
      attempt: 1,
      dispatchId: "dispatch-one",
      turnId: "turn-one",
      expectation: "required",
      authorizedPaths: ["packages/application"],
      frozenPaths: [".senawa/**"],
      recovered: false,
      capturedAt: "2026-08-07T00:00:00.000Z",
    });

    expect(baseline.entries.map((entry) => entry.path)).toContain("README.md");
    await writeFile(join(root, "packages/application/index.ts"), "export const changed = true;\n");
    await writeFile(join(root, "outside.txt"), "outside\n");
    await mkdir(join(root, ".senawa"), { recursive: true });
    await writeFile(join(root, ".senawa/sensors.yaml"), "changed: true\n");

    const delta = await store.captureDelta({
      baseline,
      workerClaim: { reported: true, changed: false, patch: "" },
      recovered: false,
      capturedAt: "2026-08-07T00:01:00.000Z",
    });

    expect(delta.preExistingChanges).toContain("README.md");
    expect(delta.changedPaths.map((entry) => entry.path)).not.toContain("README.md");
    expect(delta.inScopeChanges).toEqual(["packages/application/index.ts"]);
    expect(delta.outOfScopeChanges).toEqual(["outside.txt"]);
    expect(delta.frozenChanges).toEqual([".senawa/sensors.yaml"]);
    expect(delta.workerClaim.agreement).toBe("disagree");
    expect(delta.uncertainty).toEqual([]);
    await expect(
      access(join(root, ".agents/.copilot-tracking/run-evidence", baseline.evidencePath)),
    ).resolves.toBeUndefined();
    await expect(
      access(join(root, ".agents/.copilot-tracking/run-evidence", delta.evidencePath)),
    ).resolves.toBeUndefined();
  });

  it("marks post-interruption remeasurement as uncertain", async () => {
    const root = await createRepository();
    const store = new GitRepositoryEvidenceStore(root);
    const baseline = await store.captureBaseline({
      runId: "run-recovery",
      taskId: "task-one",
      attempt: 1,
      dispatchId: "dispatch-one",
      turnId: "turn-one",
      expectation: "required",
      authorizedPaths: ["packages/application"],
      frozenPaths: [".senawa/**"],
      recovered: false,
      capturedAt: "2026-08-07T00:00:00.000Z",
    });
    await writeFile(join(root, "packages/application/index.ts"), "export const changed = true;\n");

    const delta = await store.captureDelta({
      baseline,
      workerClaim: { reported: false, changed: null },
      recovered: true,
      capturedAt: "2026-08-07T00:01:00.000Z",
    });

    expect(delta.inScopeChanges).toEqual(["packages/application/index.ts"]);
    expect(delta.uncertainty).toEqual(["delta-captured-during-recovery"]);
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-repository-evidence-"));
  await mkdir(join(root, "packages/application"), { recursive: true });
  await writeFile(join(root, "packages/application/index.ts"), "export const initial = true;\n");
  await writeFile(join(root, "README.md"), "initial\n");
  await execute("git", ["init", "--quiet"], { cwd: root });
  await execute("git", ["config", "user.email", "senawa@example.invalid"], { cwd: root });
  await execute("git", ["config", "user.name", "Senawa Test"], { cwd: root });
  await execute("git", ["add", "."], { cwd: root });
  await execute("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  return root;
}
