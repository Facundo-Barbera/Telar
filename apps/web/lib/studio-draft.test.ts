// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildStudioPrompt,
  describeDraft,
  designSummary,
  draftFromLook,
  draftScenePreset,
  loadThemeHalfIntoDraft,
  loadThemeIntoDraft,
  mergeDesignIntoDraft,
  patchDraftAccent,
  patchDraftHalf,
  patchDraftStrength,
  patchDraftToken,
  patchDraftType,
  readStudioChat,
  readStudioDraft,
  replaceDraftBackdrop,
  scenePresetBackdrop,
  setDraftLabel,
  STUDIO_CHAT_KEY,
  STUDIO_DRAFT_KEY,
  writeStudioChat,
  writeStudioDraft,
  type StudioDraft,
} from "./studio-draft";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "./appearance";
import { BACKDROP_PRESETS } from "./backdrop-presets";
import { BUILT_IN_THEMES, concreteHalf, TELAR_DARK, TELAR_LIGHT } from "./theme-palettes";
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
    translucencyLevel: 40,
    ...overrides,
  };
}

function design(overrides: Partial<DesignSuccess> = {}): DesignSuccess {
  return {
    definition: { label: "Cedar Dusk", light: { ...TELAR_LIGHT, background: "#fdfaf6" }, dark: { ...TELAR_DARK, background: "#171310" } },
    ...overrides,
  };
}

describe("updaters are pure", () => {
  test("patching a token touches one half and returns a new value", () => {
    const before = draft();
    const after = patchDraftToken(before, "light", "background", "#ffeedd");

    expect(after).not.toBe(before);
    expect(after.theme.light.background).toBe("#ffeedd");
    // The other half, and the original, are untouched.
    expect(after.theme.dark.background).toBe(TELAR_DARK.background);
    expect(before.theme.light.background).toBe(TELAR_LIGHT.background);
  });

  test("patching a half replaces every token in it", () => {
    const after = patchDraftHalf(draft(), "dark", { ...TELAR_DARK, foreground: "#00ff00" });
    expect(after.theme.dark.foreground).toBe("#00ff00");
    expect(after.theme.light).toEqual(TELAR_LIGHT);
  });

  test("label and accent write only themselves", () => {
    expect(setDraftLabel(draft(), "Cedar").label).toBe("Cedar");
    expect(patchDraftAccent(draft(), "amber").accent).toBe("amber");
    expect(patchDraftAccent(draft(), "amber").theme).toEqual(draft().theme);
  });

  test("type patches clamp the font size and leave absent members alone", () => {
    expect(patchDraftType(draft(), { fontSize: 99 }).fontSize).toBe(MAX_FONT_SIZE);
    expect(patchDraftType(draft(), { fontSize: 2 }).fontSize).toBe(MIN_FONT_SIZE);
    expect(patchDraftType(draft(), { fontSize: Number.NaN }).fontSize).toBe(14);

    const fonts = patchDraftType(draft(), { fontSans: "inter", fontMonoCustom: "SF Mono" });
    expect(fonts.fontSans).toBe("inter");
    expect(fonts.fontMono).toBe("geist");
    expect(fonts.fontMonoCustom).toBe("SF Mono");
    expect(fonts.fontSize).toBe(14);
  });

  test("strength clamps to the appearance store's bounds", () => {
    expect(patchDraftStrength(draft(), 500).translucencyLevel).toBe(100);
    expect(patchDraftStrength(draft(), -20).translucencyLevel).toBe(0);
    expect(patchDraftStrength(draft(), 55).translucencyLevel).toBe(55);
  });
});

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
    const one = replaceDraftBackdrop(draft(), scenePresetBackdrop(PRESET_ID, 70)!);
    expect(draftScenePreset(one)).toEqual({ presetId: PRESET_ID, opacity: 70 });

    expect(draftScenePreset(draft())).toBeUndefined();
    const stacked = replaceDraftBackdrop(draft(), {
      kind: "scene",
      scene: { layers: [{ type: "gradient", presetId: PRESET_ID, opacity: 100 }, { type: "gradient", presetId: PRESET_ID, opacity: 50 }] },
      images: {},
      resolved: { light: "linear-gradient(#fff, #000)", dark: "linear-gradient(#000, #fff)" },
    });
    expect(draftScenePreset(stacked)).toBeUndefined();
  });
});

describe("sources load into the draft", () => {
  test("a Look opens with its id intact, halves copied", () => {
    const look = draft({ id: "look-kept", label: "Deep Sea" });
    const opened = draftFromLook(look);
    expect(opened.id).toBe("look-kept");
    expect(opened.theme.light).toEqual(look.theme.light);
    expect(opened.theme.light).not.toBe(look.theme.light);
    // Editing the opened draft leaves the shelf's Look untouched.
    const edited = patchDraftToken(opened, "light", "background", "#123456");
    expect(edited.theme.light.background).toBe("#123456");
    expect(look.theme.light.background).toBe(TELAR_LIGHT.background);
  });

  test("a theme loads both halves concrete and takes its label; the rest of the look stays", () => {
    const ember = BUILT_IN_THEMES.find((theme) => theme.id === "ember")!;
    const before = draft({ accent: "plum", fontSize: 17 });
    const after = loadThemeIntoDraft(before, ember);
    expect(after.label).toBe("Ember");
    expect(after.theme.light).toEqual(concreteHalf(ember, "light"));
    expect(after.theme.dark).toEqual(concreteHalf(ember, "dark"));
    expect(after.accent).toBe("plum");
    expect(after.fontSize).toBe(17);
    expect(after.id).toBe(before.id);
  });

  test("an orb loads exactly one half", () => {
    const ember = BUILT_IN_THEMES.find((theme) => theme.id === "ember")!;
    const after = loadThemeHalfIntoDraft(draft(), "dark", ember);
    expect(after.theme.dark).toEqual(concreteHalf(ember, "dark"));
    expect(after.theme.light).toEqual(TELAR_LIGHT);
    expect(after.label).toBe("Working draft");
  });
});

