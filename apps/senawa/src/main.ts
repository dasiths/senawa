import { spawn } from "node:child_process";
import { join } from "node:path";
import { FileRunDocumentStore } from "@senawa/artifact-store";
import { FileJournalStore, FileOutputLogStore, RunChangeNotifier } from "@senawa/observability";
import {
  FileActiveRunRegistry,
  FileLeaseStore,
  FileRunPersistence,
  FileRuntimeStateStore,
} from "@senawa/runtime-file";
import { CopilotSubprocessHost, DeterministicWorkerHost } from "@senawa/workers";
import { runCli } from "./program.js";
import { createSenawaServices } from "./services.js";

const arguments_ = process.argv.slice(2);
const repositoryRoot = process.cwd();
const workerHost = optionValue(arguments_, "--worker-host") ?? "deterministic";
const deterministicHost = new DeterministicWorkerHost();
const notifier = new RunChangeNotifier();
const persistence = new FileRunPersistence(repositoryRoot, {
  runtime: new FileRuntimeStateStore(repositoryRoot),
  activeRuns: new FileActiveRunRegistry(repositoryRoot),
  documents: new FileRunDocumentStore(repositoryRoot),
  journal: new FileJournalStore(repositoryRoot, notifier),
  output: new FileOutputLogStore(repositoryRoot, notifier),
  leases: new FileLeaseStore(repositoryRoot),
  notifications: notifier,
});
const copilotHost = new CopilotSubprocessHost({
  enabled: true,
  repositoryRoot,
  isolationRoot: join(repositoryRoot, ".agents", ".copilot-tracking", "copilot-home"),
});

process.exitCode = await runCli(arguments_, {
  services: createSenawaServices(repositoryRoot, {
    persistence,
    notifier,
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
