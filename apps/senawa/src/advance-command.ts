import { resolve } from "node:path";
import { canonicalValue, sha256Digest } from "@senawa/kernel";
import type { AuthenticatedPrincipal } from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { type AdvanceOutcome, advanceRun } from "./advance-run.js";
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
        workflowInput: {
          bindingDigest: sha256Digest("0".repeat(64)),
          value: canonicalValue({}),
        },
        repositoryBase: {
          commitDigest: sha256Digest("0".repeat(64)),
          treeDigest: sha256Digest("0".repeat(64)),
        },
      });
      lines.push(describe(outcome));
      if (outcome.kind !== "closed" && outcome.kind !== "dispatched") {
        return { output: lines.join("\n"), exitCode: outcome.kind === "gate-refused" ? 1 : 0 };
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

function describe(outcome: AdvanceOutcome): string {
  switch (outcome.kind) {
    case "dispatched":
      return `dispatched ${outcome.phaseKey} as ${outcome.dispatchId}`;
    case "awaiting-agent":
      return `waiting for the agent working on ${outcome.phaseKey}`;
    case "awaiting-approval":
      return `waiting for a decision on ${outcome.phaseKey}`;
    case "gate-refused":
      return `${outcome.phaseKey} did not pass: ${outcome.reasons.join(", ")}`;
    case "closed":
      return `closed ${outcome.phaseKey}`;
    default:
      return "finished";
  }
}
