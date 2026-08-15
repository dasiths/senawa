import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseFileSecretSafe } from "./release-secret-scanner.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "senawa-packaging-"));
const commandTimeoutMs = 10 * 60_000;
let service;
let serviceDeadline;
try {
  assertHostileCredentialFixtureRejected();
  run("pnpm", ["package:alpha"], root);
  const firstManifest = readFileSync(join(root, "dist", "alpha", "manifest.json"), "utf8");
  run("pnpm", ["package:alpha"], root);
  assert(
    readFileSync(join(root, "dist", "alpha", "manifest.json"), "utf8") === firstManifest,
    "consecutive alpha package manifests differ",
  );
  const bundle = join(temporary, "bundle");
  cpSync(join(root, "dist", "alpha"), bundle, { recursive: true });
  const installOutput = run(
    "npm",
    ["install", "--ignore-scripts=false", "--no-audit", "--no-fund", "--loglevel=verbose"],
    bundle,
    {
      ...process.env,
      npm_config_cache: join(temporary, "npm-cache"),
      npm_config_update_notifier: "false",
    },
  );
  const nativeBuildEvidence = installOutput
    .split("\n")
    .filter((line) => /cmake|node-gyp|gyp info|building from source/iu.test(line));
  if (
    nativeBuildEvidence.some((line) => /gyp info|gyp ERR|cmake|building from source/iu.test(line))
  ) {
    throw new Error(
      `Core install attempted a native build fallback\n${nativeBuildEvidence.join("\n")}`,
    );
  }
  const liveDependencyEvidence = installOutput
    .split("\n")
    .filter((line) => /copilot-sdk|(?:^|[/@])koffi(?:[/@\s-]|$)/iu.test(line));
  if (liveDependencyEvidence.length > 0) {
    throw new Error(
      `Core install resolved the optional live-worker dependency graph\n${liveDependencyEvidence.join("\n")}`,
    );
  }

  const modules = join(bundle, "node_modules");
  if (existsSync(join(modules, "@github", "copilot-sdk")) || existsSync(join(modules, "koffi"))) {
    throw new Error("Core install contains the optional live-worker dependency graph");
  }
  assertInstalledTree(modules);
  verifyCleanTypeScriptConsumer(bundle);

  const bin = join(modules, ".bin", "senawa");
  const repository = join(temporary, "repository");
  mkdirSync(repository);
  const environment = {
    ...process.env,
    XDG_RUNTIME_DIR: join(temporary, "runtime"),
    XDG_STATE_HOME: join(temporary, "state"),
    SENAWA_PORTAL_PORT: "0",
  };
  for (const name of [
    "SENAWA_COPILOT_LIVE",
    "SENAWA_COPILOT_MODEL",
    "SENAWA_COPILOT_MAX_AI_CREDITS",
    "SENAWA_COPILOT_TIMEOUT_MS",
    "SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA",
    "SENAWA_REPOSITORY_DIR",
    "SENAWA_REMOTE_ENDPOINT",
    "SENAWA_REMOTE_KEY_FILE",
  ]) {
    delete environment[name];
  }
  run(bin, ["init"], repository, environment);
  assert(run(bin, ["doctor"], repository, environment).includes("valid"), "default doctor failed");
  const initializedTree = relativeFiles(join(repository, ".senawa"));
  const packagedTree = relativeFiles(join(modules, "senawa", "dist", "template", ".senawa"));
  const trackedTree = relativeFiles(join(root, ".senawa"));
  assert(
    JSON.stringify(initializedTree) === JSON.stringify(packagedTree),
    "installed init bytes differ from packaged template",
  );
  assert(
    JSON.stringify(initializedTree) === JSON.stringify(trackedTree),
    "installed init bytes differ from tracked template",
  );
  const original = readFileSync(join(repository, ".senawa", "workflow.json"), "utf8");
  const overwrite = runResult(bin, ["init"], repository, environment);
  assert(overwrite.status === 1 && overwrite.stdout.includes("already exists"), "init overwrote");
  assert(
    readFileSync(join(repository, ".senawa", "workflow.json"), "utf8") === original,
    "init changed existing file",
  );
  mkdirSync(join(repository, "explicit"));
  run(bin, ["init", "explicit"], repository, environment);
  assert(
    run(bin, ["doctor", "explicit"], repository, environment).includes("valid"),
    "explicit doctor failed",
  );
  assert(
    JSON.stringify(relativeFiles(join(repository, "explicit", ".senawa"))) ===
      JSON.stringify(initializedTree),
    "explicit init bytes differ from default init",
  );
  assert(
    run(bin, ["--version"], repository, environment).trim() === "0.1.0-alpha.0",
    "version failed",
  );
  assert(
    run(bin, ["service", "--help"], repository, environment).includes("service start|run"),
    "service help failed",
  );
  assert(
    run(bin, ["service", "--version"], repository, environment).trim() === "0.1.0-alpha.0",
    "service version failed",
  );
  assert(!existsSync(join(modules, ".bin", "senawa-service")), "unexpected service bin exists");

  service = spawn(bin, ["service", "run"], {
    cwd: repository,
    env: environment,
    stdio: "ignore",
  });
  serviceDeadline = setTimeout(() => service?.kill("SIGKILL"), 30_000);
  await waitForService(bin, repository, environment);
  const portalUrl = run(bin, ["portal"], repository, environment).trim();
  const bootstrap = await fetch(portalUrl, { redirect: "manual" });
  assert(bootstrap.status === 303, `portal bootstrap returned ${bootstrap.status}`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  const location = bootstrap.headers.get("location");
  assert(cookie !== undefined && location !== null, "portal bootstrap omitted session metadata");
  const response = await fetch(new URL(location, portalUrl), { headers: { cookie } });
  assert(response.ok, "packaged portal did not respond");
  const shell = await response.text();
  assert(shell.includes("/portal/assets/"), "packaged portal shell is invalid");
  run(bin, ["service", "stop"], repository, environment);
  await Promise.race([
    new Promise((resolveExit) => service.once("exit", resolveExit)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("service did not stop")), 5_000)),
  ]);
  service = undefined;
  clearTimeout(serviceDeadline);
  serviceDeadline = undefined;

  verifyPortalManifest(join(modules, "senawa", "dist", "portal"));
  assertExecutable(join(modules, "senawa", "dist", "main.js"), true);
  assertExecutable(join(modules, "senawa", "dist", "main-service.js"), true);
  assertExecutable(join(modules, "@senawa", "execution-host", "dist", "senawa-process-supervisor"));
  assertExecutable(join(modules, "@senawa", "execution-host", "dist", "senawa-workspace-files"));
  process.stdout.write(
    "Installed alpha packaging journey passed without live-worker or build-tool fallback.\n",
  );
} finally {
  if (serviceDeadline !== undefined) clearTimeout(serviceDeadline);
  if (service !== undefined) service.kill("SIGKILL");
  rmSync(temporary, { recursive: true, force: true });
}

