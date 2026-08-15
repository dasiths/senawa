import { describe, expect, it } from "vitest";
import { firstRovingIndex, nextRovingIndex } from "./node-toolbar.js";

describe("node toolbar roving tab stop", () => {
  it("wraps arrow movement around the enabled controls", () => {
    expect(nextRovingIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextRovingIndex(2, "ArrowRight", 3)).toBe(0);
    expect(nextRovingIndex(0, "ArrowLeft", 3)).toBe(2);
    expect(nextRovingIndex(1, "ArrowLeft", 3)).toBe(0);
  });

  it("jumps to the first and last control", () => {
    expect(nextRovingIndex(1, "Home", 3)).toBe(0);
    expect(nextRovingIndex(1, "End", 3)).toBe(2);
    expect(nextRovingIndex(0, "ArrowRight", 1)).toBe(0);
  });

  it("ignores keys and positions that cannot move the tab stop", () => {
    expect(nextRovingIndex(0, "Enter", 3)).toBeUndefined();
    expect(nextRovingIndex(0, "Tab", 3)).toBeUndefined();
    expect(nextRovingIndex(-1, "ArrowRight", 3)).toBeUndefined();
    expect(nextRovingIndex(3, "ArrowRight", 3)).toBeUndefined();
    expect(nextRovingIndex(0, "ArrowRight", 0)).toBeUndefined();
  });

  it("places the single tab stop on the first enabled control", () => {
    expect(firstRovingIndex([false, false, true])).toBe(0);
    expect(firstRovingIndex([true, false, false])).toBe(1);
    expect(firstRovingIndex([true, true])).toBe(0);
    expect(firstRovingIndex([])).toBe(0);
  });
});
