"use client";

/**
 * READING THE APPEARANCE HOME INTO THE BROWSER.
 *
 * The files at `$TELAR_HOME/appearance` are the record; this window keeps a
 * localStorage copy because APPEARANCE_INIT_SCRIPT has to paint the right
 * colours synchronously, before any fetch could have finished. So the copy is
 * a CACHE with a source, rather than the only place anything lives — which is
 * the whole point: an agent has a filesystem and no browser, and until now it
 * could write a theme that nothing would ever read.
 *
 * THE HOME WINS ON ID, AND ONLY ON ID. A merge rather than a replace, because
 * both authors are real: the pane writes what you edit here, the agent writes
 * what it is asked to, and neither should silently delete the other's work.
 * Where an id exists in both, the file is newer by definition — it is what the
 * other author most recently said — and where it exists in only one, it stays.
 *
 * PARSED WITH THE VOCABULARY THAT PAINTS. The engine holds JSON it does not
 * understand, so an entry becomes a Theme or a Look here or not at all; one
 * that this build cannot read is COUNTED and reported rather than dropped in
 * silence, because a theme that never appears with no explanation is the worst
 * version of this feature.
 */

import { compositionFromV1, type Look } from "@telar/engine-client";
import { DEFAULT_APPEARANCE } from "./appearance";
import { parseLook, parseThemeHalf } from "./looks";

export type HomeRead = {
  looks: Look[];
  settings: Record<string, unknown> | null;
  images: string[];
  /** Files the engine could not parse as JSON, plus entries this build could
   *  not read as a look. Both are things a person needs told. */
  unreadable: { file: string; reason: string }[];
};

const EMPTY: HomeRead = { looks: [], settings: null, images: [], unreadable: [] };

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * A `themes/` FILE, READ AS A LOOK (#471). The folder predates the composition
 * and holds the old shape — an id, a label and two halves — which is exactly
 * what `compositionFromV1` exists to read forward, so an agent's theme file
 * still lands and still paints. It arrives with every token pinned, the same as
 * an imported VS Code theme, because those halves are work somebody did rather
 * than something a base could regenerate.
 *
 * The halves are filled out by the same total parser a Look's are, so a file
 * naming three tokens is a valid look with thirteen defaults rather than a
 * rejected one.
 */
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
    // No engine, no pairing, no network — the cache stands on its own, which
    // is exactly what it is for.
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
    // The web-side parser, which supplies THIS build's gradient preset table —
    // the shared one is deliberately ignorant of which presets exist.
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

/**
 * MERGE, NEVER REPLACE. Both authors are real, so an id present in only one
 * side survives; an id present in both takes the home's copy, because the file
 * is what the other author most recently said.
 */
export function mergeById<T extends { id: string }>(mine: readonly T[], home: readonly T[]): T[] {
  const fromHome = new Map(home.map((entry) => [entry.id, entry]));
  const merged = mine.map((entry) => fromHome.get(entry.id) ?? entry);
  const seen = new Set(mine.map((entry) => entry.id));
  return [...merged, ...home.filter((entry) => !seen.has(entry.id))];
}

/** Where a stored picture is served from. The name is a content hash, so this
 *  URL is stable for the life of the bytes and cached as immutable. */
export function homeImageUrl(name: string): string {
  return `/api/appearance/home/images/${encodeURIComponent(name)}`;
}
