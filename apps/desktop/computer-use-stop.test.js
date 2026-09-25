// STOPPING THE COMPUTER-USE HELPER ON QUIT — issue #931. Real processes, but
// only FIXTURES this file spawns: a symlink to /bin/bash placed where a helper
// binary would be, run as `<binary> serve --socket <socket>` so its command
// line reads like the daemon's. Nothing here starts, finds or signals the real
// cua-driver or Telar, and every path is under a fresh temp directory.

const { afterEach, describe, expect, test } = require("bun:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bundledHelperDaemon, helperDaemonPids, stopHelperDaemon } = require("./computer-use-stop");

const spawned = [];
const scratch = [];
afterEach(() => {
  for (const child of spawned.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-stop-")));
  scratch.push(dir);
  return dir;
}

/** A helper-shaped app in a temp dir: its "binary" is a symlink to bash, and a
 *  `serve` script beside the cwd keeps it alive until stdin closes. */
function fakeHelper(dir, name, { ignoreTerm = false } = {}) {
  const app = path.join(dir, `${name}.app`);
  const binary = path.join(app, "Contents", "MacOS", "cua-driver");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.symlinkSync("/bin/bash", binary);
  const cwd = path.join(dir, `${name}-cwd`);
  fs.mkdirSync(cwd);
  // `read -t` returns >128 on timeout and 1 on EOF, so the fixture ends by
  // itself if this test process dies and closes its stdin.
  fs.writeFileSync(path.join(cwd, "serve"), `${ignoreTerm ? "trap '' TERM\n" : ""}while read -r -t 30 _ || [ $? -gt 128 ]; do :; done\n`);
  return { app, binary, cwd };
}

function start(fake, socket) {
  const child = spawn(fake.binary, ["serve", "--socket", socket], { cwd: fake.cwd, stdio: ["pipe", "ignore", "ignore"] });
  spawned.push(child);
  return child;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.signalCode)
    : new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

async function until(check, timeoutMs = 3_000) {
  for (let waited = 0; waited < timeoutMs; waited += 20) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the helper's paths", () => {
  test("are the ones the engine launches the daemon with", async () => {
    const { bundledHelper } = await import("../engine/src/computer-use.ts");
    const engine = bundledHelper("/Applications/Telar.app/Contents/Helpers/Computer Use for Telar.app", "/Users/someone");
    const shell = bundledHelperDaemon("/Applications/Telar.app/Contents/Helpers/Computer Use for Telar.app", "/Users/someone");
    expect(shell).toEqual({ binary: engine.binary, socket: engine.socket, pidFile: engine.pidFile });
  });
});

describe.skipIf(process.platform === "win32")("stopHelperDaemon", () => {
  function setup(options) {
    const dir = tempDir();
    const fake = fakeHelper(dir, "Computer Use for Telar", options);
    const helper = { binary: fake.binary, socket: path.join(dir, "driver.sock"), pidFile: path.join(dir, "driver.pid") };
    return { dir, fake, helper };
  }

  test("SIGTERMs our daemon and leaves a look-alike on another socket, another binary, and a stale pid file alone", async () => {
    const { dir, fake, helper } = setup();
    const ours = start(fake, helper.socket);
    const otherSocket = start(fake, path.join(dir, "someone-elses.sock"));
    const otherBinary = start(fakeHelper(dir, "CuaDriver"), helper.socket);
    // A pid file naming a live process that is NOT our daemon — what a stale
    // file looks like once its pid has been reused.
    fs.writeFileSync(helper.pidFile, `${otherBinary.pid}\n`);
    expect(await until(() => helperDaemonPids(helper).includes(ours.pid))).toBe(true);
    expect(helperDaemonPids(helper)).toEqual([ours.pid]);

    const outcome = stopHelperDaemon(helper);
    expect(outcome).toEqual({ terminated: [ours.pid], killed: [] });
    expect(await exited(ours)).toBe("SIGTERM");
    expect(alive(otherSocket.pid)).toBe(true);
    expect(alive(otherBinary.pid)).toBe(true);
  });

  test("a pid file naming our daemon is honoured, and a daemon that ignores SIGTERM is killed after the grace period", async () => {
    const { fake, helper } = setup({ ignoreTerm: true });
    const ours = start(fake, helper.socket);
    fs.writeFileSync(helper.pidFile, `${ours.pid}\n`);
    expect(await until(() => helperDaemonPids(helper).includes(ours.pid))).toBe(true);

    const outcome = stopHelperDaemon(helper, { graceMs: 200 });
    expect(outcome).toEqual({ terminated: [ours.pid], killed: [ours.pid] });
    expect(await exited(ours)).toBe("SIGKILL");
  });

  test("nothing running is nothing signalled, pid file or not", () => {
    const { helper } = setup();
    fs.writeFileSync(helper.pidFile, `${process.pid}\n`);
    const kills = [];
    expect(stopHelperDaemon(helper, { kill: (pid, signal) => kills.push([pid, signal]) })).toEqual({ terminated: [], killed: [] });
    expect(kills).toEqual([]);
  });

  test("a pid that stops being ours during the grace period is never SIGKILLed", () => {
    const helper = { binary: "/x/Computer Use for Telar.app/Contents/MacOS/cua-driver", socket: "/x/driver.sock", pidFile: "/x/none.pid" };
    let table = [{ pid: 4242, command: `${helper.binary} serve --socket ${helper.socket}` }];
    const kills = [];
    const outcome = stopHelperDaemon(helper, {
      processes: () => table,
      kill: (pid, signal) => kills.push([pid, signal]),
      sleepSync: () => {
        // Still ours for the grace period, then another program takes the pid.
        table = [{ pid: 4242, command: "/usr/bin/some-other-program" }];
      },
      graceMs: 50,
    });
    expect(kills).toEqual([[4242, "SIGTERM"]]);
    expect(outcome).toEqual({ terminated: [4242], killed: [] });
  });
});
