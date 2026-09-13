/**
 * WHICH APP "OPEN" MEANS, AND THE ORDER THE MENU PUTS THEM IN.
 *
 * The old control asked the same question every time: a folder glyph, a
 * popover, pick your editor, again tomorrow. People do not rotate editors —
 * they have one, and they open their work in it several times an hour, so the
 * question had a known answer and was asked anyway. This module holds the
 * answer, and the two rules that make remembering it safe.
 *
 * WRITTEN ON EVERY OPEN, NEVER CONFIGURED. There is no setting; the preference
 * is a side effect of using the thing. Picking Zed once makes the button say
 * "Open in Zed" from then on, and picking something else once changes it back.
 * A "default editor" setting would be a second place to state a fact the last
 * click already stated, and the two would disagree.
 *
 * ON EVERY OPEN, AND ONLY ON AN OPEN: revealing in Finder is in the same menu
 * but teaches the button nothing, because it is a look rather than an open.
 * `remembersOpener` is the one place that distinction lives.
 *
 * BEFORE YOU HAVE SAID ANYTHING, IT REVEALS (#384). The half used to guess an
 * editor — VS Code, else whatever was installed — and a guess is what this
 * control cannot afford: one click launches it. `workspaceOpenerPrimary` says
 * why Finder is the answer that can never be the wrong one.
 *
 * KEYED PER MACHINE. The value is an opener id, and an opener id is only
 * meaningful against the app list of the machine that reported it — this Mac's
 * `zed` is not the Mac mini's anything if Zed is not installed there. One
 * shared key would hand a remembered preference to a machine that cannot
 * honour it, which is how a one-click button becomes a one-click error.
 *
 * AND IT IS RE-VALIDATED ON EVERY RENDER, not just on write: an editor
 * uninstalled since the last open must not leave a button promising to launch
 * it. An unmatched preference is simply not applied — the control falls back to
 * its first-run shape rather than failing at the moment it is pressed.
 *
 * Pure: the storage object is a parameter, so every rule below is a unit test
 * rather than a browser.
 */

/** The one entry that is not an installed app. Reserved, so a future opener id
 *  colliding with it is a test failure rather than a menu that opens the wrong
 *  thing. `SYSTEM_OPENER_ID` is kept only to keep that reservation standing —
 *  the row it named is gone (see `workspaceOpenerEntries`). */
export const SYSTEM_OPENER_ID = "system";
export const REVEAL_OPENER_ID = "reveal";

/** What the shell reported: an installed app that can open a folder. Structural
 *  rather than imported so this module stays free of the desktop bridge. */
export type OpenerLike = { id: string; label: string; path?: string; icon?: string };

export type WorkspaceOpenerEntryKind =
  /** An installed app, launched by id through the shell. */
  | "opener"
  /** Show it in the file manager instead of opening it. In T3's list and in
   *  this one, revealing lives in the same menu rather than in a separate
   *  control beside it — it is the same question ("where do I want this
   *  folder?") and splitting it into its own button asks it twice.
   *
   *  IT IS STILL NOT AN OPEN, and `remembersOpener` is where that matters: it
   *  is the left half until you pick an editor, and picking it back afterwards
   *  must not un-teach the editor you chose. */
  | "reveal"
  /** Nothing is installed. A row, not a missing row, so the menu explains its
   *  own shortness. */
  | "empty";

export type WorkspaceOpenerEntry = {
  /** The preference key, and the menu's React key. */
  id: string;
  /** The row's own words. */
  label: string;
  /** The split button's left half when this entry is what the half does. A verb
   *  phrase, because that half is a button that acts rather than a label.
   *
   *  PRESENT ON THE REVEAL ROW TOO, which is what changed with #384: revealing
   *  is the left half before an editor has been picked, so it needs words for
   *  it. That is a separate question from `remembersOpener` — being the default
   *  is not being remembered. */
  primaryLabel?: string;
  kind: WorkspaceOpenerEntryKind;
  /** Brand mark id from the shell's opener table; absent means the neutral
   *  glyph. */
  icon?: string;
  /** What to name when asking the shell to launch it. Absent on every entry
   *  that is not an installed app. */
  openerId?: string;
  /** The app bundle's path, for the row's tooltip. */
  path?: string;
  preferred?: boolean;
  /** Draw a hairline above this row. Computed here so the component renders a
   *  list and does not re-derive the grouping. */
  separatorBefore?: boolean;
  /** Rendered on the preferred row only — the menu teaches the shortcut for the
   *  thing you actually use, not for all fourteen. */
  shortcut?: string;
};

