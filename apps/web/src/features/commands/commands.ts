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
} from "../../../../desktop/src/main/command-keys.js";

export { normalizeChord, resolveCommandForEvent };
export type { CommandKeyEventLike };

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

export function keymapConflicts(keymap: Keymap): Partial<Record<CommandId, CommandId[]>> {
  return rawKeymapConflicts(keymap) as Partial<Record<CommandId, CommandId[]>>;
}

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

function readOverrides(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Partial<Keymap> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
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

function commit(overrides: Partial<Keymap>) {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
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
    }
    cached = mergeKeymap(overrides);
    announce();
  } catch {
  }
}

let capturing = false;

export function isCapturingChord(): boolean {
  return capturing;
}

export function setChordCapture(next: boolean) {
  if (capturing === next) return;
  capturing = next;
  void shell()?.capture?.(next);
}

const chordClaims: Array<readonly string[]> = [];

export function claimChords(chords: readonly string[]): () => void {
  const claim: readonly string[] = [...chords];
  chordClaims.push(claim);
  announceClaims();
  return () => {
    const at = chordClaims.lastIndexOf(claim);
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

function announceClaims() {
  void shell()?.scope?.(claimedChords());
}

export type CommandHandlers = Partial<Record<CommandId, () => void>>;

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

export function runCommand(id: CommandId): boolean {
  const run = commandHandler(id);
  if (!run) return false;
  run();
  return true;
}
