// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildStudioPrompt,
  customGradientBackdrop,
  DEFAULT_IMAGE_DIM,
  describeDraft,
  designSummary,
  draftGradientPair,
  draftScenePreset,
  draftSceneStack,
  imageBackdrop,
  patchImageBackdrop,
  presetBackdrop,
  sceneBackdrop,
  mergeDesignIntoDraft,
  chatLabel,
  readStudioChats,
  scenePresetBackdrop,
  STUDIO_CHAT_KEY,
  writeStudioChats,
  type StudioDraft,
} from "./studio-draft";
import { MAX_BACKDROP_BLUR } from "./backdrop";
import { BACKDROP_PRESETS, DEFAULT_CUSTOM_GRADIENT } from "./backdrop-presets";
import { TELAR_DARK, TELAR_LIGHT, THEME_TOKENS } from "./theme-palettes";
import type { DesignSuccess } from "./theme-designer";

const PRESET_ID = BACKDROP_PRESETS[0]!.id;
const DATA_URL = "data:image/webp;base64,AAAA";

function draft(overrides: Partial<StudioDraft> = {}): StudioDraft {
  return {
    version: 1,
    id: "look-1",
    label: "Working draft",
    theme: { light: { ...TELAR_LIGHT }, dark: { ...TELAR_DARK } },
    backdrop: { kind: "none" },
    accent: "indigo",
    fontSans: "geist",
    fontMono: "geist",
    fontSansCustom: "",
    fontMonoCustom: "",
    fontSize: 14,
    fontMonoSize: 13,
    translucencyLevel: 40,
    depth: "soft",
    ...overrides,
  };
}

function design(overrides: Partial<DesignSuccess> = {}): DesignSuccess {
  return {
    definition: { label: "Cedar Dusk", light: { ...TELAR_LIGHT, background: "#fdfaf6" }, dark: { ...TELAR_DARK, background: "#171310" } },
    ...overrides,
  };
}

describe("the scene tool's one-layer backdrop", () => {
  test("a known preset becomes a scene the full composer could reopen", () => {
    const backdrop = scenePresetBackdrop(PRESET_ID, 80);
    expect(backdrop?.kind).toBe("scene");
    if (backdrop?.kind !== "scene") throw new Error("unreachable");
    expect(backdrop.scene.layers).toEqual([{ type: "gradient", presetId: PRESET_ID, opacity: 80 }]);
    expect(backdrop.images).toEqual({});
    expect(backdrop.resolved.light.length).toBeGreaterThan(0);
  });

  test("an unknown preset refuses rather than composing to nothing", () => {
    expect(scenePresetBackdrop("not-a-preset", 100)).toBeUndefined();
  });

  test("the fade is clamped into the composer's own range", () => {
    const backdrop = scenePresetBackdrop(PRESET_ID, 0);
    if (backdrop?.kind !== "scene") throw new Error("unreachable");
    expect(backdrop.scene.layers[0]).toMatchObject({ opacity: 10 });
  });

  test("reading back only recognises a single gradient layer", () => {
    const one = { ...draft(), backdrop: scenePresetBackdrop(PRESET_ID, 70)! };
    expect(draftScenePreset(one)).toEqual({ presetId: PRESET_ID, opacity: 70 });

    expect(draftScenePreset(draft())).toBeUndefined();
    const stacked: StudioDraft = { ...draft(), backdrop: {
      kind: "scene" as const,
      scene: { layers: [{ type: "gradient", presetId: PRESET_ID, opacity: 100 }, { type: "gradient", presetId: PRESET_ID, opacity: 50 }] },
      images: {},
      resolved: { light: "linear-gradient(#fff, #000)", dark: "linear-gradient(#000, #fff)" },
    } };
    expect(draftScenePreset(stacked)).toBeUndefined();
  });
});

