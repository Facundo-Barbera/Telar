import { resolveCommandForEvent, type CommandId, type CommandKeyEventLike, type Keymap } from "./commands";

export type { CommandId };

export type EditableTargetLike = unknown;

export function isEditableTarget(target: EditableTargetLike): boolean {
  if (!target || typeof target !== "object") return false;
  const { tagName, isContentEditable } = target as { tagName?: unknown; isContentEditable?: unknown };
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;
  return isContentEditable === true;
}

export type CommandKeyEvent = CommandKeyEventLike & { target?: EditableTargetLike };

export function resolveWebCommandKeyAction(keymap: Keymap, event: CommandKeyEvent): CommandId | null {
  const chorded = Boolean(event.metaKey) || Boolean(event.ctrlKey);
  if (!chorded && isEditableTarget(event.target)) return null;
  return resolveCommandForEvent(keymap, event) as CommandId | null;
}

export type CommandDestination =
  | { kind: "navigate"; href: string }
  | { kind: "open-tab"; href: string }
  | { kind: "open-window"; href: string }
  | { kind: "noop" };

export function commandDestination(id: CommandId, recentSessionHrefs: readonly (string | undefined)[]): CommandDestination {
  if (id === "new-conversation") return { kind: "navigate", href: "/" };
  if (id === "new-tab") return { kind: "open-tab", href: "/" };
  if (id === "new-window") return { kind: "open-window", href: "/" };
  if (id === "settings" || id === "search-settings") return { kind: "navigate", href: "/settings" };
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
