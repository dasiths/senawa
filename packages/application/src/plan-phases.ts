import type { PlanArtifact } from "@senawa/domain";

type PlanTask = PlanArtifact["tasks"][number];

/** A task fanning in more than this many dependencies is a plan smell, not a scheduling need. */
export const PLAN_PHASE_DEPENDENCY_LIMIT = 100;

export interface DerivedTaskDependency {
  readonly task: string;
  readonly from: string;
  readonly added: readonly string[];
}

export interface PlanPhaseExpansion {
  /** Plan tasks in phase order, so array order matches the intended sequence. */
  readonly tasks: readonly PlanTask[];
  readonly phases: readonly string[];
  readonly derivedDependencies: readonly DerivedTaskDependency[];
  /** Tasks whose transitive closure exceeded the cap and collapsed to immediate predecessors. */
  readonly collapsed: readonly string[];
}

/**
 * Turns declared plan phases into runtime task dependencies. Both persistence backends already
 * honor `dependsOn`, so phase ordering reaches the frontier without touching `claimReadyTask`.
 */
export function expandPlanPhases(plan: PlanArtifact): PlanPhaseExpansion {
  if (plan.phases.length === 0) {
    return { tasks: plan.tasks, phases: [], derivedDependencies: [], collapsed: [] };
  }

  const ranked = plan.phases
    .map((phase, index) => ({ phase, index, order: phase.order ?? index + 1 }))
    .sort((left, right) => left.order - right.order || left.index - right.index);
  const rankById = new Map(ranked.map((entry, rank) => [entry.phase.id, rank]));
  const declared = new Map(plan.phases.map((phase) => [phase.id, phase.dependsOn]));
  assertAcyclic(declared);

  const tasksByPhase = new Map<string, string[]>();
  for (const task of plan.tasks) {
    if (task.phase === undefined) continue;
    const bucket = tasksByPhase.get(task.phase);
    if (bucket === undefined) tasksByPhase.set(task.phase, [task.key]);
    else bucket.push(task.key);
  }

  const tasks = plan.tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (left, right) =>
        phaseRank(rankById, left.task) - phaseRank(rankById, right.task) ||
        (left.task.order ?? Number.MAX_SAFE_INTEGER) -
          (right.task.order ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map((entry) => entry.task);

  const derivedDependencies: DerivedTaskDependency[] = [];
  const collapsed: string[] = [];
  const ordered: PlanTask[] = [];
  for (const task of tasks) {
    if (task.phase === undefined) {
      ordered.push(task);
      continue;
    }
    const predecessors = closure(declared, declared.get(task.phase) ?? []);
    let added = keysFrom(tasksByPhase, predecessors, task);
    if (task.dependsOn.length + added.length > PLAN_PHASE_DEPENDENCY_LIMIT) {
      collapsed.push(task.key);
      added = keysFrom(tasksByPhase, new Set(declared.get(task.phase) ?? []), task);
    }
    if (added.length > 0) {
      derivedDependencies.push({ task: task.key, from: task.phase, added });
      ordered.push({ ...task, dependsOn: [...task.dependsOn, ...added] });
      continue;
    }
    ordered.push(task);
  }

  assertAcyclic(new Map(ordered.map((task) => [task.key, task.dependsOn])));
  return {
    tasks: ordered,
    phases: ranked.map((entry) => entry.phase.id),
    derivedDependencies,
    collapsed,
  };
}

function phaseRank(rankById: ReadonlyMap<string, number>, task: PlanTask): number {
  if (task.phase === undefined) return Number.MAX_SAFE_INTEGER;
  return rankById.get(task.phase) ?? Number.MAX_SAFE_INTEGER;
}

function keysFrom(
  tasksByPhase: ReadonlyMap<string, readonly string[]>,
  phases: ReadonlySet<string>,
  task: PlanTask,
): readonly string[] {
  const seen = new Set(task.dependsOn);
  const added: string[] = [];
  for (const phase of phases) {
    for (const key of tasksByPhase.get(phase) ?? []) {
      if (key === task.key || seen.has(key)) continue;
      seen.add(key);
      added.push(key);
    }
  }
  return added;
}

function closure(
  edges: ReadonlyMap<string, readonly string[]>,
  roots: readonly string[],
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || reached.has(next) || !edges.has(next)) continue;
    reached.add(next);
    pending.push(...(edges.get(next) ?? []));
  }
  return reached;
}

function assertAcyclic(edges: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const walk = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(
        `Plan phase ordering forms a dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(" -> ")}`,
      );
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of edges.get(id) ?? []) {
      if (edges.has(dependency)) walk(dependency);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of edges.keys()) walk(id);
}
