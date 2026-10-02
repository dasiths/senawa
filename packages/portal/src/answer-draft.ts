import { canonicalStringify, type PortalHumanNeed } from "@senawa/protocol";
import type { SessionStorageLike } from "./pending.js";

const DRAFT_KEY = "senawa.portal.answer-draft.v1";
export const MAX_ANSWER_DRAFT_LENGTH = 8_192;
export const MAX_ANSWER_DRAFTS = 8;
const MAX_IDENTITY_LENGTH = 512;

/**
 * A draft belongs to one question of one run. The run is part of the identity so
 * a draft can never be restored under another run or another question digest.
 */
export function answerDraftIdentity(
  repositoryId: string,
  runId: string,
  need: Pick<PortalHumanNeed, "sourceId" | "sourceDigest">,
): string {
  return [repositoryId, runId, need.sourceId, need.sourceDigest].join("\u0000");
}

/** Identity prefix shared by every draft of one run, used to drop exactly that run. */
function answerDraftRunPrefix(repositoryId: string, runId: string): string {
  return `${repositoryId}\u0000${runId}\u0000`;
}

export function answerDraftStorageKey(): string {
  return DRAFT_KEY;
}

export function readAnswerDraft(storage: SessionStorageLike, identity: string): string | undefined {
  return loadAnswerDrafts(storage).get(identity);
}

export function writeAnswerDraft(
  storage: SessionStorageLike,
  identity: string,
  value: string,
): void {
  if (identity.length === 0 || identity.length > MAX_IDENTITY_LENGTH) return;
  const drafts = new Map(loadAnswerDrafts(storage));
  if (value.length === 0) {
    drafts.delete(identity);
  } else {
    drafts.set(identity, value.slice(0, MAX_ANSWER_DRAFT_LENGTH));
  }
  for (const key of [...drafts.keys()].toSorted()) {
    if (drafts.size <= MAX_ANSWER_DRAFTS) break;
    if (key !== identity) drafts.delete(key);
  }
  persist(storage, drafts);
}

/**
 * Drops drafts of one run whose question is no longer open, which covers
 * accepted and stale answers. Only that run is considered: the open questions
 * of one run say nothing about what another run still has open, and wiping
 * those made `dropRunAnswerDrafts` pointless.
 */
export function pruneAnswerDrafts(
  storage: SessionStorageLike,
  scope: { readonly repositoryId: string; readonly runId: string },
  active: Iterable<string>,
): void {
  const keep = new Set(active);
  const prefix = answerDraftRunPrefix(scope.repositoryId, scope.runId);
  const drafts = loadAnswerDrafts(storage);
  const retained = new Map(
    [...drafts].filter(([identity]) => !identity.startsWith(prefix) || keep.has(identity)),
  );
  if (retained.size === drafts.size) return;
  persist(storage, retained);
}

/** Leaving a run drops exactly that run's drafts; every other run keeps its own. */
export function dropRunAnswerDrafts(
  storage: SessionStorageLike,
  repositoryId: string,
  runId: string,
): void {
  pruneAnswerDrafts(storage, { repositoryId, runId }, []);
}

/** Drops every persisted draft, used when the session or the selected run changes. */
export function clearAnswerDrafts(storage: SessionStorageLike): void {
  storage.removeItem(DRAFT_KEY);
}

export function loadAnswerDrafts(storage: SessionStorageLike): ReadonlyMap<string, string> {
  const serialized = storage.getItem(DRAFT_KEY);
  if (serialized === null) return new Map();
  try {
    const value = JSON.parse(serialized) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("Invalid answer drafts");
    const entries = Object.entries(value as Readonly<Record<string, unknown>>);
    if (entries.length > MAX_ANSWER_DRAFTS) throw new TypeError("Too many answer drafts");
    for (const [identity, draft] of entries) {
      if (identity.length === 0 || identity.length > MAX_IDENTITY_LENGTH)
        throw new TypeError("Invalid answer draft identity");
      if (typeof draft !== "string" || draft.length > MAX_ANSWER_DRAFT_LENGTH)
        throw new TypeError("Invalid answer draft body");
    }
    return new Map(entries as readonly (readonly [string, string])[]);
  } catch {
    storage.removeItem(DRAFT_KEY);
    return new Map();
  }
}

function persist(storage: SessionStorageLike, drafts: ReadonlyMap<string, string>): void {
  if (drafts.size === 0) {
    storage.removeItem(DRAFT_KEY);
    return;
  }
  storage.setItem(DRAFT_KEY, canonicalStringify(Object.fromEntries(drafts)));
}
