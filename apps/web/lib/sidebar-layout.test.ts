/**
 * WHEN A POLLED ARRANGEMENT IS NEWS.
 *
 * The rail's live read now carries the whole `SidebarLayout` (#306), which is
 * how a drag on the phone reaches a browser tab. It arrives several times a
 * minute whether or not anything moved, so the rail has to be able to say "same
 * document" — otherwise every pass would re-render every group and every row
 * for news it did not carry.
 *
 * The comparison is the only part of that path a test without a DOM can reach;
 * `observeSidebarLayout` dispatches a window event and the hook folds it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { SidebarLayout } from "@telar/engine-client";
import { sameSidebarLayout } from "./sidebar-layout";

const layout = (patch: Partial<SidebarLayout> = {}): SidebarLayout => ({
  projectOrder: [],
  sessionOrder: {},
  pinnedOrder: [],
  ...patch,
});

describe("sameSidebarLayout", () => {
  test("two blank arrangements are the same document", () => {
    expect(sameSidebarLayout(layout(), layout())).toBe(true);
  });

  test("equal contents in fresh objects are still the same document", () => {
    const left = layout({ projectOrder: ["a", "b"], sessionOrder: { a: ["s1", "s2"] }, pinnedOrder: ["s9"] });
    const right = layout({ projectOrder: ["a", "b"], sessionOrder: { a: ["s1", "s2"] }, pinnedOrder: ["s9"] });
    expect(sameSidebarLayout(left, right)).toBe(true);
  });

  test("ORDER is the whole point, so a reversal is a different document", () => {
    expect(sameSidebarLayout(layout({ projectOrder: ["a", "b"] }), layout({ projectOrder: ["b", "a"] }))).toBe(false);
    expect(sameSidebarLayout(layout({ pinnedOrder: ["s1", "s2"] }), layout({ pinnedOrder: ["s2", "s1"] }))).toBe(false);
    expect(sameSidebarLayout(layout({ sessionOrder: { a: ["s1", "s2"] } }), layout({ sessionOrder: { a: ["s2", "s1"] } }))).toBe(false);
  });

  test("a group arranged on one side only is a change — from either direction", () => {
    const arranged = layout({ sessionOrder: { a: ["s1"] } });
    expect(sameSidebarLayout(arranged, layout())).toBe(false);
    expect(sameSidebarLayout(layout(), arranged)).toBe(false);
    // A SECOND GROUP IS NEWS TOO, and comparing only the left side's keys would
    // miss it — which is the drag the phone would make while this tab watched.
    expect(sameSidebarLayout(arranged, layout({ sessionOrder: { a: ["s1"], b: ["s2"] } }))).toBe(false);
  });

  test("a document written before the row arrangements existed reads as blank, not as different", () => {
    // `sessionOrder` and `pinnedOrder` default on the wire, but an engine older
    // than them sends neither — and "nobody has arranged any rows" must not
    // look like a change on every poll.
    const old = { projectOrder: ["a"] } as SidebarLayout;
    expect(sameSidebarLayout(old, layout({ projectOrder: ["a"] }))).toBe(true);
  });
});
