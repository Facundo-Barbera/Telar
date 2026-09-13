/**
 * WHAT THE KEYBOARD DOES IN A FOLDER BROWSER — pure, so every rule is a test.
 *
 * The browser itself is a fetch, a list and an input; the part worth arguing
 * about is which key means what, and that is all here. Same split the palette
 * makes (`matchTargets`/`sourceRows` beside `project-palette.tsx`), and for the
 * same reason: a keystroke cannot be driven through a static render, so the
 * decision has to be a function that takes a key and answers with an intent.
 *
 * ONE FIELD THAT IS BOTH A BREADCRUMB AND AN ENTRY BOX, which is T3's shape and
 * the reason two keys are contextual:
 *
 *   - ENTER descends into the highlighted row — UNLESS the field has been
 *     typed in, in which case it goes where the field says. The field showing
 *     `~/code/` is the browser telling you where you are; the field showing
 *     `~/code/tel` is you telling it where to go, and Enter should not ignore
 *     what somebody just typed in favour of a row they never touched.
 *   - BACKSPACE goes up — UNLESS the field has been typed in, in which case it
 *     is a text key. Taking Backspace mid-word would delete somebody's typing
 *     by navigating away from it. (The palette draws the same line with an
 *     empty-field rule; here the field is never empty, so "edited" is the test.)
 *
 * ⌘ IS FOR THE THINGS THAT ARE NOT NAVIGATION. ⌘Enter takes the directory you
 * are IN rather than the row you are ON — the whole point of the gesture is
 * that you do not have to descend into a folder to choose it — and ⌘. toggles
 * dotfolders. A bare `.` cannot be the toggle: it is a character in half the
 * paths anybody types.
 */

// Type-only: `lib/fs-dirs.ts` is the route's own module and reads the
// filesystem, so this must never become a value import.
import type { DirectoryEntry } from "./fs-dirs";

/** Everything a key decision reads. The component owns it; this never writes. */
export type DirectoryBrowserState = {
  /** The field, verbatim — including what somebody is mid-way through typing. */
  field: string;
  /** The canonical directory whose children are listed. */
  path: string;
  /** One step up, or `null` at a browsable root. The engine decides. */
  parent: string | null;
  /** The engine's home, so `~` means the machine that ANSWERED. */
  home: string;
  entries: readonly DirectoryEntry[];
  index: number;
  hidden: boolean;
};

/** A keystroke, reduced to what changes the answer. */
export type DirectoryKey = { key: string; meta?: boolean; ctrl?: boolean };

/**
 * What a key meant. `none` is explicit rather than undefined, so a caller that
 * forwards unhandled keys to the input can tell "this was not for me" from
 * "this was for me and did nothing".
 */
export type DirectoryAction =
  | { type: "none" }
  /** Highlight this row. */
  | { type: "move"; index: number }
  /** List this directory. The path may not exist — the engine answers that. */
  | { type: "open"; path: string }
  /** Replace the field with this completion. */
  | { type: "complete"; field: string }
  | { type: "hidden"; hidden: boolean }
  /** Take this directory: register it, or clone into it. */
  | { type: "submit"; path: string };

const SEP = "/";

/** Trailing separators dropped, except from a bare root. */
function trimEnd(target: string): string {
  const trimmed = target.replace(/\/+$/, "");
  return trimmed || SEP;
}

/**
 * `~`, `~/code` and a typed absolute path, as the path to ask the engine for.
 *
 * `~someone` IS LEFT ALONE — another account's home is not this one's, and the
 * engine refuses it by name rather than this guessing what was meant.
 */
export function expandTilde(field: string, home: string): string {
  const input = field.trim();
  if (!input || input === "~" || input === "~/") return home;
  if (input.startsWith("~/")) return trimEnd(`${trimEnd(home)}${SEP}${input.slice(2)}`);
  return trimEnd(input);
}

/** `/Users/someone/code` → `~/code`, for the field. */
export function foldHome(target: string, home: string): string {
  const root = trimEnd(home);
  if (target === root) return "~";
  return target.startsWith(`${root}${SEP}`) ? `~${target.slice(root.length)}` : target;
}

/**
 * The field's text for a directory you are IN — folded, and with a trailing
 * separator.
 *
 * THE SLASH IS NOT DECORATION. It is what makes the field continue naturally:
 * `~/code/` plus three characters is a path under the folder you are looking
 * at, which is how a typed name and a completed one end up the same shape.
 */
