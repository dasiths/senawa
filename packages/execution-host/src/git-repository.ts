import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitObjectFormat, GitRevisionDescriptor } from "@senawa/kernel";
import type { GitCommandPort, GitCommandResult } from "./git-command.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const LOCAL_BRANCH_REF =
  /^refs\/heads\/(?![./])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[^\0 ~^:?*[\\]+$/u;

export interface GitWorktreeRecord {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}

interface VerifiedGitRepositoryInput {
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly targetRef: string;
  readonly objectFormat: GitObjectFormat;
  readonly targetRevision: GitRevisionDescriptor;
}

export class VerifiedGitRepository {
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly targetRef: string;
  readonly objectFormat: GitObjectFormat;
  readonly targetRevision: GitRevisionDescriptor;

  private constructor(input: VerifiedGitRepositoryInput) {
    this.repositoryRoot = input.repositoryRoot;
    this.ownedRoot = input.ownedRoot;
    this.targetRef = input.targetRef;
    this.objectFormat = input.objectFormat;
    this.targetRevision = input.targetRevision;
    Object.freeze(this);
  }

  static create(input: VerifiedGitRepositoryInput): VerifiedGitRepository {
    return new VerifiedGitRepository(input);
  }
}

export interface VerifyGitRepositoryInput {
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly targetRef: string;
  readonly expectedRevision?: GitRevisionDescriptor;
  readonly signal?: AbortSignal;
}

export async function verifyGitRepository(
  command: GitCommandPort,
  input: VerifyGitRepositoryInput,
): Promise<VerifiedGitRepository> {
  if (!LOCAL_BRANCH_REF.test(input.targetRef)) {
    throw new GitRepositoryVerificationError("Integration target must be a full local branch ref");
  }
  const [repositoryRoot, ownedRoot] = await Promise.all([
    realpath(input.repositoryRoot),
    realpath(input.ownedRoot),
  ]);
  assertSeparateRoots(repositoryRoot, ownedRoot);
  await verifyRootOwnership(repositoryRoot, ownedRoot);
  const run = (args: readonly string[]): Promise<GitCommandResult> =>
    command.run({
      rootDirectory: repositoryRoot,
      args,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  const topLevel = singleLine(await successful(run(["rev-parse", "--show-toplevel"])), "top level");
  if ((await realpath(topLevel)) !== repositoryRoot) {
    throw new GitRepositoryVerificationError(
      "Registered root is not the exact repository top level",
    );
  }
  if (
    singleLine(await successful(run(["rev-parse", "--is-bare-repository"])), "bare mode") !==
    "false"
  ) {
    throw new GitRepositoryVerificationError("Bare repositories are not supported");
  }
  const objectFormat = singleLine(
    await successful(run(["rev-parse", "--show-object-format"])),
    "object format",
  );
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new GitRepositoryVerificationError("Repository object format is not supported");
  }
  await successful(run(["check-ref-format", input.targetRef]));
  const commit = objectId(
    singleLine(
      await successful(run(["rev-parse", "--verify", `${input.targetRef}^{commit}`])),
      "target commit",
    ),
    objectFormat,
  );
  const tree = objectId(
    singleLine(await successful(run(["rev-parse", "--verify", `${commit}^{tree}`])), "target tree"),
    objectFormat,
  );
  if (
    input.expectedRevision !== undefined &&
    (input.expectedRevision.commit.objectFormat !== objectFormat ||
      input.expectedRevision.tree.objectFormat !== objectFormat ||
      input.expectedRevision.commit.oid !== commit ||
      input.expectedRevision.tree.oid !== tree)
  ) {
    throw new GitRepositoryVerificationError(
      "Integration target does not match the exact expected revision",
    );
  }
  await verifyNoSubmodules(run, commit);
  await verifyNoExternalFilters(run);
  const worktrees = parseGitWorktreePorcelain(
    (await successful(run(["worktree", "list", "--porcelain", "-z"]))).stdout.text,
    objectFormat,
  );
  if (worktrees.some(({ branch }) => branch === input.targetRef)) {
    throw new GitRepositoryVerificationError("Integration target is checked out in a worktree");
  }
  return VerifiedGitRepository.create({
    repositoryRoot,
    ownedRoot,
    targetRef: input.targetRef,
    objectFormat,
    targetRevision: revision(objectFormat, commit, tree),
  });
}

export function parseGitWorktreePorcelain(
  text: string,
  objectFormat: GitObjectFormat,
): readonly GitWorktreeRecord[] {
  if (!text.endsWith("\0")) {
    throw new GitRepositoryVerificationError("Worktree porcelain must be NUL terminated");
  }
  const records: GitWorktreeRecord[] = [];
  let fields: string[] = [];
  for (const field of text.split("\0")) {
    if (field.length === 0) {
      if (fields.length > 0) {
        records.push(parseWorktreeRecord(fields, objectFormat));
        fields = [];
      }
    } else {
      fields.push(field);
    }
  }
  return Object.freeze(records);
}

export class GitRepositoryVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitRepositoryVerificationError";
  }
}

