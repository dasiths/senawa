import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import type { TaskGenerationReference } from "./completion.js";
import type { AssetSensitivity } from "./context.js";
import {
  type ConsumerKey,
  type ContextId,
  type DefinitionGeneration,
  type DispatchId,
  isConsumerKey,
  isContextId,
  isDefinitionGeneration,
  isDispatchId,
  isPhaseId,
  isRunId,
  isTaskId,
  type PhaseId,
  type RunId,
} from "./identity.js";

export const WORKFLOW_INPUT_BINDING_API_VERSION = "senawa.dev/workflow-input-binding/v1";
export const PHASE_ATTEMPT_API_VERSION = "senawa.dev/phase-attempt/v1";
export const PHASE_OUTPUT_PUBLICATION_API_VERSION = "senawa.dev/phase-output-publication/v1";

const MAX_MAPPINGS = 256;
const MAX_POINTER_LENGTH = 2_048;
const MAX_POINTER_SEGMENTS = 128;

export type MappingSource =
  | { readonly kind: "workflow-input"; readonly pointer: string }
  | {
      readonly kind: "phase-output";
      readonly phase: ConsumerKey;
      readonly output: ConsumerKey;
      readonly pointer: string;
    }
  | { readonly kind: "current-item"; readonly pointer: string }
  | {
      readonly kind: "completion-evidence";
      readonly phase: ConsumerKey;
      readonly view: ConsumerKey;
      readonly pointer: string;
    };

export interface DataMappingDeclaration {
  readonly key: ConsumerKey;
  readonly source: MappingSource;
  readonly destinationPointer: string;
}

export type MappingSourceBinding =
  | {
      readonly source: Readonly<{ readonly kind: "workflow-input" }>;
      readonly sourceBindingDigest: Sha256Digest;
      readonly value: CanonicalValue;
    }
  | {
      readonly source: Readonly<{
        readonly kind: "phase-output";
        readonly phase: ConsumerKey;
        readonly output: ConsumerKey;
      }>;
      readonly sourceBindingDigest: Sha256Digest;
      readonly acceptanceDigest: Sha256Digest;
      readonly value: CanonicalValue;
    }
  | {
      readonly source: Readonly<{ readonly kind: "current-item" }>;
      readonly sourceBindingDigest: Sha256Digest;
      readonly value: CanonicalValue;
    }
  | {
      readonly source: Readonly<{
        readonly kind: "completion-evidence";
        readonly phase: ConsumerKey;
        readonly view: ConsumerKey;
      }>;
      readonly sourceBindingDigest: Sha256Digest;
      readonly value: CanonicalValue;
    };

export interface MappingEvaluationPolicy {
  readonly dependencyPhases: readonly ConsumerKey[];
  readonly declaredPhaseOutputs: readonly Readonly<{
    readonly phase: ConsumerKey;
    readonly output: ConsumerKey;
  }>[];
  readonly completionEvidenceViews: readonly Readonly<{
    readonly phase: ConsumerKey;
    readonly view: ConsumerKey;
  }>[];
  readonly allowCurrentItem: boolean;
}

export interface EvaluatedMapping {
  readonly mappingKey: ConsumerKey;
  readonly source: MappingSource;
  readonly sourceBindingDigest: Sha256Digest;
  readonly selectedValueDigest: Sha256Digest;
  readonly destinationPointer: string;
}

export interface EvaluatedPhaseInput {
  readonly value: CanonicalValue;
  readonly mappings: readonly EvaluatedMapping[];
  readonly contentDigest: Sha256Digest;
  readonly sourceSetDigest: Sha256Digest;
}

export interface WorkflowInputBindingInput {
  readonly repositoryId: string;
  readonly runId: RunId;
  readonly workflowId: string;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly schemaKey: ConsumerKey;
  readonly schemaResourceDigest: Sha256Digest;
  readonly contentDigest: Sha256Digest;
  readonly byteLength: number;
  readonly validationReceiptDigest: Sha256Digest;
}

export interface WorkflowInputBinding extends WorkflowInputBindingInput {
  readonly apiVersion: typeof WORKFLOW_INPUT_BINDING_API_VERSION;
  readonly bindingDigest: Sha256Digest;
}

export interface PhaseAttemptReference {
  readonly phaseId: PhaseId;
  readonly definitionGeneration: DefinitionGeneration;
  readonly attempt: number;
}

export interface PhaseInputBindingInput {
  readonly phase: PhaseAttemptReference;
  readonly schemaKey: ConsumerKey;
  readonly schemaResourceDigest: Sha256Digest;
  readonly mappings: readonly EvaluatedMapping[];
  readonly contentDigest: Sha256Digest;
  readonly byteLength: number;
  readonly validationReceiptDigest: Sha256Digest;
  readonly sourceSetDigest: Sha256Digest;
}

export interface PhaseInputBinding extends PhaseInputBindingInput {
  readonly bindingDigest: Sha256Digest;
}

export interface PhaseAttemptInput {
  readonly repositoryId: string;
  readonly runId: RunId;
  readonly phase: PhaseAttemptReference;
  readonly inputBindingDigest: Sha256Digest;
  readonly sourceSetDigest: Sha256Digest;
  readonly executorDigest: Sha256Digest;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly upstreamClosureSetDigest: Sha256Digest;
  readonly upstreamOutputSetDigest: Sha256Digest;
}

