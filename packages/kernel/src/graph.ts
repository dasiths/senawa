import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import {
  CompletionAccountingError,
  type CompletionPolicy,
  validateCompletionPolicy,
} from "./completion.js";
import {
  type ConsumerKey,
  type CriterionId,
  type DefinitionGeneration,
  isConsumerKey,
  isCriterionId,
  isDefinitionGeneration,
  isPhaseId,
  isTaskId,
  isWorkflowId,
  type PhaseId,
  type TaskId,
  type WorkflowId,
} from "./identity.js";

export interface SourcePointerInput {
  readonly locator: string;
  readonly pointer: string;
}

export interface SourcePointer {
  readonly locator: string;
  readonly pointer: string;
}

interface DefinitionInput<Id, SupersededId = never> {
  readonly id: Id;
  readonly key: ConsumerKey;
  /** What a person calls this. Presentation only: never part of identity or the digest. */
  readonly title?: string;
  readonly generation: DefinitionGeneration;
  readonly source: SourcePointerInput;
  readonly input?: unknown;
  readonly supersedes?: readonly SupersededId[];
}

export interface WorkflowDefinitionInput extends DefinitionInput<WorkflowId> {}

export interface PhaseDefinitionInput extends DefinitionInput<PhaseId, PhaseId> {
  readonly parentId: WorkflowId | PhaseId;
  readonly dependsOn?: readonly PhaseId[];
}

export interface TaskDefinitionInput extends DefinitionInput<TaskId, TaskId> {
  readonly parentId: PhaseId;
  readonly dependsOn?: readonly TaskId[];
  readonly completionPolicy: CompletionPolicy;
}

export type ExecutableWorkInput = TaskDefinitionInput;

export interface CriterionDefinitionInput extends DefinitionInput<CriterionId, CriterionId> {
  readonly parentId: TaskId;
}

export interface NormalizedWorkflowInput {
  readonly workflow: WorkflowDefinitionInput;
  readonly phases: readonly PhaseDefinitionInput[];
  readonly executableWork: readonly ExecutableWorkInput[];
  readonly criteria: readonly CriterionDefinitionInput[];
}

interface Definition<Id> {
  readonly id: Id;
  readonly key: ConsumerKey;
  readonly title?: string;
  readonly generation: DefinitionGeneration;
  readonly source: SourcePointer;
  readonly input: CanonicalValue;
  readonly definitionDigest: Sha256Digest;
}

export interface WorkflowDefinition extends Definition<WorkflowId> {}

export interface PhaseDefinition extends Definition<PhaseId> {
  readonly parentId: WorkflowId | PhaseId;
  readonly dependsOn: readonly PhaseId[];
  readonly supersedes: readonly PhaseId[];
}

export interface TaskDefinition extends Definition<TaskId> {
  readonly parentId: PhaseId;
  readonly dependsOn: readonly TaskId[];
  readonly supersedes: readonly TaskId[];
  readonly completionPolicy: CompletionPolicy;
}

export interface CriterionDefinition extends Definition<CriterionId> {
  readonly parentId: TaskId;
  readonly supersedes: readonly CriterionId[];
}

export interface WorkflowNode {
  readonly kind: "workflow";
  readonly definition: WorkflowDefinition;
}

export interface PhaseNode {
  readonly kind: "phase";
  readonly definition: PhaseDefinition;
}

export interface TaskNode {
  readonly kind: "task";
  readonly definition: TaskDefinition;
}

export interface CriterionNode {
  readonly kind: "criterion";
  readonly definition: CriterionDefinition;
}

export type GraphNode = WorkflowNode | PhaseNode | TaskNode | CriterionNode;

export type ContainsEdge =
  | { readonly kind: "contains"; readonly from: WorkflowId; readonly to: PhaseId }
  | { readonly kind: "contains"; readonly from: PhaseId; readonly to: PhaseId }
  | { readonly kind: "contains"; readonly from: PhaseId; readonly to: TaskId }
  | { readonly kind: "contains"; readonly from: TaskId; readonly to: CriterionId };

export type DependsOnEdge =
  | { readonly kind: "depends-on"; readonly from: PhaseId; readonly to: PhaseId }
  | { readonly kind: "depends-on"; readonly from: TaskId; readonly to: TaskId };

export type SupersedesEdge =
  | { readonly kind: "supersedes"; readonly from: PhaseId; readonly to: PhaseId }
  | { readonly kind: "supersedes"; readonly from: TaskId; readonly to: TaskId }
  | { readonly kind: "supersedes"; readonly from: CriterionId; readonly to: CriterionId };

export type GraphEdge = ContainsEdge | DependsOnEdge | SupersedesEdge;

export interface WorkflowGraph {
  readonly workflowId: WorkflowId;
  readonly revisionDigest: Sha256Digest;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export type GraphCompilationErrorCode =
  | "duplicate-id"
  | "duplicate-key"
  | "invalid-input"
  | "invalid-identity"
  | "invalid-key"
  | "invalid-generation"
  | "invalid-relation"
  | "unknown-reference"
  | "invalid-parent"
  | "containment-cycle"
  | "dependency-cycle"
  | "supersession-cycle"
  | "invalid-supersession"
  | "invalid-completion-policy"
  | "invalid-source";

export type GraphCompilationDiagnosticField =
  | "completionPolicy"
  | "completionEvidencePolicy"
  | "dependsOn"
  | "parentId"
  | "supersedes"
  | "source";

export interface GraphCompilationDiagnostic {
  readonly code: GraphCompilationErrorCode;
  readonly message: string;
  readonly subject?: Readonly<{ readonly kind: GraphNode["kind"]; readonly id: string }>;
  readonly field?: GraphCompilationDiagnosticField;
}

export type WorkflowGraphDiagnosis = Readonly<
  | { readonly diagnostics: readonly GraphCompilationDiagnostic[]; readonly graph?: never }
  | { readonly diagnostics: readonly []; readonly graph: WorkflowGraph }
>;

export class GraphCompilationError extends Error {
  readonly code: GraphCompilationErrorCode;
  readonly subject?: GraphCompilationDiagnostic["subject"];
  readonly field?: GraphCompilationDiagnosticField;

