"use client";

/**
 * LOOKS — the whole appearance as one shareable thing.
 *
 * Every other file on the Appearance pane owns ONE axis: theme-palettes the
 * surfaces, appearance the accent and type, backdrop the scene under the app.
 * Each has its own store, its own key, its own lifetime. That separation is
 * right for editing — and useless for SHARING, because "my setup" is all of
 * them at once. A Look is the bundle: capture takes a photograph of every
 * store, apply writes them all back, and one JSON file carries it to another
 * machine.
 *
 * THE THEME IS EMBEDDED CONCRETE, NOT REFERENCED. A Look could store the
 * active theme's id and be a fraction of the size — and would then be a
 * dangling pointer the moment the referenced custom theme is deleted, or the
 * moment the file lands on a machine that never had it. So a Look carries the
 * two HALVES themselves, filled out through concreteHalf against the active
 * pair, which also means a Look records exactly what the reader was looking
 * at even when their pair was MIXED (Ember's day over Tide's night): the pair
 * collapses into one embedded theme, because that combination is the look.
 *
 * WHY THE BACKDROP CARRIES BOTH CHOICE AND RESOLVED CSS. lib/backdrop.ts
 * deliberately writes the resolved `background-image` at choice time so the
 * pre-paint script needs no preset table. A Look that stored only `{kind:
 * "gradient", id}` would depend on that preset still existing under that id in
 * whatever build opens the file. Storing the resolved layers beside the choice
 * makes the Look self-contained; the id is kept anyway so the backdrop pane
 * still shows the right preset selected after wearing one.
 *
 * WHY `translucent` IS NOT IN A LOOK, BUT `translucencyLevel` IS. The on/off
 * toggle is a property of the MACHINE, not of the taste: it only exists inside
 * the desktop shell, it requires macOS, turning it on REBUILDS the window
 * (transparency is decided at window creation), and the shell keeps its own
 * authoritative copy in ui-prefs.json which wins on entry (see
 * appearance-section.tsx). A Look imported into a browser tab that flipped it
 * would either do nothing or, in the desktop app, silently rebuild someone's
 * window as a side effect of trying a colour scheme. The STRENGTH is pure
 * taste — how much shows through — and it is also read by the backdrop wash in
 * a plain browser tab, so it travels.
 *
 * PARSING IS TOTAL, like every store this file touches: an unreadable member
 * degrades to a default rather than throwing, and a backdrop whose embedded
 * CSS does not pass the store's own gates degrades to no backdrop at all.
 *
 * THE SHAPE AND ITS PARSERS NOW LIVE IN @telar/engine-client, because a Look is
 * no longer only a file: the cockpit PUBLISHES one to the engine so a paired
 * client can wear the host's look, and the reader on the other end needs the
 * same types and the same total, gated parse. What stayed here is everything
 * that needs a browser — capture from the live stores, apply back into them,
 * the shelf and its quota. The moved names are re-exported, so nothing that
 * imports from "@/lib/looks" changed.
 */

import { useSyncExternalStore } from "react";
import {
  parseLook as parseLookValue,
  parseLookBackdrop as parseLookBackdropValue,
  type Look,
  type LookBackdrop,
} from "@telar/engine-client";
import { parseAppearance, type Appearance } from "./appearance";
import {
  BACKDROP_KEY,
  isGradientValue,
  isSceneValue,
  parseBackdrop,
  readBackdropLayers,
  setBackdrop,
  type BackdropLayers,
} from "./backdrop";
import { readBackdropImage, storeBackdropImage } from "./image-backdrop";
import { readScene, readSceneImages, SCENE_PRESETS, writeScene, writeSceneImages } from "./scene-composer";
import { BUILT_IN_THEMES, concreteHalf, matchThemeHalf, parseActivePair, parseCustomThemes, type ThemeDefinition, type ThemeHalf } from "./theme-palettes";

export { parseThemeHalf, type Look, type LookBackdrop } from "@telar/engine-client";

/* ------------------------------------------------------------- the keys */

/** Where the saved Looks live. */
export const LOOKS_KEY = "telar-looks";

/**
 * theme-palettes.ts and appearance.ts keep their own storage keys private —
 * they are implementation details of stores that own every write to them. This
 * file only ever READS them (capture), and writes them through those modules'
 * own functions, so the literals are restated here rather than widening two
 * modules' public surface with keys nobody else should be setting.
 */
