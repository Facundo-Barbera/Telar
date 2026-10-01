import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsmonitorCheckouts, liveFsmonitorCheckouts } from "./fsmonitor";

const run = (args: string[]) => spawnSync("git", args, { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
const temps: string[] = [];
const started: string[] = [];

afterEach(() => {
  for (const checkout of started.splice(0)) run(["-C", checkout, "fsmonitor--daemon", "stop"]);
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const daemon = (pid: number, socket: string, dirs: [number, string][]) => [
  `p${pid}`,
  "fcwd",
  "tDIR",
  "n/Users/me",
  ...dirs.flatMap(([fd, name]) => [`f${fd}`, "tDIR", `n${name}`]),
  "f34",
  "tunix",
  `n${socket}`,
];

test("names each daemon by the first directory it opened, whatever its socket says", () => {
  const listing = [
    ...daemon(10, "/repo/.git/fsmonitor--daemon.ipc", [[5, "/"], [4, "/repo"]]),
    ...daemon(11, "fsmonitor--daemon.ipc", [[4, "/wt/w1"], [5, "/wt"], [16, "/repo/.git/worktrees/w1"]]),
    "p12",
    "f4",
    "tDIR",
    "n/somewhere",
    "f5",
    "tunix",
    "n/tmp/other.sock",
  ].join("\n");
  expect(fsmonitorCheckouts(listing)).toEqual(["/repo", "/wt/w1"]);
});

test("cannot tell on Windows or without lsof", async () => {
  expect(await liveFsmonitorCheckouts({ platform: "win32" })).toBeUndefined();
  expect(await liveFsmonitorCheckouts({ platform: "darwin", lsof: async () => undefined })).toBeUndefined();
});

const daemonSupported = process.platform === "darwin" && run(["version", "--build-options"]).stdout.includes("feature: fsmonitor--daemon");

test.skipIf(!daemonSupported)("finds a real daemon in a linked worktree whose path is too long for its socket", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-fsmonitor-")));
  temps.push(dir);
  const repo = path.join(dir, "repo");
  const worktree = path.join(dir, "a-worktree-name-long-enough-that-its-socket-path-passes-the-unix-limit");
  const git = (cwd: string, ...args: string[]) => run(["-C", cwd, ...args]);
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "root");
  git(repo, "worktree", "add", "-q", worktree);
  started.push(worktree);
  expect(git(worktree, "fsmonitor--daemon", "start").status).toBe(0);

  expect((await liveFsmonitorCheckouts())?.filter((checkout) => checkout.startsWith(dir))).toEqual([worktree]);
});
