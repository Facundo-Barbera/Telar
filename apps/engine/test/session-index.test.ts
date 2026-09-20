/**
 * THE INDEXED `sessions` TABLE — issue #493.
 *
 * The live fold used to parse every session's documents to discover which rows a
 * rail would draw. It now decides off a table of scalars and reads documents
 * only for the rows that survive. Three things have to hold for that to be safe,
 * and each has a test here:
 *
 *   - THE TWO PATHS AGREE. A store with an index and a store without must answer
 *     the same rows, or a conversation is on one machine's list and off
 *     another's. The document path is not dead code; it is the reference.
 *   - THE ROW NEVER OUTLIVES ITS DOCUMENT. It is written in the transaction that
 *     wrote the document, so a command that throws leaves neither.
 *   - THE CURSOR MOVES FOR WHAT THE READER CAN SEE, and not for what it cannot.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-index-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

const stores: EngineStore[] = [];
/** A store on the SQLite backend, which is the only one that has an index. */
function indexed(directory = root(), clock?: () => number): EngineStore {
  const store = new EngineStore(directory, clock ?? (() => 1_700_000_000_000), { executionStorage: "sqlite" });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.closeExecutionStore(); } catch { /* already closed by the test */ }
  }
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** The same handful of sessions on either backend: one plainly live, one pinned
 *  settled, one archived — the three the partition has to get right. */
function seed(store: EngineStore): void {
  store.registerProject({ id: "project_one", name: "Telar", root: "/tmp" });
  for (const id of ["session_aaaa", "session_bbbb", "session_cccc"]) {
    store.createSession({ id, projectId: "project_one", title: `Session ${id}` });
  }
  store.updateSession("session_bbbb", { settledOverride: "settled" });
  store.archiveSession("session_cccc");
}

test("the indexed fold and the document fold answer the same rows", () => {
  const withIndex = indexed();
  const withoutIndex = new EngineStore(root(), () => 1_700_000_000_000);
  stores.push(withoutIndex);
  seed(withIndex);
  seed(withoutIndex);

  const ids = (store: EngineStore, all: boolean): string[] =>
    store.liveSessionRows({ all }).sessions.map((session) => session.id).sort();

  expect(ids(withIndex, false)).toEqual(ids(withoutIndex, false));
  expect(ids(withIndex, true)).toEqual(ids(withoutIndex, true));
  expect(withIndex.liveSessionRows().settledCount).toBe(withoutIndex.liveSessionRows().settledCount);

  // And it is the partition we meant, not two empty lists agreeing.
  expect(ids(withIndex, false)).toEqual(["session_aaaa"]);
  expect(withIndex.liveSessionRows().settledCount).toBe(1);
});

test("the row carries the folded activity, so a blocked session is decided without its queue", () => {
  const store = indexed();
  seed(store);
  store.submitTurn("session_aaaa", { runId: "run_one", input: "hello" });
  store.claimNextTurn("worker_one");

  const [row] = store.liveSessionRows().sessions;
  expect(row?.id).toBe("session_aaaa");
  // Claimed, not yet running: the fold calls that `queued`, and a queued session
  // is one `isShelved` refuses to take — which is the decision the row now makes.
  expect(row?.activity).toBe("queued");
});

test("a metadata-only write carries the folded fields over rather than re-reading the queue", () => {
  const store = indexed();
  seed(store);
  store.submitTurn("session_aaaa", { runId: "run_one", input: "hello" });
  store.stopTurn("session_aaaa", "run_one");

  const folded = store.liveSessionRows({ all: true }).sessions.find((session) => session.id === "session_aaaa");
  expect(folded?.lastTurnSequence).toBe(1);

  /**
   * A RENAME TOUCHES `session.json` AND NOTHING ELSE, so the five queue-derived
   * fields cannot have moved — and the row must still carry them. Getting this
   * wrong would blank `lastTurnSequence` on every rename, and a session with no
   * sequence is one the unread rule can never mark read.
   */
  store.updateSession("session_aaaa", { title: "renamed" });
  const after = store.liveSessionRows({ all: true }).sessions.find((session) => session.id === "session_aaaa");
  expect(after?.title).toBe("renamed");
  expect(after?.lastTurnSequence).toBe(folded?.lastTurnSequence);
  expect(after?.lastTurnEndedAt).toBe(folded?.lastTurnEndedAt);
  expect(after?.activity).toBe(folded?.activity);
});

