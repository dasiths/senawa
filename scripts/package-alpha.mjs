import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSecretSafePositiveProjection } from "../packages/reporting/dist/index.js";
import { assertReleaseFileSecretSafe } from "./release-secret-scanner.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "dist", "alpha");
const packageOutput = join(output, "packages");
const stagingOutput = join(output, ".staging");
const npmCache = join(output, ".npm-cache");
const version = "0.1.0-alpha.0";
const packages = [
  ["@senawa/protocol", "packages/protocol"],
  ["@senawa/kernel", "packages/kernel"],
  ["@senawa/runtime", "packages/runtime"],
  ["@senawa/configuration", "packages/configuration"],
  ["@senawa/execution-host", "packages/execution-host"],
  ["@senawa/storage-sqlite", "packages/storage-sqlite"],
  ["@senawa/reporting", "packages/reporting"],
  ["@senawa/supervisor", "packages/supervisor"],
  ["senawa", "apps/senawa"],
];

assertPlatform();
run("pnpm", ["build"]);
rmSync(output, { recursive: true, force: true });
mkdirSync(packageOutput, { recursive: true });
mkdirSync(stagingOutput, { recursive: true });
mkdirSync(npmCache, { recursive: true });

const records = [];
for (const [name, directory] of packages) {
  const stagingDirectory = stagePackage(name, directory);
  const [packed] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", packageOutput], stagingDirectory),
  );
  const filename = basename(packed.filename);
  const path = join(packageOutput, filename);
  const inventory = inspectTarball(path, name);
  records.push({
    name,
    version,
    filename,
    byteLength: statSync(path).size,
    sha256: digest(readFileSync(path)),
    files: inventory,
    source: directory,
  });
}
rmSync(stagingOutput, { recursive: true, force: true });
rmSync(npmCache, { recursive: true, force: true });

const dependencies = Object.fromEntries(
  records.map(({ name, filename }) => [name, `file:./packages/${filename}`]),
);
writeFileSync(
  join(output, "package.json"),
  `${JSON.stringify(
    {
      name: "senawa-alpha-install",
      version,
      private: true,
      engines: { node: ">=22.12.0" },
      dependencies,
    },
    undefined,
    2,
  )}\n`,
);
const manifest = {
  apiVersion: "senawa.dev/alpha-bundle/v1alpha1",
  version,
  platform: { os: "linux", cpu: "x64", libc: "glibc", minimumGlibc: "2.34" },
  packages: records,
};
const manifestText = `${JSON.stringify(manifest, undefined, 2)}\n`;
assertSecretSafePositiveProjection(manifestText, "Alpha package inventory");
writeFileSync(join(output, "manifest.json"), manifestText);
process.stdout.write(`${JSON.stringify(manifest, undefined, 2)}\n`);

function stagePackage(name, directory) {
  const source = join(root, directory);
  const destination = join(stagingOutput, name.replaceAll("/", "__"));
  mkdirSync(destination, { recursive: true });
  for (const runtimePath of ["dist", "migrations"]) {
    const sourcePath = join(source, runtimePath);
    if (existsSync(sourcePath)) {
      cpSync(sourcePath, join(destination, runtimePath), { recursive: true, errorOnExist: true });
    }
  }
  if (name === "senawa") {
    chmodSync(join(destination, "dist", "main.js"), 0o755);
    chmodSync(join(destination, "dist", "main-service.js"), 0o755);
  }
  const sourceManifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const releaseManifest = {
    ...sourceManifest,
    dependencies: exactDependencies(sourceManifest.dependencies),
    devDependencies: undefined,
    ...(name === "@senawa/execution-host"
      ? { peerDependencies: undefined, peerDependenciesMeta: undefined }
      : {}),
    scripts: undefined,
  };
  writeFileSync(
    join(destination, "package.json"),
    `${JSON.stringify(sortJson(releaseManifest), undefined, 2)}\n`,
  );
  return destination;
}

