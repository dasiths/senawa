import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CopilotSerialWorkerAdapter, ProductionCopilotSdkPort } from "@senawa/execution-host";
import { canonicalValue, sha256Digest } from "@senawa/kernel";
import { SqliteAuthority, SqliteContextBroker } from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { describe, expect, it } from "vitest";
import { type AdvanceOutcome, advanceRun } from "./advance-run.js";
import { BASE, dependencies, NOW } from "./brief-scenarios.js";
import { configurationPhaseOutputSchemas } from "./dataflow-composition.js";
import { answerQuestion } from "./decide.js";
import { listArtifacts } from "./inspect.js";
import { startAuthoredRun } from "./start-run.js";

// Opt in, because this spends model credits. Everything about the loop is proven
// without a model by the scripted scenarios. What this adds is a whole authored
// workflow driven by a real agent, from a clean directory to a finished run.
const live = process.env.SENAWA_COPILOT_LIVE === "1";
const model = process.env.SENAWA_COPILOT_MODEL ?? "claude-haiku-4.5";
const timeoutMs = Number(process.env.SENAWA_COPILOT_TIMEOUT_MS ?? 240_000);

const AGENTS = `
planner:
  prompt: prompts/planner.md
  model: ${model}
  credits: 40
`;

const WORKFLOW = `
name: delivery
input: schemas/request.schema.json
phases:
  - name: plan
    agent: planner
    output: schemas/plan.schema.json
`;

const SENSORS = "sensors: {}\n";

// The assignment is answerable from the request alone. An agent that has to ask
// is a fair outcome for the protocol but a poor one for this test, which is
// about whether a workflow can be driven to completion rather than about how a
// model handles ambiguity.
const PLANNER_PROMPT = `Break the requested change into ordered steps.

Answer only from the request text. Do not read the repository, and do not ask for
more detail: the request is the whole assignment.

Request: \${{ input.request }}
`;

const SCHEMAS: Readonly<Record<string, unknown>> = {
  "request.schema.json": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:senawa:live-request",
    type: "object",
    required: ["request"],
    properties: { request: { type: "string" } },
    additionalProperties: false,
  },
  "plan.schema.json": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:senawa:live-plan",
    type: "object",
    required: ["summary", "steps"],
    properties: {
      summary: { type: "string" },
      steps: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    additionalProperties: false,
  },
};

async function authoredProject(root: string): Promise<void> {
  const configuration = join(root, ".senawa");
  await mkdir(join(configuration, "prompts"), { recursive: true });
  await mkdir(join(configuration, "schemas"), { recursive: true });
  await writeFile(join(configuration, "agents.yaml"), AGENTS);
  await writeFile(join(configuration, "workflow.yaml"), WORKFLOW);
  await writeFile(join(configuration, "sensors.yaml"), SENSORS);
  await writeFile(join(configuration, "prompts", "planner.md"), PLANNER_PROMPT);
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    await writeFile(join(configuration, "schemas", name), `${JSON.stringify(schema, null, 2)}\n`);
  }
}

