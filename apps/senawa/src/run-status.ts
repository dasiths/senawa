import type { RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
} from "@senawa/storage-sqlite";
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
    return { output: lines.join("\n"), exitCode: 0 };
  } finally {
    broker.close();
    portal.close();
    authority.close();
  }
}
