"use strict";

// The shared command registry, from the shell's side of the wall.
//
// WHAT THIS PINS THAT THE WEB TESTS CANNOT: `menuCommands` is what `main.js`
// turns into an Electron menu template, and #367's whole claim is that a chord
// changed in the cockpit reaches those accelerators. The renderer never sees
// that function.
//
// Plain CommonJS with no Electron import, deliberately — the module under test
// has neither, which is what lets the real main process require it.

const { describe, expect, test } = require("bun:test");
const {
  COMMANDS,
  chordForEvent,
  defaultKeymap,
  keymapConflicts,
  keymapOverrides,
  menuCommands,
  mergeKeymap,
  normalizeChord,
  resolveCommandForEvent,
} = require("./command-keys");

describe("the registry", () => {
  test("ships no two commands on one chord", () => {
    // A collision here is a command that never fires out of the box, with
    // nothing to tell anybody why.
    expect(keymapConflicts(defaultKeymap())).toEqual({});
  });

  test("every command has an id, a label, a group and a CommandOrControl default", () => {
    for (const command of COMMANDS) {
      expect(typeof command.id).toBe("string");
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.group.length).toBeGreaterThan(0);
      expect(command.defaultChord.startsWith("CommandOrControl+")).toBe(true);
      // Every default must survive the normaliser unchanged, or the map the menu
      // is built from would differ from the table a reader is looking at.
      expect(normalizeChord(command.defaultChord)).toBe(command.defaultChord);
    }
  });

  test("only commands with a menu placement can reach a menu", () => {
    const placed = new Set([...menuCommands(defaultKeymap(), "file"), ...menuCommands(defaultKeymap(), "panel")].map((c) => c.id));
    for (const command of COMMANDS) expect(placed.has(command.id)).toBe(Boolean(command.menu));
  });
});

describe("the menu is built from the stored map, not the defaults", () => {
  test("A STORED CHORD BECOMES THE ELECTRON ACCELERATOR", () => {
    // This is the blocker the old settings copy named: the accelerators used to
    // be frozen into the table, so nothing a person stored could reach them.
    const keymap = mergeKeymap({ "new-conversation": "CommandOrControl+Alt+9" });
    const item = menuCommands(keymap, "file").find((command) => command.id === "new-conversation");
    expect(item.accelerator).toBe("CommandOrControl+Alt+9");
    expect(item.label).toBe("New Conversation");
    // Everything it did not touch still wears the registry's own answer.
    expect(menuCommands(keymap, "file").find((command) => command.id === "settings").accelerator).toBe("CommandOrControl+,");
  });

  test("a stored chord is normalised on the way to the menu", () => {
    // Electron accepts "Shift+CommandOrControl+D"; the conflict check does not,
    // so one spelling reaches both.
    const keymap = mergeKeymap({ "open-diff": "shift+cmd+d" });
    expect(menuCommands(keymap, "panel").find((command) => command.id === "open-diff").accelerator).toBe("CommandOrControl+Shift+D");
  });

  test("an unbound command keeps its row and loses only its accelerator", () => {
    // Clearing a binding should cost the key, not the command — the row is still
    // how you reach it with the mouse. (main.js spreads the accelerator
    // conditionally, because Electron rejects an empty one.)
    const keymap = mergeKeymap({ "open-diff": "" });
    const item = menuCommands(keymap, "panel").find((command) => command.id === "open-diff");
    expect(item).toBeDefined();
    expect(item.accelerator).toBe("");
  });

  test("the File menu carries the jumps and the Panel menu carries the surfaces", () => {
    const file = menuCommands(defaultKeymap(), "file");
    const panel = menuCommands(defaultKeymap(), "panel");
    expect(file.filter((command) => command.jump)).toHaveLength(9);
    expect(panel.map((command) => command.id)).toContain("open-latex");
    // A File menu that also opened a LaTeX tab would be a File menu in name.
    expect(file.map((command) => command.id)).not.toContain("open-latex");
  });
});

describe("the store round trip", () => {
  test("only what differs is kept, and a stale id is dropped", () => {
    expect(keymapOverrides(defaultKeymap())).toEqual({});
    expect(keymapOverrides(mergeKeymap({ "toggle-panel": "CommandOrControl+Alt+P" }))).toEqual({
      "toggle-panel": "CommandOrControl+Alt+P",
    });
    expect(keymapOverrides(mergeKeymap({ "open-hologram": "CommandOrControl+H" }))).toEqual({});
  });

  test("a corrupt record reads as the defaults rather than throwing", () => {
    // What `readKeybindingOverrides` leans on: a half-written file is a first
    // run, never a shell that will not start.
    expect(mergeKeymap(null)).toEqual(defaultKeymap());
    expect(mergeKeymap("nonsense")).toEqual(defaultKeymap());
    expect(mergeKeymap({ settings: 42 })).toEqual(defaultKeymap());
  });
});

describe("matching a keydown", () => {
  test("the physical key is what makes a shifted chord work", () => {
    const keymap = defaultKeymap();
    expect(resolveCommandForEvent(keymap, { key: ",", code: "Comma", metaKey: true })).toBe("settings");
    expect(resolveCommandForEvent(keymap, { key: "<", code: "Comma", metaKey: true, shiftKey: true })).toBe("search-settings");
    expect(chordForEvent({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true })).toBe("CommandOrControl+Shift+1");
  });

  test("no modifier, no match — every chord this registry ships is chorded", () => {
    expect(resolveCommandForEvent(defaultKeymap(), { key: "n", code: "KeyN" })).toBeNull();
  });
});
