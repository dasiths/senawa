import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
      completionEvidencePolicy: { mode: "task" },
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
