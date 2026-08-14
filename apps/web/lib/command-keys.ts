/**
 * The web half of Telar's application command keys — ⌘N, ⌘T, ⌘1..⌘9, ⌘,.
 *
 * PORTED FROM THE FROZEN APP'S `lib/command-keys.ts`, because the cockpit
 * never had this half at all. The BINDING TABLE and the Electron menu that wears
 * it have been alive the whole time in `apps/desktop/command-keys.js` and
 * `main.js` — the accelerators are in the app menu, the main process fires them,
 * the preload bridge forwards them — and nothing in this renderer was listening.
 * So the keys were not broken; they were never connected on this side.
 *
 * THE TABLE LIVES ONCE, in plain CommonJS, so Electron's real main process can
 * `require` it without a build step. This file is the only place in the cockpit
 * that reaches across the app boundary to import it; everything else imports
 * THIS file. The frozen app's reasoning for a relative import over a
 * `packages/*` dependency is in `docs/command-keys-web-port.md` and still holds.
 *
 * WHAT CHANGED HERE, and it is only the destinations:
 *   - "/" IS A COMPOSER NOW rather than a projects table, so ⌘N lands exactly
 *     where its label promises. In the donor this route was a redirect into
 *     whichever session was most recent; here it resolves a project and opens a
 *     new-conversation canvas.
 *   - JUMP COUNTS THE PINNED BAND FIRST, because the rail draws it first. See
 *     `recentSessionsForCommandKeys`.
 */
import {
  COMMAND_KEY_BINDINGS as RAW_COMMAND_KEY_BINDINGS,
  resolveCommandKeyAction as resolveRawCommandKeyAction,
  type CommandKeyBinding,
  type CommandKeyEventLike,
} from "../../desktop/command-keys.js";

export type { CommandKeyBinding, CommandKeyEventLike };

/** The closed set of action ids the table can produce. Kept in step with
 *  `apps/desktop/command-keys.js` by the test beside this file, since TypeScript
 *  cannot narrow a plain JS array's `.id` strings on its own. */
export type CommandKeyId = "new-session" | "new-tab" | "settings" | `jump-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export const COMMAND_KEY_BINDINGS = RAW_COMMAND_KEY_BINDINGS as CommandKeyBinding[];

/** Loose, duck-typed "is this an editable surface" — deliberately NOT `Element`,
 *  so the same function runs against a real DOM node and against a plain object
 *  in a test. `unknown` rather than an all-optional object because TS's weak-type
 *  check would otherwise reject a real `EventTarget`, which declares neither. */
export type EditableTargetLike = unknown;

/**
 * THE FOCUS RULE: a binding is suppressed while focus is somewhere editable ONLY
 * when its chord carries no command/control modifier.
 *
 * A modifier chord is exactly the mechanism by which a shortcut stays reachable
 * while typing — ⌘N, ⌘T and ⌘, fire from inside a text field in every macOS
 * application — and in this cockpit the composer holds focus nearly all the
 * time, so an unconditional rule would leave the table with no state in which
 * most of it could fire.
 *
 * Every binding in today's table is a chord, so this currently suppresses
 * nothing. It stays for the first BARE-KEY binding: a naked "n" over a focused
 * field must keep typing an "n".
 */
export function isEditableTarget(target: EditableTargetLike): boolean {
  if (!target || typeof target !== "object") return false;
  const { tagName, isContentEditable } = target as { tagName?: unknown; isContentEditable?: unknown };
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;
  // Reflects the element OR any ancestor being contenteditable — the browser
  // has already computed that walk.
  return isContentEditable === true;
}

export type CommandKeyEvent = CommandKeyEventLike & { target?: EditableTargetLike };

/**
 * Resolve a keydown-shaped event to a binding id, applying the focus rule.
 *
 * Returns null both when nothing matches and when the focus rule suppresses an
 * otherwise-matching bare key — callers never need to tell the two apart.
 *
 * THE ONE ENFORCEMENT POINT. The donor once applied this rule twice, here and
 * again in the menu-invoke handler, and two copies of a rule this subtle is how
 * one gets fixed and the other does not. The menu path needs no copy: every
 * accelerator in the table is a chord, and chords are exempt.
 */
export function resolveWebCommandKeyAction(event: CommandKeyEvent): CommandKeyId | null {
  const chorded = Boolean(event.metaKey) || Boolean(event.ctrlKey);
  if (!chorded && isEditableTarget(event.target)) return null;
  return resolveRawCommandKeyAction(event) as CommandKeyId | null;
}

/** For a jump-N id, which N (1-9); undefined for every other binding. */
export function jumpNumber(id: CommandKeyId): number | undefined {
  const match = /^jump-([1-9])$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

export type CommandKeyDestination =
  | { kind: "navigate"; href: string }
  /**
   * A real, separate browser tab (`window.open`); the current one and any turn
   * running in it are left alone. The desktop shell degrades this to in-place
   * navigation, because `browserManager` owns a single window and a second one
   * is unbuilt multi-window support rather than a line of code.
   */
  | { kind: "open-tab"; href: string }
  | { kind: "noop" };

/**
 * What each binding MEANS in this cockpit.
 *
 * `/` for both new-session and new-tab: it resolves a project and opens its
 * new-conversation canvas, which is the same guess the rail's own New
 * conversation button makes — so the key and the button cannot disagree.
 * `jump-N` is the Nth row of the rail as drawn, pinned band included.
 */
export function commandKeyDestination(id: CommandKeyId, recentSessionHrefs: readonly (string | undefined)[]): CommandKeyDestination {
  if (id === "new-session") return { kind: "navigate", href: "/" };
  if (id === "new-tab") return { kind: "open-tab", href: "/" };
  if (id === "settings") return { kind: "navigate", href: "/settings" };
  const n = jumpNumber(id);
  if (!n) return { kind: "noop" };
  const href = recentSessionHrefs[n - 1];
  return href ? { kind: "navigate", href } : { kind: "noop" };
}
