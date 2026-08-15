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
import { createStandardTemplateFiles } from "../packages/configuration/dist/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = createStandardTemplateFiles();

stagePackagedTemplate();
if (process.argv.includes("--tracked")) regenerateTrackedTemplate();

function stagePackagedTemplate() {
  const parent = join(root, "apps", "senawa", "dist");
  mkdirSync(parent, { recursive: true });
  const staging = writeStagingTree(parent);
  const destination = join(parent, "template");
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
}

function regenerateTrackedTemplate() {
  const staging = writeStagingTree(root);
  const destination = join(root, ".senawa");
  rmSync(destination, { recursive: true, force: true });
  renameSync(join(staging, ".senawa"), destination);
  rmSync(staging, { recursive: true, force: true });
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
