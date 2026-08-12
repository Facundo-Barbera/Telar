/**
 * Starred models.
 *
 * The ordering is the part worth pinning: a menu whose rows move when you are
 * not looking is a menu you have to read every time.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { orderByFavorite, readFavorites, toggleFavorite, writeFavorites } from "./model-favorites";

function storage(initial?: string) {
  const slots = new Map<string, string>();
  if (initial !== undefined) slots.set("telar:favorite-models:v1", initial);
  return {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => void slots.set(key, value),
    read: () => slots.get("telar:favorite-models:v1"),
  };
}

describe("reading", () => {
  test("nothing stored is no favourites, not a failure", () => {
    expect(readFavorites(storage())).toEqual(new Set());
  });

  test("a shape another build wrote costs the sorting, never the menu", () => {
    // The menu has to open. A bad preference is not a reason to lose it.
    expect(readFavorites(storage("not json"))).toEqual(new Set());
    expect(readFavorites(storage('{"claude":true}'))).toEqual(new Set());
    expect(readFavorites(storage('["claude-opus-5", 7, null]'))).toEqual(new Set(["claude-opus-5"]));
  });

  test("round-trips", () => {
    const store = storage();
    writeFavorites(new Set(["a", "b"]), store);
    expect(readFavorites(store)).toEqual(new Set(["a", "b"]));
  });
});

describe("toggleFavorite", () => {
  test("adds, removes, and never mutates what it was given", () => {
    const before = new Set(["a"]);
    expect(toggleFavorite(before, "b")).toEqual(new Set(["a", "b"]));
    expect(toggleFavorite(before, "a")).toEqual(new Set());
    expect(before).toEqual(new Set(["a"]));
  });
});

describe("orderByFavorite", () => {
  test("favourites lead, and both halves keep catalogue order", () => {
    // NOT sorted by name and NOT by recency: the catalogue's own order already
    // puts the models people reach for at the top, and rows that reshuffle
    // themselves are rows you have to re-read.
    const options = [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }, { id: "fable" }];
    expect(orderByFavorite(options, new Set(["haiku", "fable"]))).toEqual([
      { id: "haiku" },
      { id: "fable" },
      { id: "opus" },
      { id: "sonnet" },
    ]);
    expect(orderByFavorite(options, new Set())).toEqual(options);
  });
});
