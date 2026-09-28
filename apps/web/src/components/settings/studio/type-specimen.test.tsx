/**
 * THE SPECIMENS FIT THE READING COLUMN — issue #435.
 *
 * Appearance used to opt out of the settings measure and run the full window,
 * so nothing here had a width to answer to. It sits in the same 42rem column
 * as General now, which turns "how long is a sample line?" from a matter of
 * taste into arithmetic: the column is fixed, the card's inset is fixed, and
 * the mono size is a SETTING that a reader can push to `MAX_MONO_FONT_SIZE`.
 * A line longer than the budget below is one that scrolls out of sight at the
 * biggest face on offer — and a specimen you have to scroll to read cannot
 * answer the only question it was put on the pane to answer.
 *
 * SO THE BUDGET IS COMPUTED, NOT TYPED. Every term is imported or taken from
 * the markup it constrains, so widening the column or raising the maximum size
 * moves this test with it rather than leaving a stale number behind.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_MONO_FONT_SIZE } from "@/lib/appearance";
import { CodeSpecimen, InterfaceSpecimen, TerminalSpecimen } from "./type-specimen";

/** The shell's reading column, `max-w-2xl` in settings-shell.tsx. */
const COLUMN_PX = 42 * 16;
/** The shell's own `px-5`, then the group card's `[&>*]:px-4`. */
const COLUMN_INSET = 2 * 20 + 2 * 16;
/** The widest advance a monospace face in the picker draws, as a fraction of
 *  its size. The bundled six are all ≈0.6em; the margin is for `custom`. */
const ADVANCE = 0.62;

function charBudget(chrome: number): number {
  return Math.floor((COLUMN_PX - COLUMN_INSET - chrome) / (MAX_MONO_FONT_SIZE * ADVANCE));
}

/** Every `whitespace-pre` run in a specimen, tags stripped and entities
 *  decoded — which is exactly the set of lines rendered in the mono face. */
function monoLines(html: string): string[] {
  const runs = [...html.matchAll(/<code class="whitespace-pre">([\s\S]*?)<\/code>/g)].map((match) => match[1] ?? "");
  return runs
    .flatMap((run) => run.replace(/<[^>]+>/g, "").split("\n"))
    .map((line) =>
      line
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
}

describe("the mono specimens stay inside the column", () => {
  test("the diff's longest line is readable whole at the largest mono size", () => {
    // `pre` pads `px-3`, the gutter is `w-4` and the gap to the code is `gap-3`.
    const budget = charBudget(2 * 12 + 16 + 12);
    const lines = monoLines(renderToStaticMarkup(<CodeSpecimen />));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(budget);
  });

  test("the terminal run is readable whole at the largest mono size", () => {
    // `pre` pads `px-3`; there is no gutter in this one.
    const budget = charBudget(2 * 12);
    const lines = monoLines(renderToStaticMarkup(<TerminalSpecimen />));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(budget);
  });

  test("a long line scrolls the block rather than stretching the card", () => {
    /**
     * The budget above is about what can be READ; this is the floor under it.
     * `overflow-x-auto` is load-bearing twice over: it scrolls the overflow,
     * and — because a flex item with a non-visible overflow has an automatic
     * minimum size of zero — it is what lets these blocks shrink to the column
     * at all instead of pushing the group card past the measure.
     */
    expect(renderToStaticMarkup(<TerminalSpecimen />)).toContain("overflow-x-auto");
    const code = renderToStaticMarkup(<CodeSpecimen />);
    expect(code).toContain("overflow-x-auto");
    // The frame clips too, so the scrolling `pre` cannot spill past its border.
    expect(code).toContain("overflow-hidden");
  });
});

describe("the interface specimen", () => {
  test("is prose that wraps, with no width of its own to defend", () => {
    // It is the one specimen that must REFLOW rather than scroll: interface
    // text wraps everywhere else in the app, so a specimen that scrolled
    // sideways would be showing the reader something the app never does.
    const html = renderToStaticMarkup(<InterfaceSpecimen />);
    expect(html).not.toContain("overflow-x-auto");
    expect(html).not.toContain("whitespace-pre");
    expect(html).not.toContain("w-[");
  });
});
