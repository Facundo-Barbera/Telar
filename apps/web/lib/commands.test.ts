/** The registry's table is `apps/desktop/command-keys.js`, the same file `main.js` requires. */
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import {
  COMMANDS,
  COMMAND_GROUPS,
  bindCommands,
  chordForEvent,
  claimChords,
  claimedChords,
  claimedCommandIds,
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
  "new-conversation-in",
  "new-tab",
  "new-window",
  "focus-composer",
  "send",
  "stop-turn",
  "toggle-dictation",
  "reveal-in-finder",
  "pin-session",
  "search-sessions",
  "add-project",
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
  "toggle-devtools",
  "go-to-file",
  "search-project-contents",
  "settings",
  "search-settings",
  "appearance",
  "project-settings",
  "open-usage",
  "open-plugins",
  "check-for-updates",
];

describe("the registry is the one source of truth", () => {
  test("is the exact closed set of ids the app declares, in order", () => {
    // Checks the `CommandId` union against the plain-JS table it describes.
    expect(COMMANDS.map((command) => command.id)).toEqual(EXPECTED_IDS);
  });

  test("every default chord uses CommandOrControl, never a hardcoded Cmd or Ctrl", () => {
    // The table must work unmodified off macOS; "" means the command ships unbound.
    for (const command of COMMANDS) {
      expect(command.defaultChord === "" || command.defaultChord.startsWith("CommandOrControl+")).toBe(true);
    }
  });

  test("the commands that ship unbound are unbound, not half-bound", () => {
    const keymap = defaultKeymap();
    for (const id of ["new-conversation-in", "add-project", "appearance", "open-usage"] as CommandId[]) {
      expect(keymap[id]).toBe("");
    }
    expect(keymapOverrides(keymap)).toEqual({});
  });

  test("the palette's two panel chords are the shifted ones, because ⌘P is pinning", () => {
    const keymap = defaultKeymap();
    expect(keymap["go-to-file"]).toBe("CommandOrControl+Shift+P");
    expect(keymap["search-project-contents"]).toBe("CommandOrControl+Shift+F");
  });

  test("⌘K names the palette it opens, and keeps the id anybody's override is stored under", () => {
    // The id stays so existing ⌘K overrides on disk still apply.
    expect(COMMANDS.find((command) => command.id === "search-sessions")).toMatchObject({
      label: "Command Palette",
      defaultChord: "CommandOrControl+K",
    });
  });

  test("every command is filed under a group the pane actually draws", () => {
    for (const command of COMMANDS) expect(COMMAND_GROUPS).toContain(command.group);
  });

  test("NO TWO COMMANDS SHIP ON THE SAME CHORD", () => {
    expect(keymapConflicts(defaultKeymap())).toEqual({});
  });

  test("⌘O reveals the session's folder, and it reaches the File menu", () => {
    const reveal = COMMANDS.find((command) => command.id === "reveal-in-finder");
    expect(reveal).toMatchObject({ label: "Reveal in Finder", defaultChord: "CommandOrControl+O", menu: "file" });
    expect(defaultKeymap()["reveal-in-finder"]).toBe("CommandOrControl+O");
  });

  test("⌘P pins the conversation you are reading, and says what unpinning is called", () => {
    const pin = COMMANDS.find((command) => command.id === "pin-session");
    expect(pin).toMatchObject({
      label: "Pin Conversation",
      altLabel: "Unpin Conversation",
      group: "Conversation",
      defaultChord: "CommandOrControl+P",
      menu: "file",
    });
    expect(defaultKeymap()["pin-session"]).toBe("CommandOrControl+P");
    expect(keymapConflicts(defaultKeymap())["pin-session"]).toBeUndefined();
  });

  test("⌘D dictates, and it is a command rather than a menu row", () => {
    // No menu: dictation is off until a provider is chosen, and an inert menu row is worse.
    const dictate = COMMANDS.find((command) => command.id === "toggle-dictation");
    expect(dictate).toMatchObject({ label: "Dictate", group: "Conversation", icon: "mic", defaultChord: "CommandOrControl+D" });
    expect(dictate?.menu).toBeUndefined();
    expect(defaultKeymap()["toggle-dictation"]).toBe("CommandOrControl+D");
    // ⇧⌘D is Open Diff, a different chord.
    expect(keymapConflicts(defaultKeymap())["toggle-dictation"]).toBeUndefined();
    expect(defaultKeymap()["open-diff"]).toBe("CommandOrControl+Shift+D");
  });

  test("⌘D still fires with the caret in the message box, which is where it is pressed from", () => {
    // The composer holds focus almost always, so the focus rule must not eat this chord.
    const pressed = { metaKey: true, key: "d", code: "KeyD", target: { isContentEditable: true } };
    expect(resolveWebCommandKeyAction(defaultKeymap(), pressed)).toBe("toggle-dictation");
  });

  test("only a toggle carries an alternate label", () => {
    expect(COMMANDS.filter((command) => command.altLabel).map((command) => command.id)).toEqual(["pin-session"]);
  });

  test("only the jump commands carry a jump number, and it matches the id", () => {
    for (const command of COMMANDS) expect(command.jump).toBe(jumpNumber(command.id));
    expect(jumpCommands().map((command) => command.jump)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("a chord in canonical form", () => {
  test("modifiers sort, aliases collapse, and one key survives", () => {
    expect(normalizeChord("Shift+CommandOrControl+D")).toBe("CommandOrControl+Shift+D");
    expect(normalizeChord("cmd+alt+f")).toBe("CommandOrControl+Alt+F");
    expect(normalizeChord("Ctrl+Enter")).toBe("CommandOrControl+Return");
    expect(normalizeChord("meta+ArrowLeft")).toBe("CommandOrControl+Left");
  });

  test("a chord of nothing but modifiers is not a chord", () => {
    // "" is the deliberate unbind; ⌘ held alone must not store half a chord.
    expect(normalizeChord("CommandOrControl")).toBe("");
    expect(normalizeChord("")).toBe("");
    expect(normalizeChord("   ")).toBe("");
  });
});

describe("recording a keydown", () => {
  test("the physical key wins, which is the only way Shift is recordable", () => {
    // On a Mac ⇧1 arrives as key "!" and ⇧, as "<".
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
    const keymap = { ...defaultKeymap(), "open-diff": "", "open-editor": "", "open-data": "" } as Keymap;
    expect(keymapConflicts(keymap)).toEqual({});
  });

  test("a conflicted map still resolves deterministically, in registry order", () => {
    const keymap = { ...defaultKeymap(), "open-editor": "CommandOrControl+Shift+D" } as Keymap;
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
    const composer = { tagName: "TEXTAREA" };
    expect(resolveWebCommandKeyAction(keymap, { key: "n", code: "KeyN", metaKey: true, target: composer })).toBe("new-conversation");
  });

  test("a bare key over an editable surface is suppressed", () => {
    // Nothing shipped is bare; this is for the first bare key a person binds.
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
    expect(commandDestination("appearance", [])).toEqual({ kind: "navigate", href: "/settings?section=appearance" });
    expect(commandDestination("open-plugins", [])).toEqual({ kind: "navigate", href: "/settings?section=plugins" });
    expect(commandDestination("check-for-updates", [])).toEqual({ kind: "navigate", href: "/settings?section=updates" });
    expect(commandDestination("open-usage", [])).toEqual({ kind: "navigate", href: "/usage" });
    // The rail answers project-settings; it alone knows the current project.
    expect(commandDestination("project-settings", [])).toEqual({ kind: "noop" });
    // Panel and composer commands are bound by their components.
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
    // The dispatcher checks this first, so an armed row can record chords like ⇧⌘D.
    expect(isCapturingChord()).toBe(false);
    setChordCapture(true);
    expect(isCapturingChord()).toBe(true);
    setChordCapture(false);
    expect(isCapturingChord()).toBe(false);
  });
});

describe("a surface claiming chords (#656)", () => {
  // Claims are module state; a leaked claim would suppress the next test's ⌘1.
  test("nothing is claimed until something claims it", () => {
    expect(claimedChords()).toEqual([]);
    expect(claimedCommandIds(defaultKeymap())).toEqual([]);
  });

  test("a claim stands the colliding commands down, and releasing puts them back", () => {
    const release = claimChords(["CommandOrControl+1", "CommandOrControl+2"]);
    expect(claimedCommandIds(defaultKeymap())).toEqual(["jump-1", "jump-2"]);
    release();
    expect(claimedCommandIds(defaultKeymap())).toEqual([]);
  });

  test("nested claims are a union, and the inner one releases without taking the outer's chords", () => {
    // The command palette embeds the project palette's pages, so two claims can be live.
    const outer = claimChords(["CommandOrControl+1"]);
    const inner = claimChords(["CommandOrControl+1", "CommandOrControl+2"]);
    expect(claimedCommandIds(defaultKeymap())).toEqual(["jump-1", "jump-2"]);
    inner();
    expect(claimedCommandIds(defaultKeymap())).toEqual(["jump-1"]);
    outer();
    expect(claimedCommandIds(defaultKeymap())).toEqual([]);
  });

  test("releasing twice is not an error", () => {
    // StrictMode runs cleanup twice; a double release must not pop another claim.
    const other = claimChords(["CommandOrControl+1"]);
    const release = claimChords(["CommandOrControl+2"]);
    release();
    release();
    expect(claimedCommandIds(defaultKeymap())).toEqual(["jump-1"]);
    other();
    expect(claimedChords()).toEqual([]);
  });

  test("two surfaces claiming the same chord are two claims", () => {
    const first = claimChords(["CommandOrControl+1"]);
    const second = claimChords(["CommandOrControl+1"]);
    first();
    expect(claimedCommandIds(defaultKeymap())).toEqual(["jump-1"]);
    second();
    expect(claimedCommandIds(defaultKeymap())).toEqual([]);
  });

  test("the claim is canonical, so a surface may spell its chords loosely", () => {
    const release = claimChords(["cmd+1"]);
    expect(claimedChords()).toEqual(["CommandOrControl+1"]);
    release();
  });
});

describe("the handler binding point", () => {
  beforeEach(() => {
    // The bus is module state; this guards against a test leaking a binding.
    for (const command of COMMANDS) expect(commandHandler(command.id)).toBeUndefined();
  });

  test("a command nobody has bound does nothing, and says so", () => {
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
