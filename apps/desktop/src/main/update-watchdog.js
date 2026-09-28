const path = require("node:path");

const STALL_MS = 60_000;

const CHECK_TIMEOUT_MS = 2 * 60_000;

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

    timer?.unref?.();
  }

  return {
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

    settle() {
      disarm();
      const done = current;
      current = null;
      return done;
    },
    inFlight() {
      return current;
    },

    plan() {
      if (current === null) return "check";
      return now() - current.lastProgressAt >= stallMs ? "restart" : "report";
    },
  };
}

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

function pendingUpdateDir(updater) {
  const dir = updater?.downloadedUpdateHelper?.cacheDirForPendingUpdate;
  return typeof dir === "string" && dir ? dir : null;
}

function removeStaleTempFiles(dir, fsLike = require("node:fs")) {
  if (!dir) return [];
  let names;
  try {
    names = fsLike.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!name.startsWith("temp-")) continue;
    try {
      fsLike.rmSync(path.join(dir, name), { force: true, recursive: true });
      removed.push(name);
    } catch {
    }
  }
  return removed;
}

function clearCachedCheckPromise(updater) {
  if (!updater || updater.checkForUpdatesPromise == null) return false;
  updater.checkForUpdatesPromise = null;
  return true;
}

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