function assertInstalledTree(modules) {
  const roots = [join(modules, "senawa"), join(modules, "@senawa")];
  for (const packageRoot of roots) {
    for (const path of walk(packageRoot)) {
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error(`Installed package uses workspace link ${path}`);
      if (status.isFile() && path.endsWith(".js")) {
        const content = readFileSync(path, "utf8");
        if (content.includes(root))
          throw new Error(`Installed JavaScript resolves through workspace ${path}`);
      }
    }
  }
}

function assertHostileCredentialFixtureRejected() {
  const credentialKey = ["pass", "word"].join("");
  const credentialValue = ["hostile", "embedded", "release", "fixture"].join("-");
  let rejected = false;
  try {
    assertReleaseFileSecretSafe(
      Buffer.from(JSON.stringify({ [credentialKey]: credentialValue })),
      "hostile-fixture.json",
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "release scanner accepted a hostile embedded credential fixture");
  rejected = false;
  try {
    const generatedJavaScript = `export const fixture = ${JSON.stringify(credentialValue)};\n`;
    assertReleaseFileSecretSafe(
      Buffer.from(generatedJavaScript),
      "hostile-fixture.js",
      [],
      [credentialValue],
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "release scanner accepted a hostile generated JavaScript credential literal");
}

function verifyCleanTypeScriptConsumer(bundle) {
  const consumer = join(temporary, "typescript consumer with spaces");
  mkdirSync(consumer);
  const bundleManifest = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8"));
  const dependencies = Object.fromEntries(
    Object.entries(bundleManifest.dependencies).map(([name, specifier]) => [
      name,
      `file:${join(bundle, specifier.slice("file:./".length))}`,
    ]),
  );
  const manifest = {
    name: "senawa-clean-typescript-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
    devDependencies: {
      "@types/node": "22.17.2",
      typescript: "5.8.3",
    },
  };
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["consumer.ts"],
    })}\n`,
  );
  writeFileSync(
    join(consumer, "consumer.ts"),
    'import { ProductionCopilotSdkPort } from "@senawa/execution-host";\nvoid ProductionCopilotSdkPort;\n',
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, {
    ...process.env,
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_update_notifier: "false",
  });
  assert(
    !existsSync(join(consumer, "node_modules", "@github", "copilot-sdk")),
    "clean TypeScript consumer installed the optional Copilot SDK",
  );
  run(join(consumer, "node_modules", ".bin", "tsc"), ["--project", "tsconfig.json"], consumer);
}

function walk(directory) {
  const values = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    values.push(path);
    if (lstatSync(path).isDirectory()) values.push(...walk(path));
  }
  return values;
}

function relativeFiles(directory, prefix = "") {
  const records = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const status = lstatSync(path);
    if (status.isDirectory()) records.push(...relativeFiles(path, relativePath));
    else if (status.isFile())
      records.push({ path: relativePath, bytes: readFileSync(path).toString("base64") });
    else throw new Error(`Template contains special file ${relativePath}`);
  }
  return records;
}

async function waitForService(bin, cwd, environment) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = runResult(bin, ["service", "status"], cwd, environment);
    if (result.status === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("installed service did not become ready");
}

function verifyPortalManifest(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  for (const asset of manifest.assets) {
    const bytes = readFileSync(join(directory, asset.path));
    assert(bytes.byteLength === asset.byteLength, `portal length mismatch: ${asset.path}`);
    assert(
      createHash("sha256").update(bytes).digest("hex") === asset.digest,
      `portal digest mismatch: ${asset.path}`,
    );
  }
}

function assertExecutable(path, shebang = false) {
  assert((statSync(path).mode & 0o111) !== 0, `${path} is not executable`);
  if (shebang) {
    assert(
      readFileSync(path, "utf8").startsWith("#!/usr/bin/env node\n"),
      `${path} has no shebang`,
    );
  }
}

function run(command, arguments_, cwd, environment = process.env) {
  const result = runResult(command, arguments_, cwd, environment);
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

function runResult(command, arguments_, cwd, environment = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${command} exceeded the ${commandTimeoutMs}ms packaging test timeout`);
    }
    throw result.error;
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
