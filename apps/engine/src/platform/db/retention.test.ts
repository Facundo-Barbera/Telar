import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { ExecutionStore } from "./execution-store";

const homes: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) { try { close(); } catch { /* already closed */ } }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-01-01T00:00:00Z");
const window = (days: number, now: number) => ({ idleBefore: now - days * DAY, now });

type Built = { home: string; exportTo: string; events: Record<string, number>; cursors: Record<string, number> };

function build(plan: (engine: EngineStore, set: (at: number) => void) => void): Built {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-retention-"));
  homes.push(home);
  let clock = START;
  const engine = new EngineStore(home, () => clock);
  engine.projectRegistry.register({ id: "project_one", name: "one", root: "/tmp" });
  plan(engine, (at) => { clock = at; });
  const events: Record<string, number> = {};
  const cursors: Record<string, number> = {};
  for (const session of engine.live.list("project_one")) {
    events[session.id] = engine.queries.readEvents(session.id).length;
    cursors[session.id] = engine.queries.eventCursor(session.id);
  }
  engine.kernel.executionStore.close();
  return { home, exportTo: path.join(home, "exports"), events, cursors };
}

/** One session with `turns` finished turns, each streamed and then completed —
 *  so its journal holds deltas, item events and a terminal turn event, and its
 *  `turn_summaries` row is written by the path production uses. */
function conversation(engine: EngineStore, sessionId: string, turns = 2): void {
  engine.lifecycle.createSession({ id: sessionId, projectId: "project_one" });
  for (let turn = 0; turn < turns; turn += 1) {
    const runId = `run_${turn}`;
    engine.intake.submitTurn(sessionId, { runId, input: `ask ${turn}` });
    const token = engine.claims.claimTurn(sessionId, "worker_one")!.claim!.token;
    engine.turnLifecycle.markRunning(sessionId, runId, token);
    engine.ingest.ingestObservations(sessionId, runId, token, [
      { kind: "item.started", item: { id: `item_${turn}`, title: "answering", detail: { type: "assistant_message", text: "" } } },
      { kind: "content.delta", itemId: `item_${turn}`, stream: "assistant_text", text: "part one " },
      { kind: "content.delta", itemId: `item_${turn}`, stream: "assistant_text", text: "part two" },
      { kind: "item.completed", itemId: `item_${turn}`, status: "completed", detail: { type: "assistant_message", text: "part one part two" } },
    ]);
    engine.turnLifecycle.completeTurn(sessionId, runId, token, { text: `answer ${turn}` });
    // READ, so the session is not held out of every window by its own unread
    // result. That exemption has a test of its own below.
    engine.records.markRead(sessionId, runId);
  }
}

/** The same root, reopened as the bare store the mechanism lives on. */
function reopen(built: Built): ExecutionStore {
  const store = new ExecutionStore(built.home);
  closers.push(() => store.close());
  return store;
}

function reopenEngine(built: Built, now: number): EngineStore {
  const engine = new EngineStore(built.home, () => now);
  closers.push(() => engine.kernel.executionStore.close());
  return engine;
}

test("the sweep takes exactly the sessions past the window, and nothing else", () => {
  const built = build((engine, set) => {
    conversation(engine, "session_old");
    set(START + 20 * DAY);
    conversation(engine, "session_recent");
    set(START + 21 * DAY);
  });
  const store = reopen(built);
  const now = START + 21 * DAY;
  expect(store.retireJournal(window(7, now), { exportTo: built.exportTo }))
    .toEqual({ retired: 1, skipped: 0, events: built.events.session_old! });
  expect(store.events("session_old")).toHaveLength(0);
  // THE OTHER HALF, and it is the one that proves the predicate is live: a
  // sweep that deleted everything would also pass the assertion above.
  expect(store.events("session_recent")).toHaveLength(built.events.session_recent!);
});

test("…and nothing at all when the window is wider than the store is old", () => {
  const built = build((engine, set) => { conversation(engine, "session_one"); set(START + 3 * DAY); });
  const store = reopen(built);
  // A SWEEP THAT DELETES NOTHING PASSES "NO DATA LOST" TRIVIALLY, so the
  // do-nothing direction is asserted on its own numbers rather than inferred.
  expect(store.retireJournal(window(30, START + 3 * DAY), { exportTo: built.exportTo }))
    .toEqual({ retired: 0, skipped: 0, events: 0 });
  expect(store.events("session_one")).toHaveLength(built.events.session_one!);
});

