"use strict";

const COMMANDS = [
  { id: "new-conversation", label: "New Conversation", group: "Conversation", icon: "message-square-plus", defaultChord: "CommandOrControl+N", menu: "file" },

  { id: "new-conversation-in", label: "New Conversation In…", group: "Conversation", icon: "messages-square", defaultChord: "" },
  { id: "new-tab", label: "New Tab", group: "Conversation", icon: "square-plus", defaultChord: "CommandOrControl+T", menu: "file" },
  { id: "new-window", label: "New Window", group: "Conversation", icon: "app-window", defaultChord: "CommandOrControl+Shift+N", menu: "file" },
  { id: "focus-composer", label: "Focus Composer", group: "Conversation", icon: "text-cursor", defaultChord: "CommandOrControl+L" },
  { id: "send", label: "Send", group: "Conversation", icon: "send", defaultChord: "CommandOrControl+Return" },
  { id: "stop-turn", label: "Stop Turn", group: "Conversation", icon: "square", defaultChord: "CommandOrControl+." },

  { id: "toggle-dictation", label: "Dictate", group: "Conversation", icon: "mic", defaultChord: "CommandOrControl+D" },

  { id: "reveal-in-finder", label: "Reveal in Finder", group: "Conversation", icon: "folder-open", defaultChord: "CommandOrControl+O", menu: "file" },

  { id: "pin-session", label: "Pin Conversation", altLabel: "Unpin Conversation", group: "Conversation", icon: "pin", defaultChord: "CommandOrControl+P", menu: "file" },

  { id: "search-sessions", label: "Command Palette", group: "Rail", icon: "search", defaultChord: "CommandOrControl+K" },

  { id: "add-project", label: "Add Project…", group: "Rail", icon: "folder-plus", defaultChord: "" },
  { id: "toggle-rail", label: "Toggle Rail", group: "Rail", icon: "panel-left", defaultChord: "CommandOrControl+B" },

  ...Array.from({ length: 9 }, (_, index) => {
    const n = index + 1;
    return {
      id: `jump-${n}`,
      label: `Jump to ${n}`,
      group: "Rail",

      icon: "hash",
      defaultChord: `CommandOrControl+${n}`,
      menu: "file",
      jump: n,
    };
  }),

  { id: "toggle-panel", label: "Toggle Right Panel", group: "Panel", icon: "panel-right", defaultChord: "CommandOrControl+\\", menu: "panel" },
  { id: "panel-next-tab", label: "Next Panel Tab", group: "Panel", icon: "arrow-right", defaultChord: "CommandOrControl+Alt+Right", menu: "panel" },
  { id: "panel-previous-tab", label: "Previous Panel Tab", group: "Panel", icon: "arrow-left", defaultChord: "CommandOrControl+Alt+Left", menu: "panel" },
  { id: "panel-fullscreen", label: "Fill the Window", group: "Panel", icon: "maximize", defaultChord: "CommandOrControl+Alt+F", menu: "panel" },
  { id: "open-diff", label: "Open Diff", group: "Panel", icon: "git-compare", defaultChord: "CommandOrControl+Shift+D", menu: "panel" },
  { id: "open-editor", label: "Open Editor", group: "Panel", icon: "file-code", defaultChord: "CommandOrControl+Shift+E", menu: "panel" },
  { id: "open-data", label: "Open Data", group: "Panel", icon: "table", defaultChord: "CommandOrControl+Shift+B", menu: "panel" },
  { id: "open-latex", label: "Open LaTeX", group: "Panel", icon: "sigma", defaultChord: "CommandOrControl+Shift+X", menu: "panel" },

  { id: "toggle-devtools", label: "Developer Tools", group: "Panel", icon: "bug", defaultChord: "CommandOrControl+Alt+I", menu: "view" },

  { id: "go-to-file", label: "Go to File…", group: "Panel", icon: "file-search", defaultChord: "CommandOrControl+Shift+P" },

  { id: "search-project-contents", label: "Search in Project…", group: "Panel", icon: "text-search", defaultChord: "CommandOrControl+Shift+F" },

  { id: "settings", label: "Settings…", group: "Application", icon: "settings", defaultChord: "CommandOrControl+,", menu: "file" },
  { id: "search-settings", label: "Search Settings…", group: "Application", icon: "settings-2", defaultChord: "CommandOrControl+Shift+,", menu: "file" },

  { id: "appearance", label: "Appearance…", group: "Application", icon: "palette", defaultChord: "" },

  { id: "project-settings", label: "Project Settings…", group: "Application", icon: "folder-cog", defaultChord: "" },
  { id: "open-usage", label: "Usage…", group: "Application", icon: "gauge", defaultChord: "" },
  { id: "open-plugins", label: "Plugins…", group: "Application", icon: "puzzle", defaultChord: "" },
  { id: "check-for-updates", label: "Check for Updates…", group: "Application", icon: "refresh-cw", defaultChord: "" },
];

const MODIFIER_ORDER = ["CommandOrControl", "Alt", "Shift"];

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

function isModifierKey(token) {
  const lower = String(token ?? "").toLowerCase();
  return lower === "meta" || lower === "control" || lower === "shift" || lower === "alt" || lower === "altgraph" || lower === "os";
}

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

    key = normalizeKeyToken(part);
  }
  if (key === "") return "";
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

function defaultKeymap() {
  const keymap = {};
  for (const command of COMMANDS) keymap[command.id] = normalizeChord(command.defaultChord);
  return keymap;
}

function mergeKeymap(overrides) {
  const keymap = defaultKeymap();
  if (!overrides || typeof overrides !== "object") return keymap;
  for (const command of COMMANDS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, command.id)) continue;
    const stored = overrides[command.id];

    if (typeof stored !== "string") continue;
    keymap[command.id] = normalizeChord(stored);
  }
  return keymap;
}

function keymapOverrides(keymap) {
  const defaults = defaultKeymap();
  const overrides = {};
  for (const command of COMMANDS) {
    const chord = normalizeChord(keymap?.[command.id] ?? defaults[command.id]);
    if (chord !== defaults[command.id]) overrides[command.id] = chord;
  }
  return overrides;
}

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

function chordForEvent(event) {
  const candidates = chordsForEvent(event);
  return candidates[candidates.length - 1] ?? "";
}

function resolveCommandForEvent(keymap, event) {
  const candidates = chordsForEvent(event);
  if (candidates.length === 0) return null;
  for (const command of COMMANDS) {
    const chord = normalizeChord(keymap?.[command.id]);
    if (chord !== "" && candidates.includes(chord)) return command.id;
  }
  return null;
}

function claimedCommandIds(keymap, chords) {
  const claimed = new Set();
  for (const chord of chords ?? []) {
    const normalized = normalizeChord(chord);
    if (normalized !== "") claimed.add(normalized);
  }
  if (claimed.size === 0) return [];
  const ids = [];
  for (const command of COMMANDS) {
    const chord = normalizeChord(keymap?.[command.id]);
    if (chord !== "" && claimed.has(chord)) ids.push(command.id);
  }
  return ids;
}

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
  claimedCommandIds,
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
