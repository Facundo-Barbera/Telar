"use client";

/**
 * THE SCENE COMPOSER — gradients and images stacked, as one CSS value.
 *
 * lib/backdrop.ts can already PAINT a composition: a `scene` choice carries
 * resolved `{light, dark, size, position, repeat}` comma lists straight to
 * #app-backdrop, and the pre-paint init script replays them without running a
 * line of our code. This file is the other half — the editable SOURCE those
 * lists are compiled from, plus the compiler.
 *
 * THE MODEL IS A STACK, TOP FIRST. `layers[0]` is the layer nearest the
 * reader, because that is the order CSS itself uses: the first entry in a
 * `background-image` list paints ON TOP of the ones after it. Keeping our
 * array in paint order means composing is a map, not a reverse-and-map, and
 * "move up" in the UI is `index - 1` in both worlds.
 *
 * EVERYTHING IS A LAYER — GRADIENTS INCLUDED. A stack entry is either an
 * IMAGE (positioned, scaled, tiled) or a GRADIENT (a preset id, painted
 * full-bleed). There is no separate mandatory base any more: what used to be
 * `baseId` is just the bottom-most gradient layer, and a stack with no
 * gradient at the bottom ends in TRANSPARENT — which, inside a translucent
 * desktop window, means the desktop itself is the bottom layer. Scenes
 * written by older builds still carry `baseId`; parseScene migrates it to
 * exactly that bottom gradient layer at 100%.
 *
 * WHY THE LISTS ARE BUILT PER-PROPERTY. `background-size/position/repeat`
 * accept one comma entry per image, and CSS CYCLES a short list against a
 * longer image list. That cycling is a trap here: a preset's `light` is
 * itself four comma-separated gradients, so emitting ONE entry for a gradient
 * layer would let an image layer's `60% auto` wrap around onto a gradient and
 * paint it in a corner. So a gradient layer contributes as many
 * `cover`/`center`/`no-repeat` entries as it has top-level gradients, and —
 * because the two halves share one set of lists — the shorter half is padded
 * with transparent gradients so both halves have the SAME entry count.
 * splitTopLevel does the counting.
 *
 * WHY DATA URLs ARE ESCAPED. isSceneValue (the store's gate) refuses any `;`,
 * and every base64 data URL has one in `image/webp;base64`. Rather than store
 * a percent-encoded URL — three bytes per byte instead of base64's four per
 * three, on a payload that has to fit in localStorage six times over — the
 * semicolon is written as the CSS escape `\00003B` inside the url() string.
 * The tokenizer turns it back into a real `;` before anything sees the URL
 * (verified: the computed `background-image` is byte-identical to the
 * unescaped form), and the SIX-digit form is used because `\3B` followed by
 * `base64` would swallow `ba` as more hex digits.
 *
 * WHY IMAGE OPACITY IS BAKED INTO THE PIXELS. CSS has no per-background-layer
 * opacity — `opacity` applies to the whole element and would fade the rest of
 * the stack with it. So an image layer at 60% is a re-encode at globalAlpha
 * 0.6, which is also why layer images are WebP and not the image picker's
 * JPEG: baked opacity is an alpha channel, and JPEG has none. The ORIGINAL is
 * kept beside it under `orig:${id}` so the slider stays lossless — every bake
 * starts from the original, never from a previously faded copy.
 *
 * A GRADIENT LAYER'S OPACITY IS FREE, and so it is not baked: a gradient is
 * already a string of colours, so fading one is rewriting those colours'
 * alpha (withGradientAlpha below). Same reason, opposite mechanism — and it
 * means the gradient slider is live rather than landing on release.
 *
 * DOM AND PURE ARE SPLIT the way image-backdrop.ts splits them: everything
 * that decides anything (parsing, clamping, list building) is pure and
 * tested; the canvas code below does nothing but draw.
 */

import {
  DEFAULT_LAYER,
  isSceneValue,
  MAX_SCENE_GRADIENT_LAYERS,
  MAX_SCENE_LAYERS,
  parseScene as parseSceneJson,
  parseSceneImages,
  parseSceneLayer as parseSceneLayerValue,
  SCENE_LIMITS,
  type BackdropLayers,
  type Scene,
  type SceneGradientLayer,
  type SceneLayer,
  type ScenePresets,
} from "@telar/engine-client";
import { backdropPresetById, BACKDROP_PRESETS, type BackdropPreset } from "./backdrop-presets";
import { compressImageFile, dataUrlBytes, fitWithin, ImageBackdropError, stepDown, type CompressionStep } from "./image-backdrop";

