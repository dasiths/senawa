-- Baseline schema for senawa v1. The alpha migration chain was collapsed
-- into this file; v1 creates its state root fresh and migrates nothing.

CREATE TABLE agent_session_resume_bindings (
  binding_digest TEXT PRIMARY KEY CHECK (length(binding_digest) = 64),
  predecessor_dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  predecessor_session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_generation INTEGER NOT NULL CHECK (task_generation > 0),
  context_id TEXT NOT NULL REFERENCES context_bases(context_id),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  graph_revision_digest TEXT NOT NULL CHECK (length(graph_revision_digest) = 64),
  configuration_snapshot_digest TEXT NOT NULL REFERENCES configuration_snapshots(snapshot_digest),
  prompt_resource_digest TEXT NOT NULL CHECK (length(prompt_resource_digest) = 64),
  prompt_content_digest TEXT NOT NULL CHECK (length(prompt_content_digest) = 64),
  prompt_pack_digest TEXT NOT NULL CHECK (length(prompt_pack_digest) = 64),
  mapped_input_digest TEXT NOT NULL CHECK (length(mapped_input_digest) = 64),
  model_selection_digest TEXT NOT NULL CHECK (length(model_selection_digest) = 64),
  repository_commit_digest TEXT NOT NULL CHECK (length(repository_commit_digest) = 64),
  repository_tree_digest TEXT NOT NULL CHECK (length(repository_tree_digest) = 64),
  canonical_binding TEXT NOT NULL,
  UNIQUE (predecessor_dispatch_id, predecessor_session_id)
) STRICT;

CREATE TABLE agent_transcript_lines (
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('dispatch', 'task', 'phase')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0 AND length(owner_id) <= 128),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  run_sequence INTEGER NOT NULL CHECK (run_sequence > 0),
  line_id TEXT NOT NULL CHECK (length(line_id) > 0 AND length(line_id) <= 128),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24),
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  text TEXT NOT NULL CHECK (
    length(text) > 0
    AND octet_length(text) <= 4096
    AND instr(text, char(10)) = 0
    AND instr(text, char(13)) = 0
    AND instr(text, char(133)) = 0
    AND instr(text, char(8232)) = 0
    AND instr(text, char(8233)) = 0
  ),
  PRIMARY KEY (run_key, owner_kind, owner_id, sequence),
  UNIQUE (run_key, owner_kind, owner_id, line_id),
  UNIQUE (run_key, run_sequence)
) STRICT;

CREATE TABLE amendment_applications (
  amendment_id TEXT PRIMARY KEY REFERENCES amendment_proposals(amendment_id) ON DELETE CASCADE,
  application_digest TEXT NOT NULL UNIQUE CHECK (length(application_digest) = 64),
  before_graph_revision_digest TEXT NOT NULL CHECK (length(before_graph_revision_digest) = 64),
  after_graph_revision_digest TEXT NOT NULL CHECK (length(after_graph_revision_digest) = 64),
  quiescence_fact_digest TEXT NOT NULL CHECK (length(quiescence_fact_digest) = 64),
  canonical_application TEXT NOT NULL
) STRICT;

CREATE TABLE amendment_decisions (
  approval_id TEXT PRIMARY KEY,
  amendment_id TEXT NOT NULL UNIQUE REFERENCES amendment_proposals(amendment_id) ON DELETE CASCADE,
  proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
  decision_digest TEXT NOT NULL UNIQUE CHECK (length(decision_digest) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  canonical_decision TEXT NOT NULL
) STRICT;

CREATE TABLE amendment_fenced_dispatches (
  amendment_id TEXT NOT NULL REFERENCES amendment_proposals(amendment_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation > 0),
  prior_fence_generation INTEGER NOT NULL CHECK (prior_fence_generation > 0),
  installed_fence_generation INTEGER NOT NULL CHECK (
    installed_fence_generation = prior_fence_generation + 1
  ),
  PRIMARY KEY (amendment_id, dispatch_id)
) STRICT;

CREATE TABLE amendment_proposal_bridge_outcomes (
  submission_id TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('acknowledged', 'compiled', 'diagnostics')),
  canonical_outcome TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE amendment_proposals (
  amendment_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
  base_graph_revision_digest TEXT NOT NULL CHECK (length(base_graph_revision_digest) = 64),
  base_context_digest TEXT NOT NULL CHECK (length(base_context_digest) = 64),
  base_snapshot_digest TEXT NOT NULL REFERENCES configuration_snapshots(snapshot_digest),
  result_snapshot_digest TEXT NOT NULL REFERENCES configuration_snapshots(snapshot_digest),
  reviewed_graph_revision_digest TEXT NOT NULL CHECK (length(reviewed_graph_revision_digest) = 64),
  canonical_proposal TEXT NOT NULL,
  UNIQUE (run_key, proposal_digest)
) STRICT;

CREATE TABLE amendment_withdrawals (
  amendment_id TEXT PRIMARY KEY REFERENCES amendment_proposals(amendment_id) ON DELETE CASCADE,
  withdrawal_digest TEXT NOT NULL UNIQUE CHECK (length(withdrawal_digest) = 64),
  canonical_withdrawal TEXT NOT NULL
) STRICT;

CREATE TABLE amendment_work_fences (
  run_key TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation > 0),
  fence_generation INTEGER NOT NULL CHECK (fence_generation > 0),
  current_context_digest TEXT NOT NULL CHECK (length(current_context_digest) = 64),
  claims_accepted INTEGER NOT NULL CHECK (claims_accepted IN (0, 1)),
  amendment_id TEXT REFERENCES amendment_proposals(amendment_id),
  installed_at TEXT,
  PRIMARY KEY (run_key, task_id, definition_generation),
  CHECK ((claims_accepted = 1) = (installed_at IS NULL))
) STRICT;

