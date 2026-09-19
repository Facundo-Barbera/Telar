/**
 * EVERY COMMAND THIS APP HAS A KEY FOR — the registry, the keymap over it, and
 * the place a component says "I am the one who can do this".
 *
 * THE TABLE LIVES ONCE, in plain CommonJS (`apps/desktop/command-keys.js`), so
 * Electron's real main process can `require` it without a build step. This file
 * is the only place in the cockpit that reaches across the app boundary to
 * import it; everything else imports THIS file. The reasoning for a relative
 * import over a `packages/*` dependency is in `docs/command-keys-web-port.md`
 * and still holds.
 *
 * THREE THINGS LIVE HERE, and they are one thing:
 *
 *   1. THE REGISTRY — id, label, group, default chord. Read straight off the
 *      shared table, typed here so the rest of the cockpit gets a closed union
 *      instead of `string`.
 *   2. THE KEYMAP — command id → chord, defaults from the registry with a
 *      person's overrides laid over them. Stored under a `telar:` localStorage
 *      key like every other cockpit preference, and MIRRORED to the desktop
 *      shell, which is what lets the application menu rebuild its accelerators
 *      the moment a chord changes (#367's named blocker).
 *   3. THE HANDLER BINDING POINT — `bindCommands`. A command is a NAME with no
 *      behaviour of its own; the component that can actually do the thing
 *      (the rail knows how to open a conversation, the panel knows how to go
 *      fullscreen) binds itself while it is mounted, and the dispatcher looks
 *      the name up. A module-level bus rather than a React context on purpose:
 *      the binders are scattered across the rail, the cockpit, the panel and
 *      the composer, and threading a provider through all four to deliver a
 *      callback would be ceremony around a `Map`.
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
} from "../../desktop/command-keys.js";

export { normalizeChord, resolveCommandForEvent };
export type { CommandKeyEventLike };

/**
 * The closed set of ids the table can produce. Kept in step with
 * `apps/desktop/command-keys.js` by the test beside this file, since TypeScript
 * cannot narrow a plain JS array's `.id` strings on its own.
 */
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

/** A chord per command. "" is a real value: deliberately unbound. */
export type Keymap = Record<CommandId, string>;

/** The order the settings pane draws the groups in — the order a person meets
 *  them in the app, not alphabetical. */
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

/** `{ [commandId]: [the other commands on that chord] }` — empty when the map
 *  is clean. See the shared table for why "" never counts as a collision. */
export function keymapConflicts(keymap: Keymap): Partial<Record<CommandId, CommandId[]>> {
  return rawKeymapConflicts(keymap) as Partial<Record<CommandId, CommandId[]>>;
}

/** The chord to STORE for a keydown, canonical and Shift-safe. "" when the
 *  press was a bare modifier — which is what lets a recorder sit there while
 *  ⌘ is held and wait for the key that finishes the chord. */
export function chordForEvent(event: CommandKeyEventLike): string {
  return rawChordForEvent(event);
}

/** The nine jump commands, in order. One idea generated nine times, and the
 *  settings pane folds them back into one row. */
export function jumpCommands(): Command[] {
  return COMMANDS.filter((command) => command.jump).sort((left, right) => (left.jump ?? 0) - (right.jump ?? 0));
}

