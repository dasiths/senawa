import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createRoleAuthorizationPolicy } from "../packages/runtime/dist/index.js";
import { SqliteAuthority } from "../packages/storage-sqlite/dist/index.js";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
} from "../packages/testing/dist/index.js";

const sampleCount = 100;
const p99LimitMs = 25;
const root = mkdtempSync(join(tmpdir(), "senawa-sqlite-authority-benchmark-"));
const authority = new SqliteAuthority({
  databasePath: join(root, "authority.db"),
  assetDirectory: join(root, "assets"),
  dependencies: {
    sha256: deterministicSha256,
    authorization: createRoleAuthorizationPolicy([
      { intent: "instantiate-run", roles: ["release-manager"] },
    ]),
  },
});

try {
  const durations = [];
  let allocation = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const command = {
      ...runtimeCommand({
        commandId: `command_latency-${index}`,
        intent: "instantiate-run",
        payload: {
          workflowId: runtimeFixture.workflowId,
          graph: createRuntimeGraph(),
          phase: runtimeFixture.phase,
          approvalPolicy: { policy: "no-approval" },
          escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        },
      }),
      payloadDigest: "0".repeat(64),
    };
    const startedAt = performance.now();
    const receipt = authority.submit(command, {
      currentTime: "2026-08-12T12:00:00.000Z",
      facts: { benchmark: "sqlite-authority-refusal" },
      allocateId(kind) {
        allocation += 1;
        return `${kind}-${allocation}`;
      },
    });
    durations.push(performance.now() - startedAt);
    if (receipt.error?.code !== "payload-digest-mismatch") {
      throw new Error(`Unexpected benchmark receipt: ${receipt.error?.code ?? receipt.status}`);
    }
  }

  durations.sort((left, right) => left - right);
  const summary = {
    samples: sampleCount,
    thresholdMs: p99LimitMs,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.at(-1),
  };
  console.log(JSON.stringify(summary));
  if (summary.p99Ms >= p99LimitMs) {
    throw new Error(
      `SQLite authority refusal p99 ${summary.p99Ms.toFixed(2)} ms must be below ${p99LimitMs} ms`,
    );
  }
} finally {
  authority.close();
  rmSync(root, { recursive: true, force: true });
}

function percentile(sortedValues, quantile) {
  return sortedValues[Math.ceil(sortedValues.length * quantile) - 1];
}
