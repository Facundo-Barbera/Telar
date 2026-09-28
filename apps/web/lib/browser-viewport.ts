/**
 * Browser viewport sizes and fixed-mode presentation geometry.
 * Fit mode follows the panel at native scale. Fixed mode lays out the page
 * at a chosen size and scales its presentation into the available stage.
 * These helpers keep the fixed frame and its drag handles aligned with the
 * desktop host's native view.
 *
 * THE PRESET TABLE LIVES ONCE, in `apps/desktop/viewport-presets.js`, which
 * the host requires directly; this file is the cockpit's only import of it.
 */
import {
  orient,
  orientationOf,
  presetOf,
  viewportPreset,
  VIEWPORT_PRESET_GROUPS,
  VIEWPORT_PRESETS,
  type ViewportOrientation,
  type ViewportPreset,
  type ViewportPresetEntryKey,
  type ViewportPresetGroup,
  type ViewportPresetKey,
} from "../../desktop/viewport-presets.js";

export { orient, orientationOf, viewportPreset, VIEWPORT_PRESET_GROUPS, VIEWPORT_PRESETS };
export type { ViewportOrientation, ViewportPreset, ViewportPresetEntryKey, ViewportPresetGroup, ViewportPresetKey };

export type ViewportSize = { width: number; height: number };
export type ViewportMode = "fixed" | "fit";

export const VIEWPORT_MIN = 200;
export const VIEWPORT_MAX = 5_000;

/**
 * THE RESIZE RAIL — the strip along all four of the host's edges where the
 * drag handles live. The native view is given the STAGE inside it (`host −
 * 2 × rail` on each axis), never the whole host, so the handles are DOM the
 * native layer cannot cover. Fit mode uses the whole host without rails.
 */
export const VIEWPORT_RAIL = 12;

/** The preset a size is, or undefined for a custom size. */
export function presetFor(size: ViewportSize): ViewportPresetEntryKey | undefined {
  return presetOf(size) ?? undefined;
}

/** The presets under their group headings, in menu order; empty groups dropped. */
export function groupedViewportPresets(): Array<{ key: ViewportPresetGroup; label: string; presets: ViewportPreset[] }> {
  return VIEWPORT_PRESET_GROUPS.map((group) => ({ ...group, presets: VIEWPORT_PRESETS.filter((preset) => preset.group === group.key) })).filter((group) => group.presets.length > 0);
}

/** The toolbar's one-line label: the preset's name, or the numbers. */
export function describeViewport(size: ViewportSize, mode: ViewportMode = "fit"): string {
  if (mode === "fit") return `Fit panel · ${size.width}×${size.height}`;
  const preset = viewportPreset(presetFor(size));
  return preset ? `${preset.label} · ${size.width}×${size.height}` : `${size.width}×${size.height}`;
}

export function clampViewport(size: ViewportSize): ViewportSize {
  const clamp = (value: number) => Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(value)));
  return { width: clamp(size.width), height: clamp(size.height) };
}

/**
 * THE DEVICE TOOLBAR'S TWO FIELDS, READ AS A SIZE (#473).
 *
 * Undefined for anything that is not yet a size, which is the whole point:
 * the fields commit on submit and on blur, and "1" on the way to "1024" — or
 * an emptied field on the way to anything — must relayout nothing. A negative
 * or absurd number is not refused but clamped, the same as every other way
 * into a viewport, because the host would clamp it regardless and a field
 * that silently did nothing would read as broken.
 */
export function sizeFromFields(width: string, height: string): ViewportSize | undefined {
  const w = width.trim();
  const h = height.trim();
  if (!w || !h) return undefined;
  // `Number` on its own accepts "1e3", " 12 " and "0x10"; a size a person
  // typed into a numeric field is digits.
  if (!/^\d+$/.test(w) || !/^\d+$/.test(h)) return undefined;
  return clampViewport({ width: Number(w), height: Number(h) });
}

/**
 * A size a person typed — "1024x768", "1024 × 768", "1024,768" — clamped to
 * what the host accepts. Undefined for anything that is not two numbers.
 */
export function parseViewportInput(text: string): ViewportSize | undefined {
  const match = text.trim().match(/^(\d{2,5})\s*[x×X,*\s]\s*(\d{2,5})$/);
  if (!match) return undefined;
  return clampViewport({ width: Number(match[1]), height: Number(match[2]) });
}

export type StageRect = { x: number; y: number; width: number; height: number };