export function requireSuccessfulGit(result: GitCommandResult, operation: string): string {
  if (result.timedOut) throw new GitRepositoryVerificationError(`${operation} timed out`);
  if (result.cancelled) throw new GitRepositoryVerificationError(`${operation} was cancelled`);
  if (result.stdout.truncated || result.stderr.truncated) {
    throw new GitRepositoryVerificationError(`${operation} exceeded its output bound`);
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new GitRepositoryVerificationError(
      `${operation} failed: ${result.stderr.text.trim() || `exit ${String(result.exitCode)}`}`,
    );
  }
  return result.stdout.text;
}

export function exactContainedPath(ownedRoot: string, path: string): void {
  const relativePath = relative(ownedRoot, path);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new GitRepositoryVerificationError("Owned path is not strictly contained by its root");
  }
}

export async function requireCanonicalContainedPath(
  ownedRoot: string,
  path: string,
): Promise<string> {
  exactContainedPath(ownedRoot, path);
  const canonical = await realpath(path);
  exactContainedPath(ownedRoot, canonical);
  if (canonical !== resolve(path)) {
    throw new GitRepositoryVerificationError("Owned path contains a symlink or alias");
  }
  return canonical;
}

export async function requireAbsentPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new GitRepositoryVerificationError("Owned workspace path already exists");
}

function parseWorktreeRecord(
  fields: readonly string[],
  objectFormat: GitObjectFormat,
): GitWorktreeRecord {
  const first = fields[0];
  if (first === undefined || !first.startsWith("worktree ")) {
    throw new GitRepositoryVerificationError("Worktree record must start with its path");
  }
  const path = first.slice("worktree ".length);
  if (!isAbsolute(path) || path.includes("\n") || path.includes("\r")) {
    throw new GitRepositoryVerificationError("Worktree path is invalid");
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const field of fields.slice(1)) {
    const space = field.indexOf(" ");
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? "" : field.slice(space + 1);
    if (!["HEAD", "branch", "detached", "bare", "locked", "prunable"].includes(key)) {
      throw new GitRepositoryVerificationError(`Unknown worktree porcelain field ${key}`);
    }
    if (values.has(key) || flags.has(key)) {
      throw new GitRepositoryVerificationError(`Duplicate worktree porcelain field ${key}`);
    }
    if (key === "detached" || key === "bare") flags.add(key);
    else values.set(key, value);
  }
  const head = values.get("HEAD");
  if (head !== undefined) objectId(head, objectFormat);
  const record: GitWorktreeRecord = {
    path,
    detached: flags.has("detached"),
    bare: flags.has("bare"),
    ...(head === undefined ? {} : { head }),
    ...(values.get("branch") === undefined ? {} : { branch: values.get("branch") as string }),
    ...(values.get("locked") === undefined ? {} : { locked: values.get("locked") as string }),
    ...(values.get("prunable") === undefined ? {} : { prunable: values.get("prunable") as string }),
  };
  if (!record.bare && record.head === undefined) {
    throw new GitRepositoryVerificationError("Non-bare worktree record requires HEAD");
  }
  if (record.detached && record.branch !== undefined) {
    throw new GitRepositoryVerificationError("Detached worktree record cannot contain a branch");
  }
  return Object.freeze(record);
}

