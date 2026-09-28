const { describe, expect, test } = require("bun:test");
const { QUIT_GRACE_MS, createInstallGate } = require("./update-install");
const { mainSource } = require("../../test/main-source");

function fakeClock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

const gateOn = (clock, graceMs = QUIT_GRACE_MS) => createInstallGate({ now: clock.now, graceMs });

describe("a build that installs nothing", () => {
  test("an unpackaged build never reaches the updater", () => {
    const gate = gateOn(fakeClock());
    expect(gate.press({ packaged: false })).toBe("unsupported");

    expect(gate.startedAt()).toBeNull();
  });

  test("a Dev build updates from its checkout, not from a channel", () => {
    const gate = gateOn(fakeClock());
    expect(gate.press({ packaged: true, devBuild: true })).toBe("unsupported");
    expect(gate.startedAt()).toBeNull();
  });
});

describe("the press that stages", () => {
  test("the first one installs", () => {
    const clock = fakeClock();
    const gate = gateOn(clock);
    expect(gate.press({ packaged: true })).toBe("install");
    expect(gate.startedAt()).toBe(clock.now());
  });

  test("every press inside the grace window is a no-op, however many there are", () => {
    const clock = fakeClock();
    const gate = gateOn(clock);
    expect(gate.press({ packaged: true })).toBe("install");
    for (const wait of [0, 200, 1_000, 4_000]) {
      clock.advance(wait);
      expect(gate.press({ packaged: true })).toBe("pending");
    }

    expect(gate.startedAt()).toBe(clock.now() - 5_200);
  });

  test("the moment the window closes is not yet a retry", () => {
    const clock = fakeClock();
    const gate = gateOn(clock);
    gate.press({ packaged: true });
    clock.advance(QUIT_GRACE_MS - 1);
    expect(gate.press({ packaged: true })).toBe("pending");
  });
});

describe("a quit that never happened", () => {
  test("past the grace window the press is a real second attempt", () => {
    const clock = fakeClock();
    const gate = gateOn(clock);
    gate.press({ packaged: true });
    clock.advance(QUIT_GRACE_MS);
    expect(gate.press({ packaged: true })).toBe("retry");
  });

  test("a retry re-arms the window, so its own repeats are no-ops too", () => {
    const clock = fakeClock();
    const gate = gateOn(clock);
    gate.press({ packaged: true });
    clock.advance(QUIT_GRACE_MS);
    expect(gate.press({ packaged: true })).toBe("retry");
    clock.advance(1_000);
    expect(gate.press({ packaged: true })).toBe("pending");
  });

  test("a stage that THREW is not an attempt in flight", () => {
    const clock = fakeClock();
    const gate = gateOn(clock);
    expect(gate.press({ packaged: true })).toBe("install");
    gate.reset();
    expect(gate.startedAt()).toBeNull();
    expect(gate.press({ packaged: true })).toBe("install");
  });
});

describe("the window itself", () => {
  test("the shell waits as long as the renderer does", () => {
    expect(QUIT_GRACE_MS).toBe(10_000);
  });
});

describe("the planned-restart marker", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { PLANNED_RESTART_FILE, writePlannedRestart, clearPlannedRestart } = require("./update-install");

  test("names the reason and the time, beside the engine's state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-planned-restart-"));
    try {
      expect(writePlannedRestart(path.join(root, "engine"), { now: () => 1234 })).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, "engine", PLANNED_RESTART_FILE), "utf8"))).toEqual({ version: 1, reason: "update", at: 1234 });
      clearPlannedRestart(path.join(root, "engine"));
      expect(fs.existsSync(path.join(root, "engine", PLANNED_RESTART_FILE))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a marker that cannot be written costs the resume, never the update", () => {
    const failing = { mkdirSync() { throw new Error("read-only"); }, writeFileSync() {} };
    expect(writePlannedRestart("/nowhere", { fs: failing })).toBe(false);
  });

  test("the install handler writes it, takes it back on a failed stage, and never asks the quit question", () => {
    const source = mainSource();
    const start = source.indexOf('ipcMain.handle("telar:updates:install"');
    const handler = source.slice(start, source.indexOf("\n});", start));
    expect(handler).toContain("writePlannedRestart(engineRoot)");
    expect(handler).toContain("clearPlannedRestart(engineRoot)");

    expect(handler).not.toContain("showMessageBox");
    expect(handler).not.toContain("decideQuit");
    expect(handler).toContain("terminalsClosedForQuit = true");
  });
});
