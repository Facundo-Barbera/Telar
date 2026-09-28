import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";

const homes: string[] = [];
const stores: EngineStore[] = [];

/** Closes every store opened through this fixture; pass to `afterEach`. */
export function closeStores(): void {
  for (const store of stores.splice(0)) store.kernel.executionStore.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
}

/** Reopens a store on `home`, closed with the rest by `closeStores`. */
export function reopenStore(home: string): EngineStore {
  const store = new EngineStore(home);
  stores.push(store);
  return store;
}

/** A coordinator and two workers it can subscribe to. */
export function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-notify-"));
  homes.push(home);
  // A resolvable model, so `claimNextTurn` can build a claim (held mail rides its notes).
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const store = new EngineStore(home, Date.now);
  stores.push(store);
  store.projectRegistry.register({ id: "project_one", name: "test", root: "/tmp" });
  for (const id of ["session_host", "session_a", "session_b"]) store.lifecycle.createSession({ id, projectId: "project_one", title: id });
  return { store };
}

/** Run one whole turn on `sessionId`, ending it the named way. */
export function runTurn(store: EngineStore, sessionId: string, runId: string, end: "complete" | "fail" = "complete"): void {
  store.intake.submitTurn(sessionId, { runId, input: "work" });
  const token = store.claims.claimTurn(sessionId, "worker_child")!.claim!.token;
  store.turnLifecycle.markRunning(sessionId, runId, token);
  if (end === "complete") store.turnLifecycle.completeTurn(sessionId, runId, token, { text: "done" });
  else store.turnLifecycle.failTurn(sessionId, runId, token, { code: "driver_failed", message: "the CLI died" });
}

/** Make the host busy, and hand back the claim so a test can settle it. */
export function busy(store: EngineStore, runId = "run_host"): { runId: string; token: string } {
  store.intake.submitTurn("session_host", { runId, input: "a long think" });
  const token = store.claims.claimTurn("session_host", "worker_host")!.claim!.token;
  store.turnLifecycle.markRunning("session_host", runId, token);
  return { runId, token };
}

export const notifications = (store: EngineStore) => store.queries.turns("session_host").filter((turn) => turn.notification !== undefined);

/** A worker's run that sends its coordinator a result and then ends. */
export function reports(store: EngineStore, opts: { runId?: string; intent?: "result" | "report"; sent?: string } = {}) {
  const runId = opts.runId ?? "run_src";
  store.intake.submitTurn("session_a", { runId, input: "work" });
  const token = store.claims.claimTurn("session_a", "worker_child")!.claim!.token;
  store.turnLifecycle.markRunning("session_a", runId, token);
  const sent = store.intake.submitAgentTurn(
    "session_host",
    { runId: `run_sent_${runId}`, input: opts.sent ?? "Three commits landed: the parser, its tests, the changelog.", intent: opts.intent ?? "result" },
    { sessionId: "session_a", runId, claimToken: token },
  );
  return { runId, token, sent: sent.turn, end: () => store.turnLifecycle.completeTurn("session_a", runId, token, { text: "done" }) };
}

/** The passive row recorded for a completion that woke nobody, if one was. */
export const recordOf = (store: EngineStore, runId: string) =>
  store.queries.turns("session_host").find((turn) => turn.wakeReason?.runId === runId && turn.agentDelivery === "passive");
