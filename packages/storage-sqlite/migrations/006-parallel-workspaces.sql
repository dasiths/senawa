CREATE TABLE runner_capacities (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  resource_key TEXT NOT NULL CHECK (resource_key = 'writer'),
  capacity_limit INTEGER NOT NULL CHECK (capacity_limit > 0),
  occupied INTEGER NOT NULL CHECK (occupied >= 0 AND occupied <= capacity_limit),
  PRIMARY KEY (run_key, resource_key)
) STRICT;

UPDATE authority_state
SET canonical_json = '{"runs":[],"version":"senawa.dev/runtime-memory/v1alpha2"}'
WHERE singleton = 1
  AND revision = 0
  AND canonical_json = '{"runs":[],"version":"senawa.dev/runtime-memory/v1alpha1"}';

CREATE TABLE runner_capacity_reservations (
  intent_id TEXT PRIMARY KEY REFERENCES runner_effect_intents(intent_id) ON DELETE CASCADE,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  resource_key TEXT NOT NULL CHECK (resource_key = 'writer'),
  amount INTEGER NOT NULL CHECK (amount > 0),
  released INTEGER NOT NULL CHECK (released IN (0, 1)),
  reserved_at TEXT NOT NULL,
  released_at TEXT,
  CHECK ((released = 0 AND released_at IS NULL) OR (released = 1 AND released_at IS NOT NULL)),
  FOREIGN KEY (run_key, resource_key)
    REFERENCES runner_capacities(run_key, resource_key)
) STRICT;

INSERT INTO runner_capacities(run_key, resource_key, capacity_limit, occupied)
SELECT run_key, 'writer', 1, 0 FROM runner_runs;

CREATE TABLE runner_execution_bindings (
  run_key TEXT PRIMARY KEY REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  configuration_snapshot_digest TEXT NOT NULL CHECK (length(configuration_snapshot_digest) = 64),
  workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('repository', 'worktree')),
  max_writer_concurrency INTEGER NOT NULL CHECK (max_writer_concurrency > 0),
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('continue', 'fail-fast')),
  integration_ref TEXT,
  canonical_binding TEXT NOT NULL,
  CHECK (
    (workspace_mode = 'repository' AND max_writer_concurrency = 1 AND integration_ref IS NULL)
    OR (workspace_mode = 'worktree' AND integration_ref IS NOT NULL)
  ),
  UNIQUE (repository_id, run_id)
) STRICT;

CREATE TABLE runner_workspaces (
  workspace_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation > 0),
  mode TEXT NOT NULL CHECK (mode IN ('repository', 'worktree')),
  state TEXT NOT NULL CHECK (
    state IN ('intent', 'prepared', 'capture-intent', 'captured',
              'removal-intent', 'removed', 'failed', 'unknown')
  ),
  base_revision_digest TEXT NOT NULL CHECK (length(base_revision_digest) = 64),
  prepare_effect_id TEXT NOT NULL UNIQUE,
  inspect_effect_id TEXT NOT NULL UNIQUE,
  canonical_workspace TEXT NOT NULL,
  UNIQUE (run_key, task_id, definition_generation)
) STRICT;

CREATE TABLE runner_workspace_results (
  result_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES runner_workspaces(workspace_id) ON DELETE CASCADE,
  result_tree_digest TEXT NOT NULL CHECK (length(result_tree_digest) = 64),
  result_revision_digest TEXT NOT NULL CHECK (length(result_revision_digest) = 64),
  completion_fact_digest TEXT NOT NULL CHECK (length(completion_fact_digest) = 64),
  capture_effect_id TEXT NOT NULL UNIQUE,
  inspect_effect_id TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  canonical_result TEXT NOT NULL
) STRICT;

