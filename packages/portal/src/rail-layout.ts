export type RailSide = "left" | "right";

export interface RailLayout {
  readonly left: number;
  readonly right: number;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
}

export interface RailLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const RAIL_MIN = 192;
export const RAIL_MAX = 576;
export const RAIL_STEP = 32;
export const RAIL_LARGE_STEP = 96;
export const RAIL_COLLAPSED = 44;

const LAYOUT_KEY = "senawa.portal.layout.v1";

export const DEFAULT_RAIL_LAYOUT: RailLayout = Object.freeze({
  left: 224,
  right: 320,
  leftCollapsed: false,
  rightCollapsed: false,
});

/** Every reachable width, so the stylesheet can carry the geometry without an inline style. */
export const RAIL_WIDTHS: readonly number[] = Object.freeze(
  Array.from(
    { length: (RAIL_MAX - RAIL_MIN) / RAIL_STEP + 1 },
    (_, step) => RAIL_MIN + step * RAIL_STEP,
  ),
);

export function railLayoutStorageKey(): string {
  return LAYOUT_KEY;
}

/** Widths snap to the fixed step ladder that the stylesheet declares. */
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_RAIL_LAYOUT.left;
  const bounded = Math.min(RAIL_MAX, Math.max(RAIL_MIN, width));
  return RAIL_MIN + Math.round((bounded - RAIL_MIN) / RAIL_STEP) * RAIL_STEP;
}

export function railWidth(layout: RailLayout, side: RailSide): number {
  return side === "left" ? layout.left : layout.right;
}

export function railCollapsed(layout: RailLayout, side: RailSide): boolean {
  return side === "left" ? layout.leftCollapsed : layout.rightCollapsed;
}

/** The rendered track width, which is the collapsed spine rather than the stored width. */
export function railTrackWidth(layout: RailLayout, side: RailSide): number {
  return railCollapsed(layout, side) ? RAIL_COLLAPSED : railWidth(layout, side);
}

/** The stylesheet token that selects the rendered track width. */
export function railTrackToken(layout: RailLayout, side: RailSide): string {
  return railCollapsed(layout, side) ? "collapsed" : String(railWidth(layout, side));
}

export function resizeRail(layout: RailLayout, side: RailSide, width: number): RailLayout {
  const clamped = clampRailWidth(width);
  return side === "left"
    ? Object.freeze({ ...layout, left: clamped, leftCollapsed: false })
    : Object.freeze({ ...layout, right: clamped, rightCollapsed: false });
}

export function collapseRail(layout: RailLayout, side: RailSide, collapsed: boolean): RailLayout {
  return side === "left"
    ? Object.freeze({ ...layout, leftCollapsed: collapsed })
    : Object.freeze({ ...layout, rightCollapsed: collapsed });
}

/** Pointer drags move the shared edge, so the right rail grows as the pointer moves left. */
export function dragRailWidth(side: RailSide, startWidth: number, deltaX: number): number {
  return clampRailWidth(startWidth + (side === "left" ? deltaX : -deltaX));
}

export function railKeyboardLayout(
  layout: RailLayout,
  side: RailSide,
  key: string,
  shiftKey = false,
): RailLayout | undefined {
  if (key === "Home") return resizeRail(layout, side, RAIL_MIN);
  if (key === "End") return resizeRail(layout, side, RAIL_MAX);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;
  const step = shiftKey ? RAIL_LARGE_STEP : RAIL_STEP;
  const direction = key === "ArrowRight" ? 1 : -1;
  const current = railCollapsed(layout, side) ? RAIL_COLLAPSED : railWidth(layout, side);
  return resizeRail(layout, side, current + direction * (side === "left" ? step : -step));
}

export function readRailLayout(storage: RailLayoutStorage): RailLayout {
  const serialized = storage.getItem(LAYOUT_KEY);
  if (serialized === null) return DEFAULT_RAIL_LAYOUT;
  try {
    const value = JSON.parse(serialized) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("Invalid rail layout");
    const object = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(object);
    if (keys.length > 4) throw new TypeError("Invalid rail layout fields");
    return Object.freeze({
      left: number(object.left, DEFAULT_RAIL_LAYOUT.left),
      right: number(object.right, DEFAULT_RAIL_LAYOUT.right),
      leftCollapsed: object.leftCollapsed === true,
      rightCollapsed: object.rightCollapsed === true,
    });
  } catch {
    storage.removeItem(LAYOUT_KEY);
    return DEFAULT_RAIL_LAYOUT;
  }
}

export function saveRailLayout(storage: RailLayoutStorage, layout: RailLayout): void {
  storage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      left: layout.left,
      right: layout.right,
      leftCollapsed: layout.leftCollapsed,
      rightCollapsed: layout.rightCollapsed,
    }),
  );
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clampRailWidth(value) : fallback;
}
