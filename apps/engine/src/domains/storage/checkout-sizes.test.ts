/**
 * THE CHECKOUT SIZER — the part of the storage pane that used to take the
 * engine down (Settings ▸ Storage never finished, and the sidebar and every
 * conversation queued behind it until a reload).
 *
 * AGAINST A FAKE FILESYSTEM, never a real tree and never a clock: the claims
 * are about how much work happens and when, so the tree is virtual (as big as
 * the test likes, for free), every call is counted, time is a number the test
 * moves, and the next pass runs when the test says so.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { CheckoutSizes, type SizingFs, type SizingStat } from "../src/checkout-sizes";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const ROOT = "/virtual/worktrees";
const BLOCK = 4096;

/**
 * `checkouts` checkouts under ROOT, each holding one directory of `files`
 * files of one block. Names are generated on read, so a million files costs
 * nothing until somebody lists them.
 */
function virtualTree(checkouts: number, files: number, options: { hangInside?: boolean } = {}) {
  const calls = { lstat: 0, readdir: 0, inFlight: 0, peak: 0 };
  const mtimes = new Map<string, number>();
  const dirStat = (target: string): SizingStat => ({ isDirectory: () => true, blocks: 0, size: 0, nlink: 2, dev: 1, ino: 0, mtimeMs: mtimes.get(target) ?? 1 });
  const fileStat: SizingStat = { isDirectory: () => false, blocks: BLOCK / 512, size: BLOCK, nlink: 1, dev: 1, ino: 0, mtimeMs: 1 };
  const track = async <T>(work: () => T): Promise<T> => {
    calls.inFlight += 1;
    calls.peak = Math.max(calls.peak, calls.inFlight);
    await Promise.resolve();
    calls.inFlight -= 1;
    return work();
  };
  const depth = (target: string) => path.relative(ROOT, target).split(path.sep).filter(Boolean).length;
  const fsSeam: SizingFs = {
    lstat: (target) => {
      calls.lstat += 1;
      return track(() => (depth(target) <= 2 ? dirStat(target) : fileStat));
    },
    readdir: (target) => {
      calls.readdir += 1;
      const level = depth(target);
      if (options.hangInside && level >= 1) return new Promise<string[]>(() => {});
      return track(() => {
        if (level === 0) return Array.from({ length: checkouts }, (_, index) => `checkout-${index}`);
        if (level === 1) return ["node_modules"];
        return Array.from({ length: files }, (_, index) => `f${index}`);
      });
    },
  };
  return { fs: fsSeam, calls, mtimes };
}

