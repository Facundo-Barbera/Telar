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
  MAX_TRANSLUCENCY,
  MIN_FONT_SIZE,
  MIN_TRANSLUCENCY,
  type Accent,
  type MonoFont,
  type SansFont,
} from "./appearance";
import { composeGradient } from "./backdrop-presets";
import { captureLook, parseLook, type Look, type LookBackdrop } from "./looks";
import { composeScene, SCENE_LIMITS, type Scene } from "./scene-composer";
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
  patch: Partial<{ fontSans: SansFont; fontMono: MonoFont; fontSansCustom: string; fontMonoCustom: string; fontSize: number }>,
): StudioDraft {
  return {
    ...draft,
    ...(patch.fontSans ? { fontSans: patch.fontSans } : {}),
    ...(patch.fontMono ? { fontMono: patch.fontMono } : {}),
    ...(patch.fontSansCustom !== undefined ? { fontSansCustom: patch.fontSansCustom } : {}),
    ...(patch.fontMonoCustom !== undefined ? { fontMonoCustom: patch.fontMonoCustom } : {}),
    ...(patch.fontSize !== undefined ? { fontSize: clampInt(patch.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, draft.fontSize) } : {}),
  };
}

export function patchDraftStrength(draft: StudioDraft, level: number): StudioDraft {
  return { ...draft, translucencyLevel: clampInt(level, MIN_TRANSLUCENCY, MAX_TRANSLUCENCY, draft.translucencyLevel) };
}

export function replaceDraftBackdrop(draft: StudioDraft, backdrop: LookBackdrop): StudioDraft {
  return { ...draft, backdrop };
}

/**
 * The studio's Scene tool writes a ONE-LAYER scene, not a gradient choice: the
 * settings pane's composer edits `kind: "scene"` and nothing else, so a studio
 * that wrote `kind: "gradient"` would hand the reader a look the full composer
 * refuses to open. Returns undefined when the preset is not one this build has
 * — composeScene's own refusal, passed straight through rather than written as
 * a backdrop that paints nothing.
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

/* ------------------------------------------------- the chat's merge */

/**
 * A validated design folded INTO the draft rather than over it.
 *
 * The chat iterates: "warmer", "now try it at night" are edits to something
 * that already exists. So the palette and the label always land (they are what
 * the model was asked for), the accent and the backdrop land only when the
 * model offered one — `applyDesign` already degrades both to absent rather
 * than failing — and the members no design run can speak to (the typefaces,
 * the text size, the translucency strength) are never touched. Declining a
 * backdrop therefore KEEPS the draft's, which is the iterating reading of
 * "leave the backdrop alone"; clearing one is the Scene tool's job.
 */
export function mergeDesignIntoDraft(draft: StudioDraft, outcome: DesignSuccess): StudioDraft {
  const merged: StudioDraft = {
    ...draft,
    label: outcome.definition.label,
    theme: { light: { ...outcome.definition.light }, dark: { ...outcome.definition.dark } },
    ...(outcome.accent ? { accent: outcome.accent } : {}),
  };
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
  if (outcome.accent) notes.push(`${outcome.accent} accent`);
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
  const backdrop =
    draft.backdrop.kind === "none"
      ? "none"
      : draft.backdrop.kind === "image"
        ? "a photograph (leave it alone unless asked to replace it)"
        : `${draft.backdrop.kind}: ${draft.backdrop.resolved.light}`;
  return [
    `Name: ${draft.label}`,
    `Accent: ${draft.accent}`,
    `Light half: ${half("light")}`,
    `Dark half: ${half("dark")}`,
    `Backdrop: ${backdrop}`,
  ].join("\n");
}

/**
 * The designer's brief, plus the draft it is editing.
 *
 * `buildDesignPrompt` is reused verbatim — one brief describing what the
 * sixteen tokens mean, one set of lightness rules — and the studio adds only
 * the thing that makes this a CONVERSATION rather than a series of unrelated
 * one-shots: the current draft, and an instruction to change it rather than
 * start over. The instruction rides in as the brief so a first message with no
 * draft history still reads exactly like the settings pane's designer.
 */
export function buildStudioPrompt(draft: StudioDraft, instruction: string, buildBase: (brief: string) => string): string {
  return [
    buildBase(instruction),
    "",
    "YOU ARE EDITING AN EXISTING DRAFT, NOT STARTING OVER. Below is the draft as it stands. Apply the brief as a CHANGE to it: keep everything the brief does not speak to — hues, relative lightnesses, the backdrop — and answer with the complete edited theme (the schema still requires every token).",
    "",
    describeDraft(draft),
  ].join("\n");
}

