// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { applyDesign, buildDesignPrompt, DESIGN_SCHEMA } from "./theme-designer";
import { THEME_TOKENS, type ThemeHalf } from "./theme-palettes";
import { contrastRatio } from "./vscode-theme-import";
import { composeGradient } from "./backdrop-presets";
import { isGradientValue } from "./backdrop";

/** Every object in the schema, recursively — the strictness rules below are
 *  claims about ALL of them, not just the root. */
function objects(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (typeof node !== "object" || node === null) return found;
  const record = node as Record<string, unknown>;
  if (record.type === "object") found.push(record);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const entry of value) objects(entry, found);
    else objects(value, found);
  }
  return found;
}

const HALF: ThemeHalf = Object.fromEntries(THEME_TOKENS.map((token) => [token, "#123456"])) as ThemeHalf;

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: "Autumn Library",
    light: { ...HALF, background: "#faf7f2", foreground: "#3a2a1c", card: "#fffdf9", "card-foreground": "#3a2a1c" },
    dark: { ...HALF, background: "#171310", foreground: "#f3ece3" },
    backdrop: { action: "set", angle: 165, lightStops: ["#f7efe2", "#e8d6bd"], darkStops: ["#1c1510", "#2a1d12"] },
    accent: "amber",
    type: { fontSans: "keep", fontMono: "keep", fontSize: 0 },
    ...overrides,
  };
}

describe("DESIGN_SCHEMA", () => {
  // THE PORTABILITY RULE. The codex harness routes this into OpenAI structured
  // outputs, which refuses an object that allows extra properties or leaves a
  // declared property optional. A schema that loses either is not rejected
  // loudly at build time — it fails at the far end of a sixty-second call.
  test("every object is strict and lists every property as required", () => {
    const all = objects(DESIGN_SCHEMA);
    expect(all.length).toBeGreaterThan(3);
    for (const node of all) {
      expect(node.additionalProperties).toBe(false);
      const properties = Object.keys(node.properties as Record<string, unknown>);
      expect([...(node.required as string[])].sort()).toEqual([...properties].sort());
    }
  });

  test("both halves ask for all sixteen tokens", () => {
    for (const half of ["light", "dark"] as const) {
      const node = (DESIGN_SCHEMA.properties as Record<string, Record<string, unknown>>)[half]!;
      expect(node.required).toEqual([...THEME_TOKENS]);
    }
  });

  // Declining must be sayable INSIDE a strict schema, which is why every
  // decline is a required VALUE ("keep", "none", 0), never an omitted member.
  test("the backdrop action is a required keep/set/remove enum", () => {
    const backdrop = (DESIGN_SCHEMA.properties as Record<string, Record<string, unknown>>).backdrop!;
    expect((backdrop.required as string[]).includes("action")).toBe(true);
    expect((backdrop.properties as Record<string, Record<string, unknown>>).action!.enum).toEqual(["keep", "set", "remove"]);
  });

  test("the type block offers real families plus keep, and never custom", () => {
    const type = (DESIGN_SCHEMA.properties as Record<string, Record<string, unknown>>).type!;
    const sans = (type.properties as Record<string, Record<string, unknown>>).fontSans!.enum as string[];
    expect(sans).toContain("keep");
    expect(sans).toContain("geist");
    expect(sans).not.toContain("custom");
  });
});

describe("buildDesignPrompt", () => {
  test("carries the description and names every token", () => {
    const prompt = buildDesignPrompt("  warm autumn library  ");
    expect(prompt).toContain("warm autumn library");
    for (const token of THEME_TOKENS) expect(prompt).toContain(token);
  });

  test("states the schema-only rule and the contrast bar", () => {
    const prompt = buildDesignPrompt("neon over deep navy");
    expect(prompt).toContain("4.5:1");
    expect(prompt.toLowerCase()).toContain("only");
  });
});

