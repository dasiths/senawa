import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedGitCommandPort } from "./git-command.js";

const gitExecutable = "/usr/bin/git";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BoundedGitCommandPort", () => {
  it("runs literal argv with isolated deterministic Git configuration", async () => {
    const root = await temporaryRoot();
    const port = await commandPort(root);
    const result = await port.run({
      rootDirectory: root,
      args: ["config", "--show-origin", "--get", "core.hooksPath"],
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(result.stdout.text).toContain("/dev/null");
  });

  it("bounds output and reports cancellation through the process supervisor", async () => {
    const root = await temporaryRoot();
    const port = await commandPort(root);
    const bounded = await port.run({
      rootDirectory: root,
      args: ["help", "-a"],
      timeoutMs: 2_000,
      maxStdoutBytes: 16,
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await port.run({
      rootDirectory: root,
      args: ["help", "-a"],
      timeoutMs: 2_000,
      signal: controller.signal,
    });

    expect(bounded.stdout.capturedBytes).toBeLessThanOrEqual(16);
    expect(cancelled).toMatchObject({ cancelled: true, cleanup: "not-needed" });
  });
});

async function commandPort(root: string): Promise<BoundedGitCommandPort> {
  const home = join(root, "home");
  await mkdir(home);
  return new BoundedGitCommandPort({
    gitExecutable,
    isolatedHome: home,
    additionalSubcommands: ["init", "commit", "cat-file", "show", "checkout", "branch"],
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-git-command-"));
  roots.push(root);
  if (process.env.SENAWA_GIT_TEST_AUDIT === "1") {
    console.info(`SENAWA_GIT_TEST_ROOT ${root}`);
  }
  return root;
}
