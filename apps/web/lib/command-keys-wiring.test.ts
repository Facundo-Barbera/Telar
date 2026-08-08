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
    // Passes activeSessionId too, not just chats — otherwise cmd+1..9 silently
    // disagrees with the sidebar the moment the open session is old enough to
    // have been pinned past the Recent band's usual cutoff (see
    // recentSessionsForCommandKeys in session-list.ts for what the pin means).
    expect(sidebar).toContain("useCommandKeys(chats, activeSessionFromPathname(pathname))");
  });

  test("the hook listens for both the in-page keydown AND the desktop menu's forwarded id", () => {
    const hook = read("lib/use-command-keys.ts");
    expect(hook).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(hook).toContain("resolveWebCommandKeyAction(event)");
    expect(hook).toContain("window.telarDesktop?.commandKeys?.onInvoke");
    // The desktop path applies NO focus check (issue #46): every menu
    // accelerator is a CommandOrControl chord and chords are exempt from
    // the focus rule, which is enforced in exactly one place —
    // resolveWebCommandKeyAction. Pinned as an ABSENCE so the old
    // re-check, which silently dropped every menu invoke while the
    // composer held focus, cannot creep back as a second copy of the rule.
    expect(hook).not.toContain("isEditableTarget");
  });
});

describe("the hold-⌘ hints are actually wired into the sidebar", () => {
  test("the sidebar mounts the gesture hook and derives the id-keyed jump map", () => {
    const sidebar = read("components/app-sidebar.tsx");
    expect(sidebar).toContain("useCommandKeyHints()");
    expect(sidebar).toContain("commandKeyJumpNumbers(chats, activeSessionId, renderedAt)");
    // The Settings and New Session hints ride the same visibility flag.
    expect(sidebar).toContain('hintLabel(",")');
    expect(sidebar).toContain('hintLabel("n")');
  });

  test("the hook translates every ending signal, not just keyup — ⌘Tab must not strand hints on", () => {
    const hook = read("lib/use-command-key-hints.ts");
    expect(hook).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(hook).toContain('window.addEventListener("keyup", onKeyUp)');
    expect(hook).toContain('window.addEventListener("blur", onBlur)');
    expect(hook).toContain('document.addEventListener("visibilitychange", onVisibility)');
    // The behavior itself must stay in the pure machine, where it is tested.
    expect(hook).toContain("nextHintState(state.current, signal)");
  });

  test("a session row renders the hint the sidebar hands it", () => {
    const row = read("components/session/session-row.tsx");
    expect(row).toContain("commandHint");
    expect(row).toContain("<CommandKeyHint");
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
