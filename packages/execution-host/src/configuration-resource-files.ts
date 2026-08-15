import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ConfigurationResourceReadError,
  type ConfigurationResourceReader,
  type ConfigurationResourceReadRequest,
  validateConfigurationResourcePath,
} from "@senawa/configuration";

const helperPath = fileURLToPath(new URL("../dist/senawa-workspace-files", import.meta.url));

export interface ConfigurationResourceFileTestHooks {
  beforeIdentityCheck?(): Promise<void> | void;
}

export class RootScopedConfigurationResources implements ConfigurationResourceReader {
  readonly root: string;
  readonly configurationDirectory: string;
  readonly #testHooks: ConfigurationResourceFileTestHooks;

  private constructor(
    root: string,
    configurationDirectory: string,
    testHooks: ConfigurationResourceFileTestHooks,
  ) {
    this.root = root;
    this.configurationDirectory = configurationDirectory;
    this.#testHooks = testHooks;
  }

  static async create(
    projectRoot: string,
    configurationDirectory = ".senawa",
    options: { readonly testHooks?: ConfigurationResourceFileTestHooks } = {},
  ): Promise<RootScopedConfigurationResources> {
    if (!isSafeRelativeDirectory(configurationDirectory)) {
      throw new ConfigurationResourceReadError("path-escape");
    }
    const projectMetadata = await lstat(projectRoot).catch(() => {
      throw new ConfigurationResourceReadError("not-found");
    });
    if (projectMetadata.isSymbolicLink()) throw new ConfigurationResourceReadError("symlink");
    const lexicalRoot =
      configurationDirectory === "." ? projectRoot : `${projectRoot}/${configurationDirectory}`;
    const lexicalMetadata = await lstat(lexicalRoot).catch(() => {
      throw new ConfigurationResourceReadError("not-found");
    });
    if (lexicalMetadata.isSymbolicLink()) throw new ConfigurationResourceReadError("symlink");
    const root = await realpath(projectRoot).catch(() => {
      throw new ConfigurationResourceReadError("not-found");
    });
    const metadata = await stat(root).catch(() => {
      throw new ConfigurationResourceReadError("read-failed");
    });
    if (!metadata.isDirectory()) throw new ConfigurationResourceReadError("not-regular-file");
    return new RootScopedConfigurationResources(
      root,
      configurationDirectory,
      options.testHooks ?? {},
    );
  }

  async read(request: ConfigurationResourceReadRequest): Promise<Uint8Array> {
    const path = validateConfigurationResourcePath(request.kind, request.path);
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > 256 * 1_024
    ) {
      throw new ConfigurationResourceReadError("too-large");
    }
    const relativePath =
      this.configurationDirectory === "." ? path : `${this.configurationDirectory}/${path}`;
    try {
      return Uint8Array.from(
        await runStableRead(
          this.root,
          relativePath,
          request.maxBytes,
          this.#testHooks.beforeIdentityCheck,
        ),
      );
    } catch (error) {
      if (error instanceof ConfigurationResourceReadError) throw error;
      throw new ConfigurationResourceReadError("read-failed");
    }
  }
}

function runStableRead(
  root: string,
  path: string,
  maxBytes: number,
  beforeIdentityCheck?: () => Promise<void> | void,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(helperPath, ["stable-read", root, path, String(maxBytes)], {
      env:
        beforeIdentityCheck === undefined
          ? { PATH: process.env.PATH }
          : { PATH: process.env.PATH, SENAWA_WORKSPACE_FAIL_BEFORE_RENAME: "1" },
      stdio: ["ignore", "pipe", "pipe", beforeIdentityCheck === undefined ? "ignore" : "pipe"],
    });
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      reject(new ConfigurationResourceReadError("read-failed"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let hookError: unknown;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const control = child.stdio[3] as Duplex | null | undefined;
    if (beforeIdentityCheck !== undefined && control !== null && control !== undefined) {
      control.once("data", () => {
        Promise.resolve(beforeIdentityCheck()).then(
          () => control.write(Buffer.from([1])),
          (error) => {
            hookError = error;
            control.write(Buffer.from([1]));
          },
        );
      });
    }
    child.once("error", () => reject(new ConfigurationResourceReadError("read-failed")));
    child.once("close", (code, signal) => {
      if (hookError !== undefined) {
        reject(hookError);
        return;
      }
      if (code !== 0 || signal !== null) {
        reject(
          new ConfigurationResourceReadError(
            classifyFailure(Buffer.concat(stderr).toString("utf8")),
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
  });
}

function classifyFailure(
  message: string,
): ConstructorParameters<typeof ConfigurationResourceReadError>[0] {
  if (message.includes("multiple hard links")) return "hardlink";
  if (message.includes("not a regular file") || message.includes("Is a directory"))
    return "not-regular-file";
  if (message.includes("exceeds bound") || message.includes("File too large")) return "too-large";
  if (message.includes("changed") || message.includes("Stale file handle"))
    return "changed-during-read";
  if (message.includes("Too many levels of symbolic links")) return "symlink";
  if (message.includes("Invalid cross-device link")) return "path-escape";
  if (message.includes("No such file or directory")) return "not-found";
  if (message.includes("Permission denied") || message.includes("Operation not permitted")) {
    return "permission-denied";
  }
  return "read-failed";
}

function isSafeRelativeDirectory(path: string): boolean {
  if (path === ".") return true;
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment) && segment !== "." && segment !== "..")
  );
}
