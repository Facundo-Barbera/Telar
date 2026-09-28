import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Turn } from "@telar/engine-client";
import { acquireDaemonLock, EngineStateError, EngineStore, migrateLegacyEngineRoot, engineRootFromEnv } from "../src/state";
import { statePaths } from "../src/platform/fs/state-paths";
import type { ExecutionStore } from "../src/platform/db/execution-store";

const roots: string[] = [];
/**
 * A Claude default this temp home already knows, so a claim is not withheld
 * waiting for a model list nobody is going to read here. Real homes learn this
 * from the provider; see `rememberClaudeDefault`.
 */
const knownClaudeDefault = (directory: string): string => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
  roots.push(directory);
  return knownClaudeDefault(directory);
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

const documents = (store: EngineStore) => (store as unknown as { kernel: { executionStore: ExecutionStore } }).kernel.executionStore;

// Rewrites a stored session_one document, as an older build left it.
function editDocument(store: EngineStore, stateRoot: string, name: string, edit: (value: any) => void): void {
  const file = path.join(stateRoot, "sessions", "session_one", name);
  const value = documents(store).read(file);
  edit(value);
  documents(store).write(file, value);
}

test("the engine requires an explicit absolute home and writes only beneath its Telar root", () => {
  expect(() => engineRootFromEnv({})).toThrow(EngineStateError);
  expect(() => engineRootFromEnv({ TELAR_HOME: "relative" })).toThrow(EngineStateError);
  expect(engineRootFromEnv({ TELAR_HOME: "/tmp/telar" })).toBe(path.join(fs.realpathSync.native("/tmp"), "telar", "engine"));
  const { root: stateRoot } = readyStore();
  expect(fs.existsSync(path.join(stateRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(path.join(stateRoot, "sessions", "session_one", "session.json"))).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(stateRoot), "chats.json"))).toBe(false);
});

