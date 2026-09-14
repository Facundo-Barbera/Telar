// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMANDS, defaultKeymap, mergeKeymap, type Command, type Keymap } from "@/lib/commands";
// The formatter moved out of the pane in #401 — every control bound to a chord
// draws its caps now, so a settings page is not where they can live.
import { keyCaps } from "@/lib/key-caps";
import { searchSettings } from "@/lib/settings-search";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { KeybindingsPage, jumpChordsFrom, keybindingRows, recordedChord } from "./keybindings-page";

/**
 * THE PANE IS A VIEW OF THE REGISTRY, so what has to be true is that it stays
 * one: a command added to `apps/desktop/command-keys.js` must appear here
 * without anybody editing this directory, none of them may render as the raw
 * accelerator string the Electron menu wants, and — since #367 — every row has
 * to be pressable, because a row that looked recordable and was not would be
 * worse than no pane at all.
 */

const rowsWith = (keymap: Keymap = defaultKeymap()) => keybindingRows("mac", keymap);

test("every command in the registry is accounted for, derived rather than listed", () => {
  const rows = rowsWith();
  const jumps = COMMANDS.filter((command) => command.jump);
  // The nine jumps fold into one row; everything else is still one row each.
  expect(rows).toHaveLength(COMMANDS.length - jumps.length + 1);
  const singles = COMMANDS.filter((command) => !command.jump).map((command) => command.id);
  expect(rows.map((row) => row.id).sort()).toEqual([...singles, "jump"].sort());
  // Every row files under a group the pane draws, or it would render nowhere.
  for (const row of rows) expect(["Conversation", "Rail", "Panel", "Application"]).toContain(row.group);
});

test("the nine jumps are one row carrying the whole range", () => {
  // Nine near-identical rows were three quarters of this pane saying one thing.
  const jump = rowsWith().find((row) => row.id === "jump");
  expect(jump?.title).toBe("Jump to conversation 1–9");
  expect(jump?.caps).toEqual(["⌘", "1"]);
  expect(jump?.through).toEqual(["⌘", "9"]);
  // And the row rebinds all nine, which is what makes the fold honest.
  expect(jump?.commandIds).toHaveLength(9);
});

test("the range is read off the registry, not hardcoded", () => {
  // A tenth slot must widen the row rather than go unlisted, and a registry with
  // one jump has no range to fold.
  const table: Command[] = [
    // `icon` is carried because the registry's type requires one; this pane
    // pointedly ignores it — a keybindings row is a chord, not a glyph.
    { id: "jump-1" as never, label: "Jump 1", group: "Rail", icon: "hash", defaultChord: "CommandOrControl+1", jump: 1 },
    { id: "jump-2" as never, label: "Jump 2", group: "Rail", icon: "hash", defaultChord: "CommandOrControl+2", jump: 2 },
  ];
  const keymap = { "jump-1": "CommandOrControl+1", "jump-2": "CommandOrControl+2" } as Keymap;
  expect(keybindingRows("mac", keymap, table)[0]?.title).toBe("Jump to conversation 1–2");
  const lone = keybindingRows("mac", keymap, [table[0]!]);
  expect(lone).toHaveLength(1);
  expect(lone[0]?.id).toBe("jump-1");
  expect(lone[0]?.through).toBeUndefined();
});

test("the chord is split into one cap per key, in the platform's own register", () => {
  expect(keyCaps("CommandOrControl+N", "mac")).toEqual(["⌘", "N"]);
  expect(keyCaps("CommandOrControl+N", "other")).toEqual(["Ctrl", "N"]);
  // CommandOrControl is the whole reason the registry works off a Mac (issue
  // #16), so the caps have to answer to it rather than hardcoding one platform.
  expect(keyCaps("CommandOrControl+,", "mac")).toEqual(["⌘", ","]);
  expect(keyCaps("CommandOrControl+Shift+1", "mac")).toEqual(["⌘", "⇧", "1"]);
  // The keys with a glyph on the keyboard get the glyph.
  expect(keyCaps("CommandOrControl+Return", "mac")).toEqual(["⌘", "↩"]);
  expect(keyCaps("CommandOrControl+Alt+Left", "mac")).toEqual(["⌘", "⌥", "←"]);
  // An unbound command has no caps at all — the row draws "Unbound" instead.
  expect(keyCaps("", "mac")).toEqual([]);
});

test("rows read in this app's vocabulary, not the Electron menu's", () => {
  const titles = rowsWith().map((row) => row.title);
  expect(titles).toContain("New Conversation");
  expect(titles).toContain("Jump to conversation 1–9");
  // The menu's trailing ellipsis is a menu-item convention and names nothing on
  // a settings row.
  expect(titles).toContain("Settings");
  expect(titles.some((title) => title.endsWith("…"))).toBe(false);
  // "File" is the Electron menu's grouping and names nothing in a browser tab.
  expect(titles.some((title) => title.startsWith("File:"))).toBe(false);
});

