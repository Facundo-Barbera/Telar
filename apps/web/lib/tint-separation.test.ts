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

import { THEME_TOKENS } from "@telar/engine-client";
import { BUILT_IN_LOOKS } from "./built-in-looks";
import { compositionHalf } from "./composition";
import { halfFromBase } from "./palette-from-image";
import {
  deltaEOk,
  measureTint,
  oklabToRgb,
  paintsAsMeasured,
  repairInk,
  rgbToOklab,
  STATE_INK,
  TINT_ELEVATION,
  TINT_FLOOR,
  TINT_READABLE,
  TINT_TONES,
  tintCost,
  tintOf,
  toOklab,
  TONE_JND,
  toneSeparation,
} from "./tint-separation";

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

/**
 * THE REPAIR — the ink moves, the card never does (#705).
 *
 * WHY THIS IS THE END OF THE MIX THAT MAY BE REWRITTEN, in one sentence: the
 * card is a colour somebody chose, and the state vocabulary is a colour nobody
 * can choose. The first test below is that premise as an assertion, because
 * every other test here is worthless if it stops being true.
 *
 * TWO DOMAINS, AND THEY ANSWER DIFFERENT QUESTIONS. The BASE-REACHABLE set is
 * every card this build can derive from the composer's own control — generated
 * from the hue/saturation domain of a colour picker and pushed through the real
 * `halfFromBase`, never written down — and the answer there is that the repair
 * never fires. The sRGB GRID is every card a VS Code import, a Look file or a
 * hand override can reach, and the answer there is what the repair does when it
 * does fire. A guard over only the first would pass forever without exercising
 * a line of the search.
 */
