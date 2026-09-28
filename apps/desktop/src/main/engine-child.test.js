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
  test("an exit draws no dialog; the app still quits", () => {
    const { markMainWindowShown, onEngineExit } = freshEngineChild();
    markMainWindowShown();
    onEngineExit("/nowhere", 3, null);
    onEngineExit("/nowhere", 1, null);
    expect(electron.dialog.shown).toEqual([]);
    expect(electron.app.quits).toBe(2);
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
