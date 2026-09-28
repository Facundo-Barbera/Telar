/**
 * THE COLOURED LAYER, RENDERED — against real Shiki output, not a stand-in.
 *
 * The defect this pins was invisible to every unit test the editor had, because
 * it was not in the tokenising and not in the text: Shiki returns an EMPTY TOKEN
 * ARRAY for a blank line, `[]` is truthy, and the highlighted branch drew
 * `<div></div>` — an element with no inline content and so no line box. The
 * source was intact the whole time; only the layer UNDER the textarea lost its
 * blank lines, which is why the code appeared to slide up and the missing height
 * appeared to pile up at the end of the file.
 *
 * So the assertions are about the RENDERED MARKUP, before and after the colours
 * arrive: one `<div>` per source line either way, and no `<div>` that draws
 * nothing. Line count is the caret invariant — the gutter numbers the same array
 * and the textarea holds the same newlines, so a coloured layer with a different
 * number of line boxes is a caret pointing at the wrong line.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { carryTokens, highlight } from "@/lib/highlight";
import { CodeLines } from "./overlay-editor";

/** Consecutive blank lines, a blank line inside an indented block, a tab
 *  indent, and a trailing newline — the shape of ordinary Python, and every
 *  case the collapse showed up in. */
const PYTHON = ["import os", "", "", "def main():", "    a = 1", "", "    return a", "\tpass", ""].join("\n");

/** The `<div>`s of the coloured layer, as their text. */
function renderedLines(markup: string): string[] {
  return [...markup.matchAll(/<div[^>]*>(.*?)<\/div>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, ""));
}

describe("CodeLines", () => {
  test("draws one line box per source line, plain", () => {
    const lines = PYTHON.split("\n");
    const drawn = renderedLines(renderToStaticMarkup(<CodeLines lines={lines} />));
    expect(drawn).toHaveLength(lines.length);
    // Nothing empty: an empty div has no height, and the gutter beside it does.
    expect(drawn.filter((line) => line === "")).toHaveLength(0);
  });

  test("draws one line box per source line once Shiki has answered", async () => {
    const lines = PYTHON.split("\n");
    const coloured = await highlight(PYTHON, "python");
    expect(coloured).toBeDefined();
    // The fixture is only worth anything if Shiki really does hand back empty
    // token arrays for the blank lines — that IS the bug's ingredient.
    expect(coloured!.filter((line) => line.length === 0).length).toBeGreaterThan(0);
    expect(coloured).toHaveLength(lines.length);

    const drawn = renderedLines(renderToStaticMarkup(<CodeLines lines={lines} coloured={coloured} />));
    expect(drawn).toHaveLength(lines.length);
    expect(drawn.filter((line) => line === "")).toHaveLength(0);
  });

  test("highlighting does not move a line — the two renders agree, line for line", async () => {
    // The caret invariant stated directly: what the reader sees before the
    // colours land and what they see after must be the same text in the same
    // order, or the textarea's caret is over a different line than it was.
    const lines = PYTHON.split("\n");
    const before = renderedLines(renderToStaticMarkup(<CodeLines lines={lines} />));
    const after = renderedLines(renderToStaticMarkup(<CodeLines lines={lines} coloured={await highlight(PYTHON, "python")} />));
    expect(after).toEqual(before);
  });

  test("a blank line keeps its indentation-free space rather than its source", () => {
    // The substitute is a space, not the empty string, and it is only ever used
    // where the line has nothing visible in it — a line with content is never
    // padded.
    const drawn = renderedLines(renderToStaticMarkup(<CodeLines lines={["a", "", "b"]} />));
    expect(drawn).toEqual(["a", " ", "b"]);
  });

  test("a grammar that emits one empty token still gets a line box", () => {
    // Not hypothetical for every language Shiki ships, and it renders exactly
    // as nothing does — so the check is on visible text, not on token count.
    const empty = [{ text: "", style: {} }];
    expect(renderedLines(renderToStaticMarkup(<CodeLines lines={[""]} coloured={[empty]} />))).toEqual([" "]);
  });

  test("minRows pads the box out, without inventing source lines", () => {
    // A notebook cell asks for a minimum height (OverlayEditor's `minRows`); the
    // padding lines are blank ones and must have boxes for the same reason.
    const drawn = renderedLines(renderToStaticMarkup(<CodeLines lines={["a"]} minRows={3} />));
    expect(drawn).toEqual(["a", " ", " "]);
  });

  test("a trailing newline is a line, and it is the last one", async () => {
    // `"x\n".split("\n")` is `["x", ""]`: the file ends with a newline, so there
    // IS a final empty line, the gutter numbers it, and dropping its box was
    // half of what made the blank lines look like they had moved to the end.
    const source = "x = 1\n";
    const lines = source.split("\n");
    expect(lines).toHaveLength(2);
    const drawn = renderedLines(renderToStaticMarkup(<CodeLines lines={lines} coloured={await highlight(source, "python")} />));
    expect(drawn).toHaveLength(2);
    expect(drawn[1]).toBe(" ");
  });

  /** How many lines were drawn with coloured `<span>`s rather than as plain
   *  text — the thing the reader actually sees flicker. */
  function colouredLineCount(markup: string): number {
    return [...markup.matchAll(/<div[^>]*>(.*?)<\/div>/g)].filter((match) => match[1]!.includes("<span")).length;
  }

  test("a keystroke costs ONE line its colours, not the whole file", async () => {
    // THE FLICKER, at the layer the reader sees it. Between a keystroke and the
    // debounced re-tokenise the editor holds tokens for text one character out
    // of date; it used to discard them wholesale, which repainted every line of
    // the file as plain text ~120ms at a time, continuously while typing.
    const before = "import os\n\n\ndef main():\n    a = 1\n    return a\n";
    const typed = before.replace("a = 1", "a = 12");
    const tokens = await highlight(before, "python");
    expect(tokens).toBeDefined();

    const all = renderToStaticMarkup(<CodeLines lines={before.split("\n")} coloured={tokens} />);
    const settled = colouredLineCount(all);
    expect(settled).toBeGreaterThan(1);

    // What the old rule drew for the very next frame: no tokens at all.
    expect(colouredLineCount(renderToStaticMarkup(<CodeLines lines={typed.split("\n")} />))).toBe(0);

    // What it draws now: everything but the line under the caret.
    const mid = renderToStaticMarkup(<CodeLines lines={typed.split("\n")} coloured={carryTokens({ of: before, lines: tokens! }, typed)} />);
    expect(colouredLineCount(mid)).toBe(settled - 1);
    // And the line that lost them still draws its own source, not a gap.
    expect(renderedLines(mid)).toEqual(typed.split("\n").map((line) => line || " "));
  });
});