describe("the store survives being renamed out of vnext/", () => {
  /**
   * THE FAILURE THIS PREVENTS IS SILENT AND TOTAL. The engine root moved from
   * `<TELAR_HOME>/vnext` to `<TELAR_HOME>/engine` when the app stopped being
   * called vNext. Without the migration the daemon finds an empty directory,
   * creates it, and comes up perfectly healthy with every project and session
   * gone — no error anywhere, because nothing was ever wrong with the new root.
   */
  test("an existing vnext/ store is renamed into place", () => {
    const home = root();
    const legacy = path.join(home, "vnext");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "projects.json"), '{"projects":[]}', "utf8");

    expect(migrateLegacyEngineRoot(path.join(home, "engine"))).toBe(true);
    expect(fs.existsSync(path.join(home, "engine", "projects.json"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  test("a store already in place is never overwritten by a stale vnext/", () => {
    // Both names existing means somebody ran an old build after a new one. The
    // CURRENT root wins; renaming over it would replace live state with older
    // state, which is worse than the leftover directory.
    const home = root();
    fs.mkdirSync(path.join(home, "vnext"), { recursive: true });
    fs.mkdirSync(path.join(home, "engine"), { recursive: true });
    fs.writeFileSync(path.join(home, "engine", "projects.json"), '{"projects":[]}', "utf8");

    expect(migrateLegacyEngineRoot(path.join(home, "engine"))).toBe(false);
    expect(fs.existsSync(path.join(home, "vnext"))).toBe(true);
  });

  test("nothing to migrate is not an error, and says nothing", () => {
    expect(migrateLegacyEngineRoot(path.join(root(), "engine"))).toBe(false);
  });

  test("a root explicitly pinned AT the old name is left exactly where it is", () => {
    // Tests and anyone who passed `--engine-root .../vnext` by hand. Renaming a
    // directory onto itself is either a no-op or a crash, depending on the
    // platform; neither is something to find out at somebody's boot.
    const home = root();
    const pinned = path.join(home, "vnext");
    fs.mkdirSync(pinned, { recursive: true });
    expect(migrateLegacyEngineRoot(pinned)).toBe(false);
    expect(fs.existsSync(pinned)).toBe(true);
  });
});

test("the event cursor is the last journal id", () => {
  const { store } = readyStore();
  expect(store.eventCursor("session_one")).toBe(1); // session.created
  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  store.stopTurn("session_one", "run_one");
  expect(store.eventCursor("session_one")).toBe(store.readEvents("session_one").at(-1)!.id);
});

test("a windowed snapshot is the newest settled turns plus everything unsettled, paged by runId", () => {
  const { store } = readyStore();
  for (const n of [1, 2, 3, 4, 5]) {
    const runId = `run_${n}`;
    store.submitTurn("session_one", { runId, input: `Turn ${n}` });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.ingestObservations("session_one", runId, token, [
      { kind: "item.started", item: { id: `i_${n}`, detail: { type: "assistant_message", text: `Answer ${n}` } } },
      { kind: "item.completed", itemId: `i_${n}`, status: "completed" },
    ]);
    store.completeTurn("session_one", runId, token, { text: `Answer ${n}` });
  }
  store.submitTurn("session_one", { runId: "run_live", input: "Now" }); // queued — unsettled

  const first = store.snapshotWindow("session_one", { limit: 2 });
  expect(first.turns.map((turn) => turn.runId)).toEqual(["run_4", "run_5", "run_live"]);
  expect(first.page).toEqual({ before: "run_4", more: true, total: 6 });
  // Items follow their turns — the window is what makes the read small.
  expect(first.items.map((item) => item.id).sort()).toEqual(["i_4", "i_5"]);

  const older = store.snapshotWindow("session_one", { limit: 2, before: "run_4" });
  expect(older.turns.map((turn) => turn.runId)).toEqual(["run_2", "run_3"]);
  expect(older.page).toEqual({ before: "run_2", more: true, total: 6 });

  const oldest = store.snapshotWindow("session_one", { limit: 2, before: "run_2" });
  expect(oldest.turns.map((turn) => turn.runId)).toEqual(["run_1"]);
  expect(oldest.page).toEqual({ before: null, more: false, total: 6 });

  // A limit past the start is the whole history, first page, no cursor.
  const whole = store.snapshotWindow("session_one", { limit: 50 });
  expect(whole.turns).toHaveLength(6);
  expect(whole.page).toEqual({ before: null, more: false, total: 6 });

  expect(() => store.snapshotWindow("session_one", { limit: 2, before: "run_nope" })).toThrow(EngineStateError);
});

test("a windowed snapshot carries the window's requests and every open one, not the whole history", () => {
  // THE KEY THAT USED TO IGNORE THE WINDOW. On the dogfood store this was 549
  // requests / 315 KB per read, of which 44 were in the window and none were
  // unresolved — re-read every second by every open cockpit.
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one", detached: false });

  for (const n of [1, 2, 3, 4, 5]) {
    const runId = `run_${n}`;
    store.submitTurn("session_one", { runId, input: `Turn ${n}` });
    const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
    store.markRunning("session_one", runId, token);
    store.openRequest("session_one", runId, token, {
      requestId: `req_${n}`,
      kind: "command_execution",
      detail: { kind: "command_execution", command: { command: `echo ${n}` } },
    });
    store.resolveRequest("session_one", `req_${n}`, { decision: "accept" });
    store.completeTurn("session_one", runId, token, { text: `Answer ${n}` });
  }
  // …and one still running, holding the question nobody has answered.
  store.submitTurn("session_one", { runId: "run_live", input: "Now" });
  const liveToken = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_live", liveToken);
  store.openRequest("session_one", "run_live", liveToken, {
    requestId: "req_open",
    kind: "command_execution",
    detail: { kind: "command_execution", command: { command: "rm -rf build" } },
  });

  const first = store.snapshotWindow("session_one", { limit: 2 });
  expect(first.requests.map((request) => request.id)).toEqual(["req_4", "req_5", "req_open"]);

  // An older page drops the newer turns' settled requests — but NOT the open
  // one: a client replaces this key rather than merging it, so a question left
  // off a page is a question the composer stops being able to answer.
  const older = store.snapshotWindow("session_one", { limit: 2, before: "run_4" });
  expect(older.requests.map((request) => request.id)).toEqual(["req_2", "req_3", "req_open"]);

  // The unwindowed read is unchanged: everything the session ever opened.
  expect(store.requests("session_one")).toHaveLength(6);
});

test("the cached item projection is per session and never outlives a write", () => {
  // The cache is what makes the read above cheap; a stale one would serve a
  // closed item as still open, or one session's rows to another.
  const { store } = readyStore();
  store.createSession({ id: "session_two", projectId: "project_one" });
  const open = (sessionId: string, runId: string, itemId: string): string => {
    store.submitTurn(sessionId, { runId, input: "Hello" });
    const token = store.claimTurn(sessionId, `worker_${sessionId}`)!.claim!.token;
    store.markRunning(sessionId, runId, token);
    store.ingestObservations(sessionId, runId, token, [
      { kind: "item.started", item: { id: itemId, detail: { type: "assistant_message", text: "" } } },
    ]);
    return token;
  };
  const oneToken = open("session_one", "run_one", "i_one");
  const twoToken = open("session_two", "run_two", "i_two");

  // Interleaved, so a cache keyed by anything but the session would cross them.
  store.ingestObservations("session_one", "run_one", oneToken, [{ kind: "content.delta", itemId: "i_one", stream: "assistant_text", text: "a" }]);
  store.ingestObservations("session_two", "run_two", twoToken, [{ kind: "content.delta", itemId: "i_two", stream: "assistant_text", text: "b" }]);
  store.ingestObservations("session_one", "run_one", oneToken, [{ kind: "item.completed", itemId: "i_one", status: "completed", detail: { type: "assistant_message", text: "a" } }]);

  expect(store.items("session_one").map((item) => [item.id, item.status])).toEqual([["i_one", "completed"]]);
  expect(store.items("session_two").map((item) => [item.id, item.status])).toEqual([["i_two", "inProgress"]]);
});

test("a turn that fails while parked on a question retires the question; the session is idle and recoverable", () => {
  // Reproduced live: the provider CLI was killed while inside AskUserQuestion.
  // The turn failed, but the request stayed open — sidebar "Waiting on you",
  // composer in answer mode, continuation unreachable.
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Write a checkpoint then wait" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  const asked = store.openRequest("session_one", "run_one", token, {
    requestId: "req_question",
    kind: "user_input",
    detail: { kind: "user_input", prompt: "Wait or continue?", fields: [{ key: "choice", label: "Choice", kind: "choice", choices: ["Wait", "Continue"] }] },
  });
  expect(asked.state).toBe("open");
  expect(store.getSession("session_one").activity).toBe("blocked");

  store.failTurn("session_one", "run_one", token, { code: "driver_failed", message: "Claude Code process terminated by signal SIGKILL" });

  const request = store.requests("session_one").find((candidate) => candidate.id === "req_question");
  expect(request).toMatchObject({ state: "resolved", decision: "cancel", resolvedBy: "cancelled", resolvedAt: 100 });
  expect(store.getSession("session_one")).toMatchObject({ activity: "idle", lastTurnFailed: true });
  expect(store.readEvents("session_one").filter((event) => event.type === "request.resolved" && event.requestId === "req_question")).toHaveLength(1);
  // Nothing left for a human to answer — and answering again is refused.
  expect(() => store.resolveRequest("session_one", "req_question", { decision: "accept" })).toThrow(/already been resolved/);
  // The next human turn is accepted: the session is not stuck behind the question.
  expect(store.submitTurn("session_one", { runId: "run_two", input: "Keep the existing checkpoint." }).turn.state).toBe("queued");
});

test("a v1 document names the version break instead of reading as corruption", () => {
  const { store, root: stateRoot } = readyStore();
  editDocument(store, stateRoot, "queue.json", (queue) => { queue.version = 1; });
  // A bare schema failure here would read as disk corruption and send an
  // operator looking in the wrong place.
  expect(() => store.turns("session_one")).toThrow(/protocol v1/);
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

/**
 * ISSUE #894. The pid is the only thing a person can act on, and until this it
 * was nowhere: the engine threw "engine state root is already locked", the
 * desktop turned any engine exit into a silent `app.quit()`, and the owner got
 * a Telar that opened and closed again with nothing on screen. `main.ts` prints
 * this message beside the lock's path and the shell puts the pid in the dialog,
 * so it has to be IN the message rather than only in the file.
 */
test("a live owner's refusal names the pid holding the lock", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  // This process: alive by construction, so `processExists` is true for the
  // one pid this test can be certain about.
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, token: "live", hostname: os.hostname() }));
  expect(() => acquireDaemonLock(paths)).toThrow(new RegExp(`already locked \\(pid ${process.pid}\\)`));
  // The lock is still whole: refusing must not have broken what it named.
  expect(JSON.parse(fs.readFileSync(paths.lock, "utf8")).token).toBe("live");
  fs.unlinkSync(paths.lock);
});

