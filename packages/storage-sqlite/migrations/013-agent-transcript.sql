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

CREATE TRIGGER portal_revision_agent_transcript_insert
AFTER INSERT ON agent_transcript_lines
BEGIN
  UPDATE portal_run_revisions
  SET portal_revision = portal_revision + 1
  WHERE repository_id = (SELECT repository_id FROM runs WHERE run_key = NEW.run_key)
    AND run_id = (SELECT run_id FROM runs WHERE run_key = NEW.run_key);
END;
