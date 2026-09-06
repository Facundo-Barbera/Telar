/**
 * Browser viewport sizes and fixed-mode presentation geometry.
 * Fit mode follows the panel at native scale. Fixed mode lays out the page
 * at a chosen size and scales its presentation into the available stage.
 * These helpers keep the fixed frame and its drag handles aligned with the
 * desktop host's native view.
 */

export type ViewportSize = { width: number; height: number };
export type ViewportPresetKey = "default" | "laptop" | "tablet" | "phone";
export type ViewportMode = "fixed" | "fit";

export const VIEWPORT_PRESETS: ReadonlyArray<{ key: ViewportPresetKey; label: string; width: number; height: number }> = [
  { key: "default", label: "Default", width: 1280, height: 800 },
  { key: "laptop", label: "Laptop", width: 1440, height: 900 },
  { key: "tablet", label: "Tablet", width: 768, height: 1024 },
  { key: "phone", label: "Phone", width: 390, height: 844 },
];

export const VIEWPORT_MIN = 200;
export const VIEWPORT_MAX = 5_000;

/**
 * THE RESIZE RAIL — the strip along the host's right and bottom edges where
 * the drag handles live. The native view is given the STAGE inside it
 * (`host − rail`), never the whole host, so the handles are DOM the native
 * layer cannot cover. Fit mode uses the whole host without rails.
 */
export const VIEWPORT_RAIL = 12;

/** The preset a size is, or undefined for a custom size. */
export function presetFor(size: ViewportSize): ViewportPresetKey | undefined {
  return VIEWPORT_PRESETS.find((preset) => preset.width === size.width && preset.height === size.height)?.key;
}

/** The toolbar's one-line label: the preset's name, or the numbers. */
export function describeViewport(size: ViewportSize, mode: ViewportMode = "fit"): string {
  if (mode === "fit") return `Fit panel · ${size.width}×${size.height}`;
  const preset = presetFor(size);
  return preset ? `${VIEWPORT_PRESETS.find((entry) => entry.key === preset)!.label} · ${size.width}×${size.height}` : `${size.width}×${size.height}`;
}

export function clampViewport(size: ViewportSize): ViewportSize {
  const clamp = (value: number) => Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(value)));
  return { width: clamp(size.width), height: clamp(size.height) };
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

/** The stage the native view may occupy inside a host of this size. */
export function stageOf(host: { width: number; height: number }): { width: number; height: number } {
  return { width: Math.max(1, host.width - VIEWPORT_RAIL), height: Math.max(1, host.height - VIEWPORT_RAIL) };
}

/**
 * Where the page sits inside the stage: scaled down to fit (never up) and
 * centred. Mirrors the host's `fitViewport` exactly, so the device frame and
 * the rails the panel draws land on the native rect.
 */
export function fitViewport(viewport: ViewportSize, stage: { width: number; height: number }): { scale: number; x: number; y: number; width: number; height: number } {
  const scale = Math.min(1, stage.width / viewport.width, stage.height / viewport.height);
  const width = Math.max(1, Math.round(viewport.width * scale));
  const height = Math.max(1, Math.round(viewport.height * scale));
  return { scale, x: Math.max(0, Math.floor((stage.width - width) / 2)), y: Math.max(0, Math.floor((stage.height - height) / 2)), width, height };
}

export type ResizeDirection = "east" | "south" | "southeast";

/**
 * SCALE-AWARE DRAG. The pointer moves in screen pixels over a view drawn at
 * `scale`; the viewport is in CSS pixels, so a screen delta is `delta /
 * scale` of viewport — dragging the edge of a half-size page 100px makes the
 * page 200px wider. The rails sit at the fitted edges, so the delta is
 * against the START size, never accumulated. Clamped to the host's limits.
 */
export function resizeByDrag(start: ViewportSize, delta: { x: number; y: number }, scale: number, direction: ResizeDirection): ViewportSize {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const dx = direction === "south" ? 0 : delta.x / factor;
  const dy = direction === "east" ? 0 : delta.y / factor;
  return clampViewport({ width: start.width + dx, height: start.height + dy });
}

/** Arrow keys on a rail: 10 CSS px, 50 with Shift; only the axes the rail
 *  controls. Undefined for a key the rail ignores. */
export function resizeByKey(start: ViewportSize, key: string, shift: boolean, direction: ResizeDirection): ViewportSize | undefined {
  const step = shift ? 50 : 10;
  const controlsWidth = direction !== "south";
  const controlsHeight = direction !== "east";
  const delta =
    key === "ArrowLeft" && controlsWidth ? { x: -step, y: 0 }
    : key === "ArrowRight" && controlsWidth ? { x: step, y: 0 }
    : key === "ArrowUp" && controlsHeight ? { x: 0, y: -step }
    : key === "ArrowDown" && controlsHeight ? { x: 0, y: step }
    : undefined;
  if (!delta) return undefined;
  const next = clampViewport({ width: start.width + delta.x, height: start.height + delta.y });
  return next.width === start.width && next.height === start.height ? undefined : next;
}
