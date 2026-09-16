/**
 * WHAT RUNS WHEN NOBODY PICKED A MODEL.
 *
 * Measured in a Dev store before this existed: every Claude session holding a
 * `[1m]` id ran a 1 000 000 window, and every session with no model at all ran
 * 200 000 — four consecutive turns of one session among them. Telar publishes
 * only long rows, so the absent selection was the one path left that could run
 * a window the picker never offered.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelCatalogue, ProviderModel } from "@telar/engine-client";
import { EngineStore } from "../src/state";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { EngineClient } from "@telar/engine-client";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-default-model-"));
  roots.push(directory);
  return directory;
};
const daemons: EngineDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const model = (id: string, isDefault = false): ProviderModel => ({
  id,
  label: id,
  isDefault,
  hidden: false,
  hiddenByUser: false,
  efforts: [],
  fastMode: false,
  source: "provider",
});

/** The CLI's own answer. `claude-opus-5` is the default family here; the
 *  manifest is what turns it into the `[1m]` row Telar publishes. */
function engineWith(models: ProviderModel[], driver: "claude" | "codex" = "claude") {
  const catalogue = async (): Promise<ModelCatalogue> => ({ driver, instanceId: driver, readAt: 100, models });
  return new EngineStore(root(), () => 100, { models: catalogue });
}

/** Claim one turn and report the model the worker would be handed. */
async function claimedModel(
  engine: EngineStore,
  options: { driver?: "claude" | "codex"; sessionModel?: { instanceId: string; model?: string }; warm?: boolean } = {},
): Promise<string | undefined> {
  const driver = options.driver ?? "claude";
  if (options.warm !== false) await engine.modelCatalogue(driver);
  engine.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  engine.createSession({ id: "session_one", projectId: "project_one", driver });
  // The model is a session PATCH, not a creation field.
  if (options.sessionModel) engine.updateSession("session_one", { model: options.sessionModel });
  engine.submitTurn("session_one", { runId: "run_one", input: "hello" });
  return engine.claimNextTurn("worker_one")?.model?.model;
}

test("a session with NO model claims the catalogue's default at its long window", async () => {
  const engine = engineWith([model("claude-opus-5", true), model("claude-sonnet-5")]);
  // The manifest publishes `claude-opus-5[1m]` and carries `isDefault` onto it,
  // so this is the row the picker itself would have shown as default.
  expect(await claimedModel(engine)).toBe("claude-opus-5[1m]");
});

test("the family is the CLI's own — this changes the WINDOW, never which model runs", async () => {
  // A different default family produces a different answer: nothing here picks
  // a favourite, it spells whatever the provider already chose.
  const engine = engineWith([model("claude-opus-5"), model("claude-sonnet-5", true)]);
  expect(await claimedModel(engine)).toBe("claude-sonnet-5[1m]");
});

test("an OLD session saved with no model is covered at claim, with its history untouched", async () => {
  const engine = engineWith([model("claude-opus-5", true)]);
  await engine.modelCatalogue("claude");
  engine.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  // Saved before the window was a control: no model at all.
  engine.createSession({ id: "session_old", projectId: "project_one", driver: "claude" });

  engine.submitTurn("session_old", { runId: "run_one", input: "hello" });
  const claim = engine.claimNextTurn("worker_one");
  expect(claim?.model?.model).toBe("claude-opus-5[1m]");
  // The stored record is NOT rewritten: the claim decides what runs, it does
  // not edit what happened.
  expect(engine.getSession("session_old").model).toBeUndefined();
});

test("an EXPLICIT model keeps its exact semantics — known normalised, unknown untouched", async () => {
  const engine = engineWith([model("claude-opus-5", true)]);
  // A known bare id still gains the suffix, exactly as before.
  expect(await claimedModel(engine, { sessionModel: { instanceId: "claude", model: "claude-sonnet-5" } })).toBe("claude-sonnet-5[1m]");

  // An unknown id is left alone: no suffix invented, and the default never
  // overrides a choice somebody made.
  const other = engineWith([model("claude-opus-5", true)]);
  expect(await claimedModel(other, { sessionModel: { instanceId: "claude", model: "some-custom-build" } })).toBe("some-custom-build");
});

