import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliDependencies } from "./cli.js";

export function createNodeCliDependencies(): CliDependencies {
  return {
    sha256: {
      digest(bytes) {
        return createHash("sha256").update(bytes).digest("hex");
      },
    },
    readText(path) {
      return readFile(path, "utf8");
    },
    async createExclusive(path) {
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
        async syncParentDirectory() {
          const directory = await open(dirname(path), "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        },
      };
    },
  };
}