const KEY_PREFIX = "telar:workspace-opener:v1";
/** The key a session with no host named belongs to — the machine running this
 *  cockpit, which is the only one whose openers can be enumerated today. */
const LOCAL = "local";

export function workspaceOpenerPreferenceKey(hostId?: string): string {
  return `${KEY_PREFIX}:${hostId || LOCAL}`;
}

/**
 * The remembered id for one machine, or undefined.
 *
 * Every failure is undefined rather than a throw: a preference is a convenience,
 * and Safari in private mode, a quota error or a value somebody typed into
 * devtools must each cost the one-click shortcut and nothing else.
 */
export function readPreferredOpener(hostId: string | undefined, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | undefined {
  try {
    const raw = storage?.getItem(workspaceOpenerPreferenceKey(hostId));
    return raw ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Remember `id` for `hostId`. Called on every OPEN and never on a reveal;
 *  `remembersOpener` holds that line and says why. Whatever you last opened
 *  with is what the button offers next. */
export function writePreferredOpener(
  hostId: string | undefined,
  id: string,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(workspaceOpenerPreferenceKey(hostId), id);
  } catch {
    // A browser that will not store it still opened the folder. Nothing to say.
  }
  cached.set(workspaceOpenerPreferenceKey(hostId), id);
  for (const listener of listeners) listener();
}

/**
 * Read through `useSyncExternalStore`, the shape editor-wrap.ts already uses:
 * the preference lives outside React, and the hook's server snapshot is what
 * keeps the first client render agreeing with the markup the server produced —
 * there is no `localStorage` there, so both start at "no preference" and the
 * value arrives in the same commit as everything else.
 *
 * The snapshot is CACHED because the hook compares by identity and would spin
 * on a fresh read each render. One entry per machine, so two hosts do not share
 * one cached answer.
 */
const listeners = new Set<() => void>();
const cached = new Map<string, string | undefined>();

export function subscribePreferredOpener(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function preferredOpenerSnapshot(hostId?: string): string | undefined {
  const key = workspaceOpenerPreferenceKey(hostId);
  if (!cached.has(key)) cached.set(key, readPreferredOpener(hostId));
  return cached.get(key);
}

/** The server has no storage, so it renders "Open" and hydration agrees. */
export function serverPreferredOpenerSnapshot(): string | undefined {
  return undefined;
}

/**
 * The menu, in the order it is drawn: the preferred entry alone at the top,
 * then everything else in the shell's curated order, then the two that are not
 * apps.
 *
 * HOISTING RATHER THAN HIGHLIGHTING. The preferred entry is already on the
 * button's left half, so its row in the list is mostly there for the shortcut
 * hint and for "yes, that is the one". Putting it first means the pointer
 * travels the same distance to the second-most-likely choice every time,
 * instead of hunting for wherever the preferred app happens to sort.
 *
 * `preferred` that matches nothing installed is ignored — see the module note.
 */
export function workspaceOpenerEntries(input: {
  /** What the shell found, in its curated order. `undefined` while the answer
   *  is still in flight; an empty array means "none installed". */
  openers: readonly OpenerLike[];
  preferred?: string | undefined;
  /** The chord bound to opening the workspace, if anything binds one. */
  shortcut?: string | undefined;
}): WorkspaceOpenerEntry[] {
  const apps: WorkspaceOpenerEntry[] = input.openers.map((opener) => ({
    id: opener.id,
    label: opener.label,
    primaryLabel: `Open in ${opener.label}`,
    kind: "opener",
    openerId: opener.id,
    ...(opener.icon ? { icon: opener.icon } : {}),
    ...(opener.path ? { path: opener.path } : {}),
  }));

  /**
   * NO "SYSTEM DEFAULT" ROW (issue #384). Handing a folder to whatever the OS
   * happens to associate with it answers a question nobody asked — on a Mac it
   * is Finder, which the row below names properly and wears the right mark for,
   * so the two rows were the same gesture with one of them unable to say what
   * it would do.
   */
  const natural: WorkspaceOpenerEntry[] = [
    ...(apps.length > 0 ? apps : [{ id: "none", label: "No installed editors found", kind: "empty" as const }]),
    { id: REVEAL_OPENER_ID, label: "Reveal in Finder", primaryLabel: "Reveal in Finder", kind: "reveal", icon: REVEAL_OPENER_ID },
  ];

  // Applied on READ as well as on write, so a "reveal" stored by an earlier
  // build is ignored rather than pinned to somebody's button forever.
  const chosen = natural.find((entry) => entry.id === input.preferred && remembersOpener(entry));
  const ordered = chosen ? [chosen, ...natural.filter((entry) => entry !== chosen)] : natural;

  return ordered.map((entry, index) => ({
    ...entry,
    ...(entry === chosen ? { preferred: true } : {}),
    ...(entry === chosen && input.shortcut ? { shortcut: input.shortcut } : {}),
    // A line under the hoisted entry, and a line where installed apps give way
    // to the two that are not apps. Both rules can want the same line; a
    // boolean means they cannot draw two.
    ...(index > 0 && ((index === 1 && Boolean(chosen)) || groupOf(entry) !== groupOf(ordered[index - 1]!)) ? { separatorBefore: true } : {}),
  }));
}

/**
 * WHETHER USING THIS ENTRY TEACHES THE BUTTON ANYTHING.
 *
 * The button remembers the last app you OPENED the folder in. Revealing is not
 * that: it is a look — you wanted to see where the folder lives, not to work in
 * it. It is the left half by DEFAULT now (#384), which is a different claim: a
 * default is what happens before you have said anything, and pressing it says
 * nothing, so an editor you have already chosen is not undone by one glance.
 *
 * The inert "nothing installed" row is excluded for the plainer reason that it
 * is not a choice at all.
 */
export function remembersOpener(entry: Pick<WorkspaceOpenerEntry, "kind">): boolean {
  return entry.kind === "opener";
}

/**
 * What the split button's left half does, and therefore says.
 *
 * TWO ANSWERS: what you last opened with, and failing that Finder.
 *
 * IT USED TO GUESS AN EDITOR — VS Code, then whatever the machine had — and a
 * guess is the one thing this half cannot afford. It launches on a single
 * click, so guessing wrong opens a folder in an application somebody did not
 * ask for, and on a machine with two editors installed the guess is a coin
 * toss about which one they work in. Finder is the answer that is never wrong
 * about what it is: it SHOWS you the folder and decides nothing, and the first
 * pick from the menu replaces it for good (`remembersOpener`).
 *
 * Undefined only while the shell's list has not arrived — the reveal entry is
 * always there once it has, so the half always has something to name.
 */
export function workspaceOpenerPrimary(entries: readonly WorkspaceOpenerEntry[]): WorkspaceOpenerEntry | undefined {
  const first = entries[0];
  if (first?.preferred) return first;
  return entries.find((entry) => entry.kind === "reveal");
}

export function workspaceOpenerPrimaryLabel(entries: readonly WorkspaceOpenerEntry[]): string {
  return workspaceOpenerPrimary(entries)?.primaryLabel ?? "Open";
}

/** Apps on one side of the hairline, the not-apps on the other. */
function groupOf(entry: WorkspaceOpenerEntry): "app" | "tool" {
  return entry.kind === "opener" || entry.kind === "empty" ? "app" : "tool";
}

function safeStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
