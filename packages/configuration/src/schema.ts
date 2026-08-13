import type { CanonicalValue } from "@senawa/kernel";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import traverse from "json-schema-traverse";
import type { ConfigurationDiagnosticCode } from "./contracts.js";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export interface SchemaValidationFinding {
  readonly code: Extract<
    ConfigurationDiagnosticCode,
    "invalid-schema" | "network-schema-reference" | "undefined-schema-reference"
  >;
  readonly pointer: string;
  readonly message: string;
}

export interface SchemaResourceIdentifier {
  readonly id: string;
  readonly pointer: string;
}

export interface SchemaDefinitionAnalysis {
  readonly findings: readonly SchemaValidationFinding[];
  readonly resources: readonly SchemaResourceIdentifier[];
}

const MAX_SCHEMA_DEPTH = 128;
const MAX_SCHEMA_NODES = 10_000;

interface SchemaResourceRecord {
  readonly id: string;
  readonly root: Readonly<Record<string, unknown>>;
  readonly pointer: string;
  readonly anchors: Map<string, SchemaAnchorRecord>;
}

interface SchemaAnchorRecord {
  readonly pointer: string;
  readonly declarationPointer: string;
}

interface SchemaLocationRecord {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly pointer: string;
  readonly resource: SchemaResourceRecord;
}

export function validateSchemaDefinition(
  schema: CanonicalValue,
  pointer: string,
): readonly SchemaValidationFinding[] {
  return analyzeSchemaDefinition(schema, pointer).findings;
}

export function analyzeSchemaDefinition(
  schema: CanonicalValue,
  pointer: string,
): SchemaDefinitionAnalysis {
  const findings: SchemaValidationFinding[] = [];
  if (!isRecord(schema)) {
    return {
      findings: [
        {
          code: "invalid-schema",
          pointer,
          message: "Schema definitions must be JSON Schema objects",
        },
      ],
      resources: [],
    };
  }
  const boundsFinding = validateSchemaBounds(schema, pointer);
  if (boundsFinding !== undefined) return { findings: [boundsFinding], resources: [] };
  let rootResourceId: string | undefined;
  if (schema.$schema !== JSON_SCHEMA_2020_12) {
    findings.push({
      code: "invalid-schema",
      pointer: `${pointer}/$schema`,
      message: `Schema definitions must declare ${JSON_SCHEMA_2020_12}`,
    });
  }
  if (typeof schema.$id !== "string" || schema.$id.length === 0) {
    findings.push({
      code: "invalid-schema",
      pointer: `${pointer}/$id`,
      message: "Schema definitions must declare a non-empty $id",
    });
  } else {
    rootResourceId = normalizeSchemaResourceId(schema.$id);
    if (rootResourceId === undefined) {
      findings.push({
        code: "invalid-schema",
        pointer: `${pointer}/$id`,
        message: "Schema $id must be a valid absolute URI without a non-empty fragment",
      });
    }
  }
  const discoveredLocations: Array<{
    readonly schema: Readonly<Record<string, unknown>>;
    readonly pointer: string;
  }> = [];
  visitSchemaLocations(schema, (subschema, relativePointer) => {
    discoveredLocations.push({ schema: subschema, pointer: relativePointer });
  });
  const index = buildSchemaLocationRecords(
    schema,
    discoveredLocations,
    rootResourceId ?? "",
    pointer,
    findings,
  );
  const resolvedReferences = new Map<string, string>();
  for (const location of index.locations) {
    inspectReferences(location, index.resources, pointer, findings, resolvedReferences);
  }
  const resources = index.resources
    .filter(({ id }) => id.length > 0)
    .map(({ id, pointer: resourcePointer }) => ({
      id,
      pointer: `${pointer}${resourcePointer}/$id`,
    }));
  if (findings.length > 0) return { findings, resources };

  const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
  if (!ajv.validateSchema(schema)) {
    return {
      findings: (ajv.errors ?? []).map((error: ErrorObject) => ({
        code: "invalid-schema" as const,
        pointer: `${pointer}${error.instancePath}`,
        message: error.message ?? "Invalid draft 2020-12 schema",
      })),
      resources,
    };
  }
  try {
    ajv.compile(buildAjvStructuralSchema(schema, index.locations, resolvedReferences));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Schema compilation failed";
    return {
      findings: [
        {
          code: message.includes("can't resolve reference")
            ? "undefined-schema-reference"
            : "invalid-schema",
          pointer,
          message,
        },
      ],
      resources,
    };
  }
  return { findings, resources };
}

function validateSchemaBounds(
  schema: Readonly<Record<string, unknown>>,
  pointer: string,
): SchemaValidationFinding | undefined {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: schema, depth: 1 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (!Array.isArray(current.value) && !isRecord(current.value)) continue;
    nodes += 1;
    if (current.depth > MAX_SCHEMA_DEPTH || nodes > MAX_SCHEMA_NODES) {
      return {
        code: "invalid-schema",
        pointer,
        message: `Schema definitions cannot exceed ${MAX_SCHEMA_DEPTH} levels or ${MAX_SCHEMA_NODES} container nodes`,
      };
    }
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
  return undefined;
}