CREATE TABLE assets (
  digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT,
  relative_path TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE authority_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  canonical_json TEXT NOT NULL
) STRICT;

CREATE TABLE cancellation_requests (
  request_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  requested_at TEXT NOT NULL
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

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  canonical_envelope TEXT NOT NULL,
  admission_json TEXT NOT NULL,
  terminal_receipt_json TEXT NOT NULL
) STRICT;

CREATE TABLE configuration_snapshots (
  snapshot_digest TEXT PRIMARY KEY CHECK (length(snapshot_digest) = 64),
  graph_revision_digest TEXT NOT NULL CHECK (length(graph_revision_digest) = 64),
  canonical_snapshot TEXT NOT NULL
) STRICT;

CREATE TABLE context_amendment_outbox (
  submission_id TEXT PRIMARY KEY REFERENCES context_submissions(submission_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  context_id TEXT NOT NULL REFERENCES context_bases(context_id),
  amendment_id TEXT,
  canonical_source TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1)),
  claim_owner_id TEXT,
  claim_fence INTEGER CHECK (claim_fence IS NULL OR claim_fence > 0),
  claim_expires_at TEXT,
  CHECK (
    (delivered = 0 AND claim_owner_id IS NULL AND claim_expires_at IS NULL)
    OR (delivered = 0 AND claim_owner_id IS NOT NULL AND claim_fence IS NOT NULL
      AND claim_expires_at IS NOT NULL)
    OR (delivered = 1 AND claim_owner_id IS NULL AND claim_fence IS NOT NULL
      AND claim_expires_at IS NULL)
  )
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

CREATE TABLE context_asset_manifests (
  asset_binding_id TEXT PRIMARY KEY REFERENCES context_asset_bindings(asset_binding_id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  chunk_size INTEGER NOT NULL CHECK (chunk_size = 65536),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0)
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

CREATE TABLE context_authority_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  canonical_json TEXT NOT NULL
) STRICT;

CREATE TABLE context_bases (
  context_id TEXT PRIMARY KEY,
  context_digest TEXT NOT NULL UNIQUE CHECK (length(context_digest) = 64),
  canonical_context TEXT NOT NULL
) STRICT;

CREATE TABLE context_completion_outbox (
  submission_id TEXT PRIMARY KEY REFERENCES context_submissions(submission_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  canonical_fact TEXT NOT NULL,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1))
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

CREATE TABLE context_events (
  cursor INTEGER PRIMARY KEY CHECK (cursor > 0),
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  event_type TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  UNIQUE (repository_id, run_id, cursor)
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

CREATE TABLE context_phase_output_outbox (
  submission_id TEXT PRIMARY KEY REFERENCES context_submissions(submission_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id),
  canonical_fact TEXT NOT NULL,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1))
) STRICT;

CREATE TABLE context_projection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  canonical_projection TEXT NOT NULL
) STRICT;

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

