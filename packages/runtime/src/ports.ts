import type { Sha256 } from "@senawa/kernel";
import type {
  AuthenticatedPrincipal,
  CommandEnvelope,
  CommandIntent,
  DurableReceipt,
  EventStreamFrame,
  JsonValue,
  ProjectionEnvelope,
} from "@senawa/protocol";

export type RuntimeSha256 = Sha256;

export type AllocationKind = "approval" | "stream-event";

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
  queryEvents(
    repositoryId: string,
    runId: string,
    afterCursor?: number,
  ): readonly EventStreamFrame[];
  queryProjection(repositoryId: string, runId: string): ProjectionEnvelope | undefined;
}

export interface SerializableAuthorityPort {
  toCanonicalJson(): string;
}
