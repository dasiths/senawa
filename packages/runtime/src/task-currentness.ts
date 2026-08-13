export interface TaskScope {
  readonly runId: string;
  readonly taskId: string;
  readonly definitionGeneration: number;
}

export interface TaskScopeFence extends TaskScope {
  readonly acceptedContextDigest: string;
  readonly fenceGeneration: number;
}

export interface TaskScopeCurrentness extends TaskScopeFence {
  readonly claimsAccepted: boolean;
}

export interface TaskScopeFenceInstallation {
  readonly scope: TaskScope;
  readonly expectedFenceGeneration: number;
  readonly expectedAcceptedContextDigest: string;
}

export interface InstallTaskScopeFencesInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly installedAt: string;
  readonly fences: readonly TaskScopeFenceInstallation[];
}

export function taskScopeKey(scope: TaskScope): string {
  return `${scope.runId}\u0000${scope.taskId}\u0000${scope.definitionGeneration}`;
}

export function taskScopeFence(currentness: TaskScopeCurrentness): TaskScopeFence {
  return Object.freeze({
    runId: currentness.runId,
    taskId: currentness.taskId,
    definitionGeneration: currentness.definitionGeneration,
    acceptedContextDigest: currentness.acceptedContextDigest,
    fenceGeneration: currentness.fenceGeneration,
  });
}
