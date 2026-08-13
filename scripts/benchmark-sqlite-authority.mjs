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
const warmupCount = 10;
const conditioningCount = 100;
const windowCount = 5;
const requiredPassingWindows = 4;
const p99LimitMs = 25;
const root = mkdtempSync(join(tmpdir(), "senawa-sqlite-authority-benchmark-"));

try {
  const windows = [];
  let allocation = 0;
  const conditioningAuthority = createAuthority("conditioning");
  try {
    for (let index = 0; index < conditioningCount; index += 1) {
      submitRefusal(conditioningAuthority, `command_latency-conditioning-${index}`, () => {
        allocation += 1;
        return allocation;
      });
    }
  } finally {
    conditioningAuthority.close();
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    const authority = createAuthority(`window-${windowIndex}`);
    try {
      for (let index = 0; index < warmupCount; index += 1) {
        submitRefusal(authority, `command_latency-${windowIndex}-warmup-${index}`, () => {
          allocation += 1;
          return allocation;
        });
      }
      const durations = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const startedAt = performance.now();
        submitRefusal(authority, `command_latency-${windowIndex}-measured-${index}`, () => {
          allocation += 1;
          return allocation;
        });
        durations.push(performance.now() - startedAt);
      }
      durations.sort((left, right) => left - right);
      windows.push({
        window: windowIndex + 1,
        samples: sampleCount,
        warmups: warmupCount,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
        maxMs: durations.at(-1),
      });
    } finally {
      authority.close();
    }
  }

  const windowP99Values = windows.map(({ p99Ms }) => p99Ms).sort((left, right) => left - right);
  const passingWindows = windows.filter(({ p99Ms }) => p99Ms < p99LimitMs).length;
  const summary = {
    thresholdMs: p99LimitMs,
    conditioningSubmissions: conditioningCount,
    requiredPassingWindows,
    passingWindows,
    medianWindowP99Ms: percentile(windowP99Values, 0.5),
    maxWindowP99Ms: windowP99Values.at(-1),
    windows,
  };
  console.log(JSON.stringify(summary));
  if (summary.medianWindowP99Ms >= p99LimitMs || summary.passingWindows < requiredPassingWindows) {
    throw new Error(
      `SQLite authority refusal requires at least ${requiredPassingWindows}/${windowCount} window p99 values and the median window p99 below ${p99LimitMs} ms; observed ${summary.passingWindows}/${windowCount} and ${summary.medianWindowP99Ms.toFixed(2)} ms`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function createAuthority(suffix) {
  return new SqliteAuthority({
    databasePath: join(root, `authority-${suffix}.db`),
    assetDirectory: join(root, `assets-${suffix}`),
    dependencies: {
      sha256: deterministicSha256,
      authorization: createRoleAuthorizationPolicy([
        { intent: "instantiate-run", roles: ["release-manager"] },
      ]),
    },
  });
}

function submitRefusal(authority, commandId, allocate) {
  const command = {
    ...runtimeCommand({
      commandId,
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
  const receipt = authority.submit(command, {
    currentTime: "2026-08-12T12:00:00.000Z",
    facts: { benchmark: "sqlite-authority-refusal" },
    allocateId(kind) {
      return `${kind}-${allocate()}`;
    },
  });
  if (receipt.error?.code !== "payload-digest-mismatch") {
    throw new Error(`Unexpected benchmark receipt: ${receipt.error?.code ?? receipt.status}`);
  }
}

function percentile(sortedValues, quantile) {
  return sortedValues[Math.ceil(sortedValues.length * quantile) - 1];
}
