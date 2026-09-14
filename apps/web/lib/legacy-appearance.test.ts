/**
 * THE OLD APPEARANCE, READ FORWARD — and the owner's requested migration test.
 *
 * "A migration test for every built-in theme and one imported VS Code theme."
 * The two halves of that ask are genuinely different cases and are tested as
 * such: a BUILT-IN theme's sixteen tokens were this build's own table restated,
 * so it migrates to the built-in LOOK of the same name and its base goes on
 * deciding things; a CUSTOM theme — one somebody built, or a VS Code import —
 * has no table behind it, so every token is pinned and the result paints exactly
 * what it painted before.
 *
 * WHAT WOULD GO WRONG IF THIS DRIFTED: somebody's window changes colour when
 * they update. There is no error for that, only this.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { THEME_TOKENS } from "@telar/engine-client";
import { BUILT_IN_LOOKS, BUILT_IN_PREFIX } from "./built-in-looks";
import { forgetLegacyAppearance, migrateLegacyAppearance, parseActivePair, parseCustomThemes, readLegacyBackdrop } from "./legacy-appearance";
import { halfFor } from "./palette-from-image";
import { TELAR_DARK, TELAR_LIGHT } from "./theme-palettes";
import { vsCodeThemeToDefinition } from "./vscode-theme-import";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const GRADIENT = "linear-gradient(180deg, oklch(0.95 0.02 250) 0%, oklch(0.9 0.03 260) 100%)";

/** The five ids the old built-in table shipped, which are the five flat
 *  built-in Looks now. */
const OLD_BUILT_INS = ["telar", "ember", "grove", "tide", "iris"] as const;

function seed(keys: Record<string, string>): void {
  window.localStorage.clear();
  for (const [key, value] of Object.entries(keys)) window.localStorage.setItem(key, value);
}

describe("parseActivePair", () => {
  test("a bare id is a pre-pair install: that theme wore both halves", () => {
    expect(parseActivePair("tide")).toEqual({ light: "tide", dark: "tide" });
  });

  test("a stored pair round-trips", () => {
    expect(parseActivePair(JSON.stringify({ light: "ember", dark: "tide" }))).toEqual({ light: "ember", dark: "tide" });
  });

  // Nothing here may throw: it runs on a path that decides what somebody's
  // window looks like after an update.
  test.each([
    ["missing", null],
    ["empty", ""],
    ["blank", "   "],
    ["truncated json", '{"light":"ember"'],
    ["an array", "[1,2]"],
  ])("garbage (%s) falls back to telar on both halves", (_label: string, raw: string | null) => {
    expect(parseActivePair(raw)).toEqual({ light: "telar", dark: "telar" });
  });

  test("a half-filled object keeps what it can and defaults the rest", () => {
    expect(parseActivePair('{"light":"grove"}')).toEqual({ light: "grove", dark: "telar" });
    expect(parseActivePair('{"light":"grove","dark":42}')).toEqual({ light: "grove", dark: "telar" });
  });
});

describe("parseCustomThemes", () => {
  test("a garbage entry is dropped, never thrown on", () => {
    expect(parseCustomThemes(null)).toEqual([]);
    expect(parseCustomThemes("{")).toEqual([]);
    expect(parseCustomThemes(JSON.stringify([{ id: "a" }, "junk", 7]))).toEqual([]);
  });

  test("a complete theme survives with both halves", () => {
    const stored = [{ id: "mine", label: "Mine", light: { ...TELAR_LIGHT, background: "#fefefe" }, dark: { ...TELAR_DARK } }];
    const [theme] = parseCustomThemes(JSON.stringify(stored));
    expect(theme?.id).toBe("mine");
    expect(theme?.light.background).toBe("#fefefe");
  });
});

