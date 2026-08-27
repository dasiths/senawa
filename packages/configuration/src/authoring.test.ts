import type { Sha256 } from "@senawa/kernel";
import { describe, expect, it } from "vitest";
import { lowerAuthoredWorkflow } from "./authoring.js";
import { doctorWorkflowConfiguration } from "./compiler.js";
import type { ConfigurationResourceReader } from "./contracts.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const AGENTS = `
definer:
  model: gpt-5
  prompt: prompts/definer.md
  session: run
verifier:
  model: gpt-5
  prompt: prompts/verifier.md
  session: run
`;

const WORKFLOW = `
name: delivery
input: schemas/request.schema.json
phases:
  - name: define
    agent: definer
    output: schemas/definition.schema.json
    approve: true
  - name: verify
    agent: verifier
    needs: [define]
    output: schemas/verification.schema.json
    gates: [tests]
`;

const SENSORS = `
sensors:
  tests:
    run: pnpm test
    deterministic: true
`;

const PROMPTS = new Map([
  ["prompts/definer.md", "Define the work.\n\nRequest: ${{ input.request }}\n"],
  ["prompts/verifier.md", "Verify it.\n\nDefinition: ${{ input.definition }}\n"],
]);

describe("authored workflow lowering", () => {
  it("lowers three authored documents into a document the compiler accepts", async () => {
    const lowered = lowerAuthoredWorkflow(authored());
    expect(lowered.diagnostics).toEqual([]);
    expect(lowered.document).toBeDefined();

    const result = await doctorWorkflowConfiguration(
      { document: lowered.document, locator: "authored://workflow.yaml", resources: reader() },
      deterministicSha256,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot?.graph.nodes.filter((node) => node.kind === "phase")).toHaveLength(2);
  });

  it("lowers a fan-out into a task frontier over the named collection", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      workflow: {
        path: "workflow.yaml",
        text: `${WORKFLOW.slice(0, WORKFLOW.indexOf("  - name: verify"))}  - name: verify\n    agent: verifier\n    needs: [define]\n    forEach: define.items\n    collection: schemas/collection.schema.json\n    input: schemas/item.schema.json\n    output: schemas/verification.schema.json\n`,
      },
    });
    expect(lowered.diagnostics).toEqual([]);
    const document = lowered.document as unknown as {
      readonly forEach: readonly Record<string, unknown>[];
      readonly taskTemplates: readonly Record<string, unknown>[];
      readonly phases: readonly Record<string, unknown>[];
    };
    expect(document.forEach[0]).toMatchObject({
      key: "verify-items",
      source: { kind: "phase-output", phase: "define" },
      pointer: "/items",
      identityPointer: "/id",
    });
    expect(document.taskTemplates[0]).toMatchObject({ key: "verify-work", role: "verifier" });
    expect(document.phases[1]?.executor).toMatchObject({
      kind: "task-frontier",
      forEach: "verify-items",
      template: "verify-work",
    });
  });

  it("refuses a fan-out that does not name its collection shape", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      workflow: {
        path: "workflow.yaml",
        text: `${WORKFLOW.slice(0, WORKFLOW.indexOf("  - name: verify"))}  - name: verify\n    agent: verifier\n    needs: [define]\n    forEach: define.items\n    input: schemas/item.schema.json\n    output: schemas/verification.schema.json\n`,
      },
    });
    // The kernel validates the selected collection separately, so its shape
    // cannot be inferred from the item schema.
    expect(lowered.diagnostics.map(({ pointer }) => pointer)).toContain("/phases/1/collection");
  });

  it("keeps ordered model routes so a run can fall back rather than stall", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      agents: {
        path: "agents.yaml",
        text: "definer:\n  prompt: prompts/definer.md\n  models:\n    - model: gpt-5\n      turns: 24\n    - model: gpt-5-mini\nverifier:\n  model: gpt-5\n  prompt: prompts/verifier.md\n",
      },
    });
    expect(lowered.diagnostics).toEqual([]);
    const policies = (
      lowered.document as unknown as {
        readonly modelPolicies: readonly { key: string; routes: unknown[] }[];
      }
    ).modelPolicies;
    expect(policies.find(({ key }) => key === "definer")?.routes).toEqual([
      expect.objectContaining({ model: "gpt-5", maxTurns: 24 }),
      expect.objectContaining({ model: "gpt-5-mini", maxTurns: 12 }),
    ]);
  });

  it("refuses an agent that declares both a model and a route list", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      agents: {
        path: "agents.yaml",
        text: "definer:\n  prompt: prompts/definer.md\n  model: gpt-5\n  models:\n    - model: gpt-5-mini\nverifier:\n  model: gpt-5\n  prompt: prompts/verifier.md\n",
      },
    });
    expect(lowered.diagnostics.map(({ message }) => message)).toContain(
      "Declare either model or models, not both",
    );
  });

  it("gates on a measured value, not only on an exit code", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      sensors: {
        path: "sensors.yaml",
        text: `${SENSORS}  coverage:\n    run: pnpm test --coverage\n    deterministic: true\n\ngates:\n  quality:\n    blocking:\n      - sensor: coverage\n        field: /total/lines/pct\n        atLeast: 80\n    advisory:\n      - sensor: tests\n        exitCode: 0\n`,
      },
      workflow: {
        path: "workflow.yaml",
        text: WORKFLOW.replace("gates: [tests]", "gates: [quality]"),
      },
    });
    expect(lowered.diagnostics).toEqual([]);
    const gates = (
      lowered.document as unknown as {
        readonly gates: readonly { readonly blocking: unknown[]; readonly advisory: unknown[] }[];
      }
    ).gates;
    expect(gates[0]?.blocking).toEqual([
      {
        key: "coverage-total-lines-pct-at-least",
        condition: {
          operator: "greater-than-or-equal",
          accessor: { sensorKey: "coverage", pointer: "/total/lines/pct" },
          expected: 80,
        },
      },
    ]);
    expect(gates[0]?.advisory).toHaveLength(1);
  });

  it("refuses a named gate that no deterministic reading can anchor", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      sensors: {
        path: "sensors.yaml",
        text: `${SENSORS}  opinion:\n    run: node critique.mjs\n    deterministic: false\n\ngates:\n  vibes:\n    blocking:\n      - sensor: opinion\n        atLeast: 7\n        field: /score\n`,
      },
    });
    // Blocking on an opinion is the harness agreeing with whoever submitted.
    expect(lowered.diagnostics.map(({ message }) => message)).toContain(
      "Gate vibes has no deterministic reading to anchor it",
    );
  });

  it("takes the loop policy from the author, and the defaults when it is silent", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    attempts: 7\n    onGateRejected: fail\n",
      ),
    );
    expect(lowered.diagnostics).toEqual([]);
    const phases = (
      lowered.document as unknown as { readonly phases: readonly Record<string, never>[] }
    ).phases;
    expect(phases[1]?.iteration).toEqual({
      maximumAttempts: 7,
      onGateRejected: "fail",
      onApprovalRejected: "iterate",
      onUpstreamChanged: "iterate",
      onExhausted: "escalate",
    });
    // The phase that said nothing keeps the default loop.
    expect(phases[0]?.iteration).toMatchObject({ maximumAttempts: 3, onGateRejected: "iterate" });
  });

  it("refuses a disposition it cannot honour", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    onExhausted: pretend\n",
      ),
    );
    expect(lowered.diagnostics.map(({ pointer }) => pointer)).toContain("/phases/1/onExhausted");
  });

  it("routes approval to the role the author named", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    approve:\n      role: security-officer\n",
      ),
    );
    expect(lowered.diagnostics).toEqual([]);
    const phases = (
      lowered.document as unknown as { readonly phases: readonly Record<string, never>[] }
    ).phases;
    expect(phases[1]?.exit).toMatchObject({
      approval: { policy: "required", authority: { role: "security-officer" } },
    });
  });

  it("carries whose work one approval covers, and refuses the scope nothing honours", () => {
    // The kernel records one decision per candidate, so member scope has
    // nowhere to be asked yet. Accepting it and ignoring it would be authored
    // configuration that silently does nothing.
    const perMember = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    approve:\n      role: security-officer\n      scope: member\n",
      ),
    );
    expect(perMember.diagnostics.map(({ message }) => message).join(" ")).toContain(
      "not supported yet",
    );

    const perPhase = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    approve:\n      role: security-officer\n      scope: phase\n",
      ),
    );
    expect(perPhase.diagnostics).toEqual([]);
    expect(
      (perPhase.document as unknown as { readonly phases: readonly Record<string, never>[] })
        .phases[1]?.exit,
    ).toMatchObject({ approval: { policy: "required", scope: "phase" } });

    // An existing workflow says nothing, and reading it again must not change
    // what approval means for it.
    const unsaid = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    approve:\n      role: security-officer\n",
      ),
    );
    expect(
      (unsaid.document as unknown as { readonly phases: readonly Record<string, never>[] })
        .phases[1]?.exit,
    ).not.toHaveProperty("approval.scope");

    const wrong = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    approve:\n      role: security-officer\n      scope: everyone\n",
      ),
    );
    expect(wrong.diagnostics.map(({ pointer }) => pointer)).toContain("/phases/1/approve/scope");
  });

  it("takes output size from the author", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output:\n      schema: schemas/verification.schema.json\n      maxBytes: 4096\n",
      ),
    );
    expect(lowered.diagnostics).toEqual([]);
    const phases = (
      lowered.document as unknown as { readonly phases: readonly Record<string, never>[] }
    ).phases;
    expect(phases[1]?.outputs).toEqual([expect.objectContaining({ maxBytes: 4096 })]);
  });

  it("refuses an output larger than the kernel will accept", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output:\n      schema: schemas/verification.schema.json\n      maxBytes: 999999\n",
      ),
    );
    expect(lowered.diagnostics.map(({ pointer }) => pointer)).toContain(
      "/phases/1/output/maxBytes",
    );
  });

  it("takes the completion evidence policy from the author", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    completionEvidence:\n      mode: task\n      require:\n        - kind: task-completion\n          min: 2\n",
      ),
    );
    expect(lowered.diagnostics).toEqual([]);
    const phases = (
      lowered.document as unknown as { readonly phases: readonly Record<string, never>[] }
    ).phases;
    expect(phases[1]?.executor).toMatchObject({
      completionPolicy: {
        completionEvidencePolicy: {
          mode: "task",
          requirements: [{ kind: "task-completion", minimumCount: 2 }],
        },
      },
    });
  });

  it("refuses requirements under a mode that collects no evidence", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output: schemas/verification.schema.json\n    completionEvidence:\n      mode: none\n      require:\n        - kind: task-completion\n",
      ),
    );
    // Promising evidence a gate never collects would read as a guarantee.
    expect(lowered.diagnostics.map(({ pointer }) => pointer)).toContain(
      "/phases/1/completionEvidence/mode",
    );
  });

  it("derives prompt input paths from the template rather than the author", () => {
    const document = lowerAuthoredWorkflow(authored()).document as
      | { readonly prompts: readonly { readonly key: string; readonly inputPaths: string[] }[] }
      | undefined;
    expect(document?.prompts).toEqual([
      { key: "definer", path: "prompts/definer.md", inputPaths: ["/request"] },
      { key: "verifier", path: "prompts/verifier.md", inputPaths: ["/definition"] },
    ]);
  });

  it("names the file, path, and reason when an authored reference is wrong", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      workflow: {
        path: "workflow.yaml",
        text: WORKFLOW.replace("agent: verifier", "agent: absent").replace(
          "gates: [tests]",
          "gates: [absent-sensor]",
        ),
      },
    });
    expect(lowered.diagnostics).toEqual([
      {
        code: "unknown-reference",
        locator: "workflow.yaml",
        pointer: "/phases/1/agent",
        message: "Unknown agent absent",
      },
      {
        code: "unknown-reference",
        locator: "workflow.yaml",
        pointer: "/phases/1/gates/0",
        message: "Unknown gate or sensor absent-sensor",
      },
    ]);
  });

  it("requires an input schema only when a phase reads more than one upstream output", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      workflow: {
        path: "workflow.yaml",
        text: `${WORKFLOW}  - name: report
    agent: verifier
    needs: [define, verify]
    output: schemas/report.schema.json
