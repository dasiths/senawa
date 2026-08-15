import {
  type ConfigurationSchemaResource,
  type ConfigurationSnapshot,
  schemaValidatorProfileDigest,
  validateSchemaInstance,
} from "@senawa/configuration";
import type { PhaseOutputSchemaResolverPort } from "@senawa/execution-host";
import { type CanonicalValue, canonicalValue, type Sha256, type Sha256Digest } from "@senawa/kernel";
import type {
  CanonicalJsonAssetPort,
  PhaseOutputFact,
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
        let contract: RuntimeSchemaContract;
        try {
          contract = runtimeSchemaContract(
            snapshot as ConfigurationSnapshot,
            String(declaration.schemaKey),
            sha256,
          );
        } catch {
          continue;
        }
        if (contract.schemaResourceDigest !== declaration.schemaResourceDigest) continue;
        contracts.set(String(declaration.outputName), contract);
      }
      return contracts;
    },
  });
}

/**
 * Reads canonical phase output bytes from the broker that staged them, falling
 * back to the command authority's canonical JSON assets for other boundaries.
 */
export function phaseOutputAssetPort(
  assets: CanonicalJsonAssetPort,
  stagedBytes: (contentDigest: string) => Uint8Array | undefined,
): CanonicalJsonAssetPort {
  return Object.freeze({
    install: (value: CanonicalValue) => assets.install(value),
    load(contentDigest: Sha256Digest): CanonicalValue | undefined {
      const installed = assets.load(contentDigest);
      if (installed !== undefined) return installed;
      const bytes = stagedBytes(String(contentDigest));
      if (bytes === undefined) return undefined;
      return canonicalValue(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    },
  });
}

/** Resolves the accepted output schema an admitted phase output fact binds. */
export function configurationOutputSchemaFor(
  loadSnapshot: (snapshotDigest: string) => unknown | undefined,
  sha256: Sha256,
  fact: PhaseOutputFact,
): RuntimeSchemaContract | undefined {
  const snapshot = loadSnapshot(String(fact.output.configurationSnapshotDigest));
  if (snapshot === undefined) return undefined;
  let contract: RuntimeSchemaContract;
  try {
    contract = runtimeSchemaContract(
      snapshot as ConfigurationSnapshot,
      String(fact.output.schemaKey),
      sha256,
    );
  } catch {
    return undefined;
  }
  return contract.schemaResourceDigest === fact.output.schemaResourceDigest ? contract : undefined;
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
