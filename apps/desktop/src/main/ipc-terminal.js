const { ipcMain } = require("electron");
const { readKittyImageFile } = require("../terminal/kitty-image-file");
const { TerminalOwner } = require("../terminal/terminal-host");
const { requireCockpitSender } = require("./browser-hosts");

function registerTerminalIpc(main) {
  const { RENDERER, requireTerminalHost, terminalReaders } = main;
  ipcMain.handle("telar:terminal:open", (event, input) => {
    requireCockpitSender(event, "open a terminal");
    const host = requireTerminalHost();
    const opened = host.open({
      shell: input?.shell,
      args: input?.args,
      cwd: input?.cwd,
      cols: input?.cols,
      rows: input?.rows,

      env: process.env,
      owner: RENDERER,

      sessionId: input?.sessionId,
      title: input?.title,
    });
    if (opened.pid !== undefined) terminalReaders.set(opened.id, event.sender);
    return opened;
  });

  ipcMain.handle("telar:terminal:write", (event, input) => {
    requireCockpitSender(event, "type into a terminal");
    return { ok: requireTerminalHost().write(input?.id, input?.data, RENDERER) };
  });

  ipcMain.handle("telar:terminal:resize", (event, input) => {
    requireCockpitSender(event, "resize a terminal");
    return { ok: requireTerminalHost().resize(input?.id, input?.cols, input?.rows, RENDERER) };
  });

  ipcMain.handle("telar:terminal:kill", (event, input) => {
    requireCockpitSender(event, "stop a terminal");
    return { ok: requireTerminalHost().kill(input?.id, input?.signal || "SIGTERM", RENDERER) };
  });

  ipcMain.handle("telar:terminal:close", async (event, input) => {
    requireCockpitSender(event, "close a terminal");
    return { ok: await requireTerminalHost().close(String(input?.id ?? ""), RENDERER) };
  });

  ipcMain.handle("telar:terminal:active", async (event, input) => {
    requireCockpitSender(event, "ask whether a terminal is busy");
    const host = requireTerminalHost();
    const ids = Array.isArray(input?.ids) ? input.ids.map(String) : undefined;
    return { terminals: await host.activeProcesses(ids ? { ids } : { owner: RENDERER }) };
  });

  ipcMain.handle("telar:terminal:read-image-file", (event, input) => {
    requireCockpitSender(event, "read a terminal image file");
    return readKittyImageFile(input?.path);
  });

  ipcMain.handle("telar:terminal:list", (event) => {
    requireCockpitSender(event, "list terminals");
    return { terminals: requireTerminalHost().list(RENDERER) };
  });

  ipcMain.handle("telar:terminal:adopt", (event, input) => {
    requireCockpitSender(event, "read a run's terminal");
    const id = String(input?.id ?? "");
    if (!id) return { ok: false };
    const host = requireTerminalHost();
    if (!host.list(TerminalOwner.ENGINE).some((entry) => entry.id === id)) return { ok: false };
    terminalReaders.set(id, event.sender);
    return { ok: true };
  });

  ipcMain.handle("telar:terminal:abandon", (event, input) => {
    requireCockpitSender(event, "stop reading a run's terminal");
    const id = String(input?.id ?? "");
    if (id && terminalReaders.get(id) === event.sender) terminalReaders.delete(id);
    return { ok: true };
  });
}

module.exports = { registerTerminalIpc };