test("a session deleted takes its row with it, and the next open finds no orphan", () => {
  const home = root();
  const store = indexed(home);
  seed(store);
  expect(store.deleteSession("session_aaaa")).toBe(true);
  store.closeExecutionStore();

  // The backfill on open reconciles: nothing to build, nothing to drop.
  const reopened = indexed(home);
  expect(reopened.sessionIndexBackfill).toEqual({ built: 0, removed: 0 });
  expect(reopened.liveSessionRows({ all: true }).sessions.map((session) => session.id)).not.toContain("session_aaaa");
});

test("the backfill builds the rows a binary without the index left behind", async () => {
  const home = root();
  const store = indexed(home);
  seed(store);
  store.closeExecutionStore();

  /**
   * WHAT A DOWNGRADE LOOKS LIKE FROM HERE: the documents are all there and the
   * table is empty, because the binary that wrote them did not know about it.
   * The schema is additive and `user_version` stays at 1 precisely so that can
   * happen, which is why the reconcile runs on every open rather than once.
   */
  const { Database } = await import("bun:sqlite");
  const raw = new Database(path.join(home, "execution.sqlite"));
  raw.exec("DELETE FROM sessions");
  raw.exec("INSERT INTO sessions(id, state, activity) VALUES('session_gone', 'active', 'idle')");
  raw.close();

  const reopened = indexed(home);
  expect(reopened.sessionIndexBackfill).toEqual({ built: 3, removed: 1 });
  expect(reopened.liveSessionRows().sessions.map((session) => session.id)).toEqual(["session_aaaa"]);
  expect(reopened.liveSessionRows().settledCount).toBe(1);
});

test("a command that throws leaves neither the document nor the row", () => {
  const store = indexed();
  seed(store);
  const before = store.liveSessionRows({ all: true }).sessions.find((session) => session.id === "session_aaaa");

  expect(() => store.executeCommand("deliberate failure", () => {
    store.updateSession("session_aaaa", { title: "written inside a doomed command" });
    throw new Error("rolled back");
  })).toThrow("rolled back");

  const after = store.liveSessionRows({ all: true }).sessions.find((session) => session.id === "session_aaaa");
  expect(after?.title).toBe(before?.title);
  expect(after?.updatedAt).toBe(before?.updatedAt);
});

test("the cursor moves for a session on the list and not for one on the shelf", () => {
  const store = indexed();
  seed(store);

  // A write to the pinned-settled session: it is not in the default answer, so
  // the default cursor must not move — and the wide one must.
  const listBefore = store.sessionsRevision();
  const allBefore = store.sessionsRevision({ all: true });
  store.updateSession("session_bbbb", { title: "renamed on the shelf" });
  expect(store.sessionsRevision()).toBe(listBefore);
  expect(store.sessionsRevision({ all: true })).toBeGreaterThan(allBefore);

  // A write to the live one moves both.
  const listNow = store.sessionsRevision();
  store.updateSession("session_aaaa", { title: "renamed on the list" });
  expect(store.sessionsRevision()).toBeGreaterThan(listNow);
});

test("crossing between the list and the shelf moves every reader's cursor", () => {
  const store = indexed();
  seed(store);
  const before = store.sessionsRevision();
  // `settledCount` rides the DEFAULT answer, so a row leaving the list changes
  // that answer even though the row itself is no longer in it.
  store.updateSession("session_aaaa", { settledOverride: "settled" });
  expect(store.sessionsRevision()).toBeGreaterThan(before);
  expect(store.liveSessionRows().sessions).toHaveLength(0);
  expect(store.liveSessionRows().settledCount).toBe(2);
});

