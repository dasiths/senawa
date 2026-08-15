import type {
  AmendmentErrorCode,
  AmendmentProposal,
  BudgetUnit,
  CanonicalValue,
  ConsumerKey,
  DataflowErrorCode,
  GraphCompilationErrorCode,
  NormalizedAmendmentOperation,
  PhaseGenerationReference,
  Sha256Digest,
  WorkflowGraph,
} from "@senawa/kernel";

export const WORKFLOW_CONFIGURATION_API_VERSION = "senawa.dev/workflow/v1alpha3";
export const CONFIGURATION_SNAPSHOT_API_VERSION = "senawa.dev/configuration-snapshot/v1alpha3";
export const WORKFLOW_AMENDMENT_API_VERSION = "senawa.dev/workflow-amendment/v1alpha1";

export type WorkspaceMode = "repository" | "worktree";
export type FailurePolicy = "continue" | "fail-fast";
export type RemoteDisconnectedMode = "continue-authorized-local" | "pause-new-local-work";
export type RemoteSynchronizationClassification = "public" | "internal";

export interface ExecutionDeclaration {
  readonly workspaceMode?: WorkspaceMode;
  readonly maxWriterConcurrency?: number;
  readonly failurePolicy?: FailurePolicy;
  readonly integrationRef?: string;
}

export type ExecutionPolicy = Readonly<
  {
    readonly workspaceMode: WorkspaceMode;
    readonly maxWriterConcurrency: number;
    readonly failurePolicy: FailurePolicy;
  } & { readonly integrationRef?: string }
>;

export interface RemoteRoleMappingDeclaration {
  readonly issuer: string;
  readonly tenant: string;
  readonly upstreamRole: string;
  readonly localRoles: readonly string[];
}

export interface RemoteSynchronizationDeclaration {
  readonly classificationCeiling: RemoteSynchronizationClassification;
  readonly receiptChain: boolean;
  readonly events: boolean;
  readonly projections: boolean;
  readonly synchronizationState: boolean;
}

export interface RemotePolicyDeclaration {
  readonly disconnectedMode?: RemoteDisconnectedMode;
  readonly roleMappings: readonly RemoteRoleMappingDeclaration[];
  readonly maximumRemoteAuthorizationLeaseSeconds: number;
  readonly synchronization: RemoteSynchronizationDeclaration;
}

export interface RemotePolicy {
  readonly disconnectedMode: RemoteDisconnectedMode;
  readonly roleMappings: readonly RemoteRoleMappingDeclaration[];
  readonly maximumRemoteAuthorizationLeaseSeconds: number;
  readonly synchronization: RemoteSynchronizationDeclaration;
}

export interface WorkflowConfigurationDocument {
  readonly apiVersion: typeof WORKFLOW_CONFIGURATION_API_VERSION;
  readonly kind: "Workflow";
  readonly execution?: ExecutionDeclaration;
  readonly remote?: RemotePolicyDeclaration;
  readonly workflow: WorkflowDeclaration;
  readonly prompts: readonly PromptResourceDeclaration[];
  readonly schemas: readonly SchemaDeclaration[];
  readonly roles: readonly RoleDeclaration[];
  readonly modelPolicies: readonly ModelPolicyDeclaration[];
  readonly sensors: readonly SensorDeclaration[];
  readonly gates: readonly GateDeclaration[];
  readonly implementationEvidenceViews: readonly ImplementationEvidenceViewDeclaration[];
  readonly forEach: readonly ForEachDeclaration[];
  readonly taskTemplates: readonly TaskTemplateDeclaration[];
  readonly phases: readonly PhaseDeclaration[];
}

export interface WorkflowAmendmentDocument {
  readonly apiVersion: typeof WORKFLOW_AMENDMENT_API_VERSION;
  readonly kind: "WorkflowAmendment";
  readonly baseSnapshotDigest: Sha256Digest;
  readonly baseContextDigest: Sha256Digest;
  readonly operations: readonly WorkflowAmendmentOperationDeclaration[];
}

export type WorkflowAmendmentOperationDeclaration =
  | {
      readonly kind: "add-phase";
      readonly phase: Omit<PhaseDeclaration, "work">;
    }
  | {
      readonly kind: "add-task";
      readonly phase: string;
      readonly work: ExecutableWorkDeclaration;
    };

export interface WorkflowDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly input: WorkflowInputDeclaration;
}

export interface WorkflowInputDeclaration {
  readonly schema: string;
}