test("an EFFORT-ONLY selection keeps its effort and gains the model", async () => {
  // "The configured model, at maximum effort" is representable and ordinary
  // (see `ModelSelection`'s refine). Filling in the model must not drop what
  // the person actually chose, and the instanceId they picked is kept.
  const engine = engineWith([model("claude-opus-5", true)]);
  engine.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await engine.modelCatalogue("claude");
  engine.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  engine.updateSession("session_one", { model: { instanceId: "claude", effort: "max" } });
  engine.submitTurn("session_one", { runId: "run_one", input: "hello" });
  const claim = engine.claimNextTurn("worker_one");
  expect(claim?.model).toEqual({ instanceId: "claude", effort: "max", model: "claude-opus-5[1m]" });
});

test("a COLD catalogue changes nothing — no guess is ever made", async () => {
  // `claimNextTurn` is synchronous by design, so it reads the in-memory
  // catalogue and nothing else. With none, the behaviour is exactly today's.
  const engine = engineWith([model("claude-opus-5", true)]);
  expect(await claimedModel(engine, { warm: false })).toBeUndefined();
});

test("a default row that is NOT long is refused rather than pinned", async () => {
  // Haiku is `longWindow: false` in the manifest, so it publishes no `[1m]`
  // row. Filling it in would pin the 200k window this exists to avoid.
  const engine = engineWith([model("claude-haiku-4-5", true)]);
  expect(await claimedModel(engine)).toBeUndefined();
});

test("CODEX is untouched: no window to spell, no default filled in", async () => {
  const engine = engineWith([model("gpt-5.6-terra", true)], "codex");
  expect(await claimedModel(engine, { driver: "codex" })).toBeUndefined();
});


// ── the cold start: a fresh daemon whose picker has never been opened ────────

/** A daemon whose Claude list is served by `probe`, counting its reads. */
async function freshDaemon(probe: () => Promise<ModelCatalogue>, engineRoot = root()) {
  let reads = 0;
  const daemon = await startEngine({
    engineRoot,
    workerLeaseMs: 60_000,
    models: (async (driver: string) => {
      reads += 1;
      if (driver !== "claude") throw new Error(`the ${driver} CLI must not be probed here`);
      return probe();
    }) as never,
  });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery), reads: () => reads, engineRoot };
}

const claudeList = async (): Promise<ModelCatalogue> => ({
  driver: "claude",
  instanceId: "claude",
  readAt: 100,
  models: [model("claude-opus-5", true), model("claude-sonnet-5")],
});

test("a machine that has read the list ONCE covers its next daemon's very first turn", async () => {
  /**
   * The restart case, and the common one. Reading the list spawns the
   * provider's CLI, which a synchronous claim cannot do and a person's first
   * message must not wait for — so the default this machine last read is
   * remembered on disk and the claim reads THAT. Deterministic: the probe
   * below never resolves, and the turn is still covered.
   */
  const shared = root();
  const learn = await freshDaemon(claudeList, shared);
  // Opening the picker once is what teaches the machine.
  await learn.client.modelCatalogue("claude");
  await daemons.pop()!.close();

  const f = await freshDaemon(() => new Promise<ModelCatalogue>(() => {}), shared);
  await f.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await f.client.registerWorker("worker_one");
  await f.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  await f.client.submitTurn("session_one", { runId: "run_one", input: "hello" });
  const claim = await f.client.claimTurn("worker_one", 1);
  expect(claim.claim?.model?.model).toBe("claude-opus-5[1m]");
  expect(claim.claim?.model?.instanceId).toBe("claude");
});

test("REGRESSION: a fresh empty home NEVER hands the driver a short or absent model", async () => {
  /**
   * This replaces a test that accepted the first turn running at 200k. It does
   * not: the short-context rows were removed from this app on purpose, so a
   * turn whose window is not yet known is simply NOT CLAIMABLE. It waits — no
   * lease is taken, so nothing expires — and it is claimed as `[1m]` the moment
   * the list lands.
   */
  let release!: (value: ModelCatalogue) => void;
  const f = await freshDaemon(() => new Promise<ModelCatalogue>((resolve) => {
    release = resolve;
  }));
  await f.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await f.client.registerWorker("worker_one");
  await f.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  await f.client.submitTurn("session_one", { runId: "run_one", input: "hello" });

  // Nothing is handed out while the window is unknown — not a short model, not
  // an absent one. Polled as a worker would.
  for (let poll = 1; poll <= 3; poll += 1) {
    const attempt = await f.client.claimTurn("worker_one", poll);
    expect(attempt.claim).toBeUndefined();
  }
  // And the turn is still waiting, not expired or failed.
  expect((await f.client.session("session_one")).turns[0]?.state).toBe("queued");

  release(await claudeList());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const claim = await f.client.claimTurn("worker_one", 4);
  expect(claim.claim?.model?.model).toBe("claude-opus-5[1m]");
});

