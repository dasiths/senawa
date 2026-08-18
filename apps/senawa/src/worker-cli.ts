import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { decodeCanonicalJsonValue, type JsonValue } from "@senawa/protocol";
import { HttpSupervisorClient } from "@senawa/supervisor";
import type { CliResult } from "./cli.js";

/**
 * The environment variable naming the credential file, not the token.
 *
 * A token in the environment cannot be withdrawn from a process that already
 * read it and propagates to every descendant; a path can be unlinked.
 */
const WORKER_CREDENTIAL_PATH_VARIABLE = "SENAWA_WORKER_CREDENTIAL";
const WORKER_DISPATCH_VARIABLE = "SENAWA_WORKER_DISPATCH";

export interface WorkerCliOptions {
  readonly socketPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
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
  if (action === "complete") {
    const request = buildCompleteRequest(rest, options.workspaceRoot);
    if (typeof request === "string") return { exitCode: 2, output: request };
    return json(await client.submitWorkerSubmission(dispatchId, request));
  }
  if (action === "ask" && rest.length === 1) {
    return json(
      await client.submitWorkerSubmission(dispatchId, {
        kind: "question",
        question: rest[0] ?? "",
      }),
    );
  }
  if (action === "escalate" && rest.length === 1) {
    return json(
      await client.submitWorkerSubmission(dispatchId, {
        kind: "escalation",
        reason: rest[0] ?? "",
      }),
    );
  }
  if (action === "submit" && rest.length === 1) {
    const submission = decodeCanonicalJsonValue(readSubmission(rest[0] ?? ""));
    return json(await client.submitWorkerSubmission(dispatchId, submission));
  }
  return {
    exitCode: 2,
    output: [
      "Usage:",
      "  senawa worker context",
      "  senawa worker output-schema",
      "  senawa worker complete --output <name>=<file> [--evidence <kind>=<file>] [--summary <text>]",
      "  senawa worker ask <question>",
      "  senawa worker escalate <reason>",
      "  senawa worker submit <file|->",
    ].join("\n"),
  };
}
/**
 * Turns named files into the complete request.
 *
 * The agent names what it produced; senawa reads the bytes and builds the
 * envelope, so no agent has to know a dispatch identity or compute a digest.
 */
function buildCompleteRequest(argv: readonly string[], workspaceRoot: string): JsonValue | string {
  const outputs: { name: string; value: JsonValue }[] = [];
  const completionEvidence: {
    kind: string;
    path: string;
    content: string;
    criterionId?: string;
  }[] = [];
  let summary = "";

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const argument = argv[index + 1];
    if (flag === "--summary" && argument !== undefined) {
      summary = argument;
      index += 1;
      continue;
    }
    if ((flag === "--output" || flag === "--evidence") && argument !== undefined) {
      const separator = argument.indexOf("=");
      if (separator <= 0) return `Expected ${flag} <name>=<file>, got ${argument}`;
      const name = argument.slice(0, separator);
      const path = argument.slice(separator + 1);
      let content: string;
      try {
        content = readWorkspaceFile(workspaceRoot, path);
      } catch (error) {
        return `Cannot read ${path}: ${error instanceof Error ? error.message : "unknown"}`;
      }
      if (flag === "--evidence") {
        // kind@criterion binds the item to one criterion; a bare kind is evidence
        // for the completion itself, which is what a task-scoped policy counts.
        const at = name.indexOf("@");
        completionEvidence.push(
          at <= 0
            ? { kind: name, path, content }
            : {
                kind: name.slice(0, at),
                path,
                content,
                criterionId: name.slice(at + 1),
              },
        );
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return `Output ${name} at ${path} is not valid JSON`;
        }
        try {
          // Parsing first canonicalises for the agent. Asking a worker to sort
          // its own keys and omit a trailing newline would refuse ordinary JSON.
          outputs.push({ name, value: decodeCanonicalJsonValue(parsed) });
        } catch (error) {
          return `Output ${name} at ${path} cannot be submitted: ${
            error instanceof Error ? error.message : "unknown"
          }`;
        }
      }
      index += 1;
      continue;
    }
    return `Unrecognized argument ${flag ?? ""}`.trim();
  }

  if (outputs.length === 0) return "complete requires at least one --output <name>=<file>";
  return {
    kind: "complete",
    outputs,
    completionEvidence,
    ...(summary.length === 0 ? {} : { summary }),
  } as unknown as JsonValue;
}

/** Reads a file the agent named, refusing anything outside the workspace. */
function readWorkspaceFile(workspaceRoot: string, path: string): string {
  const resolved = resolve(workspaceRoot, path);
  const root = resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(`${root}sep`.replace("sep", sep))) {
    throw new Error("path escapes the workspace");
  }
  return readFileSync(resolved, "utf8");
}

function readSubmission(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function json(value: JsonValue): CliResult {
  return { exitCode: 0, output: JSON.stringify(value, undefined, 2) };
}