/* -------------------------------------------------------------- the model */

/**
 * THE MODEL AND ITS PARSERS MOVED to @telar/engine-client: a composed scene
 * travels inside a `Look`, so the engine and any client that reads a published
 * look need the same total parse this composer does. What stayed here is
 * everything that needs THIS app — the preset table, the compiler, the canvas,
 * localStorage — and the moved names are re-exported so no importer changed.
 */
export {
  DEFAULT_LAYER,
  MAX_SCENE_GRADIENT_LAYERS,
  MAX_SCENE_LAYERS,
  parseSceneImages,
  SCENE_LIMITS,
  type Scene,
  type SceneGradientLayer,
  type SceneImageLayer,
  type SceneLayer,
} from "@telar/engine-client";

/** The Scene JSON. */
export const SCENE_KEY = "telar-backdrop-scene";
/** layerId → data URL, plus `orig:${layerId}` → the un-faded original. */
export const SCENE_IMAGES_KEY = "telar-backdrop-scene-images";

/** Layer images are compressed HARDER than the single-image backdrop: several
 *  of them share one quota, and each is drawn at a fraction of the window. */
export const SCENE_LAYER_EDGE = 1024;
export const MAX_SCENE_IMAGE_BYTES = 700 * 1024;

export const DEFAULT_SCENE_BASE: string = BACKDROP_PRESETS[0]?.id ?? "aurora";

/**
 * THE PRESET TABLE, HANDED TO THE SHARED PARSER. The moved parsers are
 * deliberately ignorant of which gradients exist (see `ScenePresets` there);
 * this is where that knowledge is supplied, so a scene naming a preset this
 * build dropped still degrades to the default base exactly as it always did.
 * Every parse in the cockpit goes through the two wrappers below, so the
 * cockpit's forgiveness is stated once.
 */
export const SCENE_PRESETS: ScenePresets = { known: (id) => backdropPresetById(id) !== undefined, fallback: DEFAULT_SCENE_BASE };

/** A fresh scene is one gradient and nothing over it — the picture the old
 *  `baseId`-only model started from. */
export const DEFAULT_SCENE: Scene = { layers: [{ type: "gradient", presetId: DEFAULT_SCENE_BASE, opacity: 100 }] };

let idCounter = 0;

