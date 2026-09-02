// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { isGradientValue, isSceneValue } from "./backdrop";
import { BACKDROP_PRESETS, type BackdropPreset } from "./backdrop-presets";
import {
  addSceneGradientLayer,
  addSceneLayer,
  composeScene,
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
  sceneBasePresetId,
  sceneImageUrl,
  SCENE_LIMITS,
  setSceneBase,
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

const base: BackdropPreset = BACKDROP_PRESETS[0];
const lookup = (id: string) => BACKDROP_PRESETS.find((preset) => preset.id === id);

function layer(id: string, overrides: Partial<Omit<SceneImageLayer, "type">> = {}): SceneImageLayer {
  return { id, ...DEFAULT_LAYER, ...overrides };
}

function gradient(presetId: string, opacity = 100): SceneGradientLayer {
  return { type: "gradient", presetId, opacity };
}

/** The old shape — images over one base — in the new model: a bottom gradient
 *  layer. Most tests below still describe exactly that picture. */
function scene(layers: SceneLayer[], baseId: string | null = base.id): Scene {
  return { layers: baseId === null ? layers : [...layers, gradient(baseId)] };
}

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
    expect(sceneBasePresetId(migrated)).toBe(base.id);
  });

  test("an unknown base falls back rather than painting nothing", () => {
    expect(sceneBasePresetId(parseScene(JSON.stringify({ baseId: "no-such-preset", layers: [] })))).toBe(DEFAULT_SCENE_BASE);
    expect(sceneBasePresetId(parseScene(JSON.stringify({ baseId: base.id, layers: [] })))).toBe(base.id);
  });

  /** The new model can say "nothing underneath", and a stored scene without a
   *  `baseId` is saying it — no base may be invented on read. */
  test("a scene with layers and no baseId keeps its transparent bottom", () => {
    const parsed = parseScene(JSON.stringify({ layers: [{ type: "image", id: "a" }] }));
    expect(parsed.layers).toEqual([layer("a")]);
    expect(sceneBasePresetId(parsed)).toBeNull();
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

const ids = (value: Scene) => value.layers.map((l) => (l.type === "image" ? l.id : `~${l.presetId}`));

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

  test("a gradient layer takes only opacity from a patch", () => {
    const one: Scene = { layers: [gradient(base.id, 100)] };
    expect(updateSceneLayerAt(one, 0, { opacity: 35, x: 10, scale: 200, tiled: true }).layers[0]).toEqual(gradient(base.id, 35));
    expect(updateSceneLayerAt(one, 0, { opacity: 0 }).layers[0]).toEqual(gradient(base.id, SCENE_LIMITS.opacity.min));
  });

  test("the base is the bottom gradient — set, swapped, or taken away", () => {
    const stack: Scene = { layers: [layer("a"), gradient(base.id, 60)] };
    expect(sceneBasePresetId(stack)).toBe(base.id);
    // Swapping keeps the fade someone chose; only the colours change.
    expect(setSceneBase(stack, BACKDROP_PRESETS[1].id).layers[1]).toEqual(gradient(BACKDROP_PRESETS[1].id, 60));
    expect(setSceneBase(stack, null).layers).toEqual([layer("a")]);
    const bare: Scene = { layers: [layer("a")] };
    expect(sceneBasePresetId(bare)).toBeNull();
    expect(setSceneBase(bare, null)).toBe(bare);
    expect(setSceneBase(bare, base.id).layers).toEqual([layer("a"), gradient(base.id, 100)]);
    expect(setSceneBase(bare, "no-such-preset")).toBe(bare);
    // An empty stack is a legal state, and "None" on it is still a no-op.
    expect(setSceneBase({ layers: [] }, null).layers).toEqual([]);
    expect(setSceneBase({ layers: [] }, base.id).layers).toEqual([gradient(base.id, 100)]);
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

describe("composeScene", () => {
  const images = { a: PIXEL, b: PIXEL };

  test("an unknown gradient preset composes to nothing at all", () => {
    expect(composeScene({ layers: [gradient("no-such-preset")] }, {}, lookup)).toBeNull();
  });

  /** The empty stack is a state the editor can be in — it just is not a value
   *  anything can paint, so it refuses rather than writing an empty rule. */
  test("an empty stack composes to nothing, and so does one with only dead images", () => {
    expect(composeScene({ layers: [] }, {}, lookup)).toBeNull();
    expect(composeScene({ layers: [layer("gone")] }, {}, lookup)).toBeNull();
  });

  /** "None (transparent)": no trailing entries at all, so whatever is behind
   *  the app — the desktop, through a translucent window — is the bottom. */
  test("with no gradient layer nothing is appended underneath the images", () => {
    const composed = composeScene({ layers: [layer("a"), layer("b")] }, images, lookup);
    const url = sceneImageUrl(PIXEL) as string;
    expect(composed?.light).toBe(`${url}, ${url}`);
    expect(composed?.dark).toBe(`${url}, ${url}`);
    expect(composed?.size).toBe(`${DEFAULT_LAYER.scale}% auto, ${DEFAULT_LAYER.scale}% auto`);
  });

  test("a gradient layer paints full-bleed wherever it sits in the stack", () => {
    const composed = composeScene({ layers: [gradient(base.id), layer("a")] }, images, lookup);
    const url = sceneImageUrl(PIXEL) as string;
    const count = splitTopLevel(base.light).length;
    expect(composed?.light).toBe(`${base.light}, ${url}`);
    expect(composed?.size?.split(", ")).toEqual([...Array(count).fill("cover"), `${DEFAULT_LAYER.scale}% auto`]);
    expect(composed?.position?.split(", ")).toEqual([...Array(count).fill("center"), "50% 50%"]);
  });

  test("a faded gradient layer is the same gradient with alpha in its colours", () => {
    const composed = composeScene({ layers: [gradient(base.id, 50)] }, {}, lookup);
    expect(composed?.light).toBe(withGradientAlpha(base.light, 50));
    expect(composed?.light).not.toBe(base.light);
    expect(splitTopLevel(composed?.light ?? "").length).toBe(splitTopLevel(base.light).length);
    expect(isSceneValue(composed?.light)).toBe(true);
  });

  test("every preset survives every fade, in both halves and the store's gate", () => {
    for (const preset of BACKDROP_PRESETS) {
      for (const opacity of [10, 33, 50, 99, 100]) {
        const composed = composeScene({ layers: [gradient(preset.id, opacity), layer("a")] }, images, lookup);
        expect(composed).not.toBeNull();
        expect(isSceneValue(composed?.light)).toBe(true);
        expect(isSceneValue(composed?.dark)).toBe(true);
        const count = splitTopLevel(composed?.light ?? "").length;
        expect(splitTopLevel(composed?.dark ?? "").length).toBe(count);
        for (const list of [composed?.size, composed?.position, composed?.repeat]) {
          expect((list ?? "").split(", ").length).toBe(count);
        }
      }
    }
  });

  test("with no layers it is just the base, in both halves", () => {
    const composed = composeScene(scene([]), {}, lookup);
    expect(composed?.light).toBe(base.light);
    expect(composed?.dark).toBe(base.dark);
  });

  test("layers paint over the base, first layer on top", () => {
    const composed = composeScene(scene([layer("a"), layer("b")]), images, lookup);
    const url = sceneImageUrl(PIXEL) as string;
    expect(composed?.light.startsWith(`${url}, ${url}, `)).toBe(true);
    expect(composed?.light.endsWith(base.light)).toBe(true);
    expect(composed?.dark.endsWith(base.dark)).toBe(true);
  });

  test("each layer contributes one size, position and repeat entry", () => {
    const composed = composeScene(
      scene([layer("a", { x: 10, y: 20, scale: 150, tiled: true }), layer("b", { x: 0, y: 100, scale: 30 })]),
      images,
      lookup,
    );
    const baseCount = splitTopLevel(base.light).length;
    expect(composed?.size?.split(", ").slice(0, 2)).toEqual(["150% auto", "30% auto"]);
    expect(composed?.position?.split(", ").slice(0, 2)).toEqual(["10% 20%", "0% 100%"]);
    expect(composed?.repeat?.split(", ").slice(0, 2)).toEqual(["repeat", "no-repeat"]);
    expect(composed?.size?.split(", ").slice(2)).toEqual(Array(baseCount).fill("cover"));
    expect(composed?.position?.split(", ").slice(2)).toEqual(Array(baseCount).fill("center"));
    expect(composed?.repeat?.split(", ").slice(2)).toEqual(Array(baseCount).fill("no-repeat"));
  });

  /** The lists are POSITIONAL: if their lengths ever drift from the image
   *  list's, CSS cycles them and every layer paints with someone else's size.
   *  This is the invariant that catches that. */
  test("every list has exactly one entry per background-image entry", () => {
    for (const preset of BACKDROP_PRESETS) {
      const composed = composeScene(scene([layer("a"), layer("b")], preset.id), images, lookup);
      expect(composed).not.toBeNull();
      const count = splitTopLevel(composed?.light ?? "").length;
      expect(splitTopLevel(composed?.dark ?? "").length).toBe(count);
      for (const list of [composed?.size, composed?.position, composed?.repeat]) {
        expect((list ?? "").split(", ").length).toBe(count);
      }
    }
  });

  test("a layer with no image is skipped, not left as a gap", () => {
    const composed = composeScene(scene([layer("a"), layer("gone"), layer("b", { scale: 30 })]), images, lookup);
    const baseCount = splitTopLevel(base.light).length;
    expect(splitTopLevel(composed?.light ?? "").length).toBe(2 + baseCount);
    // The second entry is b's size, not the missing layer's — the whole point.
    expect(composed?.size?.split(", ")[1]).toBe("30% auto");
  });

  test("a malformed stored image is skipped like a missing one", () => {
    const composed = composeScene(scene([layer("a")]), { a: 'data:image/png,a"b' }, lookup);
    expect(composed?.light).toBe(base.light);
  });

  /** The store's gate is silent — a value that fails it paints nothing at all
   *  — so every composition this function can produce is checked against it. */
  test("both halves pass the store's gate, for every preset and a full stack", () => {
    const full = ["a", "b", "c", "d", "e", "f"].map((id, index) => layer(id, { x: index * 20, scale: 10 + index * 30, tiled: index % 2 === 0 }));
    const stacked = Object.fromEntries(full.map((l) => [l.id, PIXEL]));
    for (const preset of BACKDROP_PRESETS) {
      const composed = composeScene(scene(full, preset.id), stacked, lookup);
      expect(composed).not.toBeNull();
      expect(isSceneValue(composed?.light)).toBe(true);
      expect(isSceneValue(composed?.dark)).toBe(true);
    }
  });

  test("the default lookup finds the shipped presets", () => {
    expect(composeScene(DEFAULT_SCENE, {})).not.toBeNull();
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
