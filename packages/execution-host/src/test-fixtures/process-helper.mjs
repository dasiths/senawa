import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, ...arguments_] = process.argv.slice(2);

switch (mode) {
  case "argv":
    process.stdout.write(JSON.stringify(arguments_));
    break;
  case "env":
    process.stdout.write(JSON.stringify(process.env));
    break;
  case "output": {
    const bytes = Number(arguments_[0]);
    process.stdout.write(Buffer.alloc(bytes, "o"));
    process.stderr.write(Buffer.alloc(bytes, "e"));
    break;
  }
  case "euro":
    process.stdout.write("€");
    break;
  case "invalid-utf8":
    process.stdout.write(Buffer.from([0x61, 0xff, 0x62]));
    break;
  case "nonzero":
    process.exitCode = Number(arguments_[0]);
    break;
  case "signal":
    process.kill(process.pid, "SIGTERM");
    break;
  case "wait":
    setInterval(() => {}, 1_000);
    break;
  case "ignore-term":
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    break;
  case "tree-timeout":
  case "tree-exit": {
    const directory = arguments_[0];
    if (directory === undefined) throw new Error("Missing tree pid directory");
    spawn(process.execPath, [new URL(import.meta.url).pathname, "tree-child", directory], {
      stdio: "ignore",
    });
    if (mode === "tree-timeout") setInterval(() => {}, 1_000);
    else setTimeout(() => process.exit(0), 150);
    break;
  }
  case "tree-setsid": {
    const directory = arguments_[0];
    if (directory === undefined) throw new Error("Missing tree pid directory");
    spawn(process.execPath, [new URL(import.meta.url).pathname, "setsid-child", directory], {
      detached: true,
      stdio: "ignore",
    }).unref();
    setTimeout(() => process.exit(0), 150);
    break;
  }
  case "setsid-child": {
    const directory = arguments_[0];
    if (directory === undefined) throw new Error("Missing tree pid directory");
    writeFileSync(join(directory, "setsid.pid"), String(process.pid));
    setInterval(() => {}, 1_000);
    break;
  }
  case "tree-child": {
    const directory = arguments_[0];
    if (directory === undefined) throw new Error("Missing tree pid directory");
    writeFileSync(join(directory, "child.pid"), String(process.pid));
    spawn(process.execPath, [new URL(import.meta.url).pathname, "tree-grandchild", directory], {
      stdio: "ignore",
    });
    setInterval(() => {}, 1_000);
    break;
  }
  case "tree-grandchild": {
    const directory = arguments_[0];
    if (directory === undefined) throw new Error("Missing tree pid directory");
    writeFileSync(join(directory, "grandchild.pid"), String(process.pid));
    setInterval(() => {}, 1_000);
    break;
  }
  default:
    throw new Error(`Unknown helper mode: ${mode}`);
}