const { afterEach, describe, expect, spyOn, test } = require("bun:test");
require("../../test/fake-electron");
const { ExtensionHost } = require("../browser/extension-host");
const { startExtensionHost } = require("./cockpit-extensions");

afterEach(() => spyOn(ExtensionHost.prototype, "startOnce").mockRestore());

const win = { isDestroyed: () => false, webContents: { send() {} } };

describe("the browser's extension host", () => {
  test("is not created, so nothing is loaded or spawned, while the password manager is off", () => {
    const start = spyOn(ExtensionHost.prototype, "startOnce").mockResolvedValue({ phase: "ready" });
    expect(startExtensionHost(win, {}, "persist:p", () => false)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  test("starts as before while it is on", () => {
    const start = spyOn(ExtensionHost.prototype, "startOnce").mockResolvedValue({ phase: "ready" });
    expect(startExtensionHost(win, {}, "persist:p", () => true)).toBeInstanceOf(ExtensionHost);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
