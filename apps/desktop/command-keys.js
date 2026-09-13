"use strict";

// THE COMMAND REGISTRY, and the chord arithmetic around it (issues #16, #367).
//
// Both halves of the app read this exact array — main.js requires it directly
// to build the Electron menu's native accelerators, and apps/web/lib/commands.ts
// imports it by relative path (see the long comment there for why a relative
// cross-app import, rather than a packages/* workspace dependency, is the
// deliberate choice). Nothing in this file may depend on Electron, Node, or the
// DOM: main.js reads `label`/`menu` to build menu items, the web renderer reads
// the chord functions to match a KeyboardEvent, and anything platform-specific
// (the focus rule, routing, window management) belongs on whichever side
// actually has that context.
//
// Plain CommonJS, zero dependencies, on purpose: this is required at runtime by
// Electron's REAL main process (a real Node runtime with no TypeScript support
// and no bundler), so it has to already be valid, dependency-free JavaScript —
// not source that needs a build step to become that.
//
// WHAT #367 CHANGED. A binding used to be one immovable row: `accelerator` was
// the chord, full stop, and the settings pane could only read it out. Now the
// registry carries a DEFAULT chord and the live chord comes from a KEYMAP — a
// plain `{ [commandId]: chord }` object the cockpit stores and the shell mirrors
// — so `buildApplicationMenu` can be handed a new map and rebuild its
// accelerators, which is exactly the blocker the old settings copy named.

/**
 * @typedef {Object} Command
 * @property {string} id - stable action id the renderer dispatches on.
 * @property {string} label - human-readable name; doubles as the Electron menu
 *   item's label where the command has one.
 * @property {string} group - which heading the settings pane files it under.
 *   The cockpit's vocabulary, not the menu's: "Conversation", "Rail", "Panel",
 *   "Application".
 * @property {string} defaultChord - an Electron accelerator string. Always
 *   "CommandOrControl+…", never a hardcoded "Cmd" or "Ctrl" — issue #16 asks for
 *   CommandOrControl semantics explicitly so the same table works unmodified on
 *   macOS today and on a Windows/Linux build later.
 * @property {string} [altLabel] - what this command is called when it would
 *   UNDO itself. Only a toggle has one ("Pin Conversation" / "Unpin
 *   Conversation"), and `label` remains the command's name everywhere state is
 *   not known — the settings pane lists one row per command, not one per state,
 *   and a keybindings page that renamed itself as you worked would be lying
 *   about what it binds.
 * @property {"file"|"panel"} [menu] - which application menu carries it. Absent
 *   means the command has no menu item at all and is dispatched by the
 *   renderer's own keydown listener, which is where every contextual command
 *   (send, stop, focus the composer) belongs: a menu row that is inert on every
 *   route but one is worse than no row.
 * @property {number} [jump] - for a "jump to Nth recent conversation" command,
 *   which N (1-9). Absent on every other command.
 */

/** @type {Command[]} */
const COMMANDS = [
  { id: "new-conversation", label: "New Conversation", group: "Conversation", defaultChord: "CommandOrControl+N", menu: "file" },
  { id: "new-tab", label: "New Tab", group: "Conversation", defaultChord: "CommandOrControl+T", menu: "file" },
  { id: "new-window", label: "New Window", group: "Conversation", defaultChord: "CommandOrControl+Shift+N", menu: "file" },
  { id: "focus-composer", label: "Focus Composer", group: "Conversation", defaultChord: "CommandOrControl+L" },
  { id: "send", label: "Send", group: "Conversation", defaultChord: "CommandOrControl+Return" },
  { id: "stop-turn", label: "Stop Turn", group: "Conversation", defaultChord: "CommandOrControl+." },
  // The session's workspace folder, shown in Finder (#384) — the same verb the
  // header's Open menu carries, from the keyboard. `menu: "file"` because it is
  // about a folder on disk, which is what a File menu is for; the handler lives
  // with the bridge, in components/session/open-workspace-button.tsx.
  { id: "reveal-in-finder", label: "Reveal in Finder", group: "Conversation", defaultChord: "CommandOrControl+O", menu: "file" },
  // Pin or unpin the conversation you are LOOKING AT (#408) — the same verb the
  // session menu's Pin row performs, from the keyboard. One command with two
  // names rather than two commands: a person binds "pin this", and which of the
  // two things that means is the session's state, never a second chord to
  // learn. `menu: "file"` for the same reason Reveal in Finder is there — it is
  // about the conversation as a thing you keep, not about the panel.
  { id: "pin-session", label: "Pin Conversation", altLabel: "Unpin Conversation", group: "Conversation", defaultChord: "CommandOrControl+P", menu: "file" },

  { id: "search-sessions", label: "Search Conversations", group: "Rail", defaultChord: "CommandOrControl+K" },
  { id: "toggle-rail", label: "Toggle Rail", group: "Rail", defaultChord: "CommandOrControl+B" },
  // jump-1..jump-9: the Nth conversation in the rail, top to bottom as drawn.
  // Generated, not hand-written nine times — see railRowsForCommandKeys in
  // apps/web/lib/session-groups.ts for exactly which rows count.
  ...Array.from({ length: 9 }, (_, index) => {
    const n = index + 1;
    return {
      id: `jump-${n}`,
      label: `Jump to Conversation ${n}`,
      group: "Rail",
      defaultChord: `CommandOrControl+${n}`,
      menu: "file",
      jump: n,
    };
  }),

  { id: "toggle-panel", label: "Toggle Right Panel", group: "Panel", defaultChord: "CommandOrControl+\\", menu: "panel" },
  { id: "panel-next-tab", label: "Next Panel Tab", group: "Panel", defaultChord: "CommandOrControl+Alt+Right", menu: "panel" },
  { id: "panel-previous-tab", label: "Previous Panel Tab", group: "Panel", defaultChord: "CommandOrControl+Alt+Left", menu: "panel" },
  { id: "panel-fullscreen", label: "Fill the Window", group: "Panel", defaultChord: "CommandOrControl+Alt+F", menu: "panel" },
  { id: "open-diff", label: "Open Diff", group: "Panel", defaultChord: "CommandOrControl+Shift+D", menu: "panel" },
  { id: "open-editor", label: "Open Editor", group: "Panel", defaultChord: "CommandOrControl+Shift+E", menu: "panel" },
  { id: "open-data", label: "Open Data", group: "Panel", defaultChord: "CommandOrControl+Shift+B", menu: "panel" },
  { id: "open-latex", label: "Open LaTeX", group: "Panel", defaultChord: "CommandOrControl+Shift+X", menu: "panel" },

  { id: "settings", label: "Settings…", group: "Application", defaultChord: "CommandOrControl+,", menu: "file" },
  { id: "search-settings", label: "Search Settings…", group: "Application", defaultChord: "CommandOrControl+Shift+,", menu: "file" },
];

