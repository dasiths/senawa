import { describe, expect, it } from "vitest";
import {
  answerDraftIdentity,
  answerDraftRunPrefix,
  answerDraftStorageKey,
  clearAnswerDrafts,
  loadAnswerDrafts,
  MAX_ANSWER_DRAFT_LENGTH,
  MAX_ANSWER_DRAFTS,
  pruneAnswerDrafts,
  readAnswerDraft,
  writeAnswerDraft,
} from "./answer-draft.js";
import type { SessionStorageLike } from "./pending.js";

class MemoryStorage implements SessionStorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const question = { sourceId: "submission_one", sourceDigest: "digest_one" };

describe("answer draft persistence", () => {
  it("keys a draft by repository, run, question, and digest", () => {
    const identity = answerDraftIdentity("repository_one", "run_one", question);
    expect(identity).toBe("repository_one\u0000run_one\u0000submission_one\u0000digest_one");
    expect(answerDraftIdentity("repository_one", "run_two", question)).not.toBe(identity);
    expect(
      answerDraftIdentity("repository_one", "run_one", { ...question, sourceDigest: "other" }),
    ).not.toBe(identity);
  });

  it("restores a draft and clears it when the value empties", () => {
    const storage = new MemoryStorage();
    const identity = answerDraftIdentity("repository_one", "run_one", question);
    writeAnswerDraft(storage, identity, "staging");
    expect(readAnswerDraft(storage, identity)).toBe("staging");
    writeAnswerDraft(storage, identity, "");
    expect(readAnswerDraft(storage, identity)).toBeUndefined();
    expect(storage.getItem(answerDraftStorageKey())).toBeNull();
  });

  it("drops every persisted draft, not only the current question", () => {
    const storage = new MemoryStorage();
    writeAnswerDraft(storage, answerDraftIdentity("repository_one", "run_one", question), "one");
    writeAnswerDraft(storage, answerDraftIdentity("repository_one", "run_two", question), "two");
    clearAnswerDrafts(storage);
    expect(storage.getItem(answerDraftStorageKey())).toBeNull();
    expect(loadAnswerDrafts(storage).size).toBe(0);
  });

  it("bounds one draft body and the retained draft count", () => {
    const storage = new MemoryStorage();
    const identity = answerDraftIdentity("repository_one", "run_one", question);
    writeAnswerDraft(storage, identity, "x".repeat(MAX_ANSWER_DRAFT_LENGTH + 512));
    expect(readAnswerDraft(storage, identity)?.length).toBe(MAX_ANSWER_DRAFT_LENGTH);
    for (let index = 0; index < MAX_ANSWER_DRAFTS + 4; index += 1) {
      writeAnswerDraft(
        storage,
        answerDraftIdentity("repository_one", "run_one", {
          sourceId: `submission_${index}`,
          sourceDigest: "digest",
        }),
        `answer ${index}`,
      );
    }
    expect(loadAnswerDrafts(storage).size).toBe(MAX_ANSWER_DRAFTS);
  });

  it("prunes every draft whose question is no longer open", () => {
    const storage = new MemoryStorage();
    const open = answerDraftIdentity("repository_one", "run_one", question);
    const stale = answerDraftIdentity("repository_one", "run_one", {
      ...question,
      sourceDigest: "superseded",
    });
    const otherRun = answerDraftIdentity("repository_one", "run_two", question);
    writeAnswerDraft(storage, open, "keep");
    writeAnswerDraft(storage, stale, "drop");
    writeAnswerDraft(storage, otherRun, "drop");
    pruneAnswerDrafts(storage, [open]);
    expect([...loadAnswerDrafts(storage).keys()]).toEqual([open]);
    pruneAnswerDrafts(storage, []);
    expect(storage.getItem(answerDraftStorageKey())).toBeNull();
  });

  it("drops only the departed run's drafts when the selected run changes", () => {
    const storage = new MemoryStorage();
    const departed = answerDraftIdentity("repository_one", "run_one", question);
    const departedOther = answerDraftIdentity("repository_one", "run_one", {
      ...question,
      sourceId: "submission_two",
    });
    const retained = answerDraftIdentity("repository_one", "run_two", question);
    const otherRepository = answerDraftIdentity("repository_two", "run_one", question);
    writeAnswerDraft(storage, departed, "drop");
    writeAnswerDraft(storage, departedOther, "drop");
    writeAnswerDraft(storage, retained, "keep");
    writeAnswerDraft(storage, otherRepository, "keep");

    const prefix = answerDraftRunPrefix("repository_one", "run_one");
    pruneAnswerDrafts(
      storage,
      [...loadAnswerDrafts(storage).keys()].filter((identity) => !identity.startsWith(prefix)),
    );

    expect([...loadAnswerDrafts(storage).keys()].toSorted()).toEqual(
      [retained, otherRepository].toSorted(),
    );
  });

  it("discards a hostile or oversized persisted record", () => {
    const storage = new MemoryStorage();
    storage.setItem(answerDraftStorageKey(), "not json");
    expect(loadAnswerDrafts(storage).size).toBe(0);
    expect(storage.getItem(answerDraftStorageKey())).toBeNull();

    storage.setItem(answerDraftStorageKey(), JSON.stringify({ identity: 12 }));
    expect(loadAnswerDrafts(storage).size).toBe(0);

    storage.setItem(
      answerDraftStorageKey(),
      JSON.stringify({ identity: "x".repeat(MAX_ANSWER_DRAFT_LENGTH + 1) }),
    );
    expect(loadAnswerDrafts(storage).size).toBe(0);

    storage.setItem(answerDraftStorageKey(), JSON.stringify(["array"]));
    expect(loadAnswerDrafts(storage).size).toBe(0);
  });
});
