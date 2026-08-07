import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RunDocumentStoragePort } from "@senawa/application";
import {
  decodeRunIdentity,
  type RunIdentity,
  type RunSnapshot,
  type RuntimeArtifact,
} from "@senawa/domain";

interface DocumentEnvelope<T> {
  readonly operationId: string;
  readonly sha256: string;
  readonly value: T;
}

export class DocumentConflictError extends Error {
  constructor(readonly path: string) {
    super(`Immutable document conflicts with existing content: ${path}`);
    this.name = "DocumentConflictError";
  }
}

export class FileRunDocumentStore implements RunDocumentStoragePort {
  private readonly trackingDirectory: string;

  constructor(repositoryRoot: string) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  async publishIdentity(identity: RunIdentity, operationId: string): Promise<void> {
    const path = this.path(identity.runId, "identity.json");
    try {
      await this.publish(path, identity, operationId);
    } catch (error) {
      if (!(error instanceof DocumentConflictError)) throw error;
      const existing = decodeRunIdentity((await readEnvelope<unknown>(path)).value);
      if (JSON.stringify(existing) !== JSON.stringify(decodeRunIdentity(identity))) throw error;
    }
  }

  publishSnapshot(snapshot: RunSnapshot, operationId: string): Promise<void> {
    return this.publish(this.path(snapshot.runId, "snapshot.json"), snapshot, operationId);
  }

  publishArtifact(artifact: RuntimeArtifact, runId: string, operationId: string): Promise<void> {
    const expectedPath = `artifacts/${artifact.phaseId}/v${artifact.version}.json`;
    if (artifact.path !== expectedPath) {
      throw new Error(`Artifact path must be ${expectedPath}`);
    }
    return this.publish(this.path(runId, artifact.path), artifact, operationId);
  }

  async readIdentity(runId: string): Promise<RunIdentity> {
    return decodeRunIdentity(await this.read<unknown>(this.path(runId, "identity.json")));
  }

  readSnapshot(runId: string): Promise<RunSnapshot> {
    return this.read(this.path(runId, "snapshot.json"));
  }

  async readArtifact(
    runId: string,
    phaseId: string,
    version?: number,
  ): Promise<RuntimeArtifact | null> {
    const artifacts = (await this.listArtifacts(runId)).filter(
      (artifact) => artifact.phaseId === phaseId,
    );
    const selected =
      version === undefined
        ? artifacts.toSorted((left, right) => left.version - right.version).at(-1)
        : artifacts.find((artifact) => artifact.version === version);
    return selected ?? null;
  }

  async listArtifacts(runId: string): Promise<readonly RuntimeArtifact[]> {
    const root = this.path(runId, "artifacts");
    const paths = await listJsonFiles(root).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    });
    return Promise.all(paths.map((path) => this.read<RuntimeArtifact>(path)));
  }

  private path(runId: string, relativePath: string): string {
    assertIdentifier(runId, "run ID");
    const runDirectory = resolve(this.trackingDirectory, runId);
    const path = resolve(runDirectory, relativePath);
    if (path !== runDirectory && !path.startsWith(`${runDirectory}${sep}`)) {
      throw new Error("Document path escapes the run directory");
    }
    return path;
  }

  private async publish<T>(path: string, value: T, operationId: string): Promise<void> {
    const sha256 = digest(value);
    const envelope = { operationId, sha256, value } satisfies DocumentEnvelope<T>;
    await mkdir(dirname(path), { recursive: true });
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await readEnvelope<T>(path);
      if (existing.sha256 !== sha256) throw new DocumentConflictError(path);
    }
  }

  private async read<T>(path: string): Promise<T> {
    const envelope = await readEnvelope<T>(path);
    if (digest(envelope.value) !== envelope.sha256) {
      throw new Error(`Immutable document digest mismatch: ${path}`);
    }
    return structuredClone(envelope.value);
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? listJsonFiles(path)
        : entry.isFile() && entry.name.endsWith(".json")
          ? [path]
          : [];
    }),
  );
  return paths.flat();
}

async function readEnvelope<T>(path: string): Promise<DocumentEnvelope<T>> {
  return JSON.parse(await readFile(path, "utf8")) as DocumentEnvelope<T>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
