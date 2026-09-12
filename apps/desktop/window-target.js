"use strict";

/**
 * WHERE A SECOND WINDOW IS ALLOWED TO POINT.
 *
 * "Open in a new window" (the session menu, issue #287) is the renderer asking
 * the shell to build another BrowserWindow on a page of the app. The renderer
 * therefore names a PATH and never a URL: a full address crossing the bridge
 * would let anything that can reach `telarDesktop` open a window on any origin
 * it liked, wearing Telar's own preload — which is the one thing the external
 * link policy exists to prevent for a clicked link, and would be a hole beside
 * it.
 *
 * Same origin as the window doing the asking, and nothing else. The path is
 * resolved against that window's own address, which is the same origin in
 * dev-repo, packaged and TELAR_DESKTOP_URL modes — so nothing here has to guess
 * a port or a hostname either.
 *
 * Pure and dependency-free on purpose: main.js cannot be required outside an
 * Electron main process, so the decision lives where a test can reach it.
 */

/**
 * The absolute URL a new window may open, or null when the request is not the
 * app's own UI.
 *
 * @param {string | null | undefined} appUrl - the asking window's current address.
 * @param {unknown} target - the path the renderer asked for.
 * @returns {string | null}
 */
function windowTargetUrl(appUrl, target) {
  if (typeof appUrl !== "string" || !appUrl) return null;
  if (typeof target !== "string" || !target) return null;
  /**
   * ONE LEADING SLASH, ALWAYS. A bare "evil.com" resolves as a RELATIVE path
   * (so it would pass the origin check while landing somewhere nobody named),
   * and "//evil.com" is a protocol-relative URL that resolves to another host
   * entirely. Both are refused by shape before any parsing, so the origin check
   * below is the second guard rather than the only one.
   */
  if (!target.startsWith("/") || target.startsWith("//")) return null;
  // A backslash is a slash to the URL parser for http(s), so "/\evil.com" is
  // the protocol-relative case in disguise.
  if (target.startsWith("/\\")) return null;
  let base;
  let resolved;
  try {
    base = new URL(appUrl);
    resolved = new URL(target, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  return resolved.href;
}

module.exports = { windowTargetUrl };