describe.skipIf(!live)("a real agent driven by an authored workflow", () => {
  it(
    "runs a project from clean directory to finished run",
    async () => {
      if (process.env.SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA !== "1") {
        throw new Error("A live run requires explicit cost and data acknowledgement");
      }
      const isolated = await mkdtemp(join(tmpdir(), "senawa-live-run-"));
      const project = await mkdtemp(join(isolated, "project-"));
      const workingDirectory = await mkdtemp(join(isolated, "work-"));
      const baseDirectory = await mkdtemp(join(isolated, "home-"));
      await authoredProject(project);

      const paths = {
        databasePath: join(project, "authority.db"),
        assetDirectory: join(project, "assets"),
      };
      const identity = { repositoryId: "repository_live", runId: "run_live" };
      const request = canonicalValue({
        request: "Add a health endpoint that returns the service name and uptime.",
      });

      const started = await startAuthoredRun({
        projectRoot: project,
        ...paths,
        dependencies,
        ...identity,
        principal: runtimePrincipal,
        input: request,
        currentTime: NOW,
        repositoryBase: BASE,
      });

      const port = await ProductionCopilotSdkPort.create({
        repositoryDirectory: workingDirectory,
        workingDirectory,
        baseDirectory,
        allowRepositoryWorkingDirectory: true,
      });

      const advance = (): Promise<AdvanceOutcome> =>
        advanceRun({
          projectRoot: project,
          ...paths,
          ...identity,
          principal: runtimePrincipal,
          dependencies,
          currentTime: NOW,
          workflowInput: { bindingDigest: sha256Digest("3".repeat(64)), value: request },
          repositoryBase: BASE,
        });

      const work = async (dispatchId: string): Promise<string> => {
        const broker = new SqliteContextBroker({
          databasePath: paths.databasePath,
          dependencies: {
            sha256: dependencies.sha256,
            currentTime: () => NOW,
            issueGrantToken: () => new Uint8Array(32),
          },
        });
        try {
          const stored = broker
            .listWorkerDispatches(identity.repositoryId, identity.runId)
            .find((entry) => entry.dispatch.dispatchId === dispatchId);
          if (stored === undefined) throw new Error(`no dispatch ${dispatchId}`);
          const authority = new SqliteAuthority({ ...paths, dependencies });
          const schemas = configurationPhaseOutputSchemas(
            (digest) => authority.getConfigurationSnapshot(digest),
            dependencies.sha256,
          ).resolve(stored);
          authority.close();
          const result = await new CopilotSerialWorkerAdapter(port, dependencies.sha256).run({
            broker,
            context: stored.context,
            dispatch: stored.dispatch,
            phaseOutputSchemas: schemas,
            transcript: broker.transcript,
            grantTokens: new Map(),
            routeSelection: started.routeSelection,
            workingDirectory,
            sessionBaseDirectory: baseDirectory,
            timeoutMs,
          });
          return result.status;
        } finally {
          broker.close();
        }
      };

      try {
        const statuses: string[] = [];
        statuses.push(await work(started.dispatchId));

        // A real agent may stop to ask before it can finish. Answering and
        // carrying on is the loop this run exists to prove, not a failure.
        let outcome = await advance();
        for (let step = 0; step < 8 && outcome.kind !== "finished"; step += 1) {
          if (outcome.kind === "awaiting-agent") {
            const answered = answerQuestion({
              ...paths,
              ...identity,
              answer: "Assume a Node.js HTTP service. Plan the work from the request alone.",
              principal: runtimePrincipal,
              dependencies,
              currentTime: NOW,
            });
            if (answered.exitCode !== 0) break;
            outcome = await advance();
            continue;
          }
          if (outcome.kind === "dispatched" || outcome.kind === "retrying") {
            statuses.push(await work(outcome.dispatchId));
          }
          outcome = await advance();
        }

        expect(statuses).toContain("completed");
        expect(outcome).toEqual({ kind: "finished" });

        // Nothing from the run is still in memory here. Every handle used above
        // is gone, and these read the same paths from disk, which is all a
        // restarted process would have.
        const listed = listArtifacts({ ...paths, ...identity, dependencies, currentTime: NOW });
        expect(listed.exitCode).toBe(0);
        expect(listed.output).not.toBe("no artifacts yet");

        const database = new DatabaseSync(paths.databasePath, { readOnly: true });
        try {
          const row = database
            .prepare("SELECT COUNT(*) AS total FROM agent_transcript_lines")
            .get() as { readonly total: number };
          expect(row.total).toBeGreaterThan(0);
        } finally {
          database.close();
        }
      } finally {
        if (port.clientOwnership === "port-created") await port.stopOwnedClient();
      }
    },
    timeoutMs * 4,
  );
});