export function newLayerId(): string {
  idCounter += 1;
  return `l${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function clampTo(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/* ------------------------------------------------------------ total parsing */

export function parseSceneLayer(value: unknown): SceneLayer | undefined {
  return parseSceneLayerValue(value, SCENE_PRESETS);
}

export function parseScene(raw: string | null): Scene {
  return parseSceneJson(raw, SCENE_PRESETS);
}

/* ----------------------------------------------------------- pure editing */

/** What a slider can change about a layer. Fields the layer's kind does not
 *  have are ignored rather than refused — a gradient row only ever sends
 *  `opacity`, and nothing else should have to know that twice. */
export type SceneLayerPatch = { x?: number; y?: number; scale?: number; opacity?: number; tiled?: boolean };

export function countSceneImages(scene: Scene): number {
  return scene.layers.reduce((total, layer) => total + (layer.type === "image" ? 1 : 0), 0);
}

export function countSceneGradients(scene: Scene): number {
  return scene.layers.length - countSceneImages(scene);
}

export function addSceneLayer(scene: Scene, id: string): Scene {
  if (countSceneImages(scene) >= MAX_SCENE_LAYERS || scene.layers.some((layer) => layer.type === "image" && layer.id === id)) return scene;
  // New layers land on TOP — you just added it, you want to see it.
  return { layers: [{ id, ...DEFAULT_LAYER }, ...scene.layers] };
}

/** A gradient lands on top too, at full opacity: you can always fade it, but
 *  a new layer you cannot see reads as a broken button. */
export function addSceneGradientLayer(scene: Scene, presetId: string): Scene {
  if (countSceneGradients(scene) >= MAX_SCENE_GRADIENT_LAYERS || !backdropPresetById(presetId)) return scene;
  return { layers: [{ type: "gradient", presetId, opacity: SCENE_LIMITS.opacity.max }, ...scene.layers] };
}

/* --- the bottom of the stack, which the UI still calls "the base" --------- */

/** The preset painted UNDER everything, or null for "nothing — let whatever
 *  is behind the app show through". Only the bottom-most layer counts: a
 *  gradient with an image below it is a wash, not a base. */
export function sceneBasePresetId(scene: Scene): string | null {
  const bottom = scene.layers[scene.layers.length - 1];
  return bottom !== undefined && bottom.type === "gradient" ? bottom.presetId : null;
}

/** Set (or clear) that bottom gradient. Clearing is what "None (transparent)"
 *  writes, and it is a REMOVAL, not a transparent entry: no trailing entries
 *  at all is what lets the desktop be the bottom layer. */
export function setSceneBase(scene: Scene, presetId: string | null): Scene {
  const layers = scene.layers.slice();
  const bottom = layers[layers.length - 1];
  const based = bottom !== undefined && bottom.type === "gradient";
  if (presetId === null) {
    if (!based) return scene;
    layers.pop();
    return { layers };
  }
  if (!backdropPresetById(presetId)) return scene;
  if (based) {
    layers[layers.length - 1] = { ...(bottom as SceneGradientLayer), presetId };
    return { layers };
  }
  if (countSceneGradients(scene) >= MAX_SCENE_GRADIENT_LAYERS) return scene;
  layers.push({ type: "gradient", presetId, opacity: SCENE_LIMITS.opacity.max });
  return { layers };
}

/* --- editing by position, because gradient layers carry no id ------------- */

export function removeSceneLayerAt(scene: Scene, index: number): Scene {
  if (index < 0 || index >= scene.layers.length) return scene;
  return { layers: scene.layers.filter((_, at) => at !== index) };
}

export function updateSceneLayerAt(scene: Scene, index: number, patch: SceneLayerPatch): Scene {
  if (index < 0 || index >= scene.layers.length) return scene;
  return {
    layers: scene.layers.map((layer, at) => {
      if (at !== index) return layer;
      const opacity = patch.opacity === undefined ? layer.opacity : clampTo(patch.opacity, SCENE_LIMITS.opacity, layer.opacity);
      if (layer.type === "gradient") return { ...layer, opacity };
      return {
        ...layer,
        x: patch.x === undefined ? layer.x : clampTo(patch.x, SCENE_LIMITS.x, layer.x),
        y: patch.y === undefined ? layer.y : clampTo(patch.y, SCENE_LIMITS.y, layer.y),
        scale: patch.scale === undefined ? layer.scale : clampTo(patch.scale, SCENE_LIMITS.scale, layer.scale),
        opacity,
        tiled: patch.tiled === undefined ? layer.tiled : patch.tiled === true,
      };
    }),
  };
}

/** `delta` is a step in ARRAY order, which is paint order: -1 moves the layer
 *  towards the front. A move off either end is a no-op, not a wrap. */
export function moveSceneLayerAt(scene: Scene, index: number, delta: number): Scene {
  if (index < 0 || index >= scene.layers.length) return scene;
  const to = index + Math.trunc(delta);
  if (to < 0 || to >= scene.layers.length || to === index) return scene;
  const layers = scene.layers.slice();
  const [moved] = layers.splice(index, 1);
  layers.splice(to, 0, moved);
  return { layers };
}

/* --- and by id, which only image layers have ----------------------------- */

function imageIndex(scene: Scene, id: string): number {
  return scene.layers.findIndex((layer) => layer.type === "image" && layer.id === id);
}

export function removeSceneLayer(scene: Scene, id: string): Scene {
  return removeSceneLayerAt(scene, imageIndex(scene, id));
}

export function updateSceneLayer(scene: Scene, id: string, patch: SceneLayerPatch): Scene {
  return updateSceneLayerAt(scene, imageIndex(scene, id), patch);
}

export function moveSceneLayer(scene: Scene, id: string, delta: number): Scene {
  return moveSceneLayerAt(scene, imageIndex(scene, id), delta);
}

/** Drop a layer's images — both the baked one and its original. */
export function forgetLayerImages(images: Record<string, string>, id: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(images)) {
    if (key !== id && key !== `orig:${id}`) next[key] = value;
  }
  return next;
}

/** Images no layer refers to any more — what a removal leaves behind, and
 *  what a scene restored from a half-written storage write can accumulate. */
export function pruneSceneImages(scene: Scene, images: Record<string, string>): Record<string, string> {
  const live = new Set(scene.layers.flatMap((layer) => (layer.type === "image" ? [layer.id] : [])));
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(images)) {
    const id = key.startsWith("orig:") ? key.slice(5) : key;
    if (live.has(id)) next[key] = value;
  }
  return next;
}

/* ------------------------------------------------------------- the compiler */

/** Split a `background-image` value on its TOP-LEVEL commas — the ones
 *  between whole gradients, not the ones between a gradient's own stops.
 *  Depth counting is enough because the only values passed here are preset
 *  gradients (no strings, no nested quotes). */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

/** Pads a half so both halves have the same entry count (see the header).
 *  Transparent, so a padded entry is invisible rather than black. */
const TRANSPARENT_ENTRY = "linear-gradient(transparent, transparent)";

/** The characters a data URL our own encoder produced can contain. Anything
 *  else (a hand-edited map, a URL with a quote in it) is refused rather than
 *  escaped, because a url() we cannot reason about is a url() that might
 *  escape the declaration. */
const SAFE_DATA_URL = /^data:image\/[a-z0-9.+-]+(;base64)?,[A-Za-z0-9+/=%._~-]*$/i;

/** A data URL as a CSS `url()` token that survives isSceneValue: the one
 *  semicolon becomes the six-digit CSS escape (see the header). Returns null
 *  for anything that is not a plain data URL. */
export function sceneImageUrl(dataUrl: string): string | null {
  if (!SAFE_DATA_URL.test(dataUrl)) return null;
  return `url("${dataUrl.replace(/;/g, "\\00003B")}")`;
}

/* ------------------------------------------------------- gradient opacity */

/** `0.5` → `50%`, at two decimals and with no trailing zeros, because these
 *  strings are stored six times over and `50%` reads better than `50.00%`. */
function alphaText(alpha: number): string {
  return `${Number((Math.min(1, Math.max(0, alpha)) * 100).toFixed(2))}%`;
}

/** An existing alpha, from either notation CSS allows (`/ 60%` or `/ 0.6`). */
function alphaValue(text: string): number {
  const trimmed = text.trim();
  const number = trimmed.endsWith("%") ? Number(trimmed.slice(0, -1)) / 100 : Number(trimmed);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
}

function hexPair(alpha: number): string {
  return Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * FADE A GRADIENT WITHOUT AN `opacity` PROPERTY — by rewriting the alpha of
 * every colour in it. CSS gives a background layer no opacity of its own
 * (`opacity` would fade the whole element, the layers under it included), and
 * these values are just strings, so the honest move is to edit the colours.
 *
 * The two forms that actually appear here are handled, and nothing else is
 * invented: `oklch(…)` (every preset stop) gains or MULTIPLIES a `/ N%`
 * alpha, and `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` (what the custom-gradient
 * editor's colour inputs produce) becomes an 8-digit hex. `transparent` is
 * left alone — it is already invisible, and fading it is a no-op that would
 * only make the string longer.
 *
 * Multiplying rather than overwriting is what makes this composable: a
 * half-transparent stop inside a layer at 50% ends up at 25%, which is what
 * stacking two translucent things means everywhere else.
 *
 * The output is still gradient syntax with no `;`, `}` or `url(` in it, so it
 * passes isGradientValue and isSceneValue exactly as the input did.
 */
export function withGradientAlpha(css: string, opacity: number): string {
  const factor = Math.min(1, Math.max(0, (Number.isFinite(opacity) ? opacity : 100) / 100));
  if (factor >= 1) return css;
  return css
    .replace(/oklch\(([^()]*)\)/gi, (_match, body: string) => {
      const slash = body.lastIndexOf("/");
      const head = (slash < 0 ? body : body.slice(0, slash)).trim();
      const existing = slash < 0 ? 1 : alphaValue(body.slice(slash + 1));
      return `oklch(${head} / ${alphaText(existing * factor)})`;
    })
    .replace(/#([0-9a-fA-F]+)\b/g, (match, hex: string) => {
      const short = hex.length === 3 || hex.length === 4;
      const long = hex.length === 6 || hex.length === 8;
      if (!short && !long) return match;
      const rgb = short ? hex.slice(0, 3).replace(/./g, (char) => char + char) : hex.slice(0, 6);
      const tail = short ? hex.slice(3) : hex.slice(6);
      const existing = tail.length === 0 ? 1 : parseInt(short ? tail + tail : tail, 16) / 255;
      return `#${rgb}${hexPair(existing * factor)}`;
    });
}

