import type {
  DurableReceipt,
  EventStreamFrame,
  PortalAgentPage,
  PortalArtifactContent,
  PortalArtifactPage,
  PortalDeliveryPage,
  PortalEventWindow,
  PortalGraphEdgePage,
  PortalGraphNodePage,
  PortalGraphSummary,
  PortalHumanNeed,
  PortalIntegrationPage,
  PortalQuestionPage,
  PortalReceiptWindow,
  PortalRepositoryPage,
  PortalRunOverview,
  PortalRunPage,
  PortalSessionDescriptor,
  PortalSyncVector,
  PortalTranscriptOwner,
  PortalTranscriptPage,
  PortalWorkspacePage,
} from "@senawa/protocol";
import {
  type CommandNarration,
  narrateCleared,
  narrateReceipt,
  narrateSubmission,
} from "./command-narrator.js";
import {
  collapseRail,
  DEFAULT_RAIL_LAYOUT,
  type RailLayout,
  type RailSide,
} from "./rail-layout.js";
import type { PortalRoute } from "./router.js";
import {
  emptyTranscriptView,
  mergeTranscriptPage,
  selectTranscriptOwner,
  setTranscriptPinned,
  type TranscriptScope,
  type TranscriptView,
} from "./transcript-view-model.js";

export type SessionStatus = "booting" | "read-write" | "read-only" | "expired" | "invalid";
export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "gap"
  | "resyncing"
  | "offline";
export type FreshnessStatus = "empty" | "loading" | "fresh" | "stale" | "failed";

export interface PortalSessionState {
  readonly status: SessionStatus;
  readonly expiresAt?: string;
  readonly capabilities: readonly string[];
  readonly csrfToken?: string;
  readonly message?: string;
}

export interface PortalConnectionState {
  readonly status: ConnectionStatus;
  readonly reconnectAttempt: number;
  readonly message?: string;
}

export interface PendingCanonicalSubmission {
  readonly commandId: string;
  readonly canonicalSubmission: string;
  readonly payloadDigest: string;
  readonly intent: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly storedAt: string;
  readonly exactRetryUsed: boolean;
  readonly receipt?: DurableReceipt;
}

export interface ResourceFreshness {
  readonly status: FreshnessStatus;
  readonly vector?: PortalSyncVector;
  readonly message?: string;
}

export interface PortalCaches {
  readonly repositories?: PortalRepositoryPage;
  readonly runsByRepository: Readonly<Record<string, PortalRunPage>>;
  readonly overviews: Readonly<Record<string, PortalRunOverview>>;
  readonly graphSummaries: Readonly<Record<string, PortalGraphSummary>>;
  readonly graphNodes: Readonly<Record<string, PortalGraphNodePage>>;
  readonly graphEdges: Readonly<Record<string, PortalGraphEdgePage>>;
  readonly events: Readonly<Record<string, PortalEventWindow>>;
  readonly receipts: Readonly<Record<string, PortalReceiptWindow>>;
  readonly artifacts: Readonly<Record<string, PortalArtifactPage>>;
  readonly delivery: Readonly<Record<string, PortalDeliveryPage>>;
  readonly artifactContent: Readonly<Record<string, PortalArtifactContent>>;
  readonly questions: Readonly<Record<string, PortalQuestionPage>>;
  readonly agents: Readonly<Record<string, PortalAgentPage>>;
  readonly workspaces: Readonly<Record<string, PortalWorkspacePage>>;
  readonly integrations: Readonly<Record<string, PortalIntegrationPage>>;
  readonly records: Readonly<Record<string, unknown>>;
  readonly amendments: Readonly<Record<string, unknown>>;
}

export type DialogKind =
  | "answer"
  | "approval"
  | "amendment"
  | "allowance"
  | "pause"
  | "resume"
  | "end"
  | "steer"
  | "override";

export interface PortalDialogState {
  readonly kind: DialogKind;
  readonly title: string;
  readonly triggerId?: string;
  readonly verified: boolean;
  readonly loading: boolean;
  readonly source?: unknown;
  readonly message?: string;
  readonly answerDraft?: string;
}

export type GraphMode = "diagram" | "tree";

export interface PortalGraphViewport {
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
}

export const INITIAL_GRAPH_VIEWPORT: PortalGraphViewport = Object.freeze({
  scale: 1,
  panX: 0,
  panY: 0,
});

export interface PortalReplyState {
  readonly status: "idle" | "sending" | "sent" | "failed";
  readonly message?: string;
}

