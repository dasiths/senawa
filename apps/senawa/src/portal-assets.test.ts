import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalStringify } from "@senawa/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPortalAssetSource,
  MAX_PORTAL_MANIFEST_BYTES,
  MAX_PORTAL_STATIC_BYTES,
  optionalPortalAssetSource,
} from "./portal-assets.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("portal asset manifest", () => {
  it("loads the generated portal package output through the production verifier", () => {
    const manifestPath = resolve("packages/portal/dist/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      readonly shell: string;
      readonly assets: readonly { readonly name: string }[];
    };
    const source = loadPortalAssetSource(manifestPath);
    expect(Buffer.from(source.shell()?.bytes ?? []).toString()).toContain("/portal/assets/");
    for (const asset of manifest.assets) {
      if (asset.name !== manifest.shell) expect(source.asset(asset.name)).toBeDefined();
    }
    expect(optionalPortalAssetSource({})?.shell()?.name).toBe(manifest.shell);
  });

  it("loads only exact verified manifest assets into memory", () => {
    const root = sandbox();
    const shell = Buffer.from("<!doctype html><script src=/portal/assets/app.abc123.js></script>");
    const script = Buffer.from("console.log('portal');");
    writeFileSync(join(root, "index.html"), shell);
    writeFileSync(join(root, "app.abc123.js"), script);
    writeFileSync(join(root, "unmanifested.js"), "not served");
    const manifestPath = writeManifest(root, [
      entry("index.html", "index.html", shell, "text/html; charset=utf-8"),
      entry("app.abc123.js", "app.abc123.js", script, "text/javascript; charset=utf-8"),
    ]);

    const source = loadPortalAssetSource(manifestPath);
    expect(Buffer.from(source.shell()?.bytes ?? []).toString()).toContain("<!doctype html>");
    expect(Buffer.from(source.asset("app.abc123.js")?.bytes ?? []).toString()).toBe(
      "console.log('portal');",
    );
    expect(source.asset("index.html")).toBeUndefined();
    expect(source.asset("unmanifested.js")).toBeUndefined();
  });

  it("rejects symlinks, digest drift, traversal, and unknown content types", () => {
    const root = sandbox();
    const shell = Buffer.from("<!doctype html>");
    writeFileSync(join(root, "index.html"), shell);
    writeFileSync(join(root, "outside.js"), "outside");
    symlinkSync(join(root, "outside.js"), join(root, "linked.js"));

    expect(() =>
      loadPortalAssetSource(
        writeManifest(root, [
          entry("index.html", "index.html", shell, "text/html; charset=utf-8"),
          entry("linked.js", "linked.js", Buffer.from("outside"), "text/javascript; charset=utf-8"),
        ]),
      ),
    ).toThrow(/symlink|regular file/);

    expect(() =>
      loadPortalAssetSource(
        writeManifest(root, [
          {
            ...entry("index.html", "index.html", shell, "text/html; charset=utf-8"),
            digest: "f".repeat(64),
          },
        ]),
      ),
    ).toThrow("do not match");

    expect(() =>
      loadPortalAssetSource(
        writeManifest(root, [
          entry("index.html", "../index.html", shell, "text/html; charset=utf-8"),
        ]),
      ),
    ).toThrow("path is invalid");

    expect(
      optionalPortalAssetSource({ SENAWA_PORTAL_MANIFEST: join(root, "missing.json") }),
    ).toBeUndefined();
  });

  it("rejects a declared static aggregate above 64 MiB before reading assets", () => {
    const root = sandbox();
    const shell = Buffer.from("<!doctype html>");
    writeFileSync(join(root, "index.html"), shell);
    const oversized = Array.from({ length: 5 }, (_, index) => ({
      ...entry(
        index === 0 ? "index.html" : `asset-${index}.js`,
        index === 0 ? "index.html" : `asset-${index}.js`,
        shell,
        index === 0 ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      ),
      byteLength: index === 4 ? 1 : MAX_PORTAL_STATIC_BYTES / 4,
    }));
    expect(() => loadPortalAssetSource(writeManifest(root, oversized))).toThrow(
      "aggregate byte length",
    );
  });

  it("bounds the manifest before allocation and detects growth while reading", () => {
    const root = sandbox();
    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, "x".repeat(MAX_PORTAL_MANIFEST_BYTES + 1));
    expect(() => loadPortalAssetSource(oversized)).toThrow("byte limit");

    const shell = Buffer.from("<!doctype html>");
    writeFileSync(join(root, "index.html"), shell);
    const growing = writeManifest(root, [
      entry("index.html", "index.html", shell, "text/html; charset=utf-8"),
    ]);
    expect(() =>
      loadPortalAssetSource(growing, {
        afterInitialStat(path) {
          appendFileSync(path, "x".repeat(MAX_PORTAL_MANIFEST_BYTES));
        },
      }),
    ).toThrow("byte limit");
  });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "senawa-portal-assets-"));
  roots.add(root);
  return root;
}

function entry(name: string, path: string, bytes: Uint8Array, contentType: string) {
  return {
    name,
    path,
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    contentType,
  };
}

function writeManifest(root: string, assets: readonly ReturnType<typeof entry>[]): string {
  const path = join(root, "manifest.json");
  writeFileSync(
    path,
    canonicalStringify({
      apiVersion: "senawa.dev/portal-assets/v1",
      shell: "index.html",
      assets,
    }),
  );
  return path;
}
