import type {
  AsyncEffectHost,
  AsyncEffectHostContext,
  EffectInspection,
  EffectIntent,
  EffectObservation,
} from "@senawa/runtime";

export const MAX_ACTIVE_WORKSPACES = 32;

export interface WorkspaceEffectHostPolicy {
  readonly workspaceMode: "repository" | "worktree";
  readonly hostWriterCapacity: number;
}

export interface WorkspaceEffectHostOptions {
  readonly policy: WorkspaceEffectHostPolicy;
  readonly repositoryRoot: string;
  readonly createWorkerHost: (workingRoot: string) => AsyncEffectHost | Promise<AsyncEffectHost>;
  readonly resolveWorkspaceRoot?: (workspaceId: string, intent: EffectIntent) => string | undefined;
  readonly createGitHost?: () => AsyncEffectHost;
}

interface WorktreeWorkerEffectInput {
  readonly operation: "dispatch-worker";
  readonly workspaceId: string;
  readonly worker: EffectIntent["command"]["input"];
}

export class WorkspaceEffectHost implements AsyncEffectHost {
  readonly policy: WorkspaceEffectHostPolicy;
  readonly repositoryRoot: string;
  readonly #createWorkerHost: (workingRoot: string) => AsyncEffectHost | Promise<AsyncEffectHost>;
  readonly #resolveWorkspaceRoot:
    | ((workspaceId: string, intent: EffectIntent) => string | undefined)
    | undefined;
  readonly #createGitHost: (() => AsyncEffectHost) | undefined;
  readonly #workerHosts = new Map<string, Promise<AsyncEffectHost>>();
  #activeWriterDispatches = 0;
  #gitHost: AsyncEffectHost | undefined;

  constructor(options: WorkspaceEffectHostOptions) {
    if (
      !Number.isSafeInteger(options.policy.hostWriterCapacity) ||
      options.policy.hostWriterCapacity < 1 ||
      options.policy.hostWriterCapacity > MAX_ACTIVE_WORKSPACES
    ) {
      throw new TypeError(
        `Workspace effect host capacity must be between 1 and ${MAX_ACTIVE_WORKSPACES}`,
      );
    }
    if (options.policy.workspaceMode === "repository" && options.policy.hostWriterCapacity !== 1) {
      throw new TypeError("Repository workspace mode requires host writer capacity one");
    }
    if (options.policy.workspaceMode === "worktree" && options.resolveWorkspaceRoot === undefined) {
      throw new TypeError("Worktree workspace mode requires a durable root resolver");
    }
    if (options.policy.workspaceMode === "worktree" && options.createGitHost === undefined) {
      throw new TypeError("Worktree workspace mode requires a Git effect host factory");
    }
    this.policy = Object.freeze({ ...options.policy });
    this.repositoryRoot = options.repositoryRoot;
    this.#createWorkerHost = options.createWorkerHost;
    this.#resolveWorkspaceRoot = options.resolveWorkspaceRoot;
    this.#createGitHost = options.createGitHost;
  }

  dispatch(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectObservation> {
    if (intent.command.kind === "worker") {
      const binding = this.#workerBinding(intent);
      return this.#withWorkspaceCapacity(() =>
        this.#workerHost(binding.root).then((host) => host.dispatch(binding.intent, context)),
      );
    }
    return this.#gitEffectHost(intent).dispatch(intent, context);
  }

  inspect(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectInspection> {
    if (intent.command.kind === "worker") {
      const binding = this.#workerBinding(intent);
      return this.#workerHost(binding.root).then((host) => host.inspect(binding.intent, context));
    }
    return this.#gitEffectHost(intent).inspect(intent, context);
  }

  cancel(intent: EffectIntent, context: AsyncEffectHostContext): Promise<EffectObservation> {
    if (intent.command.kind === "worker") {
      const binding = this.#workerBinding(intent);
      return this.#workerHost(binding.root).then((host) => host.cancel(binding.intent, context));
    }
    return this.#gitEffectHost(intent).cancel(intent, context);
  }

  #workerBinding(intent: EffectIntent): { readonly root: string; readonly intent: EffectIntent } {
    if (this.policy.workspaceMode === "repository") {
      return { root: this.repositoryRoot, intent };
    }
    const input = decodeWorktreeWorkerEffectInput(intent.command.input);
    const root = this.#resolveWorkspaceRoot?.(input.workspaceId, intent);
    if (root === undefined) {
      throw new TypeError("Worker effect workspace is not prepared in durable authority");
    }
    return {
      root,
      intent: Object.freeze({
        ...intent,
        command: Object.freeze({ ...intent.command, input: input.worker }),
      }),
    };
  }

  #workerHost(root: string): Promise<AsyncEffectHost> {
    const existing = this.#workerHosts.get(root);
    if (existing !== undefined) return existing;
    const host = Promise.resolve(this.#createWorkerHost(root));
    this.#workerHosts.set(root, host);
    return host;
  }

  #gitEffectHost(intent: EffectIntent): AsyncEffectHost {
    if (intent.command.kind !== "git") {
      throw new TypeError("Workspace effect host accepts only worker and Git effects");
    }
    if (this.policy.workspaceMode !== "worktree") {
      throw new TypeError("Repository workspace mode forbids Git effects");
    }
    if (this.#gitHost !== undefined) return this.#gitHost;
    this.#gitHost = required(this.#createGitHost)();
    return this.#gitHost;
  }

  async #withWorkspaceCapacity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#activeWriterDispatches >= this.policy.hostWriterCapacity) {
      throw new WorkspaceHostCapacityError(this.policy.hostWriterCapacity);
    }
    this.#activeWriterDispatches += 1;
    try {
      return await operation();
    } finally {
      this.#activeWriterDispatches -= 1;
    }
  }
}

export class WorkspaceHostCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`Workspace effect host capacity ${capacity} is occupied`);
    this.name = "WorkspaceHostCapacityError";
  }
}

function decodeWorktreeWorkerEffectInput(value: unknown): WorktreeWorkerEffectInput {
  assertExactObject(value, ["operation", "workspaceId", "worker"]);
  if (value.operation !== "dispatch-worker") {
    throw new TypeError("Worktree worker effect operation must be dispatch-worker");
  }
  if (typeof value.workspaceId !== "string" || value.workspaceId.length === 0) {
    throw new TypeError("Worktree worker effect workspaceId must be non-empty");
  }
  return Object.freeze({
    operation: value.operation,
    workspaceId: value.workspaceId,
    worker: value.worker as EffectIntent["command"]["input"],
  });
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workspace effect input must be an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Workspace effect input contains unexpected fields");
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Required workspace effect host value is missing");
  return value;
}
