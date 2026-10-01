const { ipcMain, shell, BrowserWindow, dialog, app } = require("electron");
const { openersWithIcons, bundleIcon, discoverOpeners, openWith } = require("./workspace-openers");
const path = require("node:path");
const fs = require("node:fs");
const { readMarker, clearRetired } = require("../store/store-location");
const { DEV_BUILD } = require("./flags");
const { retiredSubtrees, deleteRetiredSubtrees, totalBytes } = require("../store/store-retired");

function registerWorkspaceAndStoreIpc(main) {
  const { telarHome } = main;
  ipcMain.handle("telar:workspace:openers", () => openersWithIcons({ getFileIcon: (target) => bundleIcon(target) }));

  ipcMain.handle("telar:workspace:open", async (_event, input) => {
    const target = typeof input?.path === "string" ? input.path : "";
    if (!target || !path.isAbsolute(target)) return { ok: false, error: "A workspace can only be opened from an absolute path." };
    const file = input?.kind === "file";
    let stat;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return { ok: false, error: file ? "That file is no longer on this machine." : "That folder is no longer on this machine." };
    }
    if (file ? !stat.isFile() : !stat.isDirectory()) return { ok: false, error: file ? "That path is not a file." : "That path is not a folder." };
    if (input?.reveal === true) {
      shell.showItemInFolder(target);
      return { ok: true };
    }
    if (typeof input?.openerId === "string" && input.openerId) {
      const opener = discoverOpeners().find((candidate) => candidate.id === input.openerId);
      if (!opener) return { ok: false, error: "That app is not installed on this machine." };
      return openWith({ target, appPath: opener.path });
    }

    const failure = await shell.openPath(target);
    return failure ? { ok: false, error: failure } : { ok: true };
  });

  ipcMain.handle("telar:dialog:choose-directory", async (event, input) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: input?.title || "Choose a project folder",
      properties: ["openDirectory", "createDirectory", "treatPackageAsDirectory"],
      ...(input?.buttonLabel ? { buttonLabel: input.buttonLabel } : {}),
      ...(typeof input?.defaultPath === "string" && path.isAbsolute(input.defaultPath) ? { defaultPath: input.defaultPath } : {}),
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const [directory] = result.filePaths || [];
    return result.canceled || !directory ? { cancelled: true } : { path: directory };
  });

  async function storeStatus() {
    const userData = app.getPath("userData");
    const { marker } = readMarker(userData);
    const active = marker?.active;
    const retired = marker?.retired;
    return {
      path: telarHome(),
      defaultPath: app.getPath("userData"),
      storeId: active?.storeId,
      volume: active?.volume,

      pinnedByEnvironment: Boolean(!DEV_BUILD && process.env.TELAR_HOME?.trim()),
      retired: retired
        ? {
            ...retired,
            bytes: totalBytes(await retiredSubtrees(retired.source, retired.stamp)),
            removable: (active?.lastOpenedAt ?? 0) > Number(retired.stamp),
          }
        : undefined,
    };
  }

  ipcMain.handle("telar:store:status", () => storeStatus());

  ipcMain.handle("telar:store:remove-old", async () => {
    const userData = app.getPath("userData");
    const { marker } = readMarker(userData);
    if (!marker?.retired) return { ok: false, message: "There is no previous store to remove." };
    const outcome = await deleteRetiredSubtrees({
      source: marker.retired.source,
      stamp: marker.retired.stamp,
      openedAt: marker.active?.lastOpenedAt ?? 0,
    });
    if (outcome.ok) clearRetired(userData);
    return outcome;
  });

  ipcMain.handle("telar:store:keep-old", () => {
    clearRetired(app.getPath("userData"));
    return { ok: true };
  });
}

module.exports = { registerWorkspaceAndStoreIpc };