export interface PhaseAttempt extends PhaseAttemptInput {
  readonly apiVersion: typeof PHASE_ATTEMPT_API_VERSION;
  readonly attemptDigest: Sha256Digest;
}

export interface PhaseOutputPublicationInput {
  readonly repositoryId: string;
  readonly runId: RunId;
  readonly phase: PhaseAttemptReference;
  readonly outputName: ConsumerKey;
  readonly schemaKey: ConsumerKey;
  readonly schemaResourceDigest: Sha256Digest;
  readonly contentDigest: Sha256Digest;
  readonly byteLength: number;
  readonly mediaType: "application/json";
  readonly sensitivity: AssetSensitivity;
  readonly producingTask: TaskGenerationReference;
  readonly dispatchId: DispatchId;
  readonly contextId: ContextId;
  readonly contextDigest: Sha256Digest;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly inputBindingDigest: Sha256Digest;
  readonly validationReceiptDigest: Sha256Digest;
}

export interface PhaseOutputPublication extends PhaseOutputPublicationInput {
  readonly apiVersion: typeof PHASE_OUTPUT_PUBLICATION_API_VERSION;
  readonly publicationId: string;
  readonly publicationDigest: Sha256Digest;
}

export interface PhaseOutputAcceptanceInput {
  readonly publication: PhaseOutputPublication;
  readonly candidateDigest: Sha256Digest;
  readonly closureDigest: Sha256Digest;
}

export interface PhaseOutputAcceptance {
  readonly publicationId: string;
  readonly publicationDigest: Sha256Digest;
  readonly candidateDigest: Sha256Digest;
  readonly closureDigest: Sha256Digest;
  readonly acceptanceDigest: Sha256Digest;
}

export type DataflowErrorCode =
  | "invalid-dataflow-record"
  | "invalid-json-pointer"
  | "mapping-limit-exceeded"
  | "mapping-key-conflict"
  | "mapping-destination-collision"
  | "mapping-source-missing"
  | "phase-dependency-violation"
  | "undeclared-phase-output"
  | "completion-evidence-not-allowed"
  | "current-item-not-allowed"
  | "source-binding-conflict";

export class DataflowError extends Error {
  readonly code: DataflowErrorCode;

  constructor(code: DataflowErrorCode, message: string) {
    super(message);
    this.name = "DataflowError";
    this.code = code;
  }
}

export function evaluateDataMappings(
  declarations: readonly DataMappingDeclaration[],
  sourceBindings: readonly MappingSourceBinding[],
  policy: MappingEvaluationPolicy,
  sha256: Sha256,
): EvaluatedPhaseInput {
  const mappings = snapshotCanonical(declarations, "Data mappings");
  const bindings = snapshotCanonical(sourceBindings, "Mapping source bindings");
  const evaluatedPolicy = snapshotCanonical(policy, "Mapping evaluation policy");
  if (!Array.isArray(mappings) || !Array.isArray(bindings) || !isRecord(evaluatedPolicy)) {
    fail("invalid-dataflow-record", "Mappings, bindings, and policy must be canonical records");
  }
  if (mappings.length > MAX_MAPPINGS) {
    fail("mapping-limit-exceeded", `Mapped inputs cannot exceed ${MAX_MAPPINGS} mappings`);
  }
  const validatedPolicy = validateMappingPolicy(evaluatedPolicy);
  const validatedBindings = bindings.map(validateSourceBinding);
  const validatedMappings = mappings.map(validateMappingDeclaration);
  validatedMappings.sort((left, right) => compareText(left.key, right.key));
  assertUniqueMappingKeys(validatedMappings);
  const destinations = validatedMappings.map((mapping) => ({
    mapping,
    segments: parseJsonPointer(mapping.destinationPointer),
  }));
  validateDestinations(destinations);

  const evaluated = validatedMappings.map(
    (mapping): EvaluatedMapping & { value: CanonicalValue } => {
      validateMappingSourcePolicy(mapping.source, validatedPolicy);
      const binding = matchingSourceBinding(mapping.source, validatedBindings);
      const value = valueAtJsonPointer(binding.value, mapping.source.pointer);
      return {
        mappingKey: mapping.key,
        source: mapping.source,
        sourceBindingDigest: binding.sourceBindingDigest,
        selectedValueDigest: canonicalDigest(value, sha256),
        destinationPointer: mapping.destinationPointer,
        value,
      };
    },
  );
  const value = assembleMappedValue(evaluated);
  const mappingRecords = evaluated.map(({ value: _value, ...mapping }) => mapping);
  const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: mappingRecords }), sha256);
  return canonicalValue({
    value,
    mappings: mappingRecords,
    contentDigest: canonicalDigest(value, sha256),
    sourceSetDigest,
  }) as unknown as EvaluatedPhaseInput;
}

export function validateDataMappingDeclarations(
  declarations: readonly DataMappingDeclaration[],
  policy: MappingEvaluationPolicy,
): readonly DataMappingDeclaration[] {
  const mappings = snapshotCanonical(declarations, "Data mappings");
  const evaluatedPolicy = snapshotCanonical(policy, "Mapping evaluation policy");
  if (!Array.isArray(mappings) || !isRecord(evaluatedPolicy)) {
    fail("invalid-dataflow-record", "Mappings and policy must be canonical records");
  }
  if (mappings.length > MAX_MAPPINGS) {
    fail("mapping-limit-exceeded", `Mapped inputs cannot exceed ${MAX_MAPPINGS} mappings`);
  }
  const validatedPolicy = validateMappingPolicy(evaluatedPolicy);
  const validatedMappings = mappings.map(validateMappingDeclaration);
  validatedMappings.sort((left, right) => compareText(left.key, right.key));
  assertUniqueMappingKeys(validatedMappings);
  const destinations = validatedMappings.map((mapping) => ({
    mapping,
    segments: parseJsonPointer(mapping.destinationPointer),
  }));
  validateDestinations(destinations);
  for (const mapping of validatedMappings) {
    validateMappingSourcePolicy(mapping.source, validatedPolicy);
  }
  return canonicalValue(validatedMappings) as unknown as readonly DataMappingDeclaration[];
}