/**
 * ══ THE FRONT DOOR'S AGGREGATE — issue #490 ══
 *
 * `projectActivity` replaces `liveSessions({ all: true })` on the launch path.
 * The rule it has to keep is not "it is faster": it is that the ranking built on
 * it opens THE SAME PROJECT for every input the list would have. Both tests
 * below are that, and neither can pass on two empty lists agreeing.
 */
/**
 * A MOVING CLOCK, AND THIS FILE'S OTHER FIXTURES DELIBERATELY DO NOT HAVE ONE.
 * The shared `indexed()` helper freezes time, which is right for the shelving
 * tests — they compare a stamp against a settling window and a wall clock would
 * shelve everything. It is WRONG for a recency ranking: with every `updatedAt`
 * identical, "the newest project wins" passes on the sort's tie-break and would
 * go on passing against an aggregate that read the wrong column entirely. Each
 * call is a millisecond later, so the order below is a fact rather than an
 * accident.
 */
const ticking = () => {
  let at = 1_700_000_000_000;
  return () => (at += 1);
};

test("the aggregate and the list it replaces name the same newest project", () => {
  const withIndex = indexed(root(), ticking());
  const withoutIndex = new EngineStore(root(), ticking());
  stores.push(withoutIndex);
  for (const store of [withIndex, withoutIndex]) {
    store.registerProject({ id: "project_quiet", name: "Quiet", root: root() });
    store.registerProject({ id: "project_busy", name: "Busy", root: root() });
    store.createSession({ id: "session_aaaa", projectId: "project_quiet", title: "older" });
    store.createSession({ id: "session_bbbb", projectId: "project_busy", title: "newer" });
    /**
     * AND ONE ARCHIVED SESSION, TOUCHED LAST, IN THE LOSING PROJECT. Without it
     * this test passes against an aggregate with no `archived` filter at all —
     * every row in the fixture would be active and the two spellings could not
     * disagree. With it, a leak makes `project_quiet` the newest and flips the
     * ranking, which is the user-visible failure: Telar opens the project you
     * finished with.
     */
    store.createSession({ id: "session_cccc", projectId: "project_quiet", title: "finished last" });
    store.archiveSession("session_cccc");
  }

  /** The fold `composerProject` makes, spelled here so the two answers are
   *  compared as the ranking would use them and not as raw rows. */
  const rank = (activity: { projectId: string; updatedAt: number }[]): string =>
    [...activity].sort((left, right) => right.updatedAt - left.updatedAt)[0]!.projectId;

  const indexedActivity = withIndex.projectActivity();
  const documentActivity = withoutIndex.projectActivity();

  /**
   * THE INDEXED PATH AND THE DOCUMENT PATH AGREE — the second is the reference.
   *
   * COMPARED AS THE RANKING USES THEM, not as raw stamps: the two backends do
   * not make the same number of `now()` calls to write the same fixture, so
   * their absolute timestamps are allowed to differ. What may never differ is
   * WHICH PROJECTS ARE IN THE ANSWER and WHICH ONE COMES OUT ON TOP — the only
   * two things `composerProject` reads.
   */
  expect(indexedActivity.map((entry) => entry.projectId).sort())
    .toEqual(documentActivity.map((entry) => entry.projectId).sort());
  expect(rank(indexedActivity)).toBe(rank(documentActivity));
  // And it is the answer we meant, not two empty lists agreeing.
  expect(rank(indexedActivity)).toBe("project_busy");
  expect(indexedActivity).toHaveLength(2);

  // AND IT MATCHES THE WIDE LIST IT REPLACES, folded the way the front door
  // folded it. This is the assertion that would catch a population drift.
  const fromRows = new Map<string, number>();
  for (const row of withIndex.liveSessionRows({ all: true }).sessions) {
    if (!row.projectId) continue;
    if (row.updatedAt > (fromRows.get(row.projectId) ?? 0)) fromRows.set(row.projectId, row.updatedAt);
  }
  expect(Object.fromEntries(indexedActivity.map((entry) => [entry.projectId, entry.updatedAt])))
    .toEqual(Object.fromEntries(fromRows));
});

