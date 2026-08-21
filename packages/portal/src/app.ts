import {
  decodeCanonicalJsonValue,
  type JsonValue,
  type PortalAgentSummary,
  type PortalHumanNeed,
  type PortalQuestionRecord,
  type PortalRunOverview,
  type PortalTranscriptOwner,
  TRANSCRIPT_LIMITS,
} from "@senawa/protocol";
import { allowanceCommandDraft, allowanceReviewIsCurrent } from "./allowance-review.js";
import {
  answerDraftIdentity,
  clearAnswerDrafts,
  dropRunAnswerDrafts,
  pruneAnswerDrafts,
  readAnswerDraft,
  writeAnswerDraft,
} from "./answer-draft.js";
import {
  type CommandDraft,
  clearPortalSession,
  createPendingSubmission,
  loadPending,
  loadPortalSession,
  pendingRecoveryDecision,
  savePending,
  savePortalSession,
} from "./pending.js";
import { pendingQuestionNeed } from "./question-attention.js";
import { readRailLayout, saveRailLayout } from "./rail-layout.js";
import { type PortalRenderActions, refreshQuestionAttention, renderPortal } from "./render.js";
import { parsePortalHash, portalHash } from "./router.js";
import { transcriptRevisionsEqual, vectorsEqual } from "./selectors.js";
import { sessionAccess } from "./session.js";
import { PortalEventStream } from "./sse.js";
import {
  artifactContentKey,
  type DialogKind,
  initialPortalState,
  type PendingCanonicalSubmission,
  type PortalAction,
  type PortalState,
  portalReducer,
  revisionKey,
  runKey,
} from "./state.js";
import { sameTranscriptOwner, transcriptOwnerForNode } from "./transcript-view-model.js";
import { PortalHttpClient, PortalTransportError } from "./transport.js";

const POLL_INTERVAL_MS = 10_000;
const RECEIPT_POLL_MS = 1_000;
/** Bounded tick that ages the open question banner without a full rerender. */
const QUESTION_TICK_MS = 1_000;
/** Paging ceiling that can never retain more than one owner's bounded window. */
const TRANSCRIPT_MAX_PAGES = Math.ceil(
  TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner / TRANSCRIPT_LIMITS.maxRecordsPerPage,
);

