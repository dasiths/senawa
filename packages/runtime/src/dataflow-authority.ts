import {
  type BudgetLedger,
  type CanonicalValue,
  canonicalBytes,
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createPhaseAttempt,
  createPhaseInputBinding,
  createPhaseOutputPublication,
  createWorkflowInputBinding,
  type DataMappingDeclaration,
  evaluateDataMappings,
  isSha256Digest,
  type MappingEvaluationPolicy,
  type MappingSourceBinding,
  type PhaseAttempt,
  type PhaseAttemptReference,
  type PhaseAttemptTransition,
  type PhaseAttemptTransitionTrigger,
  type PhaseInputBinding,
  type PhaseIterationPolicy,
  type PhaseOutputPublication,
  planPhaseAttemptTransition,
  runId,
  type Sha256,
  type Sha256Digest,
  validatePhaseAttempt,
  validatePhaseAttemptTransition,
  validatePhaseInputBinding,
  validatePhaseOutputPublication,
  validateWorkflowInputBinding,
  type WorkflowInputBinding,
} from "@senawa/kernel";
import type { PhaseOutputFact } from "./context-broker.js";

export interface RuntimeSchemaContract {
  readonly key: string;
  readonly schemaResourceDigest: Sha256Digest;
  readonly validatorProfileDigest: Sha256Digest;
  readonly schema: CanonicalValue;
  readonly externalSchemas: readonly Readonly<{
    readonly id: string;
    readonly schemaResourceDigest: Sha256Digest;
    readonly schema: CanonicalValue;
  }>[];
}

export interface RuntimeSchemaFinding {
  readonly instancePointer: string;
  readonly schemaPointer: string;
  readonly keyword: string;
}

export interface RuntimeSchemaValidatorPort {
  validate(
    contract: RuntimeSchemaContract,
    instance: CanonicalValue,
  ): readonly RuntimeSchemaFinding[];
}

/** Exact validation receipt derivation shared by dataflow publication and worker submission. */
export function schemaValidationReceiptDigest(
  boundary: string,
  contract: Pick<RuntimeSchemaContract, "key" | "schemaResourceDigest" | "validatorProfileDigest">,
  contentDigest: Sha256Digest,
  sha256: Sha256,
): Sha256Digest {
  return canonicalDigest(
    canonicalValue({
      boundary,
      schemaKey: contract.key,
      schemaResourceDigest: contract.schemaResourceDigest,
      validatorProfileDigest: contract.validatorProfileDigest,
      contentDigest,
      findings: [],
    }),
    sha256,
  );
}

export interface CanonicalJsonAssetDescriptor {
  readonly contentDigest: Sha256Digest;
  readonly byteLength: number;
}

export interface CanonicalJsonAssetPort {
  install(value: CanonicalValue): CanonicalJsonAssetDescriptor;
  load(contentDigest: Sha256Digest): CanonicalValue | undefined;
}

export type DataflowPersistenceResult = "created" | "replayed";

export interface RuntimeDataflowPersistencePort {
  bindWorkflowInput(binding: WorkflowInputBinding): DataflowPersistenceResult;
  appendPhaseAttempt(
    attempt: PhaseAttempt,
    inputBinding: PhaseInputBinding,
  ): DataflowPersistenceResult;
  appendPhaseAttemptTransition(transition: PhaseAttemptTransition): DataflowPersistenceResult;
  publishPhaseOutput(publication: PhaseOutputPublication): DataflowPersistenceResult;
}

export interface TransitionPhaseAttemptRequest {
  readonly attempt: PhaseAttempt;
  readonly predecessorTransitionDigest?: Sha256Digest;
  readonly trigger: PhaseAttemptTransitionTrigger;
  readonly triggerDigest: Sha256Digest;
  readonly policy: PhaseIterationPolicy;
  readonly budgetLedger: BudgetLedger;
}

export interface BindWorkflowInputRequest {
  readonly repositoryId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly schema: RuntimeSchemaContract;
  readonly value: unknown;
}

export interface StartPhaseAttemptRequest {
  readonly repositoryId: string;
  readonly runId: string;
  readonly phase: PhaseAttemptReference;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly executorDigest: Sha256Digest;
  readonly upstreamClosureSetDigest: Sha256Digest;
  readonly upstreamOutputSetDigest: Sha256Digest;
  readonly schema: RuntimeSchemaContract;
  readonly mappings: readonly DataMappingDeclaration[];
  readonly sourceBindings: readonly MappingSourceBinding[];
  readonly mappingPolicy: MappingEvaluationPolicy;
}

