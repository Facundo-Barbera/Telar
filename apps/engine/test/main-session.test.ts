/**
 * THE MAIN SESSION — the designation, the briefing at three seams, and what
 * switching it off actually stops (#522).
 *
 * WHAT IS ACTUALLY BEING PINNED. The paragraph itself is copy and a test that
 * quoted it would fail on every edit for no benefit. What must not drift is:
 *
 *   - that OFF IS OFF AND LEAVES NO TRACE: no briefing on any claim, no entry
 *     on the rail's answer, and no document written by an engine nobody asked;
 *   - that enable / disable / re-enable / restart can never leave TWO — the one
 *     failure that would quietly fill somebody's rail with abandoned
 *     coordinators;
 *   - that the briefing reaches each provider EXACTLY ONCE for the designated
 *     session and NOT AT ALL for any other, three providers, three seams;
 *   - that DISABLE STOPS THE MONITORING rather than merely hiding it, while
 *     keeping the conversation, its journal and everything it delegated to.
 *
 * NO SERVER FOR THE STORE HALF, and no CLI anywhere. The Claude and OpenCode
 * seams are read off what each driver builds; Codex's is read off source, for
 * the reason `orientation.test.ts` gives — reaching its `threadParams` needs a
 * live `codex app-server`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineStore } from "../src/state";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { EngineClient } from "@telar/engine-client";
import { MAIN_SESSION_BRIEFING } from "../src/main-session/briefing";
import { TELAR_ORIENTATION } from "../src/orientation";
import { BROWSER_BRIEFING } from "../src/browser/briefing";
import { openCodeBriefings } from "../src/opencode/runtime";
import { createClaudeDriver } from "../src/driver";
import type { DriverRun } from "../src/provider-contract";

let home: string;
const daemons: EngineDaemon[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "main-session-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

/** A store with one project, which is all designation needs — a project is
 *  required in this slice and there are no project-less routes in it. */
function store(): EngineStore {
  const engine = new EngineStore(join(home, "state"));
  engine.registerProject({ id: "project_one", name: "One", root: home });
  return engine;
}

/** The document the setting lives in, so "nothing was written" can be asserted
 *  as the absence of a file rather than as a shape. */
const settingFile = () => join(home, "state", "main-session.json");

async function engine(): Promise<EngineClient> {
  const daemon = await startEngine({ engineRoot: join(home, "engine") });
  daemons.push(daemon);
  return new EngineClient(daemon.discovery);
}

const run = (over: Partial<DriverRun> = {}): DriverRun =>
  ({
    sessionId: "session_one",
    runId: "run_one",
    cwd: "/tmp",
    prompt: "hello",
    signal: new AbortController().signal,
    onObservations: async () => {},
    ...over,
  }) as DriverRun;

/* ------------------------------------------------------------------ *
 * Default off.
 * ------------------------------------------------------------------ */

test("off by default: no briefing, no rail entry, and no document written", () => {
  const engine = store();
  engine.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });
  engine.submitTurn("session_one", { runId: "run_one", input: "Hello" });

  // The claim is where the decision is made, so the claim is where "no change
  // at all" has to be true.
  expect(engine.claimNextTurn("worker_one")?.mainBriefing).toBeUndefined();
  expect(engine.getMainSession()).toEqual({ enabled: false });
  // The rail reads this off the live answer, so the entry's absence is a fact
  // about that answer rather than about a component.
  expect(engine.liveSessionRows().mainSession).toEqual({ enabled: false });
  // AND NOTHING ON DISK. A default that wrote a document on first read would
  // mean every install carries a file for a feature nobody switched on.
  expect(existsSync(settingFile())).toBe(false);
});

/* ------------------------------------------------------------------ *
 * Designation — the rule that can never leave two.
 * ------------------------------------------------------------------ */

