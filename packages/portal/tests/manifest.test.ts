import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStringify } from "@senawa/protocol";
import { describe, expect, it } from "vitest";

describe("portal production manifest", () => {
  it("canonically covers every emitted static asset with exact bytes", () => {
    const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const manifestPath = resolve(packageRoot, "dist/manifest.json");
    const serialized = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(serialized) as {
      readonly apiVersion: string;
      readonly shell: string;
      readonly assets: readonly {
        readonly name: string;
        readonly path: string;
        readonly digest: string;
        readonly byteLength: number;
        readonly contentType: string;
      }[];
    };
    expect(serialized).toBe(canonicalStringify(manifest));
    expect(manifest.apiVersion).toBe("senawa.dev/portal-assets/v1alpha1");
    expect(manifest.shell).toBe("index.html");
    expect(manifest.assets.length).toBeGreaterThanOrEqual(3);
    for (const asset of manifest.assets) {
      const bytes = readFileSync(resolve(packageRoot, "dist", asset.path));
      expect(asset.name).toBe(asset.path.replace(/^static\//u, ""));
      expect(asset.byteLength).toBe(bytes.byteLength);
      expect(asset.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
});
