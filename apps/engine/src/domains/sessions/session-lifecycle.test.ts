import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EngineStateError, EngineStore } from "../../state";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

describe("a pin survives everything that is not a decision", () => {
  /** One turn, run to completion the way a worker would. */
  function runTurn(store: EngineStore, sessionId: string, runId: string): void {
    store.submitTurn(sessionId, { runId, input: "work" });
    const token = store.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.markRunning(sessionId, runId, token);
    store.completeTurn(sessionId, runId, token, { text: "done" });
  }

  test("a human's own message does not throw the pin away", () => {
    // THE BUG: `settledOverride` holds two opposite decisions, and new work
    // used to clear the field rather than the "settled" half of it — so the
    // next turn silently unpinned a row the reader had pinned on purpose.
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "active" });
    store.submitTurn("session_one", { runId: "run_pinned", input: "one more thing" });
    expect(store.getSession("session_one").settledOverride).toBe("active");
  });

  test("nor does a turn the PROVIDER started, or a peer waking it", () => {
    const { store } = readyStore();
    store.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
    store.updateSession("session_one", { settledOverride: "active" });

    // A background task finishing wakes the CLI, which opens its own turn.
    const provider = store.openProviderTurn("session_one", {
      workerId: "worker_one",
      input: "Background task completed (DONE).",
      reason: { kind: "task_notification", taskId: "task_bg" },
    });
    store.completeTurn("session_one", provider.runId, provider.claim!.token, { text: "noted" });
    expect(store.getSession("session_one").settledOverride).toBe("active");

    // And a subscribed peer finishing queues a wake turn on the pinned one.
    store.subscribe("session_one", { targetSessionId: "session_two" });
    runTurn(store, "session_two", "run_peer");
    expect(store.turns("session_one").some((turn) => turn.origin === "session")).toBe(true);
    expect(store.getSession("session_one").settledOverride).toBe("active");
  });

  test("only unpinning clears it, and settling still wins over the pin", () => {
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "active" });
    expect(store.updateSession("session_one", { settledOverride: null }).settledOverride).toBeUndefined();
    store.updateSession("session_one", { settledOverride: "active" });
    expect(store.updateSession("session_one", { settledOverride: "settled" }).settledOverride).toBe("settled");
  });

  test("a settled session still comes back on its own, and its snooze goes with it", () => {
    // The half that must NOT change: unpinning-on-work is the rule that keeps
    // settling from being a place things get lost.
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "settled", snoozedUntil: 9_000 });
    store.submitTurn("session_one", { runId: "run_back", input: "actually" });
    const session = store.getSession("session_one");
    expect(session.settledOverride).toBeUndefined();
    expect(session.snoozedUntil).toBeUndefined();
    expect(session.snoozedAt).toBeUndefined();
  });

  test("a pinned session's snooze is still lifted by new work — the pin is not a snooze", () => {
    const { store } = readyStore();
    store.updateSession("session_one", { settledOverride: "active", snoozedUntil: 9_000 });
    store.submitTurn("session_one", { runId: "run_both", input: "hi" });
    const session = store.getSession("session_one");
    expect(session.settledOverride).toBe("active");
    expect(session.snoozedUntil).toBeUndefined();
  });
});

test("a session names its provider, and the routing instance is derived from it", () => {
  const { store } = readyStore();
  // The built-in slot's id IS the driver kind — t3 code's
  // `defaultInstanceIdForDriver` — which is what keeps an instance id a plain
  // slug that survives a URL path segment. It used to be `<driver>:default`.
  const codex = store.createSession({ id: "session_codex", projectId: "project_one", driver: "codex" });
  expect(codex).toMatchObject({ driver: "codex", providerInstanceId: "codex" });
  expect(store.createSession({ id: "session_default", projectId: "project_one" })).toMatchObject({
    driver: "claude",
    providerInstanceId: "claude",
  });
  expect(() => store.createSession({ id: "session_bad", projectId: "project_one", driver: "gemini" as "claude" })).toThrow(
    /unknown provider driver/,
  );
  // The claim is what a worker routes on, so the driver has to survive onto it.
  store.submitTurn("session_codex", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")).toMatchObject({ sessionId: "session_codex", driver: "codex" });
});

test("a local session records the commit it started from, so its review survives the agent committing", () => {
  // Without a base, "what has this session done" was answerable only for
  // worktree sessions: `git status` forgets a change the instant it is
  // committed, so a session that committed its work reviewed as having done
  // nothing at all.
  const projectRoot = fs.realpathSync.native(root());
  const store = new EngineStore(root(), () => 100, {
    git: (_cwd, args) => (args.join(" ") === "rev-parse HEAD" ? { status: 0, stdout: "base000\n", stderr: "" } : { status: 1, stdout: "", stderr: "" }),
  });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  const session = store.createSession({ id: "session_one", projectId: "project_one" });
  expect(session.workspace).toEqual({ mode: "local", path: projectRoot, baseRef: "base000" });
});

test("an unversioned project still gets a session, with no base rather than a refusal", () => {
  // `envMode: "local"` exists precisely so an unversioned directory can host
  // sessions; a failure to resolve HEAD must not cost the session.
  const projectRoot = fs.realpathSync.native(root());
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 128, stdout: "", stderr: "not a git repository" }) });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  expect(store.createSession({ id: "session_one", projectId: "project_one" }).workspace).toEqual({ mode: "local", path: projectRoot });
});

test("deleting a session removes everything it owns, and refuses mid-turn", () => {
  // THE OTHER END OF THE LIFECYCLE. Settling is now the only way to put a
  // session down, so the way to get rid of one has to be real — a "delete" that
  // leaves the record behind is the dishonest version of exactly the thing
  // archive was.
  const { store, root: stateRoot } = readyStore();
  const directory = path.join(stateRoot, "sessions", "session_one");
  expect(fs.existsSync(directory)).toBe(true);

  // A turn in flight refuses: the journal is still being appended to, and the
  // checkout is under a live provider process.
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(() => store.deleteSession("session_one")).toThrow(EngineStateError);
  expect(fs.existsSync(directory)).toBe(true);

  // Finish the turn and it goes — metadata, queue, journal, the lot.
  const claim = store.claimNextTurn("worker_one")!;
  store.markRunning("session_one", "run_one", claim.turn.claim!.token);
  store.completeTurn("session_one", "run_one", claim.turn.claim!.token, { text: "done" });
  expect(store.deleteSession("session_one")).toBe(true);
  expect(fs.existsSync(directory)).toBe(false);
  expect(() => store.getSession("session_one")).toThrow(EngineStateError);
  // And it is gone from the list rather than lingering as an unreadable entry.
  expect(store.listSessions("project_one")).toEqual([]);
});
