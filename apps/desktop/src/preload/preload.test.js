const { beforeAll, describe, expect, test } = require("bun:test");
const { electron } = require("../../test/fake-electron");

let desktop;
beforeAll(() => {
  globalThis.document ??= { documentElement: { getAttribute: () => null, setAttribute() {} }, addEventListener() {} };
  require("./preload");
  desktop = electron.contextBridge.exposed.telarDesktop;
});

function lastInvoke(call) {
  electron.ipcRenderer.invoked = [];
  call();
  return electron.ipcRenderer.invoked.at(-1);
}

describe("the bridge sends what the main process checks", () => {
  test("a new window is asked for by path, never by URL", () => {
    expect(lastInvoke(() => desktop.app.openWindow("/spool"))).toEqual(["telar:app:open-window", { path: "/spool" }]);
  });

  test("the page claims links through set-routing, and hears them on the open channel", () => {
    expect(lastInvoke(() => desktop.links.setRouting(true))).toEqual(["telar:links:set-routing", { on: true }]);
    const heard = [];
    const stop = desktop.links.onOpen((payload) => heard.push(payload));
    electron.ipcRenderer.emit("telar:links:open", {}, { url: "https://example.com/" });
    stop();
    electron.ipcRenderer.emit("telar:links:open", {}, { url: "https://late.example/" });
    expect(heard).toEqual([{ url: "https://example.com/" }]);
  });
});

describe("the workspace verbs share one channel, and only the file verbs send a kind", () => {
  test("the folder verbs send no kind at all", () => {
    expect(lastInvoke(() => desktop.workspace.open("/p"))).toEqual(["telar:workspace:open", { path: "/p" }]);
    expect(lastInvoke(() => desktop.workspace.open("/p", "vscode"))).toEqual(["telar:workspace:open", { path: "/p", openerId: "vscode" }]);
    expect(lastInvoke(() => desktop.workspace.reveal("/p"))).toEqual(["telar:workspace:open", { path: "/p", reveal: true }]);
  });

  test("the file verbs say so", () => {
    expect(lastInvoke(() => desktop.workspace.revealFile("/p/a.ts"))).toEqual(["telar:workspace:open", { path: "/p/a.ts", kind: "file", reveal: true }]);
    expect(lastInvoke(() => desktop.workspace.openFile("/p/a.ts"))).toEqual(["telar:workspace:open", { path: "/p/a.ts", kind: "file" }]);
    expect(lastInvoke(() => desktop.workspace.openFile("/p/a.ts", "vscode"))).toEqual(["telar:workspace:open", { path: "/p/a.ts", kind: "file", openerId: "vscode" }]);
  });
});