describe("repairing the ink", () => {
  /** Every base a person can pick, as the picker's own hue × saturation grid.
   *  GENERATED, so raising MAX_TINT or letting `retint` touch lightness moves
   *  what this covers instead of leaving a stale list behind. */
  const BASES: string[] = (() => {
    const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, "0");
    const fromHsl = (hue: number, saturation: number) => {
      const chroma = saturation; // at lightness 0.5, (1 − |2L − 1|)·s is just s
      const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
      const lift = 0.5 - chroma / 2;
      const [r, g, b] = [
        [chroma, second, 0],
        [second, chroma, 0],
        [0, chroma, second],
        [0, second, chroma],
        [second, 0, chroma],
        [chroma, 0, second],
      ][Math.floor(hue / 60) % 6]!;
      return `#${channel(r + lift)}${channel(g + lift)}${channel(b + lift)}`;
    };
    const bases: string[] = [];
    for (let hue = 0; hue < 360; hue += 2) for (let step = 0; step <= 40; step += 1) bases.push(fromHsl(hue, step / 40));
    return bases;
  })();

  /** Every card an IMPORT or a hand override can reach: sRGB at six levels per
   *  channel. Coarse on purpose — the search is two thousand evaluations deep
   *  and this is multiplied by two schemes and three tones. */
  const SRGB: string[] = (() => {
    const cards: string[] = [];
    const levels = [0, 51, 102, 153, 204, 255];
    for (const r of levels) for (const g of levels) for (const b of levels) cards.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    return cards;
  })();

  /** The search is two thousand evaluations deep and four tests below walk the
   *  same grid. One answer per (scheme, card, tone), computed once. */
  const answers = new Map<string, ReturnType<typeof repairInk>>();
  const repaired = (mode: Mode, card: string, tone: (typeof TINT_TONES)[number]) => {
    const key = `${mode}|${card}|${tone}`;
    const cached = answers.get(key);
    if (cached) return cached;
    const answer = repairInk(STATE_INK[mode][tone], card, floor);
    answers.set(key, answer);
    return answer;
  };

  test("the whole argument's premise: no Look can set a state colour", () => {
    /**
     * THE LOAD-BEARING FACT. Repairing `--success` is only safe because there is
     * no way for anybody to have chosen it — it is not in the sixteen a Look
     * carries, so no import, no Look file, no picker and no migration can write
     * one. Put `success` in THEME_TOKENS and this fails, which is correct: the
     * rule would have to be reconsidered from the start.
     */
    for (const tone of TINT_TONES) expect(THEME_TOKENS as readonly string[], `--${tone} must stay out of the themable vocabulary`).not.toContain(tone);

    // And the copy this module carries is the stylesheet's, character for
    // character — the repair runs in a browser, where there is no globals.css
    // to read, so the copy exists and must not be allowed to drift.
    expect(TINT_FLOOR).toBe(floor);
    for (const mode of MODES) {
      for (const tone of TINT_TONES) {
        expect(STATE_INK[mode][tone], `--${tone} in ${mode}`).toBe(token(mode === "light" ? ":root" : ".dark", tone));
      }
    }
  });

  test("no base colour makes the repair fire — it is a fixed point on everything the composer can derive", () => {
    /**
     * 14,760 CARDS, and the point is that not one of them needs repairing.
     *
     * `halfFromBase` carries Telar's lightness spine across verbatim and
     * rewrites only chroma and hue, capped at MAX_TINT × the card's weight — so
     * the card's LIGHTNESS is pinned and its chroma is tiny. Both facts are
     * asserted rather than assumed: let `retint` rewrite lightness and the
     * spine check fails, raise MAX_TINT far enough and the separations do.
     */
    const spine = { light: "1", dark: "0.2" } as const;
    const offSpine: string[] = [];
    const broken: string[] = [];
    const moved: string[] = [];
    for (const mode of MODES) {
      for (const base of BASES) {
        const card = halfFromBase(base, mode).card;
        const lightness = /^oklch\(([\d.]+)\s/.exec(card)?.[1];
        if (lightness !== spine[mode]) offSpine.push(`${mode} base ${base} derived ${card}`);
        for (const tone of TINT_TONES) {
          const { elevation, readability } = measureTint(STATE_INK[mode][tone], card, floor);
          if (elevation < TINT_ELEVATION || readability < TINT_READABLE) {
            broken.push(`${mode} base ${base} card ${card} tint-${tone}: ${elevation.toFixed(4)}:1 elevation, ${readability.toFixed(3)}:1 readability`);
          }
          const repair = repairInk(STATE_INK[mode][tone], card, floor);
          if (repair.outcome !== "holds") moved.push(`${mode} base ${base} card ${card} tint-${tone}: ${repair.outcome}`);
        }
      }
    }
    expect(BASES.length * MODES.length).toBe(14_760);
    expect(offSpine.slice(0, 5), "a derived card must keep the spine's lightness").toEqual([]);
    expect(broken.slice(0, 5), "no base colour may break either separation").toEqual([]);
    expect(moved.slice(0, 5), "and so the repair must be a fixed point on every one of them").toEqual([]);
  });

  test("every Look this build ships is a fixed point too", () => {
    const moved: string[] = [];
    for (const { label, mode, card } of surfaces) {
      for (const tone of TINT_TONES) {
        const repair = repairInk(STATE_INK[mode][tone], card, floor);
        if (repair.outcome !== "holds") moved.push(`${label} ${mode} tint-${tone}: ${repair.outcome}`);
      }
      expect(tintCost(card, STATE_INK[mode], floor).stranded, `${label} ${mode} strands nothing`).toEqual([]);
    }
    expect(moved).toEqual([]);
  });

  test("it answers BOTH separations, not the one that happened to fail", () => {
    /**
     * A READABILITY-ONLY RULE IS WRONG AND THE sRGB DOMAIN PROVES IT. #705's
     * investigation expected elevation to be dominated — never failing while
     * readability holds — and over the cards a BASE can derive that is exactly
     * true. Over the cards an IMPORT can reach it is not: a near-black card
     * fails elevation with readability at 8:1, because a fill made of 12% ink
     * over black has nowhere to go.
     *
     * Measured, not asserted: five such pairings in the grid below. Repair
     * readability alone and `#000011` comes back "holds" with its fill still
     * invisible.
     */
    const elevationOnly: string[] = [];
    for (const mode of MODES) {
      for (const card of SRGB) {
        for (const tone of TINT_TONES) {
          const { elevation, readability } = measureTint(STATE_INK[mode][tone], card, floor);
          if (elevation >= TINT_ELEVATION || readability < TINT_READABLE) continue;
          elevationOnly.push(`${mode} ${card} tint-${tone}`);
          const repair = repaired(mode, card, tone);
          expect(repair.outcome, `${mode} ${card} tint-${tone} fails elevation at ${elevation.toFixed(4)}:1 — it cannot be left alone`).not.toBe("holds");
        }
      }
    }
    expect(elevationOnly.length, "the grid must contain the elevation-only case this guard is about").toBeGreaterThan(0);

    // And nothing the search RETURNS as repaired may fail either bar.
    const failed: string[] = [];
    for (const mode of MODES) {
      for (const card of SRGB) {
        for (const tone of TINT_TONES) {
          const repair = repaired(mode, card, tone);
          if (repair.outcome !== "repaired") continue;
          const { elevation, readability } = measureTint(repair.ink, card, floor);
          if (elevation < TINT_ELEVATION || readability < TINT_READABLE) {
            failed.push(`${mode} ${card} tint-${tone} → ${repair.ink}: ${elevation.toFixed(4)} / ${readability.toFixed(3)}`);
          }
        }
      }
    }
    expect(failed.slice(0, 5)).toEqual([]);
  });

  test("a card no lightness can rescue is REPORTED, and nothing moves", () => {
    /**
     * The mid-green card from the measurement above: it sits on the ink's own
     * lightness, so ELEVATION is what fails and no ink can answer that — the
     * fill has nowhere to go. The right outcome is to change nothing and say
     * so. Let the search return its best failing attempt and this fails with
     * the moved colour in hand.
     */
    for (const tone of TINT_TONES) {
      const repair = repairInk(STATE_INK.light[tone], "oklch(0.50 0.10 162)", floor);
      expect(repair.outcome, `tint-${tone} on a card at the ink's own lightness`).toBe("stranded");
      expect(repair.ink, "a stranded tone keeps the shipped colour exactly").toBe(STATE_INK.light[tone]);
    }
    expect(tintCost("oklch(0.50 0.10 162)", STATE_INK.light, floor).stranded).toEqual([...TINT_TONES]);

    // The pale-mint card is the other arm: readability fails, and a tenth of a
    // step of lightness answers it.
    const mint = repairInk(STATE_INK.light.success, "oklch(0.95 0.05 162)", floor);
    expect(mint.outcome).toBe("repaired");
    expect(mint.outcome === "repaired" && mint.moved, "the smallest move that works, not the first one found").toBeLessThan(0.05);
  });

  test("moving the ink does not spend the separation between added and removed", () => {
    /**
     * THE COST THE OBVIOUS ALTERNATIVE PAYS. Readability is a contrast ratio, and
     * chroma moves it too — so "reduce the chroma until the ink reads" is a
     * rule somebody will propose. It merges added with removed: `tint-success`
     * and `tint-destructive` are told apart almost entirely by a and b, and
     * draining chroma is draining exactly that. Repair by chroma instead of
     * lightness and the worst case here falls to 0.0185, under the JND.
     *
     * Held BOTH ways: an absolute floor at the JND, and a no-meaningful-
     * regression bar against what the shipped vocabulary already had. The
     * second is the sharper one — the measured worst is 0.9955 of the shipped
     * separation, so a rule that spent even a twentieth of it would fail here
     * long before the absolute floor noticed.
     */
    const shipped = { light: toneSeparation(STATE_INK.light.success, STATE_INK.light.destructive, floor), dark: toneSeparation(STATE_INK.dark.success, STATE_INK.dark.destructive, floor) };
    let fired = 0;
    const merged: string[] = [];
    for (const mode of MODES) {
      for (const card of SRGB) {
        const success = repaired(mode, card, "success");
        const destructive = repaired(mode, card, "destructive");
        if (success.outcome === "holds" && destructive.outcome === "holds") continue;
        fired += 1;
        const apart = toneSeparation(success.ink, destructive.ink, floor);
        if (apart < TONE_JND) merged.push(`${mode} ${card}: ${apart.toFixed(5)} apart, under the JND`);
        else if (apart < shipped[mode] * 0.99) merged.push(`${mode} ${card}: ${apart.toFixed(5)}, down from ${shipped[mode].toFixed(5)}`);
      }
    }
    expect(fired, "the grid must actually make the repair fire").toBeGreaterThan(0);
    expect(merged.slice(0, 5)).toEqual([]);
  });

  test("what it emits is what a screen paints", () => {
    /**
     * THE TRAP UNDER THE WHOLE MEASUREMENT. `oklabToRgb` clamps each channel on
     * its own; a browser handed an out-of-gamut `oklch()` reduces CHROMA
     * instead. The difference is invisible while every colour measured came in
     * as sRGB — and the repair is the first thing here that INVENTS one.
     *
     * #705's investigation proposed moving Nord's `--destructive` to
     * `oklch(0.943 0.19 25.5)`. That colour is 0.145 ΔE-Oklab — seven JND —
     * from what any screen would show for it, so the 4.5:1 it was credited with
     * was a ratio for a colour nobody would ever see. Drop this check and that
     * class of answer comes back.
     */
    const stray: string[] = [];
    for (const mode of MODES) {
      for (const card of SRGB) {
        for (const tone of TINT_TONES) {
          const repair = repaired(mode, card, tone);
          if (repair.outcome !== "repaired") continue;
          const asked = toOklab(repair.ink);
          const painted = rgbToOklab(oklabToRgb(asked));
          const drift = deltaEOk(asked, painted);
          if (drift > TONE_JND) stray.push(`${mode} ${card} tint-${tone} → ${repair.ink} paints ${drift.toFixed(4)} away`);
        }
      }
    }
    expect(stray.slice(0, 5)).toEqual([]);
    // The specific colour the investigation proposed, named so the number is
    // checked rather than quoted.
    expect(paintsAsMeasured(toOklab("oklch(0.943 0.19 25.5)")), "the investigation's Nord repair is not a colour a screen can show").toBe(false);
    for (const mode of MODES) for (const tone of TINT_TONES) expect(paintsAsMeasured(toOklab(STATE_INK[mode][tone])), `the shipped --${tone} is`).toBe(true);
  });
});
