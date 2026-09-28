/**
 * "OPEN LINKS IN THE SESSION'S BROWSER", AS THE MAIN PROCESS SEES IT.
 *
 * The setting lives in the renderer (`apps/web/lib/link-policy.ts`), and for
 * as long as it did ONLY there it never worked: a link the page did not catch
 * itself — Streamdown's confirmed link, a `target=_blank` in tool output or in
 * the right panel — arrives here as a popup, and this process handed every one
 * of them to the system browser without knowing the setting existed.
 *
 * SO THE PAGE TELLS US. A cockpit with the setting on CLAIMS its window's
 * links; a claimed window's external hand-offs go back to that page, which
 * knows the session and opens the tab there. Anything unclaimed — the setting
 * off, no cockpit mounted, a window the app opened — still leaves for the
 * system browser, which is today's behaviour and the only honest fallback.
 *
 * PER webContents, not a global flag: two windows can show two sessions, and
 * one of them turning the setting on must not route the other's links.
 */
const LINK_OPEN_CHANNEL = "telar:links:open";

function createLinkRouting() {
  const claimed = new WeakSet();
  return {
    set(webContents, on) {
      if (on) claimed.add(webContents);
      else claimed.delete(webContents);
    },
    claims(webContents) {
      return claimed.has(webContents) && !webContents.isDestroyed();
    },
    /** Where an external hand-off from `webContents` goes: `"page"` or `"system"`. */
    handOff(webContents, url, openInSystemBrowser) {
      if (this.claims(webContents)) {
        webContents.send(LINK_OPEN_CHANNEL, { url });
        return "page";
      }
      openInSystemBrowser(url);
      return "system";
    },
  };
}

module.exports = { createLinkRouting, LINK_OPEN_CHANNEL };
