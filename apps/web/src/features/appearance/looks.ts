"use client";

import { useSyncExternalStore } from "react";
import { parseLook as parseLookValue, type Composition, type Look } from "@telar/engine-client";
import { parseAppearance, type Appearance } from "./appearance";
import { currentComposition, strandedTones, writeComposition } from "./composition";
import { SCENE_PRESETS } from "./scene-composer";

export { parseThemeHalf, type Look } from "@telar/engine-client";

const LOOKS_KEY = "telar-looks";

const APPEARANCE_KEY = "telar-appearance";

export const MAX_LOOKS = 12;

export type LookAppearance = Pick<
  Appearance,
  "accent" | "fontSans" | "fontMono" | "fontSansCustom" | "fontMonoCustom" | "fontSize" | "fontMonoSize" | "translucencyLevel" | "depth"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLook(value: unknown): Look | undefined {
  return parseLookValue(value, SCENE_PRESETS);
}

export function parseLooks(raw: string | null): Look[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const looks: Look[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      const look = parseLook(entry);
      if (!look || seen.has(look.id)) continue;
      seen.add(look.id);
      looks.push(look);
      if (looks.length === MAX_LOOKS) break;
    }
    return looks;
  } catch {
    return [];
  }
}

export function serializeLook(look: Look): string {
  return JSON.stringify(look);
}

export function parseLookFile(raw: string, id: string): Look | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const look = parseLook({ ...parsed, id: "imported" });
    return look ? { ...look, id } : undefined;
  } catch {
    return undefined;
  }
}

export function lookFilename(look: Look): string {
  const stem = look.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${stem.length > 0 ? stem : "look"}.telar-look.json`;
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function newLookId(): string {
  return `look-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function captureLook(label: string): Look {
  const appearance = parseAppearance(readKey(APPEARANCE_KEY));
  const { composition, images } = currentComposition();
  return {
    version: 2,
    id: newLookId(),
    label: label.trim().length > 0 ? label.trim() : "Untitled look",
    composition,
    images,
    accent: appearance.accent,
    fontSans: appearance.fontSans,
    fontMono: appearance.fontMono,
    fontSansCustom: appearance.fontSansCustom,
    fontMonoCustom: appearance.fontMonoCustom,
    fontSize: appearance.fontSize,
    fontMonoSize: appearance.fontMonoSize,
    translucencyLevel: appearance.translucencyLevel,
    depth: appearance.depth,
  };
}

export function lookAppearance(look: Look): LookAppearance {
  return {
    accent: look.accent,
    fontSans: look.fontSans,
    fontMono: look.fontMono,
    fontSansCustom: look.fontSansCustom,
    fontMonoCustom: look.fontMonoCustom,
    fontSize: look.fontSize,
    fontMonoSize: look.fontMonoSize,
    translucencyLevel: look.translucencyLevel,
    depth: look.depth,
  };
}

const LOOK_QUOTA_MESSAGE = "This look's layer images would not fit in storage; everything else was applied.";

export function lookTintMessage(tones: readonly string[]): string {
  const named = tones.length === 1 ? tones[0] : `${tones.slice(0, -1).join(", ")} and ${tones[tones.length - 1]}`;
  return `This look's card sits too close to the ${named} colour${tones.length === 1 ? "" : "s"}, so ${tones.length === 1 ? "that tint" : "those tints"} will be hard to read. Nothing was changed for ${tones.length === 1 ? "it" : "them"}.`;
}

export function applyLook(look: Look, setAppearance: (patch: LookAppearance) => void): string | undefined {
  const stored = writeComposition(look.composition, look.images);
  setAppearance(lookAppearance(look));
  const notices: string[] = [];
  if (!stored) notices.push(LOOK_QUOTA_MESSAGE);
  const stranded = strandedTones(look.composition);
  if (stranded.length > 0) notices.push(lookTintMessage(stranded));
  return notices.length > 0 ? notices.join(" ") : undefined;
}

export function sameComposition(a: Composition, b: Composition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function upsertLook(looks: Look[], look: Look): Look[] | undefined {
  const existing = looks.findIndex((entry) => entry.id === look.id);
  if (existing >= 0) return looks.map((entry) => (entry.id === look.id ? look : entry));
  if (looks.length >= MAX_LOOKS) return undefined;
  return [look, ...looks];
}

export function readLooks(): Look[] {
  return parseLooks(readKey(LOOKS_KEY));
}

const listeners = new Set<() => void>();
let version = 0;
let snapshotCache: { version: number; value: Look[] } | undefined;

const SERVER_LOOKS: Look[] = [];

function readSnapshot(): Look[] {
  if (!snapshotCache || snapshotCache.version !== version) snapshotCache = { version, value: readLooks() };
  return snapshotCache.value;
}

function subscribeToLooks(onChange: () => void): () => void {
  const onStorage = () => {
    version += 1;
    onChange();
  };
  listeners.add(onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useLooks(): Look[] {
  return useSyncExternalStore(subscribeToLooks, readSnapshot, () => SERVER_LOOKS);
}

export function writeLooks(looks: Look[]): boolean {
  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(LOOKS_KEY);
  } catch {
    return false; // Private browsing: nothing can be stored at all.
  }
  try {
    window.localStorage.setItem(LOOKS_KEY, JSON.stringify(looks));
    version += 1;
    for (const listener of listeners) listener();
    return true;
  } catch {
    try {
      if (previous === null) window.localStorage.removeItem(LOOKS_KEY);
      else window.localStorage.setItem(LOOKS_KEY, previous);
    } catch {
    }
    return false;
  }
}

export const LOOKS_FULL_MESSAGE = `You can keep ${MAX_LOOKS} looks. Delete one to save another.`;
export const LOOKS_QUOTA_MESSAGE = "There is not enough browser storage left for this look — its layer images are large.";