describe("applyDesign", () => {
  test("garbage is an error string, never a throw", () => {
    for (const junk of [null, undefined, 42, "a theme", [], {}, { light: HALF }]) {
      const outcome = applyDesign(junk);
      expect(outcome.definition).toBeUndefined();
      expect(typeof outcome.error).toBe("string");
    }
  });

  test("a missing or unparseable token fails the whole half", () => {
    expect(applyDesign(answer({ light: { ...HALF, border: "not a colour" } })).error).toBeTruthy();
    const short = { ...HALF } as Record<string, unknown>;
    delete short.sidebar;
    expect(applyDesign(answer({ dark: short })).error).toBeTruthy();
  });

  test("a well-formed answer becomes a wearable definition", () => {
    const outcome = applyDesign(answer());
    expect(outcome.error).toBeUndefined();
    expect(outcome.definition!.label).toBe("Autumn Library");
    for (const token of THEME_TOKENS) {
      expect(outcome.definition!.light[token]).toMatch(/^#[0-9a-f]{6}$/);
      expect(outcome.definition!.dark[token]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("short and long hex forms both normalise to #RRGGBB", () => {
    const outcome = applyDesign(answer({ light: { ...HALF, background: "#FFF", card: "#fffdf9ff" } }));
    expect(outcome.definition!.light.background).toBe("#ffffff");
    expect(outcome.definition!.light.card).toBe("#fffdf9");
  });

  test("labels are trimmed, collapsed, capped, and defaulted", () => {
    expect(applyDesign(answer({ label: "  Autumn   Library " })).definition!.label).toBe("Autumn Library");
    expect(applyDesign(answer({ label: "   " })).definition!.label).toBe("Designed theme");
    expect(applyDesign(answer({ label: 7 })).definition!.label).toBe("Designed theme");
    expect(applyDesign(answer({ label: "x".repeat(200) })).definition!.label.length).toBe(48);
  });

  // The repair is the whole reason this is not just JSON.parse: a schema
  // constrains shape, not legibility, and an unreadable theme is the one
  // failure the reader cannot fix from inside the pane.
  test("every foreground clears 4.5:1 on its own surface, even when the model's did not", () => {
    const unreadable = { ...HALF, background: "#ffffff", foreground: "#f2f2f2", card: "#ffffff", "card-foreground": "#fafafa", accent: "#eeeeee", "accent-foreground": "#e9e9e9" };
    const outcome = applyDesign(answer({ light: unreadable }));
    const half = outcome.definition!.light;
    const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
    for (const [fg, surface] of [
      ["foreground", "background"],
      ["card-foreground", "card"],
      ["accent-foreground", "accent"],
      ["muted-foreground", "background"],
    ] as const) {
      expect(contrastRatio(rgb(half[fg]), rgb(half[surface]))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("a readable foreground is left exactly as the model drew it", () => {
    const half = applyDesign(answer()).definition!.dark;
    expect(half.foreground).toBe("#f3ece3");
    expect(half.background).toBe("#171310");
  });

  test("the backdrop composes into a value the store will accept", () => {
    const outcome = applyDesign(answer());
    expect(outcome.backdropSpec!.light.angle).toBe(165);
    expect(outcome.backdropSpec!.dark.stops).toEqual(["#1c1510", "#2a1d12"]);
    expect(isGradientValue(composeGradient(outcome.backdropSpec!.light))).toBe(true);
    expect(isGradientValue(composeGradient(outcome.backdropSpec!.dark))).toBe(true);
  });

  test("keep and unusable stops both mean no backdrop change, not a failed design", () => {
    const kept = answer({ backdrop: { action: "keep", angle: 0, lightStops: [], darkStops: [] } });
    expect(applyDesign(kept).backdropSpec).toBeUndefined();
    expect(applyDesign(kept).removeBackdrop).toBeUndefined();
    expect(applyDesign(kept).definition).toBeTruthy();

    const broken = answer({ backdrop: { action: "set", angle: 10, lightStops: ["#fff"], darkStops: ["#000000", "#111111"] } });
    expect(applyDesign(broken).backdropSpec).toBeUndefined();
    expect(applyDesign(broken).definition).toBeTruthy();

    expect(applyDesign(answer({ backdrop: "sunset" })).definition).toBeTruthy();
  });

  test("remove asks for a plain canvas; the previous schema's present:true still sets", () => {
    const removed = applyDesign(answer({ backdrop: { action: "remove", angle: 0, lightStops: [], darkStops: [] } }));
    expect(removed.removeBackdrop).toBe(true);
    expect(removed.backdropSpec).toBeUndefined();

    const legacy = applyDesign(answer({ backdrop: { present: true, angle: 165, lightStops: ["#f7efe2", "#e8d6bd"], darkStops: ["#1c1510", "#2a1d12"] } }));
    expect(legacy.backdropSpec).toBeTruthy();
  });

  test("type lands only when it names a real choice in range", () => {
    expect(applyDesign(answer()).fontSans).toBeUndefined();
    expect(applyDesign(answer()).fontSize).toBeUndefined();

    const typed = applyDesign(answer({ type: { fontSans: "inter", fontMono: "jetbrains", fontSize: 15 } }));
    expect(typed.fontSans).toBe("inter");
    expect(typed.fontMono).toBe("jetbrains");
    expect(typed.fontSize).toBe(15);

    const junk = applyDesign(answer({ type: { fontSans: "papyrus", fontMono: "custom", fontSize: 40 } }));
    expect(junk.fontSans).toBeUndefined();
    expect(junk.fontMono).toBeUndefined();
    expect(junk.fontSize).toBeUndefined();
  });

  test("angles wrap and junk angles fall back", () => {
    expect(applyDesign(answer({ backdrop: { ...(answer().backdrop as object), angle: 400 } })).backdropSpec!.light.angle).toBe(40);
    expect(applyDesign(answer({ backdrop: { ...(answer().backdrop as object), angle: -20 } })).backdropSpec!.light.angle).toBe(340);
    expect(applyDesign(answer({ backdrop: { ...(answer().backdrop as object), angle: "steep" } })).backdropSpec!.light.angle).toBe(160);
  });

  test("more than four stops keeps the first four rather than losing the scene", () => {
    const many = answer({ backdrop: { present: true, angle: 90, lightStops: ["#111111", "#222222", "#333333", "#444444", "#555555"], darkStops: ["#000000", "#111111"] } });
    expect(applyDesign(many).backdropSpec!.light.stops).toEqual(["#111111", "#222222", "#333333", "#444444"]);
  });

  test("an accent is taken only when it names one of ours", () => {
    expect(applyDesign(answer()).accent).toBe("amber");
    expect(applyDesign(answer({ accent: "none" })).accent).toBeUndefined();
    expect(applyDesign(answer({ accent: "burnt sienna" })).accent).toBeUndefined();
    expect(applyDesign(answer({ accent: 3 })).accent).toBeUndefined();
  });
});
