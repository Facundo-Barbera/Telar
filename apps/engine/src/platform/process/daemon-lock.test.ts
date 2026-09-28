import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDaemonLock } from "./daemon-lock";
import { statePaths } from "../fs/state-paths";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

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
  const source = path.resolve(import.meta.dir, "daemon-lock.ts");
  const program = `import { acquireDaemonLock } from ${JSON.stringify(source)}; import { statePaths } from ${JSON.stringify(path.resolve(import.meta.dir, "../fs/state-paths.ts"))};
const lock = acquireDaemonLock(statePaths(${JSON.stringify(stateRoot)}));
setTimeout(() => { lock.release(); process.exit(0); }, 1_000);`;
  const left = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const right = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const statuses = await Promise.all([left.exited, right.exited]);
  expect(statuses.sort()).toEqual([0, 1]);
});
