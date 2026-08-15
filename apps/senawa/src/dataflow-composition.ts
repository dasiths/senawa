import {
  type ConfigurationSchemaResource,
  type ConfigurationSnapshot,
  schemaValidatorProfileDigest,
  validateSchemaInstance,
} from "@senawa/configuration";
import type { CanonicalValue, Sha256 } from "@senawa/kernel";
import type {
  RuntimeSchemaContract,
  RuntimeSchemaFinding,
  RuntimeSchemaValidatorPort,
} from "@senawa/runtime";

export function runtimeSchemaContract(
  snapshot: ConfigurationSnapshot,
  schemaKey: string,
  sha256: Sha256,
): RuntimeSchemaContract {
  const schema = snapshot.schemas.find(({ key }) => key === schemaKey);
  if (schema === undefined) {
    throw new TypeError(`Accepted configuration snapshot does not declare schema ${schemaKey}`);
  }
  return Object.freeze({
    key: schema.key,
    schemaResourceDigest: schema.source.contentDigest,
    validatorProfileDigest: schemaValidatorProfileDigest(sha256),
    schema: schema.schema,
    externalSchemas: externalSchemaContracts(snapshot.schemas, schema),
  });
}

export function configurationRuntimeSchemaValidator(): RuntimeSchemaValidatorPort {
  return Object.freeze({
    validate(
      contract: RuntimeSchemaContract,
      instance: CanonicalValue,
    ): readonly RuntimeSchemaFinding[] {
      const findings = validateSchemaInstance(
        contract.schema,
        instance,
        contract.externalSchemas.map(({ id, schema }) => ({ id, schema })),
      );
      return Object.freeze(
        findings.map((finding) => ({
          instancePointer: finding.pointer,
          schemaPointer: finding.schemaPointer ?? "",
          keyword: finding.keyword ?? finding.code,
        })),
      );
    },
  });
}

function externalSchemaContracts(
  schemas: readonly ConfigurationSchemaResource[],
  selected: ConfigurationSchemaResource,
): RuntimeSchemaContract["externalSchemas"] {
  return Object.freeze(
    schemas.flatMap((candidate) => {
      if (candidate.key === selected.key || !isRecord(candidate.schema)) return [];
      const id = candidate.schema.$id;
      return typeof id === "string"
        ? [
            Object.freeze({
              id,
              schemaResourceDigest: candidate.source.contentDigest,
              schema: candidate.schema,
            }),
          ]
        : [];
    }),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
