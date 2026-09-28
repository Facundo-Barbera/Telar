// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { DEFAULT_DIFF_TAB, diffBaseFor, diffTabParams, readDiffTab, scopesFor, type DiffTab } from "./diff-scope";

describe("the diff tab's scope", () => {
  test("a tab with no params is the working tree", () => {
    expect(readDiffTab({})).toEqual({ kind: "unstaged" });
    expect(DEFAULT_DIFF_TAB).toEqual(readDiffTab({}));
  });

  test("a tab persisted before the selector existed comes back on the default", () => {
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
    const remembered: DiffTab = { kind: "unstaged", base: "origin/main", turn: "run_7" };
    expect(diffTabParams(remembered)).toEqual({ base: "origin/main", turn: "run_7" });
    expect(readDiffTab(diffTabParams(remembered))).toEqual(remembered);
  });

  test("an unrecognised scope is the default, not a surface that renders nothing", () => {
    // Read back from localStorage, so anything may arrive.
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
    // No base means the session's recorded base, a different question.
    expect(diffBaseFor({ kind: "unstaged" })).toEqual({ base: null });
    expect(diffBaseFor({ kind: "unstaged", base: "origin/main" })).toEqual({ base: null });
  });

  test("a branch with no chosen ref sends NO base, which is the session's own", () => {
    expect(diffBaseFor({ kind: "branch" })).toEqual({});
    expect(diffBaseFor({ kind: "branch", base: "   " })).toEqual({});
  });

  test("a branch with a ref sends it", () => {
    expect(diffBaseFor({ kind: "branch", base: "origin/main" })).toEqual({ base: "origin/main" });
  });

  test("an UNANCHORED turn sends nothing at all — not an empty option (#741)", () => {
    // `{}` would be a real request for the session's own base.
    expect(diffBaseFor({ kind: "turn", turn: "run_1" })).toBeUndefined();
    expect(diffBaseFor({ kind: "branch" })).toEqual({});
  });
});

describe("which scopes are offered", () => {
  test("a canvas is not offered the turn scope", () => {
    expect(scopesFor(false)).toEqual(["unstaged", "branch"]);
    expect(scopesFor(true)).toEqual(["unstaged", "branch", "turn"]);
  });
});
