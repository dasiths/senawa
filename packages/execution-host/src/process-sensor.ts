import { type ChildProcess, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STATUS_BYTES = 4_096;
const supervisorPath = fileURLToPath(new URL("../dist/senawa-process-supervisor", import.meta.url));

export interface ExecutableSensorHostDependencies {
  readonly supervisorPath: string;
  realpath(path: string): Promise<string>;
  openRoot(path: string): Promise<FileHandle>;
  onSupervisorSpawned?(): void;
}

const defaultHostDependencies: ExecutableSensorHostDependencies = {
  supervisorPath,
  realpath,
  openRoot(path) {
    return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  },
};

export interface ExecutableSensorCommand {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly inheritedEnvironment: readonly string[];
}

export interface ExecutableSensorMeasurementRequest {
  readonly rootDirectory: string;
  readonly command: ExecutableSensorCommand;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  readonly terminationGraceMs: number;
  readonly signal?: AbortSignal;
}

export interface BoundedProcessOutput {
  readonly text: string;
  readonly capturedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export type ProcessCleanup = "not-needed" | "terminated" | "forced";

export interface ExecutableSensorMeasurement {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cleanup: ProcessCleanup;
  readonly stdout: BoundedProcessOutput;
  readonly stderr: BoundedProcessOutput;
}

export type ExecutableSensorFailureCode =
  | "unsupported-platform"
  | "invalid-request"
  | "cwd-escape"
  | "setup-failed"
  | "spawn-failed"
  | "cleanup-unconfirmed";

export interface ExecutableSensorFailure {
  readonly code: ExecutableSensorFailureCode;
  readonly message: string;
  readonly measurement?: ExecutableSensorMeasurement;
}

export type ExecutableSensorOutcome =
  | { readonly type: "measurement"; readonly measurement: ExecutableSensorMeasurement }
  | { readonly type: "failure"; readonly failure: ExecutableSensorFailure };

export async function measureExecutableSensor(
  request: ExecutableSensorMeasurementRequest,
  dependencies: ExecutableSensorHostDependencies = defaultHostDependencies,
): Promise<ExecutableSensorOutcome> {
  if (process.platform !== "linux" || process.arch !== "x64" || !hasGlibc()) {
    return failure(
      "unsupported-platform",
      "Executable sensors currently require Linux x64 with glibc",
    );
  }

  const invalid = validateRequest(request);
  if (invalid !== undefined) return failure("invalid-request", invalid);
  let setupCancelled = request.signal?.aborted === true;
  const latchSetupCancellation = (): void => {
    setupCancelled = true;
  };
  request.signal?.addEventListener("abort", latchSetupCancellation, { once: true });
  if (setupCancelled) {
    request.signal?.removeEventListener("abort", latchSetupCancellation);
    return measurementResult(createMeasurement(null, null, false, true, "not-needed"));
  }

  const environment = buildEnvironment(
    request.command.inheritedEnvironment,
    request.ambientEnvironment,
  );
  if (!request.command.argv[0].includes("/") && !Object.hasOwn(environment, "PATH")) {
    return failure("invalid-request", "A bare executable requires PATH in inheritedEnvironment");
  }

  const stdout = new PrefixCapture(request.command.maxStdoutBytes);
  const stderr = new PrefixCapture(request.command.maxStderrBytes);
  const status = new PrefixCapture(MAX_STATUS_BYTES);
  let rootHandle: FileHandle;
  try {
    const canonicalRoot = await dependencies.realpath(request.rootDirectory);
    if (setupCancelled) {
      request.signal?.removeEventListener("abort", latchSetupCancellation);
      return measurementResult(createMeasurement(null, null, false, true, "not-needed"));
    }
    rootHandle = await dependencies.openRoot(canonicalRoot);
  } catch (error) {
    request.signal?.removeEventListener("abort", latchSetupCancellation);
    return failure("setup-failed", errorMessage(error));
  }
  if (setupCancelled) {
    request.signal?.removeEventListener("abort", latchSetupCancellation);
    await closeIgnoringErrors(rootHandle);
    return measurementResult(createMeasurement(null, null, false, true, "not-needed"));
  }

  let child: ChildProcess;
  try {
    child = spawn(
      dependencies.supervisorPath,
      [request.command.cwd, String(request.terminationGraceMs), "--", ...request.command.argv],
      {
        env: environment,
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe", "pipe", rootHandle.fd],
      },
    );
  } catch (error) {
    request.signal?.removeEventListener("abort", latchSetupCancellation);
    await closeIgnoringErrors(rootHandle);
    return failure("spawn-failed", errorMessage(error));
  }
  let spawnError: Error | undefined;
  const closedPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  dependencies.onSupervisorSpawned?.();
  void closeIgnoringErrors(rootHandle);

  const childStdout = child.stdout;
  const childStderr = child.stderr;
  const childStatus = child.stdio[3];
  if (
    !(childStdout instanceof Readable) ||
    !(childStderr instanceof Readable) ||
    !(childStatus instanceof Readable)
  ) {
    request.signal?.removeEventListener("abort", latchSetupCancellation);
    child.kill("SIGTERM");
    await closedPromise;
    return failure("spawn-failed", "Process supervisor pipes were unavailable");
  }
  childStdout.on("data", (chunk: Buffer) => stdout.add(chunk));
  childStderr.on("data", (chunk: Buffer) => stderr.add(chunk));
  let supervisorReady = false;
  let terminationPending = false;
  const terminate = (): void => {
    if (supervisorReady) child.kill("SIGTERM");
    else terminationPending = true;
  };
  childStatus.on("data", (chunk: Buffer) => {
    status.add(chunk);
    if (!supervisorReady && hasSupervisorReadyFrame(status.output().text)) {
      supervisorReady = true;
      if (terminationPending) child.kill("SIGTERM");
    }
  });

  let timedOut = false;
  let cancelled: boolean = setupCancelled;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.command.timeoutMs);
  const abort = (): void => {
    cancelled = true;
    terminate();
  };
  request.signal?.removeEventListener("abort", latchSetupCancellation);
  request.signal?.addEventListener("abort", abort, { once: true });
  if (setupCancelled || request.signal?.aborted === true) abort();
  const closed = await closedPromise;
  clearTimeout(timeout);
  request.signal?.removeEventListener("abort", abort);

  if (spawnError !== undefined) return failure("spawn-failed", spawnError.message);
  const supervisorStatus = parseSupervisorStatus(status.output());
  if (supervisorStatus.type === "error") {
    return failure(
      failureCodeForStage(supervisorStatus.stage, supervisorStatus.errorNumber),
      `Process supervisor ${supervisorStatus.stage} failed (errno ${supervisorStatus.errorNumber})`,
      createMeasurement(
        null,
        null,
        timedOut,
        cancelled,
        "forced",
        stdout.output(),
        stderr.output(),
      ),
    );
  }
  if (supervisorStatus.type === "invalid") {
    return failure(
      "setup-failed",
      `Process supervisor returned invalid status (exit ${closed.code ?? "signal"})`,
    );
  }
  if (closed.code !== 0 || closed.signal !== null) {
    return failure("setup-failed", "Process supervisor exited unsuccessfully");
  }
  return measurementResult(
    createMeasurement(
      supervisorStatus.exitCode,
      signalName(supervisorStatus.signalNumber),
      timedOut,
      cancelled,
      supervisorStatus.cleanup,
      stdout.output(),
      stderr.output(),
    ),
  );
}

function hasGlibc(): boolean {
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: unknown } }
    | undefined;
  const version = report?.header?.glibcVersionRuntime;
  return typeof version === "string" && compareVersions(version, "2.34") >= 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function closeIgnoringErrors(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The spawned helper owns its duplicate descriptor independently.
  }
}

