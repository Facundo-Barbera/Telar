/**
 * THE UPDATER'S DEADLINES — the testable half of the fix for issue #317.
 *
 * WHAT HAPPENED. On 0.1.0-nightly.20260911.3 a full download stopped at 11 MB
 * of 145 and neither finished nor errored: the temp file's mtime never moved
 * again, no `error` event fired, and nothing in electron-updater was ever going
 * to notice. Two and a half hours later the user pressed "Check for updates"
 * and the pane sat on "Checking for a newer build…" forever, because the check
 * was queued behind the dead transfer. The only cure was quitting the app.
 *
 * NOTHING IN electron-updater HAS A TIMEOUT, and that is the whole bug: the
 * socket stayed open, so no HTTP layer complained; the promise stayed pending,
 * so no `.catch` ran. A transfer that has stopped moving is indistinguishable
 * from a slow one EXCEPT by the clock, which is why the answer is a clock.
 *
 * Everything here is pure — no electron, no electron-updater, injectable
 * timers — so the states that take minutes to reach in life take microseconds
 * in `update-watchdog.test.js`. main.js owns the consequences (cancelling the
 * token, deleting the part-file, telling the renderer); this owns the
 * decisions.
 */

const path = require("node:path");

/** No `download-progress` for this long means the transfer is dead, not slow.
 *  Long enough to survive a tunnel or a laptop lid; short enough that a person
 *  who is watching the percentage gets an answer rather than a spinner. */
const STALL_MS = 60_000;

/** A check that has not answered in this long has failed, whatever it is doing.
 *  Reading one small .yml over a CDN takes 0.2 s in practice. */
const CHECK_TIMEOUT_MS = 2 * 60_000;

/**
 * THE DOWNLOAD'S CLOCK, and the state a manual check consults.
 *
 * `begin` arms it, every `download-progress` re-arms it, `settle` disarms it,
 * and `onStall` fires exactly once for a transfer that goes quiet — after the
 * transfer has already been forgotten, so the stall handler cannot race a
 * second notification out of the same download.
 */
function createDownloadWatch({
  stallMs = STALL_MS,
  onStall,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let current = null;
  let timer = null;

  function disarm() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function arm() {
    disarm();
    timer = setTimer(() => {
      timer = null;
      const stalled = current;
      if (stalled === null) return;
      current = null;
      onStall?.(stalled);
    }, stallMs);
    // A watchdog must never be the reason the app stays alive.
    timer?.unref?.();
  }

  return {
    /** A transfer has started. `meta` carries whatever the stall handler will
     *  need — the CancellationToken that can kill it, and the version to name
     *  in the sentence the user reads. */
    begin(meta = {}) {
      const at = now();
      current = { ...meta, startedAt: at, lastProgressAt: at, percent: 0 };
      arm();
      return current;
    },
    progress(percent) {
      if (current === null) return null;
      current.lastProgressAt = now();
      if (typeof percent === "number" && Number.isFinite(percent)) current.percent = percent;
      arm();
      return current;
    },
    /** Finished, failed, or abandoned. Idempotent: returns the transfer it
     *  ended, or null if there was none. */
    settle() {
      disarm();
      const done = current;
      current = null;
      return done;
    },
    inFlight() {
      return current;
    },
    /**
     * WHAT A MANUAL "Check for updates" SHOULD DO RIGHT NOW.
     *
     *   · `check`   — nothing in flight. Ask the feed, as always.
     *   · `report`  — a transfer is moving. It IS the answer to "is there an
     *     update?", and starting a second check would at best duplicate work
     *     and at worst restart a download that is already 80% done.
     *   · `restart` — a transfer is in flight but its deadline has already
     *     passed without the watchdog firing. That is not a contradiction: the
     *     machine slept, and a suspended timer does not run while the socket on
     *     the other side of the sleep dies anyway. The press is the wake-up, so
     *     abandon the corpse and start over.
     */
    plan() {
      if (current === null) return "check";
      return now() - current.lastProgressAt >= stallMs ? "restart" : "report";
    },
  };
}

/**
 * Settle a promise, or give up on it.
 *
 * NEVER REJECTS. A check's real failures already reach the user through
 * electron-updater's `error` event; what this adds is the case that event has
 * no answer for — a promise that simply never settles.
 */
function settleWithin(promise, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolve(outcome);
    };
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    timer?.unref?.();
    Promise.resolve(promise).then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    );
  });
}

/**
 * WHERE electron-updater PARKS A DOWNLOAD IN PROGRESS — asked, never guessed.
 *
 * IT IS NOT DERIVABLE FROM THE APP'S NAME. electron-updater composes this from
 * `updaterCacheDirName` in the packaged app-update.yml, which electron-builder
 * writes from package.json `name` — so the directory is
 * `~/Library/Caches/telar-desktop-updater/pending` while `app.getName()` is
 * "Telar". Composing it here would have produced a path that exists on nobody's
 * machine, and a cleanup that silently deleted nothing.
 *
 * The helper is created inside `executeDownload`, before the part-file is, so
 * it is always there by the time a download can be cancelled. Null means no
 * download ever started in this session — and so there is nothing of ours to
 * clean.
 */
function pendingUpdateDir(updater) {
  const dir = updater?.downloadedUpdateHelper?.cacheDirForPendingUpdate;
  return typeof dir === "string" && dir ? dir : null;
}

/**
 * Delete the part-file a cancelled download leaves behind.
 *
 * WITHOUT THIS the 11 MB of a 145 MB archive stays on disk forever: nothing
 * resumes it (the next attempt writes its own `temp-`), nothing reads it, and
 * nothing else will ever delete it. Only `temp-` entries — a COMPLETED download
 * waiting to install lives in the same directory under its real name, and
 * removing that would throw away a finished update.
 */
function removeStaleTempFiles(dir, fsLike = require("node:fs")) {
  if (!dir) return [];
  let names;
  try {
    names = fsLike.readdirSync(dir);
  } catch {
    // No pending directory is the normal case, not a failure.
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!name.startsWith("temp-")) continue;
    try {
      fsLike.rmSync(path.join(dir, name), { force: true, recursive: true });
      removed.push(name);
    } catch {
      // Best effort: a file we cannot delete is disk to reclaim later, never a
      // reason to fail an update.
    }
  }
  return removed;
}

/**
 * DROP electron-updater's CACHED CHECK PROMISE.
 *
 * Reaching into a private field, deliberately and narrowly. `checkForUpdates()`
 * returns the in-flight promise whenever one exists — sound, until that promise
 * is one that will never settle, at which point every future check inherits the
 * hang and the app has to be relaunched. There is no public way to say "that
 * one is dead"; this is the whole of the reaching-in, it is guarded, and if a
 * future version renames the field the worst case is the behaviour we already
 * had.
 */
function clearCachedCheckPromise(updater) {
  if (!updater || updater.checkForUpdatesPromise == null) return false;
  updater.checkForUpdatesPromise = null;
  return true;
}

/**
 * A cancellation is this process's own doing. electron-updater reports it
 * through the same `error` event as a real failure, and re-broadcasting it
 * would replace the sentence that explains the stall with the word "cancelled",
 * which tells the user nothing about what to do next.
 */
function isCancellationError(err) {
  if (!err) return false;
  if (err.name === "CancellationError" || err.code === "ERR_CANCELLED") return true;
  return /\bcancell?ed\b/i.test(err.message || String(err));
}

module.exports = {
  STALL_MS,
  CHECK_TIMEOUT_MS,
  createDownloadWatch,
  settleWithin,
  pendingUpdateDir,
  removeStaleTempFiles,
  clearCachedCheckPromise,
  isCancellationError,
};
