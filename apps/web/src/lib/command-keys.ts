/**
 * The DOM side of the command registry (`lib/commands.ts`): the focus rule, event
 * matching and pure-navigation destinations. Kept out of the shared CommonJS table
 * because Electron's main process loads that without a DOM.
 */
import { resolveCommandForEvent, type CommandId, type CommandKeyEventLike, type Keymap } from "@/lib/commands";

export type { CommandId };

/** `unknown`, not `Element`, so tests can pass plain objects; TS's weak-type
 *  check would reject a real `EventTarget` against an all-optional shape. */
export type EditableTargetLike = unknown;

/**
 * A binding is suppressed in an editable target only when its chord has no
 * command/control modifier, so ⌘-chords still fire from the composer while a bare
 * "n" keeps typing.
 */
export function isEditableTarget(target: EditableTargetLike): boolean {
  if (!target || typeof target !== "object") return false;
  const { tagName, isContentEditable } = target as { tagName?: unknown; isContentEditable?: unknown };
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;
  // Covers ancestors too; the browser already computed that walk.
  return isContentEditable === true;
}

export type CommandKeyEvent = CommandKeyEventLike & { target?: EditableTargetLike };

/**
 * Keydown to command id with the focus rule applied; null for no match or a
 * suppressed bare key. The only enforcement point: menu accelerators never come
 * from a text field.
 */
export function resolveWebCommandKeyAction(keymap: Keymap, event: CommandKeyEvent): CommandId | null {
  const chorded = Boolean(event.metaKey) || Boolean(event.ctrlKey);
  if (!chorded && isEditableTarget(event.target)) return null;
  return resolveCommandForEvent(keymap, event) as CommandId | null;
}

export type CommandDestination =
  | { kind: "navigate"; href: string }
  /** A separate browser tab; the desktop shell degrades this to in-place navigation. */
  | { kind: "open-tab"; href: string }
  /** A second shell window; in a browser the caller falls back to `open-tab`. */
  | { kind: "open-window"; href: string }
  | { kind: "noop" };

/**
 * Where a pure-navigation command goes when no component claimed it; everything
 * else answers `noop`. `jump-N` is the Nth rail row as drawn, folded groups skipped.
 */
export function commandDestination(id: CommandId, recentSessionHrefs: readonly (string | undefined)[]): CommandDestination {
  if (id === "new-conversation") return { kind: "navigate", href: "/" };
  if (id === "new-tab") return { kind: "open-tab", href: "/" };
  if (id === "new-window") return { kind: "open-window", href: "/" };
  if (id === "settings" || id === "search-settings") return { kind: "navigate", href: "/settings" };
  // `check-for-updates` lands on General, where the Updates group lives.
  if (id === "appearance") return { kind: "navigate", href: "/settings?section=appearance" };
  if (id === "open-plugins") return { kind: "navigate", href: "/settings?section=plugins" };
  if (id === "check-for-updates") return { kind: "navigate", href: "/settings?section=updates" };
  if (id === "open-usage") return { kind: "navigate", href: "/usage" };
  const n = jumpSlot(id);
  if (!n) return { kind: "noop" };
  const href = recentSessionHrefs[n - 1];
  return href ? { kind: "navigate", href } : { kind: "noop" };
}

function jumpSlot(id: CommandId): number | undefined {
  const match = /^jump-([1-9])$/.exec(id);
  return match ? Number(match[1]) : undefined;
}
