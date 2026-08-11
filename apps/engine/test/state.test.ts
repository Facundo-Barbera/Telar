import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDaemonLock, EngineStateError, EngineStore, statePaths, vnextRootFromEnv } from "../src/state";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vnext-engine-"));
  roots.push(directory);
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

test("the engine requires an explicit absolute home and writes only beneath its vNext root", () => {
  expect(() => vnextRootFromEnv({})).toThrow(EngineStateError);
  expect(() => vnextRootFromEnv({ TELAR_HOME: "relative" })).toThrow(EngineStateError);
  expect(vnextRootFromEnv({ TELAR_HOME: "/tmp/telar" })).toBe(path.join(fs.realpathSync.native("/tmp"), "telar", "vnext"));
  const { root: stateRoot } = readyStore();
  expect(fs.existsSync(path.join(stateRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(path.join(stateRoot, "sessions", "session_one", "session.json"))).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(stateRoot), "chats.json"))).toBe(false);
});

test("submitting a stable run id is idempotent and a session has only one active turn", () => {
  const { store } = readyStore();
  const initial = store.submitTurn("session_one", { runId: "run_one", text: "Hello" });
  expect(initial.replayed).toBe(false);
  expect(store.submitTurn("session_one", { runId: "run_one", text: "Hello" })).toEqual({ ...initial, replayed: true });
  expect(() => store.submitTurn("session_one", { runId: "run_one", text: "Different" })).toThrow(EngineStateError);
  expect(() => store.submitTurn("session_one", { runId: "run_two", text: "Second" })).toThrow(/active turn/);
  expect(store.readEvents("session_one").map((event) => event.type)).toEqual(["session.created", "turn.accepted"]);
});

test("stop is durable and idempotent", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", text: "Hello" });
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(true);
  expect(store.turns("session_one")[0]?.state).toBe("stopped");
  expect(store.stopTurn("session_one", "run_one").stopped).toBe(false);
  expect(store.readEvents("session_one").at(-1)?.type).toBe("turn.stopped");
});

test("recovery returns merely claimed work to queued and makes running work explicitly ambiguous", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "claimed_turn", text: "Hello" });
  expect(store.claimTurn("session_one", "worker_one")?.state).toBe("claimed");
  expect(store.recover()).toEqual({ requeued: ["claimed_turn"], ambiguous: [] });
  expect(store.turns("session_one")[0]?.state).toBe("queued");
  const claimed = store.claimTurn("session_one", "worker_one");
  store.markRunning("session_one", "claimed_turn", claimed!.claim!.token);
  expect(store.recover()).toEqual({ requeued: [], ambiguous: ["claimed_turn"] });
  expect(store.turns("session_one")[0]?.state).toBe("ambiguous");
  expect(() => store.submitTurn("session_one", { runId: "later_turn", text: "must wait" })).toThrow(/ambiguous/);
  expect(store.readEvents("session_one").at(-1)).toMatchObject({ type: "turn.ambiguous", runId: "claimed_turn" });
});

test("a human discard resolves only an ambiguous turn and permits a fresh submitted run", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "uncertain_run", text: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one");
  store.markRunning("session_one", "uncertain_run", claimed!.claim!.token);
  store.recover();

  const discarded = store.discardAmbiguousTurn("session_one", "uncertain_run");
  expect(discarded).toMatchObject({ runId: "uncertain_run", state: "discarded", discardedAt: 100 });
  expect(discarded.claim).toBeUndefined();
  expect(store.readEvents("session_one").at(-1)).toMatchObject({
    type: "turn.discarded",
    runId: "uncertain_run",
    data: { decision: "discarded" },
  });
  expect(store.submitTurn("session_one", { runId: "fresh_run", text: "Hello" })).toMatchObject({
    replayed: false,
    turn: { runId: "fresh_run", state: "queued" },
  });
  expect(store.turns("session_one").map((turn) => [turn.runId, turn.state])).toEqual([
    ["uncertain_run", "discarded"],
    ["fresh_run", "queued"],
  ]);
});

