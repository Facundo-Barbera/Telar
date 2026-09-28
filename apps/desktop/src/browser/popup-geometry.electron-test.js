/**
 * POPUP GEOMETRY — real Electron, a minimal MV3 fixture extension with a
 * default_popup, to prove two things the 1Password host relies on but that an
 * unpaired 1Password cannot show (it opens a tab, not a popup):
 *
 *   1. WITHOUT `alignment:"right"`, the library anchors the popup's RIGHT edge
 *      to the toolbar button and extends it LEFT — inward, into the window —
 *      rather than off the window's right edge.
 *   2. clampRect(popupBounds, popupRegion(window)) keeps the popup inside the
 *      window content ∩ the display work area.
 *
 * No 1Password, no vault. Prints POPUP_GEOMETRY_OK.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { attachExtensionSupport } = require("./extension-compat");
const { clampRect, popupRegion } = require("./extension-host");

const PARTITION = "persist:telar-popup-geometry";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Telar popup fixture", version: "1.0.0",
    action: { default_title: "Fixture", default_popup: "popup.html" },
  }));
  // A body wider/taller than the anchor so overflow is possible if misplaced.
  fs.writeFileSync(path.join(dir, "popup.html"), "<!doctype html><meta charset=utf8><body style='margin:0;width:360px;height:480px;background:#0a7'>hi</body>");
  return dir;
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "telar-popup-geo-"));
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  const window = new BrowserWindow({ show: true, x: 200, y: 200, width: 1000, height: 700 });
  await window.webContents.loadURL("data:text/html,<title>host</title>");
  const extensions = attachExtensionSupport(ses, {
    createTab: async () => { throw new Error("no tabs"); }, selectTab: () => undefined, removeTab: () => undefined,
  }, { preloadDir: work, window });
  const extension = await ses.extensions.loadExtension(writeFixture(path.join(work, "ext")), { allowFileAccess: false });
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  extensions.addTab(view.webContents, window);
  await view.webContents.loadURL("data:text/html,<title>tab</title>");
  extensions.selectTab(view.webContents);

  // Anchor a toolbar button near the RIGHT edge of the window.
  const anchorRect = { x: 950, y: 8, width: 28, height: 28 };
  const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
  await extensions.api.browserAction.activate(
    { type: "frame", sender: null, extension },
    { eventType: "click", extensionId: extension.id, tabId: view.webContents.id, anchorRect }, // no alignment: inward
  );
  await sleep(1500);
  const popup = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
  assert(popup && !popup.isDestroyed(), "no popup window was created");

  const winContent = window.getContentBounds();
  const b = popup.getBounds();
  const anchorRightAbs = winContent.x + anchorRect.x + anchorRect.width;
  console.log(`GEOMETRY popup=${JSON.stringify(b)} winContent=${JSON.stringify(winContent)} anchorRightAbs=${anchorRightAbs}`);
  // 1. INWARD: the popup's right edge is at/left of the anchor's right edge,
  //    so it extends into the window, not off the right side.
  assert(b.x + b.width <= anchorRightAbs + 2, `popup opens outward (right ${b.x + b.width} > anchor ${anchorRightAbs})`);
  assert(b.x < anchorRightAbs, "popup is not left of the anchor");

  // 2. CLAMP: the region math keeps it inside window content ∩ work area.
  const region = popupRegion(window);
  const clamped = clampRect(b, region);
  console.log(`GEOMETRY region=${JSON.stringify(region)} clamped=${JSON.stringify(clamped)}`);
  assert(clamped.x >= region.x && clamped.y >= region.y, "clamped origin escapes the region");
  assert(clamped.x + clamped.width <= region.x + region.width + 1, "clamped right edge escapes the region");
  assert(clamped.y + clamped.height <= region.y + region.height + 1, "clamped bottom edge escapes the region");

  // 3. POPUP HOLD LIFECYCLE. PopupView emits no "closed"; the hold must be
  //    released from the actual BrowserWindow's own `closed`. Mirror the
  //    production wiring: capture the window and listen on it, then destroy
  //    the popup the way a re-click/dismiss does and assert the hold cleared.
  let holdOpen = false;
  const popupWindow = popup;
  popupWindow.once("closed", () => { holdOpen = false; });
  holdOpen = true;
  // PopupView.destroy() force-destroys the BrowserWindow — the same path a
  // re-click (toggle) or a dismiss takes. It must fire the window's `closed`.
  popupWindow.destroy();
  await sleep(300);
  console.log(`GEOMETRY holdOpenAfterClose=${holdOpen}`);
  assert(holdOpen === false, "the BrowserWindow 'closed' did not fire — the popup hold would leak");

  console.log("POPUP_GEOMETRY_OK");
  window.destroy();
}

app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error("POPUP_GEOMETRY_FAIL", error); app.exit(1); });
