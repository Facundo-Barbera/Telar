"use strict";

const fs = require("node:fs");

function mountRootsFor(platform) {
  return platform === "darwin" ? ["/Volumes"] : platform === "linux" ? ["/media", "/mnt"] : [];
}

function watchVolumes(options) {
  const platform = options.platform ?? process.platform;
  const roots = options.mountRoots ?? mountRootsFor(platform);
  const settleMs = options.settleMs ?? 250;
  const watch =
    options.watch ??
    ((dir, listener) => {
      const watcher = fs.watch(dir, { persistent: false }, listener);

      watcher.on("error", () => {});
      return watcher;
    });

  let timer = null;
  let stopped = false;
  const fire = () => {
    timer = null;
    if (stopped) return;
    options.onChanged();
  };
  const nudge = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fire, settleMs);

    if (typeof timer.unref === "function") timer.unref();
  };

  const watchers = [];
  const watching = [];
  for (const root of roots) {
    try {
      watchers.push(watch(root, nudge));
      watching.push(root);
    } catch {
    }
  }

  options.powerMonitor?.on("resume", nudge);

  return {
    watching,
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
        }
      }
    },
  };
}

module.exports = { mountRootsFor, watchVolumes };
