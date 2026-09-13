/**
 * WHAT A PRESS OF "Install & restart" SHOULD DO — the testable half of the fix
 * for issue #389.
 *
 * WHAT HAPPENED. `telar:updates:install` called `autoUpdater.quitAndInstall()`
 * every time it was invoked, and told the renderer nothing at all. Staging an
 * archive takes a few seconds, during which the app looks exactly as it did
 * before the press — so people pressed again, and the SECOND call is the one
 * that misbehaves:
 *
 *   · electron-updater's `BaseUpdater.install()` refuses a repeat outright
 *     (`quitAndInstallCalled` is already true) and reports the refusal through
 *     its error channel rather than doing nothing quietly.
 *   · On macOS `MacUpdater.quitAndInstall()` takes the other branch when
 *     Squirrel has not finished staging: it subscribes ANOTHER
 *     `update-downloaded` listener to the native updater and re-runs
 *     `checkForUpdates()`. Repeat presses stack listeners on a process that is
 *     already on its way out, and the native updater's complaint is the warning
 *     the issue describes.
 *
 * Neither of those is a state a person can act on, and both are reached only
 * because the first press produced no visible change. So the shell now says
 * `restarting` BEFORE it stages anything, and this gate decides what a second
 * press means: within the grace window, nothing (say `restarting` again — the
 * renderer may have remounted and forgotten); past it, the quit plainly did not
 * happen, and the press is a genuine retry.
 *
 * Pure — no electron, no electron-updater, injectable clock — so the ten
 * seconds this reasons about cost microseconds in `update-install.test.js`.
 * main.js owns the consequences (quitting, broadcasting); this owns the
 * decision.
 */

/**
 * How long a restart is allowed to be merely PROMISED.
 *
 * Matched deliberately to the renderer's own patience
 * (`RESTART_TIMEOUT_MS` in apps/web/lib/desktop-updates.ts): the surface offers
 * the press again at exactly the moment this stops treating a press as a
 * duplicate. A shorter window here would make the retry a no-op the user could
 * not tell from the stall; a longer one would leave a real retry refused.
 */
const QUIT_GRACE_MS = 10_000;

/**
 * The install gate.
 *
 *   · `unsupported` — this build installs nothing: unpackaged, or a Dev build
 *     whose updates come from the local checkout. Never touch the updater.
 *   · `install`     — the first press. Stage and quit.
 *   · `pending`     — a press while the first is still plausibly working. NO
 *     second `quitAndInstall`; re-broadcast `restarting` so a renderer that
 *     remounted (or never heard) learns the state.
 *   · `retry`       — the grace window elapsed and the app is still here, so
 *     the quit failed silently. Try once more, and re-arm the window.
 */
function createInstallGate({ now = Date.now, graceMs = QUIT_GRACE_MS } = {}) {
  let startedAt = null;
  return {
    press({ packaged = true, devBuild = false } = {}) {
      if (!packaged || devBuild) return "unsupported";
      const at = now();
      if (startedAt === null) {
        startedAt = at;
        return "install";
      }
      if (at - startedAt < graceMs) return "pending";
      startedAt = at;
      return "retry";
    },
    /** When the in-flight attempt began, or null if none has. */
    startedAt: () => startedAt,
    /** An attempt that FAILED LOUDLY is not an attempt in flight: the next
     *  press must be a real install, not a duplicate. */
    reset() {
      startedAt = null;
    },
  };
}

module.exports = { QUIT_GRACE_MS, createInstallGate };
