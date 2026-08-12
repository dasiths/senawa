CREATE TABLE migration_metadata (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64)
) STRICT;

CREATE TABLE authority_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  canonical_json TEXT NOT NULL
) STRICT;

INSERT INTO authority_state(singleton, revision, canonical_json)
VALUES (1, 0, '{"runs":[],"version":"senawa.dev/runtime-memory/v1alpha1"}');

CREATE TABLE repositories (
  repository_id TEXT PRIMARY KEY,
  active_run_key TEXT UNIQUE,
  FOREIGN KEY (active_run_key) REFERENCES runs(run_key)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE runs (
  run_key TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
  run_id TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  records_json TEXT,
  projection_generated_at TEXT,
  revision_digest TEXT CHECK (revision_digest IS NULL OR length(revision_digest) = 64),
  UNIQUE (repository_id, run_id)
) STRICT;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  canonical_envelope TEXT NOT NULL,
  admission_json TEXT NOT NULL,
  terminal_receipt_json TEXT NOT NULL
) STRICT;

CREATE TABLE receipt_history (
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'claimed', 'completed', 'refused', 'expired', 'unknown-effect')
  ),
  canonical_receipt TEXT NOT NULL,
  PRIMARY KEY (run_key, cursor),
  UNIQUE (command_id, ordinal)
) STRICT;

CREATE TABLE event_frames (
  event_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  canonical_frame TEXT NOT NULL,
  UNIQUE (run_key, cursor)
) STRICT;

CREATE TABLE assets (
  digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT,
  relative_path TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE leases (
  resource_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  expires_at TEXT NOT NULL,
  UNIQUE (resource_key, fence)
) STRICT;

CREATE TABLE claims (
  claim_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  command_id TEXT UNIQUE REFERENCES commands(command_id),
  resource_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'released', 'cancelled'))
) STRICT;

CREATE TABLE cancellation_requests (
  request_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  requested_at TEXT NOT NULL
) STRICT;

CREATE TABLE effect_intents (
  intent_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  canonical_intent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'reconciling', 'resolved'))
) STRICT;

CREATE TABLE effect_outcomes (
  intent_id TEXT PRIMARY KEY REFERENCES effect_intents(intent_id) ON DELETE CASCADE,
  canonical_outcome TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'unknown'))
) STRICT;

CREATE INDEX receipt_history_command_idx ON receipt_history(command_id, ordinal);
CREATE INDEX event_frames_run_cursor_idx ON event_frames(run_key, cursor);
CREATE INDEX claims_run_idx ON claims(run_key);
CREATE INDEX cancellation_requests_run_idx ON cancellation_requests(run_key);
CREATE INDEX effect_intents_run_idx ON effect_intents(run_key);