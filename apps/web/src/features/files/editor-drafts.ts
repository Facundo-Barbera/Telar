
export type EditorDraft = {
  text: string;
  baseline: string;
  problem?: { refused: boolean; reason: string };
};

export type DraftOwner = string;

let minted = 0;

export function newDraftOwner(): DraftOwner {
  minted += 1;
  return `owner_${minted}`;
}

export function draftScope(hostId: string | undefined, sessionId?: string, projectId?: string): string {
  const host = hostId && hostId.length > 0 ? hostId : "local";
  return `${host} ${sessionId ? `session:${sessionId}` : projectId ? `project:${projectId}` : "none"}`;
}

const drafts = new Map<string, EditorDraft>();
const cells = new Map<string, string>();

const owners = new Map<string, DraftOwner>();

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

function drop<T>(store: Map<string, T>, at: string, owner: DraftOwner): boolean {
  if (owners.get(at) !== owner || !store.has(at)) return false;
  store.delete(at);
  return true;
}

export function rememberDraft(scope: string, path: string, draft: EditorDraft, owner: DraftOwner): boolean {
  return put(drafts, key(scope, path), owner, draft);
}

export function readDraft(scope: string, path: string): EditorDraft | undefined {
  return drafts.get(key(scope, path));
}

export function claimDraft(scope: string, path: string, owner: DraftOwner): EditorDraft | undefined {
  return claim(drafts, key(scope, path), owner);
}

export function forgetDraft(scope: string, path: string, owner: DraftOwner): boolean {
  return drop(drafts, key(scope, path), owner);
}

export function discardDraft(scope: string, path: string): void {
  const at = key(scope, path);
  drafts.delete(at);
  take(at, newDraftOwner());
}

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

export function claimCellDraft(scope: string, path: string, cellId: string, owner: DraftOwner): string | undefined {
  return claim(cells, key(scope, path, cellId), owner);
}

export function clearDrafts(): void {
  drafts.clear();
  cells.clear();
  owners.clear();
}

export function draftCount(): number {
  return drafts.size + cells.size;
}
