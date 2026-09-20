/**
 * REQUEST DEADLINES — issue #541 D.
 *
 * The property under test is the sentence `protocol/requests.ts` has carried
 * since it was written and could not enforce: a session that parks at minute
 * three and sits there until morning "is not autonomous; it is stuck, and worse,
 * it is stuck silently."
 *
 * ── WHAT THESE ASSERT, AND WHAT THEY DELIBERATELY DO NOT ────────────────────
 * The `RequestResolver` ENUM VALUE and a ROW COUNT, never a substring of prose.
 * A `policy` resolution's own sentence can contain the word "timeout", so a
 * transcript grep for it would pass for the wrong reason — the same shape as a
 * guard that greps a test name and is satisfied by the test being SKIPPED.
 *
 * ── THE RED THESE ARE BUILT AROUND ──────────────────────────────────────────
 * "a deadline with no default still waits" is the one clause a wrong
 * implementation passes every other test with. It is exercised directly, by
 * taking the passing case and removing ONLY the default: same deadline, same
 * clock, same sweep, and the request must still be open with the inbox
 * unmoved. A sweeper that resolved on the deadline alone would be green
 * everywhere else in this file.
 *
 * ── THE INBOX IS THE REAL ONE ───────────────────────────────────────────────
 * The sink writes into an actual `AgentInbox` over sqlite and the count comes
 * out of `unreadCount`, rather than from counting calls to a spy. A spy would
 * prove the store CALLED something; this proves a row a person can read exists.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deadlineResolution } from "@telar/engine-client";
import { EngineStateError, EngineStore } from "../src/state";
import { AgentInbox, inboxRowFromNotification } from "../src/agent/inbox";

const homes: string[] = [];
const stores: EngineStore[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const database of databases.splice(0)) database.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const THREAD = "thread_one";
const OPENED_AT = 1_000_000;

type Harness = {
  store: EngineStore;
  inbox: AgentInbox;
  token: string;
  /** Move the store's clock. Every deadline here is measured from `OPENED_AT`. */
  advance: (ms: number) => void;
  unread: () => number;
};

