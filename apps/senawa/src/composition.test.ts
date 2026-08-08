import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import type { RuntimeState } from "@senawa/domain";
import { BeadsClient } from "@senawa/runtime-beads";
import { createRuntimeFixture } from "@senawa/testing";
import { sdkCapabilities } from "@senawa/workers";
import { describe, expect, it } from "vitest";
import { createRuntimeComposition, selectRuntime } from "./composition.js";

describe("runtime composition", () => {
  it("selects Beads by default and file only when explicit", () => {
    expect(selectRuntime([])).toBe("beads");
    expect(selectRuntime(["--runtime", "beads"])).toBe("beads");
    expect(selectRuntime(["--runtime", "file"])).toBe("file");
    expect(() => selectRuntime(["--runtime", "unknown"])).toThrow(
      "Unsupported runtime backend: unknown",
    );
  });

  it("does not fall back to file state when Beads is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-no-fallback-"));
    const fixture = createRuntimeFixture("run-no-fallback");
    const state: RuntimeState = {
      ...fixture,
      identity: { ...fixture.identity, backend: "beads" },
    };
    const { persistence } = createRuntimeComposition(root, "beads", {
      beadsClient: new BeadsClient(root, { executable: join(root, "missing-bd") }),
    });

    await expect(persistence.createRun(state, "start")).rejects.toThrow("missing-bd");
    await expect(
      stat(join(root, ".agents", ".copilot-tracking", state.identity.runId, "runtime-state.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readJson(join(root, ".agents", ".copilot-tracking", "active-run.json")),
    ).resolves.toMatchObject({ runId: state.identity.runId, backend: "beads" });
    await expect(
      readJson(join(root, ".agents", ".copilot-tracking", state.identity.runId, "identity.json")),
    ).resolves.toMatchObject({
      value: { runId: state.identity.runId, backend: "beads" },
    });
  });

  it("keeps every repository worker profile inside the SDK host capability set", async () => {
    const definitions = await loadRepositoryDefinitions(process.cwd());
    const supported = new Set(sdkCapabilities);
    const requested = Object.entries(definitions.workerProfiles).map(([role, profile]) => [
      role,
      profile.spec.tools.filter((capability) => !supported.has(capability)),
    ]);
    expect(Object.fromEntries(requested)).toEqual(
      Object.fromEntries(Object.keys(definitions.workerProfiles).map((role) => [role, []])),
    );
  });
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
