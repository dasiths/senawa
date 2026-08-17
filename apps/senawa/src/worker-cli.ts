import { readFileSync } from "node:fs";
import { decodeCanonicalJsonValue, type JsonValue } from "@senawa/protocol";
import { HttpSupervisorClient } from "@senawa/supervisor";
import type { CliResult } from "./cli.js";

/**
 * The environment variable naming the credential file, not the token.
 *
 * A token in the environment cannot be withdrawn from a process that already
 * read it and propagates to every descendant; a path can be unlinked.
 */
export const WORKER_CREDENTIAL_PATH_VARIABLE = "SENAWA_WORKER_CREDENTIAL";
export const WORKER_DISPATCH_VARIABLE = "SENAWA_WORKER_DISPATCH";

export interface WorkerCliOptions {
  readonly socketPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * The agent-facing command line.
 *
 * Every verb here is one a worker may hold. There is deliberately no approve,
 * reject, mark-done, steer, or end-run, because the supervisor would refuse
 * them anyway and offering them would misrepresent the contract.
 */
export async function runWorkerCli(
  action: string | undefined,
  rest: readonly string[],
  options: WorkerCliOptions,
): Promise<CliResult> {
  const dispatchId = options.environment[WORKER_DISPATCH_VARIABLE];
  const credentialPath = options.environment[WORKER_CREDENTIAL_PATH_VARIABLE];
  if (dispatchId === undefined || credentialPath === undefined) {
    return {
      exitCode: 2,
      output: `Worker commands require ${WORKER_DISPATCH_VARIABLE} and ${WORKER_CREDENTIAL_PATH_VARIABLE}`,
    };
  }
  const client = new HttpSupervisorClient({
    socketPath: options.socketPath,
    credential: readFileSync(credentialPath, "utf8").trim(),
  });
  if (action === "context" && rest.length === 0) {
    return json(await client.workerContext(dispatchId));
  }
  if (action === "output-schema" && rest.length === 0) {
    return json(await client.workerOutputSchema(dispatchId));
  }
  if (action === "submit" && rest.length === 1) {
    const submission = decodeCanonicalJsonValue(readSubmission(rest[0] ?? ""));
    return json(await client.submitWorkerSubmission(dispatchId, submission));
  }
  return {
    exitCode: 2,
    output: "Usage: senawa worker <context|output-schema|submit <file|->>",
  };
}

function readSubmission(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function json(value: JsonValue): CliResult {
  return { exitCode: 0, output: JSON.stringify(value, undefined, 2) };
}
