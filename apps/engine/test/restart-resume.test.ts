import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectEngine } from "@telar/engine-client/node";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { EngineStateError, EngineStore } from "../src/state";
import { stubModels } from "./stub-models";

/**
 * CONTINUING WHAT A PLANNED RESTART CUT OFF — `resumeAfterPlannedRestart`.
 *
 * "The process died mid-turn" is simulated the way the recovery tests in
 * state.test.ts do it: a turn is claimed and marked running, and `recover()`
 * is called as the next boot would. The shell's marker is written by hand.
 */
const roots: string[] = [];
const NOW = 10_000_000;

const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function home(): { store: EngineStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-restart-resume-"));
  roots.push(root);
  // A Claude default this home already knows, so a claim is not withheld.
  fs.writeFileSync(path.join(root, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(root, () => NOW);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  return { store, root };
}

function runningTurn(store: EngineStore, sessionId: string, runId: string): void {
  store.createSession({ id: sessionId, projectId: "project_one" });
  store.submitTurn(sessionId, { runId, input: "Refactor the parser" });
  const claimed = store.claimTurn(sessionId, "worker_one")!;
  store.markRunning(sessionId, runId, claimed.claim!.token);
}

function writeMarker(store: EngineStore, marker: unknown): void {
  fs.writeFileSync(store.paths.plannedRestart, JSON.stringify(marker));
}

const continuations = (store: EngineStore, sessionId: string) => store.turns(sessionId).filter((turn) => turn.origin === "restart");

test("a planned update restart with the setting on continues each interrupted session exactly once", () => {
  const { store } = home();
  store.setSessionDefaults({ resumeAfterRestart: true });
  runningTurn(store, "session_one", "run_one");
  runningTurn(store, "session_two", "run_two");
  // A second turn cut off in the same session still earns only one continuation.
  store.submitTurn("session_one", { runId: "run_one_queued", input: "and then the lexer" });
  writeMarker(store, { version: 1, reason: "update", at: NOW - 60_000 });

  expect(store.recover().stopped.sort()).toEqual(["run_one", "run_one_queued", "run_two"]);

  for (const [sessionId, interrupted] of [["session_one", "run_one"], ["session_two", "run_two"]] as const) {
    const resumed = continuations(store, sessionId);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      state: "queued",
      origin: "restart",
      restartOrigin: { reason: "update", plannedAt: NOW - 60_000, interruptedRunId: interrupted },
      input: expect.stringContaining("Telar restarted to install an update"),
    });
    // The engine's words, not the person's: no sender, no wake, nothing typed.
    expect(resumed[0]!.sender).toBeUndefined();
    // The cut-off turn itself stays stopped — never replayed.
    expect(store.turns(sessionId).find((turn) => turn.runId === interrupted)).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
  }
  // The pre-restart backlog is stopped as it always was; the continuation is the one thing queued.
  expect(store.turns("session_one").filter((turn) => turn.state === "queued").map((turn) => turn.origin)).toEqual(["restart"]);
  expect(fs.existsSync(store.paths.plannedRestart)).toBe(false);
  // And it is claimable like any other turn.
  expect(store.claimTurn("session_one", "worker_two")?.origin).toBe("restart");
});

test("a turn the worker settled as interrupted on the way out is continued too", () => {
  const { store } = home();
  store.setSessionDefaults({ resumeAfterRestart: true });
  runningTurn(store, "session_one", "run_one");
  const token = store.turns("session_one")[0]!.claim!.token;
  store.failTurn("session_one", "run_one", token, { code: "interrupted", message: "Telar shut down while this turn was running." });
  writeMarker(store, { version: 1, reason: "update", at: NOW - 1_000 });

  expect(store.recover()).toEqual({ stopped: [] });
  expect(continuations(store, "session_one")).toHaveLength(1);
  expect(continuations(store, "session_one")[0]!.restartOrigin?.interruptedRunId).toBe("run_one");
});

test("with the setting off nothing is continued, and the marker is still consumed", () => {
  const { store } = home();
  runningTurn(store, "session_one", "run_one");
  writeMarker(store, { version: 1, reason: "update", at: NOW - 60_000 });
  store.recover();
  expect(continuations(store, "session_one")).toHaveLength(0);
  expect(fs.existsSync(store.paths.plannedRestart)).toBe(false);
});

test("a crash leaves no marker, so nothing is continued", () => {
  const { store } = home();
  store.setSessionDefaults({ resumeAfterRestart: true });
  runningTurn(store, "session_one", "run_one");
  store.recover();
  expect(continuations(store, "session_one")).toHaveLength(0);
  expect(store.turns("session_one")[0]).toMatchObject({ state: "stopped", stopReason: "engine_restart" });
});