export interface PublishPhaseOutputRequest {
  readonly fact: PhaseOutputFact;
  readonly schema: RuntimeSchemaContract;
}

export class RuntimeDataflowError extends Error {
  readonly code:
    | "schema-instance-invalid"
    | "schema-contract-mismatch"
    | "asset-installation-invalid"
    | "workflow-input-conflict"
    | "phase-attempt-conflict"
    | "output-slot-conflict"
    | "output-asset-missing"
    | "output-content-mismatch";
  readonly findings: readonly RuntimeSchemaFinding[];

  constructor(
    code: RuntimeDataflowError["code"],
    message: string,
    findings: readonly RuntimeSchemaFinding[] = [],
  ) {
    super(message);
    this.name = "RuntimeDataflowError";
    this.code = code;
    this.findings = findings;
  }
}

export class RuntimeDataflowAuthority {
  readonly sha256: Sha256;
  readonly schemas: RuntimeSchemaValidatorPort;
  readonly assets: CanonicalJsonAssetPort;
  readonly persistence: RuntimeDataflowPersistencePort;

  constructor(
    sha256: Sha256,
    schemas: RuntimeSchemaValidatorPort,
    assets: CanonicalJsonAssetPort,
    persistence: RuntimeDataflowPersistencePort,
  ) {
    this.sha256 = sha256;
    this.schemas = schemas;
    this.assets = assets;
    this.persistence = persistence;
  }

  bindWorkflowInput(request: BindWorkflowInputRequest): WorkflowInputBinding {
    const schema = validateSchemaContract(request.schema);
    const value = canonicalValue(request.value);
    const validationReceiptDigest = this.validateInstance("workflow input", schema, value);
    const asset = this.installAsset(value);
    const binding = createWorkflowInputBinding(
      {
        repositoryId: request.repositoryId,
        runId: runId(request.runId),
        workflowId: request.workflowId,
        graphRevisionDigest: request.graphRevisionDigest,
        configurationSnapshotDigest: request.configurationSnapshotDigest,
        schemaKey: consumerKey(schema.key),
        schemaResourceDigest: schema.schemaResourceDigest,
        contentDigest: asset.contentDigest,
        byteLength: asset.byteLength,
        validationReceiptDigest,
      },
      this.sha256,
    );
    this.persist("workflow-input-conflict", () => this.persistence.bindWorkflowInput(binding));
    return binding;
  }

  startPhaseAttempt(request: StartPhaseAttemptRequest): Readonly<{
    readonly attempt: PhaseAttempt;
    readonly inputBinding: PhaseInputBinding;
    readonly value: CanonicalValue;
  }> {
    const schema = validateSchemaContract(request.schema);
    const evaluated = evaluateDataMappings(
      request.mappings,
      request.sourceBindings,
      request.mappingPolicy,
      this.sha256,
    );
    const validationReceiptDigest = this.validateInstance(
      "mapped phase input",
      schema,
      evaluated.value,
    );
    const asset = this.installAsset(evaluated.value);
    if (asset.contentDigest !== evaluated.contentDigest) {
      throw new RuntimeDataflowError(
        "asset-installation-invalid",
        "Mapped input asset digest differs from the evaluated canonical value",
      );
    }
    const inputBinding = createPhaseInputBinding(
      {
        phase: request.phase,
        schemaKey: consumerKey(schema.key),
        schemaResourceDigest: schema.schemaResourceDigest,
        mappings: evaluated.mappings,
        contentDigest: asset.contentDigest,
        byteLength: asset.byteLength,
        validationReceiptDigest,
        sourceSetDigest: evaluated.sourceSetDigest,
      },
      this.sha256,
    );
    const attempt = createPhaseAttempt(
      {
        repositoryId: request.repositoryId,
        runId: runId(request.runId),
        phase: request.phase,
        inputBindingDigest: inputBinding.bindingDigest,
        sourceSetDigest: inputBinding.sourceSetDigest,
        executorDigest: request.executorDigest,
        graphRevisionDigest: request.graphRevisionDigest,
        configurationSnapshotDigest: request.configurationSnapshotDigest,
        upstreamClosureSetDigest: request.upstreamClosureSetDigest,
        upstreamOutputSetDigest: request.upstreamOutputSetDigest,
      },
      this.sha256,
    );
    this.persist("phase-attempt-conflict", () =>
      this.persistence.appendPhaseAttempt(attempt, inputBinding),
    );
    return Object.freeze({ attempt, inputBinding, value: evaluated.value });
  }

