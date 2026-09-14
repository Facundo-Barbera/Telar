/**
 * THE COMPOSITION — the store, the compiler, and the one-shot migration.
 *
 * WHAT IS ACTUALLY BEING GUARDED. Three of these are places where a mistake
 * paints the wrong thing SILENTLY, with nothing to notice it: a compiled
 * stylesheet that restates the default palette (so globals.css stops being the
 * source of the default look), per-state background lists that drift out of
 * alignment (so CSS cycles them and every layer paints at someone else's size),
 * and a migration that reads an install's old keys wrongly (so somebody's window
 * changes colour on an upgrade). None of them throws; all three are assertions.
 *
 * A DOM, because this IS a store — see scripts/test-dom.mjs for why the suite's
 * preload hands the globals back rather than keeping them.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { TELAR_DARK, TELAR_LIGHT, THEME_TOKENS, type Composition } from "@telar/engine-client";
import {
  compileComposition,
  composeComposition,
  compositionHalf,
  copyLayersAcross,
  currentComposition,
  DEFAULT_COMPOSITION,
  patchOverride,
  patchState,
  pruneCompositionImages,
  THEME_CSS_KEY,
  writeComposition,
} from "./composition";
import { BACKDROP_CSS_KEY, parseBackdropCss } from "./backdrop";
import { BACKDROP_PRESETS } from "./backdrop-presets";
import { splitTopLevel } from "./scene-composer";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const PIXEL = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const preset = BACKDROP_PRESETS[0]!;

function composition(overrides: Partial<Composition> = {}): Composition {
  return { ...structuredClone(DEFAULT_COMPOSITION), ...overrides };
}

describe("compileComposition", () => {
  /**
   * THE IDENTITY COMPOSITION COMPILES TO NOTHING, which is what keeps
   * globals.css the single source of the default look. The old theme library
   * had the same contract as a SPECIAL CASE ("telar" was compared by id); here
   * it falls out of the rule, because the default base derives exactly the
   * authored values and a token that matches is not emitted.
   */
  test("Telar's own composition emits no stylesheet at all", () => {
    expect(compileComposition(DEFAULT_COMPOSITION)).toBe("");
  });

  test("only the tokens that actually moved are emitted", () => {
    const tinted = patchState(composition(), "light", { base: "#4999b6" });
    const css = compileComposition(tinted);
    expect(css).toContain("html:root {");
    // Light moved; dark did not, so it contributes no block.
    expect(css).not.toContain("html:root.dark");
    for (const token of THEME_TOKENS) {
      expect(css).not.toContain(`--${token}: ${TELAR_LIGHT[token]};`);
    }
  });

  test("a hand-set override reaches the stylesheet", () => {
    const css = compileComposition(patchOverride(composition(), "dark", "card", "#123456"));
    expect(css).toContain("html:root.dark { --card: #123456; }");
  });

  /** `html:root` is one type selector above globals.css's `:root`, which is how
   *  the composition wins by construction rather than by ordering. */
  test("each state writes the selector that outranks the authored tokens", () => {
    const both = patchOverride(patchOverride(composition(), "light", "card", "#111111"), "dark", "card", "#222222");
    const css = compileComposition(both);
    expect(css).toContain("html:root { --card: #111111; }");
    expect(css).toContain("html:root.dark { --card: #222222; }");
  });
});

describe("composeComposition", () => {
  test("nothing over either base is no backdrop at all", () => {
    expect(composeComposition(DEFAULT_COMPOSITION, {})).toBeNull();
  });

  /**
   * THE FORK THE OWNER ANSWERED: per-state lists. Entry n of one state can be
   * an image where the other's is a gradient, and one shared
   * `background-size/position/repeat` list cannot serve both.
   */
  test("each state carries its own four lists", () => {
    const value = composeComposition(
      {
        light: { base: "#f8f8f9", layers: [{ type: "image", id: "a", x: 10, y: 20, scale: 40, opacity: 100, tiled: false }], overrides: {} },
        dark: { base: "#252525", layers: [{ type: "gradient", presetId: preset.id, opacity: 100 }], overrides: {} },
      },
      { a: PIXEL },
    );
    expect(value?.sizeLight).toBe("40% auto");
    expect(value?.positionLight).toBe("10% 20%");
    expect(value?.sizeDark?.split(", ")).toEqual(Array(splitTopLevel(preset.dark).length).fill("cover"));
    expect(value?.dark).toBe(preset.dark);
  });

  /** A state with nothing over its base contributes an empty list rather than
   *  failing the pair — and no lists at all, so the CSS falls through. */
  test("one state may carry a scene while the other is bare", () => {
    const value = composeComposition(patchState(composition(), "light", { layers: [{ type: "gradient", presetId: preset.id, opacity: 100 }] }), {});
    expect(value?.light).toBe(preset.light);
    expect(value?.dark).toBe("none");
    expect(value?.sizeDark).toBeUndefined();
  });

  test("every list has one entry per background-image entry, in both states", () => {
    for (const entry of BACKDROP_PRESETS) {
      const value = composeComposition(
        {
          light: { base: "#f8f8f9", layers: [{ type: "image", id: "a", x: 0, y: 0, scale: 50, opacity: 100, tiled: false }, { type: "gradient", presetId: entry.id, opacity: 70 }], overrides: {} },
          dark: { base: "#252525", layers: [{ type: "gradient", presetId: entry.id, opacity: 100 }], overrides: {} },
        },
        { a: PIXEL },
      );
      expect(value, entry.id).not.toBeNull();
      for (const [image, lists] of [
        [value!.light, [value!.sizeLight, value!.positionLight, value!.repeatLight]],
        [value!.dark, [value!.sizeDark, value!.positionDark, value!.repeatDark]],
      ] as const) {
        const count = splitTopLevel(image).length;
        for (const list of lists) expect((list ?? "").split(", ").length, entry.id).toBe(count);
      }
    }
  });
});