  constructor(
    code: GraphCompilationErrorCode,
    message: string,
    context: Pick<GraphCompilationDiagnostic, "subject" | "field"> = {},
  ) {
    super(message);
    this.name = "GraphCompilationError";
    this.code = code;
    if (context.subject !== undefined) {
      this.subject = context.subject;
    }
    if (context.field !== undefined) {
      this.field = context.field;
    }
  }
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export function compileWorkflowGraph(
  input: NormalizedWorkflowInput,
  sha256: Sha256,
): WorkflowGraph {
  return compileWorkflowGraphInternal(input, sha256);
}

export function diagnoseWorkflowGraph(
  input: NormalizedWorkflowInput,
  sha256: Sha256,
): WorkflowGraphDiagnosis {
  let submittedInput: NormalizedWorkflowInput;
  try {
    submittedInput = snapshotWorkflowInput(input);
  } catch (error) {
    if (!(error instanceof GraphCompilationError)) {
      throw error;
    }
    return diagnosisFailure([diagnosticFromError(error)]);
  }

  if (!hasDefinitionArrays(submittedInput)) {
    return diagnosisFailure([
      createDiagnostic(
        "invalid-relation",
        "Normalized workflow input must contain phase, task, and criterion arrays",
      ),
    ]);
  }

  const diagnostics: GraphCompilationDiagnostic[] = [];
  const declaredIds = collectDeclaredIds(submittedInput);
  const workflow = diagnoseDefinition("workflow", submittedInput.workflow, sha256, diagnostics);
  const phases = submittedInput.phases.flatMap((definition) => {
    const compiled = diagnoseDefinition("phase", definition, sha256, diagnostics);
    return compiled === undefined ? [] : [compiled];
  });
  const tasks = submittedInput.executableWork.flatMap((definition) => {
    const compiled = diagnoseDefinition("task", definition, sha256, diagnostics);
    return compiled === undefined ? [] : [compiled];
  });
  const criteria = submittedInput.criteria.flatMap((definition) => {
    const compiled = diagnoseDefinition("criterion", definition, sha256, diagnostics);
    return compiled === undefined ? [] : [compiled];
  });
  const criterionOwnersWithCompilationErrors = collectCriterionOwnersWithCompilationErrors(
    submittedInput.criteria,
    criteria,
  );

  const duplicateIds = collectUniqueIdDiagnostics(
    workflow === undefined ? [] : [workflow],
    phases,
    tasks,
    criteria,
    diagnostics,
  );
  collectUniqueKeyDiagnostics(phases, tasks, criteria, diagnostics);
  const unambiguousPhases = phases.filter(({ id }) => !duplicateIds.has(id));
  const unambiguousTasks = tasks.filter(({ id }) => !duplicateIds.has(id));
  const unambiguousCriteria = criteria.filter(({ id }) => !duplicateIds.has(id));
  collectReferenceDiagnostics(
    workflow,
    unambiguousPhases,
    unambiguousTasks,
    unambiguousCriteria,
    declaredIds,
    criterionOwnersWithCompilationErrors,
    diagnostics,
  );
  collectCycleDiagnostics(
    unambiguousPhases,
    (phase) => phase.parentId,
    "containment-cycle",
    "parentId",
    diagnostics,
  );
  collectCycleDiagnostics(
    unambiguousPhases,
    (phase) => phase.dependsOn,
    "dependency-cycle",
    "dependsOn",
    diagnostics,
  );
  collectCycleDiagnostics(
    unambiguousTasks,
    (task) => task.dependsOn,
    "dependency-cycle",
    "dependsOn",
    diagnostics,
  );
  collectCycleDiagnostics(
    unambiguousPhases,
    (phase) => phase.supersedes,
    "supersession-cycle",
    "supersedes",
    diagnostics,
  );
  collectCycleDiagnostics(
    unambiguousTasks,
    (task) => task.supersedes,
    "supersession-cycle",
    "supersedes",
    diagnostics,
  );
  collectCycleDiagnostics(
    unambiguousCriteria,
    (criterion) => criterion.supersedes,
    "supersession-cycle",
    "supersedes",
    diagnostics,
  );
  collectSupersessionDiagnostics(unambiguousPhases, diagnostics);
  collectSupersessionDiagnostics(unambiguousTasks, diagnostics);
  collectSupersessionDiagnostics(unambiguousCriteria, diagnostics);

  if (diagnostics.length > 0) {
    return diagnosisFailure(diagnostics);
  }
  return Object.freeze({
    diagnostics: Object.freeze([]) as readonly [],
    graph: compileWorkflowGraphInternal(submittedInput, sha256),
  });
}

function hasDefinitionArrays(input: unknown): input is NormalizedWorkflowInput {
  return (
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as Partial<NormalizedWorkflowInput>).phases) &&
    Array.isArray((input as Partial<NormalizedWorkflowInput>).executableWork) &&
    Array.isArray((input as Partial<NormalizedWorkflowInput>).criteria)
  );
}

function collectDeclaredIds(input: NormalizedWorkflowInput): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const definition of [
    input.workflow,
    ...input.phases,
    ...input.executableWork,
    ...input.criteria,
  ]) {
    if (
      typeof definition === "object" &&
      definition !== null &&
      typeof definition.id === "string"
    ) {
      ids.add(definition.id);
    }
  }
  return ids;
}

function collectCriterionOwnersWithCompilationErrors(
  declared: readonly CriterionDefinitionInput[],
  compiled: readonly CriterionDefinition[],
): ReadonlySet<TaskId> {
  const compiledIds = new Set(compiled.map((criterion) => criterion.id));
  const owners = new Set<TaskId>();
  for (const criterion of declared) {
    if (
      typeof criterion === "object" &&
      criterion !== null &&
      isCriterionId(criterion.id) &&
      isTaskId(criterion.parentId) &&
      !compiledIds.has(criterion.id)
    ) {
      owners.add(criterion.parentId);
    }
  }
  return owners;
}

function diagnoseDefinition(
  kind: "workflow",
  input: WorkflowDefinitionInput,
  sha256: Sha256,
  diagnostics: GraphCompilationDiagnostic[],
): WorkflowDefinition | undefined;
function diagnoseDefinition(
  kind: "phase",
  input: PhaseDefinitionInput,
  sha256: Sha256,
  diagnostics: GraphCompilationDiagnostic[],
): PhaseDefinition | undefined;
function diagnoseDefinition(
  kind: "task",
  input: TaskDefinitionInput,
  sha256: Sha256,
  diagnostics: GraphCompilationDiagnostic[],
): TaskDefinition | undefined;
function diagnoseDefinition(
  kind: "criterion",
  input: CriterionDefinitionInput,
  sha256: Sha256,
  diagnostics: GraphCompilationDiagnostic[],
): CriterionDefinition | undefined;
function diagnoseDefinition(
  kind: GraphNode["kind"],
  input:
    | WorkflowDefinitionInput
    | PhaseDefinitionInput
    | TaskDefinitionInput
    | CriterionDefinitionInput,
  sha256: Sha256,
  diagnostics: GraphCompilationDiagnostic[],
): WorkflowDefinition | PhaseDefinition | TaskDefinition | CriterionDefinition | undefined {
  try {
    switch (kind) {
      case "workflow": {
        const definition = input as WorkflowDefinitionInput;
        assertDefinitionScalars(kind, definition, isWorkflowId);
        return compileWorkflow(definition, sha256);
      }
      case "phase": {
        const definition = input as PhaseDefinitionInput;
        assertDefinitionScalars(kind, definition, isPhaseId);
        if (!isWorkflowId(definition.parentId) && !isPhaseId(definition.parentId)) {
          invalidParent(definition.id, definition.parentId, "workflow or phase", kind);
        }
        assertRelationIdentities(kind, definition.id, "dependsOn", definition.dependsOn, isPhaseId);
        assertRelationIdentities(
          kind,
          definition.id,
          "supersedes",
          definition.supersedes,
          isPhaseId,
        );
        return compilePhase(definition, sha256);
      }
      case "task": {
        const definition = input as TaskDefinitionInput;
        assertDefinitionScalars(kind, definition, isTaskId);
        if (!isPhaseId(definition.parentId)) {
          invalidParent(definition.id, definition.parentId, "phase", kind);
        }
        assertRelationIdentities(kind, definition.id, "dependsOn", definition.dependsOn, isTaskId);
        assertRelationIdentities(
          kind,
          definition.id,
          "supersedes",
          definition.supersedes,
          isTaskId,
        );
        return compileTask(definition, sha256);
      }
      case "criterion": {
        const definition = input as CriterionDefinitionInput;
        assertDefinitionScalars(kind, definition, isCriterionId);
        if (!isTaskId(definition.parentId)) {
          invalidParent(definition.id, definition.parentId, "task", kind);
        }
        assertRelationIdentities(
          kind,
          definition.id,
          "supersedes",
          definition.supersedes,
          isCriterionId,
        );
        return compileCriterion(definition, sha256);
      }
    }
  } catch (error) {
    if (!(error instanceof GraphCompilationError)) {
      throw error;
    }
    diagnostics.push(diagnosticFromError(error, definitionSubject(kind, input)));
    return undefined;
  }
}

