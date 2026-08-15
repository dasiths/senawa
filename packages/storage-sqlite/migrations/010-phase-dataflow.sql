CREATE TABLE workflow_input_bindings (
  run_key TEXT PRIMARY KEY REFERENCES runs(run_key) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  graph_revision_digest TEXT NOT NULL CHECK (length(graph_revision_digest) = 64),
  configuration_snapshot_digest TEXT NOT NULL REFERENCES configuration_snapshots(snapshot_digest),
  schema_key TEXT NOT NULL,
  schema_resource_digest TEXT NOT NULL CHECK (length(schema_resource_digest) = 64),
  content_digest TEXT NOT NULL REFERENCES assets(digest),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  validation_receipt_digest TEXT NOT NULL CHECK (length(validation_receipt_digest) = 64),
  binding_digest TEXT NOT NULL UNIQUE CHECK (length(binding_digest) = 64),
  canonical_binding TEXT NOT NULL,
  UNIQUE (repository_id, run_id),
  FOREIGN KEY (repository_id, run_id) REFERENCES runs(repository_id, run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE phase_attempts (
  attempt_digest TEXT PRIMARY KEY CHECK (length(attempt_digest) = 64),
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation > 0),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
  input_binding_digest TEXT NOT NULL CHECK (length(input_binding_digest) = 64),
  source_set_digest TEXT NOT NULL CHECK (length(source_set_digest) = 64),
  executor_digest TEXT NOT NULL CHECK (length(executor_digest) = 64),
  graph_revision_digest TEXT NOT NULL CHECK (length(graph_revision_digest) = 64),
  configuration_snapshot_digest TEXT NOT NULL REFERENCES configuration_snapshots(snapshot_digest),
  upstream_closure_set_digest TEXT NOT NULL CHECK (length(upstream_closure_set_digest) = 64),
  upstream_output_set_digest TEXT NOT NULL CHECK (length(upstream_output_set_digest) = 64),
  canonical_attempt TEXT NOT NULL,
  UNIQUE (run_key, phase_id, definition_generation, attempt_ordinal)
) STRICT;

CREATE TABLE phase_input_bindings (
  binding_digest TEXT PRIMARY KEY CHECK (length(binding_digest) = 64),
  attempt_digest TEXT NOT NULL UNIQUE REFERENCES phase_attempts(attempt_digest) ON DELETE CASCADE,
  schema_key TEXT NOT NULL,
  schema_resource_digest TEXT NOT NULL CHECK (length(schema_resource_digest) = 64),
  content_digest TEXT NOT NULL REFERENCES assets(digest),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  validation_receipt_digest TEXT NOT NULL CHECK (length(validation_receipt_digest) = 64),
  source_set_digest TEXT NOT NULL CHECK (length(source_set_digest) = 64),
  canonical_binding TEXT NOT NULL
) STRICT;

CREATE TABLE phase_input_sources (
  binding_digest TEXT NOT NULL REFERENCES phase_input_bindings(binding_digest) ON DELETE CASCADE,
  mapping_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('workflow-input', 'phase-output', 'current-item', 'implementation-evidence')
  ),
  source_binding_digest TEXT NOT NULL CHECK (length(source_binding_digest) = 64),
  selected_value_digest TEXT NOT NULL CHECK (length(selected_value_digest) = 64),
  destination_pointer TEXT NOT NULL,
  canonical_source TEXT NOT NULL,
  PRIMARY KEY (binding_digest, mapping_key),
  UNIQUE (binding_digest, destination_pointer)
) STRICT;

CREATE TABLE phase_output_assets (
  validation_receipt_digest TEXT PRIMARY KEY CHECK (length(validation_receipt_digest) = 64),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL CHECK (media_type = 'application/json'),
  schema_resource_digest TEXT NOT NULL CHECK (length(schema_resource_digest) = 64),
  canonical_bytes BLOB NOT NULL,
  canonical_descriptor TEXT NOT NULL,
  CHECK (length(canonical_bytes) = byte_length),
  UNIQUE (
    content_digest, byte_length, media_type, schema_resource_digest, validation_receipt_digest
  )
) STRICT;

CREATE TABLE phase_output_publications (
  publication_id TEXT PRIMARY KEY,
  publication_digest TEXT NOT NULL UNIQUE CHECK (length(publication_digest) = 64),
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  attempt_digest TEXT NOT NULL REFERENCES phase_attempts(attempt_digest) ON DELETE CASCADE,
  output_name TEXT NOT NULL,
  schema_key TEXT NOT NULL,
  schema_resource_digest TEXT NOT NULL CHECK (length(schema_resource_digest) = 64),
  content_digest TEXT NOT NULL REFERENCES assets(digest),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'internal', 'confidential', 'restricted')
  ),
  producing_task_id TEXT NOT NULL,
  producing_task_generation INTEGER NOT NULL CHECK (producing_task_generation > 0),
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  context_id TEXT NOT NULL REFERENCES context_bases(context_id),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  graph_revision_digest TEXT NOT NULL CHECK (length(graph_revision_digest) = 64),
  configuration_snapshot_digest TEXT NOT NULL REFERENCES configuration_snapshots(snapshot_digest),
  input_binding_digest TEXT NOT NULL REFERENCES phase_input_bindings(binding_digest),
  validation_receipt_digest TEXT NOT NULL REFERENCES phase_output_assets(validation_receipt_digest),
  canonical_publication TEXT NOT NULL,
  UNIQUE (attempt_digest, output_name)
) STRICT;

