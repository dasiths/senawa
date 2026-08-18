import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import {
  canonicalBytes,
  canonicalStringify,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import { checkSqliteAuthorityIntegrity } from "@senawa/storage-sqlite";
import {
  HttpSupervisorClient,
  readPrivateCredential,
  recoverRunOnce,
  SqliteSupervisorAuthority,
  type SupervisorServiceStatus,
} from "@senawa/supervisor";
import { type CliResult, SENAWA_VERSION } from "./cli.js";
import {
  resolveSenawaServicePaths,
  runSenawaServiceForeground,
  runtimeDependencies,
} from "./daemon.js";
import { createDiagnosticsDirectory, createRepairPlan } from "./maintenance.js";
import { exportSqliteReportingDirectory, verifyReportingDirectory } from "./report-export.js";
import { restoreSupervisorStateRoot, verifySupervisorStateBackup } from "./state-backup.js";

const MAX_OPERATIONAL_ARGUMENT_LENGTH = 4_096;

import { runAdvanceCommand } from "./advance-command.js";
import { decidePhase } from "./decide.js";
import {
  type InspectOptions,
  inspectPhase,
  listArtifacts,
  listDispatches,
  readArtifact,
} from "./inspect.js";
import { runGates } from "./run-gates.js";
import { runStatus } from "./run-status.js";
import { runStartCommand } from "./start-command.js";
import { runWorkerCli } from "./worker-cli.js";

/** The local operator identity a consumer acts as when starting a run. */
const startPrincipal = Object.freeze({
  issuer: "senawa.local",
  subject: "operator",
  tenant: "local",
  assurance: "single-factor" as const,
  roles: Object.freeze(["operator", "release-manager"]),
});

export async function runOperationalCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeDependencies = runtimeDependencies,
): Promise<CliResult | undefined> {
  const [group, action, ...rest] = arguments_;
  if (
    group === "doctor" ||
    group === "init" ||
    group === undefined ||
    arguments_.includes("--help") ||
    arguments_.includes("-h") ||
    arguments_.includes("--version") ||
    arguments_.includes("-v")
  ) {
    return undefined;
  }
  const paths = resolveSenawaServicePaths(environment);
  if (group === "status" && action !== undefined && rest.length === 1) {
    return runStatus({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      repositoryId: action,
      runId: rest[0] ?? "",
      dependencies,
      currentTime: new Date().toISOString(),
    });
  }
  if (group === "start" && action !== undefined && rest.length <= 2) {
    const detached = rest.includes("--detach");
    const positional = rest.filter((value) => value !== "--detach");
    // `start` reaches the authority directly rather than through the service,
    // because a consumer starting a run should not have to start a daemon first.
    return runStartCommand(
      {
        projectRoot: process.cwd(),
        requestPath: action,
        repositoryId: `repository_${basename(process.cwd())}`,
        ...(positional[0] === undefined ? {} : { runId: positional[0] }),
        ...(detached ? { detach: true } : {}),
      },
      { databasePath: paths.databasePath, assetDirectory: paths.assetDirectory },
      dependencies,
      startPrincipal,
      new Date().toISOString(),
    );
  }
  if (group === "advance" && action !== undefined && rest.length === 1) {
    return runAdvanceCommand(
      { projectRoot: process.cwd(), repositoryId: action, runId: rest[0] ?? "" },
      { databasePath: paths.databasePath, assetDirectory: paths.assetDirectory },
      dependencies,
      startPrincipal,
      new Date().toISOString(),
    );
  }
  if (group === "phase" && action !== undefined && rest.length === 2) {
    return inspectPhase(inspectOptions(paths, dependencies, action, rest[0] ?? ""), rest[1] ?? "");
  }
  if (group === "artifact" && action === "list" && rest.length === 2) {
    return listArtifacts(inspectOptions(paths, dependencies, rest[0] ?? "", rest[1] ?? ""));
  }
  if (group === "artifact" && action === "read" && rest.length === 3) {
    return readArtifact(
      inspectOptions(paths, dependencies, rest[0] ?? "", rest[1] ?? ""),
      rest[2] ?? "",
    );
  }
  if (group === "agent" && action === "list" && rest.length === 2) {
    return listDispatches(inspectOptions(paths, dependencies, rest[0] ?? "", rest[1] ?? ""));
  }
  if ((group === "approve" || group === "reject") && action !== undefined && rest.length >= 1) {
    return decidePhase({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      repositoryId: action,
      runId: rest[0] ?? "",
      decision: group,
      ...(rest.length > 1 ? { reason: rest.slice(1).join(" ") } : {}),
      principal: startPrincipal,
      dependencies,
      currentTime: new Date().toISOString(),
    });
  }
  if (group === "run-gates" && action !== undefined && rest.length === 0) {
    return await runGates({ projectRoot: process.cwd(), phaseKey: action, dependencies });
  }
  if (group === "worker") {
    return await runWorkerCli(action, rest, {
      socketPath: paths.socketPath,
      environment,
      workspaceRoot: process.cwd(),
    });
  }
  if (group === "service" && action === "run" && rest.length === 0) {
    await runSenawaServiceForeground(environment);
    return success("Supervisor stopped");
  }
  if (group === "report" && action === "create" && rest.length === 3) {
    const repositoryId = boundedArgument(rest[0]);
    const runId = boundedArgument(rest[1]);
    const destinationDirectory = boundedArgument(rest[2]);
    const manifest = exportSqliteReportingDirectory({
      databasePath: paths.databasePath,
      dependencies,
      repositoryId,
      runId,
      destinationDirectory,
    });
    return success(canonicalStringify(manifest));
  }
  if (group === "export" && action === "verify" && rest.length === 1) {
    const directory = boundedArgument(rest[0]);
    return success(canonicalStringify(verifyReportingDirectory(directory, dependencies.sha256)));
  }
  if (group === "export" && action === "restore") {
    return invalid("Report exports are non-restorable; restore requires a verified backup");
  }
  if (group === "backup" && action === "create" && rest.length === 1) {
    const request = createBackupRequest(boundedArgument(rest[0]), dependencies);
    try {
      return success(canonicalStringify(await clientFor(paths).backupState(request)));
    } catch {
      return invalid(canonicalStringify({ status: "failed", code: "backup-refused" }));
    }
  }
  if ((group === "backup" || group === "restore") && action === "verify" && rest.length === 1) {
    const directory = boundedArgument(rest[0]);
    try {
      const manifest = verifySupervisorStateBackup(directory, dependencies);
      return success(
        canonicalStringify({
          format: manifest.format,
          version: manifest.version,
          requestId: manifest.requestId,
          status: "verified",
        }),
      );
    } catch {
      return invalid(canonicalStringify({ status: "failed", code: "backup-integrity-failed" }));
    }
  }
  if (group === "restore" && action === "apply" && rest.length === 2) {
    const backupDirectory = boundedArgument(rest[0]);
    const destinationStateRoot = boundedArgument(rest[1]);
    return applyFreshRestore(
      paths,
      backupDirectory,
      destinationStateRoot,
      dependencies,
      "restore-refused",
    );
  }
  if (group === "integrity" && action === "check" && rest.length === 0) {
    const report = checkSqliteAuthorityIntegrity({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
    });
    return { output: canonicalStringify(report), exitCode: report.status === "passed" ? 0 : 1 };
  }
  if (group === "diagnostics" && action === "create" && rest.length === 1) {
    const destinationDirectory = boundedArgument(rest[0]);
    const integrity = checkSqliteAuthorityIntegrity({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
    });
    let serviceStatus: SupervisorServiceStatus | undefined;
    if (existsSync(paths.socketPath)) {
      try {
        serviceStatus = await clientFor(paths).status();
      } catch {
        serviceStatus = undefined;
      }
    }
    try {
      const manifest = createDiagnosticsDirectory({
        destinationDirectory,
        productVersion: SENAWA_VERSION,
        integrity,
        ...(serviceStatus === undefined ? {} : { serviceStatus }),
      });
      return success(
        canonicalStringify({
          format: manifest.format,
          version: manifest.version,
          classification: manifest.classification,
          status: "created",
        }),
      );
    } catch {
      return invalid(canonicalStringify({ status: "failed", code: "diagnostics-refused" }));
    }
  }
  if (group === "repair" && action === "plan" && rest.length === 0) {
    const integrity = checkSqliteAuthorityIntegrity({
      databasePath: paths.databasePath,
      assetDirectory: paths.assetDirectory,
      dependencies,
    });
    return success(canonicalStringify(createRepairPlan(integrity, dependencies.sha256)));
  }
  if (group === "repair" && action === "apply" && rest.length === 2) {
    const backupDirectory = boundedArgument(rest[0]);
    const destinationStateRoot = boundedArgument(rest[1]);
    return applyFreshRestore(
      paths,
      backupDirectory,
      destinationStateRoot,
      dependencies,
      "repair-refused",
    );
  }
  if (group === "service" && action === "start") return startService(paths, environment);
  const client = clientFor(paths);
  if (group === "service" && action === "status" && rest.length === 0) {
    return success(canonicalStringify(await client.status()));
  }
  if (group === "service" && action === "drain" && rest.length === 0) {
    await client.drain();
    return success("Supervisor drain accepted");
  }
  if (group === "service" && action === "stop" && rest.length === 0) {
    await client.stop();
    return success("Supervisor stop accepted");
  }
  if (group === "service" && action === "logs") {
    const after = rest[0] === undefined ? undefined : integer(rest[0], "after");
    return success(canonicalStringify(await client.logs(after, 100)));
  }
  if (group === "service" && action === "recover") {
    const [repositoryId, runId, option] = rest;
    if (repositoryId === undefined || runId === undefined)
      return invalid("recover requires repository and run IDs");
    if (option === "--direct") {
      const authority = new SqliteSupervisorAuthority({
        databasePath: paths.databasePath,
        assetDirectory: paths.assetDirectory,
        dependencies: runtimeDependencies,
      });
      try {
        const now = new Date().toISOString();
        const result = await recoverRunOnce(authority, {
          repositoryId,
          runId,
          ownerId: `direct-${process.pid}`,
          currentTime: now,
        });
        return success(canonicalStringify({ worked: result.receipt !== undefined }));
      } finally {
        authority.close();
      }
    }
    if (option !== undefined) return invalid("unknown recover option");
    return success(canonicalStringify(await client.recover({ repositoryId, runId })));
  }
  if (group === "command" && action === "submit" && rest.length === 1) {
    const content = rest[0] === "-" ? await readStdin() : readBoundedCommandFile(rest[0] as string);
    return success(canonicalStringify(await client.submitCommand(content)));
  }
  if (group === "receipt" && action === "get" && rest.length === 1) {
    return success(canonicalStringify(await client.getReceipt({ commandId: rest[0] })));
  }
  if (group === "receipt" && action === "list" && rest.length >= 2) {
    return success(canonicalStringify(await client.listReceipts(pageRequest(rest))));
  }
  if (group === "event" && action === "list" && rest.length >= 2) {
    return success(canonicalStringify(await client.listEvents(pageRequest(rest))));
  }
  if (group === "projection" && action === "get" && rest.length === 2) {
    return success(
      canonicalStringify(await client.getProjection({ repositoryId: rest[0], runId: rest[1] })),
    );
  }
  if (group === "amendment" && action === "list" && rest.length === 2) {
    return success(
      canonicalStringify(await client.listAmendments({ repositoryId: rest[0], runId: rest[1] })),
    );
  }
  if (group === "amendment" && action === "get" && rest.length === 3) {
    return success(
      canonicalStringify(
        await client.getAmendment({
          repositoryId: rest[0],
          runId: rest[1],
          amendmentId: rest[2],
        }),
      ),
    );
  }
  if (group === "amendment" && action === "source" && rest.length === 3) {
    return success(
      canonicalStringify(
        await client.getAmendmentSource({
          repositoryId: rest[0],
          runId: rest[1],
          amendmentId: rest[2],
        }),
      ),
    );
  }
  if (group === "amendment" && action === "status" && rest.length === 3) {
    const amendment = await client.getAmendment({
      repositoryId: rest[0],
      runId: rest[1],
      amendmentId: rest[2],
    });
    return success(canonicalStringify(amendment.lifecycle));
  }
  if (
    group === "amendment" &&
    (action === "withdraw" || action === "approve" || action === "reject") &&
    rest.length === 3
  ) {
    const [repositoryId, runId, amendmentId] = rest as [string, string, string];
    const amendment = await client.getAmendment({ repositoryId, runId, amendmentId });
    const proposal = exactRecord(amendment.proposal, "amendment proposal");
    const proposalDigest = exactDigest(proposal.proposalDigest, "proposalDigest");
    const baseGraph = exactRecord(proposal.baseGraph, "base graph");
    const baseGraphRevision = exactDigest(baseGraph.revisionDigest, "base graph revision");
    const reviewedResultGraph = exactRecord(proposal.reviewedResultGraph, "reviewed result graph");
    const reviewedResultGraphRevisionDigest = exactDigest(
      reviewedResultGraph.revisionDigest,
      "reviewed result graph revision",
    );
    const payload =
      action === "withdraw"
        ? { amendmentId, proposalDigest }
        : {
            amendmentId,
            proposalDigest,
            decision: action,
            reviewedResultGraphRevisionDigest,
          };
    const submission = {
      apiVersion: PROTOCOL_VERSION,
      commandId: `command_amendment-${action}-${proposalDigest.slice(0, 24)}`,
      repositoryId,
      runId,
      intent: {
        type:
          action === "withdraw"
            ? ("withdraw-amendment-proposal" as const)
            : ("record-amendment-decision" as const),
      },
      payload,
      payloadDigest: runtimeDependencies.sha256.digest(canonicalBytes(payload)),
      expectedGraphRevision: baseGraphRevision,
      exactObjectDigest: proposalDigest,
    };
    return success(canonicalStringify(await client.submitCommand(submission)));
  }
  if (group === "amendment" && action === "recover" && rest.length === 2) {
    return success(
      canonicalStringify(await client.recover({ repositoryId: rest[0], runId: rest[1] })),
    );
  }
  if (group === "portal" && action === undefined) {
    const bootstrap = await client.createPortalSession();
    const status = await client.status();
    const origin = status.listeners.find(({ kind }) => kind === "loopback")?.address;
    if (origin === undefined) return invalid("loopback portal listener is not enabled");
    return success(`${origin}${bootstrap.path}`);
  }
  return invalid("Unknown operational command");
}

