/**
 * `/v2/storage` OVER THE REAL WIRE — issue #642.
 *
 * The unit tests prove the walk. What only the daemon can prove is the half
 * that keeps the pane honest: that a second reader does NOT set a second
 * traversal of a 13 GB tree going, and that `?refresh=1` is the one thing that
 * does. #629 is open because four timers in the rail cost ~97,000 requests a
 * day; a route that re-walked the store on every GET would be that bug with a
 * filesystem attached.
 *
 * AGAINST A TEMPORARY ROOT, never the live store — `startEngine` is given its
 * own directory here, as every engine test is.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-storage-http-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function ready() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery) };
}

test("the engine reports what it is keeping, with the moment it measured it", async () => {
  const { daemon, client } = await ready();
  const { storage } = await client.storage();

  expect(storage.root).toBe(daemon.store.paths.root);
  expect(storage.measuredAt).toBeGreaterThan(0);
  expect(storage.total).toBe(storage.entries.reduce((sum, entry) => sum + entry.bytes, 0));
  // A started engine has written its discovery record and its lock, so the
  // settings row is real rather than hypothetical. The journal is NOT asserted
  // here: sqlite is opened lazily, and an engine nobody has talked to yet
  // legitimately has no database — which is itself the right answer for a row
  // that reports what is on disk.
  expect(storage.entries.some((entry) => entry.category === "settings")).toBe(true);
});

test("a second reader gets the measurement already taken — one walk, not two", async () => {
  const { client } = await ready();
  const first = await client.storage();
  const second = await client.storage();
  // Same instant, so the same walk: two Settings windows opening together must
  // not put two traversals of the store on the same disk.
  expect(second.storage.measuredAt).toBe(first.storage.measuredAt);
});

test("refresh is what re-walks, and it sees what was written since", async () => {
  const { daemon, client } = await ready();
  const before = await client.storage();

  fs.writeFileSync(path.join(daemon.store.paths.root, "usage-scan-cache.json"), Buffer.alloc(512 * 1024, 7));
  // Still the cached answer: the file is on disk and the figure has not moved,
  // which is exactly what "as of a timestamp" means.
  expect((await client.storage()).storage.measuredAt).toBe(before.storage.measuredAt);

  const after = await client.storage({ refresh: true });
  expect(after.storage.measuredAt).toBeGreaterThanOrEqual(before.storage.measuredAt);
  expect(after.storage.total).toBeGreaterThan(before.storage.total);
  expect(after.storage.entries.some((entry) => entry.category === "usage")).toBe(true);
});

test("reading the store does not write to it", async () => {
  const { daemon, client } = await ready();
  const before = fs.readdirSync(daemon.store.paths.root).sort();
  await client.storage({ refresh: true });
  expect(fs.readdirSync(daemon.store.paths.root).sort()).toEqual(before);
});
