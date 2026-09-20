// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { cssColorToHex, FOREGROUND_SURFACES, TELAR_DARK, TELAR_LIGHT, THEME_TOKENS } from "./theme-palettes";
import { BUILT_IN_LOOKS } from "./built-in-looks";
import { halfFor } from "./palette-from-image";

describe("cssColorToHex", () => {
  test("every value a built-in look actually paints round-trips to a real hex", () => {
    // The picker is an <input type="color">, which shows black for anything
    // that is not exactly #rrggbb — so this is a hard contract, not a
    // preference. `#808080` used to be the answer for whole syntaxes.
    const halves: Record<string, string>[] = [
      TELAR_LIGHT,
      TELAR_DARK,
      ...BUILT_IN_LOOKS.flatMap((look) => [halfFor(look.composition.light, "light"), halfFor(look.composition.dark, "dark")]),
      // The BASES too: they are what the composer's own colour input shows, and
      // an input that cannot render its value shows black.
      ...BUILT_IN_LOOKS.map((look) => ({ base: look.composition.light.base, dark: look.composition.dark.base })),
    ];
    for (const half of halves) {
      for (const token of Object.keys(half)) {
        const value = half[token];
        if (!value) continue;
        expect(cssColorToHex(value), `${token} = ${value}`).toMatch(/^#[\da-f]{6}$/);
        expect(cssColorToHex(value), `${token} = ${value} fell through to grey`).not.toBe("#808080");
      }
    }
  });

  test("a translucent oklch reports its colour rather than a grey stand-in", () => {
    // The alpha cannot be shown by the widget; the COLOUR can, and reporting
    // mid-grey for a white hairline is what corrupted it on the way back out.
    expect(cssColorToHex("oklch(1 0 0 / 10%)")).toBe("#ffffff");
    expect(cssColorToHex("oklch(0.92 0.042 55 / 11%)")).not.toBe("#808080");
  });

  test("reads the CSS syntaxes an imported theme arrives in", () => {
    expect(cssColorToHex("oklch(100% 0 0)")).toBe("#ffffff");
    expect(cssColorToHex("oklch(0 0 none)")).toBe("#000000");
    expect(cssColorToHex("#ABC")).toBe("#aabbcc");
    expect(cssColorToHex("#12345678")).toBe("#123456");
    expect(cssColorToHex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(cssColorToHex("rgba(0 128 255 / 0.5)")).toBe("#0080ff");
    expect(cssColorToHex("rgb(100%, 0%, 0%)")).toBe("#ff0000");
    expect(cssColorToHex("  #FFFFFF  ")).toBe("#ffffff");
  });

  test("the hue's angle unit is read, not assumed to be degrees", () => {
    // 0.25turn, 90deg and 100grad are the same hue; they used to be 0.25, 90
    // and 100 degrees.
    const degrees = cssColorToHex("oklch(0.6 0.15 90)");
    expect(cssColorToHex("oklch(0.6 0.15 0.25turn)")).toBe(degrees);
    expect(cssColorToHex("oklch(0.6 0.15 100grad)")).toBe(degrees);
  });

  test("is total: nonsense still yields a usable hex", () => {
    expect(cssColorToHex("not a colour")).toMatch(/^#[\da-f]{6}$/);
    expect(cssColorToHex("")).toMatch(/^#[\da-f]{6}$/);
  });
});

describe("FOREGROUND_SURFACES", () => {
  test("names real tokens on both sides", () => {
    for (const [text, surface] of FOREGROUND_SURFACES) {
      expect(THEME_TOKENS, `${text} is a token`).toContain(text);
      expect(THEME_TOKENS, `${surface} is a token`).toContain(surface);
    }
  });

  test("muted text is judged on the CANVAS, not on --muted", () => {
    // The pairing the token names suggest is wrong for this one, and getting it
    // wrong silently passes a hint that is unreadable where it actually sits.
    expect(FOREGROUND_SURFACES.find(([text]) => text === "muted-foreground")?.[1]).toBe("background");
  });
});