describe("persistence", () => {
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

  test("the draft round-trips with its id, and clearing removes the key", () => {
    const kept = draft({ id: "look-persist", label: "Kept" });
    writeStudioDraft(kept);
    expect(readStudioDraft()).toEqual(kept);
    writeStudioDraft(undefined);
    expect(store.has(STUDIO_DRAFT_KEY)).toBe(false);
    expect(readStudioDraft()).toBeUndefined();
  });

  test("garbage in storage degrades to no draft", () => {
    store.set(STUDIO_DRAFT_KEY, "{not json");
    expect(readStudioDraft()).toBeUndefined();
    store.set(STUDIO_DRAFT_KEY, JSON.stringify({ id: "" }));
    expect(readStudioDraft()).toBeUndefined();
  });

  test("the transcript keeps only well-formed lines and clears with an empty list", () => {
    writeStudioChat([
      { kind: "you", text: "warmer" },
      { kind: "studio", text: "Drafted “Cedar”." },
    ]);
    expect(readStudioChat()).toEqual([
      { kind: "you", text: "warmer" },
      { kind: "studio", text: "Drafted “Cedar”." },
    ]);
    store.set(STUDIO_CHAT_KEY, JSON.stringify([{ kind: "you", text: "kept" }, { kind: "shout", text: "dropped" }, "junk", { kind: "trouble" }]));
    expect(readStudioChat()).toEqual([{ kind: "you", text: "kept" }]);
    writeStudioChat([]);
    expect(store.has(STUDIO_CHAT_KEY)).toBe(false);
  });
});

describe("the chat's merge", () => {
  test("the palette and label land; the type members never move", () => {
    const before = patchDraftType(draft({ translucencyLevel: 65 }), { fontSans: "inter", fontSize: 16 });
    const after = mergeDesignIntoDraft(before, design());

    expect(after.label).toBe("Cedar Dusk");
    expect(after.theme.light.background).toBe("#fdfaf6");
    expect(after.theme.dark.background).toBe("#171310");
    expect(after.fontSans).toBe("inter");
    expect(after.fontSize).toBe(16);
    expect(after.translucencyLevel).toBe(65);
    expect(after.id).toBe(before.id);
  });

  test("an accent lands only when the model named one", () => {
    expect(mergeDesignIntoDraft(draft(), design({ accent: "amber" })).accent).toBe("amber");
    expect(mergeDesignIntoDraft(patchDraftAccent(draft(), "plum"), design()).accent).toBe("plum");
  });

  test("a drafted backdrop becomes a custom gradient carrying its own CSS", () => {
    const after = mergeDesignIntoDraft(draft(), design({ backdropSpec: { light: { type: "linear", angle: 160, stops: ["#eeeeee", "#cccccc"] }, dark: { type: "linear", angle: 160, stops: ["#222222", "#000000"] } } }));
    expect(after.backdrop.kind).toBe("custom-gradient");
    if (after.backdrop.kind !== "custom-gradient") throw new Error("unreachable");
    expect(after.backdrop.light).toContain("#eeeeee");
    // The resolved layers are the same strings — a Look is self-contained.
    expect(after.backdrop.resolved.light).toBe(after.backdrop.light);
    expect(after.backdrop.resolved.dark).toBe(after.backdrop.dark);
  });

  test("declining a backdrop KEEPS the draft's — this is an edit, not a restart", () => {
    const withScene = replaceDraftBackdrop(draft(), scenePresetBackdrop(PRESET_ID, 100)!);
    expect(mergeDesignIntoDraft(withScene, design()).backdrop).toEqual(withScene.backdrop);
  });

  test("the summary names the theme and only what actually changed", () => {
    expect(designSummary(design())).toBe("Drafted “Cedar Dusk” — new palette.");
    const full = designSummary(design({ accent: "amber", backdropSpec: { light: { type: "linear", angle: 0, stops: ["#fff", "#eee"] }, dark: { type: "linear", angle: 0, stops: ["#111", "#000"] } } }));
    expect(full).toBe("Drafted “Cedar Dusk” — new palette, a fresh gradient backdrop, amber accent.");
  });
});

describe("the chat's prompt", () => {
  test("the draft is serialised as hex, both halves, with its name and accent", () => {
    const described = describeDraft(patchDraftAccent(draft({ label: "Cedar" }), "moss"));
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
    const described = describeDraft(replaceDraftBackdrop(draft(), { kind: "image", fit: "cover", blur: 0, dim: 0, image: DATA_URL }));
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