/** The stage the native view may occupy inside a host of this size, in the
 *  host's own coordinates: inset by a rail on every side. */
export function stageOf(host: { width: number; height: number }): StageRect {
  return {
    x: VIEWPORT_RAIL,
    y: VIEWPORT_RAIL,
    width: Math.max(1, host.width - 2 * VIEWPORT_RAIL),
    height: Math.max(1, host.height - 2 * VIEWPORT_RAIL),
  };
}

/**
 * THE PRESENTATION ZOOM a person picked in the device toolbar. "fit" scales
 * the page down until it fits (never up); a number is that scale, but never
 * past fit — the native view cannot reach outside the stage, so a zoom that
 * would not fit is offered disabled rather than cropped (`zoomFits`).
 */
export type ViewportZoom = "fit" | number;
export const VIEWPORT_ZOOMS: ReadonlyArray<{ key: ViewportZoom; label: string }> = [
  { key: "fit", label: "Fit" },
  { key: 0.5, label: "50%" },
  { key: 0.75, label: "75%" },
  { key: 1, label: "100%" },
];

/** The largest scale at which the whole page fits the stage, capped at 1. */
function fitScale(viewport: ViewportSize, stage: { width: number; height: number }): number {
  return Math.min(1, stage.width / viewport.width, stage.height / viewport.height);
}

/** Whether a zoom can be shown whole in this stage. */
export function zoomFits(zoom: ViewportZoom, viewport: ViewportSize, stage: { width: number; height: number }): boolean {
  return zoom === "fit" || zoom <= fitScale(viewport, stage) + 1e-6;
}

/**
 * Where the page sits inside the stage: scaled down to fit (never up) and
 * CENTRED ON BOTH AXES, relative to the stage's own origin. Mirrors the
 * host's `fitViewport` exactly, so the device frame and the rails the panel
 * draws land on the native rect.
 */
export function fitViewport(viewport: ViewportSize, stage: { width: number; height: number }, zoom: ViewportZoom = "fit"): { scale: number; x: number; y: number; width: number; height: number } {
  const fit = fitScale(viewport, stage);
  const scale = zoom === "fit" ? fit : Math.min(fit, zoom);
  const width = Math.max(1, Math.round(viewport.width * scale));
  const height = Math.max(1, Math.round(viewport.height * scale));
  return { scale, x: Math.max(0, Math.floor((stage.width - width) / 2)), y: Math.max(0, Math.floor((stage.height - height) / 2)), width, height };
}

export type ResizeDirection = "north" | "south" | "east" | "west" | "northeast" | "northwest" | "southeast" | "southwest";
export const RESIZE_DIRECTIONS: ReadonlyArray<ResizeDirection> = ["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"];

/** Which way a handle moves each axis: +1 grows toward positive screen
 *  coordinates, −1 toward negative, 0 leaves the axis alone. */
export function axesOf(direction: ResizeDirection): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  return {
    x: direction.endsWith("east") ? 1 : direction.endsWith("west") ? -1 : 0,
    y: direction.startsWith("north") ? -1 : direction.startsWith("south") ? 1 : 0,
  };
}

/** Width over height, for a locked aspect ratio. */
export function ratioOf(size: ViewportSize): number {
  return size.width / size.height;
}

/** Clamp, and with a ratio keep it: the axis `driver` names wins and the
 *  other follows, then both are clamped again. */
function clampToRatio(size: ViewportSize, ratio: number | undefined, driver: "width" | "height"): ViewportSize {
  const clamped = clampViewport(size);
  if (!ratio) return clamped;
  return driver === "width"
    ? clampViewport({ width: clamped.width, height: clamped.width / ratio })
    : clampViewport({ width: clamped.height * ratio, height: clamped.height });
}

/**
 * THE CSS LENGTH WHOSE DISPLAYED LENGTH IS `want`. Along one axis the page is
 * shown at `min(css × k, cap)`: `k` is the scale the OTHER axis imposes, `cap`
 * where the stage stops it. Below the cap that inverts exactly; past it the
 * edge cannot follow (the page already fills the stage), so the size keeps
 * growing continuously — `want² / (cap × k)` meets `want / k` at the cap.
 */
function cssForDisplayed(want: number, cap: number, k: number): number {
  const displayed = Math.max(1, want);
  return displayed <= cap ? displayed / k : (displayed * displayed) / (cap * k);
}

