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

CREATE TABLE fan_out_diff_decisions (
  decision_digest TEXT PRIMARY KEY CHECK (length(decision_digest) = 64),
  evaluation_digest TEXT NOT NULL UNIQUE REFERENCES fan_out_evaluations(evaluation_digest),
  prior_evaluation_digest TEXT REFERENCES fan_out_evaluations(evaluation_digest),
  diff_digest TEXT NOT NULL UNIQUE CHECK (length(diff_digest) = 64),
  authority_digest TEXT NOT NULL CHECK (length(authority_digest) = 64),
  canonical_decision TEXT NOT NULL
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

ALTER TABLE portal_run_revisions
  ADD COLUMN task_frontier_revision INTEGER NOT NULL DEFAULT 0
  CHECK (task_frontier_revision >= 0);

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

CREATE INDEX phase_attempt_transitions_attempt_idx
  ON phase_attempt_transitions(attempt_digest, transition_digest);
CREATE INDEX agent_session_resume_task_idx
  ON agent_session_resume_bindings(task_id, task_generation, binding_digest);
CREATE INDEX fan_out_evaluations_run_idx
  ON fan_out_evaluations(run_key, attempt_digest, for_each_key, evaluation_digest);
CREATE INDEX plan_imports_state_idx ON plan_imports(state, proposal_digest);