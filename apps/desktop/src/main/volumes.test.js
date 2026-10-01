"use strict";

const { expect, test } = require("bun:test");
const { findVolumeMount } = require("./volumes");

test("a uuid no mounted drive carries is not found", () => {
  expect(findVolumeMount("00000000-0000-0000-0000-000000000000")).toBeUndefined();
});
