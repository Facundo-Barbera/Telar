/**
 * WHAT THE STORE REMEMBERS ABOUT A PROJECT'S ICON, and when it stops trusting
 * it.
 *
 * A cache exists here so a ten-second sidebar poll does not re-walk every
 * registered checkout — and it is wrong the moment somebody adds, replaces or
 * deletes a favicon. These tests drive the store's clock so the staleness
 * bounds are exercised rather than waited out.
 *
 * All of it runs against temporary directories — no user project is ever
 * registered or read by this file.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";

const roots: string[] = [];
const dir = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const png = (tail = "one"): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);

/** A store whose clock this test drives, so the TTLs are exercised rather than
 *  waited out. */
function ready(): { store: EngineStore; projectRoot: string; tick: (ms: number) => void } {
  let now = 1_000;
  const store = new EngineStore(dir("telar-registry-state-"), () => now);
  const projectRoot = dir("telar-registry-checkout-");
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  return { store, projectRoot, tick: (ms) => { now += ms; } };
}

/* ------------------------------------------------------------------ *
 * The icon cache
 * ------------------------------------------------------------------ */

test("an icon added to a checkout becomes visible without waiting out a long TTL", () => {
  // THE COMPLAINT THIS FIXES. A person drops `public/favicon.ico` into their
  // repo and watches the sidebar. The "no icon" answer is the one they are in
  // the middle of falsifying, so it is held for seconds, not minutes.
  const { store, projectRoot, tick } = ready();
  expect(() => store.projectIconFile("project_one")).toThrow(EngineStateError);
  fs.mkdirSync(path.join(projectRoot, "public"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "public/icon.png"), png());
  tick(16_000);
  expect(store.projectIconFile("project_one").contentType).toBe("image/png");
});

test("a replaced icon gets a new etag on the very next read, inside the positive TTL", () => {
  // The cached answer names a path; confirming it costs one stat and re-derives
  // the etag from the file's mtime and size, so a designer swapping the file
  // does not have to wait five minutes to see it.
  const { store, projectRoot, tick } = ready();
  const file = path.join(projectRoot, "icon.png");
  fs.writeFileSync(file, png("one"));
  const first = store.projectIconFile("project_one").etag;
  fs.writeFileSync(file, png("two-much-longer"));
  tick(1_000); // well inside the five-minute positive TTL
  expect(store.projectIconFile("project_one").etag).not.toBe(first);
});

test("a deleted icon falls back at once rather than serving a path that is gone", () => {
  const { store, projectRoot, tick } = ready();
  fs.writeFileSync(path.join(projectRoot, "icon.png"), png());
  expect(store.projectIconFile("project_one")).toBeDefined();
  fs.rmSync(path.join(projectRoot, "icon.png"));
  tick(1_000);
  expect(() => store.projectIconFile("project_one")).toThrow(EngineStateError);
});

test("a deleted icon is replaced by the next candidate down, not just dropped", () => {
  const { store, projectRoot, tick } = ready();
  fs.writeFileSync(path.join(projectRoot, "icon.png"), png("explicit"));
  fs.mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "assets/icon.png"), png("fallback"));
  expect(store.projectIconFile("project_one").path.endsWith("icon.png")).toBe(true);
  fs.rmSync(path.join(projectRoot, "icon.png"));
  tick(1_000);
  expect(store.projectIconFile("project_one").path.endsWith(path.join("assets", "icon.png"))).toBe(true);
});

test("the async read agrees with the sync one against the same cache", async () => {
  const { store, projectRoot } = ready();
  fs.writeFileSync(path.join(projectRoot, "icon.png"), png());
  expect(await store.projectIconFileAsync("project_one")).toEqual(store.projectIconFile("project_one"));
});
