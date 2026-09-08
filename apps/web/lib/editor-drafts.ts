/**
 * UNSAVED TEXT, KEPT WHERE UNMOUNTING CANNOT REACH IT.
 *
 * THE HOLE THIS CLOSES. Only the file you are looking at is mounted — the
 * alternative is every open file holding a read, a save coordinator and a
 * re-read on every settled turn — so switching files UNMOUNTS the editor you
 * were typing in. That is fine for text that reached disk: the coordinator
 * flushes rather than cancels on the way out (lib/save-coordinator.ts). It is
 * not fine for text that COULD NOT reach disk. A refused write — the agent
 * changed the file under you — leaves the only copy of your edit in a component
 * that is about to be thrown away, and re-opening the file would read the disk
 * and show you the agent's version as though nothing had happened. A red dot in
 * the tab strip is not preservation; this is.
 *
 * A MODULE-LEVEL STORE, deliberately, and not a ref in the Editor: the Editor
 * unmounts too — the panel closes, the cockpit navigates, the session changes —
 * and every one of those boundaries is above the component that holds the text.
 * The store outlives all of them.
 *
 * THE BASELINE TRAVELS WITH THE TEXT, and that is the part it would be
 * dangerous to leave out. A write carries the hash of the read it was made
 * from, which is how the engine refuses to overwrite what it did not show you.
 * If a re-opened file adopted its stashed draft but wrote against the FRESH
 * read's hash, the write would succeed and silently destroy whatever changed
 * the file — turning "your edit was refused" into "your edit won". So the stash
 * carries the baseline it was edited against, the re-mounted editor writes
 * against that, and a file that moved on disk is refused a second time, which
 * is the honest answer.
 *
 * IN MEMORY ONLY. It survives every unmount inside one page; it does not
 * survive a reload or a closed window, which is where an unsaved textarea has
 * always ended in this app.
 */

/** One file's unsaved text, and what it was edited against. */
export type EditorDraft = {
  text: string;
  /** The `sha256` of the read this edit began from — see the note above. */
  baseline: string;
  /** Why the last write did not land, when one did not. `refused` is the case
   *  that makes this store load-bearing rather than a convenience. */
  problem?: { refused: boolean; reason: string };
};

/**
 * WHICH CHECKOUT THE PATH IS IN. Two sessions can hold the same path with
 * different bytes — a worktree per session is the normal case here — so a
 * scope-less key would hand one session's unsaved text to another's editor.
 */
export function draftScope(sessionId?: string, projectId?: string): string {
  return sessionId ? `session:${sessionId}` : projectId ? `project:${projectId}` : "none";
}

const drafts = new Map<string, EditorDraft>();

/** A separator no path and no scope can contain, written as an ESCAPE rather
 *  than typed — a literal control character in source is what
 *  lib/no-invisible-characters.test.ts exists to catch. */
function key(scope: string, path: string): string {
  return `${scope}\u0000${path}`;
}

export function rememberDraft(scope: string, path: string, draft: EditorDraft): void {
  drafts.set(key(scope, path), draft);
}

export function readDraft(scope: string, path: string): EditorDraft | undefined {
  return drafts.get(key(scope, path));
}

/** The text reached disk, or was deliberately discarded. Both mean the stash is
 *  no longer the truth about this file, and keeping it would resurrect an old
 *  edit the next time the file was opened. */
export function forgetDraft(scope: string, path: string): void {
  drafts.delete(key(scope, path));
}

/** Only for tests: the store is a singleton for the life of the page. */
export function clearDrafts(): void {
  drafts.clear();
}

/** How many files are holding unsaved text — for a test to assert nothing
 *  leaks, rather than for anything on screen. */
export function draftCount(): number {
  return drafts.size;
}