export const DETAIL_TABS = Object.freeze([
  "live",
  "answers",
  "produced",
  "checks",
  "about",
] as const);
export type DetailTab = (typeof DETAIL_TABS)[number];

export interface PortalAssetOverlayState {
  readonly artifactId: string;
  readonly triggerId: string;
}

export interface PortalUiState {
  readonly dialog: PortalDialogState | undefined;
  readonly filter: string;
  readonly focusedRecord: string | undefined;
  readonly rightRailOpen: boolean;
  readonly graphMode: GraphMode;
  /**
   * Phases a reader opened by hand. A phase folds itself once its work is done,
   * so this records only the decision to disagree, which must outlive a poll.
   */
  readonly unfoldedNodes: readonly string[];
  /** Activity rows a reader opened. Their detail is built only while they are. */
  readonly openedRecords: readonly string[];
  /** Which face of the one detail surface is showing. */
  readonly detailTab: DetailTab;
  /** What the reply box under the transcript is doing. */
  readonly reply: PortalReplyState;
  /** Which open need the reply box is addressed to; nothing means a steering. */
  readonly replyTarget: string | undefined;
  readonly graphViewport: PortalGraphViewport;
  readonly transcript: TranscriptView;
  readonly transcriptScope: TranscriptScope;
  readonly narration: CommandNarration | undefined;
  readonly railLayout: RailLayout;
  readonly assetOverlay: PortalAssetOverlayState | undefined;
}

export interface PortalState {
  readonly session: PortalSessionState;
  readonly connection: PortalConnectionState;
  readonly route: PortalRoute;
  readonly selectedRepositoryId: string | undefined;
  readonly selectedRunId: string | undefined;
  readonly cursor: number;
  readonly vector: PortalSyncVector | undefined;
  readonly freshness: Readonly<Record<string, ResourceFreshness>>;
  readonly caches: PortalCaches;
  readonly pending: Readonly<Record<string, PendingCanonicalSubmission>>;
  readonly humanNeeds: readonly PortalHumanNeed[];
  readonly visibleEvents: readonly EventStreamFrame[];
  readonly ui: PortalUiState;
}

export type PortalAction =
  | {
      readonly type: "session-ready";
      readonly descriptor: PortalSessionDescriptor;
      readonly csrfToken?: string;
    }
  | { readonly type: "session-expired"; readonly message: string }
  | { readonly type: "session-invalid"; readonly message: string }
  | { readonly type: "connection"; readonly status: ConnectionStatus; readonly message?: string }
  | { readonly type: "route"; readonly route: PortalRoute }
  | { readonly type: "select-run"; readonly repositoryId: string; readonly runId: string }
  | { readonly type: "repositories"; readonly page: PortalRepositoryPage }
  | { readonly type: "runs"; readonly repositoryId: string; readonly page: PortalRunPage }
  | { readonly type: "overview"; readonly overview: PortalRunOverview }
  | {
      readonly type: "cache";
      readonly cache: Exclude<
        keyof PortalCaches,
        "repositories" | "runsByRepository" | "overviews"
      >;
      readonly key: string;
      readonly value: unknown;
    }
  | { readonly type: "freshness"; readonly resource: string; readonly freshness: ResourceFreshness }
  | { readonly type: "human-needs"; readonly needs: readonly PortalHumanNeed[] }
  | { readonly type: "event"; readonly event: EventStreamFrame }
  | { readonly type: "gap"; readonly message: string }
  | { readonly type: "resync-complete"; readonly overview: PortalRunOverview }
  | { readonly type: "pending-add"; readonly pending: PendingCanonicalSubmission }
  | { readonly type: "pending-retry"; readonly commandId: string }
  | { readonly type: "pending-receipt"; readonly receipt: DurableReceipt }
  | { readonly type: "pending-clear"; readonly commandId: string }
  | { readonly type: "dialog-open"; readonly dialog: PortalDialogState }
  | { readonly type: "dialog-update"; readonly dialog: PortalDialogState }
  | { readonly type: "dialog-close" }
  | { readonly type: "filter"; readonly value: string }
  | { readonly type: "focus-record"; readonly recordId?: string }
  | { readonly type: "right-rail"; readonly open: boolean }
  | { readonly type: "graph-mode"; readonly mode: GraphMode }
  | { readonly type: "graph-unfold"; readonly nodeId: string }
  | { readonly type: "detail-tab"; readonly tab: DetailTab }
  | { readonly type: "reply-state"; readonly reply: PortalReplyState }
  | { readonly type: "reply-target"; readonly needId: string | undefined }
  | { readonly type: "record-disclosure"; readonly recordKey: string }
  | { readonly type: "graph-viewport"; readonly viewport: PortalGraphViewport }
  | { readonly type: "transcript-owner"; readonly owner: PortalTranscriptOwner | undefined }
  | { readonly type: "transcript-page"; readonly page: PortalTranscriptPage }
  | { readonly type: "transcript-pin"; readonly pinned: boolean }
  | { readonly type: "transcript-scope"; readonly scope: TranscriptScope }
  | { readonly type: "rail-layout"; readonly layout: RailLayout }
  | { readonly type: "rail-collapse"; readonly side: RailSide; readonly collapsed: boolean }
  | { readonly type: "asset-overlay-open"; readonly artifactId: string; readonly triggerId: string }
  | { readonly type: "asset-overlay-close" };

