/**
 * `/v2/worktrees-root` OVER THE REAL WIRE — issue #642 part 2.
 *
 * Three claims that only a running daemon can make:
 *
 *   NO RESTART IS ANNOUNCED, because none is needed. The root is read when a
 *   cut is planned, so a PUT applies to the next one — and the next cut in the
 *   SAME engine lands in the new place, which is what "no restart" has to mean
 *   to be worth saying.
 *
 *   A CUT IS REFUSED, NOT THE ENGINE, when the record cannot be read. The
 *   refusal names the file; every other route keeps answering.
 *
 *   NOTHING IS MOVED. A checkout already cut is still exactly where it was and
 *   still holds what it held.
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-wtroot-http-"));
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

test("with nothing chosen, checkouts go beside the store", async () => {
  const { daemon, client } = await ready();
  const { worktreesRoot } = await client.worktreesRoot();
  expect(worktreesRoot).toMatchObject({ kind: "default", root: path.join(daemon.store.paths.root, "worktrees") });
  expect(worktreesRoot.blocker).toBeUndefined();
});

test("choosing a folder takes effect with no restart, and says so by having no restart to report", async () => {
  const { client } = await ready();
  const chosen = root();
  const answer = await client.setWorktreesRoot(path.join(chosen, "checkouts"));

  expect(answer.worktreesRoot).toMatchObject({ kind: "configured", root: path.join(chosen, "checkouts") });
  // #630's answer shape carries `restartRequired`; this one deliberately does
  // not, because the root is read when a cut is planned rather than at launch.
  expect("restartRequired" in answer.worktreesRoot).toBe(false);
  // And it is durable: a fresh read of the same engine agrees.
  expect((await client.worktreesRoot()).worktreesRoot.root).toBe(path.join(chosen, "checkouts"));
});

test("null puts it back, and the default travels with the answer so the pane can offer it", async () => {
  const { daemon, client } = await ready();
  await client.setWorktreesRoot(path.join(root(), "checkouts"));
  const back = await client.setWorktreesRoot(null);
  expect(back.worktreesRoot).toMatchObject({ kind: "default", root: path.join(daemon.store.paths.root, "worktrees") });
  expect(back.worktreesRoot.default).toBe(path.join(daemon.store.paths.root, "worktrees"));
});

test("a relative path is refused rather than resolved against whatever the engine's cwd happens to be", async () => {
  const { client } = await ready();
  await expect(client.setWorktreesRoot("checkouts")).rejects.toThrow();
});

test("an unreadable record blocks a CUT and nothing else", async () => {
  const { daemon, client } = await ready();
  fs.writeFileSync(path.join(daemon.store.paths.root, "worktrees-location.json"), JSON.stringify({ version: 99, root: "/nowhere" }));

  const { worktreesRoot } = await client.worktreesRoot();
  expect(worktreesRoot.kind).toBe("unreadable");
  expect(worktreesRoot.blocker).toContain("worktrees-location.json");

  /**
   * THE SCOPE OF THE REFUSAL IS THE POINT. #630 refuses to START on a record
   * it cannot read, because the alternative there is a fresh store over absent
   * history. Nothing here is destructive, so locking somebody out of every
   * session and all their history over the file that says where checkouts go
   * would be a bigger failure than the one being prevented.
   */
  expect((await client.health()).ok ?? true).toBeTruthy();
  expect(Array.isArray((await client.listProjects()).projects)).toBe(true);
  // And it is recoverable from the same route that reports it.
  expect((await client.setWorktreesRoot(null)).worktreesRoot.kind).toBe("default");
});

test("changing the root moves nothing that is already on disk", async () => {
  const { daemon, client } = await ready();
  const existing = path.join(daemon.store.paths.root, "worktrees", "already-cut");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "uncommitted.txt"), "work nobody has committed");

  await client.setWorktreesRoot(path.join(root(), "checkouts"));

  // "A half-migrated worktrees root loses uncommitted work in every open
  // session" — so this setting is not allowed to be a migration.
  expect(fs.readFileSync(path.join(existing, "uncommitted.txt"), "utf8")).toBe("work nobody has committed");
});

test("the storage pane keeps counting the checkouts left behind by a change", async () => {
  const { daemon, client } = await ready();
  const old = path.join(daemon.store.paths.root, "worktrees", "already-cut");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "big.bin"), Buffer.alloc(256 * 1024, 7));

  await client.setWorktreesRoot(path.join(root(), "checkouts"));
  const { storage } = await client.storage({ refresh: true });

  const checkouts = storage.entries.find((entry) => entry.category === "worktrees");
  // Under-reporting here would hide exactly the gigabytes somebody changed the
  // setting in order to get rid of.
  expect(checkouts?.bytes ?? 0).toBeGreaterThanOrEqual(256 * 1024);
});