export class PortalApplication {
  readonly #root: HTMLElement;
  readonly #client: PortalHttpClient;
  readonly #stream: PortalEventStream;
  #state: PortalState;
  #poll: number | undefined;
  #refetchFrame: number | undefined;
  #streamIdentity: string | undefined;
  #consistentLoad: Promise<boolean> | undefined;
  #consistentLoadIdentity: string | undefined;
  #restoredCanRetry = false;
  #dialogNeed: PortalHumanNeed | undefined;
  #transcriptSync: Promise<void> | undefined;
  #transcriptQueued = false;
  #questionTick: number | undefined;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#state = initialPortalState(parsePortalHash(location.hash));
    this.#state = portalReducer(this.#state, {
      type: "rail-layout",
      layout: readRailLayout(localStorage),
    });
    this.#client = new PortalHttpClient({ onUnauthorized: () => this.#expireSession() });
    this.#stream = new PortalEventStream({
      create: (url) => new BrowserEventSource(url),
      onOpen: () => this.#dispatch({ type: "connection", status: "live" }),
      onFrame: (event) => {
        this.#dispatch({ type: "event", event });
        this.#coalesceRefetch();
      },
      onGap: (message) => void this.#resynchronizeGap(message),
      onReconnect: async (attempt) => {
        this.#dispatch({
          type: "connection",
          status: "reconnecting",
          message: `Reconnect attempt ${attempt}`,
        });
        try {
          await this.#client.session();
          return await this.#loadConsistent(0, false);
        } catch {
          return false;
        }
      },
    });
  }

  async start(): Promise<void> {
    this.#bindBrowserEvents();
    this.#render();
    for (const pending of loadPending(sessionStorage))
      this.#dispatch({ type: "pending-add", pending });
    try {
      const persisted = loadPortalSession(sessionStorage);
      const descriptor = await this.#client.session();
      const access = sessionAccess(descriptor, persisted, Date.now());
      let csrfToken: string | undefined;
      if (access.type === "issue-csrf") {
        csrfToken = await this.#client.issueCsrf();
        savePortalSession(sessionStorage, { csrfToken, expiresAt: descriptor.expiresAt });
      } else if (access.type === "read-write") {
        csrfToken = access.csrfToken;
        this.#restoredCanRetry = true;
      }
      this.#client.setCsrfToken(csrfToken);
      this.#dispatch({
        type: "session-ready",
        descriptor,
        ...(csrfToken === undefined ? {} : { csrfToken }),
      });
      await this.#discover();
      if (csrfToken !== undefined) void this.#recoverAllPending(this.#restoredCanRetry);
      this.#startPolling();
    } catch (error) {
      if (this.#sessionExpired()) return;
      this.#dispatch({
        type: "session-invalid",
        message: safeMessage(error, "Portal session could not start"),
      });
    }
  }

  #bindBrowserEvents(): void {
    const compactRail = window.matchMedia("(max-width: 1179px)");
    const synchronizeRail = () => {
      this.#dispatch({ type: "right-rail", open: !compactRail.matches });
    };
    compactRail.addEventListener("change", synchronizeRail);
    synchronizeRail();
    window.addEventListener("hashchange", () => {
      const routeTabHadFocus = document.activeElement?.getAttribute("role") === "tab";
      const route = parsePortalHash(location.hash);
      this.#dispatch({ type: "route", route });
      if (route.repositoryId !== undefined && route.runId !== undefined) {
        void this.#selectRun(route.repositoryId, route.runId, false);
      } else {
        void this.#loadConsistent();
      }
      requestAnimationFrame(() => {
        const target = routeTabHadFocus
          ? document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
          : document.querySelector<HTMLElement>("#route-heading");
        target?.focus();
      });
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void this.#loadConsistent();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLSelectElement>("#run-switcher")?.focus();
      }
      if (event.key === "Escape" && this.#state.ui.dialog !== undefined) this.#closeDialog();
      if (
        event.key === "Escape" &&
        this.#state.ui.dialog === undefined &&
        this.#state.ui.assetOverlay !== undefined
      ) {
        this.#closeAssetOverlay();
      }
    });
  }

  async #discover(): Promise<void> {
    const repositories = await this.#client.repositories();
    this.#dispatch({ type: "repositories", page: repositories });
    for (const repository of repositories.repositories) {
      const runs = await this.#client.runs(repository.repositoryId);
      this.#dispatch({ type: "runs", repositoryId: repository.repositoryId, page: runs });
    }
    const routed = this.#state.route;
    if (routed.repositoryId !== undefined && routed.runId !== undefined) {
      await this.#selectRun(routed.repositoryId, routed.runId, false);
      return;
    }
    const repository = repositories.repositories[0];
    const run =
      repository === undefined
        ? undefined
        : this.#state.caches.runsByRepository[repository.repositoryId]?.runs[0];
    if (repository !== undefined && run !== undefined)
      await this.#selectRun(repository.repositoryId, run.runId, true);
  }

  async #selectRun(repositoryId: string, runId: string, updateHash: boolean): Promise<void> {
    const identity = runKey(repositoryId, runId);
    const changed =
      identity !== runKey(this.#state.selectedRepositoryId ?? "", this.#state.selectedRunId ?? "");
    if (changed) {
      this.#stream.close();
      this.#streamIdentity = undefined;
      this.#dropDepartedRunDrafts();
      this.#dispatch({ type: "select-run", repositoryId, runId });
    }
    if (
      updateHash ||
      this.#state.route.repositoryId !== repositoryId ||
      this.#state.route.runId !== runId
    ) {
      location.hash = portalHash(repositoryId, runId, this.#state.route.name);
    }
    await this.#loadConsistent();
  }

  async #loadConsistent(attempt = 0, connectStream = true): Promise<boolean> {
    const selected = this.#selectedIdentity();
    const identity =
      selected === undefined
        ? undefined
        : `${runKey(selected.repositoryId, selected.runId)}\u0000${this.#state.route.name}`;
    if (this.#consistentLoad !== undefined) {
      const activeIdentity = this.#consistentLoadIdentity;
      const result = await this.#consistentLoad;
      return activeIdentity === identity ? result : this.#loadConsistent(attempt, connectStream);
    }
    const load = this.#performConsistentLoad(attempt, connectStream);
    this.#consistentLoad = load;
    this.#consistentLoadIdentity = identity;
    try {
      return await load;
    } finally {
      if (this.#consistentLoad === load) {
        this.#consistentLoad = undefined;
        this.#consistentLoadIdentity = undefined;
      }
    }
  }

  async #performConsistentLoad(attempt = 0, connectStream = true): Promise<boolean> {
    const identity = this.#selectedIdentity();
    if (identity === undefined || this.#state.session.status === "expired" || document.hidden)
      return false;
    const route = this.#state.route.name;
    const routeAlreadyFresh = this.#state.freshness[route]?.status === "fresh";
    if (!routeAlreadyFresh) {
      this.#dispatch({
        type: "freshness",
        resource: this.#state.route.name,
        freshness: { status: "loading" },
      });
    }
    try {
      const overviewA = await this.#client.overview(identity.repositoryId, identity.runId);
      if (!this.#isCurrentAssembly(identity.repositoryId, identity.runId, route)) return false;
      const current = this.#selectedOverview();
      if (
        current !== undefined &&
        vectorsEqual(current.sync, overviewA.sync) &&
        routeAlreadyFresh
      ) {
        // Agent output advances outside the assembly window, so it is picked up
        // here without re-running the whole bounded assembly.
        if (!transcriptRevisionsEqual(current.sync, overviewA.sync)) {
          this.#dispatch({ type: "overview", overview: overviewA });
          void this.#syncTranscript();
        }
        if (connectStream) {
          this.#ensureStream(identity.repositoryId, identity.runId, overviewA.sync.workflowCursor);
        }
        return true;
      }
      if (!(await this.#loadResources(identity.repositoryId, identity.runId, route, overviewA))) {
        return false;
      }
      const overviewB = await this.#client.overview(identity.repositoryId, identity.runId);
      if (!this.#isCurrentAssembly(identity.repositoryId, identity.runId, route)) return false;
      if (!vectorsEqual(overviewA.sync, overviewB.sync)) {
        if (attempt === 0) return this.#performConsistentLoad(1, connectStream);
        this.#dispatch({
          type: "freshness",
          resource: route,
          freshness: { status: "stale", message: "Authority changed during bounded assembly" },
        });
        return false;
      }
      this.#dispatch({ type: "overview", overview: overviewB });
      const freshness = { status: "fresh" as const, vector: overviewB.sync };
      // Keyed off the routes deliberately: marking a route fresh is what lets a
      // later visit skip its load, and the run authority is not any one route's
      // data.
      this.#dispatch({
        type: "freshness",
        resource: "authority",
        freshness,
      });
      this.#dispatch({ type: "freshness", resource: route, freshness });
      if (connectStream)
        this.#ensureStream(identity.repositoryId, identity.runId, overviewB.sync.workflowCursor);
      return true;
    } catch (error) {
      if (
        this.#sessionExpired() ||
        !this.#isCurrentAssembly(identity.repositoryId, identity.runId, route)
      ) {
        return false;
      }
      this.#dispatch({
        type: "freshness",
        resource: route,
        freshness: { status: "failed", message: safeMessage(error, "Resource load failed") },
      });
      this.#dispatch({
        type: "connection",
        status: "offline",
        message: safeMessage(error, "Authority is offline"),
      });
      return false;
    }
  }

  async #loadResources(
    repositoryId: string,
    runId: string,
    route: PortalState["route"]["name"],
    overview: PortalRunOverview,
  ): Promise<boolean> {
    const key = runKey(repositoryId, runId);
    const needs = await this.#client.needs(repositoryId, runId);
    if (!this.#isCurrentAssembly(repositoryId, runId, route)) return false;
    this.#dispatch({ type: "human-needs", needs: needs.needs });
    // Needs drive the attention banner on every route. Events and receipts feed
    // only the activity route, so fetching them everywhere made three requests
    // where one was wanted and delayed the view a reader actually asked for.
    if (route === "record") {
      const [events, receipts, delivery, integrations] = await Promise.all([
        this.#client.events(repositoryId, runId),
        this.#client.receipts(repositoryId, runId),
        this.#client.delivery(repositoryId, runId),
        this.#client.integrations(repositoryId, runId),
      ]);
      if (!this.#isCurrentAssembly(repositoryId, runId, route)) return false;
      this.#dispatch({ type: "cache", cache: "events", key, value: events });
      this.#dispatch({ type: "cache", cache: "receipts", key, value: receipts });
      this.#dispatch({ type: "cache", cache: "delivery", key, value: delivery });
      this.#dispatch({ type: "cache", cache: "integrations", key, value: integrations });
    }
    switch (route) {
      case "record":
        return true;
      case "workflow": {
        const summary = await this.#client.graph(repositoryId, runId);
        if (!this.#isCurrentAssembly(repositoryId, runId, route)) return false;
        if (summary.graphRevision !== overview.sync.graphRevision)
          throw new Error("Graph summary revision changed during assembly");
        const [nodes, edges, workspaces, questions] = await Promise.all([
          this.#client.graphNodes(repositoryId, runId, summary.graphRevision),
          this.#client.graphEdges(repositoryId, runId, summary.graphRevision),
          this.#client.workspaces(repositoryId, runId),
          // A need renders on the node it blocks, so the question behind it has
          // to be here rather than on a tab of its own.
          this.#client.questions(repositoryId, runId),
        ]);
        if (!this.#isCurrentAssembly(repositoryId, runId, route)) return false;
        if (
          nodes.graphRevision !== summary.graphRevision ||
          edges.graphRevision !== summary.graphRevision
        )
          throw new Error("Graph pages do not share one revision");
        const revision = revisionKey(repositoryId, runId, summary.graphRevision);
        this.#dispatch({ type: "cache", cache: "graphSummaries", key, value: summary });
        this.#dispatch({ type: "cache", cache: "graphNodes", key: revision, value: nodes });
        this.#dispatch({ type: "cache", cache: "graphEdges", key: revision, value: edges });
        this.#dispatch({ type: "cache", cache: "workspaces", key, value: workspaces });
        this.#dispatch({ type: "cache", cache: "questions", key, value: questions });
        // The transcript names its lines by agent, but a name is a nicety and
        // this view is how a person answers a blocked agent. Letting it fail the
        // assembly would take every command offline to spare a label.
        void this.#client
          .agents(repositoryId, runId)
          .then((agents) => {
            if (this.#isCurrentAssembly(repositoryId, runId, route))
              this.#dispatch({ type: "cache", cache: "agents", key, value: agents });
          })
          .catch(() => undefined);
        void this.#syncTranscript();
        return true;
      }
      case "artifacts": {
        const artifacts = await this.#client.artifacts(repositoryId, runId);
        if (!this.#isCurrentAssembly(repositoryId, runId, route)) return false;
        this.#dispatch({
          type: "cache",
          cache: "artifacts",
          key,
          value: artifacts,
        });
        return true;
      }
      case "agents": {
        const agents = await this.#client.agents(repositoryId, runId);
        if (!this.#isCurrentAssembly(repositoryId, runId, route)) return false;
        this.#dispatch({ type: "cache", cache: "agents", key, value: agents });
        return true;
      }
    }
  }

  #isCurrentAssembly(repositoryId: string, runId: string, route: string): boolean {
    return (
      this.#state.selectedRepositoryId === repositoryId &&
      this.#state.selectedRunId === runId &&
      this.#state.route.name === route &&
      this.#state.session.status !== "expired" &&
      this.#state.session.status !== "invalid"
    );
  }

  #ensureStream(repositoryId: string, runId: string, cursor: number): void {
    const identity = runKey(repositoryId, runId);
    if (this.#streamIdentity === identity) return;
    this.#streamIdentity = identity;
    this.#dispatch({ type: "connection", status: "connecting" });
    this.#stream.open(repositoryId, runId, cursor);
  }

  async #resynchronizeGap(message: string): Promise<void> {
    this.#dispatch({ type: "gap", message });
    this.#dispatch({
      type: "connection",
      status: "resyncing",
      message: "Reloading all selected run authority",
    });
    this.#streamIdentity = undefined;
    await this.#loadConsistent();
  }

  #coalesceRefetch(): void {
    if (this.#refetchFrame !== undefined) return;
    this.#refetchFrame = requestAnimationFrame(() => {
      this.#refetchFrame = undefined;
      void this.#loadAfterCurrent();
    });
  }

  async #loadAfterCurrent(): Promise<boolean> {
    const active = this.#consistentLoad;
    if (active !== undefined) {
      await active;
      if (this.#consistentLoad === active) {
        this.#consistentLoad = undefined;
        this.#consistentLoadIdentity = undefined;
      }
    }
    return this.#loadConsistent();
  }

  #startPolling(): void {
    if (this.#poll !== undefined) window.clearInterval(this.#poll);
    this.#poll = window.setInterval(() => {
      if (!document.hidden) void this.#loadConsistent();
    }, POLL_INTERVAL_MS);
  }

  async #openNeed(need: PortalHumanNeed, triggerId: string): Promise<void> {
    const identity = this.#selectedIdentity();
    if (identity === undefined) return;
    const kind = dialogKindForNeed(need);
    if (kind === undefined) return;
    this.#dialogNeed = need;
    const answerDraft = this.#answerDraft(need, kind);
    this.#dispatch({
      type: "dialog-open",
      dialog: {
        kind,
        title: need.title,
        triggerId,
        verified: false,
        loading: true,
        ...answerDraft,
      },
    });
    try {
      const source = await this.#loadReviewSource(
        identity.repositoryId,
        identity.runId,
        need,
        kind,
      );
      if (
        this.#state.ui.dialog?.triggerId !== triggerId ||
        this.#dialogNeed?.needId !== need.needId
      ) {
        return;
      }
      const verified = verifyReviewSource(need, kind, source, this.#selectedOverview());
      this.#dispatch({
        type: "dialog-update",
        dialog: {
          kind,
          title: need.title,
          triggerId,
          verified,
          loading: false,
          source,
          ...answerDraft,
          ...(verified
            ? {}
            : {
                message:
                  kind === "allowance"
                    ? "The exact allowance projection is stale or incomplete. Refresh before acting."
                    : "Referenced digest or revision did not verify. Refresh before acting.",
              }),
        },
      });
    } catch (error) {
      if (
        this.#state.ui.dialog?.triggerId !== triggerId ||
        this.#dialogNeed?.needId !== need.needId
      ) {
        return;
      }
      this.#dispatch({
        type: "dialog-update",
        dialog: {
          kind,
          title: need.title,
          triggerId,
          verified: false,
          loading: false,
          ...answerDraft,
          message: safeMessage(error, "Exact review source could not be loaded"),
        },
      });
    }
  }

  #answerDraft(need: PortalHumanNeed, kind: DialogKind): { readonly answerDraft?: string } {
    if (kind !== "answer") return {};
    const draftIdentity = this.#answerDraftIdentity(need);
    if (draftIdentity === undefined) return {};
    const draft = readAnswerDraft(sessionStorage, draftIdentity);
    return draft === undefined ? {} : { answerDraft: draft };
  }

  async #loadReviewSource(
    repositoryId: string,
    runId: string,
    need: PortalHumanNeed,
    kind: DialogKind,
  ): Promise<unknown> {
    if (kind === "answer") {
      const question = await this.#client.question(repositoryId, runId, need.sourceId);
      return decodeCanonicalJsonValue({ need, question });
    }
    if (kind === "approval") {
      const candidate = await this.#client.record(
        repositoryId,
        runId,
        "candidate",
        need.sourceDigest,
      );
      const gateDigest = firstString(candidate.body, ["gateEvidenceDigest", "gateDigest"]);
      const gate =
        gateDigest === undefined
          ? undefined
          : await this.#client.record(repositoryId, runId, "gate", gateDigest);
      return decodeCanonicalJsonValue({ need, candidate, ...(gate === undefined ? {} : { gate }) });
    }
    if (kind === "amendment") {
      const [amendment, source] = await Promise.all([
        this.#client.amendment(repositoryId, runId, need.sourceId),
        this.#client.amendmentSource(repositoryId, runId, need.sourceId),
      ]);
      return decodeCanonicalJsonValue({ need, amendment, source });
    }
    if (kind === "allowance") {
      return this.#client.allowanceReview(repositoryId, runId, need.sourceId);
    }
    throw new Error("Unsupported review source");
  }

  #openRunControl(kind: "pause" | "resume" | "end", triggerId: string): void {
    const overview = this.#selectedOverview();
    if (overview === undefined) return;
    this.#dialogNeed = undefined;
    this.#dispatch({
      type: "dialog-open",
      dialog: {
        kind,
        title:
          kind === "end" ? "End this run" : `${kind === "pause" ? "Pause" : "Resume"} this run`,
        triggerId,
        verified: true,
        loading: false,
        source: decodeCanonicalJsonValue({
          repositoryId: overview.repositoryId,
          runId: overview.runId,
          mode: overview.mode,
          runModeRevision: overview.runModeRevision,
          counts: overview.counts,
          graphRevision: overview.sync.graphRevision,
        }),
      },
    });
  }

  #openAgentAction(kind: "steer" | "override", agent: PortalAgentSummary, triggerId: string): void {
    this.#dialogNeed = undefined;
    this.#dispatch({
      type: "dialog-open",
      dialog: {
        kind,
        title:
          kind === "steer"
            ? `Redirect ${agent.persona}`
            : `Accept ${agent.persona}'s unfinished work`,
        triggerId,
        verified: true,
        loading: false,
        source: decodeCanonicalJsonValue({
          dispatchId: agent.dispatchId,
          taskId: agent.taskId,
          persona: agent.persona,
        }),
      },
    });
  }

  #closeDialog(): void {
    const triggerId = this.#state.ui.dialog?.triggerId;
    this.#dialogNeed = undefined;
    this.#dispatch({ type: "dialog-close" });
    if (triggerId !== undefined)
      requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
  }

  async #submitDialog(kind: DialogKind, values: Readonly<Record<string, string>>): Promise<void> {
    const dialog = this.#state.ui.dialog;
    const identity = this.#selectedIdentity();
    const overview = this.#selectedOverview();
    if (
      dialog === undefined ||
      !dialog.verified ||
      identity === undefined ||
      overview === undefined
    )
      return;
    try {
      const draft = commandDraft(
        kind,
        values,
        identity.repositoryId,
        identity.runId,
        overview,
        this.#dialogNeed,
        dialog.source,
      );
      const pending = await createPendingSubmission(draft);
      this.#dispatch({ type: "pending-add", pending });
      this.#closeDialog();
      try {
        await this.#client.postCanonicalSubmission(pending.canonicalSubmission);
      } catch (error) {
        if (error instanceof PortalTransportError && error.status === 401) return;
      }
      await this.#recoverPending(pending, true);
    } catch (error) {
      this.#dispatch({
        type: "dialog-update",
        dialog: {
          ...dialog,
          loading: false,
          message: safeMessage(error, "Command could not be constructed"),
        },
      });
    }
  }

  async #recoverAllPending(canRetry: boolean): Promise<void> {
    for (const pending of Object.values(this.#state.pending))
      await this.#recoverPending(pending, canRetry);
  }

  async #recoverPending(pending: PendingCanonicalSubmission, canRetry: boolean): Promise<void> {
    try {
      const current = this.#state.pending[pending.commandId];
      if (current === undefined) return;
      const receipt = await this.#client.receipt(pending.commandId);
      const decision = pendingRecoveryDecision(current, receipt);
      if (decision.type === "terminal") {
        this.#dispatch({ type: "pending-receipt", receipt: decision.receipt });
        this.#dispatch({ type: "pending-clear", commandId: pending.commandId });
        await this.#loadConsistent();
        return;
      }
      if (decision.type === "wait") {
        this.#dispatch({ type: "pending-receipt", receipt: decision.receipt });
        window.setTimeout(() => void this.#recoverPending(pending, canRetry), RECEIPT_POLL_MS);
        return;
      }
      if (decision.type === "retry-exact" && canRetry) {
        this.#dispatch({ type: "pending-retry", commandId: pending.commandId });
        await this.#client.postCanonicalSubmission(decision.canonicalSubmission);
        window.setTimeout(() => void this.#recoverPending(pending, canRetry), RECEIPT_POLL_MS);
      }
    } catch (error) {
      if (this.#state.session.status !== "expired") {
        this.#dispatch({
          type: "connection",
          status: "offline",
          message: safeMessage(error, "Receipt recovery is waiting"),
        });
        window.setTimeout(() => void this.#recoverPending(pending, canRetry), RECEIPT_POLL_MS);
      }
    }
  }

  async #loadArtifact(artifactId: string): Promise<void> {
    const identity = this.#selectedIdentity();
    if (identity === undefined) return;
    try {
      const content = await this.#client.artifactContent(
        identity.repositoryId,
        identity.runId,
        artifactId,
      );
      this.#dispatch({
        type: "cache",
        cache: "artifactContent",
        key: artifactContentKey(identity.repositoryId, identity.runId, artifactId),
        value: content,
      });
    } catch (error) {
      this.#dispatch({
        type: "freshness",
        resource: "artifacts",
        freshness: { status: "failed", message: safeMessage(error, "Artifact preview failed") },
      });
    }
  }

  async #pageActivity(kind: "events" | "receipts", before: number): Promise<void> {
    const identity = this.#selectedIdentity();
    if (identity === undefined) return;
    const key = runKey(identity.repositoryId, identity.runId);
    const value =
      kind === "events"
        ? await this.#client.events(identity.repositoryId, identity.runId, before)
        : await this.#client.receipts(identity.repositoryId, identity.runId, before);
    this.#dispatch({ type: "cache", cache: kind, key, value });
  }

  /**
   * Derives the transcript owner from the selected node. The node's own current
   * dispatch wins because capture writes worker lines under the dispatch, and it
   * is the only owner that exists in the default repository mode where no
   * workspace row is ever created.
   */
  #transcriptOwner(): PortalTranscriptOwner | undefined {
    const identity = this.#selectedIdentity();
    if (identity === undefined || this.#state.route.name !== "workflow") return undefined;
    if (this.#state.ui.transcriptScope === "run")
      return Object.freeze({ kind: "run", id: identity.runId });
    const revision = this.#state.vector?.graphRevision;
    if (revision === undefined) return undefined;
    const node = this.#state.caches.graphNodes[
      revisionKey(identity.repositoryId, identity.runId, revision)
    ]?.nodes.find(({ nodeId }) => nodeId === this.#state.ui.focusedRecord);
    if (node === undefined) return undefined;
    const workspaces =
      this.#state.caches.workspaces[runKey(identity.repositoryId, identity.runId)]?.workspaces ??
      [];
    const workspaceDispatchId = workspaces
      .filter(
        (workspace) =>
          workspace.taskId === node.nodeId &&
          workspace.definitionGeneration === node.definitionGeneration,
      )
      .map(({ dispatchId: value }) => value)
      .sort()
      .at(-1);
    return transcriptOwnerForNode(node, workspaceDispatchId);
  }

  #syncTranscript(): Promise<void> {
    if (this.#transcriptSync !== undefined) {
      this.#transcriptQueued = true;
      return this.#transcriptSync;
    }
    const sync = this.#performTranscriptSync().finally(() => {
      this.#transcriptSync = undefined;
      if (!this.#transcriptQueued) return;
      this.#transcriptQueued = false;
      void this.#syncTranscript();
    });
    this.#transcriptSync = sync;
    return sync;
  }

  async #performTranscriptSync(): Promise<void> {
    const identity = this.#selectedIdentity();
    if (identity === undefined) return;
    const owner = this.#transcriptOwner();
    if (!sameTranscriptOwner(this.#state.ui.transcript.owner, owner))
      this.#dispatch({ type: "transcript-owner", owner });
    if (owner === undefined) return;
    const route = this.#state.route.name;
    try {
      for (let fetched = 0; fetched < TRANSCRIPT_MAX_PAGES; fetched += 1) {
        const page = await this.#client.transcript(
          identity.repositoryId,
          identity.runId,
          owner,
          this.#state.ui.transcript.nextAfter,
        );
        if (
          !this.#isCurrentAssembly(identity.repositoryId, identity.runId, route) ||
          !sameTranscriptOwner(this.#state.ui.transcript.owner, owner)
        ) {
          return;
        }
        this.#dispatch({ type: "transcript-page", page });
        if (!page.hasMore) return;
      }
    } catch (error) {
      if (
        this.#sessionExpired() ||
        !this.#isCurrentAssembly(identity.repositoryId, identity.runId, route)
      ) {
        return;
      }
      this.#dispatch({
        type: "freshness",
        resource: route,
        freshness: { status: "failed", message: safeMessage(error, "Agent output load failed") },
      });
    }
  }

  #actions(): PortalRenderActions {
    return {
      navigate: (route) => {
        const identity = this.#selectedIdentity();
        if (identity !== undefined)
          location.hash = portalHash(identity.repositoryId, identity.runId, route);
      },
      selectRun: (repositoryId, runId) => void this.#selectRun(repositoryId, runId, true),
      setFilter: (value) => this.#dispatch({ type: "filter", value }),
      setGraphMode: (mode) => this.#dispatch({ type: "graph-mode", mode }),
      setGraphViewport: (viewport) => this.#dispatch({ type: "graph-viewport", viewport }),
      focusRecord: (recordId) => {
        this.#dispatch({ type: "focus-record", recordId });
        void this.#syncTranscript();
      },
      openNeed: (need, triggerId) => void this.#openNeed(need, triggerId),
      openRunControl: (kind, triggerId) => this.#openRunControl(kind, triggerId),
      openAgentAction: (kind, agent, triggerId) => this.#openAgentAction(kind, agent, triggerId),
      closeDialog: () => this.#closeDialog(),
      submitDialog: (kind, values) => void this.#submitDialog(kind, values),
      loadArtifact: (artifact) => void this.#loadArtifact(artifact.artifactId),
      pageActivity: (kind, before) => void this.#pageActivity(kind, before),
      toggleRightRail: (open) => this.#dispatch({ type: "right-rail", open }),
      setTranscriptPinned: (pinned) => this.#dispatch({ type: "transcript-pin", pinned }),
      setTranscriptScope: (scope) => {
        this.#dispatch({ type: "transcript-scope", scope });
        void this.#syncTranscript();
      },
      setRailLayout: (layout) => {
        this.#dispatch({ type: "rail-layout", layout });
        saveRailLayout(localStorage, this.#state.ui.railLayout);
      },
      setRailCollapsed: (side, collapsed) => {
        this.#dispatch({ type: "rail-collapse", side, collapsed });
        saveRailLayout(localStorage, this.#state.ui.railLayout);
      },
      openAssetOverlay: (artifactId, triggerId) =>
        this.#dispatch({ type: "asset-overlay-open", artifactId, triggerId }),
      closeAssetOverlay: () => this.#closeAssetOverlay(),
      saveAnswerDraft: (value) => this.#saveAnswerDraft(value),
    };
  }

  #closeAssetOverlay(): void {
    const triggerId = this.#state.ui.assetOverlay?.triggerId;
    this.#dispatch({ type: "asset-overlay-close" });
    if (triggerId !== undefined)
      requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
  }

  #answerDraftIdentity(need: PortalHumanNeed | undefined): string | undefined {
    const identity = this.#selectedIdentity();
    if (identity === undefined || need === undefined || need.kind !== "question") return undefined;
    return answerDraftIdentity(identity.repositoryId, identity.runId, need);
  }

  #saveAnswerDraft(value: string): void {
    const draftIdentity = this.#answerDraftIdentity(this.#dialogNeed);
    if (draftIdentity === undefined) return;
    writeAnswerDraft(sessionStorage, draftIdentity, value);
  }

  /** Drops drafts for questions that were answered, superseded, or replaced by a new digest. */
  #pruneAnswerDrafts(): void {
    const identity = this.#selectedIdentity();
    if (identity === undefined) return;
    pruneAnswerDrafts(
      sessionStorage,
      this.#state.humanNeeds
        .filter((need) => need.kind === "question")
        .map((need) => answerDraftIdentity(identity.repositoryId, identity.runId, need)),
    );
  }

  /** Leaving a run drops only that run's drafts; other runs keep theirs. */
  #dropDepartedRunDrafts(): void {
    const departed = this.#selectedIdentity();
    if (departed === undefined) return;
    dropRunAnswerDrafts(sessionStorage, departed.repositoryId, departed.runId);
  }

  #syncQuestionTick(): void {
    const pending = pendingQuestionNeed(this.#state.humanNeeds) !== undefined;
    if (!pending) {
      if (this.#questionTick !== undefined) window.clearInterval(this.#questionTick);
      this.#questionTick = undefined;
      return;
    }
    if (this.#questionTick !== undefined) return;
    this.#questionTick = window.setInterval(
      () => refreshQuestionAttention(this.#root, this.#state),
      QUESTION_TICK_MS,
    );
  }

  #dispatch(action: PortalAction): void {
    this.#state = portalReducer(this.#state, action);
    if (action.type.startsWith("pending-")) savePending(sessionStorage, this.#state.pending);
    if (action.type === "human-needs") this.#pruneAnswerDrafts();
    this.#render();
  }

  #render(): void {
    renderPortal(this.#root, this.#state, this.#actions());
    this.#syncQuestionTick();
  }

  #expireSession(): void {
    this.#stream.close();
    this.#streamIdentity = undefined;
    clearPortalSession(sessionStorage);
    clearAnswerDrafts(sessionStorage);
    this.#client.setCsrfToken(undefined);
    this.#dispatch({
      type: "session-expired",
      message:
        "Open a new portal bootstrap from the Senawa CLI. No mutation was retried under another session.",
    });
  }

  #selectedIdentity(): { readonly repositoryId: string; readonly runId: string } | undefined {
    return this.#state.selectedRepositoryId === undefined || this.#state.selectedRunId === undefined
      ? undefined
      : { repositoryId: this.#state.selectedRepositoryId, runId: this.#state.selectedRunId };
  }

  #selectedOverview(): PortalRunOverview | undefined {
    const identity = this.#selectedIdentity();
    return identity === undefined
      ? undefined
      : this.#state.caches.overviews[runKey(identity.repositoryId, identity.runId)];
  }

  #sessionExpired(): boolean {
    return this.#state.session.status === "expired";
  }
}

