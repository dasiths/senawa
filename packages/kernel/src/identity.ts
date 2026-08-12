declare const opaqueBrand: unique symbol;

type Opaque<Value, Name extends string> = Value & {
  readonly [opaqueBrand]: Name;
};

export type WorkflowId = Opaque<string, "WorkflowId">;
export type RunId = Opaque<string, "RunId">;
export type PhaseId = Opaque<string, "PhaseId">;
export type TaskId = Opaque<string, "TaskId">;
export type CriterionId = Opaque<string, "CriterionId">;
export type AssetId = Opaque<string, "AssetId">;
export type DispatchId = Opaque<string, "DispatchId">;
export type ApprovalId = Opaque<string, "ApprovalId">;
export type AmendmentId = Opaque<string, "AmendmentId">;
export type EscalationId = Opaque<string, "EscalationId">;
export type EventId = Opaque<string, "EventId">;
export type ConsumerKey = Opaque<string, "ConsumerKey">;
export type DefinitionGeneration = Opaque<number, "DefinitionGeneration">;

type IdentityKind =
  | "workflow"
  | "run"
  | "phase"
  | "task"
  | "criterion"
  | "asset"
  | "dispatch"
  | "approval"
  | "amendment"
  | "escalation"
  | "event";

interface IdentityByKind {
  readonly workflow: WorkflowId;
  readonly run: RunId;
  readonly phase: PhaseId;
  readonly task: TaskId;
  readonly criterion: CriterionId;
  readonly asset: AssetId;
  readonly dispatch: DispatchId;
  readonly approval: ApprovalId;
  readonly amendment: AmendmentId;
  readonly escalation: EscalationId;
  readonly event: EventId;
}

const IDENTITY_TOKEN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CONSUMER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isIdentity<K extends IdentityKind>(kind: K, value: unknown): value is IdentityByKind[K] {
  if (typeof value !== "string") {
    return false;
  }

  const prefix = `${kind}_`;
  return value.startsWith(prefix) && IDENTITY_TOKEN_PATTERN.test(value.slice(prefix.length));
}

function identity<K extends IdentityKind>(kind: K, value: string): IdentityByKind[K] {
  if (!isIdentity(kind, value)) {
    throw new TypeError(
      `${kind} identities must use the ${kind}_ prefix followed by 1-64 lowercase letters, digits, or hyphens`,
    );
  }

  return value;
}

export const isWorkflowId = (value: unknown): value is WorkflowId => isIdentity("workflow", value);
export const workflowId = (value: string): WorkflowId => identity("workflow", value);

export const isRunId = (value: unknown): value is RunId => isIdentity("run", value);
export const runId = (value: string): RunId => identity("run", value);

export const isPhaseId = (value: unknown): value is PhaseId => isIdentity("phase", value);
export const phaseId = (value: string): PhaseId => identity("phase", value);

export const isTaskId = (value: unknown): value is TaskId => isIdentity("task", value);
export const taskId = (value: string): TaskId => identity("task", value);

export const isCriterionId = (value: unknown): value is CriterionId =>
  isIdentity("criterion", value);
export const criterionId = (value: string): CriterionId => identity("criterion", value);

export const isAssetId = (value: unknown): value is AssetId => isIdentity("asset", value);
export const assetId = (value: string): AssetId => identity("asset", value);

export const isDispatchId = (value: unknown): value is DispatchId => isIdentity("dispatch", value);
export const dispatchId = (value: string): DispatchId => identity("dispatch", value);

export const isApprovalId = (value: unknown): value is ApprovalId => isIdentity("approval", value);
export const approvalId = (value: string): ApprovalId => identity("approval", value);

export const isAmendmentId = (value: unknown): value is AmendmentId =>
  isIdentity("amendment", value);
export const amendmentId = (value: string): AmendmentId => identity("amendment", value);

export const isEscalationId = (value: unknown): value is EscalationId =>
  isIdentity("escalation", value);
export const escalationId = (value: string): EscalationId => identity("escalation", value);

export const isEventId = (value: unknown): value is EventId => isIdentity("event", value);
export const eventId = (value: string): EventId => identity("event", value);

export function isConsumerKey(value: unknown): value is ConsumerKey {
  return typeof value === "string" && CONSUMER_KEY_PATTERN.test(value);
}

export function consumerKey(value: string): ConsumerKey {
  if (!isConsumerKey(value)) {
    throw new TypeError(
      "Consumer keys must contain 1-63 lowercase letters, digits, or hyphens and start and end with a letter or digit",
    );
  }

  return value;
}

export function isDefinitionGeneration(value: unknown): value is DefinitionGeneration {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function definitionGeneration(value: number): DefinitionGeneration {
  if (!isDefinitionGeneration(value)) {
    throw new TypeError("Definition generations must be positive safe integers");
  }

  return value;
}
