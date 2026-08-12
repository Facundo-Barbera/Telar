// Hand-written declaration for command-keys.js — apps/desktop has no
// tsconfig of its own (it is plain-JS Electron main-process code, see
// main.js's header), so this pairing is what lets apps/web_old's TypeScript
// resolve the relative import in apps/web_old/lib/command-keys.ts without
// depending on allowJs's best-effort inference of a CommonJS module's shape.
// The .js file is still what actually ships and runs on both sides; this
// file only describes it.

export type CommandKeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export type CommandKeyBinding = {
  id: string;
  label: string;
  accelerator: string;
  key: string;
  jump?: number;
};

export const COMMAND_KEY_BINDINGS: CommandKeyBinding[];

export function matchesCommandKeyEvent(
  binding: CommandKeyBinding,
  event: CommandKeyEventLike,
): boolean;

export function resolveCommandKeyAction(event: CommandKeyEventLike): string | null;
