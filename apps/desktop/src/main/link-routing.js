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
