// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { BUILT_IN_THEMES, concreteHalf, cssColorToHex, matchThemeHalf, TELAR_DARK, TELAR_LIGHT, type ThemeDefinition } from "./theme-palettes";

const ember = BUILT_IN_THEMES.find((t) => t.id === "ember")!;
const tide = BUILT_IN_THEMES.find((t) => t.id === "tide")!;

describe("matchThemeHalf", () => {
  test("a half loaded from a theme still names that theme", () => {
    expect(matchThemeHalf(concreteHalf(ember, "dark"), BUILT_IN_THEMES, "dark")?.id).toBe("ember");
    expect(matchThemeHalf(concreteHalf(tide, "light"), BUILT_IN_THEMES, "light")?.id).toBe("tide");
  });

  test("the halves are compared per mode — a dark half is not its own light one", () => {
    const match = matchThemeHalf(concreteHalf(ember, "dark"), BUILT_IN_THEMES, "light");
    expect(match?.id).not.toBe("ember");
  });

  test("one edited token is enough to stop matching", () => {
    const edited = { ...concreteHalf(ember, "dark"), background: "#123456" };
    expect(matchThemeHalf(edited, BUILT_IN_THEMES, "dark")).toBeUndefined();
  });

  test("the same colour written another way still matches", () => {
    // What a round trip through the colour input does to a stored oklch value.
    const half = { ...concreteHalf(tide, "dark") };
    const hexed = Object.fromEntries(
      Object.entries(half).map(([token, value]) => {
        const v = value as string;
        // Re-express one token as the hex the picker would commit.
        return [token, token === "background" ? cssColorToHex(v) : v];
      }),
    ) as typeof half;
    expect(matchThemeHalf(hexed, BUILT_IN_THEMES, "dark")?.id).toBe("tide");
  });

  test("a custom theme can be the match, and built-ins win a tie", () => {
    const clone: ThemeDefinition = { id: "custom-1", label: "Copy of Telar", light: { ...TELAR_LIGHT }, dark: { ...TELAR_DARK } };
    const themes = [...BUILT_IN_THEMES, clone];
    expect(matchThemeHalf({ ...TELAR_DARK }, themes, "dark")?.id).toBe("telar");
  });

  test("no themes means no match rather than a throw", () => {
    expect(matchThemeHalf(concreteHalf(ember, "dark"), [], "dark")).toBeUndefined();
  });
});
