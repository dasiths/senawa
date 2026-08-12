import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderCli, SENAWA_VERSION } from "./cli.js";

const execute = promisify(execFile);
const EXPECTED_HELP = `Senawa ${SENAWA_VERSION}

Usage: senawa [--help] [--version]

The alpha implementation reset currently exposes no workflow commands.`;

describe("renderCli", () => {
  it("reports the alpha version", () => {
    expect(renderCli(["--version"])).toEqual({ output: SENAWA_VERSION, exitCode: 0 });
  });

  it("does not advertise unimplemented workflow commands", () => {
    const result = renderCli(["--help"]);

    expect(result).toEqual({ output: EXPECTED_HELP, exitCode: 0 });
  });

  it("keeps the rendered version aligned with package metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(SENAWA_VERSION).toBe(packageJson.version);
  });

  it("runs the built executable with truthful output and exit codes", async () => {
    const executable = new URL("../dist/main.js", import.meta.url);
    const version = await execute(process.execPath, [executable.pathname, "--version"]);
    const help = await execute(process.execPath, [executable.pathname, "--help"]);

    expect(version.stdout.trim()).toBe(SENAWA_VERSION);
    expect(help.stdout.trim()).toBe(EXPECTED_HELP);

    await expect(execute(process.execPath, [executable.pathname, "work"])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("Unknown argument: work"),
    });
  });
});
