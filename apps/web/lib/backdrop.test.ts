// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { BACKDROP_CSS_KEY, BACKDROP_INIT_SCRIPT, parseBackdropCss } from "./backdrop";

const stored = (value: unknown): string => JSON.stringify(value);

describe("parseBackdropCss", () => {
  test.each([
    ["missing", null],
    ["empty", ""],
    ["truncated json", '{"light":"linear-gradient(red, blue)"'],
    ["an array", "[1,2]"],
    ["a bare string", '"gradient"'],
    ["no image list at all", '{"sizeLight":"cover"}'],
    ["a light list that is not a string", '{"light":42}'],
  ])("garbage (%s) is no scene rather than a throw", (_label: string, raw: string | null) => {
    expect(parseBackdropCss(raw)).toBeNull();
  });

  test("a compiled pair round-trips with both states' lists", () => {
    const value = {
      light: 'url("data:image/webp,a"), linear-gradient(red, blue)',
      dark: "linear-gradient(black, navy)",
      sizeLight: "60% auto, cover",
      positionLight: "50% 50%, center",
      repeatLight: "no-repeat, no-repeat",
      sizeDark: "cover",
      positionDark: "center",
      repeatDark: "no-repeat",
    };
    expect(parseBackdropCss(stored(value))).toEqual(value);
  });

  test("a state with no lists of its own keeps none — the CSS falls through", () => {
    // Inventing dark lists here would stop the `.dark` rule falling back to light's.
    const parsed = parseBackdropCss(stored({ light: "linear-gradient(red, blue)", dark: "none", sizeLight: "cover" }));
    expect(parsed?.sizeLight).toBe("cover");
    expect(parsed?.sizeDark).toBeUndefined();
    expect(Object.hasOwn(parsed!, "sizeDark")).toBe(false);
  });

  test("dark falls back to light when it is missing, never to nothing", () => {
    expect(parseBackdropCss(stored({ light: "linear-gradient(red, blue)" }))?.dark).toBe("linear-gradient(red, blue)");
  });

  test("a list that could close the declaration is dropped", () => {
    // A `;` or `}` in a custom property would end the declaration and inject rules.
    const parsed = parseBackdropCss(stored({ light: "linear-gradient(red, blue)", sizeLight: "cover; } html { display: none" }));
    expect(parsed?.sizeLight).toBeUndefined();
  });
});

describe("BACKDROP_INIT_SCRIPT", () => {
  test("writes every per-state variable applyBackdrop does", () => {
    for (const name of [
      "--backdrop-light",
      "--backdrop-dark",
      "--backdrop-size-light",
      "--backdrop-position-light",
      "--backdrop-repeat-light",
      "--backdrop-size-dark",
      "--backdrop-position-dark",
      "--backdrop-repeat-dark",
    ]) {
      expect(BACKDROP_INIT_SCRIPT, name).toContain(name);
    }
  });

  test("makes no decision about which state is showing", () => {
    // globals.css's `.dark` rule picks, so an OS scheme flip needs no script.
    expect(BACKDROP_INIT_SCRIPT).not.toContain("classList");
    expect(BACKDROP_INIT_SCRIPT).not.toContain("prefers-color-scheme");
  });

  test("reads the key the store writes", () => {
    expect(BACKDROP_INIT_SCRIPT).toContain(BACKDROP_CSS_KEY);
  });

  test("stays dependency-free and swallows its own errors", () => {
    expect(BACKDROP_INIT_SCRIPT).not.toContain("import");
    expect(BACKDROP_INIT_SCRIPT).toContain("catch(e){}");
  });
});