export function directoryField(path: string, home: string): string {
  const folded = foldHome(path, home);
  return folded.endsWith(SEP) ? folded : `${folded}${SEP}`;
}

/** Somebody has typed in the field, so it is no longer the breadcrumb. */
export function edited(state: DirectoryBrowserState): boolean {
  return state.field !== directoryField(state.path, state.home);
}

/** The row the arrows are on, kept inside a list that may have just changed
 *  size under it. -1 for an empty listing, which has no row to be on. */
export function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(Math.max(index, 0), length - 1);
}

/** The longest prefix every one of these shares, case-sensitively — so a
 *  completion never changes a character somebody already typed. */
function commonPrefix(names: readonly string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0]!;
  for (const name of names.slice(1)) {
    let at = 0;
    while (at < prefix.length && at < name.length && prefix[at] === name[at]) at += 1;
    prefix = prefix.slice(0, at);
  }
  return prefix;
}

/**
 * What Tab would put in the field, or nothing.
 *
 * ONLY AGAINST THE LISTING IN FRONT OF YOU. The entries are this directory's,
 * so a field whose directory part is somewhere else has nothing to complete
 * against — completing it would need a second listing, and a browser that
 * fetches on every keystroke is one that flickers.
 *
 * A UNIQUE MATCH COMPLETES AND DESCENDS (it ends in a separator, so the next
 * keystroke continues inside it); several matches complete as far as they
 * agree, which is the shell behaviour everybody already has in their fingers.
 */
export function completion(state: DirectoryBrowserState): string | undefined {
  const cut = state.field.lastIndexOf(SEP);
  if (cut === -1) return undefined;
  const directory = state.field.slice(0, cut + 1);
  const seed = state.field.slice(cut + 1);
  if (!seed) return undefined;
  if (expandTilde(directory, state.home) !== trimEnd(state.path)) return undefined;
  const lower = seed.toLocaleLowerCase();
  const matches = state.entries.filter((entry) => entry.name.toLocaleLowerCase().startsWith(lower));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return `${directory}${matches[0]!.name}${SEP}`;
  const shared = commonPrefix(matches.map((entry) => entry.name));
  return shared.length > seed.length ? `${directory}${shared}` : undefined;
}

/**
 * The whole keyboard, as one fold.
 *
 * ⌘ AND ^ ARE THE SAME KEY HERE, as everywhere else in this cockpit: the
 * desktop app is a Mac and the browser tab may not be.
 */
export function directoryKey(state: DirectoryBrowserState, key: DirectoryKey): DirectoryAction {
  const command = Boolean(key.meta || key.ctrl);

  // TAKE WHERE YOU ARE, not where the highlight is. Descending into a folder
  // just to choose it is the step this gesture exists to remove.
  if (command && key.key === "Enter") return { type: "submit", path: state.path };
  if (command && key.key === ".") return { type: "hidden", hidden: !state.hidden };

  if (key.key === "ArrowDown" || key.key === "ArrowUp") {
    if (state.entries.length === 0) return { type: "none" };
    const delta = key.key === "ArrowDown" ? 1 : -1;
    const from = clampIndex(state.index, state.entries.length);
    return { type: "move", index: (from + delta + state.entries.length) % state.entries.length };
  }

  if (key.key === "Tab") {
    const completed = completion(state);
    return completed === undefined ? { type: "none" } : { type: "complete", field: completed };
  }

  if (key.key === "Enter") {
    // Typed text wins over a row nobody touched — see the note at the top.
    if (edited(state)) return { type: "open", path: expandTilde(state.field, state.home) };
    const row = state.entries[clampIndex(state.index, state.entries.length)];
    return row ? { type: "open", path: row.path } : { type: "none" };
  }

  if (key.key === "Backspace") {
    // A text key while somebody is typing; the up gesture only when the field
    // is still the breadcrumb.
    if (edited(state)) return { type: "none" };
    return state.parent ? { type: "open", path: state.parent } : { type: "none" };
  }

  return { type: "none" };
}

/**
 * WHERE THIS MAC'S BROWSER LAST WAS, per host.
 *
 * PER HOST, because the paths are a different machine's: reopening the browser
 * on a paired Mac at a directory that only exists on this one would start
 * every visit with a refusal. A remembered directory that has since been
 * deleted is the same story one step later, which is why the component treats
 * a failed first listing as "start at home" rather than an error.
 */
export function rememberedDirectoryKey(hostId: string | undefined): string {
  return `telar.directory-browser.${hostId && hostId !== "local" ? hostId : "local"}`;
}