export function valueAtJsonPointer(value: CanonicalValue, pointer: string): CanonicalValue {
  const segments = parseJsonPointer(pointer);
  let current: CanonicalValue = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        fail("mapping-source-missing", `Array pointer segment ${segment} is not a canonical index`);
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        fail("mapping-source-missing", `Array pointer segment ${segment} does not exist`);
      }
      current = current[index] as CanonicalValue;
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      fail("mapping-source-missing", `JSON Pointer member ${segment} does not exist`);
    }
    current = current[segment] as CanonicalValue;
  }
  return canonicalValue(current);
}

export function createWorkflowInputBinding(
  input: WorkflowInputBindingInput,
  sha256: Sha256,
): WorkflowInputBinding {
  const content = workflowInputBindingContent(input);
  const apiVersion = WORKFLOW_INPUT_BINDING_API_VERSION;
  const bindingDigest = canonicalDigest(canonicalValue({ apiVersion, ...content }), sha256);
  return canonicalValue({
    apiVersion,
    ...content,
    bindingDigest,
  }) as unknown as WorkflowInputBinding;
}

export function validateWorkflowInputBinding(value: unknown, sha256: Sha256): WorkflowInputBinding {
  const submitted = snapshotCanonical(value, "Workflow input bindings");
  assertExactKeys(submitted, [
    "apiVersion",
    "repositoryId",
    "runId",
    "workflowId",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "schemaKey",
    "schemaResourceDigest",
    "contentDigest",
    "byteLength",
    "validationReceiptDigest",
    "bindingDigest",
  ]);
  if (submitted.apiVersion !== WORKFLOW_INPUT_BINDING_API_VERSION) {
    fail("invalid-dataflow-record", "Workflow input binding apiVersion is not supported");
  }
  const expected = createWorkflowInputBinding(
    {
      repositoryId: submitted.repositoryId as unknown as string,
      runId: submitted.runId as unknown as RunId,
      workflowId: submitted.workflowId as unknown as string,
      graphRevisionDigest: submitted.graphRevisionDigest as unknown as Sha256Digest,
      configurationSnapshotDigest: submitted.configurationSnapshotDigest as unknown as Sha256Digest,
      schemaKey: submitted.schemaKey as unknown as ConsumerKey,
      schemaResourceDigest: submitted.schemaResourceDigest as unknown as Sha256Digest,
      contentDigest: submitted.contentDigest as unknown as Sha256Digest,
      byteLength: submitted.byteLength as unknown as number,
      validationReceiptDigest: submitted.validationReceiptDigest as unknown as Sha256Digest,
    },
    sha256,
  );
  assertExactRecord(submitted, expected, "Workflow input binding");
  return expected;
}

export function createPhaseInputBinding(
  input: PhaseInputBindingInput,
  sha256: Sha256,
): PhaseInputBinding {
  const content = phaseInputBindingContent(input, sha256);
  const bindingDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, bindingDigest }) as unknown as PhaseInputBinding;
}

export function validatePhaseInputBinding(value: unknown, sha256: Sha256): PhaseInputBinding {
  const submitted = snapshotCanonical(value, "Phase input bindings");
  assertExactKeys(submitted, [
    "phase",
    "schemaKey",
    "schemaResourceDigest",
    "mappings",
    "contentDigest",
    "byteLength",
    "validationReceiptDigest",
    "sourceSetDigest",
    "bindingDigest",
  ]);
  const expected = createPhaseInputBinding(
    {
      phase: submitted.phase as unknown as PhaseAttemptReference,
      schemaKey: submitted.schemaKey as unknown as ConsumerKey,
      schemaResourceDigest: submitted.schemaResourceDigest as unknown as Sha256Digest,
      mappings: submitted.mappings as unknown as readonly EvaluatedMapping[],
      contentDigest: submitted.contentDigest as unknown as Sha256Digest,
      byteLength: submitted.byteLength as unknown as number,
      validationReceiptDigest: submitted.validationReceiptDigest as unknown as Sha256Digest,
      sourceSetDigest: submitted.sourceSetDigest as unknown as Sha256Digest,
    },
    sha256,
  );
  assertExactRecord(submitted, expected, "Phase input binding");
  return expected;
}

export function createPhaseAttempt(input: PhaseAttemptInput, sha256: Sha256): PhaseAttempt {
  const content = phaseAttemptContent(input);
  const apiVersion = PHASE_ATTEMPT_API_VERSION;
  const attemptDigest = canonicalDigest(canonicalValue({ apiVersion, ...content }), sha256);
  return canonicalValue({ apiVersion, ...content, attemptDigest }) as unknown as PhaseAttempt;
}