test("enabling mints exactly one project-less session, and re-enabling reuses it", () => {
  const engine = store();
  const first = engine.setMainSession({ enabled: true });
  expect(first.enabled).toBe(true);
  expect(first.sessionId).toBeDefined();
  // WHAT WAS MINTED, not merely that something was (#526): no project, no
  // directory, and the engine's own loop rather than whatever CLI this Mac
  // happens to default to.
  const minted = engine.getSession(first.sessionId!);
  expect(minted.projectId).toBeUndefined();
  expect(minted.workspace).toEqual({ mode: "none" });
  expect(minted.driver).toBe("telar");

  // OFF AND ON AGAIN IS THE SAME CONVERSATION. This is the whole requirement:
  // a second create here would leave an abandoned coordinator behind every
  // time somebody tried the feature and changed their mind.
  engine.setMainSession({ enabled: false });
  const again = engine.setMainSession({ enabled: true });
  expect(again.sessionId).toBe(first.sessionId!);

  // Even asked twice in a row while already on.
  expect(engine.setMainSession({ enabled: true }).sessionId).toBe(first.sessionId!);
  // And the project is untouched throughout: the coordinator was never in it.
  expect(engine.listSessions("project_one")).toHaveLength(0);
});

test("a restart reuses the designation rather than minting a second one", () => {
  const first = store();
  const designated = first.setMainSession({ enabled: true }).sessionId!;

  // A SECOND STORE ON THE SAME ROOT is what a daemon restart is from the
  // document's point of view: nothing in memory, everything on disk.
  const restarted = new EngineStore(join(home, "state"));
  expect(restarted.getMainSession().sessionId).toBe(designated);
  expect(restarted.setMainSession({ enabled: true }).sessionId).toBe(designated);
  expect(restarted.listSessions("project_one")).toHaveLength(0);
});

test("an existing session can be designated, and one that does not exist is refused", () => {
  const engine = store();
  engine.createSession({ id: "session_mine", projectId: "project_one" });
  expect(engine.setMainSession({ enabled: true, sessionId: "session_mine" }).sessionId).toBe("session_mine");
  // No session was created: designating is picking, not building.
  expect(engine.listSessions("project_one")).toHaveLength(1);

  // Naming one nobody holds is a bad request rather than a silent create — the
  // designation would otherwise draw a rail row that navigates nowhere.
  expect(() => engine.setMainSession({ enabled: true, sessionId: "session_nope" })).toThrow();
});

test("turning it on needs nothing chosen — there is nothing left to choose (#526)", () => {
  const engine = store();
  // #523 refused this, because a project had to be picked and picking one for
  // somebody is the engine deciding where their coordinator lives. The
  // correction removed the question: the coordinator lives in no project.
  const main = engine.setMainSession({ enabled: true });
  expect(main.enabled).toBe(true);
  expect(engine.getSession(main.sessionId!).projectId).toBeUndefined();
  // And no project gained a session on the way.
  expect(engine.listSessions("project_one")).toEqual([]);
});

test("a designated conversation that was deleted reads as none, and the next enable creates", () => {
  const engine = store();
  const designated = engine.setMainSession({ enabled: true }).sessionId!;
  engine.deleteSession(designated);

  // THE DOCUMENT STILL NAMES IT — the id outliving a disable is what makes
  // re-enabling idempotent — so the resolution is what has to notice.
  expect(engine.getMainSession().sessionId).toBe(designated);
  expect(engine.resolveMainSession().sessionId).toBeUndefined();
  expect(engine.liveSessionRows().mainSession.sessionId).toBeUndefined();

  const replacement = engine.setMainSession({ enabled: true }).sessionId!;
  expect(replacement).not.toBe(designated);
});

/* ------------------------------------------------------------------ *
 * The claim, and the three seams.
 * ------------------------------------------------------------------ */

/**
 * A DESIGNATED CODEX SESSION, for every test below that reaches a claim.
 *
 * Not because the driver matters to this feature — it does not — but because
 * `claimNextTurn` defers a Claude turn until the long-context catalogue has
 * resolved, and a created Main session takes this machine's ordinary default.
 * Designating an existing session exercises the same `isMainSession` seam
 * without making the assertion depend on a provider probe. `orientation.test.ts`
 * pins its claim the same way and for the same reason.
 */
