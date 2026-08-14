import type {
  AmendmentErrorCode,
  AmendmentProposal,
  BudgetUnit,
  CanonicalValue,
  ConsumerKey,
  GraphCompilationErrorCode,
  NormalizedAmendmentOperation,
  PhaseGenerationReference,
  Sha256Digest,
  WorkflowGraph,
} from "@senawa/kernel";

export const WORKFLOW_CONFIGURATION_API_VERSION = "senawa.dev/workflow/v1alpha2";
export const CONFIGURATION_SNAPSHOT_API_VERSION = "senawa.dev/configuration-snapshot/v1alpha2";
export const WORKFLOW_AMENDMENT_API_VERSION = "senawa.dev/workflow-amendment/v1alpha1";

export type WorkspaceMode = "repository" | "worktree";
export type FailurePolicy = "continue" | "fail-fast";

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

export interface WorkflowConfigurationDocument {
  readonly apiVersion: typeof WORKFLOW_CONFIGURATION_API_VERSION;
  readonly kind: "Workflow";
  readonly execution?: ExecutionDeclaration;
  readonly workflow: WorkflowDeclaration;
  readonly schemas: readonly SchemaDeclaration[];
  readonly roles: readonly RoleDeclaration[];
  readonly modelPolicies: readonly ModelPolicyDeclaration[];
  readonly sensors: readonly SensorDeclaration[];
  readonly gates: readonly GateDeclaration[];
  readonly phases: readonly PhaseDeclaration[];
  readonly projectedWork: readonly ProjectedWorkDeclaration[];
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
  readonly input?: unknown;
}

export interface PhaseDeclaration {
  readonly key: string;
  readonly generation: number;
  readonly dependsOn?: readonly string[];
  readonly input?: unknown;
  readonly work: readonly ExecutableWorkDeclaration[];
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

export interface ProjectedWorkDeclaration {
  readonly phase: string;
  readonly work: ExecutableWorkDeclaration;
}

export interface SchemaDeclaration {
  readonly key: string;
  readonly schema: CanonicalValue;
}

export interface RoleDeclaration {
  readonly key: string;
  readonly kind: "agent" | "human" | "authority";
  readonly capabilities: readonly string[];
  readonly modelPolicy?: string;
}

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
  | GraphCompilationErrorCode
  | "authority-widening"
  | "duplicate-schema-id"
  | "duplicate-key"
  | "invalid-api-version"
  | "invalid-budget"
  | "invalid-canonical-value"
  | "invalid-document"
  | "invalid-field"
  | "invalid-gate"
  | "invalid-kind"
  | "invalid-locator"
  | "invalid-model-policy"
  | "invalid-role"
  | "invalid-schema"
  | "invalid-sensor"
  | "missing-field"
  | "network-schema-reference"
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

export type ConfigurationComponentCategory =
  | "execution"
  | "graph"
  | "schemas"
  | "roles"
  | "modelPolicies"
  | "sensors"
  | "gates"
  | "projections";

export type ConfigurationComponentDigests = Readonly<
  Record<ConfigurationComponentCategory, Sha256Digest>
>;

export interface ConfigurationSnapshot {
  readonly apiVersion: typeof CONFIGURATION_SNAPSHOT_API_VERSION;
  readonly execution: ExecutionPolicy;
  readonly graph: WorkflowGraph;
  readonly schemas: readonly ConfigurationRegistryEntry[];
  readonly roles: readonly ConfigurationRegistryEntry[];
  readonly modelPolicies: readonly ConfigurationRegistryEntry[];
  readonly sensors: readonly ConfigurationRegistryEntry[];
  readonly gates: readonly ConfigurationRegistryEntry[];
  readonly projections: readonly ConfigurationRegistryEntry[];
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
