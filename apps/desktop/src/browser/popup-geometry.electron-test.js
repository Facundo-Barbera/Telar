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

  const anchorRect = { x: 950, y: 8, width: 28, height: 28 };
  const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
  await extensions.api.browserAction.activate(
    { type: "frame", sender: null, extension },
    { eventType: "click", extensionId: extension.id, tabId: view.webContents.id, anchorRect },
  );
  await sleep(1500);
  const popup = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
  assert(popup && !popup.isDestroyed(), "no popup window was created");

  const winContent = window.getContentBounds();
  const b = popup.getBounds();
  const anchorRightAbs = winContent.x + anchorRect.x + anchorRect.width;
  console.log(`GEOMETRY popup=${JSON.stringify(b)} winContent=${JSON.stringify(winContent)} anchorRightAbs=${anchorRightAbs}`);

  assert(b.x + b.width <= anchorRightAbs + 2, `popup opens outward (right ${b.x + b.width} > anchor ${anchorRightAbs})`);
  assert(b.x < anchorRightAbs, "popup is not left of the anchor");

  const region = popupRegion(window);
  const clamped = clampRect(b, region);
  console.log(`GEOMETRY region=${JSON.stringify(region)} clamped=${JSON.stringify(clamped)}`);
  assert(clamped.x >= region.x && clamped.y >= region.y, "clamped origin escapes the region");
  assert(clamped.x + clamped.width <= region.x + region.width + 1, "clamped right edge escapes the region");
  assert(clamped.y + clamped.height <= region.y + region.height + 1, "clamped bottom edge escapes the region");

  let holdOpen = false;
  const popupWindow = popup;
  popupWindow.once("closed", () => { holdOpen = false; });
  holdOpen = true;

  popupWindow.destroy();
  await sleep(300);
  console.log(`GEOMETRY holdOpenAfterClose=${holdOpen}`);
  assert(holdOpen === false, "the BrowserWindow 'closed' did not fire — the popup hold would leak");

  console.log("POPUP_GEOMETRY_OK");
  window.destroy();
}

app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error("POPUP_GEOMETRY_FAIL", error); app.exit(1); });
