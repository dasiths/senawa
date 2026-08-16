import { resolve } from "node:path";
import {
  canonicalBytes,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type WorkflowGraph,
} from "@senawa/kernel";
import {
  decodeCanonicalJsonValue,
  decodeCommandEnvelope,
  decodeDurableReceipt,
  decodeEventStreamFrame,
  decodeRemoteClassifiedReport,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import {
  InMemoryAuthority,
  REPORTING_LIMITS,
  REPORTING_SNAPSHOT_VERSION,
  type ReportingNamedScalar,
  type ReportingRecord,
  type ReportingReference,
  type ReportingSectionName,
  type ReportingSnapshot,
  type ReportingSnapshotPort,
  type ReportingSnapshotSection,
  type ReportingSourceVector,
  RuntimeCommandService,
  type RuntimeDependencies,
} from "@senawa/runtime";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "./index.js";

export interface SqliteReportingSnapshotAuthorityOptions {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly captureObserver?: (stage: "after-source-vector-read") => void;
}

const SECTION_NAMES: readonly ReportingSectionName[] = Object.freeze([
  "graph",
  "trajectory",
  "actors",
  "models",
  "assets",
  "context",
  "dataflow",
  "amendments",
  "escalations",
  "gates",
  "approvals",
  "costs",
  "uncertainty",
  "workspaces",
  "integration",
  "portal",
  "remote",
]);

const ALWAYS_COMPLETE = new Set<ReportingSectionName>([
  "graph",
  "trajectory",
  "actors",
  "uncertainty",
  "portal",
]);

export class SqliteReportingSnapshotAuthority implements ReportingSnapshotPort {
  readonly databasePath: string;
  readonly dependencies: RuntimeDependencies;
  readonly #database: Database.Database;
  readonly #schemaVersion: number;
  readonly #captureObserver: ((stage: "after-source-vector-read") => void) | undefined;

  constructor(options: SqliteReportingSnapshotAuthorityOptions) {
    this.databasePath = resolve(options.databasePath);
    this.dependencies = options.dependencies;
    this.#captureObserver = options.captureObserver;
    this.#database = new Database(this.databasePath, { readonly: true, fileMustExist: true });
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("trusted_schema = OFF");
    this.#database.pragma("query_only = ON");
    this.#schemaVersion = this.#database.pragma("user_version", { simple: true }) as number;
    if (this.#schemaVersion !== CURRENT_SCHEMA_VERSION) {
      this.#database.close();
      throw new TypeError(
        `Reporting requires SQLite schema version ${CURRENT_SCHEMA_VERSION}, received ${this.#schemaVersion}`,
      );
    }
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  captureReportingSnapshot(repositoryId: string, runId: string): ReportingSnapshot {
    validateOpaqueIdentity(repositoryId);
    validateOpaqueIdentity(runId);
    const capture = this.#database.transaction(() => {
      const run = this.#database
        .prepare<[string, string], { run_key: string; records_json: string | null }>(
          `SELECT run_key, records_json FROM runs
           WHERE repository_id = ? AND run_id = ?`,
        )
        .get(repositoryId, runId);
      if (run === undefined) throw new TypeError("Reporting run does not exist");

      const graph = this.#runtimeService().queryRunScheduling(repositoryId, runId)?.graph;
      if (graph === undefined) throw new TypeError("Reporting run has no validated workflow graph");
      const before = this.#sourceVector(repositoryId, runId, graph.revisionDigest);
      this.#captureObserver?.("after-source-vector-read");

      const collected = new Map<ReportingSectionName, ReportingRecord[]>(
        SECTION_NAMES.map((name) => [name, []]),
      );
      const records = (name: ReportingSectionName): ReportingRecord[] => {
        const selected = collected.get(name);
        if (selected === undefined) throw new Error(`Unknown reporting section ${name}`);
        return selected;
      };

      this.#captureGraph(graph, records("graph"));
      this.#captureTrajectory(run.run_key, records("trajectory"), records("actors"));
      this.#captureModels(run.run_key, records("models"), records("costs"));
      this.#captureContext(
        repositoryId,
        runId,
        records("context"),
        records("assets"),
        records("actors"),
        records("models"),
        records("costs"),
      );
      this.#captureAmendments(run.run_key, records("amendments"));
      this.#captureDataflow(run.run_key, records("dataflow"));
      this.#captureLifecycle(run.records_json, records("gates"), records("approvals"));
      this.#captureRunner(
        run.run_key,
        records("trajectory"),
        records("escalations"),
        records("costs"),
        records("uncertainty"),
      );
      this.#captureWorkspaces(
        run.run_key,
        records("workspaces"),
        records("integration"),
        records("gates"),
        records("uncertainty"),
      );
      this.#capturePortal(repositoryId, runId, before, records("portal"));
      this.#captureRemote(repositoryId, runId, records("remote"), records("uncertainty"));

      const after = this.#sourceVector(repositoryId, runId, graph.revisionDigest);
      if (
        canonicalSerialize(canonicalValue(before)) !== canonicalSerialize(canonicalValue(after))
      ) {
        throw new TypeError("Reporting source vector changed during capture");
      }
      const sections = SECTION_NAMES.map((name) =>
        section(name, records(name), ALWAYS_COMPLETE.has(name)),
      );
      assertCeilings(sections);
      const configurationSnapshotDigest = this.#configurationSnapshotDigest(
        run.run_key,
        run.records_json,
      );
      return Object.freeze({
        version: REPORTING_SNAPSHOT_VERSION,
        repositoryId,
        runId,
        schemaVersion: this.#schemaVersion,
        ...(configurationSnapshotDigest === undefined ? {} : { configurationSnapshotDigest }),
        sourceVector: before,
        sections: Object.freeze(sections),
      });
    });
    return capture();
  }

  #runtimeService(): RuntimeCommandService {
    const row = this.#database
      .prepare<[], { canonical_json: string }>(
        "SELECT canonical_json FROM authority_state WHERE singleton = 1",
      )
      .get();
    if (row === undefined) throw new Error("SQLite authority singleton is missing");
    return new RuntimeCommandService(
      this.dependencies,
      InMemoryAuthority.fromCanonicalJson(row.canonical_json, this.dependencies),
    );
  }

  #sourceVector(repositoryId: string, runId: string, graphRevision: string): ReportingSourceVector {
    const row = this.#database
      .prepare<
        [string, string],
        {
          cursor: number;
          workflow_revision: number;
          context_revision: number;
          dataflow_revision: number;
          runner_revision: number;
          workspace_revision: number;
          human_revision: number;
          portal_revision: number;
        }
      >(
        `SELECT r.cursor, p.workflow_revision, p.context_revision, p.dataflow_revision,
                p.runner_revision, p.workspace_revision, p.human_revision,
                p.portal_revision
         FROM runs r JOIN portal_run_revisions p
           ON p.repository_id = r.repository_id AND p.run_id = r.run_id
         WHERE r.repository_id = ? AND r.run_id = ?`,
      )
      .get(repositoryId, runId);
    if (row === undefined) throw new TypeError("Reporting source vector is missing");
    const remote = this.#database
      .prepare<
        [string, string],
        {
          local_cursor: number | null;
          enqueued_cursor: number | null;
          acknowledged_cursor: number | null;
        }
      >(
        `SELECT MAX(local_latest_cursor) AS local_cursor,
                MAX(durably_enqueued_cursor) AS enqueued_cursor,
                MAX(centrally_acknowledged_cursor) AS acknowledged_cursor
         FROM remote_run_event_checkpoints WHERE repository_id = ? AND run_id = ?`,
      )
      .get(repositoryId, runId);
    return Object.freeze({
      workflowCursor: row.cursor,
      lifecycleRevision: row.workflow_revision,
      contextRevision: row.context_revision,
      dataflowRevision: row.dataflow_revision,
      runnerRevision: row.runner_revision,
      workspaceRevision: row.workspace_revision,
      humanRevision: row.human_revision,
      portalRevision: row.portal_revision,
      graphRevision,
      ...(remote?.local_cursor === null || remote?.local_cursor === undefined
        ? {}
        : {
            remoteLocalCursor: remote.local_cursor,
            remoteEnqueuedCursor: remote.enqueued_cursor ?? 0,
            remoteAcknowledgedCursor: remote.acknowledged_cursor ?? 0,
          }),
    });
  }

  #configurationSnapshotDigest(runKey: string, recordsJson: string | null): string | undefined {
    const binding = this.#database
      .prepare<[string], { configuration_snapshot_digest: string }>(
        `SELECT configuration_snapshot_digest FROM runner_execution_bindings
         WHERE run_key = ?`,
      )
      .get(runKey);
    if (binding !== undefined) return binding.configuration_snapshot_digest;
    if (recordsJson === null) return undefined;
    const value = decodeCanonicalJsonValue(recordsJson);
    if (!isRecord(value)) return undefined;
    const digest = value.configurationSnapshotDigest;
    return typeof digest === "string" && isSha256Digest(digest) ? digest : undefined;
  }

  #captureDataflow(runKey: string, output: ReportingRecord[]): void {
    const workflowInput = this.#database
      .prepare<
        [string],
        {
          binding_digest: string;
          schema_key: string;
          schema_resource_digest: string;
          content_digest: string;
          byte_length: number;
          validation_receipt_digest: string;
        }
      >(
        `SELECT binding_digest, schema_key, schema_resource_digest, content_digest,
                byte_length, validation_receipt_digest
         FROM workflow_input_bindings WHERE run_key = ?`,
      )
      .get(runKey);
    if (workflowInput !== undefined) {
      output.push(
        record({
          kind: "workflow-input-binding",
          identity: workflowInput.binding_digest,
          digest: workflowInput.binding_digest,
          references: [
            reference("source", "schema-resource", workflowInput.schema_resource_digest),
            reference("result", "asset", workflowInput.content_digest),
            reference("result", "validation-receipt", workflowInput.validation_receipt_digest),
          ],
          scalars: [
            scalar("schemaKey", workflowInput.schema_key),
            scalar("byteLength", workflowInput.byte_length),
          ],
        }),
      );
    }
    const attempts = this.#database
      .prepare<
        [string],
        {
          attempt_digest: string;
          phase_id: string;
          definition_generation: number;
          attempt_ordinal: number;
          input_binding_digest: string;
          source_set_digest: string;
          executor_digest: string;
          graph_revision_digest: string;
          configuration_snapshot_digest: string;
          schema_key: string;
          schema_resource_digest: string;
          content_digest: string;
          byte_length: number;
          validation_receipt_digest: string;
        }
      >(
        `SELECT a.attempt_digest, a.phase_id, a.definition_generation, a.attempt_ordinal,
                a.input_binding_digest, a.source_set_digest, a.executor_digest,
                a.graph_revision_digest, a.configuration_snapshot_digest,
                i.schema_key, i.schema_resource_digest, i.content_digest, i.byte_length,
                i.validation_receipt_digest
         FROM phase_attempts a
         JOIN phase_input_bindings i ON i.attempt_digest = a.attempt_digest
         WHERE a.run_key = ?
         ORDER BY a.phase_id, a.definition_generation, a.attempt_ordinal`,
      )
      .all(runKey);
    for (const attempt of attempts) {
      output.push(
        record({
          kind: "phase-attempt",
          identity: attempt.attempt_digest,
          digest: attempt.attempt_digest,
          references: [
            reference("related", "phase", attempt.phase_id),
            reference("source", "graph-revision", attempt.graph_revision_digest),
            reference("source", "configuration-snapshot", attempt.configuration_snapshot_digest),
            reference("source", "executor", attempt.executor_digest),
            reference("result", "phase-input-binding", attempt.input_binding_digest),
          ],
          scalars: [
            scalar("generation", attempt.definition_generation),
            scalar("attempt", attempt.attempt_ordinal),
          ],
        }),
      );
      output.push(
        record({
          kind: "phase-input-binding",
          identity: attempt.input_binding_digest,
          digest: attempt.input_binding_digest,
          references: [
            reference("source", "phase-attempt", attempt.attempt_digest),
            reference("source", "mapping-source-set", attempt.source_set_digest),
            reference("source", "schema-resource", attempt.schema_resource_digest),
            reference("result", "asset", attempt.content_digest),
            reference("result", "validation-receipt", attempt.validation_receipt_digest),
          ],
          scalars: [
            scalar("schemaKey", attempt.schema_key),
            scalar("byteLength", attempt.byte_length),
          ],
        }),
      );
    }
    const publications = this.#database
      .prepare<
        [string],
        {
          publication_id: string;
          publication_digest: string;
          attempt_digest: string;
          output_name: string;
          schema_key: string;
          schema_resource_digest: string;
          content_digest: string;
          byte_length: number;
          sensitivity: string;
          producing_task_id: string;
          dispatch_id: string;
          context_id: string;
          validation_receipt_digest: string;
          acceptance_digest: string | null;
          candidate_digest: string | null;
          closure_digest: string | null;
        }
      >(
        `SELECT p.publication_id, p.publication_digest, p.attempt_digest, p.output_name,
                p.schema_key, p.schema_resource_digest, p.content_digest, p.byte_length,
                p.sensitivity, p.producing_task_id, p.dispatch_id, p.context_id,
                p.validation_receipt_digest, a.acceptance_digest, a.candidate_digest,
                a.closure_digest
         FROM phase_output_publications p
         LEFT JOIN phase_output_acceptances a ON a.publication_id = p.publication_id
         WHERE p.run_key = ? ORDER BY p.attempt_digest, p.output_name`,
      )
      .all(runKey);
    for (const publication of publications) {
      output.push(
        record({
          kind: "phase-output-publication",
          identity: publication.publication_id,
          digest: publication.publication_digest,
          references: [
            reference("source", "phase-attempt", publication.attempt_digest),
            reference("source", "schema-resource", publication.schema_resource_digest),
            reference("source", "task", publication.producing_task_id),
            reference("source", "dispatch", publication.dispatch_id),
            reference("source", "context", publication.context_id),
            reference("result", "asset", publication.content_digest),
            reference("result", "validation-receipt", publication.validation_receipt_digest),
          ],
          scalars: [
            scalar("outputName", publication.output_name),
            scalar("schemaKey", publication.schema_key),
            scalar("byteLength", publication.byte_length),
            scalar("sensitivity", publication.sensitivity),
            scalar("accepted", publication.acceptance_digest !== null),
          ],
        }),
      );
      if (
        publication.acceptance_digest !== null &&
        publication.candidate_digest !== null &&
        publication.closure_digest !== null
      ) {
        output.push(
          record({
            kind: "phase-output-acceptance",
            identity: publication.acceptance_digest,
            digest: publication.acceptance_digest,
            references: [
              reference("source", "phase-output-publication", publication.publication_id),
              reference("source", "candidate", publication.candidate_digest),
              reference("source", "closure", publication.closure_digest),
            ],
            scalars: [],
          }),
        );
      }
    }
    for (const transition of this.#database
      .prepare<
        [string],
        {
          transition_digest: string;
          attempt_digest: string;
          predecessor_transition_digest: string | null;
          trigger_kind: string;
          disposition: string;
          next_attempt_ordinal: number | null;
        }
      >(
        `SELECT t.transition_digest, t.attempt_digest, t.predecessor_transition_digest,
                t.trigger_kind, t.disposition, t.next_attempt_ordinal
         FROM phase_attempt_transitions t JOIN phase_attempts a
           ON a.attempt_digest = t.attempt_digest
         WHERE a.run_key = ? ORDER BY t.attempt_digest`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "phase-attempt-transition",
          identity: transition.transition_digest,
          digest: transition.transition_digest,
          references: [
            reference("source", "phase-attempt", transition.attempt_digest),
            ...(transition.predecessor_transition_digest === null
              ? []
              : [
                  reference(
                    "source",
                    "phase-attempt-transition",
                    transition.predecessor_transition_digest,
                  ),
                ]),
            reference(
              "result",
              transition.disposition === "closed" ? "phase-closure" : "attempt-disposition",
              transition.next_attempt_ordinal === null
                ? `${transition.disposition}:${transition.transition_digest}`
                : `attempt:${transition.next_attempt_ordinal}`,
            ),
          ],
          scalars: scalars({
            trigger: transition.trigger_kind,
            disposition: transition.disposition,
            nextAttempt: transition.next_attempt_ordinal ?? undefined,
          }),
        }),
      );
    }
    for (const binding of this.#database
      .prepare<
        [string],
        {
          binding_digest: string;
          predecessor_dispatch_id: string;
          task_id: string;
          task_generation: number;
          context_digest: string;
          prompt_resource_digest: string;
          prompt_content_digest: string;
          prompt_pack_digest: string;
          mapped_input_digest: string;
          model_selection_digest: string;
          repository_commit_digest: string;
          repository_tree_digest: string;
        }
      >(
        `SELECT b.binding_digest, b.predecessor_dispatch_id, b.task_id, b.task_generation,
                b.context_digest, b.prompt_resource_digest, b.prompt_content_digest,
                b.prompt_pack_digest, b.mapped_input_digest, b.model_selection_digest,
                b.repository_commit_digest, b.repository_tree_digest
         FROM agent_session_resume_bindings b
         JOIN context_dispatches d ON d.dispatch_id = b.predecessor_dispatch_id
         JOIN runs r ON r.repository_id = d.repository_id AND r.run_id = d.run_id
         WHERE r.run_key = ? ORDER BY b.binding_digest`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "agent-session-resume-binding",
          identity: binding.binding_digest,
          digest: binding.binding_digest,
          references: [
            reference("source", "dispatch", binding.predecessor_dispatch_id),
            reference("source", "task", binding.task_id),
            reference("source", "context", binding.context_digest),
            reference("source", "prompt-resource", binding.prompt_resource_digest),
            reference("source", "prompt-content", binding.prompt_content_digest),
            reference("source", "prompt-pack", binding.prompt_pack_digest),
            reference("source", "mapped-input", binding.mapped_input_digest),
            reference("source", "model-selection", binding.model_selection_digest),
            reference("source", "repository-commit", binding.repository_commit_digest),
            reference("source", "repository-tree", binding.repository_tree_digest),
          ],
          scalars: [scalar("generation", binding.task_generation)],
        }),
      );
    }
    for (const evaluation of this.#database
      .prepare<
        [string],
        {
          evaluation_digest: string;
          attempt_digest: string;
          for_each_key: string;
          prior_evaluation_digest: string | null;
          definition_digest: string;
          source_binding_digest: string;
          collection_digest: string;
          task_set_digest: string;
          graph_revision_digest: string;
          configuration_snapshot_digest: string;
          applied: number;
        }
      >(
        `SELECT evaluation_digest, attempt_digest, for_each_key, prior_evaluation_digest,
                definition_digest, source_binding_digest, collection_digest, task_set_digest,
                graph_revision_digest, configuration_snapshot_digest, applied
         FROM fan_out_evaluations WHERE run_key = ?
         ORDER BY for_each_key, evaluation_digest`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "fan-out-evaluation",
          identity: evaluation.evaluation_digest,
          digest: evaluation.evaluation_digest,
          references: [
            reference("source", "phase-attempt", evaluation.attempt_digest),
            reference("source", "fan-out-definition", evaluation.definition_digest),
            reference("source", "phase-output-binding", evaluation.source_binding_digest),
            reference("source", "fan-out-collection", evaluation.collection_digest),
            reference("source", "graph-revision", evaluation.graph_revision_digest),
            reference("source", "configuration-snapshot", evaluation.configuration_snapshot_digest),
            ...(evaluation.prior_evaluation_digest === null
              ? []
              : [
                  reference(
                    "source",
                    "prior-fan-out-evaluation",
                    evaluation.prior_evaluation_digest,
                  ),
                ]),
            reference("result", "generated-task-set", evaluation.task_set_digest),
          ],
          scalars: [
            scalar("forEachKey", evaluation.for_each_key),
            scalar("applied", evaluation.applied === 1),
          ],
        }),
      );
    }
    for (const member of this.#database
      .prepare<
        [string],
        {
          member_digest: string;
          evaluation_digest: string;
          item_digest: string;
          task_id: string;
          task_generation: number;
          input_digest: string;
        }
      >(
        `SELECT m.member_digest, m.evaluation_digest, m.item_digest, m.task_id,
                m.task_generation, m.input_digest
         FROM fan_out_members m JOIN fan_out_evaluations e
           ON e.evaluation_digest = m.evaluation_digest
         WHERE e.run_key = ? ORDER BY m.evaluation_digest, m.stable_identity`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "generated-task",
          identity: member.member_digest,
          digest: member.member_digest,
          references: [
            reference("source", "fan-out-evaluation", member.evaluation_digest),
            reference("source", "fan-out-item", member.item_digest),
            reference("source", "task-input", member.input_digest),
            reference("result", "graph-task", member.task_id),
          ],
          scalars: [scalar("generation", member.task_generation)],
        }),
      );
    }
    for (const imported of this.#database
      .prepare<
        [string],
        {
          evaluation_digest: string;
          acceptance_digest: string;
          proposal_digest: string;
          amendment_id: string;
          decision_digest: string | null;
          application_digest: string | null;
          state: string;
        }
      >(
        `SELECT i.evaluation_digest, i.acceptance_digest, i.proposal_digest,
                i.amendment_id, i.decision_digest, i.application_digest, i.state
         FROM plan_imports i JOIN fan_out_evaluations e
           ON e.evaluation_digest = i.evaluation_digest
         WHERE e.run_key = ? ORDER BY i.evaluation_digest`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "plan-import",
          identity: imported.amendment_id,
          digest: imported.proposal_digest,
          references: [
            reference("source", "fan-out-evaluation", imported.evaluation_digest),
            reference("source", "phase-output-acceptance", imported.acceptance_digest),
            reference("result", "amendment-proposal", imported.proposal_digest),
            ...(imported.decision_digest === null
              ? []
              : [reference("result", "amendment-decision", imported.decision_digest)]),
            ...(imported.application_digest === null
              ? []
              : [reference("result", "amendment-application", imported.application_digest)]),
          ],
          scalars: [scalar("state", imported.state)],
        }),
      );
    }
  }

  #captureGraph(graph: WorkflowGraph, output: ReportingRecord[]): void {
    for (const node of graph.nodes) {
      const definition = node.definition;
      const references: ReportingReference[] = [];
      if ("parentId" in definition) {
        references.push(reference("related", "parent", definition.parentId));
      }
      if ("dependsOn" in definition) {
        for (const identity of definition.dependsOn) {
          references.push(reference("related", "dependency", identity));
        }
      }
      if ("supersedes" in definition) {
        for (const identity of definition.supersedes) {
          references.push(reference("related", "superseded", identity));
        }
      }
      output.push(
        record({
          kind: `graph-${node.kind}`,
          identity: definition.id,
          digest: definition.definitionDigest,
          references,
          scalars: [scalar("generation", definition.generation), scalar("key", definition.key)],
        }),
      );
      if (node.kind === "task") {
        const policy = node.definition.completionPolicy;
        const policyDigest = this.#digestValue(policy);
        output.push(
          record({
            kind: "completion-policy",
            identity: `${definition.id}:completion-policy`,
            digest: policyDigest,
            references: [reference("related", "graph-task", definition.id)],
            scalars: scalars({
              evidenceMode: policy.evidencePolicy.mode,
              waiverAuthorityDigest:
                policy.evidencePolicy.waiverAuthority === undefined
                  ? undefined
                  : this.#digestValue(policy.evidencePolicy.waiverAuthority),
            }),
          }),
        );
        for (const requirement of policy.criteria) {
          output.push(
            record({
              kind: "completion-criterion",
              identity: `${definition.id}:${requirement.criterionId}`,
              references: [
                reference("related", "graph-task", definition.id),
                reference("related", "graph-criterion", requirement.criterionId),
              ],
              scalars: [scalar("required", requirement.required)],
            }),
          );
        }
        policy.evidencePolicy.requirements.forEach((requirement, index) => {
          const kindDigest = this.#digestValue(requirement.kind);
          output.push(
            record({
              kind: "evidence-requirement",
              identity: `${definition.id}:${index}:${kindDigest}`,
              sequence: index,
              digest: kindDigest,
              references: [reference("related", "graph-task", definition.id)],
              scalars: [scalar("minimumCount", requirement.minimumCount)],
            }),
          );
        });
      }
    }
    graph.edges.forEach((edge, sequence) => {
      output.push(
        record({
          kind: `graph-edge-${edge.kind}`,
          identity: `${edge.kind}:${edge.from}:${edge.to}`,
          sequence,
          references: [
            reference("source", "graph-node", edge.from),
            reference("result", "graph-node", edge.to),
          ],
          scalars: [],
        }),
      );
    });
  }

  #captureTrajectory(runKey: string, output: ReportingRecord[], actors: ReportingRecord[]): void {
    const actorDigests = new Set<string>();
    for (const row of this.#database
      .prepare<
        [string],
        { command_id: string; canonical_envelope: string; terminal_receipt_json: string }
      >(
        `SELECT command_id, canonical_envelope, terminal_receipt_json
         FROM commands WHERE run_key = ? ORDER BY command_id`,
      )
      .all(runKey)) {
      const command = decodeCommandEnvelope(row.canonical_envelope);
      const receipt = decodeDurableReceipt(row.terminal_receipt_json);
      output.push(
        record({
          kind: "command",
          identity: row.command_id,
          sequence: receipt.cursor,
          state: receipt.status,
          digest: command.payloadDigest,
          references: [
            reference("source", "command", row.command_id),
            reference("result", "receipt", `${receipt.cursor}:${row.command_id}`),
          ],
          scalars: [
            scalar("intent", command.intent.type),
            scalar("transport", command.transport.kind),
            ...(command.expectedGraphRevision === undefined
              ? []
              : [scalar("expectedGraphRevision", command.expectedGraphRevision)]),
          ],
        }),
      );
      const principalDigest = this.dependencies.sha256.digest(
        canonicalBytes(canonicalValue(command.principal)),
      );
      if (!isSha256Digest(principalDigest)) {
        throw new TypeError("Principal digest is not a SHA-256 digest");
      }
      if (!actorDigests.has(principalDigest)) {
        actorDigests.add(principalDigest);
        actors.push(
          record({
            kind: "authenticated-principal",
            identity: principalDigest,
            digest: principalDigest,
            references: [],
            scalars: [
              scalar("assurance", command.principal.assurance),
              scalar("issuer", command.principal.issuer),
              ...command.principal.roles.map((role) => scalar(`role:${role}`, true)),
              scalar("tenant", command.principal.tenant),
            ],
          }),
        );
      }
    }
    for (const row of this.#database
      .prepare<[string], { cursor: number; canonical_receipt: string }>(
        `SELECT cursor, canonical_receipt FROM receipt_history
         WHERE run_key = ? ORDER BY cursor`,
      )
      .all(runKey)) {
      const receipt = decodeDurableReceipt(row.canonical_receipt);
      output.push(
        record({
          kind: "receipt",
          identity: `${row.cursor}:${receipt.commandId}`,
          sequence: row.cursor,
          state: `receipt-${receipt.status}`,
          references: [reference("related", "command", receipt.commandId)],
          scalars: [scalar("status", receipt.status)],
        }),
      );
    }
    for (const row of this.#database
      .prepare<[string], { cursor: number; canonical_frame: string }>(
        `SELECT cursor, canonical_frame FROM event_frames
         WHERE run_key = ? ORDER BY cursor`,
      )
      .all(runKey)) {
      const event = decodeEventStreamFrame(row.canonical_frame);
      output.push(
        record({
          kind: "event",
          identity: event.eventId,
          sequence: row.cursor,
          state: `event-${event.eventType}`,
          occurredAt: event.occurredAt,
          digest: event.payloadDigest,
          references:
            event.commandId === undefined ? [] : [reference("related", "command", event.commandId)],
          scalars: [scalar("eventType", event.eventType)],
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          revision: number;
          event_id: string;
          command_id: string | null;
          prior_mode: string;
          result_mode: string;
          principal_digest: string;
          occurred_at: string;
        }
      >(
        `SELECT revision, event_id, command_id, prior_mode, result_mode,
                principal_digest, occurred_at
         FROM run_control_events WHERE run_key = ? ORDER BY revision`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "run-transition",
          identity: row.event_id,
          sequence: row.revision,
          state: row.result_mode,
          occurredAt: row.occurred_at,
          references: [
            ...(row.command_id === null ? [] : [reference("source", "command", row.command_id)]),
            reference("result", "run-mode-revision", String(row.revision)),
            reference("related", "principal", row.principal_digest),
          ],
          scalars: [scalar("priorMode", row.prior_mode), scalar("resultMode", row.result_mode)],
        }),
      );
    }
  }

  #captureModels(runKey: string, output: ReportingRecord[], costs: ReportingRecord[]): void {
    for (const row of this.#database
      .prepare<
        [string],
        {
          command_id: string;
          selection_digest: string | null;
          policy_digest: string | null;
          ordered_routes_digest: string | null;
          policy_key: string | null;
          route_index: number | null;
          provider: string | null;
          model: string | null;
          max_turns: number | null;
          max_submissions: number | null;
          max_millidollars: number | null;
          max_ai_credits: string | null;
        }
      >(
        `SELECT command_id,
                json_extract(canonical_command, '$.input.routeSelection.selectionDigest') AS selection_digest,
                json_extract(canonical_command, '$.input.routeSelection.modelPolicy.policyDigest') AS policy_digest,
                json_extract(canonical_command, '$.input.routeSelection.modelPolicy.orderedRoutesDigest') AS ordered_routes_digest,
                json_extract(canonical_command, '$.input.routeSelection.modelPolicy.key') AS policy_key,
                json_extract(canonical_command, '$.input.routeSelection.modelPolicy.routeIndex') AS route_index,
                json_extract(canonical_command, '$.input.routeSelection.modelPolicy.provider') AS provider,
                json_extract(canonical_command, '$.input.routeSelection.modelPolicy.model') AS model,
                json_extract(canonical_command, '$.input.routeSelection.limits.maxTurns') AS max_turns,
                json_extract(canonical_command, '$.input.routeSelection.limits.maxSubmissions') AS max_submissions,
                json_extract(canonical_command, '$.input.routeSelection.limits.maxMillidollars') AS max_millidollars,
                CAST(json_extract(canonical_command, '$.input.routeSelection.limits.maxAiCredits') AS TEXT) AS max_ai_credits
         FROM runner_commands WHERE run_key = ?
           AND json_extract(canonical_command, '$.kind') = 'worker'
         ORDER BY command_id`,
      )
      .all(runKey)) {
      if (row.selection_digest === null) continue;
      output.push(
        record({
          kind: "model-selection",
          identity: row.selection_digest,
          digest: row.selection_digest,
          references: [reference("related", "runner-command", row.command_id)],
          scalars: scalars({
            maxAiCredits: row.max_ai_credits,
            maxMillidollars: row.max_millidollars,
            maxSubmissions: row.max_submissions,
            maxTurns: row.max_turns,
            model: row.model,
            orderedRoutesDigest: row.ordered_routes_digest,
            policyDigest: row.policy_digest,
            policyKey: row.policy_key,
            provider: row.provider,
            routeIndex: row.route_index,
          }),
        }),
      );
      costs.push(
        record({
          kind: "model-ceiling",
          identity: row.selection_digest,
          references: [reference("related", "model-selection", row.selection_digest)],
          scalars: scalars({
            maxAiCredits: row.max_ai_credits,
            maxMillidollars: row.max_millidollars,
            maxSubmissions: row.max_submissions,
            maxTurns: row.max_turns,
          }),
        }),
      );
    }
  }

  #captureContext(
    repositoryId: string,
    runId: string,
    output: ReportingRecord[],
    assets: ReportingRecord[],
    actors: ReportingRecord[],
    models: ReportingRecord[],
    costs: ReportingRecord[],
  ): void {
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          dispatch_id: string;
          context_id: string;
          context_digest: string;
          prompt_pack_digest: string;
          task_id: string | null;
          definition_generation: number | null;
          graph_revision_digest: string | null;
          configuration_snapshot_digest: string | null;
          barrier_digest: string | null;
          base_commit_digest: string | null;
          base_tree_digest: string | null;
          role_key: string | null;
          role_digest: string | null;
          prompt_key: string | null;
          prompt_resource_digest: string | null;
          prompt_content_digest: string | null;
          prompt_byte_length: number | null;
          policy_key: string | null;
          policy_digest: string | null;
          ordered_routes_digest: string | null;
          worker_principal_id: string | null;
          worker_role_key: string | null;
        }
      >(
        `SELECT d.dispatch_id, d.context_id, b.context_digest, d.prompt_pack_digest,
                json_extract(b.canonical_context, '$.task.taskId') AS task_id,
                json_extract(b.canonical_context, '$.task.definitionGeneration') AS definition_generation,
                json_extract(b.canonical_context, '$.graphRevisionDigest') AS graph_revision_digest,
                json_extract(b.canonical_context, '$.configurationSnapshotDigest') AS configuration_snapshot_digest,
                json_extract(b.canonical_context, '$.dependencyBarrier.barrierDigest') AS barrier_digest,
                json_extract(b.canonical_context, '$.repositoryBase.commitDigest') AS base_commit_digest,
                json_extract(b.canonical_context, '$.repositoryBase.treeDigest') AS base_tree_digest,
                json_extract(b.canonical_context, '$.role.key') AS role_key,
                json_extract(b.canonical_context, '$.role.roleDigest') AS role_digest,
                json_extract(b.canonical_context, '$.prompt.key') AS prompt_key,
                json_extract(b.canonical_context, '$.prompt.resourceDigest') AS prompt_resource_digest,
                json_extract(b.canonical_context, '$.prompt.contentDigest') AS prompt_content_digest,
                json_extract(b.canonical_context, '$.prompt.byteLength') AS prompt_byte_length,
                json_extract(b.canonical_context, '$.modelPolicy.key') AS policy_key,
                json_extract(b.canonical_context, '$.modelPolicy.policyDigest') AS policy_digest,
                json_extract(b.canonical_context, '$.modelPolicy.orderedRoutesDigest') AS ordered_routes_digest,
                json_extract(d.canonical_dispatch, '$.worker.principalId') AS worker_principal_id,
                json_extract(d.canonical_dispatch, '$.worker.roleKey') AS worker_role_key
         FROM context_dispatches d JOIN context_bases b ON b.context_id = d.context_id
         WHERE d.repository_id = ? AND d.run_id = ? ORDER BY d.dispatch_id`,
      )
      .all(repositoryId, runId)) {
      output.push(
        record({
          kind: "dispatch",
          identity: row.dispatch_id,
          digest: row.prompt_pack_digest,
          references: [
            reference("related", "context", row.context_id),
            ...(row.task_id === null || row.definition_generation === null
              ? []
              : [reference("related", "task", `${row.task_id}:${row.definition_generation}`)]),
          ],
          scalars: scalars({
            baseCommitDigest: row.base_commit_digest,
            baseTreeDigest: row.base_tree_digest,
            configurationSnapshotDigest: row.configuration_snapshot_digest,
            contextDigest: row.context_digest,
            dependencyBarrierDigest: row.barrier_digest,
            graphRevisionDigest: row.graph_revision_digest,
            modelPolicyDigest: row.policy_digest,
            modelPolicyKey: row.policy_key,
            orderedRoutesDigest: row.ordered_routes_digest,
            promptByteLength: row.prompt_byte_length,
            promptContentDigest: row.prompt_content_digest,
            promptKey: row.prompt_key,
            promptResourceDigest: row.prompt_resource_digest,
            roleDigest: row.role_digest,
            roleKey: row.role_key,
          }),
        }),
      );
      if (
        row.worker_principal_id !== null &&
        !actors.some(({ identity }) => identity === row.worker_principal_id)
      ) {
        actors.push(
          record({
            kind: "worker-principal",
            identity: row.worker_principal_id,
            references: [reference("related", "dispatch", row.dispatch_id)],
            scalars: scalars({ roleKey: row.worker_role_key }),
          }),
        );
      }
      if (
        row.policy_digest !== null &&
        !models.some(({ identity }) => identity === row.policy_digest)
      ) {
        models.push(
          record({
            kind: "model-policy",
            identity: row.policy_digest,
            digest: row.policy_digest,
            references: [reference("related", "context", row.context_id)],
            scalars: scalars({
              key: row.policy_key,
              orderedRoutesDigest: row.ordered_routes_digest,
            }),
          }),
        );
      }
    }
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          asset_binding_id: string;
          semantic_asset_id: string;
          alias_binding_digest: string;
          content_digest: string;
          byte_length: number;
          media_type: string;
          sensitivity: string;
          context_id: string;
        }
      >(
        `SELECT DISTINCT a.asset_binding_id, a.semantic_asset_id, a.alias_binding_digest,
                a.content_digest, a.byte_length, a.media_type, a.sensitivity, a.context_id
         FROM context_asset_bindings a JOIN context_dispatches d ON d.context_id = a.context_id
         WHERE d.repository_id = ? AND d.run_id = ? ORDER BY a.asset_binding_id`,
      )
      .all(repositoryId, runId)) {
      assets.push(
        record({
          kind: "asset-metadata",
          identity: row.asset_binding_id,
          digest: row.content_digest,
          references: [
            reference("related", "context", row.context_id),
            reference("related", "semantic-asset", row.semantic_asset_id),
          ],
          scalars: scalars({
            aliasBindingDigest: row.alias_binding_digest,
            byteLength: row.byte_length,
            mediaType: row.media_type,
            sensitivity: row.sensitivity,
          }),
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          dispatch_id: string;
          asset_binding_id: string;
          operations_used: number;
          bytes_used: number;
        }
      >(
        `SELECT dispatch_id, asset_binding_id, operations_used, bytes_used
         FROM context_grants WHERE repository_id = ? AND run_id = ?
         ORDER BY dispatch_id, asset_binding_id`,
      )
      .all(repositoryId, runId)) {
      const usage = record({
        kind: "grant-usage",
        identity: `grant-usage:${row.dispatch_id}:${row.asset_binding_id}`,
        references: [
          reference("related", "asset-binding", row.asset_binding_id),
          reference("related", "dispatch", row.dispatch_id),
        ],
        scalars: [
          scalar("bytesUsed", row.bytes_used),
          scalar("operationsUsed", row.operations_used),
        ],
      });
      output.push(usage);
      costs.push(usage);
    }
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          request_id: string;
          dispatch_id: string | null;
          request_digest: string;
          status: string;
          failure_stage: string | null;
          failure_fact_digest: string | null;
        }
      >(
        `SELECT r.request_id, r.dispatch_id, r.request_digest, r.status,
                a.failure_stage, a.failure_fact_digest
         FROM context_read_attempts r
         LEFT JOIN context_audit_receipts a ON a.request_id = r.request_id
         WHERE r.repository_id = ? AND r.run_id = ? ORDER BY r.request_id`,
      )
      .all(repositoryId, runId)) {
      output.push(
        record({
          kind: "context-read",
          identity: row.request_id,
          state: row.status,
          digest: row.request_digest,
          references:
            row.dispatch_id === null ? [] : [reference("related", "dispatch", row.dispatch_id)],
          scalars: scalars({
            failureFactDigest: row.failure_fact_digest,
            failureStage: row.failure_stage,
          }),
        }),
      );
    }
    const installedAsset = this.#database.prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM assets WHERE digest = ?",
    );
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          submission_id: string;
          dispatch_id: string;
          submission_type: string;
          canonical_submission: string;
          canonical_result: string;
        }
      >(
        `SELECT submission_id, dispatch_id, submission_type, canonical_submission, canonical_result
         FROM context_submissions WHERE repository_id = ? AND run_id = ?
         ORDER BY submission_id`,
      )
      .all(repositoryId, runId)) {
      const submission = decodeCanonicalJsonValue(row.canonical_submission);
      const result = decodeCanonicalJsonValue(row.canonical_result);
      output.push(
        record({
          kind: "submission",
          identity: row.submission_id,
          state: `submission-${objectString(result, "status") ?? "recorded"}`,
          references: [reference("related", "dispatch", row.dispatch_id)],
          scalars: [scalar("submissionType", row.submission_type)],
        }),
      );
      if (row.submission_type === "asset" && isRecord(submission)) {
        const asset = submission.asset;
        if (isRecord(asset)) {
          const assetId = objectString(asset, "assetId");
          const contentDigest = objectString(asset, "contentDigest");
          const mediaType = objectString(asset, "mediaType");
          const sensitivity = objectString(asset, "sensitivity");
          const byteLength = asset.byteLength;
          if (
            assetId !== undefined &&
            contentDigest !== undefined &&
            mediaType !== undefined &&
            sensitivity !== undefined &&
            typeof byteLength === "number" &&
            Number.isSafeInteger(byteLength)
          ) {
            assets.push(
              record({
                kind: "worker-asset",
                identity: assetId,
                digest: contentDigest,
                references: [
                  reference("source", "submission", row.submission_id),
                  reference("related", "dispatch", row.dispatch_id),
                ],
                scalars: scalars({
                  byteLength,
                  mediaType,
                  sensitivity,
                  verifiedStored: installedAsset.get(contentDigest) !== undefined,
                }),
              }),
            );
          }
        }
      }
    }
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          submission_id: string;
          dispatch_id: string;
          question_digest: string | null;
          answer_digest: string | null;
          answered_at: string | null;
          principal_digest: string | null;
        }
      >(
        `SELECT q.submission_id, s.dispatch_id, a.question_digest, a.answer_digest,
                a.answered_at, a.principal_digest
         FROM context_questions q JOIN context_submissions s ON s.submission_id = q.submission_id
         LEFT JOIN context_question_answers a ON a.submission_id = q.submission_id
         WHERE q.repository_id = ? AND q.run_id = ? ORDER BY q.submission_id`,
      )
      .all(repositoryId, runId)) {
      output.push(
        record({
          kind: "question",
          identity: row.submission_id,
          state: row.answer_digest === null ? "pending" : "answered",
          ...(row.answered_at === null ? {} : { occurredAt: row.answered_at }),
          ...(row.question_digest === null ? {} : { digest: row.question_digest }),
          references: [
            reference("related", "dispatch", row.dispatch_id),
            ...(row.principal_digest === null
              ? []
              : [reference("related", "principal", row.principal_digest)]),
          ],
          scalars: scalars({ answerDigest: row.answer_digest }),
        }),
      );
      if (
        row.principal_digest !== null &&
        !actors.some(({ identity }) => identity === row.principal_digest)
      ) {
        actors.push(
          record({
            kind: "human-principal",
            identity: row.principal_digest,
            digest: row.principal_digest,
            references: [reference("related", "question", row.submission_id)],
            scalars: [],
          }),
        );
      }
    }
  }

  #digestValue(value: unknown): string {
    const digest = this.dependencies.sha256.digest(canonicalBytes(canonicalValue(value)));
    if (!isSha256Digest(digest)) throw new TypeError("Reporting value digest is invalid");
    return digest;
  }

  #captureAmendments(runKey: string, output: ReportingRecord[]): void {
    for (const row of this.#database
      .prepare<
        [string],
        {
          amendment_id: string;
          proposal_digest: string;
          base_graph_revision_digest: string;
          base_context_digest: string;
          base_snapshot_digest: string;
          result_snapshot_digest: string;
          reviewed_graph_revision_digest: string;
        }
      >(
        `SELECT amendment_id, proposal_digest, base_graph_revision_digest,
                base_context_digest, base_snapshot_digest, result_snapshot_digest,
                reviewed_graph_revision_digest
         FROM amendment_proposals WHERE run_key = ? ORDER BY amendment_id`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "amendment-proposal",
          identity: row.amendment_id,
          digest: row.proposal_digest,
          references: [],
          scalars: scalars({
            baseContextDigest: row.base_context_digest,
            baseGraphRevisionDigest: row.base_graph_revision_digest,
            baseSnapshotDigest: row.base_snapshot_digest,
            resultSnapshotDigest: row.result_snapshot_digest,
            reviewedGraphRevisionDigest: row.reviewed_graph_revision_digest,
          }),
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string],
        { amendment_id: string; approval_id: string; decision_digest: string; decision: string }
      >(
        `SELECT d.amendment_id, d.approval_id, d.decision_digest, d.decision
         FROM amendment_decisions d JOIN amendment_proposals p ON p.amendment_id = d.amendment_id
         WHERE p.run_key = ? ORDER BY d.amendment_id`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "amendment-decision",
          identity: row.approval_id,
          state: row.decision,
          digest: row.decision_digest,
          references: [reference("related", "amendment", row.amendment_id)],
          scalars: [],
        }),
      );
    }
    for (const row of this.#database
      .prepare<[string], { amendment_id: string; withdrawal_digest: string }>(
        `SELECT w.amendment_id, w.withdrawal_digest FROM amendment_withdrawals w
         JOIN amendment_proposals p ON p.amendment_id = w.amendment_id
         WHERE p.run_key = ? ORDER BY w.amendment_id`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "amendment-withdrawal",
          identity: row.amendment_id,
          state: "withdrawn",
          digest: row.withdrawal_digest,
          references: [reference("related", "amendment", row.amendment_id)],
          scalars: [],
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          amendment_id: string;
          application_digest: string;
          before_graph_revision_digest: string;
          after_graph_revision_digest: string;
          quiescence_fact_digest: string;
        }
      >(
        `SELECT a.amendment_id, a.application_digest, a.before_graph_revision_digest,
                a.after_graph_revision_digest, a.quiescence_fact_digest
         FROM amendment_applications a JOIN amendment_proposals p ON p.amendment_id = a.amendment_id
         WHERE p.run_key = ? ORDER BY a.amendment_id`,
      )
      .all(runKey)) {
      output.push(
        record({
          kind: "amendment-application",
          identity: row.amendment_id,
          state: "applied",
          digest: row.application_digest,
          references: [
            reference("source", "graph-revision", row.before_graph_revision_digest),
            reference("result", "graph-revision", row.after_graph_revision_digest),
          ],
          scalars: [scalar("quiescenceFactDigest", row.quiescence_fact_digest)],
        }),
      );
    }
  }

  #captureLifecycle(
    recordsJson: string | null,
    gates: ReportingRecord[],
    approvals: ReportingRecord[],
  ): void {
    if (recordsJson === null) return;
    for (const row of this.#database
      .prepare<
        [string],
        {
          phase_id: string;
          definition_generation: number;
          candidate_digest: string | null;
          gate_policy_digest: string | null;
          gate_evaluation_digest: string | null;
          gate_decision: string | null;
          approval_id: string | null;
          authority_decision_digest: string | null;
          authority_decision: string | null;
          closure_digest: string | null;
        }
      >(
        `SELECT json_extract(value, '$.phase.phaseId') AS phase_id,
                json_extract(value, '$.phase.definitionGeneration') AS definition_generation,
                json_extract(value, '$.candidate.candidateDigest') AS candidate_digest,
                json_extract(value, '$.gateEvidence.definition.policyDigest') AS gate_policy_digest,
                json_extract(value, '$.gateEvidence.evaluation.evaluationDigest') AS gate_evaluation_digest,
                json_extract(value, '$.gateEvidence.evaluation.decision') AS gate_decision,
                json_extract(value, '$.authorityDecision.approvalId') AS approval_id,
                json_extract(value, '$.authorityDecision.decisionDigest') AS authority_decision_digest,
                json_extract(value, '$.authorityDecision.decision') AS authority_decision,
                json_extract(value, '$.closure.closureDigest') AS closure_digest
         FROM json_each(?, '$.phaseLifecycles')`,
      )
      .all(recordsJson)) {
      const phaseIdentity = `${row.phase_id}:${row.definition_generation}`;
      if (row.gate_evaluation_digest !== null) {
        gates.push(
          record({
            kind: "workflow-gate",
            identity: row.gate_evaluation_digest,
            state: row.gate_decision ?? "recorded",
            digest: row.gate_evaluation_digest,
            references: [reference("related", "phase", phaseIdentity)],
            scalars: scalars({
              candidateDigest: row.candidate_digest,
              policyDigest: row.gate_policy_digest,
            }),
          }),
        );
      }
      if (row.candidate_digest !== null) {
        approvals.push(
          record({
            kind: "phase-candidate",
            identity: row.candidate_digest,
            digest: row.candidate_digest,
            references: [reference("related", "phase", phaseIdentity)],
            scalars: [],
          }),
        );
      }
      if (row.authority_decision_digest !== null && row.approval_id !== null) {
        approvals.push(
          record({
            kind: "authority-decision",
            identity: row.approval_id,
            state: row.authority_decision ?? "recorded",
            digest: row.authority_decision_digest,
            references:
              row.candidate_digest === null
                ? []
                : [reference("related", "candidate", row.candidate_digest)],
            scalars: [],
          }),
        );
      }
      if (row.closure_digest !== null) {
        approvals.push(
          record({
            kind: "phase-closure",
            identity: row.closure_digest,
            state: "closed",
            digest: row.closure_digest,
            references:
              row.candidate_digest === null
                ? []
                : [reference("related", "candidate", row.candidate_digest)],
            scalars: [],
          }),
        );
      }
    }
  }

  #captureRunner(
    runKey: string,
    trajectory: ReportingRecord[],
    escalations: ReportingRecord[],
    costs: ReportingRecord[],
    uncertainty: ReportingRecord[],
  ): void {
    for (const row of this.#database
      .prepare<
        [string],
        {
          command_id: string;
          operation_id: string;
          unit: string;
          requested: number;
          available: number;
          created_at: string;
        }
      >(
        `SELECT e.command_id,
                json_extract(e.canonical_escalation, '$.operationId') AS operation_id,
                json_extract(e.canonical_escalation, '$.unit') AS unit,
                json_extract(e.canonical_escalation, '$.requested') AS requested,
                json_extract(e.canonical_escalation, '$.available') AS available,
                json_extract(e.canonical_escalation, '$.createdAt') AS created_at
         FROM runner_escalations e WHERE e.run_key = ? ORDER BY e.command_id`,
      )
      .all(runKey)) {
      escalations.push(
        record({
          kind: "runner-escalation",
          identity: row.command_id,
          state: "budget-exhausted",
          occurredAt: row.created_at,
          references: [reference("related", "operation", row.operation_id)],
          scalars: [
            scalar("available", row.available),
            scalar("requested", row.requested),
            scalar("unit", row.unit),
          ],
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          escalation_command_id: string;
          command_id: string;
          escalation_digest: string;
          policy_digest: string;
          unit: string;
          prior_limit: number;
          increase_by: number;
          resulting_limit: number;
          principal_digest: string;
          resolved_at: string;
        }
      >(
        `SELECT escalation_command_id, command_id, escalation_digest, policy_digest,
                unit, prior_limit, increase_by, resulting_limit,
                principal_digest, resolved_at
         FROM runner_allowance_resolutions WHERE run_key = ?
         ORDER BY resolved_at, escalation_command_id`,
      )
      .all(runKey)) {
      const resolution = record({
        kind: "allowance-resolution",
        identity: row.command_id,
        state: "granted",
        occurredAt: row.resolved_at,
        references: [
          reference("source", "command", row.command_id),
          reference("related", "runner-escalation", row.escalation_command_id),
          reference("related", "allowance-policy", row.policy_digest),
          reference("related", "principal", row.principal_digest),
          reference("result", "runner-budget-limit", `${row.unit}:${row.resulting_limit}`),
        ],
        scalars: scalars({
          escalationDigest: row.escalation_digest,
          increaseBy: row.increase_by,
          priorLimit: row.prior_limit,
          resultingLimit: row.resulting_limit,
          unit: row.unit,
        }),
      });
      escalations.push(resolution);
      costs.push(resolution);
    }
    for (const row of this.#database
      .prepare<
        [string],
        { unit: string; budget_limit: number; reserved: number; spent: number; unreported: number }
      >(
        `SELECT unit, budget_limit, reserved, spent, unreported
         FROM runner_budgets WHERE run_key = ? ORDER BY unit`,
      )
      .all(runKey)) {
      costs.push(
        record({
          kind: "runner-budget",
          identity: row.unit,
          references: [],
          scalars: [
            scalar("limit", row.budget_limit),
            scalar("reserved", row.reserved),
            scalar("spent", row.spent),
            scalar("unreported", row.unreported),
          ],
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          intent_id: string;
          command_id: string;
          operation_id: string;
          kind: string;
          status: string | null;
          freshness: string | null;
          observed_at: string | null;
          reconciliation_attempts: number | null;
          origin: string | null;
          output_digest: string | null;
          transcript_refusals: number | null;
          usage_unit: string | null;
          usage_reserved: number | null;
          usage_reported: number | null;
          usage_unreported: number | null;
        }
      >(
        `SELECT i.intent_id,
                json_extract(i.canonical_intent, '$.command.commandId') AS command_id,
                json_extract(i.canonical_intent, '$.command.operationId') AS operation_id,
                json_extract(i.canonical_intent, '$.command.kind') AS kind,
                json_extract(o.canonical_outcome, '$.status') AS status,
                json_extract(o.canonical_outcome, '$.freshness') AS freshness,
                json_extract(o.canonical_outcome, '$.observedAt') AS observed_at,
                json_extract(o.canonical_outcome, '$.reconciliationAttempts') AS reconciliation_attempts,
                json_extract(o.canonical_outcome, '$.origin') AS origin,
                json_extract(o.canonical_outcome, '$.outputDigest') AS output_digest,
                json_extract(o.canonical_outcome, '$.details.transcriptRefusals')
                  AS transcript_refusals,
                json_extract(o.canonical_outcome, '$.usage.unit') AS usage_unit,
                json_extract(o.canonical_outcome, '$.usage.reserved') AS usage_reserved,
                json_extract(o.canonical_outcome, '$.usage.reported') AS usage_reported,
                json_extract(o.canonical_outcome, '$.usage.unreported') AS usage_unreported
         FROM runner_effect_intents i
         LEFT JOIN runner_effect_outcomes o ON o.intent_id = i.intent_id
           AND o.commit_cursor = (SELECT MAX(latest.commit_cursor)
                                  FROM runner_effect_outcomes latest
                                  WHERE latest.intent_id = i.intent_id)
         WHERE i.run_key = ? ORDER BY i.intent_id`,
      )
      .all(runKey)) {
      const effect = record({
        kind: "effect",
        identity: row.intent_id,
        state: row.status ?? "intent",
        ...(row.observed_at === null ? {} : { occurredAt: row.observed_at }),
        ...(row.output_digest === null ? {} : { digest: row.output_digest }),
        references: [
          reference(row.status === "completed" ? "source" : "related", "command", row.command_id),
          reference("related", "operation", row.operation_id),
          ...(row.status === "completed"
            ? [reference("result", "effect-outcome", row.intent_id)]
            : []),
        ],
        scalars: scalars({
          effectKind: row.kind,
          freshness: row.freshness,
          origin: row.origin,
          reconciliationAttempts: row.reconciliation_attempts,
          // Present only when durable transcript capture refused at least one
          // line, so an operator reading the report sees the loss.
          transcriptRefusals: row.transcript_refusals,
        }),
      });
      trajectory.push(effect);
      if (row.usage_unit !== null) {
        costs.push(
          record({
            kind: "effect-usage",
            identity: row.intent_id,
            references: [reference("related", "effect", row.intent_id)],
            scalars: scalars({
              reported: row.usage_reported,
              reserved: row.usage_reserved,
              unit: row.usage_unit,
              unreported: row.usage_unreported,
            }),
          }),
        );
      }
      if (row.status === "unknown" || row.freshness === "stale") uncertainty.push(effect);
    }
  }

  #captureWorkspaces(
    runKey: string,
    workspaces: ReportingRecord[],
    integrations: ReportingRecord[],
    gates: ReportingRecord[],
    uncertainty: ReportingRecord[],
  ): void {
    for (const row of this.#database
      .prepare<
        [string],
        {
          workspace_id: string;
          dispatch_id: string;
          task_id: string;
          definition_generation: number;
          mode: string;
          state: string;
          base_revision_digest: string;
        }
      >(
        `SELECT workspace_id, dispatch_id, task_id, definition_generation, mode,
                state, base_revision_digest
         FROM runner_workspaces WHERE run_key = ? ORDER BY workspace_id`,
      )
      .all(runKey)) {
      const workspace = record({
        kind: "workspace",
        identity: row.workspace_id,
        state: row.state,
        digest: row.base_revision_digest,
        references: [
          reference("related", "dispatch", row.dispatch_id),
          reference("related", "task", `${row.task_id}:${row.definition_generation}`),
        ],
        scalars: [scalar("mode", row.mode)],
      });
      workspaces.push(workspace);
      if (row.state === "unknown") uncertainty.push(workspace);
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          result_id: string;
          workspace_id: string;
          result_tree_digest: string;
          result_revision_digest: string;
          completion_fact_digest: string;
          recorded_at: string;
        }
      >(
        `SELECT r.result_id, r.workspace_id, r.result_tree_digest,
                r.result_revision_digest, r.completion_fact_digest, r.recorded_at
         FROM runner_workspace_results r JOIN runner_workspaces w ON w.workspace_id = r.workspace_id
         WHERE w.run_key = ? ORDER BY r.result_id`,
      )
      .all(runKey)) {
      workspaces.push(
        record({
          kind: "workspace-result",
          identity: row.result_id,
          occurredAt: row.recorded_at,
          digest: row.result_revision_digest,
          references: [reference("related", "workspace", row.workspace_id)],
          scalars: [
            scalar("completionFactDigest", row.completion_fact_digest),
            scalar("resultTreeDigest", row.result_tree_digest),
          ],
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          integration_id: string;
          phase_id: string;
          definition_generation: number;
          fan_in_digest: string;
          state: string;
          barrier_digest: string | null;
        }
      >(
        `SELECT integration_id, phase_id, definition_generation, fan_in_digest,
                state, barrier_digest
         FROM runner_integration_attempts WHERE run_key = ? ORDER BY integration_id`,
      )
      .all(runKey)) {
      const integration = record({
        kind: "integration-attempt",
        identity: row.integration_id,
        state: row.state,
        digest: row.fan_in_digest,
        references: [reference("related", "phase", `${row.phase_id}:${row.definition_generation}`)],
        scalars: scalars({ barrierDigest: row.barrier_digest }),
      });
      integrations.push(integration);
      if (["unknown", "conflicted", "target-moved", "rework-required"].includes(row.state)) {
        uncertainty.push(integration);
      }
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          integration_id: string;
          policy_digest: string;
          reading_digest: string;
          evaluation_digest: string;
          decision: string;
        }
      >(
        `SELECT g.integration_id, g.policy_digest, g.reading_digest,
                g.evaluation_digest, g.decision
         FROM runner_integration_gates g
         JOIN runner_integration_attempts i ON i.integration_id = g.integration_id
         WHERE i.run_key = ? ORDER BY g.integration_id`,
      )
      .all(runKey)) {
      gates.push(
        record({
          kind: "integration-gate",
          identity: row.evaluation_digest,
          state: row.decision,
          digest: row.evaluation_digest,
          references: [reference("related", "integration", row.integration_id)],
          scalars: [
            scalar("policyDigest", row.policy_digest),
            scalar("readingDigest", row.reading_digest),
          ],
        }),
      );
    }
  }

  #capturePortal(
    repositoryId: string,
    runId: string,
    vector: ReportingSourceVector,
    output: ReportingRecord[],
  ): void {
    const state = this.#database
      .prepare<[string, string], { mode: string; revision: number }>(
        `SELECT mode, revision FROM run_control_state
         WHERE repository_id = ? AND run_id = ?`,
      )
      .get(repositoryId, runId);
    output.push(
      record({
        kind: "portal-summary",
        identity: `${repositoryId}:${runId}`,
        ...(state === undefined ? {} : { state: state.mode }),
        references: [],
        scalars: scalars({
          contextRevision: vector.contextRevision,
          dataflowRevision: vector.dataflowRevision,
          humanRevision: vector.humanRevision,
          lifecycleRevision: vector.lifecycleRevision,
          portalRevision: vector.portalRevision,
          runModeRevision: state?.revision ?? 0,
          runnerRevision: vector.runnerRevision,
          workflowCursor: vector.workflowCursor,
          workspaceRevision: vector.workspaceRevision,
        }),
      }),
    );
  }

  #captureRemote(
    repositoryId: string,
    runId: string,
    output: ReportingRecord[],
    uncertainty: ReportingRecord[],
  ): void {
    const relevantBindingIds = new Set<string>();
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          binding_id: string;
          local_latest_cursor: number;
          durably_enqueued_cursor: number;
          centrally_acknowledged_cursor: number;
          last_enqueued_report_sequence: number;
          last_acknowledged_report_sequence: number;
        }
      >(
        `SELECT binding_id, local_latest_cursor, durably_enqueued_cursor,
                centrally_acknowledged_cursor, last_enqueued_report_sequence,
                last_acknowledged_report_sequence
         FROM remote_run_event_checkpoints WHERE repository_id = ? AND run_id = ?
         ORDER BY binding_id`,
      )
      .all(repositoryId, runId)) {
      relevantBindingIds.add(row.binding_id);
      const synchronization = record({
        kind: "remote-sync",
        identity: `${row.binding_id}:${runId}`,
        state:
          row.centrally_acknowledged_cursor === row.local_latest_cursor
            ? "synchronized"
            : "lagging",
        references: [reference("related", "remote-binding", row.binding_id)],
        scalars: [
          scalar("acknowledgedCursor", row.centrally_acknowledged_cursor),
          scalar("acknowledgedReportSequence", row.last_acknowledged_report_sequence),
          scalar("enqueuedCursor", row.durably_enqueued_cursor),
          scalar("enqueuedReportSequence", row.last_enqueued_report_sequence),
          scalar("localCursor", row.local_latest_cursor),
        ],
      });
      output.push(synchronization);
      if (row.centrally_acknowledged_cursor !== row.local_latest_cursor) {
        uncertainty.push(synchronization);
      }
    }
    for (const row of this.#database
      .prepare<
        [string, string],
        {
          binding_id: string;
          sequence: number;
          command_id: string;
          envelope_digest: string;
          delivery_entry_digest: string;
          processing_state: string;
          local_acceptance_digest: string | null;
          local_result_digest: string | null;
        }
      >(
        `SELECT binding_id, sequence, command_id, envelope_digest,
                delivery_entry_digest, processing_state, local_acceptance_digest,
                local_result_digest
         FROM remote_command_inbox
         WHERE repository_id = ?
           AND json_extract(canonical_envelope, '$.acceptedCommand.command.runId') = ?
         ORDER BY binding_id, sequence`,
      )
      .all(repositoryId, runId)) {
      relevantBindingIds.add(row.binding_id);
      output.push(
        record({
          kind: "remote-command-chain",
          identity: `${row.binding_id}:${row.sequence}`,
          sequence: row.sequence,
          state: row.processing_state,
          digest: row.envelope_digest,
          references: [
            reference("related", "command", row.command_id),
            reference("related", "remote-binding", row.binding_id),
          ],
          scalars: scalars({
            deliveryEntryDigest: row.delivery_entry_digest,
            localAcceptanceDigest: row.local_acceptance_digest,
            localResultDigest: row.local_result_digest,
          }),
        }),
      );
    }
    for (const row of this.#database
      .prepare<
        [string, string, string, string],
        {
          report_id: string;
          binding_id: string;
          report_sequence: number;
          report_digest: string;
          delivery_state: string;
          acknowledgement_digest: string | null;
          canonical_report: string;
          from_cursor: number | null;
          through_cursor: number | null;
          local_latest_cursor: number | null;
        }
      >(
        `SELECT report_id, binding_id, report_sequence, report_digest,
                delivery_state, acknowledgement_digest, canonical_report,
                (SELECT from_cursor FROM remote_report_run_event_advances
                 WHERE report_id = remote_report_outbox.report_id AND run_id = ?) AS from_cursor,
                (SELECT through_cursor FROM remote_report_run_event_advances
                 WHERE report_id = remote_report_outbox.report_id AND run_id = ?) AS through_cursor,
                (SELECT local_latest_cursor FROM remote_report_run_event_advances
                 WHERE report_id = remote_report_outbox.report_id AND run_id = ?) AS local_latest_cursor
         FROM remote_report_outbox WHERE repository_id = ? ORDER BY binding_id, report_sequence`,
      )
      .all(runId, runId, runId, repositoryId)) {
      const report = decodeRemoteClassifiedReport(row.canonical_report);
      const commandIds = new Set(
        this.#database
          .prepare<[string, string], { command_id: string }>(
            `SELECT command_id FROM remote_command_inbox
             WHERE binding_id = ?
               AND json_extract(canonical_envelope, '$.acceptedCommand.command.runId') = ?`,
          )
          .all(row.binding_id, runId)
          .map(({ command_id }) => command_id),
      );
      const receiptChains = report.receiptChains.filter(({ commandId }) =>
        commandIds.has(commandId),
      );
      const events = report.events.filter((event) => event.runId === runId);
      const projections = report.projections.filter((projection) => projection.runId === runId);
      if (
        row.through_cursor === null &&
        receiptChains.length === 0 &&
        events.length === 0 &&
        projections.length === 0
      ) {
        continue;
      }
      relevantBindingIds.add(row.binding_id);
      output.push(
        record({
          kind: "remote-report",
          identity: row.report_id,
          sequence: row.report_sequence,
          state: row.delivery_state,
          digest: row.report_digest,
          references: [reference("related", "remote-binding", row.binding_id)],
          scalars: scalars({
            acknowledgementDigest: row.acknowledgement_digest,
            fromCursor: row.from_cursor,
            localLatestCursor: row.local_latest_cursor,
            throughCursor: row.through_cursor,
          }),
        }),
      );
      for (const chain of receiptChains) {
        for (const entry of chain.entries) {
          output.push(
            record({
              kind: "remote-receipt-entry",
              identity: `${row.report_id}:${chain.commandId}:${entry.stageSequence}`,
              sequence: entry.stageSequence,
              state: entry.stage,
              occurredAt: entry.recordedAt,
              digest: entry.entryDigest,
              references: [
                reference("related", "remote-report", row.report_id),
                reference("related", "command", chain.commandId),
              ],
              scalars: [],
            }),
          );
        }
      }
      for (const event of events) {
        output.push(
          record({
            kind: "remote-event",
            identity: event.eventId,
            sequence: event.cursor,
            state: event.eventType,
            occurredAt: event.occurredAt,
            digest: event.payloadDigest,
            references: [
              reference("related", "remote-report", row.report_id),
              ...(event.commandId === undefined
                ? []
                : [reference("related", "command", event.commandId)]),
            ],
            scalars: [],
          }),
        );
      }
      for (const projection of projections) {
        output.push(
          record({
            kind: "remote-projection",
            identity: `${row.report_id}:${projection.projectionType}:${projection.revision}`,
            sequence: projection.cursor,
            state: projection.lifecycleStatus,
            occurredAt: projection.generatedAt,
            digest: projection.payloadDigest,
            references: [reference("related", "remote-report", row.report_id)],
            scalars: scalars({
              activeEffects: projection.counts.activeEffects,
              humanNeeds: projection.counts.humanNeeds,
              readyTasks: projection.counts.readyTasks,
              tasks: projection.counts.tasks,
              uncertainEffects: projection.counts.uncertainEffects,
            }),
          }),
        );
      }
    }
    for (const row of this.#database
      .prepare<
        [string],
        {
          binding_id: string;
          binding_digest: string;
          current_revocation_epoch: number;
          selected_protocol_version: string | null;
        }
      >(
        `SELECT binding_id, binding_digest, current_revocation_epoch,
                selected_protocol_version
         FROM remote_peer_state WHERE repository_id = ? ORDER BY binding_id`,
      )
      .all(repositoryId)) {
      if (!relevantBindingIds.has(row.binding_id)) continue;
      output.push(
        record({
          kind: "remote-binding",
          identity: row.binding_id,
          digest: row.binding_digest,
          references: [],
          scalars: scalars({
            protocolVersion: row.selected_protocol_version,
            revocationEpoch: row.current_revocation_epoch,
          }),
        }),
      );
    }
  }
}

