/**
 * THE TINTS ARE VISIBLE — measured, on every scheme and every Look we ship.
 *
 * globals.test.ts pins the DECLARATION. This file pins the RESULT, and the two
 * are deliberately different kinds of guard: the first reads source and can say
 * nothing about colour, the second evaluates colour and would survive a total
 * rewrite of how the declaration is spelled. #691 shipped the first and said so.
 *
 * EVERYTHING IS READ, NOTHING IS COPIED. The floor and the state vocabulary come
 * out of globals.css — the file they paint from — and the cards come out of the
 * built-in Looks. A second copy of any of those numbers here would be a test
 * that keeps passing while the app changes underneath it, which is the failure
 * mode #691's guards were careful to avoid.
 *
 * WHY THE FLOOR IS A WINDOW AND NOT A MINIMUM. The fill is made of the same
 * token as the ink standing on it, so raising --tint-floor pushes the fill away
 * from the card (good) and toward its own text (bad). The last test measures
 * both walls, and it exists so that "the tints look faint, raise the floor"
 * fails loudly with the other wall's number attached.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_IN_LOOKS } from "./built-in-looks";
import { compositionHalf } from "./composition";
import { deltaEOk, measureTint, TINT_ELEVATION, TINT_READABLE, tintOf, TONE_JND, toneSeparation } from "./tint-separation";

const here = fileURLToPath(new URL(".", import.meta.url));
const css = fs.readFileSync(path.join(here, "..", "app", "globals.css"), "utf8");

/**
 * EVERY top-level block for `selector`, braces balanced — not the first.
 *
 * `:root` is opened more than once: the palette near the top of the stylesheet,
 * and the tints down beside the prose that argues for them. Reading only the
 * first block is how globals.test.ts once came to call a real token undefined,
 * and --tint-floor lives in the second — so this walks all of them.
 */
function blocks(selector: string): string {
  const found: string[] = [];
  for (let start = css.indexOf(`${selector} {`); start !== -1; start = css.indexOf(`${selector} {`, start + 1)) {
    let depth = 0;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(css.slice(start, index));
          break;
        }
      }
    }
  }
  return found.join("\n");
}

function token(selector: string, name: string): string {
  const match = new RegExp(`^\\s*--${name}\\s*:\\s*([^;]+);`, "m").exec(blocks(selector));
  if (!match) throw new Error(`globals.css: --${name} is not declared in ${selector}`);
  return match[1].trim();
}

/** `--tint-floor: 12%` as the fraction `color-mix` means by it. */
const floor = (() => {
  const raw = token(":root", "tint-floor");
  const percent = /^([\d.]+)%$/.exec(raw);
  if (!percent) throw new Error(`globals.css: --tint-floor is "${raw}", which is not a percentage`);
  return Number(percent[1]) / 100;
})();

/** The state vocabulary, per scheme, straight out of the stylesheet. A Look
 *  cannot move these — they are not in THEME_TOKENS — which is exactly why the
 *  hazard is on the OTHER end of the mix. */
const INK = {
  light: { success: token(":root", "success"), destructive: token(":root", "destructive"), warning: token(":root", "warning") },
  dark: { success: token(".dark", "success"), destructive: token(".dark", "destructive"), warning: token(".dark", "warning") },
} as const;

type Mode = "light" | "dark";
const MODES: readonly Mode[] = ["light", "dark"];

/**
 * EVERY --card THIS BUILD CAN PAINT A TINT ONTO, without a user authoring one.
 *
 * `--card` is declared exactly twice in globals.css and is never washed (unlike
 * --sidebar and --muted-foreground, which have `-wash` variants the translucent
 * scene swaps in), so the second colour of every tint mix is precisely a
 * composition's card and nothing else composes over it.
 *
 * ONE LIST NOW, WHERE THERE WERE TWO (#471). This used to walk the built-in
 * THEMES and the starter LOOKS separately, either side of a distinction the
 * colour model no longer has — a palette with nothing over it is a composition
 * with no layers, so the ten built-in Looks are every card this build can paint
 * a tint onto. `compositionHalf` derives each one the way the app does, which
 * keeps the guard reading the real card rather than a stored copy of it.
 */
