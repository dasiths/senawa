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

CREATE INDEX phase_output_attempts_slot_idx
  ON phase_output_attempts(dispatch_id, output_name, outcome);
