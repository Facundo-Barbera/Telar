/**
 * Command registry, keymap and handler binding. The table lives in plain CommonJS
 * (`apps/desktop/command-keys.js`) so Electron's main process can require it; the
 * rest of the cockpit imports this file instead. Keymap overrides are mirrored to
 * the desktop shell so the application menu rebuilds its accelerators.
 */
import {
  COMMANDS as RAW_COMMANDS,
  chordForEvent as rawChordForEvent,
  claimedCommandIds as rawClaimedCommandIds,
  defaultKeymap as rawDefaultKeymap,
  keymapConflicts as rawKeymapConflicts,
  keymapOverrides as rawKeymapOverrides,
  mergeKeymap as rawMergeKeymap,
  normalizeChord,
  resolveCommandForEvent,
  type Command as RawCommand,
  type CommandKeyEventLike,
  type Keymap as RawKeymap,
} from "../../desktop/src/main/command-keys.js";

export { normalizeChord, resolveCommandForEvent };
export type { CommandKeyEventLike };

/** Kept in step with `apps/desktop/command-keys.js` by the test beside this file. */
export type CommandId =
  | "new-conversation"
  | "new-conversation-in"
  | "new-tab"
  | "new-window"
  | "focus-composer"
  | "send"
  | "stop-turn"
  | "toggle-dictation"
  | "reveal-in-finder"
  | "pin-session"
  | "search-sessions"
  | "add-project"
  | "toggle-rail"
  | `jump-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "toggle-panel"
  | "panel-next-tab"
  | "panel-previous-tab"
  | "panel-fullscreen"
  | "open-diff"
  | "open-editor"
  | "open-data"
  | "open-latex"
  | "toggle-devtools"
  | "go-to-file"
  | "search-project-contents"
  | "settings"
  | "search-settings"
  | "appearance"
  | "project-settings"
  | "open-usage"
  | "open-plugins"
  | "check-for-updates";

export type CommandGroup = "Conversation" | "Rail" | "Panel" | "Application";

export type Command = Omit<RawCommand, "id" | "group"> & { id: CommandId; group: CommandGroup };

export const COMMANDS = RAW_COMMANDS as Command[];

/** "" means deliberately unbound. */
export type Keymap = Record<CommandId, string>;

export const COMMAND_GROUPS: readonly CommandGroup[] = ["Conversation", "Rail", "Panel", "Application"];

export function defaultKeymap(): Keymap {
  return rawDefaultKeymap() as Keymap;
}

export function mergeKeymap(overrides: Partial<Keymap> | undefined): Keymap {
  return rawMergeKeymap(overrides as RawKeymap | undefined) as Keymap;
}

export function keymapOverrides(keymap: Keymap): Partial<Keymap> {
  return rawKeymapOverrides(keymap) as Partial<Keymap>;
}

/** `{ [commandId]: [other commands on that chord] }`; "" never collides. */
export function keymapConflicts(keymap: Keymap): Partial<Record<CommandId, CommandId[]>> {
  return rawKeymapConflicts(keymap) as Partial<Record<CommandId, CommandId[]>>;
}

/** Canonical chord to store for a keydown; "" for a bare modifier, so a recorder
 *  can wait while ⌘ is held. */
export function chordForEvent(event: CommandKeyEventLike): string {
  return rawChordForEvent(event);
}

export function jumpCommands(): Command[] {
  return COMMANDS.filter((command) => command.jump).sort((left, right) => (left.jump ?? 0) - (right.jump ?? 0));
}

export function jumpNumber(id: CommandId): number | undefined {
  const match = /^jump-([1-9])$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

const STORAGE_KEY = "telar:keybindings";

type KeybindingsBridge = {
  get?: () => Promise<Partial<Keymap>>;
  set?: (overrides: Partial<Keymap>) => Promise<Partial<Keymap>>;
  capture?: (capturing: boolean) => Promise<unknown>;
  /** Optional: an older shell keeps its accelerators. */
  scope?: (chords: readonly string[]) => Promise<unknown>;
};

function shell(): KeybindingsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { keybindings?: KeybindingsBridge } }).telarDesktop?.keybindings;
}

function safeStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Total parse: a corrupt record reads as a first run. */
export function readOverrides(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Partial<Keymap> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Normalises a hand-edited record and drops commands that no longer exist.
    return keymapOverrides(mergeKeymap(parsed as Partial<Keymap>));
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let cached: Keymap | undefined;

function announce() {
  for (const listener of listeners) listener();
}

/** The cockpit is the single writer; the shell's copy only makes the menu right at launch. */
function commit(overrides: Partial<Keymap>) {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Full or disabled storage: the live keymap still works, it just won't survive a reload.
  }
  cached = mergeKeymap(overrides);
  announce();
  void shell()?.set?.(overrides);
}

export function subscribeKeymap(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function keymapSnapshot(): Keymap {
  cached ??= mergeKeymap(readOverrides());
  return cached;
}

export function serverKeymapSnapshot(): Keymap {
  serverCache ??= defaultKeymap();
  return serverCache;
}
let serverCache: Keymap | undefined;

/** "" unbinds. */
export function setChord(id: CommandId, chord: string) {
  const next = { ...keymapSnapshot(), [id]: normalizeChord(chord) };
  commit(keymapOverrides(next));
}

export function setChords(chords: Partial<Record<CommandId, string>>) {
  const next = { ...keymapSnapshot() };
  for (const [id, chord] of Object.entries(chords)) next[id as CommandId] = normalizeChord(chord ?? "");
  commit(keymapOverrides(next));
}

export function restoreDefaultKeymap() {
  commit({});
}

/**
 * Adopts the shell's overrides when this renderer has none (site data cleared);
 * otherwise pushes this renderer's overrides to the shell.
 */
export async function syncKeymapWithShell(): Promise<void> {
  const bridge = shell();
  if (!bridge) return;
  const mine = readOverrides();
  if (Object.keys(mine).length > 0) {
    void bridge.set?.(mine);
    return;
  }
  try {
    const theirs = await bridge.get?.();
    if (!theirs || Object.keys(theirs).length === 0) return;
    const overrides = keymapOverrides(mergeKeymap(theirs));
    try {
      safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      // No storage: the live keymap below still applies.
    }
    cached = mergeKeymap(overrides);
    announce();
  } catch {
    // An older shell with no keybindings channel.
  }
}

/**
 * While a row records, nothing else may answer the press: the dispatcher checks
 * this flag and the shell strips menu accelerators, which macOS would otherwise
 * match before the page sees the keydown. Role menus (⌘Q, ⌘C) stay unrecordable.
 */
let capturing = false;

export function isCapturingChord(): boolean {
  return capturing;
}

export function setChordCapture(next: boolean) {
  if (capturing === next) return;
  capturing = next;
  void shell()?.capture?.(next);
}

/**
 * A mounted surface claims chords so macOS menu key equivalents (e.g. ⌘1..⌘9 on
 * `jump-N`) stop firing ahead of it. Release is the effect cleanup, never a handler.
 * A stack, because nested palettes can hold claims at once.
 */
const chordClaims: Array<readonly string[]> = [];

export function claimChords(chords: readonly string[]): () => void {
  // Identity releases, so two identical claims stay two claims.
  const claim: readonly string[] = [...chords];
  chordClaims.push(claim);
  announceClaims();
  return () => {
    const at = chordClaims.lastIndexOf(claim);
    // A double cleanup is StrictMode, not an error.
    if (at < 0) return;
    chordClaims.splice(at, 1);
    announceClaims();
  };
}

export function claimedChords(): string[] {
  const chords = new Set<string>();
  for (const claim of chordClaims) {
    for (const chord of claim) {
      const normalized = normalizeChord(chord);
      if (normalized !== "") chords.add(normalized);
    }
  }
  return [...chords];
}

export function claimedCommandIds(keymap: Keymap): CommandId[] {
  if (chordClaims.length === 0) return [];
  return rawClaimedCommandIds(keymap, claimedChords()) as CommandId[];
}

/** Tells the shell to strip these accelerators; in a browser the dispatcher alone stands down. */
function announceClaims() {
  void shell()?.scope?.(claimedChords());
}

/** Bound only while the component that can do it is mounted; unbound is not an error. */
export type CommandHandlers = Partial<Record<CommandId, () => void>>;

/** Newest binder wins per command; unbinding restores the one beneath. */
const bound = new Map<CommandId, Array<() => void>>();

export function bindCommands(handlers: CommandHandlers): () => void {
  const entries = Object.entries(handlers).filter(([, run]) => typeof run === "function") as [CommandId, () => void][];
  for (const [id, run] of entries) {
    const stack = bound.get(id) ?? [];
    stack.push(run);
    bound.set(id, stack);
  }
  return () => {
    for (const [id, run] of entries) {
      const stack = bound.get(id);
      if (!stack) continue;
      const at = stack.lastIndexOf(run);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) bound.delete(id);
    }
  };
}

export function commandHandler(id: CommandId): (() => void) | undefined {
  const stack = bound.get(id);
  return stack?.[stack.length - 1];
}

/** Returns whether anything was bound, so the dispatcher can fall back to `commandDestination`. */
export function runCommand(id: CommandId): boolean {
  const run = commandHandler(id);
  if (!run) return false;
  run();
  return true;
}
