"use strict";

/**
 * THE SHELL'S MOUNT-ROOT LISTS AGREE WITH THE ONE LIST — issue #665.
 *
 * ══ WHY THERE ARE STILL TWO COPIES IN THIS DIRECTORY ══
 *
 * The list moved to `@telar/engine-client`'s `mounts`, which the engine and the
 * cockpit both import. The shell cannot: `apps/desktop` is plain CommonJS
 * packaged by electron-builder from an explicit file allowlist inside its own
 * directory, with no workspace dependency on that package and no build step
 * that could inline one. Adding the dependency to share four strings would pull
 * zod and the whole protocol into the app bundle.
 *
 * So the copies stay and THIS holds them to the original. That is the part that
 * was missing: before #665 there were five copies agreeing by convention, each
 * with a comment saying it was a copy, and the win32 hole was in all five —
 * which is a fix that would have been five edits and would have held exactly
 * until the sixth copy appeared.
 *
 * ══ WHAT IT ASSERTS, AND WHY THE PLATFORM LIST IS EXPLICIT ══
 *
 * Every platform, not just this machine's. A test that only checked `darwin`
 * would pass on the divergence that matters — win32, where every copy returns
 * an empty list and every caller reads that as "on this machine's own disk".
 *
 * `main.js`'s copy is inlined inside `findVolumeMount` rather than exported, so
 * it is asserted by reading the source for its literal. That is a grep, and a
 * grep is normally the weaker instrument — here it is the only one that can see
 * a list that is not a value, and what it compares against is the shared
 * function's real output rather than a string this test invented.
 */

const { expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

/**
 * BY RELATIVE PATH, NOT BY PACKAGE NAME, and that asymmetry is the finding
 * rather than a workaround: `apps/desktop` has no dependency on
 * `@telar/engine-client` and must not grow one to share four strings. A TEST
 * may reach across the repository — it runs from the workspace root under bun,
 * which loads the TypeScript directly — where the SHIPPED shell may not.
 */
const { mountRootsFor: shared, volumeSupportOn } = require("../../packages/engine-client/src/mounts");
const { mountRootsFor: watcher } = require("./volume-watch");

/** Every platform the shared list distinguishes, plus one it does not — a
 *  platform nobody has thought about must land on the same answer in both. */
const PLATFORMS = ["darwin", "linux", "win32", "freebsd", "aix"];

test("the volume watcher's copy is the one list, on every platform", () => {
  for (const platform of PLATFORMS) {
    expect({ platform, roots: watcher(platform) }).toEqual({ platform, roots: shared(platform) });
  }
});

test("win32 is empty in both, which is the divergence that mattered", () => {
  // Stated on its own because it is the case #665 is about, and because a
  // loop that happened to skip it would still pass the test above.
  expect(shared("win32")).toEqual([]);
  expect(watcher("win32")).toEqual([]);
  // …and darwin is not, so an implementation that returned `[]` for everything
  // would fail rather than satisfy both assertions.
  expect(shared("darwin")).toEqual(["/Volumes"]);
  expect(watcher("darwin")).toEqual(["/Volumes"]);
});

test("the shell's own volume search uses the same darwin root, and no other", () => {
  /**
   * `main.js`'s `findVolumeMount` inlines its roots — it is darwin-only by
   * construction, and the gate runs before the engine exists so it cannot ask
   * it. What must not drift is WHICH directory it searches: a copy that looked
   * under `/media` would find nothing on a Mac and a copy that looked anywhere
   * else would resolve a remount to the wrong drive.
   */
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const search = /for \(const root of (\[[^\]]*\])\) \{/.exec(source);
  expect(search).not.toBeNull();
  expect(JSON.parse(search[1])).toEqual(shared("darwin"));
});

test("the store gate's platform check agrees with the shared one", () => {
  const { volumesResolvableOn } = require("./store-location");
  for (const platform of PLATFORMS) {
    // The gate needs two values where the shared function has three: it never
    // has to tell "found but not identified" from "identified", because
    // `atMovedVolume` already copes with a missing uuid. What it must not do is
    // disagree about which platforms can be asked at all.
    expect({ platform, resolvable: volumesResolvableOn(platform) })
      .toEqual({ platform, resolvable: volumeSupportOn(platform) !== "unsupported" });
  }
});
