/**
 * THE SEAM ACROSS THE TOP OF THE EDITOR.
 *
 * The Editor draws a header on both sides of one vertical border — the tree's
 * refresh-and-search line, and the open-file strip — and under the strip a third
 * row naming the file. Each of them used to size itself, so the two `border-b`
 * rules landed 4px apart, the `px-` inset differed three ways, and the address
 * row's height moved when you opened a different KIND of file (#275).
 *
 * Nothing in the type system makes those rows agree; a shared string does, and
 * this is what says so. A future edit that gives one of them its own height has
 * to fail here and come read the note in session/editor-chrome.tsx.
 *
 * `renderToStaticMarkup`, like header-controls.test.tsx: this is about the
 * classes the first paint carries, and no effects need to run for that. Every
 * surface therefore renders its header over a file it has not read yet, which
 * is the state the seam has to be right in too.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EDITOR_HEADER_ROW } from "./editor-chrome";
import { EditorSurface } from "./editor-surface";
import { FilesSurface } from "./files-surface";
import { FileViewSurface } from "./file-view-surface";
import { NotebookSurface } from "./notebook-surface";
import { PdfSurface } from "./pdf-surface";
import { TableSurface } from "./table-surface";
import { emptyEditor, setExplorerOpen } from "@/lib/editor-workspace";

/** The two properties the issue measured: one height, one inset. Spelled out
 *  rather than derived from the token, so a token edited to `h-10` fails here
 *  instead of silently re-measuring the test against itself. */
const HEIGHT = "h-9";
const INSET = "px-2";

/** The strip alone — the tree is closed, so the only header in this markup is
 *  the one on the file side. */
const strip = () =>
  renderToStaticMarkup(<EditorSurface state={setExplorerOpen(emptyEditor(), false)} onState={() => {}} sessionId="session_1" />);
const tree = () => renderToStaticMarkup(<FilesSurface sessionId="session_1" onOpenFile={() => {}} />);

describe("the tree header and the open-file strip are one bar", () => {
  test("both carry the same height and the same inset", () => {
    for (const [side, html] of Object.entries({ tree: tree(), strip: strip() })) {
      expect(`${side} height: ${html.includes(HEIGHT)}`).toBe(`${side} height: true`);
      expect(`${side} inset: ${html.includes(INSET)}`).toBe(`${side} inset: true`);
    }
  });

  test("they carry it from the same string, not by coincidence", () => {
    expect(EDITOR_HEADER_ROW).toContain(HEIGHT);
    expect(EDITOR_HEADER_ROW).toContain(INSET);
    expect(tree()).toContain(EDITOR_HEADER_ROW);
    expect(strip()).toContain(EDITOR_HEADER_ROW);
  });

  test("the tree's header is outside the tree's scroller, so it cannot scroll away", () => {
    // The overflow used to be the box AROUND this surface, which took the
    // header up with the rows while the strip opposite never moved.
    const html = tree();
    expect(html).toContain("overflow-y-auto");
    expect(html.indexOf(EDITOR_HEADER_ROW)).toBeLessThan(html.indexOf("overflow-y-auto"));
  });
});

describe("the address row does not move between file kinds", () => {
  const rows = () => ({
    code: renderToStaticMarkup(<FileViewSurface path="src/main.ts" sessionId="session_1" />),
    notebook: renderToStaticMarkup(<NotebookSurface path="analysis.ipynb" sessionId="session_1" />),
    table: renderToStaticMarkup(<TableSurface path="data/rows.csv" sessionId="session_1" />),
    pdf: renderToStaticMarkup(<PdfSurface path="docs/paper.pdf" sessionId="session_1" />),
  });

  test("all four wear the header token — the same one the strip above them does", () => {
    for (const [kind, html] of Object.entries(rows())) {
      expect(`${kind}: ${html.includes(EDITOR_HEADER_ROW)}`).toBe(`${kind}: true`);
    }
  });

  test("each one still names its own file, split at the last slash", () => {
    const { code, notebook, table, pdf } = rows();
    expect(code).toContain("main.ts");
    expect(code).toContain("src/");
    expect(notebook).toContain("analysis.ipynb");
    expect(table).toContain("rows.csv");
    expect(pdf).toContain("paper.pdf");
  });
});
