/**
 * THE OPEN SET BEHIND THE ISSUES AND PULL-REQUEST SUB-STRIPS — issue #693.
 *
 * What is worth testing here is not that a chip appears; it is the two
 * properties the move was allowed to land on. FIRST, that nothing is lost:
 * a layout saved before this change, with `issue:675` as a top-level tab, comes
 * back as Issues showing #675 — because a migration that silently closed the
 * issues somebody left open would be the exact harm moving them inside the list
 * was meant to prevent. SECOND, that the state is a value: the sub-strip lives
 * in a tab instance's `params`, which is what persists it and what keeps two
 * windows on one session independent, so it has to survive a round trip through
 * flat strings intact and refuse anything that comes back malformed.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  activateForge,
  closeForge,
  emptyForge,
  forgeFromLegacyTabs,
  forgeNumbersAfter,
  forgeParams,
  openForge,
  otherForgeNumbers,
  readForgeOpen,
  showForgeList,
} from "./forge-workspace";

describe("opening and closing details", () => {
  test("an open is deliberate: it appends and shows, and never mints a second chip", () => {
    // No preview slot, unlike the Editor's strip — see `openForge`. Clicking a
    // row you already have open focuses that chip rather than adding one.
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
    // Nothing left is the LIST, which is always something to draw — this surface
    // can never be empty the way an Editor with no file open can.
    expect(closeForge({ numbers: [7], at: 7 }, 7)).toEqual({ numbers: [] });
  });

  test("the list is a state, not the absence of one", () => {
    const open = { numbers: [4, 5], at: 5 };
    expect(showForgeList(open)).toEqual({ numbers: [4, 5] });
    // And every chip stays open, so going back costs nothing.
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
    // So a tab that was never opened into persists exactly as plainly as it did
    // before this existed — see the note on flat strings in the module.
    expect(forgeParams(emptyForge())).toEqual({});
    expect(readForgeOpen({})).toEqual({ numbers: [] });
  });

  test("what comes back out of storage is validated, not trusted", () => {
    // Everything here is reachable: a previous build, a hand edit, a half-written
    // value. A number the surface cannot ask gh about must not survive as one it
    // will try — the same strictness `issue:12abc` got as a tab id.
    expect(readForgeOpen({ open: "675,12abc,0,-4,1.5, 666 ,675" })).toEqual({ numbers: [675, 666] });
    // An `at` naming a number that is not open falls back to the LIST rather
    // than to a detail that would spin forever.
    expect(readForgeOpen({ open: "675", at: "999" })).toEqual({ numbers: [675] });
    expect(forgeParams({ numbers: [675], at: 999 })).toEqual({ open: "675" });
  });
});

describe("what a panel saved by the previous build meant", () => {
  test("the issues somebody left open survive the upgrade", () => {
    // `migratePanelTab` folds `issue:675` into `issues`; without this the fold
    // would close every issue anybody had open.
    const stored = ["diff", "issues", "issue:675", "pulls", "pull:666", "issue:9", "file:a.ts"];
    expect(forgeFromLegacyTabs(stored, "issue:675")).toEqual({
      issues: { numbers: [675, 9], at: 675 },
      pulls: { numbers: [666] },
    });
  });

  test("only the surface you were READING restores onto a detail", () => {
    // Pull requests was in the background, so it comes back on its list with the
    // chip a click away. Nothing says you were reading it.
    const read = forgeFromLegacyTabs(["issue:1", "pull:2"], "issue:1");
    expect(read.issues).toEqual({ numbers: [1], at: 1 });
    expect(read.pulls).toEqual({ numbers: [2] });
  });

  test("a layout with no detail tabs seeds nothing", () => {
    expect(forgeFromLegacyTabs(["diff", "issues", "editor"], "issues")).toEqual({});
    // And a malformed id is not a number to restore.
    expect(forgeFromLegacyTabs(["issue:12abc", "pull:"], undefined)).toEqual({});
  });
});
