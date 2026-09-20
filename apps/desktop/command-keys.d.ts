// Hand-written declaration for command-keys.js — apps/desktop has no tsconfig
// of its own (it is plain-JS Electron main-process code, see main.js's header),
// so this pairing is what lets apps/web's TypeScript resolve the relative import
// in apps/web/lib/commands.ts without depending on allowJs's best-effort
// inference of a CommonJS module's shape. The .js file is still what actually
// ships and runs on both sides; this file only describes it.

export type CommandKeyEventLike = {
  key: string;
  /** The physical key. Present on every real KeyboardEvent; optional so a test
   *  may hand in a plain object with only `key`. */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export type CommandMenu = "file" | "panel" | "view";

export type Command = {
  id: string;
  label: string;
  /** What a TOGGLE is called when pressing it would undo itself. See the
   *  registry's typedef: `label` stays the command's name everywhere the
   *  state is not known. */
  altLabel?: string;
  group: string;
  /** A lucide icon NAME, resolved to a component by the web's one map in
   *  `lib/command-icons.ts`. A string and not a glyph because this table is
   *  required by Electron's main process and may not import React; the menu
   *  builder and the keybindings pane both ignore it. */
  icon: string;
  defaultChord: string;
  menu?: CommandMenu;
  jump?: number;
};

/** A command id → its chord. "" means deliberately unbound. */
export type Keymap = Record<string, string>;

export const COMMANDS: Command[];

export function normalizeChord(chord: string): string;
export function normalizeKeyToken(token: string): string;
export function defaultKeymap(): Keymap;
export function mergeKeymap(overrides: Readonly<Keymap> | undefined | null): Keymap;
export function keymapOverrides(keymap: Readonly<Keymap>): Keymap;
export function keymapConflicts(keymap: Readonly<Keymap>): Record<string, string[]>;
export function chordsForEvent(event: CommandKeyEventLike): string[];
export function chordForEvent(event: CommandKeyEventLike): string;
export function resolveCommandForEvent(keymap: Readonly<Keymap>, event: CommandKeyEventLike): string | null;
/** Which commands a surface's chord claim suppresses under this keymap (#656).
 *  Computed against the LIVE chords, so a rebind hands the chord back. */
export function claimedCommandIds(keymap: Readonly<Keymap>, chords: readonly string[] | undefined): string[];
export function menuCommands(keymap: Readonly<Keymap>, menu: CommandMenu): (Command & { accelerator: string })[];
export function commandById(id: string): Command | undefined;