/** A clock and a run queue the test owns. */
function harness(tree: ReturnType<typeof virtualTree>, options: { opsPerPass?: number; idleMs?: number } = {}) {
  let now = 1_000;
  const queue: Array<() => void> = [];
  const sizes = new CheckoutSizes({
    fs: tree.fs,
    now: () => now,
    schedule: (next) => {
      queue.push(next);
      return { cancel: () => queue.splice(queue.indexOf(next) >>> 0, 1) };
    },
    opsPerPass: options.opsPerPass ?? 500,
    // Time never moves inside a pass here, so only the op budget ends one.
    msPerPass: 1_000_000,
    idleMs: options.idleMs ?? 10_000,
    concurrency: 2,
  });
  /** Run exactly one queued pass (or idle stop) to completion. */
  const pass = async () => {
    const next = queue.shift();
    if (!next) return;
    const ended = () => sizes.stats.passes + sizes.stats.idleStops;
    const before = ended();
    next();
    // A pass is a chain of awaits on the fake fs; let it drain.
    for (let spins = 0; spins < 1_000_000 && ended() === before; spins += 1) await Promise.resolve();
  };
  return {
    sizes,
    queue,
    pass,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("the storage read answers from memory with `measuring`, having touched no disk", () => {
  const tree = virtualTree(140, 75_000);
  const { sizes, queue } = harness(tree);

  const figure = sizes.figure([ROOT]);

  expect(figure).toMatchObject({ bytes: 0, measuring: true });
  // Not one filesystem call happened on the caller's path: the walk is queued.
  expect(tree.calls.lstat + tree.calls.readdir).toBe(0);
  expect(queue.length).toBe(1);
});

test("a pass is capped by its budget, and never has more than two calls in flight", async () => {
  const tree = virtualTree(140, 75_000);
  const { sizes, pass } = harness(tree, { opsPerPass: 500 });
  sizes.figure([ROOT]);

  await pass();
  expect(sizes.stats.passes).toBe(1);
  expect(sizes.stats.ops).toBeLessThanOrEqual(500);
  expect(tree.calls.peak).toBeLessThanOrEqual(2);

  await pass();
  expect(sizes.stats.ops).toBeLessThanOrEqual(1_000);
  // Still going, and still saying so: 140 × 75k files is not two passes.
  expect(sizes.figure([ROOT]).measuring).toBe(true);
});

test("with nobody asking, the walk stops where it stands — and resumes, not restarts, on the next read", async () => {
  const tree = virtualTree(3, 10_000);
  const { sizes, queue, pass, advance } = harness(tree, { opsPerPass: 300, idleMs: 10_000 });
  sizes.figure([ROOT]);
  await pass();
  const after = sizes.stats.ops;

  // The pane closed: no read for longer than the idle window.
  advance(10_001);
  await pass();
  expect(sizes.stats.idleStops).toBe(1);
  expect(sizes.stats.ops).toBe(after);
  expect(queue.length).toBe(0);

  // Somebody opens it again: work resumes from the kept frontier.
  const resumed = sizes.figure([ROOT]);
  expect(resumed.measuring).toBe(true);
  expect(queue.length).toBe(1);
  await pass();
  expect(sizes.stats.ops).toBeGreaterThan(after);
});

test("it settles to the sum, then serves it from cache until a checkout changes", async () => {
  const tree = virtualTree(3, 50);
  const { sizes, queue, pass, advance } = harness(tree, { opsPerPass: 40 });
  sizes.figure([ROOT]);
  for (let passes = 0; passes < 1_000 && queue.length > 0; passes += 1) {
    advance(1); // Each pass is a read's worth of attention.
    sizes.figure([ROOT]);
    await pass();
  }

  const settled = sizes.figure([ROOT]);
  expect(settled).toMatchObject({ measuring: false, partial: false, measured: 3, of: 3, bytes: 3 * 50 * BLOCK });
  expect(queue.length).toBe(0);

  // Cached: another read asks the disk nothing.
  const ops = sizes.stats.ops;
  sizes.figure([ROOT]);
  expect(queue.length).toBe(0);
  expect(sizes.stats.ops).toBe(ops);

  // One checkout touched (its directory's mtime moved): only it is re-walked,
  // and the old figure is served meanwhile rather than dropping to a floor.
  tree.mtimes.set(path.join(ROOT, "checkout-1"), 2);
  sizes.relist();
  expect(sizes.figure([ROOT]).bytes).toBe(3 * 50 * BLOCK);
  const lstatsBefore = tree.calls.lstat;
  for (let passes = 0; passes < 1_000 && queue.length > 0; passes += 1) {
    sizes.figure([ROOT]);
    await pass();
  }
  // The listing (root + 3 children) plus one checkout's walk (itself, its
  // directory and 50 files) — not three.
  expect(tree.calls.lstat - lstatsBefore).toBe(1 + 3 + 1 + 1 + 50);
  expect(sizes.figure([ROOT])).toMatchObject({ measuring: false, bytes: 3 * 50 * BLOCK });
});

test("stopping ends the job for good", async () => {
  const tree = virtualTree(3, 10_000);
  const { sizes, queue, pass } = harness(tree, { opsPerPass: 100 });
  sizes.figure([ROOT]);
  await pass();
  sizes.stop();
  expect(queue.length).toBe(0);
  sizes.figure([ROOT]);
  expect(queue.length).toBe(0);
});

/**
 * OVER THE REAL WIRE: a disk that never answers inside a checkout — the
 * saturated HDD at its worst — must not hold up the storage read or any other.
 */
const daemons: EngineDaemon[] = [];
const temporary: string[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("the storage route answers `measuring` while the checkouts' disk hangs, and other routes are not held up", async () => {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-checkout-sizes-"));
  temporary.push(engineRoot);
  const hanging = virtualTree(140, 75_000, { hangInside: true });
  // The fake stands in for the worktrees root wherever the daemon puts it.
  let worktreesRoot = "";
  const virtual = (target: string) => path.join(ROOT, path.relative(worktreesRoot, target));
  const rooted: SizingFs = { lstat: (target) => hanging.fs.lstat(virtual(target)), readdir: (target) => hanging.fs.readdir(virtual(target)) };
  const daemon = await startEngine({
    models: stubModels,
    engineRoot,
    checkoutSizing: { fs: rooted, schedule: (next) => (queueMicrotask(next), { cancel: () => {} }) },
  });
  daemons.push(daemon);
  worktreesRoot = path.join(daemon.store.paths.root, "worktrees");
  const client = new EngineClient(daemon.discovery);

  const first = (await client.storage()).storage;
  const checkouts = first.entries.find((entry) => entry.category === "worktrees") as { status?: string } | undefined;
  expect(checkouts?.status).toBe("measuring");

  // Let the sizer reach the hang, then prove the engine still answers.
  for (let reads = 0; reads < 50 && hanging.calls.readdir < 2; reads += 1) await client.storage();
  expect(hanging.calls.readdir).toBeGreaterThanOrEqual(2);
  expect(Array.isArray((await client.listProjects()).projects)).toBe(true);
  const again = (await client.storage()).storage.entries.find((entry) => entry.category === "worktrees") as { status?: string } | undefined;
  expect(again?.status).toBe("measuring");
});
