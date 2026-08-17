import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  compileWorkflowConfiguration,
  createExampleWorkflowConfiguration,
  createExampleWorkflowResources,
  createStandardWorkflowConfiguration,
  createStandardWorkflowResources,
} from "@senawa/configuration";
import { describe, expect, it } from "vitest";
import {
  type CliDependencies,
  type CliWritableFile,
  DEFAULT_WORKFLOW_PATH,
  MAX_CLI_INPUT_BYTES,
  renderCli,
  runCli,
  SENAWA_VERSION,
} from "./cli.js";
import { createNodeCliDependencies } from "./node-cli.js";

const execute = promisify(execFile);
const EXPECTED_HELP = `Senawa ${SENAWA_VERSION}

Usage: senawa <command> [arguments]

Commands:
  start <request.json> [run-id]         Start a run from the authored workflow
  status <repository> <run>             Report what a run is doing
  worker context|output-schema|complete Agent-scoped worker channel
  run-gates <phase>                     Measure a phase's gate sensors now
  phase <repository> <run> <phase>      Inspect one phase's lifecycle
  artifact list|read <repository> <run> Read what a run produced
  agent list <repository> <run>         List the agents a run dispatched
  doctor [path|directory]               Validate a workflow tree (default: .senawa)
  init [directory]                      Create the standard workflow tree (default: .senawa)
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
  report create <repository> <run> <dir> Create a deterministic report export
  export verify <dir>                   Verify a non-restorable report export
  backup create|verify <dir>            Create or verify combined state backup
  restore verify <dir>                  Verify a combined state backup
  restore apply <backup> <fresh-root>   Restore only to a fresh state root
  integrity check                       Verify storage without exposing rows
  diagnostics create <fresh-dir>        Create a secret-safe diagnostic bundle
  repair plan                           Plan refusal-first maintenance
  repair apply <backup> <fresh-root>    Apply verified fresh restore only
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

  it("refuses workflow input above 256 KiB before parsing", async () => {
    const memory = new MemoryCliDependencies();
    memory.files.set("limit.json", " ".repeat(MAX_CLI_INPUT_BYTES));
    memory.files.set("oversized.json", " ".repeat(MAX_CLI_INPUT_BYTES + 1));

    expect((await runCli(["doctor", "limit.json"], memory)).output).toContain("invalid JSON");
    expect(await runCli(["doctor", "oversized.json"], memory)).toEqual({
      output: "oversized.json: unable to read workflow configuration (EFBIG)",
      exitCode: 1,
    });
  });

  it("bounds real Node workflow reads at 256 KiB before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-cli-input-"));
    const limitPath = join(root, "limit.json");
    const oversizedPath = join(root, "oversized.json");
    await writeFile(limitPath, " ".repeat(MAX_CLI_INPUT_BYTES));
    await writeFile(oversizedPath, " ".repeat(MAX_CLI_INPUT_BYTES + 1));

    expect((await runCli(["doctor", limitPath], createNodeCliDependencies())).output).toContain(
      "invalid JSON",
    );
    expect(await runCli(["doctor", oversizedPath], createNodeCliDependencies())).toEqual({
      output: `${oversizedPath}: unable to read workflow configuration (EFBIG)`,
      exitCode: 1,
    });
    await rm(root, { recursive: true, force: true });
  });

  it("refuses real Node reads and writes through a symlinked parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-cli-symlink-"));
    const target = join(root, "target");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias, "dir");
    await writeFile(join(target, "workflow.json"), "{}");
    const dependencies = createNodeCliDependencies();

    expect(await runCli(["doctor", join(alias, "workflow.json")], dependencies)).toEqual({
      output: `${join(alias, "workflow.json")}: unable to read workflow configuration (ELOOP)`,
      exitCode: 1,
    });
    expect(await runCli(["init", alias], dependencies)).toEqual({
      output: `${join(alias, ".senawa")}: unable to durably publish standard workflow (ELOOP)`,
      exitCode: 1,
    });
    await expect(readFile(join(target, "new.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(root, { recursive: true, force: true });
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

  it("reads only the canonical default and scopes the migration hint to omitted doctor", async () => {
    const memory = new MemoryCliDependencies();
    memory.files.set("senawa.json", JSON.stringify(createExampleWorkflowConfiguration()));

    expect(await runCli(["doctor"], memory)).toEqual({
      output:
        ".senawa/workflow.json: unable to read workflow configuration (ENOENT)\nRun senawa init to create it. Earlier alpha files at senawa.json must be moved to .senawa/workflow.json or passed explicitly.",
      exitCode: 1,
    });
    expect(memory.readPaths).toEqual([DEFAULT_WORKFLOW_PATH]);
    expect(await runCli(["doctor", "senawa.json"], memory)).toEqual({
      output: "senawa.json: valid",
      exitCode: 0,
    });
    expect(await runCli(["doctor", DEFAULT_WORKFLOW_PATH], memory)).toEqual({
      output: ".senawa/workflow.json: unable to read workflow configuration (ENOENT)",
      exitCode: 1,
    });
  });

  it("creates the exact versioned example and the result compiles", async () => {
    const memory = new MemoryCliDependencies();

    expect(await runCli(["init"], memory)).toEqual({
      output: ".senawa/workflow.json: created",
      exitCode: 0,
    });
    const content = memory.files.get(DEFAULT_WORKFLOW_PATH);
    expect(content).toBeDefined();
    const document = JSON.parse(content as string);
    expect(document.apiVersion).toBe("senawa.dev/workflow/v1alpha3");
    await expect(
      compileWorkflowConfiguration(
        {
          document,
          locator: DEFAULT_WORKFLOW_PATH,
          resources: await memory.createResourceReader(DEFAULT_WORKFLOW_PATH),
        },
        memory.sha256,
      ),
    ).resolves.toBeDefined();
  });

  it("allows exactly one concurrent init and never overwrites an existing destination", async () => {
    const memory = new MemoryCliDependencies();
    const concurrent = await Promise.all([runCli(["init"], memory), runCli(["init"], memory)]);

    expect(concurrent.filter(({ exitCode }) => exitCode === 0)).toHaveLength(1);
    expect(concurrent.filter(({ exitCode }) => exitCode === 1)).toHaveLength(1);
    expect(memory.files.get(DEFAULT_WORKFLOW_PATH)).toBeDefined();

    memory.files.set("partial.json", "partial existing content");
    expect(await runCli(["init", "partial.json"], memory)).toMatchObject({ exitCode: 1 });
    expect(memory.files.get("partial.json")).toBe("partial existing content");
  });

  it("refuses an existing destination directory without changing it", async () => {
    const memory = new MemoryCliDependencies();
    memory.directories.add(".senawa");
    memory.directories.add(DEFAULT_WORKFLOW_PATH);

    expect(await runCli(["init"], memory)).toEqual({
      output: ".senawa/workflow.json: already exists",
      exitCode: 1,
    });
    expect(memory.directories.has(DEFAULT_WORKFLOW_PATH)).toBe(true);
    expect(memory.files.has(DEFAULT_WORKFLOW_PATH)).toBe(false);
  });

  it("preserves explicit-path semantics even for the canonical path string", async () => {
    const memory = new MemoryCliDependencies();

    expect(await runCli(["init", DEFAULT_WORKFLOW_PATH], memory)).toEqual({
      output: ".senawa/workflow.json: unable to create workflow configuration (ENOENT)",
      exitCode: 1,
    });
    expect(memory.directories.has(".senawa")).toBe(false);
    expect(memory.operations).toEqual(["create:.senawa/workflow.json"]);

    memory.directories.add("nested");
    expect(await runCli(["init", "nested/custom.json"], memory)).toEqual({
      output: "nested/custom.json: created",
      exitCode: 0,
    });
    expect(memory.operations.slice(1)).toEqual([
      "create:nested/custom.json",
      "write:nested/custom.json",
      "sync-file:nested/custom.json",
      "close:nested/custom.json",
      "sync-directory:nested",
    ]);
  });

  it("syncs the file, configuration directory, and project root in durability order", async () => {
    const memory = new MemoryCliDependencies();
    memory.directories.add(".senawa");

    expect(await runCli(["init"], memory)).toMatchObject({ exitCode: 0 });
    expect(memory.operations).toEqual([
      "ensure-directory:.senawa",
      "create:.senawa/workflow.json",
      "write:.senawa/workflow.json",
      "sync-file:.senawa/workflow.json",
      "close:.senawa/workflow.json",
      "sync-directory:.senawa",
      "sync-directory:.",
    ]);
  });

  it.each([
    ["ensure-directory:.senawa", "EACCES", "unable to prepare configuration directory", false],
    ["create:.senawa/workflow.json", "EACCES", "a partial directory may remain", false],
    ["write:.senawa/workflow.json", "ENOSPC", "a partial file may remain", true],
    ["sync-file:.senawa/workflow.json", "ENOSPC", "a partial file may remain", true],
    ["close:.senawa/workflow.json", "EIO", "a partial file may remain", true],
    ["sync-directory:.senawa", "EIO", "a partial file may remain", true],
    ["sync-directory:.", "EIO", "a partial file may remain", true],
  ])(
    "retains owned partial paths when %s fails",
    async (operation, code, expectedMessage, expectFile) => {
      const memory = new MemoryCliDependencies();
      memory.failAt = operation;
      memory.failureCode = code;

      const result = await runCli(["init"], memory);

      expect(result).toMatchObject({ exitCode: 1 });
      expect(result.output).toContain(expectedMessage);
      expect(memory.directories.has(".senawa")).toBe(operation !== "ensure-directory:.senawa");
      expect(memory.files.has(DEFAULT_WORKFLOW_PATH)).toBe(expectFile);
    },
  );

  it.each([
    ["file", "ENOTDIR"],
    ["symlink", "ELOOP"],
  ])("refuses a default %s parent without replacing it", async (kind, code) => {
    const memory = new MemoryCliDependencies();
    if (kind === "file") memory.files.set(".senawa", "owned content");
    else memory.symlinks.add(".senawa");

    expect(await runCli(["init"], memory)).toEqual({
      output: `.senawa/workflow.json: unable to prepare configuration directory (${code})`,
      exitCode: 1,
    });
    expect(memory.files.get(".senawa")).toBe(kind === "file" ? "owned content" : undefined);
    expect(memory.symlinks.has(".senawa")).toBe(kind === "symlink");
  });

  it("retains a replacement when a durability failure occurs", async () => {
    const memory = new MemoryCliDependencies();
    memory.replaceDuringSync = true;

    expect(await runCli(["init"], memory)).toEqual({
      output:
        ".senawa/workflow.json: unable to durably write workflow configuration (FILESYSTEM_ERROR); a partial file may remain",
      exitCode: 1,
    });
    expect(memory.files.get(DEFAULT_WORKFLOW_PATH)).toBe("replacement owned by another actor");
    expect(memory.operations.at(-1)).toBe("close:.senawa/workflow.json");
  });
});

describe("built executable", () => {
  it("supports default and explicit layout, migration, collisions, and concurrency", async () => {
    const executable = new URL("../dist/main.js", import.meta.url);
    const root = await mkdtemp(join(tmpdir(), "senawa-cli-"));
    const version = await execute(process.execPath, [executable.pathname, "--version"]);
    const help = await execute(process.execPath, [executable.pathname, "--help"]);

    expect(version.stdout.trim()).toBe(SENAWA_VERSION);
    expect(help.stdout.trim()).toBe(EXPECTED_HELP);

    const initialized = await execute(process.execPath, [executable.pathname, "init"], {
      cwd: root,
    });
    expect(initialized.stdout.trim()).toBe(".senawa: created");
    // The authored tree is what a person writes. The lowered internal document
    // is machine-generated, so init must never publish one for a human to edit.
    const content = await readFile(join(root, ".senawa", "workflow.yaml"), "utf8");
    expect(content).toContain("phases:");

    const valid = await execute(process.execPath, [executable.pathname, "doctor"], { cwd: root });
    expect(valid.stdout.trim()).toBe("./.senawa: valid");
    await expect(
      execute(process.execPath, [executable.pathname, "init"], { cwd: root }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("already exists") });

    const partialPath = join(root, "partial");
    await mkdir(partialPath);
    await writeFile(join(partialPath, ".senawa"), "partial existing content", "utf8");
    await expect(
      execute(process.execPath, [executable.pathname, "init", "partial"], { cwd: root }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(join(partialPath, ".senawa"), "utf8")).toBe("partial existing content");

    await mkdir(join(root, "custom"));
    const explicit = await execute(process.execPath, [executable.pathname, "init", "custom"], {
      cwd: root,
    });
    expect(explicit.stdout.trim()).toBe("custom/.senawa: created");
    expect(
      (
        await execute(process.execPath, [executable.pathname, "doctor", "custom"], {
          cwd: root,
        })
      ).stdout.trim(),
    ).toBe("custom/.senawa: valid");

    await writeFile(join(root, "invalid.json"), '{"kind":"Job","authority":true}', "utf8");
    await expect(
      execute(process.execPath, [executable.pathname, "doctor", "invalid.json"], { cwd: root }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("invalid.json: invalid"),
    });

    const migrationRoot = await mkdtemp(join(tmpdir(), "senawa-migration-"));
    // The earlier alpha layout is the lowered internal document, which is what
    // the migration hint is about, so it cannot be the authored YAML.
    await writeFile(
      join(migrationRoot, "senawa.json"),
      `${JSON.stringify(createStandardWorkflowConfiguration(), null, 2)}\n`,
      "utf8",
    );
    for (const [path, resource] of Object.entries(createStandardWorkflowResources())) {
      const destination = join(migrationRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, resource, "utf8");
    }
    await expect(
      execute(process.execPath, [executable.pathname, "doctor"], { cwd: migrationRoot }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("Earlier alpha files at senawa.json"),
    });
    expect(
      (
        await execute(process.execPath, [executable.pathname, "doctor", "senawa.json"], {
          cwd: migrationRoot,
        })
      ).stdout.trim(),
    ).toBe("senawa.json: valid");
    await expect(
      execute(process.execPath, [executable.pathname, "init", DEFAULT_WORKFLOW_PATH], {
        cwd: migrationRoot,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("(ENOENT)") });
    await expect(
      execute(process.execPath, [executable.pathname, "init", "nested/workflow.json"], {
        cwd: migrationRoot,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("(ENOENT)") });
    expect(await lstat(join(migrationRoot, ".senawa")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(migrationRoot, "nested")).catch(() => undefined)).toBeUndefined();

    const fileParentRoot = await mkdtemp(join(tmpdir(), "senawa-file-parent-"));
    await writeFile(join(fileParentRoot, ".senawa"), "existing", "utf8");
    await expect(
      execute(process.execPath, [executable.pathname, "init"], { cwd: fileParentRoot }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("already exists") });
    expect(await readFile(join(fileParentRoot, ".senawa"), "utf8")).toBe("existing");

    const symlinkParentRoot = await mkdtemp(join(tmpdir(), "senawa-link-parent-"));
    const symlinkTarget = await mkdtemp(join(tmpdir(), "senawa-link-target-"));
    await symlink(symlinkTarget, join(symlinkParentRoot, ".senawa"), "dir");
    await expect(
      execute(process.execPath, [executable.pathname, "init"], { cwd: symlinkParentRoot }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("already exists") });
    expect(
      await lstat(join(symlinkTarget, "workflow.json")).catch(() => undefined),
    ).toBeUndefined();

    const directoryDestinationRoot = await mkdtemp(join(tmpdir(), "senawa-directory-target-"));
    await mkdir(join(directoryDestinationRoot, ".senawa", "workflow.json"), { recursive: true });
    await expect(
      execute(process.execPath, [executable.pathname, "init"], {
        cwd: directoryDestinationRoot,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("already exists") });
    expect((await lstat(join(directoryDestinationRoot, DEFAULT_WORKFLOW_PATH))).isDirectory()).toBe(
      true,
    );

    const concurrentRoot = await mkdtemp(join(tmpdir(), "senawa-concurrent-"));
    const concurrent = await Promise.allSettled([
      execute(process.execPath, [executable.pathname, "init"], { cwd: concurrentRoot }),
      execute(process.execPath, [executable.pathname, "init"], { cwd: concurrentRoot }),
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await readFile(join(concurrentRoot, ".senawa", "workflow.yaml"), "utf8")).toBe(content);
  }, 15_000);
});

class MemoryCliDependencies implements CliDependencies {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>(["."]);
  readonly symlinks = new Set<string>();
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
  readonly readPaths: string[] = [];
  createCalls = 0;
  readonly operations: string[] = [];
  readError: Error | undefined;
  replaceDuringSync = false;
  failAt: string | undefined;
  failureCode = "FILESYSTEM_ERROR";

  createResourceReader(_workflowPath: string) {
    const resources = createExampleWorkflowResources();
    return Promise.resolve({
      read: async ({ path, maxBytes }: { path: string; maxBytes: number }) => {
        const content = resources[path];
        if (content === undefined) throw objectError("ENOENT");
        const bytes = new TextEncoder().encode(content);
        if (bytes.byteLength > maxBytes) throw objectError("EFBIG");
        return bytes;
      },
    });
  }

  async readText(path: string, maxBytes: number): Promise<string> {
    this.readCalls += 1;
    this.readPaths.push(path);
    if (this.readError !== undefined) throw this.readError;
    if (this.directories.has(path)) throw objectError("EISDIR");
    const content = this.files.get(path);
    if (content === undefined) throw objectError("ENOENT");
    if (Buffer.byteLength(content, "utf8") > maxBytes) throw objectError("EFBIG");
    return content;
  }

  async ensureDirectory(path: string): Promise<"created" | "existing"> {
    this.record(`ensure-directory:${path}`);
    if (this.symlinks.has(path)) throw objectError("ELOOP");
    if (this.files.has(path)) throw objectError("ENOTDIR");
    if (this.directories.has(path)) return "existing";
    this.directories.add(path);
    return "created";
  }

  async syncDirectory(path: string): Promise<void> {
    this.record(`sync-directory:${path}`);
    if (!this.directories.has(path)) throw objectError("ENOENT");
  }

  async createExclusive(path: string): Promise<CliWritableFile> {
    this.createCalls += 1;
    this.record(`create:${path}`);
    if (this.files.has(path) || this.directories.has(path) || this.symlinks.has(path)) {
      throw objectError("EEXIST");
    }
    const parent = dirname(path);
    if (this.files.has(parent)) throw objectError("ENOTDIR");
    if (!this.directories.has(parent)) throw objectError("ENOENT");
    this.files.set(path, "");
    let closed = false;
    return {
      write: async (content) => {
        if (closed) throw new Error("closed");
        this.record(`write:${path}`);
        this.files.set(path, content);
      },
      sync: async () => {
        this.record(`sync-file:${path}`);
        if (this.replaceDuringSync) {
          this.files.set(path, "replacement owned by another actor");
          throw new Error("sync failed after replacement");
        }
      },
      close: async () => {
        this.record(`close:${path}`);
        closed = true;
      },
      syncParentDirectory: async () => {
        await this.syncDirectory(dirname(path));
      },
    };
  }

  private record(operation: string): void {
    this.operations.push(operation);
    if (this.failAt === operation) throw objectError(this.failureCode);
  }
}

function objectError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
