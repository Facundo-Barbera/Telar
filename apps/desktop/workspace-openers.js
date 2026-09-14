/**
 * WHICH APPS ON THIS MAC CAN OPEN A FOLDER.
 *
 * Discovery is a bundle-existence probe at the standard install locations
 * (/Applications, /Applications/Utilities, ~/Applications, /System/…) — the
 * same mechanism `list_apps` uses, and the same one macOS itself installs to.
 * No subprocess is spawned to find anything, so an empty list means "not
 * installed here" rather than "a helper failed".
 *
 * Launching goes through `/usr/bin/open -a <bundle> <folder>` with execFile
 * and an ARGV ARRAY: no shell, so a folder or app path containing a space,
 * quote or semicolon is one argument rather than somebody else's command.
 *
 * The list is CURATED, not exhaustive, and is only ever a filter over what is
 * actually installed. Finder is always offered because it always exists.
 *
 * AND EACH ROW CARRIES ITS REAL ICON (issue #398). The renderer used to draw a
 * vendored silhouette of each app's logo, which at 14px turned Xcode into
 * noise and made Finder a drawing of a logo rather than the logo. macOS already
 * holds the artwork — `app.getFileIcon` on the `.app` bundle is the same bitmap
 * the Dock and Finder show — so the shell reads it once per bundle and hands
 * the renderer a PNG data URL. The vector marks stay as the fallback for the
 * surfaces the shell cannot reach (a browser tab, a remote Mac).
 */
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * id → what to call it, the bundle names to look for, and the brand mark the
 * renderer should wear.
 *
 * `icon` IS A SEPARATE FIELD FROM `id` on purpose. The id is this table's
 * private key — it is what the renderer names when it asks to launch something,
 * and renaming one would strand a person's remembered preference. The icon is a
 * drawing, several openers can legitimately share one, and an opener whose
 * brand mark we do not carry OMITS IT rather than borrowing a neighbour's: the
 * renderer draws its neutral folder glyph, which is honest, where a wrong logo
 * is a small lie told every time the menu opens.
 */
