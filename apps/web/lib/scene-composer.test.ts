// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { isGradientValue, isSceneValue } from "./backdrop";
import { BACKDROP_PRESETS, composeGradient, DEFAULT_CUSTOM_GRADIENT, type BackdropPreset } from "./backdrop-presets";
import {
  addSceneCustomGradientLayer,
  addSceneGradientLayer,
  addSceneLayer,
  composeState,
  countSceneGradients,
  countSceneImages,
  DEFAULT_LAYER,
  DEFAULT_SCENE,
  DEFAULT_SCENE_BASE,
  forgetLayerImages,
  MAX_SCENE_GRADIENT_LAYERS,
  MAX_SCENE_LAYERS,
  moveSceneLayer,
  moveSceneLayerAt,
  newLayerId,
  parseScene,
  parseSceneImages,
  parseSceneLayer,
  pruneSceneImages,
  removeSceneLayer,
  removeSceneLayerAt,
  sceneImageUrl,
  SCENE_LIMITS,
  setCustomGradientCss,
  setGradientPreset,
  splitTopLevel,
  updateSceneLayer,
  updateSceneLayerAt,
  withGradientAlpha,
  type Scene,
  type SceneGradientLayer,
  type SceneImageLayer,
  type SceneLayer,
} from "./scene-composer";
import type { SceneCustomGradientLayer } from "@telar/engine-client";

/** A one-pixel WebP, shaped exactly like what the canvas encoder emits — the
 *  `;base64` in here is the whole reason sceneImageUrl exists. */
const PIXEL = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const base: BackdropPreset = BACKDROP_PRESETS[0];
const lookup = (id: string) => BACKDROP_PRESETS.find((preset) => preset.id === id);

function layer(id: string, overrides: Partial<Omit<SceneImageLayer, "type">> = {}): SceneImageLayer {
  return { id, ...DEFAULT_LAYER, ...overrides };
}

function gradient(presetId: string, opacity = 100): SceneGradientLayer {
  return { type: "gradient", presetId, opacity };
}

function custom(css: string, opacity = 100): SceneCustomGradientLayer {
  return { type: "custom-gradient", css, opacity };
}

/** A stack with a full-bleed gradient at the bottom — the picture most of these
 *  tests describe, and what the old mandatory "base" turned into. */
function scene(layers: SceneLayer[], baseId: string | null = base.id): Scene {
  return { layers: baseId === null ? layers : [...layers, gradient(baseId)] };
}

/** The bottom-most layer's preset, or null — what `sceneBasePresetId` used to
 *  answer before the composition's BASE became a colour and this became an
 *  ordinary layer like any other. */
const bottomPreset = (value: Scene): string | null => {
  const bottom = value.layers[value.layers.length - 1];
  return bottom !== undefined && bottom.type === "gradient" ? bottom.presetId : null;
};

