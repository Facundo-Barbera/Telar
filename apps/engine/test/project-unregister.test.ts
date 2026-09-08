/**
 * REMOVING A PROJECT FROM TELAR, and what has to survive it.
 *
 * Removal is REVERSIBLE and destroys nothing: the registration record is kept
 * and marked, so restoring the same checkout gives back the same id, the same
 * settings and the same sessions. Every test here is about something that must
 * still be true afterwards — the checkout, the Git metadata, the session
 * history, the id that MCP scopes and browser profiles are keyed by — or about
 * the two things the engine refuses while a project is away: starting work, and
 * removing it out from under work already running.
 *
 * All of it runs against temporary directories — no user project is ever
 * registered, removed or restored by this file.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";

const roots: string[] = [];
const dir = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const png = (tail = "one"): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);

function ready(): { store: EngineStore; projectRoot: string; tick: (ms: number) => void } {
  let now = 1_000;
  const store = new EngineStore(dir("telar-registry-state-"), () => now);
  const projectRoot = dir("telar-registry-checkout-");
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  return { store, projectRoot, tick: (ms) => { now += ms; } };
}

const registryOnDisk = (store: EngineStore): Array<{ id: string; root: string; removedAt?: number }> =>
  JSON.parse(fs.readFileSync(path.join(store.paths.root, "projects.json"), "utf8")).projects;

/* ------------------------------------------------------------------ *
 * Nothing is destroyed
 * ------------------------------------------------------------------ */

