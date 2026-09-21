/**
 * THE LADDER IS ONLY A LADDER IF EVERYTHING IS ON IT.
 *
 * Light mode read flat because five vocabularies were describing one idea:
 * Tailwind's stock `shadow-sm` at 38 call sites, stock `shadow-md` on every
 * popover, and four hand-written arbitrary values. None of the stock ones can
 * see --shadow-tint, so none of them could follow a theme, and none of them
 * moved when the Depth setting did.
 *
 * A browser settles whether the RUNGS look right. What no browser catches is
 * the next `shadow-sm` typed into a component six months from now — it will
 * render something, it will render it in Tailwind's own grey, and it will be
 * invisibly wrong. That is what this file is for, and it reads source text for
 * the same reason surface-cards.test.ts does: Tailwind only sees class names it
 * read as literals, so a shared constant is not available to hold them
 * together.
 *
 * `shadow-none` is NOT a stock rung — it is the ladder's off switch, it
 * composes with the rungs through the same `--tw-shadow` variable, and call
 * sites that reset a shadow keep it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `.pathname`: this repo is checked out under a path with a
// space in it, and a URL's pathname keeps that percent-encoded.
const UI_DIR = fileURLToPath(new URL("../components/ui", import.meta.url));
const GLOBALS = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Everything Tailwind ships as a box-shadow size. `shadow-none` is absent on
 *  purpose — see the header. */
const STOCK = /\bshadow-(2?xs|sm|md|lg|xl|2xl)\b/;

describe("no stock shadow survives in components/ui", () => {
  const files = sources(UI_DIR);

  test("there are files to check at all", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const path of files) {
    const name = path.slice(UI_DIR.length + 1);
    test(name, () => {
      const offenders = readFileSync(path, "utf8")
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => STOCK.test(line))
        .map(({ line, index }) => `  ${name}:${index + 1}  ${line.trim().slice(0, 120)}`);
      // The message is the fix: the rung to reach for, not just "this failed".
      expect(offenders.join("\n") || "clean").toBe("clean");
    });
  }
});