const THEME_ACTIVE_KEY = "telar-theme-active";
const THEME_CUSTOM_KEY = "telar-themes-custom";
const APPEARANCE_KEY = "telar-appearance";

/**
 * Twelve. A Look with a composed scene carries up to six layer images plus
 * their un-faded originals, so a dozen of them is already more than a
 * localStorage origin will hold — the cap is about keeping the grid readable;
 * the QUOTA is what actually refuses, and it refuses by measuring, below.
 */
export const MAX_LOOKS = 12;

/* ------------------------------------------------------------- the shape */

/** What a Look sets on the appearance store — every taste member, and
 *  pointedly not `translucent` or `frost` (see the header). */
export type LookAppearance = Pick<
  Appearance,
  "accent" | "fontSans" | "fontMono" | "fontSansCustom" | "fontMonoCustom" | "fontSize" | "fontMonoSize" | "translucencyLevel"
>;

/* ---------------------------------------------------------- total parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shared parsers, wearing THIS build's gradient preset table — the moved
 *  parsers are deliberately ignorant of which presets exist (see scene-composer
 *  for why), and this is the one place the cockpit supplies them. */
export function parseLookBackdrop(value: unknown): LookBackdrop {
  return parseLookBackdropValue(value, SCENE_PRESETS);
}

export function parseLook(value: unknown): Look | undefined {
  return parseLookValue(value, SCENE_PRESETS);
}

/** The resolved layers, held to the store's OWN gate: `check` is
 *  isGradientValue for the gradient kinds and isSceneValue for a scene, so a
 *  captured Look can never carry something applyBackdrop would silently drop. */
function parseLayers(value: unknown, check: (candidate: unknown) => candidate is string): BackdropLayers | undefined {
  if (!isRecord(value) || !check(value.light)) return undefined;
  const list = (candidate: unknown) =>
    typeof candidate === "string" && candidate.length > 0 && !candidate.includes(";") && !candidate.includes("}") ? candidate : undefined;
  const size = list(value.size);
  const position = list(value.position);
  const repeat = list(value.repeat);
  return {
    light: value.light,
    dark: check(value.dark) ? value.dark : value.light,
    ...(size ? { size } : {}),
    ...(position ? { position } : {}),
    ...(repeat ? { repeat } : {}),
  };
}

/** The saved list. A garbage entry is dropped, never thrown on, and duplicate
 *  ids collapse so wearing one can never be ambiguous. */
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

/* ------------------------------------------------------ the shareable file */

/** The file format IS the stored shape — a Look is already self-contained, so
 *  export has nothing to strip and import has nothing to reconstruct. Not
 *  indented: the embedded scene images make these files large enough that
 *  pretty-printing is measurable, and nobody reads a base64 blob by hand. */
export function serializeLook(look: Look): string {
  return JSON.stringify(look);
}

/** A file becomes a Look with a FRESH id: importing the same file twice should
 *  give two cards, not silently overwrite the first. */
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

