import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthoredWorkflow } from "@senawa/execution-host";
import {
  type CanonicalValue,
  canonicalBytes,
  canonicalDigest,
  canonicalValue,
  sha256Digest,
} from "@senawa/kernel";
import {
  createRoleAuthorizationPolicy,
  DEFAULT_PROMPT_PACK_MAX_BYTES,
  type RuntimeDependencies,
  renderPromptPack,
  SimulatedSerialWorkerAdapter,
} from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
} from "@senawa/storage-sqlite";
import { runtimePrincipal } from "@senawa/testing";
import { runtimeDependencies as productionDependencies } from "./daemon.js";
import { runtimeSchemaContract } from "./dataflow-composition.js";
import { type StartedAuthoredRun, startAuthoredRun } from "./start-run.js";
import { BrokerWorkerSubmissionSink } from "./worker-submission-sink.js";

export const NOW = "2026-08-18T00:00:00.000Z";
export const BASE = {
  commitDigest: sha256Digest("1".repeat(64)),
  treeDigest: sha256Digest("2".repeat(64)),
};

export const dependencies: RuntimeDependencies = {
  sha256: productionDependencies.sha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "submit-completion", roles: ["release-manager"] },
    { intent: "evaluate-gate", roles: ["release-manager"] },
    { intent: "record-authority-decision", roles: ["release-manager"] },
    { intent: "close-phase", roles: ["release-manager"] },
    { intent: "start-phase-attempt", roles: ["release-manager"] },
    { intent: "create-escalation", roles: ["release-manager"] },
    { intent: "steer-agent", roles: ["operator", "release-manager"] },
    { intent: "override-member", roles: ["release-manager"] },
    { intent: "submit-amendment-proposal", roles: ["engine", "release-manager"] },
    { intent: "record-amendment-decision", roles: ["engine", "release-manager"] },
    { intent: "apply-approved-amendment", roles: ["trusted-supervisor"] },
  ]),
};

export interface ScenarioOptions {
  /** The command the gate's sensor runs. `false` makes the gate refuse. */
  readonly sensorCommand?: string;
  /** Adds a second phase that depends on the first. */
  readonly secondPhase?: boolean;
  /** Makes the phase wait for a person before it closes. */
  readonly approval?: boolean;
  /** Refuses any output that is not an object with a boolean `verified`. */
  readonly strictOutput?: boolean;
  /** Adds a fan-out phase, optionally omitting the element schema it needs. */
  readonly fanOut?: "complete" | "no-item-schema";
  /** Adds an advisory rule alongside the blocking one. */
  readonly advisory?: boolean;
  /** Declares a gate with no deterministic sensor behind it. */
  readonly unanchored?: boolean;
  /** How many attempts the phase may take. */
  readonly attempts?: number;
  /** Adds a field the reader does not know, to check it is refused. */
  readonly unknownField?: boolean;
  /** Stops the run on the first failing member instead of continuing. */
  readonly failFast?: boolean;
  /** Authors `onFailure: continue`, which the default is not. */
  readonly continueOnFailure?: boolean;
  /** Fans out over a phase that already fans out. */
  readonly nestedFanOut?: boolean;
  /** Authors an ordered route list with explicit per-route limits on `definer`. */
  readonly routeLimits?: boolean;
  /** Requires completion evidence of a named kind before the phase can close. */
  readonly requireEvidence?: number;
  /** Declares the phase output confidential rather than the default internal. */
  readonly confidentialOutput?: boolean;
  /** Gives `definer` a session of this scope, and a second phase to work on. */
  readonly session?: "run" | "phase" | "element";
  /** Bounds how many turns one conversation carries before it is renewed. */
  readonly sessionTurns?: number;
  /** Authors where agents work and how many of them write at once. */
  readonly execution?: string;
  /** The model every agent runs on. Only a live run needs one that exists. */
  readonly model?: string;
}

