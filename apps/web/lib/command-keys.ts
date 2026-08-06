// The web half of Telar's application command keys (issue #16). The binding
// TABLE itself is defined exactly once, in apps/desktop/command-keys.js — a
// plain, dependency-free CommonJS module so Electron's main process (real
// Node, no TypeScript, no bundler) can `require` it directly to build the
// app menu's native accelerators. This file is the only place that reaches
// across the app boundary to import it; everywhere else in apps/web that
// wants a binding imports THIS file, never the desktop one directly, so
// there is exactly one seam to keep an eye on if the two apps' layout ever
// moves.
//
// Why a relative import into apps/desktop instead of a packages/* workspace
// package (the pattern @telar/core uses)? Electron's packaged build ships
// main.js via an explicit `files` whitelist in apps/desktop/package.json,
// not ordinary node_modules resolution — a new workspace dependency would
// need `bun install` to relink it AND electron-builder to prove it survives
// packaging, and this task's hard rule against launching Electron makes the
// second half of that impossible to verify here. A same-directory file that
// already ships by the mechanism every other desktop source file uses
// (browser-manager.js, preload.js, …) has no such unknown. See
// apps/desktop/command-keys.d.ts for why this still typechecks cleanly.
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
 *  `Element`, so the exact same function runs against a real DOM node in the
 *  browser and against a plain object in a test (this repository has no DOM
 *  test harness — see components/conversation/items.test.ts). Typed as
 *  `unknown` rather than an all-optional object: TypeScript's "weak type"
 *  check rejects assigning a real `EventTarget` (which declares neither
 *  property) to an object type whose properties are all optional, and
 *  `event.target` is exactly an `EventTarget` — so the looseness has to be
 *  at the boundary (this type), not inside the function, which still reads
 *  both properties safely regardless of what it's handed. */
export type EditableTargetLike = unknown;

/**
 * FOCUS RULE (issue #16 — "needs a rule for what happens when focus is
 * inside the composer or a text field").
 *
 * Every binding in this table NAVIGATES: new-session and new-tab replace or
 * open a fresh composer, jump-N and settings both leave the current view.
 * None of them insert a character — CommandOrControl+letter is not a text-
 * editing chord anywhere in this app — so intercepting one never "steals a
 * keystroke" in the literal sense of eating text the user meant to type.
 *
 * What it CAN steal is the VIEW itself. The composer's draft is plain
 * component state (session-view.tsx's `input`) — unlike a QUEUED message
 * (issue #5's localStorage fix, lib/message-queue.ts), an unsent draft is
 * never persisted, so navigating away mid-sentence would silently delete
 * whatever was half-typed. That is a worse outcome than the shortcut simply
 * not firing, so the rule is: every binding is suppressed while focus is
 * anywhere editable — the composer, but also a session-rename field, the
 * sidebar's search box, a settings input. Nothing here special-cases the
 * composer alone: losing a half-edited session title or search query to a
 * slipped cmd+N is the same class of surprise as losing a half-typed
 * message, so both are guarded the same way, uniformly, rather than by a
 * growing list of "except when focus is in THIS particular field".
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
  // Web: open a real, separate browser tab (window.open) — the current tab
  // and its in-flight turn are left exactly alone. Desktop has no tab strip
  // and today only ever manages ONE BrowserWindow (main.js's `browserManager`
  // is a module-level singleton bound to it) — spawning a second top-level
  // window is real, unbuilt multi-window support, not this issue's scope, and
  // could not be verified without launching Electron (hard rule). So on
  // desktop this degrades, on purpose, to the same in-place navigation as
  // new-session rather than silently doing nothing or risking the singleton.
  | { kind: "open-tab"; href: string }
  | { kind: "noop" };

/**
 * What each binding id MEANS, decided from how routing and session creation
 * actually work (not assumed):
 *   - "new-session" is exactly the sidebar's own global New Session
 *     control (TelarSidebarHeader / the composer-icon button), which both
 *     link to "/" rather than a project-scoped `sessions/new` — "/" is
 *     app/page.tsx's own front door, and it already resolves to the
 *     most-recently-active project's fresh composer server-side. Cmd+N
 *     mirrors that exact destination rather than introducing a second,
 *     project-scoped meaning of "new".
 *   - "new-tab" is the same destination, opened without disturbing where
 *     you already are — see the `open-tab` comment above for what that means
 *     on each platform.
 *   - "settings" is the sidebar footer's own Settings link ("/settings").
 *   - "jump-N" is recentSessionsForCommandKeys's Nth entry (session-list.ts)
 *     — the sidebar's own unfiltered "Recent" band, in the exact order it is
 *     rendered in.
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
