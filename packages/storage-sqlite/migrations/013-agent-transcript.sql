CREATE TABLE agent_transcript_lines (
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('dispatch', 'task', 'phase')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0 AND length(owner_id) <= 128),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24),
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  text TEXT NOT NULL CHECK (length(text) > 0 AND octet_length(text) <= 4096),
  PRIMARY KEY (owner_kind, owner_id, sequence)
) STRICT;

CREATE INDEX agent_transcript_lines_run_owner_idx
  ON agent_transcript_lines(run_key, owner_kind, owner_id, sequence);
