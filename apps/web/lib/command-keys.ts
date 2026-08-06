// The web half of Telar's application command keys (issue #16). The binding
// TABLE lives once in apps/desktop/command-keys.js (plain CommonJS, so
// Electron's main process can `require` it directly); this file is the only
// place that reaches across the app boundary to import it — everywhere else
// in apps/web imports THIS file, never the desktop one directly.
// Full reasoning, including why this is a relative import rather than a
// packages/* workspace dependency: docs/command-keys-web-port.md
import {
  COMMAND_KEY_BINDINGS as RAW_COMMAND_KEY_BINDINGS,
  resolveCommandKeyAction as resolveRawCommandKeyAction,
  type CommandKeyBinding,
  type CommandKeyEventLike,
} from "../../desktop/command-keys.js";

export type { CommandKeyBinding, CommandKeyEventLike };

/** The closed set of action ids the table above can ever produce — kept in
 *  sync with apps/desktop/command-keys.js by the invariant test in
 *  command-keys.test.ts, since TypeScript itself cannot narrow a plain JS
 *  array's `.id` strings for us. */
export type CommandKeyId =
  | "new-session"
  | "new-tab"
  | "settings"
  | `jump-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export const COMMAND_KEY_BINDINGS = RAW_COMMAND_KEY_BINDINGS as CommandKeyBinding[];

/** Loose, duck-typed "is this an editable surface" shape — deliberately NOT
 *  `Element`, so the same function runs against a real DOM node and against
 *  a plain object in a test. `unknown` rather than an all-optional object
 *  because TS's "weak type" check would otherwise reject a real
 *  `EventTarget` (which declares neither property) as an argument. Full
 *  reasoning: docs/command-keys-web-port.md */
export type EditableTargetLike = unknown;

/**
 * FOCUS RULE (issue #16): every binding is suppressed while focus is
 * anywhere editable — composer, session-rename field, search box, settings
 * input — uniformly, never special-cased to the composer alone. Every
 * binding NAVIGATES and none inserts a character, so this is about
 * protecting an unsent draft (never persisted, unlike a queued message —
 * lib/message-queue.ts) from being silently lost to a slipped shortcut, not
 * about "stealing a keystroke". Full reasoning: docs/command-keys-web-port.md
 */
export function isEditableTarget(target: EditableTargetLike): boolean {
  if (!target || typeof target !== "object") return false;
  const { tagName, isContentEditable } = target as { tagName?: unknown; isContentEditable?: unknown };
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;
  // Reflects the element OR any ancestor having contenteditable set — the
  // browser already computes the closest() walk for us.
  return isContentEditable === true;
}

export type CommandKeyEvent = CommandKeyEventLike & { target?: EditableTargetLike };

/**
 * Resolve a keydown-shaped event to a binding id, applying the focus rule
 * above. Returns null both when nothing matches and when the focus rule
 * suppresses an otherwise-matching chord — callers never need to (and
 * should not try to) tell the two apart.
 */
export function resolveWebCommandKeyAction(event: CommandKeyEvent): CommandKeyId | null {
  if (isEditableTarget(event.target)) return null;
  return resolveRawCommandKeyAction(event) as CommandKeyId | null;
}

/** For a jump-N id, which N (1-9); undefined for every other binding. */
export function jumpNumber(id: CommandKeyId): number | undefined {
  const match = /^jump-([1-9])$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

export type CommandKeyDestination =
  | { kind: "navigate"; href: string }
  // Web: a real, separate browser tab (window.open); the current tab and its
  // in-flight turn are left alone. Desktop degrades this to in-place
  // navigation (main.js's `browserManager` manages a single BrowserWindow,
  // and a second one is unbuilt multi-window support). Full reasoning:
  // docs/command-keys-web-port.md
  | { kind: "open-tab"; href: string }
  | { kind: "noop" };

/**
 * What each binding id MEANS: "new-session"/"new-tab" both target "/" — the
 * sidebar's own global New Session destination, not a project-scoped
 * `sessions/new`; "settings" is the sidebar footer's "/settings"; "jump-N" is
 * recentSessionsForCommandKeys's Nth entry (session-list.ts), the sidebar's
 * unfiltered "Recent" band in render order. Decided from how routing and
 * session creation actually work, not assumed — see docs/command-keys-web-port.md.
 */
export function commandKeyDestination(
  id: CommandKeyId,
  recentSessionHrefs: readonly (string | undefined)[],
): CommandKeyDestination {
  if (id === "new-session") return { kind: "navigate", href: "/" };
  if (id === "new-tab") return { kind: "open-tab", href: "/" };
  if (id === "settings") return { kind: "navigate", href: "/settings" };
  const n = jumpNumber(id);
  if (!n) return { kind: "noop" };
  const href = recentSessionHrefs[n - 1];
  return href ? { kind: "navigate", href } : { kind: "noop" };
}
