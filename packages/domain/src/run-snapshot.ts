import { z } from "zod";
import { IdentifierSchema, RelativePathSchema, Sha256Schema, TimestampSchema } from "./common.js";
import { RepositoryPolicySchema } from "./sensors.js";
import { WorkerProfileSchema } from "./worker-profile.js";
import { WorkflowSchema } from "./workflow.js";

export const SnapshotFileSchema = z
  .object({
    path: RelativePathSchema,
    sha256: Sha256Schema,
    mediaType: z.enum(["application/json", "application/yaml", "text/markdown"]),
    content: z.string(),
  })
  .strict();

export const RunSnapshotSchema = z
  .object({
    apiVersion: z.literal("senawa.dev/snapshot/v2"),
    runId: IdentifierSchema,
    createdAt: TimestampSchema,
    fingerprint: Sha256Schema,
    workflow: WorkflowSchema,
    policy: RepositoryPolicySchema,
    workerProfiles: z.record(IdentifierSchema, WorkerProfileSchema),
    files: z.array(SnapshotFileSchema).min(1),
  })
  .strict();

export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
