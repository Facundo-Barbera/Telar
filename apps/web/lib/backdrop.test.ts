/**
 * THE CHOICE PARSES TOTALLY, AND THE PRE-PAINT SCRIPT AGREES WITH IT.
 *
 * `parseBackdrop` runs on the path that decides the very first paint, so
 * nothing here may throw — a hand-edited or stale value has to become "no
 * scene", never an exception in <head>.
 *
 * BACKDROP_INIT_SCRIPT is a second implementation of the same rules, inlined
 * as a string because it must not import anything. Two implementations drift;
 * these tests are what notices. They read the script as TEXT rather than
 * running it, which is enough to catch the failure that actually happened —
 * one side learning about a variable the other never writes.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { BACKDROP_INIT_SCRIPT, MAX_BACKDROP_DIM, parseBackdrop, type Backdrop } from "./backdrop";

const stored = (value: unknown): string => JSON.stringify(value);

describe("parseBackdrop", () => {
  test.each([
    ["missing", null],
    ["empty", ""],
    ["truncated json", '{"kind":"gradient"'],
    ["an array", "[1,2]"],
    ["a bare string", '"gradient"'],
    ["an unknown kind", '{"kind":"hologram"}'],
  ])("garbage (%s) is no scene rather than a throw", (_label: string, raw: string | null) => {
    expect(parseBackdrop(raw)).toEqual({ kind: "none" });
  });

  test("a gradient preset round-trips", () => {
    expect(parseBackdrop(stored({ kind: "gradient", id: "dusk" }))).toEqual({ kind: "gradient", id: "dusk" });
  });
});

describe("dim, on every kind that can swallow the text over it", () => {
  /**
   * It used to be image-only — not by design, but because the image picker is
   * where the slider was built. The scrim reading `--backdrop-dim`
   * (`#app-backdrop::after` in globals.css) has never asked what kind of scene
   * it is over, and a saturated gradient is exactly as capable of drowning a
   * label as a photograph.
   */
  const kinds: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["gradient", { kind: "gradient", id: "dusk" }],
    ["custom-gradient", { kind: "custom-gradient", light: "linear-gradient(red, blue)", dark: "linear-gradient(red, blue)" }],
    ["scene", { kind: "scene", stamp: 7 }],
  ];

  test.each(kinds)("%s carries a dim through the store", (_label: string, choice: Record<string, unknown>) => {
    const parsed = parseBackdrop(stored({ ...choice, dim: 40 })) as Backdrop & { dim?: number };
    expect(parsed.kind).toBe(choice.kind);
    expect(parsed.dim).toBe(40);
  });

  test.each(kinds)("%s clamps a dim past the ceiling", (_label: string, choice: Record<string, unknown>) => {
    const parsed = parseBackdrop(stored({ ...choice, dim: 500 })) as Backdrop & { dim?: number };
    expect(parsed.dim).toBe(MAX_BACKDROP_DIM);
  });

  test.each(kinds)("%s without a dim stays without one, rather than storing a zero", (_label: string, choice: Record<string, unknown>) => {
    const parsed = parseBackdrop(stored(choice)) as Backdrop & { dim?: number };
    expect(parsed.dim).toBeUndefined();
    expect(Object.hasOwn(parsed, "dim")).toBe(false);
  });

  test.each(kinds)("%s rejects a dim that is not a number", (_label: string, choice: Record<string, unknown>) => {
    const parsed = parseBackdrop(stored({ ...choice, dim: "lots" })) as Backdrop & { dim?: number };
    expect(parsed.dim).toBeUndefined();
  });

  test("an image still parses its own dim, which was always required", () => {
    expect(parseBackdrop(stored({ kind: "image", fit: "cover", blur: 0, dim: 25 }))).toEqual({
      kind: "image",
      fit: "cover",
      blur: 0,
      dim: 25,
    });
  });
});

describe("BACKDROP_INIT_SCRIPT", () => {
  test("writes --backdrop-dim on the gradient and scene path too, not only the image one", () => {
    // The script paints frame one; a dim it does not know about is a flash of
    // undimmed wallpaper on every single launch.
    const writes = [...BACKDROP_INIT_SCRIPT.matchAll(/--backdrop-dim/g)];
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });

  test("clamps to the same ceiling the parser does", () => {
    expect(BACKDROP_INIT_SCRIPT).toContain(`Math.min(${MAX_BACKDROP_DIM},Math.round(b.dim))+'%'`);
  });

  test("stays dependency-free and swallows its own errors", () => {
    expect(BACKDROP_INIT_SCRIPT).not.toContain("import");
    expect(BACKDROP_INIT_SCRIPT).toContain("catch(e){}");
  });
});
