CREATE TABLE portal_run_revisions (
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision >= 0),
  context_revision INTEGER NOT NULL CHECK (context_revision >= 0),
  runner_revision INTEGER NOT NULL CHECK (runner_revision >= 0),
  workspace_revision INTEGER NOT NULL CHECK (workspace_revision >= 0),
  human_revision INTEGER NOT NULL CHECK (human_revision >= 0),
  portal_revision INTEGER NOT NULL CHECK (portal_revision >= 0),
  PRIMARY KEY (repository_id, run_id),
  FOREIGN KEY (repository_id, run_id) REFERENCES runs(repository_id, run_id) ON DELETE CASCADE
) STRICT;

INSERT INTO portal_run_revisions(
  repository_id, run_id, workflow_revision, context_revision,
  runner_revision, workspace_revision, human_revision, portal_revision
)
SELECT repository_id, run_id, cursor, 0, 0, 0, 0, cursor
FROM runs;

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

CREATE TRIGGER portal_revision_context_submission_insert
AFTER INSERT ON context_submissions
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

CREATE TRIGGER portal_revision_execution_binding_insert
AFTER INSERT ON runner_execution_bindings
BEGIN
  UPDATE portal_run_revisions
  SET workspace_revision = workspace_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
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

CREATE TRIGGER portal_revision_run_control_update
AFTER UPDATE ON run_control_state
BEGIN
  UPDATE portal_run_revisions
  SET human_revision = human_revision + 1,
      portal_revision = portal_revision + 1
  WHERE repository_id = NEW.repository_id AND run_id = NEW.run_id;
END;

CREATE INDEX portal_run_revisions_portal_idx
  ON portal_run_revisions(portal_revision, repository_id, run_id);