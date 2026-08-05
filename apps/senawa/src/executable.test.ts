import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecutable } from "./executable.js";

describe("executable resolution", () => {
  it("returns an absolute executable found on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-executable-"));
    const executable = join(root, "copilot");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);

    expect(resolveExecutable("copilot", { PATH: root }, "linux")).toBe(executable);
    expect(resolveExecutable(executable, {}, "linux")).toBe(executable);
  });

  it("returns an actionable error when Copilot is unavailable", () => {
    expect(() => resolveExecutable("copilot", { PATH: "" }, "linux")).toThrow("SENAWA_COPILOT_CLI");
  });
});