test("the live-owner refusal and the other-machine one stay distinguishable", () => {
  /**
   * `/locked by/` is how the #630 test below tells the cross-host refusal from
   * every other one. A live-owner message spelled "already locked by pid N"
   * would satisfy that regex too and quietly make it vacuous — a marker both
   * states emit is not a marker. The spelling is `(pid N)` for that reason,
   * and this is the assertion that keeps it so.
   */
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, token: "live", hostname: os.hostname() }));
  let live = "";
  try { acquireDaemonLock(paths); } catch (error) { live = (error as Error).message; }
  fs.unlinkSync(paths.lock);

  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "elsewhere", hostname: `${os.hostname()}-other` }));
  let elsewhere = "";
  try { acquireDaemonLock(paths); } catch (error) { elsewhere = (error as Error).message; }

  expect(live).toMatch(/already locked/);
  expect(live).not.toMatch(/locked by/);
  expect(elsewhere).toMatch(/locked by/);
  expect(elsewhere).not.toMatch(/already locked/);
});

/**
 * ISSUE #630. A store on a removable volume can be carried to a second Mac, so
 * "is that pid alive?" stops being a sound staleness test: pids are small
 * integers every machine hands out from the same range, and the one recorded by
 * a daemon still running over there is very likely dead here. Breaking that
 * lock puts two daemons on one store.
 */