describe("parseScene", () => {
  test("anything unrecognised is the empty default", () => {
    for (const raw of [null, "", "not json", "[]", "7", '"scene"', "{}"]) {
      expect(parseScene(raw)).toEqual(DEFAULT_SCENE);
    }
  });

  /** THE MIGRATION: `baseId` was the old mandatory base, and it means exactly
   *  the bottom-most gradient layer at full opacity. */
  test("an old scene's baseId becomes a bottom gradient layer", () => {
    const migrated = parseScene(JSON.stringify({ baseId: base.id, layers: [{ id: "a" }] }));
    expect(migrated.layers).toEqual([layer("a"), gradient(base.id)]);
    expect(bottomPreset(migrated)).toBe(base.id);
  });

  test("an unknown base falls back rather than painting nothing", () => {
    expect(bottomPreset(parseScene(JSON.stringify({ baseId: "no-such-preset", layers: [] })))).toBe(DEFAULT_SCENE_BASE);
    expect(bottomPreset(parseScene(JSON.stringify({ baseId: base.id, layers: [] })))).toBe(base.id);
  });

  /** A stack without a `baseId` is saying "nothing underneath" — no base may be
   *  invented on read. */
  test("a scene with layers and no baseId keeps its transparent bottom", () => {
    const parsed = parseScene(JSON.stringify({ layers: [{ type: "image", id: "a" }] }));
    expect(parsed.layers).toEqual([layer("a")]);
    expect(bottomPreset(parsed)).toBeNull();
    expect(parseScene(JSON.stringify({ layers: [] })).layers).toEqual([]);
  });

  test("a layer with no type is read as an image, like older builds wrote it", () => {
    expect(parseSceneLayer({ id: "a", x: 10 })).toEqual({ id: "a", ...DEFAULT_LAYER, x: 10 });
  });

  test("gradient layers carry a known preset and a clamped opacity", () => {
    expect(parseSceneLayer({ type: "gradient", presetId: base.id, opacity: 40 })).toEqual(gradient(base.id, 40));
    expect(parseSceneLayer({ type: "gradient", presetId: base.id })).toEqual(gradient(base.id, 100));
    expect(parseSceneLayer({ type: "gradient", presetId: "no-such-preset", opacity: 999 })).toEqual(gradient(DEFAULT_SCENE_BASE, 100));
    expect(parseSceneLayer({ type: "gradient", opacity: 1 })).toEqual(gradient(DEFAULT_SCENE_BASE, SCENE_LIMITS.opacity.min));
  });

  /** A custom gradient is a LAYER now rather than a backdrop kind with two
   *  halves, and it carries its RESOLVED css — so a value that is not a
   *  gradient is fatal for that layer, there being no "the one they meant". */
  test("a custom gradient layer keeps its css, or is dropped outright", () => {
    const css = "linear-gradient(160deg, #eef2ff 0%, #fce7f3 100%)";
    expect(parseSceneLayer({ type: "custom-gradient", css, opacity: 40 })).toEqual(custom(css, 40));
    expect(parseSceneLayer({ type: "custom-gradient", css })).toEqual(custom(css, 100));
    for (const bad of [{ type: "custom-gradient" }, { type: "custom-gradient", css: "red" }, { type: "custom-gradient", css: "linear-gradient(red);}" }]) {
      expect(parseSceneLayer(bad)).toBeUndefined();
    }
  });

  test("out-of-range numbers are clamped, not dropped", () => {
    const parsed = parseScene(JSON.stringify({ layers: [{ id: "a", x: -40, y: 900, scale: 5000, opacity: 0, tiled: 1 }] }));
    expect(parsed.layers).toEqual([{ type: "image", id: "a", x: 0, y: 100, scale: SCENE_LIMITS.scale.max, opacity: SCENE_LIMITS.opacity.min, tiled: false }]);
  });

  test("missing fields take the defaults", () => {
    expect(parseSceneLayer({ id: "a" })).toEqual({ id: "a", ...DEFAULT_LAYER });
  });

  test("a layer without a usable id is dropped", () => {
    for (const bad of [{}, { id: "" }, { id: 4 }, { id: "orig:a" }, { id: "a b" }, null, "a"]) {
      expect(parseSceneLayer(bad)).toBeUndefined();
    }
  });

  test("duplicate ids collapse and each kind is capped on its own", () => {
    const layers = [{ id: "a" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }, { id: "g" }, { id: "h" }];
    const gradients = Array.from({ length: MAX_SCENE_GRADIENT_LAYERS + 3 }, () => ({ type: "gradient", presetId: base.id }));
    const parsed = parseScene(JSON.stringify({ layers: [...layers, ...gradients] }));
    expect(countSceneImages(parsed)).toBe(MAX_SCENE_LAYERS);
    expect(countSceneGradients(parsed)).toBe(MAX_SCENE_GRADIENT_LAYERS);
    expect(new Set(parsed.layers.flatMap((l) => (l.type === "image" ? [l.id] : []))).size).toBe(MAX_SCENE_LAYERS);
  });

  test("a migrated base does not push the gradient cap over", () => {
    const gradients = Array.from({ length: MAX_SCENE_GRADIENT_LAYERS }, () => ({ type: "gradient", presetId: base.id }));
    expect(countSceneGradients(parseScene(JSON.stringify({ baseId: base.id, layers: gradients })))).toBe(MAX_SCENE_GRADIENT_LAYERS);
  });

  test("a scene round-trips through its own JSON", () => {
    const original = scene([layer("a", { x: 10, y: 90, scale: 130, opacity: 45, tiled: true }), gradient(base.id, 30), layer("b")]);
    expect(parseScene(JSON.stringify(original))).toEqual(original);
  });
});