CREATE TABLE phase_output_acceptances (
  acceptance_digest TEXT PRIMARY KEY CHECK (length(acceptance_digest) = 64),
  publication_id TEXT NOT NULL UNIQUE REFERENCES phase_output_publications(publication_id),
  publication_digest TEXT NOT NULL CHECK (length(publication_digest) = 64),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  closure_digest TEXT NOT NULL CHECK (length(closure_digest) = 64),
  canonical_acceptance TEXT NOT NULL
) STRICT;

CREATE TABLE context_phase_output_outbox (
  submission_id TEXT PRIMARY KEY REFERENCES context_submissions(submission_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  canonical_fact TEXT NOT NULL,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1))
) STRICT;

ALTER TABLE portal_run_revisions
  ADD COLUMN dataflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (dataflow_revision >= 0);

UPDATE context_authority_state
SET canonical_json = CASE
  WHEN json_type(canonical_json, '$.taskScopes') IS NULL THEN
    json_object(
      'completionOutbox', json(json_extract(canonical_json, '$.completionOutbox')),
      'cursor', json_extract(canonical_json, '$.cursor'),
      'dispatches', json(json_extract(canonical_json, '$.dispatches')),
      'events', json(json_extract(canonical_json, '$.events')),
      'grants', json(json_extract(canonical_json, '$.grants')),
      'phaseOutputOutbox', json('[]'),
      'questions', json(json_extract(canonical_json, '$.questions')),
      'reads', json(json_extract(canonical_json, '$.reads')),
      'receiptAttempts', json(json_extract(canonical_json, '$.receiptAttempts')),
      'receipts', json(json_extract(canonical_json, '$.receipts')),
      'submissions', json(json_extract(canonical_json, '$.submissions')),
      'terminalCompletions', json(json_extract(canonical_json, '$.terminalCompletions')),
      'version', json_extract(canonical_json, '$.version')
    )
  ELSE
    json_object(
      'completionOutbox', json(json_extract(canonical_json, '$.completionOutbox')),
      'cursor', json_extract(canonical_json, '$.cursor'),
      'dispatches', json(json_extract(canonical_json, '$.dispatches')),
      'events', json(json_extract(canonical_json, '$.events')),
      'grants', json(json_extract(canonical_json, '$.grants')),
      'phaseOutputOutbox', json('[]'),
      'questions', json(json_extract(canonical_json, '$.questions')),
      'reads', json(json_extract(canonical_json, '$.reads')),
      'receiptAttempts', json(json_extract(canonical_json, '$.receiptAttempts')),
      'receipts', json(json_extract(canonical_json, '$.receipts')),
      'submissions', json(json_extract(canonical_json, '$.submissions')),
      'taskScopes', json(json_extract(canonical_json, '$.taskScopes')),
      'terminalCompletions', json(json_extract(canonical_json, '$.terminalCompletions')),
      'version', json_extract(canonical_json, '$.version')
    )
END
WHERE json_type(canonical_json, '$.phaseOutputOutbox') IS NULL;

CREATE TRIGGER portal_revision_workflow_input_insert
AFTER INSERT ON workflow_input_bindings
BEGIN
  UPDATE portal_run_revisions
  SET dataflow_revision = dataflow_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_phase_attempt_insert
AFTER INSERT ON phase_attempts
BEGIN
  UPDATE portal_run_revisions
  SET dataflow_revision = dataflow_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_phase_input_insert
AFTER INSERT ON phase_input_bindings
BEGIN
  UPDATE portal_run_revisions
  SET dataflow_revision = dataflow_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT runs.repository_id, runs.run_id
    FROM phase_attempts JOIN runs ON runs.run_key = phase_attempts.run_key
    WHERE phase_attempts.attempt_digest = NEW.attempt_digest
  );
END;

CREATE TRIGGER portal_revision_phase_publication_insert
AFTER INSERT ON phase_output_publications
BEGIN
  UPDATE portal_run_revisions
  SET dataflow_revision = dataflow_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT runs.repository_id, runs.run_id
    FROM phase_attempts JOIN runs ON runs.run_key = phase_attempts.run_key
    WHERE phase_attempts.attempt_digest = NEW.attempt_digest
  );
END;

CREATE TRIGGER portal_revision_phase_acceptance_insert
AFTER INSERT ON phase_output_acceptances
BEGIN
  UPDATE portal_run_revisions
  SET dataflow_revision = dataflow_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT runs.repository_id, runs.run_id
    FROM phase_output_publications
    JOIN phase_attempts ON phase_attempts.attempt_digest = phase_output_publications.attempt_digest
    JOIN runs ON runs.run_key = phase_attempts.run_key
    WHERE phase_output_publications.publication_id = NEW.publication_id
  );
END;

CREATE INDEX phase_attempts_run_idx
  ON phase_attempts(run_key, phase_id, definition_generation, attempt_ordinal);
CREATE INDEX phase_input_sources_source_idx
  ON phase_input_sources(source_binding_digest, selected_value_digest);
CREATE INDEX phase_output_publications_run_idx
  ON phase_output_publications(run_key, attempt_digest, output_name);
CREATE INDEX context_phase_output_outbox_delivery_idx
  ON context_phase_output_outbox(delivered, submission_id);