  publishPhaseOutput(request: PublishPhaseOutputRequest): PhaseOutputPublication {
    const schema = validateSchemaContract(request.schema);
    const output = request.fact.output;
    if (
      output.schemaKey !== schema.key ||
      output.schemaResourceDigest !== schema.schemaResourceDigest
    ) {
      throw new RuntimeDataflowError(
        "schema-contract-mismatch",
        "Output fact does not bind the supplied accepted schema contract",
      );
    }
    const value = this.assets.load(output.contentDigest as Sha256Digest);
    if (value === undefined) {
      throw new RuntimeDataflowError(
        "output-asset-missing",
        "Output fact references a missing canonical JSON asset",
      );
    }
    const bytes = canonicalBytes(value);
    if (
      this.sha256.digest(bytes) !== output.contentDigest ||
      bytes.byteLength !== output.byteLength
    ) {
      throw new RuntimeDataflowError(
        "output-content-mismatch",
        "Output fact content digest or byte length does not match installed canonical JSON",
      );
    }
    const validationReceiptDigest = this.validateInstance("phase output", schema, value);
    if (validationReceiptDigest !== output.validationReceiptDigest) {
      throw new RuntimeDataflowError(
        "schema-contract-mismatch",
        "Output fact validation receipt does not match runtime schema validation",
      );
    }
    const publication = createPhaseOutputPublication(
      {
        repositoryId: request.fact.repositoryId,
        runId: runId(request.fact.runId),
        phase: output.phase as never,
        outputName: consumerKey(output.outputName),
        schemaKey: consumerKey(output.schemaKey),
        schemaResourceDigest: schema.schemaResourceDigest,
        contentDigest: output.contentDigest as Sha256Digest,
        byteLength: output.byteLength,
        mediaType: output.mediaType,
        sensitivity: output.sensitivity,
        producingTask: request.fact.producingTask,
        dispatchId: request.fact.dispatchId as never,
        contextId: request.fact.contextId as never,
        contextDigest: request.fact.contextDigest as Sha256Digest,
        graphRevisionDigest: output.graphRevisionDigest as Sha256Digest,
        configurationSnapshotDigest: output.configurationSnapshotDigest as Sha256Digest,
        inputBindingDigest: output.inputBindingDigest as Sha256Digest,
        validationReceiptDigest,
      },
      this.sha256,
    );
    this.persist("output-slot-conflict", () => this.persistence.publishPhaseOutput(publication));
    return publication;
  }

  transitionPhaseAttempt(request: TransitionPhaseAttemptRequest): Readonly<{
    readonly transition: PhaseAttemptTransition;
    readonly budgetLedger: BudgetLedger;
  }> {
    const attempt = validatePhaseAttempt(request.attempt, this.sha256);
    const policyDigest = canonicalDigest(canonicalValue(request.policy), this.sha256);
    const planned = planPhaseAttemptTransition(
      {
        repositoryId: attempt.repositoryId,
        runId: attempt.runId,
        phase: attempt.phase,
        attemptDigest: attempt.attemptDigest,
        ...(request.predecessorTransitionDigest === undefined
          ? {}
          : { predecessorTransitionDigest: request.predecessorTransitionDigest }),
        trigger: request.trigger,
        triggerDigest: request.triggerDigest,
        policyDigest,
        policy: request.policy,
        budgetLedger: request.budgetLedger,
      },
      this.sha256,
    );
    this.persist("phase-attempt-conflict", () =>
      this.persistence.appendPhaseAttemptTransition(planned.transition),
    );
    return planned;
  }

  private validateInstance(
    boundary: string,
    schema: RuntimeSchemaContract,
    value: CanonicalValue,
  ): Sha256Digest {
    const findings = [...this.schemas.validate(schema, value)].sort(compareFinding);
    if (findings.length > 0) {
      throw new RuntimeDataflowError(
        "schema-instance-invalid",
        `${boundary} does not satisfy schema ${schema.key}`,
        Object.freeze(findings),
      );
    }
    return schemaValidationReceiptDigest(
      boundary,
      schema,
      canonicalDigest(value, this.sha256),
      this.sha256,
    );
  }

  private installAsset(value: CanonicalValue): CanonicalJsonAssetDescriptor {
    const expected = {
      contentDigest: canonicalDigest(value, this.sha256),
      byteLength: canonicalBytes(value).byteLength,
    };
    const installed = this.assets.install(value);
    if (
      installed.contentDigest !== expected.contentDigest ||
      installed.byteLength !== expected.byteLength
    ) {
      throw new RuntimeDataflowError(
        "asset-installation-invalid",
        "Canonical JSON asset store returned a conflicting descriptor",
      );
    }
    return installed;
  }