const emptyCaches: PortalCaches = Object.freeze({
  agents: Object.freeze({}),
  runsByRepository: Object.freeze({}),
  overviews: Object.freeze({}),
  graphSummaries: Object.freeze({}),
  graphNodes: Object.freeze({}),
  graphEdges: Object.freeze({}),
  events: Object.freeze({}),
  receipts: Object.freeze({}),
  artifacts: Object.freeze({}),
  delivery: Object.freeze({}),
  artifactContent: Object.freeze({}),
  questions: Object.freeze({}),
  workspaces: Object.freeze({}),
  integrations: Object.freeze({}),
  records: Object.freeze({}),
  amendments: Object.freeze({}),
});

export function initialPortalState(route: PortalRoute): PortalState {
  return Object.freeze({
    session: Object.freeze({ status: "booting", capabilities: Object.freeze([]) }),
    connection: Object.freeze({ status: "connecting", reconnectAttempt: 0 }),
    route,
    selectedRepositoryId: undefined,
    selectedRunId: undefined,
    cursor: 0,
    vector: undefined,
    freshness: Object.freeze({}),
    caches: emptyCaches,
    pending: Object.freeze({}),
    humanNeeds: Object.freeze([]),
    visibleEvents: Object.freeze([]),
    ui: Object.freeze({
      dialog: undefined,
      filter: "",
      focusedRecord: undefined,
      rightRailOpen: false,
      graphMode: "diagram",
      unfoldedNodes: Object.freeze([]),
      detailTab: "live",
      reply: Object.freeze({ status: "idle" }),
      replyTarget: undefined,
      openedRecords: Object.freeze([]),
      graphViewport: INITIAL_GRAPH_VIEWPORT,
      transcript: emptyTranscriptView(),
      transcriptScope: "run",
      narration: undefined,
      railLayout: DEFAULT_RAIL_LAYOUT,
      assetOverlay: undefined,
    }),
  });
}

