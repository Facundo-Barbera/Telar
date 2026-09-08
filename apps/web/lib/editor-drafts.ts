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
 * AND EVERY MUTATION IS OWNED, which is the other half and the subtler one.
 * Because a write outlives the mount that started it, TWO editors of the same
 * file overlap in time: the one that was switched away from, still waiting on
 * its answer, and the one you re-opened and are typing in now. The old one's
 * answer must not touch the new one's text — not clear it when its write lands,
 * and above all not overwrite it with the older text when its write is refused.
 * So a mount CLAIMS the key when it adopts it, and a mutation from anyone but
 * the current owner is dropped. Losing an old edit that was already superseded
 * is correct; losing the newer one is the bug this prevents.
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

/** Who may mutate a key: one mount of one editor. Opaque and per-mount. */
export type DraftOwner = string;

let minted = 0;

export function newDraftOwner(): DraftOwner {
  minted += 1;
  return `owner_${minted}`;
}

/**
 * WHICH CHECKOUT THE PATH IS IN — and on WHICH MAC.
 *
 * Two sessions can hold the same path with different bytes (a worktree per
 * session is the normal case here), so a scope-less key would hand one
 * session's unsaved text to another's editor. And session ids are minted per
 * engine, so two Macs can mint the SAME id: without the host in the key, this
 * module — which is one global Map for the whole page — would hand host A's
 * unsaved text to an editor open on host B.
 */
export function draftScope(hostId: string | undefined, sessionId?: string, projectId?: string): string {
  const host = hostId && hostId.length > 0 ? hostId : "local";
  return `${host} ${sessionId ? `session:${sessionId}` : projectId ? `project:${projectId}` : "none"}`;
}

const drafts = new Map<string, EditorDraft>();
/** Notebook cell text, which is the same problem one level down — see
 *  `rememberCellDraft`. */
const cells = new Map<string, string>();

/**
 * WHO HOLDS EACH KEY — kept SEPARATELY from the text, and that separation is
 * the whole point.
 *
 * Ownership stored ON the draft only exists while a draft does, which leaves a
 * window exactly where the danger is. Take: mount A's write is in the air, you
 * re-open the file so mount B claims it, B types and B's write LANDS — clearing
 * the text, and with it A's lock-out. A's answer arrives a moment later, finds
 * an empty key, and is allowed to write its stale text back. The file is clean
 * on disk and the Editor now offers to restore an edit from two mounts ago. A
 * deliberate discard had the same hole: emptying the key re-opened it.
 *
 * So the key is owned whether or not it holds anything. Claiming an EMPTY key
 * is meaningful — it says "this mount is the one that speaks for this file
 * now" — clearing the text leaves the ownership standing, and a discard bumps
 * it to a generation nobody holds, so the only way to write again is to claim.
 */
const owners = new Map<string, DraftOwner>();
/**
 * AND NOTHING EVICTS FROM IT, which is a deliberate choice and not an
 * oversight.
 *
 * A capped, oldest-first version of this map was the obvious way to keep it
 * from growing, and it is unsound in both directions at once. Forgetting a key
 * makes it unclaimed again, so the stale mount this whole mechanism exists to
 * stop is allowed to write — the resurrection is merely delayed until 512 other
 * files have been claimed. And the eviction cannot tell a dead owner's record
 * from a LIVE one: a notebook with more than 512 cells evicts the ownership of
 * cells its own mount is still typing into. Tightening "unclaimed" to "refuse"
 * fixes the first hole by making the second one worse — the live editor's
 * keystrokes stop being stashed.
 *
 * So every key keeps its owner for the life of the page. What that costs is one
 * short string per file (or notebook cell) opened in one page session, and it
 * buys an invariant with no expiry date in it: a key that has ever been claimed
 * can only be written by whoever claimed it last.
 */

/** A separator no scope, path or cell id can contain, written as an ESCAPE
 *  rather than typed — a literal control character in source is what
 *  lib/no-invisible-characters.test.ts exists to catch. */
function key(scope: string, path: string, cellId?: string): string {
  return cellId === undefined ? `${scope}\u0000${path}` : `${scope}\u0000${path}\u0000${cellId}`;
}

/** Take the key — with or without text on it — and answer what was there. */
function claim<T>(store: Map<string, T>, at: string, owner: DraftOwner): T | undefined {
  take(at, owner);
  return store.get(at);
}

function take(at: string, owner: DraftOwner): void {
  owners.set(at, owner);
}

/** May this owner write here? Yes if it holds the key, or if nobody does —
 *  an unclaimed key belongs to whoever gets there first. */
function held(at: string, owner: DraftOwner): boolean {
  const current = owners.get(at);
  return current === undefined || current === owner;
}

