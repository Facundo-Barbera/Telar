const { afterEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electron, resetElectron } = require("../../test/fake-electron");

afterEach(resetElectron);

function freshEngineChild() {
  delete require.cache[require.resolve("./engine-child")];
  return require("./engine-child");
}

function storeWithLock(pid) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-exit-"));
  fs.mkdirSync(path.join(home, "engine"));
  fs.writeFileSync(path.join(home, "engine", "engine.lock"), JSON.stringify({ pid }));
  return home;
}

test("the engine child will not start without the env that names its store", () => {
  const { startEngineChild } = freshEngineChild();
  expect(() => startEngineChild("/tmp/store")).toThrow(/names its store/);
  expect(() => startEngineChild("/tmp/store", { TELAR_HOME: "/tmp/other" })).toThrow(/names its store/);
});

describe("the engine's exit before the window opens", () => {
  test("a held store lock says another Telar is running, names its pid, and quits", () => {
    const { onEngineExit } = freshEngineChild();
    const home = storeWithLock(4242);
    onEngineExit(home, 3, null);
    expect(electron.dialog.shown).toHaveLength(1);
    expect(electron.dialog.shown[0]).toMatchObject({ kind: "message", title: "Telar is already running" });
    expect(electron.dialog.shown[0].detail).toContain("(pid 4242)");
    expect(electron.app.quits).toBe(1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("any other exit puts up the startup failure, once, and quits", () => {
    const { onEngineExit } = freshEngineChild();
    onEngineExit("/nowhere", 1, null);
    onEngineExit("/nowhere", 1, null);
    expect(electron.dialog.shown.filter((shown) => shown.kind === "error")).toHaveLength(1);
    expect(electron.dialog.shown[0].title).toBe("Telar's engine stopped");
    expect(electron.app.quits).toBe(2);
  });
});

describe("after the window opened", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");

  function fakeEngines() {
    const spawned = [];
    const next = [];
    const spawn = () => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: (signal) => exit(child, null, signal),
      });
      spawned.push(child);
      next.shift()?.(child);
      return child;
    };
    const nextSpawn = () => new Promise((resolve) => next.push(resolve));
    return { spawn, spawned, nextSpawn };
  }

  function exit(child, code, signal, stderr = "") {
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.stderr.end(stderr);
    child.emit("exit", code, signal);
  }

  function restartNotices() {
    const win = new electron.BrowserWindow();
    return () => win.webContents.sent.filter((sent) => sent.channel === "telar:engine:restart").map((sent) => sent.payload);
  }

  for (const [how, code, signal, reason] of [
    ["with code 1", 1, null, "exit code 1"],
    ["by a signal", null, "SIGKILL", "killed by SIGKILL"],
  ]) {
    test(`an engine that exits ${how} is restarted; the app does not quit or ask anything`, async () => {
      const { markMainWindowShown, superviseEngine, lastEngineRestart, stopEngineChild } = freshEngineChild();
      const notices = restartNotices();
      const engines = fakeEngines();
      markMainWindowShown();
      superviseEngine("/nowhere", engines.spawn);
      const restarted = engines.nextSpawn();
      exit(engines.spawned[0], code, signal);
      await restarted;
      await new Promise(setImmediate);
      expect(engines.spawned).toHaveLength(2);
      expect(electron.app.quits).toBe(0);
      expect(electron.dialog.shown).toEqual([]);
      expect(notices()).toEqual([expect.objectContaining({ reason, restarted: true })]);
      expect(lastEngineRestart()).toMatchObject({ reason, restarted: true });
      await stopEngineChild();
    });
  }

  test("the reason the engine gave on its way out is the one reported", async () => {
    const { markMainWindowShown, superviseEngine, lastEngineRestart, stopEngineChild } = freshEngineChild();
    const engines = fakeEngines();
    markMainWindowShown();
    superviseEngine("/nowhere", engines.spawn);
    const restarted = engines.nextSpawn();
    exit(engines.spawned[0], 1, null, "boom\nTelar engine stopped: uncaught TypeError: x is not a function\n    at y (z.js:1)\n");
    await restarted;
    await new Promise(setImmediate);
    expect(lastEngineRestart().reason).toBe("uncaught TypeError: x is not a function");
    await stopEngineChild();
  });

  test("an engine that keeps dying is given up on without quitting", async () => {
    const { markMainWindowShown, superviseEngine, lastEngineRestart } = freshEngineChild();
    const engines = fakeEngines();
    markMainWindowShown();
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
      superviseEngine("/nowhere", engines.spawn);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const restarted = engines.nextSpawn();
        exit(engines.spawned.at(-1), 1, null);
        await restarted;
      }
      exit(engines.spawned.at(-1), 1, null);
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(engines.spawned).toHaveLength(6);
    expect(lastEngineRestart()).toMatchObject({ restarted: false });
    expect(electron.app.quits).toBe(0);
    expect(electron.dialog.shown).toEqual([]);
  });

  test("an engine stopped for a quit is not restarted", async () => {
    const { markMainWindowShown, superviseEngine, stopEngineChild } = freshEngineChild();
    const engines = fakeEngines();
    markMainWindowShown();
    superviseEngine("/nowhere", engines.spawn);
    await stopEngineChild();
    await new Promise(setImmediate);
    expect(engines.spawned).toHaveLength(1);
    expect(electron.app.quits).toBe(0);
  });

  test("a quit Telar asked for is not reported at all", () => {
    const { onEngineExit } = freshEngineChild();
    electron.app.isQuitting = true;
    onEngineExit("/nowhere", 1, null);
    expect(electron.dialog.shown).toEqual([]);
    expect(electron.app.quits).toBe(0);
  });
});

test("the shell and the engine agree what a held lock exits with, and it is not a crash's 1", async () => {
  const { ENGINE_EXIT_LOCK_HELD } = await import("../../../engine/src/platform/process/daemon-lock.ts");
  expect(ENGINE_EXIT_LOCK_HELD).toBeGreaterThan(2);
  const { onEngineExit } = freshEngineChild();
  onEngineExit(storeWithLock(1), ENGINE_EXIT_LOCK_HELD, null);
  expect(electron.dialog.shown[0].title).toBe("Telar is already running");
});

describe("stopping a child on quit", () => {
  const { spawn } = require("node:child_process");
  const { once } = require("node:events");
  const nodeChild = (script) => spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });

  test("a child that honours SIGTERM is waited for, not killed", async () => {
    const { stopChild } = freshEngineChild();
    const child = nodeChild("console.log('ready'); setInterval(() => {}, 1000);");
    await once(child.stdout, "data");
    await stopChild(child, 60_000);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace", async () => {
    const { stopChild } = freshEngineChild();
    const child = nodeChild("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);");
    await once(child.stdout, "data");
    await stopChild(child, 50);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("a child that already exited resolves at once", async () => {
    const { stopChild } = freshEngineChild();
    const child = nodeChild("");
    await once(child, "exit");
    await stopChild(child, 60_000);
  });
});
