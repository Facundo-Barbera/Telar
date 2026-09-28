"use strict";

const { expect, test } = require("bun:test");

const { mountRootsFor: shared, volumeSupportOn } = require("../../../../packages/engine-client/src/mounts");
const { mountRootsFor: watcher } = require("./volume-watch");

const PLATFORMS = ["darwin", "linux", "win32", "freebsd", "aix"];

test("the volume watcher's copy is the one list, on every platform", () => {
  for (const platform of PLATFORMS) {
    expect({ platform, roots: watcher(platform) }).toEqual({ platform, roots: shared(platform) });
  }
});

test("win32 is empty in both, which is the divergence that mattered", () => {
  expect(shared("win32")).toEqual([]);
  expect(watcher("win32")).toEqual([]);

  expect(shared("darwin")).toEqual(["/Volumes"]);
  expect(watcher("darwin")).toEqual(["/Volumes"]);
});
test("the store gate's platform check agrees with the shared one", () => {
  const { volumesResolvableOn } = require("../store/store-location");
  for (const platform of PLATFORMS) {
    expect({ platform, resolvable: volumesResolvableOn(platform) })
      .toEqual({ platform, resolvable: volumeSupportOn(platform) !== "unsupported" });
  }
});
