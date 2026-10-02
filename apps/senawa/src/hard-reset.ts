import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { CliResult } from "./cli.js";

/** What a Senawa state root always contains, so a stray directory is not mistaken for one. */
const STATE_ROOT_MARKERS: readonly string[] = Object.freeze(["authority.db", "assets"]);

export interface HardResetInput {
  readonly stateDirectory: string;
  readonly runtimeDirectory: string;
  /** The path the caller named, which must match the state root it resolves to. */
  readonly requestedPath: string | undefined;
  readonly assumeYes: boolean;
  readonly serviceRunning: boolean;
  /** Reads one line of confirmation. Absent when nothing can be asked. */
  readonly confirm?: (question: string) => Promise<string>;
}

/**
 * Destroys a run's durable history on purpose.
 *
 * Every other destructive path here refuses in favour of a fresh root, so this
 * one carries the guards that policy implies: it will not run without being
 * told which root, without the service stopped, or without a person saying the
 * root's name back.
 */
export async function hardReset(input: HardResetInput): Promise<CliResult> {
  const stateDirectory = resolve(input.stateDirectory);
  if (input.requestedPath === undefined) {
    return {
      output: `hard-reset needs the state root to remove, named exactly:\n  senawa hard-reset ${stateDirectory}`,
      exitCode: 1,
    };
  }
  if (resolve(input.requestedPath) !== stateDirectory) {
    return {
      output: `hard-reset refused: ${resolve(input.requestedPath)} is not the state root this environment resolves to, which is ${stateDirectory}`,
      exitCode: 1,
    };
  }
  if (!existsSync(stateDirectory)) {
    return { output: `nothing to remove: ${stateDirectory} does not exist`, exitCode: 0 };
  }
  if (!statSync(stateDirectory).isDirectory()) {
    return { output: `hard-reset refused: ${stateDirectory} is not a directory`, exitCode: 1 };
  }
  const present = new Set(readdirSync(stateDirectory));
  if (!STATE_ROOT_MARKERS.some((marker) => present.has(marker))) {
    return {
      output: `hard-reset refused: ${stateDirectory} does not look like a Senawa state root`,
      exitCode: 1,
    };
  }
  if (input.serviceRunning) {
    return {
      output:
        "hard-reset refused: the supervisor is running. Stop it first with `senawa service stop`",
      exitCode: 1,
    };
  }
  if (!input.assumeYes) {
    if (input.confirm === undefined) {
      return {
        output: "hard-reset refused: nothing can be asked here, so pass --yes to mean it",
        exitCode: 1,
      };
    }
    const answer = await input.confirm(
      `This removes every run, receipt and artifact under ${stateDirectory}, and cannot be undone.\nType the path to confirm: `,
    );
    if (resolve(answer.trim()) !== stateDirectory) {
      return { output: "hard-reset cancelled", exitCode: 1 };
    }
  }
  rmSync(stateDirectory, { recursive: true, force: true });
  rmSync(resolve(input.runtimeDirectory), { recursive: true, force: true });
  return { output: `removed ${stateDirectory} and its runtime directory`, exitCode: 0 };
}

/** Asks on the terminal, which is the only place a person can answer. */
export async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
