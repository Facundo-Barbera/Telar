/**
 * THE DIFF TOOLBAR — issue #694.
 *
 * `DiffToolbar` rather than `DiffSurface`, the same split `diff-unknown.test.tsx`
 * makes and for the same reason: the review arrives over a read, and a static
 * render never runs the effect that starts one. The toolbar is a pure function
 * of the preference and the open set, so it is the half that can be handed both.
 *
 * TWO THINGS ARE PINNED HERE AND THEY ARE DIFFERENT KINDS OF THING. The markup
 * assertions are ordinary. The last case is not: it asserts that the
 * ignore-whitespace toggle reaches GIT rather than the renderer, which is the
 * one decision in this toolbar that is easy to get wrong by making it look
 * right — a client-side filter would hide the rows and leave the file's own
 * header counting them.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { filePatchQuery, parseFilePatchQuery } from "@telar/engine-client";
import { DEFAULT_DIFF_VIEW, type DiffView } from "@/lib/diff-view";
import { DiffToolbar } from "./diff-surface";

const toolbar = (view: Partial<DiffView> = {}, extra: { anyOpen?: boolean; expandable?: boolean } = {}) =>
  renderToStaticMarkup(
    <DiffToolbar
      view={{ ...DEFAULT_DIFF_VIEW, ...view }}
      setView={() => {}}
      anyOpen={extra.anyOpen ?? false}
      onToggleAll={() => {}}
      expandable={extra.expandable ?? true}
    />,
  );

const dir = fileURLToPath(new URL(".", import.meta.url));
const source = (file: string) => readFileSync(path.join(dir, file), "utf8");

describe("the diff toolbar", () => {
  test("Stacked and Split are one exclusive pair, not two independent buttons", () => {
    // A radiogroup rather than two toggles: the pair is one stop in the tab
    // order, and "both off" is not a state a layout can be in.
    const markup = toolbar();
    expect(markup).toContain('role="radiogroup"');
    expect((markup.match(/role="radio"/g) ?? []).length).toBe(2);
    expect(markup).toContain("stacked");
    expect(markup).toContain("split");
  });

  test("the chosen layout is the checked one, and only it", () => {
    /** The checked radio's own label — `[^>]*` steps over the class attribute
     *  that Tailwind puts between the two, which is not what is being read. */
    const checked = (markup: string) => /aria-checked="true"[^>]*>([a-z]+)</.exec(markup)?.[1];
    expect(checked(toolbar({ layout: "stacked" }))).toBe("stacked");
    expect(checked(toolbar({ layout: "split" }))).toBe("split");
    expect((toolbar({ layout: "split" }).match(/aria-checked="true"/g) ?? []).length).toBe(1);
  });

  test("wrap and whitespace are pressed marks, so a screen reader hears their state", () => {
    const off = toolbar();
    expect(off).toContain('aria-label="Word wrap" aria-pressed="false"');
    expect(off).toContain('aria-label="Ignore whitespace" aria-pressed="false"');
    const on = toolbar({ wrap: true, ignoreWhitespace: true });
    expect(on).toContain('aria-label="Word wrap" aria-pressed="true"');
    expect(on).toContain('aria-label="Ignore whitespace" aria-pressed="true"');
  });

  test("one button, whose label is the move that is left", () => {
    // Never a pair: with something open the useful move is to close, with
    // nothing open the only move is to open. A disabled twin would spend half
    // the control's width saying nothing.
    expect(toolbar({}, { anyOpen: false })).toContain("Expand all");
    expect(toolbar({}, { anyOpen: false })).not.toContain("Collapse all");
    expect(toolbar({}, { anyOpen: true })).toContain("Collapse all");
    expect(toolbar({}, { anyOpen: true })).not.toContain("Expand all");
  });

  test("with no rows the control goes, rather than greying out", () => {
    const empty = toolbar({}, { expandable: false });
    expect(empty).not.toContain("Expand all");
    // The layout controls stay: they are a preference, and choosing one over an
    // empty review is a perfectly ordinary thing to do before the read lands.
    expect(empty).toContain('role="radiogroup"');
  });

  test("ignoring whitespace is asked of GIT, not of the renderer", () => {
    /**
     * THE ONE CONTROL HERE THAT IS NOT A VIEW OPTION. Git decides which hunks
     * exist; a hunk that is there only because a line was re-indented is
     * already a hunk by the time the browser sees it. So the flag has to ride
     * the request — and the request function has to CHANGE IDENTITY when it
     * flips, or an already-open row goes on showing the answer to the old
     * question.
     *
     * ─────────────────────────────────────────────────────────────────────────
     * THIS TEST USED TO ASSERT THE SOURCE STRING AND PASSED WHILE THE FLAG WAS
     * DEAD (#694, fixed in the scope-selector change).
     *
     * The option was built here correctly and the engine parsed it correctly;
     * the cockpit's own adapter in between listed `untracked` and dropped the
     * rest, and TypeScript does not check excess properties on a non-literal,
     * so nothing anywhere failed. A test that reads the code that makes a claim
     * proves the claim was WRITTEN. The URL is the claim's effect, so that is
     * what this reads now — through the same builder every layer uses.
     * ─────────────────────────────────────────────────────────────────────────
     */
    expect(filePatchQuery("src/a.ts", {})).toBe("path=src%2Fa.ts");
    expect(filePatchQuery("src/a.ts", { ignoreWhitespace: true })).toContain("ignoreWhitespace=1");
    expect(filePatchQuery("src/a.ts", { untracked: true, ignoreWhitespace: true })).toContain("untracked=1");
    // ...and a server makes the same option of it again.
    expect(parseFilePatchQuery(new URLSearchParams(filePatchQuery("src/a.ts", { ignoreWhitespace: true })))).toMatchObject({
      ignoreWhitespace: true,
    });

    const surface = source("diff-surface.tsx");
    // The flag is in the request, and in the dependencies that re-read it.
    expect(surface).toContain("view.ignoreWhitespace ? { ignoreWhitespace: true } : {}");
    expect(surface).toContain("view.ignoreWhitespace");
    // ...and the row discards a patch that was read under the other flag.
    expect(surface).toContain("answer.reader === readPatch");
    // The renderer is told the other two and NOT this one, which is the proof
    // it never became a view option by accident.
    expect(source("diff-code-view.tsx")).not.toContain("ignoreWhitespace");
  });

  test("every layer between the toggle and git uses ONE query builder", () => {
    /**
     * THE STRUCTURAL HALF OF THE FIX ABOVE. Three layers stand between the
     * toolbar and `git diff`: the cockpit's adapter, its Next route handler,
     * and the engine's daemon. #694 shipped with the first of them enumerating
     * parameters by hand, which is how one went missing — the same failure
     * `forgeQuery` carries a note about for the GitHub filter.
     *
     * So none of them may list parameters any more, and this is what says so.
     * A new option added to `FilePatchOptions` reaches git through all three
     * without anybody remembering to update a fourth place.
     */
    const layers = {
      "lib/engine/client.ts": readFileSync(path.join(dir, "../../lib/engine/client.ts"), "utf8"),
      "app/api/sessions/[sessionId]/diff/route.ts": readFileSync(path.join(dir, "../../app/api/sessions/[sessionId]/diff/route.ts"), "utf8"),
      "app/api/projects/[projectId]/diff/route.ts": readFileSync(path.join(dir, "../../app/api/projects/[projectId]/diff/route.ts"), "utf8"),
    };
    for (const [name, code] of Object.entries(layers)) {
      expect(code, `${name} builds or parses the query with the shared pair`).toMatch(/filePatchQuery|parseFilePatchQuery/);
      // The hand-written form that dropped the flag, in any of its spellings.
      expect(code, `${name} does not read a diff parameter by hand`).not.toMatch(/searchParams\.get\("untracked"\)/);
    }
  });
});
