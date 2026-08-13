import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  compileWorkflowConfiguration,
  createExampleWorkflowConfiguration,
} from "@senawa/configuration";
import { describe, expect, it } from "vitest";
import {
  type CliDependencies,
  type CliWritableFile,
  renderCli,
  runCli,
  SENAWA_VERSION,
} from "./cli.js";

const execute = promisify(execFile);
const EXPECTED_HELP = `Senawa ${SENAWA_VERSION}

Usage: senawa <command> [arguments]

Commands:
  doctor [path]                         Validate workflow configuration
  init [path]                           Create example workflow configuration
  service start|run|status|drain|stop   Manage the local supervisor
  service logs [after]                  Read bounded supervisor logs
  service recover <repository> <run>    Recover a run under the service fence
  command submit <json-path|->          Submit a command through local IPC
  receipt get <command>                 Read the latest command receipt
  receipt list <repository> <run>       List durable receipts
  event list <repository> <run>         List durable events
  projection get <repository> <run>     Read the phase projection
  amendment list|get|source|status      Review additive amendment proposals
  amendment withdraw|approve|reject     Submit an exact human amendment command
  amendment recover <repository> <run>  Trigger fenced amendment recovery
  portal                                Create a one-time portal URL

Options:
  -h, --help     Show help
  -v, --version  Show version`;

describe("renderCli", () => {
  it("reports the alpha version and truthful help", () => {
    expect(renderCli(["--version"])).toEqual({ output: SENAWA_VERSION, exitCode: 0 });
    expect(renderCli(["--help"])).toEqual({ output: EXPECTED_HELP, exitCode: 0 });
  });

  it("keeps the rendered version aligned with package metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(SENAWA_VERSION).toBe(packageJson.version);
  });
});

describe("runCli", () => {
  it("doctors a valid document without an execution dependency", async () => {
    const memory = new MemoryCliDependencies();
    memory.files.set("workflow.json", JSON.stringify(createExampleWorkflowConfiguration()));
    const processExecutionCounter = { calls: 0 };

    const result = await runCli(["doctor", "workflow.json"], memory);

    expect(result).toEqual({ output: "workflow.json: valid", exitCode: 0 });
    expect(memory.readCalls).toBe(1);
    expect(memory.createCalls).toBe(0);
    expect(processExecutionCounter.calls).toBe(0);
  });

  it("aggregates invalid doctor diagnostics deterministically", async () => {
    const memory = new MemoryCliDependencies();
    const invalid = JSON.parse(JSON.stringify(createExampleWorkflowConfiguration())) as Record<
      string,
      unknown
    >;
    invalid.kind = "Job";
    invalid.authority = true;
    memory.files.set("invalid.json", JSON.stringify(invalid));

    const result = await runCli(["doctor", "invalid.json"], memory);

    expect(result.exitCode).toBe(1);
    expect(result.output.split("\n").slice(1)).toEqual([
      "- [unknown-field] invalid.json#/authority: Unknown field authority",
      "- [invalid-kind] invalid.json#/kind: kind must be Workflow",
    ]);
  });

  it.each(["ENOENT", "EACCES", "EISDIR"])(
    "reports safe filesystem code %s without internal details",
    async (code) => {
      const memory = new MemoryCliDependencies();
      memory.readError = objectError(code, "/secret/internal/path");

      const result = await runCli(["doctor", "unreadable.json"], memory);

      expect(result).toEqual({
        output: `unreadable.json: unable to read workflow configuration (${code})`,
        exitCode: 1,
      });
      expect(result.output).not.toContain("/secret/internal/path");
    },
  );

  it("reports normalized JSON syntax locations without parser details", async () => {
    const memory = new MemoryCliDependencies();
    memory.files.set("broken.json", '{\n  "kind": }');

    const invalid = await runCli(["doctor", "broken.json"], memory);

    expect(invalid).toEqual({
      output: "broken.json: invalid JSON: unexpected JSON token at line 2, column 12",
      exitCode: 1,
    });
    expect(invalid.output).not.toContain("SyntaxError");
  });

  it("creates the exact versioned example and the result compiles", async () => {
    const memory = new MemoryCliDependencies();

    expect(await runCli(["init"], memory)).toEqual({
      output: "senawa.json: created",
      exitCode: 0,
    });
    const content = memory.files.get("senawa.json");
    expect(content).toBeDefined();
    const document = JSON.parse(content as string);
    expect(document.apiVersion).toBe("senawa.dev/workflow/v1alpha1");
    expect(() =>
      compileWorkflowConfiguration(document, "senawa.json", memory.sha256),
    ).not.toThrow();
  });

  it("allows exactly one concurrent init and never overwrites an existing destination", async () => {
    const memory = new MemoryCliDependencies();
    const concurrent = await Promise.all([runCli(["init"], memory), runCli(["init"], memory)]);

    expect(concurrent.filter(({ exitCode }) => exitCode === 0)).toHaveLength(1);
    expect(concurrent.filter(({ exitCode }) => exitCode === 1)).toHaveLength(1);
    expect(memory.files.get("senawa.json")).toBeDefined();

    memory.files.set("partial.json", "partial existing content");
    expect(await runCli(["init", "partial.json"], memory)).toMatchObject({ exitCode: 1 });
    expect(memory.files.get("partial.json")).toBe("partial existing content");
  });

  it("syncs file and parent directory in durability order", async () => {
    const memory = new MemoryCliDependencies();

    expect(await runCli(["init"], memory)).toMatchObject({ exitCode: 0 });
    expect(memory.operations).toEqual([
      "create:senawa.json",
      "write:senawa.json",
      "sync-file:senawa.json",
      "close:senawa.json",
      "sync-directory:senawa.json",
    ]);
  });

  it("retains a replacement when a durability failure occurs", async () => {
    const memory = new MemoryCliDependencies();
    memory.replaceDuringSync = true;

    expect(await runCli(["init"], memory)).toEqual({
      output:
        "senawa.json: unable to durably write workflow configuration (FILESYSTEM_ERROR); a partial file may remain",
      exitCode: 1,
    });
    expect(memory.files.get("senawa.json")).toBe("replacement owned by another actor");
    expect(memory.operations.at(-1)).toBe("close:senawa.json");
  });
});

