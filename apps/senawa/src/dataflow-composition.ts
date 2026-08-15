import {
  type ConfigurationSchemaResource,
  type ConfigurationSnapshot,
  schemaValidatorProfileDigest,
  validateSchemaInstance,
} from "@senawa/configuration";
import type { PhaseOutputSchemaResolverPort } from "@senawa/execution-host";
import type { CanonicalValue, Sha256 } from "@senawa/kernel";
import type {
  RuntimeSchemaContract,
  RuntimeSchemaFinding,
  RuntimeSchemaValidatorPort,
  StoredDispatch,
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

/**
 * Resolves accepted output schema contracts from the exact configuration snapshot
 * a dispatch context binds. A missing snapshot or schema leaves the slot closed.
 */
export function configurationPhaseOutputSchemas(
  loadSnapshot: (snapshotDigest: string) => unknown | undefined,
  sha256: Sha256,
): PhaseOutputSchemaResolverPort {
  return Object.freeze({
    resolve(stored: StoredDispatch): ReadonlyMap<string, RuntimeSchemaContract> {
      const declarations = stored.context.phaseOutputDeclarations;
      if (declarations.length === 0) return new Map();
      const snapshot = loadSnapshot(String(stored.context.configurationSnapshotDigest));
      if (snapshot === undefined) return new Map();
      const contracts = new Map<string, RuntimeSchemaContract>();
      for (const declaration of declarations) {
        const contract = runtimeSchemaContract(
          snapshot as ConfigurationSnapshot,
          String(declaration.schemaKey),
          sha256,
        );
        if (contract.schemaResourceDigest !== declaration.schemaResourceDigest) continue;
        contracts.set(String(declaration.outputName), contract);
      }
      return contracts;
    },
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
