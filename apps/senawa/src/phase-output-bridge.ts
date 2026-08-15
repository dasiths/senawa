import type {
  PhaseOutputFact,
  PhaseOutputFactPort,
  RuntimeDataflowAuthority,
  RuntimeSchemaContract,
} from "@senawa/runtime";

export interface AcceptedOutputSchemaResolver {
  resolve(fact: PhaseOutputFact): RuntimeSchemaContract | undefined;
}

export class RuntimePhaseOutputFactBridge implements PhaseOutputFactPort {
  readonly authority: RuntimeDataflowAuthority;
  readonly schemas: AcceptedOutputSchemaResolver;

  constructor(authority: RuntimeDataflowAuthority, schemas: AcceptedOutputSchemaResolver) {
    this.authority = authority;
    this.schemas = schemas;
  }

  admitPhaseOutputFact(fact: PhaseOutputFact): "accepted" | "deferred" {
    const schema = this.schemas.resolve(fact);
    if (schema === undefined) return "deferred";
    this.authority.publishPhaseOutput({ fact, schema });
    return "accepted";
  }
}
