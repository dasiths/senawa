import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { IdentifierSchema, WorkflowSchema } from "@senawa/core";
import { parse as parseYaml } from "yaml";

export async function listRepositoryWorkflows(repositoryRoot: string): Promise<string[]> {
  const directory = resolve(repositoryRoot, ".senawa", "workflows");
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name.slice(0, -".yaml".length))
    .sort();
}

export async function readRepositoryWorkflow(repositoryRoot: string, workflowName: string) {
  const name = IdentifierSchema.parse(workflowName);
  const path = resolve(repositoryRoot, ".senawa", "workflows", `${name}.yaml`);
  return WorkflowSchema.parse(parseYaml(await readFile(path, "utf8")) as unknown);
}
