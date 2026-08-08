import { startWebSupervisor } from "@senawa/browser";
import { SimulatedWorkerAdapter } from "@senawa/workers";
import { createRuntimeComposition } from "../../../apps/senawa/src/composition.js";
import { createSenawaServices } from "../../../apps/senawa/src/services.js";

const [repositoryRoot, runId, leaseTtlText] = process.argv.slice(2);

if (repositoryRoot === undefined || runId === undefined || leaseTtlText === undefined) {
  throw new Error("Expected repository root, run ID, and lease TTL arguments");
}

const leaseTtlMs = Number.parseInt(leaseTtlText, 10);
if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
  throw new Error(`Invalid lease TTL: ${leaseTtlText}`);
}

const composition = createRuntimeComposition(repositoryRoot, "beads");
const services = createSenawaServices(repositoryRoot, {
  ...composition,
  runtimeBackend: "beads",
  workerHost: new SimulatedWorkerAdapter(),
  workerHostIdentity: {
    kind: "simulated",
    adapter: "simulated-worker",
    adapterVersion: "1",
  },
});
const neverProcess = new Promise<never>(() => undefined);
const browserCommands = {
  submit: services.browserCommands.submit.bind(services.browserCommands),
  receipt: services.browserCommands.receipt.bind(services.browserCommands),
  activeReceipt: services.browserCommands.activeReceipt.bind(services.browserCommands),
  async processNext(): Promise<boolean> {
    await neverProcess;
  },
};

try {
  const supervisor = await startWebSupervisor(
    { ...services, browserCommands },
    { runId, leaseTtlMs },
  );
  process.send?.({
    type: "ready",
    runId: supervisor.runId,
    url: supervisor.url,
    bootstrapUrl: supervisor.bootstrapUrl,
  });
} catch (error) {
  process.send?.({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