export interface PhaseDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly dependsOn?: readonly string[];
  readonly input: PhaseInputDeclaration;
  readonly executor: PhaseExecutorDeclaration;
  readonly outputs: readonly PhaseOutputDeclaration[];
  readonly iteration: PhaseIterationDeclaration;
  readonly exit: PhaseExitDeclaration;
  readonly actions: readonly PhaseActionDeclaration[];
}

export interface PhaseInputDeclaration {
  readonly schema: string;
  readonly mappings: readonly DataMappingDeclaration[];
}

export type MappingSourceDeclaration =
  | { readonly kind: "workflow-input"; readonly pointer: string }
  | {
      readonly kind: "phase-output";
      readonly phase: string;
      readonly output: string;
      readonly pointer: string;
    }
  | { readonly kind: "current-item"; readonly pointer: string }
  | {
      readonly kind: "implementation-evidence";
      readonly phase: string;
      readonly view: string;
      readonly pointer: string;
    };

export interface DataMappingDeclaration {
  readonly key: string;
  readonly source: MappingSourceDeclaration;
  readonly destinationPointer: string;
}

export type PhaseExecutorDeclaration =
  | AgentPhaseExecutorDeclaration
  | TaskSetPhaseExecutorDeclaration
  | TaskFrontierPhaseExecutorDeclaration;

export interface AgentPhaseExecutorDeclaration {
  readonly kind: "agent";
  readonly role: string;
  readonly budgets: readonly BudgetLimitDeclaration[];
  readonly completionPolicy: CompletionPolicyDeclaration;
  readonly resumeAcrossAttempts: boolean;
}

export interface TaskSetPhaseExecutorDeclaration {
  readonly kind: "task-set";
  readonly work: readonly ExecutableWorkDeclaration[];
}

export interface TaskFrontierPhaseExecutorDeclaration {
  readonly kind: "task-frontier";
  readonly forEach: string;
  readonly template: string;
}

export type ForEachSourceDeclaration =
  | { readonly kind: "phase-output"; readonly phase: string; readonly output: string }
  | { readonly kind: "phase-input"; readonly phase: string };

export interface ForEachDeclaration {
  readonly key: string;
  readonly source: ForEachSourceDeclaration;
  readonly pointer: string;
  readonly collectionSchema: string;
  readonly itemSchema: string;
  readonly identityPointer: string;
  readonly limits: Readonly<{
    readonly maxSelectedItems: number;
    readonly maxTotalTasks: number;
    readonly maxConcurrency: number;
    readonly exhaustion: "escalate" | "fail";
  }>;
}

export interface TaskTemplateDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly role: string;
  readonly budgets: readonly BudgetLimitDeclaration[];
  readonly inputSchema: string;
  readonly inputMappings: readonly DataMappingDeclaration[];
  readonly dependencyIdentityPointer?: string;
  readonly repositoryChanges: "required" | "allowed" | "forbidden";
  readonly completionPolicy: CompletionPolicyDeclaration;
}

export interface ImportPlanActionDeclaration {
  readonly kind: "import-plan";
  readonly forEach: string;
}

export type PhaseActionDeclaration = ImportPlanActionDeclaration;

export interface PhaseOutputDeclaration {
  readonly key: string;
  readonly schema: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly sensitivity: "public" | "internal" | "confidential" | "restricted";
}

export interface PhaseIterationDeclaration {
  readonly maximumAttempts: number;
  readonly onGateRejected: "iterate" | "fail";
  readonly onApprovalRejected: "iterate" | "fail";
  readonly onUpstreamChanged?: "iterate" | "fail";
  readonly onExhausted: "escalate" | "fail";
}

export type PhaseApprovalDeclaration =
  | { readonly policy: "none" }
  | { readonly policy: "required"; readonly authority: unknown };

export interface PhaseExitDeclaration {
  readonly requiredOutputs: readonly string[];
  readonly gate?: string;
  readonly approval: PhaseApprovalDeclaration;
}

export interface ImplementationEvidenceViewDeclaration {
  readonly key: string;
  readonly phase: string;
  readonly evidenceKinds: readonly unknown[];
  readonly sensitivityCeiling: "public" | "internal" | "confidential" | "restricted";
}

export interface ExecutableWorkDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly role: string;
  readonly budgets: readonly BudgetLimitDeclaration[];
  readonly dependsOn?: readonly string[];
  readonly inputSchema?: string;
  readonly input?: unknown;
  readonly completionPolicy: CompletionPolicyDeclaration;
}

export interface BudgetLimitDeclaration {
  readonly unit: BudgetUnit;
  readonly limit: number;
}

export interface SchemaDeclaration {
  readonly key: string;
  readonly path: string;
}