describe("editing a composition", () => {
  test("an override is set and CLEARED, which is the whole reason it is sparse", () => {
    const set = patchOverride(composition(), "light", "card", "#ffffff");
    expect(set.light.overrides.card).toBe("#ffffff");
    expect(compositionHalf(set, "light").card).toBe("#ffffff");
    const cleared = patchOverride(set, "light", "card", undefined);
    expect("card" in cleared.light.overrides).toBe(false);
    // Handed back to the base, rather than pinned at what the base happened to
    // say when it was cleared.
    expect(compositionHalf(cleared, "light").card).toBe(TELAR_LIGHT.card);
  });

  test("the other state's overrides are untouched", () => {
    const set = patchOverride(composition(), "light", "card", "#ffffff");
    expect(set.dark.overrides).toEqual({});
    expect(compositionHalf(set, "dark").card).toBe(TELAR_DARK.card);
  });

  /** The layers copy across; the BASE does not — it is the one thing the two
   *  states are never the same about. */
  test("copying layers across leaves the other base alone", () => {
    const light = patchState(composition(), "light", { layers: [{ type: "gradient", presetId: preset.id, opacity: 60 }] });
    const copied = copyLayersAcross(light, "light");
    expect(copied.dark.layers).toEqual(light.light.layers);
    expect(copied.dark.base).toBe(DEFAULT_COMPOSITION.dark.base);
    // A copy, not the same array: editing one state must not edit the other.
    expect(copied.dark.layers).not.toBe(light.light.layers);
  });

  test("images are pruned against BOTH states, never one", () => {
    const shared: Composition = {
      light: { base: "#f8f8f9", layers: [{ type: "image", id: "a", x: 0, y: 0, scale: 50, opacity: 100, tiled: false }], overrides: {} },
      dark: { base: "#252525", layers: [{ type: "image", id: "b", x: 0, y: 0, scale: 50, opacity: 100, tiled: false }], overrides: {} },
    };
    const images = { a: PIXEL, "orig:a": PIXEL, b: PIXEL, gone: PIXEL };
    expect(pruneCompositionImages(shared, images)).toEqual({ a: PIXEL, "orig:a": PIXEL, b: PIXEL });
  });

  /** Reference equality is load-bearing: the store skips re-serialising the
   *  image map when it has not moved, which is what makes dragging a slider
   *  cost a few hundred bytes a frame rather than a megabyte. */
  test("pruning nothing hands back the same object", () => {
    const images = { a: PIXEL };
    const live = patchState(composition(), "light", { layers: [{ type: "image", id: "a", x: 0, y: 0, scale: 50, opacity: 100, tiled: false }] });
    expect(pruneCompositionImages(live, images)).toBe(images);
  });
});

describe("the store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("a write round-trips, and hands back the same objects it was given", () => {
    const value = patchState(composition(), "light", { base: "#4999b6" });
    expect(writeComposition(value, {})).toBe(true);
    expect(currentComposition().composition).toBe(value);
    expect(currentComposition().composition).toEqual(value);
  });

  /** THE DERIVED CACHES ARE WRITTEN BY THE APPLY AND NOWHERE ELSE, so they can
   *  never disagree with the composition they cache. */
  test("both pre-paint caches are written by the same call", () => {
    const value = patchState(patchState(composition(), "light", { base: "#4999b6" }), "light", {
      layers: [{ type: "gradient", presetId: preset.id, opacity: 100 }],
    });
    writeComposition(value, {});
    expect(window.localStorage.getItem(THEME_CSS_KEY)).toBe(compileComposition(value));
    expect(parseBackdropCss(window.localStorage.getItem(BACKDROP_CSS_KEY))).toEqual(composeComposition(value, {})!);
  });

  test("a composition with no layers clears the backdrop cache rather than storing an empty one", () => {
    writeComposition(patchState(composition(), "light", { layers: [{ type: "gradient", presetId: preset.id, opacity: 100 }] }), {});
    expect(window.localStorage.getItem(BACKDROP_CSS_KEY)).not.toBeNull();
    writeComposition(DEFAULT_COMPOSITION, {});
    expect(window.localStorage.getItem(BACKDROP_CSS_KEY)).toBeNull();
  });

  test("the identity composition writes an empty stylesheet, not the base palette", () => {
    writeComposition(DEFAULT_COMPOSITION, {});
    expect(window.localStorage.getItem(THEME_CSS_KEY)).toBe("");
  });

  test("a stored composition is read back through the total parser", () => {
    window.localStorage.setItem("telar-composition", '{"light":{"base":"red } html { display:none","layers":"junk"}}');
    const read = currentComposition().composition;
    // The unsafe base is refused and the state falls to Telar's own, rather
    // than a value that could close a declaration reaching the stylesheet.
    expect(read.light.base).toBe(DEFAULT_COMPOSITION.light.base);
    expect(read.light.layers).toEqual([]);
  });
});