test("a lock written by another machine is held, not stale, however dead its pid looks here", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  // A pid that cannot exist, which is exactly what makes this the dangerous
  // case: every local test says the owner is gone.
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "elsewhere", hostname: `${os.hostname()}-other` }));
  expect(() => acquireDaemonLock(paths)).toThrow(/locked by/);
  // And it is still there afterwards: refusing must not have broken it.
  expect(JSON.parse(fs.readFileSync(paths.lock, "utf8")).token).toBe("elsewhere");
});

test("a lock from before hostnames were compared is still reclaimable when its pid is gone", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "old" }));
  const lock = acquireDaemonLock(paths);
  expect(lock.token).not.toBe("old");
  lock.release();
});

test("this machine's own stale lock is still reclaimed", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead", hostname: os.hostname() }));
  const lock = acquireDaemonLock(paths);
  expect(lock.token).not.toBe("dead");
  lock.release();
});

test("concurrent stale-lock breakers elect exactly one replacement owner", async () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const source = path.resolve(import.meta.dir, "../src/state.ts");
  const program = `import { acquireDaemonLock } from ${JSON.stringify(source)}; import { statePaths } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/platform/fs/state-paths.ts"))};
const lock = acquireDaemonLock(statePaths(${JSON.stringify(stateRoot)}));
setTimeout(() => { lock.release(); process.exit(0); }, 1_000);`;
  const left = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const right = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const statuses = await Promise.all([left.exited, right.exited]);
  expect(statuses.sort()).toEqual([0, 1]);
});

test("a file patch cannot be asked for outside the session's own workspace", () => {
  // `git diff -- <path>` takes a pathspec, and `../../` in one is how a client
  // asks to read a file it was never offered. Fenced in the store rather than at
  // the route, so an in-process caller cannot walk past it either.
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.sessionFilePatchAsync("session_one", "../../etc/passwd")).toThrow(EngineStateError);
  expect(() => store.sessionFilePatchAsync("session_one", "  ")).toThrow(EngineStateError);
});