`,
      },
    });
    expect(lowered.diagnostics).toEqual([
      {
        code: "missing-field",
        locator: "workflow.yaml",
        pointer: "/phases/2/input",
        message: "Phase report reads 2 upstream outputs, so it must declare an input schema",
      },
    ]);
  });

  it("refuses a fan-out that reads a phase the author did not declare in needs", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      workflow: {
        path: "workflow.yaml",
        text: WORKFLOW.replace("needs: [define]", "forEach: define.items"),
      },
    });
    expect(lowered.diagnostics).toContainEqual({
      code: "unknown-reference",
      locator: "workflow.yaml",
      pointer: "/phases/1/forEach",
      message: "forEach reads phase define which is absent from needs",
    });
  });

  it("refuses a blocking gate whose sensor cannot anchor it", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      sensors: {
        path: "sensors.yaml",
        text: "sensors:\n  tests:\n    run: pnpm test\n    deterministic: false\n",
      },
    });
    expect(lowered.diagnostics).toContainEqual({
      code: "invalid-gate",
      locator: "workflow.yaml",
      pointer: "/phases/1/gates/0",
      message: "Sensor tests is not deterministic, so it cannot anchor a blocking gate",
    });
  });

  it("reports a YAML syntax error against the file that carries it", () => {
    const lowered = lowerAuthoredWorkflow({
      ...authored(),
      sensors: { path: "sensors.yaml", text: "sensors:\n  tests:\n   run: [unclosed\n" },
    });
    expect(lowered.diagnostics.some(({ locator }) => locator === "sensors.yaml")).toBe(true);
    expect(lowered.document).toBeUndefined();
  });
});

function authored() {
  return {
    agents: { path: "agents.yaml", text: AGENTS },
    workflow: { path: "workflow.yaml", text: WORKFLOW },
    sensors: { path: "sensors.yaml", text: SENSORS },
    prompts: PROMPTS,
  };
}

/** The same project with one phase's body replaced, for policy cases. */
function authoredWithVerify(body: string) {
  return {
    ...authored(),
    workflow: {
      path: "workflow.yaml",
      text: `${WORKFLOW.slice(0, WORKFLOW.indexOf("  - name: verify"))}  - name: verify\n    agent: verifier\n    needs: [define]\n${body}`,
    },
  };
}

function reader(): ConfigurationResourceReader {
  const schema = (id: string) =>
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: id,
      type: "object",
      additionalProperties: true,
    });
  const resources: Readonly<Record<string, string>> = {
    "prompts/definer.md": PROMPTS.get("prompts/definer.md") ?? "",
    "prompts/verifier.md": PROMPTS.get("prompts/verifier.md") ?? "",
    "schemas/request.schema.json": schema("urn:senawa:request"),
    "schemas/definition.schema.json": schema("urn:senawa:definition"),
    "schemas/verification.schema.json": schema("urn:senawa:verification"),
  };
  return {
    async read({ path, maxBytes }) {
      const text = resources[path];
      if (text === undefined) throw new Error(`missing fixture resource ${path}`);
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maxBytes) throw new Error("oversized fixture resource");
      return bytes;
    },
  };
}