test("the same store, two clocks: the qualifying set is the clock's answer and not a constant", () => {
  const built = build((engine) => { conversation(engine, "session_one"); });
  const store = reopen(built);
  const early = store.retentionPreview(window(7, START + 3 * DAY));
  const late = store.retentionPreview(window(7, START + 30 * DAY));
  // BREAK IT BY FREEZING `now` AND THESE TWO BECOME EQUAL — which is exactly
  // the failure `perf-marks.test.ts` shipped with.
  expect(early).toEqual({ sessions: 0, events: 0 });
  expect(late).toEqual({ sessions: 1, events: built.events.session_one! });
});

test("the preview is the sweep's own count — sessions, rows and bytes all agree", () => {
  const built = build((engine) => { conversation(engine, "session_one", 3); conversation(engine, "session_two", 2); });
  const store = reopen(built);
  const now = START + 30 * DAY;
  const preview = store.retentionPreview(window(7, now), { bytes: true });
  expect(preview.sessions).toBe(2);
  expect(preview.events).toBe(built.events.session_one! + built.events.session_two!);
  expect(preview.bytes).toBeGreaterThan(0);

  const swept = store.retireJournal(window(7, now), { exportTo: built.exportTo });
  // ONE QUERY, NOT TWO THAT AGREE TODAY. A preview computed separately from
  // the sweep is a number that will drift and be believed.
  expect(swept.retired).toBe(preview.sessions);
  expect(swept.events).toBe(preview.events);
  expect(store.retentionPreview(window(7, now), { bytes: true })).toEqual({ sessions: 2, events: 0, bytes: 0 });
});

test("bytes are absent unless a reader asks for them", () => {
  const built = build((engine) => { conversation(engine, "session_one"); });
  const store = reopen(built);
  // THE EXPENSIVE HALF IS OPT-IN. Counts are index ranges; the byte sum reads
  // every row's text, which on a gigabyte is a real scan (#629).
  expect(store.retentionPreview(window(7, START + 30 * DAY)).bytes).toBeUndefined();
  expect(store.retentionPreview(window(7, START + 30 * DAY), { bytes: true }).bytes).toBeGreaterThan(0);
});

test("an unread result and a live turn are never taken, however old", () => {
  const built = build((engine) => {
    // Completed but never read: `hasUnreadResult` holds it out, because the
    // clock's premise is "nothing happened here" and an answer waiting to be
    // read IS something that happened.
    engine.lifecycle.createSession({ id: "session_unread", projectId: "project_one" });
    engine.intake.submitTurn("session_unread", { runId: "run_one", input: "ask" });
    const token = engine.claims.claimTurn("session_unread", "worker_one")!.claim!.token;
    engine.turnLifecycle.markRunning("session_unread", "run_one", token);
    engine.turnLifecycle.completeTurn("session_unread", "run_one", token, { text: "answer" });
    // Claimed and running: a live turn outranks everything, including a pin.
    engine.lifecycle.createSession({ id: "session_live", projectId: "project_one" });
    engine.intake.submitTurn("session_live", { runId: "run_live", input: "ask" });
    const live = engine.claims.claimTurn("session_live", "worker_two")!.claim!.token;
    engine.turnLifecycle.markRunning("session_live", "run_live", live);
  });
  const store = reopen(built);
  expect(store.retireJournal(window(7, START + 400 * DAY), { exportTo: built.exportTo }))
    .toEqual({ retired: 0, skipped: 0, events: 0 });
  expect(store.events("session_unread")).toHaveLength(built.events.session_unread!);
  expect(store.events("session_live")).toHaveLength(built.events.session_live!);
});

test("an archived session is eligible, not exempt", () => {
  const built = build((engine) => { conversation(engine, "session_one"); engine.lifecycle.archiveSession("session_one"); });
  const store = reopen(built);
  expect(store.retireJournal(window(7, START + 30 * DAY), { exportTo: built.exportTo }).retired).toBe(1);
  expect(store.events("session_one")).toHaveLength(0);
});

test("#646's guard: a session missing a turn summary is skipped and counted, not swept", () => {
  const built = build((engine) => { conversation(engine, "session_one", 2); });
  const store = reopen(built);
  store.deleteTurnSummary("session_one", "run_0");
  expect(store.retireJournal(window(7, START + 30 * DAY), { exportTo: built.exportTo }))
    .toEqual({ retired: 0, skipped: 1, events: 0 });
  expect(store.events("session_one")).toHaveLength(built.events.session_one!);
});

test("#646's guard, the other way: a session whose documents will not read is skipped too", () => {
  const built = build((engine) => { conversation(engine, "session_one", 2); conversation(engine, "session_two", 2); });
  const store = reopen(built);
  store.writeText(path.join(built.home, "sessions", "session_one", "items.json"), "{ not json at all");
  expect(store.retireJournal(window(7, START + 30 * DAY), { exportTo: built.exportTo }))
    .toEqual({ retired: 1, skipped: 1, events: built.events.session_two! });
  expect(store.events("session_one")).toHaveLength(built.events.session_one!);
  expect(store.events("session_two")).toHaveLength(0);
});

