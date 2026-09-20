/**
 * ONE CARD, ONE RADIUS, AND A TINT THAT IS NOT A FOURTH CARD.
 *
 * Telar shipped four card shapes at three radii: `ui/card.tsx`, the approval
 * card (`rounded-xl border-warning/40 bg-warning/5`), a tally strip
 * (`rounded-xl bg-card shadow-sm ring-1` — a letter-perfect restatement of
 * the primitive, since decommissioned with the surface that drew it), and a
 * sidebar row
 * at `rounded-md`. Nothing was wrong on its own; together they were four
 * treatments of "a raised box with a hairline", differing only in having been
 * written on different days. Issue #250 item 10 settled it: one shape, at 14px,
 * and a warning card is that shape with a tint.
 *
 * WHY A TEST AND NOT A BROWSER. A browser settles whether 14px looks right. It
 * cannot catch the fifth card typed six months from now — that one will render
 * something, it will render it round, and it will be invisibly off the ladder.
 * The radius assertion is arithmetic against globals.css rather than a literal
 * `14px`, so retuning `--radius` moves the card with the scale instead of
 * silently breaking the parity with iOS `Theme.radiusCard`.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { cardSurface } from "@/components/ui/card";

// fileURLToPath is not needed here — `new URL(…, import.meta.url)` is handed
// straight to readFileSync, which accepts a file URL and decodes the space in
// this repo's checkout path itself.
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const cardPrimitive = readFileSync(new URL("./ui/card.tsx", import.meta.url), "utf8");
const approval = readFileSync(new URL("./approval-card.tsx", import.meta.url), "utf8");

describe("the card shape", () => {
  test("a neutral card is the fill and the hairline, at the card radius", () => {
    expect(cardSurface()).toBe("rounded-xl bg-card ring-1 ring-foreground/10");
  });

  test("the default tone is the neutral one", () => {
    expect(cardSurface("default")).toBe(cardSurface());
  });

  test("a warning card differs by the tint alone — same radius, same hairline weight", () => {
    const warning = cardSurface("warning");
    expect(warning).toBe("rounded-xl bg-warning/5 ring-1 ring-warning/40");
    // The shapes are the same object: strip the two tinted declarations and
    // what is left has to match the neutral card exactly.
    expect(warning.replace("bg-warning/5", "bg-card").replace("ring-warning/40", "ring-foreground/10")).toBe(cardSurface());
  });

  test("the primitive wears the shared shape rather than restating it", () => {
    expect(cardPrimitive).toContain("cardSurface(tone)");
    // The literals live in `cardSurface` and nowhere else in the primitive —
    // a second copy is exactly how the four shapes happened.
    expect(cardPrimitive.match(/rounded-xl bg-card/g) ?? []).toHaveLength(1);
  });
});

describe("the card radius is the ladder's, and the ladder agrees with iOS", () => {
  test("--radius-xl is --radius × 1.4", () => {
    expect(globals).toContain("--radius-xl: calc(var(--radius) * 1.4);");
  });

  test("which lands the card at 14px — the value iOS Theme.radiusCard carries", () => {
    const base = /--radius:\s*([\d.]+)rem;/.exec(globals)?.[1];
    expect(base).toBeDefined();
    expect(Number(base) * 16 * 1.4).toBeCloseTo(14, 5);
  });
});

describe("the hand-rolled card now reaches for the shape", () => {
  test("the approval card imports it and tints with it", () => {
    expect(approval).toContain('from "@/components/ui/card"');
    expect(approval).toContain('cardSurface("warning")');
  });

  test("the approval card keeps no private radius, fill or hairline", () => {
    expect(approval).not.toContain("border-warning/40");
    expect(approval).not.toContain("bg-warning/5 p-3");
  });
});
