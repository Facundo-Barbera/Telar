"use strict";

const { expect, test } = require("bun:test");
const { findVolumeMount, volumeIdentityFor } = require("./volumes");

test("a path outside /Volumes has no volume identity", () => {
  expect(volumeIdentityFor("/Users/someone/project")).toBeUndefined();
  expect(volumeIdentityFor("/Volumes/")).toBeUndefined();
});

test("a /Volumes path whose drive is not mounted is named by its label alone", () => {
  if (process.platform !== "darwin") return;
  expect(volumeIdentityFor("/Volumes/telar-no-such-drive/store")).toEqual({ mount: "/Volumes/telar-no-such-drive", label: "telar-no-such-drive" });
});

test("a uuid no mounted drive carries is not found", () => {
  expect(findVolumeMount("00000000-0000-0000-0000-000000000000")).toBeUndefined();
});
