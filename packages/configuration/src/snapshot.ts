import { createHash } from "node:crypto";
import { type RunSnapshot, RunSnapshotSchema } from "@senawa/domain";
import type { RepositoryDefinitions } from "./definitions.js";

export function createRunSnapshot(
  runId: string,
  definitions: RepositoryDefinitions,
  now: Date,
): RunSnapshot {
  const sourceFiles: Array<{
    path: string;
    mediaType: "application/json" | "application/yaml" | "text/markdown";
    content: string;
  }> = [
    {
      path: `.senawa/workflows/${definitions.workflow.metadata.name}.json`,
      mediaType: "application/json",
      content: JSON.stringify(definitions.workflow),
    },
    {
      path: "sensors.json",
      mediaType: "application/json",
      content: JSON.stringify(definitions.policy),
    },
    ...Object.entries(definitions.schemas).map(([path, schema]) => ({
      path,
      mediaType: "application/json" as const,
      content: JSON.stringify(schema),
    })),
    {
      path: ".agents/skills/senawa/SKILL.md",
      mediaType: "text/markdown",
      content: definitions.skill,
    },
    ...Object.entries(definitions.workerProfileSources).map(([path, content]) => ({
      path,
      mediaType: "text/markdown" as const,
      content,
    })),
  ];
  const files = sourceFiles
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ ...file, sha256: sha256(file.content) }));
  const fingerprint = sha256(files.map((file) => `${file.path}:${file.sha256}`).join("\n"));
  return RunSnapshotSchema.parse({
    apiVersion: "senawa.dev/snapshot/v2",
    runId,
    createdAt: now.toISOString(),
    fingerprint,
    workflow: definitions.workflow,
    policy: definitions.policy,
    workerProfiles: definitions.workerProfiles,
    files,
  });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