export function validatePhaseAttempt(value: unknown, sha256: Sha256): PhaseAttempt {
  const submitted = snapshotCanonical(value, "Phase attempts");
  assertExactKeys(submitted, [
    "apiVersion",
    "repositoryId",
    "runId",
    "phase",
    "inputBindingDigest",
    "sourceSetDigest",
    "executorDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "upstreamClosureSetDigest",
    "upstreamOutputSetDigest",
    "attemptDigest",
  ]);
  if (submitted.apiVersion !== PHASE_ATTEMPT_API_VERSION) {
    fail("invalid-dataflow-record", "Phase attempt apiVersion is not supported");
  }
  const expected = createPhaseAttempt(
    {
      repositoryId: submitted.repositoryId as unknown as string,
      runId: submitted.runId as unknown as RunId,
      phase: submitted.phase as unknown as PhaseAttemptReference,
      inputBindingDigest: submitted.inputBindingDigest as unknown as Sha256Digest,
      sourceSetDigest: submitted.sourceSetDigest as unknown as Sha256Digest,
      executorDigest: submitted.executorDigest as unknown as Sha256Digest,
      graphRevisionDigest: submitted.graphRevisionDigest as unknown as Sha256Digest,
      configurationSnapshotDigest: submitted.configurationSnapshotDigest as unknown as Sha256Digest,
      upstreamClosureSetDigest: submitted.upstreamClosureSetDigest as unknown as Sha256Digest,
      upstreamOutputSetDigest: submitted.upstreamOutputSetDigest as unknown as Sha256Digest,
    },
    sha256,
  );
  assertExactRecord(submitted, expected, "Phase attempt");
  return expected;
}

export function createPhaseOutputPublication(
  input: PhaseOutputPublicationInput,
  sha256: Sha256,
): PhaseOutputPublication {
  const content = phaseOutputPublicationContent(input);
  const apiVersion = PHASE_OUTPUT_PUBLICATION_API_VERSION;
  const publicationDigest = canonicalDigest(canonicalValue({ apiVersion, ...content }), sha256);
  const publicationId = `publication_${publicationDigest}`;
  return canonicalValue({
    apiVersion,
    publicationId,
    ...content,
    publicationDigest,
  }) as unknown as PhaseOutputPublication;
}

export function validatePhaseOutputPublication(
  value: unknown,
  sha256: Sha256,
): PhaseOutputPublication {
  const submitted = snapshotCanonical(value, "Phase output publications");
  assertExactKeys(submitted, [
    "apiVersion",
    "publicationId",
    "repositoryId",
    "runId",
    "phase",
    "outputName",
    "schemaKey",
    "schemaResourceDigest",
    "contentDigest",
    "byteLength",
    "mediaType",
    "sensitivity",
    "producingTask",
    "dispatchId",
    "contextId",
    "contextDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "inputBindingDigest",
    "validationReceiptDigest",
    "publicationDigest",
  ]);
  if (submitted.apiVersion !== PHASE_OUTPUT_PUBLICATION_API_VERSION) {
    fail("invalid-dataflow-record", "Phase output publication apiVersion is not supported");
  }
  const expected = createPhaseOutputPublication(
    {
      repositoryId: submitted.repositoryId as unknown as string,
      runId: submitted.runId as unknown as RunId,
      phase: submitted.phase as unknown as PhaseAttemptReference,
      outputName: submitted.outputName as unknown as ConsumerKey,
      schemaKey: submitted.schemaKey as unknown as ConsumerKey,
      schemaResourceDigest: submitted.schemaResourceDigest as unknown as Sha256Digest,
      contentDigest: submitted.contentDigest as unknown as Sha256Digest,
      byteLength: submitted.byteLength as unknown as number,
      mediaType: submitted.mediaType as unknown as "application/json",
      sensitivity: submitted.sensitivity as unknown as AssetSensitivity,
      producingTask: submitted.producingTask as unknown as TaskGenerationReference,
      dispatchId: submitted.dispatchId as unknown as DispatchId,
      contextId: submitted.contextId as unknown as ContextId,
      contextDigest: submitted.contextDigest as unknown as Sha256Digest,
      graphRevisionDigest: submitted.graphRevisionDigest as unknown as Sha256Digest,
      configurationSnapshotDigest: submitted.configurationSnapshotDigest as unknown as Sha256Digest,
      inputBindingDigest: submitted.inputBindingDigest as unknown as Sha256Digest,
      validationReceiptDigest: submitted.validationReceiptDigest as unknown as Sha256Digest,
    },
    sha256,
  );
  assertExactRecord(submitted, expected, "Phase output publication");
  return expected;
}

export function createPhaseOutputAcceptance(
  input: PhaseOutputAcceptanceInput,
  sha256: Sha256,
): PhaseOutputAcceptance {
  const publication = validatePhaseOutputPublication(input.publication, sha256);
  assertDigests(input as unknown as Readonly<Record<string, unknown>>, [
    "candidateDigest",
    "closureDigest",
  ]);
  const content = {
    publicationId: publication.publicationId,
    publicationDigest: publication.publicationDigest,
    candidateDigest: input.candidateDigest,
    closureDigest: input.closureDigest,
  } as const;
  const acceptanceDigest = canonicalDigest(canonicalValue(content), sha256);
  return canonicalValue({ ...content, acceptanceDigest }) as unknown as PhaseOutputAcceptance;
}