test("removing touches NOTHING on disk", () => {
  const { store, projectRoot } = ready();
  fs.writeFileSync(path.join(projectRoot, "icon.png"), png());
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".git/HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(projectRoot, "source.ts"), "export const kept = true;\n");

  expect(store.unregisterProject("project_one").project.id).toBe("project_one");

  expect(fs.readFileSync(path.join(projectRoot, "source.ts"), "utf8")).toBe("export const kept = true;\n");
  expect(fs.readFileSync(path.join(projectRoot, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  expect(fs.existsSync(path.join(projectRoot, "icon.png"))).toBe(true);
});

test("the record is KEPT and marked, not deleted — that is what makes restoring an undo", () => {
  const { store } = ready();
  store.updateProject("project_one", { dataScience: { enabled: true } });
  store.unregisterProject("project_one");

  const stored = registryOnDisk(store);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.id).toBe("project_one");
  expect(typeof stored[0]!.removedAt).toBe("number");
  // Gone from the registry every surface reads…
  expect(store.listProjects()).toEqual([]);
  // …and still there for the one screen that offers to put it back.
  expect(store.listProjects({ includeRemoved: true }).map((project) => project.id)).toEqual(["project_one"]);
  expect(store.getProject("project_one").dataScience).toEqual({ enabled: true });
});

test("removal and restoration both survive a restart", () => {
  const { store } = ready();
  store.unregisterProject("project_one");
  const reopened = new EngineStore(store.paths.root, () => 2_000);
  expect(reopened.listProjects()).toEqual([]);
  expect(reopened.listProjects({ includeRemoved: true })).toHaveLength(1);

  reopened.restoreProject("project_one");
  const again = new EngineStore(store.paths.root, () => 3_000);
  expect(again.listProjects().map((project) => project.id)).toEqual(["project_one"]);
});

/* ------------------------------------------------------------------ *
 * Restoring is an undo, not a new project
 * ------------------------------------------------------------------ */

test("registering the same checkout again restores the SAME project", () => {
  // The id is what sessions store, what MCP servers are scoped by and what
  // browser profiles are keyed on. A new id here would silently orphan all
  // three from an action that reads like an undo.
  const { store, projectRoot } = ready();
  store.updateProject("project_one", { dataScience: { enabled: true } });
  const session = store.createSession({ projectId: "project_one", title: "before" });
  store.unregisterProject("project_one");

  const back = store.registerProject({ name: "One", root: projectRoot });
  expect(back.id).toBe("project_one");
  expect(back.removedAt).toBeUndefined();
  expect(back.dataScience).toEqual({ enabled: true });
  expect(store.listProjects().map((project) => project.id)).toEqual(["project_one"]);
  // The session that ran here is its session again, not an orphan.
  expect(store.listSessions("project_one").map((each) => each.id)).toEqual([session.id]);
});

test("restoreProject does the same thing without needing the path, and is idempotent", () => {
  const { store } = ready();
  store.unregisterProject("project_one");
  expect(store.restoreProject("project_one").removedAt).toBeUndefined();
  expect(store.restoreProject("project_one").id).toBe("project_one");
  expect(store.listProjects()).toHaveLength(1);
});

test("a renamed restore keeps the id and takes the new name", () => {
  const { store, projectRoot } = ready();
  store.unregisterProject("project_one");
  const back = store.registerProject({ name: "One, renamed", root: projectRoot });
  expect(back.id).toBe("project_one");
  expect(back.name).toBe("One, renamed");
});

test("removing twice is a conflict, and an unknown id is a not_found", () => {
  const { store } = ready();
  store.unregisterProject("project_one");
  expect(() => store.unregisterProject("project_one")).toThrow(EngineStateError);
  expect(() => store.unregisterProject("project_nope")).toThrow(EngineStateError);
});

/* ------------------------------------------------------------------ *
 * While it is away: reads yes, new work no
 * ------------------------------------------------------------------ */

test("a removed project's sessions and history stay readable", () => {
  const { store } = ready();
  const session = store.createSession({ projectId: "project_one", title: "a finished conversation" });
  const removed = store.unregisterProject("project_one");
  // Reported rather than acted on: the engine says how many sessions belong to
  // the put-away project and leaves them alone.
  expect(removed.sessions).toBe(1);

  const after = store.getSession(session.id);
  expect(after.title).toBe("a finished conversation");
  expect(after.projectId).toBe("project_one");
  // The project still resolves for reads, which is what keeps the session's
  // past coherent instead of blank.
  expect(store.getProject("project_one").removedAt).toBeDefined();
  expect(store.listSessions("project_one").map((each) => each.id)).toEqual([session.id]);
  expect(store.turns(session.id)).toEqual([]);
});

test("no new session, no new turn, no settings change while a project is away", () => {
  const { store } = ready();
  const session = store.createSession({ projectId: "project_one", title: "idle" });
  store.unregisterProject("project_one");

  expect(() => store.createSession({ projectId: "project_one", title: "after" })).toThrow(EngineStateError);
  expect(() => store.submitTurn(session.id, { runId: "run_one", input: "carry on" })).toThrow(EngineStateError);
  expect(() => store.updateProject("project_one", { dataScience: { enabled: true } })).toThrow(EngineStateError);

  // …and all three work again the moment it is back.
  store.restoreProject("project_one");
  expect(store.submitTurn(session.id, { runId: "run_one", input: "carry on" }).turn.state).toBe("queued");
});

test("a peer's wake cannot restart a provider on a removed project", () => {
  // A subscription firing an hour later arrives as an ordinary turn. Refusing
  // it here is what stops a removal from being undone by a timer nobody is
  // watching; `fireSubscriptions` treats the conflict as "the subscriber
  // cannot take this" and writes the reason to that session's own journal.
  const { store } = ready();
  const session = store.createSession({ projectId: "project_one", title: "subscriber" });
  store.unregisterProject("project_one");
  expect(() =>
    store.submitTurn(session.id, {
      runId: "run_wake",
      input: "a peer finished",
      origin: "session",
      wakeReason: { kind: "turn_completed", sessionId: session.id, runId: "run_other" },
    }),
  ).toThrow(EngineStateError);
});

/* ------------------------------------------------------------------ *
 * Work in flight blocks removal
 * ------------------------------------------------------------------ */

test("a queued turn blocks the removal instead of being stopped", () => {
  const { store } = ready();
  const session = store.createSession({ projectId: "project_one", title: "mid-turn" });
  store.submitTurn(session.id, { runId: "run_one", input: "keep going" });
  expect(() => store.unregisterProject("project_one")).toThrow(EngineStateError);
  // Still registered, and the turn is untouched.
  expect(store.getProject("project_one").removedAt).toBeUndefined();
  expect(store.turns(session.id)).toHaveLength(1);
  expect(store.listProjects()).toHaveLength(1);
});

test("a settled turn does not block it", () => {
  const { store } = ready();
  const session = store.createSession({ projectId: "project_one", title: "finished" });
  store.submitTurn(session.id, { runId: "run_one", input: "hello" });
  store.stopTurn(session.id, "run_one");
  expect(store.unregisterProject("project_one").project.removedAt).toBeDefined();
});

test("a live BACKGROUNDED TASK blocks the removal even with every turn settled", () => {
  // The case a turns-only check walks straight past. `TaskKind` says a
  // backgrounded task continues after the turn that started it settles — so a
  // watcher, a dev server or a long shell is still running against this
  // checkout while every turn reads as finished.
  const { store } = ready();
  const session = store.createSession({ id: "session_bg", projectId: "project_one", title: "runs a server" });
  store.submitTurn(session.id, { runId: "run_one", input: "start the dev server" });
  const token = store.claimTurn(session.id, "worker_one")!.claim!.token;
  store.markRunning(session.id, "run_one", token);
  store.ingestObservations(session.id, "run_one", token, [
    { kind: "task.started", task: { id: "task_bg", kind: "background", state: "running", title: "dev server", backgrounded: true } },
  ]);
  store.stopTurn(session.id, "run_one");

  expect(store.turns(session.id).every((turn) => turn.state === "stopped")).toBe(true);
  expect(store.tasks(session.id).find((task) => task.id === "task_bg")?.state).toBe("running");
  expect(() => store.unregisterProject("project_one")).toThrow(EngineStateError);
});

test("a backgrounded task that has ENDED does not block it", () => {
  // The other side of the same check: a finished background task is history,
  // and refusing on it would make the action unreachable for any project that
  // ever ran a dev server.
  const { store } = ready();
  const session = store.createSession({ id: "session_bg", projectId: "project_one", title: "ran a server" });
  store.submitTurn(session.id, { runId: "run_one", input: "start the dev server" });
  const token = store.claimTurn(session.id, "worker_one")!.claim!.token;
  store.markRunning(session.id, "run_one", token);
  store.ingestObservations(session.id, "run_one", token, [
    { kind: "task.started", task: { id: "task_bg", kind: "background", state: "running", title: "dev server", backgrounded: true } },
    { kind: "task.completed", task: { id: "task_bg", kind: "background", state: "completed", title: "dev server", backgrounded: true } },
  ]);
  store.stopTurn(session.id, "run_one");

  expect(store.tasks(session.id).find((task) => task.id === "task_bg")?.state).toBe("completed");
  expect(store.unregisterProject("project_one").project.removedAt).toBeDefined();
});