export interface PromptResourceDeclaration {
  readonly key: string;
  readonly path: string;
  readonly inputPaths: readonly string[];
}

export type RoleDeclaration =
  | {
      readonly key: string;
      readonly kind: "agent";
      readonly capabilities: readonly string[];
      readonly prompt: string;
      readonly modelPolicy: string;
    }
  | {
      readonly key: string;
      readonly kind: "human" | "authority";
      readonly capabilities: readonly string[];
    };

export interface ModelPolicyDeclaration {
  readonly key: string;
  readonly routes: readonly ModelRouteDeclaration[];
}

export interface ModelRouteDeclaration {
  readonly provider: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxSubmissions: number;
  readonly maxMillidollars: number;
}

export interface SensorDeclaration {
  readonly key: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly inheritedEnvironment: readonly string[];
  readonly maxAttempts: number;
  readonly maxReconciliationAttempts: number;
}

export interface GateDeclaration {
  readonly key: string;
  readonly phase: string;
  readonly blocking: readonly GateRuleDeclaration[];
  readonly advisory: readonly GateRuleDeclaration[];
}

export interface GateRuleDeclaration {
  readonly key: string;
  readonly condition: GateConditionDeclaration;
}

export type GateConditionDeclaration =
  | { readonly operator: "all" | "any"; readonly conditions: readonly GateConditionDeclaration[] }
  | { readonly operator: "not"; readonly condition: GateConditionDeclaration }
  | { readonly operator: "exists"; readonly accessor: GateReadingAccessorDeclaration }
  | {
      readonly operator:
        | "equals"
        | "not-equals"
        | "greater-than"
        | "greater-than-or-equal"
        | "less-than"
        | "less-than-or-equal";
      readonly accessor: GateReadingAccessorDeclaration;
      readonly expected: unknown;
    };

export interface GateReadingAccessorDeclaration {
  readonly sensorKey: string;
  readonly pointer: string;
}

export interface CompletionPolicyDeclaration {
  readonly criteria: readonly CriterionDeclaration[];
  readonly evidencePolicy: EvidencePolicyDeclaration;
}

export interface CriterionDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly required: boolean;
  readonly input?: unknown;
}

export interface EvidencePolicyDeclaration {
  readonly mode: "none" | "task" | "required-criteria" | "all-satisfied";
  readonly requirements: readonly EvidenceRequirementDeclaration[];
  readonly waiverAuthority?: unknown;
}

export interface EvidenceRequirementDeclaration {
  readonly kind: unknown;
  readonly minimumCount: number;
}

export type ConfigurationDiagnosticCode =
  | AmendmentErrorCode
  | DataflowErrorCode
  | GraphCompilationErrorCode
  | "authority-widening"
  | "duplicate-schema-id"
  | "duplicate-key"
  | "duplicate-json-member"
  | "forbidden-role-prompt"
  | "invalid-api-version"
  | "invalid-budget"
  | "invalid-canonical-value"
  | "invalid-document"
  | "invalid-field"
  | "invalid-gate"
  | "invalid-kind"
  | "invalid-locator"
  | "invalid-prompt-template"
  | "invalid-resource-path"
  | "invalid-resource-utf8"
  | "invalid-model-policy"
  | "invalid-role"
  | "invalid-schema"
  | "invalid-sensor"
  | "missing-field"
  | "missing-agent-prompt"
  | "missing-prompt-resources"
  | "missing-resource-path"
  | "network-schema-reference"
  | "resource-read-failed"
  | "resource-set-too-large"
  | "undeclared-prompt-input"
  | "unknown-prompt-reference"
  | "unsupported-workflow-version"
  | "unused-prompt-input"
  | "undefined-schema-reference"
  | "unknown-field"
  | "unknown-reference";

export interface ConfigurationDiagnostic {
  readonly code: ConfigurationDiagnosticCode;
  readonly locator: string;
  readonly pointer: string;
  readonly message: string;
}

export interface ConfigurationRegistryEntry {
  readonly key: ConsumerKey | string;
  readonly value: CanonicalValue;
  readonly digest: Sha256Digest;
}

export type ConfigurationResourceKind = "prompt" | "schema";

export interface ConfigurationResourceReadRequest {
  readonly kind: ConfigurationResourceKind;
  readonly path: string;
  readonly maxBytes: number;
}

export interface ConfigurationResourceReader {
  read(request: ConfigurationResourceReadRequest): Promise<Uint8Array>;
}

