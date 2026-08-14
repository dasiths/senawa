import type { GitRevisionDescriptor } from "@senawa/kernel";
import type { GitCommandEnvironment, GitCommandPort, GitCommandResult } from "./git-command.js";
import { requireSuccessfulGit, type VerifiedGitRepository } from "./git-repository.js";
import { GitWorkspaceAdapter, type PreparedGitWorkspace } from "./git-workspace.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GitIntegrationMember {
  readonly memberId: string;
  readonly resultRevision: GitRevisionDescriptor;
}

export interface PrepareGitIntegrationInput {
  readonly integrationId: string;
  readonly beforeRevision: GitRevisionDescriptor;
  readonly members: readonly GitIntegrationMember[];
  readonly identity: GitCommandEnvironment;
  readonly signal?: AbortSignal;
}

export type PrepareGitIntegrationResult =
  | {
      readonly status: "candidate";
      readonly integrationId: string;
      readonly beforeRevision: GitRevisionDescriptor;
      readonly candidateRevision: GitRevisionDescriptor;
      readonly memberIds: readonly string[];
    }
  | {
      readonly status: "conflicted";
      readonly integrationId: string;
      readonly memberId: string;
      readonly memberIds: readonly string[];
      readonly details: string;
    };

export interface GitIntegrationGateResult {
  readonly decision: "passed" | "failed";
  readonly evidence: unknown;
}

export interface ValidateGitIntegrationInput {
  readonly integrationId: string;
  readonly candidateRevision: GitRevisionDescriptor;
  readonly signal?: AbortSignal;
  readonly evaluate: (
    workspaceRoot: string,
    signal: AbortSignal | undefined,
  ) => Promise<GitIntegrationGateResult>;
}

export interface ValidatedGitIntegration {
  readonly integrationId: string;
  readonly candidateRevision: GitRevisionDescriptor;
  readonly decision: "passed" | "failed";
  readonly evidence: unknown;
}

export type GitPublicationInspection =
  | { readonly status: "old"; readonly revision: GitRevisionDescriptor }
  | { readonly status: "new"; readonly revision: GitRevisionDescriptor }
  | { readonly status: "other"; readonly revision: GitRevisionDescriptor }
  | { readonly status: "missing" };

export type GitPublicationResult =
  | { readonly status: "published"; readonly revision: GitRevisionDescriptor }
  | { readonly status: "already-published"; readonly revision: GitRevisionDescriptor }
  | { readonly status: "target-moved"; readonly revision?: GitRevisionDescriptor };

export interface GitIntegrationAdapterOptions {
  readonly beforePublicationAuthorityReassert?: () => Promise<void> | void;
}

export class GitIntegrationAdapter {
  readonly workspaceAdapter: GitWorkspaceAdapter;

  constructor(
    readonly command: GitCommandPort,
    readonly repository: VerifiedGitRepository,
    readonly options: GitIntegrationAdapterOptions = {},
  ) {
    this.workspaceAdapter = new GitWorkspaceAdapter(command, repository);
  }

