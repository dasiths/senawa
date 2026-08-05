import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import {
  IdentifierSchema as CoreIdentifierSchema,
  loadRepositoryDefinitions as loadThroughCore,
} from "@senawa/core";
import { IdentifierSchema } from "@senawa/domain";
import { describe, expect, it } from "vitest";

describe("core compatibility facade", () => {
  it("re-exports domain contracts and configuration loading", () => {
    expect(CoreIdentifierSchema).toBe(IdentifierSchema);
    expect(loadThroughCore).toBe(loadRepositoryDefinitions);
  });

  it("has no direct workspace importers outside the facade", async () => {
    const workspaceRoot = resolve(import.meta.dirname, "../../..");
    const sourceFiles = [
      ...(await collectTypeScriptFiles(resolve(workspaceRoot, "apps"))),
      ...(await collectTypeScriptFiles(resolve(workspaceRoot, "packages"))),
    ];
    const importers: string[] = [];

    for (const sourceFile of sourceFiles) {
      if (sourceFile.startsWith(resolve(workspaceRoot, "packages/core"))) continue;
      if ((await readFile(sourceFile, "utf8")).includes('from "@senawa/core')) {
        importers.push(sourceFile.slice(workspaceRoot.length + 1));
      }
    }

    expect(importers).toEqual([]);
  });
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