function designatedCodexSession(engine: EngineStore, id = "session_main"): string {
  engine.createSession({ id, projectId: "project_one", driver: "codex" });
  return engine.setMainSession({ enabled: true, sessionId: id }).sessionId!;
}

/** Finish a turn the way a worker does — the claim's own token, through
 *  `markRunning`, exactly as `delegation-settling-store.test.ts` does it. */
function finish(engine: EngineStore, sessionId: string, runId: string, token: string): void {
  engine.markRunning(sessionId, runId, token);
  engine.completeTurn(sessionId, runId, token, { text: "done" });
}

test("the claim carries the briefing for the designated session and for no other", () => {
  const engine = store();
  const designated = designatedCodexSession(engine);
  engine.createSession({ id: "session_other", projectId: "project_one", driver: "codex" });

  engine.submitTurn(designated, { runId: "run_main", input: "Hello" });
  expect(engine.claimNextTurn("worker_one")?.mainBriefing).toBe(MAIN_SESSION_BRIEFING);

  // THE NARROWNESS IS THE FEATURE. Every other conversation on the machine is
  // untouched by somebody switching this on.
  engine.submitTurn("session_other", { runId: "run_other", input: "Hello" });
  expect(engine.claimNextTurn("worker_one")?.mainBriefing).toBeUndefined();
});

test("switching it off takes the briefing off the next claim, not the turn in flight", () => {
  const engine = store();
  const designated = designatedCodexSession(engine);

  engine.submitTurn(designated, { runId: "run_one", input: "Hello" });
  const inFlight = engine.claimNextTurn("worker_one");
  expect(inFlight?.mainBriefing).toBe(MAIN_SESSION_BRIEFING);

  // The decision is made AT CLAIM TIME, which is exactly what makes "a turn in
  // flight finishes with the briefing it started with" true: the claim above
  // already carries its own copy and nothing re-reads the setting.
  engine.setMainSession({ enabled: false });
  finish(engine, designated, "run_one", inFlight!.turn.claim!.token);
  engine.submitTurn(designated, { runId: "run_two", input: "And again" });
  expect(engine.claimNextTurn("worker_one")?.mainBriefing).toBeUndefined();
});

test("OpenCode carries it once, after the orientation and before the tool contracts", () => {
  const briefings = openCodeBriefings(
    run({ orientation: TELAR_ORIENTATION, mainBriefing: MAIN_SESSION_BRIEFING, browserSocket: { url: "http://x", token: "t" } }),
  );
  expect(briefings[0]).toBe(TELAR_ORIENTATION);
  expect(briefings[1]).toBe(MAIN_SESSION_BRIEFING);
  // The tool contract still follows: what this conversation IS comes before how
  // to drive what it HAS.
  expect(briefings).toContain(BROWSER_BRIEFING);
  expect(briefings.filter((entry) => entry === MAIN_SESSION_BRIEFING)).toHaveLength(1);
  // And an ordinary session is handed nothing of it.
  expect(openCodeBriefings(run({ orientation: TELAR_ORIENTATION }))).toEqual([TELAR_ORIENTATION]);
});

/** The Claude driver's spawn options, read off a fake SDK — `orientation.test.ts`
 *  uses the same seam, for the same reason: no CLI, no subprocess. */