/** For a jump-N id, which N (1-9); undefined for every other command. */
export function jumpNumber(id: CommandId): number | undefined {
  const match = /^jump-([1-9])$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

// --- The store ---------------------------------------------------------------

const STORAGE_KEY = "telar:keybindings";

/**
 * The desktop shell's half of the keymap. Declared locally, as
 * `lib/desktop-appearance.ts` declares its own: a global `Window` augmentation
 * would imply the shell is always there, and in a browser tab it is not.
 */
type KeybindingsBridge = {
  get?: () => Promise<Partial<Keymap>>;
  set?: (overrides: Partial<Keymap>) => Promise<Partial<Keymap>>;
  capture?: (capturing: boolean) => Promise<unknown>;
  /** The chords a surface on screen has claimed (#656). Optional like the rest:
   *  an older shell simply keeps its accelerators and the renderer's own half of
   *  the suppression still holds. */
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

/** What is on disk, sparse and unvalidated. Parsing is deliberately total: a
 *  corrupt record is a first run, never a cockpit that will not paint. */
export function readOverrides(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Partial<Keymap> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Round-tripped through the shared merge so a hand-edited record is
    // normalised (and anything naming a command that no longer exists dropped)
    // before it can reach a menu or a match.
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

/**
 * Persist a new set of overrides, tell every reader, and hand the shell its
 * copy — which is what makes the application menu rebuild.
 *
 * THE COCKPIT IS THE WRITER, the shell is a mirror. One writer means the two
 * cannot disagree about which is newer; the shell's copy exists so the menu is
 * already right at launch, before the renderer has booted far enough to say so.
 */
function commit(overrides: Partial<Keymap>) {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // A full or disabled localStorage must not break the keys that are already
    // live in this tab — they just will not survive a reload.
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

/** The server has no storage, so it renders the defaults and hydration agrees. */
export function serverKeymapSnapshot(): Keymap {
  serverCache ??= defaultKeymap();
  return serverCache;
}
let serverCache: Keymap | undefined;

/** Rebind one command. Passing "" unbinds it, which the pane offers. */
export function setChord(id: CommandId, chord: string) {
  const next = { ...keymapSnapshot(), [id]: normalizeChord(chord) };
  commit(keymapOverrides(next));
}

/** Rebind several at once — what the folded jump row needs, since ⌘1..⌘9 move
 *  together or the row is lying about being one binding. */
export function setChords(chords: Partial<Record<CommandId, string>>) {
  const next = { ...keymapSnapshot() };
  for (const [id, chord] of Object.entries(chords)) next[id as CommandId] = normalizeChord(chord ?? "");
  commit(keymapOverrides(next));
}

export function restoreDefaultKeymap() {
  commit({});
}

/**
 * Adopt the shell's stored overrides when this renderer has none of its own.
 *
 * The two copies only ever diverge one way — a cockpit whose site data was
 * cleared still runs inside a shell that remembers — and silently reverting
 * somebody's chords because a cache was emptied is worse than the one extra
 * round trip on boot. A renderer that HAS overrides pushes them instead, so the
 * shell is correct from the first paint of the session.
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
      // See `commit` — a tab with no storage still gets the live keymap below.
    }
    cached = mergeKeymap(overrides);
    announce();
  } catch {
    // An older shell with no keybindings channel: the defaults are correct.
  }
}

/**
 * A ROW IS RECORDING — SO NOTHING ELSE MAY ANSWER THE NEXT PRESS.
 *
 * THIS IS WHAT MAKES THE PANE USABLE AT ALL, and it is not a nicety. Press ⇧⌘D
 * over a recording row and, without this, two other things get there first: the
 * cockpit's own dispatcher fires "Open Diff", and — on the desktop — macOS
 * matches the application menu's key equivalent and never delivers the keydown
 * to the page. The chords a person most wants to change are exactly the ones
 * already bound, so the pane would fail on precisely its own subject.
 *
 * BOTH HALVES ARE TOLD. The dispatcher checks this flag; the shell rebuilds its
 * menu with the accelerators stripped, and puts them back when recording ends.
 * Role menus (Edit, Window, the app menu) keep theirs, so ⌘Q and ⌘C stay
 * unrecordable inside the shell — they are the OS's, and binding a Telar command
 * over one would be a bug rather than a preference.
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

// --- Chord scopes (issue #656) -----------------------------------------------

/**
 * A SURFACE OWNS THESE CHORDS WHILE IT IS UP.
 *
 * THE BUG THIS EXISTS FOR: the New Conversation palette numbers its rows ⌘1..⌘9
 * and never got to answer any of them. `jump-1`..`jump-9` carry `menu: "file"`,
 * so macOS matched the File menu's key equivalent and the keydown never reached
 * the page — the palette's handler was dead code on the desktop, and pressing ⌘1
 * switched conversations and threw away what you were composing.
 *
 * A CLAIM IS A REGISTRATION WITH A LIFETIME, exactly like `bindCommands` beside
 * it, and that is the whole reliability argument. Nothing in a dismissal path
 * has to remember to give the chords back: Escape, a click on the backdrop and
 * an unmount mid-animation all end the same React effect, and the effect's
 * cleanup is the release. A suppression released by a HANDLER would leak the
 * first time somebody found a fourth way to close the thing — and a leak here
 * leaves the rail's shortcut dead, which is worse than the bug it fixed.
 *
 * A STACK, newest-wins-by-union, for the same reason `bound` is one: the command
 * palette embeds the project palette's pages inside its own dialog, so two
 * claims can be live at once and releasing the inner one must not take the
 * outer one's chords with it.
 *
 * WHICH COMMANDS THAT SUPPRESSES IS NOT DECIDED HERE — `claimedCommandIds` in
 * the shared table computes it against the live keymap, so the shell's menu and
 * this renderer's dispatcher suppress exactly the same set. See its comment for
 * why a claim names CHORDS and never command ids.
 */
const chordClaims: Array<readonly string[]> = [];

export function claimChords(chords: readonly string[]): () => void {
  // A fresh array per claim, so identity is what releases — two surfaces
  // claiming the same nine chords are two claims, not one shared by accident.
  const claim: readonly string[] = [...chords];
  chordClaims.push(claim);
  announceClaims();
  return () => {
    const at = chordClaims.lastIndexOf(claim);
    // Already released: a double cleanup is not an error, it is StrictMode.
    if (at < 0) return;
    chordClaims.splice(at, 1);
    announceClaims();
  };
}

/** Every chord currently spoken for, canonical and de-duplicated. */
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

/** The commands a live claim suppresses under this keymap. Empty — the common
 *  case, with nothing on screen claiming anything — without touching the map. */
export function claimedCommandIds(keymap: Keymap): CommandId[] {
  if (chordClaims.length === 0) return [];
  return rawClaimedCommandIds(keymap, claimedChords()) as CommandId[];
}

/**
 * Tell the shell, which is where the fix actually lands on macOS: the menu is
 * rebuilt with these accelerators stripped, so the key equivalent stops being
 * matched ahead of the page. The same mirror `setChordCapture` uses, and it
 * degrades the same way — in a browser tab there is no shell, and the renderer's
 * own dispatcher is the only half that needs to stand down.
 */
function announceClaims() {
  void shell()?.scope?.(claimedChords());
}

// --- The handler binding point -----------------------------------------------

/**
 * What a command DOES here — supplied by whichever component can actually do
 * it, only while that component is mounted.
 *
 * A command with nobody bound is not an error and must not be: ⌘⌥F means
 * nothing on the projects list, and a key that beeped or logged on every route
 * but one would be worse than a key that quietly waits for the surface it
 * belongs to.
 */
export type CommandHandlers = Partial<Record<CommandId, () => void>>;

/** Newest binder wins per command, and unbinding restores whoever was under it
 *  — so two Editors, or a cockpit and the panel inside it, can both claim a
 *  command and the one on top gets it. */
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

/** Run whatever is bound. Answers whether anything was, so the dispatcher can
 *  fall back to the built-in destination for the commands that are pure
 *  navigation and need no component to own them. */
export function runCommand(id: CommandId): boolean {
  const run = commandHandler(id);
  if (!run) return false;
  run();
  return true;
}
