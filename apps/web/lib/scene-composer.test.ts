// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { isSceneValue } from "./backdrop";
import { BACKDROP_PRESETS, type BackdropPreset } from "./backdrop-presets";
import {
  addSceneLayer,
  composeScene,
  DEFAULT_LAYER,
  DEFAULT_SCENE,
  DEFAULT_SCENE_BASE,
  forgetLayerImages,
  MAX_SCENE_LAYERS,
  moveSceneLayer,
  newLayerId,
  parseScene,
  parseSceneImages,
  parseSceneLayer,
  pruneSceneImages,
  removeSceneLayer,
  sceneImageUrl,
  SCENE_LIMITS,
  splitTopLevel,
  updateSceneLayer,
  type Scene,
  type SceneLayer,
} from "./scene-composer";

/** A one-pixel WebP, shaped exactly like what the canvas encoder emits — the
 *  `;base64` in here is the whole reason sceneImageUrl exists. */
const PIXEL = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const base: BackdropPreset = BACKDROP_PRESETS[0];
const lookup = (id: string) => BACKDROP_PRESETS.find((preset) => preset.id === id);

function layer(id: string, overrides: Partial<SceneLayer> = {}): SceneLayer {
  return { id, ...DEFAULT_LAYER, ...overrides };
}

function scene(layers: SceneLayer[], baseId = base.id): Scene {
  return { baseId, layers };
}

describe("parseScene", () => {
  test("anything unrecognised is the empty default", () => {
    for (const raw of [null, "", "not json", "[]", "7", '"scene"', "{}"]) {
      expect(parseScene(raw)).toEqual(DEFAULT_SCENE);
    }
  });

  test("an unknown base falls back rather than painting nothing", () => {
    expect(parseScene(JSON.stringify({ baseId: "no-such-preset", layers: [] })).baseId).toBe(DEFAULT_SCENE_BASE);
    expect(parseScene(JSON.stringify({ baseId: base.id, layers: [] })).baseId).toBe(base.id);
  });

  test("out-of-range numbers are clamped, not dropped", () => {
    const parsed = parseScene(JSON.stringify({ baseId: base.id, layers: [{ id: "a", x: -40, y: 900, scale: 5000, opacity: 0, tiled: 1 }] }));
    expect(parsed.layers).toEqual([{ id: "a", x: 0, y: 100, scale: SCENE_LIMITS.scale.max, opacity: SCENE_LIMITS.opacity.min, tiled: false }]);
  });

  test("missing fields take the defaults", () => {
    expect(parseSceneLayer({ id: "a" })).toEqual({ id: "a", ...DEFAULT_LAYER });
  });

  test("a layer without a usable id is dropped", () => {
    for (const bad of [{}, { id: "" }, { id: 4 }, { id: "orig:a" }, { id: "a b" }, null, "a"]) {
      expect(parseSceneLayer(bad)).toBeUndefined();
    }
  });

  test("duplicate ids collapse and the stack is capped", () => {
    const layers = [{ id: "a" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }, { id: "g" }, { id: "h" }];
    const parsed = parseScene(JSON.stringify({ baseId: base.id, layers }));
    expect(parsed.layers.length).toBe(MAX_SCENE_LAYERS);
    expect(new Set(parsed.layers.map((l) => l.id)).size).toBe(MAX_SCENE_LAYERS);
  });

  test("a scene round-trips through its own JSON", () => {
    const original = scene([layer("a", { x: 10, y: 90, scale: 130, opacity: 45, tiled: true }), layer("b")]);
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

describe("editing", () => {
  test("a new layer lands on top with centred defaults", () => {
    const next = addSceneLayer(scene([layer("a")]), "b");
    expect(next.layers.map((l) => l.id)).toEqual(["b", "a"]);
    expect(next.layers[0]).toEqual({ id: "b", ...DEFAULT_LAYER });
  });

  test("the cap and duplicate ids are refused as no-ops", () => {
    const full = scene(["a", "b", "c", "d", "e", "f"].map((id) => layer(id)));
    expect(addSceneLayer(full, "g")).toBe(full);
    expect(addSceneLayer(scene([layer("a")]), "a").layers.length).toBe(1);
  });

  test("moving is clamped to the ends, never wrapped", () => {
    const three = scene([layer("a"), layer("b"), layer("c")]);
    expect(moveSceneLayer(three, "b", -1).layers.map((l) => l.id)).toEqual(["b", "a", "c"]);
    expect(moveSceneLayer(three, "b", 1).layers.map((l) => l.id)).toEqual(["a", "c", "b"]);
    expect(moveSceneLayer(three, "a", -1)).toBe(three);
    expect(moveSceneLayer(three, "c", 1)).toBe(three);
    expect(moveSceneLayer(three, "missing", -1)).toBe(three);
  });

  test("patches clamp and leave other layers alone", () => {
    const two = scene([layer("a"), layer("b")]);
    const next = updateSceneLayer(two, "a", { x: 999, opacity: -3, tiled: true });
    expect(next.layers[0]).toEqual({ id: "a", x: 100, y: 50, scale: DEFAULT_LAYER.scale, opacity: SCENE_LIMITS.opacity.min, tiled: true });
    expect(next.layers[1]).toEqual(two.layers[1]);
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

  test("an unknown base composes to nothing at all", () => {
    expect(composeScene(scene([], "no-such-preset"), {}, lookup)).toBeNull();
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