test("a commit needs a message and the message has a ceiling", () => {
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  store.createSession({ id: "session_one", projectId: "project_one" });
  expect(() => store.commitSessionWork("session_one", "   ")).toThrow(EngineStateError);
  expect(() => store.commitSessionWork("session_one", "x".repeat(2_001))).toThrow(EngineStateError);
});

/**
 * CLONE AND REGISTER, which the Sources palette makes one gesture.
 *
 * Git is stubbed: what is worth pinning is that the registration happens against
 * the folder the clone created and that a failed clone leaves no registration
 * behind, neither of which needs a network.
 */
describe("cloneProject", () => {
  /** A git that creates what it claims to have cloned, and records its argv. */
  const cloningGit = (calls: string[][] = []): import("../src/platform/git/runner").GitRunner => (_cwd, args) => {
    calls.push(args);
    if (args[0] === "clone") fs.mkdirSync(args[args.length - 1], { recursive: true });
    return { status: 0, stdout: "", stderr: "" };
  };

  test("what landed is what gets registered, named after the folder git chose", async () => {
    const parent = fs.realpathSync.native(root());
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    const project = await store.cloneProject({ url: "https://github.com/owner/repo.git", parent });
    expect(project).toMatchObject({ name: "repo", root: path.join(parent, "repo") });
    // And it is in the registry, which is the half a two-call client could miss.
    expect(store.listProjects().map((entry) => entry.id)).toEqual([project.id]);
    expect(calls[0]).toEqual(["clone", "--", "https://github.com/owner/repo.git", path.join(parent, "repo")]);
  });

  test("a name can be given, and a blank one falls back to the folder", async () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, { git: cloningGit() });
    expect((await store.cloneProject({ url: "https://x.test/a/one.git", parent, name: "Mine" })).name).toBe("Mine");
    expect((await store.cloneProject({ url: "https://x.test/a/two.git", parent, name: "   " })).name).toBe("two");
  });

  test("a clone that failed registers nothing, and says why in git's own words", async () => {
    const parent = fs.realpathSync.native(root());
    const store = new EngineStore(root(), () => 100, {
      git: () => ({ status: 128, stdout: "", stderr: "fatal: repository not found\n" }),
    });
    await expect(store.cloneProject({ url: "https://x.test/a/gone.git", parent })).rejects.toThrow(/repository not found/);
    expect(store.listProjects()).toEqual([]);
  });

  test("a target that already exists is a conflict rather than a merge into it", async () => {
    const parent = fs.realpathSync.native(root());
    fs.mkdirSync(path.join(parent, "repo"));
    const calls: string[][] = [];
    const store = new EngineStore(root(), () => 100, { git: cloningGit(calls) });
    await expect(store.cloneProject({ url: "https://x.test/a/repo.git", parent })).rejects.toThrow(EngineStateError);
    // Refused before git ran, so nothing was written into somebody's folder.
    expect(calls).toEqual([]);
  });
});

test("the gitignore write has an undo, and it is the project's own block only", () => {
  // Adding a project ignores Telar's files WITHOUT asking now, so the toast's
  // Undo has to reach the engine — and reach only what the engine wrote.
  const projectRoot = fs.realpathSync.native(root());
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n");
  const store = new EngineStore(root(), () => 100, { git: () => ({ status: 0, stdout: "", stderr: "" }) });
  store.registerProject({ id: "project_one", name: "One", root: projectRoot });

  const added = store.projectGitignore("project_one");
  expect(added.added.length).toBeGreaterThan(0);
  const removal = store.undoProjectGitignore("project_one");
  expect(removal.removed).toEqual(added.added);
  expect(fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8")).toBe("node_modules/\n");
  // Twice is not an error: the toast may arrive after a hand edit.
  expect(store.undoProjectGitignore("project_one").removed).toEqual([]);
});

test("an effort can be set without naming a model, and clearing the model keeps it", () => {
  // THE DEFECT THIS PINS: `ModelSelection` used to require a model in order to
  // carry an effort, so a session on the provider default — which is the
  // default — could not be told to think harder. The composer's reasoning pill
  // had nothing to write and read as a missing feature.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  const updated = store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, effort: "max" } });
  expect(updated.model).toEqual({ instanceId: session.providerInstanceId, effort: "max" });

  // And it survives the turn, which is where it actually has to arrive — beside
  // the long-window default the claim fills in, since Telar publishes no short
  // Claude rows and a turn that named no model must not run one.
  store.submitTurn("session_one", { runId: "run_one", input: "hi" });
  expect(store.claimNextTurn("worker_one")?.model).toEqual({ instanceId: session.providerInstanceId, effort: "max", model: "claude-opus-5[1m]" });
});

test("a per-turn selection may be an effort alone", () => {
  const { store } = readyStore();
  const session = store.getSession("session_one");
  const { turn } = store.submitTurn("session_one", { runId: "run_one", input: "hi", model: { effort: "low" } });
  expect(turn.model).toEqual({ instanceId: session.providerInstanceId, effort: "low" });
});

test("a selection that selects nothing is refused rather than stored", () => {
  // An empty selection is an ABSENT selection, and the engine should see it as
  // one rather than writing a record that says nothing.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  expect(() => store.updateSession("session_one", { model: { instanceId: session.providerInstanceId } as never })).toThrow(
    EngineStateError,
  );
});