describe("the ladder the call sites are reaching for", () => {
  test("three rungs, declared once, in the @theme block", () => {
    for (const rung of ["--shadow-1:", "--shadow-2:", "--shadow-3:"]) {
      expect(GLOBALS.split(rung).length - 1).toBe(1);
    }
  });

  test("every rung is two layers, and both are mixed from --shadow-tint", () => {
    for (const rung of ["--shadow-1", "--shadow-2", "--shadow-3"]) {
      const value = new RegExp(`${rung}:([^;]*);`).exec(GLOBALS)?.[1] ?? "";
      expect(value).toContain("var(--shadow-ring)");
      expect(value).toContain("var(--shadow-ambient)");
    }
    // The two layer colours are the ONLY place a shadow colour is authored,
    // and both come from the one ink.
    for (const derived of ["--shadow-ring:", "--shadow-ambient:"]) {
      expect(new RegExp(`${derived}[^;]*var\\(--shadow-tint\\)`).test(GLOBALS)).toBe(true);
    }
  });

  test("both halves tune the same three dials", () => {
    for (const dial of ["--shadow-lift:", "--shadow-ink:", "--shadow-ring-ink:"]) {
      // Once in :root, once in .dark — a half that forgets one inherits the
      // other half's balance, which is the bug this asserts against.
      expect(GLOBALS.split(dial).length - 1).toBe(2);
    }
  });

  test("Depth moves multipliers, and soft writes no block", () => {
    expect(GLOBALS).toContain('[data-depth="flat"]');
    expect(GLOBALS).toContain('[data-depth="deep"]');
    expect(GLOBALS).not.toContain('[data-depth="soft"]');
    // Flat has to zero the ink as well as the travel: a zero-sized ambient
    // layer still paints through a surface paler than full alpha.
    const flat = /\[data-depth="flat"\]\s*\{([^}]*)\}/.exec(GLOBALS)?.[1] ?? "";
    expect(flat).toContain("--depth-lift: 0");
    expect(flat).toContain("--depth-ink: 0");
  });

  /**
   * DEEP HAS TO BE FAR ENOUGH TO SEE — issue #471.
   *
   * It shipped at 1.5 / 1.6, which on the `shadow-1` card most of the app is
   * built from moved the ambient layer by one pixel and its blur by three. The
   * setting read as doing nothing, and "nothing" is indistinguishable from a
   * bug. No test can judge a shadow, but it can hold the multipliers above the
   * value that was demonstrably too small — a future tidy-up that halves them
   * is the regression this guards.
   */
  test("deep travels far enough from soft to be a different stop", () => {
    const deep = /\[data-depth="deep"\]\s*\{([^}]*)\}/.exec(GLOBALS)?.[1] ?? "";
    const dial = (name: string) => Number(new RegExp(`--depth-${name}:\\s*([\\d.]+)`).exec(deep)?.[1] ?? "0");
    expect(dial("lift")).toBeGreaterThanOrEqual(2);
    expect(dial("ink")).toBeGreaterThanOrEqual(2);
  });

  /**
   * DEPTH MOVES THE SURFACE, NOT ITS EDGE — and #904 is why that is pinned.
   *
   * The dark half spends almost all of its ink on the contact ring (38%, against
   * light's 11%), so if Depth multiplied the ring the way it multiplies the
   * ambient layer, "deep" would thicken every card edge in the app — and on a
   * mid-lightness dark canvas a settings card full of hairlines would read as a
   * wireframe. It does not: --shadow-ring is mixed from --shadow-ring-ink alone,
   * and the ring layer's own geometry (0 1px 1px -1px) is the one part of each
   * rung not scaled by --shadow-float. This test is that measurement, kept.
   */
  test("neither Depth multiplier reaches the contact ring", () => {
    // Anchored to the start of a line, because the block comment above these
    // declarations quotes `--shadow-ring:` while explaining the transparent-first
    // mix — and an unanchored match reads the prose instead of the value.
    const declaration = (name: string) => new RegExp(`^\\s*--${name}:([^;]*);`, "m").exec(GLOBALS)?.[1] ?? "";
    const ring = declaration("shadow-ring");
    expect(ring).toContain("var(--shadow-ring-ink)");
    expect(ring).not.toContain("--depth-ink");
    expect(ring).not.toContain("--depth-lift");
    // The ambient layer is where the multipliers live, and the contrast is the
    // point: one of these two carries Depth and the other must not.
    expect(declaration("shadow-ambient")).toContain("var(--depth-ink)");
    // The rung geometry says the same thing: the ring's offsets are literals,
    // and only the ambient layer's are scaled by --shadow-float.
    for (const rung of ["--shadow-1", "--shadow-2", "--shadow-3"]) {
      const value = new RegExp(`${rung}:([^;]*);`).exec(GLOBALS)?.[1] ?? "";
      const ringLayer = value.split("var(--shadow-ring)")[0] ?? "";
      expect(ringLayer).not.toContain("--shadow-float");
    }
  });

  /**
   * AND IT MUST NOT OVERFLOW EITHER HALF'S INK. --shadow-ambient mixes
   * `transparent calc(100% - var(--shadow-ink) * var(--depth-ink))`, so a
   * multiplier that pushes a half's ink past 100% makes that complement
   * negative — an invalid percentage, and the layer silently stops painting in
   * the one mode it was raised for.
   */
  test("the deep multiplier keeps both halves' ink inside 100%", () => {
    const deepInk = Number(/\[data-depth="deep"\]\s*\{[^}]*--depth-ink:\s*([\d.]+)/.exec(GLOBALS)?.[1] ?? "0");
    const inks = [...GLOBALS.matchAll(/--shadow-ink:\s*([\d.]+)%/g)].map((match) => Number(match[1]));
    // One in :root and one in .dark — the same pair the dials test counts.
    expect(inks.length).toBe(2);
    for (const ink of inks) expect(ink * deepInk).toBeLessThan(100);
  });
});
