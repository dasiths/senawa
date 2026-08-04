import { join } from "node:path";
import {
  CopilotSubprocessHost,
  createSenawaServices,
  DeterministicWorkerHost,
} from "@senawa/orchestrator";
import { runCli } from "./program.js";

const arguments_ = process.argv.slice(2);
const repositoryRoot = process.cwd();
const workerHost = optionValue(arguments_, "--worker-host") ?? "deterministic";
const deterministicHost = new DeterministicWorkerHost();
const copilotHost = new CopilotSubprocessHost({
  enabled: true,
  repositoryRoot,
  isolationRoot: join(repositoryRoot, ".agents", ".copilot-tracking", "copilot-home"),
});

process.exitCode = await runCli(arguments_, {
  services: createSenawaServices(repositoryRoot, {
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
});

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}
