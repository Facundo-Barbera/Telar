import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";

const roots: string[] = [];

// A Claude default this temp home already knows, so a claim is not withheld waiting for a model list.
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function readyStore(): { store: EngineStore; root: string } {
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  return { store, root: stateRoot };
}

test("runtime mode can be tightened mid-session and binds the very next tool call", () => {
  const { store } = readyStore();
  expect(store.getSession("session_one").runtimeMode).toBe("auto");

  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.markRunning("session_one", "run_one", token);

  // Under `auto`, a command resolves itself with nobody watching.
  const before = store.openRequest("session_one", "run_one", token, {
    requestId: "req_before",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /tmp/x" } },
  });
  expect(before.state).toBe("resolved");

  // A human takes the rope back WHILE THE TURN IS STILL RUNNING.
  const tightened = store.updateSession("session_one", { runtimeMode: "approval-required" });
  expect(tightened.runtimeMode).toBe("approval-required");

  // The next tool call parks. This is what makes it usable as a brake: it binds
  // the running turn, not merely the next one.
  const after = store.openRequest("session_one", "run_one", token, {
    requestId: "req_after",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /tmp/y" } },
  });
  expect(after.state).toBe("open");
});

test("a session can be renamed, and a no-op update writes no journal row", () => {
  const { store } = readyStore();
  const renamed = store.updateSession("session_one", { title: "  Ship the parser  " });
  expect(renamed.title).toBe("Ship the parser");
  expect(store.readEvents("session_one").filter((e) => e.type === "session.updated")).toHaveLength(1);

  // A client polling a save button must not fill the journal with rows saying
  // nothing happened.
  store.updateSession("session_one", { title: "Ship the parser" });
  expect(store.readEvents("session_one").filter((e) => e.type === "session.updated")).toHaveLength(1);

  expect(() => store.updateSession("session_one", { title: "   " })).toThrow(/cannot be empty/);
  expect(() => store.updateSession("session_one", { runtimeMode: "yolo" as "auto" })).toThrow(/unknown runtime mode/);
});

test("settling is a pin in either direction, and null hands the session back to the clock", () => {
  const { store } = readyStore();
  // Three answers, which is why this is an enum and not a boolean: shelve it,
  // keep it, or let the inactivity rule decide.
  expect(store.updateSession("session_one", { settledOverride: "settled" })).toMatchObject({ settledOverride: "settled", settledAt: 100 });
  expect(store.updateSession("session_one", { settledOverride: "active" })).toMatchObject({ settledOverride: "active" });
  const cleared = store.updateSession("session_one", { settledOverride: null });
  expect(cleared.settledOverride).toBeUndefined();
  expect(cleared.settledAt).toBeUndefined();
  expect(() => store.updateSession("session_one", { settledOverride: "maybe" as "settled" })).toThrow(/settledOverride/);
});

test("a snooze carries BOTH stamps, because 'has anything happened since' needs a baseline", () => {
  const { store } = readyStore();
  const snoozed = store.updateSession("session_one", { snoozedUntil: 9_000 });
  expect(snoozed).toMatchObject({ snoozedUntil: 9_000, snoozedAt: 100 });
  const woken = store.updateSession("session_one", { snoozedUntil: null });
  expect(woken.snoozedUntil).toBeUndefined();
  expect(woken.snoozedAt).toBeUndefined();
  expect(() => store.updateSession("session_one", { snoozedUntil: Number.NaN })).toThrow(/timestamp/);
});

test("a settled or snoozed session comes back on its own when a human queues work", () => {
  const { store } = readyStore();
  store.updateSession("session_one", { settledOverride: "settled", snoozedUntil: 9_000 });
  // THE RULE THAT KEEPS SETTLING FROM BEING A PLACE THINGS GET LOST: a person
  // settled this meaning "done for now", and typing at it means they are not.
  store.submitTurn("session_one", { runId: "run_wake", input: "Actually, one more thing" });
  const session = store.getSession("session_one");
  expect(session.settledOverride).toBeUndefined();
  expect(session.snoozedUntil).toBeUndefined();
  expect(session.snoozedAt).toBeUndefined();
  // The client is told, rather than having to poll for it.
  expect(store.readEvents("session_one").filter((event) => event.type === "session.updated")).toHaveLength(2);
});