export function portalReducer(state: PortalState, action: PortalAction): PortalState {
  switch (action.type) {
    case "session-ready":
      return next(state, {
        session: Object.freeze({
          status: action.csrfToken === undefined ? "read-only" : "read-write",
          expiresAt: action.descriptor.expiresAt,
          capabilities: action.descriptor.capabilities,
          ...(action.csrfToken === undefined ? {} : { csrfToken: action.csrfToken }),
        }),
      });
    case "session-expired":
    case "session-invalid":
      return next(state, {
        session: Object.freeze({
          status: action.type === "session-expired" ? "expired" : "invalid",
          capabilities: Object.freeze([]),
          message: action.message,
        }),
        connection: Object.freeze({
          status: "offline",
          reconnectAttempt: 0,
          message: action.message,
        }),
        cursor: 0,
        vector: undefined,
        freshness: Object.freeze({}),
        caches: emptyCaches,
        humanNeeds: Object.freeze([]),
        visibleEvents: Object.freeze([]),
        ui: Object.freeze({
          ...state.ui,
          dialog: undefined,
          assetOverlay: undefined,
          transcript: emptyTranscriptView(),
        }),
      });
    case "connection":
      return next(state, {
        connection: Object.freeze({
          status: action.status,
          reconnectAttempt:
            action.status === "reconnecting" ? state.connection.reconnectAttempt + 1 : 0,
          ...(action.message === undefined ? {} : { message: action.message }),
        }),
      });
    case "route":
      return next(state, {
        route: action.route,
        ui: Object.freeze({
          ...state.ui,
          focusedRecord: undefined,
          assetOverlay: undefined,
          transcript: emptyTranscriptView(),
        }),
      });
    case "select-run":
      return next(state, {
        selectedRepositoryId: action.repositoryId,
        selectedRunId: action.runId,
        cursor: 0,
        vector: undefined,
        freshness: Object.freeze({}),
        humanNeeds: Object.freeze([]),
        visibleEvents: Object.freeze([]),
        ui: Object.freeze({
          ...state.ui,
          dialog: undefined,
          focusedRecord: undefined,
          assetOverlay: undefined,
          graphViewport: INITIAL_GRAPH_VIEWPORT,
          transcript: emptyTranscriptView(),
          // Another run has none of this run's nodes, so a scope narrowed to one
          // of them would follow something that is no longer there.
          transcriptScope: "run" as const,
        }),
      });
    case "repositories":
      return next(state, { caches: Object.freeze({ ...state.caches, repositories: action.page }) });
    case "runs":
      return next(state, {
        caches: Object.freeze({
          ...state.caches,
          runsByRepository: withEntry(
            state.caches.runsByRepository,
            action.repositoryId,
            action.page,
          ),
        }),
      });
    case "overview":
      return next(state, {
        vector: action.overview.sync,
        cursor: Math.max(state.cursor, action.overview.sync.workflowCursor),
        caches: Object.freeze({
          ...state.caches,
          overviews: withEntry(
            state.caches.overviews,
            runKey(action.overview.repositoryId, action.overview.runId),
            action.overview,
          ),
        }),
      });
    case "cache":
      return next(state, {
        caches: Object.freeze({
          ...state.caches,
          [action.cache]: withEntry(state.caches[action.cache], action.key, action.value),
        }),
      });
    case "freshness":
      return next(state, {
        freshness: withEntry(state.freshness, action.resource, action.freshness),
      });
    case "human-needs":
      return next(state, { humanNeeds: Object.freeze([...action.needs]) });
    case "event": {
      if (action.event.cursor <= state.cursor) return state;
      const events = [...state.visibleEvents, action.event].slice(-500);
      return next(state, {
        cursor: action.event.cursor,
        visibleEvents: Object.freeze(events),
        freshness: staleFreshness(state.freshness),
      });
    }
    case "gap":
      return next(state, {
        connection: Object.freeze({ status: "gap", reconnectAttempt: 0, message: action.message }),
        freshness: Object.freeze({}),
        caches: clearRunCaches(state.caches),
        humanNeeds: Object.freeze([]),
        ui: Object.freeze({
          ...state.ui,
          dialog: undefined,
          assetOverlay: undefined,
          transcript: emptyTranscriptView(),
        }),
      });
    case "resync-complete":
      return next(portalReducer(state, { type: "overview", overview: action.overview }), {
        connection: Object.freeze({ status: "connecting", reconnectAttempt: 0 }),
      });
    case "pending-add":
      return next(state, {
        pending: withEntry(state.pending, action.pending.commandId, action.pending),
        ui: Object.freeze({ ...state.ui, narration: narrateSubmission(action.pending) }),
      });
    case "pending-retry": {
      const pending = state.pending[action.commandId];
      if (pending === undefined) return state;
      return next(state, {
        pending: withEntry(
          state.pending,
          action.commandId,
          Object.freeze({ ...pending, exactRetryUsed: true }),
        ),
      });
    }
    case "pending-receipt": {
      const pending = state.pending[action.receipt.commandId];
      if (pending === undefined) return state;
      return next(state, {
        pending: withEntry(
          state.pending,
          action.receipt.commandId,
          Object.freeze({ ...pending, receipt: action.receipt }),
        ),
        ui: Object.freeze({
          ...state.ui,
          narration: narrateReceipt(state.ui.narration, action.receipt),
        }),
      });
    }
    case "pending-clear":
      return next(state, {
        pending: withoutEntry(state.pending, action.commandId),
        ui: Object.freeze({
          ...state.ui,
          narration: narrateCleared(state.ui.narration, action.commandId),
        }),
      });
    case "dialog-open":
    case "dialog-update":
      return next(state, { ui: Object.freeze({ ...state.ui, dialog: action.dialog }) });
    case "dialog-close":
      return next(state, { ui: Object.freeze({ ...state.ui, dialog: undefined }) });
    case "filter":
      return next(state, { ui: Object.freeze({ ...state.ui, filter: action.value }) });
    case "focus-record":
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          focusedRecord: action.recordId,
          transcriptScope: action.recordId === undefined ? "run" : "node",
        }),
      });
    case "right-rail":
      return next(state, { ui: Object.freeze({ ...state.ui, rightRailOpen: action.open }) });
    case "graph-mode":
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          graphMode: action.mode,
          graphViewport: INITIAL_GRAPH_VIEWPORT,
        }),
      });
    case "reply-state":
      return Object.freeze({
        ...state,
        ui: Object.freeze({ ...state.ui, reply: action.reply }),
      });
    case "reply-target":
      return Object.freeze({
        ...state,
        ui: Object.freeze({
          ...state.ui,
          replyTarget: action.needId,
          // A note about the last thing sent says nothing about the next one.
          reply: Object.freeze({ status: "idle" as const }),
        }),
      });
    case "detail-tab":
      return Object.freeze({
        ...state,
        ui: Object.freeze({ ...state.ui, detailTab: action.tab }),
      });
    case "graph-unfold": {
      const open = new Set(state.ui.unfoldedNodes);
      if (!open.delete(action.nodeId)) open.add(action.nodeId);
      return next(state, {
        ui: Object.freeze({ ...state.ui, unfoldedNodes: Object.freeze([...open].sort()) }),
      });
    }
    case "record-disclosure": {
      const open = new Set(state.ui.openedRecords);
      if (!open.delete(action.recordKey)) open.add(action.recordKey);
      return next(state, {
        ui: Object.freeze({ ...state.ui, openedRecords: Object.freeze([...open].sort()) }),
      });
    }
    case "graph-viewport":
      return next(state, { ui: Object.freeze({ ...state.ui, graphViewport: action.viewport }) });
    case "transcript-owner":
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          transcript: selectTranscriptOwner(state.ui.transcript, action.owner),
        }),
      });
    case "transcript-page":
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          transcript: mergeTranscriptPage(state.ui.transcript, action.page),
        }),
      });
    case "transcript-pin":
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          transcript: setTranscriptPinned(state.ui.transcript, action.pinned),
        }),
      });
    case "transcript-scope":
      if (state.ui.transcriptScope === action.scope) return state;
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          transcriptScope: action.scope,
          transcript: emptyTranscriptView(),
        }),
      });
    case "rail-layout":
      return next(state, { ui: Object.freeze({ ...state.ui, railLayout: action.layout }) });
    case "rail-collapse":
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          railLayout: collapseRail(state.ui.railLayout, action.side, action.collapsed),
        }),
      });
    case "asset-overlay-open":
      return next(state, {
        ui: Object.freeze({
          ...state.ui,
          assetOverlay: Object.freeze({
            artifactId: action.artifactId,
            triggerId: action.triggerId,
          }),
        }),
      });
    case "asset-overlay-close":
      return next(state, { ui: Object.freeze({ ...state.ui, assetOverlay: undefined }) });
  }
}