export function validatePhaseOutputAcceptance(
  value: unknown,
  publicationValue: unknown,
  sha256: Sha256,
): PhaseOutputAcceptance {
  const submitted = snapshotCanonical(value, "Phase output acceptances");
  assertExactKeys(submitted, [
    "publicationId",
    "publicationDigest",
    "candidateDigest",
    "closureDigest",
    "acceptanceDigest",
  ]);
  const expected = createPhaseOutputAcceptance(
    {
      publication: validatePhaseOutputPublication(publicationValue, sha256),
      candidateDigest: submitted.candidateDigest as unknown as Sha256Digest,
      closureDigest: submitted.closureDigest as unknown as Sha256Digest,
    },
    sha256,
  );
  assertExactRecord(submitted, expected, "Phase output acceptance");
  return expected;
}

function workflowInputBindingContent(input: WorkflowInputBindingInput): WorkflowInputBindingInput {
  const value = snapshotCanonical(input, "Workflow input binding inputs");
  assertExactKeys(value, [
    "repositoryId",
    "runId",
    "workflowId",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "schemaKey",
    "schemaResourceDigest",
    "contentDigest",
    "byteLength",
    "validationReceiptDigest",
  ]);
  validateCommonBinding(value);
  if (typeof value.workflowId !== "string" || value.workflowId.length === 0) {
    fail("invalid-dataflow-record", "workflowId must be a non-empty string");
  }
  return value as unknown as WorkflowInputBindingInput;
}

function phaseInputBindingContent(
  input: PhaseInputBindingInput,
  sha256: Sha256,
): PhaseInputBindingInput {
  const value = snapshotCanonical(input, "Phase input binding inputs");
  assertExactKeys(value, [
    "phase",
    "schemaKey",
    "schemaResourceDigest",
    "mappings",
    "contentDigest",
    "byteLength",
    "validationReceiptDigest",
    "sourceSetDigest",
  ]);
  const phase = validatePhaseAttemptReference(value.phase);
  if (!isConsumerKey(value.schemaKey)) fail("invalid-dataflow-record", "schemaKey is invalid");
  assertDigests(value, [
    "schemaResourceDigest",
    "contentDigest",
    "validationReceiptDigest",
    "sourceSetDigest",
  ]);
  assertByteLength(value.byteLength);
  if (!Array.isArray(value.mappings)) fail("invalid-dataflow-record", "mappings must be an array");
  const mappings = value.mappings
    .map(validateEvaluatedMapping)
    .sort((left, right) => compareText(left.mappingKey, right.mappingKey));
  assertUniqueEvaluatedMappings(mappings);
  const sourceSetDigest = canonicalDigest(canonicalValue({ mappings }), sha256);
  if (sourceSetDigest !== (value.sourceSetDigest as unknown)) {
    fail("invalid-dataflow-record", "sourceSetDigest does not match evaluated mappings");
  }
  return {
    phase,
    schemaKey: value.schemaKey,
    schemaResourceDigest: value.schemaResourceDigest as unknown as Sha256Digest,
    mappings,
    contentDigest: value.contentDigest as unknown as Sha256Digest,
    byteLength: value.byteLength as unknown as number,
    validationReceiptDigest: value.validationReceiptDigest as unknown as Sha256Digest,
    sourceSetDigest,
  } as unknown as PhaseInputBindingInput;
}

function phaseAttemptContent(input: PhaseAttemptInput): PhaseAttemptInput {
  const value = snapshotCanonical(input, "Phase attempt inputs");
  assertExactKeys(value, [
    "repositoryId",
    "runId",
    "phase",
    "inputBindingDigest",
    "sourceSetDigest",
    "executorDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "upstreamClosureSetDigest",
    "upstreamOutputSetDigest",
  ]);
  validateRepositoryRun(value);
  const phase = validatePhaseAttemptReference(value.phase);
  assertDigests(value, [
    "inputBindingDigest",
    "sourceSetDigest",
    "executorDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "upstreamClosureSetDigest",
    "upstreamOutputSetDigest",
  ]);
  return {
    repositoryId: value.repositoryId,
    runId: value.runId,
    phase,
    inputBindingDigest: value.inputBindingDigest,
    sourceSetDigest: value.sourceSetDigest,
    executorDigest: value.executorDigest,
    graphRevisionDigest: value.graphRevisionDigest,
    configurationSnapshotDigest: value.configurationSnapshotDigest,
    upstreamClosureSetDigest: value.upstreamClosureSetDigest,
    upstreamOutputSetDigest: value.upstreamOutputSetDigest,
  } as unknown as PhaseAttemptInput;
}

