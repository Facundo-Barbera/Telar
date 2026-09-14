/**
 * THE CHIP ROW — its order, its cap, and the duplicates it refuses to draw
 * twice (#471).
 *
 * The ordering is the whole value of the row: chips in a stable place can be
 * hit without reading, and a most-recent-first tail is the only arrangement in
 * which the eighth entry is worth keeping. Both are invisible to a test of any
 * single colour, so they are pinned here.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import {
  colourChips,
  forgetRecentColours,
  recentColoursSnapshot,
  RECENT_COLOUR_LIMIT,
  rememberColour,
  rememberStopColour,
  subscribeRecentColours,
} from "./recent-colours";

describe("rememberColour", () => {
  test("the newest is first", () => {
    expect(rememberColour(["#111111"], "#222222")).toEqual(["#222222", "#111111"]);
  });

  test("a colour used again moves back to the front rather than doubling", () => {
    expect(rememberColour(["#111111", "#222222", "#333333"], "#333333")).toEqual(["#333333", "#111111", "#222222"]);
  });

  test("it normalises, so the same colour typed two ways is one entry", () => {
    expect(rememberColour(["#aabbcc"], "#ABC")).toEqual(["#aabbcc"]);
    expect(rememberColour([], "oklch(100% 0 0)")).toEqual(["#ffffff"]);
  });

  test("the cap holds, and it is the oldest that goes", () => {
    let list: string[] = [];
    for (let index = 0; index < RECENT_COLOUR_LIMIT + 4; index += 1) {
      list = rememberColour(list, `#${index.toString(16).repeat(6)}`);
    }
    expect(list).toHaveLength(RECENT_COLOUR_LIMIT);
    // Eleven down to four: the four earliest fell off the end.
    expect(list[0]).toBe("#bbbbbb");
    expect(list[RECENT_COLOUR_LIMIT - 1]).toBe("#444444");
  });

  test("something that is not a colour is not remembered", () => {
    expect(rememberColour(["#111111"], "bananas")).toEqual(["#111111"]);
    expect(rememberColour([], "")).toEqual([]);
  });
});

describe("colourChips", () => {
  const bases = { light: "#f5f5f5", dark: "#101014", accent: "oklch(0.488 0.16 264)" };

  test("both bases and the accent come first, in that order, always", () => {
    const chips = colourChips({ ...bases, recent: ["#ff0000"] });
    expect(chips.map((chip) => chip.label)).toEqual(["Light base", "Dark base", "Accent", "#ff0000"]);
  });

  test("the named ones are normalised to what a swatch can show", () => {
    const [, , accent] = colourChips({ ...bases, recent: [] });
    expect(accent!.color).toBe("#2f58b9");
  });

  test("a recent that is already a named chip is not drawn twice", () => {
    const chips = colourChips({ ...bases, recent: ["#F5F5F5", "#ff0000"] });
    expect(chips.map((chip) => chip.color)).toEqual(["#f5f5f5", "#101014", "#2f58b9", "#ff0000"]);
  });

  test("recents keep their own order under the named ones", () => {
    const chips = colourChips({ ...bases, recent: ["#ff0000", "#00ff00", "#0000ff"] });
    expect(chips.slice(3).map((chip) => chip.color)).toEqual(["#ff0000", "#00ff00", "#0000ff"]);
  });

  test("an unparseable base is left out rather than drawn as grey", () => {
    const chips = colourChips({ light: "bananas", dark: "#101014", accent: "#2f58b9", recent: [] });
    expect(chips.map((chip) => chip.label)).toEqual(["Dark base", "Accent"]);
  });

  test("two states that share a base are one chip", () => {
    const chips = colourChips({ light: "#101014", dark: "#101014", accent: "#2f58b9", recent: [] });
    expect(chips.map((chip) => chip.label)).toEqual(["Light base", "Accent"]);
  });
});

describe("the session's list", () => {
  beforeEach(() => forgetRecentColours());

  test("it remembers across the components that read it", () => {
    rememberStopColour("#112233");
    rememberStopColour("#445566");
    expect(recentColoursSnapshot()).toEqual(["#445566", "#112233"]);
  });

  /** The snapshot's identity is what `useSyncExternalStore` compares, so a
   *  write that changes nothing must not produce a new array. */
  test("a write that changes nothing does not notify", () => {
    rememberStopColour("#112233");
    const before = recentColoursSnapshot();
    let told = 0;
    const stop = subscribeRecentColours(() => (told += 1));
    rememberStopColour("#112233");
    rememberStopColour("not a colour");
    expect(told).toBe(0);
    expect(recentColoursSnapshot()).toBe(before);
    rememberStopColour("#445566");
    expect(told).toBe(1);
    stop();
  });
});
