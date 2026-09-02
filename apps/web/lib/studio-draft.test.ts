// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  accentPrimary,
  buildStudioPrompt,
  describeDraft,
  designSummary,
  draftBackdropCss,
  draftCssVars,
  draftIsDirty,
  draftScenePreset,
  mergeDesignIntoDraft,
  patchDraftAccent,
  patchDraftHalf,
  patchDraftStrength,
  patchDraftToken,
  patchDraftType,
  replaceDraftBackdrop,
  scenePresetBackdrop,
  setDraftLabel,
  type StudioDraft,
} from "./studio-draft";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "./appearance";
import { BACKDROP_PRESETS } from "./backdrop-presets";
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

describe("the stage's variables", () => {
  test("every theme token becomes a custom property of the same name", () => {
    const vars = draftCssVars(draft(), "light");
    for (const token of THEME_TOKENS) expect(vars[`--${token}`]).toBe(TELAR_LIGHT[token]);
  });

  test("the accent supplies --primary, and it differs by scheme", () => {
    const light = draftCssVars(patchDraftAccent(draft(), "amber"), "light");
    const dark = draftCssVars(patchDraftAccent(draft(), "amber"), "dark");
    expect(light["--primary"]).toBe(accentPrimary("amber", "light").primary);
    expect(dark["--primary"]).toBe(accentPrimary("amber", "dark").primary);
    expect(light["--primary"]).not.toBe(dark["--primary"]);
    expect(light["--primary-foreground"]).toBe("oklch(1 0 0)");
  });

  test("the accent mirror matches globals.css's own numbers", () => {
    // The values these blocks hold — a drift here is a stage that paints a
    // different button colour from the one applying the draft would give.
    expect(accentPrimary("indigo", "light").primary).toBe("oklch(0.488 0.16 264)");
    expect(accentPrimary("sea", "dark")).toEqual({ primary: "oklch(0.68 0.11 205)", primaryForeground: "oklch(0.17 0.04 205)" });
    expect(accentPrimary("violet", "light").primary).toBe("oklch(0.488 0.17 293)");
  });

  test("the rail and ring fall back to the draft rather than the live theme", () => {
    const vars = draftCssVars(draft(), "dark");
    expect(vars["--sidebar-foreground"]).toBe(TELAR_DARK.foreground);
    expect(vars["--sidebar-border"]).toBe(TELAR_DARK.border);
    expect(vars["--ring"]).toBe(vars["--primary"]);
  });
});

describe("the stage's backdrop", () => {
  test("no backdrop paints nothing", () => {
    expect(draftBackdropCss(draft(), "light")).toEqual({
      backgroundImage: "none",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    });
  });

  test("a resolved backdrop is read per scheme, with its own lists", () => {
    const withScene = replaceDraftBackdrop(draft(), {
      kind: "gradient",
      id: "dusk",
      resolved: { light: "linear-gradient(#fff, #eee)", dark: "linear-gradient(#111, #000)", size: "cover", position: "top", repeat: "repeat" },
    });
    expect(draftBackdropCss(withScene, "light").backgroundImage).toBe("linear-gradient(#fff, #eee)");
    expect(draftBackdropCss(withScene, "dark").backgroundImage).toBe("linear-gradient(#111, #000)");
    expect(draftBackdropCss(withScene, "dark").backgroundPosition).toBe("top");
    expect(draftBackdropCss(withScene, "dark").backgroundRepeat).toBe("repeat");
  });

  test("an image becomes a url(), and dim becomes a wash over it", () => {
    const plain = replaceDraftBackdrop(draft(), { kind: "image", fit: "cover", blur: 0, dim: 0, image: DATA_URL });
    expect(draftBackdropCss(plain, "light").backgroundImage).toBe(`url("${DATA_URL}")`);
    expect(draftBackdropCss(plain, "light").backgroundSize).toBe("cover");

    const dimmed = replaceDraftBackdrop(draft(), { kind: "image", fit: "tile", blur: 0, dim: 40, image: DATA_URL });
    const css = draftBackdropCss(dimmed, "dark");
    expect(css.backgroundImage.startsWith("linear-gradient(oklch(0 0 0 / 40%)")).toBe(true);
    expect(css.backgroundImage.endsWith(`url("${DATA_URL}")`)).toBe(true);
    // Two layers, so every positional list carries two entries.
    expect(css.backgroundSize.split(", ")).toHaveLength(2);
    expect(css.backgroundRepeat).toBe("no-repeat, repeat");
  });

  test("an image that is not image data paints nothing rather than a broken url", () => {
    const bogus = replaceDraftBackdrop(draft(), { kind: "image", fit: "cover", blur: 0, dim: 0, image: "javascript:alert(1)" });
    expect(draftBackdropCss(bogus, "light").backgroundImage).toBe("none");
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

describe("dirtiness", () => {
  test("an untouched draft is clean and any edit is not", () => {
    const before = draft();
    expect(draftIsDirty(before, before)).toBe(false);
    expect(draftIsDirty({ ...before }, before)).toBe(false);
    expect(draftIsDirty(patchDraftToken(before, "light", "border", "#123456"), before)).toBe(true);
    expect(draftIsDirty(setDraftLabel(before, "Other"), before)).toBe(true);
  });
});