function definitionSubject(
  kind: GraphNode["kind"],
  input: unknown,
): GraphCompilationDiagnostic["subject"] {
  if (typeof input !== "object" || input === null || !("id" in input)) {
    return undefined;
  }
  const id = input.id;
  const isExpected =
    kind === "workflow"
      ? isWorkflowId(id)
      : kind === "phase"
        ? isPhaseId(id)
        : kind === "task"
          ? isTaskId(id)
          : isCriterionId(id);
  return isExpected && typeof id === "string" ? Object.freeze({ kind, id }) : undefined;
}

function diagnosisFailure(
  diagnostics: readonly GraphCompilationDiagnostic[],
): WorkflowGraphDiagnosis {
  return Object.freeze({ diagnostics: sortCompilationDiagnostics(diagnostics) });
}

function diagnosticFromError(
  error: GraphCompilationError,
  fallbackSubject?: GraphCompilationDiagnostic["subject"],
): GraphCompilationDiagnostic {
  return createDiagnostic(error.code, error.message, error.subject ?? fallbackSubject, error.field);
}

function createDiagnostic(
  code: GraphCompilationErrorCode,
  message: string,
  subject?: GraphCompilationDiagnostic["subject"],
  field?: GraphCompilationDiagnosticField,
): GraphCompilationDiagnostic {
  return Object.freeze({
    code,
    message,
    ...(subject === undefined ? {} : { subject: Object.freeze({ ...subject }) }),
    ...(field === undefined ? {} : { field }),
  });
}

function sortCompilationDiagnostics(
  diagnostics: readonly GraphCompilationDiagnostic[],
): readonly GraphCompilationDiagnostic[] {
  return Object.freeze(
    [...diagnostics].sort(
      (left, right) =>
        compilationDiagnosticPriority(left.code) - compilationDiagnosticPriority(right.code) ||
        compareText(left.subject?.id ?? "", right.subject?.id ?? "") ||
        compareText(left.field ?? "", right.field ?? "") ||
        compareText(left.code, right.code) ||
        compareText(left.message, right.message),
    ),
  );
}

function compilationDiagnosticPriority(code: GraphCompilationErrorCode): number {
  return [
    "invalid-input",
    "invalid-relation",
    "invalid-identity",
    "invalid-key",
    "invalid-generation",
    "invalid-parent",
    "invalid-source",
    "invalid-completion-policy",
    "duplicate-id",
    "duplicate-key",
    "unknown-reference",
    "containment-cycle",
    "dependency-cycle",
    "supersession-cycle",
    "invalid-supersession",
  ].indexOf(code);
}