test("a conflicted map flags both rows, by the other one's name", () => {
  // Two commands on one chord is a state the store can hold — refusing the first
  // half of a swap is how a rebinding UI becomes unusable — so the pane's job is
  // to say so rather than to prevent it.
  const keymap = mergeKeymap({ "open-editor": "CommandOrControl+Shift+D" });
  const rows = rowsWith(keymap);
  expect(rows.find((row) => row.id === "open-diff")?.conflicts).toEqual(["Open Editor"]);
  expect(rows.find((row) => row.id === "open-editor")?.conflicts).toEqual(["Open Diff"]);
  // A clean map flags nothing.
  for (const row of rowsWith()) expect(row.conflicts).toEqual([]);
});

test("a clash inside the folded range surfaces on the one row that draws it", () => {
  // ⌘3 colliding with something has nowhere else to be said.
  const keymap = mergeKeymap({ "open-diff": "CommandOrControl+3" });
  expect(rowsWith(keymap).find((row) => row.id === "jump")?.conflicts).toEqual(["Open Diff"]);
});

test("a row knows whether it has been moved, which is what offers the revert", () => {
  expect(rowsWith().every((row) => !row.changed)).toBe(true);
  const keymap = mergeKeymap({ "toggle-rail": "CommandOrControl+Alt+B" });
  expect(rowsWith(keymap).find((row) => row.id === "toggle-rail")?.changed).toBe(true);
  // Moving any one slot marks the whole folded row, or the fold would hide it.
  expect(rowsWith(mergeKeymap({ "jump-4": "CommandOrControl+Alt+4" })).find((row) => row.id === "jump")?.changed).toBe(true);
});

test("the recorder reads a press, and keeps an exit", () => {
  expect(recordedChord({ key: "d", code: "KeyD", metaKey: true, shiftKey: true })).toEqual({
    kind: "chord",
    chord: "CommandOrControl+Shift+D",
  });
  // A recorder that swallowed bare Escape would have no way out; Backspace is
  // how "no chord" gets said, because unbinding is a real answer.
  expect(recordedChord({ key: "Escape" })).toEqual({ kind: "cancel" });
  expect(recordedChord({ key: "Backspace" })).toEqual({ kind: "clear" });
  // Escape is not lost to the registry — only its unmodified press.
  expect(recordedChord({ key: "Escape", code: "Escape", metaKey: true })).toEqual({ kind: "chord", chord: "CommandOrControl+Escape" });
  // ⌘ held on its own leaves the row waiting rather than storing half a chord.
  expect(recordedChord({ key: "Meta", code: "MetaLeft", metaKey: true })).toEqual({ kind: "waiting" });
});

test("recording the folded row moves all nine together, or not at all", () => {
  const slots = COMMANDS.filter((command) => command.jump);
  const chords = jumpChordsFrom("CommandOrControl+Alt+4", slots);
  expect(chords?.["jump-1"]).toBe("CommandOrControl+Alt+1");
  expect(chords?.["jump-9"]).toBe("CommandOrControl+Alt+9");
  expect(Object.keys(chords ?? {})).toHaveLength(9);
  // A chord that does not end in a digit cannot become nine bindings — the row
  // rejects it rather than binding ⌘⌥K to "jump to conversation 1".
  expect(jumpChordsFrom("CommandOrControl+Alt+K", slots)).toBeNull();
});

test("the pane draws each chord as a pressable key cap", () => {
  const html = renderToStaticMarkup(<KeybindingsPage />);
  expect(html).toContain("New Conversation");
  // Caps, not a string: "⌘ N" in one box reads as a key called "⌘ N".
  expect(html).toContain("<kbd");
  // And never the accelerator the Electron menu is built from.
  expect(html).not.toContain("CommandOrControl");
  // #367's whole point: every row is a control now. The pane used to say the
  // chords were fixed by having nothing to press.
  expect(html).toContain("<button");
  expect(html).toContain("Change the chord for New Conversation");
  expect(html).not.toContain("not built yet");
});

test("the pane groups the rows the way a person meets them", () => {
  const html = renderToStaticMarkup(<KeybindingsPage />);
  for (const group of ["Conversation", "Rail", "Panel", "Application"]) expect(html).toContain(group);
  // Conversation before Application: the order is the app's, not the alphabet's.
  expect(html.indexOf("Conversation")).toBeLessThan(html.indexOf("Application"));
});

test("search finds the pane before it has ever been opened", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  expect(first("shortcut")?.pageId).toBe("keybindings");
  expect(first("hotkey")?.pageId).toBe("keybindings");
  expect(first("keyboard shortcuts")?.pageLabel).toBe("Keybindings");
});
