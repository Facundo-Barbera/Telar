"use strict";

/**
 * NOTICE WHEN A DISK IS PLUGGED IN OR PULLED OUT, AND TELL THE ENGINE — #534.
 *
 * WHAT THIS IS FOR, precisely. The engine already knows whether a project's
 * drive is here: it probes on every listing, which means a rail learns within
 * one polling pass whatever happens. That is CORRECT and it is slow enough to
 * look broken — you plug the drive in, and for a moment the app still says it is
 * away. This module removes the moment. It is ACCELERATION, NOT TRUTH: every
 * path through it is best-effort, a missed event costs one polling pass and
 * nothing else, and the engine never trusts it for anything.
 *
 * ══ WHY `fs.watch` ON THE MOUNT ROOTS, AND NOT THE ALTERNATIVES ══
 *
 * Electron's `powerMonitor` has no mount events at all, so the choice was
 * between watching the directory and running `diskutil activity` as a child.
 *
 * `diskutil activity` streams disk-arbitration events, which is closer to the
 * real signal — and it is a permanent extra process whose output format is
 * undocumented, which nothing notices the death of, and which would have to be
 * respawned by a supervisor this shell does not otherwise need. For a hint whose
 * entire job is to save a few seconds, that is a lot of machinery to keep alive.
 *
 * `fs.watch("/Volumes")` needs none of it. A mount CREATES an entry there and an
 * unmount REMOVES one — the directory's contents are the fact, not a proxy for
 * it — and the watch is a kqueue/FSEvents registration the kernel holds, with no
 * process to babysit and no format to parse.
 *
 * ══ AND WHY `resume` IS PART OF THE ANSWER RATHER THAN AN EXTRA ══
 *
 * Neither mechanism survives the case that matters most: a drive unplugged while
 * the Mac is asleep. The machine is not running, so there is no event to deliver
 * and nothing to deliver it to — on wake, a watcher of either kind has simply
 * missed it. That is why the mechanism is a PAIR: the watch covers the machine
 * being awake, and `powerMonitor`'s `resume` covers the gap it slept through by
 * asking the engine to re-probe everything the moment the lid opens. A child
 * process streaming events would have needed exactly the same second half, and
 * would still have been a child process.
 *
 * ══ COALESCED, BECAUSE ONE MOUNT IS NOT ONE EVENT ══
 *
 * Mounting a volume writes several entries under `/Volumes` in quick succession
 * and macOS delivers a burst. One re-probe per burst is what the engine wants;
 * a POST per event would turn plugging in a drive into a dozen registry sweeps.
 *
 * Every dependency is injectable so the unit test drives it with no filesystem,
 * no Electron and no disk.
 */

const fs = require("node:fs");

/** This platform's mount roots — where an external disk appears. The third copy
 *  of this list (`apps/engine/src/volumes.ts`, `apps/web/lib/fs-dirs.ts`); three
 *  apps, none of which imports another, and each says so. */
function mountRootsFor(platform) {
  return platform === "darwin" ? ["/Volumes"] : platform === "linux" ? ["/media", "/mnt"] : [];
}

/**
 * Watch the mount roots and call `onChanged` once per burst.
 *
 * @param {object} options
 * @param {() => void} options.onChanged - ask the engine to re-probe. Best-effort; never awaited.
 * @param {NodeJS.Platform} [options.platform]
 * @param {readonly string[]} [options.mountRoots] - overrides the platform's, for tests.
 * @param {(dir: string, listener: () => void) => { close: () => void }} [options.watch]
 * @param {{ on: (event: string, listener: () => void) => void }} [options.powerMonitor] - Electron's; absent means no wake handling.
 * @param {number} [options.settleMs] - how long a burst is given to finish.
 * @returns {{ stop: () => void, watching: readonly string[] }}
 */
function watchVolumes(options) {
  const platform = options.platform ?? process.platform;
  const roots = options.mountRoots ?? mountRootsFor(platform);
  const settleMs = options.settleMs ?? 250;
  const watch =
    options.watch ??
    ((dir, listener) => {
      const watcher = fs.watch(dir, { persistent: false }, listener);
      // A watcher that throws later — the directory going away underneath it —
      // must not take the shell down with it. The poll is still the floor.
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
    // The shell's own lifetime is what this rides on: an unreferenced timer must
    // not be the reason the process stays alive.
    if (typeof timer.unref === "function") timer.unref();
  };

  const watchers = [];
  const watching = [];
  for (const root of roots) {
    try {
      watchers.push(watch(root, nudge));
      watching.push(root);
    } catch {
      // No `/Volumes` on this machine, or no permission to watch it. One root
      // fewer, never a failed start: the engine's poll covers it.
    }
  }

  /**
   * THE HALF THE WATCH CANNOT COVER. A drive pulled out during sleep produced no
   * event for anybody, so waking is itself the signal — unconditionally, because
   * the shell has no way to know whether anything moved and the re-probe is
   * three `stat`s per project.
   */
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
          /* already gone */
        }
      }
    },
  };
}

module.exports = { mountRootsFor, watchVolumes };
