import { build } from "esbuild";

const banner = {
  js: [
    "#!/usr/bin/env node",
    'import { createRequire as __senawaCreateRequire } from "node:module";',
    "const require = __senawaCreateRequire(import.meta.url);",
  ].join("\n"),
};

await Promise.all([
  build({
    entryPoints: ["packages/cli/src/main.ts"],
    outfile: "packages/cli/dist/senawa.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner,
  }),
  build({
    entryPoints: ["packages/hook/src/main.ts"],
    outfile: "packages/hook/dist/senawa-hook.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner,
  }),
]);
