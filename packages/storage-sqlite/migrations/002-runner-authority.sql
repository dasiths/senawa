CREATE TABLE runner_runs (
  run_key TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  UNIQUE (repository_id, run_id)
) STRICT;

CREATE TABLE runner_budgets (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  unit TEXT NOT NULL,
  budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
  reserved INTEGER NOT NULL CHECK (reserved >= 0),
  spent INTEGER NOT NULL CHECK (spent >= 0),
  unreported INTEGER NOT NULL CHECK (unreported >= 0),
  PRIMARY KEY (run_key, unit)
) STRICT;

CREATE TABLE runner_commands (
  command_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  canonical_command TEXT NOT NULL,
  UNIQUE (run_key, sequence, command_id)
) STRICT;

CREATE TABLE runner_effect_intents (
  intent_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  command_id TEXT NOT NULL UNIQUE REFERENCES runner_commands(command_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  attempt_id TEXT NOT NULL,
  canonical_intent TEXT NOT NULL
) STRICT;

CREATE TABLE runner_effect_claims (
  intent_id TEXT PRIMARY KEY REFERENCES runner_effect_intents(intent_id) ON DELETE CASCADE,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  attempt_id TEXT NOT NULL,
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  origin TEXT NOT NULL CHECK (
    origin IN ('dispatch', 'inspection', 'cancellation', 'settlement')
  )
) STRICT;

CREATE TABLE runner_effect_outcomes (
  intent_id TEXT NOT NULL REFERENCES runner_effect_intents(intent_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  commit_cursor INTEGER NOT NULL CHECK (commit_cursor > 0),
  status TEXT NOT NULL CHECK (
    status IN ('active', 'completed', 'failed', 'cancelled', 'unknown')
  ),
  canonical_outcome TEXT NOT NULL,
  PRIMARY KEY (intent_id, attempt_id),
  UNIQUE (intent_id, commit_cursor)
) STRICT;

CREATE TABLE runner_cancellation_requests (
  intent_id TEXT PRIMARY KEY REFERENCES runner_effect_intents(intent_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  requested_at TEXT NOT NULL
) STRICT;

CREATE TABLE runner_escalations (
  command_id TEXT PRIMARY KEY REFERENCES runner_commands(command_id) ON DELETE CASCADE,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  canonical_escalation TEXT NOT NULL
) STRICT;

CREATE TABLE runner_receipts (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  canonical_receipt TEXT NOT NULL,
  PRIMARY KEY (run_key, cursor)
) STRICT;

CREATE TABLE runner_events (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  event_type TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  PRIMARY KEY (run_key, cursor)
) STRICT;

CREATE TABLE runner_projections (
  run_key TEXT PRIMARY KEY REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  canonical_projection TEXT NOT NULL
) STRICT;

CREATE INDEX runner_commands_run_idx ON runner_commands(run_key, sequence, command_id);
CREATE INDEX runner_intents_run_idx ON runner_effect_intents(run_key, intent_id);
CREATE INDEX runner_claims_run_idx ON runner_effect_claims(run_key, intent_id);
CREATE INDEX runner_outcomes_latest_idx ON runner_effect_outcomes(intent_id, commit_cursor DESC);
CREATE INDEX runner_escalations_run_idx ON runner_escalations(run_key, command_id);