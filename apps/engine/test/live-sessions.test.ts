/**
 * THE ROUTE EVERY COCKPIT POLLS — issue #459.
 *
 * `GET /v2/sessions/live` is the most-served read on the engine: each cockpit
 * asks for it on a timer, for every paired host, for as long as it is open.
 * Measured on the owner's store (267 sessions, 724 MB) it answered 317,813
 * bytes in 200 ms, and the engine sat at 65–78% CPU with a Mac and a phone
 * attached. Most of those bytes were fields no rail has ever drawn.
 *
 * These tests pin the two halves of the fix: WHICH KEYS reach the wire, and
 * what a store the size of the owner's actually costs.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine } from "../src/daemon";
import { EngineStore } from "../src/state";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A checkout path the length of a real one, so the bytes below are not an
 *  artefact of `/tmp`: the owner's sessions live under
 *  `~/Library/Application Support/Telar/engine/worktrees/<branch-slug>-<hash>`. */
const checkout = (): string => {
  const directory = path.join(root(), "Library", "Application Support", "Telar", "engine", "worktrees", "459-lean-live-list-cursor-not-poll-5e1ea4-f08495d8");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

/** Everything the record can hold that a rail never reads, set through the
 *  public API — otherwise the saving measured below is a saving on absent
 *  fields, which is not a saving at all. */
function loadedStore(count: number): EngineStore {
  const store = new EngineStore(root(), () => 1_700_000_000_000);
  store.registerProject({ id: "project_one", name: "Telar", root: checkout() });
  for (let index = 0; index < count; index += 1) {
    const id = `session_${index.toString(16).padStart(8, "0")}b2c3d4e5f60718293a4b5c`;
    store.createSession({ id, projectId: "project_one", title: `Lean the live list: cursor, not poll (${index})` });
    store.updateSession(id, {
      model: { instanceId: "claude", model: "claude-opus-5[1m]", effort: "high" },
      runtimeMode: "full-access",
      detached: true,
      resumeAfterRateLimit: true,
      ...(index % 3 === 0 ? { settledOverride: "settled" as const } : {}),
      ...(index % 5 === 0 ? { snoozedUntil: 1_700_000_900_000 } : {}),
    });
  }
  return store;
}

test("the live list answers rows, not whole sessions — every key a rail draws and none it does not", () => {
  const store = loadedStore(1);
  // `all` because this is about the row's SHAPE, not about which rows are on
  // it — and session 0 is one of the fixture's pinned-settled third (#457).
  const [row] = store.liveSessionRows({ all: true }).sessions;
  const [full] = store.liveSessions().sessions;
  expect(row).toBeDefined();
  expect(full).toBeDefined();

  /**
   * ENGINE BOOKKEEPING, GONE FROM THE WIRE. Each of these is read by the
   * session surface (`GET /v2/sessions/:id`), by the worker, or by nobody — and
   * each was being serialized for 267 rows several times a second. The full
   * record still carries them, which is what `?full=1` serves.
   */
  for (const key of ["environmentId", "providerInstanceId", "runtimeMode", "interactionMode", "detached", "resumeCursor", "resumeAfterRateLimit", "unsettledAssignments", "agentMessagesBlocked", "paused", "origin"]) {
    expect(row).not.toHaveProperty(key);
  }
  // The four this fixture can actually set are on the full record, so the
  // absences above are the projection's doing and not the fixture's.
  for (const key of ["environmentId", "providerInstanceId", "runtimeMode", "detached", "resumeAfterRateLimit"]) {
    expect(full).toHaveProperty(key);
  }
  // The commit a checkout was cut from is a review surface's question, asked
  // once per session opened — not 267 times a poll.
  expect(row!.workspace).not.toHaveProperty("baseRef");

  /** WHAT A ROW ACTUALLY RENDERS, and it has to be all of it: the rail's
   *  projection (`toSidebarSession`) reads every one of these, and a row that
   *  lost one would draw a blank rather than fail. */
  for (const key of ["id", "projectId", "title", "state", "createdAt", "updatedAt", "driver", "model", "envMode", "workspace", "activity", "settledOverride", "settledAt"]) {
    expect(row).toHaveProperty(key);
  }
  // Absent rather than null: `JSON.stringify` drops the one and spends bytes on
  // the other, and the point of the whole exercise is the bytes.
  expect(Object.values(row as Record<string, unknown>)).not.toContain(undefined);
});

test("a 267-session store answers the live list in a fraction of what it used to", () => {
  // The owner's store, to the session: 267 live conversations.
  const store = loadedStore(267);
  // `all` on both sides: this measures the PROJECTION, so the two answers have
  // to describe the same 267 rows. What the narrower default is worth on top of
  // it is the test below (#457).
  const wide = store.liveSessionRows({ all: true });
  const full = JSON.stringify(store.liveSessions()).length;
  const lean = JSON.stringify(wide).length;

  expect(wide.sessions).toHaveLength(267);
  /**
   * THE BOUND IS PER ROW, not per answer, because it is the per-row cost that
   * multiplies: 267 sessions today, more next month, and the same read on every
   * tick per paired host either way. Measured on this fixture: 726 bytes a row
   * whole, 572 as a row. 600 is the ceiling that catches a field creeping back
   * onto the wire without pinning the exact byte count.
   *
   * WHY NOT THE 40 KB THE ISSUE ASKED FOR, WHICH IS 153 BYTES A ROW. Because
   * `workspace` alone is 216 of these 572: an absolute checkout path, which the
   * rail's row menu copies and its subtitle falls back to. Getting under 40 KB
   * means the row stops carrying the path, the model, the created stamp and the
   * usage figures — every one of which something draws today. The cold read is
   * as small as it can be while the rail draws what it draws; what takes the
   * STEADY state under 40 KB is `?since=`, which sends only the rows that moved.
   *
   * REAL ROWS ARE HEAVIER THAN THESE, and so is the saving: a fixture cannot
   * cheaply carry a resume cursor, a usage ledger, a `startedFrom` or an
   * un-settle ledger, and the whole record carries all four on the owner's
   * store while a row carries one.
   */
  expect(lean / 267).toBeLessThan(600);
  expect(lean).toBeLessThan(full);
});

test("the shapes disagree about rows and about nothing else", () => {
  // The escape hatch is the OLD method, unchanged — not a second projection
  // that could drift from it. A client asking for either must not find itself
  // reading a different LIST.
  const store = loadedStore(3);
  const full = store.liveSessions();
  const lean = store.liveSessionRows({ all: true });
  expect(lean.sessions.map((session) => session.id)).toEqual(full.sessions.map((session) => session.id));
  expect(lean.projects).toEqual(full.projects);
  expect(lean.layout).toEqual(full.layout);
  expect(lean.assignments).toEqual(full.assignments);
});

/**
 * THE MEASUREMENT #457 ASKED FOR — what the route costs before and after the
 * default narrowed, on the same store.
 *
 * THE FIXTURE'S SHELF IS THE PIN, NOT THE CLOCK. `loadedStore` builds every
 * session at one fixed instant and the store's clock is that same instant, so
 * nothing is stale and the only settled rows are the third that carry
 * `settledOverride: "settled"`. The owner's real store is the other way round —
 * 284 of 291 settled, nearly all of them by the inactivity clock — so the
 * saving measured here (a third) is the FLOOR of the saving in production
 * (97%), not an estimate of it.
 */
test("the default answer carries only the rows a rail draws, and says how many it kept", () => {
  const store = loadedStore(267);
  const before = store.liveSessionRows({ all: true });
  const after = store.liveSessionRows();

  // Every third session is pinned settled by the fixture.
  const settled = Math.ceil(267 / 3);
  expect(before.sessions).toHaveLength(267);
  expect(after.sessions).toHaveLength(267 - settled);
  // The count rides BOTH answers: the narrow one needs it to draw a shelf
  // header, and the wide one must not contradict the narrow one about it.
  expect(after.settledCount).toBe(settled);
  expect(before.settledCount).toBe(settled);

  // And the bytes, which are the point. Bounded as a RATIO rather than a byte
  // count for the reason the per-row bound above is a ratio: the fixture's
  // rows are lighter than the owner's, and it is the proportion that carries
  // over to a store where 284 of 291 are settled.
  const wide = JSON.stringify(before).length;
  const narrow = JSON.stringify(after).length;
  expect(narrow).toBeLessThan(wide * 0.75);

  // NOT ONE OF THE DROPPED ROWS IS REACHABLE from the narrow answer, including
  // through the assignment map — an entry keyed by a session the reader cannot
  // see is bytes describing a conversation that is not there.
  const kept = new Set(after.sessions.map((session) => session.id));
  for (const id of Object.keys(after.assignments)) expect(kept.has(id)).toBe(true);
});

/**
 * ISSUE #464, PINNED ON THE THING IT IS ABOUT: how many times the pass opens
 * each queue.
 *
 * SPYING ON A PRIVATE METHOD, deliberately. The claim is not about an answer —
 * both shapes were correct before and after — it is about the WORK, and the
 * only honest way to fail when the work comes back is to count it. `readQueue`
 * is where the sqlite read, the `JSON.parse` and the `TurnSchema` validation
 * all happen, so it is the call that costs what this issue measured.
 */
test("the live fold opens each session's queue once, and an archived one not at all", () => {
  const store = new EngineStore(root(), () => 1_700_000_000_000);
  store.registerProject({ id: "project_one", name: "Telar", root: checkout() });
  const ids = ["session_aaaaaaaa1111111111111111111111", "session_bbbbbbbb2222222222222222222222", "session_cccccccc3333333333333333333333"];
  for (const id of ids) store.createSession({ id, projectId: "project_one", title: id });
  store.archiveSession(ids[2]!);

  const spied = store as unknown as { readQueue(sessionId: string): { turns: unknown[] } };
  const original = spied.readQueue.bind(store);
  const opened: string[] = [];
  spied.readQueue = (sessionId: string) => {
    opened.push(sessionId);
    return original(sessionId);
  };

  const answer = store.liveSessionRows({ all: true });
  expect(answer.sessions).toHaveLength(2);
  // ONCE EACH. It was twice — the activity fold read one copy and the
  // assignment fold read another of the same document, moments apart. Sorted
  // because the pass reads in the store's own order and sorts afterwards; the
  // claim here is the COUNT, not the order.
  expect(opened.sort()).toEqual([ids[0]!, ids[1]!].sort());
  // And the archived one is never opened: its state is in the metadata
  // document, so it is answerable before the expensive read rather than after.
  expect(opened).not.toContain(ids[2]!);
});

test("a blocker, a pin and a draft all survive the filter — the rows it must never drop", () => {
  const now = 1_700_000_000_000;
  const store = new EngineStore(root(), () => now);
  store.registerProject({ id: "project_one", name: "Telar", root: checkout() });
  // An hour is the shortest window the policy allows, and every session below
  // is stamped `now`, so NOTHING is stale: this isolates the guards from the
  // clock. The clock's own case is the 267-session test above.
  store.setInboxPolicy({ autoSettleAfterHours: 1 });

  const make = (suffix: string): string => {
    const id = `session_${suffix.padEnd(30, "0")}`;
    store.createSession({ id, projectId: "project_one", title: suffix });
    return id;
  };

  const pinnedSettled = make("settled");
  store.updateSession(pinnedSettled, { settledOverride: "settled" });
  const pinnedActive = make("active");
  store.updateSession(pinnedActive, { settledOverride: "active" });
  // A DRAFT IS NEVER SHELVED BY THE CLOCK. `isStale` is true of every draft
  // ever opened — an unsent conversation has done nothing to measure — so
  // without the carve-out this row would vanish off the rail a window after
  // the composer opened it. See `isShelved`.
  const draft = make("draft");
  store.updateSession(draft, { draft: {} });
  // A SETTLED PIN STILL TAKES A DRAFT: the carve-out is against the clock, not
  // against a person's decision.
  const settledDraft = make("draftsettled");
  store.updateSession(settledDraft, { draft: {}, settledOverride: "settled" });

  const rows = new Set(store.liveSessionRows().sessions.map((session) => session.id));
  expect(rows.has(pinnedActive)).toBe(true);
  expect(rows.has(draft)).toBe(true);
  expect(rows.has(pinnedSettled)).toBe(false);
  expect(rows.has(settledDraft)).toBe(false);
  expect(store.liveSessionRows().settledCount).toBe(2);
  // And `?all=1` is the same list with nothing held back.
  expect(store.liveSessionRows({ all: true }).sessions).toHaveLength(4);
});

test("the revision moves when the list would, and not when only a transcript grows", () => {
  const store = loadedStore(2);
  const first = store.sessionsRevision();
  // A read is a read: nothing about asking changes the answer.
  store.liveSessionRows();
  store.liveSessionRows();
  expect(store.sessionsRevision()).toBe(first);

  // Anything the fold reads moves it. Renaming a session is the cheapest proof:
  // it writes `session.json`, which is a row.
  store.updateSession(store.liveSessionRows().sessions[0]!.id, { title: "Renamed" });
  expect(store.sessionsRevision()).toBeGreaterThan(first);

  // And the answer carries the number a client should hand back.
  const answer = store.liveSessionRows();
  expect(answer.revision).toBe(store.sessionsRevision());
});

test("an unchanged answer costs almost nothing, which is the whole point", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    const first = await client.liveSessions();
    const revision = first.revision;
    expect(revision).toBeDefined();

    /**
     * THE IDLE TICK. A cockpit holding a current cursor is told to keep what it
     * has — no rows, no projects, no fold over anything — and `daemonId` rides
     * along so a rail that had not cached it still needs no second request.
     */
    const again = await client.liveSessionsSince(revision!);
    expect(again.unchanged).toBe(true);
    expect(again.revision).toBe(revision);
    expect(again.daemonId).toBe(daemon.discovery.daemonId);
    expect(again).not.toHaveProperty("sessions");
    // Sixty-odd bytes against a store's worth of rows. Bounded loosely because
    // the claim is the ORDER OF MAGNITUDE, not the byte.
    expect(JSON.stringify(again).length).toBeLessThan(200);

    // Something moves, and the next ask with the same cursor is a full answer
    // again — with a new cursor on it.
    await client.updateSession("session_one", { title: "Renamed" });
    const moved = await client.liveSessionsSince(revision!);
    expect(moved.unchanged).toBeUndefined();
    expect((moved as { sessions: Array<{ title: string }> }).sessions[0]?.title).toBe("Renamed");
    expect(moved.revision).toBeGreaterThan(revision!);

    /**
     * A CURSOR FROM A DEAD DAEMON IS NOT "UNCHANGED". The counter is in memory
     * and seeded from the clock, so a client holding last week's number is told
     * to re-read rather than handed a frozen rail — the one failure mode of a
     * conditional read that a reader cannot see and cannot recover from.
     */
    const stale = await client.liveSessionsSince(1);
    expect(stale.unchanged).toBeUndefined();
    // And so is a cursor that is not a number at all.
    const nonsense = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/sessions/live?since=soon`, {
      headers: { authorization: `Bearer ${daemon.discovery.token}` },
    });
    expect(nonsense.status).toBe(200);
    expect((await nonsense.json()) as { unchanged?: boolean }).not.toHaveProperty("unchanged");
  } finally {
    await daemon.close();
  }
});

/**
 * ISSUE #457, STEP 3 — the conditional read spelled the way HTTP spells it.
 *
 * WHY IT EXISTS BESIDE `?since=`, which already answers an idle tick in sixty
 * bytes. Three things the body cursor cannot do: a 304 carries no body at all;
 * the MODE is inside the tag, so the wide read can be conditional too (a cursor
 * cannot, because the revision does not move when a reader opens a shelf); and
 * it is the standard spelling, so anything that speaks HTTP gets the cheap tick
 * without knowing about this engine's query parameters.
 */
test("an ETag answers the tick, and the tag knows which list it described", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  const ask = (query: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/sessions/live${query}`, {
      headers: { authorization: `Bearer ${daemon.discovery.token}`, ...headers },
    });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    const first = await ask("");
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();

    // THE IDLE TICK: no status, no body, nothing folded.
    const again = await ask("", { "if-none-match": tag! });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag!);
    expect(await again.text()).toBe("");

    /**
     * AND THE TAG IS NOT TRANSFERABLE BETWEEN THE TWO LISTS. This is the whole
     * reason the tag exists beside the cursor: the revision has NOT moved here
     * — nothing was written — so a `?since=` would say "unchanged" and the
     * reader's Settled shelf would stay empty. The tag names the list it
     * described, so the wide ask is answered with the wide list.
     */
    const wide = await ask("?all=1", { "if-none-match": tag! });
    expect(wide.status).toBe(200);
    const wideTag = wide.headers.get("etag");
    expect(wideTag).toBeTruthy();
    expect(wideTag).not.toBe(tag!);
    // And the wide read IS conditional on its own tag, which `?since=` refuses.
    expect((await ask("?all=1", { "if-none-match": wideTag! })).status).toBe(304);
    // The narrow tag still answers the narrow ask; neither has disturbed the
    // other.
    expect((await ask("", { "if-none-match": tag! })).status).toBe(304);

    // Something moves and the tag is spent — a full answer, with a new tag.
    await client.updateSession("session_one", { title: "Renamed" });
    const moved = await ask("", { "if-none-match": tag! });
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(tag!);
    expect(((await moved.json()) as { sessions: Array<{ title: string }> }).sessions[0]?.title).toBe("Renamed");

    // A tag from a dead daemon is not "unchanged" — the same failure mode the
    // cursor guards, and for the same reason: a frozen rail is the one thing a
    // reader cannot see and cannot recover from.
    expect((await ask("", { "if-none-match": 'W/"live-1-lean"' })).status).toBe(200);
    // `*` means "if you have anything", which here is always true.
    expect((await ask("", { "if-none-match": "*" })).status).toBe(304);
  } finally {
    await daemon.close();
  }
});