function exactDependencies(dependencies) {
  if (dependencies === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, dependencyVersion]) => [
      name,
      dependencyVersion === "workspace:*" ? version : dependencyVersion,
    ]),
  );
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function inspectTarball(tarball, expectedName) {
  const temporary = mkdtempSync(join(tmpdir(), "senawa-pack-inspect-"));
  try {
    run("tar", ["-xzf", tarball, "-C", temporary]);
    const packageRoot = join(temporary, "package");
    const packageManifestText = readFileSync(join(packageRoot, "package.json"), "utf8");
    assertSecretSafePositiveProjection(packageManifestText, `${expectedName} package manifest`);
    const manifest = JSON.parse(packageManifestText);
    if (manifest.name !== expectedName || manifest.version !== version) {
      throw new Error(`Packed identity mismatch for ${expectedName}`);
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [dependency, dependencyVersion] of Object.entries(manifest[field] ?? {})) {
        if (dependency.startsWith("@senawa/") && dependencyVersion !== version) {
          throw new Error(`${expectedName} has non-exact internal dependency ${dependency}`);
        }
      }
    }
    const files = walk(packageRoot);
    for (const file of files) {
      assertAllowed(file, expectedName);
      assertReleaseFileSecretSafe(readFileSync(join(packageRoot, file)), file, [
        root,
        stagingOutput,
      ]);
    }
    if (expectedName === "senawa") {
      assertMetadata(manifest);
      if (
        Object.keys(manifest.bin ?? {}).join(",") !== "senawa" ||
        manifest.bin.senawa !== "./dist/main.js"
      ) {
        throw new Error("senawa package must expose only the supported senawa bin");
      }
      assertExecutable(join(packageRoot, "dist", "main.js"), "#!/usr/bin/env node");
      assertExecutable(join(packageRoot, "dist", "main-service.js"), "#!/usr/bin/env node");
      if (!files.includes("dist/portal/manifest.json")) {
        throw new Error("senawa tarball is missing the packaged portal manifest");
      }
      if (!files.includes("dist/template/.senawa/workflow.json")) {
        throw new Error("senawa tarball is missing the packaged standard workflow template");
      }
    }
    if (expectedName === "@senawa/execution-host") {
      for (const name of ["senawa-process-supervisor", "senawa-workspace-files"]) {
        const helper = join(packageRoot, "dist", name);
        assertExecutable(helper);
        assertLinuxX64GlibcHelper(helper);
      }
    }
    if (expectedName === "@senawa/storage-sqlite") {
      const migrations = files.filter((path) => path.startsWith("migrations/"));
      if (
        migrations.length === 0 ||
        migrations.some((path) => !/^migrations\/\d{3}-[a-z0-9-]+\.sql$/u.test(path))
      ) {
        throw new Error("storage tarball has an invalid migration inventory");
      }
    }
    return files;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function walk(directory, prefix = "") {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const status = lstatSync(path);
    if (status.isSymbolicLink())
      throw new Error(`Package inventory contains symlink ${relativePath}`);
    if (status.isDirectory()) files.push(...walk(path, relativePath));
    else if (status.isFile()) files.push(relativePath);
    else throw new Error(`Package inventory contains special file ${relativePath}`);
  }
  return files;
}

function assertAllowed(path, packageName) {
  const forbidden =
    /(^|\/)(?:src|tests?|fixtures?|\.copilot-tracking|node_modules|coverage|\.cache)(?:\/|$)|(^|\/)[^/]*fixture[^/]*$|(?:\.map|\.tsbuildinfo|\.env|\.pem|\.key|credentials?)$/iu;
  if (forbidden.test(path)) throw new Error(`${packageName} contains forbidden path ${path}`);
  if (path !== "package.json" && !path.startsWith("dist/") && !path.startsWith("migrations/")) {
    throw new Error(`${packageName} contains unexpected path ${path}`);
  }
}

function assertMetadata(manifest) {
  if (
    manifest.engines?.node !== ">=22.12.0" ||
    manifest.os?.join(",") !== "linux" ||
    manifest.cpu?.join(",") !== "x64" ||
    manifest.libc?.join(",") !== "glibc"
  ) {
    throw new Error("senawa package platform metadata is incomplete");
  }
}

function assertExecutable(path, shebang) {
  if ((statSync(path).mode & 0o111) === 0)
    throw new Error(`${relative(root, path)} is not executable`);
  if (shebang !== undefined && !readFileSync(path, "utf8").startsWith(`${shebang}\n`)) {
    throw new Error(`${relative(root, path)} has an invalid shebang`);
  }
}

function assertLinuxX64GlibcHelper(path) {
  const bytes = readFileSync(path);
  if (
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  ) {
    throw new Error(`${relative(root, path)} is not a Linux x64 ELF executable`);
  }
  const versions = [...bytes.toString("latin1").matchAll(/GLIBC_(\d+)\.(\d+)/gu)].map(
    ([, major, minor]) => [Number(major), Number(minor)],
  );
  if (
    versions.length === 0 ||
    versions.some(([major, minor]) => major > 2 || (major === 2 && minor > 34))
  ) {
    throw new Error(`${relative(root, path)} exceeds the glibc 2.34 baseline`);
  }
}

function assertPlatform() {
  const report = process.report?.getReport();
  const glibc = report?.header.glibcVersionRuntime;
  if (process.platform !== "linux" || process.arch !== "x64" || typeof glibc !== "string") {
    throw new Error("Alpha packaging supports only Linux x64 with glibc");
  }
  const [major, minor] = glibc.split(".").map(Number);
  if (major < 2 || (major === 2 && minor < 34))
    throw new Error("Alpha packaging requires glibc 2.34+");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...(command === "npm"
        ? { npm_config_cache: npmCache, npm_config_update_notifier: "false" }
        : {}),
    },
  });
  if (result.error !== undefined) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${command} exceeded the 600000ms packaging command timeout`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}