const KNOWN_EDITORS = [
  { id: "vscode", label: "Visual Studio Code", icon: "vscode", bundles: ["Visual Studio Code.app"] },
  { id: "cursor", label: "Cursor", icon: "cursor", bundles: ["Cursor.app"] },
  { id: "windsurf", label: "Windsurf", icon: "windsurf", bundles: ["Windsurf.app"] },
  { id: "zed", label: "Zed", icon: "zed", bundles: ["Zed.app"] },
  { id: "sublime", label: "Sublime Text", icon: "sublime", bundles: ["Sublime Text.app"] },
  { id: "webstorm", label: "WebStorm", icon: "webstorm", bundles: ["WebStorm.app"] },
  { id: "intellij", label: "IntelliJ IDEA", icon: "intellij", bundles: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"] },
  { id: "pycharm", label: "PyCharm", icon: "pycharm", bundles: ["PyCharm.app", "PyCharm CE.app"] },
  { id: "xcode", label: "Xcode", icon: "xcode", bundles: ["Xcode.app"] },
  { id: "nova", label: "Nova", bundles: ["Nova.app"] },
  { id: "textmate", label: "TextMate", bundles: ["TextMate.app"] },
  { id: "iterm", label: "iTerm", icon: "iterm", bundles: ["iTerm.app"] },
  // macOS's own Terminal is deliberately NOT here (issue #384). It ships on
  // every Mac, so it appeared in every Open menu — and on a machine with one
  // editor it was half the list, offering to open a folder in a shell to
  // somebody who asked where to edit. The terminals people install ON PURPOSE
  // stay: choosing to have iTerm or Ghostty is itself the signal Terminal
  // cannot give.
  { id: "ghostty", label: "Ghostty", bundles: ["Ghostty.app"] },
];

function searchRoots(home = os.homedir()) {
  return ["/Applications", path.join(home, "Applications"), "/System/Applications"];
}

/**
 * The installed openers, in the curated order. `{ id, label, path, icon? }`.
 * `roots`/`exists` are injected by tests; production probes the real disk.
 *
 * `icon` is absent, not null, when the table carries no mark for the app — the
 * renderer's fallback is "no icon id", so an absent key says exactly that
 * without a second sentinel to keep in step.
 */
function discoverOpeners({ roots = searchRoots(), exists = fs.existsSync } = {}) {
  const found = [];
  for (const editor of KNOWN_EDITORS) {
    for (const root of roots) {
      const bundle = editor.bundles.map((name) => path.join(root, name)).find((candidate) => exists(candidate));
      if (bundle) {
        found.push({ id: editor.id, label: editor.label, path: bundle, ...(editor.icon ? { icon: editor.icon } : {}) });
        break;
      }
    }
  }
  return found;
}

/**
 * Finder's bundle. Not in `KNOWN_EDITORS` — "Reveal in Finder" is a look rather
 * than an open, and the renderer builds that row itself — but it is still a row
 * with a logo on it, and the same `.app` on disk answers for it.
 */
const FINDER_BUNDLE = "/System/Library/CoreServices/Finder.app";

/**
 * bundle path → the PNG data URL for its icon, for the life of this process.
 *
 * ONE ASK PER BUNDLE, EVER. The menu is re-enumerated on every open and by
 * every project group in the rail, and `getFileIcon` is a disk read plus an
 * image decode; an app's icon does not change while Telar is running, so the
 * first answer is the answer. Tests pass their own map so nothing leaks between
 * them.
 */
const iconCache = new Map();

/**
 * `bundlePath`'s icon as a `data:image/png;base64,…`, or undefined.
 *
 * UNDEFINED IS A REAL ANSWER, not an error: a bundle that has gone away between
 * discovery and this call, or a platform with no `getFileIcon` at all, means
 * "no bitmap" and the renderer falls back to its vector mark. Nothing here
 * rejects, so one unreadable app cannot empty the whole menu.
 *
 * A FAILURE IS NOT CACHED. The success is permanent; a miss drops out of the
 * map so the next time the menu opens asks again — an app being reinstalled
 * mid-session should not cost it its icon until Telar restarts.
 */
function openerIconDataUrl({ bundlePath, getFileIcon, cache = iconCache }) {
  const cached = cache.get(bundlePath);
  if (cached) return cached;
  const pending = Promise.resolve()
    .then(() => getFileIcon(bundlePath, { size: "normal" }))
    .then((image) => {
      // NativeImage, duck-typed: the shape this needs is `toPNG()`, and an
      // empty buffer is what an icon-less path answers with rather than a throw.
      const png = typeof image?.toPNG === "function" ? image.toPNG() : undefined;
      return png && png.length > 0 ? `data:image/png;base64,${png.toString("base64")}` : undefined;
    })
    .catch(() => undefined);
  cache.set(bundlePath, pending);
  void pending.then((answer) => {
    if (answer === undefined && cache.get(bundlePath) === pending) cache.delete(bundlePath);
  });
  return pending;
}

/**
 * The openers, each with `iconDataUrl` when macOS could produce one, plus
 * Finder's own icon for the reveal row the renderer draws.
 *
 * `getFileIcon` IS INJECTED rather than imported, because this module is unit
 * tested without Electron and because `app.getFileIcon` must be called on
 * `app`. Absent — a platform or a build with no shell behind it — every row
 * comes back exactly as `discoverOpeners` found it, which is the shape the
 * renderer already handles.
 */
async function openersWithIcons({ openers = discoverOpeners(), getFileIcon, cache = iconCache, exists = fs.existsSync } = {}) {
  if (typeof getFileIcon !== "function") return { openers };
  const [icons, reveal] = await Promise.all([
    Promise.all(openers.map((opener) => openerIconDataUrl({ bundlePath: opener.path, getFileIcon, cache }))),
    exists(FINDER_BUNDLE) ? openerIconDataUrl({ bundlePath: FINDER_BUNDLE, getFileIcon, cache }) : undefined,
  ]);
  return {
    openers: openers.map((opener, index) => (icons[index] ? { ...opener, iconDataUrl: icons[index] } : opener)),
    ...(reveal ? { revealIconDataUrl: reveal } : {}),
  };
}

/**
 * Open `target` with the app at `appPath`, or with the system default when no
 * app is named. Resolves `{ ok }` or `{ ok: false, error }`; never throws, and
 * never builds a command string.
 */
function openWith({ target, appPath, run = execFile }) {
  return new Promise((resolve) => {
    const args = appPath ? ["-a", appPath, target] : [target];
    run("/usr/bin/open", args, { timeout: 10_000 }, (error) => {
      if (!error) return resolve({ ok: true });
      resolve({ ok: false, error: `That app could not open the folder (${error.message}).` });
    });
  });
}

module.exports = { discoverOpeners, openWith, openersWithIcons, openerIconDataUrl, searchRoots, FINDER_BUNDLE, KNOWN_EDITORS };