class BrowserEventSource {
  readonly #source: EventSource;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { readonly data: string }) => void) | null = null;

  constructor(url: string) {
    this.#source = new EventSource(url);
    this.#source.onopen = () => this.onopen?.();
    this.#source.onerror = () => this.onerror?.();
    this.#source.onmessage = (event) => this.onmessage?.({ data: String(event.data) });
  }

  addEventListener(type: string, listener: (event: { readonly data: string }) => void): void {
    this.#source.addEventListener(type, (event) => {
      if (event instanceof MessageEvent) listener({ data: String(event.data) });
    });
  }

  close(): void {
    this.#source.close();
  }
}

function dialogKindForNeed(need: PortalHumanNeed): DialogKind | undefined {
  if (need.kind === "question") return "answer";
  if (need.kind === "candidate-approval") return "approval";
  if (need.kind === "amendment-decision") return "amendment";
  if (need.kind === "escalation") return "allowance";
  return undefined;
}

function verifyReviewSource(
  need: PortalHumanNeed,
  kind: DialogKind,
  source: unknown,
  overview: PortalRunOverview | undefined,
): boolean {
  if (kind === "answer") {
    return (
      firstString(source, ["questionDigest"]) === need.sourceDigest &&
      firstString(source, ["submissionId"]) === need.sourceId
    );
  }
  if (kind === "allowance") {
    return overview !== undefined && allowanceReviewIsCurrent(need, source, overview);
  }
  if (kind === "approval") {
    if (firstString(source, ["digest"]) !== need.sourceDigest) return false;
    return true;
  }
  if (kind === "amendment") {
    return (
      firstString(source, ["proposalDigest"]) === need.sourceDigest &&
      firstString(source, ["amendmentId"]) === need.sourceId
    );
  }
  return false;
}