test("startup recovery repairs Claude continuity from a completed turn after an interrupted metadata write", () => {
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "first", text: "Hello" });
  const claimed = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "first", claimed.claim!.token);
  store.completeTurn("session_one", "first", claimed.claim!.token, "Done", "claude-session-one");

  const metadataFile = path.join(stateRoot, "sessions", "session_one", "session.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as { provider: { kind: string; sessionId?: string } };
  delete metadata.provider.sessionId;
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`);

  const restarted = new EngineStore(stateRoot, () => 200);
  restarted.recover();
  expect(restarted.getSession("session_one").provider).toEqual({ kind: "claude", sessionId: "claude-session-one" });
  restarted.submitTurn("session_one", { runId: "second", text: "Again" });
  expect(restarted.claimNextTurn("worker_two")?.provider).toEqual({ kind: "claude", sessionId: "claude-session-one" });
});

test("discard cannot alter a non-ambiguous turn", () => {
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", text: "Hello" });
  expect(() => store.discardAmbiguousTurn("session_one", "run_one")).toThrow(/only an ambiguous turn/);
  expect(store.turns("session_one")[0]).toMatchObject({ runId: "run_one", state: "queued" });
  expect(store.readEvents("session_one").map((event) => event.type)).toEqual(["session.created", "turn.accepted"]);
});

test("project roots are canonical existing directories and legacy homes are rejected through symlinks", () => {
  const stateRoot = root();
  const store = new EngineStore(stateRoot);
  expect(() => store.registerProject({ id: "missing", name: "Missing", root: path.join(stateRoot, "missing") })).toThrow(/existing directory/);
  const link = path.join(stateRoot, "project-link");
  fs.symlinkSync("/tmp", link);
  expect(store.registerProject({ id: "canonical", name: "Canonical", root: link }).root).toBe(fs.realpathSync.native("/tmp"));

  const legacy = path.join(os.homedir(), ".telar");
  const alias = path.join(stateRoot, "legacy-link");
  fs.symlinkSync(legacy, alias);
  expect(() => vnextRootFromEnv({ TELAR_HOME: legacy })).toThrow(/legacy Telar state/);
  expect(() => vnextRootFromEnv({ TELAR_HOME: alias })).toThrow(/legacy Telar state/);
});

test("an interrupted final journal append is truncated, while malformed complete records are rejected", () => {
  const { store, root: stateRoot } = readyStore();
  const journal = path.join(stateRoot, "sessions", "session_one", "events.ndjson");
  const valid = fs.readFileSync(journal, "utf8");
  fs.appendFileSync(journal, '{"id":2');
  expect(store.readEvents("session_one")).toHaveLength(1);
  expect(fs.readFileSync(journal, "utf8")).toBe(valid);
  fs.appendFileSync(journal, JSON.stringify({ id: 2, at: 100, type: "turn.accepted", data: {}, runId: "run_one" }));
  expect(store.readEvents("session_one")).toHaveLength(2);
  expect(fs.readFileSync(journal, "utf8")).toEndWith("\n");
  fs.appendFileSync(journal, "not-json\n");
  expect(() => store.readEvents("session_one")).toThrow();
});

test("stale lock recovery uses exclusive replacement and never removes a newly held lock", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const first = acquireDaemonLock(paths);
  expect(() => acquireDaemonLock(paths)).toThrow(/already locked/);
  first.release();
});

test("concurrent stale-lock breakers elect exactly one replacement owner", async () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const source = path.resolve(import.meta.dir, "../src/state.ts");
  const program = `import { acquireDaemonLock, statePaths } from ${JSON.stringify(source)};
const lock = acquireDaemonLock(statePaths(${JSON.stringify(stateRoot)}));
setTimeout(() => { lock.release(); process.exit(0); }, 1_000);`;
  const left = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const right = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const statuses = await Promise.all([left.exited, right.exited]);
  expect(statuses.sort()).toEqual([0, 1]);
});