/**
 * THE COMPILER — a Scene plus its images becomes the resolved lists the store
 * paints. Pure, and the only place layer order and the gradient cycling
 * problem are reasoned about.
 *
 * Entries come out in array order, topmost first, mixing images and gradients
 * freely; NOTHING is appended underneath, so a stack that does not end in a
 * full-bleed gradient ends in transparency and the desktop (or the theme's
 * own canvas) is what shows there.
 *
 * An image layer whose image is missing — cleared storage, a failed write —
 * is SKIPPED rather than left as a gap: the lists are positional, and a gap
 * would shift every entry after it onto the wrong picture. Returns null when
 * a gradient layer names a preset this build does not have, when the stack
 * composes to nothing at all, or when the result somehow fails the store's
 * gate — so a caller never writes something that silently paints nothing.
 */
export function composeScene(
  scene: Scene,
  images: Record<string, string>,
  presetLookup: (id: string) => BackdropPreset | undefined = backdropPresetById,
): BackdropLayers | null {
  const lightEntries: string[] = [];
  const darkEntries: string[] = [];
  const size: string[] = [];
  const position: string[] = [];
  const repeat: string[] = [];

  for (const layer of scene.layers) {
    if (layer.type === "image") {
      const data = images[layer.id];
      if (typeof data !== "string") continue;
      const url = sceneImageUrl(data);
      if (!url) continue;
      lightEntries.push(url);
      darkEntries.push(url);
      size.push(`${layer.scale}% auto`);
      position.push(`${layer.x}% ${layer.y}%`);
      repeat.push(layer.tiled ? "repeat" : "no-repeat");
      continue;
    }
    const preset = presetLookup(layer.presetId);
    if (!preset) return null;
    const fade = (value: string) => (layer.opacity >= SCENE_LIMITS.opacity.max ? value : withGradientAlpha(value, layer.opacity));
    // A gradient layer contributes one entry per gradient it holds, and both
    // halves are padded to a common count so the shared lists stay aligned.
    const lightParts = splitTopLevel(fade(preset.light));
    const darkParts = splitTopLevel(fade(preset.dark));
    const count = Math.max(lightParts.length, darkParts.length, 1);
    const pad = (parts: string[]) => parts.concat(Array.from({ length: count - parts.length }, () => TRANSPARENT_ENTRY));
    lightEntries.push(...pad(lightParts));
    darkEntries.push(...pad(darkParts));
    for (let index = 0; index < count; index += 1) {
      size.push("cover");
      position.push("center");
      repeat.push("no-repeat");
    }
  }

  const light = lightEntries.join(", ");
  const dark = darkEntries.join(", ");
  // An empty stack is a real state of the editor, but not a paintable value —
  // the composer says so in its hint rather than writing an empty declaration.
  if (!isSceneValue(light) || !isSceneValue(dark)) return null;
  return { light, dark, size: size.join(", "), position: position.join(", "), repeat: repeat.join(", ") };
}

