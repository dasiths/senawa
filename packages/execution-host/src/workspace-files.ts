import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("../dist/senawa-workspace-files", import.meta.url));

export const WORKSPACE_FILE_LIMITS = Object.freeze({
  maxFileBytes: 1_048_576,
  maxListEntries: 1_000,
  maxPatchChanges: 1,
});

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly size: number;
}

export interface WorkspaceFilePatchChange {
  readonly path: string;
  readonly expectedText: string;
  readonly replacementText: string;
}

export interface WorkspaceFilePort {
  readonly root: string;
  list(path: string, maxEntries?: number): Promise<readonly WorkspaceFileEntry[]>;
  read(path: string, maxBytes?: number): Promise<string>;
  write(path: string, content: string): Promise<void>;
  applyPatch(changes: readonly WorkspaceFilePatchChange[]): Promise<void>;
}

export interface WorkspaceFileTestHooks {
  beforeCommit?(): Promise<void> | void;
}

export class RootScopedWorkspaceFiles implements WorkspaceFilePort {
  readonly root: string;
  readonly #testHooks: WorkspaceFileTestHooks;
  #operation: Promise<void> = Promise.resolve();

  private constructor(root: string, testHooks: WorkspaceFileTestHooks) {
    this.root = root;
    this.#testHooks = testHooks;
  }

  static async create(
    root: string,
    options: { readonly testHooks?: WorkspaceFileTestHooks } = {},
  ): Promise<RootScopedWorkspaceFiles> {
    const canonical = await realpath(root);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new WorkspaceFileError("Workspace root must be a directory");
    return new RootScopedWorkspaceFiles(canonical, options.testHooks ?? {});
  }

  async list(path: string, maxEntries: number = WORKSPACE_FILE_LIMITS.maxListEntries) {
    if (!boundedInteger(maxEntries, WORKSPACE_FILE_LIMITS.maxListEntries)) {
      throw new WorkspaceFileError("Workspace list bound is invalid");
    }
    const relativePath = validateRelativePath(path, true);
    return this.#serialized(async () => {
      const output = await runHelper(this.root, ["list", relativePath, String(maxEntries)]);
      const prefix = relativePath === "." ? "" : `${relativePath}/`;
      const entries = output
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line): WorkspaceFileEntry => {
          const [hexName, rawType, rawSize] = line.split("\t");
          if (hexName === undefined || rawType === undefined || rawSize === undefined) {
            throw new WorkspaceFileError("Workspace helper returned an invalid list record");
          }
          const name = decodeUtf8(Buffer.from(hexName, "hex"));
          const type =
            rawType === "f"
              ? "file"
              : rawType === "d"
                ? "directory"
                : rawType === "l"
                  ? "symlink"
                  : undefined;
          const size = Number(rawSize);
          if (type === undefined || !Number.isSafeInteger(size) || size < 0) {
            throw new WorkspaceFileError("Workspace helper returned invalid list metadata");
          }
          return Object.freeze({ path: `${prefix}${name}`, type, size });
        });
      return Object.freeze(entries.sort((left, right) => lexical(left.path, right.path)));
    });
  }

  async read(path: string, maxBytes: number = WORKSPACE_FILE_LIMITS.maxFileBytes): Promise<string> {
    if (!boundedInteger(maxBytes, WORKSPACE_FILE_LIMITS.maxFileBytes)) {
      throw new WorkspaceFileError("Workspace read bound is invalid");
    }
    const relativePath = validateRelativePath(path, false);
    return this.#serialized(async () =>
      decodeUtf8(await runHelper(this.root, ["read", relativePath, String(maxBytes)])),
    );
  }

  async write(path: string, content: string): Promise<void> {
    if (typeof content !== "string" || content.includes("\0")) {
      throw new WorkspaceFileError("Workspace content must be NUL-free text");
    }
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > WORKSPACE_FILE_LIMITS.maxFileBytes) {
      throw new WorkspaceFileError("Workspace content exceeds its write bound");
    }
    const relativePath = validateRelativePath(path, false);
    await this.#serialized(() =>
      runHelper(this.root, ["write", relativePath], bytes, this.#testHooks.beforeCommit).then(
        () => undefined,
      ),
    );
  }

  async applyPatch(changes: readonly WorkspaceFilePatchChange[]): Promise<void> {
    if (
      !Array.isArray(changes) ||
      changes.length === 0 ||
      changes.length > WORKSPACE_FILE_LIMITS.maxPatchChanges
    ) {
      throw new WorkspaceFileError("Workspace patch change count is invalid");
    }
    const [change] = changes;
    if (
      change === undefined ||
      change === null ||
      typeof change !== "object" ||
      typeof change.path !== "string" ||
      typeof change.expectedText !== "string" ||
      typeof change.replacementText !== "string"
    ) {
      throw new WorkspaceFileError("Workspace patch change is invalid");
    }
    const path = validateRelativePath(change.path, false);
    const expected = boundedText(change.expectedText, "expected text");
    const replacement = boundedText(change.replacementText, "replacement text");
    const frame = Buffer.concat([
      Buffer.from(`${expected.byteLength}\n`, "ascii"),
      expected,
      replacement,
    ]);
    await this.#serialized(() =>
      runHelper(
        this.root,
        ["patch", path, String(WORKSPACE_FILE_LIMITS.maxFileBytes)],
        frame,
        this.#testHooks.beforeCommit,
      ).then(() => undefined),
    );
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class WorkspaceFileError extends Error {
  /**
   * Whether the path simply is not there.
   *
   * An agent exploring a fresh workspace reads files that do not exist yet, and
   * reporting that as a refusal told it that it lacked permission. One stopped
   * and asked a person why every workspace operation was being denied, when the
   * answer was that it had guessed a filename.
   */
  readonly missing: boolean;

  constructor(message: string, missing = false) {
    super(message);
    this.name = "WorkspaceFileError";
    this.missing = missing;
  }
}

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRelativePath(path: string, allowRoot: boolean): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").includes("..") ||
    (!allowRoot && path === ".")
  ) {
    throw new WorkspaceFileError("Workspace path must be relative and cannot traverse parents");
  }
  return path;
}

