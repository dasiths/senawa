import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardReset } from "./hard-reset.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateRoot(): { readonly stateDirectory: string; readonly runtimeDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "senawa-reset-"));
  roots.push(root);
  const stateDirectory = join(root, "senawa");
  mkdirSync(join(stateDirectory, "assets"), { recursive: true });
  writeFileSync(join(stateDirectory, "authority.db"), "not really a database");
  return { stateDirectory, runtimeDirectory: join(root, "run") };
}

const yes = { assumeYes: true, serviceRunning: false } as const;

describe("hard-reset", () => {
  it("removes the state root once a person has named it", async () => {
    const { stateDirectory, runtimeDirectory } = stateRoot();
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory,
      requestedPath: stateDirectory,
      ...yes,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("removed");
  });

  // Every other destructive path here refuses in favour of a fresh root, so
  // this one has to be impossible to trigger by accident.
  it("refuses without being told which root", async () => {
    const { stateDirectory, runtimeDirectory } = stateRoot();
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory,
      requestedPath: undefined,
      ...yes,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("needs the state root");
  });

  it("refuses a path that is not the root this environment resolves to", async () => {
    const { stateDirectory, runtimeDirectory } = stateRoot();
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory,
      requestedPath: join(stateDirectory, ".."),
      ...yes,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("is not the state root");
  });

  it("refuses a directory that is not a state root", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-reset-"));
    roots.push(root);
    const stateDirectory = join(root, "senawa");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, "holiday-photos.txt"), "not a run");
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory: join(root, "run"),
      requestedPath: stateDirectory,
      ...yes,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("does not look like a Senawa state root");
  });

  it("refuses while the supervisor is running", async () => {
    const { stateDirectory, runtimeDirectory } = stateRoot();
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory,
      requestedPath: stateDirectory,
      assumeYes: true,
      serviceRunning: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("the supervisor is running");
  });

  it("asks, and keeps everything when the answer does not match", async () => {
    const { stateDirectory, runtimeDirectory } = stateRoot();
    const asked: string[] = [];
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory,
      requestedPath: stateDirectory,
      assumeYes: false,
      serviceRunning: false,
      confirm: async (question) => {
        asked.push(question);
        return "yes";
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("hard-reset cancelled");
    expect(asked[0]).toContain("cannot be undone");
  });

  it("removes it when the answer is the path itself", async () => {
    const { stateDirectory, runtimeDirectory } = stateRoot();
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory,
      requestedPath: stateDirectory,
      assumeYes: false,
      serviceRunning: false,
      confirm: async () => `  ${stateDirectory}  `,
    });
    expect(result.exitCode).toBe(0);
  });

  // A pipe has nobody to ask, and taking silence for consent is how a script
  // deletes a run nobody meant to lose.
  it("refuses when there is nobody to ask", async () => {
    const { stateDirectory, runtimeDirectory } = stateRoot();
    const result = await hardReset({
      stateDirectory,
      runtimeDirectory,
      requestedPath: stateDirectory,
      assumeYes: false,
      serviceRunning: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("nothing can be asked here");
  });
});
