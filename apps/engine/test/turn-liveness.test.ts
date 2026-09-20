/**
 * A turn that cannot proceed, and a turn that has gone quiet — issue #813.
 *
 * ── WHY THESE TWO ARE IN ONE FILE ──────────────────────────────────────────
 * They are the same question asked twice: can this engine tell the difference
 * between a session that is working and one that has stopped without saying so?
 * #813 recorded two occurrences and both attempts to answer it by hand were
 * wrong in opposite directions — a session whose `git worktree add` had been
 * killed read `working` for 45 minutes, and a healthy 80-minute turn was read
 * as wedged and stopped 837 ms after a successful `git push`.
 *
 * ── NOTHING HERE SPAWNS A PROVIDER, A WORKER OR A CLOCK ────────────────────
 * The store takes an injected clock, so "twenty-five minutes pass" is a
 * variable. `advance` below is the whole of the time machinery; there is no
 * sleeping, no real process and no wall-clock bound anywhere in this file.
 *
 * ── AND NOTHING ASSERTS ON A MESSAGE ───────────────────────────────────────
 * Every claim is a COUNT or a STATE. Both a failed cut and a resolved-model
 * failure produce git-shaped English, so a test that grepped the text would
 * pass on either. The one sentence that IS asserted is git's own, and it is
 * asserted by identity with what the fixture made git say.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STALLED_AFTER_MS, type Turn } from "@telar/engine-client";
import { EngineStore } from "../src/state";
import { GIT_TIMEOUT_STATUS, type AsyncGitRunner } from "../src/worktree";
import { worktreeReady } from "./worktree-ready";

const roots: string[] = [];
const stores: EngineStore[] = [];

/** A Claude default this temp home already knows, so a claim is never withheld
 *  waiting for a model list nobody here is going to read. The house idiom. */
const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repository with one commit, so `HEAD` resolves and a worktree
 *  could actually be cut off it. The house idiom — see `worktree.test.ts`. */
