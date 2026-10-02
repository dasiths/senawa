import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    `senawa-process-supervisor supports only Linux x64/glibc alpha builds (received ${process.platform} ${process.arch})`,
  );
}
const runtimeReport = process.report?.getReport();
if (typeof runtimeReport?.header.glibcVersionRuntime !== "string") {
  throw new Error("senawa-process-supervisor alpha builds require Linux x64 with glibc");
}

const root = new URL("../", import.meta.url);
mkdirSync(fileURLToPath(new URL("packages/execution-host/dist/", root)), { recursive: true });

for (const name of ["senawa-process-supervisor", "senawa-workspace-files"]) {
  const source = fileURLToPath(new URL(`packages/execution-host/native/${name}.c`, root));
  const output = fileURLToPath(new URL(`packages/execution-host/dist/${name}`, root));
  const compiler = spawnSync(
    "cc",
    [
      "-std=c17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      "-fPIE",
      "-pie",
      "-fstack-protector-strong",
      "-D_FORTIFY_SOURCE=2",
      "-Wl,-z,relro",
      "-Wl,-z,now",
      source,
      "-o",
      output,
    ],
    { encoding: "utf8" },
  );

  if (compiler.error?.code === "ENOENT") {
    throw new Error(
      "Building @senawa/execution-host requires a C17 compiler available as `cc`; no runtime compilation is performed.",
    );
  }
  if (compiler.error !== undefined) throw compiler.error;
  if (compiler.status !== 0) {
    process.stderr.write(compiler.stdout);
    process.stderr.write(compiler.stderr);
    throw new Error(`Failed to build ${name} with cc (exit ${compiler.status})`);
  }
  chmodSync(output, 0o755);
}
