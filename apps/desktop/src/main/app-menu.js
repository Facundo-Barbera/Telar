const { BrowserWindow, Menu } = require("electron");
const { claimedCommandIds, keymapOverrides, menuCommands, mergeKeymap } = require("./command-keys");
const { ChordScopes } = require("./chord-scope");
const { jsonPrefs } = require("./prefs");
const { DEV_BUILD } = require("./flags");
const devUpdate = require("../dev/dev-update");

const chords = { capturing: false, scopes: new ChordScopes() };

const { read: readKeybindingOverrides, write: writeKeybindingOverrides } = jsonPrefs(
  "keybindings.json",
  {},
  (raw) => keymapOverrides(mergeKeymap(raw)),
  "keybindings",
);

function readKeymap() {
  return mergeKeymap(readKeybindingOverrides());
}

function setBrowserChordScope(manager, owned) {
  if (chords.scopes.setOwner(manager, owned)) buildApplicationMenu();
}

function sendCommandKey(browserWindow, id) {
  const win = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  win?.webContents.send("telar:command-keys:invoke", id);
}

function buildApplicationMenu(keymap = readKeymap()) {
  const claimed = new Set(claimedCommandIds(keymap, chords.scopes.all()));
  const toMenuItem = (command) => ({
    label: command.label,

    ...(command.accelerator && !chords.capturing && !claimed.has(command.id) ? { accelerator: command.accelerator } : {}),
    enabled: !chords.capturing,
    click: (_menuItem, browserWindow) => sendCommandKey(browserWindow, command.id),
  });
  const fileCommands = menuCommands(keymap, "file");
  const panelCommands = menuCommands(keymap, "panel");
  const viewCommands = menuCommands(keymap, "view");

  const jumpBindings = fileCommands.filter((command) => command.jump);
  const otherBindings = fileCommands.filter((command) => !command.jump);
  const isMac = process.platform === "darwin";
  const template = [

    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        ...otherBindings.map(toMenuItem),
        { type: "separator" },

        { label: "Jump to", submenu: jumpBindings.map(toMenuItem) },

        ...(DEV_BUILD
          ? [
              { type: "separator" },
              { label: "Update from Local Checkout…", click: () => devUpdate.openWindow() },
            ]
          : []),
      ],
    },
    { role: "editMenu" },

    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        ...viewCommands.map(toMenuItem),
        { role: "toggleDevTools", label: "Cockpit Developer Tools", accelerator: "CommandOrControl+Alt+Shift+I" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    ...(panelCommands.length > 0 ? [{ label: "Panel", submenu: panelCommands.map(toMenuItem) }] : []),
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildApplicationMenu, chords, readKeybindingOverrides, setBrowserChordScope, writeKeybindingOverrides };
