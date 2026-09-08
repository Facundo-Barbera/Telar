/**
 * TAKING A PROJECT OFF THE REGISTRY, and what has to survive it.
 *
 * Unregistering is the one write that makes a project id stop resolving, so
 * every test here is about what is NOT touched: the checkout, its Git
 * metadata, the sessions pointed at that id and their history. The refusal
 * while work is in flight is the conservative half of the same choice.
 *
 * All of it runs against temporary directories — no user project is ever
 * registered or removed by this file.
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

/** A store whose clock this test drives, so the TTLs are exercised rather than
 *  waited out. */
function ready(): { store: EngineStore; projectRoot: string; tick: (ms: number) => void } {
  let now = 1_000;
  const store = new EngineStore(dir("telar-registry-state-"), () => now);
  const projectRoot = dir("telar-registry-checkout-");
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });
  return { store, projectRoot, tick: (ms) => { now += ms; } };
}

const registryOnDisk = (store: EngineStore): Array<{ id: string; root: string }> =>
  JSON.parse(fs.readFileSync(path.join(store.paths.root, "projects.json"), "utf8")).projects;

/* ------------------------------------------------------------------ *
 * Unregistering
 * ------------------------------------------------------------------ */

test("unregistering removes the registry entry and NOTHING on disk", () => {
  const { store, projectRoot } = ready();
  fs.writeFileSync(path.join(projectRoot, "icon.png"), png());
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".git/HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(projectRoot, "source.ts"), "export const kept = true;\n");

  const removed = store.unregisterProject("project_one");
  expect(removed.project.id).toBe("project_one");
  expect(registryOnDisk(store)).toEqual([]);
  expect(() => store.getProject("project_one")).toThrow(EngineStateError);

  // The checkout is exactly as it was.
  expect(fs.readFileSync(path.join(projectRoot, "source.ts"), "utf8")).toBe("export const kept = true;\n");
  expect(fs.readFileSync(path.join(projectRoot, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  expect(fs.existsSync(path.join(projectRoot, "icon.png"))).toBe(true);
});

test("the removal survives a restart, because it is a registry write and not a cache", () => {
  const { store } = ready();
  store.unregisterProject("project_one");
  const reopened = new EngineStore(store.paths.root, () => 2_000);
  expect(reopened.listProjects()).toEqual([]);
  expect(() => reopened.getProject("project_one")).toThrow(EngineStateError);
});

test("idle sessions keep their record and their history; they just stop resolving a project", () => {
  const { store } = ready();
  const session = store.createSession({ projectId: "project_one", title: "a finished conversation" });
  const removed = store.unregisterProject("project_one");
  // The count is reported rather than acted on: the engine says how many
  // records now point at an id that will not resolve, and leaves them alone.
  expect(removed.sessions).toBe(1);
  const after = store.getSession(session.id);
  expect(after.id).toBe(session.id);
  expect(after.title).toBe("a finished conversation");
  expect(after.projectId).toBe("project_one");
  // Asking for "that project's sessions" is now a not_found, because the
  // project is. THIS IS THE STALE-NAVIGATION ANSWER: a bookmarked project URL
  // gets the honest "no project with that id" the settings page already
  // renders, rather than an empty list that reads like the work is gone.
  expect(() => store.listSessions("project_one")).toThrow(EngineStateError);
});

test("a session with work in flight blocks the removal instead of being stopped", () => {
  // THE CONSERVATIVE HALF OF THE CHOICE. The only alternatives to refusing are
  // ending somebody's turn or letting it break; neither belongs behind a
  // settings row.
  const { store } = ready();
  const session = store.createSession({ projectId: "project_one", title: "mid-turn" });
  store.submitTurn(session.id, { runId: "run_one", input: "keep going" });
  expect(() => store.unregisterProject("project_one")).toThrow(EngineStateError);
  // Still registered, and the turn is untouched.
  expect(store.getProject("project_one").id).toBe("project_one");
  expect(store.turns(session.id)).toHaveLength(1);
  expect(registryOnDisk(store)).toHaveLength(1);
});

test("unregistering an id that is not there is a not_found, not a silent success", () => {
  const { store } = ready();
  expect(() => store.unregisterProject("project_nope")).toThrow(EngineStateError);
});

test("the same folder can be registered again, under a new id, and the old id stays gone", () => {
  const { store, projectRoot } = ready();
  const session = store.createSession({ projectId: "project_one", title: "before" });
  store.unregisterProject("project_one");

  const again = store.registerProject({ name: "One", root: projectRoot });
  expect(again.id).not.toBe("project_one");
  expect(again.root).toBe(fs.realpathSync.native(projectRoot));
  expect(store.listProjects().map((project) => project.id)).toEqual([again.id]);

  // The old session is not adopted by the new registration: its stored project
  // id is the handle on a REGISTRATION, and re-registering makes a new one.
  // Its own record and history are still there, under the id that is gone.
  expect(store.listSessions(again.id)).toEqual([]);
  expect(store.getSession(session.id).projectId).toBe("project_one");
});

test("re-registering does not inherit the removed project's cached icon answer", () => {
  const { store, projectRoot } = ready();
  fs.writeFileSync(path.join(projectRoot, "icon.png"), png());
  expect(store.projectIconFile("project_one")).toBeDefined();
  store.unregisterProject("project_one");
  const again = store.registerProject({ id: "project_one", name: "One", root: dir("telar-registry-other-") });
  expect(again.id).toBe("project_one");
  expect(() => store.projectIconFile("project_one")).toThrow(EngineStateError);
});