export function createBackupRequest(
  destinationArgument: string,
  dependencies: Pick<RuntimeDependencies, "sha256">,
): { readonly requestId: string; readonly destinationDirectory: string } {
  const destinationDirectory = resolve(destinationArgument);
  return Object.freeze({
    requestId: `backup_${dependencies.sha256
      .digest(new TextEncoder().encode(destinationDirectory))
      .slice(0, 40)}`,
    destinationDirectory,
  });
}

function clientFor(paths: ReturnType<typeof resolveSenawaServicePaths>): HttpSupervisorClient {
  const credential = readPrivateCredential(paths.credentialPath);
  return new HttpSupervisorClient({ socketPath: paths.socketPath, credential: credential.token });
}

async function startService(
  paths: ReturnType<typeof resolveSenawaServicePaths>,
  environment: NodeJS.ProcessEnv,
): Promise<CliResult> {
  try {
    await clientFor(paths).status();
    return success("Supervisor is already running");
  } catch {
    // Readiness below distinguishes a successful detached start from a stale local artifact.
  }
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(paths.serviceLogPath, "a", 0o600);
  fchmodSync(descriptor, 0o600);
  const executable = new URL("./main-service.js", import.meta.url);
  const child = spawn(process.execPath, [executable.pathname], {
    detached: true,
    stdio: ["ignore", descriptor, descriptor],
    env: environment,
  });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const status = await clientFor(paths).status();
      return success(`Supervisor started (pid ${status.processId})`);
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  return { output: "Supervisor did not become ready", exitCode: 1 };
}

