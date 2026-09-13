// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMAND_KEY_BINDINGS, type CommandKeyBinding } from "@/lib/command-keys";
import { searchSettings } from "@/lib/settings-search";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { KeybindingsPage, keyCaps, keybindingRows } from "./keybindings-page";

/**
 * THE PANE IS A VIEW OF `apps/desktop/command-keys.js`, so what has to be true
 * is that it stays one: a binding added to that table must appear here without
 * anybody editing this directory, and none of them may render as the raw
 * accelerator string the Electron menu wants.
 */

test("every binding in the table gets a row, derived rather than listed", () => {
  const rows = keybindingRows("mac");
  expect(rows).toHaveLength(COMMAND_KEY_BINDINGS.length);
  // Ids carried through, so the rows and the table cannot drift apart silently.
  expect(rows.map((row) => row.id).sort()).toEqual(COMMAND_KEY_BINDINGS.map((binding) => binding.id).sort());
});

test("the chord is split into one cap per key, in the platform's own register", () => {
  expect(keyCaps("CommandOrControl+N", "mac")).toEqual(["⌘", "N"]);
  expect(keyCaps("CommandOrControl+N", "other")).toEqual(["Ctrl", "N"]);
  // CommandOrControl is the whole reason the table works off a Mac (issue #16),
  // so the caps have to answer to it rather than hardcoding one platform.
  expect(keyCaps("CommandOrControl+,", "mac")).toEqual(["⌘", ","]);
  expect(keyCaps("CommandOrControl+Shift+1", "mac")).toEqual(["⌘", "⇧", "1"]);
  // Anything longer than a character is left as the table wrote it, so a future
  // Enter or Escape renders without an entry being added for it.
  expect(keyCaps("CommandOrControl+Enter", "mac")).toEqual(["⌘", "Enter"]);
});

test("rows read as Namespace: Command, in this app's vocabulary and not the menu's", () => {
  const titles = keybindingRows("mac").map((row) => row.title);
  expect(titles).toContain("Conversation: New");
  expect(titles).toContain("Window: New tab");
  expect(titles).toContain("Application: Settings");
  expect(titles).toContain("Rail: Jump to conversation 1");
  expect(titles).toContain("Rail: Jump to conversation 9");
  // "File" is the Electron menu's grouping and names nothing in a browser tab.
  expect(titles.some((title) => title.startsWith("File:"))).toBe(false);
});

test("a binding nobody has named still gets a row, off the table's own label", () => {
  // The failure this guards is silence: an id added to the table and forgotten
  // here must show up as something, not vanish from the list of what works.
  const invented: CommandKeyBinding[] = [{ id: "toggle-rail", label: "Toggle Sidebar", accelerator: "CommandOrControl+B", key: "b" }];
  expect(keybindingRows("mac", invented)).toEqual([{ id: "toggle-rail", title: "Application: Toggle Sidebar", caps: ["⌘", "B"] }]);
});

test("the pane draws each chord as key caps and counts what it is showing", () => {
  const html = renderToStaticMarkup(<KeybindingsPage />);
  expect(html).toContain("Conversation: New");
  expect(html).toContain(`${COMMAND_KEY_BINDINGS.length} bindings`);
  // Caps, not a string: "⌘ N" in one box reads as a key called "⌘ N".
  expect(html).toContain("<kbd");
  // And never the accelerator the Electron menu is built from.
  expect(html).not.toContain("CommandOrControl");
});

test("the pane says the chords are fixed rather than looking rebindable", () => {
  const html = renderToStaticMarkup(<KeybindingsPage />);
  expect(html).toContain("Fixed for now");
  // No control to press: a row that looked recordable and was not would be
  // worse than no pane at all.
  expect(html).not.toContain("<button");
});

test("search finds the pane before it has ever been opened", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  expect(first("shortcut")?.pageId).toBe("keybindings");
  expect(first("hotkey")?.pageId).toBe("keybindings");
  expect(first("keyboard shortcuts")?.pageLabel).toBe("Keybindings");
});
