import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const forbiddenImports = [/^node:/u, /^ajv(?:\/|$)/u, /^yaml$/u, /^@senawa\/(?!domain$)/u];

describe("domain package boundary", () => {
  it("keeps production source free of host and adapter dependencies", async () => {
    const sourceDirectory = resolve(import.meta.dirname);
    const sourceFiles = (await readdir(sourceDirectory))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort();
    const violations: string[] = [];

    for (const sourceFile of sourceFiles) {
      const source = await readFile(resolve(sourceDirectory, sourceFile), "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)) {
        const specifier = match[1];
        if (
          specifier !== undefined &&
          forbiddenImports.some((pattern) => pattern.test(specifier))
        ) {
          violations.push(`${sourceFile}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
