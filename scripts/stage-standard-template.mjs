import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthoredTemplateFiles } from "../packages/configuration/dist/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// The packaged tree has to be what `init` writes, or the two drift
// silently and a consumer's first project differs from the one shipped.
const files = createAuthoredTemplateFiles();

stagePackagedTemplate();

function stagePackagedTemplate() {
  const parent = join(root, "apps", "senawa", "dist");
  mkdirSync(parent, { recursive: true });
  const staging = writeStagingTree(parent);
  const destination = join(parent, "template");
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
}

function writeStagingTree(parent) {
  const staging = mkdtempSync(join(parent, ".senawa-template-stage-"));
  for (const [path, content] of Object.entries(files)) {
    const destination = join(staging, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const descriptor = openSync(destination, "r");
    try {
      closeSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }
  return staging;
}
