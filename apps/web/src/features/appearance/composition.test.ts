// Needs a DOM; scripts/test-dom.mjs explains why the preload hands the globals back.
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
  recompileStaleCss,
  strandedTones,
  THEME_CSS_KEY,
  writeComposition,
} from "./composition";
import { BUILT_IN_LOOKS } from "./built-in-looks";
import { BACKDROP_CSS_KEY, parseBackdropCss } from "./backdrop";
import { composeGradient, GRADIENT_STARTERS } from "./gradient-starters";
import { splitTopLevel } from "./scene-composer";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const PIXEL = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const starter = GRADIENT_STARTERS[0]!;
const preset = { id: starter.id, light: composeGradient(starter.light), dark: composeGradient(starter.dark) };

function composition(overrides: Partial<Composition> = {}): Composition {
  return { ...structuredClone(DEFAULT_COMPOSITION), ...overrides };
}

describe("compileComposition", () => {
  /** Keeps globals.css the single source of the default look. */
  test("Telar's own composition emits no stylesheet at all", () => {
    expect(compileComposition(DEFAULT_COMPOSITION)).toBe("");
  });

  function declared(block: string): string[] {
    return [...block.matchAll(/--([a-z-]+):/g)].map((match) => match[1]!);
  }
  function blocks(css: string): { light: string; dark: string } {
    const [light = "", dark = ""] = css.split("html:root.dark");
    return { light, dark };
  }

  /** `html:root` outranks `.dark`, so a token declared only in light would keep
   *  its light value at night. */
  test("a token moved in one state is declared in both, and unmoved tokens in neither", () => {
    const { light, dark } = blocks(compileComposition(patchOverride(composition(), "light", "border", "#aabbcc")));
    expect(declared(light)).toEqual(["border"]);
    // Dark carries its own (neutral) value, never a copy of light's.
    expect(declared(dark)).toEqual(["border"]);
    expect(dark).toContain(`--border: ${TELAR_DARK.border};`);
    expect(light).toContain("--border: #aabbcc;");
  });

  test("a tinted base moves the same tokens in both states", () => {
    const tinted = patchState(composition(), "light", { base: "#4999b6" });
    const { light, dark } = blocks(compileComposition(tinted));
    expect(declared(light)).toEqual(declared(dark));
    for (const token of THEME_TOKENS) expect(light).not.toContain(`--${token}: ${TELAR_LIGHT[token]};`);
  });

  test("every tinted built-in Look declares the same tokens in both states, the dark border kept translucent", () => {
    for (const look of BUILT_IN_LOOKS) {
      const css = compileComposition(look.composition);
      if (css === "") continue; // Telar itself
      const { light, dark } = blocks(css);
      expect(declared(light), look.id).toEqual(declared(dark));
      expect(light, look.id).toContain("--border:");
      expect(dark, look.id).toContain(`--border: ${TELAR_DARK.border};`);
    }
  });

  test("a hand-set override reaches the stylesheet, and the other state declares its own value", () => {
    const { light, dark } = blocks(compileComposition(patchOverride(composition(), "dark", "card", "#123456")));
    expect(dark).toContain("--card: #123456;");
    expect(light).toContain(`--card: ${TELAR_LIGHT.card};`);
  });

  /** `html:root` is one type selector above globals.css's `:root`, so the composition wins by construction. */
  test("each state writes the selector that outranks the authored tokens", () => {
    const both = patchOverride(patchOverride(composition(), "light", "card", "#111111"), "dark", "card", "#222222");
    const css = compileComposition(both);
    // A near-black light card also draws the repaired state tokens, so pin the
    // selector and declaration rather than the whole block.
    expect(css).toContain("html:root { --card: #111111; ");
    expect(css).toContain("html:root.dark { --card: #222222; }");
  });
});

/** A window's cached stylesheet from an older compiler is replaced; a matching cache costs nothing. */
describe("recompileStaleCss", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("rewrites a cached stylesheet the current compiler disagrees with", () => {
    const grove = BUILT_IN_LOOKS.find((look) => look.id === "built-in-grove")!;
    writeComposition(grove.composition, grove.images);
    window.localStorage.setItem(THEME_CSS_KEY, "html:root { --border: oklch(0.91 0.0154 150.0); }");
    recompileStaleCss();
    expect(window.localStorage.getItem(THEME_CSS_KEY)).toBe(compileComposition(grove.composition));
  });

  test("leaves an agreeing cache alone, and writes nothing for the identity composition", () => {
    recompileStaleCss();
    expect(window.localStorage.getItem(THEME_CSS_KEY)).toBeNull();
  });
});

/** `repairInk` returns the shipped ink unchanged when it already reads, so the
 *  identity composition still compiles to nothing. */