function compileWorkflowGraphInternal(
  input: NormalizedWorkflowInput,
  sha256: Sha256,
): WorkflowGraph {
  const submittedInput = snapshotWorkflowInput(input);
  assertNormalizedWorkflowInput(submittedInput);

  const workflow = compileWorkflow(submittedInput.workflow, sha256);
  const phases = submittedInput.phases.map((definition) => compilePhase(definition, sha256));
  const tasks = submittedInput.executableWork.map((definition) => compileTask(definition, sha256));
  const criteria = submittedInput.criteria.map((definition) =>
    compileCriterion(definition, sha256),
  );

  assertUniqueIds([workflow], phases, tasks, criteria);
  assertUniqueKeys(phases, tasks, criteria);
  assertReferences(workflow, phases, tasks, criteria);
  assertNoCycles(phases, (phase) => phase.parentId, "containment-cycle");
  assertNoCycles(phases, (phase) => phase.dependsOn, "dependency-cycle");
  assertNoCycles(tasks, (task) => task.dependsOn, "dependency-cycle");
  assertNoCycles(phases, (phase) => phase.supersedes, "supersession-cycle");
  assertNoCycles(tasks, (task) => task.supersedes, "supersession-cycle");
  assertNoCycles(criteria, (criterion) => criterion.supersedes, "supersession-cycle");
  assertSupersession(phases);
  assertSupersession(tasks);
  assertSupersession(criteria);

  const nodes = sortNodes([
    freezeNode("workflow", workflow),
    ...phases.map((definition) => freezeNode("phase", definition)),
    ...tasks.map((definition) => freezeNode("task", definition)),
    ...criteria.map((definition) => freezeNode("criterion", definition)),
  ]);
  const edges = sortEdges(createEdges(phases, tasks, criteria));
  const revisionDigest = canonicalDigest(
    canonicalValue({
      workflowId: workflow.id,
      definitions: nodes.map((node) => node.definition.definitionDigest),
      edges,
    }),
    sha256,
  );

  return Object.freeze({
    workflowId: workflow.id,
    revisionDigest,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}

function snapshotWorkflowInput(input: unknown): NormalizedWorkflowInput {
  try {
    return canonicalValue(input) as unknown as NormalizedWorkflowInput;
  } catch {
    throw new GraphCompilationError(
      "invalid-input",
      "Normalized workflow input must be a stable canonical JSON value",
    );
  }
}

export function validateWorkflowGraph(value: unknown, sha256: Sha256): WorkflowGraph {
  let snapshot: CanonicalValue;
  try {
    snapshot = canonicalValue(value);
  } catch {
    throw new GraphValidationError("Workflow graphs must be canonical JSON values");
  }

  try {
    const input = workflowInputFromGraphSnapshot(snapshot);
    const recompiled = compileWorkflowGraph(input, sha256);
    if (
      canonicalSerialize(snapshot) !== canonicalSerialize(recompiled as unknown as CanonicalValue)
    ) {
      throw new GraphValidationError(
        "The submitted workflow graph does not equal its canonical recompilation",
      );
    }
    return recompiled;
  } catch (error) {
    if (error instanceof GraphValidationError) {
      throw error;
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new GraphValidationError(`The submitted workflow graph is invalid${detail}`);
  }
}

export function normalizedWorkflowInputFromGraph(
  value: unknown,
  sha256: Sha256,
): NormalizedWorkflowInput {
  const graph = validateWorkflowGraph(value, sha256);
  return canonicalValue(
    workflowInputFromGraphSnapshot(canonicalValue(graph)),
  ) as unknown as NormalizedWorkflowInput;
}

type ValidatedNodeInput =
  | { readonly kind: "workflow"; readonly definition: WorkflowDefinitionInput }
  | { readonly kind: "phase"; readonly definition: PhaseDefinitionInput }
  | { readonly kind: "task"; readonly definition: TaskDefinitionInput }
  | { readonly kind: "criterion"; readonly definition: CriterionDefinitionInput };

function workflowInputFromGraphSnapshot(value: unknown): NormalizedWorkflowInput {
  assertExactKeys(value, "graph", ["workflowId", "revisionDigest", "nodes", "edges"]);
  if (!isWorkflowId(value.workflowId)) {
    invalidGraph("graph.workflowId must be a workflow identity");
  }
  if (!isSha256Digest(value.revisionDigest)) {
    invalidGraph("graph.revisionDigest must be a SHA-256 digest");
  }
  if (!Array.isArray(value.nodes)) {
    invalidGraph("graph.nodes must be an array");
  }
  if (!Array.isArray(value.edges)) {
    invalidGraph("graph.edges must be an array");
  }

  let workflow: WorkflowDefinitionInput | undefined;
  const phases: PhaseDefinitionInput[] = [];
  const executableWork: TaskDefinitionInput[] = [];
  const criteria: CriterionDefinitionInput[] = [];
  for (const [index, nodeValue] of value.nodes.entries()) {
    const node = nodeInput(nodeValue, `graph.nodes[${index}]`);
    switch (node.kind) {
      case "workflow":
        if (workflow !== undefined) {
          invalidGraph("graph.nodes must contain exactly one workflow definition");
        }
        workflow = node.definition;
        break;
      case "phase":
        phases.push(node.definition);
        break;
      case "task":
        executableWork.push(node.definition);
        break;
      case "criterion":
        criteria.push(node.definition);
        break;
    }
  }
  if (workflow === undefined) {
    invalidGraph("graph.nodes must contain exactly one workflow definition");
  }

  for (const [index, edge] of value.edges.entries()) {
    assertGraphEdge(edge, `graph.edges[${index}]`);
  }

  return { workflow, phases, executableWork, criteria };
}

function nodeInput(value: unknown, path: string): ValidatedNodeInput {
  assertExactKeys(value, path, ["kind", "definition"]);
  switch (value.kind) {
    case "workflow":
      return { kind: value.kind, definition: workflowDefinitionInput(value.definition, path) };
    case "phase":
      return { kind: value.kind, definition: phaseDefinitionInput(value.definition, path) };
    case "task":
      return { kind: value.kind, definition: taskDefinitionInput(value.definition, path) };
    case "criterion":
      return { kind: value.kind, definition: criterionDefinitionInput(value.definition, path) };
    default:
      return invalidGraph(`${path}.kind is not a graph node kind`);
  }
}

function workflowDefinitionInput(value: unknown, path: string): WorkflowDefinitionInput {
  const definitionPath = `${path}.definition`;
  assertExactKeys(
    value,
    definitionPath,
    ["id", "key", "generation", "source", "input", "definitionDigest"],
    ["title"],
  );
  assertCommonDefinition(value, definitionPath, isWorkflowId);
  return {
    id: value.id as WorkflowId,
    key: value.key as ConsumerKey,
    ...decodedTitle(value, definitionPath),
    generation: value.generation as DefinitionGeneration,
    source: sourceInput(value.source, definitionPath),
    input: value.input,
  };
}

function phaseDefinitionInput(value: unknown, path: string): PhaseDefinitionInput {
  const definitionPath = `${path}.definition`;
  assertExactKeys(
    value,
    definitionPath,
    [
      "id",
      "key",
      "generation",
      "source",
      "input",
      "definitionDigest",
      "parentId",
      "dependsOn",
      "supersedes",
    ],
    ["title"],
  );
  assertCommonDefinition(value, definitionPath, isPhaseId);
  if (!isWorkflowId(value.parentId) && !isPhaseId(value.parentId)) {
    invalidGraph(`${definitionPath}.parentId must be a workflow or phase identity`);
  }
  assertIdentityArray(value.dependsOn, `${definitionPath}.dependsOn`, isPhaseId);
  assertIdentityArray(value.supersedes, `${definitionPath}.supersedes`, isPhaseId);
  return {
    id: value.id as PhaseId,
    key: value.key as ConsumerKey,
    ...decodedTitle(value, definitionPath),
    generation: value.generation as DefinitionGeneration,
    source: sourceInput(value.source, definitionPath),
    input: value.input,
    parentId: value.parentId,
    dependsOn: value.dependsOn as PhaseId[],
    supersedes: value.supersedes as PhaseId[],
  };
}

function taskDefinitionInput(value: unknown, path: string): TaskDefinitionInput {
  const definitionPath = `${path}.definition`;
  assertExactKeys(
    value,
    definitionPath,
    [
      "id",
      "key",
      "generation",
      "source",
      "input",
      "definitionDigest",
      "parentId",
      "dependsOn",
      "supersedes",
      "completionPolicy",
    ],
    ["title"],
  );
  assertCommonDefinition(value, definitionPath, isTaskId);
  if (!isPhaseId(value.parentId)) {
    invalidGraph(`${definitionPath}.parentId must be a phase identity`);
  }
  assertIdentityArray(value.dependsOn, `${definitionPath}.dependsOn`, isTaskId);
  assertIdentityArray(value.supersedes, `${definitionPath}.supersedes`, isTaskId);
  const completionPolicy = graphCompletionPolicy(
    value.completionPolicy,
    `${definitionPath}.completionPolicy`,
  );
  return {
    id: value.id as TaskId,
    key: value.key as ConsumerKey,
    ...decodedTitle(value, definitionPath),
    generation: value.generation as DefinitionGeneration,
    source: sourceInput(value.source, definitionPath),
    input: value.input,
    parentId: value.parentId,
    dependsOn: value.dependsOn as TaskId[],
    supersedes: value.supersedes as TaskId[],
    completionPolicy,
  };
}

function graphCompletionPolicy(value: unknown, path: string): CompletionPolicy {
  try {
    return validateCompletionPolicy(value);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return invalidGraph(`${path} is invalid${detail}`);
  }
}

function criterionDefinitionInput(value: unknown, path: string): CriterionDefinitionInput {
  const definitionPath = `${path}.definition`;
  assertExactKeys(
    value,
    definitionPath,
    ["id", "key", "generation", "source", "input", "definitionDigest", "parentId", "supersedes"],
    ["title"],
  );
  assertCommonDefinition(value, definitionPath, isCriterionId);
  if (!isTaskId(value.parentId)) {
    invalidGraph(`${definitionPath}.parentId must be a task identity`);
  }
  assertIdentityArray(value.supersedes, `${definitionPath}.supersedes`, isCriterionId);
  return {
    id: value.id as CriterionId,
    key: value.key as ConsumerKey,
    ...decodedTitle(value, definitionPath),
    generation: value.generation as DefinitionGeneration,
    source: sourceInput(value.source, definitionPath),
    input: value.input,
    parentId: value.parentId,
    supersedes: value.supersedes as CriterionId[],
  };
}

function decodedTitle(value: Record<string, unknown>, path: string): { readonly title?: string } {
  if (value.title === undefined) return {};
  if (
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    value.title.length > MAX_DEFINITION_TITLE
  ) {
    invalidGraph(`${path}.title must be 1 to ${MAX_DEFINITION_TITLE} characters`);
  }
  return { title: value.title };
}

function assertCommonDefinition(
  value: Record<string, unknown>,
  path: string,
  isExpectedIdentity: (candidate: unknown) => boolean,
): void {
  if (!isExpectedIdentity(value.id)) {
    invalidGraph(`${path}.id has the wrong identity kind`);
  }
  if (!isConsumerKey(value.key)) {
    invalidGraph(`${path}.key must be a consumer key`);
  }
  if (!isDefinitionGeneration(value.generation)) {
    invalidGraph(`${path}.generation must be a positive safe integer`);
  }
  if (!isSha256Digest(value.definitionDigest)) {
    invalidGraph(`${path}.definitionDigest must be a SHA-256 digest`);
  }
}

function sourceInput(value: unknown, path: string): SourcePointerInput {
  const sourcePath = `${path}.source`;
  assertExactKeys(value, sourcePath, ["locator", "pointer"]);
  if (typeof value.locator !== "string" || value.locator.length === 0) {
    invalidGraph(`${sourcePath}.locator must be a non-empty string`);
  }
  if (typeof value.pointer !== "string") {
    invalidGraph(`${sourcePath}.pointer must be a string`);
  }
  return { locator: value.locator, pointer: value.pointer };
}

function assertIdentityArray(
  value: unknown,
  path: string,
  isExpectedIdentity: (candidate: unknown) => boolean,
): void {
  if (!Array.isArray(value) || value.some((candidate) => !isExpectedIdentity(candidate))) {
    invalidGraph(`${path} must be an array of identities of the expected kind`);
  }
}

function assertGraphEdge(value: unknown, path: string): void {
  assertExactKeys(value, path, ["kind", "from", "to"]);
  const isValid =
    (value.kind === "contains" &&
      ((isWorkflowId(value.from) && isPhaseId(value.to)) ||
        (isPhaseId(value.from) && (isPhaseId(value.to) || isTaskId(value.to))) ||
        (isTaskId(value.from) && isCriterionId(value.to)))) ||
    (value.kind === "depends-on" &&
      ((isPhaseId(value.from) && isPhaseId(value.to)) ||
        (isTaskId(value.from) && isTaskId(value.to)))) ||
    (value.kind === "supersedes" &&
      ((isPhaseId(value.from) && isPhaseId(value.to)) ||
        (isTaskId(value.from) && isTaskId(value.to)) ||
        (isCriterionId(value.from) && isCriterionId(value.to))));
  if (!isValid) {
    invalidGraph(`${path} is not a typed graph edge`);
  }
}

function assertExactKeys(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidGraph(`${path} must be an object`);
  }
  const optional = new Set(optionalKeys);
  const actualKeys = Object.keys(value)
    .filter((key) => !optional.has(key))
    .sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    invalidGraph(`${path} must contain exactly: ${expected.join(", ")}`);
  }
}

function invalidGraph(message: string): never {
  throw new GraphValidationError(message);
}

function assertNormalizedWorkflowInput(input: NormalizedWorkflowInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray(input.phases) ||
    !Array.isArray(input.executableWork) ||
    !Array.isArray(input.criteria)
  ) {
    throw new GraphCompilationError(
      "invalid-relation",
      "Normalized workflow input must contain phase, task, and criterion arrays",
    );
  }

  assertDefinitionScalars("workflow", input.workflow, isWorkflowId);
  for (const phase of input.phases) {
    assertDefinitionScalars("phase", phase, isPhaseId);
    if (!isWorkflowId(phase.parentId) && !isPhaseId(phase.parentId)) {
      invalidParent(phase.id, phase.parentId, "workflow or phase");
    }
    assertRelationIdentities("phase", phase.id, "dependsOn", phase.dependsOn, isPhaseId);
    assertRelationIdentities("phase", phase.id, "supersedes", phase.supersedes, isPhaseId);
  }
  for (const task of input.executableWork) {
    assertDefinitionScalars("task", task, isTaskId);
    if (!isPhaseId(task.parentId)) {
      invalidParent(task.id, task.parentId, "phase");
    }
    assertRelationIdentities("task", task.id, "dependsOn", task.dependsOn, isTaskId);
    assertRelationIdentities("task", task.id, "supersedes", task.supersedes, isTaskId);
    compileCompletionPolicy(task.completionPolicy);
  }
  for (const criterion of input.criteria) {
    assertDefinitionScalars("criterion", criterion, isCriterionId);
    if (!isTaskId(criterion.parentId)) {
      invalidParent(criterion.id, criterion.parentId, "task");
    }
    assertRelationIdentities(
      "criterion",
      criterion.id,
      "supersedes",
      criterion.supersedes,
      isCriterionId,
    );
  }
}