/* ------------------------------------------------------------------ storage */

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write, or put the previous value back and say no — storeBackdropImage's
 *  contract, for the same reason: a scene that half-saved is worse than one
 *  that refused, and the composer has a line to show. */
function writeKey(key: string, value: string): boolean {
  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(key);
  } catch {
    return false; // Private browsing: nothing can be stored at all.
  }
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    try {
      if (previous === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, previous);
    } catch {
      // The restore can fail too; composeScene skipping missing images keeps
      // the app coherent either way.
    }
    return false;
  }
}

export function readScene(): Scene {
  return parseScene(readKey(SCENE_KEY));
}

export function readSceneImages(): Record<string, string> {
  return parseSceneImages(readKey(SCENE_IMAGES_KEY));
}

export function writeScene(scene: Scene): boolean {
  return writeKey(SCENE_KEY, JSON.stringify(scene));
}

/** The big one — this is the write that actually meets the quota. */
export function writeSceneImages(images: Record<string, string>): boolean {
  return writeKey(SCENE_IMAGES_KEY, JSON.stringify(images));
}

/** Roughly what the map costs, for the composer's hint line. */
export function sceneImagesBytes(images: Record<string, string>): number {
  return Object.values(images).reduce((total, value) => total + dataUrlBytes(value), 0);
}

