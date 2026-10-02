import type { JsonValue } from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
} from "@senawa/storage-sqlite";
import type { CliResult } from "./cli.js";

export interface InspectOptions {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly dependencies: RuntimeDependencies;
  readonly currentTime: string;
}

const PREVIEW_BYTES = 4_096;

/**
 * Reports one phase's lifecycle in the terms a consumer thinks in.
 *
 * `status` answers "what is the run doing"; this answers "what happened to this
 * phase", which is the question asked after a refusal.
 */
export function inspectPhase(options: InspectOptions, phaseId: string): CliResult {
  const authority = new SqliteAuthority({
    databasePath: options.databasePath,
    assetDirectory: options.assetDirectory,
    dependencies: options.dependencies,
  });
  try {
    const projection = authority.queryProjection(options.repositoryId, options.runId);
    if (projection === undefined) return missingRun(options.runId);
    const phases = phaseEntries(projection.payload);
    const phase = phases.find((entry) => entry.phaseId === phaseId);
    if (phase === undefined) {
      return {
        exitCode: 1,
        output: [
          `${phaseId}: no such phase in this run`,
          `known phases: ${phases.map((entry) => entry.phaseId).join(", ")}`,
        ].join("\n"),
      };
    }
    return {
      exitCode: 0,
      output: Object.entries(phase)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n"),
    };
  } finally {
    authority.close();
  }
}

/** Reads the phase entries out of the lifecycle payload without assuming a shape. */
function phaseEntries(payload: JsonValue): readonly { readonly phaseId: string }[] {
  const record = payload as { readonly phases?: readonly { readonly phaseId?: unknown }[] };
  return (record.phases ?? []).filter(
    (entry): entry is { readonly phaseId: string } => typeof entry.phaseId === "string",
  );
}

/** Lists what a run produced, so evidence is reachable without the portal. */
export function listArtifacts(options: InspectOptions): CliResult {
  const portal = query(options);
  try {
    const page = portal.listArtifacts(options.repositoryId, options.runId);
    if (page.artifacts.length === 0) return { exitCode: 0, output: "no artifacts yet" };
    const lines = page.artifacts.map(
      (artifact) =>
        `${artifact.artifactId} ${artifact.mediaType} ${artifact.byteLength}B ${artifact.availability}`,
    );
    if (page.hasMore) lines.push("(more available)");
    return { exitCode: 0, output: lines.join("\n") };
  } finally {
    portal.close();
  }
}

/** Reads a bounded preview of one artifact rather than the whole thing. */
export function readArtifact(options: InspectOptions, artifactId: string): CliResult {
  const portal = query(options);
  try {
    const content = portal.readArtifactContent(
      options.repositoryId,
      options.runId,
      artifactId,
      0,
      PREVIEW_BYTES,
    );
    if (content === undefined) {
      // An unverified artifact is deliberately unreadable: serving bytes whose
      // digest was never checked would make evidence indistinguishable from
      // whatever happened to be on disk.
      return {
        exitCode: 1,
        output: `${artifactId}: senawa never verified these bytes against their digest, so it will not serve them. Run senawa artifact list to see which artifacts are stored.`,
      };
    }
    return { exitCode: 0, output: content.content };
  } finally {
    portal.close();
  }
}

/** Lists the agent dispatches a run made, which is what an operator asks next. */
export function listDispatches(options: InspectOptions): CliResult {
  const broker = new SqliteContextBroker({
    databasePath: options.databasePath,
    dependencies: {
      sha256: options.dependencies.sha256,
      currentTime: () => options.currentTime,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const dispatches = broker.listWorkerDispatches(options.repositoryId, options.runId);
    if (dispatches.length === 0) return { exitCode: 0, output: "no agents dispatched yet" };
    return {
      exitCode: 0,
      output: dispatches
        .map((dispatch) => `${dispatch.dispatch.dispatchId} ${dispatch.context.contextId}`)
        .join("\n"),
    };
  } finally {
    broker.close();
  }
}

function query(options: InspectOptions): SqlitePortalQueryAuthority {
  return new SqlitePortalQueryAuthority({
    databasePath: options.databasePath,
    assetDirectory: options.assetDirectory,
    dependencies: options.dependencies,
  });
}

function missingRun(runId: string): CliResult {
  return { exitCode: 1, output: `${runId}: no such run` };
}
