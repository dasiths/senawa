import type {
  JsonObject,
  JsonValue,
  WorkerCapability,
  WorkerHostIdentity,
  WorkerProfile,
} from "@senawa/domain";

export type WorkerOwner = { readonly kind: "phase" | "task"; readonly id: string };

export interface WorkerAuthorization {
  readonly runId: string;
  readonly owner: WorkerOwner;
  readonly profileDigest: string;
  readonly semanticCapabilities: readonly WorkerCapability[];
  readonly readablePaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly frozenPaths: readonly string[];
  readonly allowedCommands: readonly string[];
}

export interface WorkerTurn {
  readonly runId: string;
  readonly owner: WorkerOwner;
  readonly operation: "create" | "resume";
  readonly turnId: string;
  readonly dispatchId: string;
  readonly operationId: string;
  readonly traceId: string;
  readonly traceparent: string;
  readonly role: string;
  readonly profile: WorkerProfile;
  readonly profileDigest: string;
  readonly requestedModel?: WorkerProfile["spec"]["model"];
  readonly resolvedModel: WorkerProfile["spec"]["model"];
  readonly attempt: number;
  readonly sessionId: string;
  readonly goal: string;
  readonly rejectionReason: string | null;
  readonly steering: readonly string[];
  readonly prompt: string;
  readonly authorization: {
    readonly taskPaths: readonly string[];
    readonly frozenPaths: readonly string[];
  };
}

export interface WorkerOutput {
  readonly stream: "stdout" | "stderr" | "system";
  readonly text: string;
}

export interface WorkerResult {
  readonly sessionId: string;
  readonly artifact?: JsonObject;
  readonly completion?: JsonObject;
  readonly output: readonly WorkerOutput[];
}

export type WorkerTurnObservation =
  | { readonly state: "missing" }
  | { readonly state: "active" }
  | { readonly state: "completed"; readonly result: WorkerResult }
  | { readonly state: "idle" }
  | { readonly state: "cancelled"; readonly detail?: string }
  | { readonly state: "unknown"; readonly detail: string };

export interface WorkerAdapterDescriptor {
  readonly name: string;
  readonly version: string;
  readonly features: {
    readonly callerChosenIdentity: boolean;
    readonly resume: boolean;
    readonly inspect: "exact" | "session-only" | "none";
    readonly replay: boolean;
    readonly streaming: boolean;
    readonly cancellation: boolean;
    readonly nativeTypedTools: boolean;
    readonly commandBridge: boolean;
    readonly pathEnforcement: "policy" | "sandbox" | "none";
    readonly usageCheckpoints: boolean;
    readonly permissionFeedback: boolean;
    readonly modelDiscovery: boolean;
    readonly traceInjection: boolean;
  };
  readonly capabilities: readonly WorkerCapability[];
}

export interface WorkerSessionRequirements {
  readonly requiredCapabilities: readonly WorkerCapability[];
  readonly preferredCapabilities?: readonly WorkerCapability[];
  readonly requireResume: boolean;
  readonly requirePathEnforcement: boolean;
  readonly requestedModel: WorkerProfile["spec"]["model"];
}

export interface WorkerSessionPlan {
  readonly adapter: WorkerAdapterDescriptor;
  readonly resolvedModel: WorkerProfile["spec"]["model"];
  readonly grantedCapabilities: readonly WorkerCapability[];
  readonly toolTransport: "native" | "command-bridge" | "none";
  readonly unsupportedPreferences: readonly string[];
}

export interface WorkerModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly supportedEfforts: readonly string[];
  readonly defaultEffort?: string;
}

export interface WorkerModelCatalogPort {
  listModels(): Promise<readonly WorkerModelCatalogEntry[]>;
}

export interface WorkerPreflightRequest extends WorkerSessionRequirements {
  readonly role: string;
}

export interface WorkerHostResolverPort {
  resolve(identity: WorkerHostIdentity): Promise<WorkerExecutionPort>;
  preflight(
    identity: WorkerHostIdentity,
    requests: readonly WorkerPreflightRequest[],
  ): Promise<readonly WorkerSessionPlan[]>;
  listModels(identity: WorkerHostIdentity): Promise<readonly WorkerModelCatalogEntry[]>;
}