describe("parseSceneImages", () => {
  test("only image data URLs survive", () => {
    const raw = JSON.stringify({ a: PIXEL, "orig:a": PIXEL, b: "https://example.com/x.png", c: 12, d: null });
    expect(parseSceneImages(raw)).toEqual({ a: PIXEL, "orig:a": PIXEL });
  });

  test("junk is an empty map, never a throw", () => {
    for (const raw of [null, "", "[1,2]", "nope", "5"]) {
      expect(parseSceneImages(raw)).toEqual({});
    }
  });
});

const ids = (value: Scene) => value.layers.map((l) => (l.type === "image" ? l.id : l.type === "gradient" ? `~${l.presetId}` : "~custom"));

describe("editing", () => {
  test("a new layer lands on top with centred defaults", () => {
    const next = addSceneLayer(scene([layer("a")]), "b");
    expect(ids(next)).toEqual(["b", "a", `~${base.id}`]);
    expect(next.layers[0]).toEqual({ id: "b", ...DEFAULT_LAYER });
  });

  test("the cap and duplicate ids are refused as no-ops", () => {
    const full = scene(["a", "b", "c", "d", "e", "f"].map((id) => layer(id)));
    expect(addSceneLayer(full, "g")).toBe(full);
    expect(countSceneImages(addSceneLayer(scene([layer("a")]), "a"))).toBe(1);
  });

  test("a gradient layer lands on top too, and is capped on its own", () => {
    const next = addSceneGradientLayer(scene([layer("a")]), BACKDROP_PRESETS[1].id);
    expect(ids(next)).toEqual([`~${BACKDROP_PRESETS[1].id}`, "a", `~${base.id}`]);
    expect(next.layers[0]).toEqual(gradient(BACKDROP_PRESETS[1].id, 100));
    const full = scene(Array.from({ length: MAX_SCENE_GRADIENT_LAYERS }, () => gradient(base.id)), null);
    expect(addSceneGradientLayer(full, base.id)).toBe(full);
    expect(addSceneGradientLayer(DEFAULT_SCENE, "no-such-preset")).toBe(DEFAULT_SCENE);
  });

  test("a custom gradient is added as a layer, gated on actually being one", () => {
    const css = composeGradient(DEFAULT_CUSTOM_GRADIENT.light);
    const next = addSceneCustomGradientLayer(scene([layer("a")]), css);
    expect(ids(next)).toEqual(["~custom", "a", `~${base.id}`]);
    expect(next.layers[0]).toEqual(custom(css, 100));
    // It shares the gradient cap: both kinds are string layers with the same
    // legibility cost, and neither is the "real" one.
    const full = scene(Array.from({ length: MAX_SCENE_GRADIENT_LAYERS }, () => gradient(base.id)), null);
    expect(addSceneCustomGradientLayer(full, css)).toBe(full);
    expect(addSceneCustomGradientLayer(DEFAULT_SCENE, "red")).toBe(DEFAULT_SCENE);
  });

  test("a custom gradient's css is rewritten in place, and only on its own kind", () => {
    const first = composeGradient(DEFAULT_CUSTOM_GRADIENT.light);
    const second = composeGradient({ ...DEFAULT_CUSTOM_GRADIENT.light, angle: 42 });
    const stack: Scene = { layers: [custom(first, 60), gradient(base.id)] };
    expect(setCustomGradientCss(stack, 0, second).layers[0]).toEqual(custom(second, 60));
    // Not a gradient, not that kind of layer, not there at all: all no-ops.
    expect(setCustomGradientCss(stack, 0, "red")).toBe(stack);
    expect(setCustomGradientCss(stack, 1, second)).toBe(stack);
    expect(setCustomGradientCss(stack, 9, second)).toBe(stack);
  });

  test("a gradient layer's preset is swapped in place, keeping its fade", () => {
    const stack: Scene = { layers: [gradient(base.id, 60), layer("a")] };
    expect(setGradientPreset(stack, 0, BACKDROP_PRESETS[1].id).layers[0]).toEqual(gradient(BACKDROP_PRESETS[1].id, 60));
    expect(setGradientPreset(stack, 0, "no-such-preset")).toBe(stack);
    expect(setGradientPreset(stack, 1, BACKDROP_PRESETS[1].id)).toBe(stack);
  });

  test("moving is clamped to the ends, never wrapped", () => {
    const three = scene([layer("a"), layer("b"), layer("c")], null);
    expect(ids(moveSceneLayer(three, "b", -1))).toEqual(["b", "a", "c"]);
    expect(ids(moveSceneLayer(three, "b", 1))).toEqual(["a", "c", "b"]);
    expect(moveSceneLayer(three, "a", -1)).toBe(three);
    expect(moveSceneLayer(three, "c", 1)).toBe(three);
    expect(moveSceneLayer(three, "missing", -1)).toBe(three);
  });

  test("gradient layers reorder and remove by position, having no id", () => {
    const mixed: Scene = { layers: [layer("a"), gradient(base.id, 40), layer("b")] };
    expect(ids(moveSceneLayerAt(mixed, 1, -1))).toEqual([`~${base.id}`, "a", "b"]);
    expect(ids(removeSceneLayerAt(mixed, 1))).toEqual(["a", "b"]);
    expect(removeSceneLayerAt(mixed, 9)).toBe(mixed);
    expect(moveSceneLayerAt(mixed, 0, -1)).toBe(mixed);
  });

  test("patches clamp and leave other layers alone", () => {
    const two = scene([layer("a"), layer("b")], null);
    const next = updateSceneLayer(two, "a", { x: 999, opacity: -3, tiled: true });
    expect(next.layers[0]).toEqual({ type: "image", id: "a", x: 100, y: 50, scale: DEFAULT_LAYER.scale, opacity: SCENE_LIMITS.opacity.min, tiled: true });
    expect(next.layers[1]).toEqual(two.layers[1]);
  });

  test("either gradient kind takes only opacity from a patch", () => {
    const css = composeGradient(DEFAULT_CUSTOM_GRADIENT.light);
    const one: Scene = { layers: [gradient(base.id, 100), custom(css, 100)] };
    expect(updateSceneLayerAt(one, 0, { opacity: 35, x: 10, scale: 200, tiled: true }).layers[0]).toEqual(gradient(base.id, 35));
    expect(updateSceneLayerAt(one, 1, { opacity: 35, x: 10, scale: 200, tiled: true }).layers[1]).toEqual(custom(css, 35));
    expect(updateSceneLayerAt(one, 0, { opacity: 0 }).layers[0]).toEqual(gradient(base.id, SCENE_LIMITS.opacity.min));
  });

  test("removal and image cleanup take the original with them", () => {
    const images = { a: PIXEL, "orig:a": PIXEL, b: PIXEL, "orig:b": PIXEL };
    expect(forgetLayerImages(images, "a")).toEqual({ b: PIXEL, "orig:b": PIXEL });
    const left = removeSceneLayer(scene([layer("a"), layer("b")]), "a");
    expect(pruneSceneImages(left, images)).toEqual({ b: PIXEL, "orig:b": PIXEL });
  });

  test("ids are unique", () => {
    const ids = Array.from({ length: 50 }, () => newLayerId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(parseSceneLayer({ id })).toBeDefined();
  });
});

describe("sceneImageUrl", () => {
  test("the semicolon is escaped so the store's gate accepts it", () => {
    const url = sceneImageUrl(PIXEL);
    expect(url).toBe(`url("data:image/webp\\00003Bbase64,${PIXEL.split(",")[1]}")`);
    expect(url?.includes(";")).toBe(false);
    expect(isSceneValue(url)).toBe(true);
  });

  test("anything that is not a plain data URL is refused", () => {
    for (const bad of ['data:image/png,");background:url(http://x', "https://example.com/a.png", "data:text/html,hi", 'data:image/png,a"b']) {
      expect(sceneImageUrl(bad)).toBeNull();
    }
  });
});

describe("splitTopLevel", () => {
  test("splits between gradients, not between their stops", () => {
    expect(splitTopLevel(base.light).length).toBe(4);
    expect(splitTopLevel("linear-gradient(0deg, a, b)")).toEqual(["linear-gradient(0deg, a, b)"]);
    expect(splitTopLevel("a, b")).toEqual(["a", "b"]);
    expect(splitTopLevel("")).toEqual([]);
  });
});

describe("composeState", () => {
  const images = { a: PIXEL, b: PIXEL };
  const compose = (layers: SceneLayer[], mode: "light" | "dark" = "light", map: Record<string, string> = images) =>
    composeState(layers, map, mode, lookup);

  test("an unknown gradient preset composes to nothing at all", () => {
    expect(compose([gradient("no-such-preset")])).toBeNull();
  });

  /** The empty stack is a state the editor can be in — it just is not a value
   *  anything can paint, so it refuses rather than writing an empty rule. */
  test("an empty stack composes to nothing, and so does one with only dead images", () => {
    expect(compose([], "light", {})).toBeNull();
    expect(compose([layer("gone")], "light", {})).toBeNull();
  });

  /** THE WHOLE POINT OF PER-STATE COMPILATION: each state takes its own half of
   *  a preset, and nothing is padded to keep two halves in step. */
  test("each state takes its own half of a gradient preset", () => {
    expect(compose([gradient(base.id)], "light")?.image).toBe(base.light);
    expect(compose([gradient(base.id)], "dark")?.image).toBe(base.dark);
  });

  test("a custom gradient has no halves to choose between — it is the same in both", () => {
    const css = composeGradient(DEFAULT_CUSTOM_GRADIENT.light);
    expect(compose([custom(css)], "light")?.image).toBe(css);
    expect(compose([custom(css)], "dark")?.image).toBe(css);
  });

  /** "Nothing underneath": no trailing entries at all, so whatever is behind the
   *  app — the desktop, through a translucent window — is the bottom. */
  test("with no gradient layer nothing is appended underneath the images", () => {
    const composed = compose([layer("a"), layer("b")]);
    const url = sceneImageUrl(PIXEL) as string;
    expect(composed?.image).toBe(`${url}, ${url}`);
    expect(composed?.size).toBe(`${DEFAULT_LAYER.scale}% auto, ${DEFAULT_LAYER.scale}% auto`);
  });

  test("a gradient layer paints full-bleed wherever it sits in the stack", () => {
    const composed = compose([gradient(base.id), layer("a")]);
    const url = sceneImageUrl(PIXEL) as string;
    const count = splitTopLevel(base.light).length;
    expect(composed?.image).toBe(`${base.light}, ${url}`);
    expect(composed?.size.split(", ")).toEqual([...Array(count).fill("cover"), `${DEFAULT_LAYER.scale}% auto`]);
    expect(composed?.position.split(", ")).toEqual([...Array(count).fill("center"), "50% 50%"]);
  });

  test("a faded gradient layer is the same gradient with alpha in its colours", () => {
    const composed = compose([gradient(base.id, 50)], "light", {});
    expect(composed?.image).toBe(withGradientAlpha(base.light, 50));
    expect(composed?.image).not.toBe(base.light);
    expect(splitTopLevel(composed?.image ?? "").length).toBe(splitTopLevel(base.light).length);
    expect(isSceneValue(composed?.image)).toBe(true);
  });

  test("a faded custom gradient fades the same way", () => {
    const css = composeGradient(DEFAULT_CUSTOM_GRADIENT.light);
    expect(compose([custom(css, 50)], "light", {})?.image).toBe(withGradientAlpha(css, 50));
  });

  test("layers paint over the bottom gradient, first layer on top", () => {
    const composed = compose([layer("a"), layer("b"), gradient(base.id)]);
    const url = sceneImageUrl(PIXEL) as string;
    expect(composed?.image.startsWith(`${url}, ${url}, `)).toBe(true);
    expect(composed?.image.endsWith(base.light)).toBe(true);
  });

  test("each layer contributes one size, position and repeat entry", () => {
    const composed = compose([
      layer("a", { x: 10, y: 20, scale: 150, tiled: true }),
      layer("b", { x: 0, y: 100, scale: 30 }),
      gradient(base.id),
    ]);
    const baseCount = splitTopLevel(base.light).length;
    expect(composed?.size.split(", ").slice(0, 2)).toEqual(["150% auto", "30% auto"]);
    expect(composed?.position.split(", ").slice(0, 2)).toEqual(["10% 20%", "0% 100%"]);
    expect(composed?.repeat.split(", ").slice(0, 2)).toEqual(["repeat", "no-repeat"]);
    expect(composed?.size.split(", ").slice(2)).toEqual(Array(baseCount).fill("cover"));
    expect(composed?.position.split(", ").slice(2)).toEqual(Array(baseCount).fill("center"));
    expect(composed?.repeat.split(", ").slice(2)).toEqual(Array(baseCount).fill("no-repeat"));
  });

  /** The lists are POSITIONAL: if their lengths ever drift from the image
   *  list's, CSS cycles them and every layer paints with someone else's size.
   *  This is the invariant that catches that — and it now has to hold for each
   *  state on its own, where before the two were padded into agreement. */
  test("every list has exactly one entry per background-image entry, in both states", () => {
    for (const preset of BACKDROP_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        for (const opacity of [10, 50, 100]) {
          const composed = compose([layer("a"), layer("b"), gradient(preset.id, opacity)], mode);
          expect(composed, `${preset.id} ${mode} ${opacity}`).not.toBeNull();
          expect(isSceneValue(composed?.image)).toBe(true);
          const count = splitTopLevel(composed?.image ?? "").length;
          for (const list of [composed?.size, composed?.position, composed?.repeat]) {
            expect((list ?? "").split(", ").length, `${preset.id} ${mode}`).toBe(count);
          }
        }
      }
    }
  });

  test("a layer with no image is skipped, not left as a gap", () => {
    const composed = compose([layer("a"), layer("gone"), layer("b", { scale: 30 }), gradient(base.id)]);
    const baseCount = splitTopLevel(base.light).length;
    expect(splitTopLevel(composed?.image ?? "").length).toBe(2 + baseCount);
    // The second entry is b's size, not the missing layer's — the whole point.
    expect(composed?.size.split(", ")[1]).toBe("30% auto");
  });

  test("a malformed stored image is skipped like a missing one", () => {
    expect(compose([layer("a"), gradient(base.id)], "light", { a: 'data:image/png,a"b' })?.image).toBe(base.light);
  });

  /** The store's gate is silent — a value that fails it paints nothing at all
   *  — so every composition this function can produce is checked against it. */
  test("both states pass the store's gate, for every preset and a full stack", () => {
    const full = ["a", "b", "c", "d", "e", "f"].map((id, index) => layer(id, { x: index * 20, scale: 10 + index * 30, tiled: index % 2 === 0 }));
    const stacked = Object.fromEntries(full.map((l) => [l.id, PIXEL]));
    for (const preset of BACKDROP_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const composed = composeState([...full, gradient(preset.id)], stacked, mode, lookup);
        expect(composed, `${preset.id} ${mode}`).not.toBeNull();
        expect(isSceneValue(composed?.image)).toBe(true);
      }
    }
  });

  test("the default lookup finds the shipped presets", () => {
    expect(composeState(DEFAULT_SCENE.layers, {}, "light")).not.toBeNull();
  });
});