test("a probe that FAILS fails the turn with something actionable — no provider, no 200k, no hang", async () => {
  /**
   * The other half of refusing the short window: if the window cannot be known
   * at all, the turn must not run and must not wait for ever. It fails, saying
   * what to do, and no provider generation is ever started for it.
   */
  const f = await freshDaemon(async () => {
    throw new Error("claude is not installed");
  });
  await f.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await f.client.registerWorker("worker_one");
  await f.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  await f.client.submitTurn("session_one", { runId: "run_one", input: "hello" });

  let state: string | undefined;
  for (let poll = 1; poll <= 5 && state !== "failed"; poll += 1) {
    const attempt = await f.client.claimTurn("worker_one", poll);
    // Never claimed: no worker, therefore no provider, ever touches it.
    expect(attempt.claim).toBeUndefined();
    state = (await f.client.session("session_one")).turns[0]?.state;
    if (state !== "failed") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(state).toBe("failed");
  const failure = (await f.client.session("session_one")).turns[0]?.failure;
  expect(failure?.message).toContain("long-context Claude model");
  expect(failure?.message).toContain("Nothing was sent to the provider");
  // Actionable, not a dead end.
  // Actionable, and it names something that exists: there is no Settings →
  // Models section, the picker is the composer's pill.
  expect(failure?.message).toContain("composer's model picker");
  expect(failure?.message).toMatch(/retry/i);
  // One probe, not one per poll.
  expect(f.reads()).toBe(1);
});

test("a probe that NEVER answers becomes an actionable failure, not a turn pending for ever", async () => {
  /**
   * A hung provider used to leave the selection pending with nothing to end it:
   * the timeout only stopped waiting, it reached no verdict. It is now bounded
   * and retried like any other unusable answer.
   */
  const f = await freshDaemon(() => new Promise<ModelCatalogue>(() => {}));
  await f.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await f.client.registerWorker("worker_one");
  await f.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  await f.client.submitTurn("session_one", { runId: "run_one", input: "hello" });

  /**
   * THE LOOP HAS TO OUTLAST THE DEADLINE IT IS WAITING FOR. `prepareClaudeCatalogue`
   * gives the probe 2 000 ms before it reaches its verdict, and this loop used to
   * budget 30 × 60 ms = 1 800 ms — it only ever passed on the round-trip latency of
   * its own polls making up the other 200 ms. On a fast run it exhausted first and
   * failed on a turn that was still legitimately `queued`. 60 polls is 3 600 ms of
   * sleep alone, comfortably past the deadline and nowhere near the suite's 20 s
   * ceiling; the loop still exits the moment the verdict lands.
   */
  let state: string | undefined;
  for (let poll = 1; poll <= 60 && state !== "failed"; poll += 1) {
    const attempt = await f.client.claimTurn("worker_one", poll);
    // Never claimed: no provider is started for a window Telar cannot name.
    expect(attempt.claim).toBeUndefined();
    state = (await f.client.session("session_one")).turns[0]?.state;
    if (state !== "failed") await new Promise((resolve) => setTimeout(resolve, 60));
  }
  expect(state).toBe("failed");
});

test("a list that READS but publishes no long row terminates the turn — Haiku-only, and empty", async () => {
  /**
   * The other unusable answer, and the one that used to deadlock: the cache is
   * populated, so nothing retried, and no failure was ever recorded — the turn
   * simply waited for ever. Haiku is `longWindow: false` in the manifest, so it
   * publishes no `[1m]` row at all.
   */
  for (const models of [[model("claude-haiku-4-5", true)], [] as ProviderModel[]]) {
    const f = await freshDaemon(async () => ({ driver: "claude", instanceId: "claude", readAt: 100, models }));
    await f.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
    await f.client.registerWorker("worker_one");
    await f.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
    await f.client.submitTurn("session_one", { runId: "run_one", input: "hello" });

    const startedAt = Date.now();
    let state: string | undefined;
    for (let poll = 1; poll <= 10 && state !== "failed"; poll += 1) {
      expect((await f.client.claimTurn("worker_one", poll)).claim).toBeUndefined();
      state = (await f.client.session("session_one")).turns[0]?.state;
      if (state !== "failed") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state).toBe("failed");
    // Decided by READING the answer, not by waiting out the probe timeout: the
    // list arrived, it simply had nothing Telar can run.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  }
});

test("a coordinator following the session is WOKEN by the failure", async () => {
  /**
   * A turn that fails before any worker sees it is still a turn that failed,
   * and anyone waiting on it has to hear so — otherwise a coordinator waits on
   * a session that has already given up.
   */
  const f = await freshDaemon(async () => {
    throw new Error("claude is not installed");
  });
  await f.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await f.client.registerWorker("worker_one");
  await f.client.createSession({ id: "session_coordinator", projectId: "project_one", driver: "codex" });
  await f.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  await f.client.subscribe("session_coordinator", { targetSessionId: "session_one", events: ["turn_failed"] });
  await f.client.submitTurn("session_one", { runId: "run_one", input: "hello" });

  let failed = false;
  for (let poll = 1; poll <= 10 && !failed; poll += 1) {
    await f.client.claimTurn("worker_one", poll);
    failed = (await f.client.session("session_one")).turns[0]?.state === "failed";
    if (!failed) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(failed).toBe(true);
  // The wake landed as a turn on the coordinator's own queue.
  // The wake landed on the coordinator's own queue, naming the failed run.
  const coordinator = await f.client.session("session_coordinator");
  const wake = coordinator.turns.find((turn) => turn.wakeReason?.kind === "turn_failed");
  expect(wake?.wakeReason).toMatchObject({ kind: "turn_failed", sessionId: "session_one", runId: "run_one" });
  expect(wake?.input).toContain("[wake: failed]");
});

test("the probe happens ONCE, not per claim — and never for a Codex-only queue", async () => {
  const f = await freshDaemon(claudeList);
  await f.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await f.client.registerWorker("worker_one");
  // A Codex session alone must not make this machine read a Claude CLI.
  await f.client.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
  await f.client.submitTurn("session_codex", { runId: "run_codex", input: "hi" });

  const codex = await f.client.claimTurn("worker_one", 1);
  expect(codex.claim?.model).toBeUndefined();
  expect(f.reads()).toBe(0);
  await f.client.stopTurn("session_codex", "run_codex");

  // Now a Claude turn: one read, and the next claim reuses the cache.
  await f.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  await f.client.submitTurn("session_one", { runId: "run_one", input: "hello" });
  const first = await f.client.claimTurn("worker_one", 2);
  expect(first.claim?.model?.model).toBe("claude-opus-5[1m]");
  expect(f.reads()).toBe(1);
  await f.client.stopTurn("session_one", "run_one");

  await f.client.submitTurn("session_one", { runId: "run_two", input: "again" });
  const second = await f.client.claimTurn("worker_one", 3);
  expect(second.claim?.model?.model).toBe("claude-opus-5[1m]");
  expect(f.reads()).toBe(1);
});

test("a RESTART re-reads the list, so the second daemon's first turn is covered too", async () => {
  const shared = root();
  const first = await freshDaemon(claudeList, shared);
  await first.client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await first.client.registerWorker("worker_one");
  await first.client.createSession({ id: "session_one", projectId: "project_one", driver: "claude" });
  await first.client.submitTurn("session_one", { runId: "run_one", input: "hello" });

  const before = await first.client.claimTurn("worker_one", 1);
  expect(before.claim?.model?.model).toBe("claude-opus-5[1m]");
  await first.client.stopTurn("session_one");
  await daemons.pop()!.close();

  // The cache is per-process, so a fresh daemon starts cold — and covers its
  // own first claim rather than inheriting anything.
  const second = await freshDaemon(claudeList, shared);
  await second.client.registerWorker("worker_two");
  await second.client.submitTurn("session_one", { runId: "run_two", input: "again" });

  const after = await second.client.claimTurn("worker_two", 1);
  expect(after.claim?.model?.model).toBe("claude-opus-5[1m]");
  // Remembered on disk, so the restart costs no provider subprocess at all.
  expect(second.reads()).toBe(0);
});
