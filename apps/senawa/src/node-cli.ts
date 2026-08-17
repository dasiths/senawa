import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadAuthoredWorkflow, RootScopedConfigurationResources } from "@senawa/execution-host";
import type { CliDependencies } from "./cli.js";

export function createNodeCliDependencies(): CliDependencies {
  return {
    sha256: {
      digest(bytes) {
        return createHash("sha256").update(bytes).digest("hex");
      },
    },
    createResourceReader(workflowPath) {
      return RootScopedConfigurationResources.create(dirname(resolve(workflowPath)), ".");
    },
    publishTemplate,
    checkAuthored(projectRoot) {
      return loadAuthoredWorkflow(projectRoot, {
        digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
      });
    },
    async readText(path, maxBytes) {
      if ((await realpath(path)) !== resolve(path)) throw filesystemError("ELOOP");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw filesystemError("EISDIR");
        if (metadata.size > maxBytes) throw filesystemError("EFBIG");
        const chunks: Buffer[] = [];
        let total = 0;
        while (total <= maxBytes) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
          if (bytesRead === 0) return decodeUtf8(Buffer.concat(chunks, total));
          total += bytesRead;
          chunks.push(chunk.subarray(0, bytesRead));
        }
        throw filesystemError("EFBIG");
      } finally {
        await handle.close();
      }
    },
    async ensureDirectory(path) {
      try {
        await mkdir(path);
        return "created";
      } catch (error) {
        if (filesystemCode(error) !== "EEXIST") throw error;
      }

      const status = await lstat(path);
      if (status.isSymbolicLink()) throw filesystemError("ELOOP");
      if (!status.isDirectory()) throw filesystemError("ENOTDIR");
      return "existing";
    },
    syncDirectory,
    async createExclusive(path) {
      const parent = dirname(resolve(path));
      if ((await realpath(parent)) !== parent) throw filesystemError("ELOOP");
      const handle = await open(path, "wx");
      return {
        write(content) {
          return handle.writeFile(content, "utf8");
        },
        sync() {
          return handle.sync();
        },
        close() {
          return handle.close();
        },
        syncParentDirectory() {
          return syncDirectory(dirname(path));
        },
      };
    },
  };
}

async function publishTemplate(
  projectRootInput: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const projectRoot = resolve(projectRootInput);
  if ((await realpath(projectRoot)) !== projectRoot) throw filesystemError("ELOOP");
  const destination = join(projectRoot, ".senawa");
  const lock = join(projectRoot, ".senawa.init.lock");
  let lockIdentity: FileIdentity | undefined;
  let staging: string | undefined;
  let stagingIdentity: FileIdentity | undefined;
  let published = false;
  try {
    await mkdir(lock);
    lockIdentity = await identity(lock);
    await requireAbsent(destination);
    staging = await mkdtemp(join(projectRoot, ".senawa.init-"));
    stagingIdentity = await identity(staging);

    const directories = new Set<string>([staging]);
    for (const [templatePath, content] of Object.entries(files).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const prefix = `.senawa/`;
      if (!templatePath.startsWith(prefix)) throw filesystemError("EPERM");
      const relativePath = templatePath.slice(prefix.length);
      const path = resolve(staging, relativePath);
      if (!path.startsWith(`${staging}${sep}`) || relative(staging, path).startsWith("..")) {
        throw filesystemError("EPERM");
      }
      const parent = dirname(path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      collectDirectories(staging, parent, directories);
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await syncDirectory(directory);
    }
    await requireAbsent(destination);
    await rename(staging, destination);
    published = true;
    staging = undefined;
    await syncDirectory(projectRoot);
  } finally {
    if (!published && staging !== undefined && stagingIdentity !== undefined) {
      await removeIfIdentityMatches(staging, stagingIdentity, true);
    }
    if (lockIdentity !== undefined) await removeIfIdentityMatches(lock, lockIdentity, false);
    await syncDirectory(projectRoot).catch(() => undefined);
  }
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

async function identity(path: string): Promise<FileIdentity> {
  const status = await lstat(path, { bigint: true });
  return { device: status.dev, inode: status.ino };
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return;
    throw error;
  }
  throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
}

function collectDirectories(root: string, leaf: string, output: Set<string>): void {
  for (let current = leaf; current.startsWith(root); current = dirname(current)) {
    output.add(current);
    if (current === root) return;
  }
}

async function removeIfIdentityMatches(
  path: string,
  expected: FileIdentity,
  recursive: boolean,
): Promise<void> {
  let current: FileIdentity;
  try {
    current = await identity(path);
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return;
    throw error;
  }
  if (current.device !== expected.device || current.inode !== expected.inode) return;
  if (recursive) await rm(path, { recursive: true, force: false });
  else await rmdir(path);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(text);
    if (
      encoded.byteLength !== bytes.byteLength ||
      encoded.some((byte, index) => byte !== bytes[index])
    ) {
      throw new Error("round trip mismatch");
    }
    return text;
  } catch {
    throw Object.assign(new Error("Invalid UTF-8"), { code: "EILSEQ" });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function filesystemCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function filesystemError(code: "EFBIG" | "EISDIR" | "ELOOP" | "ENOTDIR" | "EPERM"): Error {
  return Object.assign(new Error(code), { code });
}
