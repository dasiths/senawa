import type { PortalHumanNeed } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import {
  attentionTitle,
  elapsedLabel,
  PORTAL_TITLE,
  pendingQuestionNeed,
  QUESTION_OVERDUE_MS,
  questionAttention,
} from "./question-attention.js";

function need(needId: string, kind: PortalHumanNeed["kind"], createdAt: string): PortalHumanNeed {
  return Object.freeze({
    needId,
    kind,
    sourceId: `${needId}-source`,
    sourceDigest: `${needId}-digest`,
    sourceRevision: 1,
    title: `${needId} title`,
    createdAt,
    allowedCommands: Object.freeze(["answer-question"]),
  });
}

const asked = Date.parse("2026-08-15T00:00:00.000Z");

describe("question attention", () => {
  it("selects the oldest unanswered question deterministically", () => {
    const needs = [
      need("need_b", "question", "2026-08-15T00:00:05.000Z"),
      need("need_a", "escalation", "2026-08-15T00:00:00.000Z"),
      need("need_d", "question", "2026-08-15T00:00:01.000Z"),
      need("need_c", "question", "2026-08-15T00:00:01.000Z"),
    ];
    expect(pendingQuestionNeed(needs)?.needId).toBe("need_c");
    expect(pendingQuestionNeed([])).toBeUndefined();
    expect(pendingQuestionNeed([need("need_a", "escalation", "x")])).toBeUndefined();
  });

  it("orders identities by code unit rather than by viewer locale", () => {
    const needs = [
      need("need_ab", "question", "2026-08-15T00:00:00.000Z"),
      need("need_a-c", "question", "2026-08-15T00:00:00.000Z"),
      need("need_a.d", "question", "2026-08-15T00:00:00.000Z"),
      need("need_a:e", "question", "2026-08-15T00:00:00.000Z"),
    ];
    const codeUnitFirst = [...needs].sort((left, right) =>
      left.needId < right.needId ? -1 : left.needId > right.needId ? 1 : 0,
    )[0];
    expect(pendingQuestionNeed(needs)?.needId).toBe(codeUnitFirst?.needId);
    expect(pendingQuestionNeed(needs)?.needId).toBe("need_a-c");

    // A collator would fold punctuation and case, so it must never be consulted.
    const collator = String.prototype.localeCompare;
    let consulted = 0;
    String.prototype.localeCompare = function locale(this: string, that: string): number {
      consulted += 1;
      return collator.call(this, that);
    };
    try {
      expect(pendingQuestionNeed(needs)?.needId).toBe("need_a-c");
    } finally {
      String.prototype.localeCompare = collator;
    }
    expect(consulted).toBe(0);
  });

  it("marks a question overdue only at the bounded threshold", () => {
    const question = need("need_a", "question", "2026-08-15T00:00:00.000Z");
    expect(questionAttention(question, asked + QUESTION_OVERDUE_MS - 1)?.overdue).toBe(false);
    expect(questionAttention(question, asked + QUESTION_OVERDUE_MS)?.overdue).toBe(true);
    expect(questionAttention(undefined, asked)).toBeUndefined();
  });

  it("never reports negative or unparsable waiting time", () => {
    const question = need("need_a", "question", "2026-08-15T00:00:00.000Z");
    expect(questionAttention(question, asked - 90_000)?.waitedMs).toBe(0);
    expect(questionAttention(need("need_a", "question", "not-a-time"), asked)?.waitedMs).toBe(0);
  });

  it("formats a bounded elapsed label", () => {
    expect(elapsedLabel(0)).toBe("Waiting 0s");
    expect(elapsedLabel(9_000)).toBe("Waiting 9s");
    expect(elapsedLabel(65_000)).toBe("Waiting 1m 05s");
    expect(elapsedLabel(3_723_000)).toBe("Waiting 1h 02m 03s");
    expect(elapsedLabel(100 * 3_600_000)).toBe("Waiting over 99h");
  });

  it("adds and removes the document title attention prefix", () => {
    expect(attentionTitle(false)).toBe(PORTAL_TITLE);
    expect(attentionTitle(true)).toBe(`\u25cf Answer needed \u2014 ${PORTAL_TITLE}`);
  });
});