test("the rail survives: the row, its summaries and its search row outlive the journal", () => {
  const built = build((engine) => { conversation(engine, "session_one", 2); });
  const store = reopen(built);
  expect(store.retireJournal(window(7, START + 30 * DAY), { exportTo: built.exportTo }).retired).toBe(1);
  expect(store.read(path.join(built.home, "sessions", "session_one", "session.json"))).toBeDefined();
  store.close();

  const engine = reopenEngine(built, START + 31 * DAY);
  expect(engine.records.get("session_one").id).toBe("session_one");
  expect(engine.queries.readEvents("session_one")).toHaveLength(0);
  expect(engine.queries.turnOutline("session_one", { limit: 10 }).turns).toHaveLength(2);
});

test("the id floor: emptying a journal does not restart the session's event ids", () => {
  const built = build((engine) => { conversation(engine, "session_one", 2); });
  const highest = built.cursors.session_one!;
  expect(highest).toBeGreaterThan(1);
  const store = reopen(built);
  expect(store.retireJournal(window(7, START + 30 * DAY), { exportTo: built.exportTo }).retired).toBe(1);
  store.close();

  const engine = reopenEngine(built, START + 31 * DAY);
  expect(engine.queries.eventCursor("session_one")).toBe(highest);
  engine.intake.submitTurn("session_one", { runId: "run_after", input: "again" });
  expect(engine.queries.readEvents("session_one")[0]!.id).toBeGreaterThan(highest);
});

test("a delete returns no bytes; only Reclaim does", () => {
  const built = build((engine) => { conversation(engine, "session_one", 4); });
  const store = reopen(built);
  const weigh = () => ["", "-wal", "-shm"]
    .reduce((bytes, suffix) => bytes + (fs.statSync(path.join(built.home, `execution.sqlite${suffix}`), { throwIfNoEntry: false })?.size ?? 0), 0);
  const before = weigh();
  expect(store.retireJournal(window(7, START + 30 * DAY), { exportTo: built.exportTo }).retired).toBe(1);
  expect(weigh()).toBeGreaterThanOrEqual(before);
  // …and Reclaim is the half that does. `before`/`after` are its own figures,
  // taken either side of the compaction and the rewrite.
  const reclaimed = store.reclaim();
  expect(reclaimed.after).toBeLessThan(reclaimed.before);
  expect(weigh()).toBeLessThan(before);
});

test("the export is the copy, and its line count is what licenses the delete", () => {
  const built = build((engine) => { conversation(engine, "session_one", 2); });
  const store = reopen(built);
  expect(store.retireJournal(window(7, START + 30 * DAY), { exportTo: built.exportTo }).retired).toBe(1);
  const directory = path.join(built.exportTo, "session_one", "sessions", "session_one");
  const lines = fs.readFileSync(path.join(directory, "events.ndjson"), "utf8").split("\n").filter(Boolean);
  // LINE COUNT AGAINST ROW COUNT, which is the strongest "lossless by
  // construction" available when the thing being dropped has no surviving copy
  // to compare against: the export IS the copy and the count is the comparison.
  expect(lines).toHaveLength(built.events.session_one!);
  expect(JSON.parse(lines[0]!).sessionId).toBe("session_one");
  // The documents beside it, in `exportLegacy`'s own shape — and NOT the
  // derived offset indexes, whose offsets describe this store's compact text.
  expect(fs.existsSync(path.join(directory, "session.json"))).toBe(true);
  expect(fs.existsSync(path.join(directory, "queue.json"))).toBe(true);
  expect(fs.existsSync(path.join(directory, "items.index.json"))).toBe(false);
  const items = JSON.parse(fs.readFileSync(path.join(directory, "items.json"), "utf8")) as { items: Array<{ id: string }> };
  expect(items.items.map((item) => item.id)).toEqual(["item_0", "item_1"]);
});