describe("readLegacyBackdrop", () => {
  beforeEach(() => window.localStorage.clear());

  test("nothing stored is no backdrop", () => {
    expect(readLegacyBackdrop()).toEqual({ kind: "none" });
  });

  /** The resolved layers are read out of their CACHE rather than recomposed:
   *  they were written at choice time so nothing downstream would need the
   *  preset table, and that is as true for a migration as for a paint. */
  test("a gradient choice takes the resolved layers that were cached beside it", () => {
    seed({
      "telar-backdrop": JSON.stringify({ kind: "gradient", id: "aurora" }),
      "telar-backdrop-css": JSON.stringify({ light: GRADIENT, dark: GRADIENT }),
    });
    expect(readLegacyBackdrop()).toEqual({ kind: "gradient", id: "aurora", resolved: { light: GRADIENT, dark: GRADIENT } });
  });

  test("an image choice resolves through its own payload key", () => {
    const image = "data:image/webp;base64,AAAA";
    seed({ "telar-backdrop": JSON.stringify({ kind: "image", fit: "tile" }), "telar-backdrop-image": image });
    expect(readLegacyBackdrop()).toEqual({ kind: "image", fit: "tile", blur: 0, dim: 0, image });
  });

  test("a choice whose payload has gone is no backdrop, not a broken one", () => {
    seed({ "telar-backdrop": JSON.stringify({ kind: "gradient", id: "aurora" }) });
    expect(readLegacyBackdrop()).toEqual({ kind: "none" });
    seed({ "telar-backdrop": JSON.stringify({ kind: "image", fit: "cover" }) });
    expect(readLegacyBackdrop()).toEqual({ kind: "none" });
  });
});