/** A filename someone can find again: the label, lowercased and hyphenated. */
export function lookFilename(look: Look): string {
  const stem = look.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${stem.length > 0 ? stem : "look"}.telar-look.json`;
}

/* ------------------------------------------------------------- capture */

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The active pair as one embedded theme — see the header on why a MIXED pair
 *  collapses rather than being refused. */
function captureTheme(): { light: ThemeHalf; dark: ThemeHalf } {
  const active = parseActivePair(readKey(THEME_ACTIVE_KEY));
  const themes: ThemeDefinition[] = [...BUILT_IN_THEMES, ...parseCustomThemes(readKey(THEME_CUSTOM_KEY))];
  const find = (id: string) => themes.find((theme) => theme.id === id) ?? BUILT_IN_THEMES[0];
  return { light: concreteHalf(find(active.light), "light"), dark: concreteHalf(find(active.dark), "dark") };
}

/** The backdrop plus whatever payload its kind keeps elsewhere. A choice whose
 *  payload has gone missing captures as "none" rather than as a promise the
 *  Look cannot keep. */
function captureBackdrop(): LookBackdrop {
  const backdrop = parseBackdrop(readKey(BACKDROP_KEY));
  if (backdrop.kind === "none") return { kind: "none" };
  if (backdrop.kind === "image") {
    const image = readBackdropImage();
    return image ? { kind: "image", fit: backdrop.fit, blur: backdrop.blur, dim: backdrop.dim, image } : { kind: "none" };
  }
  const layers = readBackdropLayers();
  if (!layers) return { kind: "none" };
  // The store's optional dim rides along wherever the kind carries one.
  const dim = backdrop.dim !== undefined && backdrop.dim > 0 ? { dim: backdrop.dim } : {};
  if (backdrop.kind === "gradient") {
    const resolved = parseLayers(layers, isGradientValue);
    return resolved ? { kind: "gradient", id: backdrop.id, ...dim, resolved } : { kind: "none" };
  }
  if (backdrop.kind === "custom-gradient") {
    const resolved = parseLayers(layers, isGradientValue);
    return resolved ? { kind: "custom-gradient", light: backdrop.light, dark: backdrop.dark, ...dim, resolved } : { kind: "none" };
  }
  const resolved = parseLayers(layers, isSceneValue);
  if (!resolved) return { kind: "none" };
  const scene = readScene();
  return { kind: "scene", scene, images: readSceneImages(), ...dim, resolved };
}

export function newLookId(): string {
  return `look-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** A photograph of every store, right now. */
export function captureLook(label: string): Look {
  const appearance = parseAppearance(readKey(APPEARANCE_KEY));
  return {
    version: 1,
    id: newLookId(),
    label: label.trim().length > 0 ? label.trim() : "Untitled look",
    theme: captureTheme(),
    backdrop: captureBackdrop(),
    accent: appearance.accent,
    fontSans: appearance.fontSans,
    fontMono: appearance.fontMono,
    fontSansCustom: appearance.fontSansCustom,
    fontMonoCustom: appearance.fontMonoCustom,
    fontSize: appearance.fontSize,
    fontMonoSize: appearance.fontMonoSize,
    translucencyLevel: appearance.translucencyLevel,
  };
}

/* --------------------------------------------------------------- apply */

/**
 * The two theme writes a Look needs, handed in by the caller rather than
 * reimplemented: theme-palettes owns the compile and the CSS cache, and its
 * `write` is private for exactly that reason. The component passes
 * useThemeLibrary's own saveCustom and setActive straight through.
 */
export type ThemeWriter = {
  saveCustom: (theme: ThemeDefinition) => void;
  setActive: (id: string) => void;
  /** The library as it stands, so wearing a look that is already a theme can
   *  wear THAT theme instead of minting a copy of it. */
  themes: readonly ThemeDefinition[];
};

/** The custom theme a worn Look installs. Stable per Look, so wearing the same
 *  Look twice updates one library entry instead of breeding copies. */
export function lookThemeId(look: Look): string {
  return `look-${look.id}`;
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
  };
}

/**
 * Wear a Look: every store written, in the order that keeps the app coherent
 * if one of them fails — payloads first, then the choice that points at them
 * (backdrop.ts's own rule).
 *
 * Returns a message when part of the Look could not be worn — in practice a
 * scene or image that will not fit the quota — having already degraded that
 * part to no backdrop. Everything else still applied: a Look is worth wearing
 * without its wallpaper.
 */
export function applyLook(look: Look, theme: ThemeWriter, setAppearance: (patch: LookAppearance) => void): string | undefined {
  /**
   * WEARING SOMETHING THAT ALREADY EXISTS CREATES NOTHING.
   *
   * This used to mint a custom theme on every apply, keyed by the LOOK's id —
   * and a draft captured from the live stores gets a fresh id each time it is
   * captured, so pressing Apply twice left two library entries with the same
   * name and the same sixteen colours. Wearing the starters a few times was
   * enough to produce three separate themes called Dusk.
   *
   * So the palette is matched against the library first. An exact match is
   * worn directly; only genuinely new colours become a new entry. The id is
   * still the Look's when one is minted, which keeps the old promise that
   * re-applying the SAME look updates its entry rather than breeding.
   */
  const existing = matchThemeHalf(look.theme.light, theme.themes, "light");
  const sameDark = existing && matchThemeHalf(look.theme.dark, theme.themes, "dark")?.id === existing.id;
  if (existing && sameDark) {
    theme.setActive(existing.id);
    setAppearance(lookAppearance(look));
    return applyLookBackdrop(look.backdrop);
  }

  // The embedded halves become a real library theme, so the Look is editable
  // afterwards and the theme grid shows what is being worn.
  const id = lookThemeId(look);
  theme.saveCustom({ id, label: look.label, light: look.theme.light, dark: look.theme.dark });
  theme.setActive(id);

  setAppearance(lookAppearance(look));

  return applyLookBackdrop(look.backdrop);
}

