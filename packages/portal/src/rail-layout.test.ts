import { describe, expect, it } from "vitest";
import {
  clampRailWidth,
  collapseRail,
  DEFAULT_RAIL_LAYOUT,
  dragRailWidth,
  RAIL_COLLAPSED,
  RAIL_LARGE_STEP,
  RAIL_MAX,
  RAIL_MIN,
  RAIL_STEP,
  RAIL_WIDTHS,
  type RailLayout,
  type RailLayoutStorage,
  railKeyboardLayout,
  railLayoutStorageKey,
  railTrackToken,
  railTrackWidth,
  readRailLayout,
  resizeRail,
  saveRailLayout,
} from "./rail-layout.js";

class MemoryStorage implements RailLayoutStorage {
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

const layout: RailLayout = DEFAULT_RAIL_LAYOUT;

describe("rail layout geometry", () => {
  it("clamps and snaps every width onto the declared ladder", () => {
    expect(clampRailWidth(RAIL_MIN - 400)).toBe(RAIL_MIN);
    expect(clampRailWidth(RAIL_MAX + 400)).toBe(RAIL_MAX);
    expect(clampRailWidth(RAIL_MIN + RAIL_STEP - 1)).toBe(RAIL_MIN + RAIL_STEP);
    expect(clampRailWidth(RAIL_MIN + 1)).toBe(RAIL_MIN);
    expect(clampRailWidth(Number.NaN)).toBe(DEFAULT_RAIL_LAYOUT.left);
    expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RAIL_LAYOUT.left);
    for (const width of RAIL_WIDTHS) expect(clampRailWidth(width)).toBe(width);
    expect(RAIL_WIDTHS).toContain(DEFAULT_RAIL_LAYOUT.left);
    expect(RAIL_WIDTHS).toContain(DEFAULT_RAIL_LAYOUT.right);
  });

  it("reports the collapsed spine as the rendered track", () => {
    const collapsed = collapseRail(layout, "left", true);
    expect(railTrackWidth(collapsed, "left")).toBe(RAIL_COLLAPSED);
    expect(railTrackToken(collapsed, "left")).toBe("collapsed");
    expect(railTrackWidth(collapsed, "right")).toBe(layout.right);
    expect(railTrackToken(collapsed, "right")).toBe(String(layout.right));
  });

  it("expands a collapsed rail whenever it is resized", () => {
    const resized = resizeRail(collapseRail(layout, "right", true), "right", 384);
    expect(resized).toEqual({ ...layout, right: 384, rightCollapsed: false });
  });

  it("moves the shared edge in the direction the pointer travels", () => {
    expect(dragRailWidth("left", 224, 64)).toBe(288);
    expect(dragRailWidth("right", 320, 64)).toBe(256);
    expect(dragRailWidth("left", 224, -4_000)).toBe(RAIL_MIN);
    expect(dragRailWidth("right", 320, -4_000)).toBe(RAIL_MAX);
  });

  it("resizes each rail with arrow, shift, home, and end keys", () => {
    expect(railKeyboardLayout(layout, "left", "ArrowRight")?.left).toBe(224 + RAIL_STEP);
    expect(railKeyboardLayout(layout, "left", "ArrowLeft")?.left).toBe(224 - RAIL_STEP);
    expect(railKeyboardLayout(layout, "right", "ArrowLeft")?.right).toBe(320 + RAIL_STEP);
    expect(railKeyboardLayout(layout, "right", "ArrowRight")?.right).toBe(320 - RAIL_STEP);
    expect(railKeyboardLayout(layout, "left", "ArrowRight", true)?.left).toBe(
      224 + RAIL_LARGE_STEP,
    );
    expect(railKeyboardLayout(layout, "left", "Home")?.left).toBe(RAIL_MIN);
    expect(railKeyboardLayout(layout, "left", "End")?.left).toBe(RAIL_MAX);
    expect(railKeyboardLayout(layout, "left", "Enter")).toBeUndefined();
    expect(railKeyboardLayout(layout, "left", " ")).toBeUndefined();
  });

  it("grows a collapsed rail from its spine width", () => {
    const collapsed = collapseRail(layout, "left", true);
    const grown = railKeyboardLayout(collapsed, "left", "ArrowRight");
    expect(grown?.left).toBe(RAIL_MIN);
    expect(grown?.leftCollapsed).toBe(false);
  });

  it("round trips a persisted layout and rejects a hostile record", () => {
    const storage = new MemoryStorage();
    expect(readRailLayout(storage)).toEqual(DEFAULT_RAIL_LAYOUT);
    saveRailLayout(storage, { left: 288, right: 256, leftCollapsed: false, rightCollapsed: true });
    expect(readRailLayout(storage)).toEqual({
      left: 288,
      right: 256,
      leftCollapsed: false,
      rightCollapsed: true,
    });

    storage.setItem(railLayoutStorageKey(), "not json");
    expect(readRailLayout(storage)).toEqual(DEFAULT_RAIL_LAYOUT);
    expect(storage.getItem(railLayoutStorageKey())).toBeNull();

    storage.setItem(railLayoutStorageKey(), JSON.stringify({ left: 5_000, right: -20 }));
    expect(readRailLayout(storage)).toEqual({
      left: RAIL_MAX,
      right: RAIL_MIN,
      leftCollapsed: false,
      rightCollapsed: false,
    });

    storage.setItem(railLayoutStorageKey(), JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 }));
    expect(readRailLayout(storage)).toEqual(DEFAULT_RAIL_LAYOUT);
  });
});
