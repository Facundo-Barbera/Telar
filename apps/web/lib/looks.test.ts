// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  lookAppearance,
  lookFilename,
  lookThemeId,
  MAX_LOOKS,
  parseLook,
  parseLookBackdrop,
  parseLookFile,
  parseLooks,
  parseThemeHalf,
  serializeLook,
  upsertLook,
  type Look,
} from "./looks";
import { DEFAULT_APPEARANCE, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./appearance";
import { DEFAULT_SCENE } from "./scene-composer";
import { TELAR_DARK, TELAR_LIGHT, THEME_TOKENS } from "./theme-palettes";

const GRADIENT = "linear-gradient(180deg, oklch(0.95 0.02 250) 0%, oklch(0.9 0.03 260) 100%)";
const DATA_URL = "data:image/webp;base64,AAAA";
const SCENE_VALUE = `url("data:image/webp\\00003Bbase64,AAAA"), ${GRADIENT}`;

function look(overrides: Partial<Look> = {}): Look {
  return {
    version: 1,
    id: "look-1",
    label: "Dusk",
    theme: { light: { ...TELAR_LIGHT }, dark: { ...TELAR_DARK } },
    backdrop: { kind: "none" },
    accent: "rose",
    fontSans: "inter",
    fontMono: "jetbrains",
    fontSansCustom: "",
    fontMonoCustom: "",
    fontSize: 15,
    translucencyLevel: 70,
    ...overrides,
  };
}

describe("parseThemeHalf", () => {
  test("fills every token from the Telar base when the value is absent", () => {
    expect(parseThemeHalf(undefined, "light")).toEqual(TELAR_LIGHT);
    expect(parseThemeHalf(null, "dark")).toEqual(TELAR_DARK);
  });

  test("keeps the tokens a partial half does carry", () => {
    const half = parseThemeHalf({ background: "oklch(0.5 0 0)" }, "dark");
    expect(half.background).toBe("oklch(0.5 0 0)");
    expect(half.card).toBe(TELAR_DARK.card);
    expect(Object.keys(half).sort()).toEqual([...THEME_TOKENS].sort());
  });

  // These values are joined into a compiled stylesheet; a `}` in one would
  // close the block and turn everything after it into new rules.
  test("refuses a value that could escape the declaration block", () => {
    const half = parseThemeHalf({ background: "red } html { display: none", card: "blue; color: red", popover: "<script>" }, "light");
    expect(half.background).toBe(TELAR_LIGHT.background);
    expect(half.card).toBe(TELAR_LIGHT.card);
    expect(half.popover).toBe(TELAR_LIGHT.popover);
  });

  test("refuses a non-string and an absurdly long value", () => {
    const half = parseThemeHalf({ background: 42, card: "x".repeat(200) }, "light");
    expect(half.background).toBe(TELAR_LIGHT.background);
    expect(half.card).toBe(TELAR_LIGHT.card);
  });
});

describe("parseLookBackdrop", () => {
  test("anything unrecognised is no backdrop", () => {
    expect(parseLookBackdrop(undefined)).toEqual({ kind: "none" });
    expect(parseLookBackdrop({ kind: "wallpaper" })).toEqual({ kind: "none" });
    expect(parseLookBackdrop([])).toEqual({ kind: "none" });
  });

  test("a preset keeps its id and its resolved layers", () => {
    expect(parseLookBackdrop({ kind: "gradient", id: "aurora", resolved: { light: GRADIENT, dark: GRADIENT } })).toEqual({
      kind: "gradient",
      id: "aurora",
      resolved: { light: GRADIENT, dark: GRADIENT },
    });
  });

  // The whole point of embedding the CSS is that the Look is self-contained;
  // an id with nothing behind it would set data-backdrop over a bare canvas.
  test("a preset without usable resolved layers degrades to none", () => {
    expect(parseLookBackdrop({ kind: "gradient", id: "aurora" })).toEqual({ kind: "none" });
    expect(parseLookBackdrop({ kind: "gradient", id: "aurora", resolved: { light: "url(https://evil/x.png)" } })).toEqual({ kind: "none" });
  });

  test("a custom gradient's dark half falls back to its light one", () => {
    const parsed = parseLookBackdrop({ kind: "custom-gradient", light: GRADIENT, resolved: { light: GRADIENT } });
    expect(parsed).toEqual({ kind: "custom-gradient", light: GRADIENT, dark: GRADIENT, resolved: { light: GRADIENT, dark: GRADIENT } });
  });

  test("an image carries its data URL and clamps its knobs", () => {
    expect(parseLookBackdrop({ kind: "image", fit: "tile", blur: 999, dim: -5, image: DATA_URL })).toEqual({
      kind: "image",
      fit: "tile",
      blur: 40,
      dim: 0,
      image: DATA_URL,
    });
  });

  test("an image whose data URL is missing or not an image degrades to none", () => {
    expect(parseLookBackdrop({ kind: "image", fit: "cover" })).toEqual({ kind: "none" });
    expect(parseLookBackdrop({ kind: "image", fit: "cover", image: "https://example.com/x.png" })).toEqual({ kind: "none" });
  });

  test("an unknown fit falls back to cover", () => {
    const parsed = parseLookBackdrop({ kind: "image", fit: "stretch", image: DATA_URL });
    expect(parsed.kind === "image" && parsed.fit).toBe("cover");
  });

  // The composer's own source shape is ITS business — this asserts only that a
  // Look carries one through, keeps the per-layer lists, and filters the image
  // map, so a change to Scene's members does not rewrite this test.
  test("a scene keeps its editable source, its images and its lists", () => {
    const parsed = parseLookBackdrop({
      kind: "scene",
      scene: DEFAULT_SCENE,
      images: { l1: DATA_URL, "orig:l1": DATA_URL, junk: "not-an-image" },
      resolved: { light: SCENE_VALUE, dark: SCENE_VALUE, size: "60% auto, cover", position: "10% 20%, center", repeat: "no-repeat, no-repeat" },
    });
    expect(parsed.kind).toBe("scene");
    if (parsed.kind !== "scene") return;
    expect(parsed.scene).toEqual(DEFAULT_SCENE);
    expect(Object.keys(parsed.images).sort()).toEqual(["l1", "orig:l1"]);
    expect(parsed.resolved.size).toBe("60% auto, cover");
  });

  test("a scene with an unreadable source still parses, on the composer's default", () => {
    const parsed = parseLookBackdrop({ kind: "scene", scene: "junk", images: "junk", resolved: { light: SCENE_VALUE } });
    expect(parsed.kind === "scene" && parsed.scene).toEqual(DEFAULT_SCENE);
    expect(parsed.kind === "scene" && parsed.images).toEqual({});
  });

  // isSceneValue only allows data: URLs; a remote one would make the page fetch.
  test("a scene whose layers reference a remote url degrades to none", () => {
    expect(parseLookBackdrop({ kind: "scene", scene: { baseId: "aurora", layers: [] }, images: {}, resolved: { light: 'url("https://evil/x.png")' } })).toEqual({
      kind: "none",
    });
  });
});

describe("parseLook", () => {
  test("needs an id and a label, and nothing else", () => {
    expect(parseLook({ label: "No id" })).toBeUndefined();
    expect(parseLook({ id: "a" })).toBeUndefined();
    expect(parseLook("nope")).toBeUndefined();
    const bare = parseLook({ id: "a", label: "Bare" });
    expect(bare?.accent).toBe(DEFAULT_APPEARANCE.accent);
    expect(bare?.backdrop).toEqual({ kind: "none" });
    expect(bare?.theme.light).toEqual(TELAR_LIGHT);
  });

  test("unrecognised enum members fall to the appearance defaults", () => {
    const parsed = parseLook({ id: "a", label: "L", accent: "chartreuse", fontSans: "comic", fontMono: 7 });
    expect(parsed?.accent).toBe(DEFAULT_APPEARANCE.accent);
    expect(parsed?.fontSans).toBe(DEFAULT_APPEARANCE.fontSans);
    expect(parsed?.fontMono).toBe(DEFAULT_APPEARANCE.fontMono);
  });

  test("numbers are clamped into the ranges their controls allow", () => {
    const low = parseLook({ id: "a", label: "L", fontSize: 2, translucencyLevel: -40 });
    expect(low?.fontSize).toBe(MIN_FONT_SIZE);
    expect(low?.translucencyLevel).toBe(0);
    const high = parseLook({ id: "a", label: "L", fontSize: 99, translucencyLevel: 400 });
    expect(high?.fontSize).toBe(MAX_FONT_SIZE);
    expect(high?.translucencyLevel).toBe(100);
  });

  // The desktop toggle is a machine preference, not taste — see lib/looks.ts.
  test("never carries the desktop translucency toggle", () => {
    const parsed = parseLook({ id: "a", label: "L", translucent: true, frost: "clear" });
    expect(parsed && "translucent" in parsed).toBe(false);
    expect(parsed && "frost" in parsed).toBe(false);
  });

  test("always reports version 1", () => {
    expect(parseLook({ id: "a", label: "L", version: 99 })?.version).toBe(1);
  });
});

describe("parseLooks", () => {
  test("total against every kind of junk", () => {
    expect(parseLooks(null)).toEqual([]);
    expect(parseLooks("{")).toEqual([]);
    expect(parseLooks('{"not":"a list"}')).toEqual([]);
  });

  test("drops unreadable entries rather than the whole list", () => {
    const looks = parseLooks(JSON.stringify([look(), "junk", { label: "no id" }, look({ id: "look-2", label: "Dawn" })]));
    expect(looks.map((entry) => entry.label)).toEqual(["Dusk", "Dawn"]);
  });

  test("collapses duplicate ids so wearing one is never ambiguous", () => {
    const looks = parseLooks(JSON.stringify([look({ label: "First" }), look({ label: "Second" })]));
    expect(looks.map((entry) => entry.label)).toEqual(["First"]);
  });

  test("reads no more than the cap", () => {
    const many = Array.from({ length: MAX_LOOKS + 5 }, (_, index) => look({ id: `look-${index}` }));
    expect(parseLooks(JSON.stringify(many))).toHaveLength(MAX_LOOKS);
  });
});

describe("the shareable file", () => {
  test("export then import round-trips every member but the id", () => {
    const original = look({
      backdrop: { kind: "gradient", id: "aurora", resolved: { light: GRADIENT, dark: GRADIENT } },
      fontSans: "custom",
      fontSansCustom: "SF Pro Text, Helvetica",
    });
    const restored = parseLookFile(serializeLook(original), "look-fresh");
    expect(restored).toEqual({ ...original, id: "look-fresh" });
  });

  // Importing the same file twice should give two cards, not overwrite one.
  test("the imported look takes the fresh id, never the file's", () => {
    expect(parseLookFile(serializeLook(look()), "look-other")?.id).toBe("look-other");
  });

  test("refuses a file that is not a Look", () => {
    expect(parseLookFile("not json", "x")).toBeUndefined();
    expect(parseLookFile("[]", "x")).toBeUndefined();
    expect(parseLookFile('{"label":42}', "x")).toBeUndefined();
  });

  test("a file with only a label still opens, filled from the defaults", () => {
    const restored = parseLookFile('{"label":"Minimal"}', "look-min");
    expect(restored?.label).toBe("Minimal");
    expect(restored?.theme.dark).toEqual(TELAR_DARK);
  });
});

describe("lookFilename", () => {
  test("hyphenates the label", () => {
    expect(lookFilename(look({ label: "Deep Sea Night" }))).toBe("deep-sea-night.telar-look.json");
  });

  test("falls back when the label has no filename characters at all", () => {
    expect(lookFilename(look({ label: "***" }))).toBe("look.telar-look.json");
    expect(lookFilename(look({ label: "" }))).toBe("look.telar-look.json");
  });
});

describe("upsertLook", () => {
  test("a new look lands at the front", () => {
    const list = upsertLook([look({ id: "a" })], look({ id: "b", label: "New" }));
    expect(list?.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  test("re-saving an id replaces in place rather than duplicating", () => {
    const list = upsertLook([look({ id: "a", label: "Old" }), look({ id: "b" })], look({ id: "a", label: "New" }));
    expect(list?.map((entry) => entry.label)).toEqual(["New", "Dusk"]);
  });

  test("refuses a new look at the cap, but still allows a replacement", () => {
    const full = Array.from({ length: MAX_LOOKS }, (_, index) => look({ id: `look-${index}` }));
    expect(upsertLook(full, look({ id: "fresh" }))).toBeUndefined();
    expect(upsertLook(full, look({ id: "look-3", label: "Edited" }))).toHaveLength(MAX_LOOKS);
  });
});

describe("wearing", () => {
  test("the installed theme id is stable per look", () => {
    expect(lookThemeId(look({ id: "look-7" }))).toBe("look-look-7");
  });

  test("the appearance patch carries taste and not the machine's toggle", () => {
    expect(lookAppearance(look())).toEqual({
      accent: "rose",
      fontSans: "inter",
      fontMono: "jetbrains",
      fontSansCustom: "",
      fontMonoCustom: "",
      fontSize: 15,
      translucencyLevel: 70,
    });
  });
});