describe("the backdrop tool's constructors", () => {
  test("a preset carries its own halves as the resolved CSS", () => {
    const backdrop = presetBackdrop(PRESET_ID);
    if (backdrop?.kind !== "gradient") throw new Error("unreachable");
    expect(backdrop.id).toBe(PRESET_ID);
    expect(backdrop.resolved.light).toBe(BACKDROP_PRESETS[0]!.light);
    expect(backdrop.resolved.dark).toBe(BACKDROP_PRESETS[0]!.dark);
  });

  test("an unknown preset refuses", () => {
    expect(presetBackdrop("not-a-preset")).toBeUndefined();
  });

  test("a custom gradient stores both halves and their resolved copies", () => {
    const pair = { light: { type: "linear" as const, angle: 20, stops: ["#ffffff", "#000000"] }, dark: { type: "radial" as const, angle: 0, stops: ["#111111", "#222222"] } };
    const backdrop = customGradientBackdrop(pair);
    if (backdrop?.kind !== "custom-gradient") throw new Error("unreachable");
    expect(backdrop.light).toContain("linear-gradient(20deg");
    expect(backdrop.dark).toContain("radial-gradient(");
    expect(backdrop.resolved).toEqual({ light: backdrop.light, dark: backdrop.dark });
  });

  test("a custom gradient round-trips back into stops", () => {
    const pair = { light: { type: "linear" as const, angle: 45, stops: ["#aabbcc", "#112233", "#445566"] }, dark: { type: "linear" as const, angle: 200, stops: ["#000000", "#ffffff"] } };
    const backdrop = customGradientBackdrop(pair)!;
    expect(draftGradientPair(backdrop)).toEqual(pair);
  });

  test("anything that is not a custom gradient opens on the defaults", () => {
    expect(draftGradientPair({ kind: "none" })).toEqual(DEFAULT_CUSTOM_GRADIENT);
    expect(draftGradientPair(presetBackdrop(PRESET_ID)!)).toEqual(DEFAULT_CUSTOM_GRADIENT);
  });

  test("an image lands with a default dim, and a replacement keeps the tuning", () => {
    const first = imageBackdrop(DATA_URL);
    if (first?.kind !== "image") throw new Error("unreachable");
    expect(first).toMatchObject({ fit: "cover", blur: 0, dim: DEFAULT_IMAGE_DIM, image: DATA_URL });

    const tuned = patchImageBackdrop(first, { fit: "tile", blur: 12, dim: 0 });
    const replaced = imageBackdrop("data:image/png;base64,BBBB", tuned);
    expect(replaced).toMatchObject({ fit: "tile", blur: 12, dim: 0, image: "data:image/png;base64,BBBB" });
  });

  test("only real image data URLs become a backdrop", () => {
    expect(imageBackdrop("https://example.com/cat.png")).toBeUndefined();
    expect(imageBackdrop("")).toBeUndefined();
  });

  test("image tuning clamps to the store's bounds and ignores other kinds", () => {
    const image = imageBackdrop(DATA_URL)!;
    expect(patchImageBackdrop(image, { blur: 999 })).toMatchObject({ blur: MAX_BACKDROP_BLUR });
    expect(patchImageBackdrop(image, { dim: -5 })).toMatchObject({ dim: 0 });
    // A patch against another kind is a no-op, not a coercion into an image.
    expect(patchImageBackdrop({ kind: "none" }, { blur: 10 })).toEqual({ kind: "none" });
  });

  test("a scene composes, and drops images no layer refers to", () => {
    const scene = { layers: [{ type: "gradient" as const, presetId: PRESET_ID, opacity: 100 }] };
    const backdrop = sceneBackdrop(scene, { ghost: DATA_URL, "orig:ghost": DATA_URL });
    if (backdrop?.kind !== "scene") throw new Error("unreachable");
    expect(backdrop.images).toEqual({});
    expect(backdrop.resolved.light.length).toBeGreaterThan(0);
  });

  test("an empty stack refuses rather than painting nothing", () => {
    expect(sceneBackdrop({ layers: [] }, {})).toBeUndefined();
  });

  test("the composer opens on the draft's own stack", () => {
    const scene = { layers: [{ type: "gradient" as const, presetId: PRESET_ID, opacity: 60 }] };
    const composed = sceneBackdrop(scene, {})!;
    expect(draftSceneStack(composed)).toEqual({ scene, images: {} });

    // A preset choice becomes the one bottom layer it already is…
    expect(draftSceneStack(presetBackdrop(PRESET_ID)!)).toEqual({
      scene: { layers: [{ type: "gradient", presetId: PRESET_ID, opacity: 100 }] },
      images: {},
    });
    // …and everything else opens empty, so nothing is written until a layer is.
    expect(draftSceneStack({ kind: "none" })).toEqual({ scene: { layers: [] }, images: {} });
    expect(draftSceneStack(imageBackdrop(DATA_URL)!)).toEqual({ scene: { layers: [] }, images: {} });
  });
});