async function verifyNoSubmodules(
  run: (args: readonly string[]) => Promise<GitCommandResult>,
  commit: string,
): Promise<void> {
  const output = await successful(run(["ls-tree", "-r", "-z", "--full-tree", commit]));
  for (const entry of output.stdout.text.split("\0")) {
    if (entry.length === 0) continue;
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/u.exec(entry);
    if (match === null) throw new GitRepositoryVerificationError("Git tree listing is malformed");
    if (match[1] === "160000" || match[4] === ".gitmodules") {
      throw new GitRepositoryVerificationError("Submodules are not supported");
    }
  }
}

async function verifyNoExternalFilters(
  run: (args: readonly string[]) => Promise<GitCommandResult>,
): Promise<void> {
  const result = await run([
    "config",
    "--null",
    "--get-regexp",
    "^filter\\..*\\.(clean|smudge|process)$",
  ]);
  if (result.exitCode === 1 && !result.timedOut && !result.cancelled) return;
  const output = await successful(Promise.resolve(result));
  if (output.stdout.text.length > 0) {
    throw new GitRepositoryVerificationError(
      "External Git clean, smudge, and process filters are not supported",
    );
  }
}

async function successful(result: Promise<GitCommandResult>): Promise<GitCommandResult> {
  const value = await result;
  requireSuccessfulGit(value, "Git repository verification");
  return value;
}

function singleLine(result: GitCommandResult, label: string): string {
  const value = result.stdout.text;
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw new GitRepositoryVerificationError(`Git ${label} output is not one line`);
  }
  return value.slice(0, -1);
}

function objectId(value: string, format: GitObjectFormat): string {
  const length = format === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value)) {
    throw new GitRepositoryVerificationError(`Git ${format} object ID is invalid`);
  }
  return value;
}

function revision(format: GitObjectFormat, commit: string, tree: string): GitRevisionDescriptor {
  return Object.freeze({
    commit: Object.freeze({ objectFormat: format, oid: commit }),
    tree: Object.freeze({ objectFormat: format, oid: tree }),
  });
}

function assertSeparateRoots(repositoryRoot: string, ownedRoot: string): void {
  const repositoryToOwned = relative(repositoryRoot, ownedRoot);
  const ownedToRepository = relative(ownedRoot, repositoryRoot);
  if (
    repositoryToOwned === "" ||
    (!repositoryToOwned.startsWith("..") && !isAbsolute(repositoryToOwned)) ||
    (!ownedToRepository.startsWith("..") && !isAbsolute(ownedToRepository))
  ) {
    throw new GitRepositoryVerificationError(
      "Owned workspace root must be separate from the repository",
    );
  }
}

async function verifyRootOwnership(repositoryRoot: string, ownedRoot: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new GitRepositoryVerificationError(
      "Git repository verification requires filesystem ownership support",
    );
  }
  const [repositoryMetadata, ownedMetadata] = await Promise.all([
    stat(repositoryRoot),
    stat(ownedRoot),
  ]);
  if (
    !repositoryMetadata.isDirectory() ||
    !ownedMetadata.isDirectory() ||
    repositoryMetadata.uid !== currentUid ||
    ownedMetadata.uid !== currentUid
  ) {
    throw new GitRepositoryVerificationError(
      "Git repository and workspace roots must be owned directories",
    );
  }
}
