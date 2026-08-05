import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

const supportedVersion = /^1\.1\.\d+$/u;

interface BeadsEnvelope {
  readonly schema_version: 1;
  readonly data: unknown;
}

export interface BeadsCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type BeadsCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<BeadsCommandResult>;

export interface BeadsClientOptions {
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runCommand?: BeadsCommandRunner;
}

export interface BeadsDiagnostic {
  readonly executable: string;
  readonly version: string;
  readonly supported: boolean;
}

export class BeadsCommandError extends Error {
  constructor(
    message: string,
    readonly command: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BeadsCommandError";
  }
}

export class BeadsEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeadsEnvelopeError";
  }
}

export class BeadsClient {
  private readonly executable: string;
  private readonly repositoryRoot: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runCommand: BeadsCommandRunner;

  constructor(repositoryRoot: string, options: BeadsClientOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.executable = options.executable ?? "bd";
    this.environment = {
      ...process.env,
      ...options.environment,
      BEADS_DIR: join(this.repositoryRoot, ".beads"),
      BD_JSON_ENVELOPE: "1",
      BD_NON_INTERACTIVE: "1",
      DO_NOT_TRACK: "1",
    };
    this.runCommand = options.runCommand ?? runClosedCommand;
  }

  async diagnose(): Promise<BeadsDiagnostic> {
    const result = await this.execute(["version"]);
    const match = result.stdout.match(/\bbd version (\d+\.\d+\.\d+)\b/u);
    if (match?.[1] === undefined) {
      throw new BeadsCommandError(
        `Unable to parse the Beads version from ${JSON.stringify(result.stdout.trim())}`,
        [this.executable, "version"],
      );
    }
    return {
      executable: this.executable,
      version: match[1],
      supported: supportedVersion.test(match[1]),
    };
  }

  async assertSupported(): Promise<BeadsDiagnostic> {
    const diagnostic = await this.diagnose();
    if (!diagnostic.supported) {
      throw new BeadsCommandError(
        `Unsupported Beads version ${diagnostic.version}; Senawa requires bd 1.1.x`,
        [this.executable, "version"],
      );
    }
    return diagnostic;
  }

  async ensureInitialized(): Promise<void> {
    await this.assertSupported();
    try {
      await access(join(this.repositoryRoot, ".beads"));
      return;
    } catch {
      await this.raw(["init", "--quiet", "--stealth", "--non-interactive", "--role", "maintainer"]);
    }
  }

  async json<T>(arguments_: readonly string[]): Promise<T> {
    const command = arguments_.includes("--json") ? arguments_ : [...arguments_, "--json"];
    const result = await this.execute(command);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new BeadsEnvelopeError(
        `Beads returned malformed JSON for ${formatCommand(this.executable, command)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isEnvelope(parsed)) {
      throw new BeadsEnvelopeError(
        `Beads returned an unsupported JSON envelope for ${formatCommand(this.executable, command)}; expected schema_version 1 with data`,
      );
    }
    return parsed.data as T;
  }

  async raw(arguments_: readonly string[]): Promise<string> {
    return (await this.execute(arguments_)).stdout;
  }

  private async execute(arguments_: readonly string[]): Promise<BeadsCommandResult> {
    try {
      return await this.runCommand(this.executable, arguments_, {
        cwd: this.repositoryRoot,
        env: this.environment,
      });
    } catch (error) {
      if (error instanceof BeadsCommandError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new BeadsCommandError(
        `Beads command failed (${formatCommand(this.executable, arguments_)}): ${detail}`,
        [this.executable, ...arguments_],
        { cause: error },
      );
    }
  }
}

function runClosedCommand(
  executable: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<BeadsCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostics = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolveCommand({ stdout: output, stderr: diagnostics });
        return;
      }
      rejectCommand(
        new BeadsCommandError(
          `Beads exited ${code === null ? `for signal ${signal ?? "unknown"}` : `with code ${code}`}: ${diagnostics.trim() || output.trim() || "no diagnostics"}`,
          [executable, ...arguments_],
        ),
      );
    });
  });
}

function formatCommand(executable: string, arguments_: readonly string[]): string {
  return [executable, ...arguments_].map((value) => JSON.stringify(value)).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is BeadsEnvelope {
  if (!isRecord(value)) return false;
  const envelope = value as Partial<BeadsEnvelope>;
  return envelope.schema_version === 1 && "data" in envelope;
}
