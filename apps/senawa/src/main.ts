import { spawn } from "node:child_process";
import { join } from "node:path";
import { CopilotSubprocessHost, DeterministicWorkerHost } from "@senawa/workers";
import { createRuntimeComposition, selectRuntime } from "./composition.js";
import { runCli } from "./program.js";
import { createSenawaServices } from "./services.js";

const arguments_ = process.argv.slice(2);
const repositoryRoot = process.cwd();
const workerHost = optionValue(arguments_, "--worker-host") ?? "deterministic";
const deterministicHost = new DeterministicWorkerHost();
const copilotHost = new CopilotSubprocessHost({
  enabled: true,
  repositoryRoot,
  isolationRoot: join(repositoryRoot, ".agents", ".copilot-tracking", "copilot-home"),
});

try {
  const runtime = selectRuntime(arguments_);
  const { persistence, notifier } = createRuntimeComposition(repositoryRoot, runtime);
  process.exitCode = await runCli(arguments_, {
    services: createSenawaServices(repositoryRoot, {
      persistence,
      notifier,
      runtimeBackend: runtime,
      ...(workerHost === "copilot"
        ? {
            workerHost: {
              execute: (turn) =>
                turn.owner.kind === "task"
                  ? copilotHost.execute(turn)
                  : deterministicHost.execute(turn),
            },
          }
        : {}),
    }),
    openBrowser,
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function openBrowser(url: string): Promise<void> {
  const browserEnvironmentKey = "BROWSER";
  const configured = process.env[browserEnvironmentKey];
  const command =
    configured ??
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open");
  const arguments_ =
    process.platform === "win32" && configured === undefined ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn(command, arguments_, { detached: true, stdio: "ignore" });
    child.once("error", rejectOpen);
    child.once("spawn", () => {
      child.unref();
      resolveOpen();
    });
  });
}

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}