const surfaces: ReadonlyArray<{ label: string; mode: Mode; card: string }> = BUILT_IN_LOOKS.flatMap((look) =>
  MODES.map((mode) => ({ label: `look ${look.id}`, mode, card: compositionHalf(look.composition, mode).card })),
);

/** The three declared tones. `.tint-warning` has no call site outside
 *  globals.css today; it is measured anyway, because the class exists and the
 *  next reader to reach for it should find it already held to the bar. */
const TONES = ["success", "destructive", "warning"] as const;

describe("the semantic tints, on every scheme and Look we ship", () => {
  test("the stylesheet actually yielded a floor and a vocabulary", () => {
    // A positive control: every assertion below is a claim about values pulled
    // out of a file by regex, and a regex that quietly matched nothing would
    // make all of them vacuously true.
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(1);
    expect(INK.light.success).toMatch(/^oklch\(/);
    expect(INK.dark.destructive).toMatch(/^oklch\(/);
    expect(INK.light.success).not.toBe(INK.dark.success);
    expect(BUILT_IN_LOOKS.length).toBeGreaterThan(0);
    expect(surfaces.length).toBe(2 * BUILT_IN_LOOKS.length);
    for (const { label, card } of surfaces) expect(card, `${label} has a card`).toMatch(/^(oklch\(|#|rgb)/);
  });

  test("a tint reads as a step off the card it is mixed into", () => {
    // The palette's own elevation bar, not a text bar: globals.css moved the
    // canvas to 0.975 so a white card would clear 1.075:1, and called less than
    // that "a rounding error". A fill one rung up answers to the same number.
    const faint: string[] = [];
    for (const { label, mode, card } of surfaces) {
      for (const tone of TONES) {
        const { elevation } = measureTint(INK[mode][tone], card, floor);
        if (elevation < TINT_ELEVATION) faint.push(`${label} ${mode}: tint-${tone} is ${elevation.toFixed(4)}:1 on its card`);
      }
    }
    expect(faint).toEqual([]);
  });

  test("the ink still reads on the fill, not just on the card it used to sit on", () => {
    // `text-success` on `.tint-success` — diff-surface.tsx:771. The fill is
    // 12% of the same token, so the ink is measured against a surface that has
    // already moved toward it. This is the wall that stops the floor rising.
    const unreadable: string[] = [];
    for (const { label, mode, card } of surfaces) {
      for (const tone of TONES) {
        const { readability } = measureTint(INK[mode][tone], card, floor);
        if (readability < TINT_READABLE) unreadable.push(`${label} ${mode}: text-${tone} is ${readability.toFixed(3)}:1 on tint-${tone}`);
      }
    }
    expect(unreadable).toEqual([]);
  });

  test("added and removed stay apart, and no card can bring them together", () => {
    /**
     * CONTRAST IS THE WRONG INSTRUMENT HERE and that is the point of the test.
     * At the shipped floor `tint-success` and `tint-destructive` sit at about
     * 1.01:1 — a luminance ratio calling a green and a red the same colour.
     * The separation is perceptual distance in the space the mix already
     * happens in, or it is not measurable at all.
     *
     * WARNING IS NOT IN THIS PAIRING. Added-versus-removed is the distinction a
     * diff is made of; `tint-warning` never appears beside either on a reading
     * surface, and at this floor it sits nearer to both than they sit to each
     * other (≈0.019 and ≈0.017 in light). Holding a pair that never co-occurs
     * to a bar it does not need is how a guard acquires a false patient.
     */
    for (const mode of MODES) {
      const apart = toneSeparation(INK[mode].success, INK[mode].destructive, floor);
      expect(apart, `${mode}: tint-success and tint-destructive are ${apart.toFixed(4)} apart in Oklab`).toBeGreaterThanOrEqual(TONE_JND);
    }

    /**
     * AND IT IS CARD-INDEPENDENT, which is why this separation is a test and
     * never a theme-time repair: `mix(A, card, p) − mix(B, card, p) = p·(A − B)`
     * — the card carries the same weight into both fills and cancels exactly.
     * Measured against a deliberately hostile card as well as every shipped
     * one, so the claim is checked rather than asserted in prose.
     */
    const hostile = "oklch(0.5 0.1 162)";
    for (const mode of MODES) {
      const closed = toneSeparation(INK[mode].success, INK[mode].destructive, floor);
      for (const card of [...surfaces.filter((surface) => surface.mode === mode).map((surface) => surface.card), hostile]) {
        const measured = deltaEOk(tintOf(INK[mode].success, card, floor), tintOf(INK[mode].destructive, card, floor));
        expect(measured, `${mode}: the card ${card} changed how far the two tints sit apart`).toBeCloseTo(closed, 9);
      }
    }
  });

  test("the floor has TWO walls, and 'just raise it' hits the far one", () => {
    /**
     * The trap #705 was filed about, as arithmetic.
     *
     * Both walls are found by bisection over the real tokens rather than
     * written down, so this test reports where they ARE rather than where they
     * were the day it was written. Raise the floor past the readability wall
     * and this fails naming the ink it blinded; drop it below the tone wall and
     * it fails naming the pair it merged.
     */
    const worstReadability = (fraction: number) =>
      Math.min(...surfaces.flatMap(({ mode, card }) => TONES.map((tone) => measureTint(INK[mode][tone], card, fraction).readability)));
    const worstTone = (fraction: number) => Math.min(...MODES.map((mode) => toneSeparation(INK[mode].success, INK[mode].destructive, fraction)));

    const bisect = (holds: (fraction: number) => boolean, low: number, high: number) => {
      for (let step = 0; step < 50; step += 1) {
        const middle = (low + high) / 2;
        if (holds(middle)) low = middle;
        else high = middle;
      }
      return low;
    };
    // Readability falls as the floor rises; tone separation rises with it.
    const ceiling = bisect((fraction) => worstReadability(fraction) >= TINT_READABLE, 0.001, 0.6);
    const ground = bisect((fraction) => worstTone(fraction) < TONE_JND, 0.001, 0.6);

    expect(ground, "the tone wall is below the readability wall — there is a window at all").toBeLessThan(ceiling);
    expect(floor, `--tint-floor must stay above ${(ground * 100).toFixed(2)}%, where added and removed merge`).toBeGreaterThan(ground);
    expect(floor, `--tint-floor must stay below ${(ceiling * 100).toFixed(2)}%, where the ink stops reading on its own fill`).toBeLessThan(ceiling);
  });

  test("the measurement bites: a card chosen to break each separation does", () => {
    /**
     * A guard that has never failed is a guard nobody has checked. Each card
     * here is reachable by hand: the composer's own base control and per-token
     * overrides, and the VS Code importer, none of which constrains --card
     * against the state vocabulary — which is the half of #705 a test cannot
     * cover.
     *
     * NOTE WHICH SEPARATION EACH ONE BREAKS. A pale mint card does NOT hide the
     * fill: the fill still travels 12% of a long way in lightness, so elevation
     * holds at 1.18:1. What it does is strand the INK, because the card was
     * already near it. Elevation only fails when the card's LIGHTNESS lands on
     * the ink's — and by then readability has failed far harder.
     */
    const mint = measureTint(INK.light.success, "oklch(0.95 0.05 162)", floor);
    expect(mint.elevation, "a pale mint card still leaves the fill a visible step").toBeGreaterThan(TINT_ELEVATION);
    expect(mint.readability, "…but it strands text-success on that fill").toBeLessThan(TINT_READABLE);

    const midGreen = measureTint(INK.light.success, "oklch(0.50 0.10 162)", floor);
    expect(midGreen.elevation, "a card at the ink's own lightness erases the fill").toBeLessThan(TINT_ELEVATION);
    expect(midGreen.readability, "…and the ink with it").toBeLessThan(TINT_READABLE);

    const deepGreen = measureTint(INK.dark.destructive, "oklch(0.26 0.06 162)", floor);
    expect(deepGreen.readability, "a deep-green dark card strands text-destructive").toBeLessThan(TINT_READABLE);
  });
});