function validateRequest(request: ExecutableSensorMeasurementRequest): string | undefined {
  const { command } = request;
  if (command.argv.length === 0 || command.argv[0].length === 0) {
    return "Executable sensor argv requires a non-empty executable";
  }
  if (command.argv.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    return "Executable sensor argv must contain NUL-free strings";
  }
  if (!boundedInteger(command.timeoutMs, MAX_TIMER_MILLISECONDS)) {
    return `Executable sensor timeoutMs must be between 1 and ${MAX_TIMER_MILLISECONDS}`;
  }
  if (
    !boundedInteger(command.maxStdoutBytes, MAX_OUTPUT_BYTES) ||
    !boundedInteger(command.maxStderrBytes, MAX_OUTPUT_BYTES)
  ) {
    return `Executable sensor output bounds must be between 1 and ${MAX_OUTPUT_BYTES}`;
  }
  if (!boundedInteger(request.terminationGraceMs, MAX_TIMER_MILLISECONDS)) {
    return `Executable sensor terminationGraceMs must be between 1 and ${MAX_TIMER_MILLISECONDS}`;
  }
  if (command.cwd.length === 0 || command.cwd.includes("\0") || isAbsolute(command.cwd)) {
    return "Executable sensor cwd must be a non-empty relative path";
  }
  const seen = new Set<string>();
  for (const name of command.inheritedEnvironment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || seen.has(name)) {
      return "Inherited environment names must be unique portable identifiers";
    }
    seen.add(name);
    const value = Object.hasOwn(request.ambientEnvironment, name)
      ? request.ambientEnvironment[name]
      : undefined;
    if (value !== undefined && (typeof value !== "string" || value.includes("\0"))) {
      return "Inherited environment values must not contain NUL";
    }
  }
  return undefined;
}

