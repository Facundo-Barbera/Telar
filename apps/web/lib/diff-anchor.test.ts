/**
 * WHEN A TURN CAN BE ASKED OF GIT, AND WHEN IT STILL CANNOT — issue #741.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `diffBaseFor` REFUSED THE TURN SCOPE BY CONSTRUCTION until now, with a
 * comment saying it "IS NOT HERE AND CANNOT BE" — a turn had no commit to diff
 * against. #741 stamps the shas the ENGINE observed, so some turns can be. The
 * point of this file is the OTHER half: which ones still cannot, and that the
 * refusal is a distinguishable `undefined` rather than a plausible git request.
 *
 * A PURE FOLD, so none of it needs a repository, a transcript or a mounted
 * surface — the same property `diff-turns.ts` is built for.
 * ────────────────────────────────────────────────────────────────────────────
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Item, Turn } from "@telar/engine-client";
import { diffBaseFor } from "./diff-scope";
import { diffTurns } from "./diff-turns";

const tab = { kind: "turn" } as const;

describe("a turn's anchor decides which witness answers (#741)", () => {
  test("an anchored turn is a RANGE, with both sides", () => {
    // The whole of #741 in one assertion: the scope that could not be expressed
    // as a git request now is one, and it carries a right-hand side.
    expect(diffBaseFor(tab, { before: "aaa", after: "bbb" })).toEqual({ base: "aaa", to: "bbb" });
  });

  test("a turn with no anchor is refused, and refused DISTINGUISHABLY", () => {
    /**
     * `undefined`, NOT `{}`. An empty option object is a legitimate git request
     * meaning "the session's own recorded base" — so answering an unanchored
     * turn with one would compare the whole session under a heading naming one
     * turn, and look entirely plausible doing it. The caller tells the two
     * apart by identity, which is why this asserts the value and not falsiness.
     */
    expect(diffBaseFor(tab, undefined)).toBeUndefined();
    expect(diffBaseFor(tab, {})).toBeUndefined();
  });

  test("half an anchor is not an anchor", () => {
    // `before` alone would read "from where this turn started to wherever the
    // disk is now", which includes every later turn's work.
    expect(diffBaseFor(tab, { before: "aaa" })).toBeUndefined();
    expect(diffBaseFor(tab, { after: "bbb" })).toBeUndefined();
  });

  test("a probe that never answered keeps the journal, rather than inventing a range", () => {
    expect(diffBaseFor(tab, { read: "timeout" })).toBeUndefined();
    expect(diffBaseFor(tab, { read: "failed" })).toBeUndefined();
  });

  test("a turn that committed nothing is still a range, and an EQUAL one", () => {
    // The ordinary case. `before === after` says the turn committed nothing,
    // which is a true and useful thing for git to be asked about — the disk is
    // then where the journal's patch has to be read against.
    expect(diffBaseFor(tab, { before: "aaa", after: "aaa" })).toEqual({ base: "aaa", to: "aaa" });
  });

  test("the other two scopes are untouched by any of this", () => {
    // Anti-regression, and the reason this is not a change to `unstaged`'s
    // three-state base: an anchor must not leak into a scope that never had one.
    expect(diffBaseFor({ kind: "unstaged" }, { before: "aaa", after: "bbb" })).toEqual({ base: null });
    expect(diffBaseFor({ kind: "branch" }, { before: "aaa", after: "bbb" })).toEqual({});
    expect(diffBaseFor({ kind: "branch", base: "origin/main" }, { before: "aaa", after: "bbb" })).toEqual({ base: "origin/main" });
  });
});

describe("the fold carries each turn's own anchor (#741)", () => {
  const item = (over: Partial<Item> & { runId: string; detail: Item["detail"] }): Item =>
    ({ id: `i${Math.random()}`, sessionId: "s", status: "completed", startedAt: 1_000, ...over }) as Item;
  const wrote = (runId: string, path: string, at = 1_000): Item =>
    item({ runId, startedAt: at, detail: { type: "file_change", change: { path, kind: "edit" } } as Item["detail"] });
  const turn = (runId: string, anchor?: Turn["anchor"]): Turn =>
    ({ runId, sessionId: "s", sequence: 1, state: "completed", input: "go", origin: "user", createdAt: 1, updatedAt: 1, ...(anchor ? { anchor } : {}) }) as unknown as Turn;

  test("PER TURN, not per scope — two turns in one picker can take different routes", () => {
    /**
     * THE REASON THE ANCHOR RIDES THE TURN. A session that has been running
     * since before #741 has unanchored turns above anchored ones in the same
     * picker; a scope-level flag would have to be true for both or neither, and
     * either answer is wrong for half the list.
     */
    const folded = diffTurns(
      [wrote("run_old", "a.ts", 1_000), wrote("run_new", "b.ts", 5_000)],
      [turn("run_old"), turn("run_new", { before: "aaa", after: "bbb" })],
    );
    const byRun = new Map(folded.map((entry) => [entry.runId, entry]));
    expect(diffBaseFor(tab, byRun.get("run_new")!.anchor)).toEqual({ base: "aaa", to: "bbb" });
    expect(diffBaseFor(tab, byRun.get("run_old")!.anchor)).toBeUndefined();
  });

  test("a turn whose record never arrived is unanchored, not anchored to nothing", () => {
    // `diffTurns` folds items whether or not the turn record came with them.
    const [folded] = diffTurns([wrote("run_a", "a.ts")]);
    expect(folded!.anchor).toBeUndefined();
    expect(diffBaseFor(tab, folded!.anchor)).toBeUndefined();
  });
});