  private persist(
    code: Extract<
      RuntimeDataflowError["code"],
      "workflow-input-conflict" | "phase-attempt-conflict" | "output-slot-conflict"
    >,
    operation: () => DataflowPersistenceResult,
  ): void {
    try {
      operation();
    } catch (error) {
      throw new RuntimeDataflowError(
        code,
        error instanceof Error ? error.message : "Dataflow persistence conflict",
      );
    }
  }
}

export class InMemoryCanonicalJsonAssetStore implements CanonicalJsonAssetPort {
  readonly sha256: Sha256;
  readonly values = new Map<Sha256Digest, CanonicalValue>();

  constructor(sha256: Sha256) {
    this.sha256 = sha256;
  }

  install(value: CanonicalValue): CanonicalJsonAssetDescriptor {
    const canonical = canonicalValue(value);
    const contentDigest = canonicalDigest(canonical, this.sha256);
    this.values.set(contentDigest, canonical);
    return Object.freeze({ contentDigest, byteLength: canonicalBytes(canonical).byteLength });
  }

  load(contentDigest: Sha256Digest): CanonicalValue | undefined {
    return this.values.get(contentDigest);
  }
}

export class InMemoryRuntimeDataflowPersistence implements RuntimeDataflowPersistencePort {
  readonly workflowInputs = new Map<string, WorkflowInputBinding>();
  readonly attempts = new Map<
    string,
    Readonly<{ attempt: PhaseAttempt; input: PhaseInputBinding }>
  >();
  readonly publications = new Map<string, PhaseOutputPublication>();
  readonly transitions = new Map<string, PhaseAttemptTransition>();

  constructor(readonly sha256: Sha256) {}

  bindWorkflowInput(value: WorkflowInputBinding): DataflowPersistenceResult {
    const binding = validateWorkflowInputBinding(value, this.sha256);
    const key = `${binding.repositoryId}\u0000${binding.runId}`;
    return assignExact(this.workflowInputs, key, binding);
  }

  appendPhaseAttempt(
    attemptValue: PhaseAttempt,
    inputValue: PhaseInputBinding,
  ): DataflowPersistenceResult {
    const attempt = validatePhaseAttempt(attemptValue, this.sha256);
    const input = validatePhaseInputBinding(inputValue, this.sha256);
    if (
      input.bindingDigest !== attempt.inputBindingDigest ||
      input.sourceSetDigest !== attempt.sourceSetDigest
    ) {
      throw new TypeError("Phase attempt does not match its input binding");
    }
    const key = `${attempt.repositoryId}\u0000${attempt.runId}\u0000${attempt.phase.phaseId}\u0000${attempt.phase.definitionGeneration}\u0000${attempt.phase.attempt}`;
    return assignExact(this.attempts, key, Object.freeze({ attempt, input }));
  }

  publishPhaseOutput(value: PhaseOutputPublication): DataflowPersistenceResult {
    const publication = validatePhaseOutputPublication(value, this.sha256);
    const key = `${publication.repositoryId}\u0000${publication.runId}\u0000${publication.phase.phaseId}\u0000${publication.phase.definitionGeneration}\u0000${publication.phase.attempt}\u0000${publication.outputName}`;
    return assignExact(this.publications, key, publication);
  }

  appendPhaseAttemptTransition(value: PhaseAttemptTransition): DataflowPersistenceResult {
    const transition = validatePhaseAttemptTransition(value, this.sha256);
    const key = `${transition.repositoryId}\u0000${transition.runId}\u0000${transition.attemptDigest}`;
    return assignExact(this.transitions, key, transition);
  }
}

function validateSchemaContract(contract: RuntimeSchemaContract): RuntimeSchemaContract {
  if (
    typeof contract.key !== "string" ||
    !isSha256Digest(contract.schemaResourceDigest) ||
    !isSha256Digest(contract.validatorProfileDigest)
  ) {
    throw new RuntimeDataflowError(
      "schema-contract-mismatch",
      "Runtime schema contract identity or digest is invalid",
    );
  }
  return contract;
}

function assignExact<Value>(
  map: Map<string, Value>,
  key: string,
  value: Value,
): DataflowPersistenceResult {
  const prior = map.get(key);
  if (prior === undefined) {
    map.set(key, value);
    return "created";
  }
  if (JSON.stringify(prior) !== JSON.stringify(value)) {
    throw new TypeError("Authority key is already assigned to different canonical content");
  }
  return "replayed";
}

function compareFinding(left: RuntimeSchemaFinding, right: RuntimeSchemaFinding): number {
  const leftKey = `${left.instancePointer}\u0000${left.schemaPointer}\u0000${left.keyword}`;
  const rightKey = `${right.instancePointer}\u0000${right.schemaPointer}\u0000${right.keyword}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
