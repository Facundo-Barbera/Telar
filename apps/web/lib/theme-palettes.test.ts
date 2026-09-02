// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_THEMES,
  compilePair,
  dropTheme,
  parseActivePair,
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

describe("dropTheme", () => {
  test("only the halves wearing the deleted theme go home", () => {
    expect(dropTheme({ light: "custom-1", dark: "tide" }, "custom-1")).toEqual({ light: "telar", dark: "tide" });
    expect(dropTheme({ light: "custom-1", dark: "custom-1" }, "custom-1")).toEqual({ light: "telar", dark: "telar" });
    expect(dropTheme({ light: "ember", dark: "tide" }, "custom-1")).toEqual({ light: "ember", dark: "tide" });
  });
});
