import type { RepositoryChangeExpectation, RuntimeState } from "@senawa/domain";

/**
 * The frontier is the human-authored ceiling; a plan may narrow it but never widen it.
 */
export function effectiveRepositoryChange(
  state: Pick<RuntimeState, "snapshot">,
  task: { readonly repositoryChange?: RepositoryChangeExpectation | undefined },
): RepositoryChangeExpectation {
  if (task.repositoryChange !== undefined) return task.repositoryChange;
  const allowed = new Set(
    state.snapshot.workflow.spec.phases.flatMap((phase) =>
      phase.executor.kind === "task-frontier" ? [...phase.executor.repositoryChanges] : [],
    ),
  );
  return allowed.size === 1 ? ([...allowed][0] ?? "optional") : "optional";
}
