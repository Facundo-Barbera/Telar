/**
 * THE DEFAULTS — "there should be default settings for the composer".
 *
 * They are a TABLE this build rebuilds every load rather than anything stored,
 * so what is worth pinning is that every one of them is a look the composer can
 * actually wear: a base the derivation reads as a colour, layers that compose,
 * and a palette that stays readable. A default that paints nothing is the worst
 * kind of bug here, because the gallery is where a first-time reader starts.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { parseLook, THEME_TOKENS } from "@telar/engine-client";
import { BUILT_IN_LOOKS, BUILT_IN_NOTES, BUILT_IN_PREFIX, builtInComposition, isBuiltInLook } from "./built-in-looks";
import { composeComposition, MODES } from "./composition";
import { halfFor, halfFromBase } from "./palette-from-image";
import { SCENE_PRESETS } from "./scene-composer";
import { FOREGROUND_SURFACES, cssColorToHex, TELAR_DARK, TELAR_LIGHT } from "./theme-palettes";
import { contrastRatio, parseVsCodeColor } from "./vscode-theme-import";

describe("the table", () => {
  test("the identity look leads, because a gallery that opened on a wallpaper would teach that a look is one", () => {
    expect(BUILT_IN_LOOKS[0]?.label).toBe("Telar");
    expect(BUILT_IN_LOOKS[0]?.composition.light.layers).toEqual([]);
  });

  test("every id is unique and marked as a built-in", () => {
    const ids = BUILT_IN_LOOKS.map((look) => look.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const look of BUILT_IN_LOOKS) {
      expect(look.id.startsWith(BUILT_IN_PREFIX), look.id).toBe(true);
      expect(isBuiltInLook(look), look.id).toBe(true);
    }
  });

  test("every label is unique — two rows with one name is a gallery nobody can read", () => {
    const labels = BUILT_IN_LOOKS.map((look) => look.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("every one carries the note the gallery shows instead of a layer count", () => {
    for (const look of BUILT_IN_LOOKS) {
      expect(BUILT_IN_NOTES[look.id], look.id).toBeTruthy();
    }
  });

  /** The identity look IS the default composition, which is what makes "wear
   *  Telar" and "a fresh install" the same state rather than two near-misses. */
  test("Telar's own base derives Telar's own palette, untouched", () => {
    const telar = BUILT_IN_LOOKS[0]!;
    expect(halfFor(telar.composition.light, "light")).toEqual(TELAR_LIGHT);
    expect(halfFor(telar.composition.dark, "dark")).toEqual(TELAR_DARK);
  });
});

describe("every default is wearable", () => {
  test("nothing is pinned by hand — a default is a starting point, not sixteen literals", () => {
    for (const look of BUILT_IN_LOOKS) {
      for (const mode of MODES) {
        expect(look.composition[mode].overrides, `${look.id} ${mode}`).toEqual({});
      }
    }
  });

  test("every base is a colour the derivation can actually read", () => {
    for (const look of BUILT_IN_LOOKS) {
      for (const mode of MODES) {
        const base = look.composition[mode].base;
        expect(cssColorToHex(base), `${look.id} ${mode}`).toMatch(/^#[\da-f]{6}$/);
        expect(cssColorToHex(base), `${look.id} ${mode} fell through to grey`).not.toBe("#808080");
      }
    }
  });

  test("a tinted default actually moves off the neutral it started from", () => {
    // A base under the saturation floor derives Telar itself — correct for the
    // identity look and a silent failure for any other.
    for (const look of BUILT_IN_LOOKS.slice(1)) {
      expect(halfFromBase(look.composition.light.base, "light"), look.id).not.toEqual(TELAR_LIGHT);
    }
  });

  /** The owner's derivation test, applied to the shipped table rather than to a
   *  hue wheel: a default that is not readable is one nobody can use. */
  test("every default keeps every foreground readable, in both states", () => {
    for (const look of BUILT_IN_LOOKS) {
      for (const mode of MODES) {
        const half = halfFor(look.composition[mode], mode);
        for (const [text, surface] of FOREGROUND_SURFACES) {
          const fg = parseVsCodeColor(cssColorToHex(half[text]));
          const bg = parseVsCodeColor(cssColorToHex(half[surface]));
          expect(contrastRatio(fg!, bg!), `${look.id} ${mode} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  /** A recipe naming a preset this build dropped is skipped at load, so any
   *  look that IS here composes — and a flat one composes to nothing on
   *  purpose, which is what "no backdrop" means. */
  test("every scenic default composes to something paintable, and a flat one to nothing", () => {
    for (const look of BUILT_IN_LOOKS) {
      const composed = composeComposition(look.composition, look.images);
      const flat = look.composition.light.layers.length === 0 && look.composition.dark.layers.length === 0;
      if (flat) expect(composed, look.id).toBeNull();
      else expect(composed, look.id).not.toBeNull();
    }
  });

  /** They go over the wire and into files, so they have to survive the same
   *  total, gated parse anything else does. */
  test("every default round-trips through the Look parser unchanged", () => {
    for (const look of BUILT_IN_LOOKS) {
      expect(parseLook(JSON.parse(JSON.stringify(look)), SCENE_PRESETS), look.id).toEqual(look);
    }
  });

  test("every token of every default is a value a stylesheet will accept", () => {
    for (const look of BUILT_IN_LOOKS) {
      for (const mode of MODES) {
        const half = halfFor(look.composition[mode], mode);
        for (const token of THEME_TOKENS) {
          expect(half[token], `${look.id} ${mode} ${token}`).not.toContain(";");
          expect(half[token], `${look.id} ${mode} ${token}`).not.toContain("}");
        }
      }
    }
  });
});

describe("builtInComposition", () => {
  test("answers by the id the OLD theme library used, which is what the migration has", () => {
    expect(builtInComposition("tide")).toEqual(BUILT_IN_LOOKS.find((look) => look.id === `${BUILT_IN_PREFIX}tide`)?.composition);
    expect(builtInComposition("custom-1")).toBeUndefined();
    expect(builtInComposition("dusk")).toBeDefined();
  });
});