function assertDefinitionScalars(
  kind: GraphNode["kind"],
  input: DefinitionInput<unknown, unknown>,
  isExpectedIdentity: (value: unknown) => boolean,
): void {
  if (typeof input !== "object" || input === null || !isExpectedIdentity(input.id)) {
    throw new GraphCompilationError(
      "invalid-identity",
      `${kind} definitions must use a ${kind} identity`,
    );
  }
  if (!isConsumerKey(input.key)) {
    throw new GraphCompilationError("invalid-key", `${kind} definitions must use a consumer key`);
  }
  if (!isDefinitionGeneration(input.generation)) {
    throw new GraphCompilationError(
      "invalid-generation",
      `${kind} definitions must use a positive safe-integer generation`,
    );
  }
  assertSourcePointer(input.source);
}

function assertRelationIdentities(
  kind: GraphNode["kind"],
  ownerId: unknown,
  relation: "dependsOn" | "supersedes",
  values: readonly unknown[] | undefined,
  isExpectedIdentity: (value: unknown) => boolean,
): void {
  if (values === undefined) {
    return;
  }
  if (!Array.isArray(values)) {
    const subject = definitionSubject(kind, { id: ownerId });
    throw new GraphCompilationError(
      "invalid-relation",
      `${kind} ${relation} relationships must be arrays`,
      { ...(subject === undefined ? {} : { subject }), field: relation },
    );
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index) || !isExpectedIdentity(values[index])) {
      const subject = definitionSubject(kind, { id: ownerId });
      throw new GraphCompilationError(
        "invalid-relation",
        `${kind} ${String(ownerId)} has a ${relation} identity of the wrong kind`,
        { ...(subject === undefined ? {} : { subject }), field: relation },
      );
    }
  }
}

function compileWorkflow(input: WorkflowDefinitionInput, sha256: Sha256): WorkflowDefinition {
  const common = compileCommon("workflow", input, sha256, {});
  return Object.freeze(common);
}

function compilePhase(input: PhaseDefinitionInput, sha256: Sha256): PhaseDefinition {
  const dependsOn = sortedUnique(input.dependsOn ?? []);
  const supersedes = sortedUnique(input.supersedes ?? []);
  const common = compileCommon("phase", input, sha256, {
    parentId: input.parentId,
    dependsOn,
    supersedes,
  });
  return Object.freeze({ ...common, parentId: input.parentId, dependsOn, supersedes });
}