function buildSchemaLocationRecords(
  root: Readonly<Record<string, unknown>>,
  discovered: readonly {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly pointer: string;
  }[],
  rootResourceId: string,
  diagnosticPointer: string,
  findings: SchemaValidationFinding[],
): {
  readonly locations: readonly SchemaLocationRecord[];
  readonly resources: readonly SchemaResourceRecord[];
} {
  const rootResource: SchemaResourceRecord = {
    id: rootResourceId,
    root,
    pointer: "",
    anchors: new Map(),
  };
  const resources: SchemaResourceRecord[] = [rootResource];
  const resourcePointersById = new Map<string, string>();
  if (rootResourceId.length > 0)
    resourcePointersById.set(rootResourceId, `${diagnosticPointer}/$id`);

  for (const location of discovered) {
    if (location.pointer.length === 0 || !Object.hasOwn(location.schema, "$id")) continue;
    const id = location.schema.$id;
    const idPointer = `${diagnosticPointer}${location.pointer}/$id`;
    const normalizedId = typeof id === "string" ? normalizeSchemaResourceId(id) : undefined;
    if (normalizedId === undefined) {
      findings.push({
        code: "invalid-schema",
        pointer: idPointer,
        message: "Embedded schema $id must be a valid absolute URI without a non-empty fragment",
      });
      continue;
    }
    const priorPointer = resourcePointersById.get(normalizedId);
    if (priorPointer !== undefined) {
      findings.push({
        code: "invalid-schema",
        pointer: idPointer,
        message: `Schema resource $id ${id} is already declared at ${priorPointer}`,
      });
      continue;
    }
    resourcePointersById.set(normalizedId, idPointer);
    resources.push({
      id: normalizedId,
      root: location.schema,
      pointer: location.pointer,
      anchors: new Map(),
    });
  }

  const locations = discovered.map(
    (location): SchemaLocationRecord => ({
      ...location,
      resource: findNearestResource(resources, location.pointer),
    }),
  );
  for (const location of locations) {
    for (const keyword of ["$anchor", "$dynamicAnchor"] as const) {
      const anchor = location.schema[keyword];
      if (typeof anchor !== "string") continue;
      const anchorPointer = `${diagnosticPointer}${location.pointer}/${keyword}`;
      const priorAnchor = location.resource.anchors.get(anchor);
      if (priorAnchor !== undefined) {
        findings.push({
          code: "invalid-schema",
          pointer: anchorPointer,
          message: `${keyword} ${anchor} is already declared at ${diagnosticPointer}${priorAnchor.declarationPointer}`,
        });
      } else {
        location.resource.anchors.set(anchor, {
          pointer: location.pointer,
          declarationPointer: `${location.pointer}/${keyword}`,
        });
      }
    }
  }
  return { locations, resources };
}

function findNearestResource(
  resources: readonly SchemaResourceRecord[],
  locationPointer: string,
): SchemaResourceRecord {
  let nearest = resources[0];
  if (nearest === undefined)
    throw new Error("Schema resource index must contain the root resource");
  for (const resource of resources.slice(1)) {
    if (
      (locationPointer === resource.pointer ||
        locationPointer.startsWith(`${resource.pointer}/`)) &&
      resource.pointer.length > nearest.pointer.length
    ) {
      nearest = resource;
    }
  }
  return nearest;
}

export function normalizeSchemaResourceId(value: string): string | undefined {
  if (
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    }) ||
    /%(?![0-9A-Fa-f]{2})/u.test(value)
  ) {
    return undefined;
  }
  const fragment = value.indexOf("#");
  if (fragment >= 0 && fragment !== value.length - 1) return undefined;
  try {
    const resource = new URL(value);
    resource.hash = "";
    return normalizePercentEncoding(resource.href);
  } catch {
    return undefined;
  }
}

function visitSchemaLocations(
  schema: Readonly<Record<string, unknown>>,
  visit: (schema: Readonly<Record<string, unknown>>, pointer: string) => void,
): void {
  const traverseSchema = (
    current: Readonly<Record<string, unknown>>,
    basePointer: string,
  ): void => {
    traverse(current, (subschema: Readonly<Record<string, unknown>>, pointer: string) => {
      const schemaPointer = `${basePointer}${pointer}`;
      visit(subschema, schemaPointer);
      visitDraft202012Locations(subschema, schemaPointer, traverseSchema);
    });
  };
  traverseSchema(schema, "");
}

