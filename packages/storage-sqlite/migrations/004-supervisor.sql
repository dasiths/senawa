CREATE TABLE supervisor_repositories (
  repository_id TEXT PRIMARY KEY
) STRICT;

CREATE TABLE supervisor_repository_registry (
  repository_id TEXT PRIMARY KEY REFERENCES supervisor_repositories(repository_id),
  canonical_path TEXT NOT NULL UNIQUE,
  config_snapshot_id TEXT NOT NULL
) STRICT;

CREATE TABLE supervisor_runs (
  run_key TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES supervisor_repositories(repository_id),
  run_id TEXT NOT NULL,
  UNIQUE (repository_id, run_id)
) STRICT;

CREATE TABLE supervisor_commands (
  command_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES supervisor_runs(run_key) ON DELETE CASCADE,
  accepted_sequence INTEGER NOT NULL CHECK (accepted_sequence > 0),
  canonical_envelope TEXT NOT NULL,
  canonical_admission TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'terminal')),
  accepted_at TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  claim_owner_id TEXT,
  claim_fence INTEGER CHECK (claim_fence IS NULL OR claim_fence > 0),
  claim_expires_at TEXT,
  claim_expires_at_ms INTEGER,
  terminal_receipt_json TEXT,
  CHECK (
    (state = 'queued' AND claim_owner_id IS NULL AND claim_fence IS NULL
      AND claim_expires_at IS NULL AND claim_expires_at_ms IS NULL
      AND terminal_receipt_json IS NULL)
    OR (state = 'claimed' AND claim_owner_id IS NOT NULL AND claim_fence IS NOT NULL
      AND claim_expires_at IS NOT NULL AND claim_expires_at_ms IS NOT NULL
      AND terminal_receipt_json IS NULL)
    OR (state = 'terminal' AND claim_owner_id IS NULL AND claim_fence IS NULL
      AND claim_expires_at IS NULL AND claim_expires_at_ms IS NULL
      AND terminal_receipt_json IS NOT NULL)
  ),
  UNIQUE (run_key, accepted_sequence)
) STRICT;

CREATE TABLE supervisor_receipts (
  run_key TEXT NOT NULL REFERENCES supervisor_runs(run_key) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  command_id TEXT NOT NULL REFERENCES supervisor_commands(command_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'terminal')),
  recorded_at TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  canonical_receipt TEXT NOT NULL,
  PRIMARY KEY (run_key, sequence),
  UNIQUE (command_id, status)
) STRICT;

CREATE TABLE supervisor_wakes (
  run_key TEXT PRIMARY KEY REFERENCES supervisor_runs(run_key) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  ack_generation INTEGER NOT NULL CHECK (
    ack_generation >= 0 AND ack_generation <= generation
  ),
  not_before TEXT NOT NULL,
  not_before_ms INTEGER NOT NULL,
  reasons_json TEXT NOT NULL
) STRICT;

CREATE TABLE supervisor_service_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  desired_mode TEXT NOT NULL CHECK (
    desired_mode IN ('running', 'draining', 'drained', 'stopped')
  ),
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO supervisor_service_state(singleton, desired_mode, updated_at, updated_at_ms)
VALUES (1, 'running', '1970-01-01T00:00:00.000Z', 0);

CREATE TABLE supervisor_logs (
  cursor INTEGER PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  fields_json TEXT NOT NULL
) STRICT;

CREATE INDEX supervisor_commands_pending_idx
  ON supervisor_commands(run_key, state, accepted_sequence);
CREATE INDEX supervisor_receipts_command_idx
  ON supervisor_receipts(command_id, sequence);