import { canonicalValue, type Sha256, sha256Digest } from "@senawa/kernel";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigurationCompilationError,
  type ConfigurationResourceReader,
  compileWorkflowAmendment,
  compileWorkflowConfiguration,
  createExampleWorkflowConfiguration,
  createExampleWorkflowResources,
  detectConfigurationDrift,
  doctorWorkflowAmendment,
  doctorWorkflowConfiguration,
  renderExampleWorkflowConfiguration,
  validateSchemaInstance,
  type WorkflowAmendmentDocument,
  type WorkflowConfigurationDocument,
} from "./index.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

describe("v1 workflow configuration", () => {
  it("embeds external prompt and schema bytes in an immutable snapshot", async () => {
    const snapshot = await compileFixture();

    expect(snapshot.apiVersion).toBe("senawa.dev/configuration-snapshot/v1");
    expect(snapshot.prompts).toEqual([
      expect.objectContaining({
        key: "builder",
        inputPaths: ["/request"],
        source: expect.objectContaining({
          path: "prompts/builder.md",
          utf8: "Build this request: ${{ input.request }}\n",
          byteLength: 41,
        }),
      }),
    ]);
    expect(snapshot.schemas).toEqual([
      expect.objectContaining({
        key: "work-input",
        source: expect.objectContaining({ path: "schemas/work-input.schema.json" }),
        schema: expect.objectContaining({ type: "object" }),
      }),
    ]);
    expect(snapshot.componentDigests.prompts).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(snapshot.prompts)).toBe(true);
  });

  it("loads resources in canonical kind and key order", async () => {
    const document = workflowFixture();
    document.prompts.unshift({ key: "alpha", path: "prompts/alpha.md", inputPaths: [] });
    document.schemas.unshift({ key: "alpha", path: "schemas/alpha.schema.json" });
    const resources = resourceFixture();
    resources["prompts/alpha.md"] = "Alpha\n";
    resources["schemas/alpha.schema.json"] = schemaText("urn:senawa:alpha");
    const read = vi.fn(resourceReader(resources).read);

    await compileWorkflowConfiguration(
      { document, locator: "fixture://order", resources: { read } },
      deterministicSha256,
    );

    expect(read.mock.calls.map(([request]) => `${request.kind}/${request.path}`)).toEqual([
      "prompt/prompts/alpha.md",
      "prompt/prompts/builder.md",
      "schema/schemas/alpha.schema.json",
      "schema/schemas/work-input.schema.json",
    ]);
  });

  it("accepts the prompt count bound and rejects one over before resource I/O", async () => {
    const atLimit = workflowFixture();
    atLimit.prompts = Array.from({ length: 64 }, (_, index) => ({
      key: `prompt-${index}`,
      path: `prompts/prompt-${index}.md`,
      inputPaths: [],
    }));
    atLimit.roles[0] = { ...atLimit.roles[0], prompt: "prompt-0" } as never;
    const resources = resourceFixture();
    for (const prompt of atLimit.prompts) resources[prompt.path] = "Prompt.\n";
    await expect(compileFixture(atLimit, resources)).resolves.toMatchObject({
      prompts: expect.arrayContaining([expect.objectContaining({ key: "prompt-63" })]),
    });

    const overLimit = workflowFixture();
    overLimit.prompts = [
      ...atLimit.prompts,
      {
        key: "prompt-over",
        path: "prompts/prompt-over.md",
        inputPaths: [],
      },
    ];
    const read = vi.fn(resourceReader(resources).read);
    const diagnosis = await doctorWorkflowConfiguration(
      { document: overLimit, locator: "fixture://count", resources: { read } },
      deterministicSha256,
    );
    expect(diagnosis.diagnostics).toEqual([
      expect.objectContaining({ code: "resource-set-too-large", pointer: "/prompts" }),
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects case-folded path aliases and aggregate resource overflow", async () => {
    const alias = workflowFixture();
    alias.prompts.push({ key: "alias", path: "prompts/BUILDER.md", inputPaths: [] });
    const aliasResult = await doctorWorkflowConfiguration(
      { document: alias, locator: "fixture://alias", resources: resourceReader(resourceFixture()) },
      deterministicSha256,
    );
    expect(aliasResult.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-resource-path", pointer: "/prompts/1/path" }),
    ]);

    const aggregate = workflowFixture();
    aggregate.schemas = Array.from({ length: 32 }, (_, index) => ({
      key: `schema-${index}`,
      path: `schemas/schema-${index}.schema.json`,
    }));
    aggregate.phases[0] = {
      ...aggregate.phases[0],
      input: { ...aggregate.phases[0]?.input, schema: "schema-0" },
      executor: {
        kind: "task-set",
        work: [
          {
            ...(aggregate.phases[0]?.executor.kind === "task-set"
              ? aggregate.phases[0].executor.work[0]
              : task("build")),
            inputSchema: "schema-0",
          },
        ],
      },
    } as never;
    const schema = schemaText("urn:senawa:aggregate");
    const padded = `${schema}${" ".repeat(256 * 1_024 - schema.length)}`;
    const aggregateResources = resourceFixture();
    for (const declaration of aggregate.schemas) aggregateResources[declaration.path] = padded;
    const aggregateResult = await doctorWorkflowConfiguration(
      {
        document: aggregate,
        locator: "fixture://aggregate",
        resources: resourceReader(aggregateResources),
      },
      deterministicSha256,
    );
    expect(aggregateResult.diagnostics).toEqual([
      expect.objectContaining({ code: "resource-set-too-large", pointer: "/schemas" }),
    ]);
  });

  it("refuses an unknown workflow version without reading resources", async () => {
    const document = workflowFixture() as unknown as Record<string, unknown>;
    document.apiVersion = "senawa.dev/workflow/v2";
    const read = vi.fn<ConfigurationResourceReader["read"]>();

    const result = await doctorWorkflowConfiguration(
      { document, locator: "fixture://future", resources: { read } },
      deterministicSha256,
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid-api-version",
        pointer: "/apiVersion",
      }),
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects role prompt authority widening and unknown prompt references", async () => {
    const document = workflowFixture();
    document.roles.push({
      key: "approver",
      kind: "authority",
      capabilities: ["approve"],
      prompt: "builder",
    } as never);
    document.roles[0] = { ...document.roles[0], prompt: "missing" } as never;

    const result = await doctorWorkflowConfiguration(
      { document, locator: "fixture://roles", resources: resourceReader(resourceFixture()) },
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "forbidden-role-prompt", pointer: "/roles/1/prompt" }),
        expect.objectContaining({
          code: "unknown-prompt-reference",
          pointer: "/roles/0/prompt",
        }),
      ]),
    );
  });

  it("diagnoses undeclared and stale prompt input paths", async () => {
    const document = workflowFixture();
    document.prompts[0] = { ...document.prompts[0], inputPaths: ["/unused"] } as never;

    const result = await doctorWorkflowConfiguration(
      {
        document,
        locator: "fixture://prompt-inputs",
        resources: resourceReader(resourceFixture()),
      },
      deterministicSha256,
    );

    expect(result.diagnostics.map(({ code, pointer }) => ({ code, pointer }))).toEqual([
      { code: "undeclared-prompt-input", pointer: "/prompts/0/inputPaths" },
      { code: "unused-prompt-input", pointer: "/prompts/0/inputPaths/0" },
    ]);
  });

  it("makes exact prompt and schema bytes drift while preserving semantic schema identity", async () => {
    const document = workflowFixture();
    const accepted = await compileFixture(document);
    const promptResources = resourceFixture();
    promptResources["prompts/builder.md"] += "Extra instruction.\n";
    const promptChanged = await compileFixture(document, promptResources);
    const schemaResources = resourceFixture();
    schemaResources["schemas/work-input.schema.json"] = `${JSON.stringify(
      JSON.parse(schemaResources["schemas/work-input.schema.json"] ?? "{}"),
      null,
      2,
    )}\n`;
    const schemaChanged = await compileFixture(document, schemaResources);

    expect(detectConfigurationDrift(accepted, promptChanged)).toMatchObject({
      changedCategories: ["prompts"],
      changedKeys: ["/prompts/builder"],
    });
    expect(detectConfigurationDrift(accepted, schemaChanged)).toMatchObject({
      changedCategories: ["schemas"],
      changedKeys: ["/schemas/work-input"],
    });
    expect(schemaChanged.schemas[0]?.schemaDigest).toBe(accepted.schemas[0]?.schemaDigest);
    expect(schemaChanged.schemas[0]?.source.contentDigest).not.toBe(
      accepted.schemas[0]?.source.contentDigest,
    );
  });

  it("revalidates historical bytes without resource I/O during amendment", async () => {
    const baseSnapshot = await compileFixture();
    const amendment = amendmentDocument(baseSnapshot.snapshotDigest);
    const compiled = compileWorkflowAmendment(
      {
        document: amendment,
        locator: "fixture://amendment",
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );
    const corrupted = JSON.parse(JSON.stringify(baseSnapshot)) as typeof baseSnapshot;
    (corrupted.prompts[0]?.source as { utf8: string }).utf8 += "changed";
    const diagnosis = doctorWorkflowAmendment(
      {
        document: amendment,
        locator: "fixture://amendment",
        baseSnapshot: corrupted,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );

    expect(compiled.resultSnapshot.prompts).toEqual(baseSnapshot.prompts);
    expect(compiled.resultSnapshot.schemas).toEqual(baseSnapshot.schemas);
    expect(diagnosis.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-document", pointer: "/baseSnapshotDigest" }),
    ]);
  });

  it("exports a compilable immutable v1 example tree", async () => {
    const example = createExampleWorkflowConfiguration();
    const resources = createExampleWorkflowResources();
    const snapshot = await compileWorkflowConfiguration(
      { document: example, locator: "fixture://example", resources: resourceReader(resources) },
      deterministicSha256,
    );

    expect(example.apiVersion).toBe("senawa.dev/workflow/v1");
    expect(snapshot.prompts.map(({ key }) => key)).toEqual(["worker"]);
    expect(snapshot.schemas.map(({ key }) => key)).toEqual(["work-input"]);
    expect(renderExampleWorkflowConfiguration().endsWith("\n")).toBe(true);
    expect(Object.isFrozen(example)).toBe(true);
    expect(Object.isFrozen(resources)).toBe(true);
  });

  it("lowers an agent executor to one visible reserved task and snapshots exact dataflow", async () => {
    const document = workflowFixture();
    const original = task("reserved-template");
    document.phases[0] = {
      ...phase("work"),
      executor: {
        kind: "agent",
        role: "builder",
        budgets: original.budgets,
        completionPolicy: original.completionPolicy,
        resumeAcrossAttempts: true,
      },
      outputs: [
        {
          key: "result",
          schema: "work-input",
          path: "result.json",
          maxBytes: 262_144,
          sensitivity: "internal",
        },
      ],
      iteration: {
        maximumAttempts: 3,
        onGateRejected: "iterate",
        onApprovalRejected: "iterate",
        onExhausted: "escalate",
      },
      exit: {
        requiredOutputs: ["result"],
        approval: { policy: "required", authority: { role: "release-manager" } },
      },
    } as never;

    const snapshot = await compileFixture(document);
    const taskNode = snapshot.graph.nodes.find((node) => node.kind === "task");

    expect(taskNode).toMatchObject({
      kind: "task",
      definition: {
        key: "phase-executor",
        // Every agent phase reserves the same key, so the key cannot tell two
        // pieces of work apart. The phase's own name can.
        title: "work",
        source: { pointer: "/phases/work/executor" },
      },
    });
    expect(snapshot.phaseDataflow).toEqual([
      expect.objectContaining({
        key: "work",
        value: expect.objectContaining({
          executor: expect.objectContaining({
            kind: "agent",
            reservedTaskKey: "phase-executor",
            resumeAcrossAttempts: true,
          }),
          outputs: [expect.objectContaining({ key: "result", schema: "work-input" })],
        }),
      }),
    ]);
  });

  it("snapshots exact task-frontier registries and rejects removed projectedWork", async () => {
    const document = workflowFixture();
    const templateTask = task("template");
    document.forEach = [
      {
        key: "plan-tasks",
        source: { kind: "phase-input", phase: "work" },
        pointer: "/tasks",
        collectionSchema: "work-input",
        itemSchema: "work-input",
        identityPointer: "/identity",
        limits: {
          maxSelectedItems: 256,
          maxTotalTasks: 1024,
          maxConcurrency: 32,
          exhaustion: "escalate",
        },
      },
    ];
    document.taskTemplates = [
      {
        key: "implementation",
        generation: 1,
        role: "builder",
        budgets: templateTask.budgets,
        inputSchema: "work-input",
        inputMappings: [
          {
            key: "item",
            source: { kind: "current-item", pointer: "" },
            destinationPointer: "",
          },
        ],
        dependencyIdentityPointer: "/dependsOn",
        repositoryChanges: "required",
        completionPolicy: templateTask.completionPolicy,
      },
    ];
    document.phases[0] = {
      ...phase("work"),
      executor: { kind: "task-frontier", forEach: "plan-tasks", template: "implementation" },
      actions: [{ kind: "import-plan", forEach: "plan-tasks" }],
    } as never;

    const snapshot = await compileFixture(document);
    expect(snapshot.forEach).toEqual([
      expect.objectContaining({
        key: "plan-tasks",
        value: expect.objectContaining({ pointer: "/tasks" }),
      }),
    ]);
    expect(snapshot.taskTemplates).toEqual([expect.objectContaining({ key: "implementation" })]);
    expect(snapshot.graph.nodes.filter(({ kind }) => kind === "task")).toEqual([]);

    const removed = { ...document, projectedWork: [] };
    const diagnosis = await doctorWorkflowConfiguration(
      {
        document: removed,
        locator: "fixture://removed",
        resources: resourceReader(resourceFixture()),
      },
      deterministicSha256,
    );
    expect(diagnosis.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unknown-field", pointer: "/projectedWork" }),
    );
  });

  it("rejects legacy phase work, mapping collisions, current-item, and implicit dependencies", async () => {
    const legacy = workflowFixture() as unknown as Record<string, unknown>;
    const legacyPhases = legacy.phases as Array<Record<string, unknown>>;
    const legacyPhase = legacyPhases[0] as Record<string, unknown>;
    legacyPhase.work = (legacyPhase.executor as { work: unknown }).work;
    delete legacyPhase.executor;
    expect(
      (
        await doctorWorkflowConfiguration(
          {
            document: legacy,
            locator: "fixture://legacy-phase",
            resources: resourceReader(resourceFixture()),
          },
          deterministicSha256,
        )
      ).diagnostics,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unknown-field" })]));

    const invalid = workflowFixture();
    invalid.phases.push({ ...phase("upstream"), executor: { kind: "task-set", work: [] } });
    invalid.phases[0] = {
      ...invalid.phases[0],
      input: {
        schema: "work-input",
        mappings: [
          {
            key: "first",
            source: { kind: "workflow-input", pointer: "/request" },
            destinationPointer: "/request",
          },
          {
            key: "second",
            source: { kind: "workflow-input", pointer: "" },
            destinationPointer: "/request/nested",
          },
          {
            key: "item",
            source: { kind: "current-item", pointer: "" },
            destinationPointer: "/item",
          },
          {
            key: "implicit",
            source: {
              kind: "phase-output",
              phase: "upstream",
              output: "result",
              pointer: "",
            },
            destinationPointer: "/upstream",
          },
        ],
      },
    } as never;
    const diagnosis = await doctorWorkflowConfiguration(
      {
        document: invalid,
        locator: "fixture://mappings",
        resources: resourceReader(resourceFixture()),
      },
      deterministicSha256,
    );
    expect(diagnosis.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mapping-destination-collision" })]),
    );

    for (const [source, code] of [
      [{ kind: "current-item", pointer: "" }, "current-item-not-allowed"],
      [
        { kind: "phase-output", phase: "upstream", output: "result", pointer: "" },
        "phase-dependency-violation",
      ],
    ] as const) {
      const document = workflowFixture();
      document.phases.push({
        ...phase("upstream"),
        executor: { kind: "task-set", work: [] },
      });
      document.phases[0] = {
        ...document.phases[0],
        input: {
          schema: "work-input",
          mappings: [{ key: "invalid", source, destinationPointer: "/value" }],
        },
      } as never;
      const result = await doctorWorkflowConfiguration(
        {
          document,
          locator: `fixture://${code}`,
          resources: resourceReader(resourceFixture()),
        },
        deterministicSha256,
      );
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
    }
  });

  it("throws the aggregate compilation error for invalid resource declarations", async () => {
    const document = workflowFixture();
    document.prompts[0] = { ...document.prompts[0], path: "../outside.md" } as never;
    await expect(
      compileWorkflowConfiguration(
        { document, locator: "fixture://invalid", resources: resourceReader(resourceFixture()) },
        deterministicSha256,
      ),
    ).rejects.toBeInstanceOf(ConfigurationCompilationError);
  });

  it("resolves only declared in-memory cross-schema references", async () => {
    const document = workflowFixture();
    document.schemas.push({ key: "shared", path: "schemas/shared.schema.json" });
    const resources = resourceFixture();
    resources["schemas/shared.schema.json"] = schemaText("urn:senawa:shared");
    resources["schemas/work-input.schema.json"] = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:work-input",
      $ref: "urn:senawa:shared",
    });
    await expect(compileFixture(document, resources)).resolves.toBeDefined();

    resources["schemas/work-input.schema.json"] = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:work-input",
      $ref: "file:///tmp/secret.schema.json",
    });
    await expect(compileFixture(document, resources)).rejects.toBeInstanceOf(
      ConfigurationCompilationError,
    );
  });

  it("rejects unsafe regexes and validates bounded concrete instances", async () => {
    const document = workflowFixture();
    const resources = resourceFixture();
    resources["schemas/work-input.schema.json"] = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:work-input",
      type: "string",
      pattern: "(a+)+$",
    });
    await expect(compileFixture(document, resources)).rejects.toBeInstanceOf(
      ConfigurationCompilationError,
    );

    const schema = JSON.parse(schemaText("urn:senawa:instance"));
    expect(validateSchemaInstance(canonicalValue(schema), { request: "build" })).toEqual([]);
    expect(validateSchemaInstance(canonicalValue(schema), { request: 42 })).toEqual([
      expect.objectContaining({ pointer: "/request" }),
    ]);
  });
});

