/**
 * THE COMPILED BACKDROP PARSES TOTALLY, AND THE PRE-PAINT SCRIPT AGREES WITH IT.
 *
 * `parseBackdropCss` runs on the path that decides the very first paint, so
 * nothing here may throw — a hand-edited or stale value has to become "no
 * scene", never an exception in <head>.
 *
 * BACKDROP_INIT_SCRIPT is a second implementation of the same rules, inlined as
 * a string because it must not import anything. Two implementations drift;
 * these tests are what notices. They read the script as TEXT rather than running
 * it, which is enough to catch the failure that actually happened — one side
 * learning about a variable the other never writes.
 */
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
    // Light carries a scene, dark is bare. Inventing dark lists here would make
    // the `.dark` rule stop falling back to light's.
    const parsed = parseBackdropCss(stored({ light: "linear-gradient(red, blue)", dark: "none", sizeLight: "cover" }));
    expect(parsed?.sizeLight).toBe("cover");
    expect(parsed?.sizeDark).toBeUndefined();
    expect(Object.hasOwn(parsed!, "sizeDark")).toBe(false);
  });

  test("dark falls back to light when it is missing, never to nothing", () => {
    expect(parseBackdropCss(stored({ light: "linear-gradient(red, blue)" }))?.dark).toBe("linear-gradient(red, blue)");
  });

  test("a list that could close the declaration is dropped", () => {
    // These go straight into a CSS custom property; a `;` or a `}` in one would
    // end the declaration and let whatever follows become new rules.
    const parsed = parseBackdropCss(stored({ light: "linear-gradient(red, blue)", sizeLight: "cover; } html { display: none" }));
    expect(parsed?.sizeLight).toBeUndefined();
  });
});

describe("BACKDROP_INIT_SCRIPT", () => {
  test("writes every per-state variable applyBackdrop does", () => {
    // The script paints frame one. A variable it does not know about is a flash
    // of a wrongly-sized scene on every single launch.
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
    // CSS picks (globals.css's `.dark` rule), which is what keeps first paint
    // right with no flash and keeps it right when the OS flips scheme under a
    // window set to `system`. A script that branched on the class would be a
    // second answer to the same question.
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
