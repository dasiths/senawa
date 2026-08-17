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

  it("takes output sensitivity and size from the author", () => {
    const lowered = lowerAuthoredWorkflow(
      authoredWithVerify(
        "    output:\n      schema: schemas/verification.schema.json\n      sensitivity: confidential\n      maxBytes: 4096\n",
      ),
    );
    expect(lowered.diagnostics).toEqual([]);
    const phases = (
      lowered.document as unknown as { readonly phases: readonly Record<string, never>[] }
    ).phases;
    expect(phases[1]?.outputs).toEqual([
      expect.objectContaining({ sensitivity: "confidential", maxBytes: 4096 }),
    ]);
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
        evidencePolicy: {
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
        message: "Unknown sensor absent-sensor",
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
