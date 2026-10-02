import {
  CONFIGURATION_SNAPSHOT_API_VERSION,
  type ConfigurationSnapshot,
  validateSchemaInstance,
} from "@senawa/configuration";
import {
  type CanonicalValue,
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createAmendmentProposal,
  definitionGeneration,
  evaluateTaskFrontier,
  type FanOutEvaluation,
  type Sha256Digest,
  sha256Digest,
} from "@senawa/kernel";
import type { RuntimeDependencies } from "@senawa/runtime";
import { runtimeSchemaContract } from "./dataflow-composition.js";

interface Registry {
  readonly key: string;
  readonly digest: Sha256Digest;
  readonly value: unknown;
}

interface SnapshotForEach {
  readonly key: string;
  readonly pointer: string;
  readonly collectionSchema: string;
  readonly itemSchema: string;
  readonly identityPointer: string;
  readonly limits: {
    readonly maxSelectedItems: number;
    readonly maxTotalTasks: number;
    readonly maxConcurrency: number;
    readonly exhaustion: string;
  };
}

interface SnapshotTaskTemplate {
  readonly key: string;
  readonly generation: number;
  readonly inputSchema: string;
  readonly inputMappings: readonly unknown[];
  readonly dependencyIdentityPointer?: string;
  readonly completionPolicy: {
    readonly criteria: readonly unknown[];
    readonly completionEvidencePolicy: unknown;
  };
}

export interface FanOutPlanInput {
  readonly snapshot: ConfigurationSnapshot;
  readonly dependencies: RuntimeDependencies;
  readonly repositoryId: string;
  readonly runId: string;
  /** The fan-out phase, which supplies the `forEach` key and the task template. */
  readonly phaseKey: string;
  /** The accepted upstream output the collection is selected from. */
  readonly source: {
    readonly value: CanonicalValue;
    readonly acceptanceDigest: Sha256Digest;
  };
  readonly attemptDigest: Sha256Digest;
}

export interface FanOutPlan {
  readonly evaluation: FanOutEvaluation;
  readonly proposal: ReturnType<typeof createAmendmentProposal>;
  readonly resultSnapshot: ConfigurationSnapshot;
}

const PROBE_DIGEST: Sha256Digest = sha256Digest("0".repeat(64));

/**
 * Turns a computed collection into the member tasks a fan-out phase runs.
 *
 * The members are not in the compiled graph, because the collection is not known
 * until the phase before produces it. Adding them is an amendment by mechanism
 * rather than by meaning: the author declared the fan-out, and the diff
 * classifier refuses to enqueue anything that changed or removed a member
 * without a decision, so a first plan is the declared shape being filled in.
 */
