import { resolve } from "node:path";
import type { ConfigurationSnapshot } from "@senawa/configuration";
import {
  compileWorkflowConfiguration,
  createStandardWorkflowConfiguration,
  createStandardWorkflowResources,
} from "@senawa/configuration";
import { loadAuthoredWorkflow } from "@senawa/execution-host";
import { describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";

const projectRoot = resolve(import.meta.dirname, "../../..");

/**
 * Compares the authored surface against the internal template it replaces.
 *
 * F-004 asked whether authored YAML gives up anything the old internal template
 * expressed. Counting lines cannot answer that, and comparing the two documents
 * phase by phase answers the wrong question: they are different workflows, so
 * they differ in how many attempts they allow and where they ask for approval
 * without either having lost anything.
 *
 * What matters is the vocabulary. For every mechanism the template reaches for,
 * the authored tree has to reach for it too, or that mechanism is unreachable
 * from YAML and the replacement is not a replacement.
 */

type Fields = Record<string, never>;

const asRecord = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null ? (value as Fields) : undefined;

const listOf = (value: unknown): readonly Fields[] =>
  Array.isArray(value) ? (value as readonly Fields[]) : [];

/**
 * The set of mechanisms a compiled workflow actually uses.
 *
 * Derived from the document rather than listed by hand, because a hand-written
 * list only ever checks what somebody remembered to write down.
 */
function vocabulary(snapshot: ConfigurationSnapshot): ReadonlySet<string> {
  const used = new Set<string>();
  for (const entry of snapshot.phaseDataflow) {
    const phase = entry.value as unknown as Fields;
    const exit = asRecord(phase.exit);
    const iteration = asRecord(phase.iteration);
    const completion = asRecord(phase.completionPolicy);

    used.add(`executor:${String(asRecord(phase.executor)?.kind ?? "none")}`);
    if (iteration?.onGateRejected !== undefined)
      used.add(`on-gate-rejected:${String(iteration.onGateRejected)}`);
    if (iteration?.onApprovalRejected !== undefined)
      used.add(`on-approval-rejected:${String(iteration.onApprovalRejected)}`);
    if (Number(iteration?.maximumAttempts ?? 1) > 1) used.add("iteration:retries");

    const approval = asRecord(exit?.approval);
    if (approval?.policy !== undefined) used.add(`approval:${String(approval.policy)}`);
    if (asRecord(approval?.authority)?.role !== undefined) used.add("approval:role-bound");

    for (const output of listOf(phase.outputs)) {
      used.add(`sensitivity:${String(output.sensitivity)}`);
    }

    const evidence = asRecord(completion?.completionEvidencePolicy);
    if (evidence?.mode !== undefined) used.add(`evidence:${String(evidence.mode)}`);
    for (const requirement of listOf(evidence?.requirements)) {
      used.add(`evidence-requirement:${String(requirement.kind)}`);
    }

    const gateKey = exit?.gate;
    if (gateKey === undefined) continue;
    used.add("gate:declared");
    const gate = snapshot.gates.find((candidate) => candidate.key === gateKey);
    const definition = asRecord(asRecord(gate?.value)?.definition);
    if (listOf(definition?.blocking).length > 0) used.add("gate:blocking");
    if (listOf(definition?.advisory).length > 0) used.add("gate:advisory");
    for (const rule of [...listOf(definition?.blocking), ...listOf(definition?.advisory)]) {
      const operator = asRecord(rule.condition)?.operator;
      if (operator !== undefined) used.add(`gate-operator:${String(operator)}`);
    }
  }
  if (snapshot.forEach.length > 0) used.add("fan-out:declared");
  if (snapshot.sensors.length > 0) used.add("sensor:declared");
  for (const policy of snapshot.modelPolicies) {
    const routes = listOf(asRecord(policy.value)?.routes);
    if (routes.length > 0) used.add("model:route");
    if (routes.length > 1) used.add("model:fallback-route");
    for (const route of routes) {
      if (route.maxTurns !== undefined) used.add("model:max-turns");
      if (route.maxSubmissions !== undefined) used.add("model:max-submissions");
      if (route.maxMillidollars !== undefined) used.add("model:max-spend");
    }
  }
  return used;
}

async function authored(): Promise<ConfigurationSnapshot> {
  const loaded = await loadAuthoredWorkflow(projectRoot, runtimeDependencies.sha256);
  if (loaded.snapshot === undefined) throw new Error("the authored tree must compile");
  return loaded.snapshot;
}

async function internal(): Promise<ConfigurationSnapshot> {
  const resources = createStandardWorkflowResources();
  return await compileWorkflowConfiguration(
    {
      document: createStandardWorkflowConfiguration(),
      locator: "internal://standard-template",
      resources: {
        read: ({ path }: { readonly path: string }) => {
          const content = resources[path];
          if (content === undefined) throw new Error(`missing ${path}`);
          return Promise.resolve(new TextEncoder().encode(content));
        },
      },
    },
    runtimeDependencies.sha256,
  );
}

describe("authored YAML against the internal template it replaces", () => {
  it("reaches for every mechanism the internal template reaches for", async () => {
    const [left, right] = await Promise.all([authored(), internal()]);
    const reachable = vocabulary(left);
    const missing = [...vocabulary(right)].filter((term) => !reachable.has(term)).sort();

    // Anything listed here is a mechanism the template can express and the
    // authored tree cannot, which is exactly what F-004 asked about.
    expect(missing).toEqual([]);
  });

  it("measures something, so two empty vocabularies cannot pass as parity", async () => {
    // Comparing two empty sets succeeds while proving nothing. This is the
    // guard: the first version of this comparison read gates from the wrong
    // field, reported none for either document, and looked like agreement.
    const [left, right] = await Promise.all([authored(), internal()]);
    for (const snapshot of [left, right]) {
      const terms = vocabulary(snapshot);
      expect(terms.size).toBeGreaterThan(10);
      expect([...terms].filter((term) => term.startsWith("gate:"))).not.toEqual([]);
    }
  });
});
