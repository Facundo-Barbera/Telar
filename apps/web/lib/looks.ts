"use client";

/**
 * LOOKS — the whole appearance as one shareable thing.
 *
 * A look is a COMPOSITION (lib/composition.ts: what the app looks like, in both
 * colour states) plus the scalar taste that lives beside it — the accent, the
 * two typefaces, their sizes, how much shows through, and how far the elevation
 * ladder travels. Capture takes a photograph of both stores, apply writes them
 * both back, and one JSON file carries the pair to another machine.
 *
 * THE GALLERY IS THE ONLY PRESET SYSTEM (#471). There used to be a second one
 * underneath: a library of THEMES, which a look referenced by embedding two
 * concrete halves so the reference could not dangle. There is no theme object
 * any more — a look carries the composition itself, which is the thing that
 * paints — so wearing one no longer installs anything anywhere, and the whole
 * "does this palette already exist in the library?" dance is gone with the
 * library.
 *
 * WHY `translucent` IS NOT IN A LOOK, BUT `translucencyLevel` IS. The on/off
 * toggle is a property of the MACHINE, not of the taste: it only exists inside
 * the desktop shell, it requires macOS, turning it on REBUILDS the window
 * (transparency is decided at window creation), and the shell keeps its own
 * authoritative copy in ui-prefs.json which wins on entry (see
 * appearance-section.tsx). A Look imported into a browser tab that flipped it
 * would either do nothing or, in the desktop app, silently rebuild someone's
 * window as a side effect of trying a colour scheme. The STRENGTH is pure taste
 * — how much shows through — and it is also read by the backdrop wash in a
 * plain browser tab, so it travels.
 *
 * PARSING IS TOTAL, like every store this file touches: an unreadable member
 * degrades to a default rather than throwing, and a look written before
 * compositions existed is MIGRATED on the way in rather than refused
 * (`parseLook` in @telar/engine-client, which is also where the shape lives —
 * a Look is no longer only a file: the cockpit PUBLISHES one to the engine so a
 * paired client can wear the host's look, and the reader on the other end needs
 * the same types and the same total, gated parse). What stayed here is
 * everything that needs a browser: capture from the live stores, apply back
 * into them, the shelf and its quota.
 */

import { useSyncExternalStore } from "react";
import { parseLook as parseLookValue, type Composition, type Look } from "@telar/engine-client";
import { parseAppearance, type Appearance } from "./appearance";
import { currentComposition, strandedTones, writeComposition } from "./composition";
import { SCENE_PRESETS } from "./scene-composer";

export { parseThemeHalf, type Look, type LookBackdrop } from "@telar/engine-client";

/* ------------------------------------------------------------- the keys */

/** Where the saved Looks live. */
export const LOOKS_KEY = "telar-looks";

/**
 * appearance.ts keeps its storage key private — it is an implementation detail
 * of a store that owns every write to it. This file only ever READS it
 * (capture), and writes it through that module's own function, so the literal
 * is restated here rather than widening its public surface with a key nobody
 * else should be setting.
 */
const APPEARANCE_KEY = "telar-appearance";

/**
 * Twelve. A Look with a composed scene carries up to six layer images plus
 * their un-faded originals, so a dozen of them is already more than a
 * localStorage origin will hold — the cap is about keeping the list readable;
 * the QUOTA is what actually refuses, and it refuses by measuring, below.
 */
export const MAX_LOOKS = 12;

/* ------------------------------------------------------------- the shape */

/** What a Look sets on the appearance store — every taste member, and
 *  pointedly not `translucent` or `frost` (see the header). */
export type LookAppearance = Pick<
  Appearance,
  "accent" | "fontSans" | "fontMono" | "fontSansCustom" | "fontMonoCustom" | "fontSize" | "fontMonoSize" | "translucencyLevel" | "depth"
>;

/* ---------------------------------------------------------- total parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shared parser, wearing THIS build's gradient preset table — the moved
 *  parsers are deliberately ignorant of which presets exist (see scene-composer
 *  for why), and this is the one place the cockpit supplies them. */
export function parseLook(value: unknown): Look | undefined {
  return parseLookValue(value, SCENE_PRESETS);
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

export function newLookId(): string {
  return `look-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** A photograph of both stores, right now. */
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

/* --------------------------------------------------------------- apply */

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

/** The named failure a wear can meet, so the string lives beside its reason
 *  rather than in the component. */
export const LOOK_QUOTA_MESSAGE = "This look's layer images would not fit in storage; everything else was applied.";

/**
 * THE OTHER THING A WEAR CAN COST, and the only one the wearer must hear about
 * (#705).
 *
 * A Look's card is mixed into every semantic tint, and the ink standing on that
 * fill is made of the same token. `compileComposition` moves the ink when the
 * card requires it — invisibly, and correctly, because nobody chose the ink —
 * so a repaired tone is NOT news. What is news is a card sitting on the ink's
 * own lightness: there the fill has nowhere to go, the repair changes nothing
 * on purpose, and a tone stays hard to read. That is worth a sentence, and it
 * is the only case that gets one.
 */
export function lookTintMessage(tones: readonly string[]): string {
  const named = tones.length === 1 ? tones[0] : `${tones.slice(0, -1).join(", ")} and ${tones[tones.length - 1]}`;
  return `This look's card sits too close to the ${named} colour${tones.length === 1 ? "" : "s"}, so ${tones.length === 1 ? "that tint" : "those tints"} will be hard to read. Nothing was changed for ${tones.length === 1 ? "it" : "them"}.`;
}

/**
 * Wear a Look: the composition, then everything beside it.
 *
 * Returns a message when part of it could not be worn — layer images that will
 * not fit the quota, which leaves the composition it came with unwritten and
 * the previous one standing (everything else still applies: a look is worth
 * wearing without its wallpaper), and a card the tint repair could not answer.
 * Both can be true at once, so they are joined rather than ranked.
 */
export function applyLook(look: Look, setAppearance: (patch: LookAppearance) => void): string | undefined {
  const stored = writeComposition(look.composition, look.images);
  setAppearance(lookAppearance(look));
  const notices: string[] = [];
  if (!stored) notices.push(LOOK_QUOTA_MESSAGE);
  const stranded = strandedTones(look.composition);
  if (stranded.length > 0) notices.push(lookTintMessage(stranded));
  return notices.length > 0 ? notices.join(" ") : undefined;
}

/** Does the window have this look's colours on? Compared by the COMPOSITION
 *  rather than by an id: the gallery's own entries are rebuilt every load and
 *  a saved card may hold the same composition under another name, so the
 *  honest question is "is this what is painted", not "is this the id". */
export function sameComposition(a: Composition, b: Composition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
 * Write, or put the previous list back and say no — writeComposition's
 * contract, for the same reason: these carry embedded images, this IS the write
 * that meets the quota, and a half-saved shelf is worse than a refusal the pane
 * can show a line about.
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
export const LOOKS_QUOTA_MESSAGE = "There is not enough browser storage left for this look — its layer images are large.";
