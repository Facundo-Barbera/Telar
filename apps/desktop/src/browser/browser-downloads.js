"use strict";

const nodeFs = require("node:fs");
const path = require("node:path");

const MAX_SUFFIX = 9_999;

function safeFilename(name) {
  const flat = String(name ?? "").replace(/[/\\\x00-\x1f]/g, "_").trim().replace(/^\.+/, "");
  return flat || "download";
}

function uniqueDownloadPath(dir, filename, exists) {
  const name = safeFilename(filename);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n <= MAX_SUFFIX; n += 1) {
    const candidate = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

function installDownloadHandler(ses, { directory, shouldAsk = () => false, onStarted = () => {}, onFinished = () => {}, fs = nodeFs }) {
  const reserved = new Set();
  ses.on("will-download", (_event, item, webContents) => {
    const url = item.getURL();
    const report = { url, webContents: webContents ?? null };
    let target = null;
    if (!shouldAsk(url)) {
      const dir = directory();
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      target = uniqueDownloadPath(dir, item.getFilename(), (candidate) => reserved.has(candidate) || fs.existsSync(candidate));
      reserved.add(target);
      item.setSavePath(target);
      onStarted({ ...report, path: target, filename: path.basename(target) });
    }
    item.once("done", (_doneEvent, state) => {
      if (target) reserved.delete(target);

      const saved = target || item.getSavePath();
      if (!saved) return;
      onFinished({ ...report, state, path: saved, filename: path.basename(saved) });
    });
  });
}

module.exports = { installDownloadHandler, uniqueDownloadPath, safeFilename };
