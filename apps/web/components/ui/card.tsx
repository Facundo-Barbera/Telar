/** What tints a card. `warning` is the shape asking for a decision. */
export type CardTone = "default" | "warning"

/**
 * THE CARD SHAPE, IN ONE PLACE — radius, fill and hairline, nothing else.
 *
 * Telar drew four cards at three radii: this primitive, the approval card, a
 * tally strip (since decommissioned) and a sidebar row. Three of them were
 * hand-rolled restatements of the same box, which is how they came to disagree
 * about how round a card is. `rounded-xl` is 14px here (--radius-xl, i.e.
 * --radius × 1.4) and it is also iOS `Theme.radiusCard` — practice on both
 * platforms, and now the documented ladder too (see globals.css --radius).
 *
 * IT IS A STRING, NOT A COMPONENT, because two of the three call sites are not
 * a `<div>`: the question card is a `<form>` and the two approval cards are
 * `<section>`s carrying an aria-label. A primitive that can only render a div
 * would have cost them their element, and an element is not a style choice.
 *
 * A WARNING CARD IS A CARD WITH A TINT, not its own object. It differs from a
 * neutral one by exactly two declarations, and the ring carries the warning at
 * 40% where the fill carries it at 5% — the hairline is what a person reads as
 * "this one is waiting on me" from across the transcript.
 */
export function cardSurface(tone: CardTone = "default"): string {
  return tone === "warning"
    ? "rounded-xl bg-warning/5 ring-1 ring-warning/40"
    : "rounded-xl bg-card ring-1 ring-foreground/10"
}
