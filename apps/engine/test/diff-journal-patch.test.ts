/**
 * THE SHAPE OF A PATCH THE JOURNAL CARRIES — issue #694, §2.4.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS FILE PINS A STRING THAT IS PARSED SOMEWHERE ELSE, AND SAYS SO.
 *
 * `unifiedDiff` produces the turn scope's patches; `@pierre/diffs` reads them.
 * The parser is a dependency of `apps/web` and not of this app, so the seam is
 * asserted from both ends against the SAME literal:
 *
 *   - here, that `unifiedDiff` emits exactly that text;
 *   - in `apps/web/components/session/diff-code-view.test.tsx`, that the parser
 *     makes `type="change"` of it rather than a rename.
 *
 * Either half alone is worthless. Without the parse, this pins a format nobody
 * has checked is readable — which is precisely the state #694 found: a patch
 * that looked entirely reasonable and parsed as a rename of `a/x.ts` to
 * `b/x.ts`. Without this, that one pins a literal that may no longer be what
 * the engine writes. Change one and the other must be changed in the same
 * commit.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { expect, test } from "bun:test";
import { unifiedDiff } from "../src/diff";

const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] };

test("a journal patch opens with `diff --git`, or the prefixes become the filename (#694)", () => {
  /**
   * WITHOUT THAT LINE a parser does not know it is looking at a git diff, so it
   * does not strip `a/` and `b/` — and since `a/x.ts ≠ b/x.ts` it concludes the
   * file was renamed. Every patch in the turn scope, in both hunk forms. It is
   * invisible today only because the viewer's file header is disabled; a file
   * tree or a re-enabled header draws it as `a/x.ts → b/x.ts`.
   */
  expect(unifiedDiff("x.ts", [HUNK])).toBe(["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"));

  // The multi-line hunk form too — `,1` is omitted by convention only for a
  // single line, so the two forms take different branches.
  expect(unifiedDiff("src/a.ts", [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO", " three"] }])).toBe(
    ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n"),
  );
});

test("an ABSOLUTE path still gets no header, because the only legal form is rejected (#694)", () => {
  /**
   * MEASURED, NOT TIDIED. `diff --git /tmp/x.ts /tmp/x.ts` — the one form that
   * would not reintroduce the double slash `a//tmp/x.ts` — makes the parser
   * throw `parsePatchContent: invalid git diff header`, while the bare
   * `---`/`+++` pair with no prefixes already reads as
   * `name="/tmp/x.ts" type="change"`.
   *
   * So the arm this module treats as the awkward exception is the one that was
   * always right, and it is left exactly as it was.
   */
  const patch = unifiedDiff("/tmp/x.ts", [HUNK]);
  expect(patch).toBe(["--- /tmp/x.ts", "+++ /tmp/x.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"));
  expect(patch).not.toContain("diff --git");
});
