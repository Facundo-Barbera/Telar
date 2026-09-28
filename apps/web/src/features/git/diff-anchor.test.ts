import { describe, expect, test } from "bun:test";
import type { Item, Turn } from "@telar/engine-client";
import { diffBaseFor } from "./diff-scope";
import { diffTurns } from "./diff-turns";

const tab = { kind: "turn" } as const;

describe("a turn's anchor decides which witness answers (#741)", () => {
  test("an anchored turn is a RANGE, with both sides", () => {
    expect(diffBaseFor(tab, { before: "aaa", after: "bbb" })).toEqual({ base: "aaa", to: "bbb" });
  });

  test("a turn with no anchor is refused, and refused DISTINGUISHABLY", () => {
    // `{}` is a real request for the session's own base, so the refusal must be `undefined`.
    expect(diffBaseFor(tab, undefined)).toBeUndefined();
    expect(diffBaseFor(tab, {})).toBeUndefined();
  });

  test("half an anchor is not an anchor", () => {
    // `before` alone would include every later turn's work.
    expect(diffBaseFor(tab, { before: "aaa" })).toBeUndefined();
    expect(diffBaseFor(tab, { after: "bbb" })).toBeUndefined();
  });

  test("a probe that never answered keeps the journal, rather than inventing a range", () => {
    expect(diffBaseFor(tab, { read: "timeout" })).toBeUndefined();
    expect(diffBaseFor(tab, { read: "failed" })).toBeUndefined();
  });

  test("a turn that committed nothing is still a range, and an EQUAL one", () => {
    expect(diffBaseFor(tab, { before: "aaa", after: "aaa" })).toEqual({ base: "aaa", to: "aaa" });
  });

  test("the other two scopes are untouched by any of this", () => {
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
    // Older turns are unanchored, so the anchor rides each turn rather than the scope.
    const folded = diffTurns(
      [wrote("run_old", "a.ts", 1_000), wrote("run_new", "b.ts", 5_000)],
      [turn("run_old"), turn("run_new", { before: "aaa", after: "bbb" })],
    );
    const byRun = new Map(folded.map((entry) => [entry.runId, entry]));
    expect(diffBaseFor(tab, byRun.get("run_new")!.anchor)).toEqual({ base: "aaa", to: "bbb" });
    expect(diffBaseFor(tab, byRun.get("run_old")!.anchor)).toBeUndefined();
  });

  test("a turn whose record never arrived is unanchored, not anchored to nothing", () => {
    const [folded] = diffTurns([wrote("run_a", "a.ts")]);
    expect(folded!.anchor).toBeUndefined();
    expect(diffBaseFor(tab, folded!.anchor)).toBeUndefined();
  });
});