function compileTask(input: TaskDefinitionInput, sha256: Sha256): TaskDefinition {
  const dependsOn = sortedUnique(input.dependsOn ?? []);
  const supersedes = sortedUnique(input.supersedes ?? []);
  const completionPolicy = compileCompletionPolicy(input.completionPolicy);
  const common = compileCommon("task", input, sha256, {
    parentId: input.parentId,
    dependsOn,
    supersedes,
    completionPolicy,
  });
  return Object.freeze({
    ...common,
    parentId: input.parentId,
    dependsOn,
    supersedes,
    completionPolicy,
  });
}

function compileCompletionPolicy(value: unknown): CompletionPolicy {
  try {
    return validateCompletionPolicy(value);
  } catch (error) {
    if (error instanceof CompletionAccountingError) {
      throw new GraphCompilationError("invalid-completion-policy", error.message, {
        field: error.path?.includes(".completionEvidencePolicy")
          ? "completionEvidencePolicy"
          : "completionPolicy",
      });
    }
    throw error;
  }
}

function compileCriterion(input: CriterionDefinitionInput, sha256: Sha256): CriterionDefinition {
  const supersedes = sortedUnique(input.supersedes ?? []);
  const common = compileCommon("criterion", input, sha256, {
    parentId: input.parentId,
    supersedes,
  });
  return Object.freeze({ ...common, parentId: input.parentId, supersedes });
}

function compileCommon<Id>(
  kind: GraphNode["kind"],
  input: DefinitionInput<Id, Id>,
  sha256: Sha256,
  relationships: Readonly<Record<string, unknown>>,
): Definition<Id> {
  const source = sourcePointer(input.source);
  const normalizedInput = canonicalValue(input.input ?? null);
  // The digest names its fields, so a title rides along without renaming anything.
  const definitionDigest = canonicalDigest(
    canonicalValue({
      kind,
      id: input.id,
      key: input.key,
      generation: input.generation,
      source,
      input: normalizedInput,
      ...relationships,
    }),
    sha256,
  );
  return {
    id: input.id,
    key: input.key,
    ...(input.title === undefined ? {} : { title: definitionTitle(input.title) }),
    generation: input.generation,
    source,
    input: normalizedInput,
    definitionDigest,
  };
}

const MAX_DEFINITION_TITLE = 256;

function definitionTitle(value: string): string {
  if (value.length === 0 || value.length > MAX_DEFINITION_TITLE) {
    throw new GraphCompilationError(
      "invalid-input",
      `A definition title must be 1 to ${MAX_DEFINITION_TITLE} characters`,
    );
  }
  return value;
}

function sourcePointer(input: SourcePointerInput): SourcePointer {
  assertSourcePointer(input);
  return Object.freeze({ locator: input.locator, pointer: input.pointer });
}

function assertSourcePointer(input: SourcePointerInput): void {
  if (typeof input !== "object" || input === null) {
    throw new GraphCompilationError("invalid-source", "Sources must be objects", {
      field: "source",
    });
  }
  if (typeof input.locator !== "string" || input.locator.length === 0) {
    throw new GraphCompilationError("invalid-source", "Source locators must be non-empty strings", {
      field: "source",
    });
  }
  if (typeof input.pointer !== "string") {
    throw new GraphCompilationError("invalid-source", "Source pointers must be strings", {
      field: "source",
    });
  }
}

function collectUniqueIdDiagnostics(
  workflows: readonly WorkflowDefinition[],
  phases: readonly PhaseDefinition[],
  tasks: readonly TaskDefinition[],
  criteria: readonly CriterionDefinition[],
  diagnostics: GraphCompilationDiagnostic[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const [kind, definitions] of [
    ["workflow", workflows],
    ["phase", phases],
    ["task", tasks],
    ["criterion", criteria],
  ] as const) {
    for (const definition of definitions) {
      if (seen.has(definition.id)) {
        duplicates.add(definition.id);
        diagnostics.push(
          createDiagnostic("duplicate-id", `Duplicate definition identity: ${definition.id}`, {
            kind,
            id: definition.id,
          }),
        );
      }
      seen.add(definition.id);
    }
  }
  return duplicates;
}

function collectUniqueKeyDiagnostics(
  phases: readonly PhaseDefinition[],
  tasks: readonly TaskDefinition[],
  criteria: readonly CriterionDefinition[],
  diagnostics: GraphCompilationDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const [kind, definitions] of [
    ["phase", phases],
    ["task", tasks],
    ["criterion", criteria],
  ] as const) {
    for (const definition of definitions) {
      const scopedKey = `${kind}\u0000${definition.parentId}\u0000${definition.key}`;
      if (seen.has(scopedKey)) {
        diagnostics.push(
          createDiagnostic(
            "duplicate-key",
            `Duplicate ${kind} key ${definition.key} under ${definition.parentId}`,
            { kind, id: definition.id },
          ),
        );
      }
      seen.add(scopedKey);
    }
  }
}

function collectReferenceDiagnostics(
  workflow: WorkflowDefinition | undefined,
  phases: readonly PhaseDefinition[],
  tasks: readonly TaskDefinition[],
  criteria: readonly CriterionDefinition[],
  declaredIds: ReadonlySet<string>,
  criterionOwnersWithCompilationErrors: ReadonlySet<TaskId>,
  diagnostics: GraphCompilationDiagnostic[],
): void {
  const phaseById = indexById(phases);
  const taskById = indexById(tasks);
  const criterionById = indexById(criteria);

  for (const phase of phases) {
    if (
      phase.parentId !== workflow?.id &&
      !phaseById.has(phase.parentId as PhaseId) &&
      !declaredIds.has(phase.parentId)
    ) {
      diagnostics.push(unknownReferenceDiagnostic("phase", phase.id, phase.parentId, "parentId"));
    }
    collectKnownReferenceDiagnostics(
      "phase",
      phase.id,
      phase.dependsOn,
      phaseById,
      "dependsOn",
      declaredIds,
      diagnostics,
    );
    collectKnownReferenceDiagnostics(
      "phase",
      phase.id,
      phase.supersedes,
      phaseById,
      "supersedes",
      declaredIds,
      diagnostics,
    );
  }
  for (const task of tasks) {
    if (!phaseById.has(task.parentId) && !declaredIds.has(task.parentId)) {
      diagnostics.push(unknownReferenceDiagnostic("task", task.id, task.parentId, "parentId"));
    }
    collectKnownReferenceDiagnostics(
      "task",
      task.id,
      task.dependsOn,
      taskById,
      "dependsOn",
      declaredIds,
      diagnostics,
    );
    collectKnownReferenceDiagnostics(
      "task",
      task.id,
      task.supersedes,
      taskById,
      "supersedes",
      declaredIds,
      diagnostics,
    );
  }
  for (const criterion of criteria) {
    if (!taskById.has(criterion.parentId) && !declaredIds.has(criterion.parentId)) {
      diagnostics.push(
        unknownReferenceDiagnostic("criterion", criterion.id, criterion.parentId, "parentId"),
      );
    }
    collectKnownReferenceDiagnostics(
      "criterion",
      criterion.id,
      criterion.supersedes,
      criterionById,
      "supersedes",
      declaredIds,
      diagnostics,
    );
  }

  const criteriaByTask = new Map<TaskId, CriterionId[]>();
  for (const criterion of criteria) {
    const owned = criteriaByTask.get(criterion.parentId) ?? [];
    owned.push(criterion.id);
    criteriaByTask.set(criterion.parentId, owned);
  }
  for (const task of tasks) {
    if (criterionOwnersWithCompilationErrors.has(task.id)) {
      continue;
    }
    const owned = [...(criteriaByTask.get(task.id) ?? [])].sort(compareText);
    const declared = task.completionPolicy.criteria
      .map((requirement) => requirement.criterionId)
      .sort(compareText);
    if (
      owned.length !== declared.length ||
      owned.some((criterionId, index) => criterionId !== declared[index])
    ) {
      diagnostics.push(
        createDiagnostic(
          "invalid-completion-policy",
          `Task ${task.id} completion policy must declare every owned criterion exactly once`,
          { kind: "task", id: task.id },
          "completionPolicy",
        ),
      );
    }
  }
}

