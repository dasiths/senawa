import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CliDependencies } from "./cli.js";

export function createNodeCliDependencies(): CliDependencies {
  return {
    sha256: {
      digest(bytes) {
        return createHash("sha256").update(bytes).digest("hex");
      },
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
          if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8");
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

function filesystemError(code: "EFBIG" | "EISDIR" | "ELOOP" | "ENOTDIR"): Error {
  return Object.assign(new Error(code), { code });
}
