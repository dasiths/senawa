import { resolve } from "node:path";
import { type CanonicalValue, canonicalValue, sha256Digest } from "@senawa/kernel";
import type { AuthenticatedPrincipal } from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { SqliteAuthority, SqliteCanonicalJsonAssetStore } from "@senawa/storage-sqlite";
import { type AdvanceOutcome, advanceRun, classifyOutcome } from "./advance-run.js";
import type { CliResult } from "./cli.js";

export interface AdvanceCommandOptions {
  readonly projectRoot: string;
  readonly repositoryId: string;
  readonly runId: string;
  /** How many steps to take. One call, one durable decision. */
  readonly steps?: number;
}

export interface AdvanceCommandPaths {
  readonly databasePath: string;
  readonly assetDirectory: string;
}

const DEFAULT_STEPS = 32;

/**
 * Drives a run forward and says what it is waiting for.
 *
 * The loop stops as soon as the run needs something senawa cannot supply: an
 * agent that has not finished, or a person who has not decided.
 */
export async function runAdvanceCommand(
  options: AdvanceCommandOptions,
  paths: AdvanceCommandPaths,
  dependencies: RuntimeDependencies,
  principal: AuthenticatedPrincipal,
  currentTime: string,
): Promise<CliResult> {
  const lines: string[] = [];
  const workflowInput = boundWorkflowInput(options, paths, dependencies);
  try {
    for (let step = 0; step < (options.steps ?? DEFAULT_STEPS); step += 1) {
      const outcome = await advanceRun({
        projectRoot: resolve(options.projectRoot),
        databasePath: paths.databasePath,
        assetDirectory: paths.assetDirectory,
        repositoryId: options.repositoryId,
        runId: options.runId,
        principal,
        dependencies,
        currentTime,
        workflowInput,
        repositoryBase: {
          commitDigest: sha256Digest("0".repeat(64)),
          treeDigest: sha256Digest("0".repeat(64)),
        },
      });
      lines.push(describe(outcome));
      if (classifyOutcome(outcome) !== "progress" || outcome.kind === "finished") {
        return {
          output: lines.join("\n"),
          exitCode: classifyOutcome(outcome) === "refused" ? 1 : 0,
        };
      }
    }
    lines.push("stopped after the step limit");
    return { output: lines.join("\n"), exitCode: 0 };
  } catch (error) {
    lines.push(error instanceof Error ? error.message : "Run could not be advanced");
    if (process.env.SENAWA_DEBUG === "1" && error instanceof Error) lines.push(String(error.stack));
    return { output: lines.join("\n"), exitCode: 1 };
  }
}

/**
 * The input the run was actually started with.
 *
 * A phase dispatched on a fabricated input reads something nobody asked for,
 * and a second dispatch of the same attempt collides with the first because
 * the two disagree about what the run is for.
 */
export function boundWorkflowInput(
  options: { readonly repositoryId: string; readonly runId: string },
  paths: AdvanceCommandPaths,
  dependencies: RuntimeDependencies,
): { readonly bindingDigest: ReturnType<typeof sha256Digest>; readonly value: CanonicalValue } {
  const authority = new SqliteAuthority({ ...paths, dependencies });
  try {
    const bound = authority.queryWorkflowInput(options.repositoryId, options.runId);
    const value =
      bound === undefined
        ? undefined
        : new SqliteCanonicalJsonAssetStore(authority).load(sha256Digest(bound.contentDigest));
    if (bound === undefined || value === undefined) {
      return { bindingDigest: sha256Digest("0".repeat(64)), value: canonicalValue({}) };
    }
    return { bindingDigest: sha256Digest(bound.bindingDigest), value };
  } finally {
    authority.close();
  }
}

function describe(outcome: AdvanceOutcome): string {
  switch (outcome.kind) {
    case "dispatched":
      return `dispatched ${outcome.phaseKey} as ${outcome.dispatchId}`;
    case "retrying":
      return `retrying ${outcome.phaseKey}, attempt ${outcome.attempt}: ${outcome.reasons.join(", ")}`;
    case "fanned-out":
      return `fanned ${outcome.phaseKey} out over ${outcome.members} items`;
    case "awaiting-agent":
      return outcome.dispatchId === undefined
        ? `waiting for the agent working on ${outcome.phaseKey}`
        : `waiting for the agent working on ${outcome.phaseKey} (${outcome.dispatchId})`;
    case "awaiting-approval":
      return `waiting for a decision on ${outcome.phaseKey}`;
    case "gate-refused":
      return `${outcome.phaseKey} did not pass: ${outcome.reasons.join(", ")}`;
    case "rejected":
      return `${outcome.phaseKey} was rejected: ${outcome.reasons.join(", ")}`;
    case "output-refused":
      return `${outcome.phaseKey} produced an output senawa refused: ${outcome.reasons.join(", ")}`;
    case "closed":
      return `closed ${outcome.phaseKey}`;
    case "finished":
      // The run stays open: ending one carries human authority the driver has
      // no business fabricating.
      return "every phase is done; end the run when you are satisfied";
    default: {
      const unreachable: never = outcome;
      throw new Error(`Undescribed advance outcome ${JSON.stringify(unreachable)}`);
    }
  }
}