export interface Scenario {
  readonly project: string;
  readonly paths: { readonly databasePath: string; readonly assetDirectory: string };
  readonly repositoryId: string;
  readonly runId: string;
}

const roots = new Set<string>();

export async function disposeScenarios(): Promise<void> {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
}

/** Compiles an authored project without starting a run, for authoring refusals. */
export async function compileScenario(
  options: ScenarioOptions,
): Promise<readonly { readonly code: string; readonly message: string }[]> {
  const project = await authoredProject(options);
  const loaded = await loadAuthoredWorkflow(project, dependencies.sha256);
  return loaded.diagnostics ?? [];
}

/** Compiles an authored project and returns its snapshot, for lowering checks. */
export async function compileSnapshot(options: ScenarioOptions): Promise<unknown> {
  const project = await authoredProject(options);
  const loaded = await loadAuthoredWorkflow(project, dependencies.sha256);
  if (loaded.snapshot === undefined) throw new Error("Scenario workflow does not compile");
  return loaded.snapshot;
}

/** Builds an authored project and starts a run against it. */
export async function startScenario(
  name: string,
  options: ScenarioOptions = {},
): Promise<
  Scenario & {
    readonly dispatchId: string;
    readonly phaseKey: string;
    readonly routeSelection: StartedAuthoredRun["routeSelection"];
  }
> {
  const project = await authoredProject(options);
  const scenario: Scenario = {
    project,
    paths: {
      databasePath: join(project, "authority.db"),
      assetDirectory: join(project, "assets"),
    },
    repositoryId: `repository_${name}`,
    runId: `run_${name}`,
  };
  const started = await startAuthoredRun({
    projectRoot: project,
    ...scenario.paths,
    dependencies,
    repositoryId: scenario.repositoryId,
    runId: scenario.runId,
    principal: runtimePrincipal,
    input: canonicalValue({ request: "Add a health endpoint" }),
    currentTime: NOW,
    repositoryBase: BASE,
  });
  return {
    ...scenario,
    dispatchId: started.dispatchId,
    phaseKey: started.phaseKey,
    routeSelection: started.routeSelection,
  };
}

export interface SubmissionResult {
  readonly status: string;
  readonly reason?: string;
}

/**
 * Runs one scripted agent turn against a dispatch.
 *
 * `output` is submitted as the phase output. Passing a value the schema refuses
 * is how the schema-violation branch of the brief is exercised.
 */