/** Split out because it is the only part that can fail, and the only part with
 *  an ordering rule worth stating on its own. */
function applyLookBackdrop(backdrop: LookBackdrop): string | undefined {
  if (backdrop.kind === "none") {
    setBackdrop({ kind: "none" });
    return undefined;
  }
  const dim = backdrop.kind !== "image" && backdrop.dim !== undefined && backdrop.dim > 0 ? { dim: backdrop.dim } : {};
  if (backdrop.kind === "gradient") {
    setBackdrop({ kind: "gradient", id: backdrop.id, ...dim }, backdrop.resolved);
    return undefined;
  }
  if (backdrop.kind === "custom-gradient") {
    setBackdrop({ kind: "custom-gradient", light: backdrop.light, dark: backdrop.dark, ...dim }, backdrop.resolved);
    return undefined;
  }
  if (backdrop.kind === "image") {
    // The image BEFORE the choice: applyBackdrop drops the whole scene when
    // the key is missing, so a choice written first would flash a bare canvas.
    if (!storeBackdropImage(backdrop.image)) {
      setBackdrop({ kind: "none" });
      return "This look's image backdrop would not fit in storage; everything else was applied.";
    }
    setBackdrop({ kind: "image", fit: backdrop.fit, blur: backdrop.blur, dim: backdrop.dim });
    return undefined;
  }
  // A scene: the composer's source and its images, then the choice. The images
  // are the big write, so they go first and a failure stops before the choice.
  if (!writeSceneImages(backdrop.images) || !writeScene(backdrop.scene)) {
    setBackdrop({ kind: "none" });
    return "This look's scene would not fit in storage; everything else was applied.";
  }
  // A fresh stamp: the composition changed even though the choice did not, and
  // the stamp is what busts backdrop.ts's raw-string snapshot cache.
  setBackdrop({ kind: "scene", stamp: Date.now(), ...dim }, backdrop.resolved);
  return undefined;
}

/* -------------------------------------------------------------- storage */

/** Insert or replace by id, newest first — the same "refuse rather than
 *  silently evict" stance the rest of the pane takes: a full shelf is the
 *  reader's to tidy, not ours. Returns undefined when the cap is reached. */
export function upsertLook(looks: Look[], look: Look): Look[] | undefined {
  const existing = looks.findIndex((entry) => entry.id === look.id);
  if (existing >= 0) return looks.map((entry) => (entry.id === look.id ? look : entry));
  if (looks.length >= MAX_LOOKS) return undefined;
  return [look, ...looks];
}

export function readLooks(): Look[] {
  return parseLooks(readKey(LOOKS_KEY));
}

/**
 * THE SHELF IS A STORE, like every other value on this pane — but one that
 * re-reads localStorage only when something SAYS it changed, rather than on
 * every snapshot. The other stores hold a few hundred bytes and can afford to
 * getItem-and-compare per render; a shelf of Looks holds embedded scene images
 * and can be megabytes, so the version counter is what the snapshot is
 * compared against and the string is only pulled when it moves.
 */
const listeners = new Set<() => void>();
let version = 0;
let snapshotCache: { version: number; value: Look[] } | undefined;

/** Frozen and shared, because useSyncExternalStore compares by identity: a
 *  fresh [] per server render is an infinite render loop. */
const SERVER_LOOKS: Look[] = [];

function readSnapshot(): Look[] {
  if (!snapshotCache || snapshotCache.version !== version) snapshotCache = { version, value: readLooks() };
  return snapshotCache.value;
}

function subscribeToLooks(onChange: () => void): () => void {
  // Another tab's write arrives as a storage event and cannot bump our
  // counter, so the handler invalidates before it notifies.
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

/**
 * Write, or put the previous list back and say no — writeSceneImages's
 * contract, for the same reason: these carry embedded images, this IS the
 * write that meets the quota, and a half-saved shelf is worse than a refusal
 * the pane can show a line about.
 */
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
      // The restore can fail too; parseLooks is total, so the worst case is a
      // shorter shelf rather than a wedged pane.
    }
    return false;
  }
}

/** The named failures the pane shows inline, so the strings live beside the
 *  reasons rather than in the component. */
export const LOOKS_FULL_MESSAGE = `You can keep ${MAX_LOOKS} looks. Delete one to save another.`;
export const LOOKS_QUOTA_MESSAGE = "There is not enough browser storage left for this look — its backdrop images are large.";