test("a per-session export pages rather than materialising the whole journal", () => {
  const built = build((engine) => {
    // More than one page (`EXPORT_PAGE` is 1,000) so the paging is exercised
    // rather than merely present.
    engine.lifecycle.createSession({ id: "session_big", projectId: "project_one" });
    engine.intake.submitTurn("session_big", { runId: "run_one", input: "ask" });
    const token = engine.claims.claimTurn("session_big", "worker_one")!.claim!.token;
    engine.turnLifecycle.markRunning("session_big", "run_one", token);
    engine.ingest.ingestObservations("session_big", "run_one", token, [
      { kind: "item.started", item: { id: "item_one", title: "answering", detail: { type: "assistant_message", text: "" } } },
      ...Array.from({ length: 1_200 }, () => ({ kind: "content.delta" as const, itemId: "item_one", stream: "assistant_text" as const, text: "x" })),
    ]);
    engine.turnLifecycle.completeTurn("session_big", "run_one", token, { text: "done" });
  });
  const store = reopen(built);
  const destination = path.join(built.home, "one-off");
  const exported = store.exportSession("session_big", destination);
  expect(exported.events).toBe(built.events.session_big!);
  expect(exported.events).toBeGreaterThan(1_000);
  const lines = fs.readFileSync(path.join(destination, "sessions", "session_big", "events.ndjson"), "utf8").split("\n").filter(Boolean);
  expect(lines).toHaveLength(exported.events);
  // A destination that exists is refused, exactly as `exportLegacy` refuses one.
  expect(() => store.exportSession("session_big", destination)).toThrow(/must not already exist/);
});

// ══════════════ THE POLICY, WHICH IS THE STATE LAYER'S HALF ══════════════

test("the default is never, and a window with nowhere to export is refused", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-retention-policy-"));
  homes.push(home);
  const engine = new EngineStore(home, () => START);
  closers.push(() => engine.kernel.executionStore.close());
  expect(engine.settings.retention()).toEqual({ idleAfterDays: null, exportTo: null });
  // A DELETE MUST NOT BE REACHABLE BY ACCIDENT. Enabling a window with no copy
  // to fall back on is the one shape the approved design rules out, so it is a
  // refusal rather than a setting that looks on and does nothing.
  expect(() => engine.settings.setRetention({ idleAfterDays: 7 })).toThrow(/export/);
  expect(engine.settings.retention().idleAfterDays).toBeNull();
  expect(() => engine.settings.setRetention({ idleAfterDays: 7, exportTo: "relative/path" })).toThrow(/absolute/);
  expect(() => engine.settings.setRetention({ idleAfterDays: 0, exportTo: path.join(home, "out") })).toThrow(/between/);
  engine.settings.setRetention({ idleAfterDays: 7, exportTo: path.join(home, "out") });
  expect(engine.settings.retention()).toEqual({ idleAfterDays: 7, exportTo: path.join(home, "out") });
});

test("a hand-edited retention document costs the preference and never the history", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-retention-broken-"));
  homes.push(home);
  const engine = new EngineStore(home, () => START);
  closers.push(() => engine.kernel.executionStore.close());
  for (const document of ["{ not json at all", JSON.stringify({ idleAfterDays: "soon", exportTo: 7 })]) {
    fs.writeFileSync(path.join(home, "retention.json"), document);
    expect(engine.settings.retention()).toEqual({ idleAfterDays: null, exportTo: null });
  }
});

test("with the default in place the sweep reads nothing and takes nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-retention-off-"));
  homes.push(home);
  let clock = START;
  const engine = new EngineStore(home, () => clock);
  closers.push(() => engine.kernel.executionStore.close());
  engine.projectRegistry.register({ id: "project_one", name: "one", root: "/tmp" });
  conversation(engine, "session_one");
  const before = engine.queries.readEvents("session_one").length;
  clock = START + 400 * DAY;
  expect(engine.settings.sweepRetention()).toEqual({ retired: 0, skipped: 0, events: 0 });
  expect(engine.queries.readEvents("session_one")).toHaveLength(before);
  // And the preview still answers, because reading what a window WOULD take is
  // not the same act as taking it.
  expect(engine.settings.retentionPreview().map((bucket) => bucket.days)).toEqual([7, 14, 30, 60]);
  expect(engine.settings.retentionPreview().find((bucket) => bucket.days === 7)?.sessions).toBe(1);
});

test("the configured window sweeps through the policy, end to end", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-retention-on-"));
  homes.push(home);
  let clock = START;
  const engine = new EngineStore(home, () => clock);
  closers.push(() => engine.kernel.executionStore.close());
  engine.projectRegistry.register({ id: "project_one", name: "one", root: "/tmp" });
  conversation(engine, "session_one");
  const before = engine.queries.readEvents("session_one").length;
  clock = START + 30 * DAY;
  engine.settings.setRetention({ idleAfterDays: 7, exportTo: path.join(home, "exports") });
  expect(engine.settings.sweepRetention()).toEqual({ retired: 1, skipped: 0, events: before });
  expect(engine.queries.readEvents("session_one")).toHaveLength(0);
  // The conversation is still a conversation: the rail row and the outline are
  // backed by documents and `turn_summaries`, neither of which this touched.
  expect(engine.records.get("session_one").id).toBe("session_one");
  expect(engine.queries.turnOutline("session_one", { limit: 10 }).turns).toHaveLength(2);
});