function repo(): string {
  const root = tmp("telar-liveness-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

/**
 * THE INJECTED CLOCK, and the only way time moves in this file.
 *
 * A plain mutable number behind a closure, exactly as `execution-store.test.ts`
 * and four other suites already drive it. `advance` is what stands in for the
 * twenty-five minutes a real wedge would take, and it costs nothing.
 */
function clock(from = 1_000_000) {
  let value = from;
  return { now: () => value, advance: (ms: number) => { value += ms; }, at: () => value };
}

// ── step 3: a cut that failed fails the turn, and one still running does not ─

/**
 * A GIT THAT REFUSES TO CUT, and refuses in git's own words.
 *
 * `worktree add` is the ONLY command that fails: `prepareSessionWorktree` still
 * has to get past "is this a repository" and resolve a base, and a runner that
 * failed everything would refuse the session at creation instead of producing
 * the state under test — which is a session that EXISTS and has no checkout.
 *
 * It answers on the ASYNC runner because that is the one the cut uses
 * (`EngineStore.worktreeGit`); the synchronous probes run against the real
 * repository above.
 */
const CUT_FAILURE = "fatal: could not create work tree dir: No space left on device";
const refusingCut: AsyncGitRunner = async (_cwd, args) =>
  args[0] === "worktree" && args[1] === "add"
    ? { status: GIT_TIMEOUT_STATUS, stdout: "", stderr: CUT_FAILURE, timedOut: true }
    : { status: 0, stdout: "", stderr: "" };

/** A cut that never answers at all, so the session stays `preparing` for as
 *  long as the test wants it to. The promise is deliberately never resolved;
 *  nothing awaits it and the store's own queue holds the only reference. */
const hangingCut: AsyncGitRunner = (_cwd, args) =>
  args[0] === "worktree" && args[1] === "add"
    ? new Promise(() => {})
    : Promise.resolve({ status: 0, stdout: "", stderr: "" });

function worktreeSession(git: AsyncGitRunner, now: () => number) {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-liveness-state-"), now, { asyncGit: git });
  stores.push(store);
  const project = store.registerProject({ name: "aurora", root: projectRoot });
  const session = store.createSession({ projectId: project.id, envMode: "worktree", title: "port the parser" });
  return { store, sessionId: session.id };
}

test("a session whose checkout failed fails its queued turn instead of parking it forever", async () => {
  const time = clock();
  const { store, sessionId } = worktreeSession(refusingCut, time.now);
  await worktreeReady(store, sessionId);
  // The premise, stated rather than assumed: the row carries the failure.
  expect(store.getSession(sessionId).preparation?.state).toBe("failed");

  store.submitTurn(sessionId, { runId: "run_one", input: "start" });
  expect(store.turns(sessionId).map((turn) => turn.state)).toEqual(["queued"]);

  // TEN SCAN TICKS, not one. The defect was a turn that waited FOREVER, so a
  // single tick would not tell a fix from a delay — and a scan that failed the
  // turn more than once would show up here as a second turn or a second
  // failure rather than passing quietly.
  for (let tick = 0; tick < 10; tick += 1) expect(store.claimNextTurn("worker_one")).toBeUndefined();

  const turns = store.turns(sessionId);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.state).toBe("failed");
  expect(turns[0]!.failure?.code).toBe("workspace_unavailable");
  // GIT'S OWN SENTENCE, asserted by identity with what the fixture made git
  // say — not by grepping for words that both failure paths would produce.
  expect(turns[0]!.failure?.message).toContain(CUT_FAILURE);
  // And it ended once: one terminal record for one turn.
  expect(store.readEvents(sessionId).filter((event) => event.type === "turn.failed")).toHaveLength(1);
});

test("a session whose checkout is still being cut keeps its turn queued across the same ticks", () => {
  const time = clock();
  const { store, sessionId } = worktreeSession(hangingCut, time.now);
  // NOT awaited: this cut never finishes, which is the state under test.
  expect(store.getSession(sessionId).preparation?.state).toBe("preparing");

  store.submitTurn(sessionId, { runId: "run_one", input: "start" });
  for (let tick = 0; tick < 10; tick += 1) expect(store.claimNextTurn("worker_one")).toBeUndefined();

  const turns = store.turns(sessionId);
  expect(turns).toHaveLength(1);
  // STILL QUEUED — #496's behaviour, kept exactly. A message is not lost by
  // waiting for a checkout that is on its way.
  expect(turns[0]!.state).toBe("queued");
  expect(turns[0]!.failure).toBeUndefined();
  expect(store.readEvents(sessionId).filter((event) => event.type === "turn.failed")).toHaveLength(0);
});

test("and a session with a checkout is unaffected: its turn is claimed like any other", async () => {
  const time = clock();
  // A git that agrees to everything, so the cut settles clean and the row's
  // `preparation` is cleared rather than failed.
  const { store, sessionId } = worktreeSession(async () => ({ status: 0, stdout: "", stderr: "" }), time.now);
  await worktreeReady(store, sessionId);
  store.submitTurn(sessionId, { runId: "run_one", input: "start" });
  // Non-vacuity for the two tests above: the same fixture, the same ticks, and
  // a turn that actually runs — so neither of them is passing because nothing
  // in this file can ever be claimed.
  expect(store.getSession(sessionId).preparation).toBeUndefined();
  expect(store.claimNextTurn("worker_one")?.turn.runId).toBe("run_one");
});

// ── step 5: the liveness signal ─────────────────────────────────────────────

/** A session with a turn genuinely `running` through the real paths — claimed
 *  and started, never hand-written into the queue. */
function runningTurn(now: () => number) {
  const store = new EngineStore(tmp("telar-stall-state-"), now);
  stores.push(store);
  const project = store.registerProject({ name: "aurora", root: tmp("telar-stall-project-") });
  const session = store.createSession({ projectId: project.id, envMode: "local" });
  store.submitTurn(session.id, { runId: "run_one", input: "do the long thing" });
  const claim = store.claimNextTurn("worker_one");
  if (!claim) throw new Error("the fixture's turn was not claimable");
  const turn = store.markRunning(session.id, claim.turn.runId, claim.turn.claim!.token);
  return { store, sessionId: session.id, runId: turn.runId, claimToken: claim.turn.claim!.token };
}

const turnOf = (store: EngineStore, sessionId: string, runId: string): Turn => {
  const turn = store.turns(sessionId).find((candidate) => candidate.runId === runId);
  if (!turn) throw new Error(`no turn ${runId}`);
  return turn;
};

/**
 * THE WEDGE — a worker holding a valid claim that reports nothing.
 *
 * No sleeping and no real process: the clock moves past the threshold while
 * NOTHING is appended under the run. That is precisely the state the engine
 * could not previously distinguish from a healthy long turn, and the only
 * honest way to simulate it is to withhold the evidence.
 */
test("a running turn that journals nothing for longer than the threshold is reported stalled", () => {
  const time = clock();
  const { store, sessionId, runId } = runningTurn(time.now);
  expect(turnOf(store, sessionId, runId).stalled).toBeUndefined();

  time.advance(STALLED_AFTER_MS + 60_000);
  store.claimNextTurn("worker_one");

  const turn = turnOf(store, sessionId, runId);
  expect(turn.state).toBe("running");
  expect(turn.stalled).toBeDefined();
  // The silence is measured from the last evidence there WAS — the
  // `turn.started` record `markRunning` wrote — not from an arbitrary now.
  expect(turn.stalled!.since).toBe(turn.startedAt);
  expect(turn.stalled!.noticedAt).toBe(time.at());
  expect(turn.lastProgressAt).toBe(turn.startedAt);
  // ADVISORY, NOT A KILL. Nothing was stopped, failed or requeued.
  expect(store.turns(sessionId).filter((candidate) => candidate.state === "running")).toHaveLength(1);
  expect(store.readEvents(sessionId).filter((event) => event.type === "turn.stopped" || event.type === "turn.failed")).toHaveLength(0);
});

/**
 * THE NEGATIVE DIRECTION, AND THE ONE THAT MATTERS MOST.
 *
 * This is the case that would have misfired on the healthy 80-minute session in
 * #813 — the one a human read as wedged and stopped 837 ms after a successful
 * push. The same total elapsed time as the test above, with ONE observation in
 * the middle of it, and the verdict has to come out the other way.
 */
test("the same elapsed time is NOT stalled when one observation arrived in the middle", () => {
  const time = clock();
  const { store, sessionId, runId, claimToken } = runningTurn(time.now);

  time.advance(STALLED_AFTER_MS - 60_000);
  store.claimNextTurn("worker_one");
  expect(turnOf(store, sessionId, runId).stalled).toBeUndefined();

  // One piece of evidence, through the real reporting path — the same call a
  // driver makes when a long command finally prints something.
  store.ingestObservations(sessionId, runId, claimToken, [
    { kind: "item.started", item: { id: "item_one", status: "inProgress", detail: { type: "assistant_message", text: "still here" } } },
  ]);
  const reportedAt = time.at();

  time.advance(STALLED_AFTER_MS - 60_000);
  store.claimNextTurn("worker_one");

  const turn = turnOf(store, sessionId, runId);
  // Total elapsed is now well past the threshold and this turn is fine, because
  // staleness is measured from the last EVIDENCE rather than from the start.
  expect(time.at() - turn.startedAt!).toBeGreaterThan(STALLED_AFTER_MS);
  expect(turn.stalled).toBeUndefined();
  expect(turn.lastProgressAt).toBe(reportedAt);
});

/**
 * THE DESIGN'S LOAD-BEARING PROPERTY, AND THE TEST WORTH WRITING FIRST.
 *
 * A heartbeat-based implementation passes both tests above and fails this one.
 * `worker.ts:386` says outright that the heartbeat must keep running while a
 * turn is BLOCKED — it is a `setInterval` deliberately decoupled from turn
 * progress — so a wedged turn on a live worker heartbeats forever. And the only
 * existing liveness mechanism, `pruneWorkers`, exempts the embedded worker,
 * which is what ran both of #813's sessions.
 *
 * THE HEARTBEAT IS SIMULATED BY ITS OWN STORE CALLS, not by a daemon: these
 * four are exactly what `workerHeartbeat` asks the store on every tick
 * (`daemon.ts`, the `workerHeartbeat` member). If any of them counted as
 * evidence of the TURN's progress, this test goes red.
 */
test("a worker whose heartbeat keeps arriving on schedule does not keep its wedged turn alive", () => {
  const time = clock();
  const { store, sessionId, runId } = runningTurn(time.now);

  // Fifteen minutes of heartbeats at one a minute, then the same again — well
  // past the threshold, with a worker that never stopped talking to the engine.
  let beats = 0;
  for (let minute = 0; minute < 30; minute += 1) {
    time.advance(60_000);
    store.cancellationsForWorker("worker_one");
    store.resolutionsForWorker("worker_one");
    store.steerForWorker("worker_one");
    store.taskStopsForWorker("worker_one");
    beats += 1;
  }
  expect(beats).toBe(30);
  store.claimNextTurn("worker_one");

  const turn = turnOf(store, sessionId, runId);
  expect(turn.state).toBe("running");
  expect(turn.stalled).toBeDefined();
  // Measured from the turn's last real evidence, which the heartbeats did not
  // move — thirty minutes ago, not one.
  expect(turn.stalled!.since).toBe(turn.startedAt);
  expect(time.at() - turn.stalled!.since).toBe(30 * 60_000);
});

test("the advisory is withdrawn the moment evidence arrives again, and the turn never left running", () => {
  const time = clock();
  const { store, sessionId, runId, claimToken } = runningTurn(time.now);

  time.advance(STALLED_AFTER_MS + 60_000);
  store.claimNextTurn("worker_one");
  expect(turnOf(store, sessionId, runId).stalled).toBeDefined();

  store.ingestObservations(sessionId, runId, claimToken, [
    { kind: "item.started", item: { id: "item_late", status: "inProgress", detail: { type: "assistant_message", text: "the install finished" } } },
  ]);
  store.claimNextTurn("worker_one");

  const turn = turnOf(store, sessionId, runId);
  expect(turn.stalled).toBeUndefined();
  expect(turn.state).toBe("running");
  // It tracks the present rather than accusing the turn of its history: one
  // turn, still running, and no terminal record anywhere in the journal.
  expect(store.turns(sessionId)).toHaveLength(1);
  expect(store.readEvents(sessionId).filter((event) => event.type === "turn.failed" || event.type === "turn.stopped")).toHaveLength(0);
});

test("a queued turn is never stalled, however long it waits", () => {
  const time = clock();
  const store = new EngineStore(tmp("telar-stall-queued-"), time.now);
  stores.push(store);
  const project = store.registerProject({ name: "aurora", root: tmp("telar-stall-queued-project-") });
  const session = store.createSession({ projectId: project.id, envMode: "local" });
  /**
   * BOTH MESSAGES BEFORE THE CLAIM, and the order is load-bearing: a message
   * submitted while a turn is already RUNNING is steered into it
   * (`steerIfRunning`) rather than queued, which would make this a test about
   * a `steering` turn instead of a waiting one.
   */
  store.submitTurn(session.id, { runId: "run_one", input: "first" });
  store.submitTurn(session.id, { runId: "run_two", input: "second" });
  const claim = store.claimNextTurn("worker_one")!;
  expect(claim.turn.runId).toBe("run_one");
  store.markRunning(session.id, "run_one", claim.turn.claim!.token);

  time.advance(STALLED_AFTER_MS * 3);
  store.claimNextTurn("worker_one");

  // The flag is about a turn producing no evidence while it RUNS. A queued turn
  // produces none by definition and is not wedged, it is waiting its turn.
  expect(turnOf(store, session.id, "run_two").state).toBe("queued");
  expect(turnOf(store, session.id, "run_two").stalled).toBeUndefined();
  expect(turnOf(store, session.id, "run_one").stalled).toBeDefined();
});
