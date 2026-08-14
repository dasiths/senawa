import { type Sha256, sha256Digest } from "@senawa/kernel";
import { describe, expect, it } from "vitest";
import {
  ConfigurationCompilationError,
  compileWorkflowAmendment,
  compileWorkflowConfiguration,
  createExampleWorkflowConfiguration,
  detectConfigurationDrift,
  doctorWorkflowAmendment,
  doctorWorkflowConfiguration,
  renderExampleWorkflowConfiguration,
  type WorkflowAmendmentDocument,
  type WorkflowConfigurationDocument,
} from "./index.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) {
      accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    }
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

describe("workflow configuration compilation", () => {
  it("creates a recursively immutable bounded sensor and gate example that compiles", () => {
    const example = createExampleWorkflowConfiguration();
    const snapshot = compileWorkflowConfiguration(
      example,
      "fixture://example",
      deterministicSha256,
    );

    expect(example.apiVersion).toBe("senawa.dev/workflow/v1alpha2");
    expect(example.sensors).toEqual([
      {
        key: "diff-check",
        argv: ["git", "diff", "--check"],
        cwd: ".",
        timeoutMs: 30_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        inheritedEnvironment: ["PATH"],
        maxAttempts: 3,
        maxReconciliationAttempts: 2,
      },
    ]);
    expect(example.gates).toEqual([
      {
        key: "clean-diff",
        phase: "work",
        blocking: [
          {
            key: "exit-code-zero",
            condition: {
              operator: "equals",
              accessor: { sensorKey: "diff-check", pointer: "/exitCode" },
              expected: 0,
            },
          },
        ],
        advisory: [],
      },
    ]);
    expect(snapshot.sensors.map(({ key }) => key)).toEqual(["diff-check"]);
    expect(snapshot.gates.map(({ key }) => key)).toEqual(["clean-diff"]);
    expect(Object.isFrozen(example)).toBe(true);
    expect(Object.isFrozen(example.phases)).toBe(true);
    expect(Object.isFrozen(example.sensors[0]?.argv)).toBe(true);
    expect(Object.isFrozen(example.gates[0]?.blocking[0]?.condition)).toBe(true);
    expect(Object.isFrozen(example.phases[0]?.work[0]?.completionPolicy)).toBe(true);
    const rendered = renderExampleWorkflowConfiguration();
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(example);
  });

  it.each([
    ["software delivery", softwareFixture()],
    ["incident response", incidentFixture()],
  ])("compiles a sensor-free %s document", (_name, document) => {
    const snapshot = compileWorkflowConfiguration(
      document,
      "fixture://workflow.json",
      deterministicSha256,
    );

    expect(snapshot.graph.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining(["workflow", "phase", "task", "criterion"]),
    );
    expect(snapshot.graph.nodes.every((node) => node.definition.id.includes("_"))).toBe(true);
    expect(snapshot.schemas).toEqual([]);
    expect(snapshot.roles.map(({ key }) => key)).toEqual(["builder"]);
    expect(snapshot.modelPolicies.map(({ key }) => key)).toEqual(["standard"]);
    expect(snapshot.sensors).toEqual([]);
    expect(snapshot.gates).toEqual([]);
    expect(snapshot.execution).toEqual({
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: "continue",
    });
    expect(snapshot.projections).toEqual([]);
    expect(snapshot.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.graph.nodes)).toBe(true);
    expect(Object.isFrozen(snapshot.componentDigests)).toBe(true);
  });

  it("normalizes declaration and property ordering exactly", () => {
    const first = softwareFixture();
    const second = reorderedSoftwareFixture();

    const firstSnapshot = compileWorkflowConfiguration(
      first,
      "fixture://same",
      deterministicSha256,
    );
    const secondSnapshot = compileWorkflowConfiguration(
      second,
      "fixture://same",
      deterministicSha256,
    );

    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSnapshot.componentDigests).toEqual(firstSnapshot.componentDigests);
    expect(secondSnapshot.snapshotDigest).toBe(firstSnapshot.snapshotDigest);
  });

  it("normalizes execution defaults and explicit worktree opt-in", () => {
    const repository = compileWorkflowConfiguration(
      softwareFixture(),
      "fixture://repository-execution",
      deterministicSha256,
    );
    const worktreeDocument = softwareFixture();
    worktreeDocument.execution = {
      workspaceMode: "worktree",
      maxWriterConcurrency: 4,
      failurePolicy: "fail-fast",
      integrationRef: "refs/heads/senawa/integration",
    };
    const worktree = compileWorkflowConfiguration(
      worktreeDocument,
      "fixture://worktree-execution",
      deterministicSha256,
    );

    expect(repository.execution).toEqual({
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: "continue",
    });
    expect(worktree.execution).toEqual(worktreeDocument.execution);
    expect(worktree.componentDigests.execution).not.toBe(repository.componentDigests.execution);
  });

  it.each([
    [{ workspaceMode: "parallel" }, "/execution/workspaceMode"],
    [{ workspaceMode: "repository", maxWriterConcurrency: 2 }, "/execution/maxWriterConcurrency"],
    [
      { workspaceMode: "repository", integrationRef: "refs/heads/integration" },
      "/execution/integrationRef",
    ],
    [{ workspaceMode: "worktree" }, "/execution/integrationRef"],
    [{ workspaceMode: "worktree", integrationRef: "main" }, "/execution/integrationRef"],
    [{ maxWriterConcurrency: 0 }, "/execution/maxWriterConcurrency"],
    [{ maxWriterConcurrency: 1.5 }, "/execution/maxWriterConcurrency"],
    [{ failurePolicy: "stop" }, "/execution/failurePolicy"],
  ])("rejects invalid execution policy %#", (execution, pointer) => {
    const document = softwareFixture();
    document.execution = execution as NonNullable<WorkflowConfigurationDocument["execution"]>;
    const diagnosis = doctorWorkflowConfiguration(
      document,
      "fixture://invalid-execution",
      deterministicSha256,
    );

    expect(diagnosis.snapshot).toBeUndefined();
    expect(diagnosis.diagnostics).toContainEqual(expect.objectContaining({ pointer }));
  });

  it("preserves local-only snapshot shape when remote policy is absent", () => {
    const snapshot = compileWorkflowConfiguration(
      softwareFixture(),
      "fixture://local-only",
      deterministicSha256,
    );

    expect(snapshot).not.toHaveProperty("remote");
    expect(snapshot.componentDigests).not.toHaveProperty("remote");
  });

  it("normalizes the disconnected default and binds the exact remote policy snapshot", () => {
    const defaultDocument = softwareFixture();
    defaultDocument.remote = remotePolicyFixture();
    const explicitDocument = softwareFixture();
    explicitDocument.remote = {
      ...remotePolicyFixture(),
      disconnectedMode: "continue-authorized-local",
    };

    const defaultSnapshot = compileWorkflowConfiguration(
      defaultDocument,
      "fixture://remote-default",
      deterministicSha256,
    );
    const explicitSnapshot = compileWorkflowConfiguration(
      explicitDocument,
      "fixture://remote-default",
      deterministicSha256,
    );

    expect(defaultSnapshot).toEqual(explicitSnapshot);
    expect(defaultSnapshot.remote).toEqual({
      disconnectedMode: "continue-authorized-local",
      roleMappings: [
        {
          issuer: "https://identity.example.test",
          tenant: "tenant-a",
          upstreamRole: "operator",
          localRoles: ["builder"],
        },
      ],
      maximumRemoteAuthorizationLeaseSeconds: 900,
      synchronization: {
        classificationCeiling: "public",
        receiptChain: false,
        events: false,
        projections: false,
        synchronizationState: false,
      },
    });
    expect(defaultSnapshot.componentDigests.remote).toBe(
      "3244e2a93244e2a93244e2a93244e2a93244e2a93244e2a93244e2a93244e2a9",
    );
    expect(defaultSnapshot.snapshotDigest).toBe(
      "eff6a5f3eff6a5f3eff6a5f3eff6a5f3eff6a5f3eff6a5f3eff6a5f3eff6a5f3",
    );
  });

  it("accepts explicit pause mode and public/internal metadata synchronization only", () => {
    const document = softwareFixture();
    document.remote = {
      ...remotePolicyFixture(),
      disconnectedMode: "pause-new-local-work",
      synchronization: {
        classificationCeiling: "internal",
        receiptChain: true,
        events: true,
        projections: true,
        synchronizationState: true,
      },
    };

    const snapshot = compileWorkflowConfiguration(
      document,
      "fixture://remote-pause",
      deterministicSha256,
    );

    expect(snapshot.remote?.disconnectedMode).toBe("pause-new-local-work");
    expect(snapshot.remote?.synchronization).toEqual(document.remote.synchronization);
  });

  it.each([
    "endpoint",
    "tenantCredentials",
    "privateKeyPath",
    "retryTiming",
    "localConnectorLeaseSeconds",
  ])("rejects operational remote field %s from canonical configuration", (field) => {
    const document = softwareFixture();
    document.remote = remotePolicyFixture();
    (document.remote as unknown as Record<string, unknown>)[field] = "forbidden";

    const diagnosis = doctorWorkflowConfiguration(
      document,
      "fixture://remote-operational-field",
      deterministicSha256,
    );

    expect(diagnosis.diagnostics).toEqual([
      {
        code: "unknown-field",
        locator: "fixture://remote-operational-field",
        pointer: `/remote/${field}`,
        message: `Unknown field ${field}`,
      },
    ]);
  });

  it.each([
    ["roleMappings", "/remote/roleMappings"],
    ["maximumRemoteAuthorizationLeaseSeconds", "/remote/maximumRemoteAuthorizationLeaseSeconds"],
    ["synchronization", "/remote/synchronization"],
  ])("reports one exact missing remote field for %s", (field, pointer) => {
    const document = softwareFixture();
    const remote = remotePolicyFixture() as unknown as Record<string, unknown>;
    delete remote[field];
    document.remote = remote as unknown as NonNullable<WorkflowConfigurationDocument["remote"]>;

    const diagnosis = doctorWorkflowConfiguration(
      document,
      "fixture://remote-missing",
      deterministicSha256,
    );

    expect(diagnosis.diagnostics).toEqual([
      {
        code: "missing-field",
        locator: "fixture://remote-missing",
        pointer,
        message: `Missing required field ${field}`,
      },
    ]);
  });

  it.each([
    "classificationCeiling",
    "receiptChain",
    "events",
    "projections",
    "synchronizationState",
  ])("reports one exact missing synchronization field for %s", (field) => {
    const document = softwareFixture();
    const remote = remotePolicyFixture();
    const synchronization = {
      ...remote.synchronization,
    } as unknown as Record<string, unknown>;
    delete synchronization[field];
    document.remote = {
      ...remote,
      synchronization,
    } as unknown as NonNullable<WorkflowConfigurationDocument["remote"]>;

    const diagnosis = doctorWorkflowConfiguration(
      document,
      "fixture://remote-sync-missing",
      deterministicSha256,
    );

    expect(diagnosis.diagnostics).toEqual([
      {
        code: "missing-field",
        locator: "fixture://remote-sync-missing",
        pointer: `/remote/synchronization/${field}`,
        message: `Missing required field ${field}`,
      },
    ]);
  });

  it("aggregates malformed remote policy values in source order", () => {
    const document = softwareFixture();
    document.remote = {
      ...remotePolicyFixture(),
      disconnectedMode: "hold" as "continue-authorized-local",
      maximumRemoteAuthorizationLeaseSeconds: 0,
      synchronization: {
        classificationCeiling: "confidential" as "public",
        receiptChain: "yes" as unknown as boolean,
        events: false,
        projections: false,
        synchronizationState: false,
      },
    };

    const diagnosis = doctorWorkflowConfiguration(
      document,
      "fixture://remote-malformed",
      deterministicSha256,
    );

    expect(diagnosis.diagnostics.map(({ code, pointer }) => ({ code, pointer }))).toEqual([
      { code: "invalid-field", pointer: "/remote/disconnectedMode" },
      { code: "invalid-field", pointer: "/remote/maximumRemoteAuthorizationLeaseSeconds" },
      { code: "invalid-field", pointer: "/remote/synchronization/classificationCeiling" },
      { code: "invalid-field", pointer: "/remote/synchronization/receiptChain" },
    ]);
  });

  it("rejects confidential and restricted synchronization ceilings", () => {
    for (const classificationCeiling of ["confidential", "restricted"]) {
      const document = softwareFixture();
      document.remote = {
        ...remotePolicyFixture(),
        synchronization: {
          ...remotePolicyFixture().synchronization,
          classificationCeiling: classificationCeiling as "public",
        },
      };

      expect(
        doctorWorkflowConfiguration(
          document,
          `fixture://remote-${classificationCeiling}`,
          deterministicSha256,
        ).diagnostics,
      ).toEqual([
        expect.objectContaining({
          code: "invalid-field",
          pointer: "/remote/synchronization/classificationCeiling",
        }),
      ]);
    }
  });

  it("requires synchronization state for every enabled metadata stream", () => {
    const document = softwareFixture();
    document.remote = {
      ...remotePolicyFixture(),
      synchronization: {
        ...remotePolicyFixture().synchronization,
        events: true,
      },
    };

    expect(
      doctorWorkflowConfiguration(document, "fixture://remote-staleness", deterministicSha256)
        .diagnostics,
    ).toEqual([
      expect.objectContaining({
        code: "invalid-field",
        pointer: "/remote/synchronization/synchronizationState",
      }),
    ]);
  });

  it("reports duplicate mapping inputs and duplicate local role outputs exactly", () => {
    const document = softwareFixture();
    const mapping = remotePolicyFixture().roleMappings[0];
    if (mapping === undefined) throw new Error("Expected remote role mapping fixture");
    document.remote = {
      ...remotePolicyFixture(),
      roleMappings: [
        { ...mapping, localRoles: ["builder", "builder"] },
        { ...mapping, localRoles: ["builder"] },
      ],
    };

    const diagnosis = doctorWorkflowConfiguration(
      document,
      "fixture://remote-duplicates",
      deterministicSha256,
    );

    expect(diagnosis.diagnostics.map(({ code, pointer }) => ({ code, pointer }))).toEqual([
      { code: "duplicate-key", pointer: "/remote/roleMappings/0/localRoles/1" },
      { code: "duplicate-key", pointer: "/remote/roleMappings/1/upstreamRole" },
    ]);
  });

  it("resolves every mapped local role at its source address", () => {
    const document = softwareFixture();
    const mapping = remotePolicyFixture().roleMappings[0];
    if (mapping === undefined) throw new Error("Expected remote role mapping fixture");
    document.remote = {
      ...remotePolicyFixture(),
      roleMappings: [{ ...mapping, localRoles: ["missing-role"] }],
    };

    expect(
      doctorWorkflowConfiguration(document, "fixture://remote-role-reference", deterministicSha256)
        .diagnostics,
    ).toEqual([
      expect.objectContaining({
        code: "unknown-reference",
        pointer: "/remote/roleMappings/0/localRoles/0",
      }),
    ]);
  });

  it("normalizes remote mapping and local-role declaration ordering exactly", () => {
    const first = softwareFixture();
    first.roles = [
      ...first.roles,
      { key: "reviewer", kind: "authority", capabilities: ["review"] },
    ];
    first.remote = {
      ...remotePolicyFixture(),
      roleMappings: [
        {
          issuer: "https://identity.example.test",
          tenant: "tenant-a",
          upstreamRole: "reviewer",
          localRoles: ["reviewer", "builder"],
        },
        ...remotePolicyFixture().roleMappings,
      ],
    };
    const second = softwareFixture();
    second.roles = [...first.roles].reverse();
    second.remote = {
      ...first.remote,
      roleMappings: [...first.remote.roleMappings]
        .reverse()
        .map((mapping) => ({ ...mapping, localRoles: [...mapping.localRoles].reverse() })),
    };

    const firstSnapshot = compileWorkflowConfiguration(
      first,
      "fixture://remote-order",
      deterministicSha256,
    );
    const secondSnapshot = compileWorkflowConfiguration(
      second,
      "fixture://remote-order",
      deterministicSha256,
    );

    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSnapshot.remote?.roleMappings[1]?.localRoles).toEqual(["builder", "reviewer"]);
  });

  it("binds every remote authority and disclosure policy field into snapshot digests", () => {
    const baselineDocument = softwareFixture();
    baselineDocument.remote = remotePolicyFixture();
    const baseline = compileWorkflowConfiguration(
      baselineDocument,
      "fixture://remote-digest",
      deterministicSha256,
    );
    const variants = [
      { ...remotePolicyFixture(), disconnectedMode: "pause-new-local-work" as const },
      { ...remotePolicyFixture(), maximumRemoteAuthorizationLeaseSeconds: 901 },
      {
        ...remotePolicyFixture(),
        synchronization: {
          ...remotePolicyFixture().synchronization,
          classificationCeiling: "internal" as const,
        },
      },
      {
        ...remotePolicyFixture(),
        synchronization: {
          ...remotePolicyFixture().synchronization,
          receiptChain: true,
          synchronizationState: true,
        },
      },
    ];

    for (const remote of variants) {
      const document = softwareFixture();
      document.remote = remote;
      const snapshot = compileWorkflowConfiguration(
        document,
        "fixture://remote-digest",
        deterministicSha256,
      );
      expect(snapshot.componentDigests.remote).not.toBe(baseline.componentDigests.remote);
      expect(snapshot.snapshotDigest).not.toBe(baseline.snapshotDigest);
    }
  });

  it("derives branded identities from raw qualified consumer paths", () => {
    const snapshot = compileWorkflowConfiguration(
      softwareFixture(),
      "fixture://identities",
      deterministicSha256,
    );
    const workflowDigest = deterministicSha256.digest(
      new TextEncoder().encode("workflow/delivery"),
    );
    const taskDigest = deterministicSha256.digest(
      new TextEncoder().encode("workflow/delivery/phases/build/work/compile"),
    );

    expect(snapshot.graph.workflowId).toBe(`workflow_${workflowDigest}`);
    expect(
      snapshot.graph.nodes.find(
        (node) => node.definition.source.pointer === "/phases/build/work/compile",
      )?.definition.id,
    ).toBe(`task_${taskDigest}`);
  });

  it("isolates the snapshot from caller mutation", () => {
    const document = softwareFixture();
    const snapshot = compileWorkflowConfiguration(
      document,
      "fixture://mutable",
      deterministicSha256,
    );

    document.workflow.input = { product: "changed" };
    document.phases[0]?.work.reverse();
    const firstWork = document.phases[0]?.work[0];
    if (firstWork !== undefined) {
      firstWork.input = { changed: true };
    }

    expect(snapshot).toEqual(
      compileWorkflowConfiguration(softwareFixture(), "fixture://mutable", deterministicSha256),
    );
  });

  it("reports an undefined work reference at its source address", () => {
    const document = softwareFixture();
    document.phases[1]?.work[0]?.dependsOn.push("build/missing");

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://undefined",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "unknown-reference",
        locator: "fixture://undefined",
        pointer: "/phases/release/work/publish/dependsOn",
      }),
    ]);
  });

  it("collects independent boundary errors and sorts them", () => {
    const document = softwareFixture() as unknown as Record<string, unknown>;
    document.authority = true;
    document.kind = "Job";
    document.workflow = { key: "Bad Key", generation: 0, extra: true };

    const result = doctorWorkflowConfiguration(document, "fixture://invalid", deterministicSha256);

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics.map(({ code, pointer }) => ({ code, pointer }))).toEqual([
      { code: "unknown-field", pointer: "/authority" },
      { code: "invalid-kind", pointer: "/kind" },
      { code: "unknown-field", pointer: "/workflow/extra" },
      { code: "invalid-generation", pointer: "/workflow/generation" },
      { code: "invalid-key", pointer: "/workflow/key" },
    ]);
    expect(() =>
      compileWorkflowConfiguration(document, "fixture://invalid", deterministicSha256),
    ).toThrow(ConfigurationCompilationError);
  });

  it("reports an invalid external locator without generated source cascades", () => {
    const result = doctorWorkflowConfiguration(softwareFixture(), "", deterministicSha256);

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        code: "invalid-locator",
        locator: "",
        pointer: "",
        message: "Source locator must be a non-empty string",
      },
    ]);
  });

  it("aggregates semantic references with independent structural diagnostics", () => {
    const document = softwareFixture();
    (document as unknown as Record<string, unknown>).authority = true;
    document.phases[0]?.dependsOn.push("missing");
    document.phases[1]?.work[0]?.dependsOn.push("missing/work");

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://aggregate",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics.map(({ code, pointer }) => ({ code, pointer }))).toEqual([
      { code: "unknown-field", pointer: "/authority" },
      { code: "unknown-reference", pointer: "/phases/build/dependsOn" },
      { code: "unknown-reference", pointer: "/phases/release/work/publish/dependsOn" },
    ]);
  });

  it("surfaces kernel dependency cycles as source-addressed diagnostics", () => {
    const document = softwareFixture();
    document.phases[0]?.dependsOn.push("release");

    const result = doctorWorkflowConfiguration(document, "fixture://cycle", deterministicSha256);

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "dependency-cycle",
      locator: "fixture://cycle",
    });
    expect(result.diagnostics[0]?.pointer).toMatch(/^\/phases\/(build|release)\/dependsOn$/);
  });

  it("reports disjoint phase cycles as two stable source-addressed diagnostics", () => {
    const document = softwareFixture();
    document.phases[0]?.dependsOn.push("release");
    document.phases.push(
      { key: "audit", generation: 1, dependsOn: ["notify"], work: [] },
      { key: "notify", generation: 1, dependsOn: ["audit"], work: [] },
    );

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://two-cycles",
      deterministicSha256,
    );

    expect(result.diagnostics.map(({ code, pointer }) => ({ code, pointer }))).toEqual([
      { code: "dependency-cycle", pointer: "/phases/notify/dependsOn" },
      { code: "dependency-cycle", pointer: "/phases/release/dependsOn" },
    ]);
  });

  it("points invalid none-mode requirements to the owning evidence policy", () => {
    const document = softwareFixture();
    const evidencePolicy = document.phases[0]?.work[0]?.completionPolicy.evidencePolicy;
    if (evidencePolicy !== undefined) {
      (evidencePolicy.requirements as unknown[]).push({ kind: "build-log", minimumCount: 1 });
    }

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://completion-policy",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid-completion-policy",
        pointer: "/phases/build/work/compile/completionPolicy/evidencePolicy",
      }),
    ]);
  });

  it("points duplicate evidence kinds to the owning evidence policy", () => {
    const document = softwareFixture();
    const evidencePolicy = document.phases[0]?.work[0]?.completionPolicy.evidencePolicy;
    if (evidencePolicy === undefined) throw new Error("Expected evidence policy fixture");
    evidencePolicy.mode = "task";
    (evidencePolicy.requirements as unknown[]).push(
      { kind: "build-log", minimumCount: 1 },
      { kind: "build-log", minimumCount: 2 },
    );

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://duplicate-evidence",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid-completion-policy",
        pointer: "/phases/build/work/compile/completionPolicy/evidencePolicy",
      }),
    ]);
  });

  it.each([
    ["a non-object document", [], "invalid-document", ""],
    ["an extra phase field", { unexpected: true }, "unknown-field", "/phases/0/unexpected"],
  ])("rejects %s", (_name, mutation, code, pointer) => {
    const document: unknown = Array.isArray(mutation) ? mutation : softwareFixture();
    if (!Array.isArray(mutation)) {
      Object.assign((document as ReturnType<typeof softwareFixture>).phases[0] as object, mutation);
    }
    const result = doctorWorkflowConfiguration(
      document,
      "fixture://malformed",
      deterministicSha256,
    );
    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, pointer })]),
    );
  });

  it("compiles a full software document and binds authority into graph tasks", () => {
    const snapshot = compileWorkflowConfiguration(
      fullSoftwareFixture(),
      "fixture://full-software",
      deterministicSha256,
    );

    expect(snapshot.schemas.map(({ key }) => key)).toEqual(["work-input"]);
    expect(snapshot.sensors.map(({ key }) => key)).toEqual(["quality"]);
    expect(snapshot.gates.map(({ key }) => key)).toEqual(["release-ready"]);
    expect(snapshot.projections.map(({ key }) => key)).toEqual(["release/announce"]);
    expect(snapshot.schemas[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    const publish = snapshot.graph.nodes.find(
      (node) => node.definition.source.pointer === "/phases/release/work/publish",
    );
    expect(publish?.definition.input).toMatchObject({
      binding: {
        role: "builder",
        inputSchema: "work-input",
        gates: ["release-ready"],
      },
    });
  });

  it("compiles projected-only non-software work through the shared work lowering", () => {
    const document = incidentFixture();
    const projected = document.phases[0]?.work.splice(0) ?? [];
    document.projectedWork = projected.map((work) => ({ phase: "stabilize", work }));

    const snapshot = compileWorkflowConfiguration(
      document,
      "fixture://projected-incident",
      deterministicSha256,
    );

    expect(snapshot.projections.map(({ key }) => key)).toEqual(["stabilize/coordinate"]);
    expect(
      snapshot.graph.nodes.find((node) => node.kind === "task")?.definition.source.pointer,
    ).toBe("/projectedWork/stabilize/coordinate");
  });

  it("rejects embedded and projected qualified-key collisions", () => {
    const document = softwareFixture();
    document.projectedWork = [{ phase: "build", work: task("compile", [], "other", null) }];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://projection-collision",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-key", pointer: "/projectedWork/0/work/key" }),
      ]),
    );
  });

  it("aggregates unknown role, model policy, and input schema references", () => {
    const document = softwareFixture();
    const role = document.roles[0] as unknown as { modelPolicy: string };
    role.modelPolicy = "missing-policy";
    const work = document.phases[0]?.work[0];
    if (work === undefined) throw new Error("Expected work fixture");
    work.role = "missing-role";
    work.inputSchema = "missing-schema";

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://unknown-authority",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics.map(({ code, pointer }) => ({ code, pointer }))).toEqual(
      expect.arrayContaining([
        { code: "unknown-reference", pointer: "/phases/0/work/0/inputSchema" },
        { code: "unknown-reference", pointer: "/phases/0/work/0/role" },
        { code: "unknown-reference", pointer: "/roles/0/modelPolicy" },
      ]),
    );
  });

  it("rejects human and authority work executors", () => {
    const document = softwareFixture();
    const role = document.roles[0] as unknown as {
      kind: "agent" | "human" | "authority";
      modelPolicy?: string;
    };
    role.kind = "authority";
    delete role.modelPolicy;

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://authority-widening",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "authority-widening", pointer: "/phases/0/work/0/role" }),
      ]),
    );
  });

  it("rejects an unbounded repeatable work path", () => {
    const document = softwareFixture();
    const work = document.phases[0]?.work[0];
    if (work === undefined) throw new Error("Expected work fixture");
    work.budgets = work.budgets.filter(({ unit }) => unit !== "rebase-attempt");

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://unbounded",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-budget", pointer: "/phases/0/work/0/budgets" }),
      ]),
    );
  });

  it.each([
    ["network", "https://example.test/schema", "network-schema-reference"],
    ["undefined local", "#/$defs/missing", "undefined-schema-reference"],
  ])("rejects a %s schema reference", (_name, reference, code) => {
    const document = softwareFixture();
    document.schemas = [schema("work-input", { $ref: reference })];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://schema-reference",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it("accepts percent-encoded local JSON Pointer fragments", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("work-input", {
        $defs: { "value/with space": { type: "string" } },
        $ref: "#/%24defs/value~1with%20space",
      }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://encoded-schema-reference",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
  });

  it("rejects dynamic references until runtime dynamic scope is supported", () => {
    const document = softwareFixture();
    document.schemas = [schema("work-input", { $dynamicRef: "#missing" })];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://undefined-dynamic-anchor",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-schema",
          pointer: "/schemas/0/schema/$dynamicRef",
        }),
      ]),
    );
  });

  it.each([
    [
      "root",
      {
        $defs: { value: { $anchor: "value", type: "string" } },
        $ref: "#value",
      },
    ],
    [
      "nested",
      {
        $defs: {
          value: { $anchor: "value", type: "string" },
          wrapper: { $ref: "#value" },
        },
      },
    ],
  ])("accepts a valid %s static anchor reference", (_name, content) => {
    const document = softwareFixture();
    document.schemas = [schema("work-input", content)];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://static-anchor-reference",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
  });

  it("rejects a dynamic anchor reference even within one resource", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("work-input", {
        $defs: { value: { $dynamicAnchor: "value", type: "string" } },
        $dynamicRef: "#value",
      }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://dynamic-anchor-reference",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-schema",
          pointer: "/schemas/0/schema/$dynamicRef",
        }),
      ]),
    );
  });

  it("does not resolve a root reference to an embedded resource anchor", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("work-input", {
        $defs: {
          embedded: {
            $id: "urn:senawa:embedded-anchor",
            $anchor: "embedded",
            type: "string",
          },
        },
        $ref: "#embedded",
      }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://cross-resource-anchor",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "undefined-schema-reference",
          pointer: "/schemas/0/schema/$ref",
        }),
      ]),
    );
  });

  it("resolves an embedded resource reference to its own anchor", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("work-input", {
        $defs: {
          embedded: {
            $id: "urn:senawa:embedded-internal-anchor",
            $defs: { value: { $anchor: "value", type: "string" } },
            $ref: "#value",
          },
        },
      }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://embedded-internal-anchor",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
  });

  it.each(["#/$defs/embedded", "#/$defs/embedded/$defs/secret"])(
    "rejects a root pointer crossing into embedded resource %s",
    (reference) => {
      const document = softwareFixture();
      document.schemas = [
        schema("work-input", {
          $defs: {
            embedded: {
              $id: "urn:senawa:embedded-pointer-target",
              $defs: { secret: { type: "string" } },
            },
          },
          $ref: reference,
        }),
      ];

      const result = doctorWorkflowConfiguration(
        document,
        "fixture://root-pointer-cross-resource",
        deterministicSha256,
      );

      expect(result.snapshot).toBeUndefined();
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "undefined-schema-reference",
            pointer: "/schemas/0/schema/$ref",
          }),
        ]),
      );
    },
  );

  it.each([
    [
      "accepts an embedded pointer to that resource",
      {
        $defs: {
          embedded: {
            $id: "urn:senawa:embedded-pointer",
            $defs: { value: { type: "string" } },
            $ref: "#/$defs/value",
          },
        },
      },
      true,
    ],
    [
      "rejects an embedded pointer that exists only in the document root",
      {
        $defs: {
          rootValue: { type: "string" },
          embedded: {
            $id: "urn:senawa:embedded-pointer-scope",
            $ref: "#/$defs/rootValue",
          },
        },
      },
      false,
    ],
  ])("%s", (_name, content, accepted) => {
    const document = softwareFixture();
    document.schemas = [schema("work-input", content)];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://embedded-pointer-scope",
      deterministicSha256,
    );

    if (accepted) {
      expect(result.diagnostics).toEqual([]);
      expect(result.snapshot).toBeDefined();
    } else {
      expect(result.snapshot).toBeUndefined();
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "undefined-schema-reference",
            pointer: "/schemas/0/schema/$defs/embedded/$ref",
          }),
        ]),
      );
    }
  });

  it("reports a duplicate anchor in one resource at the later declaration", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("work-input", {
        $defs: {
          first: { $anchor: "value", type: "string" },
          second: { $dynamicAnchor: "value", type: "number" },
        },
      }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://duplicate-anchor",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-schema",
          pointer: "/schemas/0/schema/$defs/second/$dynamicAnchor",
        }),
      ]),
    );
  });

  it("requires embedded resource identifiers to remain absolute", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("work-input", {
        $defs: { embedded: { $id: "relative-resource", type: "string" } },
      }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://relative-embedded-id",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-schema",
          pointer: "/schemas/0/schema/$defs/embedded/$id",
        }),
      ]),
    );
  });

  it("rejects invalid JSON Pointer tilde escapes in schema references", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("work-input", { $defs: { "a~2b": { type: "string" } }, $ref: "#/$defs/a~2b" }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://invalid-pointer-escape",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-schema",
          pointer: "/schemas/0/schema/$ref",
        }),
      ]),
    );
  });

  it("does not inspect annotation data as nested schemas", () => {
    const document = softwareFixture();
    const annotation = { $ref: "https://example.test/not-a-schema" };
    document.schemas = [
      schema("work-input", {
        type: "object",
        default: annotation,
        examples: [annotation],
        const: annotation,
        enum: [annotation],
      }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://schema-annotations",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
  });

  it.each([
    [
      "properties",
      { properties: { value: { $ref: "https://example.test/schema" } } },
      "/properties/value/$ref",
    ],
    [
      "prefixItems",
      { prefixItems: [{ $ref: "https://example.test/schema" }] },
      "/prefixItems/0/$ref",
    ],
  ])("inspects references at the %s schema location", (_name, content, suffix) => {
    const document = softwareFixture();
    document.schemas = [schema("work-input", content)];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://nested-schema-reference",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "network-schema-reference",
          pointer: `/schemas/0/schema${suffix}`,
        }),
      ]),
    );
  });

  it("rejects duplicate schema identifiers", () => {
    const document = softwareFixture();
    document.schemas = [schema("first", { type: "string" }), schema("second", { type: "number" })];
    const second = document.schemas[1] as unknown as { schema: { $id: string } };
    second.schema.$id = "urn:senawa:first";

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://duplicate-schema-id",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-schema-id", pointer: "/schemas/1/schema/$id" }),
      ]),
    );
  });

  it("treats equivalent schema resource identifiers as duplicates", () => {
    const document = softwareFixture();
    document.schemas = [schema("first", { type: "string" }), schema("second", { type: "number" })];
    const first = document.schemas[0] as unknown as { schema: { $id: string } };
    const second = document.schemas[1] as unknown as { schema: { $id: string } };
    first.schema.$id = "urn:test:same";
    second.schema.$id = "urn:test:same#";

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://equivalent-schema-id",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-schema-id", pointer: "/schemas/1/schema/$id" }),
      ]),
    );
  });

  it.each([
    ["http://example.com/%7Eresource", "http://example.com/~resource"],
    ["http://example.com/%2fresource", "http://example.com/%2Fresource"],
  ])("normalizes equivalent schema resource IDs %s and %s", (firstId, secondId) => {
    const document = softwareFixture();
    document.schemas = [schema("first", { type: "string" }), schema("second", { type: "number" })];
    const first = document.schemas[0] as unknown as { schema: { $id: string } };
    const second = document.schemas[1] as unknown as { schema: { $id: string } };
    first.schema.$id = firstId;
    second.schema.$id = secondId;

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://percent-equivalent-schema-id",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-schema-id", pointer: "/schemas/1/schema/$id" }),
      ]),
    );
  });

  it("rejects malformed schema resource identifiers", () => {
    const document = softwareFixture();
    document.schemas = [schema("work-input", { type: "object" })];
    const declaration = document.schemas[0] as unknown as { schema: { $id: string } };
    declaration.schema.$id = "not a URI";

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://malformed-schema-id",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-schema", pointer: "/schemas/0/schema/$id" }),
      ]),
    );
  });

  it("rejects duplicate embedded resource identifiers across schema entries", () => {
    const document = softwareFixture();
    document.schemas = [
      schema("first", { $defs: { nested: { $id: "urn:senawa:shared-embedded" } } }),
      schema("second", { $defs: { nested: { $id: "urn:senawa:shared-embedded" } } }),
    ];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://duplicate-embedded-resource",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate-schema-id",
          pointer: "/schemas/1/schema/$defs/nested/$id",
        }),
      ]),
    );
  });

  it("reports deeply nested finite schemas instead of overflowing doctor", () => {
    const document = softwareFixture();
    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 650; depth += 1) nested = { allOf: [nested] };
    document.schemas = [schema("work-input", nested)];

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://deep-schema",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-schema", pointer: "/schemas/0/schema" }),
      ]),
    );
  });

  it("rejects automatic model routes and non-positive sensor bounds", () => {
    const document = fullSoftwareFixture();
    const route = document.modelPolicies[0]?.routes[0] as unknown as { model: string };
    route.model = "auto";
    const sensor = document.sensors[0] as unknown as { timeoutMs: number };
    sensor.timeoutMs = 0;

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://invalid-bounds",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-model-policy",
          pointer: "/modelPolicies/0/routes/0/model",
        }),
        expect.objectContaining({ code: "invalid-field", pointer: "/sensors/0/timeoutMs" }),
      ]),
    );
  });

  it("rejects sensor bounds above practical adapter limits", () => {
    const document = fullSoftwareFixture();
    const sensor = document.sensors[0] as unknown as {
      timeoutMs: number;
      maxStdoutBytes: number;
      maxStderrBytes: number;
      maxAttempts: number;
      maxReconciliationAttempts: number;
    };
    sensor.timeoutMs = 2_147_483_648;
    sensor.maxStdoutBytes = 64 * 1024 * 1024 + 1;
    sensor.maxStderrBytes = 64 * 1024 * 1024 + 1;
    sensor.maxAttempts = 10_001;
    sensor.maxReconciliationAttempts = 10_001;

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://impractical-bounds",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics.map(({ pointer }) => pointer)).toEqual(
      expect.arrayContaining([
        "/sensors/0/timeoutMs",
        "/sensors/0/maxStdoutBytes",
        "/sensors/0/maxStderrBytes",
        "/sensors/0/maxAttempts",
        "/sensors/0/maxReconciliationAttempts",
      ]),
    );
  });

  it.each(["C:/repository", "c:repository", "Z:"])(
    "rejects Windows drive-prefixed sensor cwd %s",
    (cwd) => {
      const document = fullSoftwareFixture();
      const sensor = document.sensors[0] as unknown as { cwd: string };
      sensor.cwd = cwd;

      const result = doctorWorkflowConfiguration(
        document,
        "fixture://drive-prefixed-cwd",
        deterministicSha256,
      );

      expect(result.snapshot).toBeUndefined();
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid-sensor", pointer: "/sensors/0/cwd" }),
        ]),
      );
    },
  );

  it("rejects lifecycle authority on a sensor definition", () => {
    const document = fullSoftwareFixture();
    (document.sensors[0] as unknown as Record<string, unknown>).onFailure = "close-phase";

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://sensor-authority",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown-field", pointer: "/sensors/0/onFailure" }),
      ]),
    );
  });

  it("reports undefined gate sensor references before snapshot construction", () => {
    const document = fullSoftwareFixture();
    const gate = document.gates[0] as unknown as { blocking: Array<Record<string, unknown>> };
    const condition = gate.blocking[0]?.condition as {
      accessor: { sensorKey: string };
    };
    condition.accessor.sensorKey = "missing-sensor";

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://gate-sensor",
      deterministicSha256,
    );

    expect(result.snapshot).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unknown-reference",
          pointer: "/gates/0/blocking/0/condition/accessor/sensorKey",
        }),
      ]),
    );
  });

  it("does not treat comparison expected data as sensor references", () => {
    const document = fullSoftwareFixture();
    const gate = document.gates[0] as unknown as {
      blocking: Array<{ condition: { expected: unknown } }>;
    };
    const condition = gate.blocking[0]?.condition;
    if (condition === undefined) throw new Error("Expected blocking gate rule");
    condition.expected = { sensorKey: "ordinary-data" };

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://ordinary-expected-data",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
  });

  it.each(["blocking", "advisory"] as const)(
    "maps an invalid %s accessor pointer to its exact source",
    (kind) => {
      const document = fullSoftwareFixture();
      const gate = document.gates[0] as unknown as {
        blocking: Array<{
          key: string;
          condition: {
            operator: "exists" | "equals";
            accessor: { sensorKey: string; pointer: string };
            expected?: unknown;
          };
        }>;
        advisory: Array<{
          key: string;
          condition: {
            operator: "exists";
            accessor: { sensorKey: string; pointer: string };
          };
        }>;
      };
      if (kind === "blocking") {
        gate.blocking.push({
          key: "alpha-invalid",
          condition: {
            operator: "exists",
            accessor: { sensorKey: "quality", pointer: "not-a-pointer" },
          },
        });
      } else {
        gate.advisory.push({
          key: "zeta-valid",
          condition: {
            operator: "exists",
            accessor: { sensorKey: "quality", pointer: "/ok" },
          },
        });
        gate.advisory.push({
          key: "alpha-invalid",
          condition: {
            operator: "exists",
            accessor: { sensorKey: "quality", pointer: "not-a-pointer" },
          },
        });
      }

      const result = doctorWorkflowConfiguration(
        document,
        "fixture://invalid-gate-pointer",
        deterministicSha256,
      );

      expect(result.snapshot).toBeUndefined();
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid-gate",
            pointer: `/gates/0/${kind}/1/condition/accessor/pointer`,
          }),
        ]),
      );
    },
  );

  it("maps a duplicate gate rule key to the later rule", () => {
    const document = fullSoftwareFixture();
    const gate = document.gates[0] as unknown as {
      blocking: Array<{ key: string; condition: unknown }>;
    };
    const original = gate.blocking[0];
    if (original === undefined) throw new Error("Expected gate rule fixture");
    gate.blocking.push({ key: original.key, condition: original.condition });

    const result = doctorWorkflowConfiguration(
      document,
      "fixture://duplicate-gate-rule",
      deterministicSha256,
    );

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-gate",
          pointer: "/gates/0/blocking/1/key",
        }),
      ]),
    );
  });

  it("normalizes registry declaration order but preserves model route order", () => {
    const first = fullSoftwareFixture();
    first.schemas = [
      ...first.schemas,
      schema("result", { type: "object", properties: { ok: { type: "boolean" } } }),
    ];
    const second = fullSoftwareFixture();
    second.schemas = [
      schema("result", { properties: { ok: { type: "boolean" } }, type: "object" }),
      ...second.schemas,
    ];
    second.roles = [...second.roles].reverse();
    second.sensors = [...second.sensors].reverse();
    second.gates = [...second.gates].reverse();
    second.projectedWork = [...second.projectedWork].reverse();
    const firstSnapshot = compileWorkflowConfiguration(
      first,
      "fixture://order",
      deterministicSha256,
    );
    const secondSnapshot = compileWorkflowConfiguration(
      second,
      "fixture://order",
      deterministicSha256,
    );
    expect(secondSnapshot).toEqual(firstSnapshot);

    const reorderedRoutes = fullSoftwareFixture();
    const policy = reorderedRoutes.modelPolicies[0] as unknown as {
      routes: Array<Record<string, unknown>>;
    };
    policy.routes.push({
      provider: "azure",
      model: "gpt-5-mini",
      maxTurns: 4,
      maxSubmissions: 2,
      maxMillidollars: 2_000,
    });
    const reversedRoutes = fullSoftwareFixture();
    const reversedPolicy = reversedRoutes.modelPolicies[0] as unknown as {
      routes: Array<Record<string, unknown>>;
    };
    reversedPolicy.routes = [...policy.routes].reverse();
    expect(
      compileWorkflowConfiguration(reorderedRoutes, "fixture://routes", deterministicSha256)
        .componentDigests.modelPolicies,
    ).not.toBe(
      compileWorkflowConfiguration(reversedRoutes, "fixture://routes", deterministicSha256)
        .componentDigests.modelPolicies,
    );
  });
});