function put<T>(store: Map<string, T>, at: string, owner: DraftOwner, value: T): boolean {
  if (!held(at, owner)) return false;
  take(at, owner);
  store.set(at, value);
  return true;
}

/**
 * Clear the text, KEEPING the ownership. The key stays this mount's until
 * somebody else claims it, so a slower answer from a mount that has gone
 * cannot write into the gap the clearing just opened.
 */
function drop<T>(store: Map<string, T>, at: string, owner: DraftOwner): boolean {
  if (owners.get(at) !== owner || !store.has(at)) return false;
  store.delete(at);
  return true;
}

/** Keep this text, if this owner still holds the key. Answers whether it did. */
export function rememberDraft(scope: string, path: string, draft: EditorDraft, owner: DraftOwner): boolean {
  return put(drafts, key(scope, path), owner, draft);
}

/** Read WITHOUT taking the key — for deciding what to show. */
export function readDraft(scope: string, path: string): EditorDraft | undefined {
  return drafts.get(key(scope, path));
}

/** Read AND take the key: what a mount does when it adopts unsaved text, so
 *  the previous mount's answer can no longer touch it. */
export function claimDraft(scope: string, path: string, owner: DraftOwner): EditorDraft | undefined {
  return claim(drafts, key(scope, path), owner);
}

/**
 * The text reached disk, or was deliberately discarded — so the stash is no
 * longer the truth about this file and keeping it would resurrect an old edit
 * the next time the file was opened. Owner-guarded for the same reason writing
 * is: an old mount's write landing must not clear the text somebody has typed
 * since.
 */
export function forgetDraft(scope: string, path: string, owner: DraftOwner): boolean {
  return drop(drafts, key(scope, path), owner);
}

/**
 * THROW THE TEXT AWAY BECAUSE A PERSON SAID SO — closing a refused file after
 * the second, deliberate click.
 *
 * NOT owner-guarded, and that is the distinction the guard is for: ownership
 * exists to stop a LATE ANSWER from a mount that has gone away, not to stop the
 * human in front of the Editor. The Editor is not the mount that claimed the
 * key — the file surface is, and it may already be unmounted — so an
 * owner-guarded delete here would quietly fail and the discarded text would
 * come back the next time the file was opened.
 */
export function discardDraft(scope: string, path: string): void {
  const at = key(scope, path);
  drafts.delete(at);
  // AND THE KEY CHANGES HANDS, to a generation nobody is holding. Deleting the
  // ownership instead would leave the key unclaimed, and an unclaimed key
  // accepts the next writer — including the mount whose refused write is still
  // in the air, which would put the discarded text straight back.
  take(at, newDraftOwner());
}

/**
 * A NOTEBOOK CELL'S UNSAVED SOURCE.
 *
 * The same problem as a file, minus the baseline: a cell save is a `set` edit
 * with no hash to carry, so what has to survive is the text alone. The
 * notebook's per-cell debounce is flushed on unmount rather than cancelled, but
 * a flush can still FAIL — the engine unreachable, the notebook rewritten under
 * it — and until this existed that failure had nowhere to leave the text.
 */
export function rememberCellDraft(scope: string, path: string, cellId: string, text: string, owner: DraftOwner): boolean {
  return put(cells, key(scope, path, cellId), owner, text);
}

export function forgetCellDraft(scope: string, path: string, cellId: string, owner: DraftOwner): boolean {
  return drop(cells, key(scope, path, cellId), owner);
}

/** Every stashed cell of one notebook, claimed by the mount adopting them. */
export function claimCellDrafts(scope: string, path: string, owner: DraftOwner): Map<string, string> {
  const prefix = key(scope, path, "");
  const adopted = new Map<string, string>();
  for (const [at, text] of cells) {
    if (!at.startsWith(prefix)) continue;
    take(at, owner);
    adopted.set(at.slice(prefix.length), text);
  }
  return adopted;
}

/**
 * Take one cell's key without reading it — what a mount does for a cell it is
 * about to edit but that had nothing stashed, so a previous mount's pending
 * write cannot land on it afterwards.
 */
export function claimCellDraft(scope: string, path: string, cellId: string, owner: DraftOwner): string | undefined {
  return claim(cells, key(scope, path, cellId), owner);
}

/** Only for tests: the store is a singleton for the life of the page. */
export function clearDrafts(): void {
  drafts.clear();
  cells.clear();
  owners.clear();
}

/** How many files and cells are holding unsaved text — for a test to assert
 *  nothing leaks, rather than for anything on screen. */
export function draftCount(): number {
  return drafts.size + cells.size;
}