async function claudeSystemPrompt(extra: Record<string, unknown>): Promise<{ preset?: string; append?: string } | undefined> {
  let captured: unknown;
  const driver = createClaudeDriver(
    async () => ({
      async *query(input: { options: { systemPrompt?: unknown } }) {
        captured = input.options.systemPrompt;
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => "/fake/bin/claude" },
  );
  await driver.run({
    prompt: "prompt",
    sessionId: `session_${Math.random().toString(36).slice(2)}`,
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => {},
    ...extra,
  } as DriverRun);
  return captured as { preset?: string; append?: string } | undefined;
}

test("Claude appends it to its own preset, exactly once, and not for an ordinary session", async () => {
  const prompt = await claudeSystemPrompt({ mainBriefing: MAIN_SESSION_BRIEFING });
  expect(prompt?.preset).toBe("claude_code");
  expect(prompt?.append).toContain(MAIN_SESSION_BRIEFING);
  expect(prompt?.append?.split(MAIN_SESSION_BRIEFING)).toHaveLength(2);

  // Nothing at all for a session that is not designated — not an empty append.
  expect(await claudeSystemPrompt({})).toBeUndefined();
});

test("Codex's thread parameters carry it the same way, on start and on resume", () => {
  /**
   * READ OFF SOURCE for this one driver, exactly as `orientation.test.ts` does:
   * reaching Codex's `threadParams` needs a live `codex app-server`. What is
   * pinned is the SHAPE — spread into the same `briefings` array, gated on its
   * own presence, joined into the one `developerInstructions` that both
   * `thread/start` and `thread/resume` send.
   */
  const codex = readFileSync(new URL("../src/codex-driver.ts", import.meta.url), "utf8");
  expect(codex).toContain("...(mainBriefing ? [mainBriefing] : []),");
  expect(codex).toContain("developerInstructions: briefings.join");
  expect(codex).toContain("...threadParams,");
});

test("a live Claude query cannot keep a briefing the session no longer has", () => {
  /**
   * THE FINGERPRINT IS WHAT MAKES DISABLE MEAN ANYTHING MID-CONVERSATION. The
   * briefings are baked into the query at creation, so a reused runtime would
   * go on carrying the paragraph after the switch went off; carrying the field
   * in the fingerprint is what forces the cold start instead. The TEXT, not a
   * boolean — the same rule `orientation` follows one line above it.
   */
  const driver = readFileSync(new URL("../src/driver.ts", import.meta.url), "utf8");
  expect(driver).toContain("mainBriefing: mainBriefing ?? null,");
});

/* ------------------------------------------------------------------ *
 * The entry the rail draws from.
 * ------------------------------------------------------------------ */

test("the designated conversation is not settled out of the rail while Main is on", () => {
  /**
   * WHY THIS IS A RULE AND NOT A COINCIDENCE. Settling is a TIME rule — three
   * days quiet by default — and the rail draws its Main entry from the row in
   * this answer. Without the exemption the entry the setting promises would
   * disappear on its own, on a Tuesday, for a feature nobody had switched off.
   */
  let now = Date.UTC(2026, 0, 1);
  const engine = new EngineStore(join(home, "state"), () => now);
  engine.registerProject({ id: "project_one", name: "One", root: home });
  engine.createSession({ id: "session_main", projectId: "project_one", driver: "codex" });
  engine.createSession({ id: "session_quiet", projectId: "project_one", driver: "codex" });
  engine.setMainSession({ enabled: true, sessionId: "session_main" });

  // Well past the default settling window, with nothing touched in between.
  now += 30 * 24 * 60 * 60 * 1000;
  const listed = engine.liveSessionRows();
  expect(listed.sessions.map((session) => session.id)).toContain("session_main");
  // Its quiet neighbour goes to the shelf, which is what makes this an
  // exemption rather than settling being switched off.
  expect(listed.sessions.map((session) => session.id)).not.toContain("session_quiet");
  // AND IT IS NOT COUNTED BEHIND THE SHELF EITHER: it is on the list.
  expect(listed.settledCount).toBe(1);

  // OFF MEANS ORDINARY. A designation that is switched off settles like
  // anything else — which is what "remains an ordinary resumable session" has
  // to mean in the one place a person would see it.
  engine.setMainSession({ enabled: false });
  const after = engine.liveSessionRows();
  expect(after.sessions.map((session) => session.id)).not.toContain("session_main");
  expect(after.settledCount).toBe(2);
});

/* ------------------------------------------------------------------ *
 * Disable.
 * ------------------------------------------------------------------ */

test("disabling keeps the conversation and its journal, and drops only ITS subscriptions", () => {
  const engine = store();
  const designated = designatedCodexSession(engine);
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one" }).id;
  const watcher = engine.createSession({ id: "session_watcher", projectId: "project_one" }).id;

  engine.submitTurn(designated, { runId: "run_one", input: "Hello" });
  const claim = engine.claimNextTurn("worker_one");
  finish(engine, designated, "run_one", claim!.turn.claim!.token);

  // What the coordinator asked to be woken by, and what somebody else asked to
  // be woken by ON the coordinator. Only the first is its own.
  engine.subscribe(designated, { targetSessionId: delegate });
  engine.subscribe(watcher, { targetSessionId: designated });

  engine.setMainSession({ enabled: false });

  // THE MONITORING STOPS. This is the half of "off" that is not visible, and
  // the only way a disabled feature could still spend provider quota.
  expect(engine.subscriptionsFor(designated)).toEqual([]);
  // AND NOTHING ELSE DOES. A subscription another session holds is that
  // session's; dropping it would stop work nobody switched off.
  expect(engine.subscriptionsFor(watcher)).toHaveLength(1);

  // The conversation is an ordinary resumable session with its history intact,
  // and what it delegated to is untouched.
  expect(engine.getSession(designated).id).toBe(designated);
  expect(engine.turns(designated)).toHaveLength(1);
  expect(engine.getSession(delegate).state).toBe("active");

  // And the id is kept, which is what re-enabling reuses.
  expect(engine.getMainSession()).toMatchObject({ enabled: false, sessionId: designated });
});

/* ------------------------------------------------------------------ *
 * The two races around disable.
 * ------------------------------------------------------------------ */

/**
 * Send a turn to ONE session and claim it, handing back its claim token.
 *
 * `claimTurn` rather than `claimNextTurn`, because these tests have several
 * sessions with work waiting and the engine-wide claim takes the oldest — which
 * is not the one the test means. The generation is stamped by `claimTurn`, so
 * this is the same seam a worker goes through.
 */
function claim(engine: EngineStore, sessionId: string, runId: string): string {
  engine.submitTurn(sessionId, { runId, input: "…" });
  const claimed = engine.claimTurn(sessionId, "worker_one");
  expect(claimed?.runId).toBe(runId);
  return claimed!.claim!.token;
}

test("a coordinator turn still running after disable cannot take out new subscriptions", () => {
  /**
   * THE RACE. The briefing is resolved at claim time and the turn keeps it for
   * its whole run — deliberately. So the turn goes on being told to delegate
   * and subscribe after somebody has switched Main off, and a one-time sweep of
   * the subscriptions cannot hold: the turn simply makes new ones, and the
   * monitoring a person just stopped comes back on the next tool call.
   */
  const engine = store();
  const designated = designatedCodexSession(engine);
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one" }).id;
  const token = claim(engine, designated, "run_one");

  // While it IS the coordinator, subscribing is exactly what it is for.
  expect(engine.subscribe(designated, { targetSessionId: delegate }).targetSessionId).toBe(delegate);

  engine.setMainSession({ enabled: false });
  expect(() => engine.subscribe(designated, { targetSessionId: delegate })).toThrow(/no longer Telar's Main session/);
  expect(engine.subscriptionsFor(designated)).toEqual([]);

  // AND NOTHING ELSE ABOUT THE TURN IS RESTRICTED. It finishes the work it was
  // asked for, with its briefing, and reports — which is the accepted
  // behaviour this guard is narrow enough to preserve.
  finish(engine, designated, "run_one", token);
  expect(engine.turns(designated).find((turn) => turn.runId === "run_one")?.state).toBe("completed");
});

test("the same conversation, on a later turn, subscribes like any other session", () => {
  /**
   * THE GUARD IS ABOUT A TURN, NOT A CONVERSATION. Refusing every subscription
   * from the formerly-designated session would make it a second-class session
   * for ever — and it is supposed to remain an ordinary, resumable one. A turn
   * claimed after the switch went off carries no generation at all, so it never
   * reaches the check.
   */
  const engine = store();
  const designated = designatedCodexSession(engine);
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one" }).id;

  const stale = claim(engine, designated, "run_one");
  engine.setMainSession({ enabled: false });
  expect(() => engine.subscribe(designated, { targetSessionId: delegate })).toThrow();
  finish(engine, designated, "run_one", stale);

  // A human sends a new message to what is now an ordinary conversation.
  claim(engine, designated, "run_two");
  expect(engine.subscribe(designated, { targetSessionId: delegate }).targetSessionId).toBe(delegate);
});

test("re-enabling bumps the generation, so the old turn stays refused and the new one works", () => {
  const engine = store();
  const designated = designatedCodexSession(engine);
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one" }).id;

  const stale = claim(engine, designated, "run_one");
  engine.setMainSession({ enabled: false });
  engine.setMainSession({ enabled: true, sessionId: designated });

  // ON AGAIN IS NOT THE SAME DESIGNATION. The turn that was running across both
  // switches coordinated under the old one, and its subscriptions were swept;
  // letting it re-subscribe now would restore monitoring the person had ended
  // rather than start the monitoring they have just asked for.
  expect(() => engine.subscribe(designated, { targetSessionId: delegate })).toThrow(/no longer Telar's Main session/);
  finish(engine, designated, "run_one", stale);

  // A turn claimed under the NEW designation is the one that may.
  claim(engine, designated, "run_two");
  expect(engine.subscribe(designated, { targetSessionId: delegate }).targetSessionId).toBe(delegate);
});

test("moving the designation refuses the old coordinator and allows the new one", () => {
  const engine = store();
  const first = designatedCodexSession(engine, "session_first");
  engine.createSession({ id: "session_second", projectId: "project_one", driver: "codex" });
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one" }).id;

  const stale = claim(engine, first, "run_one");
  engine.setMainSession({ enabled: true, sessionId: "session_second" });

  expect(() => engine.subscribe(first, { targetSessionId: delegate })).toThrow(/no longer Telar's Main session/);
  finish(engine, first, "run_one", stale);

  claim(engine, "session_second", "run_two");
  expect(engine.subscribe("session_second", { targetSessionId: delegate }).targetSessionId).toBe(delegate);
});

test("saving the same designation twice does not invalidate a turn that is legitimately coordinating", () => {
  // The generation counts "who is Main, and is it on" — not writes. A settings
  // pane that saved twice must not cut a live coordinator off from its work.
  const engine = store();
  const designated = designatedCodexSession(engine);
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one" }).id;
  claim(engine, designated, "run_one");

  engine.setMainSession({ enabled: true, sessionId: designated });
  expect(engine.subscribe(designated, { targetSessionId: delegate }).targetSessionId).toBe(delegate);
});

test("disable settles the wakes already queued, and leaves explicitly requested work alone", () => {
  /**
   * THE SECOND RACE. Subscriptions that fired just before the switch went off
   * left turns sitting in the queue; each would run as a full turn and spend
   * provider quota reporting on work nobody is coordinating any more.
   *
   * A `once` SUBSCRIPTION IS WHY THE SWEEP CANNOT BE PER-SUBSCRIPTION. It is
   * removed the instant it fires, so by the time the switch goes off its wake
   * has nothing left to link it to — `dropSubscriptionsBy` alone would walk
   * straight past it.
   */
  const engine = store();
  const designated = designatedCodexSession(engine);
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one", driver: "codex" }).id;
  const peer = engine.createSession({ id: "session_peer", projectId: "project_one", driver: "codex" }).id;

  engine.subscribe(designated, { targetSessionId: delegate, once: true });
  // The delegate finishes, which fires the one-shot and removes it.
  finish(engine, delegate, "run_delegate", claim(engine, delegate, "run_delegate"));
  expect(engine.subscriptionsFor(designated)).toEqual([]);

  // A human message and a peer's task, queued behind the wake.
  engine.submitTurn(designated, { runId: "run_human", input: "please look at this" });
  // A peer's task is sent from INSIDE its own live run, which is the proof the
  // store stamps the sender from — so that run has to be running.
  const peerToken = claim(engine, peer, "run_peer");
  engine.markRunning(peer, "run_peer", peerToken);
  engine.submitAgentTurn(
    designated,
    { runId: "run_task", input: "here is an errand", intent: "task" },
    { sessionId: peer, runId: "run_peer", claimToken: peerToken },
  );

  const queuedWakes = engine.turns(designated).filter((turn) => turn.state === "queued" && turn.wakeReason !== undefined);
  expect(queuedWakes).toHaveLength(1);

  engine.setMainSession({ enabled: false });

  const after = engine.turns(designated);
  // THE WAKE IS SETTLED — discarded, not run.
  expect(after.find((turn) => turn.runId === queuedWakes[0]!.runId)?.state).toBe("discarded");
  // AND EVERYTHING SOMEBODY ASKED FOR SURVIVES. A queued human message and a
  // queued peer task are explicitly requested work; switching off a briefing is
  // not a reason to throw either away.
  expect(after.find((turn) => turn.runId === "run_human")?.state).toBe("queued");
  expect(after.find((turn) => turn.runId === "run_task")?.state).toBe("queued");
  // The delegate is untouched and still live.
  expect(engine.getSession(delegate).state).toBe("active");
});

test("a wake that is already running is the worker's, and finishes", () => {
  const engine = store();
  const designated = designatedCodexSession(engine);
  const delegate = engine.createSession({ id: "session_delegate", projectId: "project_one", driver: "codex" }).id;
  engine.subscribe(designated, { targetSessionId: delegate });

  const delegateToken = claim(engine, delegate, "run_delegate");
  finish(engine, delegate, "run_delegate", delegateToken);
  const wake = engine.turns(designated).find((turn) => turn.wakeReason !== undefined)!;

  // Claimed and RUNNING before the switch is touched.
  const claimed = engine.claimTurn(designated, "worker_one");
  expect(claimed?.runId).toBe(wake.runId);
  engine.markRunning(designated, wake.runId, claimed!.claim!.token);

  engine.setMainSession({ enabled: false });
  // NOT KILLED. Disable stops monitoring; it does not reach into a turn a
  // worker is already executing — that is `sessions_stop`'s job, and a person's
  // decision.
  expect(engine.turns(designated).find((turn) => turn.runId === wake.runId)?.state).toBe("running");
  engine.completeTurn(designated, wake.runId, claimed!.claim!.token, { text: "noted" });
  expect(engine.turns(designated).find((turn) => turn.runId === wake.runId)?.state).toBe("completed");
});

/* ------------------------------------------------------------------ *
 * The route, end to end.
 * ------------------------------------------------------------------ */

test("the setting round-trips over HTTP and rides the read every rail already makes", async () => {
  const client = await engine();
  const { project } = await client.registerProject({ id: "project_one", name: "One", root: home });

  expect((await client.mainSession()).mainSession).toEqual({ enabled: false });
  // The rail gets it from the live answer rather than a route of its own.
  expect((await client.liveSessions()).mainSession).toEqual({ enabled: false });

  const enabled = (await client.setMainSession({ enabled: true, projectId: project.id })).mainSession;
  expect(enabled.enabled).toBe(true);
  expect(enabled.sessionId).toBeDefined();
  expect((await client.liveSessions()).mainSession).toEqual(enabled);

  // THE CURSOR HAS TO MOVE WITH IT, or a rail holding one would be told
  // "unchanged" and never draw the entry it should now be drawing.
  const revision = (await client.liveSessions()).revision!;
  await client.setMainSession({ enabled: false });
  const after = await client.liveSessionsSince(revision);
  expect(after.unchanged).toBeUndefined();
  expect((after as { mainSession?: { enabled: boolean } }).mainSession?.enabled).toBe(false);
});

/* ------------------------------------------------------------------ *
 * The key the assistant runs on — #526's correction.
 * ------------------------------------------------------------------ */

/** Settle the Main session's one queued turn, however the caller wants. */
function settleMainTurn(engine: EngineStore, sessionId: string, outcome: { failure?: string } = {}): void {
  engine.submitTurn(sessionId, { runId: `run_${Math.random().toString(16).slice(2)}`, input: "hello" });
  const claim = engine.claimNextTurn("worker_one")!;
  const { runId } = claim.turn;
  const token = claim.turn.claim!.token;
  engine.markRunning(sessionId, runId, token);
  if (outcome.failure) engine.failTurn(sessionId, runId, token, { code: "provider_unavailable", message: outcome.failure });
  else engine.completeTurn(sessionId, runId, token, { text: "done" });
}

test("with no key anywhere, the pane is told there is no source — which is its cue to ask for one", () => {
  const engine = store();
  // The ambient rung is this process's own environment, and the suite must not
  // depend on whether the machine running it exports one.
  const previous = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  try {
    engine.setMainSession({ enabled: true });
    // `source` absent is the whole signal: nothing was pasted, nothing is
    // exported, and the CLI has no `opencode-go` entry on this machine.
    const credential = engine.mainSessionCredential();
    expect(credential.rejected).toBe(false);
    if (credential.source !== undefined) {
      // This machine DOES have a CLI login. Then the claim under test is the
      // other half: a source was found and it is named, never the key.
      expect(["setting", "environment", "cli"]).toContain(credential.source);
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  }
});

test("a pasted key is reported as the SETTING's, and its value never leaves the engine", () => {
  const engine = store();
  engine.saveProviderInstance({ id: "telar", driver: "telar", env: [{ name: "OPENCODE_API_KEY", value: "sk-pasted-secret", sensitive: true }] });
  engine.setMainSession({ enabled: true });

  expect(engine.mainSessionCredential()).toEqual({ source: "setting", rejected: false });
  // The registry route the settings pane actually reads hands back a redacted
  // shape — the pattern this key deliberately reuses rather than reinventing.
  const listed = engine.listProviderInstances().find((instance) => instance.id === "telar")!;
  expect(JSON.stringify(listed)).not.toContain("sk-pasted-secret");
  expect(listed.env).toEqual([{ name: "OPENCODE_API_KEY", value: "", sensitive: true, valueRedacted: true }]);
});

test("a key the service rejects flips the pane to setup, and a later good turn flips it back", () => {
  const engine = store();
  engine.saveProviderInstance({ id: "telar", driver: "telar", env: [{ name: "OPENCODE_API_KEY", value: "sk-stale", sensitive: true }] });
  const sessionId = engine.setMainSession({ enabled: true }).sessionId!;

  // A rejected key fails the turn as `provider_unavailable` — the driver turns
  // 401 and 403 into exactly that, and this is the signal the pane reads.
  settleMainTurn(engine, sessionId, { failure: "OpenCode Go answered 401: invalid api key" });
  expect(engine.mainSessionCredential()).toEqual({ source: "setting", rejected: true });

  // DERIVED, NOT STORED, which is what makes it self-clearing: nobody has to
  // remember to reset a flag when the key starts working again.
  settleMainTurn(engine, sessionId);
  expect(engine.mainSessionCredential()).toEqual({ source: "setting", rejected: false });
});

test("an ordinary session designated as Main is never reported as having a bad Go key", () => {
  // A #523-shaped designation runs a CLI and has nothing to do with this key.
  // Reporting its failure as a rejected key would send somebody to fix the
  // wrong thing entirely.
  const engine = store();
  engine.createSession({ id: "session_mine", projectId: "project_one", driver: "codex" });
  engine.setMainSession({ enabled: true, sessionId: "session_mine" });
  settleMainTurn(engine, "session_mine", { failure: "codex is not on PATH" });

  expect(engine.mainSessionCredential().rejected).toBe(false);
});
