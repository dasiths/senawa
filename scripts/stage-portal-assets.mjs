import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../packages/portal/dist", import.meta.url));
const destination = fileURLToPath(new URL("../apps/senawa/dist/portal", import.meta.url));

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true, errorOnExist: true });
