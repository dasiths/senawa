import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  type JsonObject,
  JsonObjectSchema,
  type RepositoryPolicy,
  RepositoryPolicySchema,
  type WorkerProfile,
  WorkerProfileSchema,
  type Workflow,
  WorkflowSchema,
} from "@senawa/domain";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SENAWA_DIRECTORY, SENAWA_SKILL_PATH } from "./repository-paths.js";

const artifactExtension = "@senawa/sensor-artifact";
const commandExtension = "@senawa/sensor-command";
const taskChangeExtension = "@senawa/sensor-task-change";
const ArtifactSensorConfigSchema = z
  .object({ artifactKind: z.enum(["phase-output", "verification-output"]) })
  .strict();
const TaskChangeSensorConfigSchema = z
  .object({ evidenceKind: z.literal("repository-delta") })
  .strict();
const CommandSensorConfigSchema = z
  .object({
    command: z.string().trim().min(1),
    parser: z.literal("raw"),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

export interface RepositoryDefinitions {
  readonly workflow: Workflow;
  readonly policy: RepositoryPolicy;
  readonly schemas: Readonly<Record<string, JsonObject>>;
  readonly skill: string;
  readonly workerProfiles: Readonly<Record<string, WorkerProfile>>;
  readonly workerProfileSources: Readonly<Record<string, string>>;
}

export async function loadRepositoryDefinitions(
  repositoryRoot: string,
  workflowName = "standard-delivery",
): Promise<RepositoryDefinitions> {
  const root = resolve(repositoryRoot);
  const workflowPath = resolve(root, SENAWA_DIRECTORY, "workflows", `${workflowName}.yaml`);
  const workflow = WorkflowSchema.parse(parseYaml(await readFile(workflowPath, "utf8")) as unknown);
  const policy = RepositoryPolicySchema.parse(
    parseYaml(await readFile(resolve(root, SENAWA_DIRECTORY, "sensors.yaml"), "utf8")) as unknown,
  );
  validatePolicyPreflight(policy);
  const { workerProfiles, workerProfileSources } = await loadWorkerProfiles(root);

  const schemaDirectory = resolve(root, SENAWA_DIRECTORY, "schemas");
  const schemaFiles = (await readdir(schemaDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map((entry) => entry.name)
    .sort();
  const schemas: Record<string, JsonObject> = {};
  const absoluteSchemaPaths = new Set<string>();
  const ajv = new Ajv2020.default({ allErrors: true, strict: true });
  addFormats.default(ajv);

  for (const schemaFile of schemaFiles) {
    const schemaPath = resolve(schemaDirectory, schemaFile);
    const schema = JsonObjectSchema.parse(
      JSON.parse(await readFile(schemaPath, "utf8")) as unknown,
    );
    ajv.compile(schema);
    schemas[toRepositoryPath(root, schemaPath)] = schema;
    absoluteSchemaPaths.add(schemaPath);
  }

  const referencedSchemas = [workflow.spec.inputSchema];
  const gateIds = new Set(policy.gates.map((gate) => gate.id));
  for (const phase of workflow.spec.phases) {
    if ("role" in phase.executor && workerProfiles[phase.executor.role] === undefined) {
      throw new Error(
        `Workflow phase ${phase.id} references missing worker profile ${phase.executor.role}`,
      );
    }
    if (phase.executor.kind === "agent") referencedSchemas.push(phase.executor.output.schema);
    if (phase.exit !== undefined && !gateIds.has(phase.exit.gate)) {
      throw new Error(`Workflow phase ${phase.id} references unknown gate ${phase.exit.gate}`);
    }
    if (phase.loop !== undefined && !gateIds.has(phase.loop.each.gate)) {
      throw new Error(`Workflow phase ${phase.id} references unknown gate ${phase.loop.each.gate}`);
    }
    if (phase.executor.kind === "sensor-only" && !gateIds.has(phase.executor.gate)) {
      throw new Error(`Workflow phase ${phase.id} references unknown gate ${phase.executor.gate}`);
    }
  }

  for (const schemaReference of referencedSchemas) {
    const schemaPath = resolve(dirname(workflowPath), schemaReference);
    if (!absoluteSchemaPaths.has(schemaPath)) {
      throw new Error(`Workflow references missing schema ${schemaReference}`);
    }
  }

  const skill = await readFile(resolve(root, SENAWA_SKILL_PATH), "utf8");
  return { workflow, policy, schemas, skill, workerProfiles, workerProfileSources };
}

function validatePolicyPreflight(policy: RepositoryPolicy): void {
  for (const sensor of policy.sensors) {
    const configSchema =
      sensor.extension === artifactExtension
        ? ArtifactSensorConfigSchema
        : sensor.extension === commandExtension
          ? CommandSensorConfigSchema
          : sensor.extension === taskChangeExtension
            ? TaskChangeSensorConfigSchema
            : undefined;
    if (configSchema !== undefined && !configSchema.safeParse(sensor.config).success) {
      throw new Error(`Sensor ${sensor.id} has invalid ${sensor.extension} configuration`);
    }
  }

  const sensors = new Map(policy.sensors.map((sensor) => [sensor.id, sensor]));
  for (const gate of policy.gates) {
    const hasDeterministicAnchor = gate.checks.some(
      (check) => !check.advisory && sensors.get(check.sensor)?.kind === "deterministic",
    );
    if (!hasDeterministicAnchor) {
      throw new Error(`Gate ${gate.id} has no deterministic non-advisory sensor anchor`);
    }
  }
}

async function loadWorkerProfiles(repositoryRoot: string): Promise<{
  workerProfiles: Record<string, WorkerProfile>;
  workerProfileSources: Record<string, string>;
}> {
  const profileDirectory = resolve(repositoryRoot, SENAWA_DIRECTORY, "agents");
  const entries = (await readdir(profileDirectory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const workerProfiles: Record<string, WorkerProfile> = {};
  const workerProfileSources: Record<string, string> = {};

  for (const entry of entries) {
    if (!entry.name.endsWith(".senawa.md")) continue;
    const profilePath = resolve(profileDirectory, entry.name);
    if (entry.isSymbolicLink() || !(await lstat(profilePath)).isFile()) {
      throw new Error(`Worker profile must be a regular file: ${entry.name}`);
    }
    const source = await readFile(profilePath, "utf8");
    const profile = parseWorkerProfileSource(source, entry.name);
    if (workerProfiles[profile.metadata.name] !== undefined) {
      throw new Error(`Duplicate worker profile name: ${profile.metadata.name}`);
    }
    workerProfiles[profile.metadata.name] = profile;
    workerProfileSources[toRepositoryPath(repositoryRoot, profilePath)] = source;
  }
  return { workerProfiles, workerProfileSources };
}

export function parseWorkerProfileSource(source: string, filename: string): WorkerProfile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source);
  if (match === null) {
    throw new Error(`Worker profile ${filename} must contain YAML frontmatter and a Markdown body`);
  }
  const frontmatter = parseYaml(match[1] ?? "") as unknown;
  const profile = WorkerProfileSchema.parse({
    ...(typeof frontmatter === "object" && frontmatter !== null ? frontmatter : {}),
    prompt: match[2] ?? "",
  });
  const expectedName = basename(filename, ".senawa.md");
  if (profile.metadata.name !== expectedName) {
    throw new Error(
      `Worker profile ${filename} declares metadata.name ${profile.metadata.name}; expected ${expectedName}`,
    );
  }
  return profile;
}

function toRepositoryPath(repositoryRoot: string, path: string): string {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

export const RepositoryDefinitionsSchema = z
  .object({
    workflow: WorkflowSchema,
    policy: RepositoryPolicySchema,
    schemas: z.record(z.string(), JsonObjectSchema),
    skill: z.string().min(1),
    workerProfiles: z.record(z.string(), WorkerProfileSchema),
    workerProfileSources: z.record(z.string(), z.string().min(1)),
  })
  .strict();
