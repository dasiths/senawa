import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BeadsClient, BeadsCommandError, BeadsEnvelopeError } from "./beads-client.js";

interface RequiredBeadsEnvironment extends NodeJS.ProcessEnv {
  readonly BD_JSON_ENVELOPE: string;
  readonly BD_NON_INTERACTIVE: string;
  readonly DO_NOT_TRACK: string;
}

describe("BeadsClient", () => {
  it("sets the envelope and noninteractive environment for every command", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-beads-client-"));
    const calls: Array<{
      readonly arguments_: readonly string[];
      readonly env: RequiredBeadsEnvironment;
    }> = [];
    const client = new BeadsClient(root, {
      runCommand: async (_executable, arguments_, options) => {
        calls.push({ arguments_, env: options.env as RequiredBeadsEnvironment });
        if (arguments_[0] === "version") {
          return { stdout: "bd version 1.1.2 (test)\n", stderr: "" };
        }
        return { stdout: '{"data":[],"schema_version":1}\n', stderr: "" };
      },
    });

    await client.assertSupported();
    await client.json(["list", "--all"]);

    expect(calls[1]?.arguments_).toEqual(["list", "--all", "--json"]);
    expect(calls[1]?.env.BD_JSON_ENVELOPE).toBe("1");
    expect(calls[1]?.env.BD_NON_INTERACTIVE).toBe("1");
    expect(calls[1]?.env.DO_NOT_TRACK).toBe("1");
  });

  it("rejects malformed and legacy JSON shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-beads-envelope-"));
    const outputs = ["not-json", "[]"];
    const client = new BeadsClient(root, {
      runCommand: async () => ({ stdout: outputs.shift() ?? "[]", stderr: "" }),
    });

    await expect(client.json(["list"])).rejects.toBeInstanceOf(BeadsEnvelopeError);
    await expect(client.json(["list"])).rejects.toBeInstanceOf(BeadsEnvelopeError);
  });

  it("reports missing binaries without falling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-beads-missing-"));
    const client = new BeadsClient(root, { executable: join(root, "missing-bd") });
    await expect(client.assertSupported()).rejects.toMatchObject({
      name: BeadsCommandError.name,
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("closes stdin for spawned commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-beads-stdin-"));
    const executable = join(root, "fake-bd.mjs");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdin.on('end', () => process.stdout.write('bd version 1.1.2 (fake)\\n')); process.stdin.resume();\n",
      { mode: 0o755 },
    );
    const client = new BeadsClient(root, { executable });
    await expect(client.assertSupported()).resolves.toMatchObject({ version: "1.1.2" });
  });
});
