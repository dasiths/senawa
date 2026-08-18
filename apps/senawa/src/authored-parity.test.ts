import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAuthoredTemplateFiles } from "@senawa/configuration";
import { loadAuthoredWorkflow } from "@senawa/execution-host";
import { describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";

const projectRoot = resolve(import.meta.dirname, "../../..");

/**
 * The repository's own `.senawa` tree is the parity fixture.
 *
 * Phase 1 measured the authored surface by counting lines, which cannot tell a
 * derived value from a removed one. This measures it against a real workload
 * instead: senawa's own five-phase workflow, with everything the old internal
 * template expressed.
 */
describe("the authored workflow senawa ships for itself", () => {
  it("compiles with no diagnostics", async () => {
    const loaded = await loadAuthoredWorkflow(projectRoot, runtimeDependencies.sha256);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.snapshot).toBeDefined();
  });

  it("expresses every capability the old internal template did", async () => {
    const snapshot = (await loadAuthoredWorkflow(projectRoot, runtimeDependencies.sha256)).snapshot;
    if (snapshot === undefined) throw new Error("the authored tree must compile");

    expect(snapshot.graph.nodes.filter(({ kind }) => kind === "phase")).toHaveLength(5);
    expect(snapshot.forEach.map(({ key }) => key)).toEqual(["implement-items"]);

    const phases = snapshot.phaseDataflow;
    const phase = (key: string) =>
      phases.find((entry) => entry.key === key)?.value as unknown as Record<string, never>;

    // Fan-out lowers to a task frontier over the planned collection.
    expect(phase("implement")?.executor).toMatchObject({ kind: "task-frontier" });
    // A fan-out member's completion policy lives on its task template, and the
    // evidence mode there is the one the author wrote.
    const template = snapshot.taskTemplates.find((entry) => entry.key === "implement-work")
      ?.value as unknown as Record<string, never>;
    expect(template?.completionPolicy).toMatchObject({
      completionEvidencePolicy: {
        mode: "task",
        requirements: [{ kind: "task-completion", minimumCount: 1 }],
      },
    });
    // The loop is authored, including a phase that refuses to retry.
    expect(phase("verify")?.iteration).toMatchObject({ onGateRejected: "fail" });
    expect(phase("implement")?.iteration).toMatchObject({ maximumAttempts: 5 });
    // Sensitivity reaches the output rather than being fixed at internal.
    expect(phase("verify")?.outputs).toEqual([
      expect.objectContaining({ sensitivity: "confidential" }),
    ]);
    // Approval names a role.
    expect(phase("verify")?.exit).toMatchObject({
      approval: { policy: "required", authority: { role: "release-manager" } },
    });
  });

  it("gates on a measured number and keeps an advisory reading non-blocking", async () => {
    const snapshot = (await loadAuthoredWorkflow(projectRoot, runtimeDependencies.sha256)).snapshot;
    if (snapshot === undefined) throw new Error("the authored tree must compile");
    const gate = snapshot.gates.find((entry) => entry.key === "verify-gate")?.value as unknown as {
      readonly definition: {
        readonly blocking: readonly { readonly condition: Record<string, never> }[];
        readonly advisory: readonly unknown[];
      };
    };
    const operators = gate.definition.blocking.map(({ condition }) => condition.operator);
    expect(operators).toContain("greater-than-or-equal");
    expect(gate.definition.advisory.length).toBeGreaterThan(0);
  });

  it("carries no senawa protocol text in any authored prompt", async () => {
    // Prompts describe the assignment. Senawa adds the protocol at dispatch.
    const forbidden = ["senawa worker", "senawa run-gates", "output.json", "return json"];
    for (const name of ["definer", "researcher", "planner", "implementor", "verifier"]) {
      const text = await readFile(resolve(projectRoot, ".senawa/prompts", `${name}.md`), "utf8");
      for (const phrase of forbidden) {
        expect(text.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
  });
});

/**
 * The two fixtures F-004 asked for, as projects rather than as line counts.
 *
 * The concise one is what `senawa init` scaffolds. The explicit one is the tree
 * above. Counting lines cannot tell a derived value from a removed one, so the
 * pair is measured by what each one states and what reaches the compiled graph.
 */
describe("defaults are available and overridable", () => {
  it("compiles the scaffold, which states almost no policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-concise-"));
    try {
      for (const [path, content] of Object.entries(createAuthoredTemplateFiles())) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }
      const loaded = await loadAuthoredWorkflow(root, runtimeDependencies.sha256);
      expect(loaded.diagnostics).toEqual([]);
      if (loaded.snapshot === undefined) throw new Error("the scaffold must compile");

      const authored = await readFile(join(root, ".senawa/workflow.yaml"), "utf8");
      // Nothing the scaffold omits is missing from the run: it declares no
      // iteration policy, no sensitivity, and no evidence policy, and gets the
      // documented defaults for all three.
      for (const absent of [
        "attempts:",
        "sensitivity:",
        "completionEvidence:",
        "onGateRejected:",
      ]) {
        expect(authored).not.toContain(absent);
      }
      const phase = phaseValue(loaded.snapshot, "plan");
      expect(phase.iteration).toMatchObject({ maximumAttempts: 3, onGateRejected: "iterate" });
      expect(phase.outputs[0]).toMatchObject({ sensitivity: "internal", maxBytes: 262_144 });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loses no policy in the explicit tree, because every default is overridable", async () => {
    const snapshot = (await loadAuthoredWorkflow(projectRoot, runtimeDependencies.sha256)).snapshot;
    if (snapshot === undefined) throw new Error("the authored tree must compile");
    const authored = await readFile(resolve(projectRoot, ".senawa/workflow.yaml"), "utf8");

    // Each of these is a default the explicit tree overrides. If one stopped
    // reaching the compiled document it would be authored and discarded, which
    // is the failure F-004 found four times.
    expect(authored).toContain("attempts: 5");
    expect(phaseValue(snapshot, "implement").iteration).toMatchObject({ maximumAttempts: 5 });
    expect(authored).toContain("onGateRejected: fail");
    expect(phaseValue(snapshot, "verify").iteration).toMatchObject({ onGateRejected: "fail" });
    expect(authored).toContain("sensitivity: confidential");
    expect(phaseValue(snapshot, "verify").outputs[0]).toMatchObject({
      sensitivity: "confidential",
    });
    expect(authored).toContain("role: release-manager");
    expect(phaseValue(snapshot, "verify").exit).toMatchObject({
      approval: { authority: { role: "release-manager" } },
    });
  });
});

function phaseValue(
  snapshot: NonNullable<Awaited<ReturnType<typeof loadAuthoredWorkflow>>["snapshot"]>,
  key: string,
): {
  readonly iteration?: Record<string, unknown>;
  readonly outputs: readonly Record<string, unknown>[];
  readonly exit?: Record<string, unknown>;
} {
  const entry = snapshot.phaseDataflow.find((candidate) => candidate.key === key);
  if (entry === undefined) throw new Error(`Workflow declares no phase ${key}`);
  return entry.value as never;
}
