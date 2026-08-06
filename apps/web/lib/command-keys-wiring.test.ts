// Structural pin for issue #16's wiring across app boundaries: this repo has
// no DOM test environment (components/conversation/items.test.ts), so the
// keydown listener, the Electron menu, and the contextBridge channel that
// carries a menu click to the renderer cannot be exercised by rendering or
// by launching Electron (hard rule for this task). What CAN be pinned is
// that the production source actually calls the tested logic, the same
// pattern lib/right-panel-mount.test.ts already uses for the right panel.
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const DESKTOP_ROOT = new URL("../../desktop/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");
const readDesktop = (path: string) => readFileSync(new URL(path, DESKTOP_ROOT), "utf8");

describe("the web renderer is actually wired to useCommandKeys", () => {
  test("AppSidebar — the one component alive on every route — mounts the hook with the live session list", () => {
    const sidebar = read("components/app-sidebar.tsx");
    expect(sidebar).toContain('import { useCommandKeys } from "@/lib/use-command-keys"');
    expect(sidebar).toContain("useCommandKeys(chats)");
  });

  test("the hook listens for both the in-page keydown AND the desktop menu's forwarded id", () => {
    const hook = read("lib/use-command-keys.ts");
    expect(hook).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(hook).toContain("resolveWebCommandKeyAction(event)");
    expect(hook).toContain("window.telarDesktop?.commandKeys?.onInvoke");
    // The desktop path re-applies the focus rule itself — the sender (the
    // Electron main process) has no DOM and could not have checked it.
    expect(hook).toContain("isEditableTarget(document.activeElement)");
  });
});

describe("the desktop shell is actually wired to the shared binding table", () => {
  test("main.js builds its menu from COMMAND_KEY_BINDINGS, not a hand-written list", () => {
    const main = readDesktop("main.js");
    expect(main).toContain('require("./command-keys")');
    expect(main).toContain("COMMAND_KEY_BINDINGS.filter");
    expect(main).toContain("Menu.setApplicationMenu(Menu.buildFromTemplate(template))");
    // Standard roles preserved — see the comment in main.js for why this
    // matters: replacing them, rather than keeping them, would silently
    // break native Cmd+C/V/X/Z, Quit, and window management.
    expect(main).toContain('{ role: "editMenu" }');
    expect(main).toContain('{ role: "windowMenu" }');
    expect(main).toContain("buildApplicationMenu()");
  });

  test("preload exposes the commandKeys bridge over the existing telar:* contextBridge pattern", () => {
    const preload = readDesktop("preload.js");
    expect(preload).toContain("commandKeys:");
    expect(preload).toContain('on("telar:command-keys:invoke", listener)');
  });

  test("the menu click handler sends the SAME channel name the preload bridge listens on", () => {
    const main = readDesktop("main.js");
    const preload = readDesktop("preload.js");
    expect(main).toContain('"telar:command-keys:invoke"');
    expect(preload).toContain('"telar:command-keys:invoke"');
  });

  test("command-keys.js ships in the packaged app (electron-builder's files whitelist)", () => {
    const pkg = JSON.parse(readDesktop("package.json")) as { build?: { files?: string[] } };
    expect(pkg.build?.files).toContain("command-keys.js");
  });
});