/**
 * CURSOR-FOLLOWING DRAG. `extent` is where the grabbed edge should sit, in
 * screen px from the page's centre, per axis. The page is centred on both
 * axes, so it grows on both sides at once: the displayed size is TWICE the
 * extent, and the size that displays at it is solved against the scale the
 * page will be shown at (which changes as it grows), not the scale the drag
 * started at. `zoom` is the picked presentation zoom, which caps that scale
 * the way 1 does under fit. Pure, so the arithmetic is tested without a
 * pointer.
 */
export function resizeToEdge(start: ViewportSize, direction: ResizeDirection, extent: { x: number; y: number }, stage: { width: number; height: number }, lockRatio = false, zoom: ViewportZoom = "fit"): ViewportSize {
  const top = zoom === "fit" ? 1 : zoom;
  const axes = axesOf(direction);
  const ratio = lockRatio ? ratioOf(start) : undefined;
  const want = { width: 2 * extent.x, height: 2 * extent.y };
  let driver: "width" | "height" = axes.x ? "width" : "height";
  if (axes.x && axes.y) {
    if (!ratio) {
      // Both edges under the pointer: shown at the zoom while they fit, then at
      // the one scale that puts the tighter axis on the stage's edge.
      const scale = Math.min(top, stage.width / Math.max(1, want.width), stage.height / Math.max(1, want.height));
      return clampViewport({ width: Math.max(1, want.width) / scale, height: Math.max(1, want.height) / scale });
    }
    // Locked: the axis that moved further (relative to its start) leads.
    driver = want.width / start.width >= want.height / start.height ? "width" : "height";
  }
  if (driver === "width") {
    const k = ratio ? top : Math.min(top, stage.height / start.height);
    const cap = ratio ? Math.min(stage.width, stage.height * ratio) : stage.width;
    const width = cssForDisplayed(want.width, cap, k);
    return clampToRatio({ width, height: ratio ? width / ratio : start.height }, ratio, "width");
  }
  const k = ratio ? top : Math.min(top, stage.width / start.width);
  const cap = ratio ? Math.min(stage.height, stage.width / ratio) : stage.height;
  const height = cssForDisplayed(want.height, cap, k);
  return clampToRatio({ width: ratio ? height * ratio : start.width, height }, ratio, "height");
}

/**
 * Arrow keys on a rail: 10 CSS px, 50 with Shift, on the rail's own axes.
 * The arrow that points AWAY from the page grows it, so ← widens from the
 * west rail and → from the east one. Undefined for a key the rail ignores or
 * a size already at the clamp.
 */
export function resizeByKey(start: ViewportSize, key: string, shift: boolean, direction: ResizeDirection, lockRatio = false): ViewportSize | undefined {
  const step = shift ? 50 : 10;
  const axes = axesOf(direction);
  const ratio = lockRatio ? ratioOf(start) : undefined;
  const next =
    (key === "ArrowLeft" || key === "ArrowRight") && axes.x
      ? clampToRatio({ width: start.width + step * axes.x * (key === "ArrowRight" ? 1 : -1), height: ratio ? 0 : start.height }, ratio, "width")
      : (key === "ArrowUp" || key === "ArrowDown") && axes.y
        ? clampToRatio({ width: ratio ? 0 : start.width, height: start.height + step * axes.y * (key === "ArrowDown" ? 1 : -1) }, ratio, "height")
        : undefined;
  if (!next) return undefined;
  return next.width === start.width && next.height === start.height ? undefined : next;
}

/**
 * ↑/↓ IN A SIZE FIELD: 1 px, 10 with Shift, clamped to the host's limits.
 * Undefined for any other key, or for a draft that is not a number yet.
 */
export function stepField(value: string, key: string, shift: boolean): string | undefined {
  if (key !== "ArrowUp" && key !== "ArrowDown") return undefined;
  const current = value.trim();
  if (!/^\d+$/.test(current)) return undefined;
  const step = (shift ? 10 : 1) * (key === "ArrowUp" ? 1 : -1);
  return String(Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Number(current) + step)));
}

/** A size typed with the ratio locked: the field that changed leads and the
 *  other follows it. */
export function keepRatio(next: ViewportSize, previous: ViewportSize, ratio: number): ViewportSize {
  if (next.width !== previous.width) return clampToRatio(next, ratio, "width");
  if (next.height !== previous.height) return clampToRatio(next, ratio, "height");
  return next;
}