describe("withGradientAlpha", () => {
  test("full opacity is the string untouched", () => {
    expect(withGradientAlpha(base.light, 100)).toBe(base.light);
    expect(withGradientAlpha(base.light, 250)).toBe(base.light);
  });

  test("every oklch stop gains an alpha", () => {
    expect(withGradientAlpha("linear-gradient(165deg, oklch(0.98 0.012 220), oklch(0.95 0.025 260))", 60)).toBe(
      "linear-gradient(165deg, oklch(0.98 0.012 220 / 60%), oklch(0.95 0.025 260 / 60%))",
    );
  });

  /** Stacking two translucent things multiplies — the same arithmetic the
   *  rest of the stack obeys. */
  test("an existing alpha is multiplied, in either notation", () => {
    expect(withGradientAlpha("radial-gradient(oklch(0.5 0.1 200 / 50%), transparent)", 50)).toBe("radial-gradient(oklch(0.5 0.1 200 / 25%), transparent)");
    expect(withGradientAlpha("radial-gradient(oklch(0.5 0.1 200 / 0.5), transparent)", 20)).toBe("radial-gradient(oklch(0.5 0.1 200 / 10%), transparent)");
  });

  test("transparent is left exactly as it is", () => {
    const value = "radial-gradient(at 14% 18%, oklch(0.93 0.07 165) 0px, transparent 55%)";
    const faded = withGradientAlpha(value, 40);
    expect(faded).toBe("radial-gradient(at 14% 18%, oklch(0.93 0.07 165 / 40%) 0px, transparent 55%)");
    expect(faded.split("transparent").length).toBe(2);
  });

  test("hex stops become eight digits, short forms expanded", () => {
    expect(withGradientAlpha("linear-gradient(160deg, #eef2ff 0%, #fce7f3 100%)", 50)).toBe("linear-gradient(160deg, #eef2ff80 0%, #fce7f380 100%)");
    expect(withGradientAlpha("linear-gradient(#abc 0%, #000000ff 100%)", 100 / 2)).toBe("linear-gradient(#aabbcc80 0%, #00000080 100%)");
    expect(withGradientAlpha("linear-gradient(#0000007f 0%, #fff 100%)", 50)).toBe("linear-gradient(#00000040 0%, #ffffff80 100%)");
  });

  test("percentages stay short and never carry noise", () => {
    expect(withGradientAlpha("linear-gradient(oklch(0.5 0.1 200), oklch(0.5 0.1 200 / 33%))", 33)).toBe(
      "linear-gradient(oklch(0.5 0.1 200 / 33%), oklch(0.5 0.1 200 / 10.89%))",
    );
  });

  /** The whole point of doing this as string surgery: the result is still a
   *  value the store will accept — for every preset, both halves, every fade. */
  test("the result still passes the store's gates", () => {
    for (const preset of BACKDROP_PRESETS) {
      for (const half of [preset.light, preset.dark]) {
        for (const opacity of [10, 25, 50, 75, 99]) {
          const faded = withGradientAlpha(half, opacity);
          expect(isGradientValue(faded)).toBe(true);
          expect(isSceneValue(faded)).toBe(true);
          expect(splitTopLevel(faded).length).toBe(splitTopLevel(half).length);
        }
      }
    }
  });

  test("a value with nothing to fade comes back unharmed", () => {
    expect(withGradientAlpha("linear-gradient(transparent, transparent)", 50)).toBe("linear-gradient(transparent, transparent)");
  });
});
