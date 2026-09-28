/**
 * STALE SUBSCRIPTIONS EXPIRE.
 *
 * One coordinator was found holding 32 ongoing subscriptions on sessions long
 * since settled; nothing removed them. Under test, on a fake clock: a target
 * settled, archived or deleted takes its subscriptions with it at the next
 * sweep, an ongoing watcher is bounded in age, and a live young one stays.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-sub-expiry-"));
  homes.push(home);
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const store = new EngineStore(home, () => now);
  stores.push(store);
  store.registerProject({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_a", "session_b", "session_c", "session_d"]) store.createSession({ id, projectId: "project_one", title: id });
  return { store, clock };
}

const watching = (store: EngineStore) => store.subscriptionsFor("session_host").map((each) => each.targetSessionId).sort();

test("a subscription on a settled or deleted target goes at the next sweep", () => {
  const { store } = setup();
  for (const targetSessionId of ["session_a", "session_b", "session_c"]) {
    store.subscribe("session_host", { targetSessionId, events: ["turn_failed", "request_opened"], once: false });
  }
  expect(store.sweepSubscriptions()).toEqual([]);

  store.updateSession("session_a", { settledOverride: "settled" });
  store.deleteSession("session_b");
  store.sweepSubscriptions();
  expect(watching(store)).toEqual(["session_c"]);
});

test("an ongoing watcher is bounded in age; a one-shot is not", () => {
  const { store, clock } = setup();
  store.subscribe("session_host", { targetSessionId: "session_a", once: false });
  store.subscribe("session_host", { targetSessionId: "session_b", once: true });
  clock.advance(7 * DAY - 1);
  store.subscribe("session_host", { targetSessionId: "session_d", once: false });
  expect(store.sweepSubscriptions()).toEqual([]);

  clock.advance(1);
  store.sweepSubscriptions();
  expect(watching(store)).toEqual(["session_b", "session_d"]);
});
