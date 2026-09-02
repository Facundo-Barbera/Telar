"use client";

/**
 * THE STUDIO DRAFT — a Look nobody is wearing yet.
 *
 * The Appearance pane's controls all write THROUGH to the live stores: click a
 * theme and the window retints under you. That is the right behaviour for
 * tweaking and the wrong one for DESIGNING, where half the value is trying
 * something ugly without having to live in it. So the studio edits a draft,
 * and the draft is not a parallel model of the appearance — it IS a `Look`
 * (lib/looks.ts), the same bundle the Looks shelf saves and shares, simply one
 * that has not been through `applyLook` yet. Apply is therefore not a
 * conversion; it is `applyLook` on a value that was already the right type.
 *
 * THE UPDATERS ARE PURE — a new draft out for a draft in, which is what lets
 * the studio keep an undo history of plain values and lets the chat merge be
 * a function rather than a sequence of setState calls. The only impure code
 * here is the storage edge: `newDraftFromCurrent` (reads the stores) and the
 * persistence block (the draft and transcript surviving navigation).
 *
 * There is no mock stage any more — the draft is previewed on the document
 * itself (lib/studio-preview.ts), so this file no longer restates accent hues
 * or compiles per-container variables.
 */

import {
  MAX_FONT_SIZE,
  MAX_MONO_FONT_SIZE,
  MAX_TRANSLUCENCY,
  MIN_FONT_SIZE,
  MIN_MONO_FONT_SIZE,
  MIN_TRANSLUCENCY,
  type Accent,
  type MonoFont,
  type SansFont,
} from "./appearance";
import { isGradientValue, MAX_BACKDROP_BLUR, MAX_BACKDROP_DIM, type BackdropFit } from "./backdrop";
import {
  backdropPresetById,
  composeGradient,
  DEFAULT_CUSTOM_GRADIENT,
  parseGradient,
  type CustomGradientSpec,
} from "./backdrop-presets";
import { captureLook, parseLook, type Look, type LookBackdrop } from "./looks";
import { composeScene, pruneSceneImages, SCENE_LIMITS, type Scene } from "./scene-composer";
import { concreteHalf, cssColorToHex, THEME_TOKENS, type ThemeDefinition, type ThemeToken } from "./theme-palettes";
import type { DesignSuccess } from "./theme-designer";

/** The draft IS a Look — see the header. The alias exists so the studio's own
 *  files can say what they mean without implying a second shape. */
export type StudioDraft = Look;

export type StudioMode = "light" | "dark";

/* --------------------------------------------------------------- opening */

/** A draft that starts where the reader already is: their whole current look,
 *  photographed. Impure — it reads the stores. */
export function newDraftFromCurrent(label = "New look"): StudioDraft {
  return captureLook(label);
}

/**
 * A saved Look opened INTO the studio — the id survives, which is the whole
 * point: Save updates the card it came from instead of breeding a copy, and
 * Apply installs the same `look-<id>` theme wearing it directly would. The
 * halves are copied because the updaters spread them; everything else is
 * replaced wholesale when edited.
 */
export function draftFromLook(look: Look): StudioDraft {
  return { ...look, theme: { light: { ...look.theme.light }, dark: { ...look.theme.dark } } };
}

/**
 * A library theme loaded into the draft — the library is where a palette comes
 * FROM now, not a switch that retints the app under the studio. Both halves
 * land concrete; the draft keeps its backdrop, accent and type, because a
 * palette is not a whole look.
 */
export function loadThemeIntoDraft(draft: StudioDraft, theme: ThemeDefinition): StudioDraft {
  return { ...draft, label: theme.label, theme: { light: concreteHalf(theme, "light"), dark: concreteHalf(theme, "dark") } };
}

/** One half from one theme — the orb click, drafted: Ember's day over the
 *  draft's night. */
export function loadThemeHalfIntoDraft(draft: StudioDraft, mode: StudioMode, theme: ThemeDefinition): StudioDraft {
  return { ...draft, theme: { ...draft.theme, [mode]: concreteHalf(theme, mode) } };
}

