/**
 * Module-level store for unsaved editor text so it survives unmounts. The
 * baseline hash travels with the text so a re-mounted editor writes against
 * the original read and a file that moved on disk is refused again.
 */

export type EditorDraft = {
  text: string;
  /** The `sha256` of the read this edit began from; writes must carry it, not a fresh read's hash. */
  baseline: string;
  problem?: { refused: boolean; reason: string };
};

export type DraftOwner = string;

let minted = 0;

export function newDraftOwner(): DraftOwner {
  minted += 1;
  return `owner_${minted}`;
}

/** Session ids are minted per engine, so the host must be part of the scope. */
export function draftScope(hostId: string | undefined, sessionId?: string, projectId?: string): string {
  const host = hostId && hostId.length > 0 ? hostId : "local";
  return `${host} ${sessionId ? `session:${sessionId}` : projectId ? `project:${projectId}` : "none"}`;
}

const drafts = new Map<string, EditorDraft>();
/** Notebook cell text; see `rememberCellDraft`. */
const cells = new Map<string, string>();

/**
 * Ownership is kept separately from the text so it survives clearing: a late write from an old
 * mount must not land in the gap. A discard moves the key to a generation nobody holds.
 */
const owners = new Map<string, DraftOwner>();
/** Never evicted: forgetting a key would let a stale mount write again. */

/** NUL separator, written as an escape (see lib/no-invisible-characters.test.ts). */
function key(scope: string, path: string, cellId?: string): string {
  return cellId === undefined ? `${scope}\u0000${path}` : `${scope}\u0000${path}\u0000${cellId}`;
}

function claim<T>(store: Map<string, T>, at: string, owner: DraftOwner): T | undefined {
  take(at, owner);
  return store.get(at);
}

function take(at: string, owner: DraftOwner): void {
  owners.set(at, owner);
}

/** An unclaimed key belongs to whoever gets there first. */
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

/** Clear the text but keep ownership, so a gone mount's slower answer cannot write into the gap. */
function drop<T>(store: Map<string, T>, at: string, owner: DraftOwner): boolean {
  if (owners.get(at) !== owner || !store.has(at)) return false;
  store.delete(at);
  return true;
}

/** Answers whether this owner still held the key. */
export function rememberDraft(scope: string, path: string, draft: EditorDraft, owner: DraftOwner): boolean {
  return put(drafts, key(scope, path), owner, draft);
}

/** Read without taking the key. */
export function readDraft(scope: string, path: string): EditorDraft | undefined {
  return drafts.get(key(scope, path));
}

/** Read and take the key, so the previous mount's answer can no longer touch it. */
export function claimDraft(scope: string, path: string, owner: DraftOwner): EditorDraft | undefined {
  return claim(drafts, key(scope, path), owner);
}

/** Owner-guarded, so an old mount's landed write cannot clear text typed since. */
export function forgetDraft(scope: string, path: string, owner: DraftOwner): boolean {
  return drop(drafts, key(scope, path), owner);
}

/**
 * A person's deliberate discard. Not owner-guarded: the claiming mount may already be gone,
 * and a guarded delete would let the text come back.
 */
export function discardDraft(scope: string, path: string): void {
  const at = key(scope, path);
  drafts.delete(at);
  // Hand the key to a fresh owner; leaving it unclaimed would let a pending refused write restore it.
  take(at, newDraftOwner());
}

/** A notebook cell's unsaved source; like a file draft but with no baseline hash. */
export function rememberCellDraft(scope: string, path: string, cellId: string, text: string, owner: DraftOwner): boolean {
  return put(cells, key(scope, path, cellId), owner, text);
}

export function forgetCellDraft(scope: string, path: string, cellId: string, owner: DraftOwner): boolean {
  return drop(cells, key(scope, path, cellId), owner);
}

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

/** Claim a cell with nothing stashed, so a previous mount's pending write cannot land. */
export function claimCellDraft(scope: string, path: string, cellId: string, owner: DraftOwner): string | undefined {
  return claim(cells, key(scope, path, cellId), owner);
}

/** For tests only. */
export function clearDrafts(): void {
  drafts.clear();
  cells.clear();
  owners.clear();
}

/** For tests to assert nothing leaks. */
export function draftCount(): number {
  return drafts.size + cells.size;
}
