// Issue #45 — the Workflows section splits, and the split has to STAY split.
//
// STATIC TEXT SCANS, for the reason `subagent-rail.test.ts` and
// `ultra-runs.test.ts` both give: there is no component harness in this repo
// (story 3.1's hard rule 9) and layout is proved on the dev server. What a scan
// CAN see is the half that goes quietly false — that the rail still delegates
// the grouping to the tested projection instead of re-deriving it, that both
// treatments still open the run, and that the header's number still means the
// same thing it means on the collapsed edge one component up.
//
// The BEHAVIOUR of the split is in `ultra-runs.test.ts`'s `splitRunsForRail`
// block, where it is a pure function over real state vocabularies. Nothing here
// re-asserts it.

// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath(import.meta.url)` and not `import.meta.dir`: the latter is a
// Bun extension the web tsconfig cannot type.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const rail = () => fs.readFileSync(path.join(REPO_ROOT, "apps/web/components/session/ultra-rail.tsx"), "utf8");

/** Comments stripped before matching, the same carve-out `ultra-runs.test.ts`
 *  applies to its own scans: this file's header PROSE describes the flat list it
 *  replaced, and a guard that its own explanation satisfies measures nothing. */
const code = () => rail().replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("the scans measure stripped source", () => {
  test("the comment stripper strips, and strips COMMENTS", () => {
    // Three of the scans below are negative. A stripper that silently stopped
    // matching — or one that ate the file — would satisfy every one of them
    // forever, so the instrument is pinned before it is used (the discipline
    // `ultra-runs.test.ts` applies to its own copy of this regex).
    expect(code().length).toBeLessThan(rail().length);
    expect(rail()).toContain("GLANCEABLE INDEX"); // header prose, a comment
    expect(code()).not.toContain("GLANCEABLE INDEX");
    expect(code()).toContain("export function UltraRail"); // …and code survives
  });
});

describe("the rail groups its runs, and does not decide the grouping itself", () => {
  test("the flat list is gone — cards come from the pinned group alone", () => {
    // The bug, exactly: `runs.map(...)` drew EVERY run as a full `RunCard`,
    // live or settled, in one list.
    const src = code();
    expect(src).not.toContain("{runs.map(");
    expect(src).toContain("{pinned.map(");
  });

  test("the two groups come from the PROJECTION, not from a local state filter", () => {
    // The doctrine `ultra-runs.ts` opens with and this file's header repeats:
    // a decision inside a component is a decision that ships unproven. A local
    // `state === "done"` here would be a second, untested copy of the cut.
    const src = code();
    expect(src).toContain("splitRunsForRail(runs)");
    expect(src).not.toContain('state === "done"');
    // …and no second ordering rule beside it (the issue's own instruction).
    expect(src).not.toContain(".sort(");
  });

  test("COLLAPSING IS NOT HIDING — the compact row opens its run exactly as the card does", () => {
    // Two handlers, one gesture: a settled run is still one click to the pane
    // that shows what it did. Counted rather than merely present, so deleting
    // the row's handler and leaving the card's cannot pass.
    expect(code().split("onClick={onOpen}").length - 1).toBe(2);
  });

  test("the settled group is capped, and the cap cuts from the END", () => {
    const src = code();
    expect(src).toContain("DONE_ROW_CAP");
    // `slice(0, …)` and not a filter: whatever `splitRunsForRail` put first is
    // what survives the cut — the rule `workspace-inspector.tsx`'s `CappedRows`
    // states and this re-implementation keeps.
    expect(src).toContain("settled.slice(0, DONE_ROW_CAP)");
    // …and the hidden ones are reachable rather than gone.
    expect(src).toContain("setExpanded");
  });

  test("the scroll box is still bounded — the group renders INSIDE it", () => {
    // A `Done · N` list that escaped `max-h-80` would push the sub-agent section
    // off the bottom of the panel instead of scrolling.
    expect(code()).toContain("max-h-80");
  });
});

describe("the header's number after the split", () => {
  test("it is the TOTAL, and only the group heading counts a subset", () => {
    // THE THREE READERS of one figure (see `subagent-rail.tsx`'s `workflowCount`
    // guard): this header, the collapsed edge's dot, and the "nothing yet" empty
    // state. None can derive another, so all three still mean ALL RUNS —
    // `subagent-rail.test.ts` pins the other two. What is new is a SECOND,
    // differently-labelled number below it, and this is what keeps them apart.
    //
    // COUNTED, not merely present. `toContain("{runs.length}")` — which is also
    // what `subagent-rail.test.ts` scans for — passes on ANY occurrence, so
    // while the settled group's own heading also read `{runs.length}` both
    // guards were satisfied by the subset and the header could drift to
    // `{pinned.length}` untouched (verified: the whole suite stayed green).
    // `DoneGroup`'s prop is `settled` for this reason; one occurrence is the
    // invariant.
    const src = code();
    expect(src.split("{runs.length}").length - 1).toBe(1);
    // …and it is the header's right-hand cell that holds it, not some other
    // print of the total that happens to sit in the file.
    expect(src).toMatch(/ml-auto[^"]*">\{runs\.length\}<\/span>/);
    expect(src).toContain("Done · {settled.length}"); // the group, over its own list
  });

  test("the live pill still counts running runs and nothing else", () => {
    // `failed` and `stopped` are pinned beside the live cards now. That is a
    // grouping, not a promotion to "live": folding them into this pill would
    // make the rail claim work is in flight when none is.
    expect(code()).toContain('runs.filter((r) => r.state === "running").length');
  });
});
