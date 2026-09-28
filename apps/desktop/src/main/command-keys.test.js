"use strict";

const { describe, expect, test } = require("bun:test");
const {
  COMMANDS,
  chordForEvent,
  claimedCommandIds,
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
    expect(keymapConflicts(defaultKeymap())).toEqual({});
  });

  test("every command has an id, a label, a group and a CommandOrControl default", () => {
    for (const command of COMMANDS) {
      expect(typeof command.id).toBe("string");
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.group.length).toBeGreaterThan(0);

      expect(command.defaultChord === "" || command.defaultChord.startsWith("CommandOrControl+")).toBe(true);

      expect(normalizeChord(command.defaultChord)).toBe(command.defaultChord);
    }
  });

  test("every command names its own glyph, as a lucide NAME and never a component", () => {
    for (const command of COMMANDS) {
      expect(typeof command.icon).toBe("string");

      expect(command.icon).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  test("an unbound command reaches no menu with an accelerator of nothing", () => {
    const unbound = COMMANDS.filter((command) => command.defaultChord === "");
    expect(unbound.length).toBeGreaterThan(0);
    for (const command of unbound) expect(command.menu).toBeUndefined();
  });

  test("only commands with a menu placement can reach a menu", () => {
    const placed = new Set(
      ["file", "panel", "view"].flatMap((menu) => menuCommands(defaultKeymap(), menu)).map((c) => c.id),
    );
    for (const command of COMMANDS) expect(placed.has(command.id)).toBe(Boolean(command.menu));
  });
});

describe("the menu is built from the stored map, not the defaults", () => {
  test("A STORED CHORD BECOMES THE ELECTRON ACCELERATOR", () => {
    const keymap = mergeKeymap({ "new-conversation": "CommandOrControl+Alt+9" });
    const item = menuCommands(keymap, "file").find((command) => command.id === "new-conversation");
    expect(item.accelerator).toBe("CommandOrControl+Alt+9");
    expect(item.label).toBe("New Conversation");

    expect(menuCommands(keymap, "file").find((command) => command.id === "settings").accelerator).toBe("CommandOrControl+,");
  });

  test("a stored chord is normalised on the way to the menu", () => {
    const keymap = mergeKeymap({ "open-diff": "shift+cmd+d" });
    expect(menuCommands(keymap, "panel").find((command) => command.id === "open-diff").accelerator).toBe("CommandOrControl+Shift+D");
  });

  test("an unbound command keeps its row and loses only its accelerator", () => {
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

    expect(file.map((command) => command.id)).not.toContain("open-latex");
  });

  test("Developer Tools is a View menu row on ⌥⌘I, and reaches no other menu", () => {
    const item = menuCommands(defaultKeymap(), "view").find((command) => command.id === "toggle-devtools");
    expect(item).toMatchObject({ label: "Developer Tools", accelerator: "CommandOrControl+Alt+I" });
    for (const menu of ["file", "panel"]) {
      expect(menuCommands(defaultKeymap(), menu).map((command) => command.id)).not.toContain("toggle-devtools");
    }
  });

  test("Reveal in Finder is a File menu row with ⌘O on it", () => {
    const item = menuCommands(defaultKeymap(), "file").find((command) => command.id === "reveal-in-finder");
    expect(item).toMatchObject({ label: "Reveal in Finder", accelerator: "CommandOrControl+O" });
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

describe("a surface claiming chords (#656)", () => {
  test("claiming ⌘1..⌘9 takes the nine jumps, and nothing else, off the table", () => {
    const claimed = claimedCommandIds(defaultKeymap(), ["CommandOrControl+1", "CommandOrControl+2", "CommandOrControl+3"]);
    expect(claimed).toEqual(["jump-1", "jump-2", "jump-3"]);

    expect(claimed).not.toContain("new-conversation");
  });

  test("a rebind hands the chord back rather than leaving the palette suppressed", () => {
    const moved = mergeKeymap(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`jump-${index + 1}`, `Alt+${index + 1}`])));
    expect(claimedCommandIds(moved, ["CommandOrControl+1"])).toEqual([]);
    expect(claimedCommandIds(moved, ["Alt+1"])).toEqual(["jump-1"]);
  });

  test("it follows the chord onto whatever command moved there", () => {
    const moved = mergeKeymap({ "jump-1": "Alt+1", "toggle-rail": "CommandOrControl+1" });
    expect(claimedCommandIds(moved, ["CommandOrControl+1"])).toEqual(["toggle-rail"]);
  });

  test("an unbound command is never claimed, whatever the claim says", () => {
    expect(claimedCommandIds(mergeKeymap({ "jump-1": "" }), ["", "CommandOrControl+1"])).toEqual([]);
  });

  test("no claim suppresses nothing, which is the state the app spends its life in", () => {
    expect(claimedCommandIds(defaultKeymap(), [])).toEqual([]);
    expect(claimedCommandIds(defaultKeymap(), undefined)).toEqual([]);
  });

  test("a chord is matched however it was spelled", () => {
    expect(claimedCommandIds(defaultKeymap(), ["cmd+1"])).toEqual(["jump-1"]);
    expect(claimedCommandIds(defaultKeymap(), ["Ctrl+Digit1"])).toEqual(["jump-1"]);
  });
});
