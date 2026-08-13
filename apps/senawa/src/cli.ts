import {
  doctorWorkflowConfiguration,
  renderExampleWorkflowConfiguration,
} from "@senawa/configuration";

export const SENAWA_VERSION = "0.1.0-alpha.0";

const HELP = `Senawa ${SENAWA_VERSION}

Usage: senawa <command> [arguments]

Commands:
  doctor [path]                         Validate workflow configuration
  init [path]                           Create example workflow configuration
  service start|run|status|drain|stop   Manage the local supervisor
  service logs [after]                  Read bounded supervisor logs
  service recover <repository> <run>    Recover a run under the service fence
  command submit <json-path|->          Submit a command through local IPC
  receipt get <command>                 Read the latest command receipt
  receipt list <repository> <run>       List durable receipts
  event list <repository> <run>         List durable events
  projection get <repository> <run>     Read the phase projection
  amendment list|get|source|status      Review additive amendment proposals
  amendment withdraw|approve|reject     Submit an exact human amendment command
  amendment recover <repository> <run>  Trigger fenced amendment recovery
  portal                                Create a one-time portal URL

Options:
  -h, --help     Show help
  -v, --version  Show version`;

export interface CliWritableFile {
  write(content: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  syncParentDirectory(): Promise<void>;
}

export interface CliDependencies {
  readonly sha256: { digest(bytes: Uint8Array): string };
  readText(path: string): Promise<string>;
  createExclusive(path: string): Promise<CliWritableFile>;
}

export interface CliResult {
  readonly output: string;
  readonly exitCode: number;
}

export function renderCli(arguments_: readonly string[]): CliResult {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    return { output: HELP, exitCode: 0 };
  }
  if (arguments_.includes("--version") || arguments_.includes("-v")) {
    return { output: SENAWA_VERSION, exitCode: 0 };
  }
  return {
    output: `Unknown argument: ${arguments_[0]}\n\n${HELP}`,
    exitCode: 1,
  };
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  if (
    arguments_.length === 0 ||
    arguments_.includes("--help") ||
    arguments_.includes("-h") ||
    arguments_.includes("--version") ||
    arguments_.includes("-v")
  ) {
    return renderCli(arguments_);
  }
  const [command, path = "senawa.json", ...extra] = arguments_;
  if (extra.length > 0) {
    return { output: `${command ?? "Command"} accepts at most one path\n\n${HELP}`, exitCode: 1 };
  }
  if (command === "doctor") return doctor(path, dependencies);
  if (command === "init") return initialize(path, dependencies);
  return renderCli(arguments_);
}

async function doctor(path: string, dependencies: CliDependencies): Promise<CliResult> {
  let content: string;
  try {
    content = await dependencies.readText(path);
  } catch (error) {
    return {
      output: `${path}: unable to read workflow configuration (${safeFilesystemCode(error)})`,
      exitCode: 1,
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch (error) {
    return { output: `${path}: ${jsonSyntaxDescription(error, content)}`, exitCode: 1 };
  }
  const result = doctorWorkflowConfiguration(document, path, dependencies.sha256);
  if (result.snapshot !== undefined) return { output: `${path}: valid`, exitCode: 0 };
  const diagnostics = result.diagnostics.map(
    ({ code, locator, pointer, message }) =>
      `- [${code}] ${locator}${pointer.length === 0 ? "" : `#${pointer}`}: ${message}`,
  );
  return {
    output: `${path}: invalid (${result.diagnostics.length} diagnostic${result.diagnostics.length === 1 ? "" : "s"})\n${diagnostics.join("\n")}`,
    exitCode: 1,
  };
}

async function initialize(path: string, dependencies: CliDependencies): Promise<CliResult> {
  let file: CliWritableFile;
  try {
    file = await dependencies.createExclusive(path);
  } catch (error) {
    const code = safeFilesystemCode(error);
    return {
      output:
        code === "EEXIST"
          ? `${path}: already exists`
          : `${path}: unable to create workflow configuration (${code})`,
      exitCode: 1,
    };
  }
  let closed = false;
  try {
    await file.write(renderExampleWorkflowConfiguration());
    await file.sync();
    await file.close();
    closed = true;
    await file.syncParentDirectory();
  } catch (error) {
    if (!closed) {
      try {
        await file.close();
      } catch {
        // The original durability failure remains authoritative.
      }
    }
    return {
      output: `${path}: unable to durably write workflow configuration (${safeFilesystemCode(error)}); a partial file may remain`,
      exitCode: 1,
    };
  }
  return { output: `${path}: created`, exitCode: 0 };
}

function safeFilesystemCode(error: unknown): string {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return "FILESYSTEM_ERROR";
  }
  return [
    "EACCES",
    "EEXIST",
    "EISDIR",
    "ELOOP",
    "EMFILE",
    "ENFILE",
    "ENOENT",
    "ENOSPC",
    "ENOTDIR",
    "EPERM",
    "EROFS",
  ].includes(error.code)
    ? error.code
    : "FILESYSTEM_ERROR";
}

function jsonSyntaxDescription(error: unknown, content: string): string {
  if (!(error instanceof SyntaxError)) return "invalid JSON syntax";
  const positionMatch = /\bposition (\d+)\b/u.exec(error.message);
  const position = positionMatch === null ? content.length : Number(positionMatch[1]);
  const prefix = content.slice(0, position);
  const lines = prefix.split("\n");
  const line = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  let summary = "invalid JSON syntax";
  if (/Unexpected end/u.test(error.message)) summary = "unexpected end of JSON input";
  else if (/Expected property name/u.test(error.message)) summary = "expected a property name";
  else if (/Expected ':'/u.test(error.message)) summary = "expected ':' after a property name";
  else if (/Unexpected token/u.test(error.message)) summary = "unexpected JSON token";
  return `invalid JSON: ${summary} at line ${line}, column ${column}`;
}
