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

  win.on("show", () => set(!win.isMinimized()));
  win.on("restore", () => set(win.isVisible()));
  win.on("hide", () => set(false));
  win.on("minimize", () => set(false));
}

function windowVisible(win) {
  const read = win && state.get(win);
  return read ? read() : true;
}

module.exports = { CHANNEL, watchWindowVisibility, windowVisible };