async function compileFixture(document = workflowFixture(), resources = resourceFixture()) {
  return compileWorkflowConfiguration(
    { document, locator: "fixture://workflow.json", resources: resourceReader(resources) },
    deterministicSha256,
  );
}

function workflowFixture(): MutableWorkflowDocument {
  return {
    apiVersion: "senawa.dev/workflow/v1",
    kind: "Workflow",
    workflow: { key: "delivery", generation: 1, input: { schema: "work-input" } },
    prompts: [{ key: "builder", path: "prompts/builder.md", inputPaths: ["/request"] }],
    schemas: [{ key: "work-input", path: "schemas/work-input.schema.json" }],
    roles: [
      {
        key: "builder",
        kind: "agent",
        capabilities: ["execute-work"],
        prompt: "builder",
        modelPolicy: "standard",
      },
    ],
    modelPolicies: [
      {
        key: "standard",
        routes: [
          {
            provider: "openai",
            model: "gpt-5",
            maxTurns: 8,
            maxSubmissions: 3,
            maxMillidollars: 5_000,
          },
        ],
      },
    ],
    sensors: [],
    gates: [],
    completionEvidenceViews: [],
    forEach: [],
    taskTemplates: [],
    phases: [phase("work")],
  };
}

function phase(key: string) {
  return {
    key,
    generation: 1,
    dependsOn: [],
    input: {
      schema: "work-input",
      mappings: [
        {
          key: "workflow-input",
          source: { kind: "workflow-input" as const, pointer: "" },
          destinationPointer: "",
        },
      ],
    },
    executor: { kind: "task-set" as const, work: [task("build")] },
    outputs: [],
    iteration: {
      maximumAttempts: 1,
      onGateRejected: "fail" as const,
      onApprovalRejected: "fail" as const,
      onExhausted: "fail" as const,
    },
    exit: { requiredOutputs: [], approval: { policy: "none" as const } },
    actions: [] as const,
  };
}

