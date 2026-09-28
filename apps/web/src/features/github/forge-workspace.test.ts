import { describe, expect, test } from "bun:test";
import {
  activateForge,
  closeForge,
  emptyForge,
  forgeNumbersAfter,
  forgeParams,
  openForge,
  otherForgeNumbers,
  readForgeOpen,
  showForgeList,
} from "./forge-workspace";

describe("opening and closing details", () => {
  test("an open is deliberate: it appends and shows, and never mints a second chip", () => {
    // No preview slot, unlike the Editor's strip; see `openForge`.
    let open = openForge(openForge(emptyForge(), 675), 666);
    expect(open).toEqual({ numbers: [675, 666], at: 666 });
    open = openForge(open, 675);
    expect(open).toEqual({ numbers: [675, 666], at: 675 });
  });

  test("closing takes the NEIGHBOUR to the right, and the last close shows the list", () => {
    const open = { numbers: [1, 2, 3], at: 2 };
    expect(closeForge(open, 2)).toEqual({ numbers: [1, 3], at: 3 });
    // Rightmost falls back to the new last one rather than jumping to the first.
    expect(closeForge({ numbers: [1, 2, 3], at: 3 }, 3)).toEqual({ numbers: [1, 2], at: 2 });
    // Closing a chip you are NOT reading must not move what you are reading.
    expect(closeForge(open, 3)).toEqual({ numbers: [1, 2], at: 2 });
    expect(closeForge({ numbers: [7], at: 7 }, 7)).toEqual({ numbers: [] });
  });

  test("the list is a state, not the absence of one", () => {
    const open = { numbers: [4, 5], at: 5 };
    expect(showForgeList(open)).toEqual({ numbers: [4, 5] });
    expect(activateForge(showForgeList(open), 4)).toEqual({ numbers: [4, 5], at: 4 });
    // A stale click on a chip that has gone selects nothing.
    expect(activateForge(open, 9)).toEqual(open);
  });

  test("a sweep names numbers in strip order and a stale one names none", () => {
    const open = { numbers: [1, 2, 3], at: 1 };
    expect(otherForgeNumbers(open, 2)).toEqual([1, 3]);
    expect(forgeNumbersAfter(open, 1)).toEqual([2, 3]);
    expect(forgeNumbersAfter(open, 3)).toEqual([]);
    expect(otherForgeNumbers(open, 99)).toEqual([]);
  });
});

describe("the round trip through a tab's params", () => {
  test("what goes in comes back out", () => {
    const open = { numbers: [675, 666], at: 666 };
    expect(forgeParams(open)).toEqual({ open: "675,666", at: "666" });
    expect(readForgeOpen(forgeParams(open))).toEqual(open);
  });

  test("a surface nobody drilled into writes NO keys", () => {
    expect(forgeParams(emptyForge())).toEqual({});
    expect(readForgeOpen({})).toEqual({ numbers: [] });
  });

  test("what comes back out of storage is validated, not trusted", () => {
    // Stored values may come from an old build or a hand edit.
    expect(readForgeOpen({ open: "675,12abc,0,-4,1.5, 666 ,675" })).toEqual({ numbers: [675, 666] });
    // An `at` that is not open falls back to the list.
    expect(readForgeOpen({ open: "675", at: "999" })).toEqual({ numbers: [675] });
    expect(forgeParams({ numbers: [675], at: 999 })).toEqual({ open: "675" });
  });
});