/** The order modifiers are written in, so two spellings of one chord compare
 *  equal. Electron accepts any order; a keymap that stored both
 *  "Shift+CommandOrControl+D" and "CommandOrControl+Shift+D" would report a
 *  conflict as no conflict at all. */
const MODIFIER_ORDER = ["CommandOrControl", "Alt", "Shift"];

/** Every spelling a modifier arrives in — from a stored map a human edited by
 *  hand, from the table above, or built out of a KeyboardEvent. */
const MODIFIER_ALIASES = {
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  command: "CommandOrControl",
  cmd: "CommandOrControl",
  meta: "CommandOrControl",
  super: "CommandOrControl",
  control: "CommandOrControl",
  ctrl: "CommandOrControl",
  alt: "Alt",
  option: "Alt",
  altgr: "Alt",
  shift: "Shift",
};

/** `KeyboardEvent.key` / `KeyboardEvent.code` spellings, as the accelerator
 *  token Electron wants. Only the keys that differ need an entry; a single
 *  character is upper-cased and everything else is passed through. */
const KEY_ALIASES = {
  enter: "Return",
  return: "Return",
  numpadenter: "Return",
  esc: "Escape",
  escape: "Escape",
  " ": "Space",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  backquote: "`",
  minus: "-",
  equal: "=",
  semicolon: ";",
  quote: "'",
  bracketleft: "[",
  bracketright: "]",
};

/**
 * One key token, spelled the way an Electron accelerator spells it.
 *
 * `Digit1` / `KeyN` come from `KeyboardEvent.code` and are stripped to their
 * bare key, which is what makes a SHIFTED chord recordable at all: on a Mac
 * Shift+1 arrives as `key: "!"`, and a keymap full of "!" would neither read
 * back as ⇧1 nor match the next press of it.
 */
function normalizeKeyToken(token) {
  if (typeof token !== "string" || token === "") return "";
  const lower = token.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  const digit = /^digit([0-9])$/.exec(lower);
  if (digit) return digit[1];
  const letter = /^key([a-z])$/.exec(lower);
  if (letter) return letter[1].toUpperCase();
  const numpad = /^numpad([0-9])$/.exec(lower);
  if (numpad) return numpad[1];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  return token.length === 1 ? token.toUpperCase() : token;
}

/** True for the four keys that are only ever part of a chord, never its key. */
function isModifierKey(token) {
  const lower = String(token ?? "").toLowerCase();
  return lower === "meta" || lower === "control" || lower === "shift" || lower === "alt" || lower === "altgraph" || lower === "os";
}

/**
 * A chord in canonical form, or "" for anything unusable.
 *
 * "" IS A REAL VALUE, not a failure: it is how a keymap says a command is
 * UNBOUND. The settings pane offers that, and a command with no chord is simply
 * left out of the menu rather than given an accelerator Electron would reject.
 */
function normalizeChord(chord) {
  if (typeof chord !== "string") return "";
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return "";
  const modifiers = new Set();
  let key = "";
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    // The LAST non-modifier wins rather than the first, so a malformed
    // "N+CommandOrControl+T" still resolves to something rather than half of it.
    key = normalizeKeyToken(part);
  }
  if (key === "") return "";
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

/** The registry's own answer: every command at the chord it shipped with. */
function defaultKeymap() {
  const keymap = {};
  for (const command of COMMANDS) keymap[command.id] = normalizeChord(command.defaultChord);
  return keymap;
}

