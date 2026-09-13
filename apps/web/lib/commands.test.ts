/**
 * The command registry, pinned end to end: the shared table (imported from
 * `apps/desktop/command-keys.js` — the same physical file `main.js` requires, so
 * this exercises the real cross-app import rather than a copy of it), the chord
 * arithmetic the settings pane records with, the conflict rule, and the handler
 * bus that lets a component say what a command means.
 *
 * WHAT THIS WOULD HAVE CAUGHT: a default table that ships two commands on one
 * chord — which is the failure a registry of twenty-seven bindings has and a
 * table of twelve did not, and the one nobody would notice until the second
 * command silently stopped working.
 */
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import {
  COMMANDS,
  COMMAND_GROUPS,
  bindCommands,
  chordForEvent,
  commandHandler,
  defaultKeymap,
  isCapturingChord,
  jumpCommands,
  jumpNumber,
  keymapConflicts,
  keymapOverrides,
  mergeKeymap,
  normalizeChord,
  runCommand,
  setChordCapture,
  type CommandId,
  type Keymap,
} from "./commands";
import { commandDestination, isEditableTarget, resolveWebCommandKeyAction } from "./command-keys";

const EXPECTED_IDS: CommandId[] = [
  "new-conversation",
  "new-tab",
  "new-window",
  "focus-composer",
  "send",
  "stop-turn",
  "reveal-in-finder",
  "pin-session",
  "search-sessions",
  "toggle-rail",
  "jump-1",
  "jump-2",
  "jump-3",
  "jump-4",
  "jump-5",
  "jump-6",
  "jump-7",
  "jump-8",
  "jump-9",
  "toggle-panel",
  "panel-next-tab",
  "panel-previous-tab",
  "panel-fullscreen",
  "open-diff",
  "open-editor",
  "open-data",
  "open-latex",
  "settings",
  "search-settings",
];

