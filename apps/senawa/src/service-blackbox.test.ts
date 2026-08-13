import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalStringify } from "@senawa/protocol";
import {
  createRuntimeGraph,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const roots = new Set<string>();
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited(child);
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("built supervisor service and thin CLI", () => {
  it("submits, retries, drains, stops, and recovers durable state after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-service-blackbox-"));
    roots.add(root);
    chmodSync(root, 0o700);
    const environment = {
      ...process.env,
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
    };
    const serviceExecutable = new URL("../dist/main-service.js", import.meta.url).pathname;
    const cliExecutable = new URL("../dist/main.js", import.meta.url).pathname;
    let service = spawn(process.execPath, [serviceExecutable], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(service);
    await ready(cliExecutable, environment);

    const command = runtimeCommand({
      commandId: "command_blackbox",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
      },
    });
    const { principal: _principal, transport: _transport, ...submission } = command;
    const commandPath = join(root, "command.json");
    writeFileSync(commandPath, canonicalStringify(submission), { mode: 0o600 });
    const first = await cli(cliExecutable, environment, ["command", "submit", commandPath]);
    expect(JSON.parse(first).location.commandId).toBe(command.commandId);
    const retry = await cli(cliExecutable, environment, ["command", "submit", commandPath]);
    expect(JSON.parse(retry).location.commandId).toBe(command.commandId);

    const terminal = await eventually(async () => {
      const receipt = JSON.parse(
        await cli(cliExecutable, environment, ["receipt", "get", command.commandId]),
      );
      return receipt.status === "terminal" ? receipt : undefined;
    });
    expect(terminal.commandId).toBe(command.commandId);
    const events = JSON.parse(
      await cli(cliExecutable, environment, [
        "event",
        "list",
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
      ]),
    );
    expect(events.events).toHaveLength(3);

    await cli(cliExecutable, environment, ["service", "drain"]);
    const drained = JSON.parse(await cli(cliExecutable, environment, ["service", "status"]));
    expect(drained).toMatchObject({ lifecycle: "drained", mode: "drained" });
    await cli(cliExecutable, environment, ["service", "stop"]);
    await exited(service);
    children.delete(service);

    service = spawn(process.execPath, [serviceExecutable], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(service);
    await ready(cliExecutable, environment);
    const persisted = JSON.parse(
      await cli(cliExecutable, environment, ["receipt", "get", command.commandId]),
    );
    expect(persisted).toMatchObject({ commandId: command.commandId, status: "terminal" });
    await cli(cliExecutable, environment, ["service", "stop"]);
    await exited(service);
    children.delete(service);
  }, 40_000);
});

async function ready(executable: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await eventually(async () => {
    try {
      await cli(executable, environment, ["service", "status"]);
      return true;
    } catch {
      return undefined;
    }
  });
}

async function eventually<T>(operation: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Black-box service condition did not become true");
}

async function cli(
  executable: string,
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execute(process.execPath, [executable, ...arguments_], { env: environment });
  return result.stdout.trim();
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("exit", () => resolvePromise()));
}
