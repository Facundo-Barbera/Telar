const { afterAll, beforeAll, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electron, resetElectron } = require("../../test/fake-electron");
const { registerWorkspaceAndStoreIpc } = require("./ipc-store");

let root;
beforeAll(() => {
  resetElectron();
  registerWorkspaceAndStoreIpc({ telarHome: () => root });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-workspace-open-"));
  fs.mkdirSync(path.join(root, "folder"));
  fs.writeFileSync(path.join(root, "file.ts"), "");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetElectron();
});

const open = (input) => {
  electron.shell.opened = [];
  return electron.ipcMain.invoke("telar:workspace:open", {}, input);
};

describe("telar:workspace:open", () => {
  test("a relative path is refused before anything is read", async () => {
    expect(await open({ path: "folder", reveal: true })).toEqual({ ok: false, error: "A workspace can only be opened from an absolute path." });
    expect(electron.shell.opened).toEqual([]);
  });

  test("with no kind it is a folder, so a file is refused as before", async () => {
    expect(await open({ path: path.join(root, "file.ts"), reveal: true })).toEqual({ ok: false, error: "That path is not a folder." });
    expect(await open({ path: path.join(root, "folder"), reveal: true })).toEqual({ ok: true });
    expect(electron.shell.opened).toEqual([path.join(root, "folder")]);
  });

  test("kind file accepts a file and refuses a folder", async () => {
    expect(await open({ path: path.join(root, "file.ts"), kind: "file", reveal: true })).toEqual({ ok: true });
    expect(await open({ path: path.join(root, "folder"), kind: "file", reveal: true })).toEqual({ ok: false, error: "That path is not a file." });
  });

  test("a missing path says which kind went missing", async () => {
    expect(await open({ path: path.join(root, "gone.ts"), kind: "file", reveal: true })).toEqual({ ok: false, error: "That file is no longer on this machine." });
    expect(await open({ path: path.join(root, "gone"), reveal: true })).toEqual({ ok: false, error: "That folder is no longer on this machine." });
  });

  test("an app is only ever one that is installed, whatever the kind", async () => {
    expect(await open({ path: path.join(root, "file.ts"), kind: "file", openerId: "/bin/sh" })).toEqual({ ok: false, error: "That app is not installed on this machine." });
  });
});
