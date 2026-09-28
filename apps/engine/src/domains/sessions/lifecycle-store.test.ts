import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../../state";

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
  store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  store.lifecycle.createSession({ id: "session_one", projectId: "project_one" });
  return { store, root: stateRoot };
}

test("runtime mode can be tightened mid-session and binds the very next tool call", () => {
  const { store } = readyStore();
  expect(store.records.get("session_one").runtimeMode).toBe("auto");

  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  const claimed = store.claims.claimTurn("session_one", "worker_one")!;
  const token = claimed.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);

  // Under `auto`, a command resolves itself with nobody watching.
  const before = store.requestGate.open("session_one", "run_one", token, {
    requestId: "req_before",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /tmp/x" } },
  });
  expect(before.state).toBe("resolved");

  // A human takes the rope back WHILE THE TURN IS STILL RUNNING.
  const tightened = store.lifecycle.updateSession("session_one", { runtimeMode: "approval-required" });
  expect(tightened.runtimeMode).toBe("approval-required");

  // The next tool call parks. This is what makes it usable as a brake: it binds
  // the running turn, not merely the next one.
  const after = store.requestGate.open("session_one", "run_one", token, {
    requestId: "req_after",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf /tmp/y" } },
  });
  expect(after.state).toBe("open");
});

test("a session can be renamed, and a no-op update writes no journal row", () => {
  const { store } = readyStore();
  const renamed = store.lifecycle.updateSession("session_one", { title: "  Ship the parser  " });
  expect(renamed.title).toBe("Ship the parser");
  expect(store.queries.readEvents("session_one").filter((e) => e.type === "session.updated")).toHaveLength(1);

  // A client polling a save button must not fill the journal with rows saying
  // nothing happened.
  store.lifecycle.updateSession("session_one", { title: "Ship the parser" });
  expect(store.queries.readEvents("session_one").filter((e) => e.type === "session.updated")).toHaveLength(1);

  expect(() => store.lifecycle.updateSession("session_one", { title: "   " })).toThrow(/cannot be empty/);
  expect(() => store.lifecycle.updateSession("session_one", { runtimeMode: "yolo" as "auto" })).toThrow(/unknown runtime mode/);
});

test("settling is a pin in either direction, and null hands the session back to the clock", () => {
  const { store } = readyStore();
  // Three answers, which is why this is an enum and not a boolean: shelve it,
  // keep it, or let the inactivity rule decide.
  expect(store.lifecycle.updateSession("session_one", { settledOverride: "settled" })).toMatchObject({ settledOverride: "settled", settledAt: 100 });
  expect(store.lifecycle.updateSession("session_one", { settledOverride: "active" })).toMatchObject({ settledOverride: "active" });
  const cleared = store.lifecycle.updateSession("session_one", { settledOverride: null });
  expect(cleared.settledOverride).toBeUndefined();
  expect(cleared.settledAt).toBeUndefined();
  expect(() => store.lifecycle.updateSession("session_one", { settledOverride: "maybe" as "settled" })).toThrow(/settledOverride/);
});

test("a snooze carries BOTH stamps, because 'has anything happened since' needs a baseline", () => {
  const { store } = readyStore();
  const snoozed = store.lifecycle.updateSession("session_one", { snoozedUntil: 9_000 });
  expect(snoozed).toMatchObject({ snoozedUntil: 9_000, snoozedAt: 100 });
  const woken = store.lifecycle.updateSession("session_one", { snoozedUntil: null });
  expect(woken.snoozedUntil).toBeUndefined();
  expect(woken.snoozedAt).toBeUndefined();
  expect(() => store.lifecycle.updateSession("session_one", { snoozedUntil: Number.NaN })).toThrow(/timestamp/);
});

test("a settled or snoozed session comes back on its own when a human queues work", () => {
  const { store } = readyStore();
  store.lifecycle.updateSession("session_one", { settledOverride: "settled", snoozedUntil: 9_000 });
  // THE RULE THAT KEEPS SETTLING FROM BEING A PLACE THINGS GET LOST: a person
  // settled this meaning "done for now", and typing at it means they are not.
  store.intake.submitTurn("session_one", { runId: "run_wake", input: "Actually, one more thing" });
  const session = store.records.get("session_one");
  expect(session.settledOverride).toBeUndefined();
  expect(session.snoozedUntil).toBeUndefined();
  expect(session.snoozedAt).toBeUndefined();
  // The client is told, rather than having to poll for it.
  expect(store.queries.readEvents("session_one").filter((event) => event.type === "session.updated")).toHaveLength(2);
});

test("an effort can be set without naming a model, and clearing the model keeps it", () => {
  // THE DEFECT THIS PINS: `ModelSelection` used to require a model in order to
  // carry an effort, so a session on the provider default — which is the
  // default — could not be told to think harder. The composer's reasoning pill
  // had nothing to write and read as a missing feature.
  const { store } = readyStore();
  const session = store.records.get("session_one");
  const updated = store.lifecycle.updateSession("session_one", { model: { instanceId: session.providerInstanceId, effort: "max" } });
  expect(updated.model).toEqual({ instanceId: session.providerInstanceId, effort: "max" });

  // And it survives the turn, which is where it actually has to arrive — beside
  // the long-window default the claim fills in, since Telar publishes no short
  // Claude rows and a turn that named no model must not run one.
  store.intake.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claims.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, effort: "max", model: "claude-opus-5[1m]" });
});

test("a selection that selects nothing is refused rather than stored", () => {
  // An empty selection is an ABSENT selection, and the engine should see it as
  // one rather than writing a record that says nothing.
  const { store } = readyStore();
  const session = store.records.get("session_one");
  expect(() => store.lifecycle.updateSession("session_one", { model: { instanceId: session.providerInstanceId } as never })).toThrow(
    EngineStateError,
  );
});

test("a model selection can be cleared, which `undefined` could never express", () => {
  // THE BUG THIS PINS: the cockpit's "Provider default" row sent `model:
  // undefined`, `JSON.stringify` dropped the key, and the engine saw no patch
  // at all — so the pill said one thing, the record said another, and a reload
  // snapped the old model back.
  const { store } = readyStore();
  const session = store.records.get("session_one");
  store.lifecycle.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5", effort: "max" } });
  expect(store.records.get("session_one").model).toBeDefined();

  expect(store.lifecycle.updateSession("session_one", { model: null }).model).toBeUndefined();
  // And an absent key still means "leave it alone", which is the other half of
  // the distinction.
  store.lifecycle.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5" } });
  expect(store.lifecycle.updateSession("session_one", { title: "Renamed" }).model?.model).toBe("claude-opus-5");
});