describe("migrateLegacyAppearance", () => {
  beforeEach(() => window.localStorage.clear());

  test("a machine with nothing old on it has nothing to migrate", () => {
    expect(migrateLegacyAppearance()).toBeUndefined();
  });

  /**
   * EVERY BUILT-IN THEME, to the built-in Look of the same name. Pinning the old
   * sixteen tokens as hand-set overrides would migrate somebody onto a
   * composition whose base decided nothing — Ember frozen as sixteen literals,
   * and moving the base changing nothing until every one was cleared.
   */
  test.each(OLD_BUILT_INS)("the built-in %s becomes its built-in Look", (id: string) => {
    seed({ "telar-theme-active": JSON.stringify({ light: id, dark: id }) });
    const migrated = migrateLegacyAppearance();
    const look = BUILT_IN_LOOKS.find((entry) => entry.id === `${BUILT_IN_PREFIX}${id}`);
    expect(look, id).toBeDefined();
    expect(migrated?.composition.light.base).toBe(look!.composition.light.base);
    expect(migrated?.composition.dark.base).toBe(look!.composition.dark.base);
    // And nothing pinned: the base is what decides, which is the point.
    expect(migrated?.composition.light.overrides).toEqual({});
    expect(migrated?.composition.dark.overrides).toEqual({});
  });

  /** The old selection was a PAIR, and a mixed one (Ember's day over Tide's
   *  night) was a supported thing to be wearing. Each half migrates on its own. */
  test("a mixed pair keeps both halves", () => {
    seed({ "telar-theme-active": JSON.stringify({ light: "ember", dark: "tide" }) });
    const migrated = migrateLegacyAppearance();
    const ember = BUILT_IN_LOOKS.find((entry) => entry.id === `${BUILT_IN_PREFIX}ember`)!;
    const tide = BUILT_IN_LOOKS.find((entry) => entry.id === `${BUILT_IN_PREFIX}tide`)!;
    expect(migrated?.composition.light.base).toBe(ember.composition.light.base);
    expect(migrated?.composition.dark.base).toBe(tide.composition.dark.base);
  });

  /**
   * AN IMPORTED VS CODE THEME, which is the owner's second case — and the one
   * that must be LOSSLESS, because those sixteen values are work somebody did
   * rather than something a base could regenerate.
   */
  test("an imported VS Code theme migrates token-for-token", () => {
    const definition = vsCodeThemeToDefinition({
      name: "midnight-ink",
      type: "dark",
      colors: { "editor.background": "#101820", "editor.foreground": "#e8eef5", "sideBar.background": "#0c131a" },
    });
    seed({
      "telar-theme-active": JSON.stringify({ light: "custom-1", dark: "custom-1" }),
      "telar-themes-custom": JSON.stringify([{ id: "custom-1", label: definition.label, light: definition.light, dark: definition.dark }]),
    });
    const migrated = migrateLegacyAppearance();
    expect(migrated).toBeDefined();
    // Every token pinned, and the palette it paints is byte-for-byte the one
    // the importer produced.
    for (const mode of ["light", "dark"] as const) {
      const state = migrated!.composition[mode];
      expect(Object.keys(state.overrides).sort(), mode).toEqual([...THEME_TOKENS].sort());
      expect(halfFor(state, mode), mode).toEqual(definition[mode]);
      expect(state.base, mode).toBe(definition[mode].background);
    }
  });

  test("a theme that is not in the library any more falls home rather than dangling", () => {
    seed({ "telar-theme-active": JSON.stringify({ light: "deleted", dark: "deleted" }) });
    const migrated = migrateLegacyAppearance();
    expect(migrated?.composition.light.base).toBe(TELAR_LIGHT.background);
    expect(migrated?.composition.dark.base).toBe(TELAR_DARK.background);
  });

  /** The old model had ONE backdrop for both halves, so splitting it per state
   *  would be inventing a difference nobody asked for. */
  test("the old backdrop becomes the same stack in both states", () => {
    seed({
      "telar-theme-active": JSON.stringify({ light: "tide", dark: "tide" }),
      "telar-backdrop": JSON.stringify({ kind: "gradient", id: "dusk" }),
      "telar-backdrop-css": JSON.stringify({ light: GRADIENT, dark: GRADIENT }),
    });
    const migrated = migrateLegacyAppearance();
    const layers = [{ type: "gradient", presetId: "dusk", opacity: 100 }];
    expect(migrated?.composition.light.layers).toEqual(layers);
    expect(migrated?.composition.dark.layers).toEqual(layers);
  });

  /** A custom gradient was the one place the old model held two VALUES where the
   *  new one holds two stacks, so each state takes its own. */
  test("a custom gradient's two halves become the two states' own layers", () => {
    const dark = "linear-gradient(180deg, #000000 0%, #101020 100%)";
    seed({
      "telar-backdrop": JSON.stringify({ kind: "custom-gradient", light: GRADIENT, dark }),
      "telar-backdrop-css": JSON.stringify({ light: GRADIENT, dark }),
    });
    const migrated = migrateLegacyAppearance();
    expect(migrated?.composition.light.layers).toEqual([{ type: "custom-gradient", css: GRADIENT, opacity: 100 }]);
    expect(migrated?.composition.dark.layers).toEqual([{ type: "custom-gradient", css: dark, opacity: 100 }]);
  });

  test("an image backdrop survives as a full-bleed layer with its pixels", () => {
    const image = "data:image/webp;base64,AAAA";
    seed({ "telar-backdrop": JSON.stringify({ kind: "image", fit: "cover" }), "telar-backdrop-image": image });
    const migrated = migrateLegacyAppearance();
    expect(migrated?.composition.light.layers[0]).toMatchObject({ type: "image", scale: 100, tiled: false });
    expect(Object.values(migrated?.images ?? {})).toContain(image);
  });
});

describe("forgetLegacyAppearance", () => {
  test("every key the old model owned is removed", () => {
    seed({
      "telar-theme-active": '{"light":"tide","dark":"tide"}',
      "telar-themes-custom": "[]",
      "telar-backdrop": '{"kind":"none"}',
      "telar-backdrop-css": "{}",
      "telar-backdrop-image": "x",
      "telar-backdrop-scene": "{}",
      "telar-backdrop-scene-images": "{}",
      "telar-appearance": '{"accent":"rose"}',
    });
    forgetLegacyAppearance();
    for (const key of [
      "telar-theme-active",
      "telar-themes-custom",
      "telar-backdrop",
      "telar-backdrop-css",
      "telar-backdrop-image",
      "telar-backdrop-scene",
      "telar-backdrop-scene-images",
    ]) {
      expect(window.localStorage.getItem(key), key).toBeNull();
    }
    // The appearance store is NOT the old model's — the accent, the type and
    // the depth are untouched by any of this.
    expect(window.localStorage.getItem("telar-appearance")).toBe('{"accent":"rose"}');
  });
});
