import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitRevisionDescriptor } from "@senawa/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { GitCommandPort, GitCommandRequest, GitCommandResult } from "./git-command.js";
import {
  GitIntegrationAdapter,
  type GitIntegrationMember,
  type PrepareGitIntegrationResult,
} from "./git-integration.js";
import { verifyGitRepository } from "./git-repository.js";
import {
  createTemporaryGitRepository,
  deterministicIdentity,
  type TemporaryGitRepository,
} from "./git-test-fixture.js";
import { GitWorkspaceAdapter, type PreparedGitWorkspace } from "./git-workspace.js";

const fixtures: TemporaryGitRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("GitIntegrationAdapter", () => {
  it("applies disjoint members in stable sorted order for every input permutation", async () => {
    const fixture = await temporaryRepository();
    const { integration, workspace } = await adapters(fixture);
    const members = await Promise.all([
      capture(workspace, fixture, "member_b", async (root) => {
        await writeFile(join(root, "b.txt"), "b\n", "utf8");
      }),
      capture(workspace, fixture, "member_a", async (root) => {
        await writeFile(join(root, "a.txt"), "a\n", "utf8");
      }),
      capture(workspace, fixture, "member_c", async (root) => {
        await writeFile(join(root, "c.txt"), "c\n", "utf8");
      }),
    ]);

    const candidates: PrepareGitIntegrationResult[] = [];
    for (const permutation of permutations(members)) {
      candidates.push(
        await integration.prepare({
          integrationId: "integration_fan_in",
          beforeRevision: fixture.baseRevision,
          members: permutation,
          identity: deterministicIdentity,
        }),
      );
    }

    expect(candidates.every(({ status }) => status === "candidate")).toBe(true);
    const candidateIds = candidates.map((result) =>
      result.status === "candidate" ? result.candidateRevision.commit.oid : "conflict",
    );
    expect(new Set(candidateIds).size).toBe(1);
    expect(candidates[0]).toMatchObject({
      status: "candidate",
      memberIds: ["member_a", "member_b", "member_c"],
    });
    const candidate = requireCandidate(candidates[0]);
    expect(
      oneLine(await fixture.git(["show", `${candidate.candidateRevision.commit.oid}:a.txt`])),
    ).toBe("a");
    expect(
      oneLine(await fixture.git(["show", `${candidate.candidateRevision.commit.oid}:b.txt`])),
    ).toBe("b");
    expect(
      oneLine(await fixture.git(["show", `${candidate.candidateRevision.commit.oid}:c.txt`])),
    ).toBe("c");
  });

  it.each(["text", "rename-delete", "binary"] as const)(
    "reports a deterministic %s conflict without updating the target",
    async (kind) => {
      const fixture = await temporaryRepository();
      const { integration, workspace } = await adapters(fixture);
      const members = await conflictingMembers(kind, workspace, fixture);

      const result = await integration.prepare({
        integrationId: `integration_${kind}`,
        beforeRevision: fixture.baseRevision,
        members,
        identity: deterministicIdentity,
      });

      expect(result).toMatchObject({ status: "conflicted", memberId: "member_b" });
      expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
        fixture.baseRevision.commit.oid,
      );
    },
  );

  it("validates in an owned detached worktree and leaves the target unchanged on gate failure", async () => {
    const fixture = await temporaryRepository();
    const { integration, workspace } = await adapters(fixture);
    const member = await capture(workspace, fixture, "member_gate", async (root) => {
      await writeFile(join(root, "semantic.txt"), "invalid\n", "utf8");
    });
    const candidate = requireCandidate(
      await integration.prepare({
        integrationId: "integration_gate",
        beforeRevision: fixture.baseRevision,
        members: [member],
        identity: deterministicIdentity,
      }),
    );
    let validationRoot = "";

    const validated = await integration.validate({
      integrationId: "integration_gate",
      candidateRevision: candidate.candidateRevision,
      async evaluate(root) {
        validationRoot = root;
        return { decision: "failed", evidence: { reason: "semantic refusal" } };
      },
    });

    expect(validated).toMatchObject({
      decision: "failed",
      evidence: { reason: "semantic refusal" },
    });
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
      fixture.baseRevision.commit.oid,
    );
    expect(await fixture.git(["worktree", "list", "--porcelain"])).not.toContain(validationRoot);
  });

  it("publishes exactly once with compare-and-swap and recognizes replay", async () => {
    const fixture = await temporaryRepository();
    const { integration, workspace } = await adapters(fixture);
    const candidate = await oneMemberCandidate(integration, workspace, fixture, "publish");

    const published = await integration.publish({
      integrationId: "integration_publish",
      expectedOld: fixture.baseRevision,
      candidateRevision: candidate,
      reassertAuthority() {},
    });
    const replayed = await integration.publish({
      integrationId: "integration_publish",
      expectedOld: fixture.baseRevision,
      candidateRevision: candidate,
      reassertAuthority() {},
    });

    expect(published.status).toBe("published");
    expect(replayed.status).toBe("already-published");
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(candidate.commit.oid);
    expect(
      fixture.command.operations.filter(
        ({ args }) => args[0] === "update-ref" && args.includes(candidate.commit.oid),
      ),
    ).toHaveLength(1);
  });

  it("returns target-moved when compare-and-swap authority is stale", async () => {
    const fixture = await temporaryRepository();
    const { integration, workspace } = await adapters(fixture);
    const candidate = await oneMemberCandidate(integration, workspace, fixture, "target-moved");
    const other = oneLine(
      await fixture.git([
        "commit-tree",
        fixture.baseRevision.tree.oid,
        "-p",
        fixture.baseRevision.commit.oid,
        "-m",
        "other target",
      ]),
    );
    await fixture.git(["update-ref", fixture.targetRef, other, fixture.baseRevision.commit.oid]);

    const result = await integration.publish({
      integrationId: "integration_target_moved",
      expectedOld: fixture.baseRevision,
      candidateRevision: candidate,
      reassertAuthority() {},
    });

    expect(result.status).toBe("target-moved");
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(other);
  });

  it("does not update the target when authority is lost after final inspection", async () => {
    const fixture = await temporaryRepository();
    const verified = await verify(fixture);
    let injected = false;
    const integration = new GitIntegrationAdapter(fixture.command, verified, {
      beforePublicationAuthorityReassert() {
        injected = true;
      },
    });
    const workspace = new GitWorkspaceAdapter(fixture.command, verified);
    const candidate = await oneMemberCandidate(integration, workspace, fixture, "lost-authority");
    const updateRefsBefore = fixture.command.operations.filter(
      ({ args }) => args[0] === "update-ref",
    ).length;

    await expect(
      integration.publish({
        integrationId: "integration_lost_authority",
        expectedOld: fixture.baseRevision,
        candidateRevision: candidate,
        reassertAuthority() {
          throw new Error("integration authority was taken over");
        },
      }),
    ).rejects.toThrow("integration authority was taken over");

    expect(injected).toBe(true);
    expect(fixture.command.operations.filter(({ args }) => args[0] === "update-ref")).toHaveLength(
      updateRefsBefore,
    );
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
      fixture.baseRevision.commit.oid,
    );
  });

  it("inspects a lost update-ref response as the exact new revision", async () => {
    const fixture = await temporaryRepository();
    const verified = await verify(fixture);
    const ordinaryWorkspace = new GitWorkspaceAdapter(fixture.command, verified);
    const ordinaryIntegration = new GitIntegrationAdapter(fixture.command, verified);
    const candidate = await oneMemberCandidate(
      ordinaryIntegration,
      ordinaryWorkspace,
      fixture,
      "lost-response",
    );
    const lost = new LostUpdateRefResponsePort(fixture.command);
    const integration = new GitIntegrationAdapter(lost, verified);

    await expect(
      integration.publish({
        integrationId: "integration_lost_response",
        expectedOld: fixture.baseRevision,
        candidateRevision: candidate,
        reassertAuthority() {},
      }),
    ).resolves.toMatchObject({ status: "already-published", revision: candidate });
    await expect(
      integration.inspectPublication(fixture.baseRevision, candidate),
    ).resolves.toMatchObject({ status: "new", revision: candidate });
    expect(lost.updateRefCalls).toBe(1);
  });
});