/* ------------------------------------------------- the canvas (DOM, thin) */

/**
 * Draw a stored data URL at `edge` and `alpha`, out as WebP. WebP because
 * baked opacity IS an alpha channel and JPEG has none; PNG only if the
 * browser will not encode WebP (then the size ladder below does the worrying).
 */
async function redraw(dataUrl: string, edge: number, alpha: number, quality: number): Promise<string> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const { width, height } = fitWithin(image.naturalWidth || 1, image.naturalHeight || 1, edge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new ImageBackdropError("decode-failed", "This browser could not draw the image.");
  context.clearRect(0, 0, width, height);
  context.globalAlpha = Math.min(1, Math.max(0, alpha));
  context.drawImage(image, 0, 0, width, height);
  const webp = canvas.toDataURL("image/webp", quality);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

/** Where a layer's ladder starts: smaller and cheaper than the single-image
 *  backdrop's, because up to six of these share one quota. */
const SCENE_FIRST_STEP: CompressionStep = { edge: SCENE_LAYER_EDGE, quality: 0.8 };

/**
 * A picked file becomes a layer's ORIGINAL: the image picker's own ladder
 * first (it owns decoding, format sniffing and the named errors), then one
 * more pass down to a layer's smaller budget, reusing stepDown so the retry
 * policy lives in exactly one place.
 */
export async function prepareSceneImage(file: File): Promise<string> {
  const source = await compressImageFile(file);
  let step: CompressionStep | undefined = SCENE_FIRST_STEP;
  while (step) {
    const encoded = await redraw(source, step.edge, 1, step.quality);
    if (dataUrlBytes(encoded) <= MAX_SCENE_IMAGE_BYTES) return encoded;
    step = stepDown(step);
  }
  throw new ImageBackdropError("too-large", "That image is too large to hold as a scene layer.");
}

/** Baked results, keyed by (layer, opacity). Bounded because dragging an
 *  opacity slider walks through dozens of values and each one is a megabyte-
 *  ish string; the original is always in the images map, so a miss is slow,
 *  never wrong. */
const bakeCache = new Map<string, string>();
const BAKE_CACHE_LIMIT = 16;

function remember(key: string, value: string): void {
  bakeCache.set(key, value);
  if (bakeCache.size > BAKE_CACHE_LIMIT) {
    const oldest = bakeCache.keys().next();
    if (!oldest.done) bakeCache.delete(oldest.value);
  }
}

/**
 * Return the images map with `id` re-encoded at `opacity`, ALWAYS starting
 * from `orig:${id}` so repeated drags never compound the fade. 100% needs no
 * encode at all — the original is already the answer. An unknown id, or a
 * canvas that will not draw, returns the map untouched: the composer then
 * paints the previous bake, which is a stale opacity rather than a hole.
 */
export async function bakeLayerOpacity(images: Record<string, string>, id: string, opacity: number): Promise<Record<string, string>> {
  const original = images[`orig:${id}`] ?? images[id];
  if (typeof original !== "string") return images;
  const level = clampTo(opacity, SCENE_LIMITS.opacity, SCENE_LIMITS.opacity.max);
  if (level >= SCENE_LIMITS.opacity.max) return { ...images, [`orig:${id}`]: original, [id]: original };
  const key = `${id}:${level}:${original.length}`;
  const cached = bakeCache.get(key);
  if (cached) return { ...images, [`orig:${id}`]: original, [id]: cached };
  try {
    const baked = await redraw(original, SCENE_LAYER_EDGE, level / 100, 0.8);
    remember(key, baked);
    return { ...images, [`orig:${id}`]: original, [id]: baked };
  } catch {
    return images;
  }
}