function phaseOutputPublicationContent(
  input: PhaseOutputPublicationInput,
): PhaseOutputPublicationInput {
  const value = snapshotCanonical(input, "Phase output publication inputs");
  assertExactKeys(value, [
    "repositoryId",
    "runId",
    "phase",
    "outputName",
    "schemaKey",
    "schemaResourceDigest",
    "contentDigest",
    "byteLength",
    "mediaType",
    "sensitivity",
    "producingTask",
    "dispatchId",
    "contextId",
    "contextDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "inputBindingDigest",
    "validationReceiptDigest",
  ]);
  validateRepositoryRun(value);
  const phase = validatePhaseAttemptReference(value.phase);
  if (!isConsumerKey(value.outputName) || !isConsumerKey(value.schemaKey)) {
    fail("invalid-dataflow-record", "Output and schema keys must be consumer keys");
  }
  assertDigests(value, [
    "schemaResourceDigest",
    "contentDigest",
    "contextDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "inputBindingDigest",
    "validationReceiptDigest",
  ]);
  assertByteLength(value.byteLength);
  if (value.mediaType !== "application/json") {
    fail("invalid-dataflow-record", "Phase outputs must use application/json");
  }
  if (
    !new Set(["public", "internal", "confidential", "restricted"]).has(String(value.sensitivity))
  ) {
    fail("invalid-dataflow-record", "Phase output sensitivity is invalid");
  }
  const producingTask = validateTaskReference(value.producingTask);
  if (!isDispatchId(value.dispatchId) || !isContextId(value.contextId)) {
    fail("invalid-dataflow-record", "Phase output dispatch and context identities are invalid");
  }
  return {
    repositoryId: value.repositoryId,
    runId: value.runId,
    phase,
    outputName: value.outputName,
    schemaKey: value.schemaKey,
    schemaResourceDigest: value.schemaResourceDigest,
    contentDigest: value.contentDigest,
    byteLength: value.byteLength,
    mediaType: value.mediaType,
    sensitivity: value.sensitivity,
    producingTask,
    dispatchId: value.dispatchId,
    contextId: value.contextId,
    contextDigest: value.contextDigest,
    graphRevisionDigest: value.graphRevisionDigest,
    configurationSnapshotDigest: value.configurationSnapshotDigest,
    inputBindingDigest: value.inputBindingDigest,
    validationReceiptDigest: value.validationReceiptDigest,
  } as unknown as PhaseOutputPublicationInput;
}

function validateMappingDeclaration(value: unknown): DataMappingDeclaration {
  assertExactKeys(value, ["key", "source", "destinationPointer"]);
  if (!isConsumerKey(value.key) || typeof value.destinationPointer !== "string") {
    fail("invalid-dataflow-record", "Mappings require a consumer key and destination pointer");
  }
  parseJsonPointer(value.destinationPointer);
  return {
    key: value.key,
    source: validateMappingSource(value.source),
    destinationPointer: value.destinationPointer,
  };
}

function validateMappingSource(value: unknown): MappingSource {
  if (!isRecord(value) || typeof value.kind !== "string") {
    fail("invalid-dataflow-record", "Mapping source must be an exact source record");
  }
  const pointer = typeof value.pointer === "string" ? value.pointer : undefined;
  if (pointer === undefined) fail("invalid-dataflow-record", "Mapping source pointer is required");
  parseJsonPointer(pointer);
  if (value.kind === "workflow-input" || value.kind === "current-item") {
    assertExactKeys(value, ["kind", "pointer"]);
    return { kind: value.kind as "workflow-input" | "current-item", pointer };
  }
  if (value.kind === "phase-output") {
    assertExactKeys(value, ["kind", "phase", "output", "pointer"]);
    if (!isConsumerKey(value.phase) || !isConsumerKey(value.output)) {
      fail("invalid-dataflow-record", "Phase output source keys are invalid");
    }
    return { kind: "phase-output", phase: value.phase, output: value.output, pointer };
  }
  if (value.kind === "completion-evidence") {
    assertExactKeys(value, ["kind", "phase", "view", "pointer"]);
    if (!isConsumerKey(value.phase) || !isConsumerKey(value.view)) {
      fail("invalid-dataflow-record", "Implementation evidence source keys are invalid");
    }
    return { kind: "completion-evidence", phase: value.phase, view: value.view, pointer };
  }
  fail("invalid-dataflow-record", `Mapping source kind ${value.kind} is not supported`);
}

function validateSourceBinding(value: unknown): MappingSourceBinding {
  if (!isRecord(value)) fail("invalid-dataflow-record", "Source binding must be a record");
  const source = value.source;
  if (!isRecord(source) || typeof source.kind !== "string") {
    fail("invalid-dataflow-record", "Source binding source is invalid");
  }
  const optional = source.kind === "phase-output" ? ["acceptanceDigest"] : [];
  assertExactKeys(value, ["source", "sourceBindingDigest", "value", ...optional]);
  if (!isSha256Digest(value.sourceBindingDigest)) {
    fail("invalid-dataflow-record", "Source binding digest is invalid");
  }
  const canonical = canonicalValue(value.value);
  if (source.kind === "workflow-input") {
    assertExactKeys(source, ["kind"]);
    return {
      source: { kind: "workflow-input" },
      sourceBindingDigest: value.sourceBindingDigest,
      value: canonical,
    };
  }
  if (source.kind === "current-item") {
    assertExactKeys(source, ["kind"]);
    return {
      source: { kind: "current-item" },
      sourceBindingDigest: value.sourceBindingDigest,
      value: canonical,
    };
  }
  if (source.kind === "phase-output") {
    assertExactKeys(source, ["kind", "phase", "output"]);
    if (
      !isConsumerKey(source.phase) ||
      !isConsumerKey(source.output) ||
      !isSha256Digest(value.acceptanceDigest)
    ) {
      fail("invalid-dataflow-record", "Accepted phase output binding is invalid");
    }
    return {
      source: { kind: "phase-output", phase: source.phase, output: source.output },
      sourceBindingDigest: value.sourceBindingDigest,
      acceptanceDigest: value.acceptanceDigest,
      value: canonical,
    };
  }
  if (source.kind === "completion-evidence") {
    assertExactKeys(source, ["kind", "phase", "view"]);
    if (!isConsumerKey(source.phase) || !isConsumerKey(source.view)) {
      fail("invalid-dataflow-record", "Implementation evidence binding is invalid");
    }
    return {
      source: { kind: "completion-evidence", phase: source.phase, view: source.view },
      sourceBindingDigest: value.sourceBindingDigest,
      value: canonical,
    };
  }
  fail("invalid-dataflow-record", `Source binding kind ${source.kind} is not supported`);
}

