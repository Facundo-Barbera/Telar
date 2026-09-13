// THE UPDATER'S DEADLINES, PINNED (issue #317).
//
// Every case here is a minute or more of wall-clock in life — a download that
// goes quiet for sixty seconds, a check that never answers for two minutes, a
// laptop asleep for three hours — which is exactly why update-watchdog.js takes
// its clock and its timers as arguments. The fake clock below turns the whole
// bug into microseconds.

const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const watchdog = require("./update-watchdog");

/**
 * A clock the test advances by hand, and the timer pair that runs off it.
 * `tick` fires everything due at or before the new time, in order, the way a
 * real event loop would.
 */
function fakeClock(start = 1_000_000) {
  let time = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Advance without running anything — a suspended machine, not a fast one. */
    sleep(ms) {
      time += ms;
    },
    tick(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > time) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

const watchOn = (clock, onStall, stallMs = 60_000) =>
  watchdog.createDownloadWatch({ stallMs, onStall, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

describe("a download that goes quiet", () => {
  test("no progress for the stall window cancels it, once, with what the user needs told", () => {
    const clock = fakeClock();
    const stalls = [];
    const watch = watchOn(clock, (download) => stalls.push(download));
    let cancelled = 0;

    watch.begin({ token: { cancel: () => cancelled++ }, version: "0.1.0-nightly.20260912.1" });
    watch.progress(7.6);

    clock.tick(59_999);
    expect(stalls).toEqual([]);

    clock.tick(1);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].version).toBe("0.1.0-nightly.20260912.1");
    // The percentage the transfer died at is the one figure that makes the
    // sentence in the pane worth reading.
    expect(stalls[0].percent).toBe(7.6);

    // THE TRANSFER IS FORGOTTEN BEFORE THE HANDLER RUNS, so a stall can never
    // be reported twice for the same download, and a manual check arriving a
    // moment later sees a clean slate rather than a corpse.
    expect(watch.inFlight()).toBeNull();
    expect(watch.plan()).toBe("check");
    stalls[0].token.cancel();
    expect(cancelled).toBe(1);

    clock.tick(120_000);
    expect(stalls).toHaveLength(1);
  });

  test("progress re-arms the clock, so a slow download is never mistaken for a dead one", () => {
    const clock = fakeClock();
    const stalls = [];
    const watch = watchOn(clock, (download) => stalls.push(download));
    watch.begin({ version: "1.0.0" });

    // Fifty-nine seconds of silence, then a single chunk — over and over. This
    // is a bad hotel wifi, not a wedge, and it must be allowed to finish.
    for (let round = 0; round < 10; round++) {
      clock.tick(59_000);
      expect(stalls).toEqual([]);
      watch.progress(round * 10);
    }
    expect(watch.inFlight().percent).toBe(90);

    clock.tick(60_000);
    expect(stalls).toHaveLength(1);
  });

  test("a finished or failed download stops the clock and leaves no timer behind", () => {
    const clock = fakeClock();
    const stalls = [];
    const watch = watchOn(clock, (download) => stalls.push(download));

    watch.begin({ version: "1.0.0" });
    expect(watch.settle().version).toBe("1.0.0");
    expect(clock.pending()).toBe(0);
    clock.tick(600_000);
    expect(stalls).toEqual([]);

    // Idempotent: `update-downloaded` and the downloadUpdate promise both
    // settle the same transfer, and the second must be a no-op rather than a
    // second story about it.
    expect(watch.settle()).toBeNull();
    expect(watch.progress(50)).toBeNull();
  });
});

describe("what a manual Check for updates should do", () => {
  test("nothing in flight is an ordinary check", () => {
    const watch = watchOn(fakeClock(), () => {});
    expect(watch.plan()).toBe("check");
  });

  test("a download that is moving is REPORTED, not restarted", () => {
    // Pressing the button at 80% must not throw 80% away. The download is the
    // answer to the question the button asks.
    const clock = fakeClock();
    const watch = watchOn(clock, () => {});
    watch.begin({ version: "1.0.0" });
    clock.tick(30_000);
    watch.progress(80);
    expect(watch.plan()).toBe("report");
    expect(watch.inFlight().percent).toBe(80);
  });

  test("a machine that slept through the deadline finds a corpse, and buries it", () => {
    // THE CASE THE WATCHDOG ALONE CANNOT COVER. macOS suspends timers on sleep:
    // the lid closes at 20 s into a download, the socket dies, and three hours
    // later the timer has still not fired. The press is the wake-up.
    const clock = fakeClock();
    const stalls = [];
    const watch = watchOn(clock, (download) => stalls.push(download));
    watch.begin({ version: "1.0.0" });
    clock.sleep(3 * 60 * 60 * 1000);

    expect(stalls).toEqual([]);
    expect(watch.plan()).toBe("restart");
    expect(watch.settle().version).toBe("1.0.0");
    expect(watch.plan()).toBe("check");
  });
});

describe("a wait that never ends", () => {
  test("settleWithin gives up on a promise that will not settle", async () => {
    const timers = { setTimer: setTimeout, clearTimer: clearTimeout };
    expect(await watchdog.settleWithin(new Promise(() => {}), 5, timers)).toEqual({ timedOut: true });
  });

  test("a value and a rejection both come back as outcomes, never as a throw", async () => {
    const timers = { setTimer: setTimeout, clearTimer: clearTimeout };
    expect(await watchdog.settleWithin(Promise.resolve({ isUpdateAvailable: true }), 1000, timers)).toEqual({
      value: { isUpdateAvailable: true },
    });
    // electron-updater reports check failures through its `error` event too, so
    // a rejection here must not also become an unhandled rejection.
    const outcome = await watchdog.settleWithin(Promise.reject(new Error("ENOTFOUND")), 1000, timers);
    expect(outcome.error.message).toBe("ENOTFOUND");
  });

  test("a promise that settles after the deadline changes nothing", async () => {
    const timers = { setTimer: setTimeout, clearTimer: clearTimeout };
    let resolve;
    const slow = new Promise((r) => (resolve = r));
    const outcome = await watchdog.settleWithin(slow, 5, timers);
    expect(outcome).toEqual({ timedOut: true });
    resolve("too late");
    await slow;
  });
});

describe("electron-updater's cached check promise", () => {
  test("is dropped when it is the thing that is stuck, and left alone otherwise", () => {
    // The wedge in one line: checkForUpdates() returns the in-flight promise,
    // and a promise that never settles is inherited by every later press.
    const updater = { checkForUpdatesPromise: new Promise(() => {}) };
    expect(watchdog.clearCachedCheckPromise(updater)).toBe(true);
    expect(updater.checkForUpdatesPromise).toBeNull();
    expect(watchdog.clearCachedCheckPromise(updater)).toBe(false);
    expect(watchdog.clearCachedCheckPromise(undefined)).toBe(false);
  });
});

describe("the part-file a cancelled download leaves behind", () => {
  const pending = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-updater-"));
    fs.writeFileSync(path.join(dir, "temp-Telar-0.1.0-arm64-mac.zip"), "11 megabytes, notionally");
    fs.writeFileSync(path.join(dir, "temp-Telar-0.1.0-arm64-mac.zip.blockmap"), "x");
    fs.writeFileSync(path.join(dir, "Telar-0.0.9-arm64-mac.zip"), "a FINISHED download, waiting to install");
    fs.writeFileSync(path.join(dir, "update-info.json"), "{}");
    return dir;
  };

  test("only temp- entries go; a completed download waiting to install stays", () => {
    const dir = pending();
    expect(watchdog.removeStaleTempFiles(dir).sort()).toEqual([
      "temp-Telar-0.1.0-arm64-mac.zip",
      "temp-Telar-0.1.0-arm64-mac.zip.blockmap",
    ]);
    expect(fs.readdirSync(dir).sort()).toEqual(["Telar-0.0.9-arm64-mac.zip", "update-info.json"]);
    // Idempotent — the watchdog and a manual check can both reach for it.
    expect(watchdog.removeStaleTempFiles(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("no pending directory at all is the normal case, not a failure", () => {
    expect(watchdog.removeStaleTempFiles(path.join(os.tmpdir(), "telar-updater-does-not-exist"))).toEqual([]);
  });

  test("a file that will not delete costs the others nothing", () => {
    const removed = watchdog.removeStaleTempFiles("/pending", {
      readdirSync: () => ["temp-locked", "temp-ok", "Telar.zip"],
      rmSync: (target) => {
        if (target.endsWith("temp-locked")) throw new Error("EPERM");
      },
    });
    expect(removed).toEqual(["temp-ok"]);
  });

  test("the directory is read off the updater, never composed from the app's name", () => {
    // THE TRAP THIS PINS. electron-updater takes the directory from
    // `updaterCacheDirName` in the packaged app-update.yml — electron-builder
    // writes it from package.json `name` — so it is "telar-desktop-updater"
    // while `app.getName()` is "Telar". A path built from the app's name exists
    // on nobody's machine, and would have cleaned nothing, silently.
    const updater = { downloadedUpdateHelper: { cacheDirForPendingUpdate: "/Users/x/Library/Caches/telar-desktop-updater/pending" } };
    expect(watchdog.pendingUpdateDir(updater)).toBe("/Users/x/Library/Caches/telar-desktop-updater/pending");

    // No download has started in this session, so there is no directory of ours
    // to clean — and nothing is guessed at in its place.
    expect(watchdog.pendingUpdateDir({})).toBeNull();
    expect(watchdog.pendingUpdateDir(undefined)).toBeNull();
    expect(watchdog.removeStaleTempFiles(null)).toEqual([]);
  });
});

describe("telling our own cancellation from a real failure", () => {
  test("a cancellation is recognised however electron-updater phrases it", () => {
    // It reports both through the same `error` event; re-broadcasting ours
    // would replace "Download stalled at 8%…" with "cancelled".
    expect(watchdog.isCancellationError(Object.assign(new Error("boom"), { name: "CancellationError" }))).toBe(true);
    expect(watchdog.isCancellationError(new Error("Request cancelled"))).toBe(true);
    expect(watchdog.isCancellationError(new Error("cancelled"))).toBe(true);
    expect(watchdog.isCancellationError(new Error("canceled"))).toBe(true);
  });

  test("a real failure is not swallowed as one", () => {
    expect(watchdog.isCancellationError(new Error("net::ERR_CONNECTION_RESET"))).toBe(false);
    expect(watchdog.isCancellationError(new Error("Content-Type multipart/byteranges is expected"))).toBe(false);
    expect(watchdog.isCancellationError(null)).toBe(false);
  });
});