/**
 * The defaults with a person's overrides laid over them.
 *
 * OVERRIDES ARE A SPARSE PATCH, and stay one: storing the whole resolved map
 * would freeze today's defaults into every install, so a default this app later
 * improves would never reach anyone who had opened the pane once. An override
 * naming a command that no longer exists is dropped rather than carried.
 */
function mergeKeymap(overrides) {
  const keymap = defaultKeymap();
  if (!overrides || typeof overrides !== "object") return keymap;
  for (const command of COMMANDS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, command.id)) continue;
    const stored = overrides[command.id];
    // `null` is not "unbound" — it is a corrupt record, and the default is the
    // safer read of it. "" is the deliberate unbind.
    if (typeof stored !== "string") continue;
    keymap[command.id] = normalizeChord(stored);
  }
  return keymap;
}

/** Only what differs from the defaults, which is all that is ever stored. */
function keymapOverrides(keymap) {
  const defaults = defaultKeymap();
  const overrides = {};
  for (const command of COMMANDS) {
    const chord = normalizeChord(keymap?.[command.id] ?? defaults[command.id]);
    if (chord !== defaults[command.id]) overrides[command.id] = chord;
  }
  return overrides;
}

/**
 * Which commands share a chord: `{ [commandId]: [otherCommandId, …] }`.
 *
 * ONLY BOUND COMMANDS COLLIDE. Every unbound command holds "", and reporting
 * nine of those as a nine-way conflict would be the pane crying wolf about the
 * one state a person reaches by deliberately clearing a row.
 */
function keymapConflicts(keymap) {
  const byChord = new Map();
  for (const command of COMMANDS) {
    const chord = normalizeChord(keymap?.[command.id]);
    if (chord === "") continue;
    const sharing = byChord.get(chord) ?? [];
    sharing.push(command.id);
    byChord.set(chord, sharing);
  }
  const conflicts = {};
  for (const sharing of byChord.values()) {
    if (sharing.length < 2) continue;
    for (const id of sharing) conflicts[id] = sharing.filter((other) => other !== id);
  }
  return conflicts;
}

/**
 * The chords a keydown could be spelling — usually one, two when Shift is down.
 *
 * TWO CANDIDATES, because neither `key` nor `code` alone is right. `key` is what
 * the layout produced and is the only correct answer on a non-QWERTY keyboard;
 * `code` is the physical key and is the only way to recognise ⇧1 (which arrives
 * as "!") or ⇧, (which arrives as "<"). Matching against either means a chord
 * recorded one way still fires when pressed the other.
 */
function chordsForEvent(event) {
  if (!event || isModifierKey(event.key)) return [];
  const modifiers = [];
  if (event.metaKey || event.ctrlKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const tokens = [];
  for (const raw of [event.key, event.code]) {
    const token = normalizeKeyToken(typeof raw === "string" ? raw : "");
    if (token !== "" && !tokens.includes(token)) tokens.push(token);
  }
  return tokens.map((token) => [...MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)), token].join("+"));
}

/** The one chord to STORE for a keydown — the `code` reading, because that is
 *  the one that survives Shift. Falls back to the `key` reading on a key with
 *  no code (a synthesised event, an IME). "" when the press was a bare
 *  modifier, which is what lets a recorder ignore ⌘ being held down. */
function chordForEvent(event) {
  const candidates = chordsForEvent(event);
  return candidates[candidates.length - 1] ?? "";
}

/**
 * Which command a keydown fires under this keymap, or null.
 *
 * Deliberately does NOT know about focus/editable targets — this module has no
 * DOM, so it cannot ask "is the user typing in a text field". That check (issue
 * #16's focus rule) lives one layer up, in apps/web/lib/command-keys.ts's
 * `resolveWebCommandKeyAction`, which wraps this and is the only thing the web
 * app should call directly.
 *
 * REGISTRY ORDER BREAKS A TIE, so a keymap a person has put into conflict still
 * behaves deterministically rather than depending on object key order.
 */
function resolveCommandForEvent(keymap, event) {
  const candidates = chordsForEvent(event);
  if (candidates.length === 0) return null;
  for (const command of COMMANDS) {
    const chord = normalizeChord(keymap?.[command.id]);
    if (chord !== "" && candidates.includes(chord)) return command.id;
  }
  return null;
}

/** The commands one application menu carries, in registry order, each already
 *  wearing its live chord. A command whose chord is "" keeps its menu row and
 *  loses its accelerator — the row is still how you reach it with the mouse. */
function menuCommands(keymap, menu) {
  return COMMANDS.filter((command) => command.menu === menu).map((command) => ({
    ...command,
    accelerator: normalizeChord(keymap?.[command.id]),
  }));
}

function commandById(id) {
  return COMMANDS.find((command) => command.id === id);
}

module.exports = {
  COMMANDS,
  chordForEvent,
  chordsForEvent,
  commandById,
  defaultKeymap,
  keymapConflicts,
  keymapOverrides,
  menuCommands,
  mergeKeymap,
  normalizeChord,
  normalizeKeyToken,
  resolveCommandForEvent,
};
