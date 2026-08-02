// The proof that a dragged sidebar lands where its bounds say it should.
//
// Three of these are the bugs this module exists to make impossible rather than
// hypotheticals: the degenerate window where the maximum drops BELOW the
// minimum (a clamp written the other way round returns a sidebar of negative
// width), a refused width that must leave the previous one standing (the
// difference between "you cannot go further" and "the drag broke"), and a
// stored value that is no longer a number, which must read as absent so the
// sidebar falls back to its default instead of writing NaNpx into a style
// attribute. The referential-identity test at the end guards a subtler one:
// useSyncExternalStore compares snapshots by reference, so a fresh empty record
// per call would loop forever.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  clampSidebarWidth,
  APP_SIDEBAR_MAIN_MIN_WIDTH,
  APP_SIDEBAR_STORAGE_KEY,
  flushPendingSidebarWidth,
  keepsRoomForMain,
  NO_SIDEBAR_PREFS,
  parseSidebarPrefs,
  resolveDragWidth,
  sanitizeSidebarPrefs,
  SIDEBAR_RESIZE_MIN_WIDTH,
} from "@/lib/sidebar-width";

const MIN = 200;
const MAX = 600;

describe("clampSidebarWidth", () => {
  test("below the minimum comes back as the minimum", () => {
    expect(clampSidebarWidth(40, MIN, MAX)).toBe(MIN);
    expect(clampSidebarWidth(-40, MIN, MAX)).toBe(MIN);
    expect(clampSidebarWidth(0, MIN, MAX)).toBe(MIN);
  });

  test("above the maximum comes back as the maximum", () => {
    expect(clampSidebarWidth(5000, MIN, MAX)).toBe(MAX);
  });

  test("exactly at either bound is left alone — the bounds are inclusive", () => {
    expect(clampSidebarWidth(MIN, MIN, MAX)).toBe(MIN);
    expect(clampSidebarWidth(MAX, MIN, MAX)).toBe(MAX);
  });

  test("a width inside the range passes through untouched", () => {
    expect(clampSidebarWidth(321, MIN, MAX)).toBe(321);
  });

  test("an unbounded maximum is a real option, not an accident", () => {
    expect(clampSidebarWidth(5000, MIN, Number.POSITIVE_INFINITY)).toBe(5000);
  });

  test("when the maximum falls below the minimum, the minimum wins", () => {
    // The narrow-window case: the caller reserved more for the main pane than
    // the viewport has left, so max < min. A clamp with Math.min outermost
    // would return 80 here and the sidebar would vanish.
    expect(clampSidebarWidth(400, MIN, 80)).toBe(MIN);
  });

  test("NaN reads as no usable width and lands on the minimum", () => {
    expect(clampSidebarWidth(Number.NaN, MIN, MAX)).toBe(MIN);
  });

  test("the default floor is the 16rem the sidebar has always been", () => {
    expect(SIDEBAR_RESIZE_MIN_WIDTH).toBe(256);
  });
});

describe("resolveDragWidth", () => {
  test("clamps the proposal when there is no predicate", () => {
    expect(resolveDragWidth(300, 5000, MIN, MAX)).toBe(MAX);
    expect(resolveDragWidth(300, 10, MIN, MAX)).toBe(MIN);
    expect(resolveDragWidth(300, 420, MIN, MAX)).toBe(420);
  });

  test("a refused width leaves the current width exactly as it was", () => {
    expect(resolveDragWidth(300, 420, MIN, MAX, () => false)).toBe(300);
  });

  test("a refusal does not stick — the next acceptable frame still lands", () => {
    // The predicate here refuses anything past 400, which is what a main-pane
    // floor does at the moment the drag reaches it. Growing stops; the drag
    // does not.
    const accept = (next: number) => next <= 400;
    let width = 300;
    width = resolveDragWidth(width, 500, MIN, MAX, accept);
    expect(width).toBe(300);
    width = resolveDragWidth(width, 380, MIN, MAX, accept);
    expect(width).toBe(380);
  });

  test("the predicate sees the CLAMPED width, not the raw proposal", () => {
    const seen: number[] = [];
    resolveDragWidth(300, 5000, MIN, MAX, (next) => {
      seen.push(next);
      return true;
    });
    expect(seen).toEqual([MAX]);
  });
});

describe("a release before the next animation frame", () => {
  test("commits the latest pointer proposal, not the previous painted width", () => {
    const paintedWidth = 320;
    const finalPointerWidth = 417;

    expect(flushPendingSidebarWidth(paintedWidth, finalPointerWidth, MIN, MAX)).toBe(417);
  });

  test("the release still obeys bounds and the main-pane floor", () => {
    const accept = (next: number) =>
      keepsRoomForMain(320, next, 1000, APP_SIDEBAR_MAIN_MIN_WIDTH);

    expect(flushPendingSidebarWidth(320, 500, MIN, MAX, accept)).toBe(320);
    expect(flushPendingSidebarWidth(500, 300, MIN, MAX, (next) =>
      keepsRoomForMain(500, next, 900, APP_SIDEBAR_MAIN_MIN_WIDTH)
    )).toBe(300);
  });
});

