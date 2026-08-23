import {
  canonicalDigest,
  canonicalValue,
  consumerKey,
  contextId,
  createBudgetLedger,
  definitionGeneration,
  dispatchId,
  phaseId,
  type Sha256,
  sha256Digest,
  taskId,
} from "@senawa/kernel";
import { describe, expect, it } from "vitest";
import {
  InMemoryCanonicalJsonAssetStore,
  InMemoryRuntimeDataflowPersistence,
  RuntimeDataflowAuthority,
  type RuntimeSchemaContract,
  type RuntimeSchemaValidatorPort,
} from "./dataflow-authority.js";

const sha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const DIGEST = sha256Digest("1".repeat(64));
const OTHER_DIGEST = sha256Digest("2".repeat(64));

describe("runtime dataflow authority", () => {
  it("validates and single-assigns one canonical workflow input per run", () => {
    const fixture = authorityFixture();
    const request = workflowRequest({ request: "build" });
    const first = fixture.authority.bindWorkflowInput(request);
    const replay = fixture.authority.bindWorkflowInput(request);

    expect(replay).toEqual(first);
    expect(first.contentDigest).toBe(canonicalDigest(canonicalValue(request.value), sha256));
    expect(fixture.persistence.workflowInputs).toHaveLength(1);
    expect(() =>
      fixture.authority.bindWorkflowInput(workflowRequest({ request: "changed" })),
    ).toThrowError(expect.objectContaining({ code: "workflow-input-conflict" }));
    expect(() =>
      fixture.authority.bindWorkflowInput(workflowRequest({ request: 42 })),
    ).toThrowError(expect.objectContaining({ code: "schema-instance-invalid" }));
  });

  it("assembles, validates, and appends an exact attempt from accepted sources", () => {
    const fixture = authorityFixture();
    const started = fixture.authority.startPhaseAttempt({
      repositoryId: "repository_fixture",
      runId: "run_fixture",
      phase: {
        phaseId: phaseId("phase_plan"),
        definitionGeneration: definitionGeneration(1),
        attempt: 1,
      },
      graphRevisionDigest: DIGEST,
      configurationSnapshotDigest: OTHER_DIGEST,
      executorDigest: DIGEST,
      upstreamClosureSetDigest: OTHER_DIGEST,
      upstreamOutputSetDigest: DIGEST,
      schema: schemaContract("plan-input"),
      mappings: [
        {
          key: consumerKey("research"),
          source: {
            kind: "phase-output",
            phase: consumerKey("research"),
            output: consumerKey("result"),
            pointer: "/request",
          },
          destinationPointer: "/request",
        },
      ],
      sourceBindings: [
        {
          source: {
            kind: "phase-output",
            phase: consumerKey("research"),
            output: consumerKey("result"),
          },
          sourceBindingDigest: DIGEST,
          acceptanceDigest: OTHER_DIGEST,
          value: canonicalValue({ request: "plan" }),
        },
      ],
      mappingPolicy: {
        dependencyPhases: [consumerKey("research")],
        declaredPhaseOutputs: [{ phase: consumerKey("research"), output: consumerKey("result") }],
        completionEvidenceViews: [],
        allowCurrentItem: false,
      },
    });

    expect(started.value).toEqual({ request: "plan" });
    expect(started.attempt.inputBindingDigest).toBe(started.inputBinding.bindingDigest);
    expect(fixture.persistence.attempts).toHaveLength(1);
  });

  it("appends one bounded rejection transition and makes closure terminal", () => {
    const fixture = authorityFixture();
    const started = fixture.authority.startPhaseAttempt({
      repositoryId: "repository_fixture",
      runId: "run_fixture",
      phase: {
        phaseId: phaseId("phase_plan"),
        definitionGeneration: definitionGeneration(1),
        attempt: 1,
      },
      graphRevisionDigest: DIGEST,
      configurationSnapshotDigest: OTHER_DIGEST,
      executorDigest: DIGEST,
      upstreamClosureSetDigest: OTHER_DIGEST,
      upstreamOutputSetDigest: DIGEST,
      schema: schemaContract("plan-input"),
      mappings: [
        {
          key: consumerKey("request"),
          source: { kind: "workflow-input", pointer: "/request" },
          destinationPointer: "/request",
        },
      ],
      sourceBindings: [
        {
          source: { kind: "workflow-input" },
          sourceBindingDigest: DIGEST,
          value: canonicalValue({ request: "plan" }),
        },
      ],
      mappingPolicy: {
        dependencyPhases: [],
        declaredPhaseOutputs: [],
        completionEvidenceViews: [],
        allowCurrentItem: false,
      },
    });
    const policy = {
      maxAttempts: 2,
      upstreamChange: "refuse" as const,
      exhaustion: "fail" as const,
    };
    const ledger = createBudgetLedger({
      counters: [{ unit: "review-iteration", limit: 2, used: 0 }],
      appliedAllowanceDecisionDigests: [],
    });
    const iterated = fixture.authority.transitionPhaseAttempt({
      attempt: started.attempt,
      trigger: "approval-rejected",
      triggerDigest: DIGEST,
      policy,
      budgetLedger: ledger,
    });
    expect(iterated.transition).toMatchObject({
      disposition: "iterate",
      nextAttempt: { attempt: 2 },
    });
    expect(fixture.persistence.transitions).toHaveLength(1);

    const closedFixture = authorityFixture();
    const closed = closedFixture.authority.transitionPhaseAttempt({
      attempt: started.attempt,
      trigger: "closure-created",
      triggerDigest: OTHER_DIGEST,
      policy,
      budgetLedger: ledger,
    });
    expect(closed.transition.disposition).toBe("closed");
    expect(closed.transition.nextAttempt).toBeUndefined();
  });

  it("revalidates installed output content and single-assigns one attempt slot", () => {
    const fixture = authorityFixture();
    const value = canonicalValue({ request: "verified" });
    const asset = fixture.assets.install(value);
    const schema = schemaContract("verification-output");
    const validationReceiptDigest = receiptDigest("phase output", schema, value);
    const fact = {
      submissionId: "submission_output",
      repositoryId: "repository_fixture",
      runId: "run_fixture",
      dispatchId: dispatchId("dispatch_worker"),
      contextId: contextId("context_worker"),
      contextDigest: DIGEST,
      producingTask: {
        taskId: taskId("task_worker"),
        definitionGeneration: definitionGeneration(1),
        contextRevisionDigest: DIGEST,
      },
      output: {
        phase: {
          phaseId: phaseId("phase_verify"),
          definitionGeneration: definitionGeneration(1),
          attempt: 1,
        },
        outputName: "verification",
        schemaKey: schema.key,
        schemaResourceDigest: schema.schemaResourceDigest,
        contentDigest: asset.contentDigest,
        byteLength: asset.byteLength,
        mediaType: "application/json" as const,
        graphRevisionDigest: DIGEST,
        configurationSnapshotDigest: OTHER_DIGEST,
        inputBindingDigest: DIGEST,
        validationReceiptDigest,
      },
    };
    const publication = fixture.authority.publishPhaseOutput({ fact, schema });
    expect(fixture.authority.publishPhaseOutput({ fact, schema })).toEqual(publication);
    expect(fixture.persistence.publications).toHaveLength(1);

    const changed = fixture.assets.install(canonicalValue({ request: "changed" }));
    expect(() =>
      fixture.authority.publishPhaseOutput({
        fact: {
          ...fact,
          submissionId: "submission_changed",
          output: {
            ...fact.output,
            contentDigest: changed.contentDigest,
            byteLength: changed.byteLength,
            validationReceiptDigest: receiptDigest(
              "phase output",
              schema,
              canonicalValue({ request: "changed" }),
            ),
          },
        },
        schema,
      }),
    ).toThrowError(expect.objectContaining({ code: "output-slot-conflict" }));
  });
});

