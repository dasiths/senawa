#!/usr/bin/env node
import { type CliResult, runCli } from "./cli.js";
import { createNodeCliDependencies } from "./node-cli.js";
import { runOperationalCli } from "./operational-cli.js";

const arguments_ = process.argv.slice(2);
let result: CliResult;
try {
  result =
    (await runOperationalCli(arguments_)) ??
    (await runCli(arguments_, createNodeCliDependencies()));
} catch (error) {
  result = { output: safeOperationalError(error), exitCode: 1 };
}
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;

function safeOperationalError(error: unknown): string {
  if (
    error instanceof Error &&
    (("safe" in error && error.safe === true) || error.name === "HttpSupervisorClientError")
  ) {
    return error.message;
  }
  // An unsafe message may name a path or a credential, so it is withheld unless
  // the operator asks for it. Withholding it with no way to ask made every
  // unexpected failure unreportable.
  if (process.env.SENAWA_DEBUG === "1" && error instanceof Error) {
    return `Operational command failed: ${error.stack ?? error.message}`;
  }
  return "Operational command failed. Re-run with SENAWA_DEBUG=1 for the detail.";
}
