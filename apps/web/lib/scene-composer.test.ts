// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { isGradientValue, isSceneValue } from "./backdrop";
import { composeGradient, DEFAULT_GRADIENT_SPECS, GRADIENT_STARTERS, type CustomGradientSpec, type GradientStarter } from "./gradient-starters";
import {
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
  setGradientSpec,
  splitTopLevel,
  updateSceneLayer,
  updateSceneLayerAt,
  withGradientAlpha,
  type Scene,
  type SceneGradientLayer,
  type SceneImageLayer,
  type SceneLayer,
} from "./scene-composer";

/** A one-pixel WebP, shaped exactly like what the canvas encoder emits — the
 *  `;base64` in here is the whole reason sceneImageUrl exists. */
const PIXEL = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const base: GradientStarter = GRADIENT_STARTERS[0];

function layer(id: string, overrides: Partial<Omit<SceneImageLayer, "type">> = {}): SceneImageLayer {
  return { id, ...DEFAULT_LAYER, ...overrides };
}

function gradient(spec: CustomGradientSpec, opacity = 100): SceneGradientLayer {
  return { type: "gradient", spec, opacity };
}

/** A stack with a full-bleed gradient at the bottom — the picture most of these
 *  tests describe, and what the old mandatory "base" turned into. */
function scene(layers: SceneLayer[], bottom: CustomGradientSpec | null = base.light): Scene {
  return { layers: bottom === null ? layers : [...layers, gradient(bottom)] };
}

/** The bottom-most layer's stops, or null — what `sceneBasePresetId` used to
 *  answer before the composition's BASE became a colour and this became an
 *  ordinary layer like any other. */
