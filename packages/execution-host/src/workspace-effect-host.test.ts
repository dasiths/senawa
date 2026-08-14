import type {
  AsyncEffectHost,
  AsyncEffectHostContext,
  EffectInspection,
  EffectIntent,
  EffectObservation,
} from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import { WorkspaceEffectHost } from "./workspace-effect-host.js";

const context: AsyncEffectHostContext = {
  lease: { owner: "owner_test", fence: 1, expiresAt: "2026-08-13T12:01:00.000Z" },
  signal: new AbortController().signal,
};

describe("WorkspaceEffectHost", () => {
  it("dispatches repository workers at the registered root without constructing Git", async () => {
    const roots: string[] = [];
    const host = new WorkspaceEffectHost({
      policy: { workspaceMode: "repository", hostWriterCapacity: 1 },
      repositoryRoot: "/tmp/registered-repository",
      createWorkerHost(root) {
        roots.push(root);
        return new RecordingHost();
      },
      createGitHost() {
        throw new Error("Git factory must not be constructed in repository mode");
      },
    });

    await expect(
      host.dispatch(effect("worker", { dispatchId: "dispatch_one" }), context),
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(roots).toEqual(["/tmp/registered-repository"]);
  });

  it("binds worktree workers to isolated durable roots and unwraps worker input", async () => {
    const calls: { readonly root: string; readonly input: unknown }[] = [];
    const host = new WorkspaceEffectHost({
      policy: { workspaceMode: "worktree", hostWriterCapacity: 2 },
      repositoryRoot: "/tmp/repository",
      resolveWorkspaceRoot: (workspaceId) => `/tmp/workspaces/${workspaceId}`,
      createWorkerHost(root) {
        return new RecordingHost((intent) => calls.push({ root, input: intent.command.input }));
      },
      createGitHost: () => new RecordingHost(),
    });

    await host.dispatch(
      effect("worker", {
        operation: "dispatch-worker",
        workspaceId: "workspace_one",
        worker: { dispatchId: "dispatch_one" },
      }),
      context,
    );
    await host.dispatch(
      effect("worker", {
        operation: "dispatch-worker",
        workspaceId: "workspace_two",
        worker: { dispatchId: "dispatch_two" },
      }),
      context,
    );

    expect(calls).toEqual([
      { root: "/tmp/workspaces/workspace_one", input: { dispatchId: "dispatch_one" } },
      { root: "/tmp/workspaces/workspace_two", input: { dispatchId: "dispatch_two" } },
    ]);
  });

  it("rejects every Git effect in repository mode before calling the factory", async () => {
    let factoryCalls = 0;
    const host = new WorkspaceEffectHost({
      policy: { workspaceMode: "repository", hostWriterCapacity: 1 },
      repositoryRoot: "/tmp/repository",
      createWorkerHost: () => new RecordingHost(),
      createGitHost() {
        factoryCalls += 1;
        return new RecordingHost();
      },
    });

    expect(() => host.dispatch(effect("git", { operation: "prepare-workspace" }), context)).toThrow(
      "Repository workspace mode forbids Git effects",
    );
    expect(factoryCalls).toBe(0);
  });

  it("enforces the active workspace cap and routes cancellation to the exact root", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelledRoots: string[] = [];
    const host = new WorkspaceEffectHost({
      policy: { workspaceMode: "worktree", hostWriterCapacity: 1 },
      repositoryRoot: "/tmp/repository",
      resolveWorkspaceRoot: (workspaceId) => `/tmp/workspaces/${workspaceId}`,
      createWorkerHost(root) {
        return {
          async dispatch() {
            started?.();
            await gate;
            return { status: "completed", observedAt: "2026-08-13T12:00:00.000Z" };
          },
          async inspect() {
            return { status: "active", observedAt: "2026-08-13T12:00:00.000Z" };
          },
          async cancel() {
            cancelledRoots.push(root);
            return { status: "cancelled", observedAt: "2026-08-13T12:00:00.000Z" };
          },
        };
      },
      createGitHost: () => new RecordingHost(),
    });
    const first = effect("worker", {
      operation: "dispatch-worker",
      workspaceId: "workspace_one",
      worker: { dispatchId: "dispatch_one" },
    });
    const second = effect("worker", {
      operation: "dispatch-worker",
      workspaceId: "workspace_two",
      worker: { dispatchId: "dispatch_two" },
    });
    const pending = host.dispatch(first, context);
    await active;

    await expect(host.dispatch(second, context)).rejects.toThrow(
      "Workspace effect host capacity 1 is occupied",
    );
    await expect(host.cancel(first, context)).resolves.toMatchObject({ status: "cancelled" });
    expect(cancelledRoots).toEqual(["/tmp/workspaces/workspace_one"]);
    release?.();
    await expect(pending).resolves.toMatchObject({ status: "completed" });
  });
});

class RecordingHost implements AsyncEffectHost {
  constructor(readonly onDispatch: (intent: EffectIntent) => void = () => undefined) {}

  async dispatch(intent: EffectIntent): Promise<EffectObservation> {
    this.onDispatch(intent);
    return { status: "completed", observedAt: "2026-08-13T12:00:00.000Z" };
  }

  async inspect(): Promise<EffectInspection> {
    return { status: "completed", observedAt: "2026-08-13T12:00:00.000Z" };
  }

  async cancel(): Promise<EffectObservation> {
    return { status: "cancelled", observedAt: "2026-08-13T12:00:00.000Z" };
  }
}

function effect(
  kind: EffectIntent["command"]["kind"],
  input: EffectIntent["command"]["input"],
): EffectIntent {
  return {
    command: {
      sequence: 1,
      commandId: "command_test",
      repositoryId: "repository_test",
      runId: "run_test",
      operationId: "operation_test",
      kind,
      taskScope: {
        runId: "run_test",
        taskId: "task_test",
        definitionGeneration: 1,
        acceptedContextDigest: "a".repeat(64),
        fenceGeneration: 1,
      },
      contextDigest: "a".repeat(64),
      inputDigest: "b".repeat(64),
      input,
      budgetReservation: { unit: "test", amount: 1 },
      queuedAt: "2026-08-13T12:00:00.000Z",
      maxReconciliationAttempts: 2,
    },
    owner: "owner_test",
    fence: 1,
    attemptId: "attempt_test",
    status: "intent",
    persistedAt: "2026-08-13T12:00:00.000Z",
  };
}
