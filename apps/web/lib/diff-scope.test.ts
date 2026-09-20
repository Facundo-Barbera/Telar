/**
 * WHAT A DIFF TAB IS LOOKING AT — issue #694, and the fix for #690 at the root.
 *
 * A PURE ROUND TRIP, so all of it is testable without a repository, a panel or
 * a window. The cases that matter are the ones where a wrong answer looks
 * entirely plausible: a default that silently becomes a different question, and
 * a partial write that erases the half of the tab nobody was editing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { DEFAULT_DIFF_TAB, diffBaseFor, diffTabParams, readDiffTab, scopesFor, type DiffTab } from "./diff-scope";

describe("the diff tab's scope", () => {
  test("a tab with no params is the working tree", () => {
    // THE WHOLE OF #690'S FIX IS IN THIS DEFAULT. The surface used to answer
    // `base…worktree` and call it "everything this session changed", which is
    // false in a checkout shared with an editor and three other sessions. The
    // working tree claims nothing about who wrote it, so there is nothing left
    // to be wrong about.
    expect(readDiffTab({})).toEqual({ kind: "unstaged" });
    expect(DEFAULT_DIFF_TAB).toEqual(readDiffTab({}));
  });

  test("a tab persisted before the selector existed comes back on the default", () => {
    // Deliberate, and worth pinning: an old tab carries only `filter`, and it
    // changes which question it asks. Same checkout, different claim over it.
    expect(readDiffTab({ filter: "apps/web" })).toEqual({ kind: "unstaged", filter: "apps/web" });
  });

  test("the default writes NO key, so an untouched tab persists as it always did", () => {
    expect(diffTabParams({ kind: "unstaged" })).toEqual({});
    expect(diffTabParams({ kind: "unstaged", filter: "apps/web" })).toEqual({ filter: "apps/web" });
  });

  test("scope, base, turn and filter all survive a round trip", () => {
    const tab: DiffTab = { kind: "branch", base: "origin/main", turn: "run_1", filter: "apps/engine" };
    expect(readDiffTab(diffTabParams(tab))).toEqual(tab);
  });

  test("the base and the turn are remembered while another scope is showing", () => {
    // The small thing that makes the selector usable: pick a base, glance at
    // the working tree, come back, and the base is still the one you chose.
    // Remembering them only while their own scope is active would make every
    // flip a re-choice.
    const remembered: DiffTab = { kind: "unstaged", base: "origin/main", turn: "run_7" };
    expect(diffTabParams(remembered)).toEqual({ base: "origin/main", turn: "run_7" });
    expect(readDiffTab(diffTabParams(remembered))).toEqual(remembered);
  });

  test("an unrecognised scope is the default, not a surface that renders nothing", () => {
    // This comes back out of localStorage, where a previous build or a hand
    // edit can leave anything — the rule `readForgeOpen` states.
    for (const scope of ["", "staged", "STAGED", "turns", "1"]) {
      expect(readDiffTab({ scope }).kind, `${JSON.stringify(scope)} falls back`).toBe("unstaged");
    }
  });

  test("blank keys are absent keys, both ways", () => {
    expect(readDiffTab({ scope: "branch", base: "   ", turn: "", filter: "  " })).toEqual({ kind: "branch" });
    expect(diffTabParams({ kind: "branch", base: "  ", turn: "  ", filter: "   " })).toEqual({ scope: "branch" });
  });
});

describe("what the scope asks the engine for", () => {
  test("the working tree sends an EMPTY base, never no base", () => {
    /**
     * THE DISTINCTION THE WHOLE SELECTOR RESTS ON. No base means "use the one
     * you have on file" — the session's own starting point — so a working-tree
     * scope that sent nothing would get a confident, plausible answer to a
     * different question, which is exactly the bug #690 was about.
     */
    expect(diffBaseFor({ kind: "unstaged" })).toEqual({ base: null });
    // ...even while a base is remembered from the branch scope.
    expect(diffBaseFor({ kind: "unstaged", base: "origin/main" })).toEqual({ base: null });
  });

  test("a branch with no chosen ref sends NO base, which is the session's own", () => {
    // The comparison this surface made before the selector existed, now asked
    // for deliberately rather than by default.
    expect(diffBaseFor({ kind: "branch" })).toEqual({});
    expect(diffBaseFor({ kind: "branch", base: "   " })).toEqual({});
  });

  test("a branch with a ref sends it", () => {
    expect(diffBaseFor({ kind: "branch", base: "origin/main" })).toEqual({ base: "origin/main" });
  });

  test("an UNANCHORED turn sends nothing at all — not an empty option (#741)", () => {
    /**
     * THIS TEST CHANGED ITS ANSWER FROM `{}` TO `undefined`, and the reason is
     * the whole of #741's seam.
     *
     * It used to read: a turn has no commit to diff against, so the surface
     * routes this scope to the journal and "this value is never used". That
     * second clause stopped being true. An ANCHORED turn is now a real git
     * range, so the caller reads this return to decide WHICH WITNESS ANSWERS —
     * and `{}` is not a neutral placeholder, it is a legitimate git request
     * meaning "the session's own recorded base". Returning it for a turn git
     * cannot answer would put a whole-session file list under a heading naming
     * one turn, and look entirely plausible doing it.
     *
     * So the refusal is `undefined`, which is not a request at all and cannot
     * be mistaken for one. Every caller spreads `base ?? {}` or reads `base?.x`
     * — there is no site that treats the return as an object without checking.
     */
    expect(diffBaseFor({ kind: "turn", turn: "run_1" })).toBeUndefined();
    // ...and it is distinguishable from the branch scope's `{}`, which IS a
    // request and means something else entirely.
    expect(diffBaseFor({ kind: "branch" })).toEqual({});
  });
});

describe("which scopes are offered", () => {
  test("a canvas is not offered the turn scope", () => {
    // No session means no turns and no recorded base: the picker hides what it
    // cannot answer rather than showing a control that reports nothing.
    expect(scopesFor(false)).toEqual(["unstaged", "branch"]);
    expect(scopesFor(true)).toEqual(["unstaged", "branch", "turn"]);
  });
});
