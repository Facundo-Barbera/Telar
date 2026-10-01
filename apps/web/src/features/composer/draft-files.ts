import { draftKey } from "./draft";

/** Files attached to an unsent draft, keyed like its text. Memory answers a session switch at once; IndexedDB carries them across a reload. */
const memory = new Map<string, File[]>();

const DB = "telar-draft-files";
const STORE = "files";

let opened: Promise<IDBDatabase | undefined> | undefined;

function open(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  opened ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return opened;
}

async function persist(key: string, files: readonly File[]): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    if (files.length === 0) store.delete(key);
    else store.put([...files], key);
  } catch {
    // A full or blocked store only costs the reload copy; memory still holds the files.
  }
}

async function load(key: string): Promise<File[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result.filter((file) => file instanceof File) : []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export function readDraftFiles(sessionId: string | undefined, projectId: string | undefined): File[] {
  return memory.get(draftKey(sessionId, projectId)) ?? [];
}

export function writeDraftFiles(sessionId: string | undefined, projectId: string | undefined, files: readonly File[]): void {
  const key = draftKey(sessionId, projectId);
  const had = memory.get(key) ?? [];
  // An unchanged list writes nothing, so a box mounting empty cannot erase the copy a reload is about to load.
  if (had.length === files.length && had.every((file, index) => file === files[index])) return;
  if (files.length === 0) memory.delete(key);
  else memory.set(key, [...files]);
  void persist(key, files);
}

/** What a reload left behind: memory first, else the stored copy. */
export async function loadDraftFiles(sessionId: string | undefined, projectId: string | undefined): Promise<File[]> {
  const key = draftKey(sessionId, projectId);
  const held = memory.get(key);
  if (held) return held;
  const stored = await load(key);
  if (stored.length > 0 && !memory.has(key)) memory.set(key, stored);
  return memory.get(key) ?? [];
}
