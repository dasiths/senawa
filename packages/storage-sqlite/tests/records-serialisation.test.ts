import { canonicalBytes, canonicalDigest, canonicalValue } from "@senawa/kernel";
import { durableStringify } from "@senawa/protocol";
import { deterministicSha256 } from "@senawa/testing";
import { describe, expect, it } from "vitest";

/**
 * A run's records are serialised twice on every command: once for the column
 * and once, separately, to digest the revision. Whether those two traversals
 * can become one is a question about bytes, and this is the answer, pinned
 * before anything is changed on the strength of it.
 */
describe("a run's records", () => {
  const records = {
    phase: { phaseId: "phase_build", attempt: 3 },
    zeta: [1, 2, { nested: true }],
    alpha: { b: "two", a: "one" },
    empty: {},
    list: [],
    text: 'a string with "quotes", a \\ backslash, and é',
    numbers: [0, -1, 1.5, 1e21],
    nulls: [null, null],
  };

  it("serialises to the same bytes for the column and for the digest", () => {
    const column = durableStringify(records);
    const digested = canonicalBytes(canonicalValue(records));

    // If these agree, the revision digest can be taken from the string the
    // column already holds, and the second full traversal is waste.
    expect(new TextDecoder().decode(digested)).toBe(column);
  });

  it("orders keys the same way whichever route it takes", () => {
    const reordered = {
      nulls: [null, null],
      numbers: [0, -1, 1.5, 1e21],
      text: records.text,
      list: [],
      empty: {},
      alpha: { a: "one", b: "two" },
      zeta: [1, 2, { nested: true }],
      phase: { attempt: 3, phaseId: "phase_build" },
    };

    expect(durableStringify(reordered)).toBe(durableStringify(records));
    expect(new TextDecoder().decode(canonicalBytes(canonicalValue(reordered)))).toBe(
      durableStringify(records),
    );
  });

  // The condition the write actually depends on: the revision digest taken
  // from the column's own string is the digest the run has always had.
  it("digests the same whether taken from the value or from the column", () => {
    const fromValue = canonicalDigest(canonicalValue(records), deterministicSha256);
    const fromColumn = deterministicSha256.digest(
      new TextEncoder().encode(durableStringify(records)),
    );

    expect(fromColumn).toBe(fromValue);
  });
});