describe("built executable", () => {
  it("supports version, help, doctor, exclusive init, and concurrent no-overwrite", async () => {
    const executable = new URL("../dist/main.js", import.meta.url);
    const root = await mkdtemp(join(tmpdir(), "senawa-cli-"));
    const version = await execute(process.execPath, [executable.pathname, "--version"]);
    const help = await execute(process.execPath, [executable.pathname, "--help"]);

    expect(version.stdout.trim()).toBe(SENAWA_VERSION);
    expect(help.stdout.trim()).toBe(EXPECTED_HELP);

    const initialized = await execute(process.execPath, [executable.pathname, "init"], {
      cwd: root,
    });
    expect(initialized.stdout.trim()).toBe("senawa.json: created");
    const content = await readFile(join(root, "senawa.json"), "utf8");
    expect(JSON.parse(content).apiVersion).toBe("senawa.dev/workflow/v1alpha1");

    const valid = await execute(process.execPath, [executable.pathname, "doctor"], { cwd: root });
    expect(valid.stdout.trim()).toBe("senawa.json: valid");
    await expect(
      execute(process.execPath, [executable.pathname, "init"], { cwd: root }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("already exists") });

    const partialPath = join(root, "partial.json");
    await writeFile(partialPath, "partial existing content", "utf8");
    await expect(
      execute(process.execPath, [executable.pathname, "init", "partial.json"], { cwd: root }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(partialPath, "utf8")).toBe("partial existing content");

    const concurrent = await Promise.allSettled([
      execute(process.execPath, [executable.pathname, "init", "concurrent.json"], { cwd: root }),
      execute(process.execPath, [executable.pathname, "init", "concurrent.json"], { cwd: root }),
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const concurrentContent = await readFile(join(root, "concurrent.json"), "utf8");
    expect(JSON.parse(concurrentContent).apiVersion).toBe("senawa.dev/workflow/v1alpha1");

    await writeFile(join(root, "invalid.json"), '{"kind":"Job","authority":true}', "utf8");
    await expect(
      execute(process.execPath, [executable.pathname, "doctor", "invalid.json"], { cwd: root }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("invalid.json: invalid"),
    });
  });
});

class MemoryCliDependencies implements CliDependencies {
  readonly files = new Map<string, string>();
  readonly sha256 = {
    digest(bytes: Uint8Array) {
      let accumulator = 0x811c9dc5;
      for (const byte of bytes) {
        accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
      }
      return accumulator.toString(16).padStart(8, "0").repeat(8);
    },
  };
  readCalls = 0;
  createCalls = 0;
  readonly operations: string[] = [];
  readError: Error | undefined;
  replaceDuringSync = false;

  async readText(path: string): Promise<string> {
    this.readCalls += 1;
    if (this.readError !== undefined) throw this.readError;
    const content = this.files.get(path);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  }

  async createExclusive(path: string): Promise<CliWritableFile> {
    this.createCalls += 1;
    if (this.files.has(path)) throw objectError("EEXIST");
    this.operations.push(`create:${path}`);
    this.files.set(path, "");
    let closed = false;
    return {
      write: async (content) => {
        if (closed) throw new Error("closed");
        this.operations.push(`write:${path}`);
        this.files.set(path, content);
      },
      sync: async () => {
        this.operations.push(`sync-file:${path}`);
        if (this.replaceDuringSync) {
          this.files.set(path, "replacement owned by another actor");
          throw new Error("sync failed after replacement");
        }
      },
      close: async () => {
        this.operations.push(`close:${path}`);
        closed = true;
      },
      syncParentDirectory: async () => {
        this.operations.push(`sync-directory:${path}`);
      },
    };
  }
}

function objectError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