function boundedText(value: string, label: string): Buffer {
  if (value.includes("\0")) throw new WorkspaceFileError(`Workspace ${label} must be NUL-free`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > WORKSPACE_FILE_LIMITS.maxFileBytes) {
    throw new WorkspaceFileError(`Workspace ${label} exceeds its bound`);
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceFileError("Workspace file name or content is not valid UTF-8");
  }
}

function runHelper(
  root: string,
  args: readonly string[],
  input: Uint8Array = new Uint8Array(),
  beforeCommit?: () => Promise<void> | void,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(helperPath, [args[0] ?? "", root, ...args.slice(1)], {
      env:
        beforeCommit === undefined
          ? { PATH: process.env.PATH }
          : { PATH: process.env.PATH, SENAWA_WORKSPACE_FAIL_BEFORE_RENAME: "1" },
      stdio: ["pipe", "pipe", "pipe", beforeCommit === undefined ? "ignore" : "pipe"],
    });
    const stdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (stdin === null || childStdout === null || childStderr === null) {
      child.kill();
      reject(new WorkspaceFileError("Workspace helper pipes are unavailable"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let hookError: unknown;
    childStdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    childStderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const control = child.stdio[3] as Duplex | null | undefined;
    if (beforeCommit !== undefined && control !== null && control !== undefined) {
      control.once("data", () => {
        Promise.resolve(beforeCommit()).then(
          () => control.write(Buffer.from([1])),
          (error) => {
            hookError = error;
            control.write(Buffer.from([1]));
          },
        );
      });
    }
    child.once("error", reject);
    stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("close", (code, signal) => {
      if (hookError !== undefined) {
        reject(hookError);
        return;
      }
      if (code !== 0 || signal !== null) {
        const reported = Buffer.concat(stderr).toString("utf8").trim() || "Workspace helper failed";
        reject(
          new WorkspaceFileError(reported, /no such file or directory|ENOENT/iu.test(reported)),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
    stdin.end(input);
  });
}
