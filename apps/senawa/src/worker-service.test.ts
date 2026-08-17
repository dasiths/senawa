import { canonicalValue } from "@senawa/kernel";
import { WorkerApiError } from "@senawa/supervisor";
import { describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";
import { SenawaWorkerApi, type WorkerSubmissionSink } from "./worker-service.js";

const scope = Object.freeze({
  repositoryId: "repository_demo",
  runId: "run_demo",
  dispatchId: "dispatch_demo",
  contextId: "context_demo",
  principalId: "principal_demo",
  capabilities: Object.freeze([
    "worker.submit.completion",
    "worker.submit.phase-output",
    "worker.submit.question",
  ]),
  expiresAt: 4_000_000_000_000,
  maxSubmissions: 8,
});

function api(sink: WorkerSubmissionSink): SenawaWorkerApi {
  const worker = new SenawaWorkerApi({ sink, sha256: runtimeDependencies.sha256 });
  worker.register(scope.dispatchId, {
    context: canonicalValue({ prompt: "Do the work" }),
    outputSchema: canonicalValue({ type: "object" }),
  });
  return worker;
}

describe("worker channel", () => {
  it("serves the context and the output schema so an agent need not guess", async () => {
    const worker = api({ accept: () => Promise.resolve(canonicalValue({}) as never) });
    expect(await worker.context(scope)).toEqual({ prompt: "Do the work" });
    expect(await worker.outputSchema(scope)).toEqual({ type: "object" });
  });

  it("derives the submission identity from content rather than trusting the agent", async () => {
    const seen: string[] = [];
    const worker = api({
      accept: (accepted) => {
        seen.push(accepted.submissionId);
        return Promise.resolve(canonicalValue({}) as never);
      },
    });
    const submission = { kind: "phase-output", outputName: "plan", value: { items: [1] } };
    await worker.submit(scope, submission as never);
    await worker.submit(scope, submission as never);
    // The same content yields the same identity, so a retry after a lost
    // response cannot become a second distinct submission.
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toMatch(/^submission_[0-9a-f]{64}$/u);
  });

  it("refuses a submission kind the channel does not offer", async () => {
    const worker = api({ accept: () => Promise.resolve(canonicalValue({}) as never) });
    // Approval is a human authority operation. A worker has no route to it, so
    // an agent cannot grant its own phase by choosing a different kind.
    await expect(worker.submit(scope, { kind: "approval" } as never)).rejects.toBeInstanceOf(
      WorkerApiError,
    );
  });

  it("refuses traffic for a dispatch it is not serving", async () => {
    const worker = api({ accept: () => Promise.resolve(canonicalValue({}) as never) });
    worker.forget(scope.dispatchId);
    await expect(worker.context(scope)).rejects.toBeInstanceOf(WorkerApiError);
  });

  it("refuses a malformed submission before it reaches the sink", async () => {
    let reached = false;
    const worker = api({
      accept: () => {
        reached = true;
        return Promise.resolve(canonicalValue({}) as never);
      },
    });
    await expect(
      worker.submit(scope, { kind: "phase-output", outputName: "" } as never),
    ).rejects.toBeInstanceOf(WorkerApiError);
    expect(reached).toBe(false);
  });
});
