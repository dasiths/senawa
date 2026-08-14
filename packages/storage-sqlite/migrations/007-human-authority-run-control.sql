CREATE TABLE context_question_answers (
  submission_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  question_digest TEXT NOT NULL CHECK (length(question_digest) = 64),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  task_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation > 0),
  answer_digest TEXT NOT NULL CHECK (length(answer_digest) = 64),
  canonical_answer TEXT NOT NULL,
  principal_digest TEXT NOT NULL CHECK (length(principal_digest) = 64),
  canonical_principal TEXT NOT NULL,
  answered_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_fresh_dispatch_requirements (
  submission_id TEXT PRIMARY KEY
    REFERENCES context_question_answers(submission_id) ON DELETE CASCADE,
  run_key TEXT NOT NULL,
  historical_dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  task_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation > 0),
  requirement_digest TEXT NOT NULL UNIQUE CHECK (length(requirement_digest) = 64),
  created_at TEXT NOT NULL,
  satisfied_by_dispatch_id TEXT REFERENCES context_dispatches(dispatch_id),
  CHECK (satisfied_by_dispatch_id IS NULL OR satisfied_by_dispatch_id <> historical_dispatch_id)
) STRICT;

CREATE TABLE runner_allowance_policies (
  run_key TEXT PRIMARY KEY REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  canonical_policy TEXT NOT NULL
) STRICT;

CREATE TABLE runner_allowance_resolutions (
  escalation_command_id TEXT PRIMARY KEY
    REFERENCES runner_escalations(command_id) ON DELETE CASCADE,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  escalation_digest TEXT NOT NULL CHECK (length(escalation_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  unit TEXT NOT NULL,
  prior_limit INTEGER NOT NULL CHECK (prior_limit >= 0),
  increase_by INTEGER NOT NULL CHECK (increase_by > 0),
  resulting_limit INTEGER NOT NULL CHECK (resulting_limit = prior_limit + increase_by),
  principal_digest TEXT NOT NULL CHECK (length(principal_digest) = 64),
  canonical_principal TEXT NOT NULL,
  resolved_at TEXT NOT NULL
) STRICT;

CREATE TABLE run_control_state (
  run_key TEXT PRIMARY KEY REFERENCES runs(run_key) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('running', 'paused', 'ending', 'ended')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  changed_at TEXT NOT NULL,
  UNIQUE (repository_id, run_id)
) STRICT;

CREATE TABLE run_control_events (
  run_key TEXT NOT NULL REFERENCES run_control_state(run_key) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  event_id TEXT NOT NULL UNIQUE,
  command_id TEXT REFERENCES commands(command_id),
  prior_mode TEXT NOT NULL CHECK (prior_mode IN ('running', 'paused', 'ending')),
  result_mode TEXT NOT NULL CHECK (result_mode IN ('running', 'paused', 'ending', 'ended')),
  principal_digest TEXT NOT NULL CHECK (length(principal_digest) = 64),
  canonical_event TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (run_key, revision)
) STRICT;

CREATE INDEX context_fresh_dispatch_pending_idx
  ON context_fresh_dispatch_requirements(run_key, task_id, definition_generation)
  WHERE satisfied_by_dispatch_id IS NULL;
CREATE INDEX runner_allowance_resolutions_run_idx
  ON runner_allowance_resolutions(run_key, resolved_at, escalation_command_id);
CREATE INDEX run_control_mode_idx ON run_control_state(mode, repository_id, run_id);