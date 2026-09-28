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
 * and a warning card is that shape with a tint. The 14px rung itself is
 * pinned in `app/radius-doctrine.test.ts`.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";

import { cardSurface } from "@/components/ui/card";

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
});