function task(key: string) {
  return {
    key,
    generation: 1,
    role: "builder",
    budgets: [
      { unit: "work-attempt" as const, limit: 3 },
      { unit: "dispatch-failure" as const, limit: 2 },
      { unit: "sensor-retry" as const, limit: 2 },
      { unit: "review-iteration" as const, limit: 3 },
      { unit: "integration-attempt" as const, limit: 2 },
      { unit: "rebase-attempt" as const, limit: 2 },
    ],
    dependsOn: [],
    inputSchema: "work-input",
    input: { request: "compile" },
    completionPolicy: {
      criteria: [{ key: "complete", generation: 1, required: true, input: null }],
      completionEvidencePolicy: { mode: "none" as const, requirements: [] },
    },
  };
}

function amendmentDocument(snapshotDigest: string): WorkflowAmendmentDocument {
  return {
    apiVersion: "senawa.dev/workflow-amendment/v1",
    kind: "WorkflowAmendment",
    baseSnapshotDigest: sha256Digest(snapshotDigest),
    baseContextDigest: sha256Digest("c".repeat(64)),
    operations: [
      {
        kind: "add-phase",
        phase: {
          ...phase("verify"),
          dependsOn: ["work"],
          executor: { kind: "task-set", work: [] },
        },
      },
    ],
  };
}

function resourceFixture(): Record<string, string> {
  return {
    "prompts/builder.md": "Build this request: ${{ input.request }}\n",
    "schemas/work-input.schema.json": schemaText("urn:senawa:work-input"),
  };
}

function schemaText(id: string): string {
  return JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    type: "object",
    required: ["request"],
    properties: { request: { type: "string" } },
    additionalProperties: false,
  });
}

function resourceReader(resources: Readonly<Record<string, string>>): ConfigurationResourceReader {
  return {
    async read({ path, maxBytes }) {
      const text = resources[path];
      if (text === undefined) throw new Error("missing fixture resource");
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maxBytes) throw new Error("oversized fixture resource");
      return bytes;
    },
  };
}

type MutableWorkflowDocument = {
  -readonly [Key in keyof WorkflowConfigurationDocument]: WorkflowConfigurationDocument[Key] extends readonly (infer Item)[]
    ? Item[]
    : WorkflowConfigurationDocument[Key];
};