function buildEnvironment(
  names: readonly string[],
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const value = Object.hasOwn(ambient, name) ? ambient[name] : undefined;
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

type SupervisorStatus =
  | {
      readonly type: "command";
      readonly exitCode: number | null;
      readonly signalNumber: number;
      readonly cleanup: ProcessCleanup;
    }
  | { readonly type: "error"; readonly stage: string; readonly errorNumber: number }
  | { readonly type: "invalid" };

function parseSupervisorStatus(output: BoundedProcessOutput): SupervisorStatus {
  if (output.truncated || !output.text.endsWith("\n")) return { type: "invalid" };
  const lines = output.text.slice(0, -1).split("\n");
  let line: string;
  if (lines.length === 1) {
    line = lines[0] as string;
  } else if (lines.length === 2 && lines[0] === "SENAWA1\tresult=ready") {
    line = lines[1] as string;
  } else {
    return { type: "invalid" };
  }
  const command =
    /^SENAWA1\tresult=command\tcode=(-1|\d+)\tsignal=(\d+)\tcleanup=(not-needed|terminated|forced)$/u.exec(
      line,
    );
  if (command !== null) {
    if (lines.length !== 2) return { type: "invalid" };
    const exitCode = Number(command[1]);
    return {
      type: "command",
      exitCode: exitCode < 0 ? null : exitCode,
      signalNumber: Number(command[2]),
      cleanup: command[3] as ProcessCleanup,
    };
  }
  const error = /^SENAWA1\tresult=error\tstage=([a-z0-9-]+)\terrno=(\d+)$/u.exec(line);
  return error === null
    ? { type: "invalid" }
    : { type: "error", stage: error[1] as string, errorNumber: Number(error[2]) };
}

function hasSupervisorReadyFrame(value: string): boolean {
  return value.startsWith("SENAWA1\tresult=ready\n");
}

function failureCodeForStage(stage: string, errorNumber: number): ExecutableSensorFailureCode {
  if (stage === "exec") return "spawn-failed";
  if (stage === "cleanup" || stage === "leader-status") return "cleanup-unconfirmed";
  if (stage === "openat2" && (errorNumber === 18 || errorNumber === 40)) return "cwd-escape";
  return "setup-failed";
}

function signalName(signalNumber: number): string | null {
  if (signalNumber === 0) return null;
  for (const [name, number] of Object.entries(osConstants.signals)) {
    if (number === signalNumber) return name;
  }
  return `SIG${signalNumber}`;
}

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

class PrefixCapture {
  readonly limit: number;
  readonly chunks: Buffer[] = [];
  capturedBytes = 0;
  totalBytes = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  add(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    const remaining = this.limit - this.capturedBytes;
    if (remaining <= 0) return;
    const prefix = chunk.subarray(0, remaining);
    this.chunks.push(prefix);
    this.capturedBytes += prefix.length;
  }

  output(): BoundedProcessOutput {
    const bytes = Buffer.concat(this.chunks, this.capturedBytes);
    return Object.freeze({
      text: bytes.subarray(0, completeUtf8PrefixLength(bytes)).toString("utf8"),
      capturedBytes: this.capturedBytes,
      totalBytes: this.totalBytes,
      truncated: this.totalBytes > this.capturedBytes,
    });
  }
}

function completeUtf8PrefixLength(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let leadIndex = bytes.length - 1;
  while (leadIndex >= 0 && ((bytes[leadIndex] as number) & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return bytes.length;
  const lead = bytes[leadIndex] as number;
  const expectedLength =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  return bytes.length - leadIndex < expectedLength ? leadIndex : bytes.length;
}

function createMeasurement(
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
  cancelled: boolean,
  cleanup: ProcessCleanup,
  stdout: BoundedProcessOutput = emptyOutput(),
  stderr: BoundedProcessOutput = emptyOutput(),
): ExecutableSensorMeasurement {
  return Object.freeze({ exitCode, signal, timedOut, cancelled, cleanup, stdout, stderr });
}

function emptyOutput(): BoundedProcessOutput {
  return Object.freeze({ text: "", capturedBytes: 0, totalBytes: 0, truncated: false });
}

function measurementResult(measurement: ExecutableSensorMeasurement): ExecutableSensorOutcome {
  return Object.freeze({ type: "measurement", measurement });
}

function failure(
  code: ExecutableSensorFailureCode,
  message: string,
  measurement?: ExecutableSensorMeasurement,
): ExecutableSensorOutcome {
  return Object.freeze({
    type: "failure",
    failure: Object.freeze({
      code,
      message,
      ...(measurement === undefined ? {} : { measurement }),
    }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