/* ---------------------------------------------------------- persistence */

/**
 * THE DRAFT SURVIVES NAVIGATION. The studio used to hold its draft in
 * component state, and clicking any other settings section unmounted the pane
 * and threw a ten-minute design away without a word. So the draft is written
 * through to storage (a draft IS a Look, so parseLook already knows how to
 * read it back — id included, which is what keeps "Save" updating the same
 * shelf card across a reload), and the transcript beside it, because the
 * record of what was asked for is how you pick a conversation back up.
 *
 * A quota refusal is swallowed: the in-memory draft keeps working for this
 * visit, and losing persistence is strictly better than losing the draft.
 */
export const STUDIO_DRAFT_KEY = "telar-studio-draft";
export const STUDIO_CHAT_KEY = "telar-studio-chat";

/** What one transcript line needs to survive a reload. The component adds its
 *  own render-only ids back on read. */
export type StudioChatLine = { kind: "you" | "studio" | "trouble"; text: string };

const CHAT_KINDS = ["you", "studio", "trouble"] as const;
const MAX_CHAT_LINES = 200;
const MAX_CHAT_TEXT = 4000;

export function readStudioDraft(): StudioDraft | undefined {
  try {
    const raw = window.localStorage.getItem(STUDIO_DRAFT_KEY);
    if (raw === null) return undefined;
    return parseLook(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function writeStudioDraft(draft: StudioDraft | undefined): void {
  try {
    if (draft === undefined) window.localStorage.removeItem(STUDIO_DRAFT_KEY);
    else window.localStorage.setItem(STUDIO_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota or private browsing — see the header.
  }
}

export function readStudioChat(): StudioChatLine[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STUDIO_CHAT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const lines: StudioChatLine[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const { kind, text } = entry as Record<string, unknown>;
      if (!(CHAT_KINDS as readonly unknown[]).includes(kind) || typeof text !== "string") continue;
      lines.push({ kind: kind as StudioChatLine["kind"], text: text.slice(0, MAX_CHAT_TEXT) });
      if (lines.length === MAX_CHAT_LINES) break;
    }
    return lines;
  } catch {
    return [];
  }
}

export function writeStudioChat(lines: StudioChatLine[]): void {
  try {
    if (lines.length === 0) window.localStorage.removeItem(STUDIO_CHAT_KEY);
    else window.localStorage.setItem(STUDIO_CHAT_KEY, JSON.stringify(lines.slice(-MAX_CHAT_LINES)));
  } catch {
    // Same contract as the draft: the conversation keeps working unsaved.
  }
}

/* -------------------------------------------------------------- updaters */

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function setDraftLabel(draft: StudioDraft, label: string): StudioDraft {
  return { ...draft, label };
}

/** One surface token in one half. The other half is untouched: a studio that
 *  mirrored edits across both would make the light/dark toggle a lie. */
export function patchDraftToken(draft: StudioDraft, mode: StudioMode, token: ThemeToken, value: string): StudioDraft {
  return { ...draft, theme: { ...draft.theme, [mode]: { ...draft.theme[mode], [token]: value } } };
}

/** Every half of a half at once — what the chat's merge writes. */
export function patchDraftHalf(draft: StudioDraft, mode: StudioMode, half: Look["theme"]["light"]): StudioDraft {
  return { ...draft, theme: { ...draft.theme, [mode]: { ...half } } };
}

export function patchDraftAccent(draft: StudioDraft, accent: Accent): StudioDraft {
  return { ...draft, accent };
}

/** The type and size members, clamped to the same bounds the appearance store
 *  enforces — a draft that could hold a 40px root would only be refused later. */
export function patchDraftType(
  draft: StudioDraft,
  patch: Partial<{ fontSans: SansFont; fontMono: MonoFont; fontSansCustom: string; fontMonoCustom: string; fontSize: number; fontMonoSize: number }>,
): StudioDraft {
  return {
    ...draft,
    ...(patch.fontSans ? { fontSans: patch.fontSans } : {}),
    ...(patch.fontMono ? { fontMono: patch.fontMono } : {}),
    ...(patch.fontSansCustom !== undefined ? { fontSansCustom: patch.fontSansCustom } : {}),
    ...(patch.fontMonoCustom !== undefined ? { fontMonoCustom: patch.fontMonoCustom } : {}),
    ...(patch.fontSize !== undefined ? { fontSize: clampInt(patch.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, draft.fontSize) } : {}),
    ...(patch.fontMonoSize !== undefined ? { fontMonoSize: clampInt(patch.fontMonoSize, MIN_MONO_FONT_SIZE, MAX_MONO_FONT_SIZE, draft.fontMonoSize) } : {}),
  };
}

export function patchDraftStrength(draft: StudioDraft, level: number): StudioDraft {
  return { ...draft, translucencyLevel: clampInt(level, MIN_TRANSLUCENCY, MAX_TRANSLUCENCY, draft.translucencyLevel) };
}

export function replaceDraftBackdrop(draft: StudioDraft, backdrop: LookBackdrop): StudioDraft {
  return { ...draft, backdrop };
}

/**
 * A preset as a ONE-LAYER SCENE rather than as a gradient choice — the shape a
 * compact preset grid wants, where every pick has to be reopenable by the full
 * composer. The Backdrop tool's own gallery writes `kind: "gradient"` instead
 * (see presetBackdrop below), because there a preset IS the whole choice and
 * Compose is a tab away; this stays for grids that only offer presets.
 * Returns undefined when the preset is not one this build has — composeScene's
 * own refusal, passed straight through rather than written as a backdrop that
 * paints nothing.
 */
export function scenePresetBackdrop(presetId: string, opacity: number): LookBackdrop | undefined {
  const scene: Scene = {
    layers: [{ type: "gradient", presetId, opacity: clampInt(opacity, SCENE_LIMITS.opacity.min, SCENE_LIMITS.opacity.max, 100) }],
  };
  const resolved = composeScene(scene, {});
  return resolved ? { kind: "scene", scene, images: {}, resolved } : undefined;
}

/** The preset and fade a one-gradient scene draft is showing, so the tool can
 *  reopen on what the draft holds rather than on its own default. Undefined
 *  for every other backdrop — an image or a four-layer collage is not a thing
 *  this compact control can represent, and pretending otherwise would silently
 *  flatten it on the next click. */
export function draftScenePreset(draft: StudioDraft): { presetId: string; opacity: number } | undefined {
  if (draft.backdrop.kind !== "scene") return undefined;
  const layers = draft.backdrop.scene.layers;
  const only = layers.length === 1 ? layers[0] : undefined;
  if (!only || only.type !== "gradient") return undefined;
  return { presetId: only.presetId, opacity: only.opacity };
}

/* --------------------------------------- the backdrop tool's constructors */

/**
 * THE FOUR WAYS TO BUILD A BACKDROP, as pure functions.
 *
 * The backdrop editors are CONTROLLED: they are handed a LookBackdrop and hand
 * one back, and nothing they touch writes a store. That only works if every
 * kind can be built in one go — the choice, the RESOLVED CSS the preview and
 * the pre-paint script paint from, and any payload (an image, a scene's
 * layers) that lives nowhere else. So the constructors live here, beside the
 * draft they feed, rather than inside a component where they could not be
 * tested without a DOM.
 *
 * THEY REFUSE RATHER THAN RETURN SOMETHING BLANK. Every one of them ends at
 * the store's own gate — isGradientValue, isSceneValue via composeScene, or
 * the `data:image/` prefix — and returns undefined when the value would not
 * pass. A caller that gets undefined leaves the backdrop already on screen
 * alone, which is the only outcome that is never a surprise.
 */

/** A crafted preset. Its two halves ARE the resolved CSS — backdrop-presets.ts
 *  authors finished `background-image` values — so nothing is composed here;
 *  the id rides along so the gallery still shows which tile is chosen. */
export function presetBackdrop(presetId: string): LookBackdrop | undefined {
  const preset = backdropPresetById(presetId);
  if (!preset || !isGradientValue(preset.light) || !isGradientValue(preset.dark)) return undefined;
  return { kind: "gradient", id: preset.id, resolved: { light: preset.light, dark: preset.dark } };
}

/** BOTH halves of a hand-rolled gradient. The editor only shows one half at a
 *  time (the pane's Light/Dark toggle decides which), but a backdrop choice is
 *  a pair — the scheme can flip under it — so both are always carried. */
export type GradientPair = { light: CustomGradientSpec; dark: CustomGradientSpec };

export function customGradientBackdrop(pair: GradientPair): LookBackdrop | undefined {
  const light = composeGradient(pair.light);
  const dark = composeGradient(pair.dark);
  if (!isGradientValue(light) || !isGradientValue(dark)) return undefined;
  // The choice and the resolved layers are the same two strings for this kind;
  // both are stored because applyLook writes them to two different keys.
  return { kind: "custom-gradient", light, dark, resolved: { light, dark } };
}

/** The stops a draft's custom gradient is made of, so the editor reopens on
 *  what is painted rather than on its defaults. parseGradient recognises only
 *  composeGradient's own output, so anything else — a preset, a hand-edited
 *  value — opens on the defaults instead. */
export function draftGradientPair(backdrop: LookBackdrop): GradientPair {
  if (backdrop.kind !== "custom-gradient") return { ...DEFAULT_CUSTOM_GRADIENT };
  return {
    light: parseGradient(backdrop.light) ?? DEFAULT_CUSTOM_GRADIENT.light,
    dark: parseGradient(backdrop.dark) ?? DEFAULT_CUSTOM_GRADIENT.dark,
  };
}

/** A little dim by default: an untouched photograph behind text is a
 *  legibility problem, and 20% is the smallest amount that reliably is not. */
export const DEFAULT_IMAGE_DIM = 20;

/**
 * A photograph, as a data URL INSIDE the draft — not in BACKDROP_IMAGE_KEY.
 * That is the whole difference from the old live picker: a draft nobody has
 * applied must not have already replaced the image the reader is wearing, so
 * the pixels travel in the value and only reach storage through applyLook.
 * Replacing a picture KEEPS its tuning: you chose that blur for a reason.
 */
export function imageBackdrop(image: string, previous?: LookBackdrop): LookBackdrop | undefined {
  if (!image.startsWith("data:image/")) return undefined;
  const kept = previous?.kind === "image" ? previous : undefined;
  return { kind: "image", image, fit: kept?.fit ?? "cover", blur: kept?.blur ?? 0, dim: kept?.dim ?? DEFAULT_IMAGE_DIM };
}

/** Fit, blur and dim, clamped to the bounds the backdrop store enforces — a
 *  draft that could hold a 90px blur would only be clamped later. A patch
 *  against any other kind is a no-op rather than a coercion. */
export function patchImageBackdrop(
  backdrop: LookBackdrop,
  patch: Partial<{ fit: BackdropFit; blur: number; dim: number }>,
): LookBackdrop {
  if (backdrop.kind !== "image") return backdrop;
  return {
    ...backdrop,
    ...(patch.fit ? { fit: patch.fit } : {}),
    ...(patch.blur !== undefined ? { blur: clampInt(patch.blur, 0, MAX_BACKDROP_BLUR, backdrop.blur) } : {}),
    ...(patch.dim !== undefined ? { dim: clampInt(patch.dim, 0, MAX_BACKDROP_DIM, backdrop.dim) } : {}),
  };
}

/** A composed stack. The images are PRUNED to what the layers still refer to,
 *  because a draft carries its images by value and a removed layer's megabyte
 *  would otherwise ride along in every save and every export. */
export function sceneBackdrop(scene: Scene, images: Record<string, string>): LookBackdrop | undefined {
  const kept = pruneSceneImages(scene, images);
  const resolved = composeScene(scene, kept);
  return resolved ? { kind: "scene", scene, images: kept, resolved } : undefined;
}

/**
 * The stack the composer opens on. A scene is itself; a GRADIENT PRESET
 * becomes the single bottom layer it already is, so moving a preset into
 * Compose starts from the picture you were looking at rather than from a blank
 * stage. Everything else opens empty — an empty stack composes to nothing, so
 * the draft's backdrop is left alone until a layer is actually added.
 */
export function draftSceneStack(backdrop: LookBackdrop): { scene: Scene; images: Record<string, string> } {
  if (backdrop.kind === "scene") return { scene: backdrop.scene, images: backdrop.images };
  if (backdrop.kind === "gradient") {
    return { scene: { layers: [{ type: "gradient", presetId: backdrop.id, opacity: SCENE_LIMITS.opacity.max }] }, images: {} };
  }
  return { scene: { layers: [] }, images: {} };
}

/* ------------------------------------------------- the chat's merge */

/**
 * A validated design folded into the draft as a THREE-WAY MERGE.
 *
 * The model was shown a SNAPSHOT of the draft and answered with a complete
 * theme; by the time the answer lands (five to sixty seconds later) the reader
 * may have hand-edited tokens, renamed the look, or swapped the backdrop. The
 * old merge overwrote all of that with the model's copy — the model's answer
 * silently reverted every edit made during the wait, and every turn clobbered
 * the label. So each member now lands only where the model actually CHANGED
 * it relative to the snapshot it saw:
 *
 *   token: model's value ≠ what the snapshot showed it → the model meant to
 *   move it, take the model's; otherwise keep whatever `current` holds — the
 *   unchanged original, or the reader's mid-flight edit.
 *
 * Tokens are compared through the same hex serialisation the prompt used
 * (`describeDraft` shows the model hex), so an untouched oklch token is not
 * mistaken for a change merely because the model echoed it back as hex.
 */
export function mergeDesignIntoDraft(current: StudioDraft, snapshot: StudioDraft, outcome: DesignSuccess): StudioDraft {
  const half = (mode: StudioMode): Look["theme"]["light"] => {
    const merged = { ...current.theme[mode] };
    for (const token of THEME_TOKENS) {
      const answered = outcome.definition[mode][token];
      if (answered.toLowerCase() !== cssColorToHex(snapshot.theme[mode][token]).toLowerCase()) merged[token] = answered;
    }
    return merged;
  };
  const merged: StudioDraft = {
    ...current,
    theme: { light: half("light"), dark: half("dark") },
    // The label moves only when the model renamed it — a look the reader
    // titled in the header keeps that title through "warmer".
    ...(outcome.definition.label !== snapshot.label ? { label: outcome.definition.label } : {}),
    ...(outcome.accent && outcome.accent !== snapshot.accent ? { accent: outcome.accent } : {}),
    ...(outcome.fontSans ? { fontSans: outcome.fontSans } : {}),
    ...(outcome.fontMono ? { fontMono: outcome.fontMono } : {}),
    ...(outcome.fontSize !== undefined ? { fontSize: outcome.fontSize } : {}),
  };
  if (outcome.removeBackdrop) return { ...merged, backdrop: { kind: "none" } };
  if (!outcome.backdropSpec) return merged;
  const light = composeGradient(outcome.backdropSpec.light);
  const dark = composeGradient(outcome.backdropSpec.dark);
  return { ...merged, backdrop: { kind: "custom-gradient", light, dark, resolved: { light, dark } } };
}

/** The transcript line a merge earns: what it is now called, and what changed
 *  beyond the palette. Reads as a sentence rather than a diff. */
export function designSummary(outcome: DesignSuccess): string {
  const notes: string[] = ["new palette"];
  if (outcome.backdropSpec) notes.push("a fresh gradient backdrop");
  if (outcome.removeBackdrop) notes.push("backdrop cleared");
  if (outcome.accent) notes.push(`${outcome.accent} accent`);
  if (outcome.fontSans || outcome.fontMono) notes.push("new type");
  if (outcome.fontSize !== undefined) notes.push(`${outcome.fontSize}px text`);
  return `Drafted “${outcome.definition.label}” — ${notes.join(", ")}.`;
}

/* ------------------------------------------------- the chat's prompt */

/**
 * The draft as the model sees it. Hex rather than the stored value because the
 * brief asks for `#RRGGBB` and a prompt that shows oklch would be teaching the
 * model a format its schema forbids.
 */
export function describeDraft(draft: StudioDraft): string {
  const half = (mode: StudioMode) => THEME_TOKENS.map((token) => `${token}=${cssColorToHex(draft.theme[mode][token])}`).join(" ");
  // Bounded: a composed scene's resolved CSS embeds data URLs and can be
  // megabytes — the daemon refuses prompts over 20k characters, so the model
  // gets a description, never the pixels.
  const css = (value: string) => (value.length > 400 ? `${value.slice(0, 400)}… (${draft.backdrop.kind}, truncated)` : value);
  const backdrop =
    draft.backdrop.kind === "none"
      ? "none"
      : draft.backdrop.kind === "image"
        ? "a photograph (leave it alone unless asked to replace it)"
        : draft.backdrop.kind === "scene"
          ? "a composed scene of layered images and gradients (leave it alone unless asked)"
          : `${draft.backdrop.kind} — light: ${css(draft.backdrop.resolved.light)} | dark: ${css(draft.backdrop.resolved.dark)}`;
  const fonts = `${draft.fontSans === "custom" ? draft.fontSansCustom || "custom" : draft.fontSans} / ${draft.fontMono === "custom" ? draft.fontMonoCustom || "custom" : draft.fontMono} mono`;
  return [
    `Name: ${draft.label}`,
    `Accent: ${draft.accent}`,
    `Type: ${fonts}, ${draft.fontSize}px root, ${draft.fontMonoSize}px code`,
    `Light half: ${half("light")}`,
    `Dark half: ${half("dark")}`,
    `Backdrop: ${backdrop}`,
  ].join("\n");
}

/** What the studio can add around the brief: which scheme the reader is
 *  judging the draft in, and the recent conversation. */
export type StudioPromptContext = {
  mode?: StudioMode;
  /** Recent transcript lines, oldest first — what gives "like the last one
   *  but colder" something to refer to. */
  history?: StudioChatLine[];
};

/** How much conversation rides along. Enough to refer back a few turns;
 *  bounded because the daemon caps the whole prompt at 20k characters. */
const HISTORY_LINES = 10;
const HISTORY_LINE_CHARS = 300;

/**
 * The designer's brief, plus the draft it is editing, plus the conversation
 * so far.
 *
 * `buildDesignPrompt` is reused verbatim — one brief describing what the
 * sixteen tokens mean, one set of lightness rules — and the studio adds what
 * makes this a CONVERSATION rather than a series of unrelated one-shots: the
 * current draft, the recent transcript (standing constraints like "keep the
 * borders hairline" used to evaporate every turn because the model only ever
 * saw the pixels), and which scheme the reader is looking at.
 */
export function buildStudioPrompt(
  draft: StudioDraft,
  instruction: string,
  buildBase: (brief: string) => string,
  context: StudioPromptContext = {},
): string {
  const history = (context.history ?? [])
    .filter((line) => line.kind !== "trouble")
    .slice(-HISTORY_LINES)
    .map((line) => `${line.kind === "you" ? "READER" : "YOU"}: ${line.text.slice(0, HISTORY_LINE_CHARS)}`);
  return [
    buildBase(instruction),
    "",
    "YOU ARE EDITING AN EXISTING DRAFT, NOT STARTING OVER. Below is the draft as it stands. Apply the brief as a CHANGE to it: keep everything the brief does not speak to — hues, relative lightnesses, the name, the backdrop — and answer with the complete edited theme (the schema still requires every token). Instructions from earlier in the conversation still stand unless the reader reverses them.",
    ...(context.mode ? ["", `The reader is judging the draft in its ${context.mode} half right now.`] : []),
    ...(history.length > 0 ? ["", "THE CONVERSATION SO FAR:", ...history] : []),
    "",
    describeDraft(draft),
  ].join("\n");
}

