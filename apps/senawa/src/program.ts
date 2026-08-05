import { setTimeout as delay } from "node:timers/promises";
import type { CommandActor } from "@senawa/core";
import type { SenawaServices } from "@senawa/orchestrator";
import { startWebSupervisor } from "@senawa/web";
import { Command, CommanderError, Option } from "commander";

const actor: CommandActor = { channel: "direct-cli" };

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface CliRunOptions {
  readonly services: SenawaServices;
  readonly io?: CliIo;
  readonly holdWeb?: boolean;
  readonly openBrowser?: (url: string) => Promise<void>;
}

export async function runCli(
  arguments_: readonly string[],
  options: CliRunOptions,
): Promise<number> {
  const io = options.io ?? {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
  let resultCode = 0;
  const program = new Command()
    .name("senawa")
    .description("Drive bounded Senawa workflows")
    .addOption(
      new Option("--worker-host <host>", "worker execution host")
        .choices(["deterministic", "copilot"])
        .default("deterministic"),
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program.command("doctor").action(async () => {
    const workflows = await options.services.queries.workflows();
    for (const workflow of workflows) await options.services.loadDefinitions(workflow);
    writeJson(io, { ok: true, workflows });
  });

  const workflow = program.command("workflow");
  workflow
    .command("list")
    .action(async () => writeJson(io, await options.services.queries.workflows()));
  workflow
    .command("info")
    .argument("<name>")
    .action(async (name: string) => writeJson(io, await options.services.queries.workflow(name)));
  workflow
    .command("render")
    .argument("<name>")
    .action(async (name: string) => io.stdout(await options.services.queries.renderWorkflow(name)));

  const work = program.command("work");
  work
    .command("start")
    .argument("<goal>")
    .requiredOption("--workflow <name>")
    .option("--detach")
    .action(async (goal: string, commandOptions: { workflow: string; detach?: boolean }) => {
      const started = await options.services.commands.start({
        actor,
        definitions: await options.services.loadDefinitions(commandOptions.workflow),
        request: { goal, constraints: [] },
      });
      const result = await options.services.commands.drive(started.runId, actor);
      writeJson(io, { ...result, detach: commandOptions.detach ?? false });
      if (result.kind === "awaiting-approval" || result.kind === "task-escalated") resultCode = 2;
    });
  work.command("resume").action(async () => {
    const runId = await requireActiveRun(options.services);
    const result = await options.services.commands.resume(runId, actor);
    writeJson(io, result);
    if (result.kind === "awaiting-approval" || result.kind === "task-escalated") resultCode = 2;
  });
  work
    .command("show")
    .argument("[runId]")
    .action(async (runId?: string) => writeJson(io, await options.services.queries.status(runId)));
  work
    .command("wait")
    .option("--timeout <seconds>", "bounded wait in seconds", "30")
    .action(async (commandOptions: { timeout: string }) => {
      const runId = await requireActiveRun(options.services);
      const initial = await options.services.queries.status(runId);
      const timeoutMs = parseSeconds(commandOptions.timeout) * 1_000;
      const deadline = Date.now() + timeoutMs;
      let current = initial;
      while (Date.now() < deadline) {
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
        current = await options.services.queries.status(runId);
        if (current?.cursor !== initial?.cursor || current?.status !== initial?.status) break;
      }
      writeJson(io, current);
    });
  work
    .command("end")
    .requiredOption("--reason <reason>")
    .action(async (commandOptions: { reason: string }) => {
      writeJson(
        io,
        await options.services.commands.end(
          await requireActiveRun(options.services),
          commandOptions.reason,
          actor,
        ),
      );
    });
  work
    .command("report")
    .argument("[runId]")
    .action(async (runId?: string) =>
      io.stdout(
        await options.services.queries.report(runId ?? (await requireActiveRun(options.services))),
      ),
    );
  work
    .command("web")
    .argument("[runId]")
    .option("--port <port>", "loopback port", "0")
    .action(async (runId: string | undefined, commandOptions: { port: string }) => {
      const supervisor = await startWebSupervisor(options.services, {
        ...(runId === undefined ? {} : { runId }),
        port: parsePort(commandOptions.port),
      });
      writeJson(io, {
        runId: supervisor.runId,
        url: supervisor.bootstrapUrl,
        browserUrl: supervisor.url,
      });
      if (options.holdWeb !== false) {
        const close = () => void supervisor.close();
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
        try {
          await supervisor.closed;
        } finally {
          process.off("SIGINT", close);
          process.off("SIGTERM", close);
        }
      } else {
        await supervisor.close();
      }
    });

  program
    .command("browser")
    .description("Open the active run in the local Senawa browser console")
    .argument("[runId]")
    .option("--port <port>", "loopback port", "0")
    .option("--no-open", "print a fresh bootstrap URL without opening it")
    .action(async (runId: string | undefined, commandOptions: { port: string; open: boolean }) => {
      const supervisor = await startWebSupervisor(options.services, {
        ...(runId === undefined ? {} : { runId }),
        port: parsePort(commandOptions.port),
      });
      let opened = false;
      if (commandOptions.open) {
        if (options.openBrowser === undefined) {
          await supervisor.close();
          throw new Error("No browser opener is configured; retry with --no-open");
        }
        try {
          await options.openBrowser(supervisor.bootstrapUrl);
          opened = true;
        } catch (error) {
          await supervisor.close();
          throw error;
        }
      }
      writeJson(io, {
        runId: supervisor.runId,
        url: supervisor.bootstrapUrl,
        browserUrl: supervisor.url,
        opened,
      });
      if (options.holdWeb !== false) {
        const close = () => void supervisor.close();
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
        try {
          await supervisor.closed;
        } finally {
          process.off("SIGINT", close);
          process.off("SIGTERM", close);
        }
      } else {
        await supervisor.close();
      }
    });

  program
    .command("approve")
    .argument("<phase>")
    .option("--note <note>")
    .action(async (phase: string, commandOptions: { note?: string }) =>
      writeJson(
        io,
        await options.services.commands.approve(
          await requireActiveRun(options.services),
          phase,
          actor,
          commandOptions.note,
        ),
      ),
    );
  program
    .command("reject")
    .argument("<phase>")
    .requiredOption("--reason <reason>")
    .action(async (phase: string, commandOptions: { reason: string }) =>
      writeJson(
        io,
        await options.services.commands.reject(
          await requireActiveRun(options.services),
          phase,
          commandOptions.reason,
          actor,
        ),
      ),
    );
  program
    .command("steer")
    .argument("<task>")
    .argument("<instruction>")
    .action(async (task: string, instruction: string) =>
      writeJson(
        io,
        await options.services.commands.steer(
          await requireActiveRun(options.services),
          task,
          instruction,
          actor,
        ),
      ),
    );

  try {
    await program.parseAsync(["node", "senawa", ...arguments_]);
    return resultCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function requireActiveRun(services: SenawaServices): Promise<string> {
  const runId = await services.queries.activeRunId();
  if (runId === null) throw new Error("No active run exists");
  return runId;
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function parseSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300) {
    throw new Error("Timeout must be between 0 and 300 seconds");
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("Port must be between 0 and 65535");
  }
  return parsed;
}
