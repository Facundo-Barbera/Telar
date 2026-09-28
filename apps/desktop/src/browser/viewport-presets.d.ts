// Hand-written declaration for viewport-presets.js — the same pairing as
// command-keys.d.ts, and for the same reason: apps/desktop has no tsconfig, so
// this is what lets apps/web and apps/engine type the relative import. The .js
// file is what ships and runs; this file only describes it. The key unions are
// kept in step with the table by apps/web/src/lib/browser-viewport.test.ts.

export type ViewportPresetGroup = "phones" | "tablets" | "desktop" | "foldables";

export type ViewportPresetEntryKey =
  | "iphone-se"
  | "iphone-12-pro"
  | "iphone-14-pro-max"
  | "pixel-7"
  | "galaxy-s8-plus"
  | "ipad-mini"
  | "ipad-air"
  | "ipad-pro"
  | "surface-pro-7"
  | "default"
  | "small-laptop"
  | "laptop"
  | "full-hd"
  | "galaxy-z-fold-5"
  | "surface-duo";

export type ViewportPresetAlias = "phone" | "tablet" | "galaxy-s20-ultra";

/** Every name `{preset}` accepts. */
export type ViewportPresetKey = ViewportPresetEntryKey | ViewportPresetAlias;

export type ViewportOrientation = "portrait" | "landscape";

export type ViewportPreset = {
  key: ViewportPresetEntryKey;
  label: string;
  group: ViewportPresetGroup;
  width: number;
  height: number;
};

export type ViewportSizeLike = { width: number; height: number };

export const VIEWPORT_PRESETS: ReadonlyArray<ViewportPreset>;
export const VIEWPORT_PRESET_GROUPS: ReadonlyArray<{ key: ViewportPresetGroup; label: string }>;
/** Non-empty, so a zod enum can take it as-is. */
export const VIEWPORT_PRESET_KEYS: readonly [ViewportPresetKey, ...ViewportPresetKey[]];

export function viewportPreset(key: unknown): ViewportPreset | undefined;
export function presetOf(size: ViewportSizeLike | null | undefined): ViewportPresetEntryKey | null;
export function orientationOf(size: ViewportSizeLike): ViewportOrientation;
export function orient(size: ViewportSizeLike, orientation: ViewportOrientation): { width: number; height: number };
