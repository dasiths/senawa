import { isAbsolute } from "node:path";
import {
  type BoundedProcessOutput,
  measureExecutableSensor,
  type ProcessCleanup,
} from "./process-sensor.js";

const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
const FIXED_ENVIRONMENT = Object.freeze({
  GIT_ASKPASS: "/bin/false",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  PAGER: "cat",
  SSH_ASKPASS: "/bin/false",
  TZ: "UTC",
} as const);

export interface GitCommandEnvironment {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerDate: string;
}

export interface GitCommandRequest {
  readonly rootDirectory: string;
  readonly cwd?: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly identity?: GitCommandEnvironment;
  readonly signal?: AbortSignal;
}

export interface GitCommandResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cleanup: ProcessCleanup;
  readonly stdout: BoundedProcessOutput;
  readonly stderr: BoundedProcessOutput;
}

export interface GitCommandPort {
  run(request: GitCommandRequest): Promise<GitCommandResult>;
}

export class BoundedGitCommandPort implements GitCommandPort {
  readonly gitExecutable: string;
  readonly isolatedHome: string;
  readonly terminationGraceMs: number;
  readonly #allowedSubcommands: ReadonlySet<string>;

  constructor(input: {
    readonly gitExecutable: string;
    readonly isolatedHome: string;
    readonly terminationGraceMs?: number;
    /** Extra subcommands a test fixture needs to build a repository. */
    readonly additionalSubcommands?: readonly string[];
  }) {
    if (!isAbsolute(input.gitExecutable) || input.gitExecutable.includes("\0")) {
      throw new TypeError("Git executable must be an absolute NUL-free path");
    }
    if (!isAbsolute(input.isolatedHome) || input.isolatedHome.includes("\0")) {
      throw new TypeError("Git isolated home must be an absolute NUL-free path");
    }
    const terminationGraceMs = input.terminationGraceMs ?? 1_000;
    if (!boundedInteger(terminationGraceMs, MAX_TIMER_MILLISECONDS)) {
      throw new TypeError("Git termination grace must be a positive supported timer integer");
    }
    this.gitExecutable = input.gitExecutable;
    this.isolatedHome = input.isolatedHome;
    this.terminationGraceMs = terminationGraceMs;
    this.#allowedSubcommands =
      input.additionalSubcommands === undefined
        ? ALLOWED_GIT_SUBCOMMANDS
        : new Set([...ALLOWED_GIT_SUBCOMMANDS, ...input.additionalSubcommands]);
  }

  async run(request: GitCommandRequest): Promise<GitCommandResult> {
    validateRequest(request, this.#allowedSubcommands);
    const environment = buildEnvironment(this.isolatedHome, request.identity);
    const outcome = await measureExecutableSensor({
      rootDirectory: request.rootDirectory,
      command: {
        argv: [
          this.gitExecutable,
          "--no-pager",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.useReplaceRefs=false",
          "-c",
          "diff.external=",
          ...request.args,
        ],
        cwd: request.cwd ?? ".",
        timeoutMs: request.timeoutMs,
        maxStdoutBytes: request.maxStdoutBytes ?? DEFAULT_OUTPUT_BYTES,
        maxStderrBytes: request.maxStderrBytes ?? DEFAULT_OUTPUT_BYTES,
        inheritedEnvironment: Object.keys(environment),
      },
      ambientEnvironment: environment,
      terminationGraceMs: this.terminationGraceMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.type === "failure") {
      throw new GitCommandHostError(outcome.failure.code, outcome.failure.message);
    }
    return Object.freeze(outcome.measurement);
  }
}

/**
 * Git subcommands the harness itself issues.
 *
 * Read-only inspection plus the worktree lifecycle. Anything that fetches,
 * pushes, or rewrites history is absent by design.
 */
const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add",
  "check-ref-format",
  "commit-tree",
  "config",
  "diff",
  "hash-object",
  "help",
  "ls-files",
  "ls-tree",
  "merge-tree",
  "rev-parse",
  "status",
  "update-index",
  "update-ref",
  "worktree",
  "write-tree",
]);

export class GitCommandHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitCommandHostError";
    this.code = code;
  }
}

function validateRequest(request: GitCommandRequest, allowed: ReadonlySet<string>): void {
  if (request.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("Git arguments must be NUL-free strings");
  }
  // The safety of this port rested on having no untrusted caller. Once a
  // consumer-authored sensor can reach git, the subcommand has to be bounded
  // here rather than by who happens to be calling.
  const subcommand = request.args[0];
  if (subcommand === undefined || !allowed.has(subcommand)) {
    throw new GitCommandHostError(
      "subcommand-denied",
      `Git subcommand ${subcommand ?? "(absent)"} is not permitted`,
    );
  }
  if (!boundedInteger(request.timeoutMs, MAX_TIMER_MILLISECONDS)) {
    throw new TypeError("Git timeout must be a positive supported timer integer");
  }
  for (const value of [request.maxStdoutBytes, request.maxStderrBytes]) {
    if (value !== undefined && !boundedInteger(value, MAX_OUTPUT_BYTES)) {
      throw new TypeError("Git output bounds must be positive supported integers");
    }
  }
  if (request.identity !== undefined) validateIdentity(request.identity);
}

function validateIdentity(identity: GitCommandEnvironment): void {
  for (const value of Object.values(identity)) {
    if (
      value.length === 0 ||
      value.includes("\0") ||
      value.includes("\n") ||
      value.includes("\r")
    ) {
      throw new TypeError("Git identity values must be non-empty single-line strings");
    }
  }
}

function buildEnvironment(
  isolatedHome: string,
  identity: GitCommandEnvironment | undefined,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...FIXED_ENVIRONMENT,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    ...(identity === undefined
      ? {}
      : {
          GIT_AUTHOR_NAME: identity.authorName,
          GIT_AUTHOR_EMAIL: identity.authorEmail,
          GIT_AUTHOR_DATE: identity.authorDate,
          GIT_COMMITTER_NAME: identity.committerName,
          GIT_COMMITTER_EMAIL: identity.committerEmail,
          GIT_COMMITTER_DATE: identity.committerDate,
        }),
  });
}

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
