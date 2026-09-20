/**
 * File edits, as something a human can review.
 *
 * WHY THIS EXISTS. `FileChangeDetail` has carried `unifiedDiff`, `linesAdded`
 * and `linesRemoved` since v2 was written and NOTHING PRODUCED THEM — an Edit
 * row showed a path and nothing else. For a detached session that is the whole
 * ballgame: you come back to a finished run and the one question is "what did it
 * change", and the transcript could not answer it.
 *
 * The data was there the whole time. The Agent SDK puts a `structuredPatch` on
 * the tool RESULT (`FileEditOutput` / `FileWriteOutput` in its `sdk-tools`
 * types) — the same hunk shape jsdiff produces — and the driver was reading only
 * the string content sent to the model.
 *
 * A UNIFIED DIFF STRING RATHER THAN THE HUNK STRUCTURE, matching the contract's
 * own note: every renderer and every review tool already speaks it, and a
 * bespoke structure would have to be converted back at each of them.
 */

/** One hunk, in the shape both `FileEditOutput` and `FileWriteOutput` use. */
export type PatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Already carrying their `+`/`-`/space prefixes, as jsdiff emits them. */
  lines: string[];
};

/**
 * How much diff a single row may carry.
 *
 * Bounded because `items.json` holds every item of every turn and is rewritten
 * whole; an unbounded diff on a generated file would make the projection larger
 * than the repository. Generous enough that an ordinary edit survives intact —
 * the point of the field is review, and a diff truncated at 400 bytes reviews
 * nothing.
 */
export const MAX_DIFF_CHARS = 12_000;

function isHunk(value: unknown): value is PatchHunk {
  if (!value || typeof value !== "object") return false;
  const hunk = value as Partial<PatchHunk>;
  return (
    typeof hunk.oldStart === "number" &&
    typeof hunk.oldLines === "number" &&
    typeof hunk.newStart === "number" &&
    typeof hunk.newLines === "number" &&
    Array.isArray(hunk.lines) &&
    hunk.lines.every((line) => typeof line === "string")
  );
}

/**
 * Pull the hunks out of a provider tool result, or nothing.
 *
 * A CREATED FILE IS SYNTHESISED FROM ITS CONTENT, because the SDK sends no
 * patch for one — measured, by watching a real turn write a file and get an
 * empty `structuredPatch`. Without this arm the most legible change of all
 * ("here is a whole new file") was the one change the transcript could not
 * show, while an ordinary edit rendered fine.
 *
 * Guarded on `originalFile === null` rather than on the patch being empty: an
 * edit that genuinely changed nothing also has no hunks, and inventing an
 * all-additions diff for it would claim the agent rewrote the file.
 */
export function patchHunksOf(value: unknown): PatchHunk[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const output = value as { structuredPatch?: unknown; content?: unknown; originalFile?: unknown };
  const patch = Array.isArray(output.structuredPatch) ? output.structuredPatch.filter(isHunk) : [];
  if (patch.length > 0) return patch;

  if (output.originalFile !== null || typeof output.content !== "string") return undefined;
  const lines = output.content.split("\n");
  // A trailing newline produces a final empty element that is not a line.
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return undefined;
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) }];
}

/**
 * Render hunks as a unified diff.
 *
 * THE HEADER USES `a/` AND `b/` PREFIXES because that is what `git apply` and
 * every diff viewer expect; a header without them is read as a literal relative
 * path and `-p1` strips the wrong component.
 *
 * EXCEPT ON AN ABSOLUTE PATH, where the convention does not apply and the
 * prefix produces `--- a//tmp/x.ts` — a double slash, and a path that is now
 * neither absolute nor repo-relative. Observed on a real turn; git itself omits
 * the prefixes in the same situation.
 *
 * ══ AND IT OPENS WITH `diff --git`, OR THE PREFIXES BECOME THE NAME (#694) ══
 *
 * Without that line a parser does not know it is looking at a GIT diff, so it
 * does not strip `a/` and `b/` — and since `a/x.ts ≠ b/x.ts` it concludes the
 * file was renamed. Measured against `@pierre/diffs` 1.4.3, which is what the
 * Diff surface renders with:
 *
 *   `--- a/x.ts` / `+++ b/x.ts`  alone  →  name="b/x.ts" prevName="a/x.ts"
 *                                          type="rename-changed"
 *   with `diff --git a/x.ts b/x.ts`     →  name="x.ts"   type="change"
 *
 * EVERY patch in the turn scope, in both the single-line and multi-line hunk
 * forms. It is invisible today only because the viewer's file header is off;
 * a file tree or a re-enabled header draws it as `a/x.ts → b/x.ts`.
 *
 * THE ABSOLUTE ARM GETS NO HEADER, and that asymmetry is measured rather than
 * tidy. `diff --git /tmp/x.ts /tmp/x.ts` — the only form that would not
 * reintroduce the double slash — is rejected outright ("invalid git diff
 * header"), while the bare `---`/`+++` pair with no prefixes already parses as
 * `name="/tmp/x.ts" type="change"`. The arm this module treats as the awkward
 * exception is the one that was always right.
 */
export function unifiedDiff(path: string, hunks: readonly PatchHunk[], max = MAX_DIFF_CHARS): string {
  const absolute = path.startsWith("/");
  const [from, to] = absolute ? [path, path] : [`a/${path}`, `b/${path}`];
  const body: string[] = absolute ? [] : [`diff --git ${from} ${to}`];
  body.push(`--- ${from}`, `+++ ${to}`);
  for (const hunk of hunks) {
    // `,1` is omitted by convention when a range covers exactly one line, and
    // some parsers are strict about it.
    const old = hunk.oldLines === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLines}`;
    const now = hunk.newLines === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLines}`;
    body.push(`@@ -${old} +${now} @@`);
    body.push(...hunk.lines);
  }
  const text = body.join("\n");
  if (text.length <= max) return text;
  // Truncation is ANNOUNCED IN THE DIFF ITSELF rather than left to a flag
  // nobody renders. A silently clipped patch looks like a complete one and
  // would be applied as such.
  return `${text.slice(0, max)}\n… diff truncated at ${max} characters …`;
}

/**
 * Added and removed line counts.
 *
 * COUNTED FROM THE HUNKS, not read from the SDK's `gitDiff.additions`. That
 * field is present only when the file is inside a git repo the SDK could
 * inspect, so trusting it would make the counts vanish for edits outside one —
 * and a missing count reads as "changed nothing".
 *
 * A line beginning `\` is git's "\ No newline at end of file" marker. It is
 * neither an addition nor a removal, and counting it inflates every diff that
 * touches the last line of a file.
 */
export function countDiffLines(hunks: readonly PatchHunk[]): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) linesAdded += 1;
      else if (line.startsWith("-")) linesRemoved += 1;
    }
  }
  return { linesAdded, linesRemoved };
}