function authorityFixture() {
  const assets = new InMemoryCanonicalJsonAssetStore(sha256);
  const persistence = new InMemoryRuntimeDataflowPersistence(sha256);
  const validator: RuntimeSchemaValidatorPort = {
    validate(_contract, instance) {
      return typeof (instance as { readonly request?: unknown }).request === "string"
        ? []
        : [
            {
              instancePointer: "/request",
              schemaPointer: "/properties/request/type",
              keyword: "type",
            },
          ];
    },
  };
  return {
    assets,
    persistence,
    authority: new RuntimeDataflowAuthority(sha256, validator, assets, persistence),
  };
}

function schemaContract(key: string): RuntimeSchemaContract {
  return {
    key,
    schemaResourceDigest: DIGEST,
    validatorProfileDigest: OTHER_DIGEST,
    schema: canonicalValue({ type: "object" }),
    externalSchemas: [],
  };
}

function workflowRequest(value: unknown) {
  return {
    repositoryId: "repository_fixture",
    runId: "run_fixture",
    workflowId: "workflow_fixture",
    graphRevisionDigest: DIGEST,
    configurationSnapshotDigest: OTHER_DIGEST,
    schema: schemaContract("workflow-input"),
    value,
  };
}

function receiptDigest(
  boundary: string,
  schema: RuntimeSchemaContract,
  value: ReturnType<typeof canonicalValue>,
) {
  return canonicalDigest(
    canonicalValue({
      boundary,
      schemaKey: schema.key,
      schemaResourceDigest: schema.schemaResourceDigest,
      validatorProfileDigest: schema.validatorProfileDigest,
      contentDigest: canonicalDigest(value, sha256),
      findings: [],
    }),
    sha256,
  );
}
