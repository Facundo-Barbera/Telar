"use client";

import { compositionFromV1, type Look } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { DEFAULT_APPEARANCE } from "./appearance";
import { parseLook, parseThemeHalf } from "./looks";

export type HomeRead = {
  looks: Look[];
  settings: Record<string, unknown> | null;
  images: string[];
  unreadable: { file: string; reason: string }[];
};

const EMPTY: HomeRead = { looks: [], settings: null, images: [], unreadable: [] };

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

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

export async function readAppearanceHome(): Promise<HomeRead> {
  const home = await createEngineApi().appearanceHome().catch(() => undefined);
  if (!home) return EMPTY;
  const unreadable = home.skipped.slice();
  const looks: Look[] = [];
  for (const entry of home.themes) {
    const look = themeFileAsLook(entry);
    if (look) looks.push(look);
    else unreadable.push({ file: `themes/${String(entry["id"] ?? "?")}.json`, reason: "not a theme this build can read" });
  }
  for (const entry of home.looks) {
    if (!isId(entry["id"])) {
      unreadable.push({ file: "looks/?.json", reason: "no usable id" });
      continue;
    }
    const look = parseLook(entry);
    if (look) looks.push(look);
    else unreadable.push({ file: `looks/${entry["id"]}.json`, reason: "not a look this build can read" });
  }
  return { looks, settings: home.settings, images: home.images, unreadable };
}

export function mergeById<T extends { id: string }>(mine: readonly T[], home: readonly T[]): T[] {
  const fromHome = new Map(home.map((entry) => [entry.id, entry]));
  const merged = mine.map((entry) => fromHome.get(entry.id) ?? entry);
  const seen = new Set(mine.map((entry) => entry.id));
  return [...merged, ...home.filter((entry) => !seen.has(entry.id))];
}