test("the client's conditional read reports not-modified rather than failing on an empty body", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    // A cold read hands back the tag the next one asks with. It has to: without
    // a tag on the unconditional answer the cheap tick is unreachable.
    const cold = await client.liveSessionsMatching();
    expect(cold.notModified).toBeFalsy();
    expect(cold.etag).toBeTruthy();

    const tick = await client.liveSessionsMatching({ etag: cold.etag! });
    expect(tick.notModified).toBe(true);
    expect(tick.etag).toBe(cold.etag!);
    // `request`'s envelope parses a body on every path, which is exactly why
    // this method has one of its own: a 304 has none.
    expect(tick).not.toHaveProperty("sessions");
  } finally {
    await daemon.close();
  }
});

test("`?full=1` serves the old shape over the wire, for one release", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    // The default is the row: this is what every cockpit now receives.
    const live = await client.liveSessions();
    expect(live.sessions[0]).not.toHaveProperty("runtimeMode");
    expect(live.sessions[0]).not.toHaveProperty("environmentId");
    /**
     * AND THE RAIL'S WHOLE PASS IS THIS ONE ANSWER. `daemonId` and the settling
     * window used to be a `/v2/health` and a `/v2/inbox` issued concurrently
     * with this — three reads per host per tick for two fields that move when
     * somebody opens Settings.
     */
    expect(live.daemonId).toBe(daemon.discovery.daemonId);
    expect(live.inbox).toEqual(await client.inboxPolicy().then((answer) => answer.inbox));

    // And a client built against the old shape still has one to ask for — a
    // paired Mac on last week's nightly, or a script.
    const answer = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/sessions/live?full=1`, {
      headers: { authorization: `Bearer ${daemon.discovery.token}` },
    });
    expect(answer.status).toBe(200);
    const whole = (await answer.json()) as { sessions: Array<Record<string, unknown>> };
    expect(whole.sessions[0]).toHaveProperty("runtimeMode");
    expect(whole.sessions[0]).toHaveProperty("environmentId");
    expect(whole.sessions[0]?.id).toBe("session_one");
  } finally {
    await daemon.close();
  }
});
