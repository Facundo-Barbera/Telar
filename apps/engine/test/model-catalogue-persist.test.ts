/**
 * THE MODEL CATALOGUE ANSWERS AT ONCE ONCE IT HAS EVER BEEN READ.
 *
 * A provider read is a subprocess (Codex's app-server, `opencode models`,
 * Claude's handshake and effort probe), and the cache used to live in memory
 * for five minutes — so every engine start put a spinner in the picker. The
 * last good answer is now persisted and served first, and the provider is asked
 * again in the background. Every read here is a fake that COUNTS: "answered
 * from disk" is only a claim if the count says nothing was spawned.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelCatalogue, ProviderDriverKind } from "@telar/engine-client";
import { EngineStore, type InstalledCli } from "../src/state";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
const home = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-catalogue-"));
  homes.push(dir);
  return dir;
};

const row = (id: string) => ({ id, label: id, efforts: [], isDefault: false, hidden: false, fastMode: false, hiddenByUser: false, legacy: false, source: "provider" as const });

/** A provider that answers with whatever `answer` holds, and counts. */
function provider(initial: string[]) {
  const state = { answer: initial as string[] | Error, reads: 0, version: "1.0.0" };
  const models = async (driver: ProviderDriverKind, now: () => number): Promise<ModelCatalogue> => {
    state.reads += 1;
    if (state.answer instanceof Error) return { driver, models: [], source: "builtin", message: state.answer.message, readAt: now() };
    return { driver, models: state.answer.map(row), source: "provider", readAt: now() };
  };
  const cliVersion = async (): Promise<InstalledCli> => ({ installed: true, version: state.version });
  return { state, options: { models, cliVersion } };
}

/** Let queued background work run: a refresh is a few chained microtasks. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("a cold start answers from the persisted catalogue, with no spawn", async () => {
  const dir = home();
  const clock = { now: 1_000 };
  const first = provider(["gpt-a", "gpt-b"]);
  const before = new EngineStore(dir, () => clock.now, first.options);
  expect((await before.modelCatalogue("codex")).models.map((model) => model.id)).toEqual(["gpt-a", "gpt-b"]);
  expect(first.state.reads).toBe(1);

  // A new engine on the same home — the restart that used to cost a spinner.
  const second = provider(["never-read"]);
  const after = new EngineStore(dir, () => clock.now, second.options);
  const answer = await after.modelCatalogue("codex");
  expect(answer.models.map((model) => model.id)).toEqual(["gpt-a", "gpt-b"]);
  expect(second.state.reads).toBe(0);
});

test("a stale catalogue is answered at once and refreshed in the background", async () => {
  const dir = home();
  const clock = { now: 1_000 };
  const fake = provider(["gpt-a"]);
  const store = new EngineStore(dir, () => clock.now, fake.options);
  await store.modelCatalogue("codex");

  // Past its life. The answer is still the old one, now, and says a newer one
  // is on its way.
  clock.now += 6 * 60_000;
  fake.state.answer = ["gpt-a", "gpt-new"];
  const stale = await store.modelCatalogue("codex");
  expect(stale.models.map((model) => model.id)).toEqual(["gpt-a"]);
  expect(stale.refreshing).toBe(true);
  await settle();
  expect(fake.state.reads).toBe(2);

  const fresh = await store.modelCatalogue("codex");
  expect(fresh.models.map((model) => model.id)).toEqual(["gpt-a", "gpt-new"]);
  expect(fresh.refreshing).toBeUndefined();
  // And it was persisted: a restart sees the new list without reading.
  const restarted = provider(["never-read"]);
  expect((await new EngineStore(dir, () => clock.now, restarted.options).modelCatalogue("codex")).models.map((model) => model.id)).toEqual(["gpt-a", "gpt-new"]);
  expect(restarted.state.reads).toBe(0);
});

test("a CLI version change refreshes a catalogue that is otherwise fresh", async () => {
  const dir = home();
  const clock = { now: 1_000 };
  const fake = provider(["opencode/a"]);
  const store = new EngineStore(dir, () => clock.now, fake.options);
  await store.modelCatalogue("opencode");

  // Same version, well inside its life: the prefetch has nothing to do.
  await store.prefetchModelCatalogues(["opencode"]);
  expect(fake.state.reads).toBe(1);

  fake.state.version = "1.1.0";
  fake.state.answer = ["opencode/a", "opencode/b"];
  await store.prefetchModelCatalogues(["opencode"]);
  expect(fake.state.reads).toBe(2);
  expect((await store.modelCatalogue("opencode")).models.map((model) => model.id)).toEqual(["opencode/a", "opencode/b"]);
});

test("a failed refresh keeps the last good answer", async () => {
  const dir = home();
  const clock = { now: 1_000 };
  const fake = provider(["gpt-a"]);
  const store = new EngineStore(dir, () => clock.now, fake.options);
  await store.modelCatalogue("codex");

  fake.state.answer = new Error("codex is not signed in");
  const forced = await store.modelCatalogue("codex", { force: true });
  expect(forced.models.map((model) => model.id)).toEqual(["gpt-a"]);
  expect(forced.message).toBeUndefined();

  clock.now += 6 * 60_000;
  await store.modelCatalogue("codex");
  await settle();
  expect((await store.modelCatalogue("codex")).models.map((model) => model.id)).toEqual(["gpt-a"]);
});

test("a provider never read well shows its error, and is not respawned on every open", async () => {
  const clock = { now: 1_000 };
  const fake = provider([]);
  fake.state.answer = new Error("opencode is not installed");
  const store = new EngineStore(home(), () => clock.now, fake.options);
  expect((await store.modelCatalogue("opencode")).message).toBe("opencode is not installed");
  await store.modelCatalogue("opencode");
  expect(fake.state.reads).toBe(1);
});

test("readers of one provider share one read, and providers are read one at a time", async () => {
  const clock = { now: 1_000 };
  let inFlight = 0;
  let most = 0;
  let reads = 0;
  const store = new EngineStore(home(), () => clock.now, {
    models: async (driver: ProviderDriverKind, now: () => number): Promise<ModelCatalogue> => {
      reads += 1;
      inFlight += 1;
      most = Math.max(most, inFlight);
      await settle();
      inFlight -= 1;
      return { driver, models: [row(`${driver}-model`)], source: "provider", readAt: now() };
    },
    cliVersion: async () => ({ installed: true, version: "1" }),
  });
  await Promise.all([store.modelCatalogue("codex"), store.modelCatalogue("codex"), store.modelCatalogue("opencode"), store.modelCatalogue("claude")]);
  expect(reads).toBe(3);
  expect(most).toBe(1);
});

test("after a failed refresh, opening the picker again does not respawn the provider each time", async () => {
  const clock = { now: 1_000 };
  const fake = provider(["gpt-a"]);
  const store = new EngineStore(home(), () => clock.now, fake.options);
  await store.modelCatalogue("codex");
  clock.now += 6 * 60_000;
  fake.state.answer = new Error("offline");
  await store.modelCatalogue("codex");
  await settle();
  for (let open = 0; open < 5; open += 1) await store.modelCatalogue("codex");
  await settle();
  expect(fake.state.reads).toBe(2);
});