class LostUpdateRefResponsePort implements GitCommandPort {
  updateRefCalls = 0;

  constructor(readonly delegate: GitCommandPort) {}

  async run(request: GitCommandRequest): Promise<GitCommandResult> {
    const result = await this.delegate.run(request);
    if (request.args[0] === "update-ref") {
      this.updateRefCalls += 1;
      throw new Error("simulated lost response");
    }
    return result;
  }
}

async function adapters(fixture: TemporaryGitRepository) {
  const verified = await verify(fixture);
  return {
    integration: new GitIntegrationAdapter(fixture.command, verified),
    workspace: new GitWorkspaceAdapter(fixture.command, verified),
  };
}

function verify(fixture: TemporaryGitRepository) {
  return verifyGitRepository(fixture.command, {
    repositoryRoot: fixture.repositoryRoot,
    ownedRoot: fixture.ownedRoot,
    targetRef: fixture.targetRef,
    expectedRevision: fixture.baseRevision,
  });
}

async function capture(
  adapter: GitWorkspaceAdapter,
  fixture: TemporaryGitRepository,
  memberId: string,
  mutate: (root: string) => Promise<void>,
): Promise<GitIntegrationMember> {
  let workspace: PreparedGitWorkspace | undefined;
  try {
    workspace = await adapter.prepare({
      workspaceId: memberId,
      baseRevision: fixture.baseRevision,
    });
    await mutate(workspace.path);
    const resultRevision = await adapter.capture({
      workspace,
      identity: deterministicIdentity,
      message: `senawa result ${memberId}`,
    });
    return Object.freeze({ memberId, resultRevision });
  } finally {
    if (workspace !== undefined) await adapter.cleanup(workspace);
  }
}

