"use strict";

const { expect, test } = require("bun:test");
const { mountRootsFor, watchVolumes } = require("./volume-watch");

function stubWatch() {
  const listeners = new Map();
  const closed = [];
  const watch = (dir, listener) => {
    listeners.set(dir, listener);
    return { close: () => closed.push(dir) };
  };
  return { watch, closed, fire: (dir) => listeners.get(dir)(), watched: () => [...listeners.keys()] };
}

function stubPowerMonitor() {
  const listeners = new Map();
  return { on: (event, listener) => listeners.set(event, listener), wake: () => listeners.get("resume")?.() };
}

const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the mount roots are the platform's", () => {
  expect(mountRootsFor("darwin")).toEqual(["/Volumes"]);
  expect(mountRootsFor("linux")).toEqual(["/media", "/mnt"]);
  expect(mountRootsFor("win32")).toEqual([]);
});

test("a mount event asks the engine to re-probe", async () => {
  const stub = stubWatch();
  let asked = 0;
  const watcher = watchVolumes({ onChanged: () => { asked += 1; }, platform: "darwin", watch: stub.watch, settleMs: 5 });

  expect(stub.watched()).toEqual(["/Volumes"]);
  stub.fire("/Volumes");
  await after(30);
  expect(asked).toBe(1);
  watcher.stop();
});

test("a burst of events is ONE re-probe — mounting a volume writes several entries", async () => {
  const stub = stubWatch();
  let asked = 0;
  const watcher = watchVolumes({ onChanged: () => { asked += 1; }, platform: "darwin", watch: stub.watch, settleMs: 20 });

  for (let event = 0; event < 8; event += 1) stub.fire("/Volumes");
  await after(60);
  expect(asked).toBe(1);
  watcher.stop();
});

test("waking counts as a change — a drive pulled out during sleep produced no event for anybody", async () => {
  const stub = stubWatch();
  const power = stubPowerMonitor();
  let asked = 0;
  const watcher = watchVolumes({ onChanged: () => { asked += 1; }, platform: "darwin", watch: stub.watch, powerMonitor: power, settleMs: 5 });

  power.wake();
  await after(30);
  expect(asked).toBe(1);
  watcher.stop();
});

test("a mount root that cannot be watched is one root fewer, never a failed start", () => {
  const watcher = watchVolumes({
    onChanged: () => {},
    platform: "linux",
    watch: (dir) => {
      if (dir === "/media") throw new Error("ENOENT");
      return { close: () => {} };
    },
    settleMs: 5,
  });

  expect(watcher.watching).toEqual(["/mnt"]);
  watcher.stop();
});

test("stopping closes the watchers and cancels a burst already in flight", async () => {
  const stub = stubWatch();
  let asked = 0;
  const watcher = watchVolumes({ onChanged: () => { asked += 1; }, platform: "darwin", watch: stub.watch, settleMs: 20 });

  stub.fire("/Volumes");
  watcher.stop();
  await after(60);

  expect(asked).toBe(0);
  expect(stub.closed).toEqual(["/Volumes"]);
});
