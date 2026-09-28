import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDaemonLock, EngineStateError, engineRootFromEnv, migrateLegacyEngineRoot } from "./state";
import { statePaths } from "./platform/fs/state-paths";
import { useTempStores } from "../test/temp-store";

const { root, readyStore } = useTempStores();

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
  // Without the rename from `<TELAR_HOME>/vnext`, the daemon would come up healthy on an empty root, with
  // every project and session silently gone.
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

test("stale lock recovery uses exclusive replacement and never removes a newly held lock", () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const first = acquireDaemonLock(paths);
  expect(() => acquireDaemonLock(paths)).toThrow(/already locked/);
  first.release();
});

/** The pid is what a person can act on, and the desktop shows only the message, so the pid has to be in it. */
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
  // `/locked by/` marks the cross-host refusal; a live-owner message spelled "locked by pid N" would make
  // that test vacuous, so it is spelled `(pid N)`.
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

/** A store on a removable volume can move to a second Mac, where the owner's pid looks dead; breaking that lock puts two daemons on one store. */
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
  const source = path.resolve(import.meta.dir, "state.ts");
  const program = `import { acquireDaemonLock } from ${JSON.stringify(source)}; import { statePaths } from ${JSON.stringify(path.resolve(import.meta.dir, "platform/fs/state-paths.ts"))};
const lock = acquireDaemonLock(statePaths(${JSON.stringify(stateRoot)}));
setTimeout(() => { lock.release(); process.exit(0); }, 1_000);`;
  const left = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const right = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const statuses = await Promise.all([left.exited, right.exited]);
  expect(statuses.sort()).toEqual([0, 1]);
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