function visitDraft202012Locations(
  schema: Readonly<Record<string, unknown>>,
  pointer: string,
  visit: (schema: Readonly<Record<string, unknown>>, pointer: string) => void,
): void {
  for (const keyword of ["unevaluatedItems", "unevaluatedProperties", "contentSchema"] as const) {
    const child = schema[keyword];
    if (isRecord(child)) visit(child, `${pointer}/${keyword}`);
  }
  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    prefixItems.forEach((child, index) => {
      if (isRecord(child)) visit(child, `${pointer}/prefixItems/${index}`);
    });
  }
  const dependentSchemas = schema.dependentSchemas;
  if (isRecord(dependentSchemas)) {
    for (const [key, child] of Object.entries(dependentSchemas)) {
      if (isRecord(child)) visit(child, `${pointer}/dependentSchemas/${escapePointer(key)}`);
    }
  }
}

function inspectReferences(
  location: SchemaLocationRecord,
  resources: readonly SchemaResourceRecord[],
  diagnosticPointer: string,
  findings: SchemaValidationFinding[],
  resolvedReferences: Map<string, string>,
): void {
  if (Object.hasOwn(location.schema, "$dynamicRef")) {
    findings.push({
      code: "invalid-schema",
      pointer: `${diagnosticPointer}${location.pointer}/$dynamicRef`,
      message: "$dynamicRef is not supported by workflow configuration v1alpha1",
    });
  }
  for (const key of ["$ref"] as const) {
    if (!Object.hasOwn(location.schema, key)) continue;
    const child = location.schema[key];
    const relativeChildPointer = `${location.pointer}/${escapePointer(key)}`;
    const childPointer = `${diagnosticPointer}${relativeChildPointer}`;
    if (typeof child !== "string" || !child.startsWith("#")) {
      findings.push({
        code: "network-schema-reference",
        pointer: childPointer,
        message: `${key} must be a local fragment reference`,
      });
      continue;
    }
    let fragment: string;
    try {
      fragment = decodeURIComponent(child.slice(1));
    } catch {
      findings.push({
        code: "invalid-schema",
        pointer: childPointer,
        message: `${key} must contain a valid URI fragment`,
      });
      continue;
    }
    let resolution: "resolved" | "undefined" | "invalid";
    let targetPointer: string | undefined;
    if (fragment.startsWith("/")) {
      resolution = resolvesJsonPointer(location.resource.root, fragment);
      if (resolution === "resolved") {
        targetPointer = `${location.resource.pointer}${fragment}`;
        if (findNearestResource(resources, targetPointer) !== location.resource) {
          resolution = "undefined";
          targetPointer = undefined;
        }
      }
    } else if (fragment.length === 0) {
      resolution = "resolved";
      targetPointer = location.resource.pointer;
    } else {
      const anchor = location.resource.anchors.get(fragment);
      resolution = anchor === undefined ? "undefined" : "resolved";
      targetPointer = anchor?.pointer;
    }
    if (resolution === "invalid") {
      findings.push({
        code: "invalid-schema",
        pointer: childPointer,
        message: `${key} must contain a valid JSON Pointer fragment`,
      });
    } else if (resolution === "undefined") {
      findings.push({
        code: "undefined-schema-reference",
        pointer: childPointer,
        message: `${key} does not resolve within this schema`,
      });
    } else if (targetPointer !== undefined) {
      resolvedReferences.set(relativeChildPointer, encodeDocumentFragment(targetPointer));
    }
  }
}

function buildAjvStructuralSchema(
  schema: Readonly<Record<string, unknown>>,
  locations: readonly SchemaLocationRecord[],
  resolvedReferences: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const structuralSchema = cloneJsonValue(schema) as Record<string, unknown>;
  for (const location of locations) {
    const structuralLocation = valueAtJsonPointer(structuralSchema, location.pointer);
    if (!isRecord(structuralLocation)) continue;
    const mutableLocation = structuralLocation as Record<string, unknown>;
    delete mutableLocation.$anchor;
    delete mutableLocation.$dynamicAnchor;
    if (location.pointer.length > 0) delete mutableLocation.$id;
    for (const keyword of ["$ref", "$dynamicRef"] as const) {
      const referencePointer = `${location.pointer}/${keyword}`;
      const resolvedReference = resolvedReferences.get(referencePointer);
      if (resolvedReference !== undefined) mutableLocation[keyword] = resolvedReference;
    }
  }
  return structuralSchema;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
  );
}

function valueAtJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer.length === 0) return root;
  let current = root;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function encodeDocumentFragment(pointer: string): string {
  return `#${encodeURIComponent(pointer).replaceAll("%2F", "/")}`;
}

function resolvesJsonPointer(root: unknown, pointer: string): "resolved" | "undefined" | "invalid" {
  let current = root;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(encodedSegment)) return "invalid";
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return "undefined";
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || !Object.hasOwn(current, index)) return "undefined";
      current = current[index];
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return "undefined";
      current = current[segment];
    }
  }
  return "resolved";
}

function normalizePercentEncoding(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/gu, (_match, encoded: string) => {
    const character = String.fromCharCode(Number.parseInt(encoded, 16));
    return /^[A-Za-z0-9._~-]$/u.test(character) ? character : `%${encoded.toUpperCase()}`;
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