export async function agentTurn(
  scenario: Scenario,
  dispatchId: string,
  output: CanonicalValue,
  options: {
    readonly omitOutput?: boolean;
    readonly omitCompletion?: boolean;
    /** Hands in a completion the agent itself says it could not finish. */
    readonly blocked?: boolean;
  } = {},
): Promise<SubmissionResult> {
  const loaded = await loadAuthoredWorkflow(scenario.project, dependencies.sha256);
  const snapshot = loaded.snapshot;
  if (snapshot === undefined) throw new Error("Scenario workflow does not compile");
  const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
  const assets = new SqliteCanonicalJsonAssetStore(authority);
  const broker = new SqliteContextBroker({
    databasePath: scenario.paths.databasePath,
    dependencies: {
      sha256: dependencies.sha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const stored = broker
      .listWorkerDispatches(scenario.repositoryId, scenario.runId)
      .find((entry) => entry.dispatch.dispatchId === dispatchId);
    if (stored === undefined) throw new Error("Dispatch was not stored");
    const declaration = stored.context.phaseOutputDeclarations[0];
    if (declaration === undefined) throw new Error("Phase declares no output");
    const installed = assets.install(output);
    const contract = runtimeSchemaContract(
      snapshot,
      String(declaration.schemaKey),
      dependencies.sha256,
    );
    const receipt = canonicalDigest(
      canonicalValue({
        boundary: "phase output",
        schemaKey: String(contract.key),
        schemaResourceDigest: String(contract.schemaResourceDigest),
        validatorProfileDigest: String(contract.validatorProfileDigest),
        contentDigest: String(installed.contentDigest),
        findings: [],
      }),
      dependencies.sha256,
    );
    broker.installCanonicalOutputAsset(
      {
        contentDigest: installed.contentDigest,
        byteLength: installed.byteLength,
        mediaType: "application/json",
        schemaResourceDigest: declaration.schemaResourceDigest,
        validationReceiptDigest: receipt,
      },
      canonicalBytes(output),
    );
    const suffix = dispatchId.replace("dispatch_", "").slice(0, 30);
    let refusal: string | undefined;
    const result = await new SimulatedSerialWorkerAdapter(broker).run(
      { dispatch: stored.dispatch },
      (session) => {
        try {
          if (options.omitOutput !== true) {
            session.submitOutput(`submission_${suffix}o`, {
              phase: stored.context.phaseAttempt.phase,
              outputName: declaration.outputName,
              schemaKey: declaration.schemaKey,
              schemaResourceDigest: declaration.schemaResourceDigest,
              contentDigest: installed.contentDigest,
              byteLength: installed.byteLength,
              mediaType: "application/json",
              sensitivity: declaration.sensitivity,
              graphRevisionDigest: stored.context.graphRevisionDigest,
              configurationSnapshotDigest: stored.context.configurationSnapshotDigest,
              inputBindingDigest: stored.context.phaseInputBinding.bindingDigest,
              validationReceiptDigest: receipt,
            });
          }
          if (options.omitCompletion !== true) {
            session.complete(`submission_${suffix}c`, {
              task: stored.dispatch.task,
              disposition: options.blocked === true ? "blocked" : "completed",
              summary: options.blocked === true ? "Could not finish" : "Scripted work",
              criteria: stored.completionRequirements.criteria.map(({ criterionId }) => ({
                criterionId,
                disposition:
                  options.blocked === true ? ("unsatisfied" as const) : ("satisfied" as const),
              })),
              completionEvidence: [],
            });
          }
        } catch (error) {
          refusal = error instanceof Error ? error.message : "refused";
          throw error;
        }
      },
    );
    return refusal === undefined
      ? { status: result.status }
      : { status: result.status, reason: refusal };
  } finally {
    broker.close();
    authority.close();
  }
}

/** The prompt pack a dispatch was rendered with, as the agent receives it. */
export async function promptPackText(scenario: Scenario, dispatchId: string): Promise<string> {
  const broker = new SqliteContextBroker({
    databasePath: scenario.paths.databasePath,
    dependencies: {
      sha256: dependencies.sha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const stored = broker
      .listWorkerDispatches(scenario.repositoryId, scenario.runId)
      .find((entry) => entry.dispatch.dispatchId === dispatchId);
    if (stored === undefined) throw new Error("Dispatch was not stored");
    const pack = renderPromptPack(
      stored.context,
      stored.dispatch,
      dependencies.sha256,
      DEFAULT_PROMPT_PACK_MAX_BYTES,
    );
    return await Promise.resolve(new TextDecoder().decode(pack.utf8Bytes));
  } finally {
    broker.close();
  }
}

/**
 * Runs one turn through the sink a real agent reaches over the worker channel.
 *
 * `agentTurn` drives the broker directly, which skips schema validation,
 * evidence ingestion, and the atomicity the complete request promises. This
 * exercises the path `senawa worker complete` actually takes.
 */
export async function completeThroughSink(
  scenario: Scenario,
  dispatchId: string,
  outputs: readonly { readonly name: string; readonly value: CanonicalValue }[],
  completionEvidence: readonly {
    readonly kind: string;
    readonly path: string;
    readonly content: string;
    readonly criterionId?: string;
  }[] = [],
): Promise<SubmissionResult> {
  const loaded = await loadAuthoredWorkflow(scenario.project, dependencies.sha256);
  const snapshot = loaded.snapshot;
  if (snapshot === undefined) throw new Error("Scenario workflow does not compile");
  const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
  const broker = new SqliteContextBroker({
    databasePath: scenario.paths.databasePath,
    dependencies: {
      sha256: dependencies.sha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const sink = new BrokerWorkerSubmissionSink({
      broker,
      assets: new SqliteCanonicalJsonAssetStore(authority),
      loadSnapshot: () => snapshot,
      readSteerings: (dispatchId) => authority.listAgentSteerings(dispatchId),
      sha256: dependencies.sha256,
    });
    await sink.accept({
      submissionId: `submission_${dispatchId.replace("dispatch_", "").slice(0, 30)}s`,
      scope: {
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
        dispatchId,
      } as never,
      submission: { kind: "complete", outputs, completionEvidence, summary: "Scripted work" },
    });
    return { status: "accepted" };
  } catch (error) {
    return { status: "refused", reason: error instanceof Error ? error.message : "refused" };
  } finally {
    broker.close();
    authority.close();
  }
}

/** Asks a question through the real agent channel, and returns what came back. */
export async function askThroughSink(
  scenario: Scenario,
  dispatchId: string,
  question: string,
): Promise<unknown> {
  const loaded = await loadAuthoredWorkflow(scenario.project, dependencies.sha256);
  const snapshot = loaded.snapshot;
  if (snapshot === undefined) throw new Error("Scenario workflow does not compile");
  const authority = new SqliteAuthority({ ...scenario.paths, dependencies });
  const broker = new SqliteContextBroker({
    databasePath: scenario.paths.databasePath,
    dependencies: {
      sha256: dependencies.sha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const sink = new BrokerWorkerSubmissionSink({
      broker,
      assets: new SqliteCanonicalJsonAssetStore(authority),
      loadSnapshot: () => snapshot,
      readSteerings: (id) => authority.listAgentSteerings(id),
      sha256: dependencies.sha256,
    });
    return await sink.accept({
      submissionId: `submission_${dispatchId.replace("dispatch_", "").slice(0, 30)}q`,
      scope: {
        repositoryId: scenario.repositoryId,
        runId: scenario.runId,
        dispatchId,
      } as never,
      submission: { kind: "question", question } as never,
    });
  } finally {
    broker.close();
    authority.close();
  }
}

const AGENTS_ROUTED = `
definer:
  models:
    - model: gpt-5
      turns: 7
      submissions: 3
      spend: 250
    - model: gpt-5-mini
      turns: 2
  prompt: prompts/definer.md

verifier:
  model: gpt-5
  prompt: prompts/verifier.md
`;

const AGENTS = `
definer:
  model: gpt-5
  prompt: prompts/definer.md

verifier:
  model: gpt-5
  prompt: prompts/verifier.md
`;

async function authoredProject(options: ScenarioOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-scenario-"));
  roots.add(root);
  const configuration = join(root, ".senawa");
  await mkdir(join(configuration, "prompts"), { recursive: true });
  await mkdir(join(configuration, "schemas"), { recursive: true });
  await writeFile(
    join(configuration, "agents.yaml"),
    options.model !== undefined
      ? AGENTS.replaceAll("model: gpt-5", `model: ${options.model}`)
      : options.routeLimits === true
        ? AGENTS_ROUTED
        : options.session === undefined
          ? AGENTS
          : AGENTS.replace(
              "definer:\n",
              `definer:\n  session: ${options.session}\n${
                options.sessionTurns === undefined
                  ? ""
                  : `  sessionTurns: ${options.sessionTurns}\n`
              }`,
            ),
  );
  await writeFile(join(configuration, "workflow.yaml"), workflow(options));
  await writeFile(join(configuration, "sensors.yaml"), sensors(options));
  await writeFile(
    join(configuration, "prompts", "definer.md"),
    // A persona that works two phases sees a different input in each, so a
    // template naming a field of the first would refuse in the second.
    options.session === undefined
      ? "Define the work.\n\nRequest: ${{ input.request }}\n"
      : "Define the work.\n",
  );
  await writeFile(join(configuration, "prompts", "verifier.md"), "Verify the work.\n");
  for (const [name, id] of [
    ["request.schema.json", "urn:senawa:request"],
    ["definition.schema.json", "urn:senawa:definition"],
    ["verification.schema.json", "urn:senawa:verification"],
  ]) {
    const strict = options.strictOutput === true && name === "definition.schema.json";
    await writeFile(
      join(configuration, "schemas", String(name)),
      `${JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: id,
        type: "object",
        ...(strict
          ? {
              required: ["verified"],
              properties: { verified: { type: "boolean" } },
              additionalProperties: false,
            }
          : { additionalProperties: true }),
      })}\n`,
    );
  }
  await writeFile(
    join(configuration, "schemas", "tasks.schema.json"),
    `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:tasks",
      type: "array",
      items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    })}\n`,
  );
  await writeFile(
    join(configuration, "schemas", "task.schema.json"),
    `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:task",
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: true,
    })}\n`,
  );
  return root;
}

function fanOutPhase(options: ScenarioOptions): string {
  if (options.fanOut === undefined && options.nestedFanOut !== true) return "";
  const first = `
  - name: implement
    agent: verifier
    needs: [define]
    forEach: define.tasks
    collection: schemas/tasks.schema.json
    input: schemas/task.schema.json
    output: schemas/verification.schema.json${
      options.failFast === true
        ? "\n    onFailure: fail-fast"
        : options.continueOnFailure === true
          ? "\n    onFailure: continue"
          : ""
    }
`;
  if (options.nestedFanOut === true) {
    return `${first}
  - name: review
    agent: verifier
    needs: [implement]
    forEach: implement.tasks
    collection: schemas/tasks.schema.json
    input: schemas/task.schema.json
    output: schemas/verification.schema.json
`;
  }
  return options.fanOut === "complete"
    ? first
    : first.replace("    input: schemas/task.schema.json\n", "");
}

function workflow(options: ScenarioOptions): string {
  const second =
    options.session !== undefined
      ? `
  - name: verify
    agent: definer
    needs: [define]
    output: schemas/verification.schema.json
`
      : options.secondPhase === true
        ? `
  - name: verify
    agent: verifier
    needs: [define]
    output: schemas/verification.schema.json
    gates: [check]
`
        : "";
  return `
name: delivery
input: schemas/request.schema.json${options.execution === undefined ? "" : `\n${options.execution}`}
phases:
  - name: define
    agent: definer
    output: ${
      options.confidentialOutput === true
        ? "\n      schema: schemas/definition.schema.json\n      sensitivity: confidential"
        : "schemas/definition.schema.json"
    }
    gates: [check]${options.unknownField === true ? "\n    aproove: true" : ""}${options.approval === true ? "\n    approve: true" : ""}${
      options.attempts === undefined ? "" : `\n    attempts: ${options.attempts}`
    }${
      options.requireEvidence === undefined
        ? ""
        : `\n    completionEvidence:\n      mode: task\n      require:\n        - kind: definition-note\n          min: ${options.requireEvidence}`
    }
${second}${fanOutPhase(options)}`;
}

function sensors(options: ScenarioOptions): string {
  const advisory =
    options.advisory === true
      ? `    advisory:
      - sensor: opinion
        exitCode: 0
`
      : "";
  const opinion =
    options.advisory === true || options.unanchored === true
      ? `  opinion:
    run: "false"
    deterministic: false
`
      : "";
  const blocking = options.unanchored === true ? "opinion" : "measure";
  return `sensors:
  measure:
    run: "${options.sensorCommand ?? "true"}"
    deterministic: true
${opinion}
gates:
  check:
    blocking:
      - sensor: ${blocking}
        exitCode: 0
${advisory}`;
}
