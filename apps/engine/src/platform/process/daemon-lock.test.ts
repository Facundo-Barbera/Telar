import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDaemonLock, parseBootTime, type LockProbe } from "./daemon-lock";
import { statePaths } from "../fs/state-paths";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

const BOOT = 1_790_000_000_000;
const ENGINE = "telar-engine";

function fakeProbe(processes: Record<number, string>, logs: string[] = []): LockProbe {
  return {
    alive: (pid) => pid in processes,
    command: async (pid) => processes[pid] ?? "",
    bootTime: async () => BOOT,
    now: () => BOOT + 60_000,
    log: (line) => logs.push(line),
  };
}

function lockedStore(owner: Record<string, unknown>) {
  const paths = statePaths(root());
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ hostname: os.hostname(), ...owner }));
  return paths;
}

const ownerToken = (paths: { lock: string }) => JSON.parse(fs.readFileSync(paths.lock, "utf8")).token;

test("a reused pid running an unrelated command is stale, and the replacement says why", async () => {
  const paths = lockedStore({ pid: 724, token: "old", startedAt: BOOT + 1_000, command: ENGINE });
  const logs: string[] = [];
  const lock = await acquireDaemonLock(paths, fakeProbe({ 724: "/usr/libexec/trustd", [process.pid]: ENGINE }, logs));
  expect(ownerToken(paths)).toBe(lock.token);
  expect(logs).toEqual([`Telar engine: replaced a stale lock because pid 724 is now /usr/libexec/trustd — ${paths.lock}`]);
  lock.release();
});

test("a lock written before the last boot is stale even when its pid runs a Telar engine", async () => {
  const paths = lockedStore({ pid: 724, token: "old", startedAt: BOOT - 1_000, command: ENGINE });
  const logs: string[] = [];
  const lock = await acquireDaemonLock(paths, fakeProbe({ 724: ENGINE, [process.pid]: ENGINE }, logs));
  expect(ownerToken(paths)).toBe(lock.token);
  expect(logs[0]).toMatch(/written before this boot/);
  lock.release();
});

test("a live Telar engine holds the lock, and the refusal names its pid", async () => {
  const paths = lockedStore({ pid: 724, token: "live", startedAt: BOOT + 1_000, command: ENGINE });
  await expect(acquireDaemonLock(paths, fakeProbe({ 724: ENGINE, [process.pid]: ENGINE }))).rejects.toThrow(/already locked \(pid 724\)/);
  expect(ownerToken(paths)).toBe("live");
});

test("a lock without a recorded command is held by a process whose command names Telar", async () => {
  const paths = lockedStore({ pid: 724, token: "live" });
  await expect(acquireDaemonLock(paths, fakeProbe({ 724: "/Applications/Telar.app/Contents/MacOS/Telar" }))).rejects.toThrow(/already locked/);
});

test("an owner whose command cannot be read is treated as live", async () => {
  const paths = lockedStore({ pid: 724, token: "live", startedAt: BOOT + 1_000, command: ENGINE });
  const probe = { ...fakeProbe({ 724: ENGINE }), command: async () => null };
  await expect(acquireDaemonLock(paths, probe)).rejects.toThrow(/already locked \(pid 724\)/);
});

test("the new lock records what the next start compares against", async () => {
  const paths = statePaths(root());
  const lock = await acquireDaemonLock(paths, fakeProbe({ [process.pid]: ENGINE }));
  const written = JSON.parse(fs.readFileSync(paths.lock, "utf8"));
  expect(written).toMatchObject({ pid: process.pid, startedAt: BOOT + 60_000, command: ENGINE, hostname: os.hostname() });
  lock.release();
  expect(fs.existsSync(paths.lock)).toBe(false);
});

test("a recovery breaker left from before the boot does not block start", async () => {
  const paths = lockedStore({ pid: 724, token: "old", startedAt: BOOT - 1_000 });
  fs.writeFileSync(`${paths.lock}.break`, JSON.stringify({ pid: 1, token: "crashed" }));
  fs.utimesSync(`${paths.lock}.break`, (BOOT - 5_000) / 1000, (BOOT - 5_000) / 1000);
  const lock = await acquireDaemonLock(paths, fakeProbe({ [process.pid]: ENGINE }));
  expect(ownerToken(paths)).toBe(lock.token);
  lock.release();
});

test("a lock written by another machine is held, not stale, however dead its pid looks here", async () => {
  const paths = lockedStore({ pid: -1, token: "elsewhere", hostname: `${os.hostname()}-other` });
  await expect(acquireDaemonLock(paths, fakeProbe({}))).rejects.toThrow(/locked by/);
  expect(ownerToken(paths)).toBe("elsewhere");
});

test("two engines starting together on a reused-pid lock yield exactly one owner", async () => {
  const paths = lockedStore({ pid: 724, token: "old", startedAt: BOOT + 1_000, command: ENGINE });
  const probe = fakeProbe({ 724: "/usr/libexec/trustd", [process.pid]: ENGINE });
  const results = await Promise.allSettled([acquireDaemonLock(paths, probe), acquireDaemonLock(paths, probe)]);
  const winners = results.filter((result) => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  expect(ownerToken(paths)).toBe((winners[0] as PromiseFulfilledResult<{ token: string }>).value.token);
});

test("concurrent stale-lock breakers in separate processes elect exactly one replacement owner", async () => {
  const stateRoot = root();
  const paths = statePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: -1, token: "dead" }));
  const source = path.resolve(import.meta.dir, "daemon-lock.ts");
  const program = `import { acquireDaemonLock } from ${JSON.stringify(source)}; import { statePaths } from ${JSON.stringify(path.resolve(import.meta.dir, "../fs/state-paths.ts"))};
const lock = await acquireDaemonLock(statePaths(${JSON.stringify(stateRoot)}));
setTimeout(() => { lock.release(); process.exit(0); }, 1_000);`;
  const left = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const right = Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
  const statuses = await Promise.all([left.exited, right.exited]);
  expect(statuses.sort()).toEqual([0, 1]);
});

test("boot time is read from macOS sysctl and Linux /proc/stat", () => {
  expect(parseBootTime("darwin", "{ sec = 1790838355, usec = 343811 } Thu Oct  1 01:05:55 2026\n")).toBe(1_790_838_355_000);
  expect(parseBootTime("linux", "cpu  1 2 3\nbtime 1790838355\nprocesses 9\n")).toBe(1_790_838_355_000);
  expect(parseBootTime("darwin", null)).toBeNull();
});
