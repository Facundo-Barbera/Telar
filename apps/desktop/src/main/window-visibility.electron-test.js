/**
 * THE VISIBILITY SIGNAL, MEASURED IN A REAL ELECTRON — issue #834.
 *
 * `window-visibility.test.js` proves the edge logic against a hand-made window.
 * What it cannot prove is the thing #834 is about: that a REAL window, built
 * with `backgroundThrottling: false` like the cockpit's, fires the events that
 * logic listens to, and that the answer reaches a real renderer through the
 * real preload bridge. That needs a window on a real window server, which is
 * why this runs in CI's `electron` job and nowhere else — do not run it on a
 * machine somebody is working at; it shows a window.
 *
 * THE CONTROL is `document.visibilityState`, read in the same renderer at the
 * same moment. It is only recorded, not asserted: the point is that the page
 * could not see its own hide, and a future Electron that fixes that should not
 * turn this red.
 *
 * Run: `bun run test:desktop:visibility`.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { watchWindowVisibility, windowVisible } = require("./window-visibility");
const { removeUserData } = require("../../test/electron/electron-test-teardown");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "telar-window-visibility-"));
app.setPath("userData", userData);

// A hang is a failure, and must say which step it was on.
const DEADLINE_MS = 60_000;
let stage = "app.whenReady()";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const note = (line) => console.log(`WINDOW_VISIBILITY ${line}`);
const at = (next) => {
  stage = next;
  note(`… ${next}`);
};

/** Poll the renderer until the last pushed value is `expected`. Window-server
 *  events are asynchronous — a minimise animates — so this waits for the
 *  answer rather than for a guessed interval. */
async function rendererSees(win, expected) {
  let seen;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    seen = await win.webContents.executeJavaScript("window.__telarVisible");
    if (seen === expected) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const asked = await win.webContents.executeJavaScript("window.telarDesktop.visibility.get()");
  const page = await win.webContents.executeJavaScript("document.visibilityState");
  return { seen, asked, page };
}

async function main() {
  const page = path.join(userData, "page.html");
  fs.writeFileSync(page, "<!doctype html><title>visibility fixture</title><body>ok</body>");
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // MATCHING `createWindow` IN main.js — this flag is the reason the signal
      // exists, so a test without it asks about a window the product never builds.
      backgroundThrottling: false,
    },
  });
  watchWindowVisibility(win);
  // main.js's handler, registered here because requiring main.js starts the app.
  ipcMain.handle("telar:window:visibility", (event) => windowVisible(BrowserWindow.fromWebContents(event.sender)));

  try {
    at("loading the fixture page");
    await win.loadFile(page);
    const subscribed = await win.webContents.executeJavaScript(`
      (function () {
        const bridge = window.telarDesktop && window.telarDesktop.visibility;
        if (!bridge || !bridge.onChange || !bridge.get) return "no-bridge";
        window.__telarVisible = null;
        bridge.onChange(function (visible) { window.__telarVisible = visible; });
        return "subscribed";
      })()
    `);
    assert(subscribed === "subscribed", `preload.js exposed no telarDesktop.visibility bridge (${subscribed})`);

    at("showing the window");
    win.show();
    const shown = await rendererSees(win, true);
    assert(shown.seen === true && shown.asked === true, `after show() the renderer saw ${JSON.stringify(shown)}`);

    at("hiding the window");
    win.hide();
    const hidden = await rendererSees(win, false);
    assert(hidden.seen === false && hidden.asked === false, `after hide() the renderer saw ${JSON.stringify(hidden)}`);
    note(`control: document.visibilityState after hide() read "${hidden.page}"`);

    at("showing it again");
    win.show();
    const back = await rendererSees(win, true);
    assert(back.seen === true && back.asked === true, `after the second show() the renderer saw ${JSON.stringify(back)}`);

    at("minimising the window");
    win.minimize();
    const minimized = await rendererSees(win, false);
    assert(minimized.seen === false && minimized.asked === false, `after minimize() the renderer saw ${JSON.stringify(minimized)}`);

    at("restoring the window");
    win.restore();
    const restored = await rendererSees(win, true);
    assert(restored.seen === true && restored.asked === true, `after restore() the renderer saw ${JSON.stringify(restored)}`);

    // A COUNT AND A PAIR OF OPPOSITE ANSWERS, like the other markers in this
    // job: printed only after every step passed. Edit the count with the steps.
    console.log(`WINDOW_VISIBILITY_OK 5/5 hidden=${hidden.seen} shown=${restored.seen}`);
  } finally {
    at("tearing down");
    ipcMain.removeHandler("telar:window:visibility");
    win.destroy();
    await removeUserData(userData);
  }
}

const deadline = setTimeout(() => {
  console.error(`WINDOW_VISIBILITY_FAIL timed out after ${DEADLINE_MS}ms while: ${stage}`);
  app.exit(1);
}, DEADLINE_MS);

app.whenReady().then(main).then(
  () => {
    clearTimeout(deadline);
    app.exit(0);
  },
  (error) => {
    clearTimeout(deadline);
    console.error("WINDOW_VISIBILITY_FAIL", error);
    app.exit(1);
  },
);
