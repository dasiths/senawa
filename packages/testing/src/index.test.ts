import { describe, expect, it } from "vitest";
import { createSequence } from "./index.js";

describe("createSequence", () => {
  it("produces deterministic identifiers", () => {
    const sequence = createSequence("test");

    expect(sequence.next()).toBe("test-1");
    expect(sequence.next()).toBe("test-2");
  });
});
