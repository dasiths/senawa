CREATE TABLE context_authority_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  canonical_json TEXT NOT NULL
) STRICT;

INSERT INTO context_authority_state(singleton, canonical_json)
VALUES (1, '{"completionOutbox":[],"cursor":0,"dispatches":[],"events":[],"grants":[],"questions":[],"reads":[],"receiptAttempts":[],"receipts":[],"submissions":[],"terminalCompletions":[],"version":"senawa.dev/context-authority-durable/v1alpha1"}');

CREATE TABLE context_bases (
  context_id TEXT PRIMARY KEY,
  context_digest TEXT NOT NULL UNIQUE CHECK (length(context_digest) = 64),
  canonical_context TEXT NOT NULL
) STRICT;

CREATE TABLE context_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES context_bases(context_id),
  prompt_pack_digest TEXT NOT NULL CHECK (length(prompt_pack_digest) = 64),
  canonical_dispatch TEXT NOT NULL,
  canonical_completion_requirements TEXT NOT NULL,
  UNIQUE (repository_id, run_id, dispatch_id)
) STRICT;

CREATE TABLE context_asset_bindings (
  asset_binding_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES context_bases(context_id),
  semantic_asset_id TEXT NOT NULL,
  alias_binding_digest TEXT NOT NULL CHECK (length(alias_binding_digest) = 64),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  UNIQUE (context_id, semantic_asset_id, asset_binding_id)
) STRICT;

CREATE TABLE context_asset_manifests (
  asset_binding_id TEXT PRIMARY KEY REFERENCES context_asset_bindings(asset_binding_id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  chunk_size INTEGER NOT NULL CHECK (chunk_size = 65536),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0)
) STRICT;

CREATE TABLE context_asset_chunks (
  asset_binding_id TEXT NOT NULL REFERENCES context_asset_manifests(asset_binding_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 65536),
  chunk_digest TEXT NOT NULL CHECK (length(chunk_digest) = 64),
  content BLOB NOT NULL,
  PRIMARY KEY (asset_binding_id, chunk_index),
  UNIQUE (asset_binding_id, byte_offset)
) STRICT;

CREATE TABLE context_grants (
  token_digest TEXT PRIMARY KEY CHECK (length(token_digest) = 64),
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  asset_binding_id TEXT NOT NULL REFERENCES context_asset_bindings(asset_binding_id),
  canonical_envelope TEXT NOT NULL,
  operations_used INTEGER NOT NULL CHECK (operations_used >= 0),
  bytes_used INTEGER NOT NULL CHECK (bytes_used >= 0),
  UNIQUE (repository_id, run_id, token_digest)
) STRICT;

CREATE TABLE context_read_attempts (
  request_id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL CHECK (length(token_digest) = 64),
  dispatch_id TEXT,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_replay_key TEXT NOT NULL,
  replay_key_digest TEXT NOT NULL CHECK (length(replay_key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('in-flight', 'served', 'denied')),
  result_bytes BLOB,
  canonical_receipt TEXT,
  owner_id TEXT,
  fence INTEGER CHECK (fence IS NULL OR fence > 0),
  FOREIGN KEY (dispatch_id) REFERENCES context_dispatches(dispatch_id),
  CHECK ((status = 'in-flight') = (canonical_receipt IS NULL))
) STRICT;

CREATE TABLE context_audit_receipts (
  receipt_cursor INTEGER PRIMARY KEY CHECK (receipt_cursor > 0),
  request_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  canonical_replay_key TEXT NOT NULL,
  replay_key_digest TEXT NOT NULL CHECK (length(replay_key_digest) = 64),
  token_digest TEXT NOT NULL CHECK (length(token_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  reserved INTEGER NOT NULL CHECK (reserved IN (0, 1)),
  failure_stage TEXT CHECK (failure_stage IS NULL OR failure_stage IN ('asset-read', 'asset-integrity')),
  failure_fact_digest TEXT CHECK (failure_fact_digest IS NULL OR length(failure_fact_digest) = 64),
  canonical_receipt TEXT NOT NULL,
  CHECK ((failure_stage IS NULL) = (failure_fact_digest IS NULL))
) STRICT;

CREATE TABLE context_events (
  cursor INTEGER PRIMARY KEY CHECK (cursor > 0),
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  event_type TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  UNIQUE (repository_id, run_id, cursor)
) STRICT;

CREATE TABLE context_projection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  canonical_projection TEXT NOT NULL
) STRICT;

INSERT INTO context_projection(singleton, cursor, canonical_projection)
VALUES (
  1,
  0,
  '{"acceptedSubmissions":0,"cursor":0,"deniedReads":0,"duplicateSubmissions":0,"grants":0,"questions":0,"registeredContexts":0,"registeredDispatches":0,"servedReads":0,"staleSubmissions":0}'
);

CREATE TABLE context_submissions (
  submission_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  submission_type TEXT NOT NULL,
  canonical_submission TEXT NOT NULL,
  canonical_result TEXT NOT NULL,
  UNIQUE (repository_id, run_id, submission_id)
) STRICT;

CREATE TABLE context_questions (
  submission_id TEXT PRIMARY KEY REFERENCES context_submissions(submission_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_question TEXT NOT NULL
) STRICT;

CREATE TABLE context_terminal_completions (
  dispatch_id TEXT PRIMARY KEY REFERENCES context_dispatches(dispatch_id),
  submission_id TEXT NOT NULL UNIQUE REFERENCES context_submissions(submission_id)
) STRICT;

CREATE TABLE context_completion_outbox (
  submission_id TEXT PRIMARY KEY REFERENCES context_submissions(submission_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  canonical_fact TEXT NOT NULL,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1))
) STRICT;

CREATE INDEX context_dispatches_run_idx
  ON context_dispatches(repository_id, run_id, dispatch_id);
CREATE INDEX context_assets_content_idx
  ON context_asset_bindings(content_digest, asset_binding_id);
CREATE INDEX context_chunks_range_idx
  ON context_asset_chunks(asset_binding_id, byte_offset);
CREATE INDEX context_grants_dispatch_idx
  ON context_grants(repository_id, run_id, dispatch_id);
CREATE INDEX context_reads_run_idx
  ON context_read_attempts(repository_id, run_id, request_id);
CREATE INDEX context_receipts_run_idx
  ON context_audit_receipts(repository_id, run_id, receipt_cursor);
CREATE INDEX context_submissions_dispatch_idx
  ON context_submissions(repository_id, run_id, dispatch_id);