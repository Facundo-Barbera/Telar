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
const ico = (tail = "one"): Buffer => Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.from(tail)]);
const svg = (tail = ""): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${tail}</svg>`);

/**
 * How many paths the finder has resolved since the process started.
 *
 * The cache's whole justification is that a poll should not re-walk a
 * checkout, and "it is cached" is only a claim until something counts. Every
 * candidate probe goes through `realpathSync.native`, so wrapping it once is
 * enough to tell a confirmation (one path) from a full resolution (the
 * candidate list).
 */
let resolvedPaths = 0;
const realpathNative = fs.realpathSync.native;
fs.realpathSync.native = ((target: fs.PathLike, options?: never) => {
  resolvedPaths += 1;
  return realpathNative(target, options);
}) as typeof fs.realpathSync.native;
const reads = (): number => resolvedPaths;

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

/* ------------------------------------------------------------------ *
 * The discovery clock is not the confirmation clock
 *
 * A confirmation proves the file it ALREADY KNOWS is still there. It cannot
 * see a new file that now outranks it. If confirming refreshed the discovery
 * deadline, a ten-second poll would hold a five-minute TTL open forever and
 * the full search would never run again.
 * ------------------------------------------------------------------ */

test("a higher-priority icon added later is found, however often the old one was polled", () => {
  const { store, projectRoot, tick } = ready();
  fs.writeFileSync(path.join(projectRoot, "favicon.ico"), ico());
  const first = store.projectIconFile("project_one");
  expect(first.path.endsWith("favicon.ico")).toBe(true);

  // The sidebar's poll, for eleven minutes. Every one of these is a cache hit
  // that confirms the same untouched file.
  for (let elapsed = 0; elapsed < 660_000; elapsed += 10_000) {
    tick(10_000);
    expect(store.projectIconFile("project_one").path.endsWith("favicon.ico")).toBe(true);
  }

  // Now the project states its own choice, which outranks every convention.
  fs.mkdirSync(path.join(projectRoot, ".telar"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".telar/icon.svg"), svg());
  // The old file is still there and still confirms, so only a full resolution
  // can notice. Within one discovery TTL of polling, it must.
  let found = false;
  for (let i = 0; i < 32 && !found; i++) {
    tick(10_000);
    found = store.projectIconFile("project_one").path.endsWith(path.join(".telar", "icon.svg"));
  }
  expect(found).toBe(true);
});

test("a declared href that moves to a different file is picked up too", () => {
  // Same failure, without an explicit icon: the source file still exists and
  // the old target still exists, so nothing about the cached answer looks
  // stale — only re-reading index.html finds the new href.
  const { store, projectRoot, tick } = ready();
  fs.mkdirSync(path.join(projectRoot, "public"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "public/old.svg"), svg("<rect/>"));
  fs.writeFileSync(path.join(projectRoot, "public/new.svg"), svg("<circle/>"));
  fs.writeFileSync(path.join(projectRoot, "index.html"), `<link rel="icon" href="/old.svg">`);
  expect(store.projectIconFile("project_one").path.endsWith("old.svg")).toBe(true);

  for (let elapsed = 0; elapsed < 600_000; elapsed += 10_000) {
    tick(10_000);
    store.projectIconFile("project_one");
  }
  fs.writeFileSync(path.join(projectRoot, "index.html"), `<link rel="icon" href="/new.svg">`);
  let found = false;
  for (let i = 0; i < 32 && !found; i++) {
    tick(10_000);
    found = store.projectIconFile("project_one").path.endsWith("new.svg");
  }
  expect(found).toBe(true);
});

test("polling does not re-walk the checkout on every hit — the cache still earns its keep", () => {
  // The other half of the same bargain: confirmation must be cheap. A full
  // resolution touches the candidate list; a confirmed hit touches one file.
  const { store, projectRoot, tick } = ready();
  fs.writeFileSync(path.join(projectRoot, "favicon.ico"), ico());
  store.projectIconFile("project_one");
  const before = reads();
  for (let i = 0; i < 10; i++) {
    tick(10_000);
    store.projectIconFile("project_one");
  }
  // Ten polls resolve nothing: no candidate that does not exist is probed.
  expect(reads() - before).toBeLessThan(10 * 5);
});