test("a model selection can be cleared, which `undefined` could never express", () => {
  // THE BUG THIS PINS: the cockpit's "Provider default" row sent `model:
  // undefined`, `JSON.stringify` dropped the key, and the engine saw no patch
  // at all — so the pill said one thing, the record said another, and a reload
  // snapped the old model back.
  const { store } = readyStore();
  const session = store.getSession("session_one");
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5", effort: "max" } });
  expect(store.getSession("session_one").model).toBeDefined();

  expect(store.updateSession("session_one", { model: null }).model).toBeUndefined();
  // And an absent key still means "leave it alone", which is the other half of
  // the distinction.
  store.updateSession("session_one", { model: { instanceId: session.providerInstanceId, model: "claude-opus-5" } });
  expect(store.updateSession("session_one", { title: "Renamed" }).model?.model).toBe("claude-opus-5");
});

test("stopBackgroundTasks ends lingering background work and queues the real kill", () => {
  /**
   * THE "N tasks still working" CHIP. A background task outlives its turn, so
   * there is no turn to stop; this verb marks it `stopped` in the projection
   * (the roster is right at once) and queues the actual process kill for the
   * worker to drain off the heartbeat.
   */
  const { store } = readyStore();
  store.submitTurn("session_one", { runId: "run_one", input: "Tail" });
  const claim = store.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.ingestObservations("session_one", "run_one", token, [
    {
      kind: "task.started",
      task: { id: "task_b", kind: "background", state: "running", title: "Tail the log", providerTaskId: "bqo5yo8lm" },
    },
  ]);
  store.completeTurn("session_one", "run_one", token, { text: "started" });

  // The task lingers past its completed turn — this is the feature.
  expect(store.tasks("session_one").find((t) => t.id === "task_b")).toMatchObject({ state: "running" });

  const stopped = store.stopBackgroundTasks("session_one");
  expect(stopped).toBe(1);
  expect(store.tasks("session_one").find((t) => t.id === "task_b")).toMatchObject({ state: "stopped" });

  // The real kill is queued for the worker — by PROVIDER id, the handle the
  // live CLI process knows the task by.
  const queued = store.taskStopsForWorker("worker_one");
  expect(queued.map(({ sessionId, providerTaskId }) => ({ sessionId, providerTaskId }))).toEqual([{ sessionId: "session_one", providerTaskId: "bqo5yo8lm" }]);
  // Acknowledged, it is not delivered again.
  expect(store.taskStopsForWorker("worker_one", queued.map((stop) => stop.deliveryId!))).toEqual([]);
});

