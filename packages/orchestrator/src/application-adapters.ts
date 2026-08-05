import { posix } from "node:path";
import type { ArtifactValidationPort, WorkflowCatalogPort } from "@senawa/application";
import { listRepositoryWorkflows, readRepositoryWorkflow } from "@senawa/configuration";
import type { RunSnapshot } from "@senawa/domain";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export class AjvArtifactValidationAdapter implements ArtifactValidationPort {
  validatePhaseArtifact(input: {
    readonly snapshot: RunSnapshot;
    readonly phaseId: string;
    readonly schemaReference: string;
    readonly artifact: object;
  }): void {
    const schemaPath = posix.normalize(posix.join(".senawa/workflows", input.schemaReference));
    const schemaFile = input.snapshot.files.find((file) => file.path === schemaPath);
    if (schemaFile === undefined) {
      throw new Error(`Phase ${input.phaseId} frozen output schema is missing: ${schemaPath}`);
    }
    const ajv = new Ajv2020.default({ allErrors: true, strict: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(schemaFile.content));
    if (validate(input.artifact)) return;
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(
      `Phase ${input.phaseId} artifact does not match its frozen output schema: ${truncate(details, 1_000)}`,
    );
  }
}

export class RepositoryWorkflowCatalogAdapter implements WorkflowCatalogPort {
  constructor(private readonly repositoryRoot: string) {}

  listWorkflows(): Promise<string[]> {
    return listRepositoryWorkflows(this.repositoryRoot);
  }

  readWorkflow(workflowName: string) {
    return readRepositoryWorkflow(this.repositoryRoot, workflowName);
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}
