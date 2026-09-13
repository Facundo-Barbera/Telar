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

test("every binding in the table is accounted for, derived rather than listed", () => {
  const rows = keybindingRows("mac");
  const jumps = COMMAND_KEY_BINDINGS.filter((binding) => binding.jump);
  // The nine jumps fold into one row; everything else is still one row each.
  expect(rows).toHaveLength(COMMAND_KEY_BINDINGS.length - jumps.length + 1);
  // Ids carried through, so the rows and the table cannot drift apart silently.
  const singles = COMMAND_KEY_BINDINGS.filter((binding) => !binding.jump).map((binding) => binding.id);
  expect(rows.map((row) => row.id).sort()).toEqual([...singles, "jump"].sort());
});

test("the nine jumps are one row carrying the whole range", () => {
  // Nine near-identical rows were three quarters of this pane saying one thing.
  const jump = keybindingRows("mac").find((row) => row.id === "jump");
  expect(jump?.title).toBe("Rail: Jump to conversation 1–9");
  expect(jump?.caps).toEqual(["⌘", "1"]);
  expect(jump?.through).toEqual(["⌘", "9"]);
});

test("the range is read off the table, not hardcoded", () => {
  // A tenth slot must widen the row rather than go unlisted, and a table with
  // one jump has no range to fold.
  const table: CommandKeyBinding[] = [
    { id: "jump-1", label: "Jump 1", accelerator: "CommandOrControl+1", key: "1", jump: 1 },
    { id: "jump-2", label: "Jump 2", accelerator: "CommandOrControl+2", key: "2", jump: 2 },
  ];
  expect(keybindingRows("mac", table)[0]?.title).toBe("Rail: Jump to conversation 1–2");
  const lone: CommandKeyBinding[] = [table[0]!];
  expect(keybindingRows("mac", lone)).toEqual([{ id: "jump-1", title: "Rail: Jump to conversation 1", caps: ["⌘", "1"] }]);
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
  expect(titles).toContain("Rail: Jump to conversation 1–9");
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

test("the pane shows the chords are fixed rather than apologising for it", () => {
  const html = renderToStaticMarkup(<KeybindingsPage />);
  // No control to press: a row that looked recordable and was not would be
  // worse than no pane at all — and that is the whole lesson, so the note
  // explaining which shell change rebinding would need is gone (#357).
  expect(html).not.toContain("<button");
  expect(html).not.toContain("Fixed for now");
  expect(html).not.toContain("not built yet");
});

test("search finds the pane before it has ever been opened", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  expect(first("shortcut")?.pageId).toBe("keybindings");
  expect(first("hotkey")?.pageId).toBe("keybindings");
  expect(first("keyboard shortcuts")?.pageLabel).toBe("Keybindings");
});