CREATE TABLE context_questions (
  submission_id TEXT PRIMARY KEY REFERENCES context_submissions(submission_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  canonical_question TEXT NOT NULL
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

CREATE TABLE context_terminal_completions (
  dispatch_id TEXT PRIMARY KEY REFERENCES context_dispatches(dispatch_id),
  submission_id TEXT NOT NULL UNIQUE REFERENCES context_submissions(submission_id)
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

CREATE TABLE event_frames (
  event_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  canonical_frame TEXT NOT NULL,
  UNIQUE (run_key, cursor)
) STRICT;

CREATE TABLE fan_out_diff_decisions (
  decision_digest TEXT PRIMARY KEY CHECK (length(decision_digest) = 64),
  evaluation_digest TEXT NOT NULL UNIQUE REFERENCES fan_out_evaluations(evaluation_digest),
  prior_evaluation_digest TEXT REFERENCES fan_out_evaluations(evaluation_digest),
  diff_digest TEXT NOT NULL UNIQUE CHECK (length(diff_digest) = 64),
  authority_digest TEXT NOT NULL CHECK (length(authority_digest) = 64),
  canonical_decision TEXT NOT NULL
) STRICT;

CREATE TABLE fan_out_evaluations (
  evaluation_digest TEXT PRIMARY KEY CHECK (length(evaluation_digest) = 64),
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  attempt_digest TEXT NOT NULL REFERENCES phase_attempts(attempt_digest) ON DELETE CASCADE,
  for_each_key TEXT NOT NULL,
  prior_evaluation_digest TEXT REFERENCES fan_out_evaluations(evaluation_digest),
  definition_digest TEXT NOT NULL CHECK (length(definition_digest) = 64),
  source_binding_digest TEXT NOT NULL CHECK (length(source_binding_digest) = 64),
  collection_digest TEXT NOT NULL CHECK (length(collection_digest) = 64),
  task_set_digest TEXT NOT NULL CHECK (length(task_set_digest) = 64),
  graph_revision_digest TEXT NOT NULL CHECK (length(graph_revision_digest) = 64),
  configuration_snapshot_digest TEXT NOT NULL REFERENCES configuration_snapshots(snapshot_digest),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  canonical_evaluation TEXT NOT NULL,
  UNIQUE (run_key, attempt_digest, for_each_key, prior_evaluation_digest)
) STRICT;

CREATE TABLE fan_out_members (
  evaluation_digest TEXT NOT NULL REFERENCES fan_out_evaluations(evaluation_digest) ON DELETE CASCADE,
  stable_identity TEXT NOT NULL,
  item_digest TEXT NOT NULL CHECK (length(item_digest) = 64),
  task_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_generation INTEGER NOT NULL CHECK (task_generation > 0),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  member_digest TEXT NOT NULL CHECK (length(member_digest) = 64),
  canonical_member TEXT NOT NULL,
  PRIMARY KEY (evaluation_digest, stable_identity),
  UNIQUE (evaluation_digest, task_key),
  UNIQUE (evaluation_digest, task_id),
  UNIQUE (evaluation_digest, member_digest)
) STRICT;

CREATE TABLE leases (
  resource_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  expires_at TEXT NOT NULL,
  UNIQUE (resource_key, fence)
) STRICT;

CREATE TABLE migration_metadata (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64)
) STRICT;

CREATE TABLE phase_attempt_transitions (
  transition_digest TEXT PRIMARY KEY CHECK (length(transition_digest) = 64),
  attempt_digest TEXT NOT NULL REFERENCES phase_attempts(attempt_digest) ON DELETE CASCADE,
  predecessor_transition_digest TEXT REFERENCES phase_attempt_transitions(transition_digest),
  trigger_kind TEXT NOT NULL CHECK (
    trigger_kind IN ('gate-rejected', 'approval-rejected', 'upstream-changed', 'closure-created')
  ),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('iterate', 'escalate', 'fail', 'closed', 'refused')
  ),
  next_attempt_ordinal INTEGER CHECK (next_attempt_ordinal IS NULL OR next_attempt_ordinal > 0),
  canonical_transition TEXT NOT NULL,
  UNIQUE (attempt_digest),
  UNIQUE (predecessor_transition_digest)
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

CREATE TABLE phase_output_acceptances (
  acceptance_digest TEXT PRIMARY KEY CHECK (length(acceptance_digest) = 64),
  publication_id TEXT NOT NULL UNIQUE REFERENCES phase_output_publications(publication_id),
  publication_digest TEXT NOT NULL CHECK (length(publication_digest) = 64),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  closure_digest TEXT NOT NULL CHECK (length(closure_digest) = 64),
  canonical_acceptance TEXT NOT NULL
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

CREATE TABLE phase_output_attempts (
  dispatch_id TEXT NOT NULL REFERENCES context_dispatches(dispatch_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) > 0 AND length(attempt_id) <= 128),
  output_name TEXT NOT NULL CHECK (length(output_name) > 0 AND length(output_name) <= 63),
  tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) > 0 AND length(tool_call_id) <= 128),
  outcome TEXT NOT NULL CHECK (outcome IN ('rejected', 'accepted')),
  findings_digest TEXT CHECK (findings_digest IS NULL OR length(findings_digest) = 64),
  submission_id TEXT,
  canonical_attempt TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, attempt_id),
  CHECK (
    (outcome = 'rejected' AND findings_digest IS NOT NULL AND submission_id IS NULL)
    OR (outcome = 'accepted' AND findings_digest IS NULL AND submission_id IS NOT NULL)
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

CREATE TABLE plan_imports (
  evaluation_digest TEXT PRIMARY KEY REFERENCES fan_out_evaluations(evaluation_digest),
  acceptance_digest TEXT NOT NULL REFERENCES phase_output_acceptances(acceptance_digest),
  proposal_digest TEXT NOT NULL UNIQUE CHECK (length(proposal_digest) = 64),
  amendment_id TEXT NOT NULL UNIQUE,
  decision_digest TEXT CHECK (decision_digest IS NULL OR length(decision_digest) = 64),
  application_digest TEXT CHECK (application_digest IS NULL OR length(application_digest) = 64),
  state TEXT NOT NULL CHECK (
    state IN ('proposed', 'approved', 'rejected', 'applied', 'stale', 'review-required')
  ),
  canonical_import TEXT NOT NULL
) STRICT;

CREATE TABLE portal_run_revisions (
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision >= 0),
  context_revision INTEGER NOT NULL CHECK (context_revision >= 0),
  runner_revision INTEGER NOT NULL CHECK (runner_revision >= 0),
  workspace_revision INTEGER NOT NULL CHECK (workspace_revision >= 0),
  human_revision INTEGER NOT NULL CHECK (human_revision >= 0),
  portal_revision INTEGER NOT NULL CHECK (portal_revision >= 0), dataflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (dataflow_revision >= 0), task_frontier_revision INTEGER NOT NULL DEFAULT 0
  CHECK (task_frontier_revision >= 0), transcript_revision INTEGER NOT NULL DEFAULT 0
  CHECK (transcript_revision >= 0),
  PRIMARY KEY (repository_id, run_id),
  FOREIGN KEY (repository_id, run_id) REFERENCES runs(repository_id, run_id) ON DELETE CASCADE
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

CREATE TABLE remote_command_inbox (
  binding_id TEXT NOT NULL REFERENCES remote_peer_state(binding_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  repository_id TEXT NOT NULL,
  acceptance_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  revocation_epoch INTEGER NOT NULL CHECK (revocation_epoch >= 0),
  previous_envelope_digest TEXT CHECK (
    previous_envelope_digest IS NULL OR length(previous_envelope_digest) = 64
  ),
  envelope_digest TEXT NOT NULL CHECK (length(envelope_digest) = 64),
  canonical_envelope TEXT NOT NULL,
  delivery_entry_digest TEXT NOT NULL CHECK (length(delivery_entry_digest) = 64),
  canonical_delivery_entry TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processing_state TEXT NOT NULL CHECK (
    processing_state IN (
      'waiting', 'ready', 'conflict', 'expired', 'revoked',
      'local-accepted', 'local-result'
    )
  ),
  local_command_id TEXT,
  local_acceptance_digest TEXT CHECK (
    local_acceptance_digest IS NULL OR length(local_acceptance_digest) = 64
  ),
  canonical_local_acceptance TEXT,
  local_accepted_at TEXT,
  local_result_digest TEXT CHECK (local_result_digest IS NULL OR length(local_result_digest) = 64),
  canonical_local_result TEXT,
  local_result_at TEXT,
  local_result_report_id TEXT,
  PRIMARY KEY (binding_id, sequence),
  UNIQUE (binding_id, acceptance_id),
  UNIQUE (binding_id, command_id),
  UNIQUE (binding_id, envelope_digest),
  CHECK (
    (sequence = 1 AND previous_envelope_digest IS NULL)
    OR (sequence > 1 AND previous_envelope_digest IS NOT NULL)
  ),
  CHECK (
    (processing_state IN ('waiting', 'ready', 'conflict', 'expired', 'revoked')
      AND local_command_id IS NULL
      AND local_acceptance_digest IS NULL
      AND canonical_local_acceptance IS NULL
      AND local_accepted_at IS NULL
      AND local_result_digest IS NULL
      AND canonical_local_result IS NULL
      AND local_result_at IS NULL
      AND local_result_report_id IS NULL)
    OR (processing_state = 'local-accepted'
      AND local_command_id IS NOT NULL
      AND local_acceptance_digest IS NOT NULL
      AND canonical_local_acceptance IS NOT NULL
      AND local_accepted_at IS NOT NULL
      AND local_result_digest IS NULL
      AND canonical_local_result IS NULL
      AND local_result_at IS NULL
      AND local_result_report_id IS NULL)
    OR (processing_state = 'local-result'
      AND local_command_id IS NOT NULL
      AND local_acceptance_digest IS NOT NULL
      AND canonical_local_acceptance IS NOT NULL
      AND local_accepted_at IS NOT NULL
      AND local_result_digest IS NOT NULL
      AND canonical_local_result IS NOT NULL
      AND local_result_at IS NOT NULL
      AND local_result_report_id IS NOT NULL)
  ),
  FOREIGN KEY (local_result_report_id, binding_id)
    REFERENCES remote_report_outbox(report_id, binding_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE remote_history_commitments (
  binding_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  canonical_binding TEXT NOT NULL,
  inbound_sequence INTEGER NOT NULL CHECK (inbound_sequence >= 0),
  inbound_digest TEXT CHECK (inbound_digest IS NULL OR length(inbound_digest) = 64),
  outbound_report_sequence INTEGER NOT NULL CHECK (outbound_report_sequence >= 0),
  outbound_report_digest TEXT CHECK (
    outbound_report_digest IS NULL OR length(outbound_report_digest) = 64
  ),
  acknowledged_report_sequence INTEGER NOT NULL CHECK (acknowledged_report_sequence >= 0),
  acknowledged_report_digest TEXT CHECK (
    acknowledged_report_digest IS NULL OR length(acknowledged_report_digest) = 64
  ),
  acknowledged_cursor INTEGER NOT NULL CHECK (acknowledged_cursor >= 0),
  canonical_run_event_commitments TEXT NOT NULL,
  run_event_commitments_digest TEXT NOT NULL CHECK (length(run_event_commitments_digest) = 64),
  CHECK ((inbound_sequence = 0) = (inbound_digest IS NULL)),
  CHECK ((outbound_report_sequence = 0) = (outbound_report_digest IS NULL)),
  CHECK ((acknowledged_report_sequence = 0) = (acknowledged_report_digest IS NULL)),
  CHECK (acknowledged_report_sequence <= outbound_report_sequence)
) STRICT;

CREATE TABLE remote_peer_state (
  binding_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  canonical_binding TEXT NOT NULL,
  current_revocation_epoch INTEGER NOT NULL CHECK (current_revocation_epoch >= 0),
  session_id TEXT,
  selected_protocol_version TEXT,
  canonical_capabilities TEXT,
  last_observed_at TEXT NOT NULL,
  UNIQUE (repository_id, binding_id)
) STRICT;

CREATE TABLE remote_report_outbox (
  report_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES remote_peer_state(binding_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  report_sequence INTEGER NOT NULL CHECK (report_sequence > 0),
  previous_report_digest TEXT CHECK (
    previous_report_digest IS NULL OR length(previous_report_digest) = 64
  ),
  report_digest TEXT NOT NULL UNIQUE CHECK (length(report_digest) = 64),
  data_policy_digest TEXT NOT NULL CHECK (length(data_policy_digest) = 64),
  source_cursor INTEGER NOT NULL CHECK (source_cursor >= 0),
  event_advance_count INTEGER NOT NULL CHECK (event_advance_count >= 0),
  canonical_report TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'claimed', 'acknowledged')),
  claim_owner_id TEXT,
  claim_fence INTEGER CHECK (claim_fence IS NULL OR claim_fence > 0),
  claim_expires_at TEXT,
  acknowledgement_digest TEXT CHECK (
    acknowledgement_digest IS NULL OR length(acknowledgement_digest) = 64
  ),
  canonical_acknowledgement TEXT,
  central_receipt_id TEXT,
  acknowledged_at TEXT,
  UNIQUE (report_id, binding_id),
  UNIQUE (binding_id, report_sequence),
  CHECK (
    (report_sequence = 1 AND previous_report_digest IS NULL)
    OR (report_sequence > 1 AND previous_report_digest IS NOT NULL)
  ),
  CHECK (
    (delivery_state = 'pending'
      AND claim_owner_id IS NULL
      AND claim_expires_at IS NULL
      AND acknowledgement_digest IS NULL
      AND canonical_acknowledgement IS NULL
      AND central_receipt_id IS NULL
      AND acknowledged_at IS NULL)
    OR (delivery_state = 'claimed'
      AND claim_owner_id IS NOT NULL
      AND claim_fence IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND acknowledgement_digest IS NULL
      AND canonical_acknowledgement IS NULL
      AND central_receipt_id IS NULL
      AND acknowledged_at IS NULL)
    OR (delivery_state = 'acknowledged'
      AND claim_owner_id IS NULL
      AND claim_fence IS NOT NULL
      AND claim_expires_at IS NULL
      AND acknowledgement_digest IS NOT NULL
      AND canonical_acknowledgement IS NOT NULL
      AND central_receipt_id IS NOT NULL
      AND acknowledged_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE remote_report_run_event_advances (
  report_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  from_cursor INTEGER NOT NULL CHECK (from_cursor >= 0),
  through_cursor INTEGER NOT NULL CHECK (through_cursor >= from_cursor),
  local_latest_cursor INTEGER NOT NULL CHECK (local_latest_cursor >= through_cursor),
  PRIMARY KEY (report_id, run_id),
  FOREIGN KEY (report_id, binding_id)
    REFERENCES remote_report_outbox(report_id, binding_id) ON DELETE CASCADE,
  FOREIGN KEY (binding_id, repository_id, run_id)
    REFERENCES remote_run_event_checkpoints(binding_id, repository_id, run_id)
) STRICT;

CREATE TABLE remote_run_event_checkpoints (
  binding_id TEXT NOT NULL REFERENCES remote_peer_state(binding_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  local_latest_cursor INTEGER NOT NULL CHECK (local_latest_cursor >= 0),
  durably_enqueued_cursor INTEGER NOT NULL CHECK (durably_enqueued_cursor >= 0),
  centrally_acknowledged_cursor INTEGER NOT NULL CHECK (centrally_acknowledged_cursor >= 0),
  last_enqueued_report_sequence INTEGER NOT NULL CHECK (last_enqueued_report_sequence >= 0),
  last_acknowledged_report_sequence INTEGER NOT NULL CHECK (
    last_acknowledged_report_sequence >= 0
  ),
  PRIMARY KEY (binding_id, run_id),
  UNIQUE (binding_id, repository_id, run_id),
  FOREIGN KEY (repository_id, run_id) REFERENCES runs(repository_id, run_id),
  CHECK (durably_enqueued_cursor <= local_latest_cursor),
  CHECK (centrally_acknowledged_cursor <= durably_enqueued_cursor),
  CHECK (last_acknowledged_report_sequence <= last_enqueued_report_sequence)
) STRICT;

CREATE TABLE remote_stream_checkpoints (
  binding_id TEXT NOT NULL REFERENCES remote_peer_state(binding_id) ON DELETE CASCADE,
  stream_kind TEXT NOT NULL CHECK (
    stream_kind IN ('inbound-command', 'outbound-report', 'outbound-acknowledgement')
  ),
  contiguous_sequence INTEGER NOT NULL CHECK (contiguous_sequence >= 0),
  last_digest TEXT CHECK (last_digest IS NULL OR length(last_digest) = 64),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (binding_id, stream_kind),
  CHECK (
    (contiguous_sequence = 0 AND last_digest IS NULL)
    OR (contiguous_sequence > 0 AND last_digest IS NOT NULL)
  )
) STRICT;

CREATE TABLE remote_synchronization_vectors (
  binding_id TEXT PRIMARY KEY REFERENCES remote_peer_state(binding_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  local_latest_cursor INTEGER NOT NULL CHECK (local_latest_cursor >= 0),
  durably_enqueued_cursor INTEGER NOT NULL CHECK (durably_enqueued_cursor >= 0),
  centrally_acknowledged_cursor INTEGER NOT NULL CHECK (centrally_acknowledged_cursor >= 0),
  local_observed_at TEXT NOT NULL,
  last_enqueued_at TEXT,
  last_acknowledged_at TEXT,
  CHECK (durably_enqueued_cursor <= local_latest_cursor),
  CHECK (centrally_acknowledged_cursor <= durably_enqueued_cursor),
  CHECK (
    (durably_enqueued_cursor = 0 AND last_enqueued_at IS NULL)
    OR (durably_enqueued_cursor > 0 AND last_enqueued_at IS NOT NULL)
  ),
  CHECK (
    (centrally_acknowledged_cursor = 0 AND last_acknowledged_at IS NULL)
    OR (centrally_acknowledged_cursor > 0 AND last_acknowledged_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE repositories (
  repository_id TEXT PRIMARY KEY,
  active_run_key TEXT UNIQUE,
  FOREIGN KEY (active_run_key) REFERENCES runs(run_key)
    DEFERRABLE INITIALLY DEFERRED
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

CREATE TABLE run_control_state (
  run_key TEXT PRIMARY KEY REFERENCES runs(run_key) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('running', 'paused', 'ending', 'ended')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  changed_at TEXT NOT NULL,
  UNIQUE (repository_id, run_id)
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

CREATE TABLE runner_budgets (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  unit TEXT NOT NULL,
  budget_limit INTEGER NOT NULL CHECK (budget_limit >= 0),
  reserved INTEGER NOT NULL CHECK (reserved >= 0),
  spent INTEGER NOT NULL CHECK (spent >= 0),
  unreported INTEGER NOT NULL CHECK (unreported >= 0),
  PRIMARY KEY (run_key, unit)
) STRICT;

CREATE TABLE runner_cancellation_requests (
  intent_id TEXT PRIMARY KEY REFERENCES runner_effect_intents(intent_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  requested_at TEXT NOT NULL
) STRICT;

CREATE TABLE runner_capacities (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  resource_key TEXT NOT NULL CHECK (resource_key = 'writer'),
  capacity_limit INTEGER NOT NULL CHECK (capacity_limit > 0),
  occupied INTEGER NOT NULL CHECK (occupied >= 0 AND occupied <= capacity_limit),
  PRIMARY KEY (run_key, resource_key)
) STRICT;

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

CREATE TABLE runner_commands (
  command_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  canonical_command TEXT NOT NULL,
  UNIQUE (run_key, sequence, command_id)
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
, task_id TEXT, definition_generation INTEGER, scope_fence_generation INTEGER) STRICT;

CREATE TABLE runner_effect_intents (
  intent_id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  command_id TEXT NOT NULL UNIQUE REFERENCES runner_commands(command_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  attempt_id TEXT NOT NULL,
  canonical_intent TEXT NOT NULL
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

CREATE TABLE runner_escalations (
  command_id TEXT PRIMARY KEY REFERENCES runner_commands(command_id) ON DELETE CASCADE,
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  canonical_escalation TEXT NOT NULL
) STRICT;

CREATE TABLE runner_events (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  event_type TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  PRIMARY KEY (run_key, cursor)
) STRICT;

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

CREATE TABLE runner_integration_gates (
  integration_id TEXT PRIMARY KEY
    REFERENCES runner_integration_attempts(integration_id) ON DELETE CASCADE,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  reading_digest TEXT NOT NULL CHECK (length(reading_digest) = 64),
  evaluation_digest TEXT NOT NULL CHECK (length(evaluation_digest) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('passed', 'failed')),
  canonical_evidence TEXT NOT NULL
) STRICT;

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

CREATE TABLE runner_projections (
  run_key TEXT PRIMARY KEY REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  canonical_projection TEXT NOT NULL
) STRICT;

CREATE TABLE runner_receipts (
  run_key TEXT NOT NULL REFERENCES runner_runs(run_key) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  canonical_receipt TEXT NOT NULL,
  PRIMARY KEY (run_key, cursor)
) STRICT;

CREATE TABLE runner_runs (
  run_key TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  UNIQUE (repository_id, run_id)
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

CREATE TABLE supervisor_logs (
  cursor INTEGER PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  fields_json TEXT NOT NULL
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

CREATE TABLE supervisor_service_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  desired_mode TEXT NOT NULL CHECK (
    desired_mode IN ('running', 'draining', 'drained', 'stopped')
  ),
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
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

CREATE INDEX agent_session_resume_task_idx
  ON agent_session_resume_bindings(task_id, task_generation, binding_digest);

CREATE INDEX amendment_decisions_proposal_idx
  ON amendment_decisions(amendment_id, proposal_digest);

CREATE INDEX amendment_fenced_dispatches_dispatch_idx
  ON amendment_fenced_dispatches(dispatch_id, amendment_id);

CREATE INDEX amendment_fences_run_idx
  ON amendment_work_fences(run_key, claims_accepted, task_id, definition_generation);

CREATE INDEX amendment_proposals_run_idx
  ON amendment_proposals(run_key, amendment_id);

CREATE INDEX cancellation_requests_run_idx ON cancellation_requests(run_key);

CREATE INDEX claims_run_idx ON claims(run_key);

CREATE INDEX context_amendment_outbox_delivery_idx
  ON context_amendment_outbox(delivered, submission_id);

CREATE INDEX context_assets_content_idx
  ON context_asset_bindings(content_digest, asset_binding_id);

CREATE INDEX context_chunks_range_idx
  ON context_asset_chunks(asset_binding_id, byte_offset);

CREATE INDEX context_dispatches_run_idx
  ON context_dispatches(repository_id, run_id, dispatch_id);

CREATE INDEX context_fresh_dispatch_pending_idx
  ON context_fresh_dispatch_requirements(run_key, task_id, definition_generation)
  WHERE satisfied_by_dispatch_id IS NULL;

CREATE INDEX context_grants_dispatch_idx
  ON context_grants(repository_id, run_id, dispatch_id);

CREATE INDEX context_phase_output_outbox_delivery_idx
  ON context_phase_output_outbox(delivered, submission_id);

CREATE INDEX context_reads_run_idx
  ON context_read_attempts(repository_id, run_id, request_id);

CREATE INDEX context_receipts_run_idx
  ON context_audit_receipts(repository_id, run_id, receipt_cursor);

CREATE INDEX context_submissions_dispatch_idx
  ON context_submissions(repository_id, run_id, dispatch_id);

CREATE INDEX effect_intents_run_idx ON effect_intents(run_key);

CREATE INDEX event_frames_run_cursor_idx ON event_frames(run_key, cursor);

CREATE INDEX fan_out_evaluations_run_idx
  ON fan_out_evaluations(run_key, attempt_digest, for_each_key, evaluation_digest);

CREATE INDEX phase_attempt_transitions_attempt_idx
  ON phase_attempt_transitions(attempt_digest, transition_digest);

CREATE INDEX phase_attempts_run_idx
  ON phase_attempts(run_key, phase_id, definition_generation, attempt_ordinal);

CREATE INDEX phase_input_sources_source_idx
  ON phase_input_sources(source_binding_digest, selected_value_digest);

CREATE INDEX phase_output_attempts_slot_idx
  ON phase_output_attempts(dispatch_id, output_name, outcome);

CREATE INDEX phase_output_publications_run_idx
  ON phase_output_publications(run_key, attempt_digest, output_name);

CREATE INDEX plan_imports_state_idx ON plan_imports(state, proposal_digest);

CREATE INDEX portal_run_revisions_portal_idx
  ON portal_run_revisions(portal_revision, repository_id, run_id);

CREATE INDEX receipt_history_command_idx ON receipt_history(command_id, ordinal);

CREATE INDEX remote_command_inbox_pending_idx
  ON remote_command_inbox(binding_id, processing_state, sequence)
  WHERE processing_state IN ('waiting', 'ready', 'local-accepted');

CREATE INDEX remote_report_outbox_pending_idx
  ON remote_report_outbox(binding_id, delivery_state, report_sequence)
  WHERE delivery_state <> 'acknowledged';

CREATE INDEX remote_run_event_checkpoints_fairness_idx
  ON remote_run_event_checkpoints(binding_id, last_enqueued_report_sequence, run_id);

CREATE INDEX run_control_mode_idx ON run_control_state(mode, repository_id, run_id);

CREATE INDEX runner_allowance_resolutions_run_idx
  ON runner_allowance_resolutions(run_key, resolved_at, escalation_command_id);

CREATE INDEX runner_capacity_reservations_run_idx
  ON runner_capacity_reservations(run_key, released, intent_id);

CREATE INDEX runner_claims_run_idx ON runner_effect_claims(run_key, intent_id);

CREATE INDEX runner_commands_run_idx ON runner_commands(run_key, sequence, command_id);

CREATE INDEX runner_completion_eligibility_pending_idx
  ON runner_completion_eligibility(eligible, run_key, submission_id);

CREATE INDEX runner_escalations_run_idx ON runner_escalations(run_key, command_id);

CREATE INDEX runner_integration_members_workspace_idx
  ON runner_integration_members(workspace_id, integration_id);

CREATE UNIQUE INDEX runner_integration_one_active_repository_idx
  ON runner_integration_attempts(repository_id)
  WHERE state IN ('claimed', 'candidate-created', 'validating', 'publishing', 'unknown');

CREATE INDEX runner_integrations_run_state_idx
  ON runner_integration_attempts(run_key, state, integration_id);

CREATE INDEX runner_intents_run_idx ON runner_effect_intents(run_key, intent_id);

CREATE INDEX runner_outcomes_latest_idx ON runner_effect_outcomes(intent_id, commit_cursor DESC);

CREATE INDEX runner_workspace_results_digest_idx
  ON runner_workspace_results(result_tree_digest, result_id);

CREATE INDEX runner_workspaces_run_state_idx
  ON runner_workspaces(run_key, state, workspace_id);

CREATE INDEX supervisor_commands_pending_idx
  ON supervisor_commands(run_key, state, accepted_sequence);

CREATE INDEX supervisor_receipts_command_idx
  ON supervisor_receipts(command_id, sequence);

CREATE TRIGGER portal_revision_agent_transcript_insert
AFTER INSERT ON agent_transcript_lines
BEGIN
  UPDATE portal_run_revisions
  SET transcript_revision = transcript_revision + 1
  WHERE repository_id = (SELECT repository_id FROM runs WHERE run_key = NEW.run_key)
    AND run_id = (SELECT run_id FROM runs WHERE run_key = NEW.run_key);
END;

CREATE TRIGGER portal_revision_allowance_resolution_insert
AFTER INSERT ON runner_allowance_resolutions
BEGIN
  UPDATE portal_run_revisions
  SET runner_revision = runner_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_attempt_transition_insert
AFTER INSERT ON phase_attempt_transitions
BEGIN
  UPDATE portal_run_revisions
  SET task_frontier_revision = task_frontier_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT runs.repository_id, runs.run_id
    FROM phase_attempts JOIN runs ON runs.run_key = phase_attempts.run_key
    WHERE phase_attempts.attempt_digest = NEW.attempt_digest
  );
END;

CREATE TRIGGER portal_revision_completion_eligibility_insert
AFTER INSERT ON runner_completion_eligibility
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_completion_eligibility_update
AFTER UPDATE ON runner_completion_eligibility
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_context_dispatch_insert
AFTER INSERT ON context_dispatches
BEGIN
  UPDATE portal_run_revisions
  SET context_revision = context_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_context_event_insert
AFTER INSERT ON context_events
BEGIN
  UPDATE portal_run_revisions
  SET context_revision = context_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_context_question_insert
AFTER INSERT ON context_questions
BEGIN
  UPDATE portal_run_revisions
  SET context_revision = context_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_context_submission_insert
AFTER INSERT ON context_submissions
BEGIN
  UPDATE portal_run_revisions
  SET context_revision = context_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_escalation_insert
AFTER INSERT ON runner_escalations
BEGIN
  UPDATE portal_run_revisions
  SET human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_execution_binding_insert
AFTER INSERT ON runner_execution_bindings
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_fan_out_evaluation_insert
AFTER INSERT ON fan_out_evaluations
BEGIN
  UPDATE portal_run_revisions
  SET task_frontier_revision = task_frontier_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_fresh_dispatch_insert
AFTER INSERT ON context_fresh_dispatch_requirements
BEGIN
  UPDATE portal_run_revisions
  SET context_revision = context_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_fresh_dispatch_update
AFTER UPDATE OF satisfied_by_dispatch_id ON context_fresh_dispatch_requirements
WHEN OLD.satisfied_by_dispatch_id IS NOT NEW.satisfied_by_dispatch_id
BEGIN
  UPDATE portal_run_revisions
  SET context_revision = context_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_integration_gate_insert
AFTER INSERT ON runner_integration_gates
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT rr.repository_id, rr.run_id
    FROM runner_integration_attempts i
    JOIN runner_runs rr ON rr.run_key = i.run_key
    WHERE i.integration_id = NEW.integration_id
  );
END;

CREATE TRIGGER portal_revision_integration_gate_update
AFTER UPDATE ON runner_integration_gates
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT rr.repository_id, rr.run_id
    FROM runner_integration_attempts i
    JOIN runner_runs rr ON rr.run_key = i.run_key
    WHERE i.integration_id = NEW.integration_id
  );
END;

CREATE TRIGGER portal_revision_integration_insert
AFTER INSERT ON runner_integration_attempts
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_integration_member_insert
AFTER INSERT ON runner_integration_members
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT rr.repository_id, rr.run_id
    FROM runner_integration_attempts i
    JOIN runner_runs rr ON rr.run_key = i.run_key
    WHERE i.integration_id = NEW.integration_id
  );
END;

CREATE TRIGGER portal_revision_integration_update
AFTER UPDATE ON runner_integration_attempts
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
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

CREATE TRIGGER portal_revision_plan_import_insert
AFTER INSERT ON plan_imports
BEGIN
  UPDATE portal_run_revisions
  SET task_frontier_revision = task_frontier_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT runs.repository_id, runs.run_id
    FROM fan_out_evaluations JOIN runs ON runs.run_key = fan_out_evaluations.run_key
    WHERE fan_out_evaluations.evaluation_digest = NEW.evaluation_digest
  );
END;

CREATE TRIGGER portal_revision_question_answer_insert
AFTER INSERT ON context_question_answers
BEGIN
  UPDATE portal_run_revisions
  SET context_revision = context_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_run_control_update
AFTER UPDATE ON run_control_state
BEGIN
  UPDATE portal_run_revisions
  SET human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_run_insert
AFTER INSERT ON runs
BEGIN
  INSERT INTO portal_run_revisions(
    repository_id, run_id, workflow_revision, context_revision,
    runner_revision, workspace_revision, human_revision, portal_revision
  ) VALUES (NEW.repository_id, NEW.run_id, NEW.cursor, 0, 0, 0, 0, NEW.cursor)
  ON CONFLICT(repository_id, run_id) DO NOTHING;
END;

CREATE TRIGGER portal_revision_run_update
AFTER UPDATE OF cursor, records_json, projection_generated_at, revision_digest ON runs
WHEN OLD.cursor <> NEW.cursor
  OR OLD.records_json IS NOT NEW.records_json
  OR OLD.projection_generated_at IS NOT NEW.projection_generated_at
  OR OLD.revision_digest IS NOT NEW.revision_digest
BEGIN
  UPDATE portal_run_revisions
  SET workflow_revision = workflow_revision + 1,
      human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_runner_insert
AFTER INSERT ON runner_runs
BEGIN
  UPDATE portal_run_revisions
  SET runner_revision = runner_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_runner_update
AFTER UPDATE OF cursor, context_digest ON runner_runs
WHEN OLD.cursor <> NEW.cursor OR OLD.context_digest <> NEW.context_digest
BEGIN
  UPDATE portal_run_revisions
  SET runner_revision = runner_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_workflow_input_insert
AFTER INSERT ON workflow_input_bindings
BEGIN
  UPDATE portal_run_revisions
  SET dataflow_revision = dataflow_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE TRIGGER portal_revision_workspace_insert
AFTER INSERT ON runner_workspaces
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
  );
END;

CREATE TRIGGER portal_revision_workspace_result_insert
AFTER INSERT ON runner_workspace_results
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT rr.repository_id, rr.run_id
    FROM runner_workspaces w
    JOIN runner_runs rr ON rr.run_key = w.run_key
    WHERE w.workspace_id = NEW.workspace_id
  );
END;

CREATE TRIGGER portal_revision_workspace_update
AFTER UPDATE ON runner_workspaces
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE (repository_id, run_id) = (
    SELECT repository_id, run_id FROM runner_runs WHERE run_key = NEW.run_key
  );
END;

INSERT INTO "authority_state"("singleton", "revision", "canonical_json") VALUES (1, 0, '{"runs":[],"version":"senawa.dev/runtime-memory/v1"}');

INSERT INTO "context_authority_state"("singleton", "canonical_json") VALUES (1, '{"completionOutbox":[],"cursor":0,"dispatches":[],"events":[],"grants":[],"phaseOutputOutbox":[],"questions":[],"reads":[],"receiptAttempts":[],"receipts":[],"submissions":[],"terminalCompletions":[],"version":"senawa.dev/context-authority-durable/v1"}');

INSERT INTO "context_projection"("singleton", "cursor", "canonical_projection") VALUES (1, 0, '{"acceptedSubmissions":0,"cursor":0,"deniedReads":0,"duplicateSubmissions":0,"grants":0,"questions":0,"registeredContexts":0,"registeredDispatches":0,"servedReads":0,"staleSubmissions":0}');

INSERT INTO "supervisor_service_state"("singleton", "desired_mode", "updated_at", "updated_at_ms") VALUES (1, 'running', '1970-01-01T00:00:00.000Z', 0);