function collectKnownReferenceDiagnostics<Id extends string, DefinitionType extends Definition<Id>>(
  kind: GraphNode["kind"],
  ownerId: string,
  references: readonly Id[],
  index: ReadonlyMap<Id, DefinitionType>,
  field: "dependsOn" | "supersedes",
  declaredIds: ReadonlySet<string>,
  diagnostics: GraphCompilationDiagnostic[],
): void {
  for (const reference of references) {
    if (!index.has(reference) && !declaredIds.has(reference)) {
      diagnostics.push(unknownReferenceDiagnostic(kind, ownerId, reference, field));
    }
  }
}

function unknownReferenceDiagnostic(
  kind: GraphNode["kind"],
  ownerId: string,
  reference: string,
  field: "dependsOn" | "parentId" | "supersedes",
): GraphCompilationDiagnostic {
  return createDiagnostic(
    "unknown-reference",
    `${ownerId} references unknown definition ${reference}`,
    { kind, id: ownerId },
    field,
  );
}

function collectCycleDiagnostics<Id extends string, DefinitionType extends Definition<Id>>(
  definitions: readonly DefinitionType[],
  references: (definition: DefinitionType) => Id | readonly Id[],
  code: "containment-cycle" | "dependency-cycle" | "supersession-cycle",
  field: "dependsOn" | "parentId" | "supersedes",
  diagnostics: GraphCompilationDiagnostic[],
): void {
  const index = indexById(definitions);
  const discovery = new Map<Id, number>();
  const lowLink = new Map<Id, number>();
  const stack: Id[] = [];
  const onStack = new Set<Id>();
  let nextIndex = 0;

  const visit = (id: Id): void => {
    discovery.set(id, nextIndex);
    lowLink.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    const definition = index.get(id);
    const related = definition === undefined ? [] : references(definition);
    const relatedIds = (Array.isArray(related) ? related : [related])
      .filter((relatedId): relatedId is Id => index.has(relatedId as Id))
      .sort(compareText);
    for (const relatedId of relatedIds) {
      if (!discovery.has(relatedId)) {
        visit(relatedId);
        lowLink.set(
          id,
          Math.min(requiredNumber(lowLink.get(id)), requiredNumber(lowLink.get(relatedId))),
        );
      } else if (onStack.has(relatedId)) {
        lowLink.set(
          id,
          Math.min(requiredNumber(lowLink.get(id)), requiredNumber(discovery.get(relatedId))),
        );
      }
    }
    if (lowLink.get(id) !== discovery.get(id)) {
      return;
    }
    const component: Id[] = [];
    let member: Id;
    do {
      member = stack.pop() as Id;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    component.sort(compareText);
    const subjectId = component[0];
    const isSelfCycle =
      component.length === 1 &&
      definition !== undefined &&
      (Array.isArray(related) ? related : [related]).includes(subjectId as Id);
    if (subjectId !== undefined && (component.length > 1 || isSelfCycle)) {
      const subjectDefinition = index.get(subjectId);
      const kind = graphKindForDefinition(subjectDefinition);
      diagnostics.push(
        createDiagnostic(code, `${code} includes ${subjectId}`, { kind, id: subjectId }, field),
      );
    }
  };

  const sortedIds = [...index.keys()] as Id[];
  sortedIds.sort((left, right) => compareText(left, right));
  for (const id of sortedIds) {
    if (!discovery.has(id)) {
      visit(id);
    }
  }
}

function graphKindForDefinition(definition: Definition<string> | undefined): GraphNode["kind"] {
  if (definition !== undefined && "completionPolicy" in definition) {
    return "task";
  }
  if (definition !== undefined && "dependsOn" in definition) {
    return "phase";
  }
  return "criterion";
}

function requiredNumber(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("Cycle analysis index is missing");
  }
  return value;
}

function collectSupersessionDiagnostics<
  Id extends string,
  DefinitionType extends Definition<Id> & {
    readonly parentId: string;
    readonly supersedes: readonly Id[];
  },
>(definitions: readonly DefinitionType[], diagnostics: GraphCompilationDiagnostic[]): void {
  const index = indexById(definitions);
  for (const definition of definitions) {
    for (const supersededId of definition.supersedes) {
      const superseded = index.get(supersededId);
      if (superseded === undefined) {
        continue;
      }
      const kind = graphKindForDefinition(definition);
      if (definition.parentId !== superseded.parentId) {
        diagnostics.push(
          createDiagnostic(
            "invalid-supersession",
            `${definition.id} cannot supersede ${superseded.id} under a different parent`,
            { kind, id: definition.id },
            "supersedes",
          ),
        );
      }
      if (definition.generation <= superseded.generation) {
        diagnostics.push(
          createDiagnostic(
            "invalid-supersession",
            `${definition.id} must have a newer generation than ${superseded.id}`,
            { kind, id: definition.id },
            "supersedes",
          ),
        );
      }
    }
  }
}

