"use client";

/**
 * The files in `$TELAR_HOME/appearance` are the record; localStorage is only a
 * cache so APPEARANCE_INIT_SCRIPT can paint synchronously before any fetch.
 */

import { compositionFromV1, type Look } from "@telar/engine-client";
import { DEFAULT_APPEARANCE } from "./appearance";
import { parseLook, parseThemeHalf } from "./looks";

export type HomeRead = {
  looks: Look[];
  settings: Record<string, unknown> | null;
  images: string[];
  /** Unparseable files plus entries this build cannot read as a look. */
  unreadable: { file: string; reason: string }[];
};

const EMPTY: HomeRead = { looks: [], settings: null, images: [], unreadable: [] };

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** Reads a legacy `themes/` file forward into a Look, with every token pinned. */
function themeFileAsLook(entry: Record<string, unknown>): Look | undefined {
  if (!isId(entry["id"])) return undefined;
  const label = typeof entry["label"] === "string" && entry["label"].trim() ? entry["label"].trim().slice(0, 80) : entry["id"];
  const { composition, images } = compositionFromV1(
    { light: parseThemeHalf(entry["light"], "light"), dark: parseThemeHalf(entry["dark"], "dark") },
    { kind: "none" },
  );
  return {
    version: 2,
    id: entry["id"],
    label,
    composition,
    images,
    accent: DEFAULT_APPEARANCE.accent,
    fontSans: DEFAULT_APPEARANCE.fontSans,
    fontMono: DEFAULT_APPEARANCE.fontMono,
    fontSansCustom: "",
    fontMonoCustom: "",
    fontSize: DEFAULT_APPEARANCE.fontSize,
    fontMonoSize: DEFAULT_APPEARANCE.fontMonoSize,
    translucencyLevel: DEFAULT_APPEARANCE.translucencyLevel,
    depth: DEFAULT_APPEARANCE.depth,
  };
}

export async function readAppearanceHome(signal?: AbortSignal): Promise<HomeRead> {
  let payload: {
    themes?: unknown;
    looks?: unknown;
    settings?: unknown;
    images?: unknown;
    skipped?: unknown;
  };
  try {
    const response = await fetch("/api/appearance/home", { signal, cache: "no-store" });
    if (!response.ok) return EMPTY;
    payload = (await response.json()) as typeof payload;
  } catch {
    return EMPTY;
  }

  const unreadable: { file: string; reason: string }[] = Array.isArray(payload.skipped)
    ? payload.skipped.flatMap((entry) =>
        typeof entry === "object" && entry !== null ? [{ file: String((entry as Record<string, unknown>)["file"] ?? ""), reason: String((entry as Record<string, unknown>)["reason"] ?? "") }] : [],
      )
    : [];

  const objects = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];

  const looks: Look[] = [];
  for (const entry of objects(payload.themes)) {
    const look = themeFileAsLook(entry);
    if (look) looks.push(look);
    else unreadable.push({ file: `themes/${String(entry["id"] ?? "?")}.json`, reason: "not a theme this build can read" });
  }

  for (const entry of objects(payload.looks)) {
    if (!isId(entry["id"])) {
      unreadable.push({ file: "looks/?.json", reason: "no usable id" });
      continue;
    }
    const look = parseLook(entry);
    if (look) looks.push(look);
    else unreadable.push({ file: `looks/${entry["id"]}.json`, reason: "not a look this build can read" });
  }

  return {
    looks,
    settings: typeof payload.settings === "object" && payload.settings !== null && !Array.isArray(payload.settings) ? (payload.settings as Record<string, unknown>) : null,
    images: Array.isArray(payload.images) ? payload.images.filter((name): name is string => typeof name === "string") : [],
    unreadable,
  };
}

/** Home wins where an id exists on both sides; ids on only one side survive. */
export function mergeById<T extends { id: string }>(mine: readonly T[], home: readonly T[]): T[] {
  const fromHome = new Map(home.map((entry) => [entry.id, entry]));
  const merged = mine.map((entry) => fromHome.get(entry.id) ?? entry);
  const seen = new Set(mine.map((entry) => entry.id));
  return [...merged, ...home.filter((entry) => !seen.has(entry.id))];
}
