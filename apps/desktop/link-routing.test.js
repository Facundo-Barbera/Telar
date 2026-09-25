// Settings → Links, as the main process sees it. The routing is pure and
// tested directly; its wiring in main.js and preload.js (which need an
// Electron process to require) is held to source contracts, as in
// external-links.test.js.
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { describe, expect, test } = require("bun:test");

const { createLinkRouting, LINK_OPEN_CHANNEL } = require("./link-routing");

function fakeWebContents() {
  const sent = [];
  return { sent, destroyed: false, isDestroyed() { return this.destroyed; }, send: (channel, payload) => sent.push({ channel, payload }) };
}

describe("createLinkRouting", () => {
  test("unclaimed, a link leaves for the system browser — today's behaviour", () => {
    const routing = createLinkRouting();
    const win = fakeWebContents();
    const opened = [];
    expect(routing.handOff(win, "https://example.com/", (url) => opened.push(url))).toBe("system");
    expect(opened).toEqual(["https://example.com/"]);
    expect(win.sent).toEqual([]);
  });

  test("claimed, the link goes back to the page that claimed it, not to the OS", () => {
    const routing = createLinkRouting();
    const win = fakeWebContents();
    const opened = [];
    routing.set(win, true);
    expect(routing.handOff(win, "https://example.com/", (url) => opened.push(url))).toBe("page");
    expect(win.sent).toEqual([{ channel: LINK_OPEN_CHANNEL, payload: { url: "https://example.com/" } }]);
    expect(opened).toEqual([]);
  });

  test("turning the setting off releases the claim", () => {
    const routing = createLinkRouting();
    const win = fakeWebContents();
    routing.set(win, true);
    routing.set(win, false);
    expect(routing.handOff(win, "https://example.com/", () => {})).toBe("system");
  });

  test("the claim is per window: one window's setting never routes another's links", () => {
    const routing = createLinkRouting();
    const claimed = fakeWebContents();
    const other = fakeWebContents();
    routing.set(claimed, true);
    expect(routing.handOff(other, "https://example.com/", () => {})).toBe("system");
    expect(other.sent).toEqual([]);
  });

  test("a destroyed page cannot receive the link, so it goes to the system browser", () => {
    const routing = createLinkRouting();
    const win = fakeWebContents();
    routing.set(win, true);
    win.destroyed = true;
    const opened = [];
    expect(routing.handOff(win, "https://example.com/", (url) => opened.push(url))).toBe("system");
    expect(opened).toEqual(["https://example.com/"]);
  });
});

describe("desktop link-routing wiring", () => {
  const codeOf = (file) =>
    readFileSync(path.join(__dirname, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
  const mainCode = codeOf("main.js");
  const preloadCode = codeOf("preload.js");

  test("the main process learns the setting from the page, top frame only", () => {
    expect(mainCode).toContain('ipcMain.handle("telar:links:set-routing"');
    expect(mainCode).toContain("event.senderFrame !== event.sender.mainFrame");
    expect(mainCode).toContain("linkRouting.set(event.sender, input?.on === true)");
    expect(preloadCode).toContain('ipcRenderer.invoke("telar:links:set-routing", { on })');
    expect(preloadCode).toContain(`on("${LINK_OPEN_CHANNEL}", listener)`);
  });

  test("popups and navigations consult it before the system browser", () => {
    expect(mainCode).toContain("linkRouting.handOff(webContents, decision.openExternal, openInSystemBrowser)");
    expect(mainCode.match(/ actOnLinkDecision\(decision, webContents\);/g)?.length).toBe(2);
  });

  test("a reload drops the claim; the remounted cockpit claims again", () => {
    expect(mainCode).toContain("linkRouting.set(win.webContents, false)");
  });
});
