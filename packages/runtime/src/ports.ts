import type { IntegrationBarrier, Sha256 } from "@senawa/kernel";
import type {
  AuthenticatedPrincipal,
  CommandEnvelope,
  CommandIntent,
  DurableReceipt,
  EventReplayPage,
  EventStreamFrame,
  JsonValue,
  ProjectionEnvelope,
  ReceiptPage,
} from "@senawa/protocol";

export type RuntimeSha256 = Sha256;

export type AllocationKind = "approval" | "stream-event";

export type PageQueryErrorCode = "cursor-ahead" | "event-replay-gap";

export class PageQueryError extends Error {
  readonly code: PageQueryErrorCode;

  constructor(code: PageQueryErrorCode, message: string) {
    super(message);
    this.name = "PageQueryError";
    this.code = code;
  }
}

export interface AdmissionFacts {
  readonly currentTime: string;
  readonly facts: JsonValue;
  allocateId(kind: AllocationKind, command: CommandEnvelope): string;
}

export interface AuthorizationPolicy {
  authorize(principal: AuthenticatedPrincipal, intent: CommandIntent): boolean;
}

export interface RuntimeDependencies {
  readonly sha256: RuntimeSha256;
  readonly authorization: AuthorizationPolicy;
}

export interface CommandServicePort {
  submit(input: string | unknown, admission: AdmissionFacts): DurableReceipt;
}

export interface RuntimeQueryPort {
  queryReceipt(commandId: string): DurableReceipt | undefined;
  queryReceiptHistory(repositoryId: string, runId: string): readonly DurableReceipt[];
  queryReceiptPage(
    repositoryId: string,
    runId: string,
    afterCursor?: number,
    limit?: number,
  ): ReceiptPage;
  queryEvents(
    repositoryId: string,
    runId: string,
    afterCursor?: number,
  ): readonly EventStreamFrame[];
  queryEventPage(
    repositoryId: string,
    runId: string,
    afterCursor?: number,
    limit?: number,
  ): EventReplayPage;
  queryProjection(repositoryId: string, runId: string): ProjectionEnvelope | undefined;
  queryIntegrationBarrier(repositoryId: string, runId: string): IntegrationBarrier | undefined;
}

export interface SerializableAuthorityPort {
  toCanonicalJson(): string;
}

export interface AuthorityPort<RunState = unknown> extends SerializableAuthorityPort {
  readonly runs: Map<string, RunState>;
}