export function runKey(repositoryId: string, runId: string): string {
  return `${repositoryId}/${runId}`;
}

export function artifactContentKey(
  repositoryId: string,
  runId: string,
  artifactId: string,
): string {
  return `${repositoryId}\u0000${runId}\u0000${artifactId}`;
}

export function revisionKey(repositoryId: string, runId: string, revision: string): string {
  return `${runKey(repositoryId, runId)}@${revision}`;
}

function next(state: PortalState, changes: Partial<PortalState>): PortalState {
  return Object.freeze({ ...state, ...changes });
}

function withEntry<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
  value: Value,
): Readonly<Record<string, Value>> {
  return Object.freeze({ ...record, [key]: value });
}

function withoutEntry<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> {
  const result: Record<string, Value> = {};
  for (const [entryKey, value] of Object.entries(record))
    if (entryKey !== key) result[entryKey] = value;
  return Object.freeze(result);
}

function staleFreshness(
  freshness: Readonly<Record<string, ResourceFreshness>>,
): Readonly<Record<string, ResourceFreshness>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(freshness).map(([key, value]) => [
        key,
        value.status === "fresh" ? Object.freeze({ ...value, status: "stale" as const }) : value,
      ]),
    ),
  );
}

function clearRunCaches(caches: PortalCaches): PortalCaches {
  return Object.freeze({
    ...caches,
    overviews: Object.freeze({}),
    graphSummaries: Object.freeze({}),
    graphNodes: Object.freeze({}),
    graphEdges: Object.freeze({}),
    events: Object.freeze({}),
    receipts: Object.freeze({}),
    artifacts: Object.freeze({}),
    artifactContent: Object.freeze({}),
    questions: Object.freeze({}),
    workspaces: Object.freeze({}),
    integrations: Object.freeze({}),
    records: Object.freeze({}),
    amendments: Object.freeze({}),
  });
}