function validateMappingPolicy(value: Readonly<Record<string, unknown>>): MappingEvaluationPolicy {
  assertExactKeys(value, [
    "dependencyPhases",
    "declaredPhaseOutputs",
    "completionEvidenceViews",
    "allowCurrentItem",
  ]);
  if (!Array.isArray(value.dependencyPhases) || typeof value.allowCurrentItem !== "boolean") {
    fail(
      "invalid-dataflow-record",
      "Mapping policy dependencies or current-item policy are invalid",
    );
  }
  const dependencyPhases = value.dependencyPhases.map((phase) => {
    if (!isConsumerKey(phase)) fail("invalid-dataflow-record", "Dependency phase key is invalid");
    return phase;
  });
  const declaredPhaseOutputs = validatePolicyPairs(value.declaredPhaseOutputs, "output");
  const completionEvidenceViews = validatePolicyPairs(value.completionEvidenceViews, "view");
  return {
    dependencyPhases,
    declaredPhaseOutputs: declaredPhaseOutputs as MappingEvaluationPolicy["declaredPhaseOutputs"],
    completionEvidenceViews:
      completionEvidenceViews as MappingEvaluationPolicy["completionEvidenceViews"],
    allowCurrentItem: value.allowCurrentItem,
  };
}

function validatePolicyPairs(
  value: unknown,
  member: "output" | "view",
): readonly Readonly<Record<string, ConsumerKey>>[] {
  if (!Array.isArray(value))
    fail("invalid-dataflow-record", "Mapping policy entries must be arrays");
  return value.map((entry) => {
    assertExactKeys(entry, ["phase", member]);
    if (!isConsumerKey(entry.phase) || !isConsumerKey(entry[member])) {
      fail("invalid-dataflow-record", "Mapping policy keys are invalid");
    }
    return { phase: entry.phase, [member]: entry[member] };
  });
}

function validateMappingSourcePolicy(source: MappingSource, policy: MappingEvaluationPolicy): void {
  if (source.kind === "current-item") {
    if (!policy.allowCurrentItem)
      fail("current-item-not-allowed", "current-item is only available to fan-out task mappings");
    return;
  }
  if (source.kind === "workflow-input") return;
  if (!policy.dependencyPhases.includes(source.phase)) {
    fail(
      "phase-dependency-violation",
      `Source phase ${source.phase} is not an explicit transitive dependency`,
    );
  }
  if (source.kind === "phase-output") {
    if (
      !policy.declaredPhaseOutputs.some(
        (item) => item.phase === source.phase && item.output === source.output,
      )
    ) {
      fail("undeclared-phase-output", `Output ${source.phase}/${source.output} is not declared`);
    }
    return;
  }
  if (
    !policy.completionEvidenceViews.some(
      (item) => item.phase === source.phase && item.view === source.view,
    )
  ) {
    fail(
      "completion-evidence-not-allowed",
      `Evidence view ${source.phase}/${source.view} is not allowlisted`,
    );
  }
}

function matchingSourceBinding(
  source: MappingSource,
  bindings: readonly MappingSourceBinding[],
): MappingSourceBinding {
  const matches = bindings.filter(
    (binding) => sourceIdentity(source) === sourceIdentity(binding.source),
  );
  if (matches.length === 0)
    fail("mapping-source-missing", `Source ${sourceIdentity(source)} is unavailable`);
  if (matches.length > 1)
    fail("source-binding-conflict", `Source ${sourceIdentity(source)} has conflicting bindings`);
  return matches[0] as MappingSourceBinding;
}

function sourceIdentity(source: MappingSource | MappingSourceBinding["source"]): string {
  if (source.kind === "workflow-input" || source.kind === "current-item") return source.kind;
  if (source.kind === "phase-output") return `${source.kind}:${source.phase}:${source.output}`;
  return `${source.kind}:${source.phase}:${source.view}`;
}

function assembleMappedValue(
  mappings: readonly (EvaluatedMapping & { readonly value: CanonicalValue })[],
): CanonicalValue {
  if (mappings.length === 1 && mappings[0]?.destinationPointer === "") {
    return canonicalValue(mappings[0].value);
  }
  const root: Record<string, unknown> = Object.create(null);
  for (const mapping of mappings) {
    const segments = parseJsonPointer(mapping.destinationPointer);
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = parent[segment];
      if (existing === undefined) {
        const child: Record<string, unknown> = Object.create(null);
        parent[segment] = child;
        parent = child;
      } else if (isRecord(existing) && !Array.isArray(existing)) {
        parent = existing as Record<string, unknown>;
      } else {
        fail("mapping-destination-collision", `Destination parent ${segment} is not an object`);
      }
    }
    parent[segments[segments.length - 1] as string] = mapping.value;
  }
  return canonicalValue(root);
}

function validateDestinations(
  mappings: readonly {
    readonly mapping: DataMappingDeclaration;
    readonly segments: readonly string[];
  }[],
): void {
  const rootMappings = mappings.filter(({ segments }) => segments.length === 0);
  if (rootMappings.length > 0 && mappings.length !== 1) {
    fail("mapping-destination-collision", "A root destination must be the only mapping");
  }
  const sorted = [...mappings].sort((left, right) =>
    compareText(left.mapping.destinationPointer, right.mapping.destinationPointer),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as (typeof sorted)[number];
    const current = sorted[index] as (typeof sorted)[number];
    if (isSegmentPrefix(previous.segments, current.segments)) {
      fail(
        "mapping-destination-collision",
        `Destination ${previous.mapping.destinationPointer} collides with ${current.mapping.destinationPointer}`,
      );
    }
  }
}