function section(
  name: ReportingSectionName,
  records: readonly ReportingRecord[],
  alwaysComplete: boolean,
): ReportingSnapshotSection {
  if (!alwaysComplete && records.length === 0) {
    return Object.freeze({
      name,
      status: "absent",
      reasonCode: "no-recorded-data",
      records: Object.freeze([]),
    });
  }
  return Object.freeze({ name, status: "complete", records: Object.freeze([...records]) });
}

function record(
  input: Omit<ReportingRecord, "references" | "scalars"> & {
    readonly references: readonly ReportingReference[];
    readonly scalars: readonly ReportingNamedScalar[];
  },
): ReportingRecord {
  return Object.freeze({
    ...input,
    references: Object.freeze([...input.references].sort(compareReference)),
    scalars: Object.freeze([...input.scalars].sort(compareScalar)),
  });
}

function reference(
  role: ReportingReference["role"],
  kind: string,
  identity: string,
): ReportingReference {
  return Object.freeze({ role, kind, identity });
}

function scalar(name: string, value: string | number | boolean): ReportingNamedScalar {
  return Object.freeze({ name, value });
}

function scalars(
  values: Readonly<Record<string, string | number | boolean | null | undefined>>,
): ReportingNamedScalar[] {
  return Object.entries(values).flatMap(([name, value]) =>
    value === null || value === undefined ? [] : [scalar(name, value)],
  );
}

function compareReference(left: ReportingReference, right: ReportingReference): number {
  return (
    compareText(left.role, right.role) ||
    compareText(left.kind, right.kind) ||
    compareText(left.identity, right.identity)
  );
}

function compareScalar(left: ReportingNamedScalar, right: ReportingNamedScalar): number {
  return compareText(left.name, right.name) || compareText(String(left.value), String(right.value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCeilings(sections: readonly ReportingSnapshotSection[]): void {
  let total = 0;
  for (const current of sections) {
    if (current.records.length > REPORTING_LIMITS.maxRecordsPerSection) {
      throw new TypeError(`Reporting section ${current.name} exceeds its record ceiling`);
    }
    total += current.records.length;
  }
  if (total > REPORTING_LIMITS.maxTotalRecords) {
    throw new TypeError("Reporting snapshot exceeds its total record ceiling");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const selected = value[key];
  return typeof selected === "string" ? selected : undefined;
}
