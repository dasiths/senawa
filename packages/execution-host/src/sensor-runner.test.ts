import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileAuthoredWorkflow } from "./authored-workflow.js";
import { runSensors } from "./sensor-runner.js";

const roots = new Set<string>();
const sha256 = {
  digest(bytes: Uint8Array): string {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("running declared sensors", () => {
  it("produces a passing reading from a command that exits zero", async () => {
    const project = await authoredProject();
    const snapshot = await compileAuthoredWorkflow(project, sha256);
    const result = await runSensors({
      snapshot,
      sensorKeys: ["ok"],
      rootDirectory: project,
      sha256,
    });
    expect(result.passed).toBe(true);
    expect(result.readings).toHaveLength(1);
    expect(result.readings[0]?.outcome).toBe("succeeded");
  });

  it("refuses to pass when the command exits non-zero", async () => {
    const project = await authoredProject();
    const snapshot = await compileAuthoredWorkflow(project, sha256);
    const result = await runSensors({
      snapshot,
      sensorKeys: ["fails"],
      rootDirectory: project,
      sha256,
    });
    // A gate built on this reading must resist, which is the whole point.
    expect(result.passed).toBe(false);
    expect(result.readings[0]?.outcome).toBe("succeeded");
  });

  it("binds each reading to the command that produced it", async () => {
    const project = await authoredProject();
    const snapshot = await compileAuthoredWorkflow(project, sha256);
    const result = await runSensors({
      snapshot,
      sensorKeys: ["ok", "fails"],
      rootDirectory: project,
      sha256,
    });
    const [first, second] = result.readings;
    expect(first?.inputDigest).not.toBe(second?.inputDigest);
  });

  it("refuses a sensor the workflow does not declare", async () => {
    const project = await authoredProject();
    const snapshot = await compileAuthoredWorkflow(project, sha256);
    await expect(
      runSensors({ snapshot, sensorKeys: ["absent"], rootDirectory: project, sha256 }),
    ).rejects.toThrow(/no sensor named absent/u);
  });
});

const AGENTS = `
definer:
  model: gpt-5
  prompt: prompts/definer.md
`;

const WORKFLOW = `
name: delivery
input: schemas/request.schema.json
phases:
  - name: define
    agent: definer
    output: schemas/definition.schema.json
    gates: [ok]
`;

const SENSORS = `
sensors:
  ok:
    run: /bin/true
    deterministic: true
  fails:
    run: /bin/false
    deterministic: true
`;

async function authoredProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-sensors-"));
  roots.add(root);
  const configuration = join(root, ".senawa");
  await mkdir(join(configuration, "prompts"), { recursive: true });
  await mkdir(join(configuration, "schemas"), { recursive: true });
  await writeFile(join(configuration, "agents.yaml"), AGENTS);
  await writeFile(join(configuration, "workflow.yaml"), WORKFLOW);
  await writeFile(join(configuration, "sensors.yaml"), SENSORS);
  await writeFile(
    join(configuration, "prompts", "definer.md"),
    "Define it.\n\nRequest: ${{ input.request }}\n",
  );
  for (const name of ["request", "definition"]) {
    await writeFile(
      join(configuration, "schemas", `${name}.schema.json`),
      `${JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `urn:senawa:${name}`,
        type: "object",
        additionalProperties: true,
      })}\n`,
    );
  }
  return root;
}
