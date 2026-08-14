import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const outputRoot = "dist";
const staticRoot = join(outputRoot, "static");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".woff2", "font/woff2"],
]);

export default defineConfig({
  base: "/portal/assets/",
  build: {
    outDir: staticRoot,
    emptyOutDir: true,
    assetsDir: "",
    rollupOptions: {
      output: {
        assetFileNames: "[name].[hash][extname]",
        chunkFileNames: "[name].[hash].js",
        entryFileNames: "[name].[hash].js",
      },
    },
  },
  plugins: [portalManifest()],
});

function portalManifest(): Plugin {
  return {
    name: "senawa-portal-manifest",
    apply: "build",
    async closeBundle() {
      const names = (await readdir(staticRoot)).sort();
      const assets = await Promise.all(
        names.map(async (name) => {
          const extension = extname(name);
          const contentType = contentTypes.get(extension);
          if (contentType === undefined || basename(name) !== name) {
            throw new Error(`Portal build emitted unsupported asset: ${name}`);
          }
          const bytes = await readFile(join(staticRoot, name));
          return {
            name,
            path: `static/${name}`,
            digest: createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.byteLength,
            contentType,
          };
        }),
      );
      if (!assets.some(({ name }) => name === "index.html")) {
        throw new Error("Portal build did not emit index.html");
      }
      await writeFile(
        join(outputRoot, "manifest.json"),
        canonicalJson({
          apiVersion: "senawa.dev/portal-assets/v1alpha1",
          shell: "index.html",
          assets,
        }),
      );
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
