import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type JsonObject, JsonObjectSchema } from "./contracts/common.js";
import { type RepositoryPolicy, RepositoryPolicySchema } from "./contracts/sensors.js";
import { type WorkerProfile, WorkerProfileSchema } from "./contracts/worker-profile.js";
import { type Workflow, WorkflowSchema } from "./contracts/workflow.js";

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
  const workflowPath = resolve(root, ".senawa", "workflows", `${workflowName}.yaml`);
  const workflow = WorkflowSchema.parse(parseYaml(await readFile(workflowPath, "utf8")) as unknown);
  const policy = RepositoryPolicySchema.parse(
    parseYaml(await readFile(resolve(root, ".senawa", "sensors.yaml"), "utf8")) as unknown,
  );
  const { workerProfiles, workerProfileSources } = await loadWorkerProfiles(root);

  const schemaDirectory = resolve(root, ".senawa", "schemas");
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
    if (phase.executor.kind === "agent") {
      referencedSchemas.push(phase.executor.output.schema);
    }
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

  const skill = await readFile(resolve(root, ".agents", "skills", "senawa", "SKILL.md"), "utf8");

  return { workflow, policy, schemas, skill, workerProfiles, workerProfileSources };
}

async function loadWorkerProfiles(repositoryRoot: string): Promise<{
  workerProfiles: Record<string, WorkerProfile>;
  workerProfileSources: Record<string, string>;
}> {
  const profileDirectory = resolve(repositoryRoot, ".senawa", "agents");
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
