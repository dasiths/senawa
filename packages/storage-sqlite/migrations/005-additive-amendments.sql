CREATE TABLE configuration_snapshots (
  snapshot_digest TEXT PRIMARY KEY CHECK (length(snapshot_digest) = 64),
  graph_revision_digest TEXT NOT NULL CHECK (length(graph_revision_digest) = 64),
  canonical_snapshot TEXT NOT NULL
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

CREATE TABLE amendment_decisions (
  approval_id TEXT PRIMARY KEY,
  amendment_id TEXT NOT NULL UNIQUE REFERENCES amendment_proposals(amendment_id) ON DELETE CASCADE,
  proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
  decision_digest TEXT NOT NULL UNIQUE CHECK (length(decision_digest) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  canonical_decision TEXT NOT NULL
) STRICT;

CREATE TABLE amendment_withdrawals (
  amendment_id TEXT PRIMARY KEY REFERENCES amendment_proposals(amendment_id) ON DELETE CASCADE,
  withdrawal_digest TEXT NOT NULL UNIQUE CHECK (length(withdrawal_digest) = 64),
  canonical_withdrawal TEXT NOT NULL
) STRICT;

CREATE TABLE amendment_applications (
  amendment_id TEXT PRIMARY KEY REFERENCES amendment_proposals(amendment_id) ON DELETE CASCADE,
  application_digest TEXT NOT NULL UNIQUE CHECK (length(application_digest) = 64),
  before_graph_revision_digest TEXT NOT NULL CHECK (length(before_graph_revision_digest) = 64),
  after_graph_revision_digest TEXT NOT NULL CHECK (length(after_graph_revision_digest) = 64),
  quiescence_fact_digest TEXT NOT NULL CHECK (length(quiescence_fact_digest) = 64),
  canonical_application TEXT NOT NULL
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

ALTER TABLE runner_effect_claims ADD COLUMN task_id TEXT;
ALTER TABLE runner_effect_claims ADD COLUMN definition_generation INTEGER;
ALTER TABLE runner_effect_claims ADD COLUMN scope_fence_generation INTEGER;

UPDATE runner_effect_claims
SET
  task_id = json_extract(
    (SELECT canonical_intent FROM runner_effect_intents
     WHERE runner_effect_intents.intent_id = runner_effect_claims.intent_id),
    '$.command.taskScope.taskId'
  ),
  definition_generation = json_extract(
    (SELECT canonical_intent FROM runner_effect_intents
     WHERE runner_effect_intents.intent_id = runner_effect_claims.intent_id),
    '$.command.taskScope.definitionGeneration'
  ),
  scope_fence_generation = json_extract(
    (SELECT canonical_intent FROM runner_effect_intents
     WHERE runner_effect_intents.intent_id = runner_effect_claims.intent_id),
    '$.command.taskScope.fenceGeneration'
  );

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

CREATE TABLE amendment_proposal_bridge_outcomes (
  submission_id TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('acknowledged', 'compiled', 'diagnostics')),
  canonical_outcome TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

INSERT INTO amendment_work_fences(
  run_key, repository_id, run_id, task_id, definition_generation,
  fence_generation, current_context_digest, claims_accepted, amendment_id, installed_at
)
SELECT DISTINCT
  json_array(
    json_extract(value, '$.dispatch.repositoryId'),
    json_extract(value, '$.dispatch.runId')
  ),
  json_extract(value, '$.dispatch.repositoryId'),
  json_extract(value, '$.dispatch.runId'),
  json_extract(value, '$.taskScope.taskId'),
  json_extract(value, '$.taskScope.definitionGeneration'),
  json_extract(value, '$.taskScope.fenceGeneration'),
  json_extract(value, '$.taskScope.acceptedContextDigest'),
  json_extract(value, '$.taskScope.claimsAccepted'),
  NULL,
  NULL
FROM context_authority_state, json_each(context_authority_state.canonical_json, '$.dispatches');

INSERT INTO amendment_work_fences(
  run_key, repository_id, run_id, task_id, definition_generation,
  fence_generation, current_context_digest, claims_accepted, amendment_id, installed_at
)
SELECT DISTINCT
  runner_commands.run_key,
  runner_runs.repository_id,
  runner_runs.run_id,
  json_extract(runner_commands.canonical_command, '$.taskScope.taskId'),
  json_extract(runner_commands.canonical_command, '$.taskScope.definitionGeneration'),
  json_extract(runner_commands.canonical_command, '$.taskScope.fenceGeneration'),
  json_extract(runner_commands.canonical_command, '$.taskScope.acceptedContextDigest'),
  1,
  NULL,
  NULL
FROM runner_commands
JOIN runner_runs ON runner_runs.run_key = runner_commands.run_key
ON CONFLICT(run_key, task_id, definition_generation) DO NOTHING;

CREATE INDEX amendment_proposals_run_idx
  ON amendment_proposals(run_key, amendment_id);
CREATE INDEX amendment_decisions_proposal_idx
  ON amendment_decisions(amendment_id, proposal_digest);
CREATE INDEX amendment_fences_run_idx
  ON amendment_work_fences(run_key, claims_accepted, task_id, definition_generation);
CREATE INDEX amendment_fenced_dispatches_dispatch_idx
  ON amendment_fenced_dispatches(dispatch_id, amendment_id);
CREATE INDEX context_amendment_outbox_delivery_idx
  ON context_amendment_outbox(delivered, submission_id);
