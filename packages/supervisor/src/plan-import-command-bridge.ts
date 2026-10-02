import {
  canonicalBytes,
  type DurableReceipt,
  decodeAuthenticatedPrincipal,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { ImportPlanRequest, ImportPlanResult, PlanImportCoordinator } from "@senawa/runtime";

export interface PlanImportCommandPort {
  putConfigurationSnapshot(snapshot: unknown): void;
  submit(command: ReturnType<typeof decodeCommandEnvelope>): DurableReceipt;
}

export interface PlanImportCommandBridgeOptions {
  readonly coordinator: Pick<PlanImportCoordinator, "import">;
  readonly commands: PlanImportCommandPort;
  readonly sha256: Readonly<{ digest(bytes: Uint8Array): string }>;
}

export class PlanImportCommandBridge {
  readonly #coordinator: Pick<PlanImportCoordinator, "import">;
  readonly #commands: PlanImportCommandPort;
  readonly #sha256: Readonly<{ digest(bytes: Uint8Array): string }>;

  constructor(options: PlanImportCommandBridgeOptions) {
    this.#coordinator = options.coordinator;
    this.#commands = options.commands;
    this.#sha256 = options.sha256;
  }

  execute(
    request: ImportPlanRequest,
    resultConfigurationSnapshot: unknown,
  ): Readonly<{ readonly result: ImportPlanResult; readonly receipt?: DurableReceipt }> {
    const result = this.#coordinator.import(request);
    if (result.status !== "proposal-enqueued") return Object.freeze({ result });
    this.#commands.putConfigurationSnapshot(resultConfigurationSnapshot);
    const proposal = result.proposal;
    const commandId = `command_plan-import-${proposal.proposalDigest.slice(0, 32)}`;
    const payload = { proposal } as const;
    const command = decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId,
      principal: enginePrincipal,
      transport: { kind: "runner", requestId: `request_${commandId}` },
      repositoryId: request.evaluation.repositoryId,
      runId: request.evaluation.runId,
      intent: { type: "submit-amendment-proposal" },
      payload,
      payloadDigest: this.#sha256.digest(canonicalBytes(payload)),
      expectedGraphRevision: request.baseGraph.revisionDigest,
      exactObjectDigest: proposal.proposalDigest,
    });
    return Object.freeze({ result, receipt: this.#commands.submit(command) });
  }
}

const enginePrincipal = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "plan-import-bridge",
  tenant: "local",
  assurance: "hardware-backed",
  roles: ["engine"],
});