describe("keepsRoomForMain", () => {
  test("growth stops at the point it would starve the main pane", () => {
    // 1000px of wrapper, main insists on 640: 360 is the widest the sidebar
    // may become.
    expect(keepsRoomForMain(300, 360, 1000, 640)).toBe(true);
    expect(keepsRoomForMain(300, 361, 1000, 640)).toBe(false);
  });

  test("shrinking is allowed even from a width that is already illegal", () => {
    // The window got narrower while the sidebar stayed put. Every width fails
    // the room check now, so without the shrink clause the sidebar would be
    // frozen at a size that no longer fits.
    expect(keepsRoomForMain(800, 700, 1000, 640)).toBe(true);
    expect(keepsRoomForMain(800, 800, 1000, 640)).toBe(true);
    expect(keepsRoomForMain(800, 801, 1000, 640)).toBe(false);
  });
});

describe("the live app sidebar contract", () => {
  test("pins the shared preference key and geometry defaults", () => {
    expect(APP_SIDEBAR_STORAGE_KEY).toBe("app");
    expect(APP_SIDEBAR_MAIN_MIN_WIDTH).toBe(640);
    expect(SIDEBAR_RESIZE_MIN_WIDTH).toBe(256);
  });
});

describe("parseSidebarPrefs", () => {
  test("absent, empty and corrupt all read as nothing remembered", () => {
    expect(parseSidebarPrefs(null)).toEqual(NO_SIDEBAR_PREFS);
    expect(parseSidebarPrefs("")).toEqual(NO_SIDEBAR_PREFS);
    expect(parseSidebarPrefs("not json at all")).toEqual(NO_SIDEBAR_PREFS);
    expect(parseSidebarPrefs("[1,2,3]").width).toBe(null);
    expect(parseSidebarPrefs('"320"')).toEqual(NO_SIDEBAR_PREFS);
  });

  test("a width survives only if it is a finite positive number", () => {
    expect(parseSidebarPrefs('{"width":320}').width).toBe(320);
    expect(parseSidebarPrefs('{"width":"320"}').width).toBe(null);
    expect(parseSidebarPrefs('{"width":0}').width).toBe(null);
    expect(parseSidebarPrefs('{"width":-40}').width).toBe(null);
    // JSON has no Infinity; stringify writes null, which must read as absent
    // rather than as a number.
    expect(parseSidebarPrefs('{"width":null}').width).toBe(null);
  });

  test("the collapsed flag is a boolean or it is not there", () => {
    expect(parseSidebarPrefs('{"collapsed":true}').collapsed).toBe(true);
    expect(parseSidebarPrefs('{"collapsed":false}').collapsed).toBe(false);
    expect(parseSidebarPrefs('{"collapsed":"yes"}').collapsed).toBe(null);
    expect(parseSidebarPrefs('{"width":320}').collapsed).toBe(null);
  });

  test("a half-valid record keeps the half that is valid", () => {
    expect(parseSidebarPrefs('{"width":"wide","collapsed":true}')).toEqual({
      width: null,
      collapsed: true,
    });
  });

  test("nothing usable always yields the SAME empty record", () => {
    // Referential, not structural: useSyncExternalStore re-renders until two
    // consecutive snapshots are identical by reference.
    expect(parseSidebarPrefs(null)).toBe(NO_SIDEBAR_PREFS);
    expect(parseSidebarPrefs("{}")).toBe(NO_SIDEBAR_PREFS);
    expect(sanitizeSidebarPrefs(undefined)).toBe(NO_SIDEBAR_PREFS);
    expect(sanitizeSidebarPrefs(42)).toBe(NO_SIDEBAR_PREFS);
    expect(sanitizeSidebarPrefs({ width: "nope" })).toBe(NO_SIDEBAR_PREFS);
  });
});

describe("a corrupt stored width falls back to the default, end to end", () => {
  test("the parse says absent and the clamp is never asked", () => {
    // This is the sequence Sidebar runs: parse what is stored, and only clamp
    // if something came back. The default width is a CSS constant the
    // component never overrides, so "absent" is exactly "leave it alone".
    const prefs = parseSidebarPrefs('{"width":"320px"}');
    expect(prefs.width).toBe(null);
    const applied = prefs.width === null ? null : clampSidebarWidth(prefs.width, MIN, MAX);
    expect(applied).toBe(null);
  });
});
