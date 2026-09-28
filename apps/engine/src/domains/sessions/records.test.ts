import { describe, expect, test } from "bun:test";
import { EngineStore } from "../../state";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

describe("read receipts", () => {
  function completed(store: EngineStore, sessionId: string, runId: string): void {
    store.intake.submitTurn(sessionId, { runId, input: "work" });
    const token = store.claims.claimTurn(sessionId, "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning(sessionId, runId, token);
    store.turnLifecycle.completeTurn(sessionId, runId, token, { text: "done" });
  }

  test("a session with no result has nothing to read", () => {
    const { store } = readyStore();
    expect(store.records.get("session_one").lastTurnSequence).toBeUndefined();
    expect(store.records.get("session_one").lastReadTurnSequence).toBeUndefined();
  });

  test("the newest RESULT is what is reported, and it is markable", () => {
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    const before = store.records.get("session_one");
    expect(before.lastTurnSequence).toBe(1);

    const read = store.records.markRead("session_one", "run_one");
    expect(read.lastReadTurnSequence).toBe(1);
    expect(read.readAt).toBe(100);
    // AND IT SURVIVES THE PROCESS. The whole reason this is not a browser flag.
    expect(new EngineStore(store.paths.root, () => 200).records.get("session_one")).toMatchObject({
      lastReadTurnSequence: 1,
      readAt: 100,
    });
  });

  test("being read is not work: `updatedAt` does not move", () => {
    // Otherwise opening a settled session would push it back into the list,
    // and reading a row would restart the very clock meant to shelve it.
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    const before = store.records.get("session_one").updatedAt;
    store.records.markRead("session_one", "run_one");
    expect(store.records.get("session_one").updatedAt).toBe(before);
    // The change is still announced, so other surfaces stop calling it unread.
    expect(store.queries.readEvents("session_one").at(-1)).toMatchObject({ type: "session.updated" });
  });

  test("a receipt for a turn that is not a result is refused", () => {
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_live", input: "work" });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", "run_live", token);
    // Still running: nothing has been answered yet.
    expect(() => store.records.markRead("session_one", "run_live")).toThrow(/completed, failed or stopped/);
    // A turn of ANOTHER session, and one that does not exist at all.
    store.lifecycle.createSession({ id: "session_two", projectId: "project_one" });
    completed(store, "session_two", "run_two");
    expect(() => store.records.markRead("session_one", "run_two")).toThrow(/completed, failed or stopped/);
    expect(() => store.records.markRead("session_one", "run_nope")).toThrow(/completed, failed or stopped/);
  });

  test("a LATE receipt cannot consume the answer that arrived after it", () => {
    // Two tabs, or a retry after a dropped response: the receipt names the
    // turn it was about, so the newer answer stays unread.
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    completed(store, "session_one", "run_two");
    store.records.markRead("session_one", "run_two");
    const after = store.records.markRead("session_one", "run_one");
    expect(after.lastReadTurnSequence).toBe(2);
    expect(after.lastTurnSequence).toBe(2);
  });

  test("a steered message and a discarded recovery are not results, so they never strand a session unread", () => {
    // A steered message ends when the provider takes it, but no client can mark it read;
    // counting it as the last answer would leave the session unread forever.
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_one", input: "work" });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", "run_one", token);
    store.intake.submitTurn("session_one", { runId: "run_steer", input: "also this" });
    store.turnLifecycle.ackSteer("session_one", "run_steer", token);
    store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "done" });

    const steered = store.queries.turns("session_one").find((turn) => turn.runId === "run_steer")!;
    expect(steered.state).toBe("steered");
    // The steered turn has the HIGHER sequence and the LATER end, and neither
    // makes it the answer.
    expect(steered.sequence).toBeGreaterThan(store.queries.turns("session_one").find((turn) => turn.runId === "run_one")!.sequence);
    const session = store.records.get("session_one");
    expect(session.lastTurnSequence).toBe(1);
    // Which means the reader can actually clear it.
    expect(store.records.markRead("session_one", "run_one").lastReadTurnSequence).toBe(1);
    expect(store.records.get("session_one").lastTurnSequence).toBe(1);
  });

  test("a failed or stopped turn is a result too — a failure is something to read", () => {
    const { store } = readyStore();
    store.intake.submitTurn("session_one", { runId: "run_bad", input: "work" });
    const token = store.claims.claimTurn("session_one", "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning("session_one", "run_bad", token);
    store.turnLifecycle.failTurn("session_one", "run_bad", token, { code: "driver_failed", message: "the CLI died" });
    expect(store.records.get("session_one").lastTurnSequence).toBe(1);
    expect(store.records.markRead("session_one", "run_bad").lastReadTurnSequence).toBe(1);
  });

  test("new work after a receipt is unread again", () => {
    const { store } = readyStore();
    completed(store, "session_one", "run_one");
    store.records.markRead("session_one", "run_one");
    completed(store, "session_one", "run_two");
    const session = store.records.get("session_one");
    expect(session.lastTurnSequence).toBe(2);
    expect(session.lastReadTurnSequence).toBe(1);
  });
});
