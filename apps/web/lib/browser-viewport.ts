/**
 * Fixed-mode viewport geometry. The preset table lives in
 * `apps/desktop/viewport-presets.js`; this is the cockpit's only import of it.
 */
import {
  presetOf,
  viewportPreset,
  VIEWPORT_PRESET_GROUPS,
  VIEWPORT_PRESETS,
  type ViewportPreset,
  type ViewportPresetEntryKey,
  type ViewportPresetGroup,
  type ViewportPresetKey,
} from "../../desktop/src/browser/viewport-presets.js";

export { viewportPreset, VIEWPORT_PRESETS };
export type { ViewportPreset, ViewportPresetEntryKey, ViewportPresetGroup, ViewportPresetKey };

export type ViewportSize = { width: number; height: number };
export type ViewportMode = "fixed" | "fit";

const VIEWPORT_MIN = 200;
const VIEWPORT_MAX = 5_000;

/** The rail on each host edge; the native view gets only the stage inside it, so the handles stay uncovered DOM. */
export const VIEWPORT_RAIL = 12;

export function presetFor(size: ViewportSize): ViewportPresetEntryKey | undefined {
  return presetOf(size) ?? undefined;
}

/** The presets under their group headings, in menu order; empty groups dropped. */
export function groupedViewportPresets(): Array<{ key: ViewportPresetGroup; label: string; presets: ViewportPreset[] }> {
  return VIEWPORT_PRESET_GROUPS.map((group) => ({ ...group, presets: VIEWPORT_PRESETS.filter((preset) => preset.group === group.key) })).filter((group) => group.presets.length > 0);
}

export function describeViewport(size: ViewportSize, mode: ViewportMode = "fit"): string {
  if (mode === "fit") return `Fit panel · ${size.width}×${size.height}`;
  const preset = viewportPreset(presetFor(size));
  return preset ? `${preset.label} · ${size.width}×${size.height}` : `${size.width}×${size.height}`;
}

function clampViewport(size: ViewportSize): ViewportSize {
  const clamp = (value: number) => Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(value)));
  return { width: clamp(size.width), height: clamp(size.height) };
}

/** Undefined until both fields are digits, so partial input relayouts nothing; out-of-range values are clamped. */
export function sizeFromFields(width: string, height: string): ViewportSize | undefined {
  const w = width.trim();
  const h = height.trim();
  if (!w || !h) return undefined;
  // `Number` alone accepts "1e3", " 12 " and "0x10".
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

/** "fit" scales down to fit (never up); a number is capped at fit, since the native view cannot leave the stage. */
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

export function zoomFits(zoom: ViewportZoom, viewport: ViewportSize, stage: { width: number; height: number }): boolean {
  return zoom === "fit" || zoom <= fitScale(viewport, stage) + 1e-6;
}

/** Scaled to fit (never up) and centred in the stage; mirrors the host's `fitViewport` exactly. */
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
 * Inverts `displayed = min(css × k, cap)`; past the cap it grows as `want² / (cap × k)`,
 * which stays continuous at the cap.
 */
function cssForDisplayed(want: number, cap: number, k: number): number {
  const displayed = Math.max(1, want);
  return displayed <= cap ? displayed / k : (displayed * displayed) / (cap * k);
}

/**
 * `extent` is where the grabbed edge should sit, in screen px from the page's centre. The page
 * is centred, so the displayed size is twice the extent, solved against the scale it will end at.
 */
export function resizeToEdge(start: ViewportSize, direction: ResizeDirection, extent: { x: number; y: number }, stage: { width: number; height: number }, lockRatio = false, zoom: ViewportZoom = "fit"): ViewportSize {
  const top = zoom === "fit" ? 1 : zoom;
  const axes = axesOf(direction);
  const ratio = lockRatio ? ratioOf(start) : undefined;
  const want = { width: 2 * extent.x, height: 2 * extent.y };
  let driver: "width" | "height" = axes.x ? "width" : "height";
  if (axes.x && axes.y) {
    if (!ratio) {
      // Both edges: shown at the zoom while they fit, then at the scale that fits the tighter axis.
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

/** Arrow keys on a rail: 10 px, 50 with Shift; the arrow pointing away from the page grows it. */
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

/** ↑/↓ in a size field: 1 px, 10 with Shift, clamped. Undefined for other keys or non-numeric drafts. */
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
