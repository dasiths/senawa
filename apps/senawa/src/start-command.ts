import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigurationCompilationError } from "@senawa/configuration";
import { canonicalValue, sha256Digest } from "@senawa/kernel";
import type { AuthenticatedPrincipal } from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import type { CliResult } from "./cli.js";
import { startAuthoredRun } from "./start-run.js";

export interface StartCommandPaths {
  readonly databasePath: string;
  readonly assetDirectory: string;
}

export interface StartCommandOptions {
  readonly projectRoot: string;
  readonly requestPath: string;
  readonly repositoryId: string;
  readonly runId?: string;
  readonly maxAiCredits?: number;
}

const MAX_REQUEST_BYTES = 256 * 1_024;

/**
 * Runs `senawa start`, the command that turns authored files into working agents.
 *
 * Refusals are the common case while a workflow is being written, so every one
 * names the file, the path inside it, and the reason rather than a stack trace.
 */
export async function runStartCommand(
  options: StartCommandOptions,
  paths: StartCommandPaths,
  dependencies: RuntimeDependencies,
  principal: AuthenticatedPrincipal,
  currentTime: string,
): Promise<CliResult> {
  let request: unknown;
  try {
    const text = await readFile(resolve(options.requestPath), "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
      return failure(`${options.requestPath}: request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    request = JSON.parse(text);
  } catch (error) {
    return failure(
      `${options.requestPath}: ${error instanceof Error ? error.message : "could not be read"}`,
    );
  }

  try {
    const started = await startAuthoredRun({
      projectRoot: resolve(options.projectRoot),
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
      repositoryId: options.repositoryId,
      runId: options.runId ?? deriveRunId(options.repositoryId, dependencies),
      principal,
      input: canonicalValue(request),
      currentTime,
      repositoryBase: {
        commitDigest: sha256Digest("0".repeat(64)),
        treeDigest: sha256Digest("0".repeat(64)),
      },
      ...(options.maxAiCredits === undefined ? {} : { maxAiCredits: options.maxAiCredits }),
    });
    return {
      output: [
        `run: ${started.runId}`,
        `repository: ${started.repositoryId}`,
        `phase: ${started.phaseKey}`,
        `dispatch: ${started.dispatchId}`,
      ].join("\n"),
      exitCode: 0,
    };
  } catch (error) {
    if (error instanceof ConfigurationCompilationError) {
      return failure(
        error.diagnostics
          .map((item) => `${item.locator}${item.pointer} [${item.code}] ${item.message}`)
          .join("\n"),
      );
    }
    return failure(error instanceof Error ? error.message : "Run could not be started");
  }
}

function deriveRunId(repositoryId: string, dependencies: RuntimeDependencies): string {
  return `run_${dependencies.sha256
    .digest(new TextEncoder().encode(`${repositoryId}:${Date.now()}`))
    .slice(0, 32)}`;
}

function failure(message: string): CliResult {
  return { output: message, exitCode: 1 };
}