export type ConfigurationResourceReadErrorCode =
  | "not-found"
  | "path-escape"
  | "symlink"
  | "hardlink"
  | "not-regular-file"
  | "too-large"
  | "changed-during-read"
  | "permission-denied"
  | "read-failed";

export class ConfigurationResourceReadError extends Error {
  readonly code: ConfigurationResourceReadErrorCode;

  constructor(code: ConfigurationResourceReadErrorCode, message: string = code) {
    super(message);
    this.name = "ConfigurationResourceReadError";
    this.code = code;
  }
}

export interface WorkflowConfigurationCompilationInput {
  readonly document: unknown;
  readonly locator: string;
  readonly resources: ConfigurationResourceReader;
}

export interface ConfigurationTextResourceSource {
  readonly path: string;
  readonly mediaType: "text/markdown; charset=utf-8" | "application/schema+json; charset=utf-8";
  readonly byteLength: number;
  readonly contentDigest: Sha256Digest;
  readonly utf8: string;
}

export interface ConfigurationPromptResource {
  readonly key: ConsumerKey;
  readonly source: ConfigurationTextResourceSource;
  readonly inputPaths: readonly string[];
  readonly digest: Sha256Digest;
}

export interface ConfigurationSchemaResource {
  readonly key: ConsumerKey;
  readonly source: ConfigurationTextResourceSource;
  readonly schema: CanonicalValue;
  readonly schemaDigest: Sha256Digest;
  readonly digest: Sha256Digest;
}

export type ConfigurationComponentCategory =
  | "execution"
  | "remote"
  | "graph"
  | "prompts"
  | "schemas"
  | "roles"
  | "modelPolicies"
  | "sensors"
  | "gates"
  | "implementationEvidenceViews"
  | "phaseDataflow"
  | "forEach"
  | "taskTemplates";

export type ConfigurationComponentDigests = Readonly<
  Record<Exclude<ConfigurationComponentCategory, "remote">, Sha256Digest> & {
    readonly remote?: Sha256Digest;
  }
>;

export interface ConfigurationSnapshot {
  readonly apiVersion: typeof CONFIGURATION_SNAPSHOT_API_VERSION;
  readonly execution: ExecutionPolicy;
  readonly remote?: RemotePolicy;
  readonly graph: WorkflowGraph;
  readonly prompts: readonly ConfigurationPromptResource[];
  readonly schemas: readonly ConfigurationSchemaResource[];
  readonly roles: readonly ConfigurationRegistryEntry[];
  readonly modelPolicies: readonly ConfigurationRegistryEntry[];
  readonly sensors: readonly ConfigurationRegistryEntry[];
  readonly gates: readonly ConfigurationRegistryEntry[];
  readonly implementationEvidenceViews: readonly ConfigurationRegistryEntry[];
  readonly phaseDataflow: readonly ConfigurationRegistryEntry[];
  readonly forEach: readonly ConfigurationRegistryEntry[];
  readonly taskTemplates: readonly ConfigurationRegistryEntry[];
  readonly componentDigests: ConfigurationComponentDigests;
  readonly snapshotDigest: Sha256Digest;
}

export type ConfigurationDoctorResult =
  | {
      readonly diagnostics: readonly ConfigurationDiagnostic[];
      readonly snapshot: ConfigurationSnapshot;
    }
  | {
      readonly diagnostics: readonly ConfigurationDiagnostic[];
      readonly snapshot?: never;
    };

export interface ConfigurationAmendmentCompilation {
  readonly operations: readonly NormalizedAmendmentOperation[];
  readonly resultSnapshot: ConfigurationSnapshot;
  readonly proposal: AmendmentProposal;
}

export type ConfigurationAmendmentDoctorResult =
  | {
      readonly diagnostics: readonly ConfigurationDiagnostic[];
      readonly compilation: ConfigurationAmendmentCompilation;
    }
  | {
      readonly diagnostics: readonly ConfigurationDiagnostic[];
      readonly compilation?: never;
    };

export interface WorkflowAmendmentCompilationInput {
  readonly document: unknown;
  readonly locator: string;
  readonly baseSnapshot: ConfigurationSnapshot;
  readonly phaseCandidateHistory: readonly PhaseGenerationReference[];
}

export interface ConfigurationDrift {
  readonly hasDrift: boolean;
  readonly acceptedSnapshotDigest: Sha256Digest;
  readonly currentSnapshotDigest: Sha256Digest;
  readonly acceptedGraphRevision: Sha256Digest;
  readonly currentGraphRevision: Sha256Digest;
  readonly changedCategories: readonly ConfigurationComponentCategory[];
  readonly changedKeys: readonly string[];
}