  async prepare(input: PrepareGitIntegrationInput): Promise<PrepareGitIntegrationResult> {
    validateIdentity(input.integrationId, "Integration ID");
    this.requireRevision(input.beforeRevision);
    const members = normalizeMembers(input.members, this.repository);
    let currentCommit = input.beforeRevision.commit.oid;
    let currentTree = input.beforeRevision.tree.oid;
    for (const member of members) {
      await this.verifyRevision(member.resultRevision, input.signal);
      const merged = await this.run(
        ["merge-tree", "--write-tree", currentCommit, member.resultRevision.commit.oid],
        input.signal,
      );
      if (merged.timedOut || merged.cancelled) {
        requireSuccessfulGit(merged, "Merge integration member");
      }
      if (merged.exitCode !== 0 || merged.signal !== null) {
        return Object.freeze({
          status: "conflicted",
          integrationId: input.integrationId,
          memberId: member.memberId,
          memberIds: Object.freeze(members.map(({ memberId }) => memberId)),
          details: boundedConflictDetails(merged),
        });
      }
      currentTree = firstLine(
        requireSuccessfulGit(merged, "Merge integration member"),
        "merge tree",
      );
      const committed = await this.command.run({
        rootDirectory: this.repository.repositoryRoot,
        args: [
          "commit-tree",
          currentTree,
          "-p",
          currentCommit,
          "-p",
          member.resultRevision.commit.oid,
          "-m",
          `senawa integration ${input.integrationId} member ${member.memberId}`,
        ],
        timeoutMs: DEFAULT_TIMEOUT_MS,
        identity: input.identity,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      currentCommit = firstLine(
        requireSuccessfulGit(committed, "Create integration candidate commit"),
        "candidate commit",
      );
    }
    return Object.freeze({
      status: "candidate",
      integrationId: input.integrationId,
      beforeRevision: input.beforeRevision,
      candidateRevision: revision(this.repository, currentCommit, currentTree),
      memberIds: Object.freeze(members.map(({ memberId }) => memberId)),
    });
  }

  async validate(input: ValidateGitIntegrationInput): Promise<ValidatedGitIntegration> {
    validateIdentity(input.integrationId, "Integration ID");
    this.requireRevision(input.candidateRevision);
    let workspace: PreparedGitWorkspace | undefined;
    try {
      workspace = await this.workspaceAdapter.prepare({
        workspaceId: `integration-validation:${input.integrationId}`,
        baseRevision: input.candidateRevision,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const result = await input.evaluate(workspace.path, input.signal);
      if (result.decision !== "passed" && result.decision !== "failed") {
        throw new GitIntegrationError("Integration gate returned an invalid decision");
      }
      return Object.freeze({
        integrationId: input.integrationId,
        candidateRevision: input.candidateRevision,
        decision: result.decision,
        evidence: result.evidence,
      });
    } finally {
      if (workspace !== undefined) await this.workspaceAdapter.cleanup(workspace);
    }
  }

  async publish(input: {
    readonly integrationId: string;
    readonly expectedOld: GitRevisionDescriptor;
    readonly candidateRevision: GitRevisionDescriptor;
    readonly reassertAuthority: () => Promise<void> | void;
    readonly signal?: AbortSignal;
  }): Promise<GitPublicationResult> {
    validateIdentity(input.integrationId, "Integration ID");
    this.requireRevision(input.expectedOld);
    this.requireRevision(input.candidateRevision);
    const before = await this.inspectPublication(
      input.expectedOld,
      input.candidateRevision,
      input.signal,
    );
    if (before.status === "new") {
      return Object.freeze({ status: "already-published", revision: before.revision });
    }
    if (before.status !== "old") {
      return Object.freeze({
        status: "target-moved",
        ...(before.status === "other" ? { revision: before.revision } : {}),
      });
    }
    let updated: GitCommandResult;
    await this.options.beforePublicationAuthorityReassert?.();
    await input.reassertAuthority();
    try {
      updated = await this.run(
        [
          "update-ref",
          "-m",
          `senawa integration ${input.integrationId}`,
          this.repository.targetRef,
          input.candidateRevision.commit.oid,
          input.expectedOld.commit.oid,
        ],
        input.signal,
      );
    } catch (error) {
      const after = await this.inspectPublication(
        input.expectedOld,
        input.candidateRevision,
        input.signal,
      );
      if (after.status === "new") {
        return Object.freeze({ status: "already-published", revision: after.revision });
      }
      if (after.status === "other") {
        return Object.freeze({ status: "target-moved", revision: after.revision });
      }
      throw new GitIntegrationUnknownPublicationError(
        `Integration publication response was lost before success could be proven: ${errorMessage(error)}`,
      );
    }
    if (
      updated.exitCode === 0 &&
      updated.signal === null &&
      !updated.timedOut &&
      !updated.cancelled
    ) {
      requireSuccessfulGit(updated, "Publish integration target");
      return Object.freeze({ status: "published", revision: input.candidateRevision });
    }
    const after = await this.inspectPublication(
      input.expectedOld,
      input.candidateRevision,
      input.signal,
    );
    if (after.status === "new") {
      return Object.freeze({ status: "already-published", revision: after.revision });
    }
    if (updated.timedOut || updated.cancelled) {
      throw new GitIntegrationUnknownPublicationError(
        "Integration publication was interrupted and target inspection did not prove success",
      );
    }
    return Object.freeze({
      status: "target-moved",
      ...(after.status === "other" ? { revision: after.revision } : {}),
    });
  }

  async inspectPublication(
    expectedOld: GitRevisionDescriptor,
    candidateRevision: GitRevisionDescriptor,
    signal?: AbortSignal,
  ): Promise<GitPublicationInspection> {
    this.requireRevision(expectedOld);
    this.requireRevision(candidateRevision);
    const resolved = await this.run(
      ["rev-parse", "--verify", `${this.repository.targetRef}^{commit}`],
      signal,
    );
    if (resolved.exitCode === 1 && !resolved.timedOut && !resolved.cancelled) {
      return Object.freeze({ status: "missing" });
    }
    const commit = firstLine(
      requireSuccessfulGit(resolved, "Inspect integration target"),
      "integration target commit",
    );
    const treeResult = await this.run(["rev-parse", "--verify", `${commit}^{tree}`], signal);
    const tree = firstLine(
      requireSuccessfulGit(treeResult, "Inspect integration target tree"),
      "integration target tree",
    );
    const current = revision(this.repository, commit, tree);
    if (commit === expectedOld.commit.oid && tree === expectedOld.tree.oid) {
      return Object.freeze({ status: "old", revision: current });
    }
    if (commit === candidateRevision.commit.oid && tree === candidateRevision.tree.oid) {
      return Object.freeze({ status: "new", revision: current });
    }
    return Object.freeze({ status: "other", revision: current });
  }

  private async verifyRevision(revisionValue: GitRevisionDescriptor, signal?: AbortSignal) {
    this.requireRevision(revisionValue);
    const commitTree = await this.run(
      ["rev-parse", "--verify", `${revisionValue.commit.oid}^{tree}`],
      signal,
    );
    const tree = firstLine(
      requireSuccessfulGit(commitTree, "Verify integration member revision"),
      "integration member tree",
    );
    if (tree !== revisionValue.tree.oid) {
      throw new GitIntegrationError("Integration member commit does not match its exact tree");
    }
  }

  private requireRevision(revisionValue: GitRevisionDescriptor): void {
    const length = this.repository.objectFormat === "sha1" ? 40 : 64;
    for (const object of [revisionValue.commit, revisionValue.tree]) {
      if (
        object.objectFormat !== this.repository.objectFormat ||
        !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(object.oid)
      ) {
        throw new GitIntegrationError(
          "Integration revision does not match the verified repository",
        );
      }
    }
  }

  private run(args: readonly string[], signal?: AbortSignal): Promise<GitCommandResult> {
    return this.command.run({
      rootDirectory: this.repository.repositoryRoot,
      args,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export class GitIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitIntegrationError";
  }
}

export class GitIntegrationUnknownPublicationError extends GitIntegrationError {
  constructor(message: string) {
    super(message);
    this.name = "GitIntegrationUnknownPublicationError";
  }
}

function normalizeMembers(
  members: readonly GitIntegrationMember[],
  repository: VerifiedGitRepository,
): readonly GitIntegrationMember[] {
  if (members.length === 0)
    throw new GitIntegrationError("Integration requires at least one member");
  const sorted = [...members].sort((left, right) =>
    left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0,
  );
  const seen = new Set<string>();
  for (const member of sorted) {
    validateIdentity(member.memberId, "Integration member ID");
    if (seen.has(member.memberId))
      throw new GitIntegrationError("Integration member IDs must be unique");
    seen.add(member.memberId);
    for (const object of [member.resultRevision.commit, member.resultRevision.tree]) {
      if (object.objectFormat !== repository.objectFormat) {
        throw new GitIntegrationError("Integration member object format does not match repository");
      }
    }
  }
  return Object.freeze(sorted);
}

function validateIdentity(value: string, label: string): void {
  if (value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new GitIntegrationError(`${label} must be a bounded non-empty NUL-free string`);
  }
}

function firstLine(text: string, label: string): string {
  const newline = text.indexOf("\n");
  if (newline < 0) throw new GitIntegrationError(`Git ${label} output has no complete line`);
  return text.slice(0, newline);
}

function boundedConflictDetails(result: GitCommandResult): string {
  if (result.timedOut) return "merge timed out";
  if (result.cancelled) return "merge cancelled";
  return `${result.stdout.text}\n${result.stderr.text}`.trim().slice(0, 16_384);
}

function revision(
  repository: VerifiedGitRepository,
  commit: string,
  tree: string,
): GitRevisionDescriptor {
  return Object.freeze({
    commit: Object.freeze({ objectFormat: repository.objectFormat, oid: commit }),
    tree: Object.freeze({ objectFormat: repository.objectFormat, oid: tree }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
