/**
 * PAGES THAT ARE NOT THE AGENT'S AND NOT THE HISTORY'S — the browser's own
 * internal pages and an extension's own pages (a password manager's popup, its
 * unlock, its settings). Browser tools refuse to read or act on them, captures
 * refuse to photograph them, and the recent-sites recorder skips them.
 */

const EXTENSION_SCHEMES = ["chrome-extension:", "chrome:", "devtools:", "crx:"];

function isProtectedUrl(url) {
  try {
    const protocol = new URL(String(url || "")).protocol;
    return EXTENSION_SCHEMES.includes(protocol);
  } catch {
    return false;
  }
}

module.exports = { isProtectedUrl, EXTENSION_SCHEMES };