describe("the chat transcripts survive navigation", () => {
  // The persistence block reads window.localStorage; the test provides one —
  // installed for THIS block only and torn down after, because a leaked global
  // `window` flips environment checks in every test file that runs later.
  const store = new Map<string, string>();
  const fake = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  let hadWindow = false;
  let previousWindow: unknown;
  beforeAll(() => {
    const host = globalThis as { window?: { localStorage?: unknown } };
    hadWindow = host.window !== undefined;
    previousWindow = host.window;
    if (!hadWindow) host.window = {};
    (host.window as { localStorage: unknown }).localStorage = fake;
  });
  afterAll(() => {
    const host = globalThis as { window?: unknown };
    if (hadWindow) host.window = previousWindow;
    else delete host.window;
  });

  test("a chat keeps only well-formed lines, and an empty list clears the key", () => {
    const lines = [
      { kind: "you" as const, text: "warmer" },
      { kind: "studio" as const, text: "Drafted “Cedar”." },
    ];
    writeStudioChats([{ id: "chat-1", label: "warmer", lines, updatedAt: 1 }]);
    expect(readStudioChats()).toEqual([{ id: "chat-1", label: "warmer", lines, updatedAt: 1 }]);

    store.set(
      STUDIO_CHAT_KEY,
      JSON.stringify([{ id: "chat-2", label: "mixed", updatedAt: 2, lines: [{ kind: "you", text: "kept" }, { kind: "shout", text: "dropped" }, "junk", { kind: "trouble" }] }]),
    );
    expect(readStudioChats()[0]?.lines).toEqual([{ kind: "you", text: "kept" }]);

    writeStudioChats([]);
    expect(store.has(STUDIO_CHAT_KEY)).toBe(false);
  });

  test("a chat with nothing said in it is not written", () => {
    writeStudioChats([{ id: "chat-empty", label: "New chat", lines: [], updatedAt: 1 }]);
    expect(store.has(STUDIO_CHAT_KEY)).toBe(false);
  });

  test("the old single-transcript shape becomes the reader's first chat", () => {
    // Nobody loses a conversation to an upgrade: the entries carry `kind`, so
    // one look at the first element tells the two shapes apart.
    store.set(STUDIO_CHAT_KEY, JSON.stringify([{ kind: "you", text: "cedar and dusk" }, { kind: "studio", text: "Drafted." }]));
    const migrated = readStudioChats();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.lines).toEqual([{ kind: "you", text: "cedar and dusk" }, { kind: "studio", text: "Drafted." }]);
    expect(migrated[0]?.label).toBe("cedar and dusk");
  });

  test("a chat is named by the first thing you said, elided when long", () => {
    expect(chatLabel([])).toBe("New chat");
    expect(chatLabel([{ kind: "studio", text: "an opening nobody typed" }])).toBe("New chat");
    expect(chatLabel([{ kind: "you", text: "warmer" }])).toBe("warmer");
    expect(chatLabel([{ kind: "you", text: "x".repeat(60) }]).endsWith("…")).toBe(true);
  });
});

