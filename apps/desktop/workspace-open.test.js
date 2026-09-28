const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { mainSource } = require("./main-source");

const main = mainSource();
const preload = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");

const handler = main.slice(
  main.indexOf('ipcMain.handle("telar:workspace:open", async'),
  main.indexOf('ipcMain.handle("telar:dialog:choose-directory"'),
);

describe("telar:workspace:open accepts a file only when the caller says so", () => {
  test("the handler exists and this test is reading it", () => {
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toContain("shell.showItemInFolder(target)");
  });

  test("the kind is a directory unless it is exactly \"file\", so a caller that sends none is refused a non-directory as before", () => {
    expect(handler).toContain('const file = input?.kind === "file";');

    expect(handler).toContain("if (file ? !stat.isFile() : !stat.isDirectory())");
  });

  test("both guards still stand in front of it: absolute path first, then a stat that must succeed", () => {
    const absolute = handler.indexOf("!path.isAbsolute(target)");
    const stat = handler.indexOf("fs.statSync(target)");
    const kind = handler.indexOf('input?.kind === "file"');
    const act = handler.indexOf("shell.showItemInFolder(target)");
    expect(absolute).toBeGreaterThan(-1);
    expect(absolute).toBeLessThan(stat);
    expect(kind).toBeLessThan(act);
    expect(stat).toBeLessThan(act);

    expect(handler).toContain('return { ok: false, error: "A workspace can only be opened from an absolute path." };');
  });

  test("a missing file and a wrong kind each say which they were, rather than calling a file a folder", () => {
    expect(handler).toContain('error: file ? "That file is no longer on this machine." : "That folder is no longer on this machine."');
    expect(handler).toContain('error: file ? "That path is not a file." : "That path is not a folder."');
  });

  test("an app is still matched against what is installed — the file branch adds no way to name a binary", () => {
    expect(handler).toContain("discoverOpeners().find((candidate) => candidate.id === input.openerId)");
    expect(handler).toContain('return { ok: false, error: "That app is not installed on this machine." };');
  });
});

describe("the preload names the two file verbs, and only they send the kind", () => {
  const bridge = preload.slice(preload.indexOf("  workspace: {"), preload.indexOf("  appearance: {"));

  test("revealFile and openFile reach the SAME channel the folder verbs do", () => {
    expect(bridge).toContain('revealFile: (path) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", reveal: true }),');
    expect(bridge).toContain(
      'openFile: (path, openerId) => ipcRenderer.invoke("telar:workspace:open", { path, kind: "file", ...(openerId ? { openerId } : {}) }),',
    );
    expect(bridge.match(/ipcRenderer\.invoke\("telar:workspace:open"/g)).toHaveLength(4);
  });

  test("the folder verbs send no kind at all, so the header's Open button is byte-for-byte the request it always was", () => {
    expect(bridge).toContain('open: (path, openerId) => ipcRenderer.invoke("telar:workspace:open", { path, ...(openerId ? { openerId } : {}) }),');
    expect(bridge).toContain('reveal: (path) => ipcRenderer.invoke("telar:workspace:open", { path, reveal: true }),');
    expect(bridge.match(/\{ path, kind: "file"/g)).toHaveLength(2);
  });
});