function isSegmentPrefix(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((segment, index) => right[index] === segment);
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer.length > MAX_POINTER_LENGTH)
    fail("invalid-json-pointer", `JSON Pointers cannot exceed ${MAX_POINTER_LENGTH} characters`);
  if (pointer === "") return Object.freeze([]);
  if (!pointer.startsWith("/"))
    fail("invalid-json-pointer", "JSON Pointers must be empty or start with /");
  const encoded = pointer.slice(1).split("/");
  if (encoded.length > MAX_POINTER_SEGMENTS)
    fail("invalid-json-pointer", `JSON Pointers cannot exceed ${MAX_POINTER_SEGMENTS} segments`);
  return Object.freeze(
    encoded.map((segment) => {
      if (/~(?:[^01]|$)/u.test(segment))
        fail("invalid-json-pointer", `JSON Pointer ${pointer} contains an invalid escape`);
      return segment.replaceAll("~1", "/").replaceAll("~0", "~");
    }),
  );
}

function validatePhaseAttemptReference(value: unknown): PhaseAttemptReference {
  assertExactKeys(value, ["phaseId", "definitionGeneration", "attempt"]);
  if (
    !isPhaseId(value.phaseId) ||
    !isDefinitionGeneration(value.definitionGeneration) ||
    !isPositiveInteger(value.attempt)
  ) {
    fail(
      "invalid-dataflow-record",
      "Phase attempt references require an exact phase generation and positive finite attempt",
    );
  }
  return value as unknown as PhaseAttemptReference;
}

function validateTaskReference(value: unknown): TaskGenerationReference {
  assertExactKeys(value, ["taskId", "definitionGeneration", "contextRevisionDigest"]);
  if (
    !isTaskId(value.taskId) ||
    !isDefinitionGeneration(value.definitionGeneration) ||
    !isSha256Digest(value.contextRevisionDigest)
  ) {
    fail("invalid-dataflow-record", "Producing task reference is invalid");
  }
  return value as unknown as TaskGenerationReference;
}

function validateEvaluatedMapping(value: unknown): EvaluatedMapping {
  assertExactKeys(value, [
    "mappingKey",
    "source",
    "sourceBindingDigest",
    "selectedValueDigest",
    "destinationPointer",
  ]);
  if (!isConsumerKey(value.mappingKey) || typeof value.destinationPointer !== "string") {
    fail("invalid-dataflow-record", "Evaluated mapping identity or destination is invalid");
  }
  parseJsonPointer(value.destinationPointer);
  assertDigests(value, ["sourceBindingDigest", "selectedValueDigest"]);
  return {
    mappingKey: value.mappingKey,
    source: validateMappingSource(value.source),
    sourceBindingDigest: value.sourceBindingDigest as unknown as Sha256Digest,
    selectedValueDigest: value.selectedValueDigest as unknown as Sha256Digest,
    destinationPointer: value.destinationPointer,
  };
}

function assertUniqueMappingKeys(mappings: readonly DataMappingDeclaration[]): void {
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (seen.has(mapping.key))
      fail("mapping-key-conflict", `Mapping key ${mapping.key} is duplicated`);
    seen.add(mapping.key);
  }
}

function assertUniqueEvaluatedMappings(mappings: readonly EvaluatedMapping[]): void {
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (seen.has(mapping.mappingKey))
      fail("mapping-key-conflict", `Mapping key ${mapping.mappingKey} is duplicated`);
    seen.add(mapping.mappingKey);
  }
}

function validateCommonBinding(value: Readonly<Record<string, unknown>>): void {
  validateRepositoryRun(value);
  if (!isConsumerKey(value.schemaKey)) fail("invalid-dataflow-record", "schemaKey is invalid");
  assertDigests(value, [
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "schemaResourceDigest",
    "contentDigest",
    "validationReceiptDigest",
  ]);
  assertByteLength(value.byteLength);
}

function validateRepositoryRun(value: Readonly<Record<string, unknown>>): void {
  if (
    typeof value.repositoryId !== "string" ||
    value.repositoryId.length === 0 ||
    !isRunId(value.runId)
  ) {
    fail("invalid-dataflow-record", "repositoryId and runId are invalid");
  }
}

function assertDigests(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  for (const key of keys) {
    if (!isSha256Digest(value[key]))
      fail("invalid-dataflow-record", `${key} must be a SHA-256 digest`);
  }
}

function assertByteLength(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid-dataflow-record", "byteLength must be a non-negative safe integer");
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function snapshotCanonical(value: unknown, label: string): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    return fail("invalid-dataflow-record", `${label} must contain only canonical JSON data`);
  }
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, CanonicalValue>> {
  if (!isRecord(value)) fail("invalid-dataflow-record", "Dataflow values must be objects");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("invalid-dataflow-record", `Expected exact fields ${wanted.join(", ")}`);
  }
}

function assertExactRecord(submitted: CanonicalValue, expected: unknown, label: string): void {
  if (canonicalSerialize(submitted) !== canonicalSerialize(expected as CanonicalValue)) {
    fail("invalid-dataflow-record", `${label} does not match its exact content digest`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: DataflowErrorCode, message: string): never {
  throw new DataflowError(code, message);
}