describe("the chat's merge (three-way)", () => {
  // Hex halves so "the model echoed the snapshot" is expressible exactly —
  // describeDraft shows the model cssColorToHex(value), and the merge compares
  // through the same serialisation.
  const HEX_LIGHT = Object.fromEntries(THEME_TOKENS.map((token) => [token, "#dddddd"])) as StudioDraft["theme"]["light"];
  const HEX_DARK = Object.fromEntries(THEME_TOKENS.map((token) => [token, "#222222"])) as StudioDraft["theme"]["dark"];
  const hexDraft = (overrides: Partial<StudioDraft> = {}) => draft({ theme: { light: { ...HEX_LIGHT }, dark: { ...HEX_DARK } }, ...overrides });

  /** A design that echoes the snapshot verbatim except where overridden. */
  const echo = (overrides: { light?: Partial<StudioDraft["theme"]["light"]>; dark?: Partial<StudioDraft["theme"]["dark"]>; label?: string } = {}): DesignSuccess => ({
    definition: {
      label: overrides.label ?? "Working draft",
      light: { ...HEX_LIGHT, ...overrides.light },
      dark: { ...HEX_DARK, ...overrides.dark },
    },
  });

  test("only tokens the model moved land; the rest keep the current draft's values", () => {
    const snapshot = hexDraft();
    // The reader hand-edited the border while the model was thinking.
    const current = { ...snapshot, theme: { ...snapshot.theme, light: { ...snapshot.theme.light, border: "#123456" } } };
    const after = mergeDesignIntoDraft(current, snapshot, echo({ light: { background: "#fdfaf6" } }));

    expect(after.theme.light.background).toBe("#fdfaf6"); // the model's change
    expect(after.theme.light.border).toBe("#123456"); // the reader's, kept
    expect(after.theme.dark).toEqual(HEX_DARK);
    expect(after.id).toBe(current.id);
  });

  test("an echoed label keeps the reader's title; a changed one lands", () => {
    const snapshot = hexDraft();
    const renamed = { ...snapshot, label: "My Deep Sea" };
    expect(mergeDesignIntoDraft(renamed, snapshot, echo()).label).toBe("My Deep Sea");
    expect(mergeDesignIntoDraft(renamed, snapshot, echo({ label: "Cedar Dusk" })).label).toBe("Cedar Dusk");
  });

  test("an accent lands only when it differs from what the model was shown", () => {
    const snapshot = hexDraft();
    // The reader picked plum mid-flight; the model echoed the snapshot's indigo.
    const current: StudioDraft = { ...snapshot, accent: "plum" };
    expect(mergeDesignIntoDraft(current, snapshot, { ...echo(), accent: "indigo" }).accent).toBe("plum");
    expect(mergeDesignIntoDraft(current, snapshot, { ...echo(), accent: "amber" }).accent).toBe("amber");
  });

  test("type lands when offered and stays put when not", () => {
    const snapshot = hexDraft();
    const before: StudioDraft = { ...snapshot, fontSans: "inter", fontSize: 16 };
    const kept = mergeDesignIntoDraft(before, snapshot, echo());
    expect(kept.fontSans).toBe("inter");
    expect(kept.fontSize).toBe(16);
    const moved = mergeDesignIntoDraft(before, snapshot, { ...echo(), fontMono: "jetbrains", fontSize: 17 });
    expect(moved.fontMono).toBe("jetbrains");
    expect(moved.fontSize).toBe(17);
  });

  test("a drafted backdrop becomes a custom gradient carrying its own CSS", () => {
    const snapshot = hexDraft();
    const after = mergeDesignIntoDraft(snapshot, snapshot, { ...echo(), backdropSpec: { light: { type: "linear", angle: 160, stops: ["#eeeeee", "#cccccc"] }, dark: { type: "linear", angle: 160, stops: ["#222222", "#000000"] } } });
    expect(after.backdrop.kind).toBe("custom-gradient");
    if (after.backdrop.kind !== "custom-gradient") throw new Error("unreachable");
    expect(after.backdrop.light).toContain("#eeeeee");
    // The resolved layers are the same strings — a Look is self-contained.
    expect(after.backdrop.resolved.light).toBe(after.backdrop.light);
    expect(after.backdrop.resolved.dark).toBe(after.backdrop.dark);
  });

  test("keeping a backdrop keeps it; removing one clears it", () => {
    const withScene = { ...hexDraft(), backdrop: scenePresetBackdrop(PRESET_ID, 100)! };
    expect(mergeDesignIntoDraft(withScene, withScene, echo()).backdrop).toEqual(withScene.backdrop);
    expect(mergeDesignIntoDraft(withScene, withScene, { ...echo(), removeBackdrop: true }).backdrop).toEqual({ kind: "none" });
  });

  test("the summary names the theme and only what actually changed", () => {
    expect(designSummary(design())).toBe("Drafted “Cedar Dusk” — new palette.");
    const full = designSummary(design({ accent: "amber", backdropSpec: { light: { type: "linear", angle: 0, stops: ["#fff", "#eee"] }, dark: { type: "linear", angle: 0, stops: ["#111", "#000"] } } }));
    expect(full).toBe("Drafted “Cedar Dusk” — new palette, a fresh gradient backdrop, amber accent.");
    expect(designSummary({ ...design(), removeBackdrop: true, fontSize: 15 })).toBe("Drafted “Cedar Dusk” — new palette, backdrop cleared, 15px text.");
  });
});

describe("the chat's prompt", () => {
  test("the draft is serialised as hex, both halves, with its name and accent", () => {
    const described = describeDraft(draft({ label: "Cedar", accent: "moss" }));
    expect(described).toContain("Name: Cedar");
    expect(described).toContain("Accent: moss");
    expect(described).toContain("Light half:");
    expect(described).toContain("Dark half:");
    // oklch is converted, because the schema only speaks #RRGGBB.
    expect(described).toMatch(/background=#[0-9a-f]{6}/);
    expect(described).not.toContain("oklch");
    expect(described).toContain("Backdrop: none");
  });

  test("an image backdrop is described rather than dumped as base64", () => {
    const described = describeDraft(draft({ backdrop: { kind: "image", fit: "cover", blur: 0, dim: 0, image: DATA_URL } }));
    expect(described).not.toContain(DATA_URL);
    expect(described).toContain("photograph");
  });

  test("the studio prompt is the designer's brief plus the draft and an iterate instruction", () => {
    const prompt = buildStudioPrompt(draft(), "warmer", (brief) => `BASE(${brief})`);
    expect(prompt.startsWith("BASE(warmer)")).toBe(true);
    expect(prompt).toContain("NOT STARTING OVER");
    expect(prompt).toContain("Name: Working draft");
  });
});

