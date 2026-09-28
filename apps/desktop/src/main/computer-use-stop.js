// STOPPING THE COMPUTER-USE HELPER'S DAEMON WHEN TELAR QUITS — issue #931.
//
// The engine starts the bundled helper's daemon through LaunchServices
// (`/usr/bin/open -n -g -a …`, apps/engine/src/computer-use.ts
// `helperDaemonLaunch`), so macOS makes it its own responsible process and
// gives the TCC grants to the helper. The same launch reparents it to launchd:
// it is not our child, the engine's exit does not end it, and nothing did — it
// outlived Telar for hours, and `pgrep -f Telar.app` kept finding it.
//
// THE SHELL STOPS IT, NOT THE ENGINE. On Cmd+Q main.js SIGTERMs the engine and
// exits; the engine's IPC channel then closes and server-preload.js exits it
// on the spot, so whatever its own async shutdown had not reached yet never
// runs. `will-quit` is synchronous and runs in this process before it goes,
// which makes it the one place a stop reliably happens.
//
// ONLY OUR DAEMON. A pid is signalled only while the process table says it is
// OUR helper binary — the one inside this Telar.app — running `serve` on OUR
// socket, which is exactly how the engine launched it. A separately installed
// CuaDriver.app, another Telar's helper, and a stale pid now naming something
// else all fail that test and are left alone.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bundleId: HELPER_BUNDLE_ID } = require("./computer-use-helper.json");

/**
 * The paths the engine gives the daemon (`bundledHelper` in
 * apps/engine/src/computer-use.ts). Declared twice because this file is plain
 * CommonJS and cannot import the engine; computer-use-stop.test.js holds the
 * pair together.
 */
function bundledHelperDaemon(helperApp, home = os.homedir()) {
  const caches = path.join(home, "Library", "Caches", HELPER_BUNDLE_ID);
  return {
    binary: path.join(helperApp, "Contents", "MacOS", "cua-driver"),
    socket: path.join(caches, "driver.sock"),
    pidFile: path.join(caches, "driver.pid"),
  };
}

function psProcesses() {
  const answer = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return (answer.stdout ?? "").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

function isOurDaemon(command, helper) {
  return command.startsWith(`${helper.binary} serve`) && command.includes(`--socket ${helper.socket}`);
}

function pidFromFile(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * OUR daemon's pids — the disclaiming parent and the serving child. The pid
 * file Telar passed is one candidate; the process table is the other, because
 * cua 0.28.2 accepts `--pid-file` and never writes it (see `BundledHelper` in
 * the engine). EVERY candidate, the pid file's included, must pass
 * `isOurDaemon` against the live process table before it is returned.
 */
function helperDaemonPids(helper, deps = {}) {
  const table = (deps.processes ?? psProcesses)();
  const ours = new Set(table.filter(({ command }) => isOurDaemon(command, helper)).map(({ pid }) => pid));
  const fromFile = pidFromFile(helper.pidFile);
  const candidates = fromFile === null ? [...ours] : [fromFile, ...ours];
  return [...new Set(candidates)].filter((pid) => ours.has(pid));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * SIGTERM, then SIGKILL for whatever is still ours after `graceMs`.
 *
 * SYNCHRONOUS AND BOUNDED, because it runs inside `will-quit`, which does not
 * wait on a promise. A daemon that honours SIGTERM costs one `ps` and a few
 * milliseconds; one that does not holds the quit for `graceMs` at most. The
 * SIGKILL goes only to pids the table still called ours on the last look, so a
 * pid that exited and was reused in the meantime is not touched.
 */
function stopHelperDaemon(helper, deps = {}) {
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleepSync ?? sleepSync;
  const graceMs = deps.graceMs ?? 1_000;
  const signal = (pids, name) =>
    pids.filter((pid) => {
      try {
        kill(pid, name);
        return true;
      } catch {
        return false; // Gone already: the parent exits with its child.
      }
    });
  const terminated = signal(helperDaemonPids(helper, deps), "SIGTERM");
  if (terminated.length === 0) return { terminated, killed: [] };
  let remaining = terminated;
  for (let waited = 0; waited < graceMs; waited += 50) {
    sleep(50);
    const live = new Set(helperDaemonPids(helper, deps));
    remaining = terminated.filter((pid) => live.has(pid));
    if (remaining.length === 0) return { terminated, killed: [] };
  }
  return { terminated, killed: signal(remaining, "SIGKILL") };
}

module.exports = { bundledHelperDaemon, helperDaemonPids, stopHelperDaemon };