function sortedUnique<Id extends string>(values: readonly Id[]): readonly Id[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function assertUniqueIds(
  workflows: readonly WorkflowDefinition[],
  phases: readonly PhaseDefinition[],
  tasks: readonly TaskDefinition[],
  criteria: readonly CriterionDefinition[],
): void {
  const seen = new Set<string>();
  for (const definition of [...workflows, ...phases, ...tasks, ...criteria]) {
    if (seen.has(definition.id)) {
      throw new GraphCompilationError(
        "duplicate-id",
        `Duplicate definition identity: ${definition.id}`,
      );
    }
    seen.add(definition.id);
  }
}

function assertUniqueKeys(
  phases: readonly PhaseDefinition[],
  tasks: readonly TaskDefinition[],
  criteria: readonly CriterionDefinition[],
): void {
  const seen = new Set<string>();
  const groups = [
    ["phase", phases],
    ["task", tasks],
    ["criterion", criteria],
  ] as const;
  for (const [kind, definitions] of groups) {
    for (const definition of definitions) {
      const scopedKey = `${kind}\u0000${definition.parentId}\u0000${definition.key}`;
      if (seen.has(scopedKey)) {
        throw new GraphCompilationError(
          "duplicate-key",
          `Duplicate ${kind} key ${definition.key} under ${definition.parentId}`,
        );
      }
      seen.add(scopedKey);
    }
  }
}

function assertReferences(
  workflow: WorkflowDefinition,
  phases: readonly PhaseDefinition[],
  tasks: readonly TaskDefinition[],
  criteria: readonly CriterionDefinition[],
): void {
  const phaseById = indexById(phases);
  const taskById = indexById(tasks);
  const criterionById = indexById(criteria);

  for (const phase of phases) {
    if (phase.parentId !== workflow.id && !isPhaseId(phase.parentId)) {
      invalidParent(phase.id, phase.parentId, "workflow or phase");
    }
    if (phase.parentId !== workflow.id && !phaseById.has(phase.parentId)) {
      unknownReference("phase", phase.id, phase.parentId, "parentId");
    }
    assertKnown("phase", phase.id, phase.dependsOn, phaseById, "dependsOn");
    assertKnown("phase", phase.id, phase.supersedes, phaseById, "supersedes");
  }
  for (const task of tasks) {
    if (!isPhaseId(task.parentId)) {
      invalidParent(task.id, task.parentId, "phase");
    }
    if (!phaseById.has(task.parentId)) {
      unknownReference("task", task.id, task.parentId, "parentId");
    }
    assertKnown("task", task.id, task.dependsOn, taskById, "dependsOn");
    assertKnown("task", task.id, task.supersedes, taskById, "supersedes");
  }
  for (const criterion of criteria) {
    if (!isTaskId(criterion.parentId)) {
      invalidParent(criterion.id, criterion.parentId, "task");
    }
    if (!taskById.has(criterion.parentId)) {
      unknownReference("criterion", criterion.id, criterion.parentId, "parentId");
    }
    assertKnown("criterion", criterion.id, criterion.supersedes, criterionById, "supersedes");
  }

  const criteriaByTask = new Map<TaskId, CriterionId[]>();
  for (const criterion of criteria) {
    const owned = criteriaByTask.get(criterion.parentId) ?? [];
    owned.push(criterion.id);
    criteriaByTask.set(criterion.parentId, owned);
  }
  for (const task of tasks) {
    const owned = [...(criteriaByTask.get(task.id) ?? [])].sort(compareText);
    const declared = task.completionPolicy.criteria
      .map((requirement) => requirement.criterionId)
      .sort(compareText);
    if (
      owned.length !== declared.length ||
      owned.some((criterionId, index) => criterionId !== declared[index])
    ) {
      throw new GraphCompilationError(
        "invalid-completion-policy",
        `Task ${task.id} completion policy must declare every owned criterion exactly once`,
      );
    }
  }
}

function assertKnown<Id extends string, DefinitionType extends Definition<Id>>(
  kind: GraphNode["kind"],
  ownerId: string,
  references: readonly Id[],
  index: ReadonlyMap<Id, DefinitionType>,
  field: "dependsOn" | "supersedes",
): void {
  for (const reference of references) {
    if (!index.has(reference)) {
      unknownReference(kind, ownerId, reference, field);
    }
  }
}

function invalidParent(
  ownerId: string,
  parentId: string,
  expected: string,
  kind?: GraphNode["kind"],
): never {
  const subject = kind === undefined ? undefined : definitionSubject(kind, { id: ownerId });
  throw new GraphCompilationError(
    "invalid-parent",
    `${ownerId} must be owned by a ${expected}, received ${parentId}`,
    {
      ...(subject === undefined ? {} : { subject }),
      field: "parentId",
    },
  );
}

function unknownReference(
  kind: GraphNode["kind"],
  ownerId: string,
  reference: string,
  field: "dependsOn" | "parentId" | "supersedes",
): never {
  throw new GraphCompilationError(
    "unknown-reference",
    `${ownerId} references unknown definition ${reference}`,
    { subject: { kind, id: ownerId }, field },
  );
}

function assertNoCycles<Id extends string, DefinitionType extends Definition<Id>>(
  definitions: readonly DefinitionType[],
  references: (definition: DefinitionType) => Id | readonly Id[],
  code: "containment-cycle" | "dependency-cycle" | "supersession-cycle",
): void {
  const index = indexById(definitions);
  const visiting = new Set<Id>();
  const visited = new Set<Id>();

  const visit = (id: Id): void => {
    if (visiting.has(id)) {
      throw new GraphCompilationError(code, `${code} includes ${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    const definition = index.get(id);
    if (definition !== undefined) {
      const related = references(definition);
      const relatedIds = Array.isArray(related) ? related : [related];
      for (const relatedId of relatedIds) {
        if (index.has(relatedId as Id)) {
          visit(relatedId as Id);
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const definition of definitions) {
    visit(definition.id);
  }
}

function assertSupersession<
  Id extends string,
  DefinitionType extends Definition<Id> & {
    readonly parentId: string;
    readonly supersedes: readonly Id[];
  },
>(definitions: readonly DefinitionType[]): void {
  const index = indexById(definitions);
  for (const definition of definitions) {
    for (const supersededId of definition.supersedes) {
      const superseded = index.get(supersededId) as DefinitionType;
      if (definition.parentId !== superseded.parentId) {
        throw new GraphCompilationError(
          "invalid-supersession",
          `${definition.id} cannot supersede ${superseded.id} under a different parent`,
        );
      }
      if (definition.generation <= superseded.generation) {
        throw new GraphCompilationError(
          "invalid-supersession",
          `${definition.id} must have a newer generation than ${superseded.id}`,
        );
      }
    }
  }
}

function indexById<Id extends string, DefinitionType extends Definition<Id>>(
  definitions: readonly DefinitionType[],
): Map<Id, DefinitionType> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

function freezeNode<Kind extends GraphNode["kind"], DefinitionType extends Definition<string>>(
  kind: Kind,
  definition: DefinitionType,
): Extract<GraphNode, { readonly kind: Kind }> {
  return Object.freeze({ kind, definition }) as unknown as Extract<
    GraphNode,
    { readonly kind: Kind }
  >;
}

function createEdges(
  phases: readonly PhaseDefinition[],
  tasks: readonly TaskDefinition[],
  criteria: readonly CriterionDefinition[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const phase of phases) {
    edges.push(
      Object.freeze({ kind: "contains", from: phase.parentId, to: phase.id }) as ContainsEdge,
    );
    for (const dependency of phase.dependsOn) {
      edges.push(Object.freeze({ kind: "depends-on", from: phase.id, to: dependency }));
    }
    for (const superseded of phase.supersedes) {
      edges.push(Object.freeze({ kind: "supersedes", from: phase.id, to: superseded }));
    }
  }
  for (const task of tasks) {
    edges.push(Object.freeze({ kind: "contains", from: task.parentId, to: task.id }));
    for (const dependency of task.dependsOn) {
      edges.push(Object.freeze({ kind: "depends-on", from: task.id, to: dependency }));
    }
    for (const superseded of task.supersedes) {
      edges.push(Object.freeze({ kind: "supersedes", from: task.id, to: superseded }));
    }
  }
  for (const criterion of criteria) {
    edges.push(Object.freeze({ kind: "contains", from: criterion.parentId, to: criterion.id }));
    for (const superseded of criterion.supersedes) {
      edges.push(Object.freeze({ kind: "supersedes", from: criterion.id, to: superseded }));
    }
  }
  return edges;
}

function sortNodes(nodes: GraphNode[]): GraphNode[] {
  return nodes.sort((left, right) => compareText(left.definition.id, right.definition.id));
}

function sortEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.sort((left, right) =>
    compareText(
      `${left.kind}\u0000${left.from}\u0000${left.to}`,
      `${right.kind}\u0000${right.from}\u0000${right.to}`,
    ),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