function pageRequest(arguments_: readonly string[]) {
  const [repositoryId, runId, after, limit] = arguments_;
  return {
    repositoryId,
    runId,
    ...(after === undefined ? {} : { afterCursor: integer(after, "after") }),
    ...(limit === undefined ? {} : { limit: integer(limit, "limit") }),
  };
}

function integer(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`${label} must be an integer`);
  return Number(value);
}

function boundedArgument(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > MAX_OPERATIONAL_ARGUMENT_LENGTH) {
    throw new TypeError("Operational command argument is outside its size limit");
  }
  return value;
}

function applyFreshRestore(
  paths: ReturnType<typeof resolveSenawaServicePaths>,
  backupDirectory: string,
  destinationStateRoot: string,
  dependencies: RuntimeDependencies,
  failureCode: "restore-refused" | "repair-refused",
): CliResult {
  if (existsSync(paths.socketPath)) {
    return invalid(canonicalStringify({ status: "failed", code: failureCode }));
  }
  try {
    const restored = restoreSupervisorStateRoot({
      backupDirectory,
      destinationStateRoot,
      dependencies,
    });
    restored.close();
    return success(canonicalStringify({ status: "restored" }));
  } catch {
    return invalid(canonicalStringify({ status: "failed", code: failureCode }));
  }
}

function exactRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a digest`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  return readBoundedCommandStream(process.stdin);
}

export async function readBoundedCommandStream(
  stream: AsyncIterable<string | Uint8Array>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > PROTOCOL_LIMITS.maxWireBytes) throw new TypeError("Command input exceeds 256 KiB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function readBoundedCommandFile(path: string): string {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > PROTOCOL_LIMITS.maxWireBytes) {
      throw new TypeError("Command input exceeds 256 KiB");
    }
    const buffer = Buffer.allocUnsafe(PROTOCOL_LIMITS.maxWireBytes + 1);
    let total = 0;
    while (total <= PROTOCOL_LIMITS.maxWireBytes) {
      const bytesRead = readSync(descriptor, buffer, total, buffer.byteLength - total, null);
      if (bytesRead === 0) return buffer.subarray(0, total).toString("utf8");
      total += bytesRead;
    }
    throw new TypeError("Command input exceeds 256 KiB");
  } finally {
    closeSync(descriptor);
  }
}

function success(output: string): CliResult {
  return { output, exitCode: 0 };
}

function invalid(output: string): CliResult {
  return { output, exitCode: 1 };
}

/** Assembles the shared inspection scope so each command reads the same run. */
function inspectOptions(
  paths: { readonly databasePath: string; readonly assetDirectory: string },
  dependencies: RuntimeDependencies,
  repositoryId: string,
  runId: string,
): InspectOptions {
  return {
    databasePath: paths.databasePath,
    assetDirectory: paths.assetDirectory,
    repositoryId,
    runId,
    dependencies,
    currentTime: new Date().toISOString(),
  };
}
