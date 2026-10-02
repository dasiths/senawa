import {
  encodeRemoteClassifiedReport,
  type RemoteClassifiedReport,
  type RemoteCommandDelivery,
  type RemoteHelloOffer,
  type RemoteHelloResponse,
  type RemoteReportAcknowledgement,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";

import type { ReferenceControlPlane } from "./authority.js";
import type { DeterministicControlPlaneSimulator } from "./simulator.js";

export interface InProcessTransportCallContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

export interface InProcessSignedClassifiedReport {
  readonly canonicalReport: string;
  readonly report: RemoteClassifiedReport;
  readonly signingKeyId: string;
  readonly signature: string;
}

export class InProcessControlPlaneTransport {
  readonly #authority: ReferenceControlPlane;
  readonly #simulator: DeterministicControlPlaneSimulator;
  readonly #binding: RemoteRepositoryBinding;
  readonly #sentReports: InProcessSignedClassifiedReport[] = [];
  readonly #acknowledgements: RemoteReportAcknowledgement[] = [];

  constructor(input: {
    readonly authority: ReferenceControlPlane;
    readonly simulator: DeterministicControlPlaneSimulator;
    readonly binding: RemoteRepositoryBinding;
  }) {
    this.#authority = input.authority;
    this.#simulator = input.simulator;
    this.#binding = input.binding;
    this.#simulator.registerBinding(input.binding.bindingId, input.binding.revocationEpoch);
  }

  async negotiate(
    input: Readonly<{
      repositoryKeyId: string;
      connectorId: string;
      offer: RemoteHelloOffer;
    }> &
      InProcessTransportCallContext,
  ): Promise<RemoteHelloResponse> {
    this.#assertCall(this.#binding.bindingId, input);
    return this.#authority.negotiate(input);
  }

  async receiveCommands(
    input: Readonly<{
      bindingId: string;
      sessionId: string;
      afterSequence: number;
      limit: number;
    }> &
      InProcessTransportCallContext,
  ): Promise<{
    readonly revocationEpoch: number;
    readonly deliveries: readonly RemoteCommandDelivery[];
  }> {
    this.#assertCall(input.bindingId, input);
    if (input.sessionId.length === 0) throw new Error("in-process session is missing");
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new Error("in-process command cursor is invalid");
    }
    this.#simulator.enqueue(input.bindingId, input.afterSequence);
    const deliveries = this.#simulator.poll(input.bindingId, input.limit, input.afterSequence);
    return Object.freeze({
      revocationEpoch: this.#simulator.revocationEpoch(input.bindingId),
      deliveries: Object.freeze(
        deliveries.flatMap((delivery) => {
          if ("type" in delivery.result) return [];
          const receiptEntry = delivery.result.entries[1];
          return receiptEntry === undefined
            ? []
            : [Object.freeze({ envelope: delivery.envelope, receiptEntry })];
        }),
      ),
    });
  }

  async sendReport(
    input: InProcessSignedClassifiedReport & InProcessTransportCallContext,
  ): Promise<RemoteReportAcknowledgement> {
    this.#assertCall(input.report.binding.bindingId, input);
    if (input.signingKeyId !== this.#binding.repositoryKeyId) {
      throw new Error("in-process report signing key is not bound");
    }
    if (input.canonicalReport !== encodeRemoteClassifiedReport(input.report)) {
      throw new Error("in-process report bytes do not match the report");
    }
    this.#sentReports.push(
      Object.freeze({
        canonicalReport: input.canonicalReport,
        report: input.report,
        signingKeyId: input.signingKeyId,
        signature: input.signature,
      }),
    );
    const result = this.#authority.acceptReport({
      repositoryKeyId: input.signingKeyId,
      connectorId: this.#binding.connectorId,
      report: input.report,
      signature: input.signature,
    });
    if (result.type !== "acknowledged") {
      throw new Error(`control plane refused report: ${result.code}`);
    }
    this.#acknowledgements.push(result.acknowledgement);
    return result.acknowledgement;
  }

  sentReports(): readonly InProcessSignedClassifiedReport[] {
    return Object.freeze([...this.#sentReports]);
  }

  acknowledgements(): readonly RemoteReportAcknowledgement[] {
    return Object.freeze([...this.#acknowledgements]);
  }

  #assertCall(bindingId: string, context: InProcessTransportCallContext): void {
    if (bindingId !== this.#binding.bindingId) {
      throw new Error("in-process transport binding does not match enrollment");
    }
    if (context.signal.aborted) throw context.signal.reason;
    if (!Number.isFinite(Date.parse(context.deadlineAt))) {
      throw new Error("in-process transport deadline is invalid");
    }
    if (this.#simulator.isPartitioned(bindingId)) {
      throw new Error("simulated control-plane partition");
    }
  }
}
