const { ipcMain, shell, BrowserWindow, dialog, app } = require("electron");
const { openersWithIcons, bundleIcon, discoverOpeners, openWith } = require("./workspace-openers");
const path = require("node:path");
const fs = require("node:fs");
const { readMarker, setPending, clearPending, adoptStore, clearRetired } = require("../store/store-location");
const { DEV_BUILD } = require("./flags");
const { volumeIdentityFor } = require("./volumes");
const { retiredSubtrees, preflight: preflightMove, migrateStore, deleteRetiredSubtrees } = require("../store/store-migrate");

function registerWorkspaceAndStoreIpc(main) {
  const { telarHome } = main;
  ipcMain.handle("telar:workspace:openers", () => openersWithIcons({ getFileIcon: (target) => bundleIcon(target) }));

  ipcMain.handle("telar:workspace:open", async (_event, input) => {
    const target = typeof input?.path === "string" ? input.path : "";
    if (!target || !path.isAbsolute(target)) return { ok: false, error: "A workspace can only be opened from an absolute path." };
    const file = input?.kind === "file";
    let stat;
    try {
      stat = fs.statSync(target);
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
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const [directory] = result.filePaths || [];
    return result.canceled || !directory ? { cancelled: true } : { path: directory };
  });

  function storeStatus() {
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
            bytes: retiredSubtrees(retired.source, retired.stamp).reduce((total, entry) => total + entry.bytes, 0),
            removable: (active?.lastOpenedAt ?? 0) > Number(retired.stamp),
          }
        : undefined,
    };
  }

  ipcMain.handle("telar:store:status", () => storeStatus());

  ipcMain.handle("telar:store:preflight", (_event, input) => {
    const target = typeof input?.path === "string" ? input.path.trim() : "";
    if (!target) return { ok: false, message: "Choose a folder." };
    return preflightMove({ source: telarHome(), target });
  });

  ipcMain.handle("telar:store:move", async (event, input) => {
    const target = typeof input?.path === "string" ? input.path.trim() : "";
    if (!target) return { ok: false, message: "Choose a folder." };
    const source = telarHome();
    const userData = app.getPath("userData");
    const { marker } = readMarker(userData);
    if (!marker?.active) return { ok: false, message: "Telar has not settled on a store yet." };

    setPending(userData, { path: target });
    const outcome = await migrateStore({
      source,
      target,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("telar:store:progress", progress);
      },
    });
    if (!outcome.ok) {
      clearPending(userData);
      return outcome;
    }

    adoptStore(userData, {
      path: target,
      storeId: outcome.storeId,
      volume: volumeIdentityFor(target),
      retired: { source, stamp: outcome.stamp },
    });
    clearPending(userData);
    return { ok: true, restartRequired: true, bytes: outcome.bytes, path: target };
  });

  ipcMain.handle("telar:store:remove-old", () => {
    const userData = app.getPath("userData");
    const { marker } = readMarker(userData);
    if (!marker?.retired) return { ok: false, message: "There is no previous store to remove." };
    const outcome = deleteRetiredSubtrees({
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