function commandDraft(
  kind: DialogKind,
  values: Readonly<Record<string, string>>,
  repositoryId: string,
  runId: string,
  overview: PortalRunOverview,
  need: PortalHumanNeed | undefined,
  source: unknown,
): CommandDraft {
  if (kind === "pause" || kind === "resume" || kind === "end") {
    const reviewedRunModeRevision = firstNumber(source, ["runModeRevision"]);
    if (reviewedRunModeRevision === undefined) {
      throw new Error("Exact reviewed run mode revision is unavailable");
    }
    return {
      repositoryId,
      runId,
      intent: kind === "pause" ? "pause-run" : kind === "resume" ? "resume-run" : "end-run",
      payload: { expectedRunModeRevision: reviewedRunModeRevision },
      expectedGraphRevision: overview.sync.graphRevision,
    };
  }
  if (kind === "steer" || kind === "override") {
    const dispatchId = firstString(source, ["dispatchId"]);
    const taskId = firstString(source, ["taskId"]);
    if (dispatchId === undefined || taskId === undefined)
      throw new Error("An exact dispatch is required");
    if (kind === "steer") {
      if (values.instruction === undefined || values.instruction.length === 0)
        throw new Error("A steering must carry text");
      return {
        repositoryId,
        runId,
        intent: "steer-agent",
        payload: {
          dispatchId,
          contextDigest: firstString(source, ["contextDigest"]) ?? "",
          taskId,
          definitionGeneration: 1,
          delivery: values.delivery ?? "queued",
          instruction: values.instruction,
        },
      };
    }
    if (values.reason === undefined || values.reason.length === 0)
      throw new Error("An override must say why the work was accepted");
    return {
      repositoryId,
      runId,
      intent: "override-member",
      payload: { dispatchId, taskId, definitionGeneration: 1, reason: values.reason },
    };
  }
  if (need === undefined || source === undefined)
    throw new Error("Exact human need source is unavailable");
  if (kind === "answer") {
    const question = objectAt(source, "question") as unknown as PortalQuestionRecord | undefined;
    if (question === undefined || values.answer === undefined || values.answer.length === 0)
      throw new Error("An exact question and non-empty answer are required");
    return {
      repositoryId,
      runId,
      intent: "answer-question",
      payload: {
        submissionId: question.source.submissionId,
        questionDigest: question.source.questionDigest,
        contextDigest: question.source.contextDigest,
        taskId: question.source.taskId,
        definitionGeneration: question.source.definitionGeneration,
        answer: parseAnswer(values.answer),
      },
      expectedDefinitionRevision: question.source.contextRevisionDigest,
      ...(need.expectedGraphRevision === undefined
        ? {}
        : { expectedGraphRevision: need.expectedGraphRevision }),
      exactObjectDigest: need.exactObjectDigest ?? need.sourceDigest,
    };
  }
  if (kind === "approval") {
    if (values.decision !== "approve" && values.decision !== "reject")
      throw new Error("Approval decision is required");
    return {
      repositoryId,
      runId,
      intent: "record-authority-decision",
      payload: { decision: values.decision },
      expectedGraphRevision: need.expectedGraphRevision ?? overview.sync.graphRevision,
      exactObjectDigest: need.exactObjectDigest ?? need.sourceDigest,
    };
  }
  if (kind === "amendment") {
    if (values.decision !== "approve" && values.decision !== "reject")
      throw new Error("Amendment decision is required");
    const reviewed = reviewedResultGraphRevision(source);
    return {
      repositoryId,
      runId,
      intent: "record-amendment-decision",
      payload: {
        amendmentId: need.sourceId,
        proposalDigest: need.sourceDigest,
        decision: values.decision,
        reviewedResultGraphRevisionDigest: reviewed,
      },
      expectedGraphRevision: need.expectedGraphRevision ?? overview.sync.graphRevision,
      exactObjectDigest: need.exactObjectDigest ?? need.sourceDigest,
    };
  }
  if (kind === "allowance") {
    return allowanceCommandDraft(need, source, overview, values.increaseBy);
  }
  throw new Error("Unsupported reviewed command");
}