test("a stale or malformed marker continues nothing and is deleted", () => {
  for (const marker of [
    { version: 1, reason: "update", at: NOW - 10 * 60_000 - 1 },
    { version: 2, reason: "update", at: NOW },
    { version: 1, reason: "crash", at: NOW },
    { version: 1, reason: "update", at: NOW + 60_000 },
    "not an object",
  ]) {
    const { store } = home();
    store.setSessionDefaults({ resumeAfterRestart: true });
    runningTurn(store, "session_one", "run_one");
    writeMarker(store, marker);
    store.recover();
    expect(continuations(store, "session_one")).toHaveLength(0);
    expect(fs.existsSync(store.paths.plannedRestart)).toBe(false);
  }
  // Not JSON at all.
  const { store } = home();
  store.setSessionDefaults({ resumeAfterRestart: true });
  runningTurn(store, "session_one", "run_one");
  fs.writeFileSync(store.paths.plannedRestart, "{");
  expect(() => store.recover()).not.toThrow();
  expect(continuations(store, "session_one")).toHaveLength(0);
  expect(fs.existsSync(store.paths.plannedRestart)).toBe(false);
});

test("a turn the person stopped, and a settled or archived session, are not continued", () => {
  const { store } = home();
  store.setSessionDefaults({ resumeAfterRestart: true });
  runningTurn(store, "session_stopped", "run_stopped");
  store.stopSession("session_stopped");
  runningTurn(store, "session_settled", "run_settled");
  store.updateSession("session_settled", { settledOverride: "settled" });
  runningTurn(store, "session_live", "run_live");
  writeMarker(store, { version: 1, reason: "update", at: NOW - 60_000 });

  store.recover();
  expect(store.turns("session_stopped")[0]).toMatchObject({ state: "stopped", stopReason: "user" });
  expect(continuations(store, "session_stopped")).toHaveLength(0);
  expect(continuations(store, "session_settled")).toHaveLength(0);
  expect(store.getSession("session_settled").settledOverride).toBe("settled");
  // One bad session does not cost the others theirs.
  expect(continuations(store, "session_live")).toHaveLength(1);
});

test("a boot that runs twice on the same marker opens no second continuation", () => {
  const { store, root } = home();
  store.setSessionDefaults({ resumeAfterRestart: true });
  runningTurn(store, "session_one", "run_one");
  const marker = { version: 1, reason: "update", at: NOW - 60_000 };
  writeMarker(store, marker);
  store.recover();
  // The first boot died before the delete could land: same marker, next boot.
  writeMarker(store, marker);
  new EngineStore(root, () => NOW).recover();
  expect(continuations(store, "session_one")).toHaveLength(1);
});

test("resumeAfterRestart round-trips beside envMode without clobbering it", () => {
  const { store } = home();
  expect(store.getSessionDefaults()).toEqual({ envMode: "local" });
  expect(store.setSessionDefaults({ envMode: "worktree" })).toEqual({ envMode: "worktree" });
  expect(store.setSessionDefaults({ resumeAfterRestart: true })).toEqual({ envMode: "worktree", resumeAfterRestart: true });
  expect(store.setSessionDefaults({ envMode: "local" })).toEqual({ envMode: "local", resumeAfterRestart: true });
  expect(store.setSessionDefaults({ resumeAfterRestart: false })).toEqual({ envMode: "local", resumeAfterRestart: false });
  expect(store.getSessionDefaults()).toEqual({ envMode: "local", resumeAfterRestart: false });
  for (const bad of ["yes", 1, null]) {
    expect(() => store.setSessionDefaults({ resumeAfterRestart: bad })).toThrow(EngineStateError);
  }
  expect(store.getSessionDefaults()).toEqual({ envMode: "local", resumeAfterRestart: false });
});

test("the daemon route and client carry resumeAfterRestart without touching envMode", async () => {
  const { root } = home();
  const daemon = await startEngine({ models: stubModels, engineRoot: root });
  daemons.push(daemon);
  const client = await connectEngine(daemon.store.paths.root);
  await client.setSessionDefaults({ envMode: "worktree" });
  expect((await client.setSessionDefaults({ resumeAfterRestart: true })).sessionDefaults).toEqual({ envMode: "worktree", resumeAfterRestart: true });
  expect((await client.setSessionDefaults({ envMode: "local" })).sessionDefaults).toEqual({ envMode: "local", resumeAfterRestart: true });
  expect((await client.sessionDefaults()).sessionDefaults).toEqual({ envMode: "local", resumeAfterRestart: true });
});
