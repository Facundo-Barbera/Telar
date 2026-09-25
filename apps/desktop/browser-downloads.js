"use strict";

// DOWNLOADS SAVE STRAIGHT TO THE DOWNLOADS FOLDER, WITH NO DIALOG.
//
// A session with no `will-download` handler makes Electron ask where to save
// every file. For a person that is one click too many; for an agent it is a
// dead end — a native modal it cannot see or answer, so a download it started
// never lands. Every browser partition gets this handler instead: the file goes
// to the OS Downloads folder under the name the site gave it, made unique the
// way browsers do (`file (1).pdf`), and whoever is listening hears where.
//
// ONE DOWNLOAD STILL ASKS: "Save Image As…", because its label promises a
// dialog. The manager marks that URL with `shouldAsk`, and a download with no
// save path set is exactly one Electron shows its Save dialog for.
//
// The path picking is pure and takes its `exists` probe as an argument, so the
// naming rule is tested without a disk.

const nodeFs = require("node:fs");
const path = require("node:path");

/** Past this many `(n)` suffixes the name is given up on in favour of one
 *  that cannot collide — a loop over a real disk must end. */
const MAX_SUFFIX = 9_999;

/** The site's filename as a single, visible path segment. Chromium already
 *  sanitises what it hands over; this is the belt for a separator or a leading
 *  dot that would write outside the folder or hide the file. */
function safeFilename(name) {
  const flat = String(name ?? "").replace(/[/\\\x00-\x1f]/g, "_").trim().replace(/^\.+/, "");
  return flat || "download";
}

/** `dir/name`, or the first `dir/stem (n).ext` that `exists` says is free. */
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

/**
 * Seat the handler on one session. `directory()` is read per download, so a
 * Downloads folder that moved is followed. `onStarted` and `onFinished` hear
 * `{ path, filename, url, webContents }`; `onFinished` also gets `state`
 * (`completed`, `cancelled` or `interrupted`).
 */
function installDownloadHandler(ses, { directory, shouldAsk = () => false, onStarted = () => {}, onFinished = () => {}, fs = nodeFs }) {
  // Two downloads of one name in flight at once both see a free disk; the
  // second must see the first's claim.
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
      // An asked download's path is whatever the person chose, or nothing.
      const saved = target || item.getSavePath();
      if (!saved) return;
      onFinished({ ...report, state, path: saved, filename: path.basename(saved) });
    });
  });
}

module.exports = { installDownloadHandler, uniqueDownloadPath, safeFilename };
