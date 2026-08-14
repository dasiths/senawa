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

CREATE INDEX remote_command_inbox_pending_idx
  ON remote_command_inbox(binding_id, processing_state, sequence)
  WHERE processing_state IN ('waiting', 'ready', 'local-accepted');
CREATE INDEX remote_report_outbox_pending_idx
  ON remote_report_outbox(binding_id, delivery_state, report_sequence)
  WHERE delivery_state <> 'acknowledged';
CREATE INDEX remote_run_event_checkpoints_fairness_idx
  ON remote_run_event_checkpoints(binding_id, last_enqueued_report_sequence, run_id);