export function planFanOut(input: FanOutPlanInput): FanOutPlan {
  const { snapshot, dependencies } = input;
  const sha256 = dependencies.sha256;
  const phase = requiredEntry(snapshot.phaseDataflow, input.phaseKey);
  const executor = (phase.value as { readonly executor: { readonly forEach?: string } }).executor;
  const forEachKey = executor.forEach;
  if (forEachKey === undefined) throw new Error(`Phase ${input.phaseKey} declares no fan-out`);

  const definition = requiredEntry(snapshot.forEach, forEachKey);
  const definitionValue = definition.value as unknown as SnapshotForEach;
  const templateEntry = requiredEntry(
    snapshot.taskTemplates,
    (phase.value as { readonly executor: { readonly template: string } }).executor.template,
  );
  const templateValue = templateEntry.value as unknown as SnapshotTaskTemplate;
  const phaseNode = snapshot.graph.nodes.find(
    (node) => node.kind === "phase" && String(node.definition.key) === input.phaseKey,
  );
  if (phaseNode === undefined || phaseNode.kind !== "phase") {
    throw new Error(`Workflow declares no phase ${input.phaseKey}`);
  }

  const collectionSchema = runtimeSchemaContract(
    snapshot,
    definitionValue.collectionSchema,
    sha256,
  );
  const itemSchema = runtimeSchemaContract(snapshot, definitionValue.itemSchema, sha256);
  const inputSchema = runtimeSchemaContract(snapshot, templateValue.inputSchema, sha256);
  const schemas = new Map(
    [collectionSchema, itemSchema, inputSchema].map((schema) => [
      schema.schemaResourceDigest,
      schema,
    ]),
  );

  const evaluation = evaluateTaskFrontier(
    {
      repositoryId: input.repositoryId,
      runId: input.runId,
      attemptDigest: input.attemptDigest,
      forEachKey: consumerKey(definitionValue.key),
      definitionDigest: definition.digest,
      sourceBindingDigest: input.source.acceptanceDigest,
      sourceValue: input.source.value,
      collectionPointer: definitionValue.pointer,
      collectionSchemaDigest: collectionSchema.schemaResourceDigest,
      itemSchemaDigest: itemSchema.schemaResourceDigest,
      identityPointer: definitionValue.identityPointer,
      template: {
        key: consumerKey(templateEntry.key),
        parentPhaseId: phaseNode.definition.id,
        generation: definitionGeneration(templateValue.generation),
        templateDigest: templateEntry.digest,
        inputSchemaDigest: inputSchema.schemaResourceDigest,
        inputMappings: templateValue.inputMappings as never,
        ...(templateValue.dependencyIdentityPointer === undefined
          ? {}
          : { dependencyIdentityPointer: templateValue.dependencyIdentityPointer }),
      },
      sourceBindings: [],
      mappingPolicy: {
        dependencyPhases: [],
        declaredPhaseOutputs: [],
        completionEvidenceViews: [],
        allowCurrentItem: true,
      },
      limits: definitionValue.limits as never,
      acceptedTotalTasks: 0,
      graphRevisionDigest: snapshot.graph.revisionDigest,
      configurationSnapshotDigest: snapshot.snapshotDigest,
    },
    {
      validate(digest, instance) {
        const schema = schemas.get(digest);
        if (schema === undefined) throw new Error("Fan-out named a schema the snapshot lacks");
        return validateSchemaInstance(
          schema.schema,
          instance,
          schema.externalSchemas.map(({ id, schema: external }) => ({ id, schema: external })),
        );
      },
    },
    sha256,
  );

  const operations = evaluation.members.map((member) => {
    // The template names criteria by authored key; a graph task references the
    // criterion node identities, so the nodes are built first.
    const criteria = (
      templateValue.completionPolicy.criteria as readonly {
        readonly key: string;
        readonly required: boolean;
      }[]
    ).map((criterion) => ({
      criterionId: `criterion_${member.identity}-${criterion.key}`,
      required: criterion.required,
      key: consumerKey(criterion.key),
    }));
    return {
      kind: "add-task" as const,
      task: {
        id: member.taskId,
        key: member.taskKey,
        generation: member.generation,
        parentId: phaseNode.definition.id,
        dependsOn: member.dependencyTaskIds,
        source: { locator: `senawa://fan-out/${member.memberDigest}`, pointer: "/task" },
        completionPolicy: {
          criteria: criteria.map(({ criterionId, required }) => ({ criterionId, required })),
          completionEvidencePolicy: templateValue.completionPolicy.completionEvidencePolicy,
        },
        input: { value: member.input, digest: member.inputDigest },
        supersedes: [],
      } as never,
      criteria: criteria.map((criterion) => ({
        id: criterion.criterionId,
        key: criterion.key,
        generation: definitionGeneration(1),
        parentId: member.taskId,
        source: {
          locator: `senawa://fan-out/${member.memberDigest}`,
          pointer: `/criteria/${String(criterion.key)}`,
        },
      })) as never,
    };
  });

  const proposalInput = {
    // The source kind is what lets the engine decide this without a person.
    source: {
      kind: "import-plan",
      evaluationDigest: evaluation.evaluationDigest,
      diffDigest: evaluation.taskSetDigest,
      acceptanceDigest: input.source.acceptanceDigest,
    },
    baseGraph: snapshot.graph,
    baseContextDigest: input.source.acceptanceDigest,
    baseConfigurationSnapshotDigest: snapshot.snapshotDigest,
    operations,
    phaseCandidateHistory: [],
  } as const;

  // A proposal binds its result snapshot to its result graph, and the result
  // graph only exists once the proposal is compiled, so the first one exists
  // only to produce the graph the snapshot is built from.
  const probe = createAmendmentProposal(
    { ...proposalInput, resultConfigurationSnapshotDigest: PROBE_DIGEST },
    sha256,
  );
  const resultSnapshot = snapshotWithGraph(snapshot, probe.reviewedResultGraph, sha256);
  const proposal = createAmendmentProposal(
    { ...proposalInput, resultConfigurationSnapshotDigest: resultSnapshot.snapshotDigest },
    sha256,
  );

  return { evaluation, proposal, resultSnapshot };
}

/**
 * The snapshot the amended graph belongs to.
 *
 * A proposal binds its base and result snapshots to its base and result graphs,
 * so applying one needs a snapshot whose graph is the amended one. Everything
 * else is unchanged, because an amendment adds nodes and nothing else.
 */
export function snapshotWithGraph(
  snapshot: ConfigurationSnapshot,
  graph: ConfigurationSnapshot["graph"],
  sha256: RuntimeDependencies["sha256"],
): ConfigurationSnapshot {
  const content = {
    apiVersion: CONFIGURATION_SNAPSHOT_API_VERSION,
    execution: snapshot.execution,
    graph,
    prompts: snapshot.prompts,
    schemas: snapshot.schemas,
    roles: snapshot.roles,
    modelPolicies: snapshot.modelPolicies,
    sensors: snapshot.sensors,
    gates: snapshot.gates,
    completionEvidenceViews: snapshot.completionEvidenceViews,
    phaseDataflow: snapshot.phaseDataflow,
    forEach: snapshot.forEach,
    taskTemplates: snapshot.taskTemplates,
    componentDigests: {
      ...snapshot.componentDigests,
      graph: canonicalDigest(canonicalValue(graph), sha256),
    },
  };
  return canonicalValue({
    ...content,
    snapshotDigest: canonicalDigest(canonicalValue(content), sha256),
  }) as unknown as ConfigurationSnapshot;
}

function requiredEntry(registry: readonly unknown[], key: string): Registry {
  const entry = (registry as readonly Registry[]).find((candidate) => candidate.key === key);
  if (entry === undefined) throw new Error(`Workflow declares no ${key}`);
  return entry;
}
