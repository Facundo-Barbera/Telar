"use strict";

// THE single source of truth for Telar's application command keys (issue
// #16: cmd+n new session, cmd+t new tab, cmd+1..cmd+9 jump to the Nth recent
// conversation, cmd+, settings).
//
// Both halves of the app read this exact array — main.js requires it
// directly to build the Electron menu's native accelerators, and
// apps/web/lib/command-keys.ts imports it by relative path (see the long
// comment there for why a relative cross-app import, rather than a
// packages/* workspace dependency, is the deliberate choice). Nothing in
// this file may depend on Electron, Node, or the DOM: main.js only reads
// `label`/`accelerator` to build menu items, and the web renderer only reads
// `key`/`jump` to match a KeyboardEvent and to know which action an id is —
// anything platform-specific (the focus rule, routing, window management)
// belongs on whichever side actually has that context, not here.
//
// Plain CommonJS, zero dependencies, on purpose: this is required at runtime
// by Electron's REAL main process (a real Node runtime with no TypeScript
// support and no bundler), so it has to already be valid, dependency-free
// JavaScript — not source that needs a build step to become that.

/**
 * @typedef {Object} CommandKeyBinding
 * @property {string} id - stable action id the renderer dispatches on.
 * @property {string} label - human-readable name; doubles as the Electron
 *   menu item's label.
 * @property {string} accelerator - an Electron accelerator string. Always
 *   "CommandOrControl+…", never a hardcoded "Cmd" or "Ctrl" — issue #16 asks
 *   for CommandOrControl semantics explicitly so the same table works
 *   unmodified on macOS today and on a Windows/Linux build later.
 * @property {string} key - the `KeyboardEvent.key` value to match on the web
 *   side. Only ever checked together with CommandOrControl (see
 *   matchesCommandKeyEvent below) — this field alone never fires anything.
 * @property {number} [jump] - for a "jump to Nth recent conversation"
 *   binding, which N (1-9). Absent on every other binding.
 */

/** @type {CommandKeyBinding[]} */
const COMMAND_KEY_BINDINGS = [
  {
    id: "new-session",
    label: "New Session",
    accelerator: "CommandOrControl+N",
    key: "n",
  },
  {
    id: "new-tab",
    label: "New Tab",
    accelerator: "CommandOrControl+T",
    key: "t",
  },
  // cmd+1..cmd+9: jump to the Nth conversation in the sidebar, top to bottom
  // as drawn. Generated, not hand-written nine times — see
  // railRowsForCommandKeys in apps/web/lib/session-groups.ts for exactly
  // which rows count.
  ...Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return {
      id: `jump-${n}`,
      label: `Jump to Conversation ${n}`,
      accelerator: `CommandOrControl+${n}`,
      key: String(n),
      jump: n,
    };
  }),
  {
    id: "settings",
    label: "Settings…",
    accelerator: "CommandOrControl+,",
    key: ",",
  },
];

/**
 * Whether a DOM-KeyboardEvent-shaped object satisfies a binding's chord.
 * Duck-typed on purpose (not `KeyboardEvent`) — this file has no DOM to
 * import a type from, and it lets the exact same function run against a
 * plain object in a test.
 *
 * CommandOrControl semantics: meta (Cmd on macOS) or ctrl (everywhere else)
 * either satisfies it — one check, not a platform branch, which is what lets
 * the web build work off-Mac without a second table. Shift and Alt are never
 * part of any binding today, so both must be up: Cmd+Shift+N etc. stay free
 * for the browser or a future binding.
 *
 * @param {CommandKeyBinding} binding
 * @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean }} event
 * @returns {boolean}
 */
function matchesCommandKeyEvent(binding, event) {
  const primaryModifier = Boolean(event.metaKey) || Boolean(event.ctrlKey);
  if (!primaryModifier || event.altKey || event.shiftKey) return false;
  return typeof event.key === "string" && event.key.toLowerCase() === binding.key.toLowerCase();
}

/**
 * Resolve a raw keydown-shaped event to a binding id, or null.
 *
 * Deliberately does NOT know about focus/editable targets — this module has
 * no DOM, so it cannot ask "is the user typing in a text field". That check
 * (issue #16's focus rule) lives one layer up, in
 * apps/web/lib/command-keys.ts's resolveWebCommandKeyAction, which wraps
 * this and is the only thing the web app should call directly.
 *
 * @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean }} event
 * @returns {string | null}
 */
function resolveCommandKeyAction(event) {
  const binding = COMMAND_KEY_BINDINGS.find((candidate) => matchesCommandKeyEvent(candidate, event));
  return binding ? binding.id : null;
}

module.exports = {
  COMMAND_KEY_BINDINGS,
  matchesCommandKeyEvent,
  resolveCommandKeyAction,
};