function parseAnswer(value: string): JsonValue {
  try {
    return decodeCanonicalJsonValue(JSON.parse(value));
  } catch {
    return value;
  }
}

function objectAt(value: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = (value as Readonly<Record<string, unknown>>)[key];
  return child !== null && typeof child === "object" && !Array.isArray(child)
    ? (child as Readonly<Record<string, unknown>>)
    : undefined;
}

function firstString(value: unknown, keys: readonly string[]): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstString(child, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = value as Readonly<Record<string, unknown>>;
  for (const key of keys) if (typeof object[key] === "string") return object[key];
  for (const child of Object.values(object)) {
    const found = firstString(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstNumber(value: unknown, keys: readonly string[]): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstNumber(child, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = value as Readonly<Record<string, unknown>>;
  for (const key of keys) if (typeof object[key] === "number") return object[key];
  for (const child of Object.values(object)) {
    const found = firstNumber(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function requiredString(value: unknown, keys: readonly string[], subject: string): string {
  const result = firstString(value, keys);
  if (result === undefined) throw new Error(`Exact ${subject} is unavailable`);
  return result;
}

function reviewedResultGraphRevision(value: unknown): string {
  const direct = firstString(value, ["reviewedResultGraphRevisionDigest"]);
  if (direct !== undefined) return direct;
  const reviewedGraph = findObject(value, "reviewedResultGraph");
  return requiredString(reviewedGraph, ["revisionDigest"], "reviewed result graph revision");
}

function findObject(value: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findObject(child, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = value as Readonly<Record<string, unknown>>;
  const direct = object[key];
  if (direct !== null && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Readonly<Record<string, unknown>>;
  }
  for (const child of Object.values(object)) {
    const found = findObject(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof PortalTransportError || error instanceof Error ? error.message : fallback;
}