CREATE TABLE runner_integration_attempts (
  integration_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation > 0),
  target_ref TEXT NOT NULL,
  fan_in_digest TEXT NOT NULL CHECK (length(fan_in_digest) = 64),
  state TEXT NOT NULL CHECK (
    state IN ('intent', 'claimed', 'candidate-created', 'validating', 'gate-failed',
              'publishing', 'published', 'barrier-recorded', 'conflicted',
              'target-moved', 'rework-required', 'cancelled', 'failed', 'unknown')
  ),
  owner_id TEXT,
  fence INTEGER CHECK (fence IS NULL OR fence > 0),
  slot_resource_key TEXT,
  prepare_effect_id TEXT NOT NULL UNIQUE,
  inspect_effect_id TEXT NOT NULL UNIQUE,
  barrier_digest TEXT CHECK (barrier_digest IS NULL OR length(barrier_digest) = 64),
  canonical_barrier TEXT,
  canonical_attempt TEXT NOT NULL,
  CHECK ((barrier_digest IS NULL) = (canonical_barrier IS NULL)),
  CHECK (
    (state = 'intent' AND owner_id IS NULL AND fence IS NULL AND slot_resource_key IS NULL)
    OR (state <> 'intent' AND owner_id IS NOT NULL AND fence IS NOT NULL
        AND slot_resource_key IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX runner_integration_one_active_repository_idx
  ON runner_integration_attempts(repository_id)
  WHERE state IN ('claimed', 'candidate-created', 'validating', 'publishing', 'unknown');

CREATE TABLE runner_integration_members (
  integration_id TEXT NOT NULL
    REFERENCES runner_integration_attempts(integration_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  workspace_id TEXT NOT NULL REFERENCES runner_workspaces(workspace_id),
  result_id TEXT NOT NULL REFERENCES runner_workspace_results(result_id),
  member_digest TEXT NOT NULL CHECK (length(member_digest) = 64),
  canonical_member TEXT NOT NULL,
  PRIMARY KEY (integration_id, ordinal),
  UNIQUE (integration_id, workspace_id),
  UNIQUE (integration_id, member_digest)
) STRICT;

CREATE TABLE runner_integration_gates (
  integration_id TEXT PRIMARY KEY
    REFERENCES runner_integration_attempts(integration_id) ON DELETE CASCADE,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  reading_digest TEXT NOT NULL CHECK (length(reading_digest) = 64),
  evaluation_digest TEXT NOT NULL CHECK (length(evaluation_digest) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('passed', 'failed')),
  canonical_evidence TEXT NOT NULL
) STRICT;

CREATE TABLE runner_completion_eligibility (
  submission_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('repository', 'worktree')),
  terminal_current_writer INTEGER NOT NULL CHECK (terminal_current_writer IN (0, 1)),
  workspace_id TEXT REFERENCES runner_workspaces(workspace_id),
  result_id TEXT REFERENCES runner_workspace_results(result_id),
  integration_id TEXT REFERENCES runner_integration_attempts(integration_id),
  barrier_digest TEXT CHECK (barrier_digest IS NULL OR length(barrier_digest) = 64),
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  canonical_eligibility TEXT NOT NULL,
  CHECK (
    (mode = 'repository' AND workspace_id IS NULL AND result_id IS NULL
      AND integration_id IS NULL AND barrier_digest IS NULL
      AND eligible = terminal_current_writer)
    OR
    (mode = 'worktree' AND workspace_id IS NOT NULL AND result_id IS NOT NULL
      AND integration_id IS NOT NULL
      AND ((eligible = 0) OR (eligible = 1 AND terminal_current_writer = 1
        AND barrier_digest IS NOT NULL)))
  )
) STRICT;

CREATE INDEX runner_capacity_reservations_run_idx
  ON runner_capacity_reservations(run_key, released, intent_id);
CREATE INDEX runner_workspaces_run_state_idx
  ON runner_workspaces(run_key, state, workspace_id);
CREATE INDEX runner_workspace_results_digest_idx
  ON runner_workspace_results(result_tree_digest, result_id);
CREATE INDEX runner_integrations_run_state_idx
  ON runner_integration_attempts(run_key, state, integration_id);
CREATE INDEX runner_integration_members_workspace_idx
  ON runner_integration_members(workspace_id, integration_id);
CREATE INDEX runner_completion_eligibility_pending_idx
  ON runner_completion_eligibility(eligible, run_key, submission_id);