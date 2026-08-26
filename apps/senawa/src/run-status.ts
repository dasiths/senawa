import type { RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
} from "@senawa/storage-sqlite";
import { SqliteSupervisorAuthority } from "@senawa/supervisor";
import type { CliResult } from "./cli.js";

export interface RunStatusOptions {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly dependencies: RuntimeDependencies;
  readonly currentTime: string;
}

/**
 * Reports what a run is doing, in the terms a consumer thinks in.
 *
 * The authority exposes revisions, digests, and effect counters. A consumer
 * wants to know which phase is running, whether anything is waiting on them, and
 * whether an agent has been dispatched.
 */
export function runStatus(options: RunStatusOptions): CliResult {
  const authority = new SqliteAuthority({
    databasePath: options.databasePath,
    assetDirectory: options.assetDirectory,
    dependencies: options.dependencies,
  });
  const portal = new SqlitePortalQueryAuthority({
    databasePath: options.databasePath,
    assetDirectory: options.assetDirectory,
    dependencies: options.dependencies,
  });
  const broker = new SqliteContextBroker({
    databasePath: options.databasePath,
    dependencies: {
      sha256: options.dependencies.sha256,
      currentTime: () => options.currentTime,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const overview = portal.getRunOverview(options.repositoryId, options.runId);
    if (overview === undefined) {
      return { output: `${options.runId}: no such run`, exitCode: 1 };
    }
    const needs = portal.listHumanNeeds(options.repositoryId, options.runId);
    const dispatches = broker.listWorkerDispatches(options.repositoryId, options.runId);
    // A run whose phases have all closed keeps the mode it had, because ending a
    // run is a person's decision. Saying only "running" left no way to tell a
    // finished run from a working one.
    const done =
      overview.counts.phases > 0 && overview.counts.closedPhases >= overview.counts.phases;
    const lines = [
      `run: ${options.runId}`,
      `mode: ${overview.mode}`,
      `phases: ${overview.counts.phases}`,
      ...(done
        ? ["every phase has closed: this run has finished its work"]
        : [`phases closed: ${overview.counts.closedPhases}`]),
      `agents dispatched: ${dispatches.length}`,
      `waiting on you: ${needs.needs.length}`,
    ];
    for (const need of needs.needs) lines.push(`  - ${need.kind}: ${need.title}`);
    // A run the driver has given up on looks exactly like a working one here:
    // running, nothing waiting, agents dispatched. The reason it stopped was
    // only ever written to the supervisor's log, which is not where a person
    // looks to find out what their run is doing.
    const stop = stopReason(options);
    if (stop !== undefined) lines.push(`stopped: ${stop}`);
    return { output: lines.join("\n"), exitCode: 0 };
  } finally {
    broker.close();
    portal.close();
    authority.close();
  }
}

/** How far back in the supervisor's log a stop is still worth reporting. */
const STOP_SCAN_LIMIT = 512;

/**
 * Why the driver stopped working this run, if it has not started again.
 *
 * The driver already records a stop and clears it when the run moves, so the
 * latest of the two entries is the answer. Reporting a stop without checking
 * for the resumption would leave a working run wearing an old refusal.
 */
function stopReason(options: RunStatusOptions): string | undefined {
  const supervisor = new SqliteSupervisorAuthority({
    databasePath: options.databasePath,
    assetDirectory: options.assetDirectory,
    dependencies: options.dependencies,
  });
  try {
    const latest = supervisor.queryLogs(0, 1).latestCursor;
    const page = supervisor.queryLogs(Math.max(0, latest - STOP_SCAN_LIMIT), STOP_SCAN_LIMIT);
    let reason: string | undefined;
    for (const entry of page.items) {
      const fields = entry.fields as { readonly runId?: unknown } | null;
      if (fields?.runId !== options.runId) continue;
      if (entry.event === "run.stopped" || entry.event === "run.drive-failed") {
        reason = entry.message;
      } else if (entry.event === "run.resumed" || entry.event === "run.finished") {
        reason = undefined;
      }
    }
    return reason;
  } finally {
    supervisor.close();
  }
}