const bottomSpec = (value: Scene): CustomGradientSpec | null => {
  const bottom = value.layers[value.layers.length - 1];
  return bottom !== undefined && bottom.type === "gradient" ? bottom.spec : null;
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
    expect(migrated.layers).toEqual([layer("a"), gradient(base.light)]);
    expect(bottomSpec(migrated)).toEqual(base.light);
  });

  /** THE STATE DECIDES WHICH HALF a named starter expands to — the same stored
   *  scene read for dark is a different set of stops, which is the whole reason
   *  the parser takes a mode. */
  test("a named base expands into the half the state needs", () => {
    const starter = GRADIENT_STARTERS[1];
    const raw = JSON.stringify({ baseId: starter.id, layers: [] });
    expect(bottomSpec(parseScene(raw, "light"))).toEqual(starter.light);
    expect(bottomSpec(parseScene(raw, "dark"))).toEqual(starter.dark);
  });

  test("an unknown base falls back rather than painting nothing", () => {
    const fallback = GRADIENT_STARTERS.find((entry) => entry.id === DEFAULT_SCENE_BASE)!;
    expect(bottomSpec(parseScene(JSON.stringify({ baseId: "no-such-preset", layers: [] })))).toEqual(fallback.light);
    expect(bottomSpec(parseScene(JSON.stringify({ baseId: base.id, layers: [] })))).toEqual(base.light);
  });

  /** A stack without a `baseId` is saying "nothing underneath" — no base may be
   *  invented on read. */
  test("a scene with layers and no baseId keeps its transparent bottom", () => {
    const parsed = parseScene(JSON.stringify({ layers: [{ type: "image", id: "a" }] }));
    expect(parsed.layers).toEqual([layer("a")]);
    expect(bottomSpec(parsed)).toBeNull();
    expect(parseScene(JSON.stringify({ layers: [] })).layers).toEqual([]);
  });

  test("a layer with no type is read as an image, like older builds wrote it", () => {
    expect(parseSceneLayer({ id: "a", x: 10 })).toEqual({ id: "a", ...DEFAULT_LAYER, x: 10 });
  });

  /** A gradient layer carries its own stops now. An OLDER one named a preset,
   *  and reading it forward is what the starter table is consulted for. */
  test("gradient layers carry their stops, and an older one's preset expands", () => {
    const spec: CustomGradientSpec = { type: "radial", angle: 0, centerX: 10, centerY: 90, stops: [{ color: "#010203", position: 0, opacity: 100 }, { color: "#040506", position: 100, opacity: 50 }] };
    expect(parseSceneLayer({ type: "gradient", spec, opacity: 40 })).toEqual(gradient(spec, 40));
    expect(parseSceneLayer({ type: "gradient", presetId: base.id, opacity: 40 })).toEqual(gradient(base.light, 40));
    expect(parseSceneLayer({ type: "gradient", presetId: base.id }, "dark")).toEqual(gradient(base.dark, 100));
    // An id this build dropped, and no id at all, both land on the fallback
    // starter rather than becoming a gap in a positional list.
    const fallback = GRADIENT_STARTERS.find((entry) => entry.id === DEFAULT_SCENE_BASE)!;
    expect(parseSceneLayer({ type: "gradient", presetId: "no-such-preset", opacity: 999 })).toEqual(gradient(fallback.light, 100));
    expect(parseSceneLayer({ type: "gradient", opacity: 1 })).toEqual(gradient(fallback.light, SCENE_LIMITS.opacity.min));
  });

  /** The PRE-COMPOSER layer: resolved CSS, read back into the stops that made
   *  it. A value that is not a gradient at all is fatal for that layer, there
   *  being no "the one they meant". */
  test("a custom-gradient layer becomes an authored one, or is dropped outright", () => {
    const css = "linear-gradient(30deg, #112233 0%, #445566 60%, #778899 100%)";
    expect(parseSceneLayer({ type: "custom-gradient", css, opacity: 40 })).toEqual(
      gradient(
        {
          type: "linear",
          angle: 30,
          centerX: 50,
          centerY: 50,
          stops: [
            { color: "#112233", position: 0, opacity: 100 },
            { color: "#445566", position: 60, opacity: 100 },
            { color: "#778899", position: 100, opacity: 100 },
          ],
        },
        40,
      ),
    );
    // A gradient this build cannot take apart keeps its place and opens on the
    // default: the layer survives, its stops do not.
    expect(parseSceneLayer({ type: "custom-gradient", css: "linear-gradient(1deg, red, blue)" })).toEqual(gradient(DEFAULT_GRADIENT_SPECS.light, 100));
    expect(parseSceneLayer({ type: "custom-gradient", css: "linear-gradient(1deg, red, blue)" }, "dark")).toEqual(gradient(DEFAULT_GRADIENT_SPECS.dark, 100));
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
    const gradients = Array.from({ length: MAX_SCENE_GRADIENT_LAYERS + 3 }, () => ({ type: "gradient", spec: base.light }));
    const parsed = parseScene(JSON.stringify({ layers: [...layers, ...gradients] }));
    expect(countSceneImages(parsed)).toBe(MAX_SCENE_LAYERS);
    expect(countSceneGradients(parsed)).toBe(MAX_SCENE_GRADIENT_LAYERS);
    expect(new Set(parsed.layers.flatMap((l) => (l.type === "image" ? [l.id] : []))).size).toBe(MAX_SCENE_LAYERS);
  });

  test("a migrated base does not push the gradient cap over", () => {
    const gradients = Array.from({ length: MAX_SCENE_GRADIENT_LAYERS }, () => ({ type: "gradient", spec: base.light }));
    expect(countSceneGradients(parseScene(JSON.stringify({ baseId: base.id, layers: gradients })))).toBe(MAX_SCENE_GRADIENT_LAYERS);
  });

  test("a scene round-trips through its own JSON", () => {
    const original = scene([layer("a", { x: 10, y: 90, scale: 130, opacity: 45, tiled: true }), gradient(base.dark, 30), layer("b")]);
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

/** Layer identity for an assertion: an image is its id, a gradient is the CSS
 *  it composes to — which is the only thing a gradient layer IS now. */
const ids = (value: Scene) => value.layers.map((l) => (l.type === "image" ? l.id : `~${composeGradient(l.spec)}`));

describe("editing", () => {
  const BASE_CSS = `~${composeGradient(base.light)}`;

  test("a new layer lands on top with centred defaults", () => {
    const next = addSceneLayer(scene([layer("a")]), "b");
    expect(ids(next)).toEqual(["b", "a", BASE_CSS]);
    expect(next.layers[0]).toEqual({ id: "b", ...DEFAULT_LAYER });
  });

  test("the cap and duplicate ids are refused as no-ops", () => {
    const full = scene(["a", "b", "c", "d", "e", "f"].map((id) => layer(id)));
    expect(addSceneLayer(full, "g")).toBe(full);
    expect(countSceneImages(addSceneLayer(scene([layer("a")]), "a"))).toBe(1);
  });

  test("a gradient layer lands on top too, and is capped on its own", () => {
    const other = GRADIENT_STARTERS[1].light;
    const next = addSceneGradientLayer(scene([layer("a")]), other);
    expect(ids(next)).toEqual([`~${composeGradient(other)}`, "a", BASE_CSS]);
    expect(next.layers[0]).toEqual(gradient(other, 100));
    const full = scene(Array.from({ length: MAX_SCENE_GRADIENT_LAYERS }, () => gradient(base.light)), null);
    expect(addSceneGradientLayer(full, other)).toBe(full);
  });

  test("a gradient layer's stops are rewritten in place, keeping its fade", () => {
    const second: CustomGradientSpec = { ...DEFAULT_GRADIENT_SPECS.light, angle: 42 };
    const stack: Scene = { layers: [gradient(DEFAULT_GRADIENT_SPECS.light, 60), layer("a")] };
    expect(setGradientSpec(stack, 0, second).layers[0]).toEqual(gradient(second, 60));
    // An image layer, and a row that is not there at all: both no-ops.
    expect(setGradientSpec(stack, 1, second)).toBe(stack);
    expect(setGradientSpec(stack, 9, second)).toBe(stack);
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
    const mixed: Scene = { layers: [layer("a"), gradient(base.light, 40), layer("b")] };
    expect(ids(moveSceneLayerAt(mixed, 1, -1))).toEqual([BASE_CSS, "a", "b"]);
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

  test("a gradient layer takes only opacity from a patch", () => {
    const one: Scene = { layers: [gradient(base.light, 100), layer("a")] };
    expect(updateSceneLayerAt(one, 0, { opacity: 35, x: 10, scale: 200, tiled: true }).layers[0]).toEqual(gradient(base.light, 35));
    expect(updateSceneLayerAt(one, 0, { opacity: 0 }).layers[0]).toEqual(gradient(base.light, SCENE_LIMITS.opacity.min));
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
    // An authored spec composes to ONE gradient with five stops in it, which is
    // exactly the value that would be shredded by a naive comma split.
    expect(splitTopLevel(composeGradient(base.light)).length).toBe(1);
    expect(splitTopLevel("radial-gradient(at 1% 2%, a, b), linear-gradient(0deg, c, d)").length).toBe(2);
    expect(splitTopLevel("linear-gradient(0deg, a, b)")).toEqual(["linear-gradient(0deg, a, b)"]);
    expect(splitTopLevel("a, b")).toEqual(["a", "b"]);
    expect(splitTopLevel("")).toEqual([]);
  });
});

describe("composeState", () => {
  const images = { a: PIXEL, b: PIXEL };
  const compose = (layers: SceneLayer[], map: Record<string, string> = images) => composeState(layers, map);
  const BASE_LIGHT = composeGradient(base.light);

  /** The empty stack is a state the editor can be in — it just is not a value
   *  anything can paint, so it refuses rather than writing an empty rule. */
  test("an empty stack composes to nothing, and so does one with only dead images", () => {
    expect(compose([], {})).toBeNull();
    expect(compose([layer("gone")], {})).toBeNull();
  });

  /** A LAYER CARRIES ITS OWN STOPS (#471), so there is no half to choose and no
   *  table to miss: what a stack composes to is a function of the stack alone.
   *  The two states differ because their STACKS differ, which is what a
   *  composition has meant since the model changed. */
  test("a gradient layer composes to exactly the gradient its spec makes", () => {
    expect(compose([gradient(base.light)], {})?.image).toBe(BASE_LIGHT);
    expect(compose([gradient(base.dark)], {})?.image).toBe(composeGradient(base.dark));
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
    const composed = compose([gradient(base.light), layer("a")]);
    const url = sceneImageUrl(PIXEL) as string;
    expect(composed?.image).toBe(`${BASE_LIGHT}, ${url}`);
    expect(composed?.size.split(", ")).toEqual(["cover", `${DEFAULT_LAYER.scale}% auto`]);
    expect(composed?.position.split(", ")).toEqual(["center", "50% 50%"]);
  });

  /** The layer's fade MULTIPLIES into whatever the stops already say, which is
   *  what stacking two translucent things means everywhere else. */
  test("a faded gradient layer is the same gradient with alpha in its colours", () => {
    const composed = compose([gradient(base.light, 50)], {});
    expect(composed?.image).toBe(withGradientAlpha(BASE_LIGHT, 50));
    expect(composed?.image).not.toBe(BASE_LIGHT);
    expect(splitTopLevel(composed?.image ?? "").length).toBe(1);
    expect(isSceneValue(composed?.image)).toBe(true);
  });

  test("a stop's own alpha and the layer's fade compound", () => {
    const half: CustomGradientSpec = { ...DEFAULT_GRADIENT_SPECS.light, stops: DEFAULT_GRADIENT_SPECS.light.stops.map((stop) => ({ ...stop, opacity: 50 })) };
    // 50% in the stop, 50% on the layer: a quarter, in eight-digit hex.
    expect(compose([gradient(half, 50)], {})?.image).toContain("40");
    expect(isSceneValue(compose([gradient(half, 50)], {})?.image)).toBe(true);
  });

  test("layers paint over the bottom gradient, first layer on top", () => {
    const composed = compose([layer("a"), layer("b"), gradient(base.light)]);
    const url = sceneImageUrl(PIXEL) as string;
    expect(composed?.image.startsWith(`${url}, ${url}, `)).toBe(true);
    expect(composed?.image.endsWith(BASE_LIGHT)).toBe(true);
  });

  test("each layer contributes one size, position and repeat entry", () => {
    const composed = compose([
      layer("a", { x: 10, y: 20, scale: 150, tiled: true }),
      layer("b", { x: 0, y: 100, scale: 30 }),
      gradient(base.light),
    ]);
    expect(composed?.size.split(", ")).toEqual(["150% auto", "30% auto", "cover"]);
    expect(composed?.position.split(", ")).toEqual(["10% 20%", "0% 100%", "center"]);
    expect(composed?.repeat.split(", ")).toEqual(["repeat", "no-repeat", "no-repeat"]);
  });

  /** The lists are POSITIONAL: if their lengths ever drift from the image
   *  list's, CSS cycles them and every layer paints with someone else's size.
   *  This is the invariant that catches that, over every starter's two halves
   *  since those are what the chips and the built-ins actually put in a stack. */
  test("every list has exactly one entry per background-image entry, for every starter", () => {
    for (const starter of GRADIENT_STARTERS) {
      for (const mode of ["light", "dark"] as const) {
        for (const opacity of [10, 50, 100]) {
          const composed = compose([layer("a"), layer("b"), gradient(starter[mode], opacity)]);
          expect(composed, `${starter.id} ${mode} ${opacity}`).not.toBeNull();
          expect(isSceneValue(composed?.image)).toBe(true);
          const count = splitTopLevel(composed?.image ?? "").length;
          for (const list of [composed?.size, composed?.position, composed?.repeat]) {
            expect((list ?? "").split(", ").length, `${starter.id} ${mode}`).toBe(count);
          }
        }
      }
    }
  });

  test("a layer with no image is skipped, not left as a gap", () => {
    const composed = compose([layer("a"), layer("gone"), layer("b", { scale: 30 }), gradient(base.light)]);
    expect(splitTopLevel(composed?.image ?? "").length).toBe(3);
    // The second entry is b's size, not the missing layer's — the whole point.
    expect(composed?.size.split(", ")[1]).toBe("30% auto");
  });

  test("a malformed stored image is skipped like a missing one", () => {
    expect(compose([layer("a"), gradient(base.light)], { a: 'data:image/png,a"b' })?.image).toBe(BASE_LIGHT);
  });

  /** The store's gate is silent — a value that fails it paints nothing at all
   *  — so every composition this function can produce is checked against it. */
  test("a full stack passes the store's gate, for every starter and both halves", () => {
    const full = ["a", "b", "c", "d", "e", "f"].map((id, index) => layer(id, { x: index * 20, scale: 10 + index * 30, tiled: index % 2 === 0 }));
    const stacked = Object.fromEntries(full.map((l) => [l.id, PIXEL]));
    for (const starter of GRADIENT_STARTERS) {
      for (const mode of ["light", "dark"] as const) {
        const composed = composeState([...full, gradient(starter[mode])], stacked);
        expect(composed, `${starter.id} ${mode}`).not.toBeNull();
        expect(isSceneValue(composed?.image)).toBe(true);
      }
    }
  });

  test("the default scene composes", () => {
    expect(composeState(DEFAULT_SCENE.layers, {})).not.toBeNull();
  });
});

describe("withGradientAlpha", () => {
  const BASE_LIGHT = composeGradient(base.light);

  test("full opacity is the string untouched", () => {
    expect(withGradientAlpha(BASE_LIGHT, 100)).toBe(BASE_LIGHT);
    expect(withGradientAlpha(BASE_LIGHT, 250)).toBe(BASE_LIGHT);
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
   *  value the store will accept — for every starter, both halves, every fade. */
  test("the result still passes the store's gates", () => {
    for (const starter of GRADIENT_STARTERS) {
      for (const half of [composeGradient(starter.light), composeGradient(starter.dark)]) {
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
