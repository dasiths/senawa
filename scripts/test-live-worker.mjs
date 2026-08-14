import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cleanupTimeoutMs = 15_000;
const subprocessCleanupTimeoutMs = 10_000;
const modelTimeoutMs = positiveIntegerEnvironment("SENAWA_COPILOT_TIMEOUT_MS");
const testTimeoutMs = checkedAdd(modelTimeoutMs, cleanupTimeoutMs, "live test timeout");
const subprocessTimeoutMs = checkedAdd(
  testTimeoutMs,
  subprocessCleanupTimeoutMs,
  "live subprocess timeout",
);

if (process.argv.length === 3 && process.argv[2] === "--validate-timeout") {
  process.stdout.write(
    `${JSON.stringify({ modelTimeoutMs, testTimeoutMs, subprocessTimeoutMs })}\n`,
  );
  process.exit(0);
}
if (process.argv.length !== 2) throw new Error("Unknown live worker test argument");

if (process.env.SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA !== "1") {
  throw new Error(
    "Live worker testing can spend AI credits and send data. Set SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA=1 with the bounded live probe variables to continue.",
  );
}

process.stderr.write(
  "COST AND DATA WARNING: running the opt-in bounded live Copilot worker probe.\n",
);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = spawnSync(
  "pnpm",
  ["vitest", "run", "packages/execution-host/src/copilot-worker.live.test.ts"],
  {
    cwd: root,
    env: { ...process.env, SENAWA_COPILOT_LIVE: "1" },
    stdio: "inherit",
    timeout: subprocessTimeoutMs,
  },
);
if (result.error !== undefined) {
  if (result.error.code === "ETIMEDOUT") {
    throw new Error(`Live worker subprocess exceeded ${subprocessTimeoutMs}ms`);
  }
  throw result.error;
}
process.exitCode = result.status ?? 1;

function positiveIntegerEnvironment(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Live Copilot probe requires ${name}`);
  }
  return value;
}

function checkedAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > 2_147_483_647) {
    throw new Error(`${label} exceeds the supported timer range`);
  }
  return value;
}