describe("compileComposition repairs the ink, never the card", () => {
  const TONES = ["success", "warning", "destructive"] as const;
  const stateDeclarations = (css: string) => TONES.filter((tone) => css.includes(`--${tone}:`));

  test("nothing this build ships draws a single state declaration", () => {
    expect(compileComposition(DEFAULT_COMPOSITION)).toBe("");
    for (const look of BUILT_IN_LOOKS) {
      expect(stateDeclarations(compileComposition(look.composition)), `look ${look.id}`).toEqual([]);
    }
    expect(BUILT_IN_LOOKS.length).toBeGreaterThan(0);
  });

  test("a card that strands the ink draws the ink, and leaves the card alone", () => {
    const hostile = patchOverride(composition(), "light", "card", "#111111");
    const css = compileComposition(hostile);
    expect(stateDeclarations(css)).toEqual([...TONES]);
    expect(css.match(/--card: [^;]+;/g)).toEqual(["--card: #111111;", `--card: ${TELAR_DARK.card};`]);
    expect(compositionHalf(hostile, "light").card).toBe("#111111");
    const [lightBlock = ""] = css.split("html:root.dark");
    for (const declaration of lightBlock.replace(/^html:root \{ | \}\s*$/g, "").split(" ").filter((part) => part.startsWith("--"))) {
      expect(["--card:", ...TONES.map((tone) => `--${tone}:`)]).toContain(declaration);
    }
    expect(css).toContain(`html:root.dark { --card: ${TELAR_DARK.card}; }`);
  });

  test("a card no lightness can rescue draws nothing, and names what it cost", () => {
    // The mid-green card sits on the ink's own lightness, so elevation fails with nowhere to go.
    const unrescuable = patchOverride(composition(), "light", "card", "oklch(0.50 0.10 162)");
    expect(stateDeclarations(compileComposition(unrescuable))).toEqual([]);
    expect(strandedTones(unrescuable)).toEqual([...TONES]);
    expect(strandedTones(DEFAULT_COMPOSITION)).toEqual([]);
    for (const look of BUILT_IN_LOOKS) expect(strandedTones(look.composition), `look ${look.id}`).toEqual([]);
  });
});

describe("composeComposition", () => {
  test("nothing over either base is no backdrop at all", () => {
    expect(composeComposition(DEFAULT_COMPOSITION, {})).toBeNull();
  });

  /** One shared `background-size/position/repeat` list cannot serve an image in one state and a gradient in the other. */
  test("each state carries its own four lists", () => {
    const value = composeComposition(
      {
        light: { base: "#f8f8f9", layers: [{ type: "image", id: "a", x: 10, y: 20, scale: 40, opacity: 100, tiled: false }], overrides: {} },
        dark: { base: "#252525", layers: [{ type: "gradient", spec: starter.dark, opacity: 100 }], overrides: {} },
      },
      { a: PIXEL },
    );
    expect(value?.sizeLight).toBe("40% auto");
    expect(value?.positionLight).toBe("10% 20%");
    expect(value?.sizeDark?.split(", ")).toEqual(Array(splitTopLevel(preset.dark).length).fill("cover"));
    expect(value?.dark).toBe(preset.dark);
  });

  test("one state may carry a scene while the other is bare", () => {
    const value = composeComposition(patchState(composition(), "light", { layers: [{ type: "gradient", spec: starter.light, opacity: 100 }] }), {});
    expect(value?.light).toBe(preset.light);
    expect(value?.dark).toBe("none");
    expect(value?.sizeDark).toBeUndefined();
  });

  test("every list has one entry per background-image entry, in both states", () => {
    for (const entry of GRADIENT_STARTERS) {
      const value = composeComposition(
        {
          light: { base: "#f8f8f9", layers: [{ type: "image", id: "a", x: 0, y: 0, scale: 50, opacity: 100, tiled: false }, { type: "gradient", spec: entry.light, opacity: 70 }], overrides: {} },
          dark: { base: "#252525", layers: [{ type: "gradient", spec: entry.dark, opacity: 100 }], overrides: {} },
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
    // Handed back to the base, not pinned at the base's value when cleared.
    expect(compositionHalf(cleared, "light").card).toBe(TELAR_LIGHT.card);
  });

  test("the other state's overrides are untouched", () => {
    const set = patchOverride(composition(), "light", "card", "#ffffff");
    expect(set.dark.overrides).toEqual({});
    expect(compositionHalf(set, "dark").card).toBe(TELAR_DARK.card);
  });

  test("copying layers across leaves the other base alone", () => {
    const light = patchState(composition(), "light", { layers: [{ type: "gradient", spec: starter.light, opacity: 60 }] });
    const copied = copyLayersAcross(light, "light");
    expect(copied.dark.layers).toEqual(light.light.layers);
    expect(copied.dark.base).toBe(DEFAULT_COMPOSITION.dark.base);
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

  /** Reference equality lets the store skip re-serialising the image map while a slider drags. */
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

  test("both pre-paint caches are written by the same call", () => {
    const value = patchState(patchState(composition(), "light", { base: "#4999b6" }), "light", {
      layers: [{ type: "gradient", spec: starter.light, opacity: 100 }],
    });
    writeComposition(value, {});
    expect(window.localStorage.getItem(THEME_CSS_KEY)).toBe(compileComposition(value));
    expect(parseBackdropCss(window.localStorage.getItem(BACKDROP_CSS_KEY))).toEqual(composeComposition(value, {})!);
  });

  test("a composition with no layers clears the backdrop cache rather than storing an empty one", () => {
    writeComposition(patchState(composition(), "light", { layers: [{ type: "gradient", spec: starter.light, opacity: 100 }] }), {});
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
    expect(read.light.base).toBe(DEFAULT_COMPOSITION.light.base);
    expect(read.light.layers).toEqual([]);
  });
});
