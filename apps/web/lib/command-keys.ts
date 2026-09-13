/**
 * The keydown side of the command registry: the focus rule, matching a real
 * KeyboardEvent against the live keymap, and what the handful of pure-navigation
 * commands mean in this cockpit.
 *
 * THE REGISTRY AND THE KEYMAP ARE NEXT DOOR, in `lib/commands.ts`. This file is
 * the part with an opinion about the DOM — which is exactly the part the shared
 * CommonJS table cannot hold, because Electron's main process runs it with no
 * DOM at all.
 *
 * WHAT #367 CHANGED: `resolveWebCommandKeyAction` takes the KEYMAP now. It used
 * to match against a frozen table, which is why the settings pane could only
 * ever read the chords out.
 */
import { resolveCommandForEvent, type CommandId, type CommandKeyEventLike, type Keymap } from "@/lib/commands";

export type { CommandId, CommandKeyEventLike };

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
 * IT MATTERS NOW. Every chord the registry ships with is chorded, so this
 * suppressed nothing while the table was frozen; a person may now bind a bare
 * key, and a naked "n" over a focused field must keep typing an "n".
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
 * Resolve a keydown-shaped event to a command id, applying the focus rule.
 *
 * Returns null both when nothing matches and when the focus rule suppresses an
 * otherwise-matching bare key — callers never need to tell the two apart.
 *
 * THE ONE ENFORCEMENT POINT. The donor once applied this rule twice, here and
 * again in the menu-invoke handler, and two copies of a rule this subtle is how
 * one gets fixed and the other does not. The menu path needs no copy: an
 * accelerator that reached the main process was never typed into a field.
 */
export function resolveWebCommandKeyAction(keymap: Keymap, event: CommandKeyEvent): CommandId | null {
  const chorded = Boolean(event.metaKey) || Boolean(event.ctrlKey);
  if (!chorded && isEditableTarget(event.target)) return null;
  return resolveCommandForEvent(keymap, event) as CommandId | null;
}

export type CommandDestination =
  | { kind: "navigate"; href: string }
  /**
   * A real, separate browser tab (`window.open`); the current one and any turn
   * running in it are left alone. The desktop shell degrades this to in-place
   * navigation, because `browserManager` owns a single window and a second one
   * is unbuilt multi-window support rather than a line of code.
   */
  | { kind: "open-tab"; href: string }
  /** A second shell window on this path — the desktop's own verb. In a browser
   *  tab there is no shell to ask, and the caller falls back to `open-tab`. */
  | { kind: "open-window"; href: string }
  /** Nobody is bound and there is nowhere to go: the key does nothing, which is
   *  the correct behaviour for ⌘⌥F on the projects list. */
  | { kind: "noop" };

/**
 * WHERE A COMMAND GOES when no component has claimed it.
 *
 * Only the commands that are PURE NAVIGATION live here. Everything else — the
 * panel, the composer, the rail's own search — is a component's own state, and
 * a destination table could not name it; those bind themselves through
 * `bindCommands` and this function answers `noop` for them, which is what a key
 * pressed on a route where its surface does not exist should do.
 *
 * `jump-N` is the Nth row of the rail as drawn, attention and pinned bands
 * included, folded groups skipped.
 */
export function commandDestination(id: CommandId, recentSessionHrefs: readonly (string | undefined)[]): CommandDestination {
  if (id === "new-conversation") return { kind: "navigate", href: "/" };
  if (id === "new-tab") return { kind: "open-tab", href: "/" };
  if (id === "new-window") return { kind: "open-window", href: "/" };
  if (id === "settings" || id === "search-settings") return { kind: "navigate", href: "/settings" };
  const n = jumpSlot(id);
  if (!n) return { kind: "noop" };
  const href = recentSessionHrefs[n - 1];
  return href ? { kind: "navigate", href } : { kind: "noop" };
}

function jumpSlot(id: CommandId): number | undefined {
  const match = /^jump-([1-9])$/.exec(id);
  return match ? Number(match[1]) : undefined;
}
