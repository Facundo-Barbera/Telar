"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bundleId: HELPER_BUNDLE_ID } = require("./computer-use-helper.json");

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
        return false;
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
