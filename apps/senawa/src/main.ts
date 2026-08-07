import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  COPILOT_SDK_WORKER_ADAPTER_VERSION,
  COPILOT_SUBPROCESS_WORKER_ADAPTER_VERSION,
  CopilotSdkWorkerAdapter,
  CopilotSubprocessHost,
  SIMULATED_WORKER_ADAPTER_VERSION,
  SimulatedWorkerHost,
} from "@senawa/workers";
import { createRuntimeComposition, selectRuntime } from "./composition.js";
import { resolveExecutable } from "./executable.js";
import { optionValue, parseWorkerHostOption } from "./execution-options.js";
import { runCli } from "./program.js";
import { createSenawaServices, type SenawaServices } from "./services.js";
import { createSdkWorkerBindings } from "./worker-bindings.js";
import { LazyWorkerHostResolver } from "./worker-host-resolver.js";

const arguments_ = process.argv.slice(2);
const repositoryRoot = process.cwd();
const workerHost = parseWorkerHostOption(optionValue(arguments_, "--worker-host")).kind;
let services: SenawaServices | undefined;
const copilotExecutable = () =>
  resolveExecutable(
    typeof Reflect.get(process.env, "SENAWA_COPILOT_CLI") === "string"
      ? String(Reflect.get(process.env, "SENAWA_COPILOT_CLI"))
      : "copilot",
  );
const workerHosts = new LazyWorkerHostResolver({
  simulated: () => new SimulatedWorkerHost(),
  "copilot-subprocess": () =>
    new CopilotSubprocessHost({
      enabled: true,
      repositoryRoot,
      isolationRoot: join(repositoryRoot, ".agents", ".copilot-tracking", "copilot-home"),
      executable: copilotExecutable(),
    }),
  "copilot-sdk": () =>
    new CopilotSdkWorkerAdapter({
      repositoryRoot,
      isolationRoot: join(repositoryRoot, ".agents", ".copilot-tracking", "copilot-sdk-home"),
      runtimePath: copilotExecutable(),
      bindings: createSdkWorkerBindings(() => {
        if (services === undefined) throw new Error("Senawa services are not initialized");
        return services;
      }),
    }),
});

try {
  const runtime = selectRuntime(arguments_);
  const { persistence, notifier, receiptStore, repositoryEvidence } = createRuntimeComposition(
    repositoryRoot,
    runtime,
  );
  services = createSenawaServices(repositoryRoot, {
    persistence,
    notifier,
    receiptStore,
    repositoryEvidence,
    runtimeBackend: runtime,
    workerHostResolver: workerHosts,
    workerHostIdentity: {
      kind: workerHost,
      adapter: workerHost === "simulated" ? "simulated-worker" : workerHost,
      adapterVersion:
        workerHost === "copilot-sdk"
          ? COPILOT_SDK_WORKER_ADAPTER_VERSION
          : workerHost === "copilot-subprocess"
            ? COPILOT_SUBPROCESS_WORKER_ADAPTER_VERSION
            : SIMULATED_WORKER_ADAPTER_VERSION,
      legacy: false,
    },
  });
  process.exitCode = await runCli(arguments_, {
    services,
    openBrowser,
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await workerHosts.shutdown();
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