test("the live-session read carries the arrangement, so a drag on one device reaches the others", () => {
  // THE PROPAGATION PATH. Every rail — the desktop shell, a browser tab, the
  // phone — polls this one route on its own cadence already; carrying the
  // layout on it is what lets a second device learn about a drop without a new
  // request, a new timer or a new connection. A blank document rides along too:
  // "nobody has arranged anything" is an answer, and a client that got no key
  // could not tell it from an engine too old to have one.
  const { store } = readyStore();
  expect(store.liveSessions().layout).toEqual({ projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" });

  store.setSidebarLayout({ projectOrder: ["p2", "p1"] });
  store.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } });
  store.setSidebarLayout({ pinnedOrder: ["s9"] });
  expect(store.liveSessions().layout).toEqual({
    projectOrder: ["p2", "p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["s9"],
    mode: "grouped",
  });
});

// ── the claimed→running window (#209) ───────────────────────────────────────

// ── subscriptions — one session woken by another ────────────────────────────

/**
 * THE COST OF AN IDLE CONVERSATION, which is the thing that decides whether a
 * person may keep their history or has to prune it to stay fast.
 */
test("releasing checks the turn's state before its hold, and refuses a removed project", () => {
  /**
   * `releaseHeldTurn` is vestigial — nothing produces a hold any more — but it
   * is still reachable by an older client and by a queue.json written before
   * this change, so its guards still have to be right about a turn that is no
   * longer queued.
   */
  const { store, root: stateRoot } = readyStore();
  store.submitTurn("session_one", { runId: "run_lost", input: "Refactor" });
  const claim = store.claimTurn("session_one", "worker_one")!;
  store.markRunning("session_one", "run_lost", claim.claim!.token);
  store.submitTurn("session_one", { runId: "run_held", input: "before the crash" });
  store.closeExecutionStore();
  const rebooted = new EngineStore(stateRoot, () => 200);
  rebooted.recover();

  /**
   * THE STATE GUARD RAN ONLY WHEN THE TURN WAS UNHELD, so a terminal turn that
   * still carried a stale `held` flag skipped it — and was reported as
   * "released", which is a lie about a turn that has already ended.
   */
  editDocument(rebooted, stateRoot, "queue.json", (queue) => {
    Object.assign(queue.turns.find((turn: Turn) => turn.runId === "run_held"), { state: "stopped", completedAt: 150 });
  });
  rebooted.closeExecutionStore();
  const withStale = new EngineStore(stateRoot, () => 300);
  expect(() => withStale.releaseHeldTurn("session_one", "run_held")).toThrow(/only a queued turn can be released/);

  /**
   * DEFENCE IN DEPTH, and worth being straight about: this pairing is currently
   * UNREACHABLE through the API. `unregisterProject` refuses while a session has
   * work in flight, and `sessionHasWorkInFlight` counts `queued` — which a held
   * turn is — so a removed project cannot acquire one. Releasing nonetheless
   * STARTS work, which is the thing `assertProjectAvailable` guards at the other
   * two doors, and a gate that only holds because a neighbouring gate happens to
   * hold is one refactor away from not holding. Built here by writing the state
   * a future change might make reachable.
   */
  const { store: away, root: awayRoot } = readyStore();
  away.submitTurn("session_one", { runId: "run_held", input: "before the crash" });
  editDocument(away, awayRoot, "queue.json", (queue) => { queue.turns[0].held = { at: 100, reason: "engine_restart" }; });
  away.closeExecutionStore();
  const registryFile = path.join(awayRoot, "projects.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects[0].removedAt = 150;
  fs.writeFileSync(registryFile, JSON.stringify(registry), "utf8");

  const awayBoot = new EngineStore(awayRoot, () => 300);
  expect(() => awayBoot.releaseHeldTurn("session_one", "run_held")).toThrow(/removed from Telar/);
  // ...and it is still held afterwards, rather than half-released by a throw.
  expect(awayBoot.turns("session_one")[0]?.held).toBeDefined();
});

/**
 * #290 — A TURN THAT HIT A USAGE LIMIT COMES BACK BY ITSELF.
 *
 * The engine has no timer of its own for this: the sweep rides the claim poll,
 * which is the only periodic pass over live queues. That makes ONE thing easy
 * to get wrong and invisible when you do — a `failed` turn normally drops its
 * session out of `liveQueueIndex` immediately, so without the sixth predicate
 * in `queueConcernsAWorker` the sweep would never look at the session again and
 * the requeue would silently never fire. The cold-boot test below is the one
 * that actually pins that down.
 */