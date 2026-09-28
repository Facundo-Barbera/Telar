// The shell's visibility signal (#834), against a hand-made window: which
// events move the answer, that each edge is sent once, and what a renderer that
// asks gets. Whether real Electron fires those events is
// window-visibility.electron-test.js's question, not this file's.

const { EventEmitter } = require("node:events");
const { describe, expect, test } = require("bun:test");
const { CHANNEL, watchWindowVisibility, windowVisible } = require("./window-visibility.js");

function fakeWindow({ visible = false, minimized = false } = {}) {
  const win = new EventEmitter();
  win.sent = [];
  win.visible = visible;
  win.minimized = minimized;
  win.isVisible = () => win.visible;
  win.isMinimized = () => win.minimized;
  win.isDestroyed = () => false;
  win.webContents = { send: (channel, value) => win.sent.push([channel, value]) };
  return win;
}

describe("watchWindowVisibility", () => {
  test("sends hidden on hide and visible on show", () => {
    const win = fakeWindow({ visible: true });
    watchWindowVisibility(win);
    win.visible = false;
    win.emit("hide");
    expect(windowVisible(win)).toBe(false);
    win.visible = true;
    win.emit("show");
    expect(windowVisible(win)).toBe(true);
    expect(win.sent).toEqual([[CHANNEL, false], [CHANNEL, true]]);
  });

  test("a minimised window is hidden until it is restored", () => {
    const win = fakeWindow({ visible: true });
    watchWindowVisibility(win);
    win.minimized = true;
    win.emit("minimize");
    // Occlusion can report `show` for a window still in the Dock.
    win.emit("show");
    expect(windowVisible(win)).toBe(false);
    win.minimized = false;
    win.emit("restore");
    expect(win.sent).toEqual([[CHANNEL, false], [CHANNEL, true]]);
  });

  test("sends each edge once", () => {
    const win = fakeWindow({ visible: true });
    watchWindowVisibility(win);
    win.emit("hide");
    win.emit("minimize");
    win.emit("hide");
    expect(win.sent).toEqual([[CHANNEL, false]]);
  });

  test("a window born hidden starts hidden and is told when it first shows", () => {
    const win = fakeWindow();
    watchWindowVisibility(win);
    expect(windowVisible(win)).toBe(false);
    win.visible = true;
    win.emit("show");
    expect(win.sent).toEqual([[CHANNEL, true]]);
  });

  test("sends nothing to a destroyed window", () => {
    const win = fakeWindow({ visible: true });
    watchWindowVisibility(win);
    win.isDestroyed = () => true;
    win.emit("hide");
    expect(win.sent).toEqual([]);
  });

  test("a window nobody watches reads visible", () => {
    expect(windowVisible(fakeWindow())).toBe(true);
    expect(windowVisible(null)).toBe(true);
  });
});
