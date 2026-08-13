import { spawn } from "node:child_process";
import { fchmodSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { canonicalBytes, canonicalStringify, PROTOCOL_VERSION } from "@senawa/protocol";
import {
  HttpSupervisorClient,
  readPrivateCredential,
  recoverRunOnce,
  SqliteSupervisorAuthority,
} from "@senawa/supervisor";
import type { CliResult } from "./cli.js";
import {
  resolveSenawaServicePaths,
  runSenawaServiceForeground,
  runtimeDependencies,
} from "./daemon.js";

export async function runOperationalCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CliResult | undefined> {
  const [group, action, ...rest] = arguments_;
  if (
    group === "doctor" ||
    group === "init" ||
    group === undefined ||
    group === "--help" ||
    group === "-h" ||
    group === "--version" ||
    group === "-v"
  ) {
    return undefined;
  }
  const paths = resolveSenawaServicePaths(environment);
  if (group === "service" && action === "run" && rest.length === 0) {
    await runSenawaServiceForeground(environment);
    return success("Supervisor stopped");
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
    const content = rest[0] === "-" ? await readStdin() : readFileSync(rest[0] as string, "utf8");
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function success(output: string): CliResult {
  return { output, exitCode: 0 };
}

function invalid(output: string): CliResult {
  return { output, exitCode: 1 };
}
