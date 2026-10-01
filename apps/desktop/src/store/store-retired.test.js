"use strict";

const { afterEach, beforeEach, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { retiredSubtrees, deleteRetiredSubtrees, totalBytes } = require("./store-retired");

const stamp = "1000";
let source;

beforeEach(() => {
  source = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-retired-"));
  fs.mkdirSync(path.join(source, `engine.migrated-${stamp}`, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(source, `remote.migrated-${stamp}`), { recursive: true });
  fs.writeFileSync(path.join(source, `engine.migrated-${stamp}`, "sessions", "session.json"), "x".repeat(100));
  fs.writeFileSync(path.join(source, `remote.migrated-${stamp}`, "remote.json"), "y".repeat(20));
  fs.mkdirSync(path.join(source, "engine"));
});

afterEach(() => {
  fs.rmSync(source, { recursive: true, force: true });
});

test("the retired subtrees of a move are found with their sizes", async () => {
  expect((await retiredSubtrees(source, stamp)).map((entry) => entry.bytes)).toEqual([100, 20]);
  expect(await retiredSubtrees(source, "2000")).toEqual([]);
});

test("a walk that outlives its deadline reports no size instead of stalling", async () => {
  let clock = 0;
  const now = () => (clock += 10);
  const found = await retiredSubtrees(source, stamp, { now, deadlineMs: 15 });
  expect(found).toHaveLength(2);
  expect(found.map((entry) => entry.bytes)).toEqual([undefined, undefined]);
  expect(totalBytes(found)).toBeUndefined();

  expect(await deleteRetiredSubtrees({ source, stamp, openedAt: 1001 }, { now, deadlineMs: 15 })).toEqual({ ok: true, removed: undefined });
  expect(await retiredSubtrees(source, stamp)).toHaveLength(0);
});

test("the old store cannot be removed until the new one has actually been opened", async () => {
  const tooSoon = await deleteRetiredSubtrees({ source, stamp, openedAt: 999 });
  expect(tooSoon.ok).toBe(false);
  expect(tooSoon.message).toContain("Restart first");
  expect(await retiredSubtrees(source, stamp)).toHaveLength(2);

  expect(await deleteRetiredSubtrees({ source, stamp, openedAt: 1001 })).toEqual({ ok: true, removed: 120 });
  expect(await retiredSubtrees(source, stamp)).toHaveLength(0);
  expect(fs.existsSync(path.join(source, "engine"))).toBe(true);
});

test("removing twice is refused rather than pretending", async () => {
  await deleteRetiredSubtrees({ source, stamp, openedAt: 1001 });
  expect((await deleteRetiredSubtrees({ source, stamp, openedAt: 1001 })).ok).toBe(false);
});

test("a stamp this install never recorded is refused", async () => {
  expect((await deleteRetiredSubtrees({ source, stamp: "not-a-stamp", openedAt: 1001 })).ok).toBe(false);
  expect(await retiredSubtrees(source, stamp)).toHaveLength(2);
});