async function conflictingMembers(
  kind: "text" | "rename-delete" | "binary",
  adapter: GitWorkspaceAdapter,
  fixture: TemporaryGitRepository,
): Promise<readonly GitIntegrationMember[]> {
  if (kind === "text") {
    return Promise.all([
      capture(adapter, fixture, "member_a", (root) => writeFile(join(root, "edit.txt"), "a\n")),
      capture(adapter, fixture, "member_b", (root) => writeFile(join(root, "edit.txt"), "b\n")),
    ]);
  }
  if (kind === "rename-delete") {
    return Promise.all([
      capture(adapter, fixture, "member_a", (root) =>
        rename(join(root, "edit.txt"), join(root, "renamed.txt")),
      ),
      capture(adapter, fixture, "member_b", (root) => rm(join(root, "edit.txt"))),
    ]);
  }
  return Promise.all([
    capture(adapter, fixture, "member_a", (root) =>
      writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 4])),
    ),
    capture(adapter, fixture, "member_b", (root) =>
      writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 5])),
    ),
  ]);
}

async function oneMemberCandidate(
  integration: GitIntegrationAdapter,
  workspace: GitWorkspaceAdapter,
  fixture: TemporaryGitRepository,
  suffix: string,
): Promise<GitRevisionDescriptor> {
  const member = await capture(workspace, fixture, `member_${suffix}`, (root) =>
    writeFile(join(root, `${suffix}.txt`), `${suffix}\n`, "utf8"),
  );
  return requireCandidate(
    await integration.prepare({
      integrationId: `integration_${suffix}`,
      beforeRevision: fixture.baseRevision,
      members: [member],
      identity: deterministicIdentity,
    }),
  ).candidateRevision;
}

function requireCandidate(result: PrepareGitIntegrationResult | undefined) {
  if (result?.status !== "candidate") throw new Error("Expected integration candidate");
  return result;
}

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

async function temporaryRepository(): Promise<TemporaryGitRepository> {
  const fixture = await createTemporaryGitRepository();
  fixtures.push(fixture);
  return fixture;
}

function oneLine(text: string): string {
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
    throw new Error("Expected one line");
  return text.slice(0, -1);
}