it("enforces aggregate sensor retry output at one GiB and one byte above", () => {
  const atLimit = JSON.parse(JSON.stringify(createExampleWorkflowConfiguration())) as unknown as {
    sensors: Array<{
      maxStdoutBytes: number;
      maxStderrBytes: number;
      maxAttempts: number;
      maxReconciliationAttempts: number;
    }>;
  };
  const atLimitSensor = atLimit.sensors[0];
  if (atLimitSensor === undefined) throw new Error("Expected sensor fixture");
  atLimitSensor.maxStdoutBytes = 64 * 1024 * 1024;
  atLimitSensor.maxStderrBytes = 64 * 1024 * 1024;
  atLimitSensor.maxAttempts = 4;
  atLimitSensor.maxReconciliationAttempts = 4;
  expect(
    doctorWorkflowConfiguration(atLimit, "fixture://aggregate", deterministicSha256).snapshot,
  ).toBeDefined();

  atLimitSensor.maxReconciliationAttempts += 1;
  expect(
    doctorWorkflowConfiguration(atLimit, "fixture://aggregate", deterministicSha256).diagnostics,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        pointer: "/sensors/0",
        message: expect.stringContaining("aggregate retry output"),
      }),
    ]),
  );
});

describe("workflow amendment compilation", () => {
  it("retains accepted remote policy and rejects a forged remote snapshot", () => {
    const locator = "fixture://remote-amendment";
    const base = softwareFixture();
    base.remote = remotePolicyFixture();
    const baseSnapshot = compileWorkflowConfiguration(base, locator, deterministicSha256);
    const document = amendmentDocument(baseSnapshot.snapshotDigest, [
      {
        kind: "add-task",
        phase: "release",
        work: task("verify-remote", ["release/publish"], "verified", null),
      },
    ]);
    const compiled = compileWorkflowAmendment(
      { document, locator, baseSnapshot, phaseCandidateHistory: [] },
      deterministicSha256,
    );
    const forged = JSON.parse(JSON.stringify(baseSnapshot)) as typeof baseSnapshot;
    const forgedRemote = forged.remote as unknown as {
      maximumRemoteAuthorizationLeaseSeconds: number;
    };
    forgedRemote.maximumRemoteAuthorizationLeaseSeconds += 1;

    const diagnosis = doctorWorkflowAmendment(
      { document, locator, baseSnapshot: forged, phaseCandidateHistory: [] },
      deterministicSha256,
    );

    expect(compiled.resultSnapshot.remote).toEqual(baseSnapshot.remote);
    expect(compiled.resultSnapshot.componentDigests.remote).toBe(
      baseSnapshot.componentDigests.remote,
    );
    expect(diagnosis.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-document", pointer: "/baseSnapshotDigest" }),
    ]);
  });

  it("produces the same snapshot as equivalent complete initial input", () => {
    const locator = "fixture://amendment-equivalence";
    const base = softwareFixture();
    const baseSnapshot = compileWorkflowConfiguration(base, locator, deterministicSha256);
    const report = task("report", ["release/publish"], "reported", { command: "report" });
    const amendment = amendmentDocument(baseSnapshot.snapshotDigest, [
      {
        kind: "add-phase",
        phase: { key: "audit", generation: 1, dependsOn: ["release"], input: { scope: "release" } },
      },
      { kind: "add-task", phase: "audit", work: report },
    ]);
    const complete = softwareFixture();
    complete.phases.push({
      key: "audit",
      generation: 1,
      dependsOn: ["release"],
      input: { scope: "release" },
      work: [report],
    });

    const compiled = compileWorkflowAmendment(
      { document: amendment, locator, baseSnapshot, phaseCandidateHistory: [] },
      deterministicSha256,
    );
    const expected = compileWorkflowConfiguration(complete, locator, deterministicSha256);

    expect(compiled.resultSnapshot).toEqual(expected);
    expect(compiled.proposal.reviewedResultGraph).toEqual(expected.graph);
    expect(compiled.proposal.resultConfigurationSnapshotDigest).toBe(expected.snapshotDigest);
  });

  it("normalizes operation order into one proposal and result snapshot", () => {
    const locator = "fixture://amendment-order";
    const baseSnapshot = compileWorkflowConfiguration(
      softwareFixture(),
      locator,
      deterministicSha256,
    );
    const operations: WorkflowAmendmentDocument["operations"] = [
      {
        kind: "add-phase",
        phase: { key: "audit", generation: 1, dependsOn: ["release"] },
      },
      {
        kind: "add-task",
        phase: "audit",
        work: task("report", ["release/publish"], "reported", null),
      },
    ];
    const first = compileWorkflowAmendment(
      {
        document: amendmentDocument(baseSnapshot.snapshotDigest, operations),
        locator,
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );
    const second = compileWorkflowAmendment(
      {
        document: amendmentDocument(baseSnapshot.snapshotDigest, [...operations].reverse()),
        locator,
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );

    expect(second).toEqual(first);
  });

  it("reuses accepted registries without permitting registry mutation", () => {
    const baseSnapshot = compileWorkflowConfiguration(
      fullSoftwareFixture(),
      "fixture://accepted-registries",
      deterministicSha256,
    );
    const work = task("verify", ["release/publish"], "verified", null);
    work.inputSchema = "work-input";
    const document = amendmentDocument(baseSnapshot.snapshotDigest, [
      { kind: "add-task", phase: "release", work },
    ]);
    const compiled = compileWorkflowAmendment(
      {
        document,
        locator: "fixture://accepted-registries",
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );
    const mutated = { ...document, schemas: [] };
    const diagnosis = doctorWorkflowAmendment(
      {
        document: mutated,
        locator: "fixture://accepted-registries",
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );
    const forgedBase = JSON.parse(JSON.stringify(baseSnapshot)) as typeof baseSnapshot;
    const forgedRole = forgedBase.roles[0] as unknown as { value: { capabilities: string[] } };
    forgedRole.value.capabilities.push("forged-capability");
    const forgedDiagnosis = doctorWorkflowAmendment(
      {
        document,
        locator: "fixture://accepted-registries",
        baseSnapshot: forgedBase,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );

    expect(compiled.resultSnapshot.schemas).toEqual(baseSnapshot.schemas);
    expect(compiled.resultSnapshot.roles).toEqual(baseSnapshot.roles);
    expect(compiled.resultSnapshot.execution).toEqual(baseSnapshot.execution);
    expect(diagnosis.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown-field", pointer: "/schemas" }),
    ]);
    expect(forgedDiagnosis.compilation).toBeUndefined();
    expect(forgedDiagnosis.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-document", pointer: "/baseSnapshotDigest" }),
    ]);
  });

  it("refuses stale snapshots and additions to phases with candidate history", () => {
    const locator = "fixture://amendment-history";
    const baseSnapshot = compileWorkflowConfiguration(
      softwareFixture(),
      locator,
      deterministicSha256,
    );
    const document = amendmentDocument(baseSnapshot.snapshotDigest, [
      {
        kind: "add-task",
        phase: "release",
        work: task("verify", ["release/publish"], "verified", null),
      },
    ]);
    const initial = compileWorkflowAmendment(
      { document, locator, baseSnapshot, phaseCandidateHistory: [] },
      deterministicSha256,
    );
    const target = initial.proposal.impact.existingTargetPhases[0];
    if (target === undefined) throw new Error("Expected existing target phase impact");
    const history = doctorWorkflowAmendment(
      { document, locator, baseSnapshot, phaseCandidateHistory: [target] },
      deterministicSha256,
    );
    const stale = doctorWorkflowAmendment(
      {
        document: { ...document, baseSnapshotDigest: sha256Digest("f".repeat(64)) },
        locator,
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );

    expect(history.compilation).toBeUndefined();
    expect(history.diagnostics).toEqual([
      expect.objectContaining({ code: "candidate-history", pointer: "/operations" }),
    ]);
    expect(stale.compilation).toBeUndefined();
    expect(stale.diagnostics).toEqual([
      expect.objectContaining({ code: "stale-base", pointer: "/baseSnapshotDigest" }),
    ]);
  });
});

describe("configuration drift", () => {
  it("reports remote policy drift at the normalized policy address", () => {
    const accepted = compileWorkflowConfiguration(
      softwareFixture(),
      "fixture://remote-drift",
      deterministicSha256,
    );
    const changedDocument = softwareFixture();
    changedDocument.remote = remotePolicyFixture();
    const current = compileWorkflowConfiguration(
      changedDocument,
      "fixture://remote-drift",
      deterministicSha256,
    );

    expect(detectConfigurationDrift(accepted, current)).toMatchObject({
      hasDrift: true,
      changedCategories: ["remote"],
      changedKeys: ["/remote"],
    });
  });

  it("reports execution policy drift at the normalized policy address", () => {
    const accepted = compileWorkflowConfiguration(
      softwareFixture(),
      "fixture://execution-drift",
      deterministicSha256,
    );
    const changed = softwareFixture();
    changed.execution = {
      workspaceMode: "worktree",
      maxWriterConcurrency: 2,
      failurePolicy: "continue",
      integrationRef: "refs/heads/senawa/integration",
    };
    const current = compileWorkflowConfiguration(
      changed,
      "fixture://execution-drift",
      deterministicSha256,
    );

    expect(detectConfigurationDrift(accepted, current)).toMatchObject({
      hasDrift: true,
      changedCategories: ["execution"],
      changedKeys: ["/execution"],
    });
  });

  it("reports changed component categories and stable keys", () => {
    const accepted = compileWorkflowConfiguration(
      softwareFixture(),
      "fixture://drift",
      deterministicSha256,
    );
    const changedDocument = softwareFixture();
    const changedWork = changedDocument.phases[0]?.work[0];
    if (changedWork !== undefined) {
      changedWork.input = { command: "compile --strict" };
    }
    const current = compileWorkflowConfiguration(
      changedDocument,
      "fixture://drift",
      deterministicSha256,
    );

    expect(detectConfigurationDrift(accepted, current)).toMatchObject({
      hasDrift: true,
      changedCategories: ["graph"],
      changedKeys: ["/phases/build/work/compile"],
    });
  });

  it("reports no drift for an equivalent reordered document", () => {
    const accepted = compileWorkflowConfiguration(
      softwareFixture(),
      "fixture://same",
      deterministicSha256,
    );
    const current = compileWorkflowConfiguration(
      reorderedSoftwareFixture(),
      "fixture://same",
      deterministicSha256,
    );

    expect(detectConfigurationDrift(accepted, current)).toMatchObject({
      hasDrift: false,
      changedCategories: [],
      changedKeys: [],
    });
  });

  it("reports precise registry categories and keys", () => {
    const accepted = compileWorkflowConfiguration(
      fullSoftwareFixture(),
      "fixture://registry-drift",
      deterministicSha256,
    );
    const changed = fullSoftwareFixture();
    const role = changed.roles[0] as unknown as { capabilities: string[] };
    role.capabilities.push("review");
    const current = compileWorkflowConfiguration(
      changed,
      "fixture://registry-drift",
      deterministicSha256,
    );

    expect(detectConfigurationDrift(accepted, current)).toMatchObject({
      hasDrift: true,
      changedCategories: ["roles"],
      changedKeys: ["builder"],
    });
  });
});

function softwareFixture(): MutableWorkflowDocument {
  return {
    apiVersion: "senawa.dev/workflow/v1alpha2",
    kind: "Workflow",
    workflow: { key: "delivery", generation: 1, input: { product: "senawa" } },
    ...authorityRegistries(),
    schemas: [],
    sensors: [],
    gates: [],
    projectedWork: [],
    phases: [
      {
        key: "build",
        generation: 1,
        dependsOn: [],
        input: { environment: "ci" },
        work: [
          task("compile", [], "builds", { command: "compile" }),
          task("test", ["build/compile"], "passes", { command: "test" }),
        ],
      },
      {
        key: "release",
        generation: 1,
        dependsOn: ["build"],
        input: { environment: "production" },
        work: [task("publish", ["build/test"], "published", { command: "publish" })],
      },
    ],
  };
}

function amendmentDocument(
  baseSnapshotDigest: WorkflowAmendmentDocument["baseSnapshotDigest"],
  operations: WorkflowAmendmentDocument["operations"],
): WorkflowAmendmentDocument {
  return {
    apiVersion: "senawa.dev/workflow-amendment/v1alpha1",
    kind: "WorkflowAmendment",
    baseSnapshotDigest,
    baseContextDigest: sha256Digest("c".repeat(64)),
    operations,
  };
}

function remotePolicyFixture(): NonNullable<WorkflowConfigurationDocument["remote"]> {
  return {
    roleMappings: [
      {
        issuer: "https://identity.example.test",
        tenant: "tenant-a",
        upstreamRole: "operator",
        localRoles: ["builder"],
      },
    ],
    maximumRemoteAuthorizationLeaseSeconds: 900,
    synchronization: {
      classificationCeiling: "public",
      receiptChain: false,
      events: false,
      projections: false,
      synchronizationState: false,
    },
  };
}

function reorderedSoftwareFixture(): MutableWorkflowDocument {
  const document = softwareFixture();
  document.phases.reverse();
  for (const phase of document.phases) {
    phase.work.reverse();
    for (const work of phase.work) {
      work.completionPolicy.criteria.reverse();
      work.input = { command: (work.input as { command: string }).command };
    }
  }
  document.workflow = { input: { product: "senawa" }, generation: 1, key: "delivery" };
  return document;
}

function incidentFixture(): MutableWorkflowDocument {
  return {
    apiVersion: "senawa.dev/workflow/v1alpha2",
    kind: "Workflow",
    workflow: { key: "incident", generation: 1, input: { service: "payments" } },
    ...authorityRegistries(),
    schemas: [],
    sensors: [],
    gates: [],
    projectedWork: [],
    phases: [
      {
        key: "stabilize",
        generation: 1,
        dependsOn: [],
        input: { severity: 1 },
        work: [task("coordinate", [], "stakeholders-informed", { channel: "bridge" })],
      },
    ],
  };
}

function fullSoftwareFixture(): MutableWorkflowDocument {
  const document = softwareFixture();
  document.schemas = [schema("work-input", { type: "object" })];
  document.sensors = [
    {
      key: "quality",
      argv: ["pnpm", "test"],
      cwd: ".",
      timeoutMs: 60_000,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 1_000_000,
      inheritedEnvironment: ["CI", "PATH"],
      maxAttempts: 2,
      maxReconciliationAttempts: 2,
    },
  ];
  document.gates = [
    {
      key: "release-ready",
      phase: "release",
      blocking: [
        {
          key: "quality-ok",
          condition: {
            operator: "equals",
            accessor: { sensorKey: "quality", pointer: "/ok" },
            expected: true,
          },
        },
      ],
      advisory: [],
    },
  ];
  const publish = document.phases[1]?.work[0];
  if (publish === undefined) throw new Error("Expected publish fixture");
  publish.inputSchema = "work-input";
  document.projectedWork = [
    { phase: "release", work: task("announce", ["release/publish"], "announced", null) },
  ];
  return document;
}

function schema(key: string, content: Record<string, unknown>) {
  return {
    key,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:senawa:${key}`,
      ...content,
    },
  } as unknown as WorkflowConfigurationDocument["schemas"][number];
}

function task(
  key: string,
  dependsOn: string[],
  criterionKey: string,
  input: unknown,
): MutableWorkDeclaration {
  return {
    key,
    generation: 1,
    role: "builder",
    budgets: boundedBudgets(),
    dependsOn,
    input,
    completionPolicy: {
      criteria: [{ key: criterionKey, generation: 1, required: true, input: null }],
      evidencePolicy: { mode: "none", requirements: [] },
    },
  };
}

type MutableWorkflowDocument = {
  -readonly [Key in keyof WorkflowConfigurationDocument]: Key extends "phases"
    ? MutablePhaseDeclaration[]
    : Key extends "workflow"
      ? Mutable<WorkflowConfigurationDocument[Key]>
      : WorkflowConfigurationDocument[Key];
};

interface MutablePhaseDeclaration {
  key: string;
  generation: number;
  dependsOn: string[];
  input?: unknown;
  work: MutableWorkDeclaration[];
}

interface MutableWorkDeclaration {
  key: string;
  generation: number;
  role: string;
  budgets: Array<{ unit: BudgetUnitName; limit: number }>;
  dependsOn: string[];
  inputSchema?: string;
  input?: unknown;
  completionPolicy: {
    criteria: Array<{
      key: string;
      generation: number;
      required: boolean;
      input?: unknown;
    }>;
    evidencePolicy: {
      mode: "none" | "task" | "required-criteria" | "all-satisfied";
      requirements: Array<{ kind: unknown; minimumCount: number }>;
    };
  };
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

function authorityRegistries() {
  return {
    roles: [
      {
        key: "builder",
        kind: "agent" as const,
        capabilities: ["execute-work"],
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
  };
}

function boundedBudgets(): Array<{ unit: BudgetUnitName; limit: number }> {
  return [
    { unit: "work-attempt", limit: 3 },
    { unit: "dispatch-failure", limit: 2 },
    { unit: "sensor-retry", limit: 2 },
    { unit: "review-iteration", limit: 3 },
    { unit: "integration-attempt", limit: 2 },
    { unit: "rebase-attempt", limit: 2 },
  ];
}

type BudgetUnitName =
  | "work-attempt"
  | "dispatch-failure"
  | "sensor-retry"
  | "review-iteration"
  | "integration-attempt"
  | "rebase-attempt";