describe("the registry is the one source of truth", () => {
  test("is the exact closed set of ids the app declares, in order", () => {
    // THE CLOSED-LIST GUARD: the one place TypeScript's `CommandId` union is
    // checked against the plain-JS table it describes. Add a command to
    // command-keys.js without updating both, and this fails.
    expect(COMMANDS.map((command) => command.id)).toEqual(EXPECTED_IDS);
  });

  test("every default chord uses CommandOrControl, never a hardcoded Cmd or Ctrl", () => {
    // The same table has to work unmodified on a Windows or Linux build.
    for (const command of COMMANDS) expect(command.defaultChord.startsWith("CommandOrControl+")).toBe(true);
  });

  test("every command is filed under a group the pane actually draws", () => {
    for (const command of COMMANDS) expect(COMMAND_GROUPS).toContain(command.group);
  });

  test("NO TWO COMMANDS SHIP ON THE SAME CHORD", () => {
    // The whole point of the conflict machinery is that a person CAN create a
    // collision; shipping one is a different thing entirely — a command that
    // never fires out of the box, and nothing to tell anybody why.
    expect(keymapConflicts(defaultKeymap())).toEqual({});
  });

  test("⌘O reveals the session's folder, and it reaches the File menu", () => {
    // #384: the Open menu's last row from the keyboard. It has to be in the
    // registry for Settings › Keybindings to draw a row for it at all, and to
    // carry `menu: "file"` for the shell to build an accelerator.
    const reveal = COMMANDS.find((command) => command.id === "reveal-in-finder");
    expect(reveal).toMatchObject({ label: "Reveal in Finder", defaultChord: "CommandOrControl+O", menu: "file" });
    expect(defaultKeymap()["reveal-in-finder"]).toBe("CommandOrControl+O");
  });

  test("⌘P pins the conversation you are reading, and says what unpinning is called", () => {
    // #408. The chord has to be in the registry for Settings › Keybindings to
    // draw a row at all, and `altLabel` is what lets a surface that KNOWS the
    // session's state name the other half of the toggle without inventing a
    // second command id for it.
    const pin = COMMANDS.find((command) => command.id === "pin-session");
    expect(pin).toMatchObject({
      label: "Pin Conversation",
      altLabel: "Unpin Conversation",
      group: "Conversation",
      defaultChord: "CommandOrControl+P",
      menu: "file",
    });
    expect(defaultKeymap()["pin-session"]).toBe("CommandOrControl+P");
    // And it is nobody else's chord — the guard above proves the table as a
    // whole, this names the collision #408 was warned about (#402's go-to-file).
    expect(keymapConflicts(defaultKeymap())["pin-session"]).toBeUndefined();
  });

  test("only a toggle carries an alternate label", () => {
    // A second name for a command that cannot undo itself would be a name
    // nothing could ever correctly show.
    expect(COMMANDS.filter((command) => command.altLabel).map((command) => command.id)).toEqual(["pin-session"]);
  });

  test("only the jump commands carry a jump number, and it matches the id", () => {
    for (const command of COMMANDS) expect(command.jump).toBe(jumpNumber(command.id));
    expect(jumpCommands().map((command) => command.jump)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("a chord in canonical form", () => {
  test("modifiers sort, aliases collapse, and one key survives", () => {
    // Two spellings of one chord must compare equal or the conflict check is a
    // conflict check in name only.
    expect(normalizeChord("Shift+CommandOrControl+D")).toBe("CommandOrControl+Shift+D");
    expect(normalizeChord("cmd+alt+f")).toBe("CommandOrControl+Alt+F");
    expect(normalizeChord("Ctrl+Enter")).toBe("CommandOrControl+Return");
    expect(normalizeChord("meta+ArrowLeft")).toBe("CommandOrControl+Left");
  });

  test("a chord of nothing but modifiers is not a chord", () => {
    // "" is the deliberate UNBIND, and the recorder leans on it: ⌘ held down on
    // its own must leave the row waiting rather than storing half a chord.
    expect(normalizeChord("CommandOrControl")).toBe("");
    expect(normalizeChord("")).toBe("");
    expect(normalizeChord("   ")).toBe("");
  });
});

describe("recording a keydown", () => {
  test("the physical key wins, which is the only way Shift is recordable", () => {
    // On a Mac ⇧1 arrives as key "!" and ⇧, as "<". A keymap full of those would
    // neither read back as ⇧1 nor match the next press of it.
    expect(chordForEvent({ key: "!", code: "Digit1", metaKey: true, shiftKey: true })).toBe("CommandOrControl+Shift+1");
    expect(chordForEvent({ key: "<", code: "Comma", metaKey: true, shiftKey: true })).toBe("CommandOrControl+Shift+,");
    expect(chordForEvent({ key: "d", code: "KeyD", metaKey: true })).toBe("CommandOrControl+D");
  });

  test("a bare modifier press records nothing", () => {
    expect(chordForEvent({ key: "Meta", code: "MetaLeft", metaKey: true })).toBe("");
    expect(chordForEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true })).toBe("");
  });
});

describe("the keymap", () => {
  test("defaults, with a person's overrides laid over them", () => {
    const keymap = mergeKeymap({ "open-diff": "CommandOrControl+Shift+9" });
    expect(keymap["open-diff"]).toBe("CommandOrControl+Shift+9");
    expect(keymap["new-conversation"]).toBe("CommandOrControl+N");
  });

  test("overrides stay sparse, so a default this app improves still reaches you", () => {
    // Storing the whole resolved map would freeze today's answers into every
    // install that ever opened the pane.
    const keymap = { ...defaultKeymap(), "toggle-rail": "CommandOrControl+Alt+B" } as Keymap;
    expect(keymapOverrides(keymap)).toEqual({ "toggle-rail": "CommandOrControl+Alt+B" });
    expect(keymapOverrides(defaultKeymap())).toEqual({});
  });

  test("a stored record naming a command that no longer exists is dropped, not carried", () => {
    const keymap = mergeKeymap({ "open-hologram": "CommandOrControl+H" } as never);
    expect("open-hologram" in keymap).toBe(false);
    expect(keymapOverrides(keymap)).toEqual({});
  });

  test("an unbind survives the round trip; a corrupt value falls back to the default", () => {
    expect(mergeKeymap({ "search-sessions": "" })["search-sessions"]).toBe("");
    expect(keymapOverrides(mergeKeymap({ "search-sessions": "" }))).toEqual({ "search-sessions": "" });
    expect(mergeKeymap({ "search-sessions": null } as never)["search-sessions"]).toBe("CommandOrControl+K");
  });
});

describe("conflicts", () => {
  test("two commands on one chord name each other, both ways", () => {
    const keymap = { ...defaultKeymap(), "open-editor": defaultKeymap()["open-diff"] } as Keymap;
    const conflicts = keymapConflicts(keymap);
    expect(conflicts["open-diff"]).toEqual(["open-editor"]);
    expect(conflicts["open-editor"]).toEqual(["open-diff"]);
  });

  test("a spelling difference is not a difference", () => {
    const keymap = { ...defaultKeymap(), "open-editor": "Shift+CommandOrControl+D" } as Keymap;
    expect(keymapConflicts(keymap)["open-diff"]).toEqual(["open-editor"]);
  });

  test("unbound commands do not collide with each other", () => {
    // Nine cleared rows reported as a nine-way conflict would be the pane crying
    // wolf about the one state a person reaches by deliberately clearing them.
    const keymap = { ...defaultKeymap(), "open-diff": "", "open-editor": "", "open-data": "" } as Keymap;
    expect(keymapConflicts(keymap)).toEqual({});
  });

  test("a conflicted map still resolves deterministically, in registry order", () => {
    const keymap = { ...defaultKeymap(), "open-editor": "CommandOrControl+Shift+D" } as Keymap;
    // "open-diff" is declared first, so it wins — every time, not by object order.
    expect(resolveWebCommandKeyAction(keymap, { key: "D", code: "KeyD", metaKey: true, shiftKey: true })).toBe("open-diff");
  });
});

describe("matching a keydown against the live map", () => {
  const keymap = defaultKeymap();

  test("a rebind is live immediately — the whole point of #367", () => {
    const rebound = mergeKeymap({ "new-conversation": "CommandOrControl+Alt+9" });
    expect(resolveWebCommandKeyAction(rebound, { key: "n", code: "KeyN", metaKey: true })).toBeNull();
    expect(resolveWebCommandKeyAction(rebound, { key: "9", code: "Digit9", metaKey: true, altKey: true })).toBe("new-conversation");
  });

  test("an unbound command matches nothing at all", () => {
    const cleared = mergeKeymap({ "search-sessions": "" });
    expect(resolveWebCommandKeyAction(cleared, { key: "k", code: "KeyK", metaKey: true })).toBeNull();
  });

  test("Shift is part of the chord, so ⌘, and ⇧⌘, are two different commands", () => {
    expect(resolveWebCommandKeyAction(keymap, { key: ",", code: "Comma", metaKey: true })).toBe("settings");
    expect(resolveWebCommandKeyAction(keymap, { key: "<", code: "Comma", metaKey: true, shiftKey: true })).toBe("search-settings");
  });

  test("a chord fires from inside a text field, which is the whole point of a chord", () => {
    // The composer holds focus nearly all the time here. A rule that suppressed
    // chords would leave the registry with no state in which it could ever fire.
    const composer = { tagName: "TEXTAREA" };
    expect(resolveWebCommandKeyAction(keymap, { key: "n", code: "KeyN", metaKey: true, target: composer })).toBe("new-conversation");
  });

  test("a bare key over an editable surface is suppressed", () => {
    // Nothing in the shipped registry is bare, so this suppresses nothing yet.
    // It is here for the first one a person binds: a naked "n" over a field must
    // keep typing an "n".
    const bare = mergeKeymap({ "new-conversation": "N" });
    expect(resolveWebCommandKeyAction(bare, { key: "n", code: "KeyN", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(resolveWebCommandKeyAction(bare, { key: "n", code: "KeyN", target: { tagName: "DIV" } })).toBe("new-conversation");
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("what a command means here", () => {
  test("the pure-navigation commands have a destination and the rest do not", () => {
    expect(commandDestination("new-conversation", [])).toEqual({ kind: "navigate", href: "/" });
    expect(commandDestination("new-tab", [])).toEqual({ kind: "open-tab", href: "/" });
    expect(commandDestination("new-window", [])).toEqual({ kind: "open-window", href: "/" });
    expect(commandDestination("settings", [])).toEqual({ kind: "navigate", href: "/settings" });
    // The panel and the composer are components' own state; a destination table
    // could not name them, so they answer `noop` and bind themselves instead.
    expect(commandDestination("panel-fullscreen", [])).toEqual({ kind: "noop" });
    expect(commandDestination("send", [])).toEqual({ kind: "noop" });
  });

  test("a jump past the end of the list does nothing rather than something wrong", () => {
    expect(commandDestination("jump-1", ["/a"])).toEqual({ kind: "navigate", href: "/a" });
    expect(commandDestination("jump-2", ["/a"])).toEqual({ kind: "noop" });
    expect(commandDestination("jump-3", ["/a", undefined, "/c"])).toEqual({ kind: "navigate", href: "/c" });
  });
});

describe("recording suppresses everything else", () => {
  test("the flag is off unless a row says otherwise, and toggles both ways", () => {
    // The dispatcher reads this before matching anything: press ⇧⌘D over an
    // armed row and "Open Diff" must NOT fire, or the pane cannot record the
    // chords a person most wants to change. (The shell's half — dropping the
    // menu's accelerators — is pinned in apps/desktop.)
    expect(isCapturingChord()).toBe(false);
    setChordCapture(true);
    expect(isCapturingChord()).toBe(true);
    setChordCapture(false);
    expect(isCapturingChord()).toBe(false);
  });
});

describe("the handler binding point", () => {
  beforeEach(() => {
    // The bus is module state, so a test that leaked a binding would decide the
    // next one's answer. Every case below releases what it took; this is the
    // guard that says so out loud rather than hoping.
    for (const command of COMMANDS) expect(commandHandler(command.id)).toBeUndefined();
  });

  test("a command nobody has bound does nothing, and says so", () => {
    // Not an error, deliberately: ⌘⌥F means nothing on the projects list, and a
    // key that beeped on every route but one would be worse than one that waits.
    expect(runCommand("panel-fullscreen")).toBe(false);
  });

  test("the bound handler runs, and unbinding really unbinds", () => {
    let ran = 0;
    const release = bindCommands({ "panel-fullscreen": () => (ran += 1) });
    expect(runCommand("panel-fullscreen")).toBe(true);
    expect(ran).toBe(1);
    release();
    expect(runCommand("panel-fullscreen")).toBe(false);
    expect(ran).toBe(1);
  });

  test("the newest binder wins, and unbinding it restores whoever was underneath", () => {
    // Two Editors, or a cockpit and the panel inside it, may both claim a
    // command; the one on top gets it and the stack survives its unmount.
    const ran: string[] = [];
    const outer = bindCommands({ send: () => ran.push("outer") });
    const inner = bindCommands({ send: () => ran.push("inner") });
    runCommand("send");
    inner();
    runCommand("send");
    outer();
    expect(ran).toEqual(["inner", "outer"]);
    expect(runCommand("send")).toBe(false);
  });
});