function harness(runtimeMode: "approval-required" | "auto" = "approval-required"): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-deadline-"));
  homes.push(home);
  let now = OPENED_AT;
  const store = new EngineStore(home, () => now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one", title: "A worker" });
  store.updateSession("session_one", { runtimeMode });

  const database = new Database(":memory:");
  databases.push(database);
  const inbox = new AgentInbox(database);
  /**
   * THE DAEMON'S OWN WIRING, in two lines: `setAgentWakeSink` → `wake()` →
   * `inboxRowFromNotification` → `append`. Copied rather than mocked so the
   * `inboxKind` override is exercised on the path that actually carries it.
   */
  store.setAgentWakeSink((wake) => {
    const fields = inboxRowFromNotification(wake.notification, wake.inboxKind);
    if (fields) inbox.append({ threadId: THREAD, at: now, ...fields });
  });

  store.submitTurn("session_one", { runId: "run_one", input: "Do the thing" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_one", claimed.claim!.token);
  return {
    store,
    inbox,
    token: claimed.claim!.token,
    advance: (ms) => { now = OPENED_AT + ms; },
    unread: () => inbox.unreadCount(THREAD),
  };
}

/** A question, which no runtime mode auto-answers — so it parks in every mode
 *  and is the kind #541 D is actually about. */
const question = {
  kind: "user_input" as const,
  detail: {
    kind: "user_input" as const,
    prompt: "Which base should I branch from?",
    fields: [{ key: "base", label: "Base", kind: "choice" as const, choices: ["main", "develop"], required: true }],
  },
};

const command = { kind: "command_execution" as const, detail: { kind: "command_execution" as const, command: { command: "bun test" } } };

/* ------------------------------------------------------------------ *
 * THE PASSING CASE, and the red that is the same case minus one field.
 * ------------------------------------------------------------------ */

test("a deadline with a default resolves as `timeout` and writes exactly one inbox row", () => {
  const h = harness();
  expect(h.unread()).toBe(0);

  const opened = h.store.openRequest("session_one", "run_one", h.token, {
    requestId: "req_deadline",
    ...question,
    deadlineMs: 60_000,
    default: { decision: "accept", answers: { base: "main" } },
  });
  expect(opened.state).toBe("open");

  // Not yet. The clock, not the sweep, is what decides.
  h.advance(59_999);
  expect(h.store.sweepRequestDeadlines()).toEqual([]);
  expect(h.store.requests("session_one")[0]!.state).toBe("open");
  expect(h.unread()).toBe(0);

  h.advance(60_000);
  expect(h.store.sweepRequestDeadlines()).toEqual(["req_deadline"]);

  const resolved = h.store.requests("session_one").find((request) => request.id === "req_deadline")!;
  // THE ENUM VALUE, not a sentence that happens to contain a word.
  expect(resolved.state).toBe("resolved");
  expect(resolved.resolvedBy).toBe("timeout");
  expect(resolved.decision).toBe("accept");
  // The asker's own answer, carried through to whoever was blocked on it.
  expect(resolved.answers).toEqual({ base: "main" });

  // EXACTLY ONE. Not "at least one" — a sweep that announced per tick would be
  // green under `toBeGreaterThan` and would spam a person nightly.
  expect(h.unread()).toBe(1);
  const row = h.inbox.unread(THREAD)[0]!;
  expect(row.kind).toBe("request_timeout");
  expect(row.sessionId).toBe("session_one");
});

/**
 * THE DELIBERATE RED — the issue's clause "requests with no default wait".
 *
 * Identical to the test above in every respect but one: no `default`. If this
 * ever goes green with an open request resolved, the sweeper is acting on the
 * deadline alone and the clause is not implemented — which is exactly the
 * mistake every other test in this file would still pass through.
 */
test("a deadline with NO default resolves nothing, however long it sits", () => {
  const h = harness();
  h.store.openRequest("session_one", "run_one", h.token, {
    requestId: "req_no_default",
    ...question,
    deadlineMs: 60_000,
  });

  // An hour past a one-minute deadline, swept repeatedly.
  h.advance(3_600_000);
  expect(h.store.sweepRequestDeadlines()).toEqual([]);
  expect(h.store.sweepRequestDeadlines()).toEqual([]);

  const still = h.store.requests("session_one")[0]!;
  expect(still.state).toBe("open");
  expect(still.resolvedBy).toBeUndefined();
  expect(still.decision).toBeUndefined();
  expect(h.unread()).toBe(0);
});

test("a request with no deadline at all is never swept", () => {
  const h = harness();
  h.store.openRequest("session_one", "run_one", h.token, { requestId: "req_plain", ...question });
  h.advance(86_400_000);
  expect(h.store.sweepRequestDeadlines()).toEqual([]);
  expect(h.store.requests("session_one")[0]!.state).toBe("open");
  expect(h.unread()).toBe(0);
});

test("sweeping twice resolves once — the second pass has nothing left to find", () => {
  const h = harness();
  h.store.openRequest("session_one", "run_one", h.token, {
    requestId: "req_once",
    ...question,
    deadlineMs: 1_000,
    default: { decision: "decline" },
  });
  h.advance(5_000);
  expect(h.store.sweepRequestDeadlines()).toEqual(["req_once"]);
  expect(h.store.sweepRequestDeadlines()).toEqual([]);
  // The count is the assertion: a second announcement would be a second row.
  expect(h.unread()).toBe(1);
});

/* ------------------------------------------------------------------ *
 * WHAT MAY CARRY A DEFAULT.
 * ------------------------------------------------------------------ */

test("a secret-access request may not carry a default, and is refused rather than stripped", () => {
  const h = harness();
  expect(() =>
    h.store.openRequest("session_one", "run_one", h.token, {
      requestId: "req_secret",
      kind: "secret_access",
      detail: {
        kind: "secret_access",
        secret: {
          origin: "https://github.com",
          fields: [{ kind: "password" }],
          candidates: [{ id: "item_one", title: "GitHub", domain: "github.com" }],
        },
      },
      deadlineMs: 1_000,
      default: { decision: "accept" },
    }),
  ).toThrow(EngineStateError);
  // REFUSED, NOT SILENTLY DROPPED: no request exists, so a caller cannot come
  // away believing it set a fallback it did not set.
  expect(h.store.requests("session_one")).toHaveLength(0);
});

test("a default with no deadline is refused — nothing would ever take it", () => {
  const h = harness();
  expect(() =>
    h.store.openRequest("session_one", "run_one", h.token, {
      requestId: "req_orphan",
      ...question,
      default: { decision: "accept" },
    }),
  ).toThrow(EngineStateError);
});

test("a deadline that is not a positive whole number of milliseconds is refused", () => {
  const h = harness();
  for (const deadlineMs of [0, -1, 1.5]) {
    expect(() =>
      h.store.openRequest("session_one", "run_one", h.token, { requestId: `req_${String(deadlineMs)}`, ...question, deadlineMs }),
    ).toThrow(EngineStateError);
  }
});

/**
 * A REQUEST THE MODE ANSWERED ON THE SPOT KEEPS NO CLOCK.
 *
 * It was never waiting on anybody, so a deadline on it would be a field that
 * measured nothing and a row the sweeper skipped for ever.
 */
test("an auto-resolved request stores neither deadline nor default", () => {
  const h = harness("auto");
  const opened = h.store.openRequest("session_one", "run_one", h.token, {
    requestId: "req_auto",
    ...command,
    deadlineMs: 1_000,
    default: { decision: "decline" },
  });
  expect(opened).toMatchObject({ state: "resolved", resolvedBy: "policy" });
  const stored = h.store.requests("session_one")[0]!;
  expect(stored.deadlineMs).toBeUndefined();
  expect(stored.default).toBeUndefined();
  h.advance(10_000);
  expect(h.store.sweepRequestDeadlines()).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * THE BLOCKED WORKER, AND WHAT IT IS TOLD.
 * ------------------------------------------------------------------ */

/**
 * The provider is parked inside `canUseTool` polling the heartbeat. A timeout
 * has to reach it by exactly the route a human's answer does, or the session is
 * resolved on paper and still hung in fact.
 */
test("the blocked worker takes the answer off the heartbeat, with a reason that says a person did not decide", () => {
  const h = harness();
  h.store.openRequest("session_one", "run_one", h.token, {
    requestId: "req_worker",
    ...command,
    deadlineMs: 1_000,
    default: { decision: "decline" },
  });
  expect(h.store.resolutionsForWorker("worker_one")).toHaveLength(0);

  h.advance(2_000);
  h.store.sweepRequestDeadlines();

  const pending = h.store.resolutionsForWorker("worker_one");
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ requestId: "req_worker", decision: "decline" });
  // The model is told nobody decided this. Keyed on a phrase only this sentence
  // produces — a human's own decline carries whatever they typed, and a policy
  // resolution carries no reason at all.
  expect(pending[0]!.reason).toContain("A person did not decide this");
});

/* ------------------------------------------------------------------ *
 * THE POLICY ITSELF, held directly.
 * ------------------------------------------------------------------ */

test("deadlineResolution is the single place the no-default rule lives", () => {
  const base = { state: "open" as const, openedAt: 0 };
  const answer = { decision: "accept" as const };

  expect(deadlineResolution({ ...base, deadlineMs: 100, default: answer }, 100)).toEqual(answer);
  expect(deadlineResolution({ ...base, deadlineMs: 100, default: answer }, 99)).toBeNull();
  // The clause: a deadline, long passed, and no answer to take.
  expect(deadlineResolution({ ...base, deadlineMs: 100 }, 10_000)).toBeNull();
  // An answer with no clock, and a request already settled.
  expect(deadlineResolution({ ...base, default: answer }, 10_000)).toBeNull();
  expect(deadlineResolution({ state: "resolved", openedAt: 0, deadlineMs: 100, default: answer }, 10_000)).toBeNull();
});

/* ------------------------------------------------------------------ *
 * DURABILITY.
 * ------------------------------------------------------------------ */

test("a deadline survives a restart, and the reopened store sweeps it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-deadline-restart-"));
  homes.push(home);
  let now = OPENED_AT;
  const store = new EngineStore(home, () => now, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  store.updateSession("session_one", { runtimeMode: "approval-required" });
  store.submitTurn("session_one", { runId: "run_one", input: "Do the thing" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.openRequest("session_one", "run_one", token, {
    requestId: "req_durable",
    ...question,
    deadlineMs: 60_000,
    default: { decision: "decline" },
  });
  store.closeExecutionStore();

  now = OPENED_AT + 120_000;
  const reopened = new EngineStore(home, () => now, { executionStorage: "sqlite" });
  stores.push(reopened);
  const carried = reopened.requests("session_one")[0]!;
  expect(carried.deadlineMs).toBe(60_000);
  expect(carried.default).toEqual({ decision: "decline" });

  /**
   * `recover()` IS WHAT A DAEMON DOES AT BOOT, and it stops every running turn
   * — which cancels the requests those turns left behind. So the sweep is run
   * against the store as it is BEFORE recovery, which is the state a daemon
   * that never went down has. What this pins is that the two FIELDS crossed the
   * restart; the sweep proves it is still actionable.
   */
  expect(reopened.sweepRequestDeadlines()).toEqual(["req_durable"]);
  expect(reopened.requests("session_one")[0]!.resolvedBy).toBe("timeout");
});
