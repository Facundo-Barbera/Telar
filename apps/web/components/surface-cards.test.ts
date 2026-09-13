/**
 * THE ROW'S TWO CARDS, AND THE ONE ATTRIBUTE THAT JOINS THEM.
 *
 * "Fill the window" leaves the conversation card at zero width without
 * unmounting it, and a zero-width rounded box paints its ring as a straight
 * full-height hairline — a stray divider beside the panel's own rounded edge.
 * The cure is a `:has()` rule: the panel marks itself `data-panel-fullscreen`,
 * the card drops its outline while that mark is in the row.
 *
 * Whether the rule WORKS was settled in a browser, against compiled Tailwind,
 * with a control that reproduces the hairline first. What no browser catches is
 * a rename on one side only — Tailwind cannot see a class name it did not read
 * as a literal, so neither half may come from a shared constant, and nothing in
 * the type system holds them together. This is that rename's tripwire, and the
 * only reason it reads source text rather than a rendered tree.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("./right-panel.tsx", import.meta.url), "utf8");
const cockpit = readFileSync(new URL("./session-cockpit.tsx", import.meta.url), "utf8");
/** The conversation card: the row's first child, the one wearing the ring. */
const card = /className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden([^"]*)"/.exec(cockpit)?.[1] ?? "";

describe("the mark the row's cards share", () => {
  test("the panel sets it, and only while it fills the window", () => {
    expect(panel).toContain('{...(fullscreen ? { "data-panel-fullscreen": "" } : {})}');
  });

  test("the row is the group the card reaches through", () => {
    expect(cockpit).toContain('<main data-surfaces className="group/surfaces');
  });

  test("the card drops outline AND shadow under it, and keeps both without it", () => {
    expect(card).toContain("md:ring-1");
    expect(card).toContain("md:shadow-1");
    expect(card).toContain("md:group-has-[[data-panel-fullscreen]]/surfaces:ring-0");
    expect(card).toContain("md:group-has-[[data-panel-fullscreen]]/surfaces:shadow-none");
  });
});
