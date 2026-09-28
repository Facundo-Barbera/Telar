"use client";

import {
  composeGradient,
  DEFAULT_GRADIENT_SPECS,
  DEFAULT_LAYER,
  isSceneValue,
  MAX_SCENE_GRADIENT_LAYERS,
  MAX_SCENE_LAYERS,
  parseScene as parseSceneJson,
  parseSceneLayer as parseSceneLayerValue,
  SCENE_LIMITS,
  type CustomGradientSpec,
  type Scene,
  type SceneLayer,
  type ScenePresets,
} from "@telar/engine-client";
import { GRADIENT_STARTERS, gradientStarterById } from "./gradient-starters";
import { compressImageFile, dataUrlBytes, fitWithin, ImageBackdropError, stepDown, type CompressionStep } from "./image-backdrop";

export {
  DEFAULT_LAYER,
  MAX_SCENE_GRADIENT_LAYERS,
  MAX_SCENE_LAYERS,
  parseSceneImages,
  SCENE_LIMITS,
  type CustomGradientSpec,
  type Scene,
  type SceneGradientLayer,
  type SceneImageLayer,
  type SceneLayer,
} from "@telar/engine-client";

const SCENE_LAYER_EDGE = 1024;
const MAX_SCENE_IMAGE_BYTES = 700 * 1024;

export const DEFAULT_SCENE_BASE: string = GRADIENT_STARTERS[0]?.id ?? "aurora";

export const SCENE_PRESETS: ScenePresets = { expand: (id, mode) => gradientStarterById(id)?.[mode], fallback: DEFAULT_SCENE_BASE };

export const DEFAULT_SCENE: Scene = {
  layers: [{ type: "gradient", spec: gradientStarterById(DEFAULT_SCENE_BASE)?.light ?? DEFAULT_GRADIENT_SPECS.light, opacity: 100 }],
};

let idCounter = 0;

export function newLayerId(): string {
  idCounter += 1;
  return `l${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function clampTo(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

export function parseSceneLayer(value: unknown, mode: "light" | "dark" = "light"): SceneLayer | undefined {
  return parseSceneLayerValue(value, SCENE_PRESETS, mode);
}

export function parseScene(raw: string | null, mode: "light" | "dark" = "light"): Scene {
  return parseSceneJson(raw, SCENE_PRESETS, mode);
}

export type SceneLayerPatch = { x?: number; y?: number; scale?: number; opacity?: number; tiled?: boolean };

export function countSceneImages(scene: Scene): number {
  return scene.layers.reduce((total, layer) => total + (layer.type === "image" ? 1 : 0), 0);
}

export function countSceneGradients(scene: Scene): number {
  return scene.layers.length - countSceneImages(scene);
}

export function addSceneLayer(scene: Scene, id: string): Scene {
  if (countSceneImages(scene) >= MAX_SCENE_LAYERS || scene.layers.some((layer) => layer.type === "image" && layer.id === id)) return scene;
  return { layers: [{ id, ...DEFAULT_LAYER }, ...scene.layers] };
}

export function addSceneGradientLayer(scene: Scene, spec: CustomGradientSpec): Scene {
  if (countSceneGradients(scene) >= MAX_SCENE_GRADIENT_LAYERS) return scene;
  return { layers: [{ type: "gradient", spec, opacity: SCENE_LIMITS.opacity.max }, ...scene.layers] };
}

export function setGradientSpec(scene: Scene, index: number, spec: CustomGradientSpec): Scene {
  const layer = scene.layers[index];
  if (!layer || layer.type !== "gradient") return scene;
  return { layers: scene.layers.map((entry, at) => (at === index ? { ...layer, spec } : entry)) };
}

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
      if (layer.type !== "image") return { ...layer, opacity };
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

export function moveSceneLayerAt(scene: Scene, index: number, delta: number): Scene {
  if (index < 0 || index >= scene.layers.length) return scene;
  const to = index + Math.trunc(delta);
  if (to < 0 || to >= scene.layers.length || to === index) return scene;
  const layers = scene.layers.slice();
  const [moved] = layers.splice(index, 1);
  layers.splice(to, 0, moved);
  return { layers };
}

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

export function forgetLayerImages(images: Record<string, string>, id: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(images)) {
    if (key !== id && key !== `orig:${id}`) next[key] = value;
  }
  return next;
}

export function pruneSceneImages(scene: Scene, images: Record<string, string>): Record<string, string> {
  const live = new Set(scene.layers.flatMap((layer) => (layer.type === "image" ? [layer.id] : [])));
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(images)) {
    const id = key.startsWith("orig:") ? key.slice(5) : key;
    if (live.has(id)) next[key] = value;
  }
  return next;
}

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

const SAFE_DATA_URL = /^data:image\/[a-z0-9.+-]+(;base64)?,[A-Za-z0-9+/=%._~-]*$/i;

export function sceneImageUrl(dataUrl: string): string | null {
  if (!SAFE_DATA_URL.test(dataUrl)) return null;
  return `url("${dataUrl.replace(/;/g, "\\00003B")}")`;
}

function alphaText(alpha: number): string {
  return `${Number((Math.min(1, Math.max(0, alpha)) * 100).toFixed(2))}%`;
}

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

export type SceneLists = { image: string; size: string; position: string; repeat: string };

export function composeState(layers: readonly SceneLayer[], images: Record<string, string>): SceneLists | null {
  const entries: string[] = [];
  const size: string[] = [];
  const position: string[] = [];
  const repeat: string[] = [];

  for (const layer of layers) {
    if (layer.type === "image") {
      const data = images[layer.id];
      if (typeof data !== "string") continue;
      const url = sceneImageUrl(data);
      if (!url) continue;
      entries.push(url);
      size.push(`${layer.scale}% auto`);
      position.push(`${layer.x}% ${layer.y}%`);
      repeat.push(layer.tiled ? "repeat" : "no-repeat");
      continue;
    }
    const composed = composeGradient(layer.spec);
    const css = layer.opacity >= SCENE_LIMITS.opacity.max ? composed : withGradientAlpha(composed, layer.opacity);
    const parts = splitTopLevel(css);
    entries.push(...parts);
    for (let index = 0; index < Math.max(parts.length, 1); index += 1) {
      size.push("cover");
      position.push("center");
      repeat.push("no-repeat");
    }
  }

  const image = entries.join(", ");
  if (!isSceneValue(image)) return null;
  return { image, size: size.join(", "), position: position.join(", "), repeat: repeat.join(", ") };
}

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

const SCENE_FIRST_STEP: CompressionStep = { edge: SCENE_LAYER_EDGE, quality: 0.8 };

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

const bakeCache = new Map<string, string>();
const BAKE_CACHE_LIMIT = 16;

function remember(key: string, value: string): void {
  bakeCache.set(key, value);
  if (bakeCache.size > BAKE_CACHE_LIMIT) {
    const oldest = bakeCache.keys().next();
    if (!oldest.done) bakeCache.delete(oldest.value);
  }
}

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
