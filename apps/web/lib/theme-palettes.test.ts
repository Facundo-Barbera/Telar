// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_THEMES,
  compilePair,
  cssColorToHex,
  dropTheme,
  parseActivePair,
  TELAR_DARK,
  TELAR_LIGHT,
  THEME_TOKENS,
  type ThemeDefinition,
} from "./theme-palettes";

const theme = (id: string): ThemeDefinition => {
  const found = BUILT_IN_THEMES.find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in ${id}`);
  return found;
};

describe("parseActivePair", () => {
  test("a bare id is a pre-pair install: that theme wore both halves", () => {
    expect(parseActivePair("tide")).toEqual({ light: "tide", dark: "tide" });
  });

  test("a stored pair round-trips", () => {
    expect(parseActivePair(JSON.stringify({ light: "ember", dark: "tide" }))).toEqual({ light: "ember", dark: "tide" });
  });

  // Nothing here may throw: this parse runs on the path that decides the very
  // first paint.
  test.each([
    ["missing", null],
    ["empty", ""],
    ["blank", "   "],
    ["truncated json", '{"light":"ember"'],
    ["an array", "[1,2]"],
  ])("garbage (%s) falls back to telar on both halves", (_label: string, raw: string | null) => {
    expect(parseActivePair(raw)).toEqual({ light: "telar", dark: "telar" });
  });

  test("a half-filled object keeps what it can and defaults the rest", () => {
    expect(parseActivePair('{"light":"grove"}')).toEqual({ light: "grove", dark: "telar" });
    expect(parseActivePair('{"light":"grove","dark":42}')).toEqual({ light: "grove", dark: "telar" });
  });
});

describe("compilePair", () => {
  test("each half comes from its own theme", () => {
    const css = compilePair(theme("ember"), theme("tide"));
    const light = /html:root \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const dark = /html:root\.dark \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(light).toContain(`--background: ${theme("ember").light.background};`);
    expect(dark).toContain(`--background: ${theme("tide").dark.background};`);
    // And emphatically NOT the other way round.
    expect(light).not.toContain(theme("tide").light.background);
    expect(dark).not.toContain(theme("ember").dark.background);
  });

  test("every themable token is emitted for a tinted half", () => {
    const css = compilePair(theme("grove"), theme("telar"));
    for (const [token, value] of Object.entries(theme("grove").light)) {
      expect(css).toContain(`--${token}: ${value};`);
    }
  });

  test("telar is identity: its half contributes no rule at all", () => {
    expect(compilePair(theme("telar"), theme("telar"))).toBe("");
    expect(compilePair(theme("telar"), theme("iris"))).not.toContain("html:root {");
    expect(compilePair(theme("iris"), theme("telar"))).not.toContain("html:root.dark");
  });
});

describe("a tinted half", () => {
  test("tints the hairline too, instead of copying the base palette's white", () => {
    // `oklch(1 0 0 / 10%)` verbatim put pure achromatic white on every edge in
    // the app — the most repeated mark there is, and the last one still
    // insisting a tinted theme was grey.
    for (const id of ["ember", "grove", "tide", "iris"]) {
      const border = theme(id).dark.border;
      expect(border, id).toMatch(/^oklch\(/);
      expect(border, id).toContain("/");
      // Chroma is the second component and it has to be non-zero, or the
      // hue after it means nothing.
      const [, chroma] = /^oklch\(\s*[\d.]+\s+([\d.]+)\s/.exec(border) ?? [];
      expect(Number(chroma), `${id} hairline carries chroma`).toBeGreaterThan(0);
    }
  });

  test("keeps the alpha that lets one border value serve four elevation rungs", () => {
    for (const id of ["ember", "grove", "tide", "iris"]) {
      expect(theme(id).dark.border, id).toMatch(/\/\s*\d+%\s*\)$/);
    }
  });
});

describe("cssColorToHex", () => {
  test("every value the built-in themes actually store round-trips to a real hex", () => {
    // The picker is an <input type="color">, which shows black for anything
    // that is not exactly #rrggbb — so this is a hard contract, not a
    // preference. `#808080` used to be the answer for whole syntaxes.
    const halves = [TELAR_LIGHT, TELAR_DARK, ...BUILT_IN_THEMES.flatMap((entry) => [entry.light, entry.dark])];
    for (const half of halves) {
      for (const token of THEME_TOKENS) {
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

describe("dropTheme", () => {
  test("only the halves wearing the deleted theme go home", () => {
    expect(dropTheme({ light: "custom-1", dark: "tide" }, "custom-1")).toEqual({ light: "telar", dark: "tide" });
    expect(dropTheme({ light: "custom-1", dark: "custom-1" }, "custom-1")).toEqual({ light: "telar", dark: "telar" });
    expect(dropTheme({ light: "ember", dark: "tide" }, "custom-1")).toEqual({ light: "ember", dark: "tide" });
  });
});
