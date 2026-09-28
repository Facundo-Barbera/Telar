"use strict";

const { expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { mainSource } = require("./main-source");

const { mountRootsFor: shared, volumeSupportOn } = require("../../packages/engine-client/src/mounts");
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

test("the shell's own volume search uses the same darwin root, and no other", () => {
  const source = mainSource();
  const search = /for \(const root of (\[[^\]]*\])\) \{/.exec(source);
  expect(search).not.toBeNull();
  expect(JSON.parse(search[1])).toEqual(shared("darwin"));
});

test("the store gate's platform check agrees with the shared one", () => {
  const { volumesResolvableOn } = require("./store-location");
  for (const platform of PLATFORMS) {
    expect({ platform, resolvable: volumesResolvableOn(platform) })
      .toEqual({ platform, resolvable: volumeSupportOn(platform) !== "unsupported" });
  }
});