/**
 * THE COLD CASE `composerProject` LEANS ON. An archived-only project must score
 * NOTHING, so the front door falls through to most-recently-registered rather
 * than opening a conversation somebody finished with. The list this replaced
 * carried active sessions only; if the aggregate counted archived rows, that
 * fallback would silently stop happening — and the bug would be "Telar opens
 * the wrong project", with nothing on screen to explain it.
 */
test("a project whose sessions are all archived is absent from the aggregate", () => {
  const store = indexed();
  store.registerProject({ id: "project_done", name: "Done", root: root() });
  store.registerProject({ id: "project_live", name: "Live", root: root() });
  store.createSession({ id: "session_aaaa", projectId: "project_done", title: "finished" });
  store.createSession({ id: "session_bbbb", projectId: "project_live", title: "going" });

  expect(store.projectActivity().map((entry) => entry.projectId).sort()).toEqual(["project_done", "project_live"]);
  store.archiveSession("session_aaaa");
  expect(store.projectActivity().map((entry) => entry.projectId)).toEqual(["project_live"]);

  // A SETTLED session still votes, which is the other half of the rule: the
  // shelf is a reading state, not an ending. This is the distinction that made
  // `?all=1` the right ask before and makes `archived = 0` the right filter now.
  store.updateSession("session_bbbb", { settledOverride: "settled" });
  expect(store.liveSessionRows().sessions).toHaveLength(0);
  expect(store.projectActivity().map((entry) => entry.projectId)).toEqual(["project_live"]);
});

/**
 * THE SAVING, AS A RATIO RATHER THAN A CLOCK. What this replaced serialised a
 * full row per session; this serialises two scalars per PROJECT. Asserted as a
 * ratio because a byte floor would pass against a frozen or constant payload —
 * and measured on the same store in the same breath, so nothing here depends on
 * which machine it runs on.
 */
test("the aggregate is a fraction of the wide list's payload", () => {
  const store = indexed();
  store.registerProject({ id: "project_one", name: "One", root: root() });
  store.registerProject({ id: "project_two", name: "Two", root: root() });
  for (let n = 0; n < 40; n += 1) {
    store.createSession({
      id: `session_${String(n).padStart(4, "0")}`,
      projectId: n % 2 === 0 ? "project_one" : "project_two",
      title: `Conversation number ${n}`,
    });
  }

  const wide = Buffer.byteLength(JSON.stringify(store.liveSessionRows({ all: true }).sessions));
  const narrow = Buffer.byteLength(JSON.stringify(store.projectActivity()));

  // 40 sessions, 2 projects. The wide answer grows with the first number and
  // this one with the second, which is the whole point — so the ratio is the
  // assertion, not either figure.
  expect(narrow).toBeLessThan(wide / 20);
  // And both describe the same two projects, so this is not a comparison
  // against an empty answer.
  expect(store.projectActivity()).toHaveLength(2);
  expect(store.liveSessionRows({ all: true }).sessions).toHaveLength(40);
});

test("a document the live answer never reads moves no cursor at all", () => {
  const store = indexed();
  seed(store);
  const before = store.sessionsRevision({ all: true });
  /**
   * THE NARROWING THIS ISSUE IS ABOUT. An OAuth poll, a usage refresh, a
   * provider secret — none appear in `/v2/sessions/live`, and each used to make
   * every connected rail re-read all 291 sessions.
   */
  store.setTextGenPolicy({ titles: false });
  expect(store.sessionsRevision({ all: true })).toBe(before);

  // But the three it DOES read still move it.
  store.setInboxPolicy({ autoSettleAfterHours: 12 });
  expect(store.sessionsRevision()).toBeGreaterThan(before);
});