export function fixedWorkerHostResolver(workerHost: WorkerExecutionPort): WorkerHostResolverPort {
  const candidate = workerHost as WorkerExecutionPort &
    Partial<WorkerSessionPort> &
    Partial<WorkerModelCatalogPort>;
  return {
    async resolve() {
      return workerHost;
    },
    async preflight(_identity, requests) {
      const negotiate = candidate.negotiate?.bind(candidate);
      if (negotiate === undefined) return [];
      return Promise.all(requests.map(({ role: _role, ...request }) => negotiate(request)));
    },
    async listModels() {
      if (candidate.listModels === undefined) {
        throw new Error("The selected worker host does not provide a model catalog");
      }
      return candidate.listModels();
    },
  };
}

export type WorkerSessionEvent = {
  readonly apiVersion: "senawa.dev/worker-event/v1";
  readonly eventId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly ts: string;
  readonly traceId?: string;
} & (
  | {
      readonly kind: "lifecycle";
      readonly event: "created" | "resumed" | "started" | "completed" | "failed" | "cancelled";
      readonly detail?: string;
      readonly durationMs?: number;
    }
  | {
      readonly kind: "text";
      readonly stream: WorkerOutput["stream"];
      readonly text: string;
      readonly delta?: boolean;
    }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly state: "requested" | "denied" | "started" | "completed" | "failed";
      readonly detail?: string;
    }
  | {
      readonly kind: "usage";
      readonly cumulativeNanoAiu: number;
      readonly cumulativeCostUsdMicros?: number;
    }
  | {
      readonly kind: "model";
      readonly requested: string;
      readonly resolved: string;
      readonly requestedEffort?: string;
      readonly resolvedEffort?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "diff";
      readonly changed: boolean;
      readonly patch: string;
      readonly reason?: string;
    }
  | { readonly kind: "artifact"; readonly artifact: JsonObject }
  | { readonly kind: "completion"; readonly submission: JsonObject }
);

export interface WorkerTurnHandle {
  readonly turn: WorkerTurn;
  readonly events: AsyncIterable<WorkerSessionEvent>;
  readonly result: Promise<WorkerResult>;
}

export interface WorkerCancelResult {
  readonly cancelled: boolean;
  readonly detail?: string;
}

export interface WorkerSessionPort {
  describe(): Promise<WorkerAdapterDescriptor>;
  negotiate(requirements: WorkerSessionRequirements): Promise<WorkerSessionPlan>;
  create(turn: WorkerTurn): Promise<WorkerTurnHandle>;
  resume(turn: WorkerTurn): Promise<WorkerTurnHandle>;
  inspect(turn: WorkerTurn): Promise<WorkerTurnObservation>;
  cancel(turn: WorkerTurn, reason: string): Promise<WorkerCancelResult>;
  release(sessionId: string, disposition: "retain" | "archive-delete"): Promise<void>;
}

export interface WorkerExecutionPort {
  execute(
    turn: WorkerTurn,
    onEvent?: (event: WorkerSessionEvent) => Promise<void>,
  ): Promise<WorkerResult>;
  inspect?(turn: WorkerTurn): Promise<WorkerTurnObservation>;
  cancel?(turn: WorkerTurn, reason: string): Promise<WorkerCancelResult>;
}

export type WorkerBindingName =
  | "senawa.task.done"
  | "senawa.phase.submit"
  | "senawa.ask"
  | "senawa.discover"
  | "senawa.note";

export interface WorkerBindingContext {
  readonly runId: string;
  readonly owner: WorkerOwner;
  readonly sessionId: string;
  readonly turnId: string;
  readonly authorization: WorkerAuthorization;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface WorkerBindingResult {
  readonly accepted: boolean;
  readonly code: string;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface WorkerBinding {
  readonly name: WorkerBindingName;
  readonly capability: WorkerCapability;
  readonly description: string;
  readonly inputSchema: JsonObject;
  handle(input: JsonObject, context: WorkerBindingContext): Promise<WorkerBindingResult>;
}

export interface WorkerBindingPort {
  bindingsFor(turn: WorkerTurn, authorization: WorkerAuthorization): readonly WorkerBinding[];
}
