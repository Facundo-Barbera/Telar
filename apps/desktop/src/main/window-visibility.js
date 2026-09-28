/**
 * WHETHER ANYBODY CAN SEE THIS WINDOW, said by the one process that knows — #834.
 *
 * The cockpit window sets `backgroundThrottling: false` (main.js, the renderer
 * half of the anti-flicker pair), and that flag SUPPRESSES THE PAGE VISIBILITY
 * API outright: `document.visibilityState` reads "visible" for the life of the
 * window and `visibilitychange` never fires. Measured in a real Electron with a
 * one-token control (#490). So the renderer cannot tell, and every poll gated
 * on it ran at full rate behind other windows.
 *
 * The main process still hears it. `show` and `hide` fire for an explicit
 * hide, for ⌘H (app hide), and — on macOS — for OCCLUSION, which Electron maps
 * from `NSWindowOcclusionState` onto the same two events. `minimize` and
 * `restore` are listened to as well, because a minimised window is not visible
 * and a platform that does not report it as occluded must still say so.
 *
 * EDGES ONLY, DEDUPED: a renderer is told when the answer changes, never twice
 * in a row, and `windowVisible` answers the current state for one that mounted
 * after the last edge.
 */

const CHANNEL = "telar:window:visibility";

const state = new WeakMap();

function watchWindowVisibility(win) {
  let visible = win.isVisible() && !win.isMinimized();
  state.set(win, () => visible);
  const set = (next) => {
    if (next === visible) return;
    visible = next;
    if (!win.isDestroyed()) win.webContents.send(CHANNEL, visible);
  };
  // `show` can arrive for a minimised window whose occlusion changed; a
  // minimised window is still not something anybody is looking at.
  win.on("show", () => set(!win.isMinimized()));
  win.on("restore", () => set(win.isVisible()));
  win.on("hide", () => set(false));
  win.on("minimize", () => set(false));
}

/** The current answer for a window, or `true` for one nobody is watching — a
 *  wrong "visible" is a poll that runs, a wrong "hidden" is a page that
 *  silently stops. */
function windowVisible(win) {
  const read = win && state.get(win);
  return read ? read() : true;
}

module.exports = { CHANNEL, watchWindowVisibility, windowVisible };
