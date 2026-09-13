// WHAT A SECOND PRESS OF "Install & restart" MEANS, PINNED (issue #389).
//
// The bug was a handler that called `quitAndInstall()` once per press and told
// the renderer nothing in between: staging takes seconds, nothing on screen
// moved, people pressed again, and the second call is the one electron-updater
// complains about — a refusal from `BaseUpdater.install()`, or on macOS another
// `update-downloaded` listener stacked on a process already leaving.
//
// The window this reasons about is ten real seconds, which is why the gate
// takes its clock as an argument. The fake clock below turns the whole
// double-press into microseconds.

const { describe, expect, test } = require("bun:test");
const { QUIT_GRACE_MS, createInstallGate } = require("./update-install");

/** A clock the test advances by hand — no timers here, only readings. */
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
    // AND IS NOT REMEMBERED AS AN ATTEMPT: a refusal must not make the next
    // press look like a duplicate of something that never happened.
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
    // THE DEFECT, DIRECTLY. Each of these used to be another
    // `quitAndInstall()`; now they are answered with "already going", and the
    // handler re-broadcasts `restarting` instead of staging a second time.
    const clock = fakeClock();
    const gate = gateOn(clock);
    expect(gate.press({ packaged: true })).toBe("install");
    for (const wait of [0, 200, 1_000, 4_000]) {
      clock.advance(wait);
      expect(gate.press({ packaged: true })).toBe("pending");
    }
    // The attempt is still the FIRST one — a repeat never re-arms the window,
    // or a person tapping once a second would hold the deadline open forever.
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
    // This is the retry the renderer offers when its own deadline passes
    // (RESTART_TIMEOUT_MS in apps/web/lib/desktop-updates.ts) — the two windows
    // are the same length on purpose, so the button that reappears works.
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
    // main.js resets the gate when `quitAndInstall` throws, because the app is
    // demonstrably still here and the user is about to be shown an error with a
    // button. That button must stage, not answer "already going".
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
    // Both sides say ten seconds. If these ever drift, one of two things is
    // true: the retry button is refused, or a duplicate press stages twice.
    expect(QUIT_GRACE_MS).toBe(10_000);
  });
});
