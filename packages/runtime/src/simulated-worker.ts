import type { CompletionSubmission, WorkerDispatch } from "@senawa/kernel";
import {
  PROTOCOL_VERSION,
  type WorkerAmendmentProposalSubmission,
  type WorkerAssetSubmission,
  type WorkerDiscoverySubmission,
  type WorkerQuestionSubmission,
  type WorkerSubmission,
} from "@senawa/protocol";
import type {
  AssetReadInput,
  AssetReadResult,
  ContextBrokerClient,
  SubmissionAdmissionResult,
} from "./context-broker.js";

export interface SimulatedWorkerRunInput {
  readonly dispatch: WorkerDispatch;
}

export type SimulatedWorkerRunResult =
  | {
      readonly status: "completed" | "blocked";
      readonly dispatchId: string;
      readonly submissions: readonly SubmissionAdmissionResult[];
    }
  | {
      readonly status: "missing-completion";
      readonly dispatchId: string;
      readonly submissions: readonly SubmissionAdmissionResult[];
    }
  | {
      readonly status: "crashed";
      readonly dispatchId: string;
      readonly submissions: readonly SubmissionAdmissionResult[];
      readonly error: Readonly<{ readonly code: "worker-script-failed" }>;
    };

export interface SimulatedWorkerSession {
  readonly dispatchId: string;
  read(request: AssetReadInput["request"]): Promise<AssetReadResult>;
  question(
    submissionId: string,
    question: WorkerQuestionSubmission["question"],
  ): SubmissionAdmissionResult;
  proposeAsset(
    submissionId: string,
    asset: WorkerAssetSubmission["asset"],
  ): SubmissionAdmissionResult;
  recordDiscovery(
    submissionId: string,
    discovery: WorkerDiscoverySubmission["discovery"],
  ): SubmissionAdmissionResult;
  proposeAmendment(
    submissionId: string,
    amendment: WorkerAmendmentProposalSubmission["amendment"],
  ): SubmissionAdmissionResult;
  /** Publishes one declared output. A completion without its outputs is refused. */
  submitOutput(
    submissionId: string,
    output: Extract<WorkerSubmission, { readonly type: "phase-output" }>["output"],
  ): SubmissionAdmissionResult;
  complete(submissionId: string, completion: CompletionSubmission): SubmissionAdmissionResult;
}

export type SimulatedWorkerScript = (session: SimulatedWorkerSession) => Promise<void> | void;

export class SimulatedSerialWorkerAdapter {
  readonly broker: ContextBrokerClient;
  #activeDispatchId: string | undefined;

  constructor(broker: ContextBrokerClient) {
    this.broker = broker;
  }

  async run(
    input: SimulatedWorkerRunInput,
    script: SimulatedWorkerScript,
  ): Promise<SimulatedWorkerRunResult> {
    if (this.#activeDispatchId !== undefined) {
      throw new TypeError(`Simulated worker is already running dispatch ${this.#activeDispatchId}`);
    }
    this.#activeDispatchId = input.dispatch.dispatchId;
    const submissions: SubmissionAdmissionResult[] = [];
    let admittedCompletionDisposition: CompletionSubmission["disposition"] | undefined;
    const submit = (
      type:
        | "question"
        | "asset"
        | "discovery"
        | "amendment-proposal"
        | "completion"
        | "phase-output",
      submissionId: string,
      payloadKey: "question" | "asset" | "discovery" | "amendment" | "completion" | "output",
      payload: unknown,
    ): SubmissionAdmissionResult => {
      const result = this.broker.admitSubmission({
        submission: {
          apiVersion: PROTOCOL_VERSION,
          submissionId,
          repositoryId: input.dispatch.repositoryId,
          runId: input.dispatch.runId,
          dispatchId: input.dispatch.dispatchId,
          task: input.dispatch.task,
          contextId: input.dispatch.contextId,
          contextDigest: input.dispatch.contextDigest,
          principalId: input.dispatch.worker.principalId,
          type,
          [payloadKey]: payload,
        },
      });
      submissions.push(result);
      return result;
    };
    const session: SimulatedWorkerSession = Object.freeze({
      dispatchId: input.dispatch.dispatchId,
      read: (request: AssetReadInput["request"]) => this.broker.readAsset({ request }),
      question: (submissionId: string, question: WorkerQuestionSubmission["question"]) =>
        submit("question", submissionId, "question", question),
      proposeAsset: (submissionId: string, asset: WorkerAssetSubmission["asset"]) =>
        submit("asset", submissionId, "asset", asset),
      recordDiscovery: (submissionId: string, discovery: WorkerDiscoverySubmission["discovery"]) =>
        submit("discovery", submissionId, "discovery", discovery),
      proposeAmendment: (
        submissionId: string,
        amendment: WorkerAmendmentProposalSubmission["amendment"],
      ) => submit("amendment-proposal", submissionId, "amendment", amendment),
      submitOutput: (
        submissionId: string,
        output: Extract<WorkerSubmission, { readonly type: "phase-output" }>["output"],
      ) => submit("phase-output", submissionId, "output", output),
      complete: (submissionId: string, completion: CompletionSubmission) => {
        const result = submit("completion", submissionId, "completion", completion);
        if (result.status === "accepted" && result.completionFact !== undefined)
          admittedCompletionDisposition = completion.disposition;
        return result;
      },
    });
    try {
      await script(session);
      if (admittedCompletionDisposition === undefined) {
        return Object.freeze({
          status: "missing-completion",
          dispatchId: input.dispatch.dispatchId,
          submissions: Object.freeze([...submissions]),
        });
      }
      return Object.freeze({
        status: admittedCompletionDisposition === "blocked" ? "blocked" : "completed",
        dispatchId: input.dispatch.dispatchId,
        submissions: Object.freeze([...submissions]),
      });
    } catch {
      return Object.freeze({
        status: "crashed",
        dispatchId: input.dispatch.dispatchId,
        submissions: Object.freeze([...submissions]),
        error: Object.freeze({ code: "worker-script-failed" as const }),
      });
    } finally {
      this.#activeDispatchId = undefined;
    }
  }
}
