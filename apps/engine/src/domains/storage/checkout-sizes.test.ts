import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { CheckoutSizes, type SizingFs, type SizingStat } from "./checkout-sizes";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";

const ROOT = "/virtual/worktrees";
const BLOCK = 4096;

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
    msPerPass: 1_000_000,
    idleMs: options.idleMs ?? 10_000,
    concurrency: 2,
  });
  const pass = async () => {
    const next = queue.shift();
    if (!next) return;
    const ended = () => sizes.stats.passes + sizes.stats.idleStops;
    const before = ended();
    next();
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
  expect(sizes.figure([ROOT]).measuring).toBe(true);
});

test("with nobody asking, the walk stops where it stands — and resumes, not restarts, on the next read", async () => {
  const tree = virtualTree(3, 10_000);
  const { sizes, queue, pass, advance } = harness(tree, { opsPerPass: 300, idleMs: 10_000 });
  sizes.figure([ROOT]);
  await pass();
  const after = sizes.stats.ops;

  advance(10_001);
  await pass();
  expect(sizes.stats.idleStops).toBe(1);
  expect(sizes.stats.ops).toBe(after);
  expect(queue.length).toBe(0);

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
    advance(1);
    sizes.figure([ROOT]);
    await pass();
  }

  const settled = sizes.figure([ROOT]);
  expect(settled).toMatchObject({ measuring: false, partial: false, measured: 3, of: 3, bytes: 3 * 50 * BLOCK });
  expect(queue.length).toBe(0);

  const ops = sizes.stats.ops;
  sizes.figure([ROOT]);
  expect(queue.length).toBe(0);
  expect(sizes.stats.ops).toBe(ops);

  tree.mtimes.set(path.join(ROOT, "checkout-1"), 2);
  sizes.relist();
  expect(sizes.figure([ROOT]).bytes).toBe(3 * 50 * BLOCK);
  const lstatsBefore = tree.calls.lstat;
  for (let passes = 0; passes < 1_000 && queue.length > 0; passes += 1) {
    sizes.figure([ROOT]);
    await pass();
  }
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

test("a file's private size is counted when the disk reports one, so shared clone extents are not", async () => {
  const tree = virtualTree(2, 4);
  tree.fs.privateSize = (target) => (target.endsWith("f0") ? BLOCK : 0);
  const { sizes, queue, pass } = harness(tree);
  for (let passes = 0; passes < 100 && (passes === 0 || queue.length > 0); passes += 1) {
    sizes.figure([ROOT]);
    await pass();
  }
  expect(sizes.figure([ROOT])).toMatchObject({ measuring: false, bytes: 2 * BLOCK });
});

const daemons: EngineDaemon[] = [];
const temporary: string[] = [];

function clonedFromCache(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const [cache, root] = [fs.mkdtempSync(path.join(os.tmpdir(), "telar-cache-")), fs.mkdtempSync(path.join(os.tmpdir(), "telar-clone-"))];
  temporary.push(cache, root);
  fs.mkdirSync(path.join(root, "checkout"));
  fs.writeFileSync(path.join(cache, "package.tgz"), crypto.randomBytes(4 * 1024 * 1024));
  try {
    fs.copyFileSync(path.join(cache, "package.tgz"), path.join(root, "checkout", "package.tgz"), fs.constants.COPYFILE_FICLONE_FORCE);
  } catch {
    return undefined;
  }
  return root;
}

test("a checkout's APFS clone of a package cache file is not counted as the checkout's own disk use", async () => {
  const root = clonedFromCache();
  if (!root) return;
  const queue: Array<() => void> = [];
  const sizes = new CheckoutSizes({ schedule: (next) => (queue.push(next), { cancel: () => {} }), msPerPass: 60_000 });
  sizes.figure([root]);
  for (let turns = 0; turns < 10_000 && (queue.length > 0 || sizes.figure([root]).measuring); turns += 1) {
    queue.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const naive = fs.lstatSync(path.join(root, "checkout", "package.tgz")).blocks * 512;
  const figure = sizes.figure([root]);
  expect(figure.measuring).toBe(false);
  expect(naive).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(figure.bytes).toBeLessThan(1024 * 1024);
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("the storage route answers `measuring` while the checkouts' disk hangs, and other routes are not held up", async () => {
  const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-checkout-sizes-"));
  temporary.push(engineRoot);
  const hanging = virtualTree(140, 75_000, { hangInside: true });
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

  for (let reads = 0; reads < 50 && hanging.calls.readdir < 2; reads += 1) await client.storage();
  expect(hanging.calls.readdir).toBeGreaterThanOrEqual(2);
  expect(Array.isArray((await client.listProjects()).projects)).toBe(true);
  const again = (await client.storage()).storage.entries.find((entry) => entry.category === "worktrees") as { status?: string } | undefined;
  expect(again?.status).toBe("measuring");
});